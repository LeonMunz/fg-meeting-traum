"""Tests for cancelling ONE materialized recurring occurrence
("only this meeting", materialized path).

Cancelling a materialized recurring occurrence PRESERVES the concrete
``Meeting`` (row, content, history) while marking it ``cancelled``
(a terminal status reachable only through the dedicated operation)
and persisting exactly one ``MeetingRecurrenceExclusion`` keyed by the
immutable ORIGINAL occurrence identity. The cancelled occurrence then
drops out of the effective recurrence expansion (raw expansion
unchanged, no replacement), and the existing materialization /
reschedule gates keep it out.
"""

import threading
from datetime import date, datetime, time, timezone as dt_timezone
from zoneinfo import ZoneInfo

from audit_history.models import AuditEvent
from django.contrib.auth import get_user_model
from django.db import connection as db_connection
from django.test import TransactionTestCase

from projects.services import archive_project
from projects.models import WorkItemTypeDefinition
from research_groups.models import ResearchGroup, ResearchGroupMembership

from .models import (
    Meeting,
    MeetingItemWorkItem,
    MeetingNote,
    MeetingParticipant,
    MeetingRecurrenceExclusion,
    MeetingSection,
)
from .services import (
    MeetingAuditEventType,
    MeetingDomainError,
    add_meeting_participant,
    cancel_meeting_recurrence_occurrence,
    create_meeting,
    create_meeting_item,
    create_meeting_recurrence,
    create_meeting_section,
    create_meeting_series,
    create_series_section,
    create_work_item_from_meeting_item,
    delete_meeting,
    end_meeting,
    exclude_meeting_recurrence_occurrence,
    expand_effective_meeting_recurrence_occurrences,
    expand_meeting_recurrence_occurrences,
    materialize_meeting_recurrence_occurrence,
    reopen_meeting,
    reschedule_meeting_recurrence_occurrence,
    start_meeting,
    update_meeting,
)
from .tests_recurrence import MeetingRecurrenceBase, _utc

User = get_user_model()
BERLIN = ZoneInfo("Europe/Berlin")


class MeetingRecurrenceCancelBase(MeetingRecurrenceBase):
    """Shared helpers for materialized-occurrence cancellation tests.

    The base recurrence is DAILY 09:30 Berlin, first occurrence
    2026-01-05 (Monday), no end: occurrences on 01-05, 01-06, 01-07,
    01-08, ...
    """

    def _expand_effective(self, recurrence, start, end):
        return expand_effective_meeting_recurrence_occurrences(
            meeting_recurrence=recurrence,
            range_start=start,
            range_end=end,
        )

    def _occurrence_on(self, recurrence, day, hour=9, minute=30):
        """The rule-produced occurrence whose local date is ``day``."""
        (occurrence,) = self._expand(
            recurrence,
            _utc(*day),
            _utc(day[0], day[1], day[2], 23, 59),
        )
        self.assertEqual(occurrence.original_local.hour, hour)
        self.assertEqual(occurrence.original_local.minute, minute)
        return occurrence

    def _materialize(self, recurrence, occurrence, *, actor=None, title="Mat"):
        return materialize_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=occurrence,
            actor=actor if actor is not None else self.alex,
            title=title,
        )

    def _cancel(self, meeting, *, actor=None):
        return cancel_meeting_recurrence_occurrence(
            meeting=meeting,
            actor=actor if actor is not None else self.alex,
        )

    def _window(self, recurrence):
        """A bounded window covering the first four occurrences."""
        tz = ZoneInfo(recurrence.timezone_name)
        start = datetime(2026, 1, 4, tzinfo=tz)
        end = datetime(2026, 1, 9, 23, 59, tzinfo=tz)
        return start, end

    def _cancelled_events(self, meeting):
        return AuditEvent.objects.filter(
            event_type=MeetingAuditEventType.CANCELLED,
            meeting=meeting,
        )


