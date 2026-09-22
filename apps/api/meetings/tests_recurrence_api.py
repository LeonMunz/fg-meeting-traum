"""API tests for the bounded MeetingRecurrence occurrence read endpoint.

``GET /api/meeting-recurrences/{recurrence_id}/occurrences/?from=...&to=...``
is read-only: it delegates occurrence calculation to the domain
expansion operation, resolves materialized occurrences through the
persisted ``Meeting.recurrence`` / ``original_scheduled_at``
relationship, and never mutates persistence.
"""

from datetime import timedelta, timezone as dt_timezone

from audit_history.models import AuditEvent
from django.contrib.auth import get_user_model
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from rest_framework import status
from rest_framework.test import APIClient

from .models import (
    Meeting,
    MeetingParticipant,
    MeetingRecurrence,
    MeetingRecurrenceExclusion,
    MeetingSection,
)
from .services import (
    exclude_meeting_recurrence_occurrence,
    materialize_meeting_recurrence_occurrence,
    update_meeting,
)
from .tests_recurrence import MeetingRecurrenceBase, _utc

User = get_user_model()
UTC = dt_timezone.utc


class MeetingRecurrenceOccurrenceApiTest(MeetingRecurrenceBase):
    """Bounded occurrence read API for one MeetingRecurrence."""

    def setUp(self):
        super().setUp()
        self.client = APIClient()
        # Daily 09:30 Berlin, first occurrence 2026-01-05, no end.
        self.recurrence = self._create_recurrence()

    def login(self, user):
        self.client.logout()
        self.client.force_login(user)

    def _path(self, recurrence=None):
        recurrence = recurrence if recurrence is not None else self.recurrence
        return f"/api/meeting-recurrences/{recurrence.pk}/occurrences/"

    def _get_occurrences(self, recurrence=None, start=None, end=None):
        # The data dict lets the test client URL-encode the aware
        # ISO-8601 values (a raw '+' would decode to a space).
        return self.client.get(
            self._path(recurrence),
            {
                "from": (start or _utc(2026, 1, 5, 0, 0)).isoformat(),
                "to": (end or _utc(2026, 1, 12, 0, 0)).isoformat(),
            },
        )

    def _materialize(self, recurrence, occurrence, *, actor=None):
        return materialize_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=occurrence,
            actor=actor if actor is not None else self.alex,
            title="Materialized",
        )

    # ── 1. Authorized actor reads a bounded window ───────────────

    def test_authentication_is_required(self):
        response = self._get_occurrences(
            start=_utc(2026, 1, 5, 0, 0), end=_utc(2026, 1, 6, 0, 0),
        )
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_group_member_can_read_bounded_window(self):
        self.login(self.chris)
        response = self._get_occurrences(
            start=_utc(2026, 1, 5, 0, 0), end=_utc(2026, 1, 12, 0, 0),
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        self.assertEqual(len(data), 7)  # Jan 5 .. Jan 11

    def test_occurrences_match_domain_expansion(self):
        self.login(self.chris)
        start, end = _utc(2026, 1, 5, 0, 0), _utc(2026, 1, 12, 0, 0)
        response = self._get_occurrences(start=start, end=end)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()

        expected = self._expand(self.recurrence, start, end)
        self.assertEqual(len(data), len(expected))
        for item, occurrence in zip(data, expected):
            self.assertEqual(
                item["occurrenceId"], str(occurrence.occurrence_id),
            )
            self.assertEqual(
                item["originalScheduledAt"],
                occurrence.original_start.astimezone(UTC)
                .isoformat()
                .replace("+00:00", "Z"),
            )
            self.assertEqual(
                item["originalLocal"], occurrence.original_local.isoformat(),
            )
            self.assertEqual(item["timezone"], "Europe/Berlin")
            self.assertIn("materialized", item)
            self.assertIn("meetingId", item)

    # ── 3/4/5. Input validation ──────────────────────────────────

    def test_missing_from_is_rejected(self):
        self.login(self.chris)
        response = self.client.get(
            self._path(),
            {"to": _utc(2026, 1, 6, 0, 0).isoformat()},
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("from", response.json())

    def test_missing_to_is_rejected(self):
        self.login(self.chris)
        response = self.client.get(
            self._path(),
            {"from": _utc(2026, 1, 5, 0, 0).isoformat()},
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("to", response.json())

    def test_invalid_datetime_syntax_is_rejected(self):
        self.login(self.chris)
        response = self.client.get(
            self._path(),
            {"from": "not-a-datetime", "to": "also-not-a-datetime"},
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        errors = response.json()
        self.assertIn("from", errors)
        self.assertIn("to", errors)

    def test_naive_datetime_is_rejected(self):
        self.login(self.chris)
        response = self.client.get(
            self._path(),
            {"from": "2026-01-05T08:30:00", "to": "2026-01-06T08:30:00"},
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        errors = response.json()
        self.assertIn("from", errors)
        self.assertIn("to", errors)

    def test_from_equal_to_is_rejected(self):
        self.login(self.chris)
        response = self.client.get(
            self._path(),
            {
                "from": _utc(2026, 1, 5, 0, 0).isoformat(),
                "to": _utc(2026, 1, 5, 0, 0).isoformat(),
            },
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("error", response.json())

    def test_from_after_to_is_rejected(self):
        self.login(self.chris)
        response = self.client.get(
            self._path(),
            {
                "from": _utc(2026, 1, 6, 0, 0).isoformat(),
                "to": _utc(2026, 1, 5, 0, 0).isoformat(),
            },
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("error", response.json())

    # ── 6. Window membership ─────────────────────────────────────

    def test_occurrences_outside_range_are_excluded(self):
        self.login(self.chris)
        response = self._get_occurrences(
            start=_utc(2026, 1, 7, 0, 0), end=_utc(2026, 1, 8, 23, 59),
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        # 09:30 Berlin = 08:30 UTC: exactly Jan 7 and Jan 8 fall in.
        self.assertEqual(
            [item["originalLocal"] for item in data],
            ["2026-01-07T09:30:00", "2026-01-08T09:30:00"],
        )

    # ── 7/8. Virtual and materialized representation ─────────────

    def test_virtual_occurrence_reports_not_materialized(self):
        self.login(self.chris)
        response = self._get_occurrences(
            start=_utc(2026, 1, 5, 0, 0), end=_utc(2026, 1, 6, 0, 0),
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        (item,) = response.json()
        self.assertFalse(item["materialized"])
        self.assertIsNone(item["meetingId"])
        self.assertEqual(Meeting.objects.count(), 0)

    def test_materialized_occurrence_reports_identity_state_and_meeting(self):
        self.login(self.chris)
        (occurrence,) = self._expand(
            self.recurrence, _utc(2026, 1, 5, 0, 0), _utc(2026, 1, 6, 0, 0),
        )
        before = self._get_occurrences(
            start=_utc(2026, 1, 5, 0, 0), end=_utc(2026, 1, 12, 0, 0),
        ).json()
        virtual = next(
            item for item in before
            if item["occurrenceId"] == str(occurrence.occurrence_id)
        )
        self.assertFalse(virtual["materialized"])

        meeting = self._materialize(self.recurrence, occurrence)

        after = self._get_occurrences(
            start=_utc(2026, 1, 5, 0, 0), end=_utc(2026, 1, 12, 0, 0),
        ).json()
        materialized = next(
            item for item in after
            if item["occurrenceId"] == str(occurrence.occurrence_id)
        )
        # Same stable identity, now materialized with the concrete id.
        self.assertEqual(
            materialized["occurrenceId"], virtual["occurrenceId"],
        )
        self.assertTrue(materialized["materialized"])
        self.assertEqual(materialized["meetingId"], meeting.pk)
        self.assertEqual(
            meeting.original_scheduled_at, occurrence.original_start,
        )

    # ── 9. Materialization does not disturb other occurrences ────

    def test_materialization_keeps_other_occurrences_stable(self):
        self.login(self.chris)
        start, end = _utc(2026, 1, 5, 0, 0), _utc(2026, 1, 12, 0, 0)
        before = self._get_occurrences(start=start, end=end).json()

        occurrences = self._expand(self.recurrence, start, end)
        (target,) = [
            occurrence for occurrence in occurrences
            if occurrence.original_local.isoformat() == "2026-01-06T09:30:00"
        ]
        self._materialize(self.recurrence, target)

        after = self._get_occurrences(start=start, end=end).json()
        self.assertEqual(len(after), len(before))
        for prior, current in zip(before, after):
            self.assertEqual(prior["occurrenceId"], current["occurrenceId"])
            self.assertEqual(
                prior["originalScheduledAt"],
                current["originalScheduledAt"],
            )
            if prior["occurrenceId"] != str(target.occurrence_id):
                self.assertEqual(prior, current)

    # ── 10. Editable scheduled_at does not break the mapping ─────

    def test_rescheduled_meeting_still_maps_to_same_occurrence(self):
        self.login(self.chris)
        (occurrence,) = self._expand(
            self.recurrence, _utc(2026, 1, 5, 0, 0), _utc(2026, 1, 6, 0, 0),
        )
        meeting = self._materialize(self.recurrence, occurrence)
        # Move the Meeting's OWN editable planned time; the immutable
        # original occurrence identity must keep the mapping.
        update_meeting(
            meeting=meeting,
            actor=self.alex,
            scheduled_at=occurrence.original_start + timedelta(days=3),
        )

        response = self._get_occurrences(
            start=_utc(2026, 1, 5, 0, 0), end=_utc(2026, 1, 12, 0, 0),
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        item = next(
            item for item in response.json()
            if item["occurrenceId"] == str(occurrence.occurrence_id)
        )
        self.assertTrue(item["materialized"])
        self.assertEqual(item["meetingId"], meeting.pk)

    # ── 11. GET is strictly read-only ────────────────────────────

    def test_get_creates_no_persistence_rows(self):
        self.login(self.chris)
        before = {
            "meetings": Meeting.objects.count(),
            "recurrences": MeetingRecurrence.objects.count(),
            "audit_events": AuditEvent.objects.count(),
            "participants": MeetingParticipant.objects.count(),
            "sections": MeetingSection.objects.count(),
        }
        response = self._get_occurrences(
            start=_utc(2026, 1, 5, 0, 0), end=_utc(2026, 1, 12, 0, 0),
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.json()), 7)
        after = {
            "meetings": Meeting.objects.count(),
            "recurrences": MeetingRecurrence.objects.count(),
            "audit_events": AuditEvent.objects.count(),
            "participants": MeetingParticipant.objects.count(),
            "sections": MeetingSection.objects.count(),
        }
        self.assertEqual(before, after)

    # ── 12/13/14. Authorization ──────────────────────────────────

    def test_outsider_cannot_query_group_recurrence(self):
        self.login(self.maria)
        response = self._get_occurrences(
            start=_utc(2026, 1, 5, 0, 0), end=_utc(2026, 1, 6, 0, 0),
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_unknown_recurrence_returns_404(self):
        self.login(self.chris)
        response = self._get_occurrences(
            recurrence=MeetingRecurrence(pk=999999),
            start=_utc(2026, 1, 5, 0, 0), end=_utc(2026, 1, 6, 0, 0),
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def _project_recurrence(self):
        return self._create_recurrence(
            scope="project",
            project=self.project,
        )

    def test_project_member_can_query_project_recurrence(self):
        recurrence = self._project_recurrence()
        self.login(self.chris)
        response = self._get_occurrences(
            recurrence=recurrence,
            start=_utc(2026, 1, 5, 0, 0), end=_utc(2026, 1, 12, 0, 0),
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.json()), 7)

    def test_project_viewer_can_read_project_recurrence(self):
        # Mirrors the documented scope-level read contract (a Project
        # viewer can READ scope-level Meeting resources).
        recurrence = self._project_recurrence()
        self.login(self.laura)
        response = self._get_occurrences(
            recurrence=recurrence,
            start=_utc(2026, 1, 5, 0, 0), end=_utc(2026, 1, 6, 0, 0),
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_group_member_without_project_access_cannot_query(self):
        # maria is a group member but not a member of the Project.
        recurrence = self._project_recurrence()
        self.login(self.maria)
        response = self._get_occurrences(
            recurrence=recurrence,
            start=_utc(2026, 1, 5, 0, 0), end=_utc(2026, 1, 6, 0, 0),
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_recurrence_id_alone_does_not_bypass_scope(self):
        # A valid id held by a fully unauthorized account still 404s.
        recurrence = self._project_recurrence()
        outsider = User.objects.create_user(
            username="rec-api-outsider", password="Pass1!",
        )
        self.login(outsider)
        response = self._get_occurrences(
            recurrence=recurrence,
            start=_utc(2026, 1, 5, 0, 0), end=_utc(2026, 1, 6, 0, 0),
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(
            response.json(), {"error": "Meeting recurrence not found"},
        )

    # ── 15. Distinct recurrences at the same timestamp ───────────

    def test_same_timestamp_different_recurrences_stay_distinct(self):
        self.login(self.chris)
        second = self._create_recurrence()  # same rule, different id
        self.assertNotEqual(second.pk, self.recurrence.pk)

        (first_occurrence,) = self._expand(
            self.recurrence, _utc(2026, 1, 5, 0, 0), _utc(2026, 1, 6, 0, 0),
        )
        (second_occurrence,) = self._expand(
            second, _utc(2026, 1, 5, 0, 0), _utc(2026, 1, 6, 0, 0),
        )
        self.assertNotEqual(
            first_occurrence.occurrence_id, second_occurrence.occurrence_id,
        )

        self._materialize(self.recurrence, first_occurrence)

        response = self._get_occurrences(
            recurrence=second,
            start=_utc(2026, 1, 5, 0, 0), end=_utc(2026, 1, 6, 0, 0),
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        (item,) = response.json()
        self.assertEqual(
            item["occurrenceId"], str(second_occurrence.occurrence_id),
        )
        self.assertFalse(item["materialized"])
        self.assertIsNone(item["meetingId"])

    # ── Query behavior: no N+1 materialization lookup ────────────

    def test_materialization_lookup_does_not_scale_with_window(self):
        self.login(self.chris)
        # Materialize one occurrence so the materialization query has
        # real work in both windows.
        (target,) = self._expand(
            self.recurrence, _utc(2026, 1, 5, 0, 0), _utc(2026, 1, 6, 0, 0),
        )
        self._materialize(self.recurrence, target)

        path = self._path()
        small_params = {  # 3 occurrences
            "from": _utc(2026, 1, 5, 0, 0).isoformat(),
            "to": _utc(2026, 1, 8, 0, 0).isoformat(),
        }
        large_params = {  # 11 occurrences
            "from": _utc(2026, 1, 5, 0, 0).isoformat(),
            "to": _utc(2026, 1, 16, 0, 0).isoformat(),
        }

        # Warm-up request: absorbs the one-time lazy UserSession
        # registry INSERT so both captures compare the same steady
        # state (that statement is unrelated to occurrence expansion).
        self.client.get(path, small_params)

        with CaptureQueriesContext(connection) as small_ctx:
            small_response = self.client.get(path, small_params)
        with CaptureQueriesContext(connection) as large_ctx:
            large_response = self.client.get(path, large_params)

        self.assertEqual(small_response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(small_response.json()), 3)
        self.assertEqual(large_response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(large_response.json()), 11)
        # One bounded materialization query regardless of window size:
        # a per-occurrence lookup would grow the query count.
        self.assertEqual(
            len(small_ctx.captured_queries),
            len(large_ctx.captured_queries),
        )


class MeetingRecurrenceOccurrenceExclusionApiTest(MeetingRecurrenceBase):
    """The bounded occurrence read API answers with the EFFECTIVE
    occurrence set: the raw rule expansion with persisted
    single-occurrence exclusions filtered out after rule generation.
    """

    def setUp(self):
        super().setUp()
        self.client = APIClient()
        # Daily 09:30 Berlin, first occurrence 2026-01-05, no end.
        self.recurrence = self._create_recurrence()

    def login(self, user):
        self.client.logout()
        self.client.force_login(user)

    def _path(self):
        return (
            f"/api/meeting-recurrences/"
            f"{self.recurrence.pk}/occurrences/"
        )

    def _get_occurrences(self, start=None, end=None):
        return self.client.get(
            self._path(),
            {
                "from": (start or _utc(2026, 1, 5, 0, 0)).isoformat(),
                "to": (end or _utc(2026, 1, 12, 0, 0)).isoformat(),
            },
        )

    def _exclude(self, occurrence):
        return exclude_meeting_recurrence_occurrence(
            recurrence=self.recurrence,
            occurrence=occurrence,
            actor=self.alex,
        )

    def _raw_occurrences(self, start, end):
        return self._expand(self.recurrence, start, end)

    def _materialize(self, recurrence, occurrence):
        return materialize_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=occurrence,
            actor=self.alex,
            title="Materialized",
        )

    def test_excluded_virtual_occurrence_is_absent_from_get(self):
        self.login(self.chris)
        (excluded,) = self._raw_occurrences(
            _utc(2026, 1, 6), _utc(2026, 1, 6, 23, 59),
        )
        self._exclude(excluded)

        start, end = _utc(2026, 1, 5, 0, 0), _utc(2026, 1, 12, 0, 0)
        response = self._get_occurrences(start=start, end=end)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        # Jan 5 .. Jan 11 minus the excluded Jan 6: six occurrences.
        self.assertEqual(len(data), 6)
        self.assertNotIn(
            str(excluded.occurrence_id),
            [item["occurrenceId"] for item in data],
        )

    def test_sibling_occurrences_remain_unchanged(self):
        self.login(self.chris)
        raw = self._raw_occurrences(
            _utc(2026, 1, 5, 0, 0), _utc(2026, 1, 12, 0, 0),
        )
        self._exclude(raw[1])  # Jan 6

        response = self._get_occurrences()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        expected = [occurrence for occurrence in raw if occurrence != raw[1]]
        self.assertEqual(len(data), len(expected))
        for item, occurrence in zip(data, expected):
            self.assertEqual(
                item["occurrenceId"], str(occurrence.occurrence_id),
            )
            self.assertEqual(
                item["originalScheduledAt"],
                occurrence.original_start.astimezone(UTC)
                .isoformat()
                .replace("+00:00", "Z"),
            )
            self.assertEqual(
                item["originalLocal"], occurrence.original_local.isoformat(),
            )
            self.assertEqual(item["materialized"], False)
            self.assertIsNone(item["meetingId"])

    def test_count_limited_exclusion_adds_no_replacement(self):
        self.login(self.chris)
        self.recurrence = self._create_recurrence(
            end_mode="count", occurrence_count=3,
        )
        raw = self._raw_occurrences(
            _utc(2026, 1, 5), _utc(2026, 1, 9, 23, 59),
        )
        self.assertEqual(len(raw), 3)  # Jan 5, Jan 6, Jan 7
        self._exclude(raw[1])  # Jan 6

        response = self._get_occurrences(
            start=_utc(2026, 1, 5), end=_utc(2026, 1, 9, 23, 59),
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        self.assertEqual(
            [item["originalLocal"] for item in data],
            ["2026-01-05T09:30:00", "2026-01-07T09:30:00"],
        )
        # No replacement: day 4 (Jan 8) must NOT appear.
        self.assertNotIn("2026-01-08T09:30:00",
                         [item["originalLocal"] for item in data])

    def test_get_after_exclusion_creates_no_side_effects(self):
        self.login(self.chris)
        (excluded,) = self._raw_occurrences(
            _utc(2026, 1, 6), _utc(2026, 1, 6, 23, 59),
        )
        self._exclude(excluded)

        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 1)
        response = self._get_occurrences()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(Meeting.objects.count(), 0)
        self.assertEqual(MeetingSection.objects.count(), 0)
        self.assertEqual(MeetingParticipant.objects.count(), 0)
        self.assertEqual(AuditEvent.objects.count(), 0)
        # The GET neither added nor removed any exclusion.
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 1)

    def test_excluding_every_occurrence_returns_empty_array(self):
        self.login(self.chris)
        self.recurrence = self._create_recurrence(
            end_mode="count", occurrence_count=2,
        )
        raw = self._raw_occurrences(
            _utc(2026, 1, 5), _utc(2026, 1, 7, 23, 59),
        )
        for occurrence in raw:
            self._exclude(occurrence)

        response = self._get_occurrences(
            start=_utc(2026, 1, 5), end=_utc(2026, 1, 7, 23, 59),
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.json(), [])

    def test_materialized_sibling_still_reported_after_exclusion(self):
        self.login(self.chris)
        raw = self._raw_occurrences(
            _utc(2026, 1, 5, 0, 0), _utc(2026, 1, 12, 0, 0),
        )
        meeting = self._materialize(self.recurrence, raw[2])  # Jan 7
        self._exclude(raw[1])  # Jan 6

        response = self._get_occurrences()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        item = next(
            item for item in data
            if item["occurrenceId"] == str(raw[2].occurrence_id)
        )
        self.assertEqual(item["materialized"], True)
        self.assertEqual(item["meetingId"], meeting.pk)
