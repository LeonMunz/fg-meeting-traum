"""API tests for the bounded personal recurring-occurrence feed.

``GET /api/meeting-recurrences/occurrences/?from=...&to=...`` returns
the current authenticated user's EFFECTIVE recurring occurrences
across every recurrence they are personally relevant to — the
recurrence equivalent of the canonical Meeting read-access invariant
(creator or explicit participant) — merged into one deterministic
chronological feed.

Authorization visibility (scope-level read access to ONE recurrence,
enforced by the per-recurrence read APIs) is a separate concept from
personal Meeting-feed relevance and never feeds this endpoint.
"""

from datetime import date, time, timezone as dt_timezone

from audit_history.models import AuditEvent
from django.contrib.auth import get_user_model
from django.db import connection
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
    reschedule_meeting_recurrence_occurrence,
)
from .tests_recurrence import MeetingRecurrenceBase, _utc

User = get_user_model()
UTC = dt_timezone.utc


class MeetingRecurrencePersonalFeedApiTest(MeetingRecurrenceBase):
    """Bounded personal recurring-occurrence feed for one user."""

    PATH = "/api/meeting-recurrences/occurrences/"

    def setUp(self):
        super().setUp()
        self.client = APIClient()
        # Daily 09:30 Berlin (08:30 UTC), first occurrence 2026-01-05
        # (a Monday), no end; created by alex (group admin / project
        # owner), no intended participants.
        self.recurrence = self._create_recurrence()

    def login(self, user):
        self.client.logout()
        self.client.force_login(user)

    def _get_feed(self, start=None, end=None, **extra):
        params = {
            "from": (start or _utc(2026, 1, 5, 0, 0)).isoformat(),
            "to": (end or _utc(2026, 1, 12, 0, 0)).isoformat(),
        }
        params.update(extra)
        return self.client.get(self.PATH, params)

    def _utc_iso(self, instant):
        return instant.astimezone(UTC).isoformat().replace("+00:00", "Z")

    def _occurrences_for(self, data, occurrence_id):
        return [
            item for item in data
            if item["occurrenceId"] == str(occurrence_id)
        ]

    # ── 1. Authentication ────────────────────────────────────────

    def test_authentication_is_required(self):
        response = self._get_feed()
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)

    # ── 2-5. Window contract (same conventions as the read API) ──

    def test_missing_from_is_rejected(self):
        self.login(self.alex)
        response = self.client.get(
            self.PATH,
            {"to": _utc(2026, 1, 6, 0, 0).isoformat()},
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("from", response.json())

    def test_missing_to_is_rejected(self):
        self.login(self.alex)
        response = self.client.get(
            self.PATH,
            {"from": _utc(2026, 1, 5, 0, 0).isoformat()},
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("to", response.json())

    def test_naive_datetime_is_rejected(self):
        self.login(self.alex)
        response = self.client.get(
            self.PATH,
            {
                "from": "2026-01-05T08:30:00",
                "to": "2026-01-06T08:30:00",
            },
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        errors = response.json()
        self.assertIn("from", errors)
        self.assertIn("to", errors)

    def test_from_equal_to_is_rejected(self):
        self.login(self.alex)
        response = self.client.get(
            self.PATH,
            {
                "from": _utc(2026, 1, 5, 0, 0).isoformat(),
                "to": _utc(2026, 1, 5, 0, 0).isoformat(),
            },
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("error", response.json())

    def test_from_after_to_is_rejected(self):
        self.login(self.alex)
        response = self.client.get(
            self.PATH,
            {
                "from": _utc(2026, 1, 6, 0, 0).isoformat(),
                "to": _utc(2026, 1, 5, 0, 0).isoformat(),
            },
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("error", response.json())

    # ── 6. Creator relevance ─────────────────────────────────────

    def test_creator_recurrence_is_included_with_context(self):
        self.login(self.alex)
        response = self._get_feed()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        self.assertEqual(len(data), 7)  # Jan 5 .. Jan 11
        for item in data:
            self.assertEqual(item["recurrenceId"], self.recurrence.pk)
            self.assertEqual(item["researchGroupId"], self.group.pk)
            self.assertEqual(item["meetingSeriesId"], self.recurrence.series_id)
            self.assertIsNone(item["projectId"])
            self.assertEqual(item["title"], self.recurrence.title)
            self.assertFalse(item["materialized"])
            self.assertIsNone(item["meetingId"])

    # ── 7. Participant relevance (insider and outsider) ─────────

    def test_participant_recurrence_is_included(self):
        recurrence = self._create_recurrence(
            title="Team Sync",
            participants=(self.chris,),
        )
        self.login(self.chris)
        response = self._get_feed()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        self.assertEqual(len(data), 7)
        self.assertEqual(
            [item["recurrenceId"] for item in data],
            [recurrence.pk] * 7,
        )

    def test_outsider_participant_recurrence_is_included(self):
        # The personal relationship — not scope-level visibility — is
        # the feed input: an outsider listed as an intended participant
        # sees the series exactly like a Meeting participant sees a
        # concrete Meeting (the canonical read-access invariant).
        recurrence = self._create_recurrence(
            title="External Sync",
            participants=(self.maria,),
        )
        self.login(self.maria)
        response = self._get_feed()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        self.assertEqual(
            [item["recurrenceId"] for item in data],
            [recurrence.pk] * 7,
        )

    # ── 8. Duplicate creator+participant relationship ────────────

    def test_creator_and_participant_does_not_duplicate_occurrence(self):
        self._create_recurrence(
            title="Double List",
            participants=(self.alex,),
        )
        self.login(self.alex)
        response = self._get_feed()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        # Jan 5..11 of the default series (7) + Jan 5..11 of the
        # double-list series (7) — exactly one row per occurrence.
        self.assertEqual(len(response.json()), 14)

    # ── 9-11. Non-relevant users are excluded, nothing leaks ────

    def test_unrelated_group_member_feed_is_empty(self):
        # chris is a Research Group member but neither the creator nor
        # an intended participant: group membership alone must not put
        # the series into the personal feed.
        self.login(self.chris)
        response = self._get_feed()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.json(), [])

    def test_unrelated_project_member_and_viewer_feed_is_empty(self):
        recurrence = self._create_recurrence(
            title="Project Sync",
            scope="project",
            project=self.project,
        )
        # Project membership (member) and Project visibility (viewer)
        # are authorization visibility, not personal relevance.
        for user in (self.chris, self.laura):
            with self.subTest(user=user.username):
                self.login(user)
                response = self._get_feed()
                self.assertEqual(response.status_code, status.HTTP_200_OK)
                self.assertEqual(response.json(), [])

    def test_outsider_feed_excludes_other_recurring_series(self):
        self.login(self.maria)
        response = self._get_feed()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        # No item content or count leaks the unrelated series.
        self.assertEqual(response.json(), [])

    # ── 12-14. Recurrence-rule expansion via the feed ────────────

    def test_daily_expansion_matches_domain(self):
        self.login(self.alex)
        start, end = _utc(2026, 1, 5, 0, 0), _utc(2026, 1, 12, 0, 0)
        response = self._get_feed(start=start, end=end)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        expected = self._expand(self.recurrence, start, end)
        data = response.json()
        self.assertEqual(len(data), len(expected))
        for item, occurrence in zip(data, expected):
            self.assertEqual(
                item["occurrenceId"], str(occurrence.occurrence_id),
            )
            self.assertEqual(
                item["originalScheduledAt"],
                self._utc_iso(occurrence.original_start),
            )
            self.assertEqual(
                item["scheduledAt"],
                self._utc_iso(occurrence.original_start),
            )

    def test_weekly_expansion_selects_configured_weekdays(self):
        # chris is ONLY a participant of this series (he is the creator
        # of no fixture recurrence), so his feed carries exactly this
        # series — the merge test below covers multi-series users.
        recurrence = self._create_recurrence(
            title="Weekly",
            frequency="weekly",
            interval=1,
            weekdays=[0, 2],  # Monday + Wednesday
            start_date=date(2026, 1, 5),
            local_time=time(10, 0),
            participants=(self.chris,),
        )
        self.login(self.chris)
        response = self._get_feed(
            start=_utc(2026, 1, 5, 0, 0), end=_utc(2026, 1, 16, 0, 0),
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        # Mon Jan 5, Wed Jan 7, Mon Jan 12, Wed Jan 14 (10:00 local).
        self.assertEqual(
            [item["originalScheduledAt"] for item in data],
            [
                "2026-01-05T09:00:00Z",
                "2026-01-07T09:00:00Z",
                "2026-01-12T09:00:00Z",
                "2026-01-14T09:00:00Z",
            ],
        )
        self.assertTrue(all(
            item["recurrenceId"] == recurrence.pk for item in data
        ))

    def test_monthly_expansion_skips_invalid_dates(self):
        # maria is an outsider and ONLY a participant of this series,
        # so her feed carries exactly this series.
        recurrence = self._create_recurrence(
            title="Monthly",
            frequency="monthly",
            interval=1,
            start_date=date(2026, 1, 31),
            local_time=time(9, 30),
            participants=(self.maria,),
        )
        self.login(self.maria)
        response = self._get_feed(
            start=_utc(2026, 1, 1, 0, 0), end=_utc(2026, 6, 2, 0, 0),
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        # Jan 31, then February (28 days) and April (30 days) are
        # SKIPPED, never shifted to the month end. The wall-clock
        # 09:30 is preserved across the DST transition (CEST from
        # Mar 29): 08:30Z in winter, 07:30Z in summer.
        self.assertEqual(
            [item["originalScheduledAt"] for item in data],
            [
                "2026-01-31T08:30:00Z",
                "2026-03-31T07:30:00Z",
                "2026-05-31T07:30:00Z",
            ],
        )
        self.assertTrue(all(
            item["recurrenceId"] == recurrence.pk for item in data
        ))

    # ── 15/16. Exclusions and count semantics ────────────────────

    def test_excluded_occurrence_is_omitted_from_feed(self):
        (target,) = self._expand(
            self.recurrence, _utc(2026, 1, 8, 0, 0), _utc(2026, 1, 9, 0, 0),
        )
        exclude_meeting_recurrence_occurrence(
            recurrence=self.recurrence,
            occurrence=target,
            actor=self.alex,
        )
        self.login(self.alex)
        response = self._get_feed()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        self.assertEqual(len(data), 6)  # 7 minus the excluded Jan 8
        self.assertEqual(
            self._occurrences_for(data, target.occurrence_id), [],
        )

    def test_count_semantics_remain_no_replacement(self):
        # chris is ONLY a participant of the counted series, so his
        # feed carries exactly that series.
        recurrence = self._create_recurrence(
            title="Counted",
            end_mode="count",
            occurrence_count=3,  # Jan 5, 6, 7 INCLUDING the first
            participants=(self.chris,),
        )
        (target,) = self._expand(
            recurrence, _utc(2026, 1, 6, 0, 0), _utc(2026, 1, 7, 0, 0),
        )
        exclude_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=target,
            actor=self.alex,
        )
        self.login(self.chris)
        response = self._get_feed(
            start=_utc(2026, 1, 1, 0, 0), end=_utc(2026, 2, 1, 0, 0),
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        # The exclusion consumes nothing and generates NO replacement:
        # a COUNT-limited series does not grow.
        self.assertEqual(
            [item["originalScheduledAt"] for item in data],
            ["2026-01-05T08:30:00Z", "2026-01-07T08:30:00Z"],
        )

    # ── 17-19. Materialized vs virtual representation ────────────

    def test_virtual_occurrence_reports_null_meeting_id(self):
        self.login(self.alex)
        (item,) = self._get_feed(
            start=_utc(2026, 1, 5, 0, 0), end=_utc(2026, 1, 6, 0, 0),
        ).json()
        self.assertFalse(item["materialized"])
        self.assertIsNone(item["meetingId"])
        self.assertEqual(Meeting.objects.count(), 0)

    def test_materialized_occurrence_appears_exactly_once_with_meeting(self):
        (occurrence,) = self._expand(
            self.recurrence, _utc(2026, 1, 6, 0, 0), _utc(2026, 1, 7, 0, 0),
        )
        meeting = self._materialize(self.recurrence, occurrence)
        self.login(self.alex)
        data = self._get_feed().json()
        items = self._occurrences_for(data, occurrence.occurrence_id)
        # Exactly ONE item for the occurrence: never a virtual
        # occurrence plus a duplicate concrete item.
        self.assertEqual(len(items), 1)
        item = items[0]
        self.assertTrue(item["materialized"])
        self.assertEqual(item["meetingId"], meeting.pk)
        self.assertEqual(
            item["originalScheduledAt"],
            self._utc_iso(occurrence.original_start),
        )
        # The materialized Meeting's own (possibly overridden) title
        # is the effective feed title.
        self.assertEqual(item["title"], meeting.title)
        self.assertEqual(
            item["scheduledAt"],
            self._utc_iso(meeting.scheduled_at),
        )

    # ── 20. Cancellation matches the canonical occurrence GET ───

    def test_cancelled_materialized_occurrence_is_absent_from_feed(self):
        (occurrence,) = self._expand(
            self.recurrence, _utc(2026, 1, 6, 0, 0), _utc(2026, 1, 7, 0, 0),
        )
        meeting = self._materialize(self.recurrence, occurrence)
        cancel_meeting_recurrence_occurrence(
            meeting=meeting, actor=self.alex,
        )
        self.assertEqual(meeting.status, "cancelled")
        self.login(self.alex)

        feed_data = self._get_feed().json()
        self.assertEqual(
            self._occurrences_for(feed_data, occurrence.occurrence_id),
            [],
        )
        self.assertEqual(len(feed_data), 6)

        # The canonical per-recurrence occurrence GET reports the SAME
        # effective behavior (the cancelled original is absent, no
        # replacement, siblings unchanged).
        per_recurrence = self.client.get(
            f"/api/meeting-recurrences/{self.recurrence.pk}/occurrences/",
            {
                "from": _utc(2026, 1, 5, 0, 0).isoformat(),
                "to": _utc(2026, 1, 12, 0, 0).isoformat(),
            },
        )
        self.assertEqual(per_recurrence.status_code, status.HTTP_200_OK)
        self.assertEqual(
            sorted(item["occurrenceId"] for item in per_recurrence.json()),
            sorted(item["occurrenceId"] for item in feed_data),
        )

    # ── 21. Reschedule: stable identity, actual scheduled time ──

    def test_rescheduled_occurrence_keeps_identity_and_actual_time(self):
        self.login(self.alex)
        (occurrence,) = self._expand(
            self.recurrence, _utc(2026, 1, 6, 0, 0), _utc(2026, 1, 7, 0, 0),
        )
        meeting = self._materialize(self.recurrence, occurrence)
        virtual = self._get_feed(
            start=_utc(2026, 1, 6, 0, 0), end=_utc(2026, 1, 7, 0, 0),
        ).json()
        (before,) = self._occurrences_for(
            virtual, occurrence.occurrence_id,
        )
        self.assertEqual(
            before["occurrenceId"], str(occurrence.occurrence_id),
        )

        new_time = _utc(2026, 1, 15, 14, 0)
        reschedule_meeting_recurrence_occurrence(
            recurrence=self.recurrence,
            occurrence=occurrence,
            scheduled_at=new_time,
            actor=self.alex,
            title="Moved",
        )
        meeting.refresh_from_db()
        self.assertEqual(meeting.scheduled_at, new_time)

        data = self._get_feed(
            start=_utc(2026, 1, 5, 0, 0), end=_utc(2026, 1, 16, 0, 0),
        ).json()
        (item,) = self._occurrences_for(data, occurrence.occurrence_id)
        # Stable identity + immutable original start are unchanged.
        self.assertEqual(
            item["occurrenceId"], before["occurrenceId"],
        )
        self.assertEqual(
            item["originalScheduledAt"],
            before["originalScheduledAt"],
        )
        self.assertTrue(item["materialized"])
        self.assertEqual(item["meetingId"], meeting.pk)
        # The ACTUAL scheduled time is exposed — and it drives the
        # chronological position (the moved occurrence is now last in
        # the window).
        self.assertEqual(item["scheduledAt"], self._utc_iso(new_time))
        self.assertEqual(data[-1]["occurrenceId"], item["occurrenceId"])

    # ── 22/23. Multi-series merge and deterministic ordering ────

    def test_multiple_recurrences_merge_into_one_chronological_feed(self):
        weekly = self._create_recurrence(
            title="Weekly C",
            frequency="weekly",
            interval=1,
            weekdays=[2],  # Wednesday
            start_date=date(2026, 1, 7),
            local_time=time(10, 0),
        )
        late_daily = self._create_recurrence(
            title="Daily C",
            frequency="daily",
            interval=1,
            start_date=date(2026, 1, 8),
            local_time=time(8, 0),
        )
        self.login(self.alex)
        start, end = _utc(2026, 1, 5, 0, 0), _utc(2026, 1, 13, 0, 0)
        response = self._get_feed(start=start, end=end)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()

        expected = []
        for recurrence, local_times in (
            (self.recurrence, ["08:30:00Z"]),
            (weekly, ["09:00:00Z"]),
            (late_daily, ["07:00:00Z"]),
        ):
            for occurrence in self._expand(recurrence, start, end):
                expected.append(
                    (recurrence.pk, self._utc_iso(occurrence.original_start)),
                )
        expected.sort(key=lambda pair: pair[1])
        self.assertEqual(
            [(item["recurrenceId"], item["originalScheduledAt"])
             for item in data],
            expected,
        )
        # The feed is one flat chronological list — interleaved series,
        # never grouped by series (A's Jan 7 precedes B's Jan 7, which
        # precedes C's Jan 8).
        self.assertEqual(len(data), 14)
        self.assertEqual(data[0]["recurrenceId"], self.recurrence.pk)
        self.assertEqual(data[1]["recurrenceId"], self.recurrence.pk)
        self.assertEqual(data[2]["recurrenceId"], self.recurrence.pk)
        self.assertEqual(data[3]["recurrenceId"], weekly.pk)
        self.assertEqual(data[4]["recurrenceId"], late_daily.pk)

    def test_identical_timestamp_tie_breaker_is_deterministic(self):
        second = self._create_recurrence(title="Twin Series")
        self.assertNotEqual(second.pk, self.recurrence.pk)
        self.login(self.alex)
        start, end = _utc(2026, 1, 5, 0, 0), _utc(2026, 1, 8, 0, 0)
        first = self._get_feed(start=start, end=end).json()
        second_response = self._get_feed(start=start, end=end).json()
        # Deterministic across requests.
        self.assertEqual(first, second_response)
        # Chronological by scheduledAt, with the stable occurrence
        # identity (UUID ascending) as the tie-breaker for identical
        # timestamps (uniform UTC ISO-8601 strings compare
        # chronologically).
        keys = [
            (item["scheduledAt"], item["occurrenceId"])
            for item in first
        ]
        self.assertEqual(keys, sorted(keys))
        # Every day of the window carries exactly one tied pair (one
        # item per series), in that tie order.
        self.assertEqual(len(first), 6)
        by_day = {}
        for item in first:
            by_day.setdefault(
                item["originalScheduledAt"], [],
            ).append(item["recurrenceId"])
        self.assertEqual(len(by_day), 3)
        for recurrence_ids in by_day.values():
            self.assertEqual(
                set(recurrence_ids),
                {self.recurrence.pk, second.pk},
            )

    # ── 24. Range boundaries (inclusive) ─────────────────────────

    def test_range_boundaries_are_inclusive(self):
        self.login(self.alex)
        # Daily 09:30 Berlin = 08:30 UTC: the window edges sit exactly
        # ON the Jan 7 and Jan 9 occurrence instants.
        response = self._get_feed(
            start=_utc(2026, 1, 7, 8, 30), end=_utc(2026, 1, 9, 8, 30),
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        self.assertEqual(
            [item["originalScheduledAt"] for item in data],
            [
                "2026-01-07T08:30:00Z",
                "2026-01-08T08:30:00Z",
                "2026-01-09T08:30:00Z",
            ],
        )

    # ── 25/26. Strictly read-only ────────────────────────────────

    def test_read_materializes_nothing_and_mutates_nothing(self):
        self.login(self.alex)
        before = {
            "meetings": Meeting.objects.count(),
            "sections": MeetingSection.objects.count(),
            "meeting_participants": MeetingParticipant.objects.count(),
            "recurrence_participants":
                MeetingRecurrenceParticipant.objects.count(),
            "exclusions": MeetingRecurrenceExclusion.objects.count(),
            "audit_events": AuditEvent.objects.count(),
            "participant_pairs": set(
                MeetingRecurrenceParticipant.objects.values_list(
                    "recurrence_id", "user_id",
                )
            ),
        }
        response = self._get_feed()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.json()), 7)
        after = {
            "meetings": Meeting.objects.count(),
            "sections": MeetingSection.objects.count(),
            "meeting_participants": MeetingParticipant.objects.count(),
            "recurrence_participants":
                MeetingRecurrenceParticipant.objects.count(),
            "exclusions": MeetingRecurrenceExclusion.objects.count(),
            "audit_events": AuditEvent.objects.count(),
            "participant_pairs": set(
                MeetingRecurrenceParticipant.objects.values_list(
                    "recurrence_id", "user_id",
                )
            ),
        }
        self.assertEqual(before, after)

    # ── 28. Bounded query behavior (no per-occurrence N+1) ───────

    def test_query_count_does_not_scale_with_window(self):
        self.login(self.alex)
        # Materialize one occurrence so the materialization query has
        # real work in both windows.
        (target,) = self._expand(
            self.recurrence, _utc(2026, 1, 5, 0, 0), _utc(2026, 1, 6, 0, 0),
        )
        self._materialize(self.recurrence, target)

        small_params = {  # 3 occurrences (Jan 5..7 at 08:30Z)
            "from": _utc(2026, 1, 5, 0, 0).isoformat(),
            "to": _utc(2026, 1, 8, 0, 0).isoformat(),
        }
        large_params = {  # 11 occurrences (Jan 5..15 at 08:30Z)
            "from": _utc(2026, 1, 5, 0, 0).isoformat(),
            "to": _utc(2026, 1, 16, 0, 0).isoformat(),
        }

        # Warm-up request: absorbs the one-time lazy UserSession
        # registry INSERT so both captures compare the same steady
        # state (that statement is unrelated to occurrence expansion).
        self.client.get(self.PATH, small_params)

        with CaptureQueriesContext(connection) as small_ctx:
            small_response = self.client.get(self.PATH, small_params)
        with CaptureQueriesContext(connection) as large_ctx:
            large_response = self.client.get(self.PATH, large_params)

        self.assertEqual(small_response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(small_response.json()), 3)
        self.assertEqual(large_response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(large_response.json()), 11)
        # The relevance query, the ONE batched exclusion query, and
        # the ONE batched materialization query are all bounded by
        # the recurrence set — a per-occurrence lookup would grow
        # the query count with the window.
        self.assertEqual(
            len(small_ctx.captured_queries),
            len(large_ctx.captured_queries),
        )

    def test_query_count_does_not_scale_with_relevant_recurrence_count(self):
        self.login(self.alex)
        # Give the batched materialization and exclusion queries real
        # work in BOTH scenarios: one materialized occurrence and one
        # excluded occurrence of the fixture recurrence.
        (target,) = self._expand(
            self.recurrence, _utc(2026, 1, 5, 0, 0), _utc(2026, 1, 6, 0, 0),
        )
        self._materialize(self.recurrence, target)
        (excluded,) = self._expand(
            self.recurrence, _utc(2026, 1, 8, 0, 0), _utc(2026, 1, 9, 0, 0),
        )
        exclude_meeting_recurrence_occurrence(
            recurrence=self.recurrence,
            occurrence=excluded,
            actor=self.alex,
        )

        params = {
            "from": _utc(2026, 1, 5, 0, 0).isoformat(),
            "to": _utc(2026, 1, 12, 0, 0).isoformat(),
        }

        # Warm-up request: absorbs the one-time lazy UserSession
        # registry INSERT so both captures compare the same steady
        # state (that statement is unrelated to occurrence expansion).
        self.client.get(self.PATH, params)

        with CaptureQueriesContext(connection) as single_ctx:
            single_response = self.client.get(self.PATH, params)

        # Four MORE relevant recurrences for the same user (creator
        # relevance), all inside the window; two of them carry one
        # excluded occurrence each so the batched exclusion query
        # fetches rows for several recurrences.
        extra = []
        for index, extra_time in enumerate(
            (time(11, 0), time(11, 5), time(11, 10), time(11, 15)),
        ):
            recurrence = self._create_recurrence(
                title=f"Extra Series {index}",
                start_date=date(2026, 1, 5),
                local_time=extra_time,
            )
            extra.append(recurrence)
        for recurrence in extra[:2]:
            (to_exclude,) = self._expand(
                recurrence, _utc(2026, 1, 6, 0, 0), _utc(2026, 1, 7, 0, 0),
            )
            exclude_meeting_recurrence_occurrence(
                recurrence=recurrence,
                occurrence=to_exclude,
                actor=self.alex,
            )

        with CaptureQueriesContext(connection) as multi_ctx:
            multi_response = self.client.get(self.PATH, params)

        self.assertEqual(single_response.status_code, status.HTTP_200_OK)
        # 7 fixture occurrences minus the 1 excluded = 6.
        self.assertEqual(len(single_response.json()), 6)
        self.assertEqual(multi_response.status_code, status.HTTP_200_OK)
        # 6 + 4 recurrences x 7 occurrences minus 2 excluded = 32.
        self.assertEqual(len(multi_response.json()), 6 + 28 - 2)
        # The relevance query, the ONE batched exclusion query, and
        # the ONE batched materialization query do NOT grow with the
        # number of relevant recurrences — a per-recurrence exclusion
        # query would add 4 more statements here.
        self.assertEqual(
            len(single_ctx.captured_queries),
            len(multi_ctx.captured_queries),
        )
