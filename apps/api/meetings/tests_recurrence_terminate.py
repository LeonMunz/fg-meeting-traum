"""Tests for canonical termination of a whole MeetingRecurrence.

Terminating a recurrence is ONE atomic domain operation
(``terminate_meeting_recurrence``): it persists the immutable
``terminated_at`` instant, suppresses every future VIRTUAL occurrence
(from the single persisted column — never an unbounded exclusion
collection), and cancels — without deleting — every still-``upcoming``
materialized Meeting whose effective ``scheduled_at`` lies at or after
the observed instant, reusing the canonical single-occurrence
cancellation invariants (content preserved, one exclusion keyed by the
immutable ORIGINAL occurrence identity, one ``meeting.cancelled``
event). Live / completed / already-cancelled Meetings and Meetings
before the instant are untouched, and repeated termination is
idempotent.
"""

import threading
import time as time_module
from datetime import date, datetime, time, timezone as dt_timezone
from unittest import mock
from zoneinfo import ZoneInfo

from audit_history.models import AuditEvent
from django.contrib.auth import get_user_model
from django.db import connection as db_connection, transaction
from django.test import TransactionTestCase
from rest_framework import status
from rest_framework.test import APIClient

from projects.models import ProjectMembership, WorkItemTypeDefinition
from projects.services import archive_project, remove_membership
from research_groups.models import ResearchGroup, ResearchGroupMembership
from research_groups.services import remove_research_group_membership

from .models import (
    Meeting,
    MeetingItem,
    MeetingItemWorkItem,
    MeetingNote,
    MeetingParticipant,
    MeetingRecurrence,
    MeetingRecurrenceExclusion,
    MeetingSection,
    MeetingSeries,
)
from .services import (
    MeetingAuditEventType,
    MeetingDomainError,
    create_meeting_item,
    create_meeting_recurrence,
    create_meeting_series,
    create_series_section,
    create_work_item_from_meeting_item,
    end_meeting,
    exclude_meeting_recurrence_occurrence,
    expand_effective_meeting_recurrence_occurrences,
    expand_meeting_recurrence_occurrences,
    list_personal_meeting_recurrence_overviews,
    materialize_meeting_recurrence_occurrence,
    record_audit_event,
    reschedule_meeting_recurrence_occurrence,
    start_meeting,
    terminate_meeting_recurrence,
)
from .tests_recurrence import MeetingRecurrenceBase, _utc

User = get_user_model()
BERLIN = ZoneInfo("Europe/Berlin")
UTC = dt_timezone.utc

# Frozen termination instant: Thursday 2026-01-08 12:00 UTC
# (13:00 Europe/Berlin) — AFTER the Jan 8 09:30 Berlin (08:30 UTC)
# occurrence and BEFORE the Jan 9 occurrence. The fixture recurrence
# (daily 09:30 Berlin, first occurrence Monday 2026-01-05) therefore
# has: Jan 5..Jan 8 occurrences before the instant, Jan 9+ after it.
TERMINATED_AT = _utc(2026, 1, 8, 12, 0)


class MeetingRecurrenceTerminateBase(MeetingRecurrenceBase):
    """Shared helpers for whole-series termination tests.

    The clock observation convention: tests freeze the ONE
    ``_termination_instant`` function (the repository's convention for
    a single frozen clock observation per operation).
    """

    def setUp(self):
        super().setUp()
        self._clock_patch = mock.patch(
            "meetings.services._termination_instant",
            return_value=TERMINATED_AT,
        )
        self._clock_patch.start()
        self.addCleanup(self._clock_patch.stop)

    def _terminate(self, recurrence, *, actor=None):
        return terminate_meeting_recurrence(
            recurrence=recurrence,
            actor=actor if actor is not None else self.alex,
        )

    def _occurrence_on(self, recurrence, day):
        """The rule-produced occurrence whose local date is ``day``."""
        (occurrence,) = self._expand(
            recurrence,
            _utc(*day),
            _utc(day[0], day[1], day[2], 23, 59),
        )
        return occurrence

    def _materialize(self, recurrence, occurrence, *, title="Mat"):
        return materialize_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=occurrence,
            actor=self.alex,
            title=title,
        )

    def _effective(self, recurrence, start, end):
        return expand_effective_meeting_recurrence_occurrences(
            meeting_recurrence=recurrence,
            range_start=start,
            range_end=end,
        )

    def _cancelled_events(self, meeting=None):
        query = AuditEvent.objects.filter(
            event_type=MeetingAuditEventType.CANCELLED,
        )
        if meeting is not None:
            query = query.filter(meeting=meeting)
        return query

    def _full_stack(self, recurrence):
        """Materialize the first six occurrences in the lifecycle
        states termination must reason about:

        - Jan 5: completed (historical)
        - Jan 6: live (in progress)
        - Jan 7: upcoming, effective time before the instant
        - Jan 8: upcoming, effective time before the instant
        - Jan 9: upcoming, effective time at/after the instant
        - Jan 10: upcoming, effective time at/after the instant
        """
        jan5 = self._materialize(recurrence, self._occurrence_on(recurrence, (2026, 1, 5)))
        start_meeting(meeting=jan5, actor=self.alex)
        end_meeting(meeting=jan5, actor=self.alex)
        jan6 = self._materialize(recurrence, self._occurrence_on(recurrence, (2026, 1, 6)))
        start_meeting(meeting=jan6, actor=self.alex)
        jan7 = self._materialize(recurrence, self._occurrence_on(recurrence, (2026, 1, 7)))
        jan8 = self._materialize(recurrence, self._occurrence_on(recurrence, (2026, 1, 8)))
        jan9 = self._materialize(recurrence, self._occurrence_on(recurrence, (2026, 1, 9)))
        jan10 = self._materialize(recurrence, self._occurrence_on(recurrence, (2026, 1, 10)))
        return {
            "jan5": jan5,
            "jan6": jan6,
            "jan7": jan7,
            "jan8": jan8,
            "jan9": jan9,
            "jan10": jan10,
        }


