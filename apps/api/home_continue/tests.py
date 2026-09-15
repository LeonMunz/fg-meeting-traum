"""Home "Continue working" — LIMITED V1 read model tests.

Proves the canonical semantics of
``home_continue.continue_working.get_continue_working_candidates``:

- actor-specific recency: only the current user's own persisted
  actions (supported Work Item / Meeting ``AuditEvent`` actor rows,
  authored Meeting Notes) qualify; another user's action never
  creates, moves, or retimestamps the user's candidate
- generic ``updated_at`` is never personal recency
- V1 exclusions: comments, label-only changes, received
  assignments, passive participation, write-without-read, Note
  edits, lifecycle transitions without an attributable event
- current read authorization is mandatory (Work Item Project +
  Research Group read boundary; Meeting canonical
  ``MEETING_READ``); access loss and deletion fail closed with no
  row at all (no metadata leak)
- recency-orientation: unassigned / reassigned / ``done`` Work
  Items and completed Meetings remain candidates while readable
- Meeting Note creation maps to the parent Meeting (author's
  ``created_at`` only); Notes are never standalone candidates
- follow-up events anchor the target Meeting only
- deduplication per ``(domain, object_id)`` with the latest
  qualifying personal timestamp
- deterministic ordering (timestamp DESC, domain rank tie-break,
  object ID ASC); no horizon; no row limit
- bounded, row-invariant query count (no N+1)

Event / Note timestamps are pinned with queryset
``.update(created_at=...)`` (the established Activity-feed test
technique), so no test depends on the wall clock.
"""

from datetime import date, datetime, timedelta

from django.contrib.auth import get_user_model
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from audit_history.models import AuditEvent
from projects.models import (
    ProjectMembership,
    WorkItemLabelDefinition,
)
from projects.services import (
    add_project_membership,
    change_membership_role,
    create_project,
)
from research_groups.models import ResearchGroup, ResearchGroupMembership

from meetings.models import Meeting, MeetingNote, MeetingParticipant
from meetings.services import (
    create_meeting,
    create_meeting_item,
    create_meeting_note,
    delete_meeting,
    end_meeting,
    schedule_meeting_item_follow_up,
    start_meeting,
    update_meeting,
    update_meeting_note,
)

from work_items.services import (
    create_work_item,
    create_work_item_comment,
    delete_work_item,
    update_work_item,
)
from work_items.home_my_work import get_home_my_work_candidates

from home_continue.continue_working import (
    DOMAIN_MEETING,
    DOMAIN_WORK_ITEM,
    get_continue_working_candidates,
)

# Fixed personal-action timeline: every pinned timestamp is an
# integer minute offset from this base, so ordering assertions are
# exact and wall-clock independent.
BASE_TIME = timezone.make_aware(datetime(2026, 9, 1, 12, 0, 0))

# Fixed Meeting schedule (Continue working has no window; the value
# only feeds the candidate detail block).
MEETING_AT = timezone.make_aware(datetime(2026, 9, 20, 10, 0, 0))


def t(minutes: int) -> datetime:
    """Aware application-timezone datetime at ``BASE_TIME + minutes``."""
    return BASE_TIME + timedelta(minutes=minutes)


User = get_user_model()

SEED_PASSWORD = "DevPass1!"


def _create_standard_data():
    """Create the standard Foundation 4 test scenario + an outsider.

    Paper XYZ:
      Alex: owner (Research Group admin)
      Chris: member
      Laura: viewer
      Maria: no ProjectMembership (Research Group member only)
      Outsider: no memberships at all
    """
    alex = User.objects.create_user(username="alex", password=SEED_PASSWORD)
    chris = User.objects.create_user(username="chris", password=SEED_PASSWORD)
    maria = User.objects.create_user(username="maria", password=SEED_PASSWORD)
    laura = User.objects.create_user(username="laura", password=SEED_PASSWORD)
    outsider = User.objects.create_user(
        username="outsider", password=SEED_PASSWORD,
    )

    group = ResearchGroup.objects.create(name="FG Example", created_by=alex)
    for user, role in (
        (alex, ResearchGroupMembership.Role.ADMIN),
        (chris, ResearchGroupMembership.Role.MEMBER),
        (maria, ResearchGroupMembership.Role.MEMBER),
        (laura, ResearchGroupMembership.Role.MEMBER),
    ):
        ResearchGroupMembership.objects.create(
            research_group=group, user=user, role=role,
        )

    paper_xyz = create_project(
        research_group=group, creator=alex, name="Paper XYZ"
    )
    add_project_membership(
        project=paper_xyz, actor=alex,
        target_user=chris, role=ProjectMembership.Role.MEMBER,
    )
    add_project_membership(
        project=paper_xyz, actor=alex,
        target_user=laura, role=ProjectMembership.Role.VIEWER,
    )

    return {
        "group": group,
        "alex": alex,
        "chris": chris,
        "maria": maria,
        "laura": laura,
        "outsider": outsider,
        "paper_xyz": paper_xyz,
    }


