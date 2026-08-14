"""My Work authorized projection tests.

Proves:
- My Work is a query over canonical WorkItems (no separate model)
- Same WorkItem IDs as Project WorkItem views
- Research Group scoping
- Project membership enforcement
- Stale assignment defense
- Anonymous access denied
"""

from django.contrib.auth import get_user_model
from django.test import Client, TestCase
from rest_framework.test import APIClient, APITestCase

from research_groups.models import ResearchGroup, ResearchGroupMembership
from projects.models import Project, ProjectMembership
from projects.services import create_project, add_project_membership

from work_items.models import WorkItem, WorkItemAssignee
from work_items.services import create_work_item

User = get_user_model()


# ── Setup helpers ──

SEED_PASSWORD = "DevPass1!"


def _create_standard_data():
    """Create the standard Foundation 4 test scenario.

    Paper XYZ:
      Alex: owner
      Chris: member
      Laura: viewer
      Maria: no ProjectMembership (but Research Group member)

    Returns dict with group, users, paper_xyz.
    """
    alex = User.objects.create_user(username="alex", password=SEED_PASSWORD)
    chris = User.objects.create_user(username="chris", password=SEED_PASSWORD)
    maria = User.objects.create_user(username="maria", password=SEED_PASSWORD)
    laura = User.objects.create_user(username="laura", password=SEED_PASSWORD)

    group = ResearchGroup.objects.create(name="FG Example", created_by=alex)
    ResearchGroupMembership.objects.create(
        research_group=group, user=alex,
        role=ResearchGroupMembership.Role.ADMIN,
    )
    ResearchGroupMembership.objects.create(
        research_group=group, user=chris,
        role=ResearchGroupMembership.Role.MEMBER,
    )
    ResearchGroupMembership.objects.create(
        research_group=group, user=maria,
        role=ResearchGroupMembership.Role.MEMBER,
    )
    ResearchGroupMembership.objects.create(
        research_group=group, user=laura,
        role=ResearchGroupMembership.Role.MEMBER,
    )

    paper_xyz = create_project(
        research_group=group, creator=alex, name="Paper XYZ"
    )
    add_project_membership(
        project=paper_xyz, actor=alex,
        target_user=chris, role=ProjectMembership.Role.MEMBER,
    )
    add_project_membership(
        project=paper_xyz, actor=alex,
        target_user=laura, role=ProjectMembership.Role.VIEWER,
    )
    # Maria has NO membership in Paper XYZ

    return {
        "group": group,
        "alex": alex,
        "chris": chris,
        "maria": maria,
        "laura": laura,
        "paper_xyz": paper_xyz,
    }


# ── Domain tests: My Work query semantics ──