class MeetingRecurrenceTerminateTest(MeetingRecurrenceTerminateBase):
    """1-11. Core termination behavior (domain layer)."""

    # 1. An active recurrence can be terminated by an authorized actor.

    def test_active_recurrence_can_be_terminated(self):
        recurrence = self._create_recurrence()
        self._materialize(
            recurrence, self._occurrence_on(recurrence, (2026, 1, 9)),
        )

        result = self._terminate(recurrence)

        self.assertEqual(result.pk, recurrence.pk)
        recurrence.refresh_from_db()
        self.assertEqual(recurrence.terminated_at, TERMINATED_AT)
        self.assertEqual(result.terminated_at, TERMINATED_AT)

    # 2. The terminal state is persisted (and is a real timestamp).

    def test_terminated_state_is_persisted(self):
        recurrence = self._create_recurrence()

        self._terminate(recurrence)

        fresh = MeetingRecurrence.objects.get(pk=recurrence.pk)
        self.assertIsNotNone(fresh.terminated_at)
        self.assertEqual(fresh.terminated_at, TERMINATED_AT)
        self.assertIsNotNone(fresh.terminated_at.tzinfo)
        # The persisted instant is the ONE observed instant.
        self.assertEqual(fresh.terminated_at, TERMINATED_AT)

    # 3. Rule, title, Template reference, participant intent unchanged.

    def test_rule_template_and_intent_unchanged(self):
        recurrence = self._create_recurrence()
        before = (
            recurrence.frequency,
            recurrence.interval,
            recurrence.weekdays,
            recurrence.start_date,
            recurrence.local_time,
            recurrence.timezone_name,
            recurrence.end_mode,
            recurrence.end_date,
            recurrence.occurrence_count,
            recurrence.title,
            recurrence.series_id,
        )
        series_pk = recurrence.series_id

        self._terminate(recurrence)

        recurrence.refresh_from_db()
        self.assertEqual(
            (
                recurrence.frequency,
                recurrence.interval,
                recurrence.weekdays,
                recurrence.start_date,
                recurrence.local_time,
                recurrence.timezone_name,
                recurrence.end_mode,
                recurrence.end_date,
                recurrence.occurrence_count,
                recurrence.title,
                recurrence.series_id,
            ),
            before,
        )
        self.assertEqual(recurrence.series_id, series_pk)

    # 4. Future virtual occurrences disappear from the effective set;
    #    the raw rule is unchanged.

    def test_future_virtual_occurrences_absent_effective_expansion(self):
        recurrence = self._create_recurrence()

        self._terminate(recurrence)

        recurrence.refresh_from_db()
        window = (_utc(2026, 1, 8), _utc(2026, 1, 11, 23, 59))
        raw = self._expand(recurrence, *window)
        # The RAW rule still produces Jan 8, 9, 10, 11 (unchanged rule,
        # stable identities).
        self.assertEqual(len(raw), 4)
        effective = self._effective(recurrence, *window)
        # Only the Jan 8 occurrence (08:30 UTC < the 12:00 UTC
        # instant) remains effective.
        self.assertEqual(len(effective), 1)
        self.assertEqual(effective[0].original_start, raw[0].original_start)

    def test_past_virtual_occurrences_still_effective(self):
        recurrence = self._create_recurrence()

        self._terminate(recurrence)

        recurrence.refresh_from_db()
        effective = self._effective(
            recurrence, _utc(2026, 1, 5), _utc(2026, 1, 8, 8, 30),
        )
        self.assertEqual(
            [o.original_start.date() for o in effective],
            [date(2026, 1, 5), date(2026, 1, 6), date(2026, 1, 7),
             date(2026, 1, 8)],
        )

    # 5. Future materialization is rejected without creating a Meeting.

    def test_future_materialization_rejected_no_meeting(self):
        recurrence = self._create_recurrence()
        future = self._occurrence_on(recurrence, (2026, 1, 9))

        self._terminate(recurrence)

        with self.assertRaises(MeetingDomainError):
            self._materialize(recurrence, future)
        self.assertFalse(
            Meeting.objects.filter(
                recurrence=recurrence,
                original_scheduled_at=future.original_start,
            ).exists()
        )
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 0)

    def test_future_virtual_exclusion_rejected(self):
        recurrence = self._create_recurrence()
        future = self._occurrence_on(recurrence, (2026, 1, 9))

        self._terminate(recurrence)

        with self.assertRaises(MeetingDomainError):
            exclude_meeting_recurrence_occurrence(
                recurrence=recurrence,
                occurrence=future,
                actor=self.alex,
            )
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 0)

    # 6. Future upcoming concrete Meetings are cancelled, not deleted.

    def test_future_upcoming_meetings_cancelled_not_deleted(self):
        recurrence = self._create_recurrence()
        meetings = self._full_stack(recurrence)
        pk9 = meetings["jan9"].pk
        pk10 = meetings["jan10"].pk
        scheduled9 = meetings["jan9"].scheduled_at
        scheduled10 = meetings["jan10"].scheduled_at

        self._terminate(recurrence)

        for pk, scheduled in ((pk9, scheduled9), (pk10, scheduled10)):
            retained = Meeting.objects.get(pk=pk)
            self.assertEqual(retained.status, Meeting.Status.CANCELLED)
            self.assertEqual(retained.scheduled_at, scheduled)
            self.assertIsNotNone(retained.recurrence_id)
            self.assertIsNotNone(retained.original_scheduled_at)

    def test_preserved_meetings_untouched(self):
        recurrence = self._create_recurrence()
        meetings = self._full_stack(recurrence)

        self._terminate(recurrence)

        meetings["jan5"].refresh_from_db()
        self.assertEqual(
            meetings["jan5"].status, Meeting.Status.COMPLETED,
        )
        meetings["jan6"].refresh_from_db()
        self.assertEqual(meetings["jan6"].status, Meeting.Status.LIVE)
        for key in ("jan7", "jan8"):
            meetings[key].refresh_from_db()
            self.assertEqual(meetings[key].status, Meeting.Status.UPCOMING)
        # No exclusion and no cancellation event for the preserved
        # Meetings.
        for key in ("jan5", "jan6", "jan7", "jan8"):
            meeting = meetings[key]
            self.assertFalse(
                MeetingRecurrenceExclusion.objects.filter(
                    recurrence=recurrence,
                    original_scheduled_at=meeting.original_scheduled_at,
                ).exists()
            )
            self.assertEqual(self._cancelled_events(meeting).count(), 0)

    def test_exactly_one_exclusion_per_cancelled_meeting_by_original(self):
        recurrence = self._create_recurrence()
        meetings = self._full_stack(recurrence)

        self._terminate(recurrence)

        exclusions = (
            MeetingRecurrenceExclusion.objects.filter(
                recurrence=recurrence,
            ).order_by("original_scheduled_at")
        )
        self.assertEqual([
            e.original_scheduled_at for e in exclusions
        ], [
            meetings["jan9"].original_scheduled_at,
            meetings["jan10"].original_scheduled_at,
        ])
        self.assertEqual(
            set(e.created_by_id for e in exclusions), {self.alex.pk}
        )

    def test_one_cancelled_event_per_cancelled_meeting(self):
        recurrence = self._create_recurrence()
        meetings = self._full_stack(recurrence)

        self._terminate(recurrence)

        for key in ("jan9", "jan10"):
            meeting = meetings[key]
            events = self._cancelled_events(meeting)
            self.assertEqual(events.count(), 1)
            event = events.get()
            self.assertEqual(event.actor_id, self.alex.pk)
        # No events at all for the preserved Meetings.
        self.assertEqual(
            self._cancelled_events().filter(
                meeting__in=[
                    meetings["jan5"],
                    meetings["jan6"],
                    meetings["jan7"],
                    meetings["jan8"],
                ],
            ).count(),
            0,
        )

    # 7. A moved Meeting is judged by its EFFECTIVE scheduled time and
    #    excluded by its immutable ORIGINAL identity.

    def test_moved_forward_meeting_cancelled_by_original_identity(self):
        recurrence = self._create_recurrence()
        jan9 = self._materialize(
            recurrence, self._occurrence_on(recurrence, (2026, 1, 9)),
        )
        original = jan9.original_scheduled_at
        moved = datetime(2026, 1, 12, 8, 30, tzinfo=UTC)
        reschedule_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=self._occurrence_on(recurrence, (2026, 1, 9)),
            scheduled_at=moved,
            actor=self.alex,
            title="Moved forward",
        )
        jan9.refresh_from_db()
        self.assertEqual(jan9.scheduled_at, moved)

        self._terminate(recurrence)

        jan9.refresh_from_db()
        self.assertEqual(jan9.status, Meeting.Status.CANCELLED)
        self.assertEqual(jan9.scheduled_at, moved)
        self.assertEqual(jan9.original_scheduled_at, original)
        exclusion = MeetingRecurrenceExclusion.objects.get(
            recurrence=recurrence,
        )
        self.assertEqual(exclusion.original_scheduled_at, original)

    def test_moved_earlier_meeting_preserved(self):
        recurrence = self._create_recurrence()
        jan9 = self._materialize(
            recurrence, self._occurrence_on(recurrence, (2026, 1, 9)),
        )
        earlier = datetime(2026, 1, 7, 15, 0, tzinfo=UTC)
        reschedule_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=self._occurrence_on(recurrence, (2026, 1, 9)),
            scheduled_at=earlier,
            actor=self.alex,
            title="Moved earlier",
        )
        jan9.refresh_from_db()
        self.assertEqual(jan9.scheduled_at, earlier)

        self._terminate(recurrence)

        jan9.refresh_from_db()
        self.assertEqual(jan9.status, Meeting.Status.UPCOMING)
        self.assertFalse(
            MeetingRecurrenceExclusion.objects.filter(
                recurrence=recurrence,
            ).exists()
        )
        self.assertEqual(self._cancelled_events(jan9).count(), 0)

    def test_meeting_exactly_at_termination_instant_cancelled(self):
        recurrence = self._create_recurrence()
        jan9 = self._materialize(
            recurrence, self._occurrence_on(recurrence, (2026, 1, 9)),
        )
        reschedule_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=self._occurrence_on(recurrence, (2026, 1, 9)),
            scheduled_at=TERMINATED_AT,
            actor=self.alex,
            title="At the instant",
        )
        jan9.refresh_from_db()
        self.assertEqual(jan9.scheduled_at, TERMINATED_AT)

        self._terminate(recurrence)

        jan9.refresh_from_db()
        self.assertEqual(jan9.status, Meeting.Status.CANCELLED)

    # 8. Meeting-owned content survives termination.

    def test_content_survives_termination(self):
        recurrence = self._create_recurrence(
            scope="project", project=self.project,
        )
        jan9 = self._materialize(
            recurrence, self._occurrence_on(recurrence, (2026, 1, 9)),
        )
        section = jan9.meeting_sections.first()
        item = create_meeting_item(
            meeting=jan9, meeting_section=section, actor=self.alex,
            title="Budget",
        )
        note = MeetingNote.objects.create(
            meeting_item=item, author=self.alex, content="Cut 10%.",
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

        self._terminate(recurrence)

        jan9.refresh_from_db()
        self.assertEqual(jan9.status, Meeting.Status.CANCELLED)
        section.refresh_from_db()
        self.assertEqual(section.meeting_id, jan9.pk)
        item.refresh_from_db()
        self.assertEqual(item.meeting_id, jan9.pk)
        note.refresh_from_db()
        self.assertEqual(note.content, "Cut 10%.")
        link = MeetingItemWorkItem.objects.get(
            meeting_item=item, work_item=work_item,
        )
        self.assertEqual(link.work_item_id, work_item.pk)
        self.assertEqual(
            MeetingParticipant.objects.filter(meeting=jan9).count(),
            1,  # the creator snapshot survives
        )

    def test_no_hard_delete_of_any_record(self):
        recurrence = self._create_recurrence()
        meetings = self._full_stack(recurrence)
        before = {
            "meetings": Meeting.objects.count(),
            "sections": MeetingSection.objects.count(),
            "items": MeetingItem.objects.count(),
            "participants": MeetingParticipant.objects.count(),
        }

        self._terminate(recurrence)

        after = {
            "meetings": Meeting.objects.count(),
            "sections": MeetingSection.objects.count(),
            "items": MeetingItem.objects.count(),
            "participants": MeetingParticipant.objects.count(),
        }
        self.assertEqual(before, after)

    # 9. Templates and unrelated recurrences remain unchanged.

    def test_template_and_unrelated_recurrence_unchanged(self):
        recurrence = self._create_recurrence()
        other = self._create_recurrence(
            title="Other Series",
            start_date=date(2026, 2, 2),
        )
        series = MeetingSeries.objects.get(pk=recurrence.series_id)
        other_before = [
            o.original_start for o in self._expand(
                other, _utc(2026, 2, 2), _utc(2026, 2, 5, 23, 59),
            )
        ]

        self._terminate(recurrence)

        other.refresh_from_db()
        self.assertIsNone(other.terminated_at)
        self.assertEqual(
            [
                o.original_start
                for o in self._expand(
                    other, _utc(2026, 2, 2), _utc(2026, 2, 5, 23, 59),
                )
            ],
            other_before,
        )
        series.refresh_from_db()
        self.assertFalse(series.is_archived)

    # 10. Repeated termination is idempotent.

    def test_repeated_termination_is_idempotent(self):
        recurrence = self._create_recurrence()
        meetings = self._full_stack(recurrence)

        self._terminate(recurrence)
        first = MeetingRecurrence.objects.get(pk=recurrence.pk)
        snapshot = {
            "terminated_at": first.terminated_at,
            "exclusions": MeetingRecurrenceExclusion.objects.count(),
            "events": self._cancelled_events().count(),
            "updated_at": first.updated_at,
            "meeting_states": {
                pk: (
                    Meeting.objects.get(pk=pk).status,
                    Meeting.objects.get(pk=pk).updated_at,
                )
                for pk in (
                    meetings["jan9"].pk,
                    meetings["jan10"].pk,
                )
            },
        }

        self._terminate(recurrence)

        second = MeetingRecurrence.objects.get(pk=recurrence.pk)
        self.assertEqual(second.terminated_at, snapshot["terminated_at"])
        self.assertEqual(
            MeetingRecurrenceExclusion.objects.count(),
            snapshot["exclusions"],
        )
        self.assertEqual(
            self._cancelled_events().count(), snapshot["events"],
        )
        self.assertEqual(second.updated_at, snapshot["updated_at"])
        for pk, (status_value, updated_at) in (
            snapshot["meeting_states"].items()
        ):
            meeting = Meeting.objects.get(pk=pk)
            self.assertEqual(meeting.status, status_value)
            self.assertEqual(meeting.updated_at, updated_at)

    # 11. A naturally ended recurrence can still be terminated; a
    #     naturally ended one that is NOT terminated keeps its
    #     overview behavior.

    def test_naturally_ended_recurrence_can_be_terminated(self):
        recurrence = self._create_recurrence(
            end_mode="end_date", end_date=date(2026, 1, 6),
        )
        # All occurrences (Jan 5, Jan 6) lie before the frozen
        # instant: termination cancels nothing but persists the
        # terminal state.
        self._materialize(
            recurrence, self._occurrence_on(recurrence, (2026, 1, 5)),
        )

        self._terminate(recurrence)

        recurrence.refresh_from_db()
        self.assertEqual(recurrence.terminated_at, TERMINATED_AT)
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 0)
        self.assertEqual(self._cancelled_events().count(), 0)

    def test_terminated_recurrence_absent_from_personal_overview(self):
        recurrence = self._create_recurrence()
        ended = self._create_recurrence(
            title="Naturally Ended",
            end_mode="end_date",
            end_date=date(2026, 1, 6),
        )

        self._terminate(recurrence)

        with mock.patch(
            "meetings.services._current_instant",
            return_value=_utc(2026, 1, 8, 6, 0),
        ):
            rows = list_personal_meeting_recurrence_overviews(
                user=self.alex,
            )
        row_ids = [row.recurrence.pk for row in rows]
        self.assertNotIn(recurrence.pk, row_ids)
        # The naturally ended (NOT terminated) recurrence keeps its
        # existing overview behavior: it appears, as ``ended``.
        ended_row = next(
            row for row in rows if row.recurrence.pk == ended.pk
        )
        self.assertEqual(ended_row.status, "ended")
        self.assertIsNone(ended_row.next_scheduled_at)


