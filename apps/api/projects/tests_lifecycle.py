from django.contrib.auth import get_user_model
from django.test import TestCase

from audit_history.models import AuditEvent
from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)
from work_items.services import (
    WorkItemDomainError,
    create_work_item,
)

from .models import (
    Project,
    ProjectMembership,
    WorkItemStatusDefinition,
    WorkItemTypeDefinition,
)
from .services import (
    ProjectDomainError,
    add_project_membership,
    archive_project,
    change_membership_role,
    delete_empty_project,
    remove_membership,
    restore_project,
    update_project,
)


User = get_user_model()


class ProjectLifecycleTest(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = User.objects.create_user(
            username="lifecycle_owner",
            password="DevPass1!",
        )

        cls.member = User.objects.create_user(
            username="lifecycle_member",
            password="DevPass1!",
        )

        cls.other = User.objects.create_user(
            username="lifecycle_other",
            password="DevPass1!",
        )

        cls.group = ResearchGroup.objects.create(
            name="Lifecycle Group",
            created_by=cls.owner,
        )

        for user in (
            cls.owner,
            cls.member,
            cls.other,
        ):
            ResearchGroupMembership.objects.create(
                research_group=cls.group,
                user=user,
                role=ResearchGroupMembership.Role.MEMBER,
            )

    def create_project(self):
        project = Project.objects.create(
            research_group=self.group,
            name="Lifecycle Project",
            description="",
            status=Project.Status.ACTIVE,
            created_by=self.owner,
        )

        ProjectMembership.objects.create(
            project=project,
            user=self.owner,
            role=ProjectMembership.Role.OWNER,
            added_by=self.owner,
        )

        ProjectMembership.objects.create(
            project=project,
            user=self.member,
            role=ProjectMembership.Role.MEMBER,
            added_by=self.owner,
        )

        WorkItemTypeDefinition.objects.create(
            project=project, name="Task", order=0,
        )
        WorkItemStatusDefinition.objects.create(
            project=project, name="Todo",
            category=WorkItemStatusDefinition.Category.TODO,
            order=0, is_default=True,
        )

        return project

    def test_owner_can_archive_project(self):
        project = self.create_project()

        result = archive_project(
            project=project,
            actor=self.owner,
        )

        self.assertIsNotNone(
            result.archived_at,
        )

        event = AuditEvent.objects.get(
            event_type="project.archived",
        )

        self.assertEqual(
            event.project,
            project,
        )

        self.assertEqual(
            event.actor,
            self.owner,
        )

    def test_non_owner_cannot_archive_project(self):
        project = self.create_project()

        with self.assertRaises(
            ProjectDomainError,
        ):
            archive_project(
                project=project,
                actor=self.member,
            )

        project.refresh_from_db()

        self.assertIsNone(
            project.archived_at,
        )

    def test_owner_can_restore_project(self):
        project = self.create_project()

        archive_project(
            project=project,
            actor=self.owner,
        )

        restored = restore_project(
            project=project,
            actor=self.owner,
        )

        self.assertIsNone(
            restored.archived_at,
        )

        self.assertTrue(
            AuditEvent.objects.filter(
                event_type="project.restored",
                project=project,
            ).exists()
        )

    def test_unarchived_project_cannot_be_restored(self):
        project = self.create_project()

        with self.assertRaises(
            ProjectDomainError,
        ):
            restore_project(
                project=project,
                actor=self.owner,
            )

    def test_archived_project_metadata_is_read_only(self):
        project = self.create_project()

        archive_project(
            project=project,
            actor=self.owner,
        )

        with self.assertRaises(
            ProjectDomainError,
        ):
            update_project(
                project=project,
                actor=self.owner,
                name="Changed",
            )

        project.refresh_from_db()

        self.assertEqual(
            project.name,
            "Lifecycle Project",
        )

    def test_archived_project_memberships_are_read_only(self):
        project = self.create_project()

        archive_project(
            project=project,
            actor=self.owner,
        )

        with self.assertRaises(
            ProjectDomainError,
        ):
            add_project_membership(
                project=project,
                actor=self.owner,
                target_user=self.other,
                role=ProjectMembership.Role.MEMBER,
            )

    def test_archived_project_blocks_role_changes(self):
        project = self.create_project()

        member_membership = (
            ProjectMembership.objects.get(
                project=project,
                user=self.member,
            )
        )

        archive_project(
            project=project,
            actor=self.owner,
        )

        with self.assertRaises(
            ProjectDomainError,
        ):
            change_membership_role(
                membership=member_membership,
                actor=self.owner,
                new_role=ProjectMembership.Role.VIEWER,
            )

        member_membership.refresh_from_db()

        self.assertEqual(
            member_membership.role,
            ProjectMembership.Role.MEMBER,
        )

    def test_archived_project_blocks_membership_removal(self):
        project = self.create_project()

        member_membership = (
            ProjectMembership.objects.get(
                project=project,
                user=self.member,
            )
        )

        archive_project(
            project=project,
            actor=self.owner,
        )

        with self.assertRaises(
            ProjectDomainError,
        ):
            remove_membership(
                membership=member_membership,
                actor=self.owner,
            )

        self.assertTrue(
            ProjectMembership.objects.filter(
                pk=member_membership.pk,
            ).exists()
        )

    def test_archived_project_blocks_new_work_items(self):
        project = self.create_project()

        archive_project(
            project=project,
            actor=self.owner,
        )

        with self.assertRaises(
            WorkItemDomainError,
        ):
            create_work_item(
                project=project,
                actor=self.owner,
                type_definition_id=project.type_definitions.get(name="Task").pk,
                title="Should not exist",
            )

    def test_owner_can_delete_empty_project(self):
        project = self.create_project()
        project_id = project.pk

        delete_empty_project(
            project=project,
            actor=self.owner,
        )

        self.assertFalse(
            Project.objects.filter(
                pk=project_id,
            ).exists()
        )

        event = AuditEvent.objects.get(
            event_type="project.deleted",
        )

        self.assertIsNone(
            event.project_id,
        )

        self.assertEqual(
            event.data["projectId"],
            project_id,
        )

        self.assertEqual(
            event.data["projectName"],
            "Lifecycle Project",
        )

    def test_project_with_work_items_cannot_be_deleted(self):
        project = self.create_project()

        create_work_item(
            project=project,
            actor=self.owner,
            type_definition_id=project.type_definitions.get(name="Task").pk,
            title="Historical work",
        )

        with self.assertRaises(
            ProjectDomainError,
        ):
            delete_empty_project(
                project=project,
                actor=self.owner,
            )

        self.assertTrue(
            Project.objects.filter(
                pk=project.pk,
            ).exists()
        )

        self.assertFalse(
            AuditEvent.objects.filter(
                event_type="project.deleted",
                project=project,
            ).exists()
        )