class _ContinueBase(TestCase):
    """Base with the standard scenario and projection helpers."""

    def setUp(self):
        super().setUp()
        self.data = _create_standard_data()
        self.project = self.data["paper_xyz"]
        self.task_type = self.project.type_definitions.get(name="Task")
        self.done_status = self.project.status_definitions.get(name="Done")

    # ── timestamp pinning ──

    def _pin(self, user, when, **filters):
        """Pin every matching AuditEvent of ``user`` to ``when``."""
        AuditEvent.objects.filter(actor=user, **filters).update(
            created_at=when,
        )

    def _pin_note(self, note, when):
        MeetingNote.objects.filter(pk=note.pk).update(created_at=when)

    # ── fixtures ──

    def _make_wi(
        self, *, title, actor=None, assignees=(), status_id=None,
        due_date=None,
    ):
        return create_work_item(
            project=self.project,
            actor=actor or self.data["alex"],
            type_definition_id=self.task_type.pk,
            title=title,
            status_definition_id=status_id,
            assignee_ids=[u.pk for u in assignees],
            due_date=due_date.isoformat() if due_date is not None else None,
        )

    def _make_meeting(self, *, title, actor=None, participants=()):
        return create_meeting(
            research_group=self.data["group"],
            actor=actor or self.data["alex"],
            title=title,
            scheduled_at=MEETING_AT,
            participants=participants,
        )

    def _live_meeting_with_item(self, *, title="Notes M", participants=()):
        """A live Meeting with one agenda item created by alex, so
        note-authorship tests isolate the Note as the only
        chris-attributable signal."""
        m = self._make_meeting(title=title, participants=participants)
        start_meeting(meeting=m, actor=self.data["alex"])
        item = create_meeting_item(
            meeting=m,
            meeting_section=m.meeting_sections.first(),
            actor=self.data["alex"],
            title="Item",
        )
        return m, item

    # ── projection helpers ──

    def _candidates(self, user):
        return get_continue_working_candidates(user=user)

    def _pairs(self, user):
        """Ordered (domain, object_id) list."""
        return [(c.domain, c.object_id) for c in self._candidates(user)]

    def _wi_ids(self, user):
        return [
            c.object_id for c in self._candidates(user)
            if c.domain == DOMAIN_WORK_ITEM
        ]

    def _meeting_ids(self, user):
        return [
            c.object_id for c in self._candidates(user)
            if c.domain == DOMAIN_MEETING
        ]

    def _wi_candidate(self, user, work_item_id):
        for c in self._candidates(user):
            if c.domain == DOMAIN_WORK_ITEM and c.object_id == work_item_id:
                return c
        return None

    def _meeting_candidate(self, user, meeting_id):
        for c in self._candidates(user):
            if c.domain == DOMAIN_MEETING and c.object_id == meeting_id:
                return c
        return None

    def _wi_ts(self, user, work_item_id):
        c = self._wi_candidate(user, work_item_id)
        return c.latest_personal_activity_at if c else None

    def _meeting_ts(self, user, meeting_id):
        c = self._meeting_candidate(user, meeting_id)
        return c.latest_personal_activity_at if c else None


# ── Work Item personal attribution ──


