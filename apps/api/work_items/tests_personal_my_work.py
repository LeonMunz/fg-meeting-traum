"""Tests for the personal cross-Research-Group My Work projection."""

from datetime import date, datetime, timezone

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext

from rest_framework.test import APIClient, APITestCase

from projects.models import (
    ProjectMembership,
    WorkItemTypeDefinition,
    WorkItemStatusDefinition,
)
from projects.services import create_project
from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)
from work_items.models import WorkItem, WorkItemAssignee
from work_items.services import create_work_item

User = get_user_model()


class PersonalMyWorkApiTest(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.chris = User.objects.create_user(
            username="personal_chris",
            password="TestPass1!",
        )

        cls.group_a = ResearchGroup.objects.create(
            name="FG Cognitive Science",
            created_by=cls.chris,
        )
        cls.group_b = ResearchGroup.objects.create(
            name="Robotics Lab",
            created_by=cls.chris,
        )

        cls.membership_a = (
            ResearchGroupMembership.objects.create(
                research_group=cls.group_a,
                user=cls.chris,
                role=ResearchGroupMembership.Role.MEMBER,
            )
        )
        cls.membership_b = (
            ResearchGroupMembership.objects.create(
                research_group=cls.group_b,
                user=cls.chris,
                role=ResearchGroupMembership.Role.MEMBER,
            )
        )

        cls.project_a = create_project(
            research_group=cls.group_a,
            creator=cls.chris,
            name="Paper XYZ",
        )
        cls.project_b = create_project(
            research_group=cls.group_b,
            creator=cls.chris,
            name="Robot Study",
        )

        cls.work_a = create_work_item(
            project=cls.project_a,
            actor=cls.chris,
            type_definition_id=cls.project_a.type_definitions.get(name="Task").pk,
            title="Rewrite Introduction",
            assignee_ids=[cls.chris.pk],
        )
        cls.work_b = create_work_item(
            project=cls.project_b,
            actor=cls.chris,
            type_definition_id=cls.project_b.type_definitions.get(name="Task").pk,
            title="Analyze Robot Data",
            assignee_ids=[cls.chris.pk],
        )

        cls.unassigned = create_work_item(
            project=cls.project_a,
            actor=cls.chris,
            type_definition_id=cls.project_a.type_definitions.get(name="Task").pk,
            title="Unassigned Work",
        )

    def setUp(self):
        self.client = APIClient()

    def login(self):
        self.client.get("/api/auth/csrf/")

        csrf_token = (
            self.client.cookies
            .get("csrftoken")
            .value
        )

        response = self.client.post(
            "/api/auth/login/",
            data={
                "username": "personal_chris",
                "password": "TestPass1!",
            },
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )

        self.assertEqual(response.status_code, 200)

    def test_anonymous_user_cannot_access_personal_my_work(self):
        response = self.client.get(
            "/api/me/work-items/"
        )

        self.assertEqual(response.status_code, 401)

    def test_default_returns_work_across_all_groups(self):
        self.login()

        response = self.client.get(
            "/api/me/work-items/"
        )

        self.assertEqual(response.status_code, 200)

        titles = {
            item["title"]
            for item in response.json()
        }

        self.assertEqual(
            titles,
            {
                "Rewrite Introduction",
                "Analyze Robot Data",
            },
        )

    def test_unassigned_work_is_not_returned(self):
        self.login()

        response = self.client.get(
            "/api/me/work-items/"
        )

        titles = {
            item["title"]
            for item in response.json()
        }

        self.assertNotIn(
            "Unassigned Work",
            titles,
        )

    def test_response_contains_project_and_group_context(self):
        self.login()

        response = self.client.get(
            "/api/me/work-items/"
        )

        items = {
            item["title"]: item
            for item in response.json()
        }

        item = items["Rewrite Introduction"]

        self.assertEqual(
            item["projectName"],
            "Paper XYZ",
        )
        self.assertEqual(
            item["researchGroupId"],
            self.group_a.pk,
        )
        self.assertEqual(
            item["researchGroupName"],
            "FG Cognitive Science",
        )

    def test_group_filter_limits_results(self):
        self.login()

        response = self.client.get(
            (
                "/api/me/work-items/"
                f"?group={self.group_a.pk}"
            )
        )

        self.assertEqual(response.status_code, 200)

        titles = {
            item["title"]
            for item in response.json()
        }

        self.assertEqual(
            titles,
            {"Rewrite Introduction"},
        )

    def test_invalid_group_parameter_returns_400(self):
        self.login()

        response = self.client.get(
            "/api/me/work-items/?group=abc"
        )

        self.assertEqual(response.status_code, 400)

    def test_unknown_or_inaccessible_group_returns_404(self):
        outsider = User.objects.create_user(
            username="group_owner",
            password="TestPass1!",
        )

        other_group = ResearchGroup.objects.create(
            name="Private Other FG",
            created_by=outsider,
        )

        ResearchGroupMembership.objects.create(
            research_group=other_group,
            user=outsider,
            role=ResearchGroupMembership.Role.ADMIN,
        )

        self.login()

        response = self.client.get(
            (
                "/api/me/work-items/"
                f"?group={other_group.pk}"
            )
        )

        self.assertEqual(response.status_code, 404)
        self.assertNotIn(
            "Private Other FG",
            str(response.json()),
        )

    def test_stale_research_group_membership_excludes_work(self):
        # Revoke group B access: the ProjectMembership first (required by
        # the composite FK), then the group membership.
        ProjectMembership.objects.filter(
            project=self.project_b,
            user=self.chris,
        ).delete()
        self.membership_b.delete()

        self.login()

        response = self.client.get(
            "/api/me/work-items/"
        )

        titles = {
            item["title"]
            for item in response.json()
        }

        self.assertIn(
            "Rewrite Introduction",
            titles,
        )
        self.assertNotIn(
            "Analyze Robot Data",
            titles,
        )

    def test_stale_project_access_excludes_work(self):
        project_membership = (
            ProjectMembership.objects.get(
                project=self.project_a,
                user=self.chris,
            )
        )
        project_membership.delete()

        self.login()

        response = self.client.get(
            "/api/me/work-items/"
        )

        titles = {
            item["title"]
            for item in response.json()
        }

        self.assertNotIn(
            "Rewrite Introduction",
            titles,
        )
        self.assertIn(
            "Analyze Robot Data",
            titles,
        )

    def test_viewer_is_excluded_defense_in_depth(self):
        project_membership = (
            ProjectMembership.objects.get(
                project=self.project_a,
                user=self.chris,
            )
        )
        project_membership.role = (
            ProjectMembership.Role.VIEWER
        )
        project_membership.save(
            update_fields=["role"]
        )

        # Existing assignment is intentionally left in place to simulate
        # stale/corrupt state. Personal My Work must not expose it.
        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=self.work_a,
                user=self.chris,
            ).exists()
        )

        self.login()

        response = self.client.get(
            "/api/me/work-items/"
        )

        titles = {
            item["title"]
            for item in response.json()
        }

        self.assertNotIn(
            "Rewrite Introduction",
            titles,
        )

    def test_legacy_group_my_work_endpoint_still_works(self):
        self.login()

        response = self.client.get(
            (
                "/api/research-groups/"
                f"{self.group_a.pk}/my-work/"
            )
        )

        self.assertEqual(response.status_code, 200)

        titles = {
            item["title"]
            for item in response.json()
        }

        self.assertIn(
            "Rewrite Introduction",
            titles,
        )

    def test_completed_work_item_is_still_returned(self):
        """Pins the canonical ``done`` behavior of the personal
        My Work endpoint: a completed Work Item (status category
        ``done``) REMAINS part of the projection — the My Work
        page shows completed items (sorted last), and
        ``foundation.md`` §14 lists "Done" as a possible UI
        filter. Home "My work" is an explicit active-only read
        model and excludes it there; this endpoint must not
        silently change (see work_items.tests_home_my_work)."""
        done_status = (
            self.project_a.status_definitions.get(name="Done")
        )

        create_work_item(
            project=self.project_a,
            actor=self.chris,
            type_definition_id=(
                self.project_a.type_definitions.get(name="Task").pk
            ),
            title="Completed Work",
            status_definition_id=done_status.pk,
            assignee_ids=[self.chris.pk],
        )

        self.login()

        response = self.client.get(
            "/api/me/work-items/"
        )

        self.assertEqual(response.status_code, 200)

        titles = {
            item["title"]
            for item in response.json()
        }

        self.assertIn(
            "Completed Work",
            titles,
        )

    def test_response_preserves_canonical_payload_and_status_representation(self):
        # A concrete project-local status with a custom display
        # name and the fixed semantic category ``in_progress``.
        ready = WorkItemStatusDefinition.objects.create(
            project=self.project_a,
            name="Ready for Lab",
            category=(
                WorkItemStatusDefinition.Category.IN_PROGRESS
            ),
        )
        self.work_a.status_definition = ready
        self.work_a.due_date = date(2026, 10, 1)
        self.work_a.save()

        self.login()

        response = self.client.get("/api/me/work-items/")

        self.assertEqual(response.status_code, 200)
        items = {
            item["title"]: item
            for item in response.json()
        }
        item = items["Rewrite Introduction"]

        # Canonical Work Item identity/data (the Project Work Item
        # API contract — definition IDs, not fixed strings).
        self.assertEqual(item["id"], self.work_a.pk)
        self.assertEqual(
            item["typeDefinitionId"],
            self.project_a.type_definitions.get(name="Task").pk,
        )
        # Concrete project-local type name (default Project
        # configuration) — display metadata for the canonical
        # ``typeDefinitionId``.
        self.assertEqual(item["typeName"], "Task")
        self.assertEqual(item["assigneeIds"], [self.chris.pk])
        self.assertEqual(item["dueDate"], "2026-10-01")

        # Concrete project-local status AND its fixed semantic
        # category — both preserved, never collapsed into one
        # global status.
        self.assertEqual(item["statusDefinitionId"], ready.pk)
        self.assertEqual(item["statusName"], "Ready for Lab")
        self.assertEqual(
            item["statusCategory"],
            "in_progress",
        )

        # Explicit cross-project context.
        self.assertEqual(
            item["projectId"],
            self.project_a.pk,
        )
        self.assertEqual(item["projectName"], "Paper XYZ")
        self.assertEqual(
            item["researchGroupId"],
            self.group_a.pk,
        )
        self.assertEqual(
            item["researchGroupName"],
            "FG Cognitive Science",
        )

        # The other Project keeps its own concrete status — the
        # two items are not collapsed into one global status.
        other = items["Analyze Robot Data"]
        self.assertEqual(other["statusName"], "Todo")
        self.assertEqual(other["statusCategory"], "todo")
        self.assertEqual(other["projectId"], self.project_b.pk)

    def test_response_returns_concrete_project_local_type_name(self):
        """The payload carries the concrete project-local Work Item
        type name (``typeName``) next to the canonical
        ``typeDefinitionId``: project-configured custom names are
        returned exactly, types from different Projects can have
        different names, and NO semantic Task/Epic/Milestone/
        Deliverable ``kind`` discriminator is introduced."""
        # Custom, project-configured type names — one per Project,
        # deliberately different across Projects.
        type_a = WorkItemTypeDefinition.objects.create(
            project=self.project_a,
            name="Research Milestone",
            order=10,
        )
        type_b = WorkItemTypeDefinition.objects.create(
            project=self.project_b,
            name="Robot Data Analysis",
            order=10,
        )
        self.work_a.type_definition = type_a
        self.work_a.save()
        self.work_b.type_definition = type_b
        self.work_b.save()

        self.login()

        response = self.client.get("/api/me/work-items/")

        self.assertEqual(response.status_code, 200)
        items = {
            item["title"]: item
            for item in response.json()
        }

        item_a = items["Rewrite Introduction"]
        item_b = items["Analyze Robot Data"]

        # Canonical identity stays authoritative and the concrete
        # configured name is returned EXACTLY (per Project).
        self.assertEqual(item_a["typeDefinitionId"], type_a.pk)
        self.assertEqual(item_a["typeName"], "Research Milestone")
        self.assertEqual(item_b["typeDefinitionId"], type_b.pk)
        self.assertEqual(item_b["typeName"], "Robot Data Analysis")

        # No semantic type kind: no discriminator field and no
        # inferred Task/Epic/Milestone/Deliverable value.
        for item in (item_a, item_b):
            for forbidden in (
                "typeKind",
                "kind",
                "semanticType",
                "semanticKind",
                "typeCategory",
            ):
                self.assertNotIn(
                    forbidden,
                    item,
                    f"no semantic type {forbidden!r} field may be "
                    "introduced into the personal My Work payload",
                )
            self.assertNotIn(
                item["typeName"],
                {"Task", "Epic", "Milestone", "Deliverable"},
            )

    def test_removing_assignment_removes_item(self):
        WorkItemAssignee.objects.get(
            work_item=self.work_a,
            user=self.chris,
        ).delete()

        self.login()

        response = self.client.get("/api/me/work-items/")

        self.assertEqual(response.status_code, 200)
        titles = {
            item["title"]
            for item in response.json()
        }
        self.assertNotIn("Rewrite Introduction", titles)
        self.assertIn("Analyze Robot Data", titles)

    def test_deterministic_ordering(self):
        """Document the endpoint's deterministic server ordering:
        canonical creation order (``created_at`` ascending) with a
        stable Work Item ID tie-break, across Projects and Research
        Groups. ``board_position`` is Project-local Board state and
        is never a cross-project ordering input; no
        user-configurable sorting is exposed."""
        qc_a = create_work_item(
            project=self.project_a,
            actor=self.chris,
            type_definition_id=(
                self.project_a.type_definitions.get(name="Task").pk
            ),
            title="QC mid A",
            assignee_ids=[self.chris.pk],
        )
        qc_b = create_work_item(
            project=self.project_b,
            actor=self.chris,
            type_definition_id=(
                self.project_b.type_definitions.get(name="Task").pk
            ),
            title="QC mid B",
            assignee_ids=[self.chris.pk],
        )

        # Deliberately decouple creation time from ID order (the
        # items were created work_a, work_b, qc_a, qc_b).
        WorkItem.objects.filter(pk=self.work_b.pk).update(
            created_at=datetime(2026, 2, 1, 9, 0, tzinfo=timezone.utc),
        )
        WorkItem.objects.filter(pk=qc_a.pk).update(
            created_at=datetime(2026, 2, 2, 9, 0, tzinfo=timezone.utc),
        )
        WorkItem.objects.filter(pk=qc_b.pk).update(
            created_at=datetime(2026, 2, 2, 9, 0, tzinfo=timezone.utc),
        )
        WorkItem.objects.filter(pk=self.work_a.pk).update(
            created_at=datetime(2026, 2, 3, 9, 0, tzinfo=timezone.utc),
        )

        self.login()

        response = self.client.get("/api/me/work-items/")

        self.assertEqual(response.status_code, 200)
        # created_at ascending across Projects; the two equal
        # timestamps tie-break by ascending Work Item ID (qc_a was
        # created before qc_b).
        self.assertEqual(
            [item["id"] for item in response.json()],
            [self.work_b.pk, qc_a.pk, qc_b.pk, self.work_a.pk],
        )