class MeetingRecurrenceCancelTest(MeetingRecurrenceCancelBase):
    """Core cancellation behavior (domain layer)."""

    # 1. An UPCOMING materialized recurring Meeting can be cancelled.

    def test_upcoming_materialized_occurrence_can_be_cancelled(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))
        meeting = self._materialize(recurrence, occurrence)
        self.assertEqual(meeting.status, Meeting.Status.UPCOMING)

        cancelled = self._cancel(meeting)

        self.assertEqual(cancelled.pk, meeting.pk)
        self.assertEqual(cancelled.status, Meeting.Status.CANCELLED)

    # 2/3. The Meeting row still exists with the same ID, cancelled.

    def test_meeting_row_retained_with_same_id_and_cancelled_status(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))
        meeting = self._materialize(recurrence, occurrence)
        meeting_pk = meeting.pk

        self._cancel(meeting)

        retained = Meeting.objects.get(pk=meeting_pk)
        self.assertEqual(retained.status, Meeting.Status.CANCELLED)

    # 4/5/6. Provenance: recurrence, original_scheduled_at,
    # scheduled_at all unchanged.

    def test_provenance_and_scheduled_time_unchanged(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))
        meeting = self._materialize(recurrence, occurrence)
        original = meeting.original_scheduled_at
        scheduled = meeting.scheduled_at
        recurrence_id = meeting.recurrence_id

        self._cancel(meeting)

        meeting.refresh_from_db()
        self.assertEqual(meeting.recurrence_id, recurrence_id)
        self.assertEqual(meeting.original_scheduled_at, original)
        self.assertEqual(meeting.scheduled_at, scheduled)
        self.assertEqual(meeting.title, "Mat")
        self.assertEqual(meeting.research_group_id, self.group.pk)

    # 7. IMPORTANT regression: a MOVED materialized occurrence is
    # excluded by its ORIGINAL occurrence identity.

    def test_moved_occurrence_is_cancelled_by_original_identity(self):
        # Raw occurrences: Monday 2026-01-05 10:00, Tuesday 10:00, ...
        recurrence = self._create_recurrence(local_time=time(10, 0))
        monday = self._occurrence_on(recurrence, (2026, 1, 5), 10, 0)
        meeting = self._materialize(recurrence, monday)

        # Move the occurrence: Monday 10:00 -> Tuesday 14:00.
        new_time = datetime(2026, 1, 6, 14, 0, tzinfo=BERLIN)
        rescheduled = reschedule_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=monday,
            scheduled_at=new_time,
            actor=self.alex,
            title="Moved",
        )
        self.assertEqual(rescheduled.scheduled_at, new_time)
        self.assertEqual(rescheduled.original_scheduled_at, monday.original_start)

        self._cancel(rescheduled)

        rescheduled.refresh_from_db()
        # Pinned regression: original = Monday 10:00, moved = Tuesday
        # 14:00, status cancelled — the stable occurrence identity is
        # the Monday occurrence.
        expected_original = datetime(2026, 1, 5, 10, 0, tzinfo=BERLIN)
        self.assertEqual(
            rescheduled.original_scheduled_at, expected_original,
        )
        self.assertEqual(rescheduled.scheduled_at, new_time)
        self.assertEqual(rescheduled.status, Meeting.Status.CANCELLED)

        exclusion = MeetingRecurrenceExclusion.objects.get(
            recurrence=recurrence,
        )
        self.assertEqual(
            exclusion.original_scheduled_at, expected_original,
        )

    # 8. Exactly one matching exclusion exists.

    def test_exactly_one_matching_exclusion(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))
        meeting = self._materialize(recurrence, occurrence)

        self._cancel(meeting)

        exclusions = MeetingRecurrenceExclusion.objects.filter(
            recurrence=recurrence,
        )
        self.assertEqual(exclusions.count(), 1)
        (exclusion,) = exclusions
        self.assertEqual(
            exclusion.original_scheduled_at,
            meeting.original_scheduled_at,
        )
        self.assertEqual(exclusion.created_by_id, self.alex.pk)

    # 9. Parent MeetingRecurrence remains unchanged.

    def test_parent_recurrence_unchanged(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))
        meeting = self._materialize(recurrence, occurrence)

        before = (
            recurrence.frequency, recurrence.interval, recurrence.weekdays,
            recurrence.start_date, recurrence.local_time,
            recurrence.timezone_name, recurrence.end_mode,
            recurrence.end_date, recurrence.occurrence_count,
            recurrence.updated_at,
        )

        self._cancel(meeting)

        recurrence.refresh_from_db()
        after = (
            recurrence.frequency, recurrence.interval, recurrence.weekdays,
            recurrence.start_date, recurrence.local_time,
            recurrence.timezone_name, recurrence.end_mode,
            recurrence.end_date, recurrence.occurrence_count,
            recurrence.updated_at,
        )
        self.assertEqual(before, after)

    # 10. Sections survive unchanged.

    def test_sections_survive_unchanged(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))
        meeting = self._materialize(recurrence, occurrence)
        extra = create_meeting_section(
            meeting=meeting, actor=self.alex, name="Decisions",
        )
        sections = list(
            meeting.meeting_sections.order_by("position", "id")
        )
        snapshot = [
            (s.pk, s.name, s.description, s.position, s.is_visible)
            for s in sections
        ]

        self._cancel(meeting)

        meeting.refresh_from_db()
        sections = list(
            meeting.meeting_sections.order_by("position", "id")
        )
        self.assertEqual(
            [(s.pk, s.name, s.description, s.position, s.is_visible)
             for s in sections],
            snapshot,
        )
        self.assertIsNotNone(MeetingSection.objects.filter(pk=extra.pk).first())

    # 11. Participants survive unchanged.

    def test_participants_survive_unchanged(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))
        meeting = self._materialize(recurrence, occurrence)
        add_meeting_participant(
            meeting=meeting, actor=self.alex, target_user=self.chris,
        )
        participant_ids = set(
            meeting.participant_relations
            .values_list("user_id", flat=True)
        )

        self._cancel(meeting)

        meeting.refresh_from_db()
        self.assertEqual(
            set(meeting.participant_relations.values_list("user_id", flat=True)),
            participant_ids,
        )
        self.assertTrue(
            MeetingParticipant.objects.filter(
                meeting=meeting, user=self.chris,
            ).exists()
        )

    # 12. Meeting notes survive unchanged.

    def test_notes_survive_unchanged(self):
        # Notes are authorable on LIVE Meetings only, while
        # cancellation targets UPCOMING ones — so the note is seeded
        # directly (ORM) to prove that cancellation never cascades
        # into Meeting-owned content.
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))
        meeting = self._materialize(recurrence, occurrence)
        section = meeting.meeting_sections.first()
        item = create_meeting_item(
            meeting=meeting,
            meeting_section=section,
            actor=self.alex,
            title="Budget",
        )
        note = MeetingNote.objects.create(
            meeting_item=item,
            author=self.alex,
            content="Cut 10%.",
        )

        self._cancel(meeting)

        note.refresh_from_db()
        self.assertEqual(note.content, "Cut 10%.")
        self.assertEqual(note.meeting_item_id, item.pk)
        item.refresh_from_db()
        self.assertEqual(item.title, "Budget")
        self.assertEqual(item.meeting_id, meeting.pk)

    # 13. Linked Work Items / content survive unchanged.

    def test_linked_work_items_survive_unchanged(self):
        recurrence = self._create_recurrence(
            scope="project", project=self.project,
        )
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))
        meeting = self._materialize(recurrence, occurrence)
        section = meeting.meeting_sections.first()
        item = create_meeting_item(
            meeting=meeting,
            meeting_section=section,
            actor=self.alex,
            title="Action",
        )
        task_type = (
            WorkItemTypeDefinition.objects
            .filter(project=self.project, kind="task")
            .first()
        )
        work_item = create_work_item_from_meeting_item(
            meeting_item=item,
            project=self.project,
            actor=self.alex,
            type_definition_id=task_type.pk,
            title="From the meeting",
        )

        self._cancel(meeting)

        link = MeetingItemWorkItem.objects.get(
            meeting_item=item, work_item=work_item,
        )
        self.assertEqual(link.meeting_note_id, None)
        self.assertEqual(work_item.title, "From the meeting")

    # 14. No sibling Meeting is changed.

    def test_sibling_meeting_unchanged(self):
        recurrence = self._create_recurrence()
        target = self._occurrence_on(recurrence, (2026, 1, 6))
        target_meeting = self._materialize(recurrence, target)
        sibling = self._materialize(
            recurrence, self._occurrence_on(recurrence, (2026, 1, 7)),
        )
        sibling_snapshot = (
            sibling.pk, sibling.title, sibling.scheduled_at,
            sibling.original_scheduled_at, sibling.status,
            sibling.updated_at,
        )

        self._cancel(target_meeting)

        sibling.refresh_from_db()
        self.assertEqual(
            (
                sibling.pk, sibling.title, sibling.scheduled_at,
                sibling.original_scheduled_at, sibling.status,
                sibling.updated_at,
            ),
            sibling_snapshot,
        )

    # 15. No neighboring occurrence is materialized.

    def test_no_neighboring_occurrence_materialized(self):
        recurrence = self._create_recurrence()
        meeting = self._materialize(
            recurrence, self._occurrence_on(recurrence, (2026, 1, 6)),
        )

        self._cancel(meeting)

        # Still exactly ONE concrete Meeting for the recurrence: the
        # cancelled one. Nothing was created for 01-05 or 01-07.
        meetings = list(
            Meeting.objects.filter(recurrence=recurrence)
            .order_by("original_scheduled_at")
        )
        self.assertEqual([m.pk for m in meetings], [meeting.pk])
        self.assertFalse(
            Meeting.objects.filter(
                recurrence=recurrence,
                original_scheduled_at=self._occurrence_on(
                    recurrence, (2026, 1, 7),
                ).original_start,
            ).exists()
        )

    # 16. Raw recurrence expansion remains unchanged.

    def test_raw_expansion_unchanged(self):
        recurrence = self._create_recurrence()
        start, end = self._window(recurrence)
        before = [
            o.original_start
            for o in self._expand(recurrence, start, end)
        ]
        meeting = self._materialize(
            recurrence, self._occurrence_on(recurrence, (2026, 1, 6)),
        )

        self._cancel(meeting)

        after = [
            o.original_start
            for o in self._expand(recurrence, start, end)
        ]
        self.assertEqual(before, after)

    # 17. Effective expansion omits the cancelled occurrence.

    def test_effective_expansion_omits_cancelled_occurrence(self):
        recurrence = self._create_recurrence()
        start, end = self._window(recurrence)
        meeting = self._materialize(
            recurrence, self._occurrence_on(recurrence, (2026, 1, 6)),
        )
        raw = {
            o.original_start for o in self._expand(recurrence, start, end)
        }

        self._cancel(meeting)

        effective = {
            o.original_start
            for o in self._expand_effective(recurrence, start, end)
        }
        self.assertEqual(
            effective,
            raw - {meeting.original_scheduled_at},
        )

    # 18. COUNT does not generate a replacement occurrence.

    def test_count_limit_does_not_generate_replacement(self):
        # Raw COUNT=3: A (01-05), B (01-06), C (01-07).
        recurrence = self._create_recurrence(
            end_mode="count", occurrence_count=3,
        )
        start, end = self._window(recurrence)
        raw_starts = [
            o.original_start for o in self._expand(recurrence, start, end)
        ]
        self.assertEqual(len(raw_starts), 3)

        meeting = self._materialize(
            recurrence, self._occurrence_on(recurrence, (2026, 1, 6)),
        )
        self._cancel(meeting)

        # Raw unchanged: still exactly A, B, C.
        self.assertEqual(
            [o.original_start for o in self._expand(recurrence, start, end)],
            raw_starts,
        )
        # Effective: A, C — never A, C, D.
        effective = [
            o.original_start
            for o in self._expand_effective(recurrence, start, end)
        ]
        self.assertEqual(effective, [raw_starts[0], raw_starts[2]])
        self.assertEqual(len(effective), 2)
        # And nothing beyond the count is materialized either.
        self.assertEqual(
            Meeting.objects.filter(recurrence=recurrence).count(), 1,
        )


