"""Domain tests for Research Group management."""

from django.contrib.auth import get_user_model
from django.test import TestCase

from projects.services import create_project
from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)
from research_groups.services import (
    ResearchGroupDomainError,
    add_research_group_membership,
    change_research_group_membership_role,
    remove_research_group_membership,
    update_research_group,
)

User = get_user_model()


class ResearchGroupManagementServiceTest(
    TestCase,
):
    def setUp(self):
        self.admin = User.objects.create_user(
            username="admin",
            password="Pass1!",
        )
        self.member = User.objects.create_user(
            username="member",
            password="Pass1!",
        )
        self.other = User.objects.create_user(
            username="other",
            password="Pass1!",
        )

        self.group = ResearchGroup.objects.create(
            name="FG Example",
            created_by=self.admin,
        )

        self.admin_membership = (
            ResearchGroupMembership.objects.create(
                research_group=self.group,
                user=self.admin,
                role=ResearchGroupMembership.Role.ADMIN,
            )
        )

        self.member_membership = (
            ResearchGroupMembership.objects.create(
                research_group=self.group,
                user=self.member,
                role=ResearchGroupMembership.Role.MEMBER,
            )
        )

    def test_admin_can_update_group_name(self):
        updated = update_research_group(
            research_group=self.group,
            actor=self.admin,
            name="FG Cognitive Science",
        )

        self.assertEqual(
            updated.name,
            "FG Cognitive Science",
        )

    def test_member_cannot_update_group(self):
        with self.assertRaises(
            ResearchGroupDomainError
        ):
            update_research_group(
                research_group=self.group,
                actor=self.member,
                name="Not Allowed",
            )

    def test_empty_group_name_rejected(self):
        with self.assertRaises(
            ResearchGroupDomainError
        ):
            update_research_group(
                research_group=self.group,
                actor=self.admin,
                name="   ",
            )

    def test_admin_can_add_member(self):
        membership = (
            add_research_group_membership(
                research_group=self.group,
                actor=self.admin,
                target_user=self.other,
            )
        )

        self.assertEqual(
            membership.role,
            ResearchGroupMembership.Role.MEMBER,
        )

    def test_member_cannot_add_member(self):
        with self.assertRaises(
            ResearchGroupDomainError
        ):
            add_research_group_membership(
                research_group=self.group,
                actor=self.member,
                target_user=self.other,
            )

    def test_duplicate_membership_rejected(self):
        with self.assertRaises(
            ResearchGroupDomainError
        ):
            add_research_group_membership(
                research_group=self.group,
                actor=self.admin,
                target_user=self.member,
            )

    def test_invalid_role_rejected_on_add(self):
        with self.assertRaises(
            ResearchGroupDomainError
        ):
            add_research_group_membership(
                research_group=self.group,
                actor=self.admin,
                target_user=self.other,
                role="owner",
            )

    def test_admin_can_promote_member(self):
        changed = (
            change_research_group_membership_role(
                membership=self.member_membership,
                actor=self.admin,
                new_role=(
                    ResearchGroupMembership.Role.ADMIN
                ),
            )
        )

        self.assertEqual(
            changed.role,
            ResearchGroupMembership.Role.ADMIN,
        )

    def test_member_cannot_change_roles(self):
        with self.assertRaises(
            ResearchGroupDomainError
        ):
            change_research_group_membership_role(
                membership=self.admin_membership,
                actor=self.member,
                new_role=(
                    ResearchGroupMembership.Role.MEMBER
                ),
            )

    def test_final_admin_cannot_be_demoted(self):
        with self.assertRaises(
            ResearchGroupDomainError
        ):
            change_research_group_membership_role(
                membership=self.admin_membership,
                actor=self.admin,
                new_role=(
                    ResearchGroupMembership.Role.MEMBER
                ),
            )

        self.admin_membership.refresh_from_db()

        self.assertEqual(
            self.admin_membership.role,
            ResearchGroupMembership.Role.ADMIN,
        )

    def test_admin_can_be_demoted_when_other_admin_exists(
        self,
    ):
        self.member_membership.role = (
            ResearchGroupMembership.Role.ADMIN
        )
        self.member_membership.save(
            update_fields=["role"]
        )

        changed = (
            change_research_group_membership_role(
                membership=self.admin_membership,
                actor=self.admin,
                new_role=(
                    ResearchGroupMembership.Role.MEMBER
                ),
            )
        )

        self.assertEqual(
            changed.role,
            ResearchGroupMembership.Role.MEMBER,
        )

    def test_final_admin_cannot_be_removed(self):
        with self.assertRaises(
            ResearchGroupDomainError
        ):
            remove_research_group_membership(
                membership=self.admin_membership,
                actor=self.admin,
            )

        self.assertTrue(
            ResearchGroupMembership.objects.filter(
                pk=self.admin_membership.pk,
            ).exists()
        )

    def test_member_with_project_membership_cannot_be_removed(
        self,
    ):
        project = create_project(
            research_group=self.group,
            creator=self.member,
            name="Member Project",
        )

        self.assertEqual(
            project.research_group,
            self.group,
        )

        with self.assertRaises(
            ResearchGroupDomainError
        ):
            remove_research_group_membership(
                membership=self.member_membership,
                actor=self.admin,
            )

        self.assertTrue(
            ResearchGroupMembership.objects.filter(
                pk=self.member_membership.pk,
            ).exists()
        )

    def test_admin_can_remove_member_without_dependencies(
        self,
    ):
        remove_research_group_membership(
            membership=self.member_membership,
            actor=self.admin,
        )

        self.assertFalse(
            ResearchGroupMembership.objects.filter(
                pk=self.member_membership.pk,
            ).exists()
        )
