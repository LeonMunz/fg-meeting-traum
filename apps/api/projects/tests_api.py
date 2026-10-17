"""API permission tests for Project endpoints.

Verifies:
- Effective access requires BOTH ResearchGroupMembership AND ProjectMembership
- Research Group admin alone cannot see private Projects
- 404 for inaccessible Projects (non-leaking)
- 401 for anonymous access
- Owner/member/viewer can read Projects
- Write operations respect owner-only authorization
"""

from django.contrib.auth import get_user_model
from django.test import Client, TestCase
from rest_framework.test import APIClient, APITestCase

from research_groups.models import ResearchGroup, ResearchGroupMembership
from projects.models import Project, ProjectMembership
from projects.services import create_project, add_project_membership
from projects.configuration_services import (
    create_status_definition,
    update_status_definition,
)

User = get_user_model()


class _AuthMixin:
    """Mixin with login helper for APIClient-based tests."""

    def setUp(self):
        super().setUp()
        self.client = APIClient()

    def _login(self, username, password="DevPass1!"):
        self.client.get("/api/auth/csrf/")
        csrf_token = self.client.cookies.get("csrftoken").value
        self.client.post(
            "/api/auth/login/",
            data={"username": username, "password": password},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )

    def _get_csrf_token(self):
        self.client.get("/api/auth/csrf/")
        csrf_cookie = self.client.cookies.get("csrftoken")
        return csrf_cookie.value if csrf_cookie else ""


def _setup_test_data():
    """Create the standard test scenario:

    FG Example group:
    - Alex: admin, Paper XYZ owner
    - Chris: member, Paper XYZ member
    - Maria: member, NO Paper XYZ membership
    - Laura: member, Paper XYZ viewer

    Plus an outside user.
    """
    SEED_PASSWORD = "DevPass1!"

    alex = User.objects.create_user(username="alex", password=SEED_PASSWORD)
    chris = User.objects.create_user(username="chris", password=SEED_PASSWORD)
    maria = User.objects.create_user(username="maria", password=SEED_PASSWORD)
    laura = User.objects.create_user(username="laura", password=SEED_PASSWORD)

    group = ResearchGroup.objects.create(
        name="FG Example", created_by=alex,
    )
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

    # Paper XYZ: Alex owner, Chris member, Laura viewer
    paper_xyz = create_project(
        research_group=group, creator=alex, name="Paper XYZ",
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

    # Outside user
    outside = User.objects.create_user(
        username="outside_user", password=SEED_PASSWORD,
    )

    return {
        "group": group,
        "alex": alex,
        "chris": chris,
        "maria": maria,
        "laura": laura,
        "outside": outside,
        "paper_xyz": paper_xyz,
    }


# ── Project List Tests ──


class ProjectListTest(_AuthMixin, APITestCase):
    """Test GET /api/research-groups/{group_id}/projects/."""

    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()

    def _list_projects(self, username):
        self._login(username)
        return self.client.get(
            f"/api/research-groups/{self.data['group'].pk}/projects/"
        )

    def test_anonymous_cannot_list(self):
        response = self.client.get(
            f"/api/research-groups/{self.data['group'].pk}/projects/"
        )
        self.assertEqual(response.status_code, 401)

    def test_owner_sees_project(self):
        response = self._list_projects("alex")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]["name"], "Paper XYZ")
        self.assertEqual(data[0]["currentUserRole"], "owner")

    def test_member_sees_project(self):
        response = self._list_projects("chris")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]["name"], "Paper XYZ")
        self.assertEqual(data[0]["currentUserRole"], "member")

    def test_viewer_sees_project(self):
        response = self._list_projects("laura")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]["name"], "Paper XYZ")
        self.assertEqual(data[0]["currentUserRole"], "viewer")

    def test_no_membership_does_not_see_project(self):
        """Maria is in the Research Group but has no ProjectMembership."""
        response = self._list_projects("maria")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [])

    def test_outside_user_cannot_list(self):
        response = self._list_projects("outside_user")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [])

    def test_archived_project_is_hidden_by_default(self):
        from projects.services import archive_project

        archive_project(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
        )

        response = self._list_projects("alex")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [])

    def test_archived_project_can_be_included_explicitly(self):
        from projects.services import archive_project

        archive_project(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
        )

        self._login("alex")

        response = self.client.get(
            f"/api/research-groups/{self.data['group'].pk}/projects/"
            "?includeArchived=true"
        )

        self.assertEqual(response.status_code, 200)

        data = response.json()

        self.assertEqual(len(data), 1)
        self.assertEqual(
            data[0]["id"],
            self.data["paper_xyz"].pk,
        )
        self.assertIsNotNone(
            data[0]["archivedAt"],
        )


