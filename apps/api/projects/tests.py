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


class ProjectMembershipAdminTest(TestCase):
    """Verify ProjectMembershipAdmin restricts add/change/delete in Django admin."""

    def setUp(self):
        self.superuser = User.objects.create_superuser(
            username="admin", password="Pass1!"
        )
        self.group = ResearchGroup.objects.create(
            name="FG Test", created_by=self.superuser
        )
        self.project = Project.objects.create(
            name="Admin Test",
            research_group=self.group,
            created_by=self.superuser,
        )
        self.membership = ProjectMembership.objects.create(
            project=self.project,
            user=self.superuser,
            role=ProjectMembership.Role.OWNER,
            added_by=self.superuser,
        )
        from projects.admin import ProjectMembershipAdmin
        from django.contrib.admin.sites import site
        self.admin = site.get_model_admin(ProjectMembership)

    def test_admin_cannot_add(self):
        """ProjectMembershipAdmin.has_add_permission returns False."""
        from django.test import RequestFactory
        factory = RequestFactory()
        request = factory.post("/admin/")
        request.user = self.superuser
        self.assertFalse(
            self.admin.has_add_permission(request),
            "Adding ProjectMembership through admin should be blocked",
        )

    def test_admin_cannot_change(self):
        """ProjectMembershipAdmin.has_change_permission returns False."""
        from django.test import RequestFactory
        factory = RequestFactory()
        request = factory.post("/admin/")
        request.user = self.superuser
        self.assertFalse(
            self.admin.has_change_permission(request, obj=self.membership),
            "Changing ProjectMembership through admin should be blocked",
        )

    def test_admin_cannot_change_collection(self):
        """ProjectMembershipAdmin.has_change_permission(obj=None) returns False."""
        from django.test import RequestFactory
        factory = RequestFactory()
        request = factory.post("/admin/")
        request.user = self.superuser
        self.assertFalse(
            self.admin.has_change_permission(request, obj=None),
            "Changing any ProjectMembership through admin should be blocked",
        )

    def test_admin_cannot_delete(self):
        """ProjectMembershipAdmin.has_delete_permission returns False."""
        from django.test import RequestFactory
        factory = RequestFactory()
        request = factory.post("/admin/")
        request.user = self.superuser
        self.assertFalse(
            self.admin.has_delete_permission(request, obj=self.membership),
            "Deleting ProjectMembership through admin should be blocked",
        )

    def test_admin_can_view_changelist(self):
        """Superuser can still view the ProjectMembership changelist.

        Viewing is allowed via the default ModelAdmin.has_module_permission
        which returns True for superusers.
        """
        from django.test import RequestFactory
        factory = RequestFactory()
        request = factory.get("/admin/")
        request.user = self.superuser
        self.assertTrue(
            self.admin.has_module_permission(request),
            "Superuser should be able to view ProjectMembership in admin",
        )


# ── Assignment lifecycle protection tests ──

from work_items.models import WorkItem, WorkItemAssignee
from work_items.services import WorkItemDomainError, create_work_item


