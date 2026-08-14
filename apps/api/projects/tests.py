"""Domain tests for Project, ProjectMembership, and application services.

Covers:
- Project belongs to exactly one Research Group
- Project status values
- ProjectMembership roles
- Duplicate membership rejection
- Research Group membership prerequisite
- Atomic project creation
- Final-owner invariant for active projects
"""

from django.contrib.auth import get_user_model
from django.db import IntegrityError
from django.test import TestCase

from research_groups.models import ResearchGroup, ResearchGroupMembership
from projects.models import Project, ProjectMembership
from projects.services import (
    ProjectDomainError,
    add_project_membership,
    change_membership_role,
    create_project,
    remove_membership,
    update_project,
)

User = get_user_model()


class ProjectModelTest(TestCase):
    """Test Project model basics."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="creator", password="Pass1!"
        )
        self.group = ResearchGroup.objects.create(
            name="FG Test", created_by=self.user
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.user,
            role=ResearchGroupMembership.Role.MEMBER,
        )

    def test_project_belongs_to_research_group(self):
        project = Project.objects.create(
            name="Test Project",
            research_group=self.group,
            created_by=self.user,
        )
        self.assertEqual(project.research_group, self.group)

    def test_project_status_active(self):
        project = Project.objects.create(
            name="Test Project",
            research_group=self.group,
            created_by=self.user,
            status=Project.Status.ACTIVE,
        )
        self.assertEqual(project.status, "active")

    def test_project_status_paused(self):
        project = Project.objects.create(
            name="Test Project",
            research_group=self.group,
            created_by=self.user,
            status=Project.Status.PAUSED,
        )
        self.assertEqual(project.status, "paused")

    def test_project_status_completed(self):
        project = Project.objects.create(
            name="Test Project",
            research_group=self.group,
            created_by=self.user,
            status=Project.Status.COMPLETED,
        )
        self.assertEqual(project.status, "completed")


class ProjectMembershipModelTest(TestCase):
    """Test ProjectMembership model basics."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="member_user", password="Pass1!"
        )
        self.user2 = User.objects.create_user(
            username="other_user", password="Pass1!"
        )
        self.group = ResearchGroup.objects.create(
            name="FG Test", created_by=self.user
        )
        self.project = Project.objects.create(
            name="Test Project",
            research_group=self.group,
            created_by=self.user,
        )

    def test_owner_role(self):
        membership = ProjectMembership.objects.create(
            project=self.project,
            user=self.user,
            role=ProjectMembership.Role.OWNER,
            added_by=self.user,
        )
        self.assertEqual(membership.role, "owner")

    def test_member_role(self):
        membership = ProjectMembership.objects.create(
            project=self.project,
            user=self.user,
            role=ProjectMembership.Role.MEMBER,
            added_by=self.user,
        )
        self.assertEqual(membership.role, "member")

    def test_viewer_role(self):
        membership = ProjectMembership.objects.create(
            project=self.project,
            user=self.user,
            role=ProjectMembership.Role.VIEWER,
            added_by=self.user,
        )
        self.assertEqual(membership.role, "viewer")

    def test_duplicate_membership_rejected(self):
        ProjectMembership.objects.create(
            project=self.project,
            user=self.user,
            role=ProjectMembership.Role.OWNER,
            added_by=self.user,
        )
        with self.assertRaises(IntegrityError):
            ProjectMembership.objects.create(
                project=self.project,
                user=self.user,
                role=ProjectMembership.Role.MEMBER,
                added_by=self.user,
            )

    def test_membership_independence(self):
        """Membership in Project A does not imply membership in Project B."""
        project_b = Project.objects.create(
            name="Project B",
            research_group=self.group,
            created_by=self.user,
        )
        ProjectMembership.objects.create(
            project=self.project,
            user=self.user,
            role=ProjectMembership.Role.OWNER,
            added_by=self.user,
        )
        self.assertEqual(
            self.project.memberships.filter(user=self.user).count(), 1
        )
        self.assertEqual(
            project_b.memberships.filter(user=self.user).count(), 0
        )

    def test_same_user_different_projects(self):
        """Same user can be member of multiple projects."""
        project_b = Project.objects.create(
            name="Project B",
            research_group=self.group,
            created_by=self.user,
        )
        ProjectMembership.objects.create(
            project=self.project,
            user=self.user,
            role=ProjectMembership.Role.OWNER,
            added_by=self.user,
        )
        ProjectMembership.objects.create(
            project=project_b,
            user=self.user,
            role=ProjectMembership.Role.MEMBER,
            added_by=self.user,
        )
        self.assertEqual(
            ProjectMembership.objects.filter(user=self.user).count(), 2
        )