class WorkItemAttributionTest(_ContinueBase):

    def test_user_created_work_item_qualifies(self):
        chris = self.data["chris"]
        wi = self._make_wi(title="Created by chris", actor=chris)
        self._pin(chris, t(10), work_item=wi, event_type="work_item.created")

        (candidate,) = self._candidates(chris)
        self.assertEqual(candidate.domain, DOMAIN_WORK_ITEM)
        self.assertEqual(candidate.object_id, wi.pk)
        self.assertEqual(candidate.title, "Created by chris")
        self.assertEqual(candidate.latest_personal_activity_at, t(10))
        details = candidate.details
        self.assertEqual(details.work_item_id, wi.pk)
        self.assertEqual(details.project_id, self.project.pk)
        self.assertEqual(details.project_name, "Paper XYZ")
        self.assertEqual(details.status_category, "todo")
        self.assertIsNone(details.due_date)

    def test_user_tracked_update_qualifies(self):
        chris = self.data["chris"]
        wi = self._make_wi(title="Update target")  # alex created
        self._pin(self.data["alex"], t(1), work_item=wi)
        update_work_item(work_item=wi, actor=chris, title="chris edited")
        self._pin(chris, t(2), work_item=wi)

        self.assertEqual(self._wi_ts(chris, wi.pk), t(2))

    def test_work_item_touched_only_by_other_user_does_not_qualify(self):
        chris = self.data["chris"]
        wi = self._make_wi(title="Alex only")
        update_work_item(work_item=wi, actor=self.data["alex"], title="Alex edit")

        self.assertEqual(self._wi_ids(chris), [])
        # The actor of the same actions DOES qualify.
        self.assertEqual(self._wi_ids(self.data["alex"]), [wi.pk])

    def test_other_users_later_update_does_not_replace_personal_timestamp(self):
        chris = self.data["chris"]
        alex = self.data["alex"]
        wi = self._make_wi(title="Shared edits")
        update_work_item(work_item=wi, actor=chris, title="chris v1")
        update_work_item(work_item=wi, actor=alex, title="alex v2")
        self._pin(alex, t(1), work_item=wi, event_type="work_item.created")
        self._pin(chris, t(2), work_item=wi, event_type="work_item.updated")
        self._pin(alex, t(3), work_item=wi, event_type="work_item.updated")

        # chris's personal recency stays at chris's own action time.
        self.assertEqual(self._wi_ts(chris, wi.pk), t(2))
        # alex sees alex's later action.
        self.assertEqual(self._wi_ts(alex, wi.pk), t(3))

    def test_generic_updated_at_change_by_other_user_is_not_personal(self):
        chris = self.data["chris"]
        wi = self._make_wi(title="Generic touch", actor=chris)
        self._pin(chris, t(1), work_item=wi)

        # A label-only update by alex changes WorkItem.updated_at
        # but records no event at all.
        label = WorkItemLabelDefinition.objects.create(
            project=self.project, name="Deep", order=0,
        )
        update_work_item(
            work_item=wi, actor=self.data["alex"],
            label_definition_ids=[label.pk],
        )
        wi.refresh_from_db()
        self.assertGreater(wi.updated_at, t(1))
        self.assertFalse(
            AuditEvent.objects.filter(
                work_item=wi, actor=self.data["alex"],
            ).exists(),
            "A label-only change must not record a Work Item event.",
        )
        # The generic timestamp never becomes chris's recency.
        self.assertEqual(self._wi_ts(chris, wi.pk), t(1))


# ── Work Item V1 exclusions ──


class WorkItemV1ExclusionTest(_ContinueBase):

    def test_assignment_by_other_user_does_not_qualify(self):
        chris = self.data["chris"]
        # alex creates AND assigns chris in one operation: every
        # event's actor is alex.
        wi = self._make_wi(title="Assigned", assignees=[chris])

        self.assertEqual(self._wi_ids(chris), [])
        self.assertEqual(self._wi_ids(self.data["alex"]), [wi.pk])

    def test_comment_only_interaction_does_not_create_candidate(self):
        chris = self.data["chris"]
        wi = self._make_wi(title="Commented")
        create_work_item_comment(work_item=wi, actor=chris, body="my take")

        self.assertEqual(self._wi_ids(chris), [])

    def test_label_only_change_does_not_create_candidate(self):
        chris = self.data["chris"]
        wi = self._make_wi(title="Labeled")
        label = WorkItemLabelDefinition.objects.create(
            project=self.project, name="L1", order=0,
        )
        update_work_item(
            work_item=wi, actor=chris, label_definition_ids=[label.pk],
        )

        self.assertFalse(
            AuditEvent.objects.filter(work_item=wi, actor=chris).exists(),
            "A label-only change must not record a Work Item event.",
        )
        self.assertEqual(self._wi_ids(chris), [])


# ── Work Item current state / authorization ──