class MeetingRecurrenceCancelIdempotencyTest(MeetingRecurrenceCancelBase):
    """Idempotent replay + inconsistent-pair repair."""

    def _cancelled_once(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))
        meeting = self._materialize(recurrence, occurrence)
        self._cancel(meeting)
        return recurrence, meeting

    # 19. Repeating cancellation is idempotent.

    def test_repeated_cancellation_is_idempotent(self):
        _, meeting = self._cancelled_once()
        meeting.refresh_from_db()
        before = (
            meeting.pk, meeting.status, meeting.title,
            meeting.scheduled_at, meeting.original_scheduled_at,
            meeting.updated_at,
        )

        replay = self._cancel(meeting)

        self.assertEqual(replay.pk, meeting.pk)
        meeting.refresh_from_db()
        self.assertEqual(
            (
                meeting.pk, meeting.status, meeting.title,
                meeting.scheduled_at, meeting.original_scheduled_at,
                meeting.updated_at,
            ),
            before,
        )

    # 20. Repeated cancellation produces no duplicate exclusion.

    def test_repeated_cancellation_no_duplicate_exclusion(self):
        recurrence, meeting = self._cancelled_once()
        first_exclusion = MeetingRecurrenceExclusion.objects.get(
            recurrence=recurrence,
        )

        self._cancel(meeting)

        exclusions = MeetingRecurrenceExclusion.objects.filter(
            recurrence=recurrence,
        )
        self.assertEqual(exclusions.count(), 1)
        self.assertEqual(
            exclusions.first().pk, first_exclusion.pk,
        )

    # 21. Repeated cancellation produces no duplicate event.

    def test_repeated_cancellation_no_duplicate_event(self):
        _, meeting = self._cancelled_once()

        self._cancel(meeting)

        self.assertEqual(self._cancelled_events(meeting).count(), 1)

    # 22. First cancellation records exactly one canonical event.

    def test_first_cancellation_records_exactly_one_event(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))
        meeting = self._materialize(recurrence, occurrence)

        self._cancel(meeting)

        events = self._cancelled_events(meeting)
        self.assertEqual(events.count(), 1)
        (event,) = events
        self.assertEqual(event.event_type, "meeting.cancelled")
        self.assertEqual(event.actor_id, self.alex.pk)
        self.assertEqual(event.research_group_id, self.group.pk)
        self.assertIsNone(event.project_id)
        self.assertEqual(
            event.data["changes"]["originalScheduledAt"],
            meeting.original_scheduled_at.astimezone(dt_timezone.utc).isoformat(),
        )
        self.assertEqual(
            event.data["changes"]["scheduledAt"],
            meeting.scheduled_at.astimezone(dt_timezone.utc).isoformat(),
        )

    # Inconsistent-pair repair: a pre-existing exclusion for an
    # still-active upcoming Meeting is reused, and the cancellation
    # completes (no duplicate exclusion, exactly one event).

    def test_preexisting_exclusion_is_reused(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))
        meeting = self._materialize(recurrence, occurrence)
        # Simulate a legacy inconsistent pair: the exclusion exists
        # while the Meeting is still active.
        preexisting = MeetingRecurrenceExclusion.objects.create(
            recurrence=recurrence,
            original_scheduled_at=meeting.original_scheduled_at,
            created_by=self.chris,
        )

        cancelled = self._cancel(meeting)

        self.assertEqual(cancelled.status, Meeting.Status.CANCELLED)
        exclusions = MeetingRecurrenceExclusion.objects.filter(
            recurrence=recurrence,
        )
        self.assertEqual(exclusions.count(), 1)
        self.assertEqual(exclusions.first().pk, preexisting.pk)
        self.assertEqual(self._cancelled_events(meeting).count(), 1)


