"""API tests for Research Group administration."""

from django.contrib.auth import get_user_model

from rest_framework.test import (
    APIClient,
    APITestCase,
)

from projects.services import create_project
from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)

User = get_user_model()


class ResearchGroupManagementApiTest(
    APITestCase,
):
    @classmethod
    def setUpTestData(cls):
        cls.admin = User.objects.create_user(
            username="rg_admin",
            password="TestPass1!",
        )
        cls.member = User.objects.create_user(
            username="rg_member",
            password="TestPass1!",
        )
        cls.other = User.objects.create_user(
            username="rg_other",
            password="TestPass1!",
        )
        cls.outsider = User.objects.create_user(
            username="rg_outsider",
            password="TestPass1!",
        )

        cls.group = ResearchGroup.objects.create(
            name="FG Example",
            created_by=cls.admin,
        )

        cls.admin_membership = (
            ResearchGroupMembership.objects.create(
                research_group=cls.group,
                user=cls.admin,
                role=ResearchGroupMembership.Role.ADMIN,
            )
        )

        cls.member_membership = (
            ResearchGroupMembership.objects.create(
                research_group=cls.group,
                user=cls.member,
                role=ResearchGroupMembership.Role.MEMBER,
            )
        )

    def setUp(self):
        self.client = APIClient()

    def login(self, username):
        self.client.get("/api/auth/csrf/")

        csrf_token = (
            self.client.cookies
            .get("csrftoken")
            .value
        )

        response = self.client.post(
            "/api/auth/login/",
            data={
                "username": username,
                "password": "TestPass1!",
            },
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )

        self.assertEqual(
            response.status_code,
            200,
        )

    def test_admin_can_update_group_name(self):
        self.login("rg_admin")

        response = self.client.patch(
            f"/api/research-groups/{self.group.pk}/",
            data={
                "name": "FG Cognitive Science",
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            200,
        )
        self.assertEqual(
            response.json()["name"],
            "FG Cognitive Science",
        )

    def test_member_cannot_update_group(self):
        self.login("rg_member")

        response = self.client.patch(
            f"/api/research-groups/{self.group.pk}/",
            data={
                "name": "Nope",
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            403,
        )

    def test_outsider_cannot_discover_group_via_patch(
        self,
    ):
        self.login("rg_outsider")

        response = self.client.patch(
            f"/api/research-groups/{self.group.pk}/",
            data={
                "name": "Nope",
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            404,
        )

    def test_admin_can_list_memberships(self):
        self.login("rg_admin")

        response = self.client.get(
            f"/api/research-groups/{self.group.pk}/memberships/"
        )

        self.assertEqual(
            response.status_code,
            200,
        )

        data = response.json()

        self.assertEqual(
            len(data),
            2,
        )

        usernames = {
            item["user"]["username"]
            for item in data
        }

        self.assertEqual(
            usernames,
            {
                "rg_admin",
                "rg_member",
            },
        )

    def test_member_cannot_list_management_memberships(
        self,
    ):
        self.login("rg_member")

        response = self.client.get(
            f"/api/research-groups/{self.group.pk}/memberships/"
        )

        self.assertEqual(
            response.status_code,
            403,
        )

    def test_admin_can_add_member(self):
        self.login("rg_admin")

        response = self.client.post(
            f"/api/research-groups/{self.group.pk}/memberships/",
            data={
                "userId": self.other.pk,
                "role": "member",
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            201,
        )

        self.assertEqual(
            response.json()["user"]["username"],
            "rg_other",
        )

        self.assertEqual(
            response.json()["role"],
            "member",
        )

    def test_member_cannot_add_member(self):
        self.login("rg_member")

        response = self.client.post(
            f"/api/research-groups/{self.group.pk}/memberships/",
            data={
                "userId": self.other.pk,
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            403,
        )

    def test_duplicate_member_rejected(self):
        self.login("rg_admin")

        response = self.client.post(
            f"/api/research-groups/{self.group.pk}/memberships/",
            data={
                "userId": self.member.pk,
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            400,
        )

    def test_admin_can_promote_member(self):
        self.login("rg_admin")

        response = self.client.patch(
            (
                f"/api/research-groups/{self.group.pk}"
                f"/memberships/{self.member_membership.pk}/"
            ),
            data={
                "role": "admin",
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            200,
        )

        self.assertEqual(
            response.json()["role"],
            "admin",
        )

    def test_final_admin_cannot_be_demoted(self):
        self.login("rg_admin")

        response = self.client.patch(
            (
                f"/api/research-groups/{self.group.pk}"
                f"/memberships/{self.admin_membership.pk}/"
            ),
            data={
                "role": "member",
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            400,
        )

        self.admin_membership.refresh_from_db()

        self.assertEqual(
            self.admin_membership.role,
            ResearchGroupMembership.Role.ADMIN,
        )

    def test_membership_id_is_scoped_to_group(self):
        other_group = ResearchGroup.objects.create(
            name="Other FG",
            created_by=self.outsider,
        )

        other_membership = (
            ResearchGroupMembership.objects.create(
                research_group=other_group,
                user=self.outsider,
                role=ResearchGroupMembership.Role.ADMIN,
            )
        )

        self.login("rg_admin")

        response = self.client.patch(
            (
                f"/api/research-groups/{self.group.pk}"
                f"/memberships/{other_membership.pk}/"
            ),
            data={
                "role": "member",
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            404,
        )

    def test_final_admin_cannot_be_removed(self):
        self.login("rg_admin")

        response = self.client.delete(
            (
                f"/api/research-groups/{self.group.pk}"
                f"/memberships/{self.admin_membership.pk}/"
            )
        )

        self.assertEqual(
            response.status_code,
            400,
        )

    def test_admin_can_remove_uncomplicated_member(
        self,
    ):
        membership = (
            ResearchGroupMembership.objects.create(
                research_group=self.group,
                user=self.other,
                role=ResearchGroupMembership.Role.MEMBER,
            )
        )

        self.login("rg_admin")

        response = self.client.delete(
            (
                f"/api/research-groups/{self.group.pk}"
                f"/memberships/{membership.pk}/"
            )
        )

        self.assertEqual(
            response.status_code,
            200,
        )

        self.assertFalse(
            ResearchGroupMembership.objects.filter(
                pk=membership.pk,
            ).exists()
        )

    def test_project_dependency_blocks_removal(self):
        project = create_project(
            research_group=self.group,
            creator=self.member,
            name="Member Project",
        )

        self.assertIsNotNone(project.pk)

        self.login("rg_admin")

        response = self.client.delete(
            (
                f"/api/research-groups/{self.group.pk}"
                f"/memberships/{self.member_membership.pk}/"
            )
        )

        self.assertEqual(
            response.status_code,
            400,
        )

        self.assertTrue(
            ResearchGroupMembership.objects.filter(
                pk=self.member_membership.pk,
            ).exists()
        )

    def test_existing_member_directory_endpoint_still_works(
        self,
    ):
        self.login("rg_member")

        response = self.client.get(
            f"/api/research-groups/{self.group.pk}/members/"
        )

        self.assertEqual(
            response.status_code,
            200,
        )

        usernames = {
            item["username"]
            for item in response.json()
        }

        self.assertIn(
            "rg_admin",
            usernames,
        )
        self.assertIn(
            "rg_member",
            usernames,
        )