class WorkItemCurrentStateTest(_ContinueBase):

    def test_candidate_remains_after_assignment_removed(self):
        chris = self.data["chris"]
        wi = self._make_wi(title="Unassigned later", actor=chris, assignees=[chris])
        self._pin(chris, t(1), work_item=wi)

        update_work_item(work_item=wi, actor=self.data["alex"], assignee_ids=[])

        # No longer assigned, still readable → still a candidate.
        candidate = self._wi_candidate(chris, wi.pk)
        self.assertIsNotNone(candidate)
        self.assertEqual(candidate.latest_personal_activity_at, t(1))

    def test_candidate_remains_when_reassigned_to_someone_else(self):
        chris = self.data["chris"]
        wi = self._make_wi(title="Reassigned", actor=chris, assignees=[chris])
        self._pin(chris, t(1), work_item=wi)

        update_work_item(
            work_item=wi, actor=self.data["alex"],
            assignee_ids=[self.data["alex"].pk],
        )

        candidate = self._wi_candidate(chris, wi.pk)
        self.assertIsNotNone(candidate)
        self.assertEqual(candidate.latest_personal_activity_at, t(1))

    def test_done_work_item_remains_candidate(self):
        chris = self.data["chris"]
        wi = self._make_wi(title="Will complete", actor=chris)
        self._pin(chris, t(1), work_item=wi)
        update_work_item(
            work_item=wi, actor=chris,
            status_definition_id=self.done_status.pk,
        )
        self._pin(chris, t(2), work_item=wi, event_type="work_item.updated")

        candidate = self._wi_candidate(chris, wi.pk)
        self.assertIsNotNone(candidate)
        self.assertEqual(candidate.details.status_category, "done")
        self.assertEqual(candidate.latest_personal_activity_at, t(2))

    def test_viewer_read_access_retains_candidate_but_not_my_work(self):
        chris = self.data["chris"]  # member at action time, viewer now
        wi = self._make_wi(title="Viewer read", actor=chris)
        self._pin(chris, t(1), work_item=wi)
        # Demote chris to viewer: canonical Work Item READ access
        # (PROJECT_READ) is retained, My Work eligibility
        # (owner/member) is lost.
        membership = ProjectMembership.objects.get(
            project=self.project, user=chris,
        )
        change_membership_role(
            membership=membership, actor=self.data["alex"],
            new_role=ProjectMembership.Role.VIEWER,
        )

        # The historical personal action plus CURRENT viewer read
        # access retain the candidate ...
        candidate = self._wi_candidate(chris, wi.pk)
        self.assertIsNotNone(candidate)
        self.assertEqual(candidate.latest_personal_activity_at, t(1))
        # ... while the same user is NOT My Work eligible (viewer).
        self.assertEqual(get_home_my_work_candidates(user=chris), [])

    def test_project_membership_loss_removes_candidate(self):
        chris = self.data["chris"]
        wi = self._make_wi(title="Revoke project", actor=chris)
        self.assertIsNotNone(self._wi_candidate(chris, wi.pk))

        ProjectMembership.objects.filter(
            project=self.project, user=chris,
        ).delete()

        # No candidate row at all — no title, timestamp, or
        # Project metadata leak.
        self.assertEqual(self._candidates(chris), [])

    def test_research_group_membership_loss_removes_candidate(self):
        chris = self.data["chris"]
        wi = self._make_wi(title="Revoke group", actor=chris)
        self.assertIsNotNone(self._wi_candidate(chris, wi.pk))

        ProjectMembership.objects.filter(
            project=self.project, user=chris,
        ).delete()
        ResearchGroupMembership.objects.filter(
            research_group=self.data["group"], user=chris,
        ).delete()

        self.assertEqual(self._candidates(chris), [])

    def test_deleted_work_item_disappears(self):
        chris = self.data["chris"]
        wi = self._make_wi(title="To delete", actor=chris)
        self.assertIsNotNone(self._wi_candidate(chris, wi.pk))

        delete_work_item(work_item=wi, actor=self.data["alex"])

        self.assertEqual(self._candidates(chris), [])
        # The historical event survives with the FK nulled (durable,
        # fail closed).
        event = AuditEvent.objects.filter(
            event_type="work_item.created", actor=chris,
        ).get()
        self.assertIsNone(event.work_item_id)


# ── Meeting event attribution ──


class MeetingEventAttributionTest(_ContinueBase):

    def test_user_created_meeting_qualifies(self):
        chris = self.data["chris"]
        m = self._make_meeting(title="Chris meeting", actor=chris)
        self._pin(chris, t(10), meeting=m, event_type="meeting.created")

        candidate = self._meeting_candidate(chris, m.pk)
        self.assertIsNotNone(candidate)
        self.assertEqual(candidate.title, "Chris meeting")
        self.assertEqual(candidate.latest_personal_activity_at, t(10))
        details = candidate.details
        self.assertEqual(details.meeting_id, m.pk)
        self.assertEqual(details.status, Meeting.Status.UPCOMING)
        self.assertEqual(details.scheduled_at, MEETING_AT)

    def test_user_rescheduled_meeting_qualifies(self):
        chris = self.data["chris"]
        m = self._make_meeting(title="Reschedule", participants=[chris])
        update_meeting(
            meeting=m, actor=chris,
            scheduled_at=MEETING_AT + timedelta(hours=1),
        )
        self._pin(chris, t(5), meeting=m, event_type="meeting.rescheduled")

        self.assertEqual(self._meeting_ts(chris, m.pk), t(5))

    def test_user_completed_meeting_qualifies(self):
        chris = self.data["chris"]
        m = self._make_meeting(title="End it", participants=[chris])
        start_meeting(meeting=m, actor=chris)
        end_meeting(meeting=m, actor=chris)
        self._pin(chris, t(7), meeting=m, event_type="meeting.completed")

        candidate = self._meeting_candidate(chris, m.pk)
        self.assertIsNotNone(candidate)
        self.assertEqual(candidate.details.status, Meeting.Status.COMPLETED)
        self.assertEqual(candidate.latest_personal_activity_at, t(7))

    def test_user_added_agenda_item_qualifies(self):
        chris = self.data["chris"]
        m = self._make_meeting(title="Agenda", participants=[chris])
        create_meeting_item(
            meeting=m,
            meeting_section=m.meeting_sections.first(),
            actor=chris,
            title="Item",
        )
        self._pin(
            chris, t(6), meeting=m,
            event_type="meeting.agenda_item_added",
        )

        self.assertEqual(self._meeting_ts(chris, m.pk), t(6))

    def test_user_scheduled_follow_up_qualifies_target_meeting(self):
        chris = self.data["chris"]
        source = self._make_meeting(title="Source M", actor=self.data["alex"])
        target = self._make_meeting(
            title="Target M", actor=self.data["alex"], participants=[chris],
        )
        item = create_meeting_item(
            meeting=source,
            meeting_section=source.meeting_sections.first(),
            actor=self.data["alex"],
            title="Carry over",
        )
        schedule_meeting_item_follow_up(
            source_meeting_item=item,
            target_meeting=target,
            target_meeting_section=target.meeting_sections.first(),
            actor=chris,
        )
        self._pin(
            chris, t(9), meeting=target,
            event_type="meeting.follow_up_scheduled",
        )

        # Exactly the target Meeting qualifies — never the source.
        self.assertEqual(self._meeting_ids(chris), [target.pk])
        self.assertEqual(self._meeting_ts(chris, target.pk), t(9))
        self.assertIsNone(self._meeting_candidate(chris, source.pk))

    def test_meeting_modified_only_by_other_actor_does_not_qualify(self):
        chris = self.data["chris"]
        m = self._make_meeting(title="Alex meeting", participants=[chris])
        update_meeting(
            meeting=m, actor=self.data["alex"],
            scheduled_at=MEETING_AT + timedelta(hours=2),
        )

        self.assertEqual(self._meeting_ids(chris), [])
        self.assertEqual(self._meeting_ids(self.data["alex"]), [m.pk])


