"""API tests for the single-occurrence reschedule endpoint.

``POST /api/meeting-recurrences/{recurrence_id}/occurrences/reschedule/``
reschedules ONE materialized occurrence of a MeetingRecurrence ("only
this meeting"): the concrete Meeting moves to a new planned time while
the recurrence rule, the immutable occurrence identity
(``original_scheduled_at``), and every other occurrence in the series
are left untouched. The request carries the stable occurrence identity
(``occurrenceId``) plus the canonical original scheduled timestamp
(``originalScheduledAt``) exactly as reported by the bounded
occurrence read API, and the new planned time (``scheduledAt``), plus the concrete Meeting
``title`` (required for every request: it is the title used when the
reschedule must first materialize a still-virtual occurrence, and is
ignored for an already-materialized Meeting, which a reschedule never
renames). The view validates request input, reconstructs the canonical
occurrence value, and delegates to the domain reschedule service,
which remains the final authority: occurrence validation against the
recurrence rule, on-demand idempotent materialization of a virtual
occurrence, the canonical scoped Meeting write authorization, and the
provenance-preserving time change with the ``meeting.rescheduled``
audit event.
"""

import json
from datetime import datetime, timedelta
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
from .services import (
    MeetingAuditEventType,
    exclude_meeting_recurrence_occurrence,
    materialize_meeting_recurrence_occurrence,
)
from .tests_recurrence import MeetingRecurrenceBase, _utc

User = get_user_model()
UTC = ZoneInfo("UTC")


