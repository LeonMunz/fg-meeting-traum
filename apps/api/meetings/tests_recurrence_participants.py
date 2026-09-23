"""Tests for recurrence intended-participant persistence and the
materialization participant snapshot.

Pins the slice invariants:

- a MeetingRecurrence owns a persisted set of intended Participants
  for FUTURE materialized occurrences (participant identity only —
  no attendance, RSVP, or presence state);
- creation accepts the canonical Meeting-participant domain
  representation (existing application users, no scope requirement),
  normalizes duplicates, rejects invalid entries atomically, and
  broadens no authorization;
- a legacy recurrence (no participant rows) carries an EMPTY set and
  the migration is a pure table creation with no backfill;
- materialization snapshots the recurrence's CURRENT set into
  concrete MeetingParticipant rows through the canonical
  creator-first initialization (creator never duplicated);
- an already-materialized Meeting is an immutable snapshot: later
  recurrence-set changes, replays, reschedules, and cancellations
  never rewrite it; only FUTURE materializations pick up the new set;
- replay/concurrency never duplicate MeetingParticipant rows;
- exclusion creates no participant rows; an excluded occurrence stays
  unmaterializable even after the set changes;
- Template deletion preserves the participant intent; legacy
  template-less behavior is unchanged;
- the existing recurrence-creation HTTP contract (no participant
  field) remains compatible.
"""

import json
import threading
from datetime import date, time
from zoneinfo import ZoneInfo

from django.contrib.auth import get_user_model
from django.db import connection as db_connection, migrations
from django.test import TestCase, TransactionTestCase
from rest_framework import status
from rest_framework.test import APIClient

from research_groups.models import ResearchGroup, ResearchGroupMembership

from .models import (
    Meeting,
    MeetingParticipant,
    MeetingRecurrence,
    MeetingRecurrenceParticipant,
    MeetingSeries,
)
from .services import (
    MeetingDomainError,
    cancel_meeting_recurrence_occurrence,
    create_meeting_recurrence,
    create_meeting_series,
    create_series_section,
    delete_meeting_series,
    exclude_meeting_recurrence_occurrence,
    expand_meeting_recurrence_occurrences,
    materialize_meeting_recurrence_occurrence,
    reschedule_meeting_recurrence_occurrence,
)
from .tests_recurrence import MeetingRecurrenceBase, _utc

User = get_user_model()


class RecurrenceParticipantBase(MeetingRecurrenceBase):
    """Shared participant helpers on the canonical recurrence fixtures."""

    def _create_participant_recurrence(self, participants=(), **overrides):
        return self._create_recurrence(participants=participants, **overrides)

    def _recurrence_user_ids(self, recurrence):
        return sorted(
            MeetingRecurrenceParticipant.objects.filter(
                recurrence=recurrence,
            ).values_list("user_id", flat=True)
        )

    def _set_participants(self, recurrence, users):
        """Domain/model-level mutation of the persisted intent set.

        No public recurrence-participant edit API exists in this
        slice: these tests mutate the relation directly to prove the
        snapshot-immutability invariant.
        """
        wanted = {user.pk: user for user in users}
        MeetingRecurrenceParticipant.objects.filter(
            recurrence=recurrence,
        ).exclude(user_id__in=list(wanted)).delete()
        MeetingRecurrenceParticipant.objects.bulk_create([
            MeetingRecurrenceParticipant(recurrence=recurrence, user=user)
            for user in wanted.values()
            if not MeetingRecurrenceParticipant.objects.filter(
                recurrence=recurrence, user_id=user.pk,
            ).exists()
        ])

    def _participant_ids(self, meeting):
        return sorted(
            MeetingParticipant.objects.filter(meeting=meeting)
            .values_list("user_id", flat=True)
        )

    def _legacy_recurrence(self):
        """A pre-linkage legacy recurrence: no Template, and (pre-slice)
        no participant linkage state either."""
        return MeetingRecurrence.objects.create(
            research_group=self.group,
            title="Legacy Series",
            frequency="daily",
            interval=1,
            weekdays=[],
            start_date=date(2026, 1, 5),
            local_time=time(9, 30),
            timezone_name="Europe/Berlin",
            end_mode="no_end",
            created_by=self.alex,
        )

    def _occurrence_on(self, recurrence, day):
        (occurrence,) = self._expand(
            recurrence,
            _utc(2026, 1, day, 0, 0),
            _utc(2026, 1, day, 23, 59),
        )
        return occurrence

    def _materialize_day(self, recurrence, day, actor=None):
        return self._materialize(
            recurrence,
            self._occurrence_on(recurrence, day),
            actor=actor,
        )