# ── Meeting Note attribution ──


class MeetingNoteAttributionTest(_ContinueBase):

    def test_authored_note_creates_parent_meeting_candidate(self):
        chris = self.data["chris"]
        m, item = self._live_meeting_with_item(participants=[chris])
        note = create_meeting_note(meeting_item=item, actor=chris, content="n1")
        self._pin_note(note, t(4))

        candidate = self._meeting_candidate(chris, m.pk)
        self.assertIsNotNone(candidate)
        self.assertEqual(candidate.latest_personal_activity_at, t(4))
        # A Note is never a standalone candidate: exactly the parent.
        self.assertEqual(self._meeting_ids(chris), [m.pk])

    def test_multiple_notes_collapse_to_one_meeting_candidate(self):
        chris = self.data["chris"]
        m, item = self._live_meeting_with_item(participants=[chris])
        for i, minute in enumerate((1, 2, 3)):
            note = create_meeting_note(
                meeting_item=item, actor=chris, content=f"n{i}",
            )
            self._pin_note(note, t(minute))

        self.assertEqual(self._meeting_ids(chris), [m.pk])
        self.assertEqual(self._meeting_ts(chris, m.pk), t(3))

    def test_note_and_meeting_event_collapse_to_latest_timestamp(self):
        chris = self.data["chris"]
        m, item = self._live_meeting_with_item(participants=[chris])
        note = create_meeting_note(meeting_item=item, actor=chris, content="n1")
        self._pin_note(note, t(1))
        # A later personal event wins.
        update_meeting(
            meeting=m, actor=chris,
            scheduled_at=MEETING_AT + timedelta(hours=1),
        )
        self._pin(chris, t(2), meeting=m, event_type="meeting.rescheduled")
        self.assertEqual(self._meeting_ts(chris, m.pk), t(2))
        # A still later Note wins again (max across both sources).
        note2 = create_meeting_note(meeting_item=item, actor=chris, content="n2")
        self._pin_note(note2, t(3))
        self.assertEqual(self._meeting_ids(chris), [m.pk])
        self.assertEqual(self._meeting_ts(chris, m.pk), t(3))

    def test_editing_another_users_note_does_not_move_recency(self):
        chris = self.data["chris"]
        m, item = self._live_meeting_with_item(participants=[chris])
        note = create_meeting_note(meeting_item=item, actor=chris, content="n1")
        self._pin_note(note, t(1))

        # alex edits chris's Note: only ``updated_at`` moves.
        update_meeting_note(note=note, actor=self.data["alex"], content="alex edit")
        note.refresh_from_db()
        self.assertNotEqual(note.updated_at, t(1))
        # chris's authorship timestamp is unchanged.
        self.assertEqual(note.created_at, t(1))
        self.assertEqual(self._meeting_ts(chris, m.pk), t(1))


# ── Meeting exclusions / authorization ──


