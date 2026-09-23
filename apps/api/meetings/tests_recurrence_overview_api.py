"""API tests for the personal recurring-SERIES overview.

``GET /api/meeting-recurrences/`` returns exactly ONE record per
personally relevant ``MeetingRecurrence`` of the current authenticated
user — never one row per occurrence, and never derived from an
occurrence window — each carrying the canonical recurrence
representation plus the minimal overview context (creator, people
count, derived ``active`` / ``ended`` status, next effective
occurrence).

Personal relevance mirrors the established personal-recurrence
semantics of the bounded personal occurrence feed (creator or
persisted intended participant); scope-level authorization visibility
is a separate concept and never feeds this endpoint. Time is frozen
for every test: ``meetings.services._current_instant`` is patched to
the single observation ``NOW`` (the repository's clock-observation
convention).
"""

from datetime import date, time, timezone as dt_timezone
from unittest import mock

from audit_history.models import AuditEvent
from django.contrib.auth import get_user_model
from django.db import IntegrityError, connection, transaction
from django.test.utils import CaptureQueriesContext

from rest_framework import status
from rest_framework.test import APIClient

from .models import (
    Meeting,
    MeetingParticipant,
    MeetingRecurrence,
    MeetingRecurrenceExclusion,
    MeetingRecurrenceParticipant,
    MeetingSection,
)
from .services import (
    cancel_meeting_recurrence_occurrence,
    exclude_meeting_recurrence_occurrence,
    materialize_meeting_recurrence_occurrence,
    reschedule_meeting_recurrence_occurrence,
)
from .tests_recurrence import MeetingRecurrenceBase, _utc

User = get_user_model()
UTC = dt_timezone.utc

# Frozen single clock observation: Tuesday 2026-01-06 12:00 UTC
# (13:00 Europe/Berlin). The fixture recurrence (daily 09:30 Berlin,
# first occurrence Monday 2026-01-05) has its Jan 5 and Jan 6 slots in
# the past; its next effective occurrence is Wed 2026-01-07 09:30
# Berlin = 08:30 UTC (CET).
NOW = _utc(2026, 1, 6, 12, 0)


