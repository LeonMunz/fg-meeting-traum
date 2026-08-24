"""API and admin permission tests for WorkItem endpoints.

Verifies:
- Read authorization through Project security boundary
- Write authorization (owner/member can write, viewer cannot)
- CSRF enforcement
- Admin restrictions
"""

from django.contrib.auth import get_user_model
from django.test import Client, TestCase
from rest_framework.test import APIClient, APITestCase

from research_groups.models import ResearchGroup, ResearchGroupMembership
from projects.models import Project, ProjectMembership
from projects.services import create_project, add_project_membership

from work_items.models import WorkItem, WorkItemAssignee
from work_items.services import create_work_item, update_work_item

User = get_user_model()


# ── Setup helpers ──


def _setup_test_data():
    """Create the standard test scenario.

    FG Example group:
    - Alex: admin, Paper XYZ owner
    - Chris: member, Paper XYZ member
    - Maria: member, NO Paper XYZ membership
    - Laura: member, Paper XYZ viewer

    Returns dict with group, users, paper_xyz.
    """
    SEED_PASSWORD = "DevPass1!"

    alex = User.objects.create_user(username="alex", password=SEED_PASSWORD)
    chris = User.objects.create_user(username="chris", password=SEED_PASSWORD)
    maria = User.objects.create_user(username="maria", password=SEED_PASSWORD)
    laura = User.objects.create_user(username="laura", password=SEED_PASSWORD)

    group = ResearchGroup.objects.create(name="FG Example", created_by=alex)
    ResearchGroupMembership.objects.create(
        research_group=group, user=alex, role=ResearchGroupMembership.Role.ADMIN,
    )
    ResearchGroupMembership.objects.create(
        research_group=group, user=chris, role=ResearchGroupMembership.Role.MEMBER,
    )
    ResearchGroupMembership.objects.create(
        research_group=group, user=maria, role=ResearchGroupMembership.Role.MEMBER,
    )
    ResearchGroupMembership.objects.create(
        research_group=group, user=laura, role=ResearchGroupMembership.Role.MEMBER,
    )

    paper_xyz = create_project(research_group=group, creator=alex, name="Paper XYZ")
    add_project_membership(project=paper_xyz, actor=alex, target_user=chris, role=ProjectMembership.Role.MEMBER)
    add_project_membership(project=paper_xyz, actor=alex, target_user=laura, role=ProjectMembership.Role.VIEWER)

    task_type = paper_xyz.type_definitions.get(name="Task")
    epic_type = paper_xyz.type_definitions.get(name="Epic")
    done_status = paper_xyz.status_definitions.get(name="Done")
    review_status = paper_xyz.status_definitions.get(name="Review")

    # Create a WorkItem in Paper XYZ
    wi = create_work_item(
        project=paper_xyz, actor=alex,
        type_definition_id=task_type.pk, title="Rewrite Introduction",
        assignee_ids=[chris.pk],
    )

    return {
        "group": group,
        "alex": alex,
        "chris": chris,
        "maria": maria,
        "laura": laura,
        "paper_xyz": paper_xyz,
        "work_item": wi,
        "task_type": task_type,
        "epic_type": epic_type,
        "done_status": done_status,
        "review_status": review_status,
    }


# ── Auth Mixin ──


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


# ── WorkItem List Tests ──


