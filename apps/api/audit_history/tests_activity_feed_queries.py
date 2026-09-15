"""Behavioral query-count regression test for the Activity feed.

GET /api/activity/ serializes every event's relation context (actor,
Work Item / Meeting, Project, Research Group) from the SAME page
queryset. All of those relations are eager-loaded with
``select_related`` in ``ActivityFeedView`` — including
``meeting__research_group`` — so serializing a page must not issue a
relation query per event row.

Regression covered: Meeting events previously triggered one extra
Research Group query per row (``meeting.research_group`` was not
eager-loaded), so a Meeting-heavy page scaled linearly with its row
count.

Test shape:
- A mixed Work Item + Meeting feed (the real aggregate feed shape).
- Two requests to the same authenticated session: one page with 2
  Meeting rows and one with 14 Meeting rows (Work Item rows
  unchanged).
- Invariant: the total query count of the two requests is identical —
  adding Meeting rows within a page adds ZERO queries.

Both requests are captured AFTER a warm-up request so that
one-time session-establishment queries (e.g. the per-session
``UserSession`` row) do not skew the first captured request; the
comparison therefore measures steady-state request cost only.
"""

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient, APITestCase

from projects.services import create_project
from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)
from work_items.services import create_work_item, update_work_item
from meetings.services import create_meeting

User = get_user_model()

FEED_URL = "/api/activity/"


class ActivityFeedQueryCountTest(APITestCase):
    client = APIClient()

    def setUp(self):
        self.alice = User.objects.create_user(
            username="feed-qc-alice", password="Pass1!",
        )
        self.group = ResearchGroup.objects.create(
            name="Feed Query Group", created_by=self.alice,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.alice,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        self.project = create_project(
            research_group=self.group,
            creator=self.alice,
            name="Feed Query Project",
            description="",
        )
        # Two Work Item events: created + one title update.
        task_type = self.project.type_definitions.get(name="Task")
        self.work_item = create_work_item(
            project=self.project,
            actor=self.alice,
            type_definition_id=task_type.pk,
            title="Query probe",
        )
        update_work_item(
            work_item=self.work_item,
            actor=self.alice,
            title="Query probe (updated)",
        )
        self.client.force_login(self.alice)

    def _add_meetings(self, count):
        for i in range(count):
            create_meeting(
                research_group=self.group,
                actor=self.alice,
                title=f"Query meeting {i}",
                scheduled_at=timezone.now() + timedelta(days=30 + i),
            )

    def _get_feed(self, params=None):
        response = self.client.get(FEED_URL, params or None)
        self.assertEqual(response.status_code, 200)
        return response.json()

    def _count_entry_kinds(self, entries):
        meeting_rows = sum(1 for e in entries if e["meetingId"] is not None)
        work_item_rows = sum(
            1 for e in entries if e["workItemId"] is not None
        )
        return meeting_rows, work_item_rows

    def test_meeting_rows_do_not_add_per_row_queries(self):
        # Warm-up: establish the session steady state (one-time
        # session-establishment queries must not skew the first
        # captured request).
        self._get_feed()

        # Page 1: 2 Meeting rows + the 2 Work Item rows.
        self._add_meetings(2)
        with CaptureQueriesContext(connection) as small_ctx:
            small = self._get_feed()
        small_meetings, small_wis = self._count_entry_kinds(small)
        self.assertEqual(small_meetings, 2)
        self.assertEqual(small_wis, 2)

        # Page 2: 14 Meeting rows + the same 2 Work Item rows.
        self._add_meetings(12)
        with CaptureQueriesContext(connection) as large_ctx:
            large = self._get_feed()
        large_meetings, large_wis = self._count_entry_kinds(large)
        self.assertEqual(large_meetings, 14)
        self.assertEqual(large_wis, 2)

        # Invariant: 7x the Meeting rows on the page add ZERO queries.
        # A per-row relation lookup (the old meeting.research_group
        # N+1) would make the second request issue 12 more queries.
        self.assertEqual(
            len(small_ctx.captured_queries),
            len(large_ctx.captured_queries),
            "Activity page query count must not scale with Meeting row "
            "count; every serialized relation must be eager-loaded on "
            "the page queryset.",
        )
