"""API tests for the virtual-occurrence exclusion endpoint.

``POST /api/meeting-recurrences/{recurrence_id}/occurrences/exclude/``
excludes ONE still-virtual occurrence of a MeetingRecurrence from the
effective occurrence set. The request carries the stable occurrence
identity (``occurrenceId``) plus the canonical original scheduled
timestamp (``originalScheduledAt``) exactly as reported by the bounded
occurrence read API — no title, no Meeting-level input, because NO
Meeting is being created. The view validates request input,
reconstructs the canonical occurrence value, and delegates to the
existing canonical domain exclusion service, which remains the final
authority: occurrence validation against the recurrence rule, the
materialized-occurrence boundary, the canonical scoped Meeting write
authorization, and idempotent persistence.
"""

import json
from datetime import datetime
from zoneinfo import ZoneInfo

from audit_history.models import AuditEvent
from django.contrib.auth import get_user_model

from rest_framework import status
from rest_framework.test import APIClient

from projects.services import archive_project

from .models import (
    Meeting,
    MeetingParticipant,
    MeetingRecurrence,
    MeetingRecurrenceExclusion,
    MeetingSection,
)
from .recurrence import derive_occurrence_identity
from .tests_recurrence import MeetingRecurrenceBase, _utc

User = get_user_model()
UTC = ZoneInfo("UTC")


