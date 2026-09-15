"""Behavioral API tests for the permission-safe Activity feed.

GET /api/activity/ is an aggregate, read-only projection over the
canonical audit_history.AuditEvent persistence (Work Item slice:
work_item.created / work_item.updated).

Security contract under test (docs/domain/activity.md §5):

- Authorization is evaluated at READ time: an event is returned only
  if the requester can read the underlying Work Item TODAY through
  the canonical Project read boundary (ProjectMembership
  owner/member/viewer + current ResearchGroupMembership).
- Inaccessible events leak NOTHING: no title, actor, context, event
  data, existence, count, or ordering/page behavior.
- The filter runs in the database BEFORE pagination; the response is
  a bare page (no total count), so no unauthorized row can be
  inferred through page counts or offsets.

Setup reuses the standard Work Item scenario
(work_items.tests_api._setup_test_data):

FG Example group:
- alex:  group admin, Paper XYZ owner
- chris: group member, Paper XYZ member
- maria: group member, NO Paper XYZ membership
- laura: group member, Paper XYZ viewer

Paper XYZ contains "Rewrite Introduction" (one work_item.created
event, actor alex, assignee chris).
"""

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APITestCase

from audit_history.models import AuditEvent
from projects.services import create_project
from research_groups.models import ResearchGroupMembership
from research_groups.services import offboard_research_group_member
from work_items.services import create_work_item, update_work_item
from work_items.tests_api import _setup_test_data

User = get_user_model()

FEED_URL = "/api/activity/"


class _FeedClientMixin:
    """APITestCase-based feed access with force_login."""

    def _login(self, user):
        self.client.force_login(user)

    def _feed(self, user, **params):
        self._login(user)
        return self.client.get(FEED_URL, params or None)

    def _feed_entries(self, user, **params):
        response = self._feed(user, **params)
        self.assertEqual(response.status_code, 200)
        return response.json()

    def _feed_ids(self, user, **params):
        return [entry["id"] for entry in self._feed_entries(user, **params)]

    def _append_title_events(self, work_item, actor, count, prefix):
        """Append exactly ``count`` work_item.updated events.

        Each update changes the title to a unique value — no-op
        updates record no event, so uniqueness is required.
        """
        for i in range(count):
            update_work_item(
                work_item=work_item, actor=actor,
                title=f"{prefix}-{i}",
            )


# ── Authentication ──