class MeetingRecurrenceOverviewApiTest(MeetingRecurrenceBase):
    """Personal recurring-Series overview for one user."""

    PATH = "/api/meeting-recurrences/"

    def setUp(self):
        super().setUp()
        self.client = APIClient()
        self._clock_patch = mock.patch(
            "meetings.services._current_instant",
            return_value=NOW,
        )
        self._clock_patch.start()
        self.addCleanup(self._clock_patch.stop)

    def login(self, user):
        self.client.logout()
        self.client.force_login(user)

    def _get_overview(self):
        return self.client.get(self.PATH)

    def _iso(self, instant):
        return instant.astimezone(UTC).isoformat().replace("+00:00", "Z")

    def _row_for(self, data, recurrence):
        rows = [row for row in data if row["id"] == recurrence.pk]
        self.assertEqual(len(rows), 1)
        return rows[0]

    def _state_snapshot(self):
        return {
            "meetings": Meeting.objects.count(),
            "sections": MeetingSection.objects.count(),
            "meeting_participants": MeetingParticipant.objects.count(),
            "recurrence_participants":
                MeetingRecurrenceParticipant.objects.count(),
            "exclusions": MeetingRecurrenceExclusion.objects.count(),
            "audit_events": AuditEvent.objects.count(),
            "recurrence_updated_at": list(
                MeetingRecurrence.objects.values_list("updated_at", flat=True)
            ),
            "meeting_scheduled_at": list(
                Meeting.objects.values_list("scheduled_at", flat=True)
            ),
        }

    # ── 1. Authentication ────────────────────────────────────────

    def test_anonymous_request_is_rejected(self):
        response = self._get_overview()
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)

    # ── 2-6. Personal relevance ───────────────────────────────────

    def test_creator_sees_their_series(self):
        recurrence = self._create_recurrence()
        self.login(self.alex)
        response = self._get_overview()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        self.assertEqual(len(data), 1)
        row = data[0]
        self.assertEqual(row["id"], recurrence.pk)
        self.assertEqual(row["title"], recurrence.title)
        self.assertEqual(row["meetingSeriesId"], recurrence.series_id)
        self.assertEqual(row["status"], "active")

    def test_participant_sees_the_series(self):
        recurrence = self._create_recurrence(
            title="Team Sync", participants=(self.chris,),
        )
        self.login(self.chris)
        response = self._get_overview()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]["id"], recurrence.pk)

    def test_outsider_participant_sees_the_series(self):
        # The personal relationship — not scope-level visibility — is
        # the overview input, exactly like the personal feed: an
        # outsider listed as an intended participant sees the series.
        recurrence = self._create_recurrence(
            title="External Sync", participants=(self.maria,),
        )
        self.login(self.maria)
        response = self._get_overview()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]["id"], recurrence.pk)

    def test_scope_only_group_member_does_not_see(self):
        # chris is a Research Group member but neither the creator nor
        # an intended participant: group membership alone must not put
        # the series into the personal overview.
        self._create_recurrence()
        self.login(self.chris)
        response = self._get_overview()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.json(), [])

    def test_scope_only_project_member_and_viewer_do_not_see(self):
        self._create_recurrence(
            title="Project Sync", scope="project", project=self.project,
        )
        # Project membership (member) and Project visibility (viewer)
        # are authorization visibility, not personal relevance.
        for user in (self.chris, self.laura):
            with self.subTest(user=user.username):
                self.login(user)
                response = self._get_overview()
                self.assertEqual(response.status_code, status.HTTP_200_OK)
                self.assertEqual(response.json(), [])

    def test_unrelated_user_does_not_see(self):
        self._create_recurrence()
        self.login(self.maria)
        response = self._get_overview()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        # No item content or count leaks the unrelated series.
        self.assertEqual(response.json(), [])

    # ── 7/8. One row per recurrence; duplicates cannot duplicate ─

    def test_exactly_one_row_per_recurrence(self):
        first = self._create_recurrence(
            title="Morning Sync", local_time=time(9, 30),
        )
        second = self._create_recurrence(
            title="Evening Sync", local_time=time(16, 0),
        )
        self.login(self.alex)
        response = self._get_overview()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        # Both series have several occurrences around NOW — the
        # overview still returns exactly ONE row per recurrence,
        # never one row per occurrence.
        self.assertEqual(len(data), 2)
        self.assertEqual(
            {row["id"] for row in data}, {first.pk, second.pk},
        )

    def test_creator_and_explicit_participant_does_not_duplicate_row(self):
        # The creator matching BOTH relevance branches (created_by OR
        # participant relation) must still yield exactly one row.
        recurrence = self._create_recurrence(
            title="Double Listed", participants=(self.alex,),
        )
        self.login(self.alex)
        response = self._get_overview()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            [row["id"] for row in response.json()], [recurrence.pk],
        )

    def test_duplicate_participant_relation_cannot_duplicate_row(self):
        recurrence = self._create_recurrence()
        MeetingRecurrenceParticipant.objects.create(
            recurrence=recurrence, user=self.chris,
        )
        # The database-unique (recurrence, user) constraint is the
        # final deduplication authority.
        with self.assertRaises(IntegrityError), transaction.atomic():
            MeetingRecurrenceParticipant.objects.create(
                recurrence=recurrence, user=self.chris,
            )
        self.login(self.chris)
        response = self._get_overview()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            [row["id"] for row in response.json()], [recurrence.pk],
        )

    # ── 9-12. Response data: rule fields, scope, creator ──────────

    def test_all_structured_rule_fields_are_correct(self):
        recurrence = self._create_recurrence(
            title="Weekly Planning",
            frequency="weekly",
            interval=2,
            weekdays=[0, 2],  # Monday + Wednesday (start date Monday)
            start_date=date(2026, 1, 5),
            local_time=time(10, 15),
            end_mode="end_date",
            end_date=date(2026, 6, 30),
        )
        counted = self._create_recurrence(
            title="Counted", local_time=time(11, 0),
            end_mode="count", occurrence_count=5,
        )
        self.login(self.alex)
        response = self._get_overview()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()

        row = self._row_for(data, recurrence)
        self.assertEqual(row["id"], recurrence.pk)
        self.assertEqual(row["title"], "Weekly Planning")
        self.assertEqual(row["meetingSeriesId"], recurrence.series_id)
        self.assertEqual(row["frequency"], "weekly")
        self.assertEqual(row["interval"], 2)
        self.assertEqual(row["weekdays"], [0, 2])
        self.assertEqual(row["startDate"], "2026-01-05")
        self.assertEqual(row["localTime"], "10:15:00")
        self.assertEqual(row["timezone"], "Europe/Berlin")
        self.assertEqual(row["endDate"], "2026-06-30")
        self.assertIsNone(row["count"])

        counted_row = self._row_for(data, counted)
        self.assertEqual(counted_row["frequency"], "daily")
        self.assertEqual(counted_row["interval"], 1)
        self.assertEqual(counted_row["weekdays"], [])
        self.assertEqual(counted_row["startDate"], "2026-01-05")
        self.assertIsNone(counted_row["endDate"])
        self.assertEqual(counted_row["count"], 5)

    def test_group_scope_fields_are_correct(self):
        recurrence = self._create_recurrence(local_time=time(12, 0))
        self.login(self.alex)
        row = self._row_for(self._get_overview().json(), recurrence)
        self.assertEqual(row["scope"], "group")
        self.assertEqual(row["researchGroupId"], self.group.pk)
        self.assertIsNone(row["projectId"])

    def test_project_scope_fields_are_correct(self):
        recurrence = self._create_recurrence(
            local_time=time(12, 0), scope="project", project=self.project,
        )
        self.login(self.alex)
        row = self._row_for(self._get_overview().json(), recurrence)
        self.assertEqual(row["scope"], "project")
        self.assertEqual(row["researchGroupId"], self.group.pk)
        self.assertEqual(row["projectId"], self.project.pk)

    def test_creator_uses_canonical_minimal_user_summary(self):
        self.alex.first_name = "Alex"
        self.alex.last_name = "Anderson"
        self.alex.save(update_fields=["first_name", "last_name"])
        recurrence = self._create_recurrence()
        self.login(self.alex)
        row = self._row_for(self._get_overview().json(), recurrence)
        self.assertEqual(row["creator"], {
            "id": self.alex.pk,
            "username": "rec-alex",
            "firstName": "Alex",
            "lastName": "Anderson",
        })

    # ── 13/14. peopleCount ────────────────────────────────────────

    def test_people_count_creator_only_is_one(self):
        recurrence = self._create_recurrence()
        self.login(self.alex)
        row = self._row_for(self._get_overview().json(), recurrence)
        self.assertEqual(row["peopleCount"], 1)

    def test_people_count_counts_unique_people_and_deduplicates_creator(
        self,
    ):
        two_more = self._create_recurrence(
            title="Three People", local_time=time(8, 0),
            participants=(self.chris, self.laura),
        )
        creator_listed = self._create_recurrence(
            title="Creator Listed", local_time=time(8, 15),
            participants=(self.alex, self.chris, self.laura),
        )
        four_people = self._create_recurrence(
            title="Four People", local_time=time(8, 30),
            participants=(self.chris, self.laura, self.maria),
        )
        self.login(self.alex)
        data = self._get_overview().json()
        # creator + 2 others => 3
        self.assertEqual(self._row_for(data, two_more)["peopleCount"], 3)
        # creator + 2 others, creator ALSO explicitly listed => 3
        # (counted once)
        self.assertEqual(
            self._row_for(data, creator_listed)["peopleCount"], 3,
        )
        # creator + 3 other people => 4
        self.assertEqual(
            self._row_for(data, four_people)["peopleCount"], 4,
        )

    # ── 15-17. Next effective occurrence: rule semantics ──────────

    def test_daily_next_occurrence_is_correct(self):
        recurrence = self._create_recurrence()
        self.login(self.alex)
        row = self._row_for(self._get_overview().json(), recurrence)
        # NOW = Tue 2026-01-06 12:00Z (13:00 Berlin): the Jan 5 and
        # Jan 6 09:30 slots are already past; the next effective
        # occurrence is Wed 2026-01-07 09:30 Berlin = 08:30Z (CET).
        self.assertEqual(
            row["nextOccurrenceScheduledAt"], "2026-01-07T08:30:00Z",
        )
        self.assertEqual(row["status"], "active")

    def test_weekly_next_occurrence_is_correct(self):
        recurrence = self._create_recurrence(
            title="Weekly", frequency="weekly", interval=1,
            weekdays=[0, 2],  # Monday + Wednesday
            start_date=date(2026, 1, 5), local_time=time(10, 0),
            participants=(self.chris,),
        )
        self.login(self.chris)
        row = self._row_for(self._get_overview().json(), recurrence)
        # NOW is a Tuesday: Monday Jan 5 is past, so the next
        # occurrence is Wednesday Jan 7 10:00 Berlin = 09:00Z (CET).
        self.assertEqual(
            row["nextOccurrenceScheduledAt"], "2026-01-07T09:00:00Z",
        )
        self.assertEqual(row["status"], "active")

    def test_monthly_next_occurrence_skips_invalid_dates(self):
        recurrence = self._create_recurrence(
            title="Monthly", frequency="monthly", interval=1,
            start_date=date(2025, 10, 31), local_time=time(9, 30),
            participants=(self.maria,),
        )
        with mock.patch(
            "meetings.services._current_instant",
            return_value=_utc(2026, 2, 10, 12, 0),
        ):
            self.login(self.maria)
            row = self._row_for(self._get_overview().json(), recurrence)
        # NOW = Tue 2026-02-10: the 31st-day rule skips February
        # (28 days in 2026) — the date is never shifted to the month
        # end — so the next occurrence is Mar 31 09:30 Berlin =
        # 07:30Z (CEST from Mar 29).
        self.assertEqual(
            row["nextOccurrenceScheduledAt"], "2026-03-31T07:30:00Z",
        )
        self.assertEqual(row["status"], "active")

    # ── 18-20. Exclusions, cancellations, reschedules ─────────────

    def test_exclusion_skips_the_excluded_candidate(self):
        recurrence = self._create_recurrence()
        (target,) = self._expand(
            recurrence, _utc(2026, 1, 7, 0, 0), _utc(2026, 1, 8, 0, 0),
        )
        exclude_meeting_recurrence_occurrence(
            recurrence=recurrence, occurrence=target, actor=self.alex,
        )
        self.login(self.alex)
        row = self._row_for(self._get_overview().json(), recurrence)
        # The excluded Jan 7 candidate is absent (no replacement);
        # the next effective occurrence is Jan 8.
        self.assertEqual(
            row["nextOccurrenceScheduledAt"], "2026-01-08T08:30:00Z",
        )

    def test_cancelled_materialized_occurrence_is_not_next(self):
        recurrence = self._create_recurrence()
        (target,) = self._expand(
            recurrence, _utc(2026, 1, 7, 0, 0), _utc(2026, 1, 8, 0, 0),
        )
        meeting = materialize_meeting_recurrence_occurrence(
            recurrence=recurrence, occurrence=target,
            actor=self.alex, title="Standup",
        )
        cancel_meeting_recurrence_occurrence(
            meeting=meeting, actor=self.alex,
        )
        self.login(self.alex)
        row = self._row_for(self._get_overview().json(), recurrence)
        # The cancelled Jan 7 occurrence stays absent; the next
        # effective occurrence is Jan 8.
        self.assertEqual(
            row["nextOccurrenceScheduledAt"], "2026-01-08T08:30:00Z",
        )
        self.assertEqual(row["status"], "active")

    def test_rescheduled_materialized_occurrence_is_next_at_its_effective_time(
        self,
    ):
        recurrence = self._create_recurrence(
            title="Mondays", frequency="weekly", interval=1,
            weekdays=[0], start_date=date(2026, 1, 5),
            local_time=time(9, 30), participants=(self.chris,),
        )
        # Candidates: Jan 5 (past), Jan 12, Jan 19, ...
        (target,) = self._expand(
            recurrence, _utc(2026, 1, 12, 0, 0), _utc(2026, 1, 13, 0, 0),
        )
        self._materialize(recurrence, target, actor=self.chris)
        reschedule_meeting_recurrence_occurrence(
            recurrence=recurrence, occurrence=target,
            scheduled_at=_utc(2026, 1, 10, 10, 0),
            actor=self.chris, title="Mondays",
        )
        self.login(self.chris)
        row = self._row_for(self._get_overview().json(), recurrence)
        # The moved occurrence IS the next effective occurrence, at
        # its EFFECTIVE (moved) Meeting time — not its original slot.
        self.assertEqual(
            row["nextOccurrenceScheduledAt"], "2026-01-10T10:00:00Z",
        )

    def test_rescheduled_far_future_occurrence_does_not_block_virtual_sibling(
        self,
    ):
        recurrence = self._create_recurrence(
            title="Mondays", frequency="weekly", interval=1,
            weekdays=[0], start_date=date(2026, 1, 5),
            local_time=time(9, 30), participants=(self.chris,),
        )
        (target,) = self._expand(
            recurrence, _utc(2026, 1, 12, 0, 0), _utc(2026, 1, 13, 0, 0),
        )
        self._materialize(recurrence, target, actor=self.chris)
        reschedule_meeting_recurrence_occurrence(
            recurrence=recurrence, occurrence=target,
            scheduled_at=_utc(2026, 1, 25, 10, 0),
            actor=self.chris, title="Mondays",
        )
        self.login(self.chris)
        row = self._row_for(self._get_overview().json(), recurrence)
        # The Jan 12 occurrence moved to Jan 25 — the still-virtual
        # Jan 19 sibling is EARLIER and remains the next occurrence.
        self.assertEqual(
            row["nextOccurrenceScheduledAt"], "2026-01-19T08:30:00Z",
        )

    # ── 21-23. No arbitrary horizon; finite and future-start rules ─

    def test_occurrence_beyond_upcoming_window_is_still_next(self):
        recurrence = self._create_recurrence(
            title="Quarterly Kickoff", start_date=date(2026, 4, 15),
            local_time=time(9, 30),
        )
        self.login(self.alex)
        row = self._row_for(self._get_overview().json(), recurrence)
        # Apr 15 is ~100 days out — far beyond the Upcoming +42-day
        # window — and must still be reported as the next occurrence
        # (09:30 Berlin = 07:30Z in CEST).
        self.assertEqual(
            row["nextOccurrenceScheduledAt"], "2026-04-15T07:30:00Z",
        )
        self.assertEqual(row["status"], "active")

    def test_exhausted_finite_recurrence_is_ended(self):
        counted = self._create_recurrence(
            title="Counted Out", local_time=time(9, 0),
            end_mode="count", occurrence_count=2,
        )
        ended = self._create_recurrence(
            title="Date Ended", local_time=time(10, 0),
            end_mode="end_date", end_date=date(2026, 1, 5),
        )
        self.login(self.alex)
        response = self._get_overview()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        # Jan 5 + Jan 6 (counted) and Jan 5 (date ended) all lie
        # before NOW: both series are exhausted.
        for row in (self._row_for(data, counted), self._row_for(data, ended)):
            self.assertIsNone(row["nextOccurrenceScheduledAt"])
            self.assertEqual(row["status"], "ended")

    def test_future_start_recurrence_is_active_with_start_as_next(self):
        recurrence = self._create_recurrence(
            title="Later Start", start_date=date(2026, 2, 1),
            local_time=time(9, 30),
        )
        self.login(self.alex)
        row = self._row_for(self._get_overview().json(), recurrence)
        # The start date is the first actual occurrence.
        self.assertEqual(
            row["nextOccurrenceScheduledAt"], "2026-02-01T08:30:00Z",
        )
        self.assertEqual(row["status"], "active")

    # ── 24-26. Ordering ───────────────────────────────────────────

    def test_active_rows_ordered_by_next_occurrence_ascending(self):
        later = self._create_recurrence(
            title="Later", local_time=time(9, 30),
        )
        earlier = self._create_recurrence(
            title="Earlier", local_time=time(8, 0),
        )
        self.login(self.alex)
        response = self._get_overview()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        # Both daily series (Jan 5 start) have their next occurrence
        # on Jan 7: 07:00Z before 08:30Z.
        self.assertEqual(
            [row["id"] for row in response.json()],
            [earlier.pk, later.pk],
        )

    def test_ended_rows_follow_active_rows(self):
        active = self._create_recurrence(
            title="Still Running", local_time=time(9, 30),
        )
        ended = self._create_recurrence(
            title="One Off", local_time=time(10, 0),
            end_mode="count", occurrence_count=1,
        )
        self.login(self.alex)
        response = self._get_overview()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            [row["id"] for row in response.json()],
            [active.pk, ended.pk],
        )

    def test_deterministic_tie_ordering(self):
        tie_a = self._create_recurrence(
            title="Tie A", local_time=time(9, 30),
        )
        tie_b = self._create_recurrence(
            title="Tie B", local_time=time(9, 30),
        )
        self.login(self.alex)
        response = self._get_overview()
        # Identical next occurrence (Jan 7 08:30Z): the stable
        # recurrence id is the final tie-breaker, never the title.
        self.assertEqual(
            [row["id"] for row in response.json()],
            sorted([tie_a.pk, tie_b.pk]),
        )

        end_a = self._create_recurrence(
            title="End A", local_time=time(10, 0),
            end_mode="count", occurrence_count=1,
        )
        end_b = self._create_recurrence(
            title="End B", local_time=time(11, 0),
            end_mode="count", occurrence_count=1,
        )
        response = self._get_overview()
        data = response.json()
        ended_ids = [
            row["id"] for row in data if row["status"] == "ended"
        ]
        self.assertEqual(ended_ids, sorted([end_a.pk, end_b.pk]))
        # ...and the ended rows still follow the active rows.
        self.assertEqual(
            [row["id"] for row in data],
            sorted([tie_a.pk, tie_b.pk]) + sorted([end_a.pk, end_b.pk]),
        )

    # ── 27. Strictly read-only ────────────────────────────────────

    def test_read_causes_zero_writes(self):
        recurrence = self._create_recurrence(
            participants=(self.chris,),
        )
        (target,) = self._expand(
            recurrence, _utc(2026, 1, 7, 0, 0), _utc(2026, 1, 8, 0, 0),
        )
        materialize_meeting_recurrence_occurrence(
            recurrence=recurrence, occurrence=target,
            actor=self.alex, title="Standup",
        )
        self.login(self.chris)
        before = self._state_snapshot()
        response = self._get_overview()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.json()), 1)
        after = self._state_snapshot()
        self.assertEqual(before, after)

    # ── 30. Query-count regression ─────────────────────────────────

    def test_query_count_does_not_scale_with_generated_dates(self):
        # Three users, each with EXACTLY ONE relevant recurrence; the
        # only difference is where the rule-generated dates sit
        # relative to NOW:
        #   chris — next occurrence close (a handful of generated
        #           dates);
        #   laura — dense rule history (thousands of generated dates
        #           before NOW, all consumed by the expansion);
        #   maria — next occurrence far in the future (~3 months out,
        #           beyond the Upcoming +42-day window).
        self._create_recurrence(
            title="Close", participants=(self.chris,),
            local_time=time(9, 30),
        )
        self._create_recurrence(
            title="Dense", participants=(self.laura,),
            start_date=date(2020, 1, 1), local_time=time(9, 30),
        )
        self._create_recurrence(
            title="Far", participants=(self.maria,),
            start_date=date(2026, 4, 15), local_time=time(9, 30),
        )

        counts = {}
        for user in (self.chris, self.laura, self.maria):
            self.login(user)
            # Warm-up request: absorbs the one-time lazy UserSession
            # registry INSERT so the capture compares the same
            # steady state (that statement is unrelated to the read).
            self.client.get(self.PATH)
            with CaptureQueriesContext(connection) as ctx:
                response = self.client.get(self.PATH)
            self.assertEqual(response.status_code, status.HTTP_200_OK)
            self.assertEqual(len(response.json()), 1)
            counts[user.username] = len(ctx.captured_queries)

        # Moving the next occurrence farther into the future — or
        # deepening the generated rule history — must not add SQL
        # statements: a per-generated-date lookup would grow the
        # count here.
        self.assertEqual(counts["rec-chris"], counts["rec-laura"])
        self.assertEqual(counts["rec-chris"], counts["rec-maria"])