class WorkItemListTest(_AuthMixin, APITestCase):
    """Test GET /api/projects/{project_id}/work-items/."""

    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()

    def _list_work_items(self, username):
        self._login(username)
        return self.client.get(
            f"/api/projects/{self.data['paper_xyz'].pk}/work-items/"
        )

    def test_anonymous_cannot_list(self):
        response = self.client.get(
            f"/api/projects/{self.data['paper_xyz'].pk}/work-items/"
        )
        self.assertEqual(response.status_code, 401)

    def test_owner_sees_work_items(self):
        response = self._list_work_items("alex")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]["title"], "Rewrite Introduction")

    def test_member_sees_work_items(self):
        response = self._list_work_items("chris")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()), 1)

    def test_viewer_sees_work_items(self):
        response = self._list_work_items("laura")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()), 1)

    def test_no_membership_cannot_list(self):
        """Maria has no ProjectMembership — must get empty list."""
        response = self._list_work_items("maria")
        self.assertEqual(response.status_code, 404)

    def test_no_membership_cannot_leak(self):
        """Maria cannot list WorkItems even if she knows the Project ID."""
        response = self._list_work_items("maria")
        self.assertEqual(response.status_code, 404)
        self.assertNotIn("Rewrite Introduction", str(response.json()))


# ── WorkItem Detail Tests ──


class WorkItemDetailTest(_AuthMixin, APITestCase):
    """Test GET /api/work-items/{work_item_id}/."""

    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()

    def _get_work_item(self, username, work_item):
        self._login(username)
        return self.client.get(f"/api/work-items/{work_item.pk}/")

    def test_anonymous_cannot_read(self):
        response = self.client.get(
            f"/api/work-items/{self.data['work_item'].pk}/"
        )
        self.assertEqual(response.status_code, 401)

    def test_owner_can_read(self):
        response = self._get_work_item("alex", self.data["work_item"])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["title"], "Rewrite Introduction")

    def test_member_can_read(self):
        response = self._get_work_item("chris", self.data["work_item"])
        self.assertEqual(response.status_code, 200)

    def test_viewer_can_read(self):
        response = self._get_work_item("laura", self.data["work_item"])
        self.assertEqual(response.status_code, 200)

    def test_no_membership_cannot_read(self):
        response = self._get_work_item("maria", self.data["work_item"])
        self.assertEqual(response.status_code, 404)

    def test_knowing_id_does_not_leak(self):
        response = self._get_work_item("maria", self.data["work_item"])
        self.assertEqual(response.status_code, 404)
        self.assertNotIn("Rewrite Introduction", str(response.json()))


# ── Maria Private Project — Admin Isolation ──


class WorkItemAdminIsolationTest(_AuthMixin, APITestCase):
    """Mandatory: Alex = Research Group admin, Maria = Project owner.

    Alex has NO ProjectMembership in Maria's project.
    Alex must NOT see WorkItems in Maria's project.
    """

    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()
        cls.maria_project = create_project(
            research_group=cls.data["group"],
            creator=cls.data["maria"],
            name="Maria Private Project",
        )
        cls.maria_task_type = cls.maria_project.type_definitions.get(name="Task")
        cls.maria_wi = create_work_item(
            project=cls.maria_project,
            actor=cls.data["maria"],
            type_definition_id=cls.maria_task_type.pk,
            title="Maria Secret Task",
        )

    def test_admin_cannot_list_private_project_work_items(self):
        self._login("alex")
        response = self.client.get(
            f"/api/projects/{self.maria_project.pk}/work-items/"
        )
        self.assertEqual(response.status_code, 404)

    def test_admin_cannot_read_private_work_item(self):
        self._login("alex")
        response = self.client.get(
            f"/api/work-items/{self.maria_wi.pk}/"
        )
        self.assertEqual(response.status_code, 404)
        self.assertNotIn("Maria Secret Task", str(response.json()))

    def test_maria_owner_sees_her_work_items(self):
        self._login("maria")
        response = self.client.get(
            f"/api/projects/{self.maria_project.pk}/work-items/"
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]["title"], "Maria Secret Task")


# ── WorkItem Create Tests ──


