"""Tests for the coordination of Meeting time moves with whole-series
termination.

A time move of a Meeting that belongs to a Recurrence (the canonical
single-occurrence reschedule of an already-materialized occurrence,
the materialize-then-move reschedule of a still-virtual occurrence,
and the ordinary Meeting edit of a recurring Meeting) must not be able
to place — or leave — a Meeting at or after the immutable termination
instant of an already-terminated Recurrence:

- an ACTIVE Recurrence's upcoming Meetings reschedule exactly as
  before (unchanged behavior);
- after termination, a move to the termination instant or later is
  REJECTED under the canonical Meeting → Recurrence row locks,
  leaving the Meeting and its audit history completely unchanged
  (no partial change, no event);
- a move that commits FIRST (racing termination) is still caught:
  termination's under-lock re-query sees the moved Meeting and
  cancels it (bounded retry with the same observed instant);
- the terminal state committed FIRST is visible under the recurrence
  row lock, so the racing move is rejected — a terminated series
  never regains a future upcoming Meeting;
- the virtual-occurrence reschedule stays all-or-nothing: a rejected
  move rolls the first-time materialization back (no orphaned
  Meeting, no ``meeting.created`` event);
- standalone Meetings (no recurrence) and title-only edits keep the
  existing behavior exactly.

The deterministic races use the repository's established harness:
threaded service calls, a barrier / lock-holding winner behind
threading events, ``db_connection.close()`` in every worker, and
``join(timeout=60)`` + ``is_alive`` deadlock asserts on real
PostgreSQL (``TransactionTestCase``).
"""

import threading
import time as time_module
from datetime import date, time
from unittest import mock

from audit_history.models import AuditEvent
from django.contrib.auth import get_user_model
from django.db import connection as db_connection, transaction
from django.test import TransactionTestCase

from research_groups.models import ResearchGroup, ResearchGroupMembership

from .models import (
    Meeting,
    MeetingRecurrence,
    MeetingRecurrenceExclusion,
)
from .services import (
    MeetingAuditEventType,
    MeetingDomainError,
    create_meeting,
    create_meeting_recurrence,
    create_meeting_series,
    create_series_section,
    end_meeting,
    expand_meeting_recurrence_occurrences,
    materialize_meeting_recurrence_occurrence,
    reschedule_meeting_recurrence_occurrence,
    start_meeting,
    terminate_meeting_recurrence,
    update_meeting,
)
from .tests_recurrence import MeetingRecurrenceBase, _utc
from .tests_recurrence_terminate import (
    MeetingRecurrenceTerminateBase,
    TERMINATED_AT,
)

User = get_user_model()

# A concrete future slot strictly AFTER the frozen termination
# instant (TERMINATED_AT = 2026-01-08 12:00 UTC): moving a Meeting
# here is "into the terminated future".
MOVED_TO = _utc(2026, 1, 20, 8, 30)


