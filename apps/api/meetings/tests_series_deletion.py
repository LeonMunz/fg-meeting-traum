"""Tests for MeetingSeries (Meeting Template) deletion.

Deletion reuses the existing scoped Template write rule
(MEETING_SERIES_WRITE via the authorization kernel). Existing Meeting
occurrences are independent snapshots and survive deletion with their
provenance pointers cleared.
"""

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

from .models import (
    Meeting,
    MeetingItem,
    MeetingParticipant,
    MeetingSection,
    MeetingSeries,
    MeetingSeriesSection,
)
from .services import (
    MeetingDomainError,
    create_meeting_from_series,
    create_meeting_item,
    create_meeting_series,
    create_series_section,
    delete_meeting_series,
)


User = get_user_model()


class SeriesDeletionBase(TestCase):
    def setUp(self):
        self.client = APIClient()

        self.alex = User.objects.create_user(
            username="series-del-alex",
            password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="series-del-chris",
            password="Pass1!",
        )
        self.laura = User.objects.create_user(
            username="series-del-laura",
            password="Pass1!",
        )
        self.maria = User.objects.create_user(
            username="series-del-maria",
            password="Pass1!",
        )

        self.group = ResearchGroup.objects.create(
            name="Series Deletion Group",
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

    def create_group_series(self, **kwargs):
        return create_meeting_series(
            research_group=self.group,
            actor=self.alex,
            title=kwargs.pop("title", "FG Weekly"),
            **kwargs,
        )

    def create_project_series(self, **kwargs):
        return create_meeting_series(
            research_group=self.group,
            actor=self.alex,
            title=kwargs.pop("title", "Project Weekly"),
            scope=MeetingSeries.Scope.PROJECT,
            project=self.project,
            **kwargs,
        )

    def delete(self, series):
        return self.client.delete(f"/api/meeting-series/{series.pk}/")


class SeriesDeletionDomainTest(SeriesDeletionBase):
    def test_admin_can_delete_group_series(self):
        series = self.create_group_series()
        create_series_section(
            meeting_series=series,
            actor=self.alex,
            name="Agenda",
        )

        delete_meeting_series(
            meeting_series=series,
            actor=self.alex,
        )

        self.assertFalse(
            MeetingSeries.objects.filter(pk=series.pk).exists()
        )
        self.assertFalse(
            MeetingSeriesSection.objects.filter(
                meeting_series=series.pk
            ).exists()
        )

    def test_group_member_can_delete_group_series(self):
        series = self.create_group_series()

        delete_meeting_series(
            meeting_series=series,
            actor=self.chris,
        )

        self.assertFalse(
            MeetingSeries.objects.filter(pk=series.pk).exists()
        )

    def test_non_member_cannot_delete_group_series(self):
        series = self.create_group_series()

        with self.assertRaises(MeetingDomainError):
            delete_meeting_series(
                meeting_series=series,
                actor=self.maria,
            )

        self.assertTrue(
            MeetingSeries.objects.filter(pk=series.pk).exists()
        )

    def test_project_member_can_delete_project_series(self):
        series = self.create_project_series()

        delete_meeting_series(
            meeting_series=series,
            actor=self.chris,
        )

        self.assertFalse(
            MeetingSeries.objects.filter(pk=series.pk).exists()
        )

    def test_viewer_cannot_delete_project_series(self):
        series = self.create_project_series()

        with self.assertRaises(MeetingDomainError):
            delete_meeting_series(
                meeting_series=series,
                actor=self.laura,
            )

        self.assertTrue(
            MeetingSeries.objects.filter(pk=series.pk).exists()
        )

    def test_cannot_delete_series_of_archived_project(self):
        series = self.create_project_series()
        archive_project(project=self.project, actor=self.alex)

        with self.assertRaises(MeetingDomainError):
            delete_meeting_series(
                meeting_series=series,
                actor=self.alex,
            )

        self.assertTrue(
            MeetingSeries.objects.filter(pk=series.pk).exists()
        )


class SeriesDeletionApiTest(SeriesDeletionBase):
    def test_admin_can_delete_group_series(self):
        series = self.create_group_series()
        section = create_series_section(
            meeting_series=series,
            actor=self.alex,
            name="Agenda",
        )

        self.login(self.alex)

        response = self.delete(series)

        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(
            MeetingSeries.objects.filter(pk=series.pk).exists()
        )
        self.assertFalse(
            MeetingSeriesSection.objects.filter(pk=section.pk).exists()
        )

    def test_deletion_is_not_retrievable_or_listed(self):
        series = self.create_group_series()

        self.login(self.alex)
        self.assertEqual(
            self.delete(series).status_code,
            status.HTTP_204_NO_CONTENT,
        )

        response = self.client.get(f"/api/meeting-series/{series.pk}/")
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

        listing = self.client.get(
            f"/api/research-groups/{self.group.pk}/meeting-series/"
        )
        self.assertEqual(
            [entry["id"] for entry in listing.json()],
            [],
        )

    def test_group_member_can_delete_group_series(self):
        series = self.create_group_series()

        self.login(self.chris)

        self.assertEqual(
            self.delete(series).status_code,
            status.HTTP_204_NO_CONTENT,
        )
        self.assertFalse(
            MeetingSeries.objects.filter(pk=series.pk).exists()
        )

    def test_non_member_cannot_delete_group_series(self):
        series = self.create_group_series()

        self.login(self.maria)

        self.assertEqual(
            self.delete(series).status_code,
            status.HTTP_404_NOT_FOUND,
        )
        self.assertTrue(
            MeetingSeries.objects.filter(pk=series.pk).exists()
        )

    def test_viewer_cannot_delete_project_series(self):
        series = self.create_project_series()

        self.login(self.laura)

        self.assertEqual(
            self.delete(series).status_code,
            status.HTTP_403_FORBIDDEN,
        )
        self.assertTrue(
            MeetingSeries.objects.filter(pk=series.pk).exists()
        )

    def test_member_can_delete_project_series(self):
        series = self.create_project_series()

        self.login(self.chris)

        self.assertEqual(
            self.delete(series).status_code,
            status.HTTP_204_NO_CONTENT,
        )
        self.assertFalse(
            MeetingSeries.objects.filter(pk=series.pk).exists()
        )

    def test_cannot_delete_series_of_archived_project(self):
        series = self.create_project_series()
        archive_project(project=self.project, actor=self.alex)

        self.login(self.alex)

        self.assertEqual(
            self.delete(series).status_code,
            status.HTTP_403_FORBIDDEN,
        )
        self.assertTrue(
            MeetingSeries.objects.filter(pk=series.pk).exists()
        )

    def test_delete_unknown_series_is_404(self):
        self.login(self.alex)

        response = self.client.delete("/api/meeting-series/999999/")

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)