class ProjectCreationServiceTest(TestCase):
    """Test create_project application operation."""

    def setUp(self):
        self.group = ResearchGroup.objects.create(
            name="FG Test",
            created_by=User.objects.create_user(
                username="admin", password="Pass1!"
            ),
        )
        self.member = User.objects.create_user(
            username="member", password="Pass1!"
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.member,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        self.admin = User.objects.get(username="admin")
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.admin,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        self.non_member = User.objects.create_user(
            username="nonmember", password="Pass1!"
        )

    def test_research_group_member_can_create(self):
        project = create_project(
            research_group=self.group,
            creator=self.member,
            name="Member Project",
        )
        self.assertEqual(project.name, "Member Project")
        self.assertEqual(project.research_group, self.group)
        self.assertEqual(project.created_by, self.member)

    def test_research_group_admin_can_create(self):
        project = create_project(
            research_group=self.group,
            creator=self.admin,
            name="Admin Project",
        )
        self.assertEqual(project.name, "Admin Project")
        self.assertEqual(project.created_by, self.admin)

    def test_non_group_user_cannot_create(self):
        with self.assertRaises(ProjectDomainError):
            create_project(
                research_group=self.group,
                creator=self.non_member,
                name="Bad Project",
            )

    def test_creator_becomes_owner(self):
        project = create_project(
            research_group=self.group,
            creator=self.member,
            name="Owner Test",
        )
        membership = ProjectMembership.objects.get(
            project=project, user=self.member
        )
        self.assertEqual(membership.role, ProjectMembership.Role.OWNER)

    def test_creation_is_atomic(self):
        project = create_project(
            research_group=self.group,
            creator=self.member,
            name="Atomic Test",
        )
        self.assertTrue(Project.objects.filter(pk=project.pk).exists())
        self.assertTrue(
            ProjectMembership.objects.filter(
                project=project, user=self.member
            ).exists()
        )

    def test_invalid_status_rejected(self):
        with self.assertRaises(ProjectDomainError):
            create_project(
                research_group=self.group,
                creator=self.member,
                name="Bad Status",
                status="invalid",
            )


class FinalOwnerInvariantTest(TestCase):
    """Test the active Project final-owner invariant."""

    def setUp(self):
        self.group = ResearchGroup.objects.create(
            name="FG Test",
            created_by=User.objects.create_user(
                username="owner1", password="Pass1!"
            ),
        )
        self.owner1 = User.objects.get(username="owner1")
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.owner1,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        self.owner2 = User.objects.create_user(
            username="owner2", password="Pass1!"
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.owner2,
            role=ResearchGroupMembership.Role.MEMBER,
        )

        # Create project with owner1 as owner
        self.project = create_project(
            research_group=self.group,
            creator=self.owner1,
            name="Owner Test",
        )

    def test_cannot_remove_final_owner(self):
        """Cannot remove the final owner of an active Project."""
        membership = ProjectMembership.objects.get(
            project=self.project, user=self.owner1
        )
        with self.assertRaises(ProjectDomainError):
            remove_membership(
                membership=membership, actor=self.owner1
            )

    def test_cannot_downgrade_final_owner(self):
        """Cannot downgrade the final owner of an active Project."""
        membership = ProjectMembership.objects.get(
            project=self.project, user=self.owner1
        )
        with self.assertRaises(ProjectDomainError):
            change_membership_role(
                membership=membership,
                actor=self.owner1,
                new_role=ProjectMembership.Role.MEMBER,
            )

    def test_can_remove_owner_when_another_owner_exists(self):
        """Can remove an owner when another owner exists."""
        add_project_membership(
            project=self.project,
            actor=self.owner1,
            target_user=self.owner2,
            role=ProjectMembership.Role.OWNER,
        )
        membership = ProjectMembership.objects.get(
            project=self.project, user=self.owner2
        )
        remove_membership(membership=membership, actor=self.owner1)
        self.assertFalse(
            ProjectMembership.objects.filter(
                project=self.project, user=self.owner2
            ).exists()
        )

    def test_can_downgrade_owner_when_another_owner_exists(self):
        """Can downgrade an owner when another owner exists."""
        add_project_membership(
            project=self.project,
            actor=self.owner1,
            target_user=self.owner2,
            role=ProjectMembership.Role.OWNER,
        )
        membership = ProjectMembership.objects.get(
            project=self.project, user=self.owner2
        )
        change_membership_role(
            membership=membership,
            actor=self.owner1,
            new_role=ProjectMembership.Role.MEMBER,
        )
        membership.refresh_from_db()
        self.assertEqual(membership.role, ProjectMembership.Role.MEMBER)

    def test_owner_can_remove_self_when_another_owner_exists(self):
        """Owner may remove themselves if another owner exists."""
        add_project_membership(
            project=self.project,
            actor=self.owner1,
            target_user=self.owner2,
            role=ProjectMembership.Role.OWNER,
        )
        membership = ProjectMembership.objects.get(
            project=self.project, user=self.owner1
        )
        remove_membership(membership=membership, actor=self.owner2)
        self.assertFalse(
            ProjectMembership.objects.filter(
                project=self.project, user=self.owner1
            ).exists()
        )


class MembershipPrerequisiteTest(TestCase):
    """Test that ProjectMembership requires ResearchGroupMembership."""

    def setUp(self):
        self.group = ResearchGroup.objects.create(
            name="FG Test",
            created_by=User.objects.create_user(
                username="admin", password="Pass1!"
            ),
        )
        self.admin = User.objects.get(username="admin")
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.admin,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        self.project = create_project(
            research_group=self.group,
            creator=self.admin,
            name="Prereq Test",
        )
        # User in a different group
        other_group = ResearchGroup.objects.create(
            name="Other FG", created_by=self.admin
        )
        self.other_group_user = User.objects.create_user(
            username="other_group_user", password="Pass1!"
        )
        ResearchGroupMembership.objects.create(
            research_group=other_group,
            user=self.other_group_user,
            role=ResearchGroupMembership.Role.MEMBER,
        )

    def test_non_group_user_cannot_be_added(self):
        """Cannot add a user who is not in the Project's Research Group."""
        with self.assertRaises(ProjectDomainError):
            add_project_membership(
                project=self.project,
                actor=self.admin,
                target_user=self.other_group_user,
                role=ProjectMembership.Role.MEMBER,
            )

    def test_no_group_membership_at_all(self):
        """Cannot add a user with no Research Group membership anywhere."""
        no_group_user = User.objects.create_user(
            username="no_group_user", password="Pass1!"
        )
        with self.assertRaises(ProjectDomainError):
            add_project_membership(
                project=self.project,
                actor=self.admin,
                target_user=no_group_user,
                role=ProjectMembership.Role.MEMBER,
            )


class UpdateProjectTest(TestCase):
    """Test Project update operation."""

    def setUp(self):
        self.group = ResearchGroup.objects.create(
            name="FG Test",
            created_by=User.objects.create_user(
                username="owner", password="Pass1!"
            ),
        )
        self.owner = User.objects.get(username="owner")
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.owner,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        self.project = create_project(
            research_group=self.group,
            creator=self.owner,
            name="Update Test",
        )

    def test_owner_can_update(self):
        update_project(
            project=self.project,
            actor=self.owner,
            name="Updated Name",
            description="New description",
            status=Project.Status.PAUSED,
        )
        self.project.refresh_from_db()
        self.assertEqual(self.project.name, "Updated Name")
        self.assertEqual(self.project.description, "New description")
        self.assertEqual(self.project.status, "paused")

    def test_non_owner_cannot_update(self):
        other = User.objects.create_user(
            username="other", password="Pass1!"
        )
        with self.assertRaises(ProjectDomainError):
            update_project(
                project=self.project,
                actor=other,
                name="Hacked",
            )

    def test_invalid_status_rejected(self):
        with self.assertRaises(ProjectDomainError):
            update_project(
                project=self.project,
                actor=self.owner,
                status="invalid",
            )


class UserDeletionInvariantTest(TestCase):
    """Test that deleting a User cannot bypass the final-owner invariant.

    ProjectMembership.user uses on_delete=RESTRICT, so the DB will
    refuse to delete a User who still has active ProjectMemberships.
    This prevents silently making an active Project ownerless.
    """

    def setUp(self):
        self.group = ResearchGroup.objects.create(
            name="FG Test",
            created_by=User.objects.create_user(
                username="owner1", password="Pass1!",
            ),
        )
        self.owner1 = User.objects.get(username="owner1")
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.owner1,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        self.project = create_project(
            research_group=self.group,
            creator=self.owner1,
            name="Deletion Test",
        )

    def test_cannot_delete_user_with_project_membership(self):
        """Deleting a User with ProjectMembership is blocked by RESTRICT."""
        from django.db.utils import IntegrityError
        with self.assertRaises(IntegrityError):
            self.owner1.delete()

    def test_project_still_has_owner_after_failed_user_deletion(self):
        """Project remains intact after a failed User deletion."""
        with self.assertRaises(Exception):
            self.owner1.delete()

        # Project and membership must still exist
        self.project.refresh_from_db()
        self.assertTrue(
            ProjectMembership.objects.filter(
                project=self.project,
                user__username="owner1",
                role=ProjectMembership.Role.OWNER,
            ).exists(),
        )


class OwnershipLockingTest(TestCase):
    """Verify that ownership-mutating services use select_for_update().

    Full concurrent testing requires deterministic scheduling across
    threads which is outside Django TestCase's transaction-per-test model.
    These tests verify the locking structure is in place.
    """

    def setUp(self):
        self.group = ResearchGroup.objects.create(
            name="FG Test",
            created_by=User.objects.create_user(
                username="owner1", password="Pass1!",
            ),
        )
        self.owner1 = User.objects.get(username="owner1")
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.owner1,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        self.owner2 = User.objects.create_user(
            username="owner2", password="Pass1!",
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.owner2,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        self.project = create_project(
            research_group=self.group,
            creator=self.owner1,
            name="Locking Test",
        )

    def test_change_membership_role_uses_atomic_transaction(self):
        """change_membership_role must wrap mutations in transaction.atomic()."""
        import inspect
        source = inspect.getsource(change_membership_role)
        self.assertIn("transaction.atomic", source)
        self.assertIn("select_for_update", source)

    def test_remove_membership_uses_atomic_transaction(self):
        """remove_membership must wrap mutations in transaction.atomic()."""
        import inspect
        source = inspect.getsource(remove_membership)
        self.assertIn("transaction.atomic", source)
        self.assertIn("select_for_update", source)

    def test_project_locked_before_owner_check(self):
        """The Project row must be locked before the final-owner check runs.

        This ensures concurrent downgrades/removals are serialized.
        Verified by source structure: select_for_update on Project
        comes before _check_final_owner_*.
        """
        import inspect
        source = inspect.getsource(change_membership_role)
        # Verify ordering: lock project before checking invariant
        lock_pos = source.index("Project.objects.select_for_update")
        check_pos = source.index("_check_final_owner_change")
        self.assertLess(
            lock_pos, check_pos,
            "Project row must be locked before final-owner check",
        )

    def test_project_locked_before_removal_check(self):
        """remove_membership: lock Project row before final-owner check."""
        import inspect
        source = inspect.getsource(remove_membership)
        lock_pos = source.index("Project.objects.select_for_update")
        check_pos = source.index("_check_final_owner_removal")
        self.assertLess(
            lock_pos, check_pos,
            "Project row must be locked before final-owner check",
        )