class MyWorkDomainTest(TestCase):
    """Test My Work query semantics using the ORM directly."""

    def setUp(self):
        self.data = _create_standard_data()
        # Create "Rewrite Introduction" assigned to Chris
        self.work_item = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="Rewrite Introduction",
            assignee_ids=[self.data["chris"].pk],
        )

    def _get_my_work_ids(self, user, group):
        """Return WorkItem IDs from the My Work query for a user/group."""
        work_items = (
            WorkItem.objects
            .filter(
                assignee_relations__user=user,
                project__research_group_id=group.pk,
                project__memberships__user=user,
                project__memberships__role__in=[
                    ProjectMembership.Role.OWNER,
                    ProjectMembership.Role.MEMBER,
                ],
            )
            .distinct()
            .values_list("pk", flat=True)
        )
        return set(work_items)

    def test_chris_sees_assigned_work_item(self):
        """Chris (member, assigned) sees Rewrite Introduction in My Work."""
        ids = self._get_my_work_ids(self.data["chris"], self.data["group"])
        self.assertIn(self.work_item.pk, ids)

    def test_chris_work_item_has_correct_project_id(self):
        """My Work result has correct Project ID."""
        work_items = list(
            WorkItem.objects
            .filter(
                assignee_relations__user=self.data["chris"],
                project__research_group_id=self.data["group"].pk,
                project__memberships__user=self.data["chris"],
                project__memberships__role__in=[
                    ProjectMembership.Role.OWNER,
                    ProjectMembership.Role.MEMBER,
                ],
            )
            .distinct()
        )
        self.assertEqual(len(work_items), 1)
        self.assertEqual(work_items[0].project_id, self.data["paper_xyz"].pk)
        self.assertEqual(work_items[0].status, WorkItem.Status.TODO)
        # Assignee IDs include Chris
        self.assertEqual(
            list(work_items[0].assignee_relations.values_list(
                "user__pk", flat=True
            )),
            [self.data["chris"].pk],
        )

    def test_alex_does_not_see_chris_work(self):
        """Alex (owner of Project) does NOT see Chris's WorkItem in My Work
        unless Alex is also assigned."""
        ids = self._get_my_work_ids(self.data["alex"], self.data["group"])
        self.assertNotIn(self.work_item.pk, ids)

    def test_laura_viewer_does_not_see(self):
        """Laura (viewer) does not see Chris's WorkItem in My Work.

        Viewers cannot be assigned, so they should have no My Work items
        unless they happen to also be assigned (which they shouldn't be).
        """
        ids = self._get_my_work_ids(self.data["laura"], self.data["group"])
        self.assertNotIn(self.work_item.pk, ids)

    def test_maria_no_project_membership(self):
        """Maria (Research Group member, no ProjectMembership) does not
        see Paper XYZ WorkItems in My Work."""
        ids = self._get_my_work_ids(self.data["maria"], self.data["group"])
        self.assertNotIn(self.work_item.pk, ids)

    def test_unassigned_work_not_in_my_work(self):
        """WorkItem accessible to user but NOT assigned to them does
        not appear in My Work."""
        # Alex creates a WorkItem not assigned to anyone
        unassigned_wi = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="Unassigned Task",
        )
        # Alex can see it through Project but not in My Work
        alex_ids = self._get_my_work_ids(
            self.data["alex"], self.data["group"]
        )
        self.assertNotIn(unassigned_wi.pk, alex_ids)

    def test_multiple_projects_same_group(self):
        """Assigned WorkItems from multiple Projects in the same group
        all appear in My Work."""
        # Create a second project where Chris is a member
        project_b = create_project(
            research_group=self.data["group"],
            creator=self.data["alex"],
            name="Project B",
        )
        add_project_membership(
            project=project_b, actor=self.data["alex"],
            target_user=self.data["chris"],
            role=ProjectMembership.Role.MEMBER,
        )
        wi_b = create_work_item(
            project=project_b, actor=self.data["alex"],
            type=WorkItem.Type.TASK, title="Task B",
            assignee_ids=[self.data["chris"].pk],
        )

        chris_ids = self._get_my_work_ids(
            self.data["chris"], self.data["group"]
        )
        self.assertIn(self.work_item.pk, chris_ids)
        self.assertIn(wi_b.pk, chris_ids)

    def test_other_group_not_leaked(self):
        """Work assigned to current user in Group A does not appear
        in Group B My Work."""
        # Create a second research group
        group_b = ResearchGroup.objects.create(
            name="Other Group", created_by=self.data["alex"]
        )
        ResearchGroupMembership.objects.create(
            research_group=group_b,
            user=self.data["chris"],
            role=ResearchGroupMembership.Role.MEMBER,
        )
        # Chris creates a project in Group B
        project_b = create_project(
            research_group=group_b,
            creator=self.data["chris"],
            name="Project in B",
        )
        create_work_item(
            project=project_b,
            actor=self.data["chris"],
            type=WorkItem.Type.TASK,
            title="Task in B",
            assignee_ids=[self.data["chris"].pk],
        )

        # My Work for Group A should NOT include Group B items
        group_a_ids = self._get_my_work_ids(
            self.data["chris"], self.data["group"]
        )
        self.assertNotIn(project_b.pk, {
            wi.project_id
            for wi in WorkItem.objects.filter(pk__in=group_a_ids)
        })


