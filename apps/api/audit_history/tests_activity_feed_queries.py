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

from projects.services import (
    archive_project,
    create_project,
    restore_project,
)
from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)
from research_groups.services import (
    ResearchGroupAuditEventType,
    offboard_research_group_member,
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


class ActivityFeedProjectQueryCountTest(APITestCase):
    """A Project-heavy page must not add one Project / Research Group
    / subject-user query per Activity row (same bounded-query
    invariant as the Meeting regression test above)."""

    client = APIClient()

    def setUp(self):
        self.alice = User.objects.create_user(
            username="feed-pqc-alice", password="Pass1!",
        )
        self.group = ResearchGroup.objects.create(
            name="Feed PQC Group", created_by=self.alice,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.alice,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        self.project = create_project(
            research_group=self.group,
            creator=self.alice,
            name="Feed PQC Project",
            description="",
        )
        self.client.force_login(self.alice)

    def _add_project_events(self, count):
        # Archive and restore each record exactly one Project event;
        # alternate so the project stays in a valid lifecycle state.
        for i in range(count):
            if i % 2 == 0:
                archive_project(project=self.project, actor=self.alice)
            else:
                restore_project(project=self.project, actor=self.alice)

    def _get_feed(self, params=None):
        response = self.client.get(FEED_URL, params or None)
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_project_rows_do_not_add_per_row_queries(self):
        # Warm-up: establish the session steady state.
        self._get_feed()

        # Page 1: 2 Project rows.
        self._add_project_events(2)
        with CaptureQueriesContext(connection) as small_ctx:
            small = self._get_feed()
        self.assertEqual(
            len([e for e in small if e["projectId"] == self.project.pk]),
            2,
        )

        # Page 2: 14 Project rows (same page shape, 7x the rows).
        self._add_project_events(12)
        with CaptureQueriesContext(connection) as large_ctx:
            large = self._get_feed()
        self.assertEqual(
            len([e for e in large if e["projectId"] == self.project.pk]),
            14,
        )

        # Invariant: 7x the Project rows on the page add ZERO queries.
        self.assertEqual(
            len(small_ctx.captured_queries),
            len(large_ctx.captured_queries),
            "Activity page query count must not scale with Project row "
            "count; every serialized relation (project, research "
            "group, subject user) must be eager-loaded on the page "
            "queryset.",
        )

class ActivityFeedResearchGroupQueryCountTest(APITestCase):
    """A Research Group-heavy page must not add one Research Group /
    actor / subject-user query per Activity row (same bounded-query
    invariant as the Meeting and Project regression tests)."""

    client = APIClient()

    def setUp(self):
        self.alice = User.objects.create_user(
            username="rg-feed-qc-alice", password="Pass1!",
        )
        self.group = ResearchGroup.objects.create(
            name="RG Feed Query Group", created_by=self.alice,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.alice,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        # 14 offboardable members (no Project memberships, so each
        # offboarding records exactly one Research Group event).
        self.members = [
            User.objects.create_user(
                username=f"rg-feed-qc-m{i}", password="Pass1!",
            )
            for i in range(14)
        ]
        for member in self.members:
            ResearchGroupMembership.objects.create(
                research_group=self.group, user=member,
                role=ResearchGroupMembership.Role.MEMBER,
            )
        self.offboarded = 0
        self.client.force_login(self.alice)

    def _add_rg_events(self, count):
        for member in self.members[
            self.offboarded: self.offboarded + count
        ]:
            offboard_research_group_member(
                membership=ResearchGroupMembership.objects.get(
                    research_group=self.group, user=member,
                ),
                actor=self.alice,
            )
        self.offboarded += count

    def _rg_rows(self, entries):
        return [
            e for e in entries
            if e["eventType"]
            == ResearchGroupAuditEventType.MEMBER_OFFBOARDED
        ]

    def _get_feed(self, params=None):
        response = self.client.get(FEED_URL, params or None)
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_research_group_rows_do_not_add_per_row_queries(self):
        # Warm-up: establish the session steady state.
        self._get_feed()

        # Page 1: 2 Research Group rows.
        self._add_rg_events(2)
        with CaptureQueriesContext(connection) as small_ctx:
            small = self._get_feed()
        self.assertEqual(len(self._rg_rows(small)), 2)

        # Page 2: 14 Research Group rows (7x the rows).
        self._add_rg_events(12)
        with CaptureQueriesContext(connection) as large_ctx:
            large = self._get_feed()
        self.assertEqual(len(self._rg_rows(large)), 14)

        # Invariant: 7x the Research Group rows on the page add
        # ZERO queries — the Research Group, actor, and
        # subject_user relations are eager-loaded on the page
        # queryset.
        self.assertEqual(
            len(small_ctx.captured_queries),
            len(large_ctx.captured_queries),
            "Activity page query count must not scale with Research "
            "Group row count; every serialized relation (research "
            "group, actor, subject user) must be eager-loaded on "
            "the page queryset.",
        )


class ActivityFeedWorkItemQueryCountTest(APITestCase):
    """A Work Item-heavy page must not add one Work Item / Project /
    Research Group / actor query per Activity row (same bounded-query
    invariant as the Meeting, Project, and Research Group regression
    tests)."""

    client = APIClient()

    def setUp(self):
        self.alice = User.objects.create_user(
            username="feed-wqc-alice", password="Pass1!",
        )
        self.group = ResearchGroup.objects.create(
            name="Feed WQC Group", created_by=self.alice,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.alice,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        self.project = create_project(
            research_group=self.group,
            creator=self.alice,
            name="Feed WQC Project",
            description="",
        )
        # One Work Item: create_work_item records its ``created``
        # event (row 1); every title change records exactly one
        # ``updated`` event on the same Work Item.
        task_type = self.project.type_definitions.get(name="Task")
        self.work_item = create_work_item(
            project=self.project,
            actor=self.alice,
            type_definition_id=task_type.pk,
            title="Work item query probe",
        )
        # Monotonic update counter so every update in the test
        # changes the title and records exactly one event.
        self._update_seq = 0
        self.client.force_login(self.alice)

    def _add_work_item_events(self, count):
        # Each title change records exactly one Work Item event.
        for _ in range(count):
            self._update_seq += 1
            update_work_item(
                work_item=self.work_item,
                actor=self.alice,
                title=f"Work item query probe {self._update_seq}",
            )

    def _work_item_rows(self, entries):
        return [
            e for e in entries
            if e["workItemId"] == self.work_item.pk
        ]

    def _get_feed(self, params=None):
        response = self.client.get(FEED_URL, params or None)
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_work_item_rows_do_not_add_per_row_queries(self):
        # Warm-up: establish the session steady state.
        self._get_feed()

        # Page 1: 2 Work Item rows (created + one update).
        self._add_work_item_events(1)
        with CaptureQueriesContext(connection) as small_ctx:
            small = self._get_feed()
        self.assertEqual(len(self._work_item_rows(small)), 2)

        # Page 2: 14 Work Item rows (same feed composition, 7x the
        # Work Item rows).
        self._add_work_item_events(12)
        with CaptureQueriesContext(connection) as large_ctx:
            large = self._get_feed()
        self.assertEqual(len(self._work_item_rows(large)), 14)

        # Invariant: 7x the Work Item rows on the page add
        # ZERO queries — the Work Item, Project, Research Group,
        # and actor relations are eager-loaded on the page
        # queryset.
        self.assertEqual(
            len(small_ctx.captured_queries),
            len(large_ctx.captured_queries),
            "Activity page query count must not scale with Work Item "
            "row count; every serialized relation (work item, "
            "project, research group, actor) must be eager-loaded on "
            "the page queryset.",
        )
