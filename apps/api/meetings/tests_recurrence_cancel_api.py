"""Tests for the HTTP contract of cancelling ONE materialized recurring
occurrence ("only this meeting"): ``POST /api/meetings/{id}/cancel``.

The endpoint is a thin HTTP layer over the canonical domain operation
``cancel_meeting_recurrence_occurrence``: lifecycle validation,
exclusion persistence, idempotency, recurrence locking, authorization,
and the ``meeting.cancelled`` audit event all stay in the domain
service. The concrete ``Meeting`` is RETAINED with terminal
``cancelled`` status, and the response is the canonical Meeting
representation (``200`` for both the initial cancellation and an
idempotent replay).

Meeting-level read access is creator-or-participant, so the
write-authorized actors in these tests are the creator or an explicit
participant (the canonical Meeting access/resolution convention).
"""

import json
from datetime import datetime, timezone as dt_timezone
from zoneinfo import ZoneInfo

from audit_history.models import AuditEvent
from rest_framework import status
from rest_framework.test import APIClient

from projects.services import archive_project

from .models import (
    Meeting,
    MeetingParticipant,
    MeetingRecurrenceExclusion,
    MeetingSection,
)
from .services import (
    MeetingAuditEventType,
    add_meeting_participant,
    create_meeting,
    end_meeting,
    materialize_meeting_recurrence_occurrence,
    reschedule_meeting_recurrence_occurrence,
    start_meeting,
)
from .tests_recurrence import MeetingRecurrenceBase, _utc

BERLIN = ZoneInfo("Europe/Berlin")
UTC = dt_timezone.utc


