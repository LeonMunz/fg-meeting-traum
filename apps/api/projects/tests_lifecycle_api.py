from django.test import Client
from rest_framework.test import APITestCase

from audit_history.models import AuditEvent
from work_items.models import WorkItem
from work_items.services import create_work_item

from .models import Project
from .services import archive_project
from .tests_api import (
    _AuthMixin,
    _setup_test_data,
)


class ProjectLifecycleApiTest(
    _AuthMixin,
    APITestCase,
):
    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()

    @property
    def project(self):
        return self.data["paper_xyz"]

    def test_project_list_exposes_archived_at(self):
        self._login("alex")

        response = self.client.get(
            (
                f"/api/research-groups/"
                f"{self.data['group'].pk}/projects/"
            )
        )

        self.assertEqual(
            response.status_code,
            200,
        )

        self.assertIsNone(
            response.json()[0]["archivedAt"],
        )

    def test_project_detail_exposes_archived_at(self):
        self._login("alex")

        response = self.client.get(
            f"/api/projects/{self.project.pk}/"
        )

        self.assertEqual(
            response.status_code,
            200,
        )

        self.assertIsNone(
            response.json()["archivedAt"],
        )

    def test_owner_can_archive_project(self):
        self._login("alex")
        csrf = self._get_csrf_token()

        response = self.client.post(
            f"/api/projects/{self.project.pk}/archive/",
            data={},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )

        self.assertEqual(
            response.status_code,
            200,
        )

        self.assertIsNotNone(
            response.json()["archivedAt"],
        )

        self.project.refresh_from_db()

        self.assertIsNotNone(
            self.project.archived_at,
        )

        self.assertEqual(
            AuditEvent.objects.filter(
                event_type="project.archived",
                project=self.project,
            ).count(),
            1,
        )

    def test_member_cannot_archive_project(self):
        self._login("chris")
        csrf = self._get_csrf_token()

        response = self.client.post(
            f"/api/projects/{self.project.pk}/archive/",
            data={},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )

        self.assertEqual(
            response.status_code,
            403,
        )

    def test_viewer_cannot_archive_project(self):
        self._login("laura")
        csrf = self._get_csrf_token()

        response = self.client.post(
            f"/api/projects/{self.project.pk}/archive/",
            data={},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )

        self.assertEqual(
            response.status_code,
            403,
        )

    def test_inaccessible_project_archive_is_404(self):
        self._login("maria")
        csrf = self._get_csrf_token()

        response = self.client.post(
            f"/api/projects/{self.project.pk}/archive/",
            data={},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )

        self.assertEqual(
            response.status_code,
            404,
        )

    def test_archived_project_remains_readable(self):
        archive_project(
            project=self.project,
            actor=self.data["alex"],
        )

        self._login("chris")

        response = self.client.get(
            f"/api/projects/{self.project.pk}/"
        )

        self.assertEqual(
            response.status_code,
            200,
        )

        self.assertIsNotNone(
            response.json()["archivedAt"],
        )

    def test_owner_can_restore_project(self):
        archive_project(
            project=self.project,
            actor=self.data["alex"],
        )

        self._login("alex")
        csrf = self._get_csrf_token()

        response = self.client.post(
            f"/api/projects/{self.project.pk}/restore/",
            data={},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )

        self.assertEqual(
            response.status_code,
            200,
        )

        self.assertIsNone(
            response.json()["archivedAt"],
        )

        self.project.refresh_from_db()

        self.assertIsNone(
            self.project.archived_at,
        )

        self.assertEqual(
            AuditEvent.objects.filter(
                event_type="project.restored",
                project=self.project,
            ).count(),
            1,
        )

    def test_unarchived_project_restore_is_400(self):
        self._login("alex")
        csrf = self._get_csrf_token()

        response = self.client.post(
            f"/api/projects/{self.project.pk}/restore/",
            data={},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )

        self.assertEqual(
            response.status_code,
            400,
        )

    def test_owner_can_delete_empty_project(self):
        empty_project = Project.objects.create(
            research_group=self.data["group"],
            name="Disposable Project",
            description="",
            created_by=self.data["alex"],
        )

        from .models import ProjectMembership

        ProjectMembership.objects.create(
            project=empty_project,
            user=self.data["alex"],
            role=ProjectMembership.Role.OWNER,
            added_by=self.data["alex"],
        )

        project_id = empty_project.pk

        self._login("alex")
        csrf = self._get_csrf_token()

        response = self.client.delete(
            f"/api/projects/{project_id}/",
            HTTP_X_CSRFTOKEN=csrf,
        )

        self.assertEqual(
            response.status_code,
            200,
        )

        self.assertFalse(
            Project.objects.filter(
                pk=project_id,
            ).exists()
        )

        event = AuditEvent.objects.get(
            event_type="project.deleted",
        )

        self.assertIsNone(
            event.project_id,
        )

        self.assertEqual(
            event.data["projectId"],
            project_id,
        )

    def test_project_with_work_items_cannot_be_deleted(self):
        create_work_item(
            project=self.project,
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="Historical work",
        )

        self._login("alex")
        csrf = self._get_csrf_token()

        response = self.client.delete(
            f"/api/projects/{self.project.pk}/",
            HTTP_X_CSRFTOKEN=csrf,
        )

        self.assertEqual(
            response.status_code,
            400,
        )

        self.assertTrue(
            Project.objects.filter(
                pk=self.project.pk,
            ).exists()
        )

    def test_member_cannot_delete_project(self):
        self._login("chris")
        csrf = self._get_csrf_token()

        response = self.client.delete(
            f"/api/projects/{self.project.pk}/",
            HTTP_X_CSRFTOKEN=csrf,
        )

        self.assertEqual(
            response.status_code,
            403,
        )

    def test_inaccessible_project_delete_is_404(self):
        self._login("maria")
        csrf = self._get_csrf_token()

        response = self.client.delete(
            f"/api/projects/{self.project.pk}/",
            HTTP_X_CSRFTOKEN=csrf,
        )

        self.assertEqual(
            response.status_code,
            404,
        )


class ProjectLifecycleCsrfApiTest(APITestCase):
    def test_archive_requires_csrf(self):
        data = _setup_test_data()

        client = Client(
            enforce_csrf_checks=True,
        )

        client.force_login(
            data["alex"],
        )

        response = client.post(
            (
                f"/api/projects/"
                f"{data['paper_xyz'].pk}/archive/"
            ),
            data={},
            content_type="application/json",
        )

        self.assertEqual(
            response.status_code,
            403,
        )

    def test_delete_requires_csrf(self):
        data = _setup_test_data()

        client = Client(
            enforce_csrf_checks=True,
        )

        client.force_login(
            data["alex"],
        )

        response = client.delete(
            f"/api/projects/{data['paper_xyz'].pk}/",
        )

        self.assertEqual(
            response.status_code,
            403,
        )