class MeetingRecurrenceCancelLifecycleGuardTest(MeetingRecurrenceCancelBase):
    """Terminal-state and cross-operation guards."""

    def _materialized(self, day=(2026, 1, 6)):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, day)
        meeting = self._materialize(recurrence, occurrence)
        return recurrence, occurrence, meeting

    # 23. Cancelling LIVE is rejected and causes no changes.

    def test_cancelling_live_meeting_rejected(self):
        recurrence, occurrence, meeting = self._materialized()
        start_meeting(meeting=meeting, actor=self.alex)
        self.assertEqual(meeting.status, Meeting.Status.LIVE)

        with self.assertRaises(MeetingDomainError):
            self._cancel(meeting)

        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.LIVE)
        self.assertFalse(
            MeetingRecurrenceExclusion.objects.filter(
                recurrence=recurrence,
            ).exists()
        )
        self.assertEqual(self._cancelled_events(meeting).count(), 0)

    # 24. Cancelling COMPLETED is rejected and causes no changes.

    def test_cancelling_completed_meeting_rejected(self):
        recurrence, occurrence, meeting = self._materialized()
        start_meeting(meeting=meeting, actor=self.alex)
        end_meeting(meeting=meeting, actor=self.alex)
        self.assertEqual(meeting.status, Meeting.Status.COMPLETED)

        with self.assertRaises(MeetingDomainError):
            self._cancel(meeting)

        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.COMPLETED)
        self.assertFalse(
            MeetingRecurrenceExclusion.objects.filter(
                recurrence=recurrence,
            ).exists()
        )
        self.assertEqual(self._cancelled_events(meeting).count(), 0)

    # 25. No generic lifecycle operation can produce cancelled (the
    # dedicated operation is the only path to the state).

    def test_generic_lifecycle_operations_never_produce_cancelled(self):
        recurrence, occurrence, meeting = self._materialized()

        start_meeting(meeting=meeting, actor=self.alex)
        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.LIVE)

        end_meeting(meeting=meeting, actor=self.alex)
        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.COMPLETED)

        reopen_meeting(meeting=meeting, actor=self.alex)
        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.LIVE)

        end_meeting(meeting=meeting, actor=self.alex)
        meeting.refresh_from_db()
        # Ordinary metadata updates cannot touch the status either.
        update_meeting(
            meeting=meeting, actor=self.alex, title="Renamed",
        )
        meeting.refresh_from_db()
        self.assertEqual(meeting.title, "Renamed")
        self.assertEqual(meeting.status, Meeting.Status.COMPLETED)
        self.assertNotEqual(
            meeting.status, Meeting.Status.CANCELLED,
        )
        self.assertFalse(
            MeetingRecurrenceExclusion.objects.filter(
                recurrence=recurrence,
            ).exists()
        )

    # 26. A cancelled Meeting cannot transition back to active states.

    def test_cancelled_meeting_cannot_transition_back(self):
        recurrence, occurrence, meeting = self._materialized()
        self._cancel(meeting)
        self.assertEqual(meeting.status, Meeting.Status.CANCELLED)

        for action in (start_meeting, end_meeting, reopen_meeting):
            with self.assertRaises(MeetingDomainError):
                action(meeting=meeting, actor=self.alex)
            meeting.refresh_from_db()
            self.assertEqual(meeting.status, Meeting.Status.CANCELLED)
        self.assertEqual(
            MeetingRecurrenceExclusion.objects.filter(
                recurrence=recurrence,
            ).count(),
            1,
        )

    # 27. A cancelled Meeting cannot be rescheduled.

    def test_cancelled_meeting_cannot_be_rescheduled(self):
        recurrence, occurrence, meeting = self._materialized()
        self._cancel(meeting)
        scheduled = meeting.scheduled_at

        new_time = datetime(2026, 1, 20, 10, 0, tzinfo=BERLIN)
        with self.assertRaises(MeetingDomainError):
            reschedule_meeting_recurrence_occurrence(
                recurrence=recurrence,
                occurrence=occurrence,
                scheduled_at=new_time,
                actor=self.alex,
                title="Move",
            )

        meeting.refresh_from_db()
        self.assertEqual(meeting.scheduled_at, scheduled)
        self.assertEqual(meeting.status, Meeting.Status.CANCELLED)
        self.assertEqual(
            AuditEvent.objects.filter(
                event_type=MeetingAuditEventType.RESCHEDULED,
                meeting=meeting,
            ).count(),
            0,
        )

    # 28. Materialization cannot recreate the excluded occurrence.

    def test_materialization_cannot_recreate_excluded_occurrence(self):
        recurrence, occurrence, meeting = self._materialized()
        self._cancel(meeting)

        again = self._materialize(recurrence, occurrence)

        # The idempotent materialization returns the SAME (cancelled)
        # Meeting; it never creates a second one for the original
        # occurrence.
        self.assertEqual(again.pk, meeting.pk)
        self.assertEqual(
            Meeting.objects.filter(
                recurrence=recurrence,
                original_scheduled_at=occurrence.original_start,
            ).count(),
            1,
        )
        again.refresh_from_db()
        self.assertEqual(again.status, Meeting.Status.CANCELLED)

    # The virtual-exclusion gate on materialized occurrences is
    # unchanged by cancellation semantics.

    def test_virtual_exclusion_of_materialized_occurrence_still_rejected(
        self,
    ):
        recurrence, occurrence, meeting = self._materialized()

        with self.assertRaises(MeetingDomainError):
            exclude_meeting_recurrence_occurrence(
                recurrence=recurrence,
                occurrence=occurrence,
                actor=self.alex,
            )

        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.UPCOMING)
        self.assertFalse(
            MeetingRecurrenceExclusion.objects.filter(
                recurrence=recurrence,
            ).exists()
        )