class MeetingRecurrenceCancelApiBase(MeetingRecurrenceBase):
    """Shared helpers for the materialized-occurrence cancel API.

    The base recurrence is DAILY 09:30 Berlin, first occurrence
    2026-01-05 (Monday), no end: occurrences on 01-05, 01-06, 01-07,
    01-08, 01-09, ...
    """

    def setUp(self):
        super().setUp()
        self.client = APIClient()
        self.recurrence = self._create_recurrence()

    def login(self, user):
        self.client.logout()
        self.client.force_login(user)

    def _path(self, meeting):
        return f"/api/meetings/{meeting.pk}/cancel"

    def _occurrence(self, local="2026-01-06T09:30:00"):
        """The rule-produced occurrence at the given local wall-clock
        start (an inclusive one-instant window)."""
        tz = ZoneInfo(self.recurrence.timezone_name)
        instant = datetime.fromisoformat(local).replace(tzinfo=tz)
        (occurrence,) = self._expand(self.recurrence, instant, instant)
        return occurrence

    def _materialize(
        self,
        local="2026-01-06T09:30:00",
        *,
        recurrence=None,
        actor=None,
        title="Materialized",
    ):
        recurrence = recurrence if recurrence is not None else self.recurrence
        tz = ZoneInfo(recurrence.timezone_name)
        instant = datetime.fromisoformat(local).replace(tzinfo=tz)
        (occurrence,) = self._expand(recurrence, instant, instant)
        return materialize_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=occurrence,
            actor=actor if actor is not None else self.alex,
            title=title,
        )

    def _project_recurrence(self):
        return self._create_recurrence(
            scope="project",
            project=self.project,
        )

    def _post_cancel(self, meeting):
        return self.client.post(
            self._path(meeting),
            data=json.dumps({}),
            content_type="application/json",
        )

    def _cancelled_events(self, meeting):
        return AuditEvent.objects.filter(
            event_type=MeetingAuditEventType.CANCELLED,
            meeting=meeting,
        )

    def _exclusions(self, recurrence=None):
        recurrence = recurrence if recurrence is not None else self.recurrence
        return MeetingRecurrenceExclusion.objects.filter(
            recurrence=recurrence,
        )

    def _utc_iso(self, dt):
        return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")

    def _stored_utc(self, dt):
        """The canonical persisted audit-event instant form."""
        return dt.astimezone(UTC).isoformat()

    def _occurrences_get(self, from_local, to_local):
        """Bounded occurrence read API as a logged-in group reader."""
        tz = ZoneInfo(self.recurrence.timezone_name)

        def aware(local):
            return datetime.fromisoformat(local).replace(tzinfo=tz)

        response = self.client.get(
            f"/api/meeting-recurrences/{self.recurrence.pk}/occurrences/",
            {
                "from": aware(from_local).isoformat(),
                "to": aware(to_local).isoformat(),
            },
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        return response.json()

    def _reported_locals(self, items):
        return {item["originalLocal"] for item in items}

    def _reported_item(self, items, local):
        (item,) = (i for i in items if i["originalLocal"] == local)
        return item


class MeetingRecurrenceCancelApiTest(MeetingRecurrenceCancelApiBase):
    """Authorized cancellation of an upcoming materialized occurrence."""

    def test_authorized_group_member_cancels_upcoming_materialized_occurrence(
        self,
    ):
        meeting = self._materialize()
        original = meeting.original_scheduled_at
        scheduled = meeting.scheduled_at
        # chris is a participant (canonical Meeting read access).
        add_meeting_participant(
            meeting=meeting, actor=self.alex, target_user=self.chris,
        )
        self.login(self.chris)

        response = self._post_cancel(meeting)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        # The response is the retained canonical Meeting
        # representation: same ID, terminal status, retained content.
        self.assertEqual(data["id"], meeting.pk)
        self.assertEqual(data["status"], "cancelled")
        self.assertEqual(data["title"], "Materialized")
        self.assertEqual(data["scheduledAt"], self._utc_iso(scheduled))
        self.assertEqual(data["researchGroupId"], self.group.pk)

        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.CANCELLED)
        self.assertEqual(meeting.original_scheduled_at, original)
        self.assertEqual(meeting.scheduled_at, scheduled)
        # Recurrence provenance is unchanged.
        self.assertEqual(meeting.recurrence_id, self.recurrence.pk)

    def test_cancellation_retains_meeting_content(self):
        meeting = self._materialize(title="Keep me")
        section_ids = list(
            MeetingSection.objects
            .filter(meeting=meeting)
            .values_list("pk", flat=True)
        )
        participant_ids = list(
            MeetingParticipant.objects
            .filter(meeting=meeting)
            .values_list("user_id", flat=True)
        )
        self.assertEqual(len(section_ids), 1)
        self.assertEqual(len(participant_ids), 1)

        self.login(self.alex)
        response = self._post_cancel(meeting)
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.assertTrue(Meeting.objects.filter(pk=meeting.pk).exists())
        meeting.refresh_from_db()
        self.assertEqual(meeting.title, "Keep me")
        self.assertEqual(
            list(
                MeetingSection.objects
                .filter(meeting=meeting)
                .values_list("pk", flat=True)
            ),
            section_ids,
        )
        self.assertEqual(
            list(
                MeetingParticipant.objects
                .filter(meeting=meeting)
                .values_list("user_id", flat=True)
            ),
            participant_ids,
        )

    def test_exactly_one_exclusion_keyed_by_original_scheduled_at(self):
        meeting = self._materialize()
        self.login(self.alex)
        self._post_cancel(meeting)

        exclusions = self._exclusions()
        self.assertEqual(exclusions.count(), 1)
        exclusion = exclusions.get()
        self.assertEqual(exclusion.recurrence_id, self.recurrence.pk)
        self.assertEqual(
            exclusion.original_scheduled_at,
            meeting.original_scheduled_at,
        )
        self.assertEqual(exclusion.created_by, self.alex)

    def test_first_cancellation_records_exactly_one_audit_event(self):
        meeting = self._materialize()
        self.login(self.alex)
        self._post_cancel(meeting)

        events = list(self._cancelled_events(meeting))
        self.assertEqual(len(events), 1)
        event = events[0]
        self.assertEqual(event.actor, self.alex)
        self.assertEqual(event.meeting, meeting)
        changes = event.data["changes"]
        self.assertEqual(
            changes["originalScheduledAt"],
            self._stored_utc(meeting.original_scheduled_at),
        )
        self.assertEqual(
            changes["scheduledAt"],
            self._stored_utc(meeting.scheduled_at),
        )

    def test_cancellation_creates_no_extra_meeting_or_rows(self):
        meeting = self._materialize()
        meetings_before = Meeting.objects.count()
        sections_before = MeetingSection.objects.count()
        participants_before = MeetingParticipant.objects.count()

        self.login(self.alex)
        self._post_cancel(meeting)

        self.assertEqual(Meeting.objects.count(), meetings_before)
        self.assertEqual(MeetingSection.objects.count(), sections_before)
        self.assertEqual(
            MeetingParticipant.objects.count(), participants_before,
        )
        # Materialization created one event; the cancellation added
        # exactly one more.
        self.assertEqual(AuditEvent.objects.filter(meeting=meeting).count(), 2)

    def test_cancelled_meeting_detail_read_still_works(self):
        meeting = self._materialize()
        self.login(self.alex)
        self._post_cancel(meeting)

        response = self.client.get(f"/api/meetings/{meeting.pk}/")
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        self.assertEqual(data["id"], meeting.pk)
        self.assertEqual(data["status"], "cancelled")

    def test_moved_occurrence_is_cancelled_by_original_identity(self):
        # Pinned API regression: original occurrence Monday 09:30,
        # Meeting moved to Tuesday 14:00, then cancelled over HTTP.
        occurrence = self._occurrence(local="2026-01-05T09:30:00")
        meeting = self._materialize(local="2026-01-05T09:30:00")
        moved_to = datetime(2026, 1, 6, 14, 0, tzinfo=BERLIN)
        reschedule_meeting_recurrence_occurrence(
            recurrence=self.recurrence,
            occurrence=occurrence,
            scheduled_at=moved_to,
            actor=self.alex,
            title="Moved",
        )
        meeting.refresh_from_db()
        self.assertEqual(meeting.scheduled_at, moved_to)

        self.login(self.alex)
        response = self._post_cancel(meeting)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.json()["id"], meeting.pk)

        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.CANCELLED)
        self.assertEqual(
            meeting.original_scheduled_at, occurrence.original_start,
        )
        self.assertEqual(meeting.scheduled_at, moved_to)
        exclusion = self._exclusions().get()
        # The exclusion is keyed to the ORIGINAL occurrence, never to
        # the moved time.
        self.assertEqual(
            exclusion.original_scheduled_at, occurrence.original_start,
        )
        self.assertNotEqual(
            exclusion.original_scheduled_at, moved_to,
        )


