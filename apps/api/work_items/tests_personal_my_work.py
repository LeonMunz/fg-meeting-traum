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
        ``typeDefinitionId`` and the stable semantic kind
        (``typeKind``): project-configured custom names are returned
        exactly, types from different Projects can have different
        names, and custom / unclassified types carry no canonical
        kind (``null`` — never inferred from the name, even when the
        name contains a canonical word)."""
        # Custom, project-configured type names — one per Project,
        # deliberately different across Projects. The first one
        # deliberately CONTAINS a canonical kind word to prove no
        # name-based inference.
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

        # Stable semantic kind: custom / unclassified types carry
        # no canonical kind — null, never inferred from the display
        # name.
        self.assertIsNone(item_a["typeKind"])
        self.assertIsNone(item_b["typeKind"])

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


class PersonalMyWorkTypeKindTest(APITestCase):
    """The personal My Work payload exposes the stable semantic kind
    (``typeKind``) of each item's project-local type definition —
    independent of the display name."""

    @classmethod
    def setUpTestData(cls):
        cls.chris = User.objects.create_user(
            username="tk_chris",
            password="TestPass1!",
        )

        cls.group_a = ResearchGroup.objects.create(
            name="FG Kind A",
            created_by=cls.chris,
        )
        cls.group_b = ResearchGroup.objects.create(
            name="FG Kind B",
            created_by=cls.chris,
        )
        ResearchGroupMembership.objects.create(
            research_group=cls.group_a,
            user=cls.chris,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        ResearchGroupMembership.objects.create(
            research_group=cls.group_b,
            user=cls.chris,
            role=ResearchGroupMembership.Role.MEMBER,
        )

        cls.project_a = create_project(
            research_group=cls.group_a,
            creator=cls.chris,
            name="Kind Paper",
        )
        cls.project_b = create_project(
            research_group=cls.group_b,
            creator=cls.chris,
            name="Kind Robot",
        )

    def setUp(self):
        self.client = APIClient()

    def login(self):
        self.client.get("/api/auth/csrf/")
        csrf_token = (
            self.client.cookies.get("csrftoken").value
        )
        response = self.client.post(
            "/api/auth/login/",
            data={
                "username": "tk_chris",
                "password": "TestPass1!",
            },
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )
        self.assertEqual(response.status_code, 200)

    def _item_by_title(self, response, title):
        items = {
            item["title"]: item
            for item in response.json()
        }
        return items[title]

    def test_my_work_exposes_all_four_canonical_kinds(self):
        for name, kind in (
            ("Task", "task"),
            ("Epic", "epic"),
            ("Milestone", "milestone"),
            ("Deliverable", "deliverable"),
        ):
            create_work_item(
                project=self.project_a,
                actor=self.chris,
                type_definition_id=(
                    self.project_a.type_definitions.get(name=name).pk
                ),
                title=f"kind item {name}",
                assignee_ids=[self.chris.pk],
            )

        self.login()
        response = self.client.get("/api/me/work-items/")
        self.assertEqual(response.status_code, 200)

        for name, kind in (
            ("Task", "task"),
            ("Epic", "epic"),
            ("Milestone", "milestone"),
            ("Deliverable", "deliverable"),
        ):
            item = self._item_by_title(response, f"kind item {name}")
            self.assertEqual(
                item["typeDefinitionId"],
                self.project_a.type_definitions.get(name=name).pk,
            )
            self.assertEqual(item["typeName"], name)
            self.assertEqual(item["typeKind"], kind)

    def test_type_kind_is_independent_of_display_name(self):
        create_work_item(
            project=self.project_a,
            actor=self.chris,
            type_definition_id=(
                self.project_a.type_definitions.get(name="Task").pk
            ),
            title="Renamed type item",
            assignee_ids=[self.chris.pk],
        )
        # The display name changes; the semantic kind must not.
        task = self.project_a.type_definitions.get(name="Task")
        task.name = "Experiment step"
        task.save()

        self.login()
        response = self.client.get("/api/me/work-items/")
        self.assertEqual(response.status_code, 200)

        item = self._item_by_title(response, "Renamed type item")
        self.assertEqual(item["typeDefinitionId"], task.pk)
        self.assertEqual(item["typeName"], "Experiment step")
        self.assertEqual(item["typeKind"], "task")

    def test_two_projects_different_names_same_kind(self):
        create_work_item(
            project=self.project_a,
            actor=self.chris,
            type_definition_id=(
                self.project_a.type_definitions.get(name="Task").pk
            ),
            title="Project A task",
            assignee_ids=[self.chris.pk],
        )
        create_work_item(
            project=self.project_b,
            actor=self.chris,
            type_definition_id=(
                self.project_b.type_definitions.get(name="Task").pk
            ),
            title="Project B task",
            assignee_ids=[self.chris.pk],
        )
        task_b = self.project_b.type_definitions.get(name="Task")
        task_b.name = "Aufgabe"
        task_b.save()

        self.login()
        response = self.client.get("/api/me/work-items/")
        self.assertEqual(response.status_code, 200)

        item_a = self._item_by_title(response, "Project A task")
        item_b = self._item_by_title(response, "Project B task")
        self.assertEqual(item_a["typeName"], "Task")
        self.assertEqual(item_b["typeName"], "Aufgabe")
        # Same canonical semantic kind across both Projects despite
        # the different display names.
        self.assertEqual(item_a["typeKind"], "task")
        self.assertEqual(item_b["typeKind"], "task")

    def test_custom_type_carries_no_kind_in_my_work(self):
        figure = WorkItemTypeDefinition.objects.create(
            project=self.project_a,
            name="Figure",
            order=10,
        )
        create_work_item(
            project=self.project_a,
            actor=self.chris,
            type_definition_id=figure.pk,
            title="Custom type item",
            assignee_ids=[self.chris.pk],
        )

        self.login()
        response = self.client.get("/api/me/work-items/")
        self.assertEqual(response.status_code, 200)

        item = self._item_by_title(response, "Custom type item")
        self.assertEqual(item["typeDefinitionId"], figure.pk)
        self.assertEqual(item["typeName"], "Figure")
        self.assertIsNone(item["typeKind"])


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

    def _make_project_scope(self, name):
        """Create one new Research Group + Project + one assigned
        Work Item so the response represents one more Project."""
        group = ResearchGroup.objects.create(
            name=name,
            created_by=self.alice,
        )
        ResearchGroupMembership.objects.create(
            research_group=group,
            user=self.alice,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        project = create_project(
            research_group=group,
            creator=self.alice,
            name=name,
        )
        create_work_item(
            project=project,
            actor=self.alice,
            type_definition_id=(
                project.type_definitions.get(name="Task").pk
            ),
            title=f"QC work {name}",
            assignee_ids=[self.alice.pk],
        )
        return project

    def test_query_count_does_not_scale_with_project_count(self):
        # Request 1: 2 Work Items across 2 Projects.
        self._make("QC work 1")
        self._make_project_scope("QC Group Two")
        self._login()

        with CaptureQueriesContext(connection) as two_projects_ctx:
            response = self.client.get("/api/me/work-items/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()), 2)

        # Request 2: 6 Work Items across 6 Projects (3x the Projects
        # represented, same rows-per-Project shape).
        for index in range(3, 7):
            self._make_project_scope(f"QC Group {index}")

        with CaptureQueriesContext(connection) as six_projects_ctx:
            response = self.client.get("/api/me/work-items/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()), 6)

        # The stable semantic kind rides the same eager-loaded type
        # definition — its presence in every item must not add any
        # query (pinned by the count equality below).
        for item in response.json():
            self.assertIn("typeKind", item)
            self.assertEqual(item["typeKind"], "task")

        # Invariant: 3x the represented Projects add ZERO queries —
        # the per-category status targets (like the Project /
        # Research Group / definition context and the Meeting origin
        # check) are bulk-resolved per request, never per Project.
        self.assertEqual(
            len(two_projects_ctx.captured_queries),
            len(six_projects_ctx.captured_queries),
            "personal My Work query count must not scale with the "
            "number of represented Projects; status targets and "
            "every other serialized relation must be eager-loaded or "
            "bulk-fetched per request.",
        )


# ── Global My Work Kanban status targets (read contract) ──


class PersonalMyWorkStatusTargetsTest(APITestCase):
    """Behavioral coverage for the personal My Work
    ``statusTargets`` read contract.

    For the future global My Work Kanban, every returned Work Item
    carries — per fixed semantic category — the concrete
    project-local StatusDefinition a cross-category move would
    resolve to: owned by the item's own Project, active, in that
    category; first by the Project's configured status order with a
    stable status-definition ID tie-break. Display names never
    participate in resolution, a category without an active
    definition yields no target, and ``boardPosition`` (Project-local
    Board state) never influences target selection.
    """

    FIXED_CATEGORIES = [
        WorkItemStatusDefinition.Category.TODO,
        WorkItemStatusDefinition.Category.IN_PROGRESS,
        WorkItemStatusDefinition.Category.REVIEW,
        WorkItemStatusDefinition.Category.DONE,
    ]

    @classmethod
    def setUpTestData(cls):
        cls.chris = User.objects.create_user(
            username="targets_chris",
            password="TestPass1!",
        )

        cls.group_a = ResearchGroup.objects.create(
            name="Targets FG A",
            created_by=cls.chris,
        )
        cls.group_b = ResearchGroup.objects.create(
            name="Targets FG B",
            created_by=cls.chris,
        )

        ResearchGroupMembership.objects.create(
            research_group=cls.group_a,
            user=cls.chris,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        ResearchGroupMembership.objects.create(
            research_group=cls.group_b,
            user=cls.chris,
            role=ResearchGroupMembership.Role.MEMBER,
        )

        cls.project_a = create_project(
            research_group=cls.group_a,
            creator=cls.chris,
            name="Target Alpha",
        )
        cls.project_b = create_project(
            research_group=cls.group_b,
            creator=cls.chris,
            name="Target Beta",
        )

        cls.work_a = create_work_item(
            project=cls.project_a,
            actor=cls.chris,
            type_definition_id=(
                cls.project_a.type_definitions.get(name="Task").pk
            ),
            title="Target Work A",
            assignee_ids=[cls.chris.pk],
        )
        cls.work_b = create_work_item(
            project=cls.project_b,
            actor=cls.chris,
            type_definition_id=(
                cls.project_b.type_definitions.get(name="Task").pk
            ),
            title="Target Work B",
            assignee_ids=[cls.chris.pk],
        )

    def setUp(self):
        self.client = APIClient()

    def login(self):
        self.client.get("/api/auth/csrf/")
        csrf_token = (
            self.client.cookies.get("csrftoken").value
        )
        response = self.client.post(
            "/api/auth/login/",
            data={
                "username": "targets_chris",
                "password": "TestPass1!",
            },
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )
        self.assertEqual(response.status_code, 200)

    def _fetch_items(self):
        self.login()
        response = self.client.get("/api/me/work-items/")
        self.assertEqual(response.status_code, 200)
        return {
            item["title"]: item
            for item in response.json()
        }

    def _targets_by_category(self, item):
        return {
            entry["statusCategory"]: entry
            for entry in item["statusTargets"]
        }

    def test_every_item_exposes_status_targets_in_fixed_order(self):
        items = self._fetch_items()

        self.assertIn("Target Work A", items)
        self.assertIn("Target Work B", items)

        for item in items.values():
            self.assertIsInstance(item["statusTargets"], list)
            self.assertEqual(
                [
                    entry["statusCategory"]
                    for entry in item["statusTargets"]
                ],
                self.FIXED_CATEGORIES,
            )
            for entry in item["statusTargets"]:
                self.assertEqual(
                    set(entry.keys()),
                    {
                        "statusCategory",
                        "statusDefinitionId",
                        "statusName",
                    },
                )

    def test_targets_use_only_fixed_semantic_categories(self):
        items = self._fetch_items()

        for item in items.values():
            categories = [
                entry["statusCategory"]
                for entry in item["statusTargets"]
            ]
            self.assertTrue(
                set(categories)
                <= set(self.FIXED_CATEGORIES),
            )
            # At most one target per semantic category.
            self.assertEqual(
                len(categories),
                len(set(categories)),
            )

    def test_target_carries_concrete_definition_id_and_name(self):
        items = self._fetch_items()
        item_a = self._targets_by_category(items["Target Work A"])
        item_b = self._targets_by_category(items["Target Work B"])

        # The default Project configuration (one active status per
        # category) resolves to the Project's own definition —
        # concrete ID and exact configured name, per Project.
        for category, name in [
            ("todo", "Todo"),
            ("in_progress", "In Progress"),
            ("review", "Review"),
            ("done", "Done"),
        ]:
            definition = (
                self.project_a
                .status_definitions.get(
                    name=name,
                    category=category,
                )
            )
            self.assertEqual(
                item_a[category]["statusDefinitionId"],
                definition.pk,
            )
            self.assertEqual(
                item_a[category]["statusName"],
                name,
            )

        # The other Project resolves the SAME semantic category to
        # its own, different definition row.
        other_todo = self.project_b.status_definitions.get(
            category="todo",
        )
        self.assertEqual(
            item_b["todo"]["statusDefinitionId"],
            other_todo.pk,
        )
        self.assertNotEqual(
            item_b["todo"]["statusDefinitionId"],
            item_a["todo"]["statusDefinitionId"],
        )

    def test_targets_never_cross_project_boundaries(self):
        # Distinctive names so a cross-Project leak is detectable by
        # both name and ID.
        todo_b = self.project_b.status_definitions.get(
            category="todo",
        )
        todo_b.name = "Beta Backlog"
        todo_b.save(update_fields=["name"])

        items = self._fetch_items()
        item_a = items["Target Work A"]
        item_b = items["Target Work B"]

        project_a_ids = set(
            self.project_a
            .status_definitions.values_list("pk", flat=True)
        )
        project_b_ids = set(
            self.project_b
            .status_definitions.values_list("pk", flat=True)
        )

        for entry in item_a["statusTargets"]:
            self.assertIn(
                entry["statusDefinitionId"],
                project_a_ids,
            )
        for entry in item_b["statusTargets"]:
            self.assertIn(
                entry["statusDefinitionId"],
                project_b_ids,
            )
        self.assertNotIn(
            "Beta Backlog",
            str(item_a["statusTargets"]),
        )

    def test_different_projects_resolve_different_targets_for_same_category(
        self,
    ):
        todo_a = self.project_a.status_definitions.get(
            category="todo",
        )
        todo_a.name = "Alpha Queue"
        todo_a.save(update_fields=["name"])
        todo_b = self.project_b.status_definitions.get(
            category="todo",
        )
        todo_b.name = "Beta Queue"
        todo_b.save(update_fields=["name"])

        items = self._fetch_items()
        item_a = self._targets_by_category(items["Target Work A"])
        item_b = self._targets_by_category(items["Target Work B"])

        self.assertEqual(item_a["todo"]["statusName"], "Alpha Queue")
        self.assertEqual(item_b["todo"]["statusName"], "Beta Queue")
        self.assertNotEqual(
            item_a["todo"]["statusDefinitionId"],
            item_b["todo"]["statusDefinitionId"],
        )

    def test_first_active_status_by_configured_order_wins(self):
        # The default "Todo" (order=0) is moved BEHIND two
        # later-created definitions — the lower configured order
        # wins even though its definition ID is the highest: order,
        # not ID or creation time, decides.
        todo = self.project_a.status_definitions.get(name="Todo")
        todo.order = 10
        todo.save(update_fields=["order"])
        later = WorkItemStatusDefinition.objects.create(
            project=self.project_a,
            name="Later Queue",
            category="todo",
            order=5,
        )
        first = WorkItemStatusDefinition.objects.create(
            project=self.project_a,
            name="First Queue",
            category="todo",
            order=2,
        )
        # "First Queue" was created AFTER "Later Queue" (higher ID)
        # yet still wins — by configured order, not by ID.
        self.assertLess(later.pk, first.pk)

        items = self._fetch_items()
        item_a = self._targets_by_category(items["Target Work A"])

        self.assertEqual(
            item_a["todo"]["statusDefinitionId"],
            first.pk,
        )
        self.assertEqual(item_a["todo"]["statusName"], "First Queue")

    def test_stable_id_tie_break_when_orders_tie(self):
        # Move the default "Todo" (order=0) behind the tie so the
        # equal-order pair decides the target by stable ID.
        todo = self.project_a.status_definitions.get(name="Todo")
        todo.order = 20
        todo.save(update_fields=["order"])
        tie_first = WorkItemStatusDefinition.objects.create(
            project=self.project_a,
            name="Tie First",
            category="todo",
            order=9,
        )
        tie_second = WorkItemStatusDefinition.objects.create(
            project=self.project_a,
            name="Tie Second",
            category="todo",
            order=9,
        )
        self.assertLess(tie_first.pk, tie_second.pk)

        items = self._fetch_items()
        item_a = self._targets_by_category(items["Target Work A"])
        self.assertEqual(
            item_a["todo"]["statusDefinitionId"],
            tie_first.pk,
        )

        # Deterministic on re-read.
        items = self._fetch_items()
        item_a = self._targets_by_category(items["Target Work A"])
        self.assertEqual(
            item_a["todo"]["statusDefinitionId"],
            tie_first.pk,
        )

    def test_inactive_statuses_are_ignored(self):
        # Active, in configured order: X Queue (1) < Y Queue (2)
        # < Todo (3). X Queue is inactive, so it must NOT win.
        x_queue = WorkItemStatusDefinition.objects.create(
            project=self.project_a,
            name="X Queue",
            category="todo",
            order=1,
        )
        y_queue = WorkItemStatusDefinition.objects.create(
            project=self.project_a,
            name="Y Queue",
            category="todo",
            order=2,
        )
        todo = self.project_a.status_definitions.get(
            name="Todo",
        )
        todo.order = 3
        todo.save(update_fields=["order"])

        x_queue.active = False
        x_queue.save(update_fields=["active"])

        items = self._fetch_items()
        item_a = items["Target Work A"]

        # The first ACTIVE status by configured order wins.
        self.assertEqual(
            self._targets_by_category(item_a)["todo"][
                "statusDefinitionId"
            ],
            y_queue.pk,
        )
        # The inactive definition is never exposed as a target.
        exposed_ids = {
            entry["statusDefinitionId"]
            for item in items.values()
            for entry in item["statusTargets"]
        }
        self.assertNotIn(x_queue.pk, exposed_ids)

    def test_missing_category_yields_no_target(self):
        # Deactivate Project B's only "review" definition: category
        # review becomes unavailable — no target is invented.
        review_b = self.project_b.status_definitions.get(
            name="Review",
        )
        review_b.active = False
        review_b.save(update_fields=["active"])

        items = self._fetch_items()
        item_a = self._targets_by_category(items["Target Work A"])
        item_b = self._targets_by_category(items["Target Work B"])

        self.assertIn("review", item_a)
        self.assertNotIn("review", item_b)
        self.assertEqual(
            set(item_b.keys()),
            {"todo", "in_progress", "done"},
        )

    def test_display_names_do_not_affect_category_resolution(self):
        # Misleading display names: resolution must follow the fixed
        # semantic category, never the name.
        in_progress_a = self.project_a.status_definitions.get(
            name="In Progress",
        )
        review_a = self.project_a.status_definitions.get(
            name="Review",
        )
        in_progress_a.name = "Looks Like Done"
        in_progress_a.save(update_fields=["name"])
        review_a.name = "Looks Like In Progress"
        review_a.save(update_fields=["name"])

        items = self._fetch_items()
        item_a = self._targets_by_category(items["Target Work A"])

        self.assertEqual(
            item_a["in_progress"]["statusDefinitionId"],
            in_progress_a.pk,
        )
        self.assertEqual(
            item_a["review"]["statusDefinitionId"],
            review_a.pk,
        )

    def test_canonical_fields_unchanged_alongside_targets(self):
        # A custom project-local status + custom type name: the
        # canonical Work Item fields stay authoritative and
        # unchanged while ``statusTargets`` rides along.
        ready = WorkItemStatusDefinition.objects.create(
            project=self.project_a,
            name="Ready for Lab",
            category="in_progress",
        )
        self.work_a.status_definition = ready
        self.work_a.save()
        custom_type = WorkItemTypeDefinition.objects.create(
            project=self.project_a,
            name="Research Milestone",
            order=10,
        )
        self.work_a.type_definition = custom_type
        self.work_a.save()

        items = self._fetch_items()
        item = items["Target Work A"]

        self.assertEqual(item["statusDefinitionId"], ready.pk)
        self.assertEqual(item["statusName"], "Ready for Lab")
        self.assertEqual(item["statusCategory"], "in_progress")
        self.assertEqual(item["typeDefinitionId"], custom_type.pk)
        self.assertEqual(item["typeName"], "Research Milestone")

        # "Ready for Lab" (order default 0) precedes the default
        # "In Progress" (order 1) — it becomes the in_progress
        # target by the same configured-order rule.
        self.assertEqual(
            self._targets_by_category(item)["in_progress"][
                "statusDefinitionId"
            ],
            ready.pk,
        )

    def test_board_position_does_not_influence_status_targets(self):
        # Two items in the same Project with different Project-local
        # Board positions: the status targets are identical —
        # ``boardPosition`` is never a target-selection input.
        third = create_work_item(
            project=self.project_a,
            actor=self.chris,
            type_definition_id=(
                self.project_a.type_definitions.get(name="Task").pk
            ),
            title="Target Work C",
            assignee_ids=[self.chris.pk],
        )
        self.work_a.board_position = 1
        self.work_a.save(update_fields=["board_position"])
        third.board_position = 99
        third.save(update_fields=["board_position"])

        items = self._fetch_items()

        self.assertEqual(
            items["Target Work A"]["statusTargets"],
            items["Target Work C"]["statusTargets"],
        )

    def test_inaccessible_project_configuration_cannot_leak(self):
        # A Project in a Research Group the user cannot access must
        # contribute no status configuration to the response.
        outsider = User.objects.create_user(
            username="targets_outsider",
            password="TestPass1!",
        )
        secret_group = ResearchGroup.objects.create(
            name="Secret FG",
            created_by=outsider,
        )
        ResearchGroupMembership.objects.create(
            research_group=secret_group,
            user=outsider,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        secret_project = create_project(
            research_group=secret_group,
            creator=outsider,
            name="Secret Project",
        )
        probe = WorkItemStatusDefinition.objects.create(
            project=secret_project,
            name="Leak Probe Review",
            category="review",
            order=1,
        )

        items = self._fetch_items()
        payload = str(list(items.values()))

        self.assertNotIn("Leak Probe Review", payload)
        self.assertNotIn("Secret Project", payload)
        exposed_ids = {
            entry["statusDefinitionId"]
            for item in items.values()
            for entry in item["statusTargets"]
        }
        self.assertNotIn(probe.pk, exposed_ids)
