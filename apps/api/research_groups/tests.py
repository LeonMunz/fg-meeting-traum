from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import IntegrityError
from django.test import TestCase

from research_groups.models import ResearchGroup, ResearchGroupMembership

User = get_user_model()


class ResearchGroupCreationTest(TestCase):
    """Verify ResearchGroup can be created by a User."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="creator",
            password="Pass1!",
        )

    def test_create_research_group(self):
        group = ResearchGroup.objects.create(
            name="FG Example",
            created_by=self.user,
        )
        self.assertEqual(group.name, "FG Example")
        self.assertEqual(group.created_by, self.user)
        self.assertIsNotNone(group.created_at)
        self.assertIsNotNone(group.updated_at)


class ResearchGroupMembershipTest(TestCase):
    """Verify ResearchGroupMembership behaves correctly."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="member_user",
            password="Pass1!",
        )
        self.group = ResearchGroup.objects.create(
            name="FG Alpha",
            created_by=self.user,
        )

    def test_create_membership(self):
        membership = ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.user,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        self.assertEqual(membership.role, "member")
        self.assertIsNotNone(membership.joined_at)

    def test_admin_role(self):
        membership = ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.user,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        self.assertEqual(membership.role, "admin")

    def test_duplicate_membership_rejected(self):
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.user,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        with self.assertRaises(IntegrityError):
            ResearchGroupMembership.objects.create(
                research_group=self.group,
                user=self.user,
                role=ResearchGroupMembership.Role.ADMIN,
            )

    def test_membership_independence(self):
        """Membership in one group does not imply membership in another."""
        other_user = User.objects.create_user(
            username="other_user",
            password="Pass1!",
        )
        group_b = ResearchGroup.objects.create(
            name="FG Beta",
            created_by=other_user,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.user,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        # User is a member of FG Alpha only.
        self.assertEqual(
            self.group.memberships.filter(user=self.user).count(),
            1,
        )
        self.assertEqual(
            group_b.memberships.filter(user=self.user).count(),
            0,
        )

    def test_same_user_different_groups(self):
        """The same user can be a member of multiple groups."""
        group_b = ResearchGroup.objects.create(
            name="FG Beta",
            created_by=self.user,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.user,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        ResearchGroupMembership.objects.create(
            research_group=group_b,
            user=self.user,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        self.assertEqual(
            ResearchGroupMembership.objects.filter(user=self.user).count(),
            2,
        )