class MeetingRecurrenceExcludeApiTest(MeetingRecurrenceBase):
    """Virtual occurrence exclusion over HTTP."""

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
        return (
            f"/api/meeting-recurrences/{recurrence.pk}"
            "/occurrences/exclude/"
        )

    def _occurrence(self, recurrence=None, local="2026-01-06T09:30:00"):
        """The occurrence of this recurrence at the given local
        wall-clock start (an inclusive one-instant window)."""
        recurrence = recurrence if recurrence is not None else self.recurrence
        tz = ZoneInfo(recurrence.timezone_name)
        instant = datetime.fromisoformat(local).replace(tzinfo=tz)
        (occurrence,) = self._expand(recurrence, instant, instant)
        return occurrence

    def _utc_iso(self, occurrence):
        return (
            occurrence.original_start.astimezone(UTC)
            .isoformat()
            .replace("+00:00", "Z")
        )

    def _payload(self, occurrence):
        return {
            "occurrenceId": str(occurrence.occurrence_id),
            "originalScheduledAt": self._utc_iso(occurrence),
        }

    def _post(self, payload, recurrence=None):
        return self.client.post(
            self._path(recurrence),
            data=json.dumps(payload),
            content_type="application/json",
        )

    def _materialize(self, occurrence, title="Materialized"):
        return self.client.post(
            f"/api/meeting-recurrences/{self.recurrence.pk}"
            "/occurrences/materialize/",
            data=json.dumps(
                {
                    "occurrenceId": str(occurrence.occurrence_id),
                    "originalScheduledAt": self._utc_iso(occurrence),
                    "title": title,
                }
            ),
            content_type="application/json",
        )

    def _reschedule(self, occurrence, scheduled_at, title="Rescheduled"):
        return self.client.post(
            f"/api/meeting-recurrences/{self.recurrence.pk}"
            "/occurrences/reschedule/",
            data=json.dumps(
                {
                    "occurrenceId": str(occurrence.occurrence_id),
                    "originalScheduledAt": self._utc_iso(occurrence),
                    "scheduledAt": scheduled_at,
                    "title": title,
                }
            ),
            content_type="application/json",
        )

    def _get_occurrences(self, from_dt, to_dt, recurrence=None):
        recurrence = recurrence if recurrence is not None else self.recurrence
        return self.client.get(
            f"/api/meeting-recurrences/{recurrence.pk}/occurrences/",
            {
                "from": from_dt.isoformat(),
                "to": to_dt.isoformat(),
            },
        )

    def _persistence_counts(self):
        return {
            "meetings": Meeting.objects.count(),
            "sections": MeetingSection.objects.count(),
            "participants": MeetingParticipant.objects.count(),
            "audit_events": AuditEvent.objects.count(),
            "exclusions": MeetingRecurrenceExclusion.objects.count(),
        }

    def _assert_no_side_effects(self):
        counts = self._persistence_counts()
        self.assertEqual(counts, {
            "meetings": 0,
            "sections": 0,
            "participants": 0,
            "audit_events": 0,
            "exclusions": 0,
        })

    def _assert_rule_unchanged(self):
        recurrence = MeetingRecurrence.objects.get(
            pk=self.recurrence.pk,
        )
        self.assertEqual(recurrence.frequency, "daily")
        self.assertEqual(recurrence.interval, 1)
        self.assertEqual(recurrence.start_date, datetime(2026, 1, 5).date())
        self.assertEqual(recurrence.local_time, datetime(2026, 1, 5, 9, 30).time())
        self.assertEqual(recurrence.timezone_name, "Europe/Berlin")
        self.assertEqual(recurrence.end_mode, "no_end")
        self.assertIsNone(recurrence.end_date)
        self.assertIsNone(recurrence.occurrence_count)
        self.assertEqual(recurrence.weekdays, [])
        self.assertEqual(recurrence.research_group, self.group)
        self.assertIsNone(recurrence.project)
        self.assertEqual(recurrence.created_by, self.alex)

    # ── 1. Authentication and non-leaking denial ────────────────

    def test_anonymous_cannot_exclude(self):
        occurrence = self._occurrence()
        response = self._post(self._payload(occurrence))
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self._assert_no_side_effects()

    def test_outsider_gets_non_leaking_404(self):
        # maria is not a member of the Research Group at all.
        self.login(self.maria)
        occurrence = self._occurrence()
        response = self._post(self._payload(occurrence))
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(
            response.json(), {"error": "Meeting recurrence not found"},
        )
        self._assert_no_side_effects()

    def test_unknown_recurrence_returns_404(self):
        self.login(self.chris)
        occurrence = self._occurrence()
        response = self._post(
            self._payload(occurrence),
            recurrence=MeetingRecurrence(pk=999999),
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self._assert_no_side_effects()

    # ── 2. Happy path: exclusion only, never materialization ────

    def test_group_member_excludes_virtual_occurrence(self):
        self.login(self.chris)
        occurrence = self._occurrence()

        response = self._post(self._payload(occurrence))
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        # A stable bodyless contract: 204 carries no representation.
        self.assertEqual(response.content, b"")

        # Exactly ONE exclusion row, keyed by the canonical pair.
        (exclusion,) = MeetingRecurrenceExclusion.objects.all()
        self.assertEqual(exclusion.recurrence, self.recurrence)
        self.assertEqual(
            exclusion.original_scheduled_at, occurrence.original_start,
        )
        self.assertEqual(exclusion.created_by, self.chris)

        # And NOTHING else: no Meeting, Section, participant, or
        # Meeting audit event of any kind.
        counts = self._persistence_counts()
        self.assertEqual(counts["meetings"], 0)
        self.assertEqual(counts["sections"], 0)
        self.assertEqual(counts["participants"], 0)
        self.assertEqual(counts["audit_events"], 0)
        self.assertEqual(counts["exclusions"], 1)

        # The parent recurrence rule is unchanged.
        self._assert_rule_unchanged()

    def test_replay_is_idempotent(self):
        self.login(self.chris)
        occurrence = self._occurrence()

        first = self._post(self._payload(occurrence))
        self.assertEqual(first.status_code, status.HTTP_204_NO_CONTENT)
        second = self._post(self._payload(occurrence))
        # Identical success shape for the idempotent replay.
        self.assertEqual(second.status_code, status.HTTP_204_NO_CONTENT)

        # One exclusion row, no duplicates, no Meeting, no events.
        counts = self._persistence_counts()
        self.assertEqual(counts["exclusions"], 1)
        self.assertEqual(counts["meetings"], 0)
        self.assertEqual(counts["audit_events"], 0)
        self._assert_rule_unchanged()

    def test_replay_by_another_authorized_actor_is_idempotent(self):
        self.login(self.chris)
        occurrence = self._occurrence()
        first = self._post(self._payload(occurrence))
        self.assertEqual(first.status_code, status.HTTP_204_NO_CONTENT)

        self.login(self.alex)
        second = self._post(self._payload(occurrence))
        self.assertEqual(second.status_code, status.HTTP_204_NO_CONTENT)

        counts = self._persistence_counts()
        self.assertEqual(counts["exclusions"], 1)
        self.assertEqual(counts["meetings"], 0)

    # ── 3. Effective occurrence GET ──────────────────────────────

    def test_get_omits_excluded_and_keeps_siblings(self):
        self.login(self.chris)
        excluded = self._occurrence()  # Jan 6
        response = self._post(self._payload(excluded))
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)

        read = self._get_occurrences(
            _utc(2026, 1, 5, 0, 0), _utc(2026, 1, 12, 0, 0),
        )
        self.assertEqual(read.status_code, status.HTTP_200_OK)
        data = read.json()
        # Jan 5 .. Jan 11 minus the excluded Jan 6: six occurrences.
        self.assertEqual(len(data), 6)
        ids = [item["occurrenceId"] for item in data]
        self.assertNotIn(str(excluded.occurrence_id), ids)
        for item in data:
            self.assertFalse(item["materialized"])
            self.assertIsNone(item["meetingId"])

    def test_count_series_does_not_generate_replacement(self):
        # COUNT = 3 → exactly Jan 5 (A), Jan 6 (B), Jan 7 (C).
        recurrence = self._create_recurrence(
            end_mode="count", occurrence_count=3,
        )
        self.login(self.chris)
        excluded = self._occurrence(recurrence)  # B
        response = self._post(self._payload(excluded), recurrence)
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)

        read = self._get_occurrences(
            _utc(2026, 1, 5, 0, 0), _utc(2026, 1, 12, 0, 0),
            recurrence,
        )
        self.assertEqual(read.status_code, status.HTTP_200_OK)
        data = read.json()
        # Effective = A, C — never a replacement D.
        self.assertEqual(len(data), 2)
        local_starts = [item["originalLocal"] for item in data]
        self.assertEqual(
            local_starts,
            ["2026-01-05T09:30:00", "2026-01-07T09:30:00"],
        )

    def test_end_date_series_does_not_extend(self):
        recurrence = self._create_recurrence(
            end_mode="end_date",
            end_date=datetime(2026, 1, 7).date(),
        )
        self.login(self.chris)
        excluded = self._occurrence(recurrence)  # Jan 6
        response = self._post(self._payload(excluded), recurrence)
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)

        read = self._get_occurrences(
            _utc(2026, 1, 5, 0, 0), _utc(2026, 1, 12, 0, 0),
            recurrence,
        )
        self.assertEqual(read.status_code, status.HTTP_200_OK)
        data = read.json()
        # The series still ends on Jan 7 — no Jan 8.
        self.assertEqual(len(data), 2)
        local_starts = [item["originalLocal"] for item in data]
        self.assertEqual(
            local_starts,
            ["2026-01-05T09:30:00", "2026-01-07T09:30:00"],
        )

    def test_other_recurrence_with_same_timestamp_is_unaffected(self):
        # Same rule, different schedule id → different occurrences.
        second = self._create_recurrence()
        self.assertNotEqual(second.pk, self.recurrence.pk)
        self.login(self.chris)

        excluded = self._occurrence()  # Jan 6 of the first recurrence
        response = self._post(self._payload(excluded))
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)

        read = self._get_occurrences(
            _utc(2026, 1, 6, 0, 0), _utc(2026, 1, 7, 0, 0),
            second,
        )
        self.assertEqual(read.status_code, status.HTTP_200_OK)
        (item,) = read.json()
        # The second recurrence's Jan 6 occurrence is still there.
        self.assertEqual(
            item["originalLocal"], "2026-01-06T09:30:00",
        )
        self.assertFalse(item["materialized"])

    # ── 4. Materialized-occurrence boundary ──────────────────────

    def test_materialized_occurrence_is_rejected_and_unchanged(self):
        self.login(self.chris)
        occurrence = self._occurrence()
        created = self._materialize(occurrence, title="Concrete")
        self.assertEqual(created.status_code, status.HTTP_201_CREATED)
        meeting = Meeting.objects.get()

        response = self._post(self._payload(occurrence))
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("error", response.json())

        # No exclusion through this path — and the Meeting is left
        # completely unchanged: not cancelled, not deleted, not
        # rescheduled.
        self.assertEqual(
            MeetingRecurrenceExclusion.objects.count(), 0,
        )
        self.assertEqual(Meeting.objects.count(), 1)
        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.UPCOMING)
        self.assertEqual(meeting.scheduled_at, occurrence.original_start)
        self.assertEqual(
            meeting.original_scheduled_at, occurrence.original_start,
        )
        self.assertEqual(meeting.title, "Concrete")

        # The read API still reports it as materialized.
        read = self._get_occurrences(
            _utc(2026, 1, 6, 0, 0), _utc(2026, 1, 7, 0, 0),
        )
        (item,) = read.json()
        self.assertTrue(item["materialized"])
        self.assertEqual(item["meetingId"], meeting.pk)

    # ── 5. Interaction with materialization / reschedule ─────────

    def test_materialize_endpoint_rejects_excluded_occurrence(self):
        self.login(self.chris)
        occurrence = self._occurrence()
        excluded_response = self._post(self._payload(occurrence))
        self.assertEqual(
            excluded_response.status_code, status.HTTP_204_NO_CONTENT,
        )
        (exclusion,) = MeetingRecurrenceExclusion.objects.all()

        materialize = self._materialize(occurrence)
        self.assertEqual(materialize.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("error", materialize.json())

        # No Meeting; the exclusion stays untouched (one-way gate).
        self.assertEqual(Meeting.objects.count(), 0)
        self.assertEqual(MeetingSection.objects.count(), 0)
        self.assertEqual(MeetingParticipant.objects.count(), 0)
        self.assertEqual(AuditEvent.objects.count(), 0)
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 1)
        self.assertEqual(
            MeetingRecurrenceExclusion.objects.get().pk, exclusion.pk,
        )

    def test_reschedule_endpoint_rejects_excluded_occurrence(self):
        self.login(self.chris)
        occurrence = self._occurrence()
        excluded_response = self._post(self._payload(occurrence))
        self.assertEqual(
            excluded_response.status_code, status.HTTP_204_NO_CONTENT,
        )
        (exclusion,) = MeetingRecurrenceExclusion.objects.all()

        reschedule = self._reschedule(
            occurrence,
            scheduled_at=_utc(2026, 1, 6, 15, 0).isoformat(),
        )
        self.assertEqual(
            reschedule.status_code, status.HTTP_400_BAD_REQUEST,
        )
        self.assertIn("error", reschedule.json())

        # A virtual reschedule would first materialize — it must not.
        self.assertEqual(Meeting.objects.count(), 0)
        self.assertEqual(MeetingSection.objects.count(), 0)
        self.assertEqual(MeetingParticipant.objects.count(), 0)
        self.assertEqual(AuditEvent.objects.count(), 0)
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 1)
        self.assertEqual(
            MeetingRecurrenceExclusion.objects.get().pk, exclusion.pk,
        )

    # ── 6. Explicit two-path regression ──────────────────────────

    def test_two_path_distinction_virtual_vs_materialized(self):
        """Occurrence A = virtual, occurrence B = materialized.

        exclude A through the recurrence endpoint  → success, no A
        Meeting; exclude B through the recurrence endpoint  →
        rejected, Meeting B unchanged; cancel Meeting B through
        the Meeting cancel endpoint  → Meeting B cancelled.
        """
        self.login(self.chris)
        occurrence_a = self._occurrence(local="2026-01-06T09:30:00")
        occurrence_b = self._occurrence(local="2026-01-07T09:30:00")

        # Materialize B only.
        created_b = self._materialize(occurrence_b, title="Meeting B")
        self.assertEqual(created_b.status_code, status.HTTP_201_CREATED)
        meeting_b = Meeting.objects.get()
        self.assertEqual(
            meeting_b.original_scheduled_at, occurrence_b.original_start,
        )

        # 1. Exclude A through the recurrence endpoint: success, and
        #    A is NOT materialized by it.
        exclude_a = self._post(self._payload(occurrence_a))
        self.assertEqual(exclude_a.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(Meeting.objects.count(), 1)

        # 2. Exclude B through the recurrence endpoint: rejected;
        #    Meeting B is unchanged.
        exclude_b = self._post(self._payload(occurrence_b))
        self.assertEqual(
            exclude_b.status_code, status.HTTP_400_BAD_REQUEST,
        )
        self.assertIn("error", exclude_b.json())
        meeting_b.refresh_from_db()
        self.assertEqual(meeting_b.status, Meeting.Status.UPCOMING)
        self.assertEqual(meeting_b.title, "Meeting B")
        self.assertEqual(
            meeting_b.scheduled_at, occurrence_b.original_start,
        )

        # 3. Cancel Meeting B through the Meeting cancel endpoint.
        cancel = self.client.post(
            f"/api/meetings/{meeting_b.pk}/cancel",
        )
        self.assertEqual(cancel.status_code, status.HTTP_200_OK)
        self.assertEqual(cancel.json()["status"], "cancelled")
        meeting_b.refresh_from_db()
        self.assertEqual(meeting_b.status, Meeting.Status.CANCELLED)

        # Final state: two exclusions (one per occurrence), one
        # Meeting (B, cancelled), no A.
        exclusions = set(
            MeetingRecurrenceExclusion.objects
            .values_list("original_scheduled_at", flat=True)
        )
        self.assertEqual(exclusions, {
            occurrence_a.original_start,
            occurrence_b.original_start,
        })
        self.assertEqual(Meeting.objects.count(), 1)

        # Effective GET: A and B are absent, siblings (Jan 5, 8, 9)
        # are unchanged.
        read = self._get_occurrences(
            _utc(2026, 1, 5, 0, 0), _utc(2026, 1, 10, 0, 0),
        )
        self.assertEqual(read.status_code, status.HTTP_200_OK)
        data = read.json()
        self.assertEqual(len(data), 3)
        local_starts = [item["originalLocal"] for item in data]
        self.assertEqual(
            local_starts,
            [
                "2026-01-05T09:30:00",
                "2026-01-08T09:30:00",
                "2026-01-09T09:30:00",
            ],
        )

    # ── 7. Server-side occurrence validation ─────────────────────

    def test_mismatched_occurrence_identity_is_rejected(self):
        # The identity of the Jan 7 occurrence paired with the Jan 6
        # original start: the pair is mutually inconsistent.
        self.login(self.chris)
        jan6 = self._occurrence(local="2026-01-06T09:30:00")
        jan7 = self._occurrence(local="2026-01-07T09:30:00")
        response = self._post(
            {
                "occurrenceId": str(jan7.occurrence_id),
                "originalScheduledAt": self._utc_iso(jan6),
            },
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("error", response.json())
        self._assert_no_side_effects()

    def test_foreign_recurrence_identity_is_rejected(self):
        # A genuine occurrence of a DIFFERENT schedule (same rule,
        # different schedule id → different identity) must not be
        # excludable through this recurrence.
        self.login(self.chris)
        second = self._create_recurrence()  # same rule, different id
        self.assertNotEqual(second.pk, self.recurrence.pk)

        foreign = self._occurrence(second, local="2026-01-06T09:30:00")
        own = self._occurrence(local="2026-01-06T09:30:00")
        self.assertNotEqual(foreign.occurrence_id, own.occurrence_id)

        response = self._post(
            {
                "occurrenceId": str(foreign.occurrence_id),
                "originalScheduledAt": self._utc_iso(own),
            },
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self._assert_no_side_effects()

    def test_original_start_the_rule_never_produces_is_rejected(self):
        # A self-consistent forged pair: the identity matches the
        # supplied (wrong) wall-clock time, but the rule never
        # produces 10:00 — a caller cannot forge off-rule exclusions.
        self.login(self.chris)
        forged_local = datetime(2026, 1, 6, 10, 0)
        forged_id = derive_occurrence_identity(
            recurrence_id=self.recurrence.pk,
            original_local=forged_local,
            timezone_name="Europe/Berlin",
        )
        response = self._post(
            {
                "occurrenceId": str(forged_id),
                "originalScheduledAt": _utc(2026, 1, 6, 9, 0).isoformat(),
            },
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("error", response.json())
        self._assert_no_side_effects()

    def test_occurrence_before_the_first_occurrence_is_rejected(self):
        self.login(self.chris)
        before_local = datetime(2026, 1, 4, 9, 30)
        response = self._post(
            {
                "occurrenceId": str(
                    derive_occurrence_identity(
                        recurrence_id=self.recurrence.pk,
                        original_local=before_local,
                        timezone_name="Europe/Berlin",
                    )
                ),
                "originalScheduledAt": _utc(2026, 1, 4, 8, 30).isoformat(),
            },
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self._assert_no_side_effects()

    def test_occurrence_beyond_the_count_contract_is_rejected(self):
        # count=2 → only Jan 5 and Jan 6 exist for the rule.
        recurrence = self._create_recurrence(
            end_mode="count", occurrence_count=2,
        )
        self.login(self.chris)
        beyond_local = datetime(2026, 1, 7, 9, 30)
        response = self._post(
            {
                "occurrenceId": str(
                    derive_occurrence_identity(
                        recurrence_id=recurrence.pk,
                        original_local=beyond_local,
                        timezone_name="Europe/Berlin",
                    )
                ),
                "originalScheduledAt": _utc(2026, 1, 7, 8, 30).isoformat(),
            },
            recurrence,
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self._assert_no_side_effects()

    def test_occurrence_beyond_the_end_date_contract_is_rejected(self):
        recurrence = self._create_recurrence(
            end_mode="end_date",
            end_date=datetime(2026, 1, 6).date(),
        )
        self.login(self.chris)
        beyond_local = datetime(2026, 1, 7, 9, 30)
        response = self._post(
            {
                "occurrenceId": str(
                    derive_occurrence_identity(
                        recurrence_id=recurrence.pk,
                        original_local=beyond_local,
                        timezone_name="Europe/Berlin",
                    )
                ),
                "originalScheduledAt": _utc(2026, 1, 7, 8, 30).isoformat(),
            },
            recurrence,
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self._assert_no_side_effects()

    # ── 8. Request input validation ──────────────────────────────

    def test_naive_original_scheduled_at_is_rejected(self):
        self.login(self.chris)
        occurrence = self._occurrence()
        response = self._post(
            {
                "occurrenceId": str(occurrence.occurrence_id),
                "originalScheduledAt": "2026-01-06T09:30:00",
            },
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("originalScheduledAt", response.json())
        self._assert_no_side_effects()

    def test_missing_fields_are_rejected(self):
        self.login(self.chris)
        response = self._post({})
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        errors = response.json()
        self.assertIn("occurrenceId", errors)
        self.assertIn("originalScheduledAt", errors)
        self._assert_no_side_effects()

    def test_invalid_occurrence_id_is_rejected(self):
        self.login(self.chris)
        occurrence = self._occurrence()
        response = self._post(
            {
                "occurrenceId": "not-a-uuid",
                "originalScheduledAt": self._utc_iso(occurrence),
            },
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("occurrenceId", response.json())
        self._assert_no_side_effects()

    # ── 9. Authorization: read access is never write access ──────

    def _project_recurrence(self):
        return self._create_recurrence(
            scope="project",
            project=self.project,
        )

    def test_project_owner_can_exclude_project_occurrence(self):
        recurrence = self._project_recurrence()
        self.login(self.alex)
        occurrence = self._occurrence(recurrence)

        response = self._post(self._payload(occurrence), recurrence)
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 1)
        self.assertEqual(Meeting.objects.count(), 0)

    def test_project_member_can_exclude_project_occurrence(self):
        recurrence = self._project_recurrence()
        self.login(self.chris)
        occurrence = self._occurrence(recurrence)

        response = self._post(self._payload(occurrence), recurrence)
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 1)
        self.assertEqual(Meeting.objects.count(), 0)

    def test_project_viewer_can_read_but_cannot_exclude(self):
        # The crux distinction: a Project viewer may READ the
        # occurrences (GET answers 200) but exclusion is a write
        # operation and must answer 403 without persisting anything.
        recurrence = self._project_recurrence()
        self.login(self.laura)
        read = self.client.get(
            f"/api/meeting-recurrences/{recurrence.pk}/occurrences/",
            {
                "from": _utc(2026, 1, 5, 0, 0).isoformat(),
                "to": _utc(2026, 1, 7, 0, 0).isoformat(),
            },
        )
        self.assertEqual(read.status_code, status.HTTP_200_OK)

        occurrence = self._occurrence(recurrence)
        response = self._post(self._payload(occurrence), recurrence)
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self._assert_no_side_effects()

    def test_group_member_without_project_access_gets_404(self):
        # maria is a group member but has no Project membership: the
        # Project recurrence is invisible to her (non-leaking 404,
        # not a 403).
        recurrence = self._project_recurrence()
        self.login(self.maria)
        occurrence = self._occurrence(recurrence)
        response = self._post(self._payload(occurrence), recurrence)
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self._assert_no_side_effects()

    def test_archived_project_blocks_exclusion(self):
        recurrence = self._project_recurrence()
        archive_project(project=self.project, actor=self.alex)
        # Re-load as a real request would: the creation return value
        # still caches the pre-archive Project instance.
        recurrence = MeetingRecurrence.objects.get(pk=recurrence.pk)
        self.login(self.chris)
        occurrence = self._occurrence(recurrence)
        # Baseline AFTER the archive: the archive itself records a
        # project audit event, which is unrelated to this endpoint.
        before = self._persistence_counts()

        response = self._post(self._payload(occurrence), recurrence)
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(self._persistence_counts(), before)