class MeetingRecurrenceCancelDeleteGuardTest(MeetingRecurrenceCancelBase):
    """Generic hard-delete protection for recurring Meetings."""

    # 29. delete_meeting rejects a recurring Meeting.

    def test_delete_rejects_recurring_meeting(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))
        meeting = self._materialize(recurrence, occurrence)
        sections = meeting.meeting_sections.count()

        with self.assertRaises(MeetingDomainError):
            delete_meeting(meeting=meeting, actor=self.alex)

        # The Meeting (and its content) is completely unchanged.
        self.assertTrue(Meeting.objects.filter(pk=meeting.pk).exists())
        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.UPCOMING)
        self.assertEqual(meeting.meeting_sections.count(), sections)
        self.assertFalse(
            MeetingRecurrenceExclusion.objects.filter(
                recurrence=recurrence,
            ).exists()
        )

    # 30. Standalone Meeting deletion keeps its existing behavior.

    def test_delete_standalone_meeting_still_works(self):
        standalone = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="One-off",
            scheduled_at=datetime(2026, 3, 2, 10, 0, tzinfo=BERLIN),
        )
        self.assertIsNone(standalone.recurrence_id)

        delete_meeting(meeting=standalone, actor=self.alex)

        self.assertFalse(
            Meeting.objects.filter(pk=standalone.pk).exists()
        )