class MeetingRecurrenceTerminateAuthorizationTest(
    MeetingRecurrenceTerminateBase
):
    """The canonical scoped write rule is re-checked in the domain
    service: group member / Project owner+member (non-archived);
    viewer / archived / revoked / outsider denied."""

    def _terminated_at(self, recurrence):
        """The persisted termination instant of ``recurrence`` (a
        fresh read from the database)."""
        return MeetingRecurrence.objects.get(
            pk=recurrence.pk,
        ).terminated_at

    def test_group_member_can_terminate(self):
        recurrence = self._create_recurrence()

        self._terminate(recurrence, actor=self.chris)

        recurrence.refresh_from_db()
        self.assertEqual(recurrence.terminated_at, TERMINATED_AT)

    def test_project_owner_and_member_can_terminate(self):
        for actor in (self.alex, self.chris):
            recurrence = self._create_recurrence(
                scope="project", project=self.project,
            )
            self._terminate(recurrence, actor=actor)
            self.assertEqual(self._terminated_at(recurrence), TERMINATED_AT)

    def test_project_viewer_cannot_terminate(self):
        recurrence = self._create_recurrence(
            scope="project", project=self.project,
        )

        with self.assertRaises(MeetingDomainError):
            self._terminate(recurrence, actor=self.laura)

        self.assertIsNone(self._terminated_at(recurrence))

    def test_outsider_cannot_terminate(self):
        recurrence = self._create_recurrence()

        with self.assertRaises(MeetingDomainError):
            self._terminate(recurrence, actor=self.maria)

        self.assertIsNone(self._terminated_at(recurrence))

    def test_revoked_group_membership_cannot_terminate(self):
        recurrence = self._create_recurrence()
        # The canonical removal path: the Project membership first,
        # then the group membership (the composite FK makes the
        # reverse order impossible).
        remove_membership(
            membership=ProjectMembership.objects.get(
                project=self.project, user=self.chris,
            ),
            actor=self.alex,
        )
        remove_research_group_membership(
            membership=ResearchGroupMembership.objects.get(
                research_group=self.group, user=self.chris,
            ),
            actor=self.alex,
        )

        with self.assertRaises(MeetingDomainError):
            self._terminate(recurrence, actor=self.chris)

        self.assertIsNone(self._terminated_at(recurrence))

    def test_archived_project_cannot_be_terminated(self):
        recurrence = self._create_recurrence(
            scope="project", project=self.project,
        )
        archive_project(project=self.project, actor=self.alex)
        # Fresh instance: the pre-archive object caches its Project
        # relation; a real request always resolves the Recurrence (
        # and its current Project state) from the database.
        recurrence = MeetingRecurrence.objects.get(pk=recurrence.pk)

        with self.assertRaises(MeetingDomainError):
            self._terminate(recurrence, actor=self.alex)

        self.assertIsNone(self._terminated_at(recurrence))

    def test_denied_termination_changes_nothing(self):
        recurrence = self._create_recurrence(
            scope="project", project=self.project,
        )
        meeting = self._materialize(
            recurrence, self._occurrence_on(recurrence, (2026, 1, 9)),
        )

        with self.assertRaises(MeetingDomainError):
            self._terminate(recurrence, actor=self.laura)

        self.assertIsNone(self._terminated_at(recurrence))
        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.UPCOMING)
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 0)
        self.assertEqual(self._cancelled_events().count(), 0)