class MeetingRecurrenceCancelApiReplayTest(MeetingRecurrenceCancelApiBase):
    """Idempotent replay of the same cancellation POST."""

    def test_replay_succeeds_and_returns_the_same_meeting(self):
        meeting = self._materialize()
        self.login(self.alex)
        first = self._post_cancel(meeting)
        self.assertEqual(first.status_code, status.HTTP_200_OK)
        meeting.refresh_from_db()
        updated_at_after_first = meeting.updated_at

        replay = self._post_cancel(meeting)
        self.assertEqual(replay.status_code, status.HTTP_200_OK)
        self.assertEqual(replay.json(), first.json())
        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.CANCELLED)
        # The replay changes nothing on the Meeting row.
        self.assertEqual(meeting.updated_at, updated_at_after_first)

    def test_replay_creates_no_duplicate_exclusion(self):
        meeting = self._materialize()
        self.login(self.alex)
        self._post_cancel(meeting)
        first_exclusion = self._exclusions().get()

        replay = self._post_cancel(meeting)
        self.assertEqual(replay.status_code, status.HTTP_200_OK)

        self.assertEqual(self._exclusions().count(), 1)
        self.assertEqual(self._exclusions().get().pk, first_exclusion.pk)

    def test_replay_records_no_duplicate_event(self):
        meeting = self._materialize()
        self.login(self.alex)
        self._post_cancel(meeting)
        self.assertEqual(self._cancelled_events(meeting).count(), 1)

        replay = self._post_cancel(meeting)
        self.assertEqual(replay.status_code, status.HTTP_200_OK)
        self.assertEqual(self._cancelled_events(meeting).count(), 1)

    def test_replay_by_another_authorized_actor_is_idempotent(self):
        meeting = self._materialize()
        add_meeting_participant(
            meeting=meeting, actor=self.alex, target_user=self.chris,
        )
        self.login(self.alex)
        self._post_cancel(meeting)
        self.login(self.chris)
        replay = self._post_cancel(meeting)
        self.assertEqual(replay.status_code, status.HTTP_200_OK)
        self.assertEqual(replay.json()["id"], meeting.pk)
        self.assertEqual(replay.json()["status"], "cancelled")
        self.assertEqual(self._exclusions().count(), 1)
        self.assertEqual(self._cancelled_events(meeting).count(), 1)