class WorkItemCreateTest(_AuthMixin, APITestCase):
    """Test POST /api/projects/{project_id}/work-items/."""

    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()

    def _create_work_item(self, username, data):
        self._login(username)
        csrf = self._get_csrf_token()
        return self.client.post(
            f"/api/projects/{self.data['paper_xyz'].pk}/work-items/",
            data=data,
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )

    def test_owner_can_create(self):
        response = self._create_work_item("alex", {
            "typeDefinitionId": self.data["task_type"].pk,
            "title": "Owner Task",
        })
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["title"], "Owner Task")

    def test_member_can_create(self):
        response = self._create_work_item("chris", {
            "typeDefinitionId": self.data["task_type"].pk,
            "title": "Member Task",
        })
        self.assertEqual(response.status_code, 201)

    def test_viewer_cannot_create(self):
        response = self._create_work_item("laura", {
            "typeDefinitionId": self.data["task_type"].pk,
            "title": "Viewer Task",
        })
        self.assertEqual(response.status_code, 403)

    def test_no_membership_cannot_create(self):
        response = self._create_work_item("maria", {
            "typeDefinitionId": self.data["task_type"].pk,
            "title": "No Access Task",
        })
        self.assertEqual(response.status_code, 404)

    def test_admin_without_membership_cannot_create(self):
        """Maria is a Research Group member but has no ProjectMembership."""
        response = self._create_work_item("maria", {
            "typeDefinitionId": self.data["task_type"].pk,
            "title": "No Access Task",
        })
        self.assertEqual(response.status_code, 404)

    def test_creator_cannot_be_spoofed(self):
        """Client cannot set createdById."""
        response = self._create_work_item("alex", {
            "typeDefinitionId": self.data["task_type"].pk,
            "title": "Spoof Test",
            "createdById": self.data["chris"].pk,
        })
        self.assertEqual(response.status_code, 201)
        # createdById should still be alex
        wi = WorkItem.objects.get(title="Spoof Test")
        self.assertEqual(wi.created_by, self.data["alex"])

    def test_project_cannot_be_spoofed(self):
        """Client cannot set projectId."""
        other_project = create_project(
            research_group=self.data["group"],
            creator=self.data["alex"],
            name="Other Project",
        )
        response = self._create_work_item("alex", {
            "typeDefinitionId": self.data["task_type"].pk,
            "title": "Project Spoof",
            "projectId": other_project.pk,
        })
        self.assertEqual(response.status_code, 201)
        # WorkItem should be in paper_xyz, not other_project
        wi = WorkItem.objects.get(title="Project Spoof")
        self.assertEqual(wi.project, self.data["paper_xyz"])

    def test_eligible_owner_assignee_accepted(self):
        response = self._create_work_item("alex", {
            "typeDefinitionId": self.data["task_type"].pk,
            "title": "Assign Owner",
            "assigneeIds": [self.data["alex"].pk],
        })
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["assigneeIds"], [self.data["alex"].pk])

    def test_eligible_member_assignee_accepted(self):
        response = self._create_work_item("alex", {
            "typeDefinitionId": self.data["task_type"].pk,
            "title": "Assign Member",
            "assigneeIds": [self.data["chris"].pk],
        })
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["assigneeIds"], [self.data["chris"].pk])

    def test_viewer_assignee_rejected(self):
        response = self._create_work_item("alex", {
            "typeDefinitionId": self.data["task_type"].pk,
            "title": "Assign Viewer",
            "assigneeIds": [self.data["laura"].pk],
        })
        self.assertEqual(response.status_code, 400)

    def test_non_member_assignee_rejected(self):
        response = self._create_work_item("alex", {
            "typeDefinitionId": self.data["task_type"].pk,
            "title": "Assign Non-member",
            "assigneeIds": [self.data["maria"].pk],
        })
        self.assertEqual(response.status_code, 400)

    def test_invalid_parent_rejected(self):
        """Non-existent parent."""
        response = self._create_work_item("alex", {
            "typeDefinitionId": self.data["task_type"].pk,
            "title": "Bad Parent",
            "parentId": 99999,
        })
        self.assertEqual(response.status_code, 400)

    def test_cross_project_parent_rejected(self):
        other_project = create_project(
            research_group=self.data["group"],
            creator=self.data["alex"],
            name="Other Project",
        )
        other_task_type = other_project.type_definitions.get(name="Task")
        other_wi = create_work_item(
            project=other_project,
            actor=self.data["alex"],
            type_definition_id=other_task_type.pk,
            title="Other Task",
        )
        response = self._create_work_item("alex", {
            "typeDefinitionId": self.data["task_type"].pk,
            "title": "Cross Project Child",
            "parentId": other_wi.pk,
        })
        self.assertEqual(response.status_code, 400)

    def test_atomic_rollback_on_invalid_assignment(self):
        """If assignee validation fails, the WorkItem should not be created."""
        response = self._create_work_item("alex", {
            "typeDefinitionId": self.data["task_type"].pk,
            "title": "Rollback Test",
            "assigneeIds": [self.data["chris"].pk, self.data["maria"].pk],
        })
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            WorkItem.objects.filter(title="Rollback Test").count(), 0
        )


