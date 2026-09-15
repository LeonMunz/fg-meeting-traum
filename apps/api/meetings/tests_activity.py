"""Tests for the Meeting Activity event slice.

The canonical persisted Activity event concept is
``audit_history.AuditEvent``, recorded through
``audit_history.services.record_audit_event`` — see
``docs/domain/activity.md`` for the contract.

These tests pin the Meeting slice event set, one event per logical
operation:

- ``meeting.created``          — create_meeting / create_meeting_from_series
- ``meeting.rescheduled``      — a real date-time change in update_meeting
- ``meeting.completed``        — end_meeting
- ``meeting.agenda_item_added``— create_meeting_item
- ``meeting.follow_up_scheduled`` — schedule_meeting_item_follow_up
  (anchored to the TARGET Meeting; the internally materialized target
  item records no separate agenda_item_added event)

Each persisted event must carry enough *structured* context (no
rendered English strings as source of truth) for a later Activity
projection to reconstruct:

- WHO   — ``event.actor`` (FK to the acting User)
- WHAT  — ``event.event_type`` (stable machine code) +
          ``event.data["changes"]`` (structured semantics)
- WHICH — ``event.meeting`` (FK to the affected Meeting)
- WHERE — ``event.project`` + ``event.research_group`` (the
          access-control scope the Activity feed must enforce)
- WHEN  — ``event.created_at`` (occurrence timestamp)

They also pin the transactional guarantee: an Activity event
participates in the same logical transaction as the Meeting mutation
— when the mutation rolls back, the event rolls back too.
"""

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db import transaction
from django.test import TestCase
from django.utils import timezone

from audit_history.models import AuditEvent
from projects.services import create_project
from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)

from .models import (
    Meeting,
    MeetingSection,
)
from .services import (
    MeetingAuditEventType,
    _iso8601_utc,
    create_meeting,
    create_meeting_from_series,
    create_meeting_item,
    create_meeting_series,
    end_meeting,
    reopen_meeting,
    schedule_meeting_item_follow_up,
    start_meeting,
    update_meeting,
)


User = get_user_model()


def _events_for_meeting(meeting):
    """All AuditEvents anchored to one Meeting, oldest first."""
    return list(
        AuditEvent.objects
        .filter(meeting=meeting)
        .order_by("id")
    )


def _all_events():
    return list(AuditEvent.objects.order_by("id"))