class MeetingRecurrenceTerminateReadApiTest(MeetingRecurrenceTerminateBase):
    """Read paths respect the terminal state: the bounded per-
    recurrence occurrence read, the personal occurrence feed, the
    personal Series overview, and the historical concrete Meeting read
    APIs."""

    PATH_FEED = "/api/meeting-recurrences/occurrences/"
    PATH_OVERVIEW = "/api/meeting-recurrences/"

    def setUp(self):
        super().setUp()
        self.client = APIClient()
        self.client.force_login(self.alex)

    def _fixture(self):
        """One recurrence with a past materialized upcoming Meeting,
        a future materialized upcoming Meeting, and one more future
        upcoming Meeting."""
        recurrence = self._create_recurrence()
        past = self._materialize(
            recurrence, self._occurrence_on(recurrence, (2026, 1, 7)),
        )
        future1 = self._materialize(
            recurrence, self._occurrence_on(recurrence, (2026, 1, 9)),
        )
        future2 = self._materialize(
            recurrence, self._occurrence_on(recurrence, (2026, 1, 10)),
        )
        return recurrence, past, future1, future2

    def _window(self):
        return {
            "from": _utc(2026, 1, 7, 0, 0).isoformat(),
            "to": _utc(2026, 1, 11, 0, 0).isoformat(),
        }

    def _occurrence_ids(self, items):
        return sorted(item["occurrenceId"] for item in items)

    def test_per_recurrence_occurrence_read_shows_no_future(self):
        recurrence, past, future1, future2 = self._fixture()
        before = self.client.get(
            f"/api/meeting-recurrences/{recurrence.pk}/occurrences/",
            self._window(),
        )
        self.assertEqual(before.status_code, status.HTTP_200_OK)
        before_ids = self._occurrence_ids(before.json())
        self.assertEqual(len(before_ids), 4)  # Jan 7, 8, 9, 10

        self._terminate(recurrence)

        after = self.client.get(
            f"/api/meeting-recurrences/{recurrence.pk}/occurrences/",
            self._window(),
        )
        self.assertEqual(after.status_code, status.HTTP_200_OK)
        (jan7,) = [
            item for item in before.json()
            if item["meetingId"] == past.pk
        ]
        (jan8,) = [
            item for item in before.json()
            if item["meetingId"] is None
        ]
        # The Jan 7 (materialized, before the instant) and the Jan 8
        # virtual occurrence (08:30 UTC < the 12:00 UTC instant)
        # remain; the Jan 9 / Jan 10 materialized future ones are
        # suppressed.
        after_ids = self._occurrence_ids(after.json())
        self.assertEqual(after_ids, sorted([
            jan7["occurrenceId"], jan8["occurrenceId"],
        ]))

    def test_personal_feed_shows_no_future_occurrences(self):
        recurrence, past, future1, future2 = self._fixture()
        before = self.client.get(self.PATH_FEED, self._window())
        self.assertEqual(before.status_code, status.HTTP_200_OK)
        before_ids = self._occurrence_ids(before.json())
        self.assertEqual(len(before_ids), 4)

        self._terminate(recurrence)

        after = self.client.get(self.PATH_FEED, self._window())
        self.assertEqual(after.status_code, status.HTTP_200_OK)
        (jan7,) = [
            item for item in before.json()
            if item["meetingId"] == past.pk
        ]
        (jan8,) = [
            item for item in before.json()
            if item["meetingId"] is None
        ]
        # Jan 7 (materialized, before the instant) and the Jan 8
        # virtual occurrence (before the instant) remain; the future
        # materialized ones are suppressed.
        after_ids = self._occurrence_ids(after.json())
        self.assertEqual(after_ids, sorted([
            jan7["occurrenceId"], jan8["occurrenceId"],
        ]))
        # The cancelled Meetings are absent exactly like any cancelled
        # occurrence (no resurrection, no replacement).
        self.assertNotIn(future1.pk, [
            item["meetingId"] for item in after.json()
        ])
        self.assertNotIn(future2.pk, [
            item["meetingId"] for item in after.json()
        ])

    def test_terminated_recurrence_absent_from_series_overview(self):
        recurrence, past, future1, future2 = self._fixture()
        ended = self._create_recurrence(
            title="Naturally Ended",
            end_mode="end_date",
            end_date=date(2026, 1, 6),
        )

        self._terminate(recurrence)

        with mock.patch(
            "meetings.services._current_instant",
            return_value=_utc(2026, 1, 8, 6, 0),
        ):
            response = self.client.get(self.PATH_OVERVIEW)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        rows = {row["id"]: row for row in response.json()}
        self.assertNotIn(recurrence.pk, rows)
        self.assertIn(ended.pk, rows)
        self.assertEqual(rows[ended.pk]["status"], "ended")

    def test_concrete_meeting_read_still_works_after_termination(self):
        recurrence, past, future1, future2 = self._fixture()

        self._terminate(recurrence)

        for meeting in (past, future1, future2):
            response = self.client.get(f"/api/meetings/{meeting.pk}/")
            self.assertEqual(response.status_code, status.HTTP_200_OK)
            self.assertEqual(response.json()["id"], meeting.pk)
        # The cancelled future Meetings report their terminal status;
        # the preserved past one its unchanged state.
        self.assertEqual(
            self.client.get(f"/api/meetings/{future1.pk}/").json()[
                "status"
            ],
            "cancelled",
        )
        self.assertEqual(
            self.client.get(f"/api/meetings/{past.pk}/").json()["status"],
            "upcoming",
        )


