"""API tests for the whole-series termination endpoint and the
personal Series overview's ``canTerminate`` permission report.

``POST /api/meeting-recurrences/{recurrence_id}/terminate``
permanently terminates the WHOLE recurring series through the
canonical domain operation ``terminate_meeting_recurrence``: the
request carries NO payload (the recurrence id is the entire input),
the recurrence is resolved through the canonical recurrence read
rule (unknown or inaccessible ids answer a non-leaking 404), the
canonical scoped recurrence write rule is enforced read-side
(readable but not writable answers the established 403 mutation
response), and the view delegates ENTIRELY to the domain operation,
which remains the final authority on terminal-state persistence,
the one observed termination instant, future-occurrence
suppression, the future-Meeting cancellation cutoff, idempotency,
locking, and concurrency. The response is a stable, idempotent
204 No Content for BOTH the first successful termination and an
authorized replay; a domain error answers the established
structured 400 error contract.

``GET /api/meeting-recurrences/`` additionally reports
``canTerminate`` per row: the canonical scoped recurrence write
rule of the series' scope (the SAME rule the termination endpoint
enforces), computed from ONE batched membership-state load —
constant in the number of rows, never inferred from creator
identity or personal relevance.

Time is frozen for every test: the repository's single
clock-observation convention — ``meetings.services.
_termination_instant`` (the termination operation's one observed
instant) and ``meetings.services._current_instant`` (the
read-model's now) are both patched to the shared
``TERMINATED_AT`` observation. The domain concurrency suite
(``tests_recurrence_terminate.py``) remains the authority on the
atomic operation itself; this file only pins the HTTP boundary.
"""

import json
from datetime import time
from unittest import mock
from zoneinfo import ZoneInfo

from audit_history.models import AuditEvent
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext

from rest_framework import status
from rest_framework.test import APIClient

from projects.models import ProjectMembership
from projects.services import archive_project, remove_membership
from research_groups.models import ResearchGroupMembership
from research_groups.services import remove_research_group_membership

from .models import (
    Meeting,
    MeetingParticipant,
    MeetingRecurrence,
    MeetingRecurrenceExclusion,
    MeetingSection,
)
from .services import (
    MeetingAuditEventType,
    end_meeting,
    materialize_meeting_recurrence_occurrence,
    start_meeting,
)
from .tests_recurrence import MeetingRecurrenceBase, _utc
from .tests_recurrence_terminate import TERMINATED_AT

User = get_user_model()
UTC = ZoneInfo("UTC")

OVERVIEW_PATH = "/api/meeting-recurrences/"
FEED_PATH = "/api/meeting-recurrences/occurrences/"


