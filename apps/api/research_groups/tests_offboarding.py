from django.contrib.auth import get_user_model
from django.test import TestCase

from audit_history.models import AuditEvent
from projects.models import (
    Project,
    ProjectMembership,
)
from projects.services import (
    add_project_membership,
    archive_project,
    create_project,
)
from work_items.models import (
    WorkItem,
    WorkItemAssignee,
)
from work_items.services import create_work_item

from .models import (
    ResearchGroup,
    ResearchGroupMembership,
)
from .services import (
    ResearchGroupDomainError,
    ResearchGroupProjectOffboardingResolution,
    offboard_research_group_member,
)


User = get_user_model()


class ResearchGroupOffboardingTest(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(
            username="offboard_admin",
            password="DevPass1!",
        )
        self.target = User.objects.create_user(
            username="offboard_target",
            password="DevPass1!",
        )
        self.maria = User.objects.create_user(
            username="offboard_maria",
            password="DevPass1!",
        )
        self.viewer = User.objects.create_user(
            username="offboard_viewer",
            password="DevPass1!",
        )

        self.group = ResearchGroup.objects.create(
            name="Offboarding Group",
            created_by=self.admin,
        )

        self.admin_membership = (
            ResearchGroupMembership.objects.create(
                research_group=self.group,
                user=self.admin,
                role=ResearchGroupMembership.Role.ADMIN,
            )
        )

        self.target_membership = (
            ResearchGroupMembership.objects.create(
                research_group=self.group,
                user=self.target,
                role=ResearchGroupMembership.Role.MEMBER,
            )
        )

        for user in (
            self.maria,
            self.viewer,
        ):
            ResearchGroupMembership.objects.create(
                research_group=self.group,
                user=user,
                role=ResearchGroupMembership.Role.MEMBER,
            )

    def create_member_project(
        self,
        name,
    ):
        project = create_project(
            research_group=self.group,
            creator=self.admin,
            name=name,
        )

        add_project_membership(
            project=project,
            actor=self.admin,
            target_user=self.target,
            role=ProjectMembership.Role.MEMBER,
        )

        return project

    def add_project_member(
        self,
        project,
        user,
        role=ProjectMembership.Role.MEMBER,
        actor=None,
    ):
        add_project_membership(
            project=project,
            actor=actor or self.admin,
            target_user=user,
            role=role,
        )

    def create_task(
        self,
        *,
        project,
        title,
        assignees,
        actor=None,
    ):
        return create_work_item(
            project=project,
            actor=actor or self.admin,
            type_definition_id=project.type_definitions.get(name="Task").pk,
            title=title,
            assignee_ids=[
                user.pk
                for user in assignees
            ],
        )

    def test_removes_uncomplicated_project_and_group_memberships(
        self,
    ):
        project = self.create_member_project(
            "Simple Project",
        )

        result = offboard_research_group_member(
            membership=self.target_membership,
            actor=self.admin,
        )

        self.assertEqual(
            result.removed_project_membership_count,
            1,
        )

        self.assertFalse(
            ProjectMembership.objects.filter(
                project=project,
                user=self.target,
            ).exists()
        )

        self.assertFalse(
            ResearchGroupMembership.objects.filter(
                research_group=self.group,
                user=self.target,
            ).exists()
        )

        event = AuditEvent.objects.get(
            event_type=(
                "research_group.member_offboarded"
            )
        )

        self.assertEqual(
            event.subject_user,
            self.target,
        )
        self.assertEqual(
            event.data[
                "removedProjectMembershipCount"
            ],
            1,
        )

    def test_unassigns_work_across_multiple_projects(
        self,
    ):
        first = self.create_member_project(
            "First",
        )
        second = self.create_member_project(
            "Second",
        )

        first_task = self.create_task(
            project=first,
            title="First Task",
            assignees=[
                self.target,
                self.admin,
            ],
        )
        second_task = self.create_task(
            project=second,
            title="Second Task",
            assignees=[self.target],
        )

        result = offboard_research_group_member(
            membership=self.target_membership,
            actor=self.admin,
            project_resolutions=[
                ResearchGroupProjectOffboardingResolution(
                    project_id=first.pk,
                    assignment_resolution="unassign",
                ),
                ResearchGroupProjectOffboardingResolution(
                    project_id=second.pk,
                    assignment_resolution="unassign",
                ),
            ],
        )

        self.assertEqual(
            result.affected_work_item_count,
            2,
        )
        self.assertEqual(
            result.unassigned_assignment_count,
            2,
        )

        self.assertFalse(
            WorkItemAssignee.objects.filter(
                user=self.target,
            ).exists()
        )

        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=first_task,
                user=self.admin,
            ).exists()
        )

        self.assertFalse(
            WorkItemAssignee.objects.filter(
                work_item=second_task,
                user=self.target,
            ).exists()
        )

    def test_transfers_work_and_preserves_other_assignees(
        self,
    ):
        first = self.create_member_project(
            "Transfer First",
        )
        second = self.create_member_project(
            "Transfer Second",
        )

        for project in (
            first,
            second,
        ):
            self.add_project_member(
                project,
                self.maria,
            )

        first_task = self.create_task(
            project=first,
            title="Shared",
            assignees=[
                self.target,
                self.admin,
            ],
        )
        second_task = self.create_task(
            project=second,
            title="Already Maria",
            assignees=[
                self.target,
                self.maria,
            ],
        )

        result = offboard_research_group_member(
            membership=self.target_membership,
            actor=self.admin,
            project_resolutions=[
                ResearchGroupProjectOffboardingResolution(
                    project_id=first.pk,
                    assignment_resolution="transfer",
                    assignment_replacement_user=(
                        self.maria
                    ),
                ),
                ResearchGroupProjectOffboardingResolution(
                    project_id=second.pk,
                    assignment_resolution="transfer",
                    assignment_replacement_user=(
                        self.maria
                    ),
                ),
            ],
        )

        self.assertEqual(
            result.transferred_assignment_count,
            2,
        )

        self.assertFalse(
            WorkItemAssignee.objects.filter(
                user=self.target,
            ).exists()
        )

        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=first_task,
                user=self.admin,
            ).exists()
        )

        self.assertEqual(
            WorkItemAssignee.objects.filter(
                work_item__in=[
                    first_task,
                    second_task,
                ],
                user=self.maria,
            ).count(),
            2,
        )

    def test_active_final_owner_requires_resolution_and_rolls_back(
        self,
    ):
        project = create_project(
            research_group=self.group,
            creator=self.target,
            name="Final Owner",
        )

        task = self.create_task(
            project=project,
            title="Owner Task",
            assignees=[self.target],
            actor=self.target,
        )

        with self.assertRaises(
            ResearchGroupDomainError
        ):
            offboard_research_group_member(
                membership=self.target_membership,
                actor=self.admin,
                project_resolutions=[
                    ResearchGroupProjectOffboardingResolution(
                        project_id=project.pk,
                        assignment_resolution="unassign",
                    )
                ],
            )

        self.assertTrue(
            ProjectMembership.objects.filter(
                project=project,
                user=self.target,
                role=ProjectMembership.Role.OWNER,
            ).exists()
        )

        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=task,
                user=self.target,
            ).exists()
        )

        self.assertTrue(
            ResearchGroupMembership.objects.filter(
                pk=self.target_membership.pk,
            ).exists()
        )

    def test_transfers_final_project_ownership(
        self,
    ):
        project = create_project(
            research_group=self.group,
            creator=self.target,
            name="Ownership Transfer",
        )

        self.add_project_member(
            project,
            self.maria,
            actor=self.target,
        )

        result = offboard_research_group_member(
            membership=self.target_membership,
            actor=self.admin,
            project_resolutions=[
                ResearchGroupProjectOffboardingResolution(
                    project_id=project.pk,
                    ownership_resolution="transfer",
                    ownership_replacement_user=(
                        self.maria
                    ),
                )
            ],
        )

        self.assertEqual(
            result.ownership_transfer_count,
            1,
        )

        self.assertTrue(
            ProjectMembership.objects.filter(
                project=project,
                user=self.maria,
                role=ProjectMembership.Role.OWNER,
            ).exists()
        )

        self.assertFalse(
            ProjectMembership.objects.filter(
                project=project,
                user=self.target,
            ).exists()
        )

        self.assertTrue(
            AuditEvent.objects.filter(
                event_type=(
                    "project.ownership_resolved_for_offboarding"
                ),
                project=project,
            ).exists()
        )

    def test_archives_active_final_owner_project_and_preserves_work(
        self,
    ):
        project = create_project(
            research_group=self.group,
            creator=self.target,
            name="Archive Owner Project",
        )

        task = create_work_item(
            project=project,
            actor=self.target,
            type_definition_id=project.type_definitions.get(name="Task").pk,
            title="Historical Work",
        )

        result = offboard_research_group_member(
            membership=self.target_membership,
            actor=self.admin,
            project_resolutions=[
                ResearchGroupProjectOffboardingResolution(
                    project_id=project.pk,
                    ownership_resolution="archive",
                )
            ],
        )

        self.assertEqual(
            result.archived_project_count,
            1,
        )

        project.refresh_from_db()

        self.assertIsNotNone(
            project.archived_at,
        )

        self.assertTrue(
            WorkItem.objects.filter(
                pk=task.pk,
            ).exists()
        )

        self.assertFalse(
            ProjectMembership.objects.filter(
                project=project,
                user=self.target,
            ).exists()
        )

    def test_already_archived_project_can_become_ownerless(
        self,
    ):
        project = create_project(
            research_group=self.group,
            creator=self.target,
            name="Already Archived",
        )

        archive_project(
            project=project,
            actor=self.target,
        )

        offboard_research_group_member(
            membership=self.target_membership,
            actor=self.admin,
        )

        project.refresh_from_db()

        self.assertIsNotNone(
            project.archived_at,
        )

        self.assertFalse(
            ProjectMembership.objects.filter(
                project=project,
            ).exists()
        )

    def test_paused_and_completed_projects_keep_existing_owner_semantics(
        self,
    ):
        paused = create_project(
            research_group=self.group,
            creator=self.target,
            name="Paused",
            status=Project.Status.PAUSED,
        )
        completed = create_project(
            research_group=self.group,
            creator=self.target,
            name="Completed",
            status=Project.Status.COMPLETED,
        )

        offboard_research_group_member(
            membership=self.target_membership,
            actor=self.admin,
        )

        for project in (
            paused,
            completed,
        ):
            self.assertFalse(
                ProjectMembership.objects.filter(
                    project=project,
                    role=ProjectMembership.Role.OWNER,
                ).exists()
            )

    def test_failure_in_later_project_rolls_back_earlier_project(
        self,
    ):
        first = self.create_member_project(
            "Rollback First",
        )
        second = self.create_member_project(
            "Rollback Second",
        )

        self.add_project_member(
            second,
            self.viewer,
            role=ProjectMembership.Role.VIEWER,
        )

        first_task = self.create_task(
            project=first,
            title="First Target Work",
            assignees=[self.target],
        )
        second_task = self.create_task(
            project=second,
            title="Second Target Work",
            assignees=[self.target],
        )

        with self.assertRaises(
            ResearchGroupDomainError
        ):
            offboard_research_group_member(
                membership=self.target_membership,
                actor=self.admin,
                project_resolutions=[
                    ResearchGroupProjectOffboardingResolution(
                        project_id=first.pk,
                        assignment_resolution="unassign",
                    ),
                    ResearchGroupProjectOffboardingResolution(
                        project_id=second.pk,
                        assignment_resolution="transfer",
                        assignment_replacement_user=(
                            self.viewer
                        ),
                    ),
                ],
            )

        for project in (
            first,
            second,
        ):
            self.assertTrue(
                ProjectMembership.objects.filter(
                    project=project,
                    user=self.target,
                ).exists()
            )

        for task in (
            first_task,
            second_task,
        ):
            self.assertTrue(
                WorkItemAssignee.objects.filter(
                    work_item=task,
                    user=self.target,
                ).exists()
            )

        self.assertTrue(
            ResearchGroupMembership.objects.filter(
                pk=self.target_membership.pk,
            ).exists()
        )

        self.assertFalse(
            AuditEvent.objects.filter(
                event_type=(
                    "research_group.member_offboarded"
                )
            ).exists()
        )

    def test_final_research_group_admin_failure_rolls_back_projects(
        self,
    ):
        solo_group = ResearchGroup.objects.create(
            name="Solo Admin Group",
            created_by=self.admin,
        )

        solo_membership = (
            ResearchGroupMembership.objects.create(
                research_group=solo_group,
                user=self.admin,
                role=ResearchGroupMembership.Role.ADMIN,
            )
        )

        project = create_project(
            research_group=solo_group,
            creator=self.admin,
            name="Solo Paused Project",
            status=Project.Status.PAUSED,
        )

        with self.assertRaises(
            ResearchGroupDomainError
        ):
            offboard_research_group_member(
                membership=solo_membership,
                actor=self.admin,
            )

        self.assertTrue(
            ResearchGroupMembership.objects.filter(
                pk=solo_membership.pk,
            ).exists()
        )

        self.assertTrue(
            ProjectMembership.objects.filter(
                project=project,
                user=self.admin,
            ).exists()
        )

        self.assertFalse(
            AuditEvent.objects.filter(
                research_group=solo_group,
                event_type=(
                    "research_group.member_offboarded"
                ),
            ).exists()
        )

    def test_non_admin_cannot_offboard_member(
        self,
    ):
        project = self.create_member_project(
            "Admin Boundary",
        )

        with self.assertRaises(
            ResearchGroupDomainError
        ):
            offboard_research_group_member(
                membership=self.target_membership,
                actor=self.maria,
            )

        self.assertTrue(
            ResearchGroupMembership.objects.filter(
                pk=self.target_membership.pk,
            ).exists()
        )

        self.assertTrue(
            ProjectMembership.objects.filter(
                project=project,
                user=self.target,
            ).exists()
        )

        self.assertFalse(
            AuditEvent.objects.filter(
                event_type=(
                    "research_group.member_offboarded"
                ),
            ).exists()
        )

    def test_ownership_transfer_cannot_grant_new_project_access(
        self,
    ):
        project = create_project(
            research_group=self.group,
            creator=self.target,
            name="Private Ownership Project",
        )

        self.assertFalse(
            ProjectMembership.objects.filter(
                project=project,
                user=self.maria,
            ).exists()
        )

        with self.assertRaises(
            ResearchGroupDomainError
        ):
            offboard_research_group_member(
                membership=self.target_membership,
                actor=self.admin,
                project_resolutions=[
                    ResearchGroupProjectOffboardingResolution(
                        project_id=project.pk,
                        ownership_resolution="transfer",
                        ownership_replacement_user=(
                            self.maria
                        ),
                    )
                ],
            )

        self.assertTrue(
            ProjectMembership.objects.filter(
                project=project,
                user=self.target,
                role=ProjectMembership.Role.OWNER,
            ).exists()
        )

        self.assertFalse(
            ProjectMembership.objects.filter(
                project=project,
                user=self.maria,
            ).exists()
        )

        self.assertTrue(
            ResearchGroupMembership.objects.filter(
                pk=self.target_membership.pk,
            ).exists()
        )

        self.assertFalse(
            AuditEvent.objects.filter(
                event_type=(
                    "research_group.member_offboarded"
                ),
            ).exists()
        )


    def test_unknown_project_resolution_is_rejected(
        self,
    ):
        self.create_member_project(
            "Known Project",
        )

        with self.assertRaises(
            ResearchGroupDomainError
        ):
            offboard_research_group_member(
                membership=self.target_membership,
                actor=self.admin,
                project_resolutions=[
                    ResearchGroupProjectOffboardingResolution(
                        project_id=999999,
                        assignment_resolution="unassign",
                    )
                ],
            )

        self.assertTrue(
            ResearchGroupMembership.objects.filter(
                pk=self.target_membership.pk,
            ).exists()
        )