class SeriesDeletionOccurrencesTest(SeriesDeletionBase):
    """Deleting a Template never deletes existing occurrences."""

    def _create_occurrence(self, series):
        section = create_series_section(
            meeting_series=series,
            actor=self.alex,
            name="Agenda",
            description="Default agenda.",
        )
        meeting = create_meeting_from_series(
            meeting_series=series,
            actor=self.alex,
            scheduled_at=self.scheduled_at,
        )
        item = create_meeting_item(
            meeting=meeting,
            meeting_section=meeting.meeting_sections.first(),
            actor=self.alex,
            title="Agenda entry",
        )
        return section, meeting, item

    def test_deleting_series_keeps_occurrence_and_snapshots(self):
        series = self.create_group_series()
        section, meeting, item = self._create_occurrence(series)

        self.login(self.alex)
        self.assertEqual(
            self.delete(series).status_code,
            status.HTTP_204_NO_CONTENT,
        )

        meeting.refresh_from_db()
        self.assertTrue(Meeting.objects.filter(pk=meeting.pk).exists())
        # The provenance reference is cleared; the occurrence remains.
        self.assertIsNone(meeting.series_id)
        self.assertEqual(meeting.title, series.title)

        snapshot = meeting.meeting_sections.first()
        self.assertIsNotNone(snapshot)
        self.assertEqual(snapshot.name, "Agenda")
        self.assertEqual(snapshot.description, "Default agenda.")
        # The snapshot's source pointer is cleared; content is kept.
        self.assertIsNone(snapshot.source_series_section_id)

        self.assertTrue(
            MeetingItem.objects.filter(pk=item.pk).exists()
        )
        self.assertTrue(
            MeetingParticipant.objects.filter(
                meeting=meeting.pk,
                user=self.alex,
            ).exists()
        )

    def test_deleting_series_keeps_sibling_templates(self):
        series = self.create_group_series(title="To Delete")
        sibling = self.create_group_series(title="To Keep")
        create_series_section(
            meeting_series=sibling,
            actor=self.alex,
            name="Kept Section",
        )

        self.login(self.alex)
        self.assertEqual(
            self.delete(series).status_code,
            status.HTTP_204_NO_CONTENT,
        )

        self.assertTrue(
            MeetingSeries.objects.filter(pk=sibling.pk).exists()
        )
        self.assertEqual(
            MeetingSeriesSection.objects.filter(
                meeting_series=sibling.pk
            ).count(),
            1,
        )

    def test_new_occurrence_after_deletion_uses_no_template(self):
        """The list no longer offers the deleted template."""
        series = self.create_group_series()

        self.login(self.alex)
        self.assertEqual(
            self.delete(series).status_code,
            status.HTTP_204_NO_CONTENT,
        )

        listing = self.client.get(
            f"/api/research-groups/{self.group.pk}/meeting-series/"
        )
        self.assertEqual(listing.json(), [])