class _MeetingActivityBase(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.alex = User.objects.create_user(
            username="meeting-activity-alex",
            password="Pass1!",
            first_name="Alex",
        )
        cls.chris = User.objects.create_user(
            username="meeting-activity-chris",
            password="Pass1!",
            first_name="Chris",
        )
        cls.group = ResearchGroup.objects.create(
            name="Meeting Activity Group",
            created_by=cls.alex,
        )
        ResearchGroupMembership.objects.create(
            research_group=cls.group,
            user=cls.alex,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        ResearchGroupMembership.objects.create(
            research_group=cls.group,
            user=cls.chris,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        cls.project = create_project(
            research_group=cls.group,
            creator=cls.alex,
            name="Activity Project",
            description="",
        )

    def _create_meeting(self, *, title="Activity Meeting", days=1, **kwargs):
        return create_meeting(
            research_group=self.group,
            actor=self.alex,
            title=title,
            scheduled_at=timezone.now() + timedelta(days=days),
            **kwargs,
        )


class MeetingActivityEventSliceTest(_MeetingActivityBase):
    """The required Meeting events, one per domain action."""

    def _assert_event_scope_and_identity(self, event, meeting):
        """WHICH + WHERE + WHEN: the event is bound to the affected
        Meeting and to its own Project/Research Group scope."""
        self.assertEqual(event.meeting_id, meeting.pk)
        self.assertIsNone(event.work_item_id)
        self.assertEqual(event.project_id, meeting.project_id)
        self.assertEqual(event.research_group_id, meeting.research_group_id)
        self.assertIsNotNone(event.created_at)

    # ── Meeting created ──

    def test_created_event_reconstructs_who_what_which_where_when(self):
        meeting = self._create_meeting()
        self.assertEqual(len(_events_for_meeting(meeting)), 1)

        event = _events_for_meeting(meeting)[0]
        self.assertEqual(event.event_type, "meeting.created")
        self.assertEqual(event.actor_id, self.alex.pk)
        # group-scoped: no Project scope
        self.assertIsNone(meeting.project_id)
        self._assert_event_scope_and_identity(event, meeting)
        # created carries no structured changes
        self.assertEqual(event.data, {})

    def test_project_scoped_created_event_carries_project_scope(self):
        meeting = self._create_meeting(
            scope=Meeting.Scope.PROJECT,
            project=self.project,
        )
        event = _events_for_meeting(meeting)[0]
        self.assertEqual(event.event_type, "meeting.created")
        self.assertEqual(event.project_id, self.project.pk)
        self.assertEqual(
            event.research_group_id, self.group.pk,
        )

    def test_created_from_series_records_one_event_without_section_noise(
        self,
    ):
        series = create_meeting_series(
            research_group=self.group,
            actor=self.alex,
            title="Weekly",
        )
        meeting = create_meeting_from_series(
            meeting_series=series,
            actor=self.alex,
            scheduled_at=timezone.now() + timedelta(days=1),
        )

        events = _events_for_meeting(meeting)
        # Exactly one event for the logical creation operation — the
        # snapshotted Series sections are internal structure.
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].event_type, "meeting.created")
        self.assertEqual(events[0].data, {})

    # ── Meeting rescheduled ──

    def test_reschedule_event_is_structured_with_previous_and_new_datetime(
        self,
    ):
        meeting = self._create_meeting()
        original_dt = meeting.scheduled_at
        new_dt = original_dt + timedelta(days=8)

        update_meeting(
            meeting=meeting,
            actor=self.alex,
            scheduled_at=new_dt,
        )

        events = _events_for_meeting(meeting)
        self.assertEqual(len(events), 2)

        event = events[-1]
        self.assertEqual(event.event_type, "meeting.rescheduled")
        self.assertEqual(event.actor_id, self.alex.pk)
        self._assert_event_scope_and_identity(event, meeting)

        scheduled_at_change = event.data["changes"]["scheduledAt"]
        self.assertEqual(set(event.data["changes"].keys()), {"scheduledAt"})
        self.assertEqual(
            scheduled_at_change["from"],
            _iso8601_utc(original_dt),
        )
        self.assertEqual(
            scheduled_at_change["to"],
            _iso8601_utc(new_dt),
        )

    def test_title_only_update_records_no_event(self):
        meeting = self._create_meeting()
        update_meeting(
            meeting=meeting,
            actor=self.alex,
            title="Renamed Meeting",
        )
        self.assertEqual(len(_events_for_meeting(meeting)), 1)
        self.assertEqual(
            _events_for_meeting(meeting)[0].event_type,
            "meeting.created",
        )

    def test_same_datetime_update_records_no_event(self):
        meeting = self._create_meeting()
        update_meeting(
            meeting=meeting,
            actor=self.alex,
            scheduled_at=meeting.scheduled_at,
        )
        self.assertEqual(len(_events_for_meeting(meeting)), 1)

    def test_one_update_with_title_and_datetime_records_one_event(self):
        """One logical update = one event; the title is not a tracked
        Meeting Activity aspect, so only scheduledAt appears."""
        meeting = self._create_meeting()
        new_dt = timezone.now() + timedelta(days=3)

        update_meeting(
            meeting=meeting,
            actor=self.alex,
            title="Renamed",
            scheduled_at=new_dt,
        )

        events = _events_for_meeting(meeting)
        self.assertEqual(len(events), 2)
        event = events[-1]
        self.assertEqual(event.event_type, "meeting.rescheduled")
        self.assertEqual(
            set(event.data["changes"].keys()),
            {"scheduledAt"},
        )
        self.assertEqual(
            event.data["changes"]["scheduledAt"]["to"],
            _iso8601_utc(new_dt),
        )

    # ── Meeting completed ──

    def test_completed_event_is_structured(self):
        meeting = self._create_meeting()
        start_meeting(meeting=meeting, actor=self.alex)
        end_meeting(meeting=meeting, actor=self.alex)

        events = _events_for_meeting(meeting)
        self.assertEqual(len(events), 2)

        event = events[-1]
        self.assertEqual(event.event_type, "meeting.completed")
        self.assertEqual(event.actor_id, self.alex.pk)
        self._assert_event_scope_and_identity(event, meeting)

        meeting.refresh_from_db()
        self.assertEqual(
            event.data["changes"],
            {"endedAt": _iso8601_utc(meeting.ended_at)},
        )

    def test_start_and_reopen_record_no_event(self):
        """Start / Reopen are not in this slice's event set: the
        lifecycle boundary events are created / rescheduled /
        completed only."""
        meeting = self._create_meeting()
        start_meeting(meeting=meeting, actor=self.alex)
        end_meeting(meeting=meeting, actor=self.alex)
        reopen_meeting(meeting=meeting, actor=self.alex)

        events = _events_for_meeting(meeting)
        self.assertEqual(
            [e.event_type for e in events],
            ["meeting.created", "meeting.completed"],
        )

    # ── Agenda item added ──

    def test_agenda_item_added_event_is_structured(self):
        meeting = self._create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        item = create_meeting_item(
            meeting=meeting,
            meeting_section=section,
            actor=self.alex,
            title="Discuss experiment results",
        )

        events = _events_for_meeting(meeting)
        self.assertEqual(len(events), 2)

        event = events[-1]
        self.assertEqual(event.event_type, "meeting.agenda_item_added")
        self.assertEqual(event.actor_id, self.alex.pk)
        self._assert_event_scope_and_identity(event, meeting)
        # The item identity is structured; internal ordering fields
        # (position) never appear in the event payload.
        self.assertEqual(
            event.data["changes"],
            {
                "agendaItem": {
                    "id": item.pk,
                    "title": "Discuss experiment results",
                }
            },
        )

    # ── Follow-up scheduled ──

    def test_follow_up_scheduled_records_one_event_anchored_to_target(self):
        source = self._create_meeting(title="Source")
        target = self._create_meeting(title="Target", days=7)
        source_section = MeetingSection.objects.get(meeting=source)
        target_section = MeetingSection.objects.get(meeting=target)
        source_item = create_meeting_item(
            meeting=source,
            meeting_section=source_section,
            actor=self.alex,
            title="Continue the experiment",
        )

        schedule_meeting_item_follow_up(
            source_meeting_item=source_item,
            target_meeting=target,
            target_meeting_section=target_section,
            actor=self.alex,
        )

        # Source Meeting: created + agenda item added — nothing else.
        self.assertEqual(
            [e.event_type for e in _events_for_meeting(source)],
            ["meeting.created", "meeting.agenda_item_added"],
        )
        # Target Meeting: created + follow_up_scheduled. The internally
        # materialized target item produces NO separate
        # agenda_item_added event.
        target_events = _events_for_meeting(target)
        self.assertEqual(
            [e.event_type for e in target_events],
            ["meeting.created", "meeting.follow_up_scheduled"],
        )

        event = target_events[-1]
        self.assertEqual(event.actor_id, self.alex.pk)
        self.assertEqual(event.meeting_id, target.pk)
        self.assertEqual(
            event.research_group_id, target.research_group_id,
        )
        self.assertEqual(event.project_id, target.project_id)
        # Stable flat machine reference for the feed's source
        # readability filter.
        self.assertEqual(event.data["sourceMeetingId"], source.pk)
        self.assertEqual(
            event.data["changes"]["followUp"],
            {
                "sourceMeeting": {
                    "id": source.pk,
                    "title": source.title,
                },
                "sourceItem": {
                    "id": source_item.pk,
                    "title": source_item.title,
                },
                "targetSection": {
                    "id": target_section.pk,
                    "name": target_section.name,
                },
                "targetItem": {
                    "id": Meeting.objects.get(pk=target.pk).items.first().pk,
                    "title": source_item.title,
                },
            },
        )

    def test_follow_up_retry_records_no_second_event(self):
        source = self._create_meeting(title="Source")
        target = self._create_meeting(title="Target", days=7)
        source_section = MeetingSection.objects.get(meeting=source)
        target_section = MeetingSection.objects.get(meeting=target)
        source_item = create_meeting_item(
            meeting=source,
            meeting_section=source_section,
            actor=self.alex,
            title="Continue the experiment",
        )

        schedule_meeting_item_follow_up(
            source_meeting_item=source_item,
            target_meeting=target,
            target_meeting_section=target_section,
            actor=self.alex,
        )
        # Idempotent retry: returns the existing schedule, no event.
        schedule_meeting_item_follow_up(
            source_meeting_item=source_item,
            target_meeting=target,
            target_meeting_section=target_section,
            actor=self.alex,
        )

        follow_up_events = [
            e
            for e in _events_for_meeting(target)
            if e.event_type == "meeting.follow_up_scheduled"
        ]
        self.assertEqual(len(follow_up_events), 1)

    def test_cross_group_follow_up_event_scoped_to_target_group(self):
        other_actor = User.objects.create_user(
            username="meeting-activity-dan",
            password="Pass1!",
        )
        other_group = ResearchGroup.objects.create(
            name="Other Meeting Activity Group",
            created_by=other_actor,
        )
        ResearchGroupMembership.objects.create(
            research_group=other_group,
            user=self.alex,
            role=ResearchGroupMembership.Role.MEMBER,
        )

        source = self._create_meeting(title="Source")
        source_section = MeetingSection.objects.get(meeting=source)
        source_item = create_meeting_item(
            meeting=source,
            meeting_section=source_section,
            actor=self.alex,
            title="Continue the experiment",
        )
        target = create_meeting(
            research_group=other_group,
            actor=self.alex,
            title="Target",
            scheduled_at=timezone.now() + timedelta(days=7),
        )
        target_section = MeetingSection.objects.get(meeting=target)

        schedule_meeting_item_follow_up(
            source_meeting_item=source_item,
            target_meeting=target,
            target_meeting_section=target_section,
            actor=self.alex,
        )

        event = (
            _events_for_meeting(target)[-1]
        )
        self.assertEqual(
            event.event_type, "meeting.follow_up_scheduled",
        )
        # The event belongs to the TARGET Meeting's access-control
        # scope, even when the source lives in another group.
        self.assertEqual(event.research_group_id, other_group.pk)
        self.assertEqual(event.data["sourceMeetingId"], source.pk)


class MeetingActivityTransactionTest(_MeetingActivityBase):
    """Transactional guarantee: rollback of the Meeting mutation rolls
    back its Activity event (no orphaned history), and a committed
    mutation always has its event."""

    def test_rolled_back_create_leaves_no_meeting_and_no_event(self):
        with self.assertRaises(RuntimeError):
            with transaction.atomic():
                meeting = self._create_meeting(title="Doomed")
                self.assertTrue(
                    AuditEvent.objects.filter(
                        meeting=meeting,
                        event_type="meeting.created",
                    ).exists()
                )
                raise RuntimeError("simulated failure after create")

        self.assertFalse(
            Meeting.objects.filter(title="Doomed").exists()
        )
        self.assertEqual(AuditEvent.objects.count(), 0)

    def test_rolled_back_reschedule_leaves_no_event_and_no_change(self):
        meeting = self._create_meeting()
        original_dt = meeting.scheduled_at

        with self.assertRaises(RuntimeError):
            with transaction.atomic():
                update_meeting(
                    meeting=meeting,
                    actor=self.alex,
                    scheduled_at=original_dt + timedelta(days=5),
                )
                raise RuntimeError("simulated failure after mutation")

        meeting.refresh_from_db()
        self.assertEqual(meeting.scheduled_at, original_dt)
        # only the creation event survives
        self.assertEqual(
            [e.event_type for e in _events_for_meeting(meeting)],
            ["meeting.created"],
        )

    def test_rolled_back_completion_leaves_no_event(self):
        meeting = self._create_meeting()
        start_meeting(meeting=meeting, actor=self.alex)

        with self.assertRaises(RuntimeError):
            with transaction.atomic():
                end_meeting(meeting=meeting, actor=self.alex)
                raise RuntimeError("simulated failure after mutation")

        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.LIVE)
        self.assertEqual(
            [e.event_type for e in _events_for_meeting(meeting)],
            ["meeting.created"],
        )

    def test_rolled_back_follow_up_leaves_no_event(self):
        source = self._create_meeting(title="Source")
        target = self._create_meeting(title="Target", days=7)
        source_section = MeetingSection.objects.get(meeting=source)
        target_section = MeetingSection.objects.get(meeting=target)
        source_item = create_meeting_item(
            meeting=source,
            meeting_section=source_section,
            actor=self.alex,
            title="Continue the experiment",
        )

        with self.assertRaises(RuntimeError):
            with transaction.atomic():
                schedule_meeting_item_follow_up(
                    source_meeting_item=source_item,
                    target_meeting=target,
                    target_meeting_section=target_section,
                    actor=self.alex,
                )
                raise RuntimeError("simulated failure after mutation")

        target_item_count = (
            Meeting.objects.get(pk=target.pk).items.count()
        )
        self.assertEqual(target_item_count, 0)
        self.assertFalse(
            AuditEvent.objects.filter(
                event_type="meeting.follow_up_scheduled",
            ).exists()
        )