class RecurrenceParticipantCreationTest(RecurrenceParticipantBase):
    """Domain creation with an intended participant set."""

    def test_creation_without_participants_remains_valid(self):
        recurrence = self._create_recurrence()
        self.assertEqual(
            self._recurrence_user_ids(recurrence), [],
        )
        self.assertEqual(Meeting.objects.count(), 0)
        # Still fully materializable (creator-only participant set).
        meeting = self._materialize_day(recurrence, 5)
        self.assertEqual(self._participant_ids(meeting), [self.alex.pk])

    def test_creation_with_participants_persists_them(self):
        recurrence = self._create_participant_recurrence(
            participants=[self.chris, self.laura],
        )
        self.assertEqual(
            self._recurrence_user_ids(recurrence),
            sorted([self.chris.pk, self.laura.pk]),
        )
        # The creator is NOT force-added to the intent set: the
        # canonical creator semantics apply at materialization.
        self.assertNotIn(self.alex.pk, self._recurrence_user_ids(recurrence))
        # No Meeting rows are created by the persistence.
        self.assertEqual(Meeting.objects.count(), 0)
        self.assertEqual(MeetingParticipant.objects.count(), 0)

    def test_duplicate_participant_input_persists_each_user_once(self):
        recurrence = self._create_participant_recurrence(
            participants=[self.chris, self.chris, self.laura,
                         self.laura, self.chris],
        )
        self.assertEqual(
            self._recurrence_user_ids(recurrence),
            sorted([self.chris.pk, self.laura.pk]),
        )
        self.assertEqual(
            MeetingRecurrenceParticipant.objects.filter(
                recurrence=recurrence,
            ).count(),
            2,
        )

    def test_non_persisted_participant_rejected_atomically(self):
        ghost = User(username="rec-ghost")  # never saved
        before_recurrences = MeetingRecurrence.objects.count()
        with self.assertRaises(MeetingDomainError):
            self._create_participant_recurrence(
                participants=[self.chris, ghost],
            )
        self.assertEqual(
            MeetingRecurrence.objects.count(), before_recurrences,
        )
        self.assertEqual(MeetingRecurrenceParticipant.objects.count(), 0)

    def test_external_user_can_be_a_recurrence_participant(self):
        # Canonical Meeting-participant eligibility: ANY existing
        # application user — Research Group membership is NOT a
        # requirement (the same rule ordinary Meeting creation
        # applies).
        recurrence = self._create_participant_recurrence(
            participants=[self.maria],
        )
        self.assertEqual(
            self._recurrence_user_ids(recurrence), [self.maria.pk],
        )
        # And the intent materializes into a concrete participant.
        meeting = self._materialize_day(recurrence, 5)
        self.assertEqual(
            self._participant_ids(meeting),
            sorted([self.alex.pk, self.maria.pk]),
        )

    def test_participant_persistence_grants_no_recurrence_access(self):
        # Persistence of the intent must NOT broaden authorization:
        # a persisted participant who is NOT a group member cannot
        # read the recurrence (the recurrence read rule is scope-based
        # and unchanged).
        self._create_participant_recurrence(participants=[self.maria])
        client = APIClient()
        client.force_login(self.maria)
        recurrence = MeetingRecurrence.objects.get()
        response = client.get(
            f"/api/meeting-recurrences/{recurrence.pk}/occurrences/",
            {
                "from": _utc(2026, 1, 5).isoformat(),
                "to": _utc(2026, 1, 7).isoformat(),
            },
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_unauthorized_actor_cannot_create_recurrence_with_participants(
        self,
    ):
        # The scoped write rule is unchanged: a Project viewer cannot
        # create a project-scoped recurrence — participants or not.
        template = self._create_series(
            scope="project", project=self.project,
        )
        with self.assertRaises(MeetingDomainError):
            create_meeting_recurrence(
                research_group=self.group,
                actor=self.laura,
                meeting_series=template,
                title="Viewer Series",
                frequency="daily",
                interval=1,
                start_date=date(2026, 1, 5),
                local_time=time(9, 30),
                timezone_name="Europe/Berlin",
                scope="project",
                project=self.project,
                participants=[self.chris],
            )
        self.assertEqual(MeetingRecurrence.objects.count(), 0)
        self.assertEqual(MeetingRecurrenceParticipant.objects.count(), 0)


class RecurrenceParticipantMigrationTest(RecurrenceParticipantBase):
    """Migration 0020 is a pure table creation; legacy rows → empty set."""

    def test_migration_is_pure_table_creation_without_backfill(self):
        import importlib

        m20 = importlib.import_module(
            "meetings.migrations.0020_meetingrecurrenceparticipant"
        )
        # No data step exists that could backfill, fabricate, or touch
        # any historical recurrence row.
        for operation in m20.Migration.operations:
            self.assertNotIsInstance(
                operation, (migrations.RunPython, migrations.RunSQL),
            )
        self.assertIsInstance(
            m20.Migration.operations[0], migrations.CreateModel,
        )

    def test_legacy_recurrence_survives_with_empty_set(self):
        recurrence = self._legacy_recurrence()
        self.assertIsNone(recurrence.series)
        # Legacy rows legitimately predate the participant linkage:
        # their participant set is EMPTY (no backfill of the creator or
        # of any Meeting participant).
        self.assertEqual(self._recurrence_user_ids(recurrence), [])
        # The legacy recurrence remains fully valid: the rule expands.
        occurrences = self._expand(
            recurrence, _utc(2026, 1, 5), _utc(2026, 1, 7),
        )
        self.assertEqual(len(occurrences), 2)


class RecurrenceParticipantMaterializationTest(RecurrenceParticipantBase):
    """First materialization snapshots the persisted participant set."""

    def test_materialization_snapshots_persisted_participants(self):
        recurrence = self._create_participant_recurrence(
            participants=[self.chris, self.laura],
        )
        meeting = self._materialize_day(recurrence, 5)
        self.assertEqual(
            self._participant_ids(meeting),
            sorted([self.alex.pk, self.chris.pk, self.laura.pk]),
        )
        self.assertEqual(MeetingParticipant.objects.count(), 3)

    def test_creator_behavior_remains_canonical(self):
        # The creator is ALWAYS a participant of a materialized
        # occurrence — even when absent from the intent set.
        recurrence = self._create_participant_recurrence(
            participants=[self.chris],
        )
        meeting = self._materialize_day(recurrence, 5)
        self.assertIn(self.alex.pk, self._participant_ids(meeting))
        # Materialized by the actor: the actor is the creator.
        self.assertEqual(meeting.created_by, self.alex)

    def test_creator_in_participant_set_does_not_duplicate(self):
        recurrence = self._create_participant_recurrence(
            participants=[self.alex, self.chris],
        )
        # The intent persists the creator exactly once...
        self.assertEqual(
            self._recurrence_user_ids(recurrence),
            sorted([self.alex.pk, self.chris.pk]),
        )
        # ...and materialization never duplicates the Meeting row.
        meeting = self._materialize_day(recurrence, 5)
        self.assertEqual(
            self._participant_ids(meeting),
            sorted([self.alex.pk, self.chris.pk]),
        )
        self.assertEqual(
            MeetingParticipant.objects.filter(
                meeting=meeting, user=self.alex,
            ).count(),
            1,
        )
        self.assertEqual(MeetingParticipant.objects.count(), 2)

    def test_multiple_participants_each_materialize_exactly_once(self):
        recurrence = self._create_participant_recurrence(
            participants=[self.chris, self.laura, self.maria],
        )
        meeting = self._materialize_day(recurrence, 5)
        self.assertEqual(
            self._participant_ids(meeting),
            sorted([self.alex.pk, self.chris.pk, self.laura.pk,
                    self.maria.pk]),
        )
        for user in (self.alex, self.chris, self.laura, self.maria):
            self.assertEqual(
                MeetingParticipant.objects.filter(
                    meeting=meeting, user=user,
                ).count(),
                1,
            )

    def test_template_sections_still_snapshot_alongside_participants(self):
        template = self._create_series()
        create_series_section(
            meeting_series=template, actor=self.alex, name="Decisions",
        )
        recurrence = self._create_participant_recurrence(
            meeting_series=template, participants=[self.chris],
        )
        meeting = self._materialize_day(recurrence, 5)
        # Both Template Section snapshots AND participant rows exist.
        self.assertEqual(
            [s.name for s in meeting.meeting_sections.order_by("position")],
            ["Agenda", "Decisions"],
        )
        for section in meeting.meeting_sections.all():
            self.assertIsNotNone(section.source_series_section_id)
        self.assertEqual(
            self._participant_ids(meeting),
            sorted([self.alex.pk, self.chris.pk]),
        )

    def test_materializing_a_later_occurrence_snapshots_the_same_set(self):
        recurrence = self._create_participant_recurrence(
            participants=[self.chris],
        )
        first = self._materialize_day(recurrence, 5)
        second = self._materialize_day(recurrence, 6)
        self.assertNotEqual(first.pk, second.pk)
        for meeting in (first, second):
            self.assertEqual(
                self._participant_ids(meeting),
                sorted([self.alex.pk, self.chris.pk]),
            )


class RecurrenceParticipantSnapshotImmutabilityTest(
    RecurrenceParticipantBase,
):
    """Existing materialized Meetings are immutable snapshots."""

    def test_changing_set_does_not_modify_existing_meeting(self):
        recurrence = self._create_participant_recurrence(
            participants=[self.chris, self.laura],
        )
        meeting_a = self._materialize_day(recurrence, 5)
        self.assertEqual(
            self._participant_ids(meeting_a),
            sorted([self.alex.pk, self.chris.pk, self.laura.pk]),
        )

        # Change the recurrence participant set later.
        self._set_participants(recurrence, [self.laura, self.maria])
        self.assertEqual(
            self._recurrence_user_ids(recurrence),
            sorted([self.laura.pk, self.maria.pk]),
        )

        # Meeting A is untouched.
        meeting_a.refresh_from_db()
        self.assertEqual(
            self._participant_ids(meeting_a),
            sorted([self.alex.pk, self.chris.pk, self.laura.pk]),
        )
        self.assertEqual(MeetingParticipant.objects.count(), 3)

    def test_later_occurrence_receives_changed_set(self):
        recurrence = self._create_participant_recurrence(
            participants=[self.chris, self.laura],
        )
        meeting_a = self._materialize_day(recurrence, 5)
        self._set_participants(recurrence, [self.laura, self.maria])
        meeting_b = self._materialize_day(recurrence, 6)

        # A keeps the original snapshot...
        self.assertEqual(
            self._participant_ids(meeting_a),
            sorted([self.alex.pk, self.chris.pk, self.laura.pk]),
        )
        # ...B receives the CURRENT set.
        self.assertEqual(
            self._participant_ids(meeting_b),
            sorted([self.alex.pk, self.laura.pk, self.maria.pk]),
        )

    def test_replay_after_set_change_does_not_rewrite(self):
        recurrence = self._create_participant_recurrence(
            participants=[self.chris, self.laura],
        )
        meeting_a = self._materialize_day(recurrence, 5)
        self._set_participants(recurrence, [self.maria])

        # Replaying the same occurrence returns the SAME Meeting and
        # does NOT re-snapshot the changed set.
        again = self._materialize(
            recurrence, self._occurrence_on(recurrence, 5),
        )
        self.assertEqual(again.pk, meeting_a.pk)
        self.assertEqual(Meeting.objects.count(), 1)
        self.assertEqual(
            self._participant_ids(meeting_a),
            sorted([self.alex.pk, self.chris.pk, self.laura.pk]),
        )
        # No duplicate rows: exactly the original snapshot survives.
        self.assertEqual(MeetingParticipant.objects.count(), 3)


class RecurrenceParticipantMaterializationConcurrencyTest(
    TransactionTestCase,
):
    """Concurrent first materialization never duplicates participants."""

    def setUp(self):
        self.alex = User.objects.create_user(
            username="recpp-alex", password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="recpp-chris", password="Pass1!",
        )
        self.laura = User.objects.create_user(
            username="recpp-laura", password="Pass1!",
        )
        self.group = ResearchGroup.objects.create(
            name="PP Race Group", created_by=self.alex,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        series = create_meeting_series(
            research_group=self.group,
            actor=self.alex,
            title="PP Race Template",
        )
        create_series_section(
            meeting_series=series, actor=self.alex, name="Agenda",
        )
        self.recurrence = create_meeting_recurrence(
            research_group=self.group,
            actor=self.alex,
            meeting_series=series,
            title="PP Race",
            frequency="daily",
            interval=1,
            start_date=date(2026, 1, 5),
            local_time=time(9, 30),
            timezone_name="Europe/Berlin",
            participants=[self.chris, self.laura],
        )
        (self.occurrence,) = expand_meeting_recurrence_occurrences(
            meeting_recurrence=self.recurrence,
            range_start=_utc(2026, 1, 5),
            range_end=_utc(2026, 1, 6),
        )

    def _materialize_in_thread(self, name, results, errors, barrier):
        def worker():
            barrier.wait()
            try:
                results[name] = materialize_meeting_recurrence_occurrence(
                    recurrence=self.recurrence,
                    occurrence=self.occurrence,
                    actor=self.alex,
                    title="PP Raced",
                )
            except Exception as exc:
                errors[name] = exc
            finally:
                db_connection.close()

        return worker

    def test_concurrent_materialization_does_not_duplicate_participants(
        self,
    ):
        results, errors = {}, {}
        barrier = threading.Barrier(2)
        threads = [
            threading.Thread(
                target=self._materialize_in_thread(
                    name, results, errors, barrier,
                ),
            )
            for name in ("a", "b")
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(errors, {})
        self.assertEqual(results["a"].pk, results["b"].pk)
        self.assertEqual(Meeting.objects.count(), 1)
        meeting = Meeting.objects.first()
        # Exactly one participant row per intended user + creator —
        # the losing racer's snapshot rolled back with its transaction.
        self.assertEqual(
            sorted(
                MeetingParticipant.objects.filter(meeting=meeting)
                .values_list("user_id", flat=True)
            ),
            sorted([self.alex.pk, self.chris.pk, self.laura.pk]),
        )
        self.assertEqual(MeetingParticipant.objects.count(), 3)


class RecurrenceParticipantRescheduleCancelExclusionTest(
    RecurrenceParticipantBase,
):
    """Reschedule / cancel / exclusion keep the participant snapshot."""

    def test_reschedule_preserves_participant_snapshot(self):
        recurrence = self._create_participant_recurrence(
            participants=[self.chris, self.laura],
        )
        meeting_a = self._materialize_day(recurrence, 5)
        self._set_participants(recurrence, [self.maria])

        moved = _utc(2026, 1, 5, 11, 0)
        reschedule_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=self._occurrence_on(recurrence, 5),
            scheduled_at=moved,
            actor=self.alex,
            title="PP Rescheduled",
        )
        meeting_a.refresh_from_db()
        self.assertEqual(meeting_a.scheduled_at, moved)
        # The snapshot is unchanged by the reschedule.
        self.assertEqual(
            self._participant_ids(meeting_a),
            sorted([self.alex.pk, self.chris.pk, self.laura.pk]),
        )
        self.assertEqual(Meeting.objects.count(), 1)

    def test_virtual_reschedule_materializes_with_current_set(self):
        recurrence = self._create_participant_recurrence(
            participants=[self.chris],
        )
        self._set_participants(recurrence, [self.laura])

        moved = _utc(2026, 1, 5, 11, 0)
        reschedule_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=self._occurrence_on(recurrence, 5),
            scheduled_at=moved,
            actor=self.alex,
            title="PP Virtual Reschedule",
        )
        meeting = Meeting.objects.get()
        # The virtual occurrence materialized with the CURRENT set.
        self.assertEqual(
            self._participant_ids(meeting),
            sorted([self.alex.pk, self.laura.pk]),
        )
        self.assertEqual(meeting.scheduled_at, moved)

    def test_cancel_preserves_participant_snapshot(self):
        recurrence = self._create_participant_recurrence(
            participants=[self.chris, self.laura],
        )
        meeting_a = self._materialize_day(recurrence, 5)

        cancelled = cancel_meeting_recurrence_occurrence(
            meeting=meeting_a, actor=self.alex,
        )
        self.assertEqual(cancelled.status, Meeting.Status.CANCELLED)
        # The participant snapshot survives the cancellation.
        self.assertEqual(
            self._participant_ids(cancelled),
            sorted([self.alex.pk, self.chris.pk, self.laura.pk]),
        )
        self.assertEqual(MeetingParticipant.objects.count(), 3)

    def test_exclusion_creates_no_participant_rows(self):
        recurrence = self._create_participant_recurrence(
            participants=[self.chris, self.laura],
        )
        exclude_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=self._occurrence_on(recurrence, 5),
            actor=self.alex,
        )
        self.assertEqual(Meeting.objects.count(), 0)
        self.assertEqual(MeetingParticipant.objects.count(), 0)

    def test_excluded_occurrence_stays_unmaterializable_after_set_change(
        self,
    ):
        recurrence = self._create_participant_recurrence(
            participants=[self.chris],
        )
        exclude_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=self._occurrence_on(recurrence, 5),
            actor=self.alex,
        )
        # A later participant change cannot open a second
        # materialization path for the excluded occurrence.
        self._set_participants(recurrence, [self.maria])
        with self.assertRaises(MeetingDomainError):
            self._materialize_day(recurrence, 5)
        self.assertEqual(Meeting.objects.count(), 0)
        self.assertEqual(MeetingParticipant.objects.count(), 0)