class MeetingRecurrenceCancelApiLifecycleTest(MeetingRecurrenceCancelApiBase):
    """Lifecycle guard: only an upcoming materialized occurrence is
    cancellable; the terminal state stays terminal over HTTP."""

    def test_cancelling_a_standalone_meeting_is_rejected(self):
        meeting = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="Standalone",
            scheduled_at=_utc(2026, 2, 1, 10, 0),
        )
        self.login(self.alex)

        response = self._post_cancel(meeting)

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.UPCOMING)
        self.assertIsNone(meeting.recurrence_id)
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 0)
        self.assertEqual(self._cancelled_events(meeting).count(), 0)

    def test_cancelling_a_live_recurring_meeting_is_rejected(self):
        meeting = self._materialize()
        start_meeting(meeting=meeting, actor=self.alex)
        self.login(self.alex)

        response = self._post_cancel(meeting)

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.LIVE)
        self.assertEqual(self._exclusions().count(), 0)
        self.assertEqual(self._cancelled_events(meeting).count(), 0)

    def test_cancelling_a_completed_recurring_meeting_is_rejected(self):
        meeting = self._materialize()
        start_meeting(meeting=meeting, actor=self.alex)
        end_meeting(meeting=meeting, actor=self.alex)
        self.login(self.alex)

        response = self._post_cancel(meeting)

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.COMPLETED)
        self.assertEqual(self._exclusions().count(), 0)
        self.assertEqual(self._cancelled_events(meeting).count(), 0)

    def test_cancelled_meeting_rejects_lifecycle_actions(self):
        meeting = self._materialize()
        self.login(self.alex)
        self._post_cancel(meeting)

        for suffix in ("start", "end", "reopen"):
            response = self.client.post(
                f"/api/meetings/{meeting.pk}/{suffix}",
                data=json.dumps({}),
                content_type="application/json",
            )
            self.assertEqual(
                response.status_code, status.HTTP_400_BAD_REQUEST,
            )

        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.CANCELLED)


class MeetingRecurrenceCancelApiAuthorizationTest(MeetingRecurrenceCancelApiBase):
    """Cancellation is a Meeting write operation under the canonical
    Meeting access/resolution conventions."""

    def test_unauthenticated_request_is_rejected(self):
        meeting = self._materialize()
        response = self._post_cancel(meeting)
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.UPCOMING)
        self.assertEqual(self._exclusions().count(), 0)

    def test_outsider_gets_non_leaking_404(self):
        meeting = self._materialize()
        self.login(self.maria)
        response = self._post_cancel(meeting)
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(response.json(), {"error": "Meeting not found"})
        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.UPCOMING)
        self.assertEqual(self._exclusions().count(), 0)

    def test_unknown_meeting_returns_404(self):
        self.login(self.alex)
        response = self.client.post(
            "/api/meetings/999999/cancel",
            data=json.dumps({}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(response.json(), {"error": "Meeting not found"})

    def test_project_owner_can_cancel_project_occurrence(self):
        recurrence = self._project_recurrence()
        meeting = self._materialize(recurrence=recurrence)
        self.login(self.alex)
        response = self._post_cancel(meeting)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.CANCELLED)

    def test_project_member_can_cancel_project_occurrence(self):
        recurrence = self._project_recurrence()
        meeting = self._materialize(recurrence=recurrence)
        add_meeting_participant(
            meeting=meeting, actor=self.alex, target_user=self.chris,
        )
        self.login(self.chris)
        response = self._post_cancel(meeting)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.CANCELLED)

    def test_project_viewer_cannot_cancel(self):
        recurrence = self._project_recurrence()
        meeting = self._materialize(recurrence=recurrence)
        add_meeting_participant(
            meeting=meeting, actor=self.alex, target_user=self.laura,
        )
        self.login(self.laura)

        response = self._post_cancel(meeting)

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.UPCOMING)
        self.assertEqual(self._exclusions(recurrence).count(), 0)
        self.assertEqual(self._cancelled_events(meeting).count(), 0)

    def test_archived_project_cannot_cancel(self):
        recurrence = self._project_recurrence()
        meeting = self._materialize(recurrence=recurrence)
        archive_project(project=self.project, actor=self.alex)
        self.login(self.alex)

        response = self._post_cancel(meeting)

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.UPCOMING)
        self.assertEqual(self._exclusions(recurrence).count(), 0)