class MeetingRecurrenceRescheduleTerminationTest(
    MeetingRecurrenceTerminateBase,
):
    """Behavioral contract: reschedule vs. terminal recurrence state."""

    # 1. Active recurrences reschedule exactly as before.

    def test_active_recurrence_reschedule_still_works(self):
        recurrence = self._create_recurrence()
        jan9 = self._materialize(
            recurrence, self._occurrence_on(recurrence, (2026, 1, 9)),
        )

        result = reschedule_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=self._occurrence_on(recurrence, (2026, 1, 9)),
            scheduled_at=MOVED_TO,
            actor=self.alex,
            title="Moved",
        )

        self.assertEqual(result.pk, jan9.pk)
        jan9.refresh_from_db()
        self.assertEqual(jan9.scheduled_at, MOVED_TO)
        # A reschedule never renames an already-materialized Meeting.
        self.assertEqual(jan9.title, "Mat")
        self.assertEqual(
            AuditEvent.objects.filter(
                event_type=MeetingAuditEventType.RESCHEDULED,
                meeting=jan9,
            ).count(),
            1,
        )
        recurrence.refresh_from_db()
        self.assertIsNone(recurrence.terminated_at)

    # 2. After termination: a move into the terminated future is
    #    rejected, and the Meeting stays completely unchanged.

    def test_reschedule_into_terminated_future_rejected(self):
        recurrence = self._create_recurrence()
        jan8 = self._materialize(
            recurrence, self._occurrence_on(recurrence, (2026, 1, 8)),
        )
        self._materialize(
            recurrence, self._occurrence_on(recurrence, (2026, 1, 9)),
        )
        self._terminate(recurrence)

        with self.assertRaises(MeetingDomainError):
            reschedule_meeting_recurrence_occurrence(
                recurrence=recurrence,
                occurrence=self._occurrence_on(recurrence, (2026, 1, 8)),
                scheduled_at=MOVED_TO,
                actor=self.alex,
                title="Moved",
            )

        jan8.refresh_from_db()
        self.assertEqual(jan8.scheduled_at, _utc(2026, 1, 8, 8, 30))
        self.assertEqual(jan8.status, Meeting.Status.UPCOMING)
        self.assertEqual(jan8.title, "Mat")
        self.assertEqual(
            AuditEvent.objects.filter(
                event_type=MeetingAuditEventType.RESCHEDULED,
            ).count(),
            0,
        )

    # 3. A rejected ordinary Meeting edit (title + time together)
    #    leaves NEITHER field changed and records no event.

    def test_rejected_direct_update_leaves_no_partial_change(self):
        recurrence = self._create_recurrence()
        jan8 = self._materialize(
            recurrence, self._occurrence_on(recurrence, (2026, 1, 8)),
        )
        self._terminate(recurrence)

        baseline_events = AuditEvent.objects.count()
        with self.assertRaises(MeetingDomainError):
            update_meeting(
                meeting=jan8,
                actor=self.alex,
                title="Renamed",
                scheduled_at=MOVED_TO,
            )

        jan8.refresh_from_db()
        self.assertEqual(jan8.title, "Mat")
        self.assertEqual(jan8.scheduled_at, _utc(2026, 1, 8, 8, 30))
        # Rejected with no side effect: no NEW event of any kind
        # (the fixture's materialization events are the baseline).
        self.assertEqual(
            AuditEvent.objects.count(),
            baseline_events,
        )

    # 4. The boundary is EXACTLY the termination instant: a move that
    #    stays before the instant is still allowed after termination.

    def test_reschedule_before_termination_instant_still_allowed(self):
        recurrence = self._create_recurrence()
        jan8 = self._materialize(
            recurrence, self._occurrence_on(recurrence, (2026, 1, 8)),
        )
        self._terminate(recurrence)

        earlier = _utc(2026, 1, 8, 11, 0)  # still < TERMINATED_AT
        reschedule_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=self._occurrence_on(recurrence, (2026, 1, 8)),
            scheduled_at=earlier,
            actor=self.alex,
            title="Tweaked",
        )

        jan8.refresh_from_db()
        self.assertEqual(jan8.scheduled_at, earlier)
        self.assertEqual(
            AuditEvent.objects.filter(
                event_type=MeetingAuditEventType.RESCHEDULED,
                meeting=jan8,
            ).count(),
            1,
        )
        recurrence.refresh_from_db()
        self.assertEqual(recurrence.terminated_at, TERMINATED_AT)

    # 5. Virtual-occurrence reschedule stays all-or-nothing: the
    #    first-time materialization (original start BEFORE the
    #    instant, so the materialization gate passes) is rolled back
    #    when the move into the terminated future is rejected — no
    #    orphaned Meeting, no meeting.created event.

    def test_virtual_reschedule_into_terminated_future_creates_no_orphan(
        self,
    ):
        recurrence = self._create_recurrence()
        self._materialize(
            recurrence, self._occurrence_on(recurrence, (2026, 1, 9)),
        )
        self._terminate(recurrence)

        baseline_created = AuditEvent.objects.filter(
            event_type=MeetingAuditEventType.CREATED,
        ).count()
        with self.assertRaises(MeetingDomainError):
            reschedule_meeting_recurrence_occurrence(
                recurrence=recurrence,
                occurrence=self._occurrence_on(recurrence, (2026, 1, 7)),
                scheduled_at=MOVED_TO,
                actor=self.alex,
                title="Orphan?",
            )

        jan7 = Meeting.objects.filter(
            recurrence=recurrence,
            original_scheduled_at=self._occurrence_on(
                recurrence, (2026, 1, 7),
            ).original_start,
        ).first()
        self.assertIsNone(jan7)
        # The first-time materialization rolled back: no NEW created
        # event (the fixture's Jan 9 materialization is the baseline).
        self.assertEqual(
            AuditEvent.objects.filter(
                event_type=MeetingAuditEventType.CREATED,
            ).count(),
            baseline_created,
        )
        self.assertEqual(
            AuditEvent.objects.filter(
                event_type=MeetingAuditEventType.RESCHEDULED,
            ).count(),
            0,
        )

    # 6. A still-virtual occurrence AT or AFTER the instant is
    #    rejected by the canonical materialization gate (the reschedule
    #    would first materialize it).

    def test_virtual_reschedule_at_or_after_instant_rejected(
        self,
    ):
        recurrence = self._create_recurrence()
        self._materialize(
            recurrence, self._occurrence_on(recurrence, (2026, 1, 8)),
        )
        self._terminate(recurrence)

        with self.assertRaises(MeetingDomainError):
            reschedule_meeting_recurrence_occurrence(
                recurrence=recurrence,
                occurrence=self._occurrence_on(recurrence, (2026, 1, 9)),
                scheduled_at=_utc(2026, 1, 25, 8, 30),
                actor=self.alex,
                title="Late",
            )

        jan9 = Meeting.objects.filter(
            recurrence=recurrence,
            original_scheduled_at=self._occurrence_on(
                recurrence, (2026, 1, 9),
            ).original_start,
        ).first()
        self.assertIsNone(jan9)

    # 7. Standalone Meeting time edits are untouched by the guard.

    def test_standalone_meeting_time_edit_unchanged(self):
        standalone = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="One-off",
            scheduled_at=_utc(2026, 1, 9, 8, 30),
        )

        update_meeting(
            meeting=standalone,
            actor=self.alex,
            scheduled_at=MOVED_TO,
        )

        standalone.refresh_from_db()
        self.assertEqual(standalone.scheduled_at, MOVED_TO)
        self.assertEqual(
            AuditEvent.objects.filter(
                event_type=MeetingAuditEventType.RESCHEDULED,
                meeting=standalone,
            ).count(),
            1,
        )

    # 8. Termination after a reschedule: the moved Meeting is
    #    cancelled by its EFFECTIVE time, excluded by its ORIGINAL
    #    identity.

    def test_termination_cancels_earlier_rescheduled_meeting(self):
        recurrence = self._create_recurrence()
        jan8 = self._materialize(
            recurrence, self._occurrence_on(recurrence, (2026, 1, 8)),
        )
        # Active recurrence: the move into the future is fine.
        reschedule_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=self._occurrence_on(recurrence, (2026, 1, 8)),
            scheduled_at=MOVED_TO,
            actor=self.alex,
            title="Moved early",
        )
        jan8.refresh_from_db()
        self.assertEqual(jan8.scheduled_at, MOVED_TO)

        self._terminate(recurrence)

        jan8.refresh_from_db()
        self.assertEqual(jan8.status, Meeting.Status.CANCELLED)
        self.assertEqual(jan8.scheduled_at, MOVED_TO)
        (exclusion,) = MeetingRecurrenceExclusion.objects.filter(
            recurrence=recurrence,
        )
        self.assertEqual(
            exclusion.original_scheduled_at,
            _utc(2026, 1, 8, 8, 30),
        )
        self.assertEqual(
            AuditEvent.objects.filter(
                event_type=MeetingAuditEventType.RESCHEDULED,
                meeting=jan8,
            ).count(),
            1,
        )
        self.assertEqual(
            AuditEvent.objects.filter(
                event_type=MeetingAuditEventType.CANCELLED,
                meeting=jan8,
            ).count(),
            1,
        )


