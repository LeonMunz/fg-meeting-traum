"""Database-level membership/scope integrity tests.

Covers the persisted invariants:

- ProjectMembership.research_group is derived from the Project.
- A ProjectMembership can never validly reference a user who is not a
  member of the Project's Research Group (composite FK).
- Cross-ResearchGroup ProjectMembership is rejected at the database.
- Removing a ResearchGroupMembership requires explicit
  ProjectMembership cleanup first (ON DELETE RESTRICT composite FK).
- Group rejoin does not restore old ProjectMemberships.
"""

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.test import TestCase

from research_groups.models import ResearchGroup, ResearchGroupMembership

from .models import Project, ProjectMembership

User = get_user_model()


class ProjectMembershipIntegrityTest(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="Pass1!")
        self.member = User.objects.create_user(username="member", password="Pass1!")
        self.outsider = User.objects.create_user(username="outsider", password="Pass1!")

        self.group = ResearchGroup.objects.create(name="Group A", created_by=self.owner)
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.owner,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.member,
            role=ResearchGroupMembership.Role.MEMBER,
        )

        self.other_group = ResearchGroup.objects.create(name="Group B", created_by=self.outsider)
        ResearchGroupMembership.objects.create(
            research_group=self.other_group,
            user=self.outsider,
            role=ResearchGroupMembership.Role.ADMIN,
        )

        self.project = Project.objects.create(
            name="Project A",
            research_group=self.group,
            created_by=self.owner,
        )

    def create_membership(self, user, role=ProjectMembership.Role.MEMBER):
        return ProjectMembership.objects.create(
            project=self.project,
            user=user,
            role=role,
            added_by=self.owner,
        )

    def test_research_group_derived_from_project(self):
        membership = self.create_membership(self.member)
        self.assertEqual(membership.research_group, self.group)

    def test_membership_requires_group_membership(self):
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                self.create_membership(self.outsider)

    def test_membership_cannot_target_wrong_group(self):
        # The member is a valid member of another group, but not of
        # this Project's group.
        ResearchGroupMembership.objects.create(
            research_group=self.other_group,
            user=self.member,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        # A Project in the other group proves the user has a valid
        # group membership somewhere, yet the composite FK must still
        # pin the membership to the Project's group.
        other_project = Project.objects.create(
            name="Project B",
            research_group=self.other_group,
            created_by=self.outsider,
        )
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                ProjectMembership.objects.create(
                    project=other_project,
                    user=self.member,
                    role=ProjectMembership.Role.MEMBER,
                    added_by=self.outsider,
                    research_group=self.group,
                )

    def test_group_membership_removal_requires_project_cleanup(self):
        self.create_membership(self.member)
        group_membership = ResearchGroupMembership.objects.get(
            research_group=self.group,
            user=self.member,
        )
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                group_membership.delete()

    def test_group_membership_removal_after_project_cleanup(self):
        self.create_membership(self.member)
        group_membership = ResearchGroupMembership.objects.get(
            research_group=self.group,
            user=self.member,
        )
        ProjectMembership.objects.filter(
            project=self.project, user=self.member
        ).delete()
        group_membership.delete()
        self.assertFalse(
            ResearchGroupMembership.objects.filter(
                research_group=self.group, user=self.member
            ).exists()
        )

    def test_rejoin_does_not_restore_project_memberships(self):
        self.create_membership(self.member)
        # Removing the group membership revokes the ProjectMemberships
        # (explicit cleanup, then group membership removal).
        ProjectMembership.objects.filter(
            project=self.project, user=self.member
        ).delete()
        ResearchGroupMembership.objects.filter(
            research_group=self.group, user=self.member
        ).delete()
        self.assertFalse(
            ProjectMembership.objects.filter(
                project=self.project, user=self.member
            ).exists()
        )

        # Rejoin the group.
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.member,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        self.assertFalse(
            ProjectMembership.objects.filter(
                project=self.project, user=self.member
            ).exists()
        )

    def test_project_delete_cleans_memberships(self):
        self.create_membership(self.member)
        self.project.delete()
        self.assertFalse(
            ProjectMembership.objects.filter(user=self.member).exists()
        )