class MeetingExclusionAndAuthorizationTest(_ContinueBase):

    def test_passive_participation_does_not_create_candidate(self):
        chris = self.data["chris"]
        # alex creates the Meeting; chris is a passive participant.
        self._make_meeting(title="Passive", participants=[chris])

        self.assertEqual(self._candidates(chris), [])

    def test_participant_removal_removes_historical_candidate(self):
        chris = self.data["chris"]
        m = self._make_meeting(title="Drop", participants=[chris])
        update_meeting(
            meeting=m, actor=chris,
            scheduled_at=MEETING_AT + timedelta(hours=3),
        )
        self._pin(chris, t(8), meeting=m, event_type="meeting.rescheduled")
        self.assertIsNotNone(self._meeting_candidate(chris, m.pk))

        MeetingParticipant.objects.filter(meeting=m, user=chris).delete()

        # No candidate row at all — no title or timestamp leak.
        self.assertEqual(self._candidates(chris), [])

    def test_meeting_write_without_meeting_read_does_not_surface_candidate(self):
        chris = self.data["chris"]  # RG member → group-scope Meeting write
        # chris is NEITHER creator NOR participant of this Meeting.
        m = self._make_meeting(title="Write only")
        create_meeting_item(
            meeting=m,
            meeting_section=m.meeting_sections.first(),
            actor=chris,
            title="Item",
        )
        self._pin(
            chris, t(6), meeting=m,
            event_type="meeting.agenda_item_added",
        )

        # chris is the actor of a qualifying event but holds no
        # canonical MEETING_READ: scope-based write access grants
        # nothing.
        self.assertEqual(self._candidates(chris), [])

    def test_deleted_meeting_disappears(self):
        chris = self.data["chris"]
        m = self._make_meeting(title="Gone", actor=chris)
        self.assertIsNotNone(self._meeting_candidate(chris, m.pk))

        delete_meeting(meeting=m, actor=self.data["alex"])

        self.assertEqual(self._candidates(chris), [])


# ── Completion / lifecycle independence ──


class LifecycleIndependenceTest(_ContinueBase):

    def test_completed_meeting_remains_candidate(self):
        chris = self.data["chris"]
        m = self._make_meeting(title="Finished", actor=chris)
        start_meeting(meeting=m, actor=chris)
        end_meeting(meeting=m, actor=chris)
        self._pin(chris, t(5), meeting=m, event_type="meeting.created")

        candidate = self._meeting_candidate(chris, m.pk)
        self.assertIsNotNone(candidate)
        self.assertEqual(candidate.details.status, Meeting.Status.COMPLETED)

    def test_done_work_item_remains_candidate(self):
        chris = self.data["chris"]
        wi = self._make_wi(title="Shipped", actor=chris, assignees=[chris])
        self._pin(chris, t(1), work_item=wi)
        update_work_item(
            work_item=wi, actor=chris,
            status_definition_id=self.done_status.pk,
        )

        candidate = self._wi_candidate(chris, wi.pk)
        self.assertIsNotNone(candidate)
        self.assertEqual(candidate.details.status_category, "done")


# ── Deduplication ──


class DeduplicationTest(_ContinueBase):

    def test_many_work_item_events_collapse_to_one_candidate(self):
        chris = self.data["chris"]
        wi = self._make_wi(title="Many edits", actor=chris)
        self._pin(chris, t(1), work_item=wi, event_type="work_item.created")
        for i in range(2, 6):
            update_work_item(work_item=wi, actor=chris, title=f"v{i}")
            self._pin(
                chris, t(i), work_item=wi,
                event_type="work_item.updated",
            )

        self.assertEqual(self._wi_ids(chris), [wi.pk])
        self.assertEqual(self._wi_ts(chris, wi.pk), t(5))

    def test_many_meeting_signals_collapse_to_one_candidate(self):
        chris = self.data["chris"]
        m = self._make_meeting(title="Many signals", actor=chris, participants=[chris])
        self._pin(chris, t(1), meeting=m, event_type="meeting.created")
        update_meeting(
            meeting=m, actor=chris,
            scheduled_at=MEETING_AT + timedelta(hours=1),
        )
        self._pin(chris, t(2), meeting=m, event_type="meeting.rescheduled")
        start_meeting(meeting=m, actor=chris)
        item = create_meeting_item(
            meeting=m,
            meeting_section=m.meeting_sections.first(),
            actor=self.data["alex"],
            title="Item",
        )
        note = create_meeting_note(meeting_item=item, actor=chris, content="n")
        self._pin_note(note, t(3))

        self.assertEqual(self._meeting_ids(chris), [m.pk])
        self.assertEqual(self._meeting_ts(chris, m.pk), t(3))


# ── Ordering ──


