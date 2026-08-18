"""Tests for the personal cross-Research-Group My Work projection."""

from django.contrib.auth import get_user_model

from rest_framework.test import APIClient, APITestCase

from projects.models import ProjectMembership
from projects.services import create_project
from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)
from work_items.models import WorkItemAssignee
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
            type="task",
            title="Rewrite Introduction",
            assignee_ids=[cls.chris.pk],
        )
        cls.work_b = create_work_item(
            project=cls.project_b,
            actor=cls.chris,
            type="task",
            title="Analyze Robot Data",
            assignee_ids=[cls.chris.pk],
        )

        cls.unassigned = create_work_item(
            project=cls.project_a,
            actor=cls.chris,
            type="task",
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