class MeetingRecurrenceCancelApiProtectionsTest(MeetingRecurrenceCancelApiBase):
    """The dedicated action is the ONLY cancellation path: PATCH cannot
    set the status and hard-delete still rejects recurring Meetings."""

    def test_patch_cannot_set_status_cancelled(self):
        meeting = self._materialize()
        self.login(self.alex)

        response = self.client.patch(
            f"/api/meetings/{meeting.pk}/",
            {"status": "cancelled"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.UPCOMING)
        self.assertEqual(self._exclusions().count(), 0)
        self.assertEqual(self._cancelled_events(meeting).count(), 0)

    def test_delete_still_rejects_recurring_meeting(self):
        meeting = self._materialize()
        self.login(self.alex)

        response = self.client.delete(f"/api/meetings/{meeting.pk}/")

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertTrue(Meeting.objects.filter(pk=meeting.pk).exists())
        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.UPCOMING)
        self.assertEqual(meeting.title, "Materialized")
        self.assertEqual(self._exclusions().count(), 0)

    def test_delete_standalone_meeting_keeps_existing_behavior(self):
        meeting = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="Standalone",
            scheduled_at=_utc(2026, 2, 1, 10, 0),
        )
        self.login(self.alex)

        response = self.client.delete(f"/api/meetings/{meeting.pk}/")

        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Meeting.objects.filter(pk=meeting.pk).exists())


class MeetingRecurrenceCancelApiOccurrenceGetTest(MeetingRecurrenceCancelApiBase):
    """After an HTTP cancellation the bounded occurrence read API shows
    the established effective recurrence behavior."""

    def _window_items(self):
        self.login(self.alex)
        return self._occurrences_get("2026-01-04T00:00:00", "2026-01-09T23:59:00")

    def test_cancelled_occurrence_is_absent_and_siblings_unchanged(self):
        meeting = self._materialize(local="2026-01-06T09:30:00")
        self.login(self.alex)
        self._post_cancel(meeting)

        items = self._window_items()
        locals_reported = self._reported_locals(items)
        # The cancelled original occurrence is absent.
        self.assertNotIn("2026-01-06T09:30:00", locals_reported)
        # Siblings are unchanged and still virtual.
        self.assertEqual(
            locals_reported,
            {
                "2026-01-05T09:30:00",
                "2026-01-07T09:30:00",
                "2026-01-08T09:30:00",
                "2026-01-09T09:30:00",
            },
        )
        for local in (
            "2026-01-05T09:30:00",
            "2026-01-07T09:30:00",
            "2026-01-08T09:30:00",
            "2026-01-09T09:30:00",
        ):
            item = self._reported_item(items, local)
            self.assertFalse(item["materialized"])
            self.assertIsNone(item["meetingId"])

    def test_materialized_sibling_still_reported_after_cancellation(self):
        sibling = self._materialize(local="2026-01-05T09:30:00")
        cancelled = self._materialize(local="2026-01-06T09:30:00")
        self.login(self.alex)
        self._post_cancel(cancelled)

        items = self._window_items()
        self.assertNotIn("2026-01-06T09:30:00", self._reported_locals(items))
        item = self._reported_item(items, "2026-01-05T09:30:00")
        self.assertTrue(item["materialized"])
        self.assertEqual(item["meetingId"], sibling.pk)

    def test_count_recurrence_does_not_generate_a_replacement(self):
        recurrence = self._create_recurrence(
            end_mode="count", occurrence_count=3,
        )
        meeting = self._materialize(
            local="2026-01-06T09:30:00", recurrence=recurrence,
        )
        self.login(self.alex)
        self._post_cancel(meeting)

        tz = ZoneInfo(recurrence.timezone_name)
        response = self.client.get(
            f"/api/meeting-recurrences/{recurrence.pk}/occurrences/",
            {
                "from": datetime(2026, 1, 4, tzinfo=tz).isoformat(),
                "to": datetime(2026, 1, 10, 23, 59, tzinfo=tz).isoformat(),
            },
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        locals_reported = self._reported_locals(response.json())
        # The excluded day drops out; day 4 is NOT generated as a
        # replacement of the count-limited series.
        self.assertEqual(
            locals_reported,
            {"2026-01-05T09:30:00", "2026-01-07T09:30:00"},
        )

    def test_no_neighboring_meeting_is_materialized(self):
        meeting = self._materialize(local="2026-01-06T09:30:00")
        meetings_before = Meeting.objects.count()
        self.login(self.alex)
        self._post_cancel(meeting)

        self.assertEqual(Meeting.objects.count(), meetings_before)
        recurring = list(
            Meeting.objects.filter(recurrence_id=self.recurrence.pk)
        )
        self.assertEqual(recurring, [meeting])
        self.assertEqual(
            [m.original_scheduled_at for m in recurring],
            [meeting.original_scheduled_at],
        )
