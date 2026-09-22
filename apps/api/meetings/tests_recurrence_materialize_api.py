"""API tests for the idempotent recurring-occurrence materialization
endpoint.

``POST /api/meeting-recurrences/{recurrence_id}/occurrences/materialize/``
materializes ONE calculated occurrence of a MeetingRecurrence into a
concrete Meeting. The request carries the stable occurrence identity
(``occurrenceId``) plus the canonical original scheduled timestamp
(``originalScheduledAt``) exactly as reported by the bounded
occurrence read API, and the concrete Meeting ``title``. The view
validates request input, reconstructs the canonical occurrence value,
and delegates to the existing idempotent domain materialization
service, which remains the final authority: occurrence validation
against the recurrence rule, the canonical scoped Meeting write
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
    MeetingSection,
)
from .recurrence import derive_occurrence_identity
from .services import MeetingAuditEventType
from .tests_recurrence import MeetingRecurrenceBase, _utc

User = get_user_model()
UTC = ZoneInfo("UTC")


class MeetingRecurrenceMaterializeApiTest(MeetingRecurrenceBase):
    """Idempotent occurrence materialization over HTTP."""

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
            "/occurrences/materialize/"
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

    def _payload(self, occurrence, title="Materialized"):
        return {
            "occurrenceId": str(occurrence.occurrence_id),
            "originalScheduledAt": self._utc_iso(occurrence),
            "title": title,
        }

    def _post(self, payload, recurrence=None):
        return self.client.post(
            self._path(recurrence),
            data=json.dumps(payload),
            content_type="application/json",
        )

    def _persistence_counts(self):
        return {
            "meetings": Meeting.objects.count(),
            "sections": MeetingSection.objects.count(),
            "participants": MeetingParticipant.objects.count(),
            "audit_events": AuditEvent.objects.count(),
        }

    # ── 1. Authentication and non-leaking denial ────────────────

    def test_anonymous_cannot_materialize(self):
        occurrence = self._occurrence()
        response = self._post(self._payload(occurrence))
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(Meeting.objects.count(), 0)

    def test_outsider_gets_non_leaking_404(self):
        # maria is not a member of the Research Group at all.
        self.login(self.maria)
        occurrence = self._occurrence()
        response = self._post(self._payload(occurrence))
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(
            response.json(), {"error": "Meeting recurrence not found"},
        )
        self.assertEqual(Meeting.objects.count(), 0)

    def test_unknown_recurrence_returns_404(self):
        self.login(self.chris)
        occurrence = self._occurrence()
        response = self._post(
            self._payload(occurrence),
            recurrence=MeetingRecurrence(pk=999999),
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(Meeting.objects.count(), 0)

    # ── 2. Happy path ────────────────────────────────────────────

    def test_group_member_materializes_virtual_occurrence(self):
        self.login(self.chris)
        occurrence = self._occurrence()
        before = self._persistence_counts()
        self.assertEqual(before["meetings"], 0)

        response = self._post(self._payload(occurrence, "Weekly check-in"))
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        data = response.json()

        # The response is the concrete canonical Meeting
        # representation.
        self.assertEqual(data["title"], "Weekly check-in")
        self.assertEqual(data["status"], "upcoming")
        self.assertEqual(data["scheduledAt"], self._utc_iso(occurrence))
        self.assertEqual(data["researchGroupId"], self.group.pk)
        self.assertIsNone(data["projectId"])
        self.assertEqual(data["createdById"], self.chris.pk)
        self.assertIn(self.chris.pk, data["participantIds"])

        # Exactly one concrete Meeting with the immutable provenance.
        self.assertEqual(Meeting.objects.count(), 1)
        meeting = Meeting.objects.get()
        self.assertEqual(meeting.id, data["id"])
        self.assertEqual(meeting.research_group_id, self.group.pk)
        self.assertEqual(meeting.scope, Meeting.Scope.GROUP)
        self.assertIsNone(meeting.project_id)
        self.assertEqual(meeting.recurrence, self.recurrence)
        self.assertEqual(
            meeting.original_scheduled_at, occurrence.original_start,
        )
        self.assertEqual(meeting.scheduled_at, occurrence.original_start)
        self.assertEqual(meeting.status, Meeting.Status.UPCOMING)
        self.assertEqual(meeting.created_by, self.chris)

        # Standalone-style initialization: one Agenda section, the
        # creator as participant, ONE meeting.created event.
        (section,) = MeetingSection.objects.all()
        self.assertEqual(section.meeting, meeting)
        self.assertEqual(section.name, "Agenda")
        self.assertEqual(
            list(
                MeetingParticipant.objects.filter(
                    meeting=meeting,
                ).values_list("user_id", flat=True)
            ),
            [self.chris.pk],
        )
        (event,) = AuditEvent.objects.all()
        self.assertEqual(
            event.event_type, MeetingAuditEventType.CREATED,
        )
        self.assertEqual(event.meeting, meeting)
        self.assertEqual(event.actor, self.chris)

    def test_materialized_occurrence_is_reported_by_the_read_api(self):
        self.login(self.chris)
        occurrence = self._occurrence()
        response = self._post(self._payload(occurrence))
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        meeting_id = response.json()["id"]

        read = self.client.get(
            f"/api/meeting-recurrences/{self.recurrence.pk}/occurrences/",
            {
                "from": _utc(2026, 1, 5, 0, 0).isoformat(),
                "to": _utc(2026, 1, 8, 0, 0).isoformat(),
            },
        )
        self.assertEqual(read.status_code, status.HTTP_200_OK)
        item = next(
            item for item in read.json()
            if item["occurrenceId"] == str(occurrence.occurrence_id)
        )
        self.assertTrue(item["materialized"])
        self.assertEqual(item["meetingId"], meeting_id)

    # ── 3. Idempotency ───────────────────────────────────────────

    def test_repeated_identical_post_returns_same_meeting_without_duplicates(
        self,
    ):
        self.login(self.chris)
        occurrence = self._occurrence()

        first = self._post(self._payload(occurrence))
        self.assertEqual(first.status_code, status.HTTP_201_CREATED)

        second = self._post(self._payload(occurrence))
        self.assertEqual(second.status_code, status.HTTP_200_OK)
        self.assertEqual(second.json()["id"], first.json()["id"])

        counts = self._persistence_counts()
        self.assertEqual(counts["meetings"], 1)
        self.assertEqual(counts["sections"], 1)
        self.assertEqual(counts["participants"], 1)
        self.assertEqual(counts["audit_events"], 1)

    def test_idempotent_replay_by_another_actor_returns_same_meeting(self):
        self.login(self.chris)
        occurrence = self._occurrence()
        first = self._post(self._payload(occurrence))
        self.assertEqual(first.status_code, status.HTTP_201_CREATED)

        # A different authorized actor replays the same occurrence:
        # the winner's Meeting is returned, nothing is duplicated.
        self.login(self.alex)
        second = self._post(self._payload(occurrence))
        self.assertEqual(second.status_code, status.HTTP_200_OK)
        self.assertEqual(second.json()["id"], first.json()["id"])

        counts = self._persistence_counts()
        self.assertEqual(counts["meetings"], 1)
        self.assertEqual(counts["sections"], 1)
        self.assertEqual(counts["participants"], 1)
        self.assertEqual(counts["audit_events"], 1)

    def test_replay_with_different_title_returns_existing_meeting(self):
        self.login(self.chris)
        occurrence = self._occurrence()
        first = self._post(self._payload(occurrence, "First title"))
        self.assertEqual(first.status_code, status.HTTP_201_CREATED)

        second = self._post(self._payload(occurrence, "Second title"))
        self.assertEqual(second.status_code, status.HTTP_200_OK)
        self.assertEqual(second.json()["id"], first.json()["id"])
        # The first creation's state wins; the replay does not rename.
        self.assertEqual(second.json()["title"], "First title")
        self.assertEqual(
            Meeting.objects.get().title, "First title",
        )

    def test_same_instant_with_different_offsets_is_the_same_occurrence(
        self,
    ):
        self.login(self.chris)
        occurrence = self._occurrence()
        # 09:30+01:00 (Berlin winter) is the same instant as the
        # canonical 08:30Z reported by the read API.
        berlin = (
            occurrence.original_start.astimezone(ZoneInfo("Europe/Berlin"))
            .isoformat()
        )
        first = self._post(
            {
                "occurrenceId": str(occurrence.occurrence_id),
                "originalScheduledAt": berlin,
                "title": "Materialized",
            },
        )
        self.assertEqual(first.status_code, status.HTTP_201_CREATED)

        second = self._post(self._payload(occurrence))
        self.assertEqual(second.status_code, status.HTTP_200_OK)
        self.assertEqual(second.json()["id"], first.json()["id"])
        self.assertEqual(Meeting.objects.count(), 1)

    # ── 4. Authorization: read access is never write access ──────

    def _project_recurrence(self):
        return self._create_recurrence(
            scope="project",
            project=self.project,
        )

    def test_project_owner_can_materialize_project_occurrence(self):
        recurrence = self._project_recurrence()
        self.login(self.alex)
        occurrence = self._occurrence(recurrence)

        response = self._post(self._payload(occurrence), recurrence)
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(
            Meeting.objects.get().project_id, self.project.pk,
        )

    def test_project_member_can_materialize_project_occurrence(self):
        recurrence = self._project_recurrence()
        self.login(self.chris)
        occurrence = self._occurrence(recurrence)

        response = self._post(self._payload(occurrence), recurrence)
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        meeting = Meeting.objects.get()
        self.assertEqual(meeting.scope, Meeting.Scope.PROJECT)
        self.assertEqual(meeting.project_id, self.project.pk)
        self.assertEqual(meeting.research_group_id, self.group.pk)

    def test_project_viewer_can_read_but_cannot_materialize(self):
        # The crux distinction: a Project viewer may READ the
        # occurrences (GET answers 200) but materialization is a
        # write operation and must answer 403 without persisting
        # anything.
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
        self.assertEqual(Meeting.objects.count(), 0)

    def test_group_member_without_project_access_gets_404(self):
        # maria is a group member but has no Project membership: the
        # Project recurrence is invisible to her (non-leaking 404,
        # not a 403).
        recurrence = self._project_recurrence()
        self.login(self.maria)
        occurrence = self._occurrence(recurrence)
        response = self._post(self._payload(occurrence), recurrence)
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(Meeting.objects.count(), 0)

    def test_archived_project_blocks_materialization(self):
        recurrence = self._project_recurrence()
        archive_project(project=self.project, actor=self.alex)
        # Re-load as a real request would: the creation return value
        # still caches the pre-archive Project instance.
        recurrence = MeetingRecurrence.objects.get(pk=recurrence.pk)
        self.login(self.chris)
        occurrence = self._occurrence(recurrence)

        response = self._post(self._payload(occurrence), recurrence)
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(Meeting.objects.count(), 0)

    # ── 5. Server-side occurrence validation ─────────────────────

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
                "title": "Materialized",
            },
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("error", response.json())
        self.assertEqual(Meeting.objects.count(), 0)

    def test_foreign_recurrence_identity_is_rejected(self):
        # A genuine occurrence of a DIFFERENT schedule (same rule,
        # different schedule id → different identity) must not be
        # materializable through this recurrence.
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
                "title": "Materialized",
            },
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Meeting.objects.count(), 0)

    def test_original_start_the_rule_never_produces_is_rejected(self):
        # A self-consistent forged pair: the identity matches the
        # supplied (wrong) wall-clock time, but the rule never
        # produces 10:00 — a caller cannot create recurring Meetings
        # by supplying an unchecked datetime.
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
                "title": "Materialized",
            },
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("error", response.json())
        self.assertEqual(Meeting.objects.count(), 0)

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
                "title": "Materialized",
            },
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Meeting.objects.count(), 0)

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
                "originalScheduledAt": _utc(
                    2026, 1, 7, 8, 30,
                ).isoformat(),
                "title": "Materialized",
            },
            recurrence,
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Meeting.objects.count(), 0)

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
                "originalScheduledAt": _utc(
                    2026, 1, 7, 8, 30,
                ).isoformat(),
                "title": "Materialized",
            },
            recurrence,
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Meeting.objects.count(), 0)

    def test_nonexistent_calendar_date_cannot_be_materialized(self):
        # A monthly rule starting on the 31st skips months without a
        # 31st; such a date is not even expressible as a timestamp,
        # and the request is rejected before anything is persisted.
        self.login(self.chris)
        response = self._post(
            {
                "occurrenceId": str(
                    derive_occurrence_identity(
                        recurrence_id=self.recurrence.pk,
                        original_local=datetime(2026, 1, 5, 9, 30),
                        timezone_name="Europe/Berlin",
                    )
                ),
                "originalScheduledAt": "2026-02-31T08:30:00Z",
                "title": "Materialized",
            },
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Meeting.objects.count(), 0)

    # ── 6. Request input validation ──────────────────────────────

    def test_naive_original_scheduled_at_is_rejected(self):
        self.login(self.chris)
        occurrence = self._occurrence()
        response = self._post(
            {
                "occurrenceId": str(occurrence.occurrence_id),
                "originalScheduledAt": "2026-01-06T09:30:00",
                "title": "Materialized",
            },
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("originalScheduledAt", response.json())
        self.assertEqual(Meeting.objects.count(), 0)

    def test_missing_fields_are_rejected(self):
        self.login(self.chris)
        response = self._post({})
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        errors = response.json()
        self.assertIn("occurrenceId", errors)
        self.assertIn("originalScheduledAt", errors)
        self.assertIn("title", errors)
        self.assertEqual(Meeting.objects.count(), 0)

    def test_invalid_occurrence_id_is_rejected(self):
        self.login(self.chris)
        occurrence = self._occurrence()
        response = self._post(
            {
                "occurrenceId": "not-a-uuid",
                "originalScheduledAt": self._utc_iso(occurrence),
                "title": "Materialized",
            },
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("occurrenceId", response.json())
        self.assertEqual(Meeting.objects.count(), 0)

    def test_blank_title_is_rejected(self):
        self.login(self.chris)
        occurrence = self._occurrence()
        response = self._post(self._payload(occurrence, title="  "))
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("title", response.json())
        self.assertEqual(Meeting.objects.count(), 0)

    def test_overlong_title_is_rejected(self):
        self.login(self.chris)
        occurrence = self._occurrence()
        response = self._post(
            self._payload(occurrence, title="x" * 256),
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("title", response.json())
        self.assertEqual(Meeting.objects.count(), 0)
