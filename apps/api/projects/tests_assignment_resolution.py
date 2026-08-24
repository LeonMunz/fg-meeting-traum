from django.contrib.auth import get_user_model
from django.test import TestCase

from audit_history.models import AuditEvent
from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)
from work_items.models import (
    WorkItem,
    WorkItemAssignee,
)
from work_items.services import create_work_item

from .models import ProjectMembership
from .services import (
    ProjectDomainError,
    add_project_membership,
    archive_project,
    change_membership_role,
    create_project,
    remove_membership,
)


User = get_user_model()


class ProjectAssignmentResolutionTest(TestCase):
    def setUp(self):
        self.alex = User.objects.create_user(
            username="resolution_alex",
            password="DevPass1!",
        )
        self.chris = User.objects.create_user(
            username="resolution_chris",
            password="DevPass1!",
        )
        self.maria = User.objects.create_user(
            username="resolution_maria",
            password="DevPass1!",
        )
        self.laura = User.objects.create_user(
            username="resolution_laura",
            password="DevPass1!",
        )
        self.group_only = User.objects.create_user(
            username="resolution_group_only",
            password="DevPass1!",
        )

        self.group = ResearchGroup.objects.create(
            name="Assignment Resolution Group",
            created_by=self.alex,
        )

        for user in (
            self.alex,
            self.chris,
            self.maria,
            self.laura,
            self.group_only,
        ):
            ResearchGroupMembership.objects.create(
                research_group=self.group,
                user=user,
                role=ResearchGroupMembership.Role.MEMBER,
            )

        self.project = create_project(
            research_group=self.group,
            creator=self.alex,
            name="Resolution Project",
        )

        add_project_membership(
            project=self.project,
            actor=self.alex,
            target_user=self.chris,
            role=ProjectMembership.Role.MEMBER,
        )

        add_project_membership(
            project=self.project,
            actor=self.alex,
            target_user=self.maria,
            role=ProjectMembership.Role.MEMBER,
        )

        add_project_membership(
            project=self.project,
            actor=self.alex,
            target_user=self.laura,
            role=ProjectMembership.Role.VIEWER,
        )

    def membership(self, user):
        return ProjectMembership.objects.get(
            project=self.project,
            user=user,
        )

    def create_task(self, title, assignees):
        return create_work_item(
            project=self.project,
            actor=self.alex,
            type_definition_id=self.project.type_definitions.get(name="Task").pk,
            title=title,
            assignee_ids=[
                user.pk
                for user in assignees
            ],
        )

    def test_viewer_downgrade_can_unassign_target_only(self):
        task = self.create_task(
            "Shared Task",
            [self.chris, self.alex],
        )

        membership = change_membership_role(
            membership=self.membership(self.chris),
            actor=self.alex,
            new_role=ProjectMembership.Role.VIEWER,
            assignment_resolution="unassign",
        )

        self.assertEqual(
            membership.role,
            ProjectMembership.Role.VIEWER,
        )

        self.assertFalse(
            WorkItemAssignee.objects.filter(
                work_item=task,
                user=self.chris,
            ).exists()
        )

        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=task,
                user=self.alex,
            ).exists()
        )

        event = AuditEvent.objects.get(
            event_type="project.member_assignments_resolved",
        )

        self.assertEqual(event.subject_user, self.chris)
        self.assertEqual(event.project, self.project)
        self.assertEqual(event.data["resolution"], "unassign")
        self.assertEqual(event.data["affectedWorkItemCount"], 1)
        self.assertIsNone(event.data["replacementUserId"])
        self.assertEqual(
            event.data["membershipAction"],
            "role_changed",
        )

    def test_transfer_preserves_other_assignees_and_deduplicates(self):
        first = self.create_task(
            "First",
            [self.chris, self.alex],
        )
        second = self.create_task(
            "Second",
            [self.chris, self.maria],
        )

        change_membership_role(
            membership=self.membership(self.chris),
            actor=self.alex,
            new_role=ProjectMembership.Role.VIEWER,
            assignment_resolution="transfer",
            replacement_user=self.maria,
        )

        self.assertFalse(
            WorkItemAssignee.objects.filter(
                work_item__project=self.project,
                user=self.chris,
            ).exists()
        )

        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=first,
                user=self.alex,
            ).exists()
        )

        self.assertEqual(
            WorkItemAssignee.objects.filter(
                work_item__in=[first, second],
                user=self.maria,
            ).count(),
            2,
        )

        event = AuditEvent.objects.get(
            event_type="project.member_assignments_resolved",
        )

        self.assertEqual(
            event.data["affectedWorkItemCount"],
            2,
        )
        self.assertEqual(
            event.data["replacementUserId"],
            self.maria.pk,
        )

    def test_remove_can_unassign_target(self):
        task = self.create_task(
            "Remove Unassign",
            [self.chris, self.alex],
        )

        remove_membership(
            membership=self.membership(self.chris),
            actor=self.alex,
            assignment_resolution="unassign",
        )

        self.assertFalse(
            ProjectMembership.objects.filter(
                project=self.project,
                user=self.chris,
            ).exists()
        )

        self.assertFalse(
            WorkItemAssignee.objects.filter(
                work_item=task,
                user=self.chris,
            ).exists()
        )

        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=task,
                user=self.alex,
            ).exists()
        )

    def test_remove_can_transfer_target_assignments(self):
        task = self.create_task(
            "Remove Transfer",
            [self.chris],
        )

        remove_membership(
            membership=self.membership(self.chris),
            actor=self.alex,
            assignment_resolution="transfer",
            replacement_user=self.maria,
        )

        self.assertFalse(
            ProjectMembership.objects.filter(
                project=self.project,
                user=self.chris,
            ).exists()
        )

        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=task,
                user=self.maria,
            ).exists()
        )

    def test_transfer_to_viewer_is_rejected_without_changes(self):
        task = self.create_task(
            "Viewer Recipient",
            [self.chris],
        )

        with self.assertRaises(ProjectDomainError):
            change_membership_role(
                membership=self.membership(self.chris),
                actor=self.alex,
                new_role=ProjectMembership.Role.VIEWER,
                assignment_resolution="transfer",
                replacement_user=self.laura,
            )

        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=task,
                user=self.chris,
            ).exists()
        )

        self.assertEqual(
            self.membership(self.chris).role,
            ProjectMembership.Role.MEMBER,
        )

        self.assertFalse(
            AuditEvent.objects.filter(
                event_type="project.member_assignments_resolved",
            ).exists()
        )

    def test_transfer_to_group_member_without_project_access_is_rejected(self):
        task = self.create_task(
            "No Project Access",
            [self.chris],
        )

        with self.assertRaises(ProjectDomainError):
            remove_membership(
                membership=self.membership(self.chris),
                actor=self.alex,
                assignment_resolution="transfer",
                replacement_user=self.group_only,
            )

        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=task,
                user=self.chris,
            ).exists()
        )

        self.assertTrue(
            ProjectMembership.objects.filter(
                project=self.project,
                user=self.chris,
            ).exists()
        )

    def test_transfer_to_same_user_is_rejected(self):
        task = self.create_task(
            "Self Transfer",
            [self.chris],
        )

        with self.assertRaises(ProjectDomainError):
            remove_membership(
                membership=self.membership(self.chris),
                actor=self.alex,
                assignment_resolution="transfer",
                replacement_user=self.chris,
            )

        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=task,
                user=self.chris,
            ).exists()
        )

    def test_invalid_resolution_is_rejected(self):
        task = self.create_task(
            "Invalid Mode",
            [self.chris],
        )

        with self.assertRaises(ProjectDomainError):
            remove_membership(
                membership=self.membership(self.chris),
                actor=self.alex,
                assignment_resolution="something-else",
            )

        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=task,
                user=self.chris,
            ).exists()
        )

    def test_final_owner_failure_rolls_back_resolution(self):
        task = self.create_task(
            "Owner Work",
            [self.alex],
        )

        with self.assertRaises(ProjectDomainError):
            change_membership_role(
                membership=self.membership(self.alex),
                actor=self.alex,
                new_role=ProjectMembership.Role.VIEWER,
                assignment_resolution="unassign",
            )

        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=task,
                user=self.alex,
            ).exists()
        )

        self.assertEqual(
            self.membership(self.alex).role,
            ProjectMembership.Role.OWNER,
        )

    def test_archived_project_does_not_resolve_assignments(self):
        task = self.create_task(
            "Archived Work",
            [self.chris],
        )

        archive_project(
            project=self.project,
            actor=self.alex,
        )

        with self.assertRaises(ProjectDomainError):
            remove_membership(
                membership=self.membership(self.chris),
                actor=self.alex,
                assignment_resolution="unassign",
            )

        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=task,
                user=self.chris,
            ).exists()
        )

        self.assertTrue(
            ProjectMembership.objects.filter(
                project=self.project,
                user=self.chris,
            ).exists()
        )