class MeetingRecurrenceRescheduleTerminationConcurrencyTest(
    TransactionTestCase,
):
    """Real-PostgreSQL races: reschedule vs. termination.

    Same repository concurrency harness as the termination /
    exclusion / materialization races: threaded service calls, a
    lock-holding winner behind threading events, and deadlock asserts
    (``join(timeout=60)`` + ``is_alive``).
    """

    def setUp(self):
        self.alex = User.objects.create_user(
            username="reschedrace-alex", password="Pass1!",
        )
        self.group = ResearchGroup.objects.create(
            name="Reschedule Race Group", created_by=self.alex,
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

    def test_reschedule_wins_race_termination_cancels_moved_meeting(
        self,
    ):
        """Deterministic race: the (post-fix) reschedule of the
        BEFORE-instant Meeting holds the canonical Meeting → Recurrence
        locks and commits its move into the future while the
        termination waits for the recurrence lock. The termination's
        under-lock re-query must see the committed move (candidate
        set GROW) and converge: the moved Meeting is cancelled too —
        no orphaned future upcoming Meeting, no deadlock."""
        jan8 = self._materialize(self._occurrence_on((2026, 1, 8)))
        self._materialize(self._occurrence_on((2026, 1, 9)))
        self._materialize(self._occurrence_on((2026, 1, 10)))

        winner_locked = threading.Event()
        release_winner = threading.Event()

        def winner():
            # The post-fix reschedule internals: Meeting lock FIRST,
            # then the Slice-6 recurrence row lock, then the guarded
            # move (terminated_at is still NULL under the lock).
            with transaction.atomic():
                locked_meeting = Meeting.objects.select_for_update().get(
                    pk=jan8.pk,
                )
                MeetingRecurrence.objects.select_for_update(
                    no_key=True,
                ).get(pk=self.recurrence.pk)
                winner_locked.set()
                locked_meeting.scheduled_at = MOVED_TO
                locked_meeting.save(
                    update_fields=["scheduled_at", "updated_at"],
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
        # Give the loser time to reach the recurrence-lock wait while
        # the winner's transaction is still open.
        time_module.sleep(0.25)
        release_winner.set()
        loser_thread.join(timeout=60)
        winner_thread.join(timeout=60)
        db_connection.close()

        self.assertFalse(winner_thread.is_alive())
        self.assertFalse(loser_thread.is_alive())
        self.assertEqual(loser_errors, {})
        self.assertEqual(
            loser_result["recurrence"].terminated_at, TERMINATED_AT,
        )

        # All three Meetings cancelled — including the one moved into
        # the terminated future by the winning reschedule. Its moved
        # time is preserved on the row; only the status changed.
        jan8.refresh_from_db()
        self.assertEqual(jan8.status, Meeting.Status.CANCELLED)
        self.assertEqual(jan8.scheduled_at, MOVED_TO)
        for day in ((2026, 1, 9), (2026, 1, 10)):
            meeting = Meeting.objects.get(
                recurrence=self.recurrence,
                original_scheduled_at=self._occurrence_on(day).original_start,
            )
            self.assertEqual(meeting.status, Meeting.Status.CANCELLED)
        # No upcoming Meeting at or after the instant survives.
        self.assertFalse(
            Meeting.objects.filter(
                recurrence=self.recurrence,
                status=Meeting.Status.UPCOMING,
                scheduled_at__gte=TERMINATED_AT,
            ).exists(),
        )
        # One exclusion per cancelled Meeting, keyed by the ORIGINAL
        # occurrence identity (the moved one by its Jan 8 slot).
        exclusions = set(
            MeetingRecurrenceExclusion.objects.filter(
                recurrence=self.recurrence,
            ).values_list("original_scheduled_at", flat=True)
        )
        self.assertEqual(
            exclusions,
            {
                _utc(2026, 1, 8, 8, 30),
                _utc(2026, 1, 9, 8, 30),
                _utc(2026, 1, 10, 8, 30),
            },
        )
        self.assertEqual(
            AuditEvent.objects.filter(
                event_type=MeetingAuditEventType.CANCELLED,
            ).count(),
            3,
        )

    def test_termination_wins_race_reschedule_rejected(self):
        """Deterministic race: the terminal state commits first (the
        winner holds the recurrence row lock and persists
        ``terminated_at``). The racing reschedule — which takes the
        Meeting lock and then WAITS on the recurrence lock — must see
        the committed terminal state under the lock and be REJECTED:
        the Meeting stays unchanged, no event is recorded, and the
        rejection is a domain error (never a deadlock)."""
        jan8 = self._materialize(self._occurrence_on((2026, 1, 8)))

        winner_locked = threading.Event()
        release_winner = threading.Event()

        def winner():
            # The minimal terminal-state writer: the Slice-6
            # recurrence row lock, then the persisted instant.
            # (Isolates the reschedule-side guarantee: the terminal
            # state is visible under the recurrence lock.)
            with transaction.atomic():
                MeetingRecurrence.objects.select_for_update(
                    no_key=True,
                ).get(pk=self.recurrence.pk)
                winner_locked.set()
                MeetingRecurrence.objects.filter(
                    pk=self.recurrence.pk,
                ).update(terminated_at=TERMINATED_AT)
                release_winner.wait(timeout=30)
            db_connection.close()

        loser_result = {}
        loser_errors = {}

        def loser():
            try:
                loser_result["meeting"] = (
                    reschedule_meeting_recurrence_occurrence(
                        recurrence=self.recurrence,
                        occurrence=self._occurrence_on((2026, 1, 8)),
                        scheduled_at=MOVED_TO,
                        actor=self.alex,
                        title="Too late",
                    )
                )
            except MeetingDomainError as exc:
                loser_errors["domain"] = exc
            except Exception as exc:  # pragma: no cover - deadlock proof
                loser_errors["unexpected"] = exc
            finally:
                db_connection.close()

        winner_thread = threading.Thread(target=winner)
        winner_thread.start()
        self.assertTrue(winner_locked.wait(timeout=30))

        loser_thread = threading.Thread(target=loser)
        loser_thread.start()
        # The loser must be blocked on the recurrence lock; let the
        # winner commit, then release it.
        time_module.sleep(0.25)
        release_winner.set()
        loser_thread.join(timeout=60)
        winner_thread.join(timeout=60)
        db_connection.close()

        self.assertFalse(winner_thread.is_alive())
        self.assertFalse(loser_thread.is_alive())
        # Rejected by the guard under the lock — a domain error, not
        # a deadlock and not a silent success.
        self.assertNotIn("unexpected", loser_errors)
        self.assertIn("domain", loser_errors)
        self.assertNotIn("meeting", loser_result)

        jan8.refresh_from_db()
        self.assertEqual(jan8.scheduled_at, _utc(2026, 1, 8, 8, 30))
        self.assertEqual(jan8.status, Meeting.Status.UPCOMING)
        self.assertEqual(jan8.title, "Mat")
        self.assertEqual(
            AuditEvent.objects.filter(
                event_type=MeetingAuditEventType.RESCHEDULED,
            ).count(),
            0,
        )
        self.assertEqual(
            MeetingRecurrence.objects.get(pk=self.recurrence.pk).terminated_at,
            TERMINATED_AT,
        )

    def test_reschedule_termination_barrier_race(self):
        """Full barrier race with BOTH real services: whichever wins
        the recurrence lock first, the final state satisfies the
        whole-series invariant — the series is terminated and NO
        upcoming Meeting at or after the instant survives (the move
        either committed first and was cancelled, or was rejected
        under the lock and never happened). No deadlock in either
        ordering."""
        jan8 = self._materialize(self._occurrence_on((2026, 1, 8)))
        self._materialize(self._occurrence_on((2026, 1, 9)))
        self._materialize(self._occurrence_on((2026, 1, 10)))

        resched_result = {}
        resched_errors = {}
        term_result = {}
        term_errors = {}
        barrier = threading.Barrier(2)

        def resched_worker():
            barrier.wait()
            try:
                resched_result["meeting"] = (
                    reschedule_meeting_recurrence_occurrence(
                        recurrence=self.recurrence,
                        occurrence=self._occurrence_on((2026, 1, 8)),
                        scheduled_at=MOVED_TO,
                        actor=self.alex,
                        title="Race move",
                    )
                )
            except MeetingDomainError as exc:
                resched_errors["domain"] = exc
            except Exception as exc:  # pragma: no cover - deadlock proof
                resched_errors["unexpected"] = exc
            finally:
                db_connection.close()

        def term_worker():
            barrier.wait()
            try:
                term_result["recurrence"] = terminate_meeting_recurrence(
                    recurrence=self.recurrence,
                    actor=self.alex,
                )
            except Exception as exc:
                term_errors["error"] = exc
            finally:
                db_connection.close()

        threads = [
            threading.Thread(target=resched_worker),
            threading.Thread(target=term_worker),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=60)
        db_connection.close()

        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertEqual(term_errors, {})
        self.assertNotIn("unexpected", resched_errors)

        recurrence = MeetingRecurrence.objects.get(
            pk=self.recurrence.pk,
        )
        self.assertEqual(recurrence.terminated_at, TERMINATED_AT)

        # The invariant: NO upcoming Meeting at or after the instant.
        self.assertFalse(
            Meeting.objects.filter(
                recurrence=self.recurrence,
                status=Meeting.Status.UPCOMING,
                scheduled_at__gte=TERMINATED_AT,
            ).exists(),
        )

        # Jan 9 / Jan 10 were always candidates: cancelled, each with
        # exactly one exclusion and one event.
        for day in ((2026, 1, 9), (2026, 1, 10)):
            meeting = Meeting.objects.get(
                recurrence=self.recurrence,
                original_scheduled_at=self._occurrence_on(day).original_start,
            )
            self.assertEqual(meeting.status, Meeting.Status.CANCELLED)
        self.assertEqual(
            MeetingRecurrenceExclusion.objects.filter(
                recurrence=self.recurrence,
                original_scheduled_at=_utc(2026, 1, 9, 8, 30),
            ).count(),
            1,
        )
        self.assertEqual(
            MeetingRecurrenceExclusion.objects.filter(
                recurrence=self.recurrence,
                original_scheduled_at=_utc(2026, 1, 10, 8, 30),
            ).count(),
            1,
        )

        # Jan 8: exactly ONE of the two valid outcomes.
        jan8.refresh_from_db()
        if "domain" in resched_errors:
            # Termination won: the move was rejected under the lock;
            # the before-instant Meeting is preserved as-is.
            self.assertEqual(jan8.scheduled_at, _utc(2026, 1, 8, 8, 30))
            self.assertEqual(jan8.status, Meeting.Status.UPCOMING)
            self.assertEqual(
                AuditEvent.objects.filter(
                    event_type=MeetingAuditEventType.RESCHEDULED,
                    meeting=jan8,
                ).count(),
                0,
            )
        else:
            # The reschedule committed first: the termination caught
            # the moved Meeting and cancelled it (its moved time is
            # preserved; the exclusion keeps the ORIGINAL identity).
            self.assertEqual(jan8.scheduled_at, MOVED_TO)
            self.assertEqual(jan8.status, Meeting.Status.CANCELLED)
            self.assertEqual(
                AuditEvent.objects.filter(
                    event_type=MeetingAuditEventType.RESCHEDULED,
                    meeting=jan8,
                ).count(),
                1,
            )
            self.assertEqual(
                MeetingRecurrenceExclusion.objects.filter(
                    recurrence=self.recurrence,
                    original_scheduled_at=_utc(2026, 1, 8, 8, 30),
                ).count(),
                1,
            )
