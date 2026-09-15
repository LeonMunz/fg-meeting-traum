from datetime import timedelta

from django.contrib import admin
from django.contrib.auth import get_user_model
from django.db.models.deletion import RestrictedError
from django.test import TestCase
from django.utils import timezone

from meetings.models import Meeting
from projects.models import (
    Project,
    WorkItemStatusDefinition,
    WorkItemTypeDefinition,
)
from research_groups.models import ResearchGroup
from work_items.models import WorkItem

from .models import AuditEvent
from .services import (
    AuditHistoryError,
    record_audit_event,
)


User = get_user_model()


class AuditHistoryTest(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.actor = User.objects.create_user(
            username="audit_actor",
            password="DevPass1!",
        )

        cls.subject = User.objects.create_user(
            username="audit_subject",
            password="DevPass1!",
        )

        cls.group = ResearchGroup.objects.create(
            name="Audit Group",
            created_by=cls.actor,
        )

        cls.project = Project.objects.create(
            research_group=cls.group,
            name="Audit Project",
            description="",
            created_by=cls.actor,
        )

        cls.task_type = WorkItemTypeDefinition.objects.create(
            project=cls.project,
            name="Task",
        )
        cls.todo_status = WorkItemStatusDefinition.objects.create(
            project=cls.project,
            name="Todo",
            category=WorkItemStatusDefinition.Category.TODO,
            is_default=True,
        )

        cls.work_item = WorkItem.objects.create(
            project=cls.project,
            type_definition=cls.task_type,
            status_definition=cls.todo_status,
            title="Audit Task",
            created_by=cls.actor,
        )

        cls.other_actor = User.objects.create_user(
            username="other_actor",
            password="DevPass1!",
        )

        cls.other_group = ResearchGroup.objects.create(
            name="Other Group",
            created_by=cls.other_actor,
        )

        cls.other_project = Project.objects.create(
            research_group=cls.other_group,
            name="Other Project",
            description="",
            created_by=cls.other_actor,
        )

        cls.other_task_type = WorkItemTypeDefinition.objects.create(
            project=cls.other_project,
            name="Task",
        )
        cls.other_todo_status = WorkItemStatusDefinition.objects.create(
            project=cls.other_project,
            name="Todo",
            category=WorkItemStatusDefinition.Category.TODO,
            is_default=True,
        )

        cls.other_work_item = WorkItem.objects.create(
            project=cls.other_project,
            type_definition=cls.other_task_type,
            status_definition=cls.other_todo_status,
            title="Other Task",
            created_by=cls.other_actor,
        )

        cls.meeting = Meeting.objects.create(
            research_group=cls.group,
            title="Audit Meeting",
            scheduled_at=timezone.now() + timedelta(days=1),
            created_by=cls.actor,
        )
        cls.project_meeting = Meeting.objects.create(
            research_group=cls.group,
            scope="project",
            project=cls.project,
            title="Audit Project Meeting",
            scheduled_at=timezone.now() + timedelta(days=2),
            created_by=cls.actor,
        )
        cls.other_meeting = Meeting.objects.create(
            research_group=cls.other_group,
            title="Other Audit Meeting",
            scheduled_at=timezone.now() + timedelta(days=3),
            created_by=cls.other_actor,
        )

    def test_event_can_capture_domain_context(self):
        event = record_audit_event(
            research_group=self.group,
            actor=self.actor,
            event_type=(
                "work_item.assignment_transferred"
            ),
            subject_user=self.subject,
            project=self.project,
            work_item=self.work_item,
            data={
                "fromUserId":
                    self.subject.pk,
                "toUserId":
                    self.actor.pk,
            },
        )

        self.assertEqual(
            event.research_group,
            self.group,
        )

        self.assertEqual(
            event.actor,
            self.actor,
        )

        self.assertEqual(
            event.subject_user,
            self.subject,
        )

        self.assertEqual(
            event.project,
            self.project,
        )

        self.assertEqual(
            event.work_item,
            self.work_item,
        )

        self.assertEqual(
            event.data["fromUserId"],
            self.subject.pk,
        )

    def test_event_type_is_required(self):
        with self.assertRaises(
            AuditHistoryError,
        ):
            record_audit_event(
                research_group=self.group,
                actor=self.actor,
                event_type="  ",
            )

    def test_event_data_must_be_object(self):
        with self.assertRaises(
            AuditHistoryError,
        ):
            record_audit_event(
                research_group=self.group,
                actor=self.actor,
                event_type="example",
                data=["invalid"],
            )

    def test_project_must_match_group(self):
        with self.assertRaises(
            AuditHistoryError,
        ):
            record_audit_event(
                research_group=self.group,
                actor=self.actor,
                event_type="example",
                project=self.other_project,
            )

    def test_work_item_must_match_group(self):
        with self.assertRaises(
            AuditHistoryError,
        ):
            record_audit_event(
                research_group=self.group,
                actor=self.actor,
                event_type="example",
                work_item=self.other_work_item,
            )

    def test_work_item_must_match_referenced_project(
        self,
    ):
        with self.assertRaises(
            AuditHistoryError,
        ):
            record_audit_event(
                research_group=self.group,
                actor=self.actor,
                event_type="example",
                project=self.project,
                work_item=self.other_work_item,
            )

    def test_meeting_must_match_group(self):
        with self.assertRaises(
            AuditHistoryError,
        ):
            record_audit_event(
                research_group=self.group,
                actor=self.actor,
                event_type="example",
                meeting=self.other_meeting,
            )

    def test_meeting_must_match_referenced_project(
        self,
    ):
        with self.assertRaises(
            AuditHistoryError,
        ):
            record_audit_event(
                research_group=self.group,
                actor=self.actor,
                event_type="example",
                project=self.project,
                meeting=self.meeting,
            )

    def test_meeting_event_carries_scope(self):
        event = record_audit_event(
            research_group=self.group,
            actor=self.actor,
            event_type="example",
            project=self.project,
            meeting=self.project_meeting,
        )
        self.assertEqual(event.meeting_id, self.project_meeting.pk)
        self.assertEqual(event.project_id, self.project.pk)
        self.assertEqual(
            event.research_group_id, self.group.pk,
        )

    def test_project_deletion_preserves_event(self):
        event = record_audit_event(
            research_group=self.group,
            actor=self.actor,
            event_type="project.deleted",
            project=self.project,
            work_item=self.work_item,
            data={
                "projectId":
                    self.project.pk,
                "projectName":
                    self.project.name,
            },
        )

        # The project-scoped Meeting references the project with
        # RESTRICT: remove the fixture Meeting first (a Project with
        # live Meetings is not deletable in the domain either).
        self.project_meeting.delete()

        self.project.delete()

        event.refresh_from_db()

        self.assertIsNone(
            event.project_id,
        )

        self.assertIsNone(
            event.work_item_id,
        )

        self.assertEqual(
            event.data["projectName"],
            "Audit Project",
        )

    def test_meeting_deletion_preserves_event(self):
        event = record_audit_event(
            research_group=self.group,
            actor=self.actor,
            event_type="meeting.completed",
            meeting=self.meeting,
            data={
                "changes": {
                    "endedAt": "2026-01-01T00:00:00+00:00",
                }
            },
        )

        self.meeting.delete()

        event.refresh_from_db()

        self.assertIsNone(event.meeting_id)
        # The event stays durable with its structured data intact.
        self.assertEqual(event.event_type, "meeting.completed")
        self.assertEqual(
            event.data["changes"]["endedAt"],
            "2026-01-01T00:00:00+00:00",
        )
        self.assertEqual(event.actor_id, self.actor.pk)

    def test_subject_user_is_protected_from_hard_delete(
        self,
    ):
        event = record_audit_event(
            research_group=self.group,
            actor=self.actor,
            event_type="example",
            subject_user=self.subject,
        )

        self.assertIsNotNone(event.pk)

        with self.assertRaises(
            RestrictedError,
        ):
            self.subject.delete()

    def test_admin_is_read_only(self):
        model_admin = (
            admin.site
            ._registry[AuditEvent]
        )

        self.assertFalse(
            model_admin.has_add_permission(
                request=None,
            )
        )

        self.assertFalse(
            model_admin.has_change_permission(
                request=None,
            )
        )

        self.assertFalse(
            model_admin.has_delete_permission(
                request=None,
            )
        )