class MyWorkStaleAssignmentDefense(TestCase):
    """Test that My Work excludes stale/abnormal assignment states.

    These tests use direct ORM setup to create states that normal
    application services should prevent, to prove My Work does not
    trust historical assignment rows by themselves.
    """

    def setUp(self):
        self.data = _create_standard_data()
        self.work_item = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="Stale Test Task",
            assignee_ids=[self.data["chris"].pk],
        )

    def _get_my_work_ids(self, user, group):
        work_items = (
            WorkItem.objects
            .filter(
                assignee_relations__user=user,
                project__research_group_id=group.pk,
                project__memberships__user=user,
                project__memberships__role__in=[
                    ProjectMembership.Role.OWNER,
                    ProjectMembership.Role.MEMBER,
                ],
            )
            .distinct()
            .values_list("pk", flat=True)
        )
        return set(work_items)

    def test_stale_assignment_membership_removed(self):
        """A: WorkItemAssignee exists + ProjectMembership removed.

        My Work must exclude this WorkItem.
        """
        # Directly remove Chris's ProjectMembership
        ProjectMembership.objects.filter(
            project=self.data["paper_xyz"],
            user=self.data["chris"],
        ).delete()

        # WorkItemAssignee still exists
        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=self.work_item,
                user=self.data["chris"],
            ).exists()
        )

        # But My Work must not include it
        ids = self._get_my_work_ids(self.data["chris"], self.data["group"])
        self.assertNotIn(self.work_item.pk, ids)

    def test_stale_assignment_viewer_role(self):
        """B: WorkItemAssignee exists + ProjectMembership role = viewer.

        My Work must exclude this WorkItem.
        """
        # Directly change Chris's role to viewer
        chris_pm = ProjectMembership.objects.get(
            project=self.data["paper_xyz"],
            user=self.data["chris"],
        )
        chris_pm.role = ProjectMembership.Role.VIEWER
        chris_pm.save(update_fields=["role"])

        # WorkItemAssignee still exists
        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=self.work_item,
                user=self.data["chris"],
            ).exists()
        )

        # But My Work must not include it (role filter)
        ids = self._get_my_work_ids(self.data["chris"], self.data["group"])
        self.assertNotIn(self.work_item.pk, ids)

    def test_stale_assignment_group_membership_removed(self):
        """C: WorkItemAssignee exists + ResearchGroupMembership removed.

        This is tested through the API layer where ResearchGroupMembership
        is checked. The query itself does not check ResearchGroupMembership
        directly, but the My Work endpoint requires it.

        We test this at the API level in MyWorkAPITest.
        """
        pass  # Tested in API tests


# ── API tests: My Work endpoint ──


class _MyWorkAuthMixin:
    """Mixin with login helper for My Work API tests."""

    def setUp(self):
        super().setUp()
        self.client = APIClient()

    def _login(self, username, password=SEED_PASSWORD):
        self.client.get("/api/auth/csrf/")
        csrf_token = self.client.cookies.get("csrftoken").value
        self.client.post(
            "/api/auth/login/",
            data={"username": username, "password": password},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )


