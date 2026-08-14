"""Canonical projection consistency tests.

Proves that My Work and Project WorkItems are two views over the SAME
canonical WorkItem. No synchronization code is needed because there is
nothing to synchronize.
"""

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient, APITestCase

from research_groups.models import ResearchGroup, ResearchGroupMembership
from projects.models import Project, ProjectMembership
from projects.services import create_project, add_project_membership

from work_items.models import WorkItem, WorkItemAssignee
from work_items.services import create_work_item, update_work_item

User = get_user_model()

SEED_PASSWORD = "DevPass1!"


def _setup():
    """Create standard test data."""
    alex = User.objects.create_user(username="alex", password=SEED_PASSWORD)
    chris = User.objects.create_user(username="chris", password=SEED_PASSWORD)

    group = ResearchGroup.objects.create(name="FG Example", created_by=alex)
    ResearchGroupMembership.objects.create(
        research_group=group, user=alex,
        role=ResearchGroupMembership.Role.ADMIN,
    )
    ResearchGroupMembership.objects.create(
        research_group=group, user=chris,
        role=ResearchGroupMembership.Role.MEMBER,
    )

    paper_xyz = create_project(
        research_group=group, creator=alex, name="Paper XYZ"
    )
    add_project_membership(
        project=paper_xyz, actor=alex,
        target_user=chris, role=ProjectMembership.Role.MEMBER,
    )

    wi = create_work_item(
        project=paper_xyz,
        actor=alex,
        type=WorkItem.Type.TASK,
        title="Rewrite Introduction",
        assignee_ids=[chris.pk],
    )

    return {
        "group": group,
        "alex": alex,
        "chris": chris,
        "paper_xyz": paper_xyz,
        "work_item": wi,
    }


class _AuthMixin:
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

    def _get_csrf_token(self):
        self.client.get("/api/auth/csrf/")
        csrf_cookie = self.client.cookies.get("csrftoken")
        return csrf_cookie.value if csrf_cookie else ""


