"""Permission tests for the Research Group API.

Verifies that:
- LIST returns only groups the user belongs to
- DETAIL returns a group only if the user is a member
- Anonymous users cannot access protected endpoints
- 404 is used (not 403) to avoid leaking group existence
"""

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient, APITestCase

from research_groups.models import ResearchGroup, ResearchGroupMembership

User = get_user_model()


class _AuthMixin:
    """Mixin with login helper for APIClient-based tests."""

    def setUp(self):
        super().setUp() if isinstance(self, TestCase) else None
        self.client = APIClient()

    def _login(self, username="testuser", password="TestPass1!"):
        self.client.get("/api/auth/csrf/")
        csrf_token = self.client.cookies.get("csrftoken").value
        self.client.post(
            "/api/auth/login/",
            data={"username": username, "password": password},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )


class ResearchGroupListTest(_AuthMixin, APITestCase):
    """Test GET /api/research-groups/ permission filtering."""

    @classmethod
    def setUpTestData(cls):
        cls.user_a = User.objects.create_user(
            username="user_a", password="TestPass1!"
        )
        cls.user_b = User.objects.create_user(
            username="user_b", password="TestPass1!"
        )
        cls.user_no_membership = User.objects.create_user(
            username="user_none", password="TestPass1!"
        )
        cls.group_alpha = ResearchGroup.objects.create(
            name="FG Alpha", created_by=cls.user_a
        )
        cls.group_beta = ResearchGroup.objects.create(
            name="FG Beta", created_by=cls.user_b
        )
        # user_a is member of Alpha
        ResearchGroupMembership.objects.create(
            research_group=cls.group_alpha,
            user=cls.user_a,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        # user_b is admin of Beta
        ResearchGroupMembership.objects.create(
            research_group=cls.group_beta,
            user=cls.user_b,
            role=ResearchGroupMembership.Role.ADMIN,
        )

    def test_anonymous_cannot_list(self):
        response = self.client.get("/api/research-groups/")
        self.assertEqual(response.status_code, 401)

    def test_member_sees_own_groups_only(self):
        self._login(username="user_a")
        response = self.client.get("/api/research-groups/")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]["id"], self.group_alpha.pk)
        self.assertEqual(data[0]["name"], "FG Alpha")
        self.assertEqual(data[0]["role"], "member")

    def test_admin_sees_own_groups_only(self):
        self._login(username="user_b")
        response = self.client.get("/api/research-groups/")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]["id"], self.group_beta.pk)
        self.assertEqual(data[0]["name"], "FG Beta")
        self.assertEqual(data[0]["role"], "admin")

    def test_user_with_no_membership_gets_empty_list(self):
        self._login(username="user_none")
        response = self.client.get("/api/research-groups/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [])

    def test_multi_member_user(self):
        """User belonging to both groups sees both."""
        ResearchGroupMembership.objects.create(
            research_group=self.group_beta,
            user=self.user_a,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        self._login(username="user_a")
        response = self.client.get("/api/research-groups/")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(len(data), 2)
        ids = {g["id"] for g in data}
        self.assertIn(self.group_alpha.pk, ids)
        self.assertIn(self.group_beta.pk, ids)


class ResearchGroupDetailTest(_AuthMixin, APITestCase):
    """Test GET /api/research-groups/{id}/ permission filtering."""

    @classmethod
    def setUpTestData(cls):
        cls.user_a = User.objects.create_user(
            username="detail_a", password="TestPass1!"
        )
        cls.user_b = User.objects.create_user(
            username="detail_b", password="TestPass1!"
        )
        cls.user_none = User.objects.create_user(
            username="detail_none", password="TestPass1!"
        )
        cls.group_alpha = ResearchGroup.objects.create(
            name="FG Alpha", created_by=cls.user_a
        )
        cls.group_beta = ResearchGroup.objects.create(
            name="FG Beta", created_by=cls.user_b
        )
        ResearchGroupMembership.objects.create(
            research_group=cls.group_alpha,
            user=cls.user_a,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        ResearchGroupMembership.objects.create(
            research_group=cls.group_beta,
            user=cls.user_b,
            role=ResearchGroupMembership.Role.ADMIN,
        )

    def test_anonymous_cannot_access_detail(self):
        response = self.client.get(f"/api/research-groups/{self.group_alpha.pk}/")
        self.assertEqual(response.status_code, 401)

    def test_member_can_read_own_group(self):
        self._login(username="detail_a")
        response = self.client.get(f"/api/research-groups/{self.group_alpha.pk}/")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["id"], self.group_alpha.pk)
        self.assertEqual(data["name"], "FG Alpha")
        self.assertEqual(data["role"], "member")

    def test_admin_can_read_own_group(self):
        self._login(username="detail_b")
        response = self.client.get(f"/api/research-groups/{self.group_beta.pk}/")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["id"], self.group_beta.pk)
        self.assertEqual(data["name"], "FG Beta")
        self.assertEqual(data["role"], "admin")

    def test_unrelated_user_cannot_read_group(self):
        """User belonging to Beta cannot read Alpha."""
        self._login(username="detail_b")
        response = self.client.get(f"/api/research-groups/{self.group_alpha.pk}/")
        self.assertEqual(response.status_code, 404)

    def test_no_membership_user_cannot_read_group(self):
        self._login(username="detail_none")
        response = self.client.get(f"/api/research-groups/{self.group_alpha.pk}/")
        self.assertEqual(response.status_code, 404)

    def test_nonexistent_group_returns_404(self):
        self._login(username="detail_a")
        response = self.client.get("/api/research-groups/99999/")
        self.assertEqual(response.status_code, 404)

    def test_knowing_id_does_not_grant_access(self):
        """Even if a user knows another group's ID, they cannot read it."""
        self._login(username="detail_b")
        # user_b knows group_alpha.pk but is not a member
        response = self.client.get(f"/api/research-groups/{self.group_alpha.pk}/")
        self.assertEqual(response.status_code, 404)
        # Should not leak group name
        data = response.json()
        self.assertNotIn("FG Alpha", str(data))