class OrderingTest(_ContinueBase):

    def test_more_recent_personal_action_sorts_first(self):
        chris = self.data["chris"]
        wi_a = self._make_wi(title="A", actor=chris)
        wi_b = self._make_wi(title="B", actor=chris)
        self._pin(chris, t(1), work_item=wi_a)
        self._pin(chris, t(2), work_item=wi_b)

        self.assertEqual(self._pairs(chris), [
            (DOMAIN_WORK_ITEM, wi_b.pk),
            (DOMAIN_WORK_ITEM, wi_a.pk),
        ])

    def test_other_users_later_mutation_does_not_move_position(self):
        chris = self.data["chris"]
        alex = self.data["alex"]
        wi_1 = self._make_wi(title="One", actor=chris)
        wi_2 = self._make_wi(title="Two", actor=chris)
        self._pin(chris, t(1), work_item=wi_1)
        self._pin(chris, t(3), work_item=wi_2)
        # alex's later mutation of wi_1 must not move wi_1 ahead of
        # wi_2 in chris's personal-recency ordering.
        update_work_item(work_item=wi_1, actor=alex, title="alex touch")
        self._pin(alex, t(2), work_item=wi_1, event_type="work_item.updated")

        self.assertEqual(self._pairs(chris), [
            (DOMAIN_WORK_ITEM, wi_2.pk),
            (DOMAIN_WORK_ITEM, wi_1.pk),
        ])

    def test_exact_tie_work_item_before_meeting(self):
        chris = self.data["chris"]
        wi = self._make_wi(title="Tie WI", actor=chris)
        m = self._make_meeting(title="Tie M", actor=chris)
        self._pin(chris, t(5), work_item=wi)
        self._pin(chris, t(5), meeting=m, event_type="meeting.created")

        self.assertEqual(self._pairs(chris), [
            (DOMAIN_WORK_ITEM, wi.pk),
            (DOMAIN_MEETING, m.pk),
        ])

    def test_same_domain_exact_tie_object_id_ascending(self):
        chris = self.data["chris"]
        with self.subTest(domain="work_item"):
            wi_a = self._make_wi(title="Tie A", actor=chris)
            wi_b = self._make_wi(title="Tie B", actor=chris)
            self._pin(chris, t(5), work_item=wi_a)
            self._pin(chris, t(5), work_item=wi_b)
            self.assertEqual(
                self._wi_ids(chris),
                sorted([wi_a.pk, wi_b.pk]),
            )
        with self.subTest(domain="meeting"):
            m_a = self._make_meeting(title="Tie M A", actor=chris)
            m_b = self._make_meeting(title="Tie M B", actor=chris)
            self._pin(chris, t(6), meeting=m_a, event_type="meeting.created")
            self._pin(chris, t(6), meeting=m_b, event_type="meeting.created")
            self.assertEqual(
                self._meeting_ids(chris),
                sorted([m_a.pk, m_b.pk]),
            )

    def test_repeated_reads_are_deterministic(self):
        chris = self.data["chris"]
        wi_1 = self._make_wi(title="D1", actor=chris)
        wi_2 = self._make_wi(title="D2", actor=chris)
        m = self._make_meeting(title="D3", actor=chris)
        self._pin(chris, t(3), work_item=wi_1)
        self._pin(chris, t(1), work_item=wi_2)
        self._pin(chris, t(2), meeting=m, event_type="meeting.created")

        def snapshot(user):
            return [
                (c.domain, c.object_id, c.title, c.latest_personal_activity_at)
                for c in self._candidates(user)
            ]

        self.assertEqual(snapshot(chris), snapshot(chris))


# ── No horizon / no display limit ──


class NoHorizonNoLimitTest(_ContinueBase):

    def test_old_qualifying_object_remains_eligible(self):
        chris = self.data["chris"]
        wi = self._make_wi(title="Ancient", actor=chris)
        ancient = timezone.make_aware(datetime(2020, 1, 1, 8, 0, 0))
        self._pin(chris, ancient, work_item=wi)

        self.assertEqual(self._wi_ids(chris), [wi.pk])
        self.assertEqual(self._wi_ts(chris, wi.pk), ancient)

    def test_returns_all_candidates_beyond_display_capacity(self):
        chris = self.data["chris"]
        for i in range(12):
            self._make_wi(title=f"WI {i}", actor=chris)
        for i in range(5):
            self._make_meeting(title=f"M {i}", actor=chris)

        candidates = self._candidates(chris)
        self.assertEqual(len(candidates), 17)
        # Flat deterministic list in personal-recency DESC order,
        # never a fixed Home row page.
        for a, b in zip(candidates, candidates[1:]):
            self.assertGreaterEqual(
                a.latest_personal_activity_at,
                b.latest_personal_activity_at,
            )


# ── Query behavior ──