class ActivityFeedAuthenticationTest(_FeedClientMixin, APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()

    def test_anonymous_request_rejected(self):
        response = self.client.get(FEED_URL)
        self.assertEqual(response.status_code, 401)

    def test_authenticated_user_can_request_feed(self):
        response = self._feed(self.data["alex"])
        self.assertEqual(response.status_code, 200)
        self.assertIsInstance(response.json(), list)


# ── Positive visibility + ordering + payload contract ──


class ActivityFeedVisibilityTest(_FeedClientMixin, APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()
        cls.wi = cls.data["work_item"]

    def test_authorized_user_sees_work_item_event(self):
        body = self._feed_entries(self.data["alex"])

        self.assertEqual(len(body), 1)
        entry = body[0]

        self.assertEqual(entry["eventType"], "work_item.created")
        self.assertEqual(entry["workItemId"], self.wi.pk)
        self.assertEqual(entry["workItemTitle"], "Rewrite Introduction")
        self.assertEqual(entry["projectId"], self.data["paper_xyz"].pk)
        self.assertEqual(entry["projectName"], "Paper XYZ")
        self.assertEqual(
            entry["researchGroupId"], self.data["group"].pk,
        )
        self.assertEqual(entry["researchGroupName"], "FG Example")
        self.assertEqual(entry["actor"]["id"], self.data["alex"].pk)
        self.assertEqual(entry["actor"]["username"], "alex")
        self.assertEqual(entry["changes"], {})
        self.assertIsNotNone(entry["createdAt"])

    def test_viewer_can_read_feed_matching_work_item_read_permission(self):
        # The feed's read rule must match WorkItem reads exactly:
        # owner/member/viewer all read.
        for username in ("alex", "chris", "laura"):
            with self.subTest(username=username):
                self.assertIn(
                    self.wi.pk,
                    {
                        e["workItemId"]
                        for e in self._feed_entries(self.data[username])
                    },
                )

    def test_feed_aggregates_events_from_multiple_authorized_work_items(self):
        chris = self.data["chris"]
        task_type = self.data["task_type"]

        wi_a = create_work_item(
            project=self.data["paper_xyz"], actor=chris,
            type_definition_id=task_type.pk, title="Feed Task A",
        )
        wi_b = create_work_item(
            project=self.data["paper_xyz"], actor=self.data["alex"],
            type_definition_id=task_type.pk, title="Feed Task B",
        )

        work_item_ids = {
            entry["workItemId"]
            for entry in self._feed_entries(self.data["alex"])
        }
        self.assertEqual(
            work_item_ids,
            {self.wi.pk, wi_a.pk, wi_b.pk},
        )

    def test_results_are_newest_first_deterministic(self):
        alex = self.data["alex"]
        self._append_title_events(self.wi, alex, 5, "Order")

        expected = list(
            AuditEvent.objects
            .filter(work_item=self.wi)
            .order_by("-created_at", "-id")
            .values_list("id", flat=True)
        )
        self.assertEqual(self._feed_ids(self.data["alex"]), expected)

    def test_equal_timestamps_break_tie_by_event_id_descending(self):
        alex = self.data["alex"]
        self._append_title_events(self.wi, alex, 4, "Tie")

        # Force timestamp equality in the DB (auto_now_add only
        # applies on insert) so ordering cannot fall back to
        # undefined database order.
        fixed = timezone.now()
        AuditEvent.objects.filter(work_item=self.wi).update(
            created_at=fixed,
        )

        expected = list(
            AuditEvent.objects
            .filter(work_item=self.wi)
            .order_by("-id")
            .values_list("id", flat=True)
        )
        self.assertEqual(self._feed_ids(self.data["alex"]), expected)

    def test_payload_is_structured_not_rendered(self):
        alex = self.data["alex"]
        review_status = self.data["review_status"]

        update_work_item(
            work_item=self.wi, actor=alex,
            status_definition_id=review_status.pk,
        )

        entry = self._feed_entries(alex)[0]

        # Exact contract: no arbitrary AuditEvent internals. The
        # Meeting slice extends the entry with the meeting identity
        # pair; on a Work Item event both are null.
        self.assertEqual(
            set(entry.keys()),
            {
                "id",
                "eventType",
                "actor",
                "subjectUser",
                "workItemId",
                "workItemTitle",
                "meetingId",
                "meetingTitle",
                "projectId",
                "projectName",
                "researchGroupId",
                "researchGroupName",
                "changes",
                "createdAt",
            },
        )
        self.assertIsNone(entry["meetingId"])
        self.assertIsNone(entry["meetingTitle"])
        # Stable machine code, never a rendered sentence.
        self.assertIn(
            entry["eventType"],
            ("work_item.created", "work_item.updated"),
        )
        # Existing audit/history actor representation, unchanged.
        self.assertEqual(
            set(entry["actor"].keys()),
            {"id", "username", "firstName", "lastName"},
        )
        # Structured status semantics (IDs + fixed category).
        status_change = entry["changes"]["statusDefinition"]
        self.assertEqual(
            set(status_change["to"].keys()),
            {"id", "name", "category"},
        )
        self.assertEqual(status_change["to"]["category"], "review")
        self.assertEqual(status_change["to"]["id"], review_status.pk)

    def test_completion_distinguishable_from_ordinary_status_change(self):
        alex = self.data["alex"]
        done_status = self.data["done_status"]

        # Transition INTO done: a completion (drives completed_at).
        update_work_item(
            work_item=self.wi, actor=alex,
            status_definition_id=done_status.pk,
        )
        entry = self._feed_entries(alex)[0]
        self.assertEqual(entry["eventType"], "work_item.updated")
        self.assertEqual(
            entry["changes"]["statusDefinition"]["to"]["category"],
            "done",
        )

        # Transition AWAY from done: an ordinary status change.
        review_status = self.data["review_status"]
        update_work_item(
            work_item=self.wi, actor=alex,
            status_definition_id=review_status.pk,
        )
        entry = self._feed_entries(alex)[0]
        status_change = entry["changes"]["statusDefinition"]
        self.assertEqual(status_change["from"]["category"], "done")
        self.assertEqual(status_change["to"]["category"], "review")


# ── Project isolation / no metadata leakage ──


class ActivityFeedProjectIsolationTest(_FeedClientMixin, APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()
        cls.wi = cls.data["work_item"]

        # A private Project that alex (group admin) has NO
        # membership in.
        cls.secret_project = create_project(
            research_group=cls.data["group"],
            creator=cls.data["chris"],
            name="Secret Beta",
        )
        cls.secret_wi = create_work_item(
            project=cls.secret_project,
            actor=cls.data["chris"],
            type_definition_id=cls.secret_project.type_definitions.get(
                name="Task",
            ).pk,
            title="TopSecret Delta",
        )
        update_work_item(
            work_item=cls.secret_wi,
            actor=cls.data["chris"],
            title="TopSecret Delta v2",
        )

    def test_group_member_without_project_membership_gets_no_project_events(self):
        # maria: Research Group member, NO Paper XYZ membership —
        # group membership alone never grants Project Activity.
        self.assertEqual(self._feed_entries(self.data["maria"]), [])

    def test_group_admin_without_project_membership_gets_no_private_events(self):
        # alex is the Research Group ADMIN — admin status alone never
        # grants visibility into a private Project's Activity.
        body = self._feed_entries(self.data["alex"])

        self.assertEqual(
            {entry["workItemId"] for entry in body}, {self.wi.pk},
        )
        # The secret object identities must not appear in their own
        # fields (raw integer equality across unrelated entity types
        # is not a leak — IDs are globally allocated).
        self.assertNotIn(
            self.secret_wi.pk, [e["workItemId"] for e in body],
        )
        self.assertNotIn(
            self.secret_project.pk, [e["projectId"] for e in body],
        )
        for secret in ("Secret Beta", "TopSecret Delta"):
            self.assertNotIn(secret, str(body))

    def test_private_project_events_leak_nothing_including_actor(self):
        # Full-response leak scan: no Project B title, actor,
        # context, event data, ID, or existence signal may appear.
        body = self._feed_entries(self.data["alex"])
        rendered = str(body)
        self.assertNotIn(
            self.secret_wi.pk, [e["workItemId"] for e in body],
        )
        self.assertNotIn(
            self.secret_project.pk, [e["projectId"] for e in body],
        )
        for secret in ("TopSecret", "Secret Beta", "chris"):
            self.assertNotIn(secret, rendered)

    def test_user_in_no_group_gets_empty_feed(self):
        outsider = User.objects.create_user(username="outsider")
        self.assertEqual(self._feed_entries(outsider), [])


# ── Access revocation (read-time authorization) ──


class ActivityFeedRevocationTest(_FeedClientMixin, APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()
        cls.wi = cls.data["work_item"]
        cls.project = cls.data["paper_xyz"]

    def test_project_membership_removal_removes_events_at_read_time(self):
        laura = self.data["laura"]

        # 1. Initially authorized: the historical event is visible.
        self.assertEqual(
            [e["workItemId"] for e in self._feed_entries(laura)],
            [self.wi.pk],
        )

        # 2. Normal domain path: the Project owner removes laura's
        #    ProjectMembership through the membership API.
        membership = self.project.memberships.get(user=laura)
        self._login(self.data["alex"])
        response = self.client.delete(
            f"/api/projects/{self.project.pk}/memberships/"
            f"{membership.pk}/",
        )
        self.assertEqual(response.status_code, 200)
        self.assertFalse(
            self.project.memberships.filter(user=laura).exists()
        )

        # 3. The same historical event is gone from laura's feed —
        #    while the owner still sees it: read-time authorization,
        #    not authorization fixed at event creation time.
        self.assertEqual(self._feed_entries(laura), [])
        self.assertIn(
            self.wi.pk,
            {
                e["workItemId"]
                for e in self._feed_entries(self.data["alex"])
            },
        )

    def test_group_offboarding_removes_events_at_read_time(self):
        chris = self.data["chris"]

        self.assertIn(
            self.wi.pk,
            {
                e["workItemId"]
                for e in self._feed_entries(chris)
            },
        )

        # Offboarding requires no open assignments on chris; clear
        # his assignment through the canonical update path first.
        update_work_item(
            work_item=self.wi, actor=self.data["alex"],
            assignee_ids=[],
        )

        # Normal domain path: canonical Research Group offboarding,
        # which atomically revokes all of chris's Project
        # memberships in the group.
        membership = ResearchGroupMembership.objects.get(
            research_group=self.data["group"], user=chris,
        )
        offboard_research_group_member(
            membership=membership, actor=self.data["alex"],
        )

        self.assertEqual(self._feed_entries(chris), [])


# ── Work Item scope: the underlying object must still exist ──


class ActivityFeedWorkItemScopeTest(_FeedClientMixin, APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()
        cls.wi = cls.data["work_item"]

    def test_hard_deleted_work_item_events_leave_the_feed(self):
        alex = self.data["alex"]

        wi_extra = create_work_item(
            project=self.data["paper_xyz"], actor=alex,
            type_definition_id=self.data["task_type"].pk,
            title="Temporary Task",
        )
        self.assertIn(
            wi_extra.pk,
            {e["workItemId"] for e in self._feed_entries(alex)},
        )

        # Allowed hard delete: the Work Item no longer exists, so it
        # can no longer be read and its events leave the feed.
        self._login(alex)
        response = self.client.delete(f"/api/work-items/{wi_extra.pk}/")
        self.assertEqual(response.status_code, 204)

        work_item_ids = {
            e["workItemId"] for e in self._feed_entries(alex)
        }
        self.assertNotIn(wi_extra.pk, work_item_ids)
        self.assertIn(self.wi.pk, work_item_ids)


# ── Pagination (filtered queryset; no leakage through page behavior) ──


class ActivityFeedPaginationTest(_FeedClientMixin, APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()
        cls.wi = cls.data["work_item"]

    def test_limit_bounds_page(self):
        alex = self.data["alex"]
        self._append_title_events(self.wi, alex, 14, "Page")  # 15 events

        body = self._feed_entries(alex, limit=10)
        self.assertEqual(len(body), 10)

        expected_top = list(
            AuditEvent.objects
            .filter(work_item=self.wi)
            .order_by("-created_at", "-id")[:10]
            .values_list("id", flat=True)
        )
        self.assertEqual([e["id"] for e in body], expected_top)

    def test_offset_pages_the_filtered_queryset(self):
        alex = self.data["alex"]
        self._append_title_events(self.wi, alex, 34, "Page")  # 35 events

        all_ids = []
        for offset in (0, 10, 20, 30):
            with self.subTest(offset=offset):
                body = self._feed_entries(alex, limit=10, offset=offset)
                ids = [entry["id"] for entry in body]
                self.assertEqual(len(ids), min(10, 35 - offset))
                all_ids.extend(ids)

        self.assertEqual(len(set(all_ids)), 35)
        # Pages concatenate into the full deterministic order.
        self.assertEqual(
            all_ids,
            list(
                AuditEvent.objects
                .filter(work_item=self.wi)
                .order_by("-created_at", "-id")
                .values_list("id", flat=True)
            ),
        )

    def test_offset_beyond_end_returns_empty_page(self):
        alex = self.data["alex"]
        self.assertEqual(self._feed_entries(alex, limit=10, offset=999), [])

    def test_unauthorized_rows_create_no_holes_or_wrong_pages(self):
        alex = self.data["alex"]

        # 15 authorized (Paper XYZ) + 15 unauthorized (Secret Gamma)
        # events, created alternately so their ids interleave; then
        # timestamps are equalized so the canonical order is purely
        # (-created_at, -id) == interleaved by id.
        secret_project = create_project(
            research_group=self.data["group"],
            creator=self.data["chris"],
            name="Secret Gamma",
        )
        secret_wi = create_work_item(
            project=secret_project,
            actor=self.data["chris"],
            type_definition_id=secret_project.type_definitions.get(
                name="Task",
            ).pk,
            title="Secret Gamma Task",
        )

        for i in range(14):
            update_work_item(
                work_item=self.wi, actor=alex, title=f"Auth-{i}",
            )
            update_work_item(
                work_item=secret_wi, actor=self.data["chris"],
                title=f"Secret-{i}",
            )

        fixed = timezone.now()
        AuditEvent.objects.filter(
            work_item__in=[self.wi, secret_wi],
        ).update(created_at=fixed)

        authorized_ids = set(
            AuditEvent.objects
            .filter(work_item=self.wi)
            .values_list("id", flat=True)
        )

        # Page 1 must be exactly 10 AUTHORIZED events — with
        # post-pagination filtering it would contain only 5.
        page_1 = self._feed_entries(alex, limit=10)
        self.assertEqual(len(page_1), 10)
        page_1_ids = [entry["id"] for entry in page_1]
        self.assertEqual(
            page_1_ids,
            sorted(authorized_ids, reverse=True)[:10],
        )

        # The full page walk yields exactly the 15 authorized events,
        # no gaps, no unauthorized ids.
        all_ids = []
        for offset in (0, 10):
            all_ids.extend(
                e["id"] for e in self._feed_entries(alex, limit=10, offset=offset)
            )
        self.assertEqual(len(all_ids), 15)
        self.assertEqual(set(all_ids), authorized_ids)

    def test_invalid_pagination_params_rejected(self):
        for params in (
            {"limit": 0},
            {"limit": 1001},
            {"limit": "abc"},
            {"offset": -1},
            {"offset": "abc"},
            {"offset": 10_001},
        ):
            with self.subTest(params=params):
                response = self._feed(self.data["alex"], **params)
                self.assertEqual(response.status_code, 400)

    def test_response_exposes_no_total_count(self):
        # Bare page only — no count/next/prev metadata that could
        # reveal unauthorized rows.
        body = self._feed_entries(self.data["alex"])
        self.assertIsInstance(body, list)
