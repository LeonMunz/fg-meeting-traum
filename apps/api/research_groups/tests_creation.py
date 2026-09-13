"""Research Group creation: creator becomes first Owner atomically."""

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from .models import ResearchGroup, ResearchGroupMembership
from .services import ResearchGroupDomainError, create_research_group

User = get_user_model()


class CreateResearchGroupServiceTest(TestCase):
    def setUp(self):
        self.creator = User.objects.create_user(
            username="creator", password="Pass1!"
        )

    def test_creator_becomes_first_admin(self):
        group = create_research_group(
            creator=self.creator, name="My Group"
        )
        membership = ResearchGroupMembership.objects.get(
            research_group=group,
            user=self.creator,
        )
        self.assertEqual(membership.role, ResearchGroupMembership.Role.ADMIN)
        self.assertEqual(
            ResearchGroupMembership.objects.filter(
                research_group=group,
                role=ResearchGroupMembership.Role.ADMIN,
            ).count(),
            1,
        )
        self.assertEqual(group.created_by, self.creator)

    def test_blank_name_rejected(self):
        with self.assertRaises(ResearchGroupDomainError):
            create_research_group(creator=self.creator, name="   ")
        self.assertFalse(ResearchGroup.objects.exists())

    def test_inactive_creator_rejected(self):
        self.creator.is_active = False
        self.creator.save()
        with self.assertRaises(ResearchGroupDomainError):
            create_research_group(
                creator=self.creator, name="Ghost Group"
            )
        self.assertFalse(ResearchGroup.objects.exists())


class CreateResearchGroupApiTest(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="creator", password="Pass1!"
        )
        self.client = APIClient()

    def test_create_returns_201_and_admin_role(self):
        self.client.force_login(self.user)
        response = self.client.post(
            "/api/research-groups/",
            data={"name": "New Group"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["role"], "admin")
        self.assertTrue(ResearchGroup.objects.filter(name="New Group").exists())

    def test_anonymous_rejected(self):
        response = self.client.post(
            "/api/research-groups/",
            data={"name": "New Group"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 401)

    def test_missing_name_rejected(self):
        self.client.force_login(self.user)
        response = self.client.post(
            "/api/research-groups/",
            data={},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertFalse(ResearchGroup.objects.exists())