class MeetingRecurrenceCancelAuthorizationTest(MeetingRecurrenceCancelBase):
    """Canonical scoped Meeting write authorization for cancellation."""

    # 31. Project viewer cannot cancel.

    def test_project_viewer_cannot_cancel(self):
        recurrence = self._create_recurrence(
            scope="project", project=self.project,
        )
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))
        meeting = self._materialize(recurrence, occurrence)

        with self.assertRaises(MeetingDomainError):
            self._cancel(meeting, actor=self.laura)

        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.UPCOMING)
        self.assertFalse(
            MeetingRecurrenceExclusion.objects.filter(
                recurrence=recurrence,
            ).exists()
        )

    # Outsider (no group membership) cannot cancel.

    def test_outsider_cannot_cancel(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))
        meeting = self._materialize(recurrence, occurrence)

        with self.assertRaises(MeetingDomainError):
            self._cancel(meeting, actor=self.maria)

        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.UPCOMING)

    # 32. Canonical group write authorization is preserved.

    def test_group_member_can_cancel(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))
        meeting = self._materialize(recurrence, occurrence)

        cancelled = self._cancel(meeting, actor=self.chris)

        self.assertEqual(cancelled.status, Meeting.Status.CANCELLED)
        self.assertEqual(
            MeetingRecurrenceExclusion.objects.filter(
                recurrence=recurrence,
            ).count(),
            1,
        )

    # 33. Canonical project write authorization is preserved.

    def test_project_member_can_cancel(self):
        recurrence = self._create_recurrence(
            scope="project", project=self.project,
        )
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))
        meeting = self._materialize(recurrence, occurrence)

        cancelled = self._cancel(meeting, actor=self.chris)

        self.assertEqual(cancelled.status, Meeting.Status.CANCELLED)
        self.assertEqual(self._cancelled_events(meeting).count(), 1)

    # 34. Archived-project restriction is preserved.

    def test_archived_project_cannot_cancel(self):
        recurrence = self._create_recurrence(
            scope="project", project=self.project,
        )
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))
        meeting = self._materialize(recurrence, occurrence)
        archive_project(project=self.project, actor=self.alex)
        # Fresh instance: the pre-archive object caches its Project
        # relation; a real request always resolves the Meeting (and its
        # current Project state) from the database.
        meeting = Meeting.objects.get(pk=meeting.pk)

        with self.assertRaises(MeetingDomainError):
            self._cancel(meeting)

        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.UPCOMING)
        self.assertFalse(
            MeetingRecurrenceExclusion.objects.filter(
                recurrence=recurrence,
            ).exists()
        )