class CanonicalConsistencyAPITest(_AuthMixin, APITestCase):
    """Prove My Work and Project WorkItems share the same WorkItem."""

    @classmethod
    def setUpTestData(cls):
        cls.data = _setup()

    # ── SAME ID ──

    def test_same_work_item_id(self):
        """My Work and Project WorkItems return the same WorkItem ID."""
        self._login("chris")

        my_work = self.client.get(
            f"/api/research-groups/{self.data['group'].pk}/my-work/"
        ).json()
        project_wis = self.client.get(
            f"/api/projects/{self.data['paper_xyz'].pk}/work-items/"
        ).json()

        my_work_ids = {item["id"] for item in my_work}
        project_ids = {item["id"] for item in project_wis}

        self.assertIn(self.data["work_item"].pk, my_work_ids)
        self.assertIn(self.data["work_item"].pk, project_ids)
        # Same integer ID
        my_wi = next(i for i in my_work if i["id"] == self.data["work_item"].pk)
        proj_wi = next(i for i in project_wis if i["id"] == self.data["work_item"].pk)
        self.assertEqual(my_wi["id"], proj_wi["id"])

    # ── STATUS PROPAGATION ──

    def test_status_todo_to_in_progress(self):
        """Status change from todo to in_progress is reflected in both views."""
        self._login("chris")
        csrf = self._get_csrf_token()

        # Update via canonical WorkItem PATCH
        self.client.patch(
            f"/api/work-items/{self.data['work_item'].pk}/",
            data={"status": "in_progress"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )

        my_work = self.client.get(
            f"/api/research-groups/{self.data['group'].pk}/my-work/"
        ).json()
        project_wis = self.client.get(
            f"/api/projects/{self.data['paper_xyz'].pk}/work-items/"
        ).json()

        my_status = next(
            i for i in my_work if i["id"] == self.data["work_item"].pk
        )["status"]
        proj_status = next(
            i for i in project_wis if i["id"] == self.data["work_item"].pk
        )["status"]

        self.assertEqual(my_status, "in_progress")
        self.assertEqual(proj_status, "in_progress")

    def test_status_in_progress_to_done(self):
        """Status change to done sets completedAt in both views."""
        self._login("chris")
        csrf = self._get_csrf_token()

        self.client.patch(
            f"/api/work-items/{self.data['work_item'].pk}/",
            data={"status": "done"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )

        my_work = self.client.get(
            f"/api/research-groups/{self.data['group'].pk}/my-work/"
        ).json()
        project_wis = self.client.get(
            f"/api/projects/{self.data['paper_xyz'].pk}/work-items/"
        ).json()

        my_wi = next(
            i for i in my_work if i["id"] == self.data["work_item"].pk
        )
        proj_wi = next(
            i for i in project_wis if i["id"] == self.data["work_item"].pk
        )

        self.assertEqual(my_wi["status"], "done")
        self.assertEqual(proj_wi["status"], "done")
        # Both must have the same completedAt
        self.assertIsNotNone(my_wi["completedAt"])
        self.assertIsNotNone(proj_wi["completedAt"])
        self.assertEqual(my_wi["completedAt"], proj_wi["completedAt"])

    def test_status_done_to_review_clears_completed_at(self):
        """Reopening a done WorkItem clears completedAt in both views."""
        self._login("chris")
        csrf = self._get_csrf_token()

        # Set to done
        self.client.patch(
            f"/api/work-items/{self.data['work_item'].pk}/",
            data={"status": "done"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )

        # Reopen to review
        self.client.patch(
            f"/api/work-items/{self.data['work_item'].pk}/",
            data={"status": "review"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )

        my_work = self.client.get(
            f"/api/research-groups/{self.data['group'].pk}/my-work/"
        ).json()
        project_wis = self.client.get(
            f"/api/projects/{self.data['paper_xyz'].pk}/work-items/"
        ).json()

        my_wi = next(
            i for i in my_work if i["id"] == self.data["work_item"].pk
        )
        proj_wi = next(
            i for i in project_wis if i["id"] == self.data["work_item"].pk
        )

        self.assertEqual(my_wi["status"], "review")
        self.assertEqual(proj_wi["status"], "review")
        self.assertIsNone(my_wi["completedAt"])
        self.assertIsNone(proj_wi["completedAt"])

    # ── OTHER FIELD CONSISTENCY ──

    def test_title_change_reflected(self):
        """Title change via canonical PATCH is reflected in both views."""
        self._login("chris")
        csrf = self._get_csrf_token()

        self.client.patch(
            f"/api/work-items/{self.data['work_item'].pk}/",
            data={"title": "Rewrite Introduction v2"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )

        my_work = self.client.get(
            f"/api/research-groups/{self.data['group'].pk}/my-work/"
        ).json()
        project_wis = self.client.get(
            f"/api/projects/{self.data['paper_xyz'].pk}/work-items/"
        ).json()

        my_title = next(
            i for i in my_work if i["id"] == self.data["work_item"].pk
        )["title"]
        proj_title = next(
            i for i in project_wis if i["id"] == self.data["work_item"].pk
        )["title"]

        self.assertEqual(my_title, "Rewrite Introduction v2")
        self.assertEqual(proj_title, "Rewrite Introduction v2")

    def test_blocked_reason_reflected(self):
        """blockedReason change is reflected in both views."""
        self._login("chris")
        csrf = self._get_csrf_token()

        self.client.patch(
            f"/api/work-items/{self.data['work_item'].pk}/",
            data={"blockedReason": "Waiting on data from co-author"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )

        my_work = self.client.get(
            f"/api/research-groups/{self.data['group'].pk}/my-work/"
        ).json()
        project_wis = self.client.get(
            f"/api/projects/{self.data['paper_xyz'].pk}/work-items/"
        ).json()

        my_blocked = next(
            i for i in my_work if i["id"] == self.data["work_item"].pk
        )["blockedReason"]
        proj_blocked = next(
            i for i in project_wis if i["id"] == self.data["work_item"].pk
        )["blockedReason"]

        self.assertEqual(
            my_blocked, "Waiting on data from co-author"
        )
        self.assertEqual(
            proj_blocked, "Waiting on data from co-author"
        )

    def test_duedate_reflected(self):
        """dueDate change is reflected in both views."""
        self._login("chris")
        csrf = self._get_csrf_token()

        self.client.patch(
            f"/api/work-items/{self.data['work_item'].pk}/",
            data={"dueDate": "2025-12-15"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )

        my_work = self.client.get(
            f"/api/research-groups/{self.data['group'].pk}/my-work/"
        ).json()
        project_wis = self.client.get(
            f"/api/projects/{self.data['paper_xyz'].pk}/work-items/"
        ).json()

        my_due = next(
            i for i in my_work if i["id"] == self.data["work_item"].pk
        )["dueDate"]
        proj_due = next(
            i for i in project_wis if i["id"] == self.data["work_item"].pk
        )["dueDate"]

        self.assertEqual(my_due, "2025-12-15")
        self.assertEqual(proj_due, "2025-12-15")

    # ── ASSIGNMENT REMOVAL ──

    def test_unassignment_removes_from_my_work(self):
        """Removing Chris as assignee removes the WorkItem from My Work.
        The WorkItem still exists in Project WorkItems."""
        self._login("chris")
        csrf = self._get_csrf_token()

        # Remove Chris from assignees
        self.client.patch(
            f"/api/work-items/{self.data['work_item'].pk}/",
            data={"assigneeIds": []},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )

        my_work = self.client.get(
            f"/api/research-groups/{self.data['group'].pk}/my-work/"
        ).json()
        project_wis = self.client.get(
            f"/api/projects/{self.data['paper_xyz'].pk}/work-items/"
        ).json()

        my_work_ids = {item["id"] for item in my_work}
        project_ids = {item["id"] for item in project_wis}

        # Removed from My Work
        self.assertNotIn(self.data["work_item"].pk, my_work_ids)
        # Still exists in Project WorkItems
        self.assertIn(self.data["work_item"].pk, project_ids)

    def test_reassignment_restores_to_my_work(self):
        """Reassigning Chris restores the WorkItem to My Work."""
        self._login("chris")
        csrf = self._get_csrf_token()

        # Remove assignee
        self.client.patch(
            f"/api/work-items/{self.data['work_item'].pk}/",
            data={"assigneeIds": []},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )

        my_work_after_remove = self.client.get(
            f"/api/research-groups/{self.data['group'].pk}/my-work/"
        ).json()
        self.assertEqual(len(my_work_after_remove), 0)

        # Reassign Chris
        self.client.patch(
            f"/api/work-items/{self.data['work_item'].pk}/",
            data={"assigneeIds": [self.data["chris"].pk]},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )

        my_work_after_reassign = self.client.get(
            f"/api/research-groups/{self.data['group'].pk}/my-work/"
        ).json()
        my_work_ids = {item["id"] for item in my_work_after_reassign}
        self.assertIn(self.data["work_item"].pk, my_work_ids)

    # ── SINGLE CANONICAL RECORD PROOF ──

    def test_single_canonical_work_item_record(self):
        """Only one WorkItem record exists in the database for
        'Rewrite Introduction', referenced by both views."""
        count = WorkItem.objects.filter(
            title="Rewrite Introduction",
            project=self.data["paper_xyz"],
        ).count()
        self.assertEqual(count, 1, "Only one canonical WorkItem should exist")

        self._login("chris")
        my_work = self.client.get(
            f"/api/research-groups/{self.data['group'].pk}/my-work/"
        ).json()
        project_wis = self.client.get(
            f"/api/projects/{self.data['paper_xyz'].pk}/work-items/"
        ).json()

        my_wi = next(i for i in my_work if i["id"] == self.data["work_item"].pk)
        proj_wi = next(i for i in project_wis if i["id"] == self.data["work_item"].pk)

        # Both views reference the exact same database row ID
        self.assertEqual(my_wi["id"], proj_wi["id"])
        self.assertEqual(my_wi["id"], self.data["work_item"].pk)