class QueryCountTest(_ContinueBase):
    """Bounded total query count consistent with the aggregate-then-
    bulk-fetch design, and NO N+1 on Work Item context (project /
    status definition) or Meeting data as candidate rows grow."""

    def _add_candidate_pair(self, index: int):
        chris = self.data["chris"]
        self._make_wi(title=f"QC WI {index}", actor=chris)
        m = self._make_meeting(title=f"QC M {index}", actor=chris)
        if index == 0:
            # One authored Note keeps the Note aggregate query
            # non-empty in the small case.
            start_meeting(meeting=m, actor=chris)
            item = create_meeting_item(
                meeting=m,
                meeting_section=m.meeting_sections.first(),
                actor=self.data["alex"],
                title="Item",
            )
            create_meeting_note(meeting_item=item, actor=chris, content="n")

    def test_query_count_bounded_and_row_invariant(self):
        chris = self.data["chris"]

        # Small: 1 Work Item + 1 Meeting (with 1 authored Note).
        self._add_candidate_pair(0)
        with CaptureQueriesContext(connection) as small_ctx:
            small = self._candidates(chris)
        self.assertEqual(len(small), 2)
        # Bounded: a handful of queries, never per-candidate.
        self.assertLessEqual(len(small_ctx.captured_queries), 8)

        # Large: +12 Work Items + 12 Meetings.
        for i in range(1, 13):
            self._add_candidate_pair(i)
        with CaptureQueriesContext(connection) as large_ctx:
            large = self._candidates(chris)
        self.assertEqual(len(large), 26)

        # 13x the candidate rows add ZERO queries — a per-row
        # relation lookup (Work Item project / status definition N+1
        # or Meeting N+1) or a per-candidate query would scale.
        self.assertEqual(
            len(small_ctx.captured_queries),
            len(large_ctx.captured_queries),
            "Continue-working query count must not scale with "
            "candidate row count; every relation must be "
            "eager-loaded on the bounded fetches.",
        )


# ── Security: no metadata leak after access loss ──


class SecurityLeakTest(_ContinueBase):

    def test_lost_project_read_access_leaks_nothing(self):
        chris = self.data["chris"]
        wi = self._make_wi(title="Secret item", actor=chris)
        self._pin(chris, t(1), work_item=wi)
        self.assertIsNotNone(self._wi_candidate(chris, wi.pk))

        ProjectMembership.objects.filter(
            project=self.project, user=chris,
        ).delete()
        ResearchGroupMembership.objects.filter(
            research_group=self.data["group"], user=chris,
        ).delete()

        # No candidate row at all: no title, no Project name, no
        # historical action timestamp, no existence signal.
        self.assertEqual(self._candidates(chris), [])

    def test_lost_meeting_read_access_leaks_nothing(self):
        chris = self.data["chris"]
        m = self._make_meeting(title="Secret meeting", participants=[chris])
        update_meeting(
            meeting=m, actor=chris,
            scheduled_at=MEETING_AT + timedelta(hours=4),
        )
        self._pin(chris, t(2), meeting=m, event_type="meeting.rescheduled")
        self.assertIsNotNone(self._meeting_candidate(chris, m.pk))

        MeetingParticipant.objects.filter(meeting=m, user=chris).delete()

        self.assertEqual(self._candidates(chris), [])

    def test_follow_up_candidate_exposes_target_only(self):
        chris = self.data["chris"]
        alex = self.data["alex"]
        # chris can read the target but NOT the source Meeting.
        source = self._make_meeting(title="Secret source", actor=alex)
        target = self._make_meeting(
            title="Visible target", actor=alex, participants=[chris],
        )
        item = create_meeting_item(
            meeting=source,
            meeting_section=source.meeting_sections.first(),
            actor=alex,
            title="Carry over",
        )
        schedule_meeting_item_follow_up(
            source_meeting_item=item,
            target_meeting=target,
            target_meeting_section=target.meeting_sections.first(),
            actor=chris,
        )

        candidates = self._candidates(chris)
        self.assertEqual(len(candidates), 1)
        candidate = candidates[0]
        self.assertEqual(candidate.domain, DOMAIN_MEETING)
        self.assertEqual(candidate.object_id, target.pk)
        self.assertEqual(candidate.title, "Visible target")
        # The source Meeting produces no candidate row and no
        # metadata leak anywhere in the projection.
        self.assertNotIn(source.pk, [c.object_id for c in candidates])
        for c in candidates:
            self.assertNotIn("Secret source", c.title)

    def test_follow_up_with_unreadable_target_surfaces_nothing(self):
        chris = self.data["chris"]
        alex = self.data["alex"]
        # chris is readable on neither Meeting (write-only access).
        source = self._make_meeting(title="Source X", actor=alex)
        target = self._make_meeting(title="Target X", actor=alex)
        item = create_meeting_item(
            meeting=source,
            meeting_section=source.meeting_sections.first(),
            actor=alex,
            title="Carry over",
        )
        schedule_meeting_item_follow_up(
            source_meeting_item=item,
            target_meeting=target,
            target_meeting_section=target.meeting_sections.first(),
            actor=chris,
        )

        self.assertEqual(self._candidates(chris), [])