class MeetingRecurrenceTerminateApiBase(MeetingRecurrenceBase):
    """Shared helpers: the frozen clock observations and one group-
    scoped fixture recurrence (daily 09:30 Berlin, first occurrence
    Monday 2026-01-05, no end) with chris as a persisted intended
    participant.

    Relative to ``TERMINATED_AT`` (Thursday 2026-01-08 12:00 UTC)
    the fixture has: Jan 5..Jan 8 occurrences BEFORE the instant,
    Jan 9+ occurrences after it.
    """

    def setUp(self):
        super().setUp()
        self.client = APIClient()
        self._termination_clock = mock.patch(
            "meetings.services._termination_instant",
            return_value=TERMINATED_AT,
        )
        self._termination_clock.start()
        self.addCleanup(self._termination_clock.stop)
        self._now_clock = mock.patch(
            "meetings.services._current_instant",
            return_value=TERMINATED_AT,
        )
        self._now_clock.start()
        self.addCleanup(self._now_clock.stop)
        self.recurrence = self._create_recurrence(participants=(self.chris,))

    def login(self, user):
        self.client.logout()
        self.client.force_login(user)

    def _path(self, recurrence=None):
        recurrence = (
            recurrence if recurrence is not None else self.recurrence
        )
        return f"/api/meeting-recurrences/{recurrence.pk}/terminate"

    def _post(self, recurrence=None):
        return self.client.post(self._path(recurrence))

    def _occurrence_on(self, recurrence, day):
        """The rule-produced occurrence whose local date is ``day``."""
        (occurrence,) = self._expand(
            recurrence,
            _utc(*day),
            _utc(day[0], day[1], day[2], 23, 59),
        )
        return occurrence

    def _occurrence_utc_iso(self, occurrence):
        return (
            occurrence.original_start.astimezone(UTC)
            .isoformat()
            .replace("+00:00", "Z")
        )

    def _materialize(self, recurrence, occurrence, *, title="Mat"):
        return materialize_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=occurrence,
            actor=self.alex,
            title=title,
        )

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
        jan5 = self._materialize(
            recurrence, self._occurrence_on(recurrence, (2026, 1, 5)),
        )
        start_meeting(meeting=jan5, actor=self.alex)
        end_meeting(meeting=jan5, actor=self.alex)
        jan6 = self._materialize(
            recurrence, self._occurrence_on(recurrence, (2026, 1, 6)),
        )
        start_meeting(meeting=jan6, actor=self.alex)
        jan7 = self._materialize(
            recurrence, self._occurrence_on(recurrence, (2026, 1, 7)),
        )
        jan8 = self._materialize(
            recurrence, self._occurrence_on(recurrence, (2026, 1, 8)),
        )
        jan9 = self._materialize(
            recurrence, self._occurrence_on(recurrence, (2026, 1, 9)),
        )
        jan10 = self._materialize(
            recurrence, self._occurrence_on(recurrence, (2026, 1, 10)),
        )
        return {
            "jan5": jan5,
            "jan6": jan6,
            "jan7": jan7,
            "jan8": jan8,
            "jan9": jan9,
            "jan10": jan10,
        }

    def _overview(self):
        return self.client.get(OVERVIEW_PATH)

    def _overview_row(self, response, recurrence):
        rows = [row for row in response.json() if row["id"] == recurrence.pk]
        self.assertEqual(len(rows), 1)
        return rows[0]

    def _feed(self, from_dt, to_dt):
        return self.client.get(
            FEED_PATH,
            {"from": from_dt.isoformat(), "to": to_dt.isoformat()},
        )

    def _persistence_state(self, recurrence=None):
        recurrence = (
            recurrence if recurrence is not None else self.recurrence
        )
        fresh = MeetingRecurrence.objects.get(pk=recurrence.pk)
        return {
            "terminated_at": fresh.terminated_at,
            "updated_at": fresh.updated_at,
            "title": fresh.title,
            "rule": (
                fresh.frequency,
                fresh.interval,
                fresh.weekdays,
                fresh.start_date,
                fresh.local_time,
                fresh.timezone_name,
                fresh.end_mode,
                fresh.end_date,
                fresh.occurrence_count,
                fresh.series_id,
                fresh.created_by_id,
            ),
            "meetings": list(
                Meeting.objects.order_by("pk").values_list(
                    "pk", "status", "scheduled_at", "title",
                )
            ),
            "sections": MeetingSection.objects.count(),
            "participants": MeetingParticipant.objects.count(),
            "exclusions": list(
                MeetingRecurrenceExclusion.objects.order_by("pk")
                .values_list("recurrence_id", "original_scheduled_at")
            ),
            "cancelled_events": list(
                AuditEvent.objects.filter(
                    event_type=MeetingAuditEventType.CANCELLED,
                )
                .order_by("pk")
                .values_list("meeting_id", flat=True)
            ),
        }