# ── Project Detail Tests ──


class ProjectDetailTest(_AuthMixin, APITestCase):
    """Test GET /api/projects/{project_id}/."""

    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()

    def _get_project(self, username, project):
        self._login(username)
        return self.client.get(f"/api/projects/{project.pk}/")

    def test_anonymous_cannot_read(self):
        response = self.client.get(
            f"/api/projects/{self.data['paper_xyz'].pk}/"
        )
        self.assertEqual(response.status_code, 401)

    def test_owner_can_read(self):
        response = self._get_project("alex", self.data["paper_xyz"])
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["name"], "Paper XYZ")
        self.assertEqual(data["currentUserRole"], "owner")

    def test_member_can_read(self):
        response = self._get_project("chris", self.data["paper_xyz"])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["name"], "Paper XYZ")

    def test_viewer_can_read(self):
        response = self._get_project("laura", self.data["paper_xyz"])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["name"], "Paper XYZ")

    def test_no_membership_cannot_read(self):
        """Maria cannot read Paper XYZ even if she knows the ID."""
        response = self._get_project("maria", self.data["paper_xyz"])
        self.assertEqual(response.status_code, 404)

    def test_outside_user_cannot_read(self):
        response = self._get_project("outside_user", self.data["paper_xyz"])
        self.assertEqual(response.status_code, 404)

    def test_knowing_id_does_not_leak_content(self):
        """Maria knows Paper XYZ ID but cannot get its data."""
        response = self._get_project("maria", self.data["paper_xyz"])
        self.assertEqual(response.status_code, 404)
        self.assertNotIn("Paper XYZ", str(response.json()))


# ── Maria Private Project — Admin Isolation ──