class AssignmentLifecycleProtectionTest(TestCase):
    """Test that ProjectMembership mutations preserve assignment invariants.

    A user with active WorkItemAssignee rows in a project cannot be:
    - downgraded to viewer
    - removed from the project

    Eligible role changes (owner -> member, member -> owner) remain allowed.
    """

    def setUp(self):
        self.group = ResearchGroup.objects.create(
            name="FG Test", created_by=User.objects.create_user(
                username="alex", password="Pass1!"
            )
        )
        self.alex = User.objects.get(username="alex")
        ResearchGroupMembership.objects.create(
            research_group=self.group, user=self.alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )

        self.chris = User.objects.create_user(username="chris", password="Pass1!")
        ResearchGroupMembership.objects.create(
            research_group=self.group, user=self.chris,
            role=ResearchGroupMembership.Role.MEMBER,
        )

        self.laura = User.objects.create_user(username="laura", password="Pass1!")
        ResearchGroupMembership.objects.create(
            research_group=self.group, user=self.laura,
            role=ResearchGroupMembership.Role.MEMBER,
        )

        self.project = create_project(
            research_group=self.group, creator=self.alex, name="Paper XYZ"
        )
        add_project_membership(
            project=self.project, actor=self.alex,
            target_user=self.chris, role=ProjectMembership.Role.MEMBER,
        )
        add_project_membership(
            project=self.project, actor=self.alex,
            target_user=self.laura, role=ProjectMembership.Role.VIEWER,
        )

    def _create_assigned_work_item(self, assignee):
        """Create a WorkItem in Paper XYZ assigned to the given user."""
        return create_work_item(
            project=self.project, actor=self.alex,
            type_definition_id=self.project.type_definitions.get(name="Task").pk,
            title="Test Task",
            assignee_ids=[assignee.pk],
        )

    # ── Assigned member cannot become viewer ──

    def test_assigned_member_cannot_become_viewer(self):
        chris = self.chris
        self._create_assigned_work_item(chris)

        chris_membership = ProjectMembership.objects.get(
            project=self.project, user=chris
        )
        with self.assertRaises(ProjectDomainError) as ctx:
            change_membership_role(
                membership=chris_membership,
                actor=self.alex,
                new_role=ProjectMembership.Role.VIEWER,
            )
        self.assertIn("unassigned", str(ctx.exception.message).lower())

    def test_assigned_member_cannot_be_removed(self):
        chris = self.chris
        self._create_assigned_work_item(chris)

        chris_membership = ProjectMembership.objects.get(
            project=self.project, user=chris
        )
        with self.assertRaises(ProjectDomainError) as ctx:
            remove_membership(
                membership=chris_membership,
                actor=self.alex,
            )
        self.assertIn("unassigned", str(ctx.exception.message).lower())

    # ── Membership remains unchanged after rejection ──

    def test_membership_unchanged_after_rejected_downgrade(self):
        chris = self.chris
        self._create_assigned_work_item(chris)

        chris_membership = ProjectMembership.objects.get(
            project=self.project, user=chris
        )
        self.assertEqual(chris_membership.role, ProjectMembership.Role.MEMBER)

        try:
            change_membership_role(
                membership=chris_membership,
                actor=self.alex,
                new_role=ProjectMembership.Role.VIEWER,
            )
        except ProjectDomainError:
            pass

        # Membership role must still be member
        updated_membership = ProjectMembership.objects.get(pk=chris_membership.pk)
        self.assertEqual(
            updated_membership.role, ProjectMembership.Role.MEMBER,
            "Membership role must remain unchanged after rejected downgrade",
        )

    def test_assignment_unchanged_after_rejected_removal(self):
        chris = self.chris
        wi = self._create_assigned_work_item(chris)

        chris_membership = ProjectMembership.objects.get(
            project=self.project, user=chris
        )
        try:
            remove_membership(
                membership=chris_membership,
                actor=self.alex,
            )
        except ProjectDomainError:
            pass

        # Assignment must still exist
        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=wi, user=chris
            ).exists(),
            "Assignment must remain after rejected membership removal",
        )
        # Membership must still exist
        self.assertTrue(
            ProjectMembership.objects.filter(
                project=self.project, user=chris
            ).exists(),
            "Membership must remain after rejected removal",
        )

    # ── Assigned owner can become member if not last owner ──

    def test_assigned_owner_can_become_member_when_another_owner(self):
        # Alex is owner, Chris is member
        # Add Chris as another owner first
        chris_membership = ProjectMembership.objects.get(
            project=self.project, user=self.chris
        )
        change_membership_role(
            membership=chris_membership,
            actor=self.alex,
            new_role=ProjectMembership.Role.OWNER,
        )
        # Now create an assignment for Chris
        self._create_assigned_work_item(self.chris)

        # Chris (owner, assigned) can become member because Alex is still owner
        chris_membership.refresh_from_db()
        result = change_membership_role(
            membership=chris_membership,
            actor=self.alex,
            new_role=ProjectMembership.Role.MEMBER,
        )
        self.assertEqual(result.role, ProjectMembership.Role.MEMBER)

    def test_assigned_owner_cannot_become_viewer(self):
        # Make Chris an owner (Alex stays owner too)
        chris_membership = ProjectMembership.objects.get(
            project=self.project, user=self.chris
        )
        change_membership_role(
            membership=chris_membership,
            actor=self.alex,
            new_role=ProjectMembership.Role.OWNER,
        )
        self._create_assigned_work_item(self.chris)

        chris_membership.refresh_from_db()
        with self.assertRaises(ProjectDomainError) as ctx:
            change_membership_role(
                membership=chris_membership,
                actor=self.alex,
                new_role=ProjectMembership.Role.VIEWER,
            )
        self.assertIn("unassigned", str(ctx.exception.message).lower())

    def test_assigned_owner_cannot_be_removed(self):
        # Make Chris an owner
        chris_membership = ProjectMembership.objects.get(
            project=self.project, user=self.chris
        )
        change_membership_role(
            membership=chris_membership,
            actor=self.alex,
            new_role=ProjectMembership.Role.OWNER,
        )
        self._create_assigned_work_item(self.chris)

        chris_membership.refresh_from_db()
        with self.assertRaises(ProjectDomainError) as ctx:
            remove_membership(
                membership=chris_membership,
                actor=self.alex,
            )
        self.assertIn("unassigned", str(ctx.exception.message).lower())

    # ── Unassigned user can become viewer or be removed ──

    def test_unassigned_member_can_become_viewer(self):
        # Laura is a viewer, add another member without assignments
        another = User.objects.create_user(username="bob", password="Pass1!")
        ResearchGroupMembership.objects.create(
            research_group=self.group, user=another,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        add_project_membership(
            project=self.project, actor=self.alex,
            target_user=another, role=ProjectMembership.Role.MEMBER,
        )
        # No assignments for 'another'

        another_membership = ProjectMembership.objects.get(
            project=self.project, user=another
        )
        result = change_membership_role(
            membership=another_membership,
            actor=self.alex,
            new_role=ProjectMembership.Role.VIEWER,
        )
        self.assertEqual(result.role, ProjectMembership.Role.VIEWER)

    def test_unassigned_member_can_be_removed(self):
        another = User.objects.create_user(username="bob", password="Pass1!")
        ResearchGroupMembership.objects.create(
            research_group=self.group, user=another,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        add_project_membership(
            project=self.project, actor=self.alex,
            target_user=another, role=ProjectMembership.Role.MEMBER,
        )
        # No assignments for 'another'

        another_membership = ProjectMembership.objects.get(
            project=self.project, user=another
        )
        remove_membership(
            membership=another_membership,
            actor=self.alex,
        )
        self.assertFalse(
            ProjectMembership.objects.filter(
                project=self.project, user=another
            ).exists()
        )

    # ── Multiple work items ──

    def test_any_assignment_blocks_ineligible_mutation(self):
        # Create two assignments for Chris
        self._create_assigned_work_item(self.chris)
        create_work_item(
            project=self.project, actor=self.alex,
            type_definition_id=self.project.type_definitions.get(name="Task").pk,
            title="Test Task 2",
            assignee_ids=[self.chris.pk],
        )

        chris_membership = ProjectMembership.objects.get(
            project=self.project, user=self.chris
        )
        with self.assertRaises(ProjectDomainError):
            remove_membership(
                membership=chris_membership,
                actor=self.alex,
            )

    # ── Other project does not block ──

    def test_assignment_in_other_project_does_not_block(self):
        # Create a second project where Chris has access and is assigned
        project_b = create_project(
            research_group=self.group, creator=self.chris,
            name="Project B"
        )
        create_work_item(
            project=project_b, actor=self.chris,
            type_definition_id=project_b.type_definitions.get(name="Task").pk,
            title="Task in B",
            assignee_ids=[self.chris.pk],
        )

        # Chris has assignment in Project B but NOT in Paper XYZ
        chris_membership = ProjectMembership.objects.get(
            project=self.project, user=self.chris
        )
        # Removing from Paper XYZ should work (no assignment there)
        remove_membership(
            membership=chris_membership,
            actor=self.alex,
        )
        self.assertFalse(
            ProjectMembership.objects.filter(
                project=self.project, user=self.chris
            ).exists()
        )


# ── Configuration service tests ──

from projects.configuration_services import (
    ConfigurationError,
    create_label_definition,
    create_status_definition,
    create_type_definition,
    reorder_label_definitions,
    reorder_status_definitions,
    reorder_type_definitions,
    update_label_definition,
    update_status_definition,
    update_type_definition,
)
from projects.models import (
    WorkItemLabelDefinition,
    WorkItemStatusDefinition,
    WorkItemTypeDefinition,
)


class _ConfigSetupMixin:
    """Create standard test users + project with default configuration."""

    def setUp(self):
        self.alex = User.objects.create_user(
            username="alex", password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="chris", password="Pass1!",
        )
        self.laura = User.objects.create_user(
            username="laura", password="Pass1!",
        )
        self.group = ResearchGroup.objects.create(
            name="FG Config", created_by=self.alex,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group, user=self.alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group, user=self.chris,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group, user=self.laura,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        self.project = create_project(
            research_group=self.group,
            creator=self.alex,
            name="Config Project",
        )


class ConfigurationServiceTest(_ConfigSetupMixin, TestCase):
    """Test configuration_services CRUD operations directly."""

    # ── Type CRUD ──

    def test_create_type_owner(self):
        t = create_type_definition(self.project, self.alex, "Bug")
        self.assertEqual(t.name, "Bug")
        self.assertEqual(t.project, self.project)
        self.assertTrue(t.active)

    def test_create_type_member_gets_error(self):
        with self.assertRaises(ConfigurationError):
            create_type_definition(self.project, self.chris, "Bug")

    def test_create_type_viewer_gets_error(self):
        with self.assertRaises(ConfigurationError):
            create_type_definition(self.project, self.laura, "Bug")

    def test_create_type_blank_name_rejected(self):
        with self.assertRaises(ConfigurationError):
            create_type_definition(self.project, self.alex, "  ")

    def test_create_type_empty_string_rejected(self):
        with self.assertRaises(ConfigurationError):
            create_type_definition(self.project, self.alex, "")

    def test_create_type_case_insensitive_unique(self):
        create_type_definition(self.project, self.alex, "Custom Type")
        with self.assertRaises(ConfigurationError) as ctx:
            create_type_definition(self.project, self.alex, "custom type")
        self.assertIn("already exists", ctx.exception.message)

    def test_create_type_case_insensitive_unique_mixed(self):
        create_type_definition(self.project, self.alex, "MixedCase")
        with self.assertRaises(ConfigurationError):
            create_type_definition(self.project, self.alex, "mIxEdCaSe")

    def test_create_type_auto_order(self):
        t1 = create_type_definition(self.project, self.alex, "A")
        t2 = create_type_definition(self.project, self.alex, "B")
        self.assertLess(t1.order, t2.order)

    def test_create_type_explicit_order(self):
        t = create_type_definition(self.project, self.alex, "Z", order=42)
        self.assertEqual(t.order, 42)

    def test_update_type_owner_rename(self):
        t = create_type_definition(self.project, self.alex, "Old")
        update_type_definition(t, self.alex, name="New")
        t.refresh_from_db()
        self.assertEqual(t.name, "New")

    def test_update_type_non_owner_rejected(self):
        t = create_type_definition(self.project, self.alex, "Bug")
        with self.assertRaises(ConfigurationError):
            update_type_definition(t, self.chris, name="Task")

    def test_update_type_blank_name_rejected(self):
        t = create_type_definition(self.project, self.alex, "Bug")
        with self.assertRaises(ConfigurationError):
            update_type_definition(t, self.alex, name="")

    def test_update_type_case_insensitive_unique(self):
        create_type_definition(self.project, self.alex, "Existing Type")
        t = create_type_definition(self.project, self.alex, "Bug")
        with self.assertRaises(ConfigurationError):
            update_type_definition(t, self.alex, name="EXISTING TYPE")

    def test_update_type_deactivate_final_active_rejected(self):
        t = create_type_definition(self.project, self.alex, "OnlyOne")
        for d in (
            WorkItemTypeDefinition.objects
            .filter(project=self.project, active=True)
            .exclude(pk=t.pk)
        ):
            update_type_definition(d, self.alex, active=False)

        with self.assertRaises(ConfigurationError) as ctx:
            update_type_definition(t, self.alex, active=False)
        self.assertIn("final active", ctx.exception.message)

    def test_update_type_deactivate_order(self):
        t = create_type_definition(self.project, self.alex, "Second")
        update_type_definition(t, self.alex, order=100)
        t.refresh_from_db()
        self.assertEqual(t.order, 100)

    # ── Status CRUD ──

    def test_create_status_owner(self):
        s = create_status_definition(
            self.project, self.alex, "Blocked", "todo",
        )
        self.assertEqual(s.name, "Blocked")
        self.assertEqual(s.category, "todo")

    def test_create_status_member_gets_error(self):
        with self.assertRaises(ConfigurationError):
            create_status_definition(
                self.project, self.chris, "Blocked", "todo",
            )

    def test_create_status_invalid_category(self):
        with self.assertRaises(ConfigurationError):
            create_status_definition(
                self.project, self.alex, "Blocked", "invalid_category",
            )

    def test_create_status_blank_name_rejected(self):
        with self.assertRaises(ConfigurationError):
            create_status_definition(
                self.project, self.alex, "  ", "todo",
            )

    def test_create_status_case_insensitive_unique(self):
        create_status_definition(
            self.project, self.alex, "Custom Status", "in_progress",
        )
        with self.assertRaises(ConfigurationError):
            create_status_definition(
                self.project, self.alex, "custom status", "in_progress",
            )

    def test_create_status_default_must_be_todo(self):
        with self.assertRaises(ConfigurationError):
            create_status_definition(
                self.project, self.alex, "Done Default", "done",
                is_default=True,
            )

    def test_create_status_default_clears_existing(self):
        existing_default = WorkItemStatusDefinition.objects.get(
            project=self.project, is_default=True, active=True,
        )
        create_status_definition(
            self.project, self.alex, "New Todo", "todo",
            is_default=True,
        )
        existing_default.refresh_from_db()
        self.assertFalse(existing_default.is_default)

    def test_update_status_owner_rename(self):
        s = create_status_definition(
            self.project, self.alex, "Old Status", "review",
        )
        update_status_definition(s, self.alex, name="New Status")
        s.refresh_from_db()
        self.assertEqual(s.name, "New Status")

    def test_update_status_non_owner_rejected(self):
        s = create_status_definition(
            self.project, self.alex, "Blocked", "todo",
        )
        with self.assertRaises(ConfigurationError):
            update_status_definition(s, self.chris, name="Frozen")

    def test_update_status_category_immutable_when_referenced(self):
        # Create a WorkItem referencing this status
        default_status = WorkItemStatusDefinition.objects.get(
            project=self.project, is_default=True, active=True,
        )
        wi = WorkItem.objects.create(
            project=self.project,
            title="Test WI",
            type_definition=self.project.type_definitions.get(name="Task"),
            status_definition=default_status,
            created_by=self.alex,
        )
        s = create_status_definition(
            self.project, self.alex, "Custom Status", "todo",
        )
        # Assign the work item to our status
        wi.status_definition = s
        wi.save(update_fields=["status_definition"])
        # Now try to change category
        with self.assertRaises(ConfigurationError) as ctx:
            update_status_definition(s, self.alex, category="done")
        self.assertIn("referenced by WorkItems", ctx.exception.message)

    def test_update_status_set_default_non_todo_rejected(self):
        s = create_status_definition(
            self.project, self.alex, "Done Status", "done",
        )
        with self.assertRaises(ConfigurationError):
            update_status_definition(s, self.alex, is_default=True)

    def test_update_status_deactivate_current_default_rejected(self):
        default_status = WorkItemStatusDefinition.objects.get(
            project=self.project, is_default=True, active=True,
        )
        with self.assertRaises(ConfigurationError) as ctx:
            update_status_definition(default_status, self.alex, active=False)
        self.assertIn("current default", ctx.exception.message)

    def test_update_status_case_insensitive_unique(self):
        create_status_definition(
            self.project, self.alex, "Custom", "in_progress",
        )
        s = create_status_definition(
            self.project, self.alex, "Another", "review",
        )
        with self.assertRaises(ConfigurationError):
            update_status_definition(s, self.alex, name="CUSTOM")

    # ── Label CRUD ──

    def test_create_label_owner(self):
        l = create_label_definition(self.project, self.alex, "Frontend")
        self.assertEqual(l.name, "Frontend")

    def test_create_label_member_gets_error(self):
        with self.assertRaises(ConfigurationError):
            create_label_definition(self.project, self.chris, "Backend")

    def test_create_label_blank_name_rejected(self):
        with self.assertRaises(ConfigurationError):
            create_label_definition(self.project, self.alex, "")

    def test_create_label_case_insensitive_unique(self):
        create_label_definition(self.project, self.alex, "Bug")
        with self.assertRaises(ConfigurationError):
            create_label_definition(self.project, self.alex, "bug")

    def test_update_label_owner_rename(self):
        l = create_label_definition(self.project, self.alex, "OldLabel")
        update_label_definition(l, self.alex, name="NewLabel")
        l.refresh_from_db()
        self.assertEqual(l.name, "NewLabel")

    def test_update_label_non_owner_rejected(self):
        l = create_label_definition(self.project, self.alex, "Label")
        with self.assertRaises(ConfigurationError):
            update_label_definition(l, self.chris, name="Hacked")

    def test_update_label_deactivate(self):
        l = create_label_definition(self.project, self.alex, "Label")
        update_label_definition(l, self.alex, active=False)
        l.refresh_from_db()
        self.assertFalse(l.active)

    def test_update_label_reactivate(self):
        l = create_label_definition(self.project, self.alex, "Label")
        update_label_definition(l, self.alex, active=False)
        update_label_definition(l, self.alex, active=True)
        l.refresh_from_db()
        self.assertTrue(l.active)

    def test_update_label_blank_name_rejected(self):
        l = create_label_definition(self.project, self.alex, "Label")
        with self.assertRaises(ConfigurationError):
            update_label_definition(l, self.alex, name="   ")

    # ── Reorder operations ──

    def test_reorder_types(self):
        t1 = create_type_definition(self.project, self.alex, "A", order=0)
        t2 = create_type_definition(self.project, self.alex, "B", order=1)
        t3 = create_type_definition(self.project, self.alex, "C", order=2)
        reorder_type_definitions(
            self.project, self.alex,
            [(t1.pk, 2), (t2.pk, 0), (t3.pk, 1)],
        )
        self.assertEqual(
            dict(WorkItemTypeDefinition.objects.filter(
                project=self.project,
                pk__in=[t1.pk, t2.pk, t3.pk],
            ).values_list("name", "order")),
            {"A": 2, "B": 0, "C": 1},
        )

    def test_reorder_types_non_owner_rejected(self):
        with self.assertRaises(ConfigurationError):
            reorder_type_definitions(self.project, self.chris, [])

    def test_reorder_statuses(self):
        s1 = create_status_definition(
            self.project, self.alex, "S1", "todo", order=0,
        )
        s2 = create_status_definition(
            self.project, self.alex, "S2", "in_progress", order=1,
        )
        reorder_status_definitions(
            self.project, self.alex,
            [(s1.pk, 1), (s2.pk, 0)],
        )
        self.assertEqual(
            dict(WorkItemStatusDefinition.objects.filter(
                project=self.project,
                pk__in=[s1.pk, s2.pk],
            ).values_list("name", "order")),
            {"S1": 1, "S2": 0},
        )

    def test_reorder_labels(self):
        l1 = create_label_definition(self.project, self.alex, "L1", order=0)
        l2 = create_label_definition(self.project, self.alex, "L2", order=1)
        reorder_label_definitions(
            self.project, self.alex,
            [(l1.pk, 1), (l2.pk, 0)],
        )
        self.assertEqual(
            dict(WorkItemLabelDefinition.objects.filter(project=self.project)
                 .values_list("name", "order")),
            {"L1": 1, "L2": 0},
        )

    # ── Inactive definitions still reserve names ──

    def test_inactive_type_reserves_name(self):
        t = create_type_definition(self.project, self.alex, "Reserved")
        update_type_definition(t, self.alex, active=False)
        with self.assertRaises(ConfigurationError):
            create_type_definition(self.project, self.alex, "reserved")

    def test_inactive_status_reserves_name(self):
        s = create_status_definition(
            self.project, self.alex, "Reserved", "review",
        )
        update_status_definition(s, self.alex, active=False)
        with self.assertRaises(ConfigurationError):
            create_status_definition(
                self.project, self.alex, "RESERVED", "todo",
            )

    def test_inactive_label_reserves_name(self):
        l = create_label_definition(self.project, self.alex, "Reserved")
        update_label_definition(l, self.alex, active=False)
        with self.assertRaises(ConfigurationError):
            create_label_definition(self.project, self.alex, "RESERVED")


class ConfigurationServiceLockingTest(_ConfigSetupMixin, TestCase):
    """Verify configuration services use select_for_update()."""

    def test_create_type_uses_atomic_and_lock(self):
        import inspect
        source = inspect.getsource(create_type_definition)
        self.assertIn("transaction.atomic", source)
        self.assertIn("select_for_update", source)

    def test_create_status_uses_atomic_and_lock(self):
        import inspect
        source = inspect.getsource(create_status_definition)
        self.assertIn("transaction.atomic", source)
        self.assertIn("select_for_update", source)

    def test_create_label_uses_atomic_and_lock(self):
        import inspect
        source = inspect.getsource(create_label_definition)
        self.assertIn("transaction.atomic", source)
        self.assertIn("select_for_update", source)

    def test_update_type_uses_atomic_and_lock(self):
        import inspect
        source = inspect.getsource(update_type_definition)
        self.assertIn("transaction.atomic", source)
        self.assertIn("select_for_update", source)

    def test_update_status_uses_atomic_and_lock(self):
        import inspect
        source = inspect.getsource(update_status_definition)
        self.assertIn("transaction.atomic", source)
        self.assertIn("select_for_update", source)

    def test_update_label_uses_atomic_and_lock(self):
        import inspect
        source = inspect.getsource(update_label_definition)
        self.assertIn("transaction.atomic", source)
        self.assertIn("select_for_update", source)

    def test_reorder_types_uses_atomic_and_lock(self):
        import inspect
        source = inspect.getsource(reorder_type_definitions)
        self.assertIn("transaction.atomic", source)
        self.assertIn("select_for_update", source)


class SameProjectInvariantTest(_ConfigSetupMixin, TestCase):
    """Test that WorkItem definitions must belong to the same Project."""

    def setUp(self):
        super().setUp()
        # Second project for cross-project tests
        self.project_b = create_project(
            research_group=self.group,
            creator=self.chris,
            name="Project B",
        )

    def test_workitem_type_def_wrong_project(self):
        t = create_type_definition(self.project_b, self.chris, "Bug")
        with self.assertRaises(WorkItemDomainError):
            create_work_item(
                project=self.project,
                actor=self.alex,
                title="Cross Project",
                type_definition_id=t.pk,
            )

    def test_workitem_status_def_wrong_project(self):
        s = create_status_definition(
            self.project_b, self.chris, "Blocked", "todo",
        )
        with self.assertRaises(WorkItemDomainError):
            create_work_item(
                project=self.project,
                actor=self.alex,
                type_definition_id=self.project.type_definitions.get(name="Task").pk,
                title="Cross Project",
                status_definition_id=s.pk,
            )

    def test_workitem_label_def_wrong_project(self):
        l = create_label_definition(self.project_b, self.chris, "Backend")
        with self.assertRaises(WorkItemDomainError):
            create_work_item(
                project=self.project,
                actor=self.alex,
                type_definition_id=self.project.type_definitions.get(name="Task").pk,
                title="Cross Project",
                label_definition_ids=[l.pk],
            )

    def test_workitem_type_def_correct_project(self):
        t = create_type_definition(self.project, self.alex, "Feature")
        wi = create_work_item(
            project=self.project,
            actor=self.alex,
            title="Correct Project",
            type_definition_id=t.pk,
        )
        self.assertEqual(wi.type_definition, t)

    def test_workitem_status_def_correct_project(self):
        s = create_status_definition(
            self.project, self.alex, "Custom Status", "in_progress",
        )
        wi = create_work_item(
            project=self.project,
            actor=self.alex,
            type_definition_id=self.project.type_definitions.get(name="Task").pk,
            title="Correct Project",
            status_definition_id=s.pk,
        )
        self.assertEqual(wi.status_definition, s)

    def test_workitem_label_def_correct_project(self):
        l = create_label_definition(self.project, self.alex, "Frontend")
        wi = create_work_item(
            project=self.project,
            actor=self.alex,
            type_definition_id=self.project.type_definitions.get(name="Task").pk,
            title="Correct Project",
            label_definition_ids=[l.pk],
        )
        self.assertEqual(wi.label_relations.count(), 1)
        self.assertEqual(wi.label_relations.first().label, l)

    def test_update_workitem_type_def_wrong_project(self):
        t = create_type_definition(self.project_b, self.chris, "Bug")
        wi = create_work_item(
            project=self.project,
            actor=self.alex,
            type_definition_id=self.project.type_definitions.get(name="Task").pk,
            title="Update Cross",
        )
        from work_items.services import update_work_item
        with self.assertRaises(WorkItemDomainError):
            update_work_item(
                work_item=wi,
                actor=self.alex,
                type_definition_id=t.pk,
            )

    def test_update_workitem_label_wrong_project(self):
        l = create_label_definition(self.project_b, self.chris, "Backend")
        wi = create_work_item(
            project=self.project,
            actor=self.alex,
            type_definition_id=self.project.type_definitions.get(name="Task").pk,
            title="Update Cross",
        )
        from work_items.services import update_work_item
        with self.assertRaises(WorkItemDomainError):
            update_work_item(
                work_item=wi,
                actor=self.alex,
                label_definition_ids=[l.pk],
            )