class MeetingRecurrenceTerminateApiTest(MeetingRecurrenceTerminateApiBase):
    """The HTTP boundary of whole-series termination."""

    # ── 1. Route resolution and authentication ───────────────────

    def test_anonymous_request_is_rejected(self):
        response = self._post()
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertIsNone(
            MeetingRecurrence.objects.get(pk=self.recurrence.pk).terminated_at
        )

    def test_route_resolves_but_rejects_wrong_method(self):
        # The terminate action is POST-only; a GET on the same
        # (slashless) route answers 405, never a redirect or 404.
        self.login(self.chris)
        response = self.client.get(self._path())
        self.assertEqual(response.status_code, status.HTTP_405_METHOD_NOT_ALLOWED)
        self.assertIsNone(
            MeetingRecurrence.objects.get(pk=self.recurrence.pk).terminated_at
        )

    # ── 2. Non-leaking denial ────────────────────────────────────

    def test_unknown_recurrence_returns_404(self):
        self.login(self.chris)
        response = self.client.post("/api/meeting-recurrences/999999/terminate")
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(
            response.json(), {"error": "Meeting recurrence not found"},
        )

    def test_inaccessible_recurrence_returns_the_same_404(self):
        # maria is an outsider: the denial is INDISTINGUISHABLE from
        # an unknown id (no existence, title, or scope leak).
        self.login(self.maria)
        response = self._post()
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(
            response.json(), {"error": "Meeting recurrence not found"},
        )
        self.assertIsNone(
            MeetingRecurrence.objects.get(pk=self.recurrence.pk).terminated_at
        )

    def test_project_viewer_denied_403(self):
        # A Project viewer may READ the series but termination is a
        # write operation: 403 without persisting anything.
        recurrence = self._create_recurrence(
            scope="project", project=self.project,
            participants=(self.laura,),
        )
        self.login(self.laura)
        before = self._persistence_state(recurrence)
        response = self._post(recurrence)
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(
            response.json(),
            {
                "error": (
                    "You do not have permission to modify "
                    "this Project Meeting resource."
                )
            },
        )
        self.assertEqual(self._persistence_state(recurrence), before)

    def test_archived_project_denied_403(self):
        recurrence = self._create_recurrence(
            scope="project", project=self.project,
            participants=(self.chris,),
        )
        archive_project(project=self.project, actor=self.alex)
        # Re-load as a real request would: the creation return value
        # still caches the pre-archive Project instance.
        recurrence = MeetingRecurrence.objects.get(pk=recurrence.pk)
        self.login(self.chris)
        # Baseline AFTER the archive: the archive itself records a
        # project audit event, which is unrelated to this endpoint.
        before = self._persistence_state(recurrence)

        response = self._post(recurrence)
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(self._persistence_state(recurrence), before)

    def test_revoked_membership_denied_404(self):
        # A revoked member lost READ access: the recurrence is
        # unreadable, so the endpoint answers the SAME non-leaking
        # 404 as an unknown id — for both scopes.
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

        for recurrence in (
            self.recurrence,  # group scope
            self._create_recurrence(
                title="Project Sync", scope="project",
                project=self.project,
            ),  # project scope
        ):
            with self.subTest(recurrence=recurrence.pk):
                self.login(self.chris)
                before = self._persistence_state(recurrence)
                response = self._post(recurrence)
                self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
                self.assertEqual(
                    response.json(),
                    {"error": "Meeting recurrence not found"},
                )
                self.assertEqual(
                    self._persistence_state(recurrence), before,
                )

    # ── 3. Authorized termination: group and Project scopes ─────

    def test_group_member_termination_returns_204_with_empty_body(self):
        # chris is a current Research Group member (not the
        # creator): group scope grants termination.
        self.login(self.chris)
        response = self._post()
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        # A stable bodyless contract: 204 carries no representation.
        self.assertEqual(response.content, b"")

        fresh = MeetingRecurrence.objects.get(pk=self.recurrence.pk)
        self.assertEqual(fresh.terminated_at, TERMINATED_AT)

    def test_project_owner_and_member_can_terminate(self):
        owned = self._create_recurrence(
            title="Planning", scope="project", project=self.project,
        )
        self.login(self.alex)
        response = self._post(owned)
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(
            MeetingRecurrence.objects.get(pk=owned.pk).terminated_at,
            TERMINATED_AT,
        )

        member = self._create_recurrence(
            title="Sprint Sync", scope="project", project=self.project,
            local_time=time(16, 0),
        )
        self.login(self.chris)
        response = self._post(member)
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(
            MeetingRecurrence.objects.get(pk=member.pk).terminated_at,
            TERMINATED_AT,
        )

    def test_group_member_termination_cancels_future_and_preserves_history(
        self,
    ):
        meetings = self._full_stack(self.recurrence)
        self.login(self.chris)
        response = self._post()
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)

        # Future upcoming Meetings (effective time at/after the
        # instant): cancelled — NEVER deleted — with their original
        # identity, times, and content intact.
        for key in ("jan9", "jan10"):
            meeting = Meeting.objects.get(pk=meetings[key].pk)
            self.assertEqual(meeting.status, Meeting.Status.CANCELLED)
            self.assertEqual(
                meeting.original_scheduled_at,
                meetings[key].original_scheduled_at,
            )
            self.assertEqual(meeting.scheduled_at, meetings[key].scheduled_at)
            self.assertEqual(meeting.title, meetings[key].title)

        # Preserved: completed, live, and before-the-instant upcoming
        # Meetings are left completely unchanged.
        self.assertEqual(
            Meeting.objects.get(pk=meetings["jan5"].pk).status,
            Meeting.Status.COMPLETED,
        )
        self.assertEqual(
            Meeting.objects.get(pk=meetings["jan6"].pk).status,
            Meeting.Status.LIVE,
        )
        for key in ("jan7", "jan8"):
            self.assertEqual(
                Meeting.objects.get(pk=meetings[key].pk).status,
                Meeting.Status.UPCOMING,
            )

        # Exactly ONE exclusion per cancelled Meeting, keyed by the
        # immutable ORIGINAL occurrence identity.
        self.assertEqual(
            set(
                MeetingRecurrenceExclusion.objects
                .values_list("original_scheduled_at", flat=True)
            ),
            {
                meetings["jan9"].original_scheduled_at,
                meetings["jan10"].original_scheduled_at,
            },
        )
        # Exactly ONE meeting.cancelled event per cancelled Meeting.
        self.assertEqual(
            sorted(
                AuditEvent.objects.filter(
                    event_type=MeetingAuditEventType.CANCELLED,
                )
                .values_list("meeting_id", flat=True)
            ),
            sorted(
                [meetings["jan9"].pk, meetings["jan10"].pk]
            ),
        )

    def test_no_payload_is_required(self):
        # The endpoint ignores any request body: the recurrence id is
        # the entire input.
        self.login(self.chris)
        response = self.client.post(
            self._path(),
            data=json.dumps({"anything": "ignored"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(
            MeetingRecurrence.objects.get(pk=self.recurrence.pk).terminated_at,
            TERMINATED_AT,
        )

    # ── 4. Idempotent replay ─────────────────────────────────────

    def test_replay_is_idempotent_without_duplicate_side_effects(self):
        self._full_stack(self.recurrence)
        self.login(self.chris)
        first = self._post()
        self.assertEqual(first.status_code, status.HTTP_204_NO_CONTENT)
        state_after_first = self._persistence_state()

        # Replay by the SAME actor...
        second = self._post()
        self.assertEqual(second.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(second.content, b"")
        self.assertEqual(self._persistence_state(), state_after_first)

        # ...and by ANOTHER authorized actor: identical 204, and the
        # terminal state (including the FIRST observed instant) is
        # never rewritten — no duplicate exclusions, no duplicate
        # cancelled events, no content mutation.
        self.login(self.alex)
        third = self._post()
        self.assertEqual(third.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(self._persistence_state(), state_after_first)

    # ── 5. Read-model effects ────────────────────────────────────

    def test_termination_removes_recurrence_from_personal_overview(self):
        ended = self._create_recurrence(
            title="One Off", local_time=time(10, 0),
            end_mode="count", occurrence_count=1,
            participants=(self.chris,),
        )
        self.login(self.alex)
        data = self._overview().json()
        self.assertEqual(
            {row["id"] for row in data},
            {self.recurrence.pk, ended.pk},
        )

        self.login(self.chris)
        response = self._post()
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)

        # The terminated series is GONE from the overview of EVERY
        # personally relevant user (creator and participant)...
        for user in (self.alex, self.chris):
            with self.subTest(user=user.username):
                self.login(user)
                data = self._overview().json()
                self.assertEqual([row["id"] for row in data], [ended.pk])

        # ...while the naturally ended (NOT terminated) series keeps
        # its existing overview behavior: still visible, derived
        # ``ended`` status, null next occurrence.
        self.login(self.alex)
        row = self._overview_row(self._overview(), ended)
        self.assertEqual(row["status"], "ended")
        self.assertIsNone(row["nextOccurrenceScheduledAt"])

    def test_future_occurrence_feed_no_longer_returns_virtual_occurrences(
        self,
    ):
        self.login(self.chris)
        before = self._feed(_utc(2026, 1, 5), _utc(2026, 1, 12))
        self.assertEqual(before.status_code, status.HTTP_200_OK)
        before_items = before.json()
        # Jan 5..Jan 11 — all still virtual.
        self.assertEqual(len(before_items), 7)
        self.assertTrue(all(not item["materialized"] for item in before_items))

        response = self._post()
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)

        after = self._feed(_utc(2026, 1, 5), _utc(2026, 1, 12))
        self.assertEqual(after.status_code, status.HTTP_200_OK)
        after_items = after.json()
        # Only the occurrences BEFORE the instant survive; Jan 9-11
        # are suppressed (no replacement, nothing materialized).
        self.assertEqual(
            [item["originalScheduledAt"] for item in after_items],
            [f"2026-01-0{day}T08:30:00Z" for day in (5, 6, 7, 8)],
        )
        self.assertTrue(all(not item["materialized"] for item in after_items))
        self.assertEqual(Meeting.objects.count(), 0)

    def test_historical_concrete_meetings_remain_readable(self):
        meetings = self._full_stack(self.recurrence)
        self.login(self.chris)
        response = self._post()
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)

        # Every concrete Meeting of the terminated series — cancelled
        # or preserved — remains fully addressable by its Meeting id.
        expected = {
            "jan5": "completed",
            "jan6": "live",
            "jan7": "upcoming",
            "jan8": "upcoming",
            "jan9": "cancelled",
            "jan10": "cancelled",
        }
        for key, expected_status in expected.items():
            with self.subTest(meeting=key):
                read = self.client.get(
                    f"/api/meetings/{meetings[key].pk}/",
                )
                self.assertEqual(read.status_code, status.HTTP_200_OK)
                self.assertEqual(read.json()["status"], expected_status)

    # ── 6. Other recurrence operations and contracts unchanged ──

    def test_other_recurrence_operations_and_contracts_unchanged(self):
        other = self._create_recurrence(
            title="Other", local_time=time(16, 0),
            participants=(self.chris,),
        )
        jan10 = self._occurrence_on(self.recurrence, (2026, 1, 10))
        self.login(self.chris)
        response = self._post()
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)

        # (a) Materializing a future virtual occurrence is rejected
        #     with the domain error — no Meeting is created.
        materialize = self.client.post(
            f"/api/meeting-recurrences/{self.recurrence.pk}"
            "/occurrences/materialize/",
            data=json.dumps(
                {
                    "occurrenceId": str(jan10.occurrence_id),
                    "originalScheduledAt": self._occurrence_utc_iso(jan10),
                    "title": "Nope",
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(materialize.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("error", materialize.json())
        self.assertEqual(Meeting.objects.count(), 0)

        # (b) Excluding a future virtual occurrence is rejected with
        #     the domain error — no exclusion row is written.
        exclude = self.client.post(
            f"/api/meeting-recurrences/{self.recurrence.pk}"
            "/occurrences/exclude/",
            data=json.dumps(
                {
                    "occurrenceId": str(jan10.occurrence_id),
                    "originalScheduledAt": self._occurrence_utc_iso(jan10),
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(exclude.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("error", exclude.json())
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 0)

        # (c) The bounded effective occurrence read shows no
        #     occurrences at or after the instant.
        read = self.client.get(
            f"/api/meeting-recurrences/{self.recurrence.pk}/occurrences/",
            {
                "from": _utc(2026, 1, 9, 0, 0).isoformat(),
                "to": _utc(2026, 1, 15, 0, 0).isoformat(),
            },
        )
        self.assertEqual(read.status_code, status.HTTP_200_OK)
        self.assertEqual(read.json(), [])

        # (d) The OTHER series' overview row is unchanged, carrying
        #     the canonical overview shape plus ``canTerminate``.
        data = self._overview().json()
        self.assertEqual([row["id"] for row in data], [other.pk])
        row = data[0]
        self.assertEqual(
            set(row.keys()),
            {
                "id", "title", "meetingSeriesId", "researchGroupId",
                "scope", "projectId", "frequency", "interval",
                "weekdays", "startDate", "localTime", "timezone",
                "endDate", "count",
                "creator", "peopleCount", "status",
                "nextOccurrenceScheduledAt", "canTerminate",
            },
        )
        self.assertEqual(row["status"], "active")
        self.assertTrue(row["canTerminate"])


class MeetingRecurrenceOverviewCanTerminateApiTest(
    MeetingRecurrenceTerminateApiBase,
):
    """``canTerminate``: the server's termination-write permission
    report on the personal Series overview — the SAME rule the
    termination endpoint enforces, batched (constant query count in
    the number of rows), never inferred from creator identity or
    personal relevance."""

    # ── Role matrix ───────────────────────────────────────────────

    def test_group_scope_can_terminate_matrix(self):
        recurrence = self._create_recurrence(
            participants=(self.chris, self.laura, self.maria),
        )
        expected = {
            # creator AND a current group member
            self.alex: True,
            self.chris: True,
            self.laura: True,
            # personally relevant participant WITHOUT scope access:
            # relevance alone is never a permission
            self.maria: False,
        }
        for user, expected_value in expected.items():
            with self.subTest(user=user.username):
                self.login(user)
                response = self._overview()
                self.assertEqual(response.status_code, status.HTTP_200_OK)
                row = self._overview_row(response, recurrence)
                self.assertEqual(row["canTerminate"], expected_value)

    def test_project_scope_can_terminate_matrix(self):
        recurrence = self._create_recurrence(
            title="Project Sync", scope="project", project=self.project,
            participants=(self.chris, self.laura, self.maria),
        )
        expected = {
            # Project owner (PROJECT_WORK)
            self.alex: True,
            # Project member (PROJECT_WORK)
            self.chris: True,
            # Project viewer: readable, never writable
            self.laura: False,
            # outsider participant: personal relevance only
            self.maria: False,
        }
        for user, expected_value in expected.items():
            with self.subTest(user=user.username):
                self.login(user)
                response = self._overview()
                self.assertEqual(response.status_code, status.HTTP_200_OK)
                row = self._overview_row(response, recurrence)
                self.assertEqual(row["canTerminate"], expected_value)

    def test_archived_project_can_terminate_is_false(self):
        recurrence = self._create_recurrence(
            title="Project Sync", scope="project", project=self.project,
            participants=(self.chris, self.laura),
        )
        archive_project(project=self.project, actor=self.alex)
        for user in (self.alex, self.chris, self.laura):
            with self.subTest(user=user.username):
                self.login(user)
                response = self._overview()
                self.assertEqual(response.status_code, status.HTTP_200_OK)
                row = self._overview_row(response, recurrence)
                self.assertEqual(row["canTerminate"], False)

    def test_revoked_membership_can_terminate_is_false(self):
        # chris keeps the row (participant relevance survives
        # revocation) but loses the scope-level write permission.
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
        self.login(self.chris)
        response = self._overview()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        row = self._overview_row(response, self.recurrence)
        self.assertEqual(row["canTerminate"], False)

    def test_can_terminate_true_matches_server_authorization(self):
        # The report is the server's rule, not a UI hint: a True
        # report means the SAME request succeeds on the endpoint.
        self.login(self.chris)
        row = self._overview_row(self._overview(), self.recurrence)
        self.assertTrue(row["canTerminate"])
        response = self._post()
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(
            MeetingRecurrence.objects.get(
                pk=self.recurrence.pk,
            ).terminated_at,
            TERMINATED_AT,
        )

    # ── Query-count regression ────────────────────────────────────

    def test_can_terminate_does_not_scale_with_group_rows(self):
        # ONE row...
        self.login(self.chris)
        # Warm-up request: absorbs the one-time lazy UserSession
        # registry INSERT so the capture compares the same
        # steady state (that statement is unrelated to the read).
        self._overview()
        with CaptureQueriesContext(connection) as ctx:
            response = self._overview()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.json()), 1)
        count_one_row = len(ctx.captured_queries)

        # ...vs SIX rows: a per-recurrence authorization query
        # sequence would grow the count here.
        for i in range(5):
            self._create_recurrence(
                title=f"More {i}", local_time=time(8, 0),
                participants=(self.chris,),
            )
        with CaptureQueriesContext(connection) as ctx:
            response = self._overview()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.json()), 6)
        self.assertTrue(all(row["canTerminate"] for row in response.json()))
        self.assertEqual(count_one_row, len(ctx.captured_queries))

    def test_can_terminate_does_not_scale_with_project_rows(self):
        # ONE project row... (laura is a Project viewer: the
        # project-scope permission branch — batched
        # ``resolve_project_scopes`` + the archived-state query —
        # is exercised, unlike the group-scope rows above).
        self._create_recurrence(
            title="Project Sync 0", scope="project",
            project=self.project, local_time=time(8, 0),
            participants=(self.laura,),
        )
        self.login(self.laura)
        self._overview()  # warm-up (same steady-state reason)
        with CaptureQueriesContext(connection) as ctx:
            response = self._overview()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.json()), 1)
        count_one_row = len(ctx.captured_queries)

        # ...vs THREE rows: a per-recurrence authorization query
        # sequence would grow the count here.
        for i in range(2):
            self._create_recurrence(
                title=f"Project Sync {i}", scope="project",
                project=self.project, local_time=time(8, 0),
                participants=(self.laura,),
            )
        with CaptureQueriesContext(connection) as ctx:
            response = self._overview()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.json()), 3)
        # laura is a Project viewer: readable, never writable.
        self.assertFalse(any(row["canTerminate"] for row in response.json()))
        self.assertEqual(count_one_row, len(ctx.captured_queries))