class AdminIsolationTest(_AuthMixin, APITestCase):
    """Mandatory: Alex = Research Group admin, Maria = Project owner.

    Alex has NO ProjectMembership in Maria's project.
    Alex must NOT see it.
    """

    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()
        # Maria creates her own private project
        cls.maria_project = create_project(
            research_group=cls.data["group"],
            creator=cls.data["maria"],
            name="Maria Private Project",
        )
        # Alex has no membership here

    def test_admin_does_not_see_private_project_in_list(self):
        self._login("alex")
        response = self.client.get(
            f"/api/research-groups/{self.data['group'].pk}/projects/"
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        project_ids = [p["id"] for p in data]
        self.assertNotIn(self.maria_project.pk, project_ids)

    def test_admin_cannot_open_private_project(self):
        self._login("alex")
        response = self.client.get(
            f"/api/projects/{self.maria_project.pk}/"
        )
        self.assertEqual(response.status_code, 404)

    def test_admin_cannot_read_memberships(self):
        self._login("alex")
        response = self.client.get(
            f"/api/projects/{self.maria_project.pk}/memberships/"
        )
        self.assertEqual(response.status_code, 404)

    def test_maria_owner_sees_her_project(self):
        self._login("maria")
        response = self.client.get(
            f"/api/projects/{self.maria_project.pk}/"
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["name"], "Maria Private Project")
        self.assertEqual(data["currentUserRole"], "owner")


# ── Write Authorization Tests ──


class ProjectWriteTest(_AuthMixin, APITestCase):
    """Test Project write operations."""

    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()

    def test_member_cannot_update_project(self):
        """Chris (member) cannot PATCH Paper XYZ."""
        self._login("chris")
        csrf = self._get_csrf_token()
        response = self.client.patch(
            f"/api/projects/{self.data['paper_xyz'].pk}/",
            data={"name": "Hacked"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )
        self.assertEqual(response.status_code, 403)

    def test_viewer_cannot_update_project(self):
        """Laura (viewer) cannot PATCH Paper XYZ."""
        self._login("laura")
        csrf = self._get_csrf_token()
        response = self.client.patch(
            f"/api/projects/{self.data['paper_xyz'].pk}/",
            data={"name": "Hacked"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )
        self.assertEqual(response.status_code, 403)

    def test_owner_can_update_project(self):
        """Alex (owner) can PATCH Paper XYZ."""
        self._login("alex")
        csrf = self._get_csrf_token()
        response = self.client.patch(
            f"/api/projects/{self.data['paper_xyz'].pk}/",
            data={"name": "Updated Paper XYZ"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["name"], "Updated Paper XYZ")

    def test_no_membership_cannot_update_project(self):
        """Maria (no membership) gets 404, not 403."""
        self._login("maria")
        csrf = self._get_csrf_token()
        response = self.client.patch(
            f"/api/projects/{self.data['paper_xyz'].pk}/",
            data={"name": "Hacked"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )
        self.assertEqual(response.status_code, 404)


class ProjectCreateTest(_AuthMixin, APITestCase):
    """Test Project creation."""

    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()

    def test_group_member_can_create(self):
        """Chris can create a Project."""
        self._login("chris")
        csrf = self._get_csrf_token()
        response = self.client.post(
            f"/api/research-groups/{self.data['group'].pk}/projects/",
            data={"name": "Chris Project"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )
        self.assertEqual(response.status_code, 201)
        data = response.json()
        self.assertEqual(data["name"], "Chris Project")
        self.assertEqual(data["currentUserRole"], "owner")

    def test_non_group_user_cannot_create(self):
        """Outside user cannot create a Project."""
        self._login("outside_user")
        csrf = self._get_csrf_token()
        response = self.client.post(
            f"/api/research-groups/{self.data['group'].pk}/projects/",
            data={"name": "Bad Project"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )
        self.assertEqual(response.status_code, 404)

    def test_anonymous_cannot_create(self):
        response = self.client.post(
            f"/api/research-groups/{self.data['group'].pk}/projects/",
            data={"name": "Bad Project"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 401)


class MembershipManagementTest(_AuthMixin, APITestCase):
    """Test membership list/add/remove."""

    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()

    def _get_memberships(self, username):
        self._login(username)
        return self.client.get(
            f"/api/projects/{self.data['paper_xyz'].pk}/memberships/"
        )

    def test_owner_can_list_memberships(self):
        response = self._get_memberships("alex")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        usernames = {m["user"]["username"] for m in data}
        self.assertIn("alex", usernames)
        self.assertIn("chris", usernames)
        self.assertIn("laura", usernames)

    def test_member_can_list_memberships(self):
        response = self._get_memberships("chris")
        self.assertEqual(response.status_code, 200)

    def test_viewer_can_list_memberships(self):
        response = self._get_memberships("laura")
        self.assertEqual(response.status_code, 200)

    def test_no_membership_cannot_list(self):
        """Maria cannot list Paper XYZ memberships."""
        self._login("maria")
        response = self.client.get(
            f"/api/projects/{self.data['paper_xyz'].pk}/memberships/"
        )
        self.assertEqual(response.status_code, 404)

    def test_owner_can_add_membership(self):
        """Alex can add Maria to Paper XYZ."""
        self._login("alex")
        csrf = self._get_csrf_token()
        response = self.client.post(
            f"/api/projects/{self.data['paper_xyz'].pk}/memberships/",
            data={
                "userId": self.data["maria"].pk,
                "role": "member",
            },
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["role"], "member")

    def test_member_cannot_add_membership(self):
        """Chris cannot add a membership."""
        self._login("chris")
        csrf = self._get_csrf_token()
        response = self.client.post(
            f"/api/projects/{self.data['paper_xyz'].pk}/memberships/",
            data={
                "userId": self.data["maria"].pk,
                "role": "member",
            },
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )
        self.assertEqual(response.status_code, 403)

    def test_cannot_add_non_group_user(self):
        """Cannot add a user outside the Research Group."""
        outside = User.objects.create_user(
            username="non_group_add", password="DevPass1!",
        )
        self._login("alex")
        csrf = self._get_csrf_token()
        response = self.client.post(
            f"/api/projects/{self.data['paper_xyz'].pk}/memberships/",
            data={
                "userId": outside.pk,
                "role": "member",
            },
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )
        self.assertEqual(response.status_code, 400)

    def test_duplicate_membership_rejected(self):
        """Cannot add a user who already has membership."""
        self._login("alex")
        csrf = self._get_csrf_token()
        response = self.client.post(
            f"/api/projects/{self.data['paper_xyz'].pk}/memberships/",
            data={
                "userId": self.data["chris"].pk,
                "role": "viewer",
            },
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )
        self.assertEqual(response.status_code, 400)


class ResearchGroupMembersTest(_AuthMixin, APITestCase):
    """Test GET /api/research-groups/{group_id}/members/."""

    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()

    def test_group_member_can_list(self):
        self._login("alex")
        response = self.client.get(
            f"/api/research-groups/{self.data['group'].pk}/members/"
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        usernames = {m["username"] for m in data}
        self.assertIn("alex", usernames)
        self.assertIn("chris", usernames)

    def test_non_group_user_cannot_list(self):
        self._login("outside_user")
        response = self.client.get(
            f"/api/research-groups/{self.data['group'].pk}/members/"
        )
        self.assertEqual(response.status_code, 404)


class CSRFRegressionTest(TestCase):
    """Regression: authenticated unsafe Project endpoints still require CSRF."""

    def test_project_patch_requires_csrf(self):
        """PATCH /api/projects/ without CSRF should be rejected (403)."""
        from projects.services import create_project
        from research_groups.models import ResearchGroup, ResearchGroupMembership

        group = ResearchGroup.objects.create(
            name="CSRF Test",
            created_by=User.objects.create_user(
                username="csrf_owner", password="DevPass1!"
            ),
        )
        owner = User.objects.get(username="csrf_owner")
        ResearchGroupMembership.objects.create(
            research_group=group,
            user=owner,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        project = create_project(
            research_group=group, creator=owner, name="CSRF Project",
        )

        django_client = Client(enforce_csrf_checks=True)
        django_client.force_login(owner)

        # PATCH without CSRF should be rejected
        response = django_client.patch(
            f"/api/projects/{project.pk}/",
            data={"name": "Hacked"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)


class AssignmentProtectionAPITest(_AuthMixin, APITestCase):
    """API tests for assignment lifecycle protection.

    Verifies that membership mutations return 400 when the target user
    has active WorkItem assignments in the project.
    """

    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()
        # Create a WorkItem assigned to Chris in Paper XYZ
        from work_items.services import create_work_item

        task_type = cls.data["paper_xyz"].type_definitions.get(name="Task")
        cls.data["assigned_work_item"] = create_work_item(
            project=cls.data["paper_xyz"],
            actor=cls.data["alex"],
            type_definition_id=task_type.pk,
            title="API Test Task",
            assignee_ids=[cls.data["chris"].pk],
        )

    def _get_chris_membership(self):
        """Return Chris's membership in Paper XYZ."""
        return ProjectMembership.objects.get(
            project=self.data["paper_xyz"],
            user=self.data["chris"],
        )

    def test_patch_assigned_member_to_viewer_returns_400(self):
        """PATCH membership to viewer returns 400 when user is assigned."""
        self._login("alex")
        csrf = self._get_csrf_token()

        chris_membership = self._get_chris_membership()
        response = self.client.patch(
            f"/api/projects/{self.data['paper_xyz'].pk}/memberships/{chris_membership.pk}/",
            data={"role": "viewer"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )
        self.assertEqual(response.status_code, 400)
        # Error message must NOT leak private WorkItem titles
        error = response.json().get("error", "")
        self.assertNotIn("API Test Task", error)
        self.assertIn("unassigned", error.lower())

    def test_delete_assigned_member_returns_400(self):
        """DELETE assigned member returns 400."""
        self._login("alex")
        csrf = self._get_csrf_token()

        chris_membership = self._get_chris_membership()
        response = self.client.delete(
            f"/api/projects/{self.data['paper_xyz'].pk}/memberships/{chris_membership.pk}/",
            HTTP_X_CSRFTOKEN=csrf,
        )
        self.assertEqual(response.status_code, 400)
        error = response.json().get("error", "")
        self.assertIn("unassigned", error.lower())

    def test_patch_unassigned_member_to_viewer_succeeds(self):
        """PATCH unassigned member (Laura is viewer already) to viewer succeeds."""
        self._login("alex")
        csrf = self._get_csrf_token()

        # Create an unassigned member
        another = User.objects.create_user(username="bob", password="DevPass1!")
        from research_groups.models import ResearchGroupMembership
        ResearchGroupMembership.objects.create(
            research_group=self.data["group"],
            user=another,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        add_project_membership(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            target_user=another,
            role=ProjectMembership.Role.MEMBER,
        )
        another_membership = ProjectMembership.objects.get(
            project=self.data["paper_xyz"], user=another
        )
        response = self.client.patch(
            f"/api/projects/{self.data['paper_xyz'].pk}/memberships/{another_membership.pk}/",
            data={"role": "viewer"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["role"], "viewer")

    def test_delete_unassigned_member_succeeds(self):
        """DELETE unassigned member succeeds."""
        self._login("alex")
        csrf = self._get_csrf_token()

        another = User.objects.create_user(username="bob2", password="DevPass1!")
        from research_groups.models import ResearchGroupMembership
        ResearchGroupMembership.objects.create(
            research_group=self.data["group"],
            user=another,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        add_project_membership(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            target_user=another,
            role=ProjectMembership.Role.MEMBER,
        )
        another_membership = ProjectMembership.objects.get(
            project=self.data["paper_xyz"], user=another
        )
        response = self.client.delete(
            f"/api/projects/{self.data['paper_xyz'].pk}/memberships/{another_membership.pk}/",
            HTTP_X_CSRFTOKEN=csrf,
        )
        self.assertEqual(response.status_code, 200)


class StatusDefaultCategoryProtectionAPITest(_AuthMixin, APITestCase):
    """API: PATCH /work-item-configuration/statuses/{id}/ must reject a
    recategorization of the active default status away from 'todo' AND a
    default assignment whose effective final state is inactive, each with
    a controlled 400 and no changes (atomic rejection).
    """

    @classmethod
    def setUpTestData(cls):
        cls.alex = User.objects.create_user(
            username="prot_alex", password="DevPass1!",
        )
        cls.group = ResearchGroup.objects.create(
            name="FG Protection", created_by=cls.alex,
        )
        ResearchGroupMembership.objects.create(
            research_group=cls.group,
            user=cls.alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        cls.project = create_project(
            research_group=cls.group,
            creator=cls.alex,
            name="Protection Project",
        )
        from projects.models import WorkItemStatusDefinition

        cls.default_status = WorkItemStatusDefinition.objects.get(
            project=cls.project, is_default=True, active=True,
        )

    def _patch_status(self, payload, definition=None):
        definition = definition or self.default_status
        csrf = self._get_csrf_token()
        return self.client.patch(
            f"/api/projects/{self.project.pk}"
            f"/work-item-configuration/statuses/{definition.pk}/",
            data=payload,
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )

    def test_recategory_active_default_returns_400(self):
        """8) Recategorizing the active default to 'done' is a controlled
        400 and leaves category / active / is_default unchanged."""
        self._login("prot_alex")

        response = self._patch_status({"category": "done"})

        self.assertEqual(response.status_code, 400)
        self.assertIn("error", response.json())
        self.default_status.refresh_from_db()
        self.assertEqual(self.default_status.category, "todo")
        self.assertTrue(self.default_status.active)
        self.assertTrue(self.default_status.is_default)

    def test_inactive_default_target_returns_400(self):
        """An inactive todo status requested as the default in a PATCH is
        a controlled 400 (its effective final state is inactive) and
        leaves the previous active default untouched."""
        self._login("prot_alex")

        backlog = create_status_definition(
            self.project, self.alex, "Backlog", "todo",
        )
        update_status_definition(backlog, self.alex, active=False)

        response = self._patch_status(
            {"isDefault": True}, definition=backlog,
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("error", response.json())
        self.default_status.refresh_from_db()
        self.assertEqual(self.default_status.category, "todo")
        self.assertTrue(self.default_status.active)
        self.assertTrue(self.default_status.is_default)
        backlog.refresh_from_db()
        self.assertFalse(backlog.is_default)
        self.assertFalse(backlog.active)

    def test_combined_activation_and_default_assignment_accepted(self):
        """The combined payload that activates the inactive todo status
        and makes it the default in one PATCH is accepted: it becomes
        the single active default, and the previous default remains a
        regular active status."""
        self._login("prot_alex")

        backlog = create_status_definition(
            self.project, self.alex, "Backlog", "todo",
        )
        update_status_definition(backlog, self.alex, active=False)

        response = self._patch_status(
            {"isDefault": True, "active": True}, definition=backlog,
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["active"])
        self.assertTrue(body["isDefault"])
        backlog.refresh_from_db()
        self.assertTrue(backlog.active)
        self.assertTrue(backlog.is_default)
        self.default_status.refresh_from_db()
        self.assertTrue(self.default_status.active)
        self.assertFalse(self.default_status.is_default)

        from projects.models import WorkItemStatusDefinition

        defaults = WorkItemStatusDefinition.objects.filter(
            project=self.project, active=True, is_default=True,
        )
        self.assertEqual(defaults.count(), 1)
        self.assertEqual(defaults.first().pk, backlog.pk)

    def test_combined_isdefault_false_returns_400(self):
        """The combined payload must not bypass the protection either."""
        self._login("prot_alex")

        response = self._patch_status(
            {"category": "done", "isDefault": False},
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("error", response.json())
        self.default_status.refresh_from_db()
        self.assertEqual(self.default_status.category, "todo")
        self.assertTrue(self.default_status.active)
        self.assertTrue(self.default_status.is_default)