class MeetingRecurrenceCancelApiGuardTest(MeetingRecurrenceCancelBase):
    """HTTP-level guards: recurring Meetings cannot be destroyed or
    lifecycle-smuggled through the existing Meeting endpoints."""

    def setUp(self):
        super().setUp()
        from rest_framework.test import APIClient

        self.client = APIClient()
        self.recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(self.recurrence, (2026, 1, 6))
        self.meeting = self._materialize(self.recurrence, occurrence)
        self.client.force_login(self.alex)

    # DELETE on a recurring Meeting is refused with a domain error
    # (400), not a silent 204.

    def test_delete_endpoint_rejects_recurring_meeting(self):
        response = self.client.delete(
            f"/api/meetings/{self.meeting.pk}/",
        )

        self.assertEqual(response.status_code, 400)
        self.assertTrue(Meeting.objects.filter(pk=self.meeting.pk).exists())

    # The Meeting PATCH surface cannot smuggle a status change.

    def test_patch_status_field_rejected(self):
        response = self.client.patch(
            f"/api/meetings/{self.meeting.pk}/",
            {"status": "cancelled"},
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 400)
        self.meeting.refresh_from_db()
        self.assertEqual(self.meeting.status, Meeting.Status.UPCOMING)


class MeetingRecurrenceCancelVirtualBoundaryTest(MeetingRecurrenceCancelBase):
    """Slice-6 virtual exclusion behavior remains unchanged."""

    # 35. Virtual exclusion still works for a virtual occurrence.

    def test_virtual_exclusion_still_works(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))

        exclusion = exclude_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=occurrence,
            actor=self.alex,
        )

        self.assertIsNotNone(exclusion.pk)
        self.assertEqual(
            exclusion.original_scheduled_at, occurrence.original_start,
        )
        self.assertFalse(
            Meeting.objects.filter(recurrence=recurrence).exists()
        )
        start, end = self._window(recurrence)
        effective = {
            o.original_start
            for o in self._expand_effective(recurrence, start, end)
        }
        self.assertNotIn(occurrence.original_start, effective)

    # Cancelling a Meeting that has no recurrence provenance is
    # rejected (standalone Meetings have no occurrence identity).

    def test_cancelling_standalone_meeting_rejected(self):
        standalone = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="One-off",
            scheduled_at=datetime(2026, 3, 2, 10, 0, tzinfo=BERLIN),
        )

        with self.assertRaises(MeetingDomainError):
            self._cancel(standalone)

        self.assertTrue(Meeting.objects.filter(pk=standalone.pk).exists())
        standalone.refresh_from_db()
        self.assertEqual(standalone.status, Meeting.Status.UPCOMING)


