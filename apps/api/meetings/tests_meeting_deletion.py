from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from rest_framework import status
from rest_framework.test import APIClient

from projects.models import ProjectMembership
from projects.services import (
    add_project_membership,
    archive_project,
    create_project,
)
from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)
from work_items.models import WorkItem

from .models import (
    Meeting,
    MeetingItem,
    MeetingItemWorkItem,
    MeetingParticipant,
    MeetingSection,
    MeetingSeries,
    MeetingSeriesSection,
)
from .services import (
    create_meeting,
    create_meeting_from_series,
    create_meeting_item,
    create_series_section,
    create_work_item_from_meeting_item,
)


User = get_user_model()


class MeetingDeletionBase(TestCase):
    def setUp(self):
        self.client = APIClient()

        self.alex = User.objects.create_user(
            username="meeting-del-alex",
            password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="meeting-del-chris",
            password="Pass1!",
        )
        self.laura = User.objects.create_user(
            username="meeting-del-laura",
            password="Pass1!",
        )
        self.maria = User.objects.create_user(
            username="meeting-del-maria",
            password="Pass1!",
        )

        self.group = ResearchGroup.objects.create(
            name="Meeting Deletion Group",
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

        self.scheduled_at = (
            timezone.now().replace(microsecond=0)
            + timedelta(days=1)
        )

    def login(self, user):
        self.client.logout()
        self.client.force_login(user)

    def create_group_meeting(self, **kwargs):
        return create_meeting(
            research_group=self.group,
            actor=self.alex,
            title=kwargs.pop("title", "FG Weekly"),
            scheduled_at=self.scheduled_at,
            **kwargs,
        )

    def create_project_meeting(self, **kwargs):
        return create_meeting(
            research_group=self.group,
            actor=self.alex,
            title=kwargs.pop("title", "Project Weekly"),
            scheduled_at=self.scheduled_at,
            scope=Meeting.Scope.PROJECT,
            project=self.project,
            **kwargs,
        )

    def delete(self, meeting):
        return self.client.delete(f"/api/meetings/{meeting.pk}/")


class MeetingDeletionApiTest(MeetingDeletionBase):
    def test_admin_can_delete_group_meeting(self):
        meeting = self.create_group_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        item = create_meeting_item(
            meeting=meeting,
            meeting_section=section,
            actor=self.alex,
            title="Agenda entry",
        )

        self.login(self.alex)

        response = self.delete(meeting)

        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Meeting.objects.filter(pk=meeting.pk).exists())
        self.assertFalse(
            MeetingSection.objects.filter(pk=section.pk).exists()
        )
        self.assertFalse(
            MeetingItem.objects.filter(pk=item.pk).exists()
        )
        self.assertFalse(
            MeetingParticipant.objects.filter(meeting=meeting.pk)
            .exists()
        )

    def test_deletion_is_not_retrievable_or_listed(self):
        meeting = self.create_group_meeting()

        self.login(self.alex)
        self.assertEqual(self.delete(meeting).status_code,
                         status.HTTP_204_NO_CONTENT)

        response = self.client.get(f"/api/meetings/{meeting.pk}/")
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

        listing = self.client.get(
            f"/api/research-groups/{self.group.pk}/meetings/"
        )
        self.assertEqual(
            [entry["id"] for entry in listing.json()],
            [],
        )

    def test_group_member_can_delete_group_meeting(self):
        meeting = self.create_group_meeting()

        self.login(self.chris)

        self.assertEqual(
            self.delete(meeting).status_code,
            status.HTTP_204_NO_CONTENT,
        )
        self.assertFalse(Meeting.objects.filter(pk=meeting.pk).exists())

    def test_non_member_cannot_delete_group_meeting(self):
        meeting = self.create_group_meeting()

        self.login(self.maria)

        self.assertEqual(
            self.delete(meeting).status_code,
            status.HTTP_404_NOT_FOUND,
        )
        self.assertTrue(Meeting.objects.filter(pk=meeting.pk).exists())

    def test_viewer_cannot_delete_project_meeting(self):
        meeting = self.create_project_meeting()

        self.login(self.laura)

        self.assertEqual(
            self.delete(meeting).status_code,
            status.HTTP_403_FORBIDDEN,
        )
        self.assertTrue(Meeting.objects.filter(pk=meeting.pk).exists())

    def test_member_can_delete_project_meeting(self):
        meeting = self.create_project_meeting()

        self.login(self.chris)

        self.assertEqual(
            self.delete(meeting).status_code,
            status.HTTP_204_NO_CONTENT,
        )
        self.assertFalse(Meeting.objects.filter(pk=meeting.pk).exists())

    def test_cannot_delete_archived_project_meeting(self):
        meeting = self.create_project_meeting()
        archive_project(project=self.project, actor=self.alex)

        self.login(self.alex)

        self.assertEqual(
            self.delete(meeting).status_code,
            status.HTTP_403_FORBIDDEN,
        )
        self.assertTrue(Meeting.objects.filter(pk=meeting.pk).exists())

    def test_delete_unknown_meeting_is_404(self):
        self.login(self.alex)

        response = self.client.delete("/api/meetings/999999/")

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)