# ── Query behavior (no N+1 growth) ──


class PersonalMyWorkQueryCountTest(APITestCase):
    """Behavioral query-count regression for the personal My Work
    endpoint.

    The read path must not add one query per returned Work Item:
    Project / Research Group / type definition / status definition
    context is
    eager-loaded with ``select_related``, assignees and labels with
    ``prefetch_related``, and Meeting origin links with one bulk
    query per request (not one per Work Item).
    """

    @classmethod
    def setUpTestData(cls):
        cls.alice = User.objects.create_user(
            username="qc_alice",
            password="TestPass1!",
        )
        cls.group = ResearchGroup.objects.create(
            name="QC FG",
            created_by=cls.alice,
        )
        ResearchGroupMembership.objects.create(
            research_group=cls.group,
            user=cls.alice,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        cls.project = create_project(
            research_group=cls.group,
            creator=cls.alice,
            name="QC Project",
        )

    def setUp(self):
        self.client = APIClient()

    def _make(self, title):
        create_work_item(
            project=self.project,
            actor=self.alice,
            type_definition_id=(
                self.project.type_definitions.get(name="Task").pk
            ),
            title=title,
            assignee_ids=[self.alice.pk],
        )

    def _login(self):
        self.client.get("/api/auth/csrf/")
        csrf_token = (
            self.client.cookies.get("csrftoken").value
        )
        response = self.client.post(
            "/api/auth/login/",
            data={
                "username": "qc_alice",
                "password": "TestPass1!",
            },
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )
        self.assertEqual(response.status_code, 200)

    def test_query_count_does_not_scale_with_row_count(self):
        # Request 1: 2 assigned Work Items.
        self._make("QC work 1")
        self._make("QC work 2")
        self._login()

        with CaptureQueriesContext(connection) as small_ctx:
            response = self.client.get("/api/me/work-items/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()), 2)

        # Request 2: 14 assigned Work Items (7x the rows, same
        # shape).
        for i in range(3, 15):
            self._make(f"QC work {i}")

        with CaptureQueriesContext(connection) as large_ctx:
            response = self.client.get("/api/me/work-items/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()), 14)

        # Invariant: 7x the rows add ZERO queries — a per-row
        # relation lookup (Project / Research Group / type
        # definition / status definition / assignee / label N+1, or
        # a per-item Meeting
        # origin check) would make the second request issue 12 more
        # queries.
        self.assertEqual(
            len(small_ctx.captured_queries),
            len(large_ctx.captured_queries),
            "personal My Work query count must not scale with the "
            "returned row count; every serialized relation (Project, "
            "Research Group, type definition, status definition, "
            "assignees, labels) "
            "and the Meeting origin check must be eager-loaded or "
            "bulk-fetched per request.",
        )