class MeetingRecurrenceCancelConcurrencyTest(TransactionTestCase):
    """Concurrent cancellation of one materialized Meeting (real
    PostgreSQL).

    Same repository concurrency harness as materialization /
    exclusion: standalone TransactionTestCase with committed fixtures
    (a TestCase-based base would wrap the test in a class-level
    atomic block invisible to the racing threads), threaded service
    calls, a barrier to align the racers. Two racing cancellations
    converge on the canonical final state: one Meeting row (cancelled),
    one exclusion row, one meeting.cancelled event.
    """

    def setUp(self):
        self.alex = User.objects.create_user(
            username="cancelrace-alex", password="Pass1!",
        )
        self.group = ResearchGroup.objects.create(
            name="Cancellation Race Group", created_by=self.alex,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        series = create_meeting_series(
            research_group=self.group,
            actor=self.alex,
            title="Race Template",
        )
        create_series_section(
            meeting_series=series,
            actor=self.alex,
            name="Agenda",
        )
        self.recurrence = create_meeting_recurrence(
            research_group=self.group,
            actor=self.alex,
            meeting_series=series,
            title="Race",
            frequency="daily",
            interval=1,
            start_date=date(2026, 1, 5),
            local_time=time(9, 30),
            timezone_name="Europe/Berlin",
        )
        (self.occurrence,) = expand_meeting_recurrence_occurrences(
            meeting_recurrence=self.recurrence,
            range_start=_utc(2026, 1, 6),
            range_end=_utc(2026, 1, 6, 23, 59),
        )
        self.meeting = materialize_meeting_recurrence_occurrence(
            recurrence=self.recurrence,
            occurrence=self.occurrence,
            actor=self.alex,
            title="Race",
        )

    def test_concurrent_cancellation_is_safe(self):
        results = []
        errors = []
        barrier = threading.Barrier(2)

        def cancel():
            try:
                barrier.wait(timeout=10)
                results.append(
                    cancel_meeting_recurrence_occurrence(
                        meeting=self.meeting, actor=self.alex,
                    )
                )
            except Exception as exc:  # pragma: no cover - diagnostics
                errors.append(exc)
            finally:
                db_connection.close()

        threads = [
            threading.Thread(target=cancel),
            threading.Thread(target=cancel),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)

        self.assertEqual(errors, [])
        self.assertEqual({m.pk for m in results}, {self.meeting.pk})
        self.meeting.refresh_from_db()
        self.assertEqual(self.meeting.status, Meeting.Status.CANCELLED)
        self.assertEqual(
            MeetingRecurrenceExclusion.objects.filter(
                recurrence=self.recurrence,
            ).count(),
            1,
        )
        self.assertEqual(
            AuditEvent.objects.filter(
                event_type=MeetingAuditEventType.CANCELLED,
                meeting=self.meeting,
            ).count(),
            1,
        )