class MeetingDeletionLifecycleTest(MeetingDeletionBase):
    def _run_to_status(self, meeting, target):
        if target in ("live", "completed"):
            self.client.post(
                f"/api/meetings/{meeting.pk}/start", {}, format="json"
            )
        if target == "completed":
            self.client.post(
                f"/api/meetings/{meeting.pk}/end", {}, format="json"
            )

    def test_deletion_works_in_every_lifecycle_state(self):
        for target in ("upcoming", "live", "completed"):
            meeting = self.create_group_meeting(
                title=f"Lifecycle {target}",
            )
            self.login(self.alex)
            self._run_to_status(meeting, target)

            response = self.delete(meeting)

            self.assertEqual(
                response.status_code,
                status.HTTP_204_NO_CONTENT,
                msg=f"deletion failed for {target}",
            )
            self.assertFalse(
                Meeting.objects.filter(pk=meeting.pk).exists()
            )


class MeetingDeletionOwnershipTest(MeetingDeletionBase):
    def test_deleting_meeting_keeps_canonical_work_item(self):
        meeting = self.create_project_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        item = create_meeting_item(
            meeting=meeting,
            meeting_section=section,
            actor=self.alex,
            title="Follow up",
        )
        work_item = create_work_item_from_meeting_item(
            meeting_item=item,
            project=self.project,
            actor=self.alex,
            type_definition_id=self.project.type_definitions.get(
                name="Task"
            ).pk,
            title="Canonical follow-up",
        )

        self.login(self.alex)

        self.assertEqual(
            self.delete(meeting).status_code,
            status.HTTP_204_NO_CONTENT,
        )

        self.assertTrue(
            WorkItem.objects.filter(pk=work_item.pk).exists()
        )
        self.assertEqual(
            WorkItem.objects.get(pk=work_item.pk).project,
            self.project,
        )
        self.assertFalse(
            MeetingItemWorkItem.objects.filter(
                work_item=work_item,
            ).exists()
        )

    def test_deleting_occurrence_keeps_template_and_siblings(self):
        series = MeetingSeries.objects.create(
            research_group=self.group,
            title="Deletion Weekly",
            created_by=self.alex,
        )
        series_section = create_series_section(
            meeting_series=series,
            actor=self.alex,
            name="Check-In",
        )

        first = create_meeting_from_series(
            meeting_series=series,
            actor=self.alex,
            title="First occurrence",
            scheduled_at=self.scheduled_at,
        )
        sibling = create_meeting_from_series(
            meeting_series=series,
            actor=self.alex,
            title="Sibling occurrence",
            scheduled_at=self.scheduled_at + timedelta(days=7),
        )
        create_meeting_item(
            meeting=first,
            meeting_section=MeetingSection.objects.filter(
                meeting=first,
            ).first(),
            actor=self.alex,
            title="First item",
        )

        self.login(self.alex)

        self.assertEqual(
            self.delete(first).status_code,
            status.HTTP_204_NO_CONTENT,
        )

        series.refresh_from_db()
        self.assertTrue(MeetingSeries.objects.filter(pk=series.pk).exists())
        self.assertFalse(series.is_archived)
        self.assertEqual(
            MeetingSeriesSection.objects.filter(
                meeting_series=series,
            ).count(),
            1,
        )
        self.assertEqual(
            MeetingSeriesSection.objects.get(
                meeting_series=series,
            ).name,
            series_section.name,
        )

        self.assertTrue(
            Meeting.objects.filter(pk=sibling.pk).exists()
        )
        self.assertEqual(
            Meeting.objects.filter(
                title="Sibling occurrence",
            ).count(),
            1,
        )