class MyWorkAPITest(_MyWorkAuthMixin, APITestCase):
    """API tests for GET /api/research-groups/{group_id}/my-work/."""

    @classmethod
    def setUpTestData(cls):
        cls.data = _create_standard_data()
        cls.data["work_item"] = create_work_item(
            project=cls.data["paper_xyz"],
            actor=cls.data["alex"],
            type=WorkItem.Type.TASK,
            title="Rewrite Introduction",
            assignee_ids=[cls.data["chris"].pk],
        )

    def test_chris_sees_work_item(self):
        """Chris sees Rewrite Introduction in My Work."""
        self._login("chris")
        response = self.client.get(
            f"/api/research-groups/{self.data['group'].pk}/my-work/"
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]["id"], self.data["work_item"].pk)

    def test_chris_work_item_has_correct_fields(self):
        """My Work result includes canonical WorkItem fields."""
        self._login("chris")
        response = self.client.get(
            f"/api/research-groups/{self.data['group'].pk}/my-work/"
        )
        data = response.json()[0]
        # Check all expected fields
        expected_fields = [
            "id", "projectId", "type", "title", "description",
            "status", "assigneeIds", "parentId", "dueDate",
            "blockedReason", "completedAt", "createdAt",
            "updatedAt", "createdById",
        ]
        for field in expected_fields:
            self.assertIn(field, data, f"Missing field: {field}")

        self.assertEqual(data["type"], "task")
        self.assertEqual(data["title"], "Rewrite Introduction")
        self.assertEqual(data["status"], "todo")
        self.assertEqual(data["projectId"], self.data["paper_xyz"].pk)
        self.assertIn(self.data["chris"].pk, data["assigneeIds"])

    def test_same_id_as_project_work_items(self):
        """My Work WorkItem ID == Project WorkItems WorkItem ID."""
        self._login("chris")

        # My Work
        my_work_response = self.client.get(
            f"/api/research-groups/{self.data['group'].pk}/my-work/"
        )
        my_work_ids = {item["id"] for item in my_work_response.json()}

        # Project WorkItems
        project_response = self.client.get(
            f"/api/projects/{self.data['paper_xyz'].pk}/work-items/"
        )
        project_ids = {item["id"] for item in project_response.json()}

        self.assertIn(
            self.data["work_item"].pk, my_work_ids,
            "WorkItem should appear in My Work"
        )
        self.assertIn(
            self.data["work_item"].pk, project_ids,
            "WorkItem should appear in Project WorkItems"
        )
        # The ID must be the SAME integer
        my_work_item = next(
            item for item in my_work_response.json()
            if item["id"] == self.data["work_item"].pk
        )
        project_item = next(
            item for item in project_response.json()
            if item["id"] == self.data["work_item"].pk
        )
        self.assertEqual(my_work_item["id"], project_item["id"])

    def test_alex_not_assigned(self):
        """Alex (owner) does not see Chris's WorkItem in My Work."""
        self._login("alex")
        response = self.client.get(
            f"/api/research-groups/{self.data['group'].pk}/my-work/"
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        # Alex should have no My Work items (not assigned to anything)
        ids = {item["id"] for item in data}
        self.assertNotIn(self.data["work_item"].pk, ids)

    def test_laura_viewer(self):
        """Laura (viewer) does not see Chris's WorkItem."""
        self._login("laura")
        response = self.client.get(
            f"/api/research-groups/{self.data['group'].pk}/my-work/"
        )
        self.assertEqual(response.status_code, 200)
        ids = {item["id"] for item in response.json()}
        self.assertNotIn(self.data["work_item"].pk, ids)

    def test_maria_no_access(self):
        """Maria (Research Group member, no ProjectMembership) does not
        see Paper XYZ WorkItem."""
        self._login("maria")
        response = self.client.get(
            f"/api/research-groups/{self.data['group'].pk}/my-work/"
        )
        self.assertEqual(response.status_code, 200)
        ids = {item["id"] for item in response.json()}
        self.assertNotIn(self.data["work_item"].pk, ids)

    def test_anonymous_denied(self):
        """Anonymous request to My Work is denied."""
        response = self.client.get(
            f"/api/research-groups/{self.data['group'].pk}/my-work/"
        )
        self.assertEqual(response.status_code, 401)

    def test_non_member_group(self):
        """User not in the Research Group gets 404 (non-leaking)."""
        outside = User.objects.create_user(
            username="outside", password=SEED_PASSWORD
        )
        self._login("outside")
        response = self.client.get(
            f"/api/research-groups/{self.data['group'].pk}/my-work/"
        )
        self.assertEqual(response.status_code, 404)

    def test_other_group_not_leaked(self):
        """Work in Group A does not appear in Group B My Work."""
        # Create Group B with Chris as member
        group_b = ResearchGroup.objects.create(
            name="Other Group", created_by=self.data["alex"]
        )
        ResearchGroupMembership.objects.create(
            research_group=group_b,
            user=self.data["chris"],
            role=ResearchGroupMembership.Role.MEMBER,
        )
        project_b = create_project(
            research_group=group_b,
            creator=self.data["chris"],
            name="Project in B",
        )
        wi_b = create_work_item(
            project=project_b,
            actor=self.data["chris"],
            type=WorkItem.Type.TASK,
            title="Task in B",
            assignee_ids=[self.data["chris"].pk],
        )

        self._login("chris")
        # My Work for Group A should NOT include Group B items
        response = self.client.get(
            f"/api/research-groups/{self.data['group'].pk}/my-work/"
        )
        ids = {item["id"] for item in response.json()}
        self.assertNotIn(wi_b.pk, ids)

        # My Work for Group B should include Task in B
        response_b = self.client.get(
            f"/api/research-groups/{group_b.pk}/my-work/"
        )
        ids_b = {item["id"] for item in response_b.json()}
        self.assertIn(wi_b.pk, ids_b)

    def test_empty_list_when_no_assignments(self):
        """User with no assigned WorkItems gets an empty list."""
        self._login("maria")
        response = self.client.get(
            f"/api/research-groups/{self.data['group'].pk}/my-work/"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [])

    def test_stale_group_membership_removed(self):
        """WorkItemAssignee exists but ResearchGroupMembership removed:
        My Work must not expose the item."""
        # Login as Chris first
        self._login("chris")

        # Directly remove Chris's ResearchGroupMembership
        ResearchGroupMembership.objects.filter(
            research_group=self.data["group"],
            user=self.data["chris"],
        ).delete()

        # WorkItemAssignee still exists
        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=self.data["work_item"],
                user=self.data["chris"],
            ).exists()
        )

        # My Work should return 404 since Chris no longer has
        # ResearchGroupMembership
        response = self.client.get(
            f"/api/research-groups/{self.data['group'].pk}/my-work/"
        )
        self.assertEqual(response.status_code, 404)