# ── WorkItem Update Tests ──


class WorkItemUpdateTest(_AuthMixin, APITestCase):
    """Test PATCH /api/work-items/{work_item_id}/."""

    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()

    def _patch_work_item(self, username, work_item, data):
        self._login(username)
        csrf = self._get_csrf_token()
        return self.client.patch(
            f"/api/work-items/{work_item.pk}/",
            data=data,
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )

    def test_owner_can_update(self):
        response = self._patch_work_item(
            "alex", self.data["work_item"], {"title": "Updated"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["title"], "Updated")

    def test_member_can_update(self):
        response = self._patch_work_item(
            "chris", self.data["work_item"], {"title": "Chris Update"},
        )
        self.assertEqual(response.status_code, 200)

    def test_viewer_cannot_update(self):
        response = self._patch_work_item(
            "laura", self.data["work_item"], {"title": "Hacked"},
        )
        self.assertEqual(response.status_code, 403)

    def test_no_membership_cannot_update(self):
        response = self._patch_work_item(
            "maria", self.data["work_item"], {"title": "Hacked"},
        )
        self.assertEqual(response.status_code, 404)

    def test_project_cannot_be_changed(self):
        other_project = create_project(
            research_group=self.data["group"],
            creator=self.data["alex"],
            name="Other Project",
        )
        response = self._patch_work_item(
            "alex", self.data["work_item"], {
                "projectId": other_project.pk,
            },
        )
        self.assertEqual(response.status_code, 400)

    def test_created_by_cannot_be_changed(self):
        response = self._patch_work_item(
            "alex", self.data["work_item"], {
                "createdById": self.data["chris"].pk,
            },
        )
        wi = WorkItem.objects.get(pk=self.data["work_item"].pk)
        self.assertEqual(wi.created_by, self.data["alex"])

    def test_completed_at_cannot_be_directly_changed(self):
        """Setting completedAt directly should not work."""
        response = self._patch_work_item(
            "alex", self.data["work_item"], {
                "completedAt": "2020-01-01T00:00:00Z",
            },
        )
        wi = WorkItem.objects.get(pk=self.data["work_item"].pk)
        # Status is todo, so completed_at should be None
        self.assertIsNone(wi.completed_at)

    def test_assignees_can_be_replaced(self):
        response = self._patch_work_item(
            "alex", self.data["work_item"], {
                "assigneeIds": [self.data["alex"].pk],
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["assigneeIds"], [self.data["alex"].pk])

    def test_invalid_assignee_set_rolls_back(self):
        response = self._patch_work_item(
            "alex", self.data["work_item"], {
                "assigneeIds": [self.data["chris"].pk, self.data["maria"].pk],
            },
        )
        self.assertEqual(response.status_code, 400)
        # Original assignee should be preserved
        wi = WorkItem.objects.get(pk=self.data["work_item"].pk)
        assignees = list(wi.assignee_relations.values_list("user__pk", flat=True))
        self.assertEqual(assignees, [self.data["chris"].pk])

    def test_parent_can_change(self):
        parent = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type_definition_id=self.data["epic_type"].pk,
            title="Epic Parent",
        )
        response = self._patch_work_item(
            "alex", self.data["work_item"], {
                "parentId": parent.pk,
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["parentId"], parent.pk)

    def test_cycle_rejected(self):
        a = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type_definition_id=self.data["task_type"].pk,
            title="A",
        )
        b = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type_definition_id=self.data["task_type"].pk,
            title="B",
            parent_id=a.pk,
        )
        response = self._patch_work_item(
            "alex", a, {"parentId": b.pk},
        )
        self.assertEqual(response.status_code, 400)

    def test_parent_can_clear(self):
        parent = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type_definition_id=self.data["epic_type"].pk,
            title="Epic",
        )
        child = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type_definition_id=self.data["task_type"].pk,
            title="Child",
            parent_id=parent.pk,
        )
        response = self._patch_work_item(
            "alex", child, {"parentId": None},
        )
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["parentId"])

    def test_blocked_reason_set(self):
        response = self._patch_work_item(
            "alex", self.data["work_item"], {
                "blockedReason": "Waiting on data",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["blockedReason"], "Waiting on data")

    def test_blocked_reason_clear(self):
        update_work_item(
            work_item=self.data["work_item"],
            actor=self.data["alex"],
            blocked_reason="Waiting on data",
        )
        response = self._patch_work_item(
            "alex", self.data["work_item"], {
                "blockedReason": "",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["blockedReason"], None)

    def test_blocked_reason_clear_with_null(self):
        update_work_item(
            work_item=self.data["work_item"],
            actor=self.data["alex"],
            blocked_reason="Waiting on data",
        )

        response = self._patch_work_item(
            "alex",
            self.data["work_item"],
            {
                "blockedReason": None,
            },
        )

        self.assertEqual(
            response.status_code,
            200,
        )
        self.assertIsNone(
            response.json()["blockedReason"],
        )

        self.data[
            "work_item"
        ].refresh_from_db()

        self.assertEqual(
            self.data[
                "work_item"
            ].blocked_reason,
            "",
        )

    def test_done_sets_completed_at(self):
        response = self._patch_work_item(
            "alex", self.data["work_item"], {
                "statusDefinitionId": self.data["done_status"].pk,
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertIsNotNone(response.json()["completedAt"])

    def test_reopen_clears_completed_at(self):
        update_work_item(
            work_item=self.data["work_item"],
            actor=self.data["alex"],
            status_definition_id=self.data["done_status"].pk,
        )
        self.data["work_item"].refresh_from_db()
        self.assertIsNotNone(self.data["work_item"].completed_at)

        response = self._patch_work_item(
            "alex", self.data["work_item"], {
                "statusDefinitionId": self.data["review_status"].pk,
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["completedAt"])


# ── CSRF Regression ──


class WorkItemCSRFRegressionTest(TestCase):
    """Regression: authenticated unsafe WorkItem endpoints still require CSRF."""

    def test_work_item_post_requires_csrf(self):
        """POST /api/projects/{project_id}/work-items/ without CSRF should be rejected."""
        group = ResearchGroup.objects.create(
            name="CSRF Test",
            created_by=User.objects.create_user(username="csrf_owner", password="DevPass1!"),
        )
        owner = User.objects.get(username="csrf_owner")
        ResearchGroupMembership.objects.create(
            research_group=group, user=owner,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        project = create_project(research_group=group, creator=owner, name="CSRF Project")
        task_type = project.type_definitions.get(name="Task")

        django_client = Client(enforce_csrf_checks=True)
        django_client.force_login(owner)

        response = django_client.post(
            f"/api/projects/{project.pk}/work-items/",
            data={"typeDefinitionId": task_type.pk, "title": "No CSRF"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)

    def test_work_item_patch_requires_csrf(self):
        """PATCH /api/work-items/{id}/ without CSRF should be rejected."""
        group = ResearchGroup.objects.create(
            name="CSRF Test2",
            created_by=User.objects.create_user(username="csrf_owner2", password="DevPass1!"),
        )
        owner = User.objects.get(username="csrf_owner2")
        ResearchGroupMembership.objects.create(
            research_group=group, user=owner,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        project = create_project(research_group=group, creator=owner, name="CSRF Project2")
        task_type = project.type_definitions.get(name="Task")
        wi = create_work_item(
            project=project, actor=owner,
            type_definition_id=task_type.pk, title="CSRF Task",
        )

        django_client = Client(enforce_csrf_checks=True)
        django_client.force_login(owner)

        response = django_client.patch(
            f"/api/work-items/{wi.pk}/",
            data={"title": "Hacked"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)


# ── Admin Safety Tests ──


class WorkItemAdminTest(TestCase):
    """Verify WorkItem and WorkItemAssignee admin restricts mutations."""

    def setUp(self):
        self.superuser = User.objects.create_superuser(
            username="admin", password="Pass1!",
        )
        self.group = ResearchGroup.objects.create(
            name="FG Test", created_by=self.superuser,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group, user=self.superuser,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        self.project = create_project(
            research_group=self.group, creator=self.superuser, name="Admin Test",
        )
        self.wi = WorkItem.objects.create(
            project=self.project,
            type_definition=self.project.type_definitions.get(name="Task"),
            status_definition=self.project.status_definitions.get(name="Todo"),
            title="Admin Task", created_by=self.superuser,
        )
        self.assignee = WorkItemAssignee.objects.create(
            work_item=self.wi, user=self.superuser,
        )

    def test_work_item_admin_cannot_add(self):
        from work_items.admin import WorkItemAdmin
        from django.contrib.admin.sites import site
        admin = site.get_model_admin(WorkItem)
        from django.test import RequestFactory
        factory = RequestFactory()
        request = factory.post("/admin/")
        request.user = self.superuser
        self.assertFalse(admin.has_add_permission(request))

    def test_work_item_admin_cannot_change(self):
        from work_items.admin import WorkItemAdmin
        from django.contrib.admin.sites import site
        admin = site.get_model_admin(WorkItem)
        from django.test import RequestFactory
        factory = RequestFactory()
        request = factory.post("/admin/")
        request.user = self.superuser
        self.assertFalse(admin.has_change_permission(request, obj=self.wi))

    def test_work_item_admin_cannot_delete(self):
        from work_items.admin import WorkItemAdmin
        from django.contrib.admin.sites import site
        admin = site.get_model_admin(WorkItem)
        from django.test import RequestFactory
        factory = RequestFactory()
        request = factory.post("/admin/")
        request.user = self.superuser
        self.assertFalse(admin.has_delete_permission(request, obj=self.wi))

    def test_work_item_assignee_admin_cannot_add(self):
        from work_items.admin import WorkItemAssigneeAdmin
        from django.contrib.admin.sites import site
        admin = site.get_model_admin(WorkItemAssignee)
        from django.test import RequestFactory
        factory = RequestFactory()
        request = factory.post("/admin/")
        request.user = self.superuser
        self.assertFalse(admin.has_add_permission(request))

    def test_work_item_assignee_admin_cannot_change(self):
        from work_items.admin import WorkItemAssigneeAdmin
        from django.contrib.admin.sites import site
        admin = site.get_model_admin(WorkItemAssignee)
        from django.test import RequestFactory
        factory = RequestFactory()
        request = factory.post("/admin/")
        request.user = self.superuser
        self.assertFalse(admin.has_change_permission(request, obj=self.assignee))

    def test_work_item_assignee_admin_cannot_delete(self):
        from work_items.admin import WorkItemAssigneeAdmin
        from django.contrib.admin.sites import site
        admin = site.get_model_admin(WorkItemAssignee)
        from django.test import RequestFactory
        factory = RequestFactory()
        request = factory.post("/admin/")
        request.user = self.superuser
        self.assertFalse(admin.has_delete_permission(request, obj=self.assignee))