class RecurrenceParticipantTemplateTest(RecurrenceParticipantBase):
    """Template deletion and legacy template-less behavior."""

    def test_template_deletion_preserves_participant_intent(self):
        template = self._create_series()
        recurrence = self._create_participant_recurrence(
            meeting_series=template,
            participants=[self.chris, self.laura],
        )
        meeting_a = self._materialize_day(recurrence, 5)

        delete_meeting_series(meeting_series=template, actor=self.alex)

        # SET_NULL: the recurrence and its participant intent survive.
        recurrence.refresh_from_db()
        self.assertIsNone(recurrence.series)
        self.assertEqual(
            self._recurrence_user_ids(recurrence),
            sorted([self.chris.pk, self.laura.pk]),
        )
        # The materialized Meeting and its snapshot are untouched.
        meeting_a.refresh_from_db()
        self.assertEqual(
            self._participant_ids(meeting_a),
            sorted([self.alex.pk, self.chris.pk, self.laura.pk]),
        )
        self.assertEqual(MeetingSeries.objects.count(), 0)

    def test_legacy_templateless_recurrence_behavior_unchanged(self):
        recurrence = self._legacy_recurrence()
        # Participant state is readable/persistable on a legacy row...
        self._set_participants(recurrence, [self.chris])
        self.assertEqual(
            self._recurrence_user_ids(recurrence), [self.chris.pk],
        )
        # ...but the Template requirement still blocks new virtual
        # materialization: no participant support bypass.
        with self.assertRaises(MeetingDomainError):
            self._materialize_day(recurrence, 5)
        self.assertEqual(Meeting.objects.count(), 0)
        self.assertEqual(MeetingParticipant.objects.count(), 0)
        # The rule still expands and the intent persists.
        self.assertEqual(
            len(self._expand(recurrence, _utc(2026, 1, 5), _utc(2026, 1, 7))),
            2,
        )
        self.assertEqual(
            self._recurrence_user_ids(recurrence), [self.chris.pk],
        )


class RecurrenceParticipantApiCompatibilityTest(RecurrenceParticipantBase):
    """The existing recurrence-creation HTTP contract is unchanged."""

    def setUp(self):
        super().setUp()
        self.client = APIClient()
        self.series = self._create_series()

    def _daily_payload(self):
        return {
            "meetingSeriesId": self.series.pk,
            "title": "Daily Standup",
            "frequency": "daily",
            "interval": 1,
            "startDate": "2026-01-05",
            "localTime": "09:30",
            "timezone": "Europe/Berlin",
        }

    def test_http_creation_without_participant_field_remains_compatible(
        self,
    ):
        self.client.force_login(self.alex)
        response = self.client.post(
            "/api/meeting-recurrences/",
            data=json.dumps(self._daily_payload()),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(MeetingRecurrence.objects.count(), 1)
        # The existing contract carries no participant field: the
        # persisted intent set is empty...
        recurrence = MeetingRecurrence.objects.get()
        self.assertEqual(self._recurrence_user_ids(recurrence), [])
        # ...and materialization yields exactly the creator.
        meeting = self._materialize_day(recurrence, 5)
        self.assertEqual(self._participant_ids(meeting), [self.alex.pk])