class MeetingRecurrenceTerminateConcurrencyTest(TransactionTestCase):
    """Concurrent termination (real PostgreSQL): no duplicate
    creation, no partial termination, no unsafe lock-order behavior.

    Same repository concurrency harness as the exclusion /
    materialization races: threaded service calls, a barrier to align
    the racers, and — for the deterministic cross-service races — a
    raw transaction that holds the relevant row lock behind
    threading events.
    """

    def setUp(self):
        self.alex = User.objects.create_user(
            username="termrace-alex", password="Pass1!",
        )
        self.group = ResearchGroup.objects.create(
            name="Termination Race Group", created_by=self.alex,
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
        self._clock_patch = mock.patch(
            "meetings.services._termination_instant",
            return_value=TERMINATED_AT,
        )
        self._clock_patch.start()
        self.addCleanup(self._clock_patch.stop)

    def _occurrence_on(self, day):
        (occurrence,) = expand_meeting_recurrence_occurrences(
            meeting_recurrence=self.recurrence,
            range_start=_utc(*day),
            range_end=_utc(day[0], day[1], day[2], 23, 59),
        )
        return occurrence

    def _materialize(self, occurrence, title="Mat"):
        return materialize_meeting_recurrence_occurrence(
            recurrence=self.recurrence,
            occurrence=occurrence,
            actor=self.alex,
            title=title,
        )

    def _terminate_in_thread(self, name, results, errors, barrier):
        def worker():
            barrier.wait()
            try:
                results[name] = terminate_meeting_recurrence(
                    recurrence=self.recurrence,
                    actor=self.alex,
                )
            except Exception as exc:
                errors[name] = exc
            finally:
                db_connection.close()

        return worker

    def test_concurrent_termination_is_idempotent(self):
        """Two racing terminations: one performs it, the other
        observes the committed terminal state under the lock — no
        duplicate exclusions, no duplicate events, one timestamp."""
        meetings = {
            day: self._materialize(self._occurrence_on(day))
            for day in ((2026, 1, 9), (2026, 1, 10))
        }

        results, errors = {}, {}
        barrier = threading.Barrier(2)
        threads = [
            threading.Thread(
                target=self._terminate_in_thread(name, results, errors, barrier),
            )
            for name in ("a", "b")
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=60)
        self.assertFalse(any(thread.is_alive() for thread in threads))
        db_connection.close()

        self.assertEqual(errors, {})
        self.assertEqual(
            results["a"].terminated_at, TERMINATED_AT,
        )
        self.assertEqual(
            results["b"].terminated_at, TERMINATED_AT,
        )
        recurrence = MeetingRecurrence.objects.get(pk=self.recurrence.pk)
        self.assertEqual(recurrence.terminated_at, TERMINATED_AT)
        for meeting in meetings.values():
            meeting.refresh_from_db()
        self.assertEqual(
            [m.status for m in meetings.values()],
            [Meeting.Status.CANCELLED, Meeting.Status.CANCELLED],
        )
        self.assertEqual(
            MeetingRecurrenceExclusion.objects.filter(
                recurrence=self.recurrence,
            ).count(),
            2,
        )
        self.assertEqual(
            AuditEvent.objects.filter(
                event_type=MeetingAuditEventType.CANCELLED,
            ).count(),
            2,
        )

    def test_termination_catches_concurrently_materialized_meeting(self):
        """Deterministic race: a concurrent materialization holds the
        recurrence row lock and commits a NEW future Meeting after the
        termination's first candidate lock but before it can take the
        recurrence lock. The termination must converge on the NEW row
        too — no partial termination, no duplicate creation."""
        jan9 = self._materialize(self._occurrence_on((2026, 1, 9)))
        jan10_occurrence = self._occurrence_on((2026, 1, 10))
        self.assertIsNone(
            Meeting.objects.filter(
                recurrence=self.recurrence,
                original_scheduled_at=jan10_occurrence.original_start,
            ).first()
        )

        winner_locked = threading.Event()
        release_winner = threading.Event()

        def winner():
            # A concurrent materialization that bypasses the service
            # (the other racer's in-flight transaction), serialized on
            # the same recurrence row lock.
            with transaction.atomic():
                MeetingRecurrence.objects.select_for_update().get(
                    pk=self.recurrence.pk,
                )
                winner_locked.set()
                Meeting.objects.create(
                    research_group=self.group,
                    scope=Meeting.Scope.GROUP,
                    title="Concurrent",
                    scheduled_at=jan10_occurrence.original_start,
                    recurrence=self.recurrence,
                    original_scheduled_at=(
                        jan10_occurrence.original_start
                    ),
                    status=Meeting.Status.UPCOMING,
                    created_by=self.alex,
                )
                release_winner.wait(timeout=30)
            db_connection.close()

        loser_result = {}
        loser_errors = {}

        def loser():
            try:
                loser_result["recurrence"] = terminate_meeting_recurrence(
                    recurrence=self.recurrence,
                    actor=self.alex,
                )
            except Exception as exc:
                loser_errors["error"] = exc
            finally:
                db_connection.close()

        winner_thread = threading.Thread(target=winner)
        winner_thread.start()
        self.assertTrue(winner_locked.wait(timeout=30))

        loser_thread = threading.Thread(target=loser)
        loser_thread.start()
        # Give the loser time to reach the recurrence lock while the
        # winner's transaction is still open.
        time_module.sleep(0.25)
        release_winner.set()
        loser_thread.join(timeout=60)
        winner_thread.join(timeout=60)
        db_connection.close()

        self.assertFalse(loser_thread.is_alive())
        self.assertEqual(loser_errors, {})
        self.assertEqual(
            loser_result["recurrence"].terminated_at, TERMINATED_AT,
        )
        # NO partial termination: both Meetings (the pre-existing one
        # AND the concurrently materialized one) are cancelled, each
        # with exactly one exclusion and one event.
        jan10 = Meeting.objects.get(
            recurrence=self.recurrence,
            original_scheduled_at=jan10_occurrence.original_start,
        )
        self.assertEqual(jan10.status, Meeting.Status.CANCELLED)
        jan9.refresh_from_db()
        self.assertEqual(jan9.status, Meeting.Status.CANCELLED)
        self.assertEqual(Meeting.objects.count(), 2)
        self.assertEqual(
            MeetingRecurrenceExclusion.objects.filter(
                recurrence=self.recurrence,
            ).count(),
            2,
        )
        self.assertEqual(
            AuditEvent.objects.filter(
                event_type=MeetingAuditEventType.CANCELLED,
            ).count(),
            2,
        )

    def test_termination_and_single_occurrence_cancellation_race(self):
        """Deterministic race: a concurrent single-occurrence
        cancellation holds its Meeting lock and the recurrence lock
        (the same Meeting → recurrence order termination uses). No
        deadlock, no duplicate exclusion, no duplicate event, and the
        already-cancelled Meeting is not cancelled twice."""
        jan9 = self._materialize(self._occurrence_on((2026, 1, 9)))
        jan10 = self._materialize(self._occurrence_on((2026, 1, 10)))

        winner_locked = threading.Event()
        release_winner = threading.Event()

        def winner():
            # The raw internals of
            # cancel_meeting_recurrence_occurrence: Meeting lock
            # FIRST, then the recurrence lock, then the exclusion and
            # the terminal status.
            with transaction.atomic():
                locked_meeting = Meeting.objects.select_for_update().get(
                    pk=jan9.pk,
                )
                winner_locked.set()
                MeetingRecurrence.objects.select_for_update(
                    no_key=True,
                ).get(pk=self.recurrence.pk)
                MeetingRecurrenceExclusion.objects.create(
                    recurrence=self.recurrence,
                    original_scheduled_at=jan9.original_scheduled_at,
                    created_by=self.alex,
                )
                locked_meeting.status = Meeting.Status.CANCELLED
                locked_meeting.save(
                    update_fields=["status", "updated_at"],
                )
                record_audit_event(
                    research_group=self.group,
                    actor=self.alex,
                    event_type=MeetingAuditEventType.CANCELLED,
                    project=None,
                    meeting=locked_meeting,
                    data={},
                )
                release_winner.wait(timeout=30)
            db_connection.close()

        loser_result = {}
        loser_errors = {}

        def loser():
            try:
                loser_result["recurrence"] = terminate_meeting_recurrence(
                    recurrence=self.recurrence,
                    actor=self.alex,
                )
            except Exception as exc:
                loser_errors["error"] = exc
            finally:
                db_connection.close()

        winner_thread = threading.Thread(target=winner)
        winner_thread.start()
        self.assertTrue(winner_locked.wait(timeout=30))

        loser_thread = threading.Thread(target=loser)
        loser_thread.start()
        # The loser blocks on jan9's Meeting lock (winner holds it)
        # WITHOUT holding the recurrence lock — the winner therefore
        # gets the free recurrence lock and commits.
        time_module.sleep(0.25)
        release_winner.set()
        loser_thread.join(timeout=60)
        winner_thread.join(timeout=60)
        db_connection.close()

        self.assertFalse(
            any(
                thread.is_alive()
                for thread in (loser_thread, winner_thread)
            ),
            "deadlock: a racer is still waiting on a row lock",
        )
        self.assertEqual(loser_errors, {})
        self.assertEqual(
            loser_result["recurrence"].terminated_at, TERMINATED_AT,
        )
        jan9.refresh_from_db()
        jan10.refresh_from_db()
        self.assertEqual(jan9.status, Meeting.Status.CANCELLED)
        self.assertEqual(jan10.status, Meeting.Status.CANCELLED)
        # Exactly ONE exclusion per occurrence (no duplicate from the
        # racing cancellation) and exactly ONE event each.
        self.assertEqual(
            MeetingRecurrenceExclusion.objects.filter(
                recurrence=self.recurrence,
            ).count(),
            2,
        )
        self.assertEqual(
            AuditEvent.objects.filter(
                event_type=MeetingAuditEventType.CANCELLED,
            ).count(),
            2,
        )
        self.assertEqual(
            AuditEvent.objects.filter(
                event_type=MeetingAuditEventType.CANCELLED,
                meeting=jan9,
            ).count(),
            1,
        )

    def test_termination_preserves_meeting_started_concurrently(self):
        """Deterministic race: a concurrent lifecycle start holds the
        Meeting lock and flips it to live. Termination must wait, then
        PRESERVE the live Meeting (no exclusion, no cancellation
        event) while cancelling the rest — and neither direction
        deadlocks."""
        jan9 = self._materialize(self._occurrence_on((2026, 1, 9)))
        jan10 = self._materialize(self._occurrence_on((2026, 1, 10)))

        winner_locked = threading.Event()
        release_winner = threading.Event()

        def winner():
            # The raw internals of start_meeting: Meeting lock first,
            # then the upcoming → live transition.
            with transaction.atomic():
                locked_meeting = Meeting.objects.select_for_update().get(
                    pk=jan9.pk,
                )
                winner_locked.set()
                locked_meeting.status = Meeting.Status.LIVE
                locked_meeting.started_at = TERMINATED_AT
                locked_meeting.save(
                    update_fields=[
                        "status", "started_at", "updated_at",
                    ],
                )
                release_winner.wait(timeout=30)
            db_connection.close()

        loser_result = {}
        loser_errors = {}

        def loser():
            try:
                loser_result["recurrence"] = terminate_meeting_recurrence(
                    recurrence=self.recurrence,
                    actor=self.alex,
                )
            except Exception as exc:
                loser_errors["error"] = exc
            finally:
                db_connection.close()

        winner_thread = threading.Thread(target=winner)
        winner_thread.start()
        self.assertTrue(winner_locked.wait(timeout=30))

        loser_thread = threading.Thread(target=loser)
        loser_thread.start()
        time_module.sleep(0.25)
        release_winner.set()
        loser_thread.join(timeout=60)
        winner_thread.join(timeout=60)
        db_connection.close()

        self.assertFalse(
            any(
                thread.is_alive()
                for thread in (loser_thread, winner_thread)
            ),
            "deadlock: a racer is still waiting on a row lock",
        )
        self.assertEqual(loser_errors, {})
        self.assertEqual(
            loser_result["recurrence"].terminated_at, TERMINATED_AT,
        )
        # The live Meeting is preserved, exactly like any live Meeting.
        jan9.refresh_from_db()
        self.assertEqual(jan9.status, Meeting.Status.LIVE)
        jan10.refresh_from_db()
        self.assertEqual(jan10.status, Meeting.Status.CANCELLED)
        self.assertFalse(
            MeetingRecurrenceExclusion.objects.filter(
                recurrence=self.recurrence,
                original_scheduled_at=jan9.original_scheduled_at,
            ).exists()
        )
        self.assertEqual(
            MeetingRecurrenceExclusion.objects.filter(
                recurrence=self.recurrence,
            ).count(),
            1,
        )
        self.assertEqual(
            AuditEvent.objects.filter(
                event_type=MeetingAuditEventType.CANCELLED,
            ).count(),
            1,
        )

    def test_virtual_exclusion_rejected_when_termination_wins(self):
        """Deterministic race: a whole-series termination commits
        while a single-occurrence virtual exclusion is in flight and
        waiting on the recurrence lock. The exclusion must then be
        rejected under the lock — the final state never carries an
        exclusion for a terminated future occurrence."""
        jan11 = self._occurrence_on((2026, 1, 11))

        winner_locked = threading.Event()
        release_winner = threading.Event()

        def winner():
            # A whole-series termination that bypasses the service
            # (the other racer's in-flight transaction), serialized on
            # the same recurrence row lock.
            with transaction.atomic():
                locked_recurrence = (
                    MeetingRecurrence.objects
                    .select_for_update()
                    .get(pk=self.recurrence.pk)
                )
                winner_locked.set()
                locked_recurrence.terminated_at = TERMINATED_AT
                locked_recurrence.save(
                    update_fields=["terminated_at", "updated_at"],
                )
                release_winner.wait(timeout=30)
            db_connection.close()

        loser_result = {}
        loser_errors = {}

        def loser():
            try:
                loser_result["exclusion"] = (
                    exclude_meeting_recurrence_occurrence(
                        recurrence=self.recurrence,
                        occurrence=jan11,
                        actor=self.alex,
                    )
                )
            except Exception as exc:
                loser_errors["error"] = exc
            finally:
                db_connection.close()

        winner_thread = threading.Thread(target=winner)
        winner_thread.start()
        self.assertTrue(winner_locked.wait(timeout=30))

        loser_thread = threading.Thread(target=loser)
        loser_thread.start()
        # Give the loser time to reach the recurrence lock while the
        # winner's transaction is still open.
        time_module.sleep(0.25)
        release_winner.set()
        loser_thread.join(timeout=60)
        winner_thread.join(timeout=60)
        db_connection.close()

        self.assertIn("error", loser_errors)
        self.assertIsInstance(
            loser_errors["error"], MeetingDomainError,
        )
        self.assertNotIn("exclusion", loser_result)
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 0)
        self.assertEqual(Meeting.objects.count(), 0)
        self.assertEqual(
            MeetingRecurrence.objects.get(
                pk=self.recurrence.pk,
            ).terminated_at,
            TERMINATED_AT,
        )
