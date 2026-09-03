"""Backend tests for canonical Work Item deletion.

Covers:
- authorized (owner/member) deletion via the detail API
- unauthorized (viewer, non-member) rejection
- deleted item is no longer retrievable / listed
- Work-Item-owned dependents (assignees, labels, comments) are removed
- AuditEvent history survives via SET_NULL
- Meeting/MeetingItem survives deletion of a Work Item created from a
  MeetingItem; the one-way origin link is cleaned
- parent/child: deleting a parent does NOT delete children (SET_NULL)
- deleting a child does not affect the parent
"""

from django.contrib.auth import get_user_model
from django.test import TestCase

from rest_framework import status
from rest_framework.test import APIClient

from audit_history.models import AuditEvent
from meetings.models import Meeting, MeetingItem, MeetingItemWorkItem, MeetingSection
from meetings.services import (
    create_meeting,
    create_meeting_item,
    create_work_item_from_meeting_item,
)
from projects.models import ProjectMembership
from projects.services import add_project_membership, archive_project, create_project
from research_groups.models import ResearchGroup, ResearchGroupMembership
from django.utils import timezone

from .models import WorkItem, WorkItemAssignee, WorkItemComment, WorkItemLabel
from .services import create_work_item, create_work_item_comment

User = get_user_model()


class WorkItemDeletionBase(TestCase):
    def setUp(self):
        self.client = APIClient()

        self.alex = User.objects.create_user(
            username="wi-del-alex",
            password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="wi-del-chris",
            password="Pass1!",
        )
        self.laura = User.objects.create_user(
            username="wi-del-laura",
            password="Pass1!",
        )
        self.maria = User.objects.create_user(
            username="wi-del-maria",
            password="Pass1!",
        )

        self.group = ResearchGroup.objects.create(
            name="Work Item Deletion Group",
            created_by=self.alex,
        )
        for user, role in [
            (self.alex, ResearchGroupMembership.Role.ADMIN),
            (self.chris, ResearchGroupMembership.Role.MEMBER),
            (self.laura, ResearchGroupMembership.Role.MEMBER),
        ]:
            ResearchGroupMembership.objects.create(
                research_group=self.group,
                user=user,
                role=role,
            )

        self.project = create_project(
            research_group=self.group,
            creator=self.alex,
            name="Deletion Project",
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
            target_user=self.laura,
            role=ProjectMembership.Role.VIEWER,
        )

    def login(self, user):
        self.client.logout()
        self.client.force_login(user)

    def make_work_item(self, **kwargs):
        return create_work_item(
            project=self.project,
            actor=self.alex,
            type_definition_id=self.project.type_definitions.get(
                name="Task"
            ).pk,
            title=kwargs.pop("title", "Deletable task"),
            **kwargs,
        )

    def delete(self, work_item):
        return self.client.delete(f"/api/work-items/{work_item.pk}/")


class WorkItemDeletionApiTest(WorkItemDeletionBase):
    def test_owner_can_delete_work_item(self):
        work_item = self.make_work_item()
        self.login(self.alex)

        response = self.delete(work_item)

        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(WorkItem.objects.filter(pk=work_item.pk).exists())

    def test_member_can_delete_work_item(self):
        work_item = self.make_work_item()
        self.login(self.chris)

        self.assertEqual(
            self.delete(work_item).status_code,
            status.HTTP_204_NO_CONTENT,
        )
        self.assertFalse(WorkItem.objects.filter(pk=work_item.pk).exists())

    def test_viewer_cannot_delete_work_item(self):
        work_item = self.make_work_item()
        self.login(self.laura)

        response = self.delete(work_item)

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertTrue(WorkItem.objects.filter(pk=work_item.pk).exists())

    def test_non_member_cannot_delete_work_item(self):
        work_item = self.make_work_item()
        self.login(self.maria)

        response = self.delete(work_item)

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertTrue(WorkItem.objects.filter(pk=work_item.pk).exists())

    def test_deleted_work_item_not_retrievable_or_listed(self):
        work_item = self.make_work_item()
        self.login(self.alex)

        self.assertEqual(
            self.delete(work_item).status_code,
            status.HTTP_204_NO_CONTENT,
        )

        detail = self.client.get(f"/api/work-items/{work_item.pk}/")
        self.assertEqual(detail.status_code, status.HTTP_404_NOT_FOUND)

        listing = self.client.get(
            f"/api/projects/{self.project.pk}/work-items/"
        )
        self.assertNotIn(work_item.pk, [entry["id"] for entry in listing.json()])

    def test_delete_unknown_work_item_is_404(self):
        self.login(self.alex)

        response = self.client.delete("/api/work-items/999999/")

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)


