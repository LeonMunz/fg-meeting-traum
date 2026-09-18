"""Hidden acceptance: query cost of ``GET /api/activity/`` is constant
with respect to the number of meeting events on a page.

This is a behavior-based, implementation-independent check:

- Two content-comparable authenticated requests to the same feed:
  one page with 2 meeting events and one with 14 (the Work Item rows
  stay identical across both requests).
- A warm-up request precedes both measured requests so that one-time
  session-establishment queries do not skew the first captured count.
- Asserted:
  * both requests succeed (HTTP 200) and return the expected rows;
  * the captured query count of the two requests is identical, i.e.
    the per-request query count does not scale with the number of
    meeting events on the page;
  * meeting entries keep their correct identity, titles, and
    Research Group linkage in the response (behavior unchanged).

Deliberately avoided: absolute query counts, timing-based assertions,
source-text search, assertions on a specific ORM method, and any
assertion tied to the historical implementation.
"""

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient, APITestCase

from meetings.services import create_meeting
from projects.services import create_project
from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)
from work_items.services import create_work_item, update_work_item

User = get_user_model()

FEED_URL = "/api/activity/"
SMALL_MEETING_COUNT = 2
LARGE_MEETING_COUNT = 14


class ActivityFeedQueryCostAcceptanceTest(APITestCase):
    client = APIClient()

    def setUp(self):
        self.alice = User.objects.create_user(
            username="acc-feed-alice",
            password="Pass1!",
        )
        self.group = ResearchGroup.objects.create(
            name="Acceptance Feed Group",
            created_by=self.alice,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.alice,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        self.project = create_project(
            research_group=self.group,
            creator=self.alice,
            name="Acceptance Feed Project",
            description="",
        )
        # Two Work Item events (created + title update) give the feed
        # the real aggregate shape; these rows are identical in both
        # measured requests.
        task_type = self.project.type_definitions.get(name="Task")
        self.work_item = create_work_item(
            project=self.project,
            actor=self.alice,
            type_definition_id=task_type.pk,
            title="Acceptance probe",
        )
        update_work_item(
            work_item=self.work_item,
            actor=self.alice,
            title="Acceptance probe (updated)",
        )
        self.client.force_login(self.alice)
        self.small_meetings = []
        self.large_meetings = []

    def _add_meetings(self, count, prefix, bucket):
        for i in range(count):
            meeting = create_meeting(
                research_group=self.group,
                actor=self.alice,
                title=f"{prefix} meeting {i}",
                scheduled_at=timezone.now() + timedelta(days=30 + i),
            )
            bucket.append(meeting)

    def _fetch_feed(self):
        response = self.client.get(FEED_URL)
        self.assertEqual(response.status_code, 200)
        return response.json()

    def _meeting_entries(self, page):
        return [e for e in page if e.get("meetingId") is not None]

    def _work_item_entries(self, page):
        return [e for e in page if e.get("workItemId") is not None]

    def _check_meeting_entries(self, page, meetings):
        by_id = {meeting.pk: meeting for meeting in meetings}
        entries = self._meeting_entries(page)
        self.assertEqual(len(entries), len(meetings))
        for entry in entries:
            meeting = by_id.get(entry["meetingId"])
            self.assertIsNotNone(
                meeting,
                f"unexpected meetingId {entry['meetingId']} in feed",
            )
            self.assertEqual(entry["meetingTitle"], meeting.title)
            # Research Group linkage must stay correct in the response.
            self.assertEqual(entry["researchGroupId"], self.group.pk)
            self.assertEqual(entry["researchGroupName"], self.group.name)

    def test_meeting_event_count_does_not_change_page_query_count(self):
        # Warm-up: bring the session/authentication steady state to a
        # stable point BEFORE measuring. One-time session-establishment
        # queries must not skew the first measured request.
        self._fetch_feed()

        # Page 1: 2 meeting events + the 2 Work Item events.
        self._add_meetings(
            SMALL_MEETING_COUNT, "Small", self.small_meetings,
        )
        with CaptureQueriesContext(connection) as small_ctx:
            small_page = self._fetch_feed()

        # Page 2: 14 meeting events + the same 2 Work Item events.
        self._add_meetings(
            LARGE_MEETING_COUNT - SMALL_MEETING_COUNT,
            "Large",
            self.large_meetings,
        )
        with CaptureQueriesContext(connection) as large_ctx:
            large_page = self._fetch_feed()

        # Both requests succeed and carry the expected rows.
        self.assertEqual(len(self._meeting_entries(small_page)), 2)
        self.assertEqual(len(self._work_item_entries(small_page)), 2)
        self.assertEqual(len(self._meeting_entries(large_page)), 14)
        self.assertEqual(len(self._work_item_entries(large_page)), 2)

        # Behavior unchanged: meeting data (identity, title, Research
        # Group linkage) is correct in both responses.
        self._check_meeting_entries(small_page, self.small_meetings)
        self._check_meeting_entries(
            large_page, self.small_meetings + self.large_meetings,
        )

        # Growth invariant: 7x the meeting events on the page add
        # ZERO queries.
        self.assertEqual(
            len(small_ctx.captured_queries),
            len(large_ctx.captured_queries),
            "GET /api/activity/ query count must be constant in the "
            "number of meeting events on the page; every relation the "
            "feed reads must be served from the page queryset.",
        )