class MeetingRecurrenceRescheduleApiTest(MeetingRecurrenceBase):
    """Single-occurrence reschedule ("only this meeting") over HTTP."""

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
            "/occurrences/reschedule/"
        )

    def _occurrence(self, recurrence=None, local="2026-01-06T09:30:00"):
        """The occurrence of this recurrence at the given local
        wall-clock start (an inclusive one-instant window)."""
        recurrence = recurrence if recurrence is not None else self.recurrence
        tz = ZoneInfo(recurrence.timezone_name)
        instant = datetime.fromisoformat(local).replace(tzinfo=tz)
        (occurrence,) = self._expand(recurrence, instant, instant)
        return occurrence

    def _utc_iso(self, occurrence_or_dt):
        """UTC ISO-8601 ('Z') for an occurrence's original start or a
        plain aware datetime."""
        dt = getattr(
            occurrence_or_dt, "original_start", occurrence_or_dt,
        )
        return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")

    def _materialize(self, recurrence, occurrence, *, actor=None):
        return materialize_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=occurrence,
            actor=actor if actor is not None else self.alex,
            title="Materialized",
        )

    def _payload(self, occurrence, scheduled_at, title="Materialized"):
        return {
            "occurrenceId": str(occurrence.occurrence_id),
            "originalScheduledAt": self._utc_iso(occurrence),
            "scheduledAt": scheduled_at,
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

    def _recurrence_rule_snapshot(self, recurrence):
        """Every field of the recurrence rule row."""
        return {
            "research_group_id": recurrence.research_group_id,
            "scope": recurrence.scope,
            "project_id": recurrence.project_id,
            "frequency": recurrence.frequency,
            "interval": recurrence.interval,
            "weekdays": recurrence.weekdays,
            "start_date": recurrence.start_date,
            "local_time": recurrence.local_time,
            "timezone_name": recurrence.timezone_name,
            "end_mode": recurrence.end_mode,
            "end_date": recurrence.end_date,
            "occurrence_count": recurrence.occurrence_count,
            "created_by_id": recurrence.created_by_id,
            "created_at": recurrence.created_at,
            "updated_at": recurrence.updated_at,
        }

    # ── 1. Authentication and non-leaking denial ────────────────

    def test_anonymous_cannot_reschedule(self):
        occurrence = self._occurrence()
        self._materialize(self.recurrence, occurrence)
        response = self._post(
            self._payload(occurrence, _utc(2026, 3, 15, 14, 0).isoformat()),
        )
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_outsider_gets_non_leaking_404(self):
        # maria is not a member of the Research Group at all.
        self.login(self.maria)
        occurrence = self._occurrence()
        self._materialize(self.recurrence, occurrence)
        response = self._post(
            self._payload(occurrence, _utc(2026, 3, 15, 14, 0).isoformat()),
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(
            response.json(), {"error": "Meeting recurrence not found"},
        )

    def test_unknown_recurrence_returns_404(self):
        self.login(self.chris)
        occurrence = self._occurrence()
        self._materialize(self.recurrence, occurrence)
        response = self._post(
            self._payload(occurrence, _utc(2026, 3, 15, 14, 0).isoformat()),
            recurrence=MeetingRecurrence(pk=999999),
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    # ── 2. Happy path ────────────────────────────────────────────

    def test_group_member_reschedules_materialized_occurrence(self):
        self.login(self.chris)
        occurrence = self._occurrence()
        meeting = self._materialize(self.recurrence, occurrence)
        original = meeting.original_scheduled_at
        new_time = _utc(2026, 3, 15, 14, 0)
        before = self._persistence_counts()
        rule_before = self._recurrence_rule_snapshot(self.recurrence)

        response = self._post(
            self._payload(occurrence, new_time.isoformat()),
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()

        # The response is the concrete canonical Meeting
        # representation at the new planned time.
        self.assertEqual(data["id"], meeting.pk)
        self.assertEqual(data["scheduledAt"], self._utc_iso(new_time))
        self.assertEqual(data["title"], "Materialized")
        self.assertEqual(data["researchGroupId"], self.group.pk)

        # The Meeting moved; the immutable occurrence identity and the
        # recurrence provenance are untouched.
        meeting.refresh_from_db()
        self.assertEqual(meeting.scheduled_at, new_time)
        self.assertEqual(meeting.original_scheduled_at, original)
        self.assertEqual(meeting.recurrence_id, self.recurrence.pk)

        # The recurrence rule itself was not mutated (not even its
        # updated_at: the row was never written).
        self.recurrence.refresh_from_db()
        self.assertEqual(
            self._recurrence_rule_snapshot(self.recurrence), rule_before,
        )

        # No new Meeting / Section / participant rows were created.
        after = self._persistence_counts()
        self.assertEqual(after["meetings"], before["meetings"])
        self.assertEqual(after["sections"], before["sections"])
        self.assertEqual(after["participants"], before["participants"])

        # Exactly one structured meeting.rescheduled event, recorded
        # by the reschedule (not by materialization).
        reschedule_events = list(
            AuditEvent.objects.filter(
                meeting=meeting,
                event_type=MeetingAuditEventType.RESCHEDULED,
            )
        )
        self.assertEqual(len(reschedule_events), 1)
        event = reschedule_events[0]
        self.assertEqual(event.actor, self.chris)
        # The persisted event uses the canonical _iso8601_utc form
        # (UTC ISO-8601 with the +00:00 offset, never a 'Z' suffix).

        def _stored_utc(dt):
            return dt.astimezone(UTC).isoformat()

        self.assertEqual(
            event.data["changes"]["scheduledAt"]["from"],
            _stored_utc(occurrence.original_start),
        )
        self.assertEqual(
            event.data["changes"]["scheduledAt"]["to"],
            _stored_utc(new_time),
        )

    def test_rescheduled_occurrence_still_maps_to_the_same_meeting(self):
        # The read-API mapping (occurrenceId / originalScheduledAt →
        # materialized + meetingId) never depends on the Meeting's
        # editable scheduled_at.
        self.login(self.chris)
        start, end = _utc(2026, 1, 5, 0, 0), _utc(2026, 1, 9, 0, 0)
        before = self.client.get(
            f"/api/meeting-recurrences/{self.recurrence.pk}/occurrences/",
            {"from": start.isoformat(), "to": end.isoformat()},
        ).json()

        occurrence = self._occurrence()
        meeting = self._materialize(self.recurrence, occurrence)
        response = self._post(
            self._payload(occurrence, _utc(2026, 3, 15, 14, 0).isoformat()),
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        after = self.client.get(
            f"/api/meeting-recurrences/{self.recurrence.pk}/occurrences/",
            {"from": start.isoformat(), "to": end.isoformat()},
        ).json()

        # Same series, same identities, same original starts; the
        # moved occurrence still reports materialized with the same
        # meetingId, and no other occurrence changed at all.
        self.assertEqual(
            [item["occurrenceId"] for item in before],
            [item["occurrenceId"] for item in after],
        )
        moved = next(
            item for item in after
            if item["occurrenceId"] == str(occurrence.occurrence_id)
        )
        self.assertTrue(moved["materialized"])
        self.assertEqual(moved["meetingId"], meeting.pk)
        self.assertEqual(
            moved["originalScheduledAt"], self._utc_iso(occurrence),
        )
        for prior, current in zip(before, after):
            if prior["occurrenceId"] != str(occurrence.occurrence_id):
                self.assertEqual(prior, current)

    # ── 3. No-op and repeated reschedules ────────────────────────

    def test_reschedule_to_the_current_time_is_a_noop(self):
        self.login(self.chris)
        occurrence = self._occurrence()
        meeting = self._materialize(self.recurrence, occurrence)

        response = self._post(
            self._payload(occurrence, self._utc_iso(occurrence)),
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            response.json()["scheduledAt"], self._utc_iso(occurrence),
        )
        # Same planned time: no reschedule event, nothing created.
        self.assertEqual(
            AuditEvent.objects.filter(
                meeting=meeting,
                event_type=MeetingAuditEventType.RESCHEDULED,
            ).count(),
            0,
        )
        self.assertEqual(Meeting.objects.count(), 1)

    def test_repeated_reschedules_record_one_event_per_change(self):
        self.login(self.chris)
        occurrence = self._occurrence()
        meeting = self._materialize(self.recurrence, occurrence)

        first = self._post(
            self._payload(occurrence, _utc(2026, 3, 1, 10, 0).isoformat()),
        )
        second = self._post(
            self._payload(occurrence, _utc(2026, 3, 2, 11, 0).isoformat()),
        )
        self.assertEqual(first.status_code, status.HTTP_200_OK)
        self.assertEqual(second.status_code, status.HTTP_200_OK)

        meeting.refresh_from_db()
        self.assertEqual(
            meeting.scheduled_at, _utc(2026, 3, 2, 11, 0),
        )
        self.assertEqual(
            AuditEvent.objects.filter(
                meeting=meeting,
                event_type=MeetingAuditEventType.RESCHEDULED,
            ).count(),
            2,
        )
        # Still exactly one Meeting for the occurrence.
        self.assertEqual(Meeting.objects.count(), 1)

    # ── 4. Authorization: read access is never write access ──────

    def _project_recurrence(self):
        return self._create_recurrence(
            scope="project",
            project=self.project,
        )

    def test_project_owner_can_reschedule_project_occurrence(self):
        recurrence = self._project_recurrence()
        occurrence = self._occurrence(recurrence)
        meeting = self._materialize(recurrence, occurrence)
        self.login(self.alex)

        response = self._post(
            self._payload(occurrence, _utc(2026, 3, 15, 14, 0).isoformat()),
            recurrence,
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.json()["id"], meeting.pk)

    def test_project_member_can_reschedule_project_occurrence(self):
        recurrence = self._project_recurrence()
        occurrence = self._occurrence(recurrence)
        meeting = self._materialize(recurrence, occurrence)
        self.login(self.chris)

        response = self._post(
            self._payload(occurrence, _utc(2026, 3, 15, 14, 0).isoformat()),
            recurrence,
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        meeting.refresh_from_db()
        self.assertEqual(meeting.scope, Meeting.Scope.PROJECT)
        self.assertEqual(meeting.project_id, self.project.pk)

    def test_project_viewer_can_read_but_cannot_reschedule(self):
        # The crux distinction: a Project viewer may READ the
        # occurrences (GET answers 200) but rescheduling is a write
        # operation and must answer 403 without persisting anything.
        recurrence = self._project_recurrence()
        occurrence = self._occurrence(recurrence)
        meeting = self._materialize(recurrence, occurrence)
        self.login(self.laura)
        read = self.client.get(
            f"/api/meeting-recurrences/{recurrence.pk}/occurrences/",
            {
                "from": _utc(2026, 1, 5, 0, 0).isoformat(),
                "to": _utc(2026, 1, 7, 0, 0).isoformat(),
            },
        )
        self.assertEqual(read.status_code, status.HTTP_200_OK)

        response = self._post(
            self._payload(occurrence, _utc(2026, 3, 15, 14, 0).isoformat()),
            recurrence,
        )
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        meeting.refresh_from_db()
        self.assertEqual(
            meeting.scheduled_at, occurrence.original_start,
        )

    def test_group_member_without_project_access_gets_404(self):
        # maria is a group member but has no Project membership: the
        # Project recurrence is invisible to her (non-leaking 404,
        # not a 403).
        recurrence = self._project_recurrence()
        self.login(self.maria)
        occurrence = self._occurrence(recurrence)
        response = self._post(
            self._payload(occurrence, _utc(2026, 3, 15, 14, 0).isoformat()),
            recurrence,
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_archived_project_blocks_reschedule(self):
        recurrence = self._project_recurrence()
        occurrence = self._occurrence(recurrence)
        meeting = self._materialize(recurrence, occurrence)
        archive_project(project=self.project, actor=self.alex)
        # Re-load as a real request would: the creation return value
        # still caches the pre-archive Project instance.
        recurrence = MeetingRecurrence.objects.get(pk=recurrence.pk)
        self.login(self.chris)

        response = self._post(
            self._payload(occurrence, _utc(2026, 3, 15, 14, 0).isoformat()),
            recurrence,
        )
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        meeting.refresh_from_db()
        self.assertEqual(
            meeting.scheduled_at, occurrence.original_start,
        )

    # ── 5. Virtual occurrence: materialize-then-move ─────────────

    def test_virtual_occurrence_reschedule_materializes_then_moves(self):
        # A still-virtual occurrence is materialized by the canonical
        # idempotent path, then moved — in one request.
        self.login(self.chris)
        occurrence = self._occurrence()
        new_time = _utc(2026, 3, 15, 14, 0)
        rule_before = self._recurrence_rule_snapshot(self.recurrence)

        response = self._post(
            self._payload(occurrence, new_time.isoformat()),
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        self.assertEqual(data["title"], "Materialized")
        self.assertEqual(data["scheduledAt"], self._utc_iso(new_time))

        # Exactly ONE concrete Meeting was created, with the
        # recurrence provenance and the immutable original start —
        # no adjacent/future occurrence was materialized.
        self.assertEqual(Meeting.objects.count(), 1)
        meeting = Meeting.objects.get()
        self.assertEqual(meeting.id, data["id"])
        self.assertEqual(meeting.recurrence_id, self.recurrence.pk)
        self.assertEqual(
            meeting.original_scheduled_at, occurrence.original_start,
        )
        self.assertEqual(meeting.scheduled_at, new_time)
        self.assertEqual(meeting.status, Meeting.Status.UPCOMING)
        self.assertEqual(meeting.meeting_sections.count(), 1)
        self.assertEqual(
            MeetingParticipant.objects.filter(meeting=meeting).count(),
            1,
        )
        # The parent recurrence rule was not mutated.
        self.recurrence.refresh_from_db()
        self.assertEqual(
            self._recurrence_rule_snapshot(self.recurrence), rule_before,
        )
        # One meeting.created (materialization) + one
        # meeting.rescheduled (the move), nothing else.
        self.assertEqual(
            AuditEvent.objects.filter(
                meeting=meeting,
                event_type=MeetingAuditEventType.CREATED,
            ).count(),
            1,
        )
        rescheduled = AuditEvent.objects.filter(
            meeting=meeting,
            event_type=MeetingAuditEventType.RESCHEDULED,
        ).order_by("id")
        self.assertEqual(rescheduled.count(), 1)
        self.assertEqual(
            rescheduled.get().data["changes"]["scheduledAt"]["to"],
            new_time.astimezone(UTC).isoformat(),
        )

        # The occurrence GET reports the original identity, now
        # materialized with the same meetingId; the other occurrences
        # in the window are still virtual.
        read = self.client.get(
            f"/api/meeting-recurrences/{self.recurrence.pk}/occurrences/",
            {
                "from": _utc(2026, 1, 5, 0, 0).isoformat(),
                "to": _utc(2026, 1, 9, 0, 0).isoformat(),
            },
        )
        self.assertEqual(read.status_code, status.HTTP_200_OK)
        items = {
            item["occurrenceId"]: item for item in read.json()
        }
        target = items[str(occurrence.occurrence_id)]
        self.assertTrue(target["materialized"])
        self.assertEqual(target["meetingId"], meeting.pk)
        self.assertEqual(
            target["originalScheduledAt"], self._utc_iso(occurrence),
        )
        for other_id, other in items.items():
            if other_id != str(occurrence.occurrence_id):
                self.assertFalse(other["materialized"])
                self.assertIsNone(other["meetingId"])
        # The moved time is the Meeting's current scheduledAt.
        detail = self.client.get(f"/api/meetings/{meeting.pk}/")
        self.assertEqual(detail.status_code, status.HTTP_200_OK)
        self.assertEqual(
            detail.json()["scheduledAt"], self._utc_iso(new_time),
        )

    def test_virtual_reschedule_repeated_identical_request_reuses_same_meeting(
        self,
    ):
        # Idempotency: repeating the same request operates on the SAME
        # Meeting row — the second identical move is a no-op, so no
        # duplicate structure or duplicate semantic events.
        self.login(self.chris)
        occurrence = self._occurrence()
        new_time = _utc(2026, 3, 15, 14, 0)

        first = self._post(
            self._payload(occurrence, new_time.isoformat()),
        )
        second = self._post(
            self._payload(occurrence, new_time.isoformat()),
        )
        self.assertEqual(first.status_code, status.HTTP_200_OK)
        self.assertEqual(second.status_code, status.HTTP_200_OK)
        self.assertEqual(first.json()["id"], second.json()["id"])

        counts = self._persistence_counts()
        self.assertEqual(counts["meetings"], 1)
        self.assertEqual(counts["sections"], 1)
        self.assertEqual(counts["participants"], 1)
        self.assertEqual(
            AuditEvent.objects.filter(
                event_type=MeetingAuditEventType.CREATED,
            ).count(),
            1,
        )
        self.assertEqual(
            AuditEvent.objects.filter(
                event_type=MeetingAuditEventType.RESCHEDULED,
            ).count(),
            1,
        )

    def test_virtual_reschedule_repeated_new_times_moves_same_meeting(self):
        # Monday 10:00 → Tuesday 14:00 → Wednesday 09:00: the SAME
        # row moves each time; only scheduled_at changes.
        self.login(self.chris)
        occurrence = self._occurrence()

        first = self._post(
            self._payload(occurrence, _utc(2026, 3, 1, 14, 0).isoformat()),
        )
        second = self._post(
            self._payload(occurrence, _utc(2026, 3, 2, 9, 0).isoformat()),
        )
        self.assertEqual(first.status_code, status.HTTP_200_OK)
        self.assertEqual(second.status_code, status.HTTP_200_OK)
        self.assertEqual(first.json()["id"], second.json()["id"])

        meeting = Meeting.objects.get()
        self.assertEqual(
            meeting.scheduled_at, _utc(2026, 3, 2, 9, 0),
        )
        self.assertEqual(
            meeting.original_scheduled_at, occurrence.original_start,
        )
        self.assertEqual(Meeting.objects.count(), 1)
        self.assertEqual(
            AuditEvent.objects.filter(
                event_type=MeetingAuditEventType.CREATED,
            ).count(),
            1,
        )
        self.assertEqual(
            AuditEvent.objects.filter(
                event_type=MeetingAuditEventType.RESCHEDULED,
            ).count(),
            2,
        )

    def test_read_only_actor_cannot_trigger_materialization(self):
        # A Project viewer may read the occurrences but the reschedule
        # write (which would also materialize) must answer 403 and
        # create nothing.
        recurrence = self._project_recurrence()
        occurrence = self._occurrence(recurrence)
        self.login(self.laura)
        read = self.client.get(
            f"/api/meeting-recurrences/{recurrence.pk}/occurrences/",
            {
                "from": _utc(2026, 1, 5, 0, 0).isoformat(),
                "to": _utc(2026, 1, 7, 0, 0).isoformat(),
            },
        )
        self.assertEqual(read.status_code, status.HTTP_200_OK)

        response = self._post(
            self._payload(occurrence, _utc(2026, 3, 15, 14, 0).isoformat()),
            recurrence,
        )
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(Meeting.objects.count(), 0)
        self.assertEqual(AuditEvent.objects.count(), 0)

    def test_forged_occurrence_on_virtual_series_creates_no_meeting(self):
        # A self-consistent forged pair on a fully virtual series must
        # be rejected BEFORE any Meeting is created.
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
                "scheduledAt": _utc(2026, 3, 15, 14, 0).isoformat(),
                "title": "Forged",
            },
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Meeting.objects.count(), 0)
        self.assertEqual(AuditEvent.objects.count(), 0)

    # ── 5a. Title contract ───────────────────────────────────────

    def test_virtual_reschedule_persists_the_requested_title(self):
        self.login(self.chris)
        occurrence = self._occurrence()

        response = self._post(
            self._payload(
                occurrence, _utc(2026, 3, 15, 14, 0).isoformat(),
                title="January 5 Standup",
            ),
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            Meeting.objects.get().title, "January 5 Standup",
        )

    def test_materialized_reschedule_ignores_the_request_title(self):
        # A reschedule never renames an existing Meeting, even though
        # the title is part of the request contract.
        self.login(self.chris)
        occurrence = self._occurrence()
        self._materialize(self.recurrence, occurrence)
        meeting = Meeting.objects.get()
        meeting.title = "Original title"
        meeting.save(update_fields=["title"])

        response = self._post(
            self._payload(
                occurrence, _utc(2026, 3, 15, 14, 0).isoformat(),
                title="Renamed by reschedule",
            ),
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.json()["title"], "Original title")
        self.assertEqual(
            Meeting.objects.get(pk=meeting.pk).title, "Original title",
        )

    def test_missing_title_is_rejected_and_persists_nothing(self):
        self.login(self.chris)
        occurrence = self._occurrence()  # still virtual
        response = self._post(
            {
                "occurrenceId": str(occurrence.occurrence_id),
                "originalScheduledAt": self._utc_iso(occurrence),
                "scheduledAt": _utc(2026, 3, 15, 14, 0).isoformat(),
            },
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("title", response.json())
        self.assertEqual(Meeting.objects.count(), 0)

    def test_blank_title_is_rejected_and_persists_nothing(self):
        self.login(self.chris)
        occurrence = self._occurrence()  # still virtual
        response = self._post(
            self._payload(
                occurrence, _utc(2026, 3, 15, 14, 0).isoformat(),
                title="   ",
            ),
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("title", response.json())
        self.assertEqual(Meeting.objects.count(), 0)

    # ── 6. Server-side occurrence validation ─────────────────────

    def test_mismatched_occurrence_identity_is_rejected(self):
        # The identity of the Jan 7 occurrence paired with the Jan 6
        # original start: the pair is mutually inconsistent.
        self.login(self.chris)
        jan6 = self._occurrence(local="2026-01-06T09:30:00")
        jan7 = self._occurrence(local="2026-01-07T09:30:00")
        self._materialize(self.recurrence, jan6)

        response = self._post(
            {
                "occurrenceId": str(jan7.occurrence_id),
                "originalScheduledAt": self._utc_iso(jan6),
                "scheduledAt": _utc(2026, 3, 15, 14, 0).isoformat(),
                "title": "Materialized",
            },
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("error", response.json())
        jan6_meeting = Meeting.objects.get(
            recurrence=self.recurrence,
            original_scheduled_at=jan6.original_start,
        )
        self.assertEqual(
            jan6_meeting.scheduled_at, jan6.original_start,
        )

    def test_foreign_recurrence_identity_is_rejected(self):
        # A genuine occurrence of a DIFFERENT schedule (same rule,
        # different schedule id → different identity) must not be
        # reschedulable through this recurrence.
        self.login(self.chris)
        second = self._create_recurrence()  # same rule, different id
        self.assertNotEqual(second.pk, self.recurrence.pk)

        foreign = self._occurrence(second, local="2026-01-06T09:30:00")
        own = self._occurrence(local="2026-01-06T09:30:00")
        self.assertNotEqual(foreign.occurrence_id, own.occurrence_id)
        self._materialize(self.recurrence, own)

        response = self._post(
            {
                "occurrenceId": str(foreign.occurrence_id),
                "originalScheduledAt": self._utc_iso(own),
                "scheduledAt": _utc(2026, 3, 15, 14, 0).isoformat(),
                "title": "Materialized",
            },
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(
            Meeting.objects.get().scheduled_at, own.original_start,
        )

    def test_original_start_the_rule_never_produces_is_rejected(self):
        # A self-consistent forged pair: the identity matches the
        # supplied (wrong) wall-clock time, but the rule never
        # produces 10:00 — the Meeting must not be moved.
        self.login(self.chris)
        own = self._occurrence()
        self._materialize(self.recurrence, own)
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
                "scheduledAt": _utc(2026, 3, 15, 14, 0).isoformat(),
                "title": "Materialized",
            },
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(
            Meeting.objects.get().scheduled_at, own.original_start,
        )

    def test_occurrence_before_the_first_occurrence_is_rejected(self):
        self.login(self.chris)
        first = self._occurrence(local="2026-01-05T09:30:00")
        self._materialize(self.recurrence, first)
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
                "scheduledAt": _utc(2026, 3, 15, 14, 0).isoformat(),
                "title": "Materialized",
            },
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(
            Meeting.objects.get().scheduled_at, first.original_start,
        )

    def test_occurrence_beyond_the_count_contract_is_rejected(self):
        # count=2 → only Jan 5 and Jan 6 exist for the rule.
        recurrence = self._create_recurrence(
            end_mode="count", occurrence_count=2,
        )
        self.login(self.chris)
        first = self._occurrence(recurrence, local="2026-01-05T09:30:00")
        self._materialize(recurrence, first)
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
                "scheduledAt": _utc(2026, 3, 15, 14, 0).isoformat(),
                "title": "Materialized",
            },
            recurrence,
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(
            Meeting.objects.get().scheduled_at, first.original_start,
        )

    def test_occurrence_beyond_the_end_date_contract_is_rejected(self):
        recurrence = self._create_recurrence(
            end_mode="end_date",
            end_date=datetime(2026, 1, 6).date(),
        )
        self.login(self.chris)
        first = self._occurrence(recurrence, local="2026-01-05T09:30:00")
        self._materialize(recurrence, first)
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
                "scheduledAt": _utc(2026, 3, 15, 14, 0).isoformat(),
                "title": "Materialized",
            },
            recurrence,
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(
            Meeting.objects.get().scheduled_at, first.original_start,
        )

    # ── 7. Request input validation ──────────────────────────────

    def test_naive_original_scheduled_at_is_rejected(self):
        self.login(self.chris)
        occurrence = self._occurrence()
        self._materialize(self.recurrence, occurrence)
        response = self._post(
            {
                "occurrenceId": str(occurrence.occurrence_id),
                "originalScheduledAt": "2026-01-06T09:30:00",
                "scheduledAt": _utc(2026, 3, 15, 14, 0).isoformat(),
                "title": "Materialized",
            },
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("originalScheduledAt", response.json())

    def test_naive_scheduled_at_is_rejected(self):
        self.login(self.chris)
        occurrence = self._occurrence()
        self._materialize(self.recurrence, occurrence)
        response = self._post(
            {
                "occurrenceId": str(occurrence.occurrence_id),
                "originalScheduledAt": self._utc_iso(occurrence),
                "scheduledAt": "2026-03-15T14:00:00",
                "title": "Materialized",
            },
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("scheduledAt", response.json())

    def test_missing_fields_are_rejected(self):
        self.login(self.chris)
        response = self._post({})
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        errors = response.json()
        self.assertIn("occurrenceId", errors)
        self.assertIn("originalScheduledAt", errors)
        self.assertIn("scheduledAt", errors)
        self.assertIn("title", errors)

    def test_invalid_occurrence_id_is_rejected(self):
        self.login(self.chris)
        occurrence = self._occurrence()
        self._materialize(self.recurrence, occurrence)
        response = self._post(
            {
                "occurrenceId": "not-a-uuid",
                "originalScheduledAt": self._utc_iso(occurrence),
                "scheduledAt": _utc(2026, 3, 15, 14, 0).isoformat(),
                "title": "Materialized",
            },
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("occurrenceId", response.json())

    def test_same_instant_with_different_offsets_is_the_same_occurrence(
        self,
    ):
        self.login(self.chris)
        occurrence = self._occurrence()
        self._materialize(self.recurrence, occurrence)
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
                "scheduledAt": _utc(2026, 3, 15, 14, 0).isoformat(),
                "title": "Materialized",
            },
        )
        self.assertEqual(first.status_code, status.HTTP_200_OK)

        # A second offset representation of the same original instant
        # still addresses the same occurrence.
        second = self._post(
            self._payload(occurrence, _utc(2026, 3, 16, 9, 0).isoformat()),
        )
        self.assertEqual(second.status_code, status.HTTP_200_OK)
        self.assertEqual(
            second.json()["id"], first.json()["id"],
        )
        self.assertEqual(Meeting.objects.count(), 1)

    # ── 8. The new time is not constrained by the rule ───────────

    def test_new_time_may_differ_from_the_recurrence_pattern(self):
        # The point of a single-occurrence move: the new planned time
        # need not match the rule's wall-clock time or weekday.
        self.login(self.chris)
        occurrence = self._occurrence()
        meeting = self._materialize(self.recurrence, occurrence)
        # Jan 5 (a Sunday) at 23:45 — neither the rule's day nor time.
        moved = _utc(2026, 1, 5, 22, 45)

        response = self._post(
            self._payload(occurrence, moved.isoformat()),
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        meeting.refresh_from_db()
        self.assertEqual(meeting.scheduled_at, moved)
        self.assertEqual(
            meeting.original_scheduled_at, occurrence.original_start,
        )
        # And a move far outside any occurrence window is fine too.
        far = (occurrence.original_start + timedelta(days=180))
        response = self._post(
            self._payload(occurrence, far.isoformat()),
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        meeting.refresh_from_db()
        self.assertEqual(meeting.scheduled_at, far)

    def test_excluded_virtual_occurrence_reschedule_rejected(self):
        """An excluded virtual occurrence cannot be rescheduled: the
        move would first materialize it through the canonical path,
        which the exclusion gates — no Meeting, no move, no events,
        and the exclusion survives the attempt."""
        self.login(self.alex)
        occurrence = self._occurrence()  # virtual, Jan 6
        exclusion = exclude_meeting_recurrence_occurrence(
            recurrence=self.recurrence,
            occurrence=occurrence,
            actor=self.alex,
        )
        moved = (occurrence.original_start + timedelta(hours=5))

        response = self._post(
            self._payload(occurrence, moved.isoformat()),
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("error", response.json())
        self.assertEqual(Meeting.objects.count(), 0)
        self.assertEqual(MeetingSection.objects.count(), 0)
        self.assertEqual(MeetingParticipant.objects.count(), 0)
        self.assertEqual(AuditEvent.objects.count(), 0)
        # The exclusion was not removed by the rejected reschedule.
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 1)
        self.assertEqual(
            MeetingRecurrenceExclusion.objects.get().pk, exclusion.pk,
        )