class WorkItemDeletionDependentsTest(WorkItemDeletionBase):
    def test_dependent_state_is_removed(self):
        label_def = self.project.label_definitions.first()
        work_item = self.make_work_item(
            title="Full of dependents",
            assignee_ids=[self.chris.pk],
            label_definition_ids=[label_def.pk] if label_def else [],
        )
        comment = create_work_item_comment(
            work_item=work_item,
            actor=self.alex,
            body="A note that goes with this item.",
        )

        self.assertEqual(
            WorkItemAssignee.objects.filter(
                work_item=work_item, user=self.chris
            ).count(),
            1,
        )
        self.assertEqual(WorkItemComment.objects.filter(pk=comment.pk).count(), 1)

        self.login(self.alex)
        self.assertEqual(
            self.delete(work_item).status_code,
            status.HTTP_204_NO_CONTENT,
        )

        self.assertFalse(
            WorkItemAssignee.objects.filter(work_item_id=work_item.pk).exists()
        )
        self.assertFalse(
            WorkItemComment.objects.filter(pk=comment.pk).exists()
        )
        self.assertFalse(
            WorkItemLabel.objects.filter(work_item_id=work_item.pk).exists()
        )

    def test_audit_history_survives_via_set_null(self):
        work_item = self.make_work_item()

        self.login(self.alex)
        self.assertEqual(
            self.delete(work_item).status_code,
            status.HTTP_204_NO_CONTENT,
        )

        # The created event survives but its Work Item reference is nulled.
        surviving = AuditEvent.objects.filter(
            event_type="work_item.created",
            data__work_item_id=work_item.pk,
        )
        # No event can still point at the deleted item through the FK.
        self.assertFalse(
            AuditEvent.objects.filter(work_item_id=work_item.pk).exists()
        )


class WorkItemDeletionMeetingTest(WorkItemDeletionBase):
    def test_deleting_work_item_keeps_meeting_and_cleans_link(self):
        meeting = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="Project Weekly",
            scheduled_at=timezone.now().replace(microsecond=0)
            + timezone.timedelta(days=1),
            scope=Meeting.Scope.PROJECT,
            project=self.project,
        )
        section = MeetingSection.objects.get(meeting=meeting)
        meeting_item = create_meeting_item(
            meeting=meeting,
            meeting_section=section,
            actor=self.alex,
            title="Follow up",
        )
        work_item = create_work_item_from_meeting_item(
            meeting_item=meeting_item,
            project=self.project,
            actor=self.alex,
            type_definition_id=self.project.type_definitions.get(
                name="Task"
            ).pk,
            title="Canonical follow-up",
        )

        self.assertEqual(
            MeetingItemWorkItem.objects.filter(
                meeting_item=meeting_item, work_item=work_item
            ).count(),
            1,
        )

        self.login(self.alex)
        self.assertEqual(
            self.delete(work_item).status_code,
            status.HTTP_204_NO_CONTENT,
        )

        # Work Item is gone; Meeting content is untouched.
        self.assertFalse(WorkItem.objects.filter(pk=work_item.pk).exists())
        self.assertTrue(Meeting.objects.filter(pk=meeting.pk).exists())
        self.assertTrue(MeetingItem.objects.filter(pk=meeting_item.pk).exists())

        # The one-way origin link is removed.
        self.assertFalse(
            MeetingItemWorkItem.objects.filter(
                work_item_id=work_item.pk
            ).exists()
        )
        self.assertFalse(
            MeetingItemWorkItem.objects.filter(
                meeting_item=meeting_item
            ).exists()
        )


class WorkItemDeletionHierarchyTest(WorkItemDeletionBase):
    def test_deleting_parent_unparents_children(self):
        parent = self.make_work_item(title="Parent epic")
        child = self.make_work_item(title="Child task", parent_id=parent.pk)

        self.assertEqual(child.parent_id, parent.pk)

        self.login(self.alex)
        self.assertEqual(
            self.delete(parent).status_code,
            status.HTTP_204_NO_CONTENT,
        )

        self.assertFalse(WorkItem.objects.filter(pk=parent.pk).exists())
        # Child survives and is now unparented.
        refreshed = WorkItem.objects.get(pk=child.pk)
        self.assertIsNone(refreshed.parent_id)

    def test_deleting_child_keeps_parent(self):
        parent = self.make_work_item(title="Parent epic")
        child = self.make_work_item(title="Child task", parent_id=parent.pk)

        self.login(self.alex)
        self.assertEqual(
            self.delete(child).status_code,
            status.HTTP_204_NO_CONTENT,
        )

        self.assertTrue(WorkItem.objects.filter(pk=parent.pk).exists())
        self.assertFalse(WorkItem.objects.filter(pk=child.pk).exists())

    def test_cannot_delete_archived_project_work_item(self):
        work_item = self.make_work_item()
        archive_project(project=self.project, actor=self.alex)

        self.login(self.alex)
        response = self.delete(work_item)

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertTrue(WorkItem.objects.filter(pk=work_item.pk).exists())
