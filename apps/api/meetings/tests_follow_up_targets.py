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
from research_groups.models import ResearchGroup, ResearchGroupMembership

from .models import Meeting, MeetingItem, MeetingItemFollowUp, MeetingSection
from .services import (
    create_meeting,
    create_meeting_from_series,
    create_meeting_item,
    create_meeting_series,
    create_series_section,
)


User = get_user_model()


class MeetingItemFollowUpTargetsApiTest(TestCase):
    def setUp(self):
        self.actor = User.objects.create_user(
            username="follow-up-targets-actor",
            password="Pass1!",
        )
        self.viewer = User.objects.create_user(
            username="follow-up-targets-viewer",
            password="Pass1!",
        )
        self.outsider = User.objects.create_user(
            username="follow-up-targets-outsider",
            password="Pass1!",
        )
        self.group = ResearchGroup.objects.create(
            name="Follow-up targets group",
            created_by=self.actor,
        )
        for user in (self.actor, self.viewer):
            ResearchGroupMembership.objects.create(
                research_group=self.group,
                user=user,
                role=ResearchGroupMembership.Role.MEMBER,
            )
        self.series = create_meeting_series(
            research_group=self.group,
            actor=self.actor,
            title="Weekly",
        )
        self.series_section = create_series_section(
            meeting_series=self.series,
            actor=self.actor,
            name="For your Info",
        )
        self.source_meeting = self._series_meeting(days=0)
        self.source_section = self.source_meeting.meeting_sections.get()
        self.source_item = create_meeting_item(
            meeting=self.source_meeting,
            meeting_section=self.source_section,
            actor=self.actor,
            title="Continue experiment",
        )
        self.client = APIClient()
        self.client.force_login(self.actor)

    def _url(self, item=None):
        return (
            f"/api/meeting-items/{(item or self.source_item).pk}"
            "/follow-up-targets/"
        )

    def _series_meeting(self, *, days):
        return create_meeting_from_series(
            meeting_series=self.series,
            actor=self.actor,
            scheduled_at=timezone.now() + timedelta(days=days),
        )

    def _standalone_meeting(
        self,
        title,
        *,
        days,
        group=None,
        actor=None,
        scope=Meeting.Scope.GROUP,
        project=None,
    ):
        return create_meeting(
            research_group=group or self.group,
            actor=actor or self.actor,
            title=title,
            scheduled_at=timezone.now() + timedelta(days=days),
            scope=scope,
            project=project,
        )

    def test_returns_only_upcoming_candidates_in_chronological_order(self):
        later_same_series = self._series_meeting(days=23)
        earlier_same_series = self._series_meeting(days=16)
        unrelated = self._standalone_meeting("Earlier unrelated", days=7)
        live = self._standalone_meeting("Live", days=2)
        live.status = Meeting.Status.LIVE
        live.save(update_fields=["status", "updated_at"])
        completed = self._standalone_meeting("Completed", days=3)
        completed.status = Meeting.Status.COMPLETED
        completed.save(update_fields=["status", "updated_at"])
        no_visible_section = self._standalone_meeting(
            "No visible section",
            days=4,
        )
        no_visible_section.meeting_sections.update(is_visible=False)
        before = {
            "meetings": Meeting.objects.count(),
            "sections": MeetingSection.objects.count(),
            "items": MeetingItem.objects.count(),
            "follow_ups": MeetingItemFollowUp.objects.count(),
        }

        response = self.client.get(self._url())

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        self.assertEqual(
            [meeting["id"] for meeting in data["meetings"]],
            [unrelated.pk, earlier_same_series.pk, later_same_series.pk],
        )
        self.assertEqual(data["recommendedMeetingId"], earlier_same_series.pk)
        self.assertNotIn(
            self.source_meeting.pk,
            [meeting["id"] for meeting in data["meetings"]],
        )
        self.assertEqual(
            set(data["meetings"][0]),
            {
                "id",
                "title",
                "scheduledAt",
                "seriesId",
                "recommendedSectionId",
                "sections",
            },
        )
        self.assertEqual(
            before,
            {
                "meetings": Meeting.objects.count(),
                "sections": MeetingSection.objects.count(),
                "items": MeetingItem.objects.count(),
                "follow_ups": MeetingItemFollowUp.objects.count(),
            },
        )
        self.source_item.refresh_from_db()
        self.assertEqual(
            self.source_item.outcome,
            MeetingItem.Outcome.NOT_DISCUSSED,
        )

    def test_filters_inaccessible_unwritable_and_archived_project_targets(self):
        writable_project = create_project(
            research_group=self.group,
            creator=self.actor,
            name="Writable",
        )
        add_project_membership(
            project=writable_project,
            actor=self.actor,
            target_user=self.viewer,
            role=ProjectMembership.Role.MEMBER,
        )
        read_only_project = create_project(
            research_group=self.group,
            creator=self.actor,
            name="Read only",
        )
        add_project_membership(
            project=read_only_project,
            actor=self.actor,
            target_user=self.viewer,
            role=ProjectMembership.Role.VIEWER,
        )
        archived_project = create_project(
            research_group=self.group,
            creator=self.actor,
            name="Archived",
        )
        add_project_membership(
            project=archived_project,
            actor=self.actor,
            target_user=self.viewer,
            role=ProjectMembership.Role.MEMBER,
        )
        archive_project(project=archived_project, actor=self.actor)
        writable = self._standalone_meeting(
            "Writable",
            days=4,
            scope=Meeting.Scope.PROJECT,
            project=writable_project,
        )
        self._standalone_meeting(
            "Read only",
            days=5,
            scope=Meeting.Scope.PROJECT,
            project=read_only_project,
        )
        self._standalone_meeting(
            "Archived",
            days=6,
            scope=Meeting.Scope.PROJECT,
            project=archived_project,
        )
        other_group = ResearchGroup.objects.create(
            name="Private group",
            created_by=self.outsider,
        )
        ResearchGroupMembership.objects.create(
            research_group=other_group,
            user=self.outsider,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        self._standalone_meeting(
            "Inaccessible",
            days=3,
            group=other_group,
            actor=self.outsider,
        )
        self.client.force_login(self.viewer)

        response = self.client.get(self._url())

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            [meeting["id"] for meeting in response.json()["meetings"]],
            [writable.pk],
        )

    def test_structural_section_match_wins_and_only_visible_sections_return(self):
        target = self._series_meeting(days=7)
        structural = target.meeting_sections.get()
        same_name = MeetingSection.objects.create(
            meeting=target,
            name=self.source_section.name,
            position=1,
            is_visible=True,
        )
        hidden = MeetingSection.objects.create(
            meeting=target,
            name="Hidden",
            position=2,
            is_visible=False,
        )
        other_target = self._standalone_meeting("Other target", days=8)
        other_section = other_target.meeting_sections.get()

        response = self.client.get(self._url())

        candidate = response.json()["meetings"][0]
        self.assertEqual(candidate["recommendedSectionId"], structural.pk)
        self.assertEqual(
            [section["id"] for section in candidate["sections"]],
            [structural.pk, same_name.pk],
        )
        self.assertNotIn(
            hidden.pk,
            [section["id"] for section in candidate["sections"]],
        )
        self.assertNotIn(
            other_section.pk,
            [section["id"] for section in candidate["sections"]],
        )

    def test_unique_name_fallback_recommends_occurrence_section(self):
        target = self._standalone_meeting("Standalone", days=7)
        section = target.meeting_sections.get()
        section.name = self.source_section.name
        section.save(update_fields=["name"])

        response = self.client.get(self._url())

        candidate = response.json()["meetings"][0]
        self.assertEqual(candidate["recommendedSectionId"], section.pk)
        self.assertEqual(candidate["sections"][0]["id"], section.pk)
        self.assertIsNone(candidate["sections"][0]["sourceSeriesSectionId"])

    def test_ambiguous_or_missing_section_match_has_no_recommendation(self):
        ambiguous = self._standalone_meeting("Ambiguous", days=7)
        first = ambiguous.meeting_sections.get()
        first.name = self.source_section.name
        first.save(update_fields=["name"])
        MeetingSection.objects.create(
            meeting=ambiguous,
            name=self.source_section.name,
            position=1,
            is_visible=True,
        )
        missing = self._standalone_meeting("Missing", days=8)

        response = self.client.get(self._url())

        candidates = {
            meeting["id"]: meeting
            for meeting in response.json()["meetings"]
        }
        self.assertIsNone(candidates[ambiguous.pk]["recommendedSectionId"])
        self.assertIsNone(candidates[missing.pk]["recommendedSectionId"])

    def test_no_same_series_candidate_and_inaccessible_source(self):
        unrelated = self._standalone_meeting("Unrelated", days=7)

        response = self.client.get(self._url())

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertIsNone(response.json()["recommendedMeetingId"])
        self.assertEqual(response.json()["meetings"][0]["id"], unrelated.pk)

        self.client.force_login(self.outsider)
        inaccessible = self.client.get(self._url())
        self.assertEqual(inaccessible.status_code, status.HTTP_404_NOT_FOUND)

    def test_equal_datetimes_use_id_as_stable_secondary_order(self):
        first = self._standalone_meeting("First", days=7)
        second = self._standalone_meeting("Second", days=8)
        second.scheduled_at = first.scheduled_at
        second.save(update_fields=["scheduled_at", "updated_at"])

        response = self.client.get(self._url())

        self.assertEqual(
            [meeting["id"] for meeting in response.json()["meetings"]],
            [first.pk, second.pk],
        )

    def test_read_only_source_returns_forbidden_without_candidates(self):
        project = create_project(
            research_group=self.group,
            creator=self.actor,
            name="Read-only source",
        )
        add_project_membership(
            project=project,
            actor=self.actor,
            target_user=self.viewer,
            role=ProjectMembership.Role.VIEWER,
        )
        source = self._standalone_meeting(
            "Project source",
            days=0,
            scope=Meeting.Scope.PROJECT,
            project=project,
        )
        source_item = create_meeting_item(
            meeting=source,
            meeting_section=source.meeting_sections.get(),
            actor=self.actor,
            title="Read-only follow-up",
        )
        self._standalone_meeting("Writable target", days=7)
        self.client.force_login(self.viewer)

        response = self.client.get(self._url(source_item))

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
