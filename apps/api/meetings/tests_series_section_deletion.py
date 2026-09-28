"""Tests for MeetingSeriesSection (Template Section) deletion.

Deletion reuses the existing scoped Template write rule
(MEETING_SERIES_WRITE via the authorization kernel), exactly like
every other Template Section edit. Deleting one Template Section
never deletes an existing Meeting occurrence, its Sections, Agenda
items, Notes, or Work Items: the snapshot's provenance pointer
(``MeetingSection.source_series_section``) is cleared (SET_NULL)
while all snapshot content is preserved. New one-time Meetings and
later materialized recurrence occurrences omit the deleted Section;
the Template itself (including the zero-Section state) and its
Recurrences survive.
"""

from datetime import (
    date,
    datetime,
    time,
    timedelta,
    timezone as dt_timezone,
)

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
    MeetingNote,
    MeetingParticipant,
    MeetingRecurrence,
    MeetingSection,
    MeetingSeries,
    MeetingSeriesSection,
)
from .services import (
    MeetingDomainError,
    add_meeting_participant,
    create_meeting_from_series,
    create_meeting_item,
    create_meeting_note,
    create_meeting_recurrence,
    create_meeting_series,
    start_meeting,
    create_series_section,
    delete_series_section,
    expand_meeting_recurrence_occurrences,
    materialize_meeting_recurrence_occurrence,
)


User = get_user_model()

UTC = dt_timezone.utc


def _utc(year, month, day, hour=0, minute=0):
    return datetime(year, month, day, hour, minute, tzinfo=UTC)


class SectionDeletionBase(TestCase):
    """Shared fixtures: group (alex admin, chris member, laura
    member), project (alex owner, chris member, laura viewer), and
    an outsider (maria)."""

    def setUp(self):
        self.client = APIClient()

        self.alex = User.objects.create_user(
            username="sec-del-alex", password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="sec-del-chris", password="Pass1!",
        )
        self.laura = User.objects.create_user(
            username="sec-del-laura", password="Pass1!",
        )
        self.maria = User.objects.create_user(
            username="sec-del-maria", password="Pass1!",
        )

        self.group = ResearchGroup.objects.create(
            name="Section Deletion Group", created_by=self.alex,
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
            name="Section Deletion Project",
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

    def _add_default_sections(self, series):
        self.check_in = create_series_section(
            meeting_series=series,
            actor=self.alex,
            name="Check-In",
            description="How is everyone doing?",
        )
        self.top = create_series_section(
            meeting_series=series,
            actor=self.alex,
            name="TOPs",
            description="Topic of the day.",
        )

    def create_group_series(self, title="FG Weekly"):
        series = create_meeting_series(
            research_group=self.group,
            actor=self.alex,
            title=title,
        )
        self._add_default_sections(series)
        return series

    def create_project_series(self, title="Project Weekly"):
        series = create_meeting_series(
            research_group=self.group,
            actor=self.alex,
            title=title,
            scope=MeetingSeries.Scope.PROJECT,
            project=self.project,
        )
        self._add_default_sections(series)
        return series

    def delete(self, section):
        return self.client.delete(
            f"/api/meeting-series-sections/{section.pk}/"
        )

    def _create_recurrence(self, series, title="Standups"):
        return create_meeting_recurrence(
            research_group=self.group,
            actor=self.alex,
            meeting_series=series,
            title=title,
            frequency="daily",
            interval=1,
            start_date=date(2026, 1, 5),
            local_time=time(9, 30),
            timezone_name="Europe/Berlin",
        )

    def _occurrence(self, recurrence, day):
        (occurrence,) = expand_meeting_recurrence_occurrences(
            meeting_recurrence=recurrence,
            range_start=_utc(2026, 1, day),
            range_end=_utc(2026, 1, day + 1),
        )
        return occurrence

    def _materialize(self, recurrence, occurrence, title):
        return materialize_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=occurrence,
            actor=self.alex,
            title=title,
        )

    def _populate_meeting(self, meeting):
        """Add one item + one note in the TOPs snapshot and one
        additional participant; returns (top_snapshot, item)."""
        top_snapshot = meeting.meeting_sections.get(name="TOPs")
        # Notes can only be authored in a Live Meeting.
        start_meeting(meeting=meeting, actor=self.alex)
        item = create_meeting_item(
            meeting=meeting,
            meeting_section=top_snapshot,
            actor=self.alex,
            title="Discuss funding",
        )
        create_meeting_note(
            meeting_item=item,
            actor=self.alex,
            content="Take the grant number.",
        )
        add_meeting_participant(
            meeting=meeting,
            actor=self.alex,
            target_user=self.chris,
        )
        return top_snapshot, item


class SectionDeletionDomainTest(SectionDeletionBase):
    def test_admin_can_delete_section(self):
        series = self.create_group_series()

        delete_series_section(
            series_section=self.top,
            actor=self.alex,
        )

        self.assertFalse(
            MeetingSeriesSection.objects.filter(pk=self.top.pk).exists()
        )
        self.assertTrue(
            MeetingSeriesSection.objects.filter(pk=self.check_in.pk)
            .exists()
        )
        self.assertTrue(
            MeetingSeries.objects.filter(pk=series.pk).exists()
        )

    def test_group_member_can_delete_section(self):
        self.create_group_series()

        delete_series_section(
            series_section=self.check_in,
            actor=self.chris,
        )

        self.assertFalse(
            MeetingSeriesSection.objects.filter(pk=self.check_in.pk)
            .exists()
        )

    def test_non_member_cannot_delete_section(self):
        self.create_group_series()

        with self.assertRaises(MeetingDomainError):
            delete_series_section(
                series_section=self.top,
                actor=self.maria,
            )

        self.assertTrue(
            MeetingSeriesSection.objects.filter(pk=self.top.pk).exists()
        )

    def test_project_member_can_delete_project_section(self):
        self.create_project_series()

        delete_series_section(
            series_section=self.top,
            actor=self.chris,
        )

        self.assertFalse(
            MeetingSeriesSection.objects.filter(pk=self.top.pk).exists()
        )

    def test_viewer_cannot_delete_project_section(self):
        self.create_project_series()

        with self.assertRaises(MeetingDomainError):
            delete_series_section(
                series_section=self.top,
                actor=self.laura,
            )

        self.assertTrue(
            MeetingSeriesSection.objects.filter(pk=self.top.pk).exists()
        )

    def test_cannot_delete_section_of_archived_project(self):
        self.create_project_series()
        archive_project(project=self.project, actor=self.alex)

        with self.assertRaises(MeetingDomainError):
            delete_series_section(
                series_section=self.top,
                actor=self.alex,
            )

        self.assertTrue(
            MeetingSeriesSection.objects.filter(pk=self.top.pk).exists()
        )


class SectionDeletionApiTest(SectionDeletionBase):
    def test_admin_can_delete_section(self):
        series = self.create_group_series()

        self.login(self.alex)
        response = self.delete(self.top)

        self.assertEqual(
            response.status_code, status.HTTP_204_NO_CONTENT
        )
        self.assertFalse(
            MeetingSeriesSection.objects.filter(pk=self.top.pk).exists()
        )
        # The Template and the sibling Section survive.
        self.assertTrue(
            MeetingSeries.objects.filter(pk=series.pk).exists()
        )
        self.assertEqual(
            MeetingSeriesSection.objects.filter(
                meeting_series=series
            ).count(),
            1,
        )
        # The deleted Section is no longer resolvable or listed.
        detail = self.client.get(
            f"/api/meeting-series-sections/{self.top.pk}/"
        )
        self.assertEqual(detail.status_code, status.HTTP_404_NOT_FOUND)
        listing = self.client.get(
            f"/api/meeting-series/{series.pk}/sections/"
        )
        self.assertEqual(
            [section["name"] for section in listing.json()],
            ["Check-In"],
        )

    def test_group_member_can_delete_section(self):
        self.create_group_series()

        self.login(self.chris)
        response = self.delete(self.top)

        self.assertEqual(
            response.status_code, status.HTTP_204_NO_CONTENT
        )
        self.assertFalse(
            MeetingSeriesSection.objects.filter(pk=self.top.pk).exists()
        )

    def test_non_member_cannot_delete_section(self):
        self.create_group_series()

        self.login(self.maria)
        response = self.delete(self.top)

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertTrue(
            MeetingSeriesSection.objects.filter(pk=self.top.pk).exists()
        )

    def test_unknown_section_is_404(self):
        self.create_group_series()

        self.login(self.alex)
        response = self.client.delete(
            "/api/meeting-series-sections/999999/"
        )

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_viewer_cannot_delete_project_section(self):
        """Readable but non-writable Template: 403, section kept."""
        self.create_project_series()

        self.login(self.laura)
        response = self.delete(self.top)

        self.assertEqual(
            response.status_code, status.HTTP_403_FORBIDDEN
        )
        self.assertTrue(
            MeetingSeriesSection.objects.filter(pk=self.top.pk).exists()
        )

    def test_cannot_delete_section_of_archived_project(self):
        self.create_project_series()
        archive_project(project=self.project, actor=self.alex)

        self.login(self.alex)
        response = self.delete(self.top)

        self.assertEqual(
            response.status_code, status.HTTP_403_FORBIDDEN
        )
        self.assertTrue(
            MeetingSeriesSection.objects.filter(pk=self.top.pk).exists()
        )


class SectionDeletionPreservationTest(SectionDeletionBase):
    """Deleting a Section never deletes an existing occurrence."""

    def test_deleting_section_keeps_one_time_meeting_and_its_content(
        self,
    ):
        series = self.create_group_series()
        meeting = create_meeting_from_series(
            meeting_series=series,
            actor=self.alex,
            scheduled_at=self.scheduled_at,
        )
        top_snapshot, item = self._populate_meeting(meeting)
        check_in_snapshot = meeting.meeting_sections.get(name="Check-In")
        self.assertEqual(
            top_snapshot.source_series_section, self.top,
        )

        self.login(self.alex)
        response = self.delete(self.top)
        self.assertEqual(
            response.status_code, status.HTTP_204_NO_CONTENT
        )

        # The occurrence survives, including its Template link.
        meeting.refresh_from_db()
        self.assertTrue(Meeting.objects.filter(pk=meeting.pk).exists())
        self.assertEqual(meeting.series_id, series.pk)

        # The snapshot survives with all content intact; only its
        # provenance pointer is cleared.
        top_snapshot.refresh_from_db()
        self.assertTrue(
            MeetingSection.objects.filter(pk=top_snapshot.pk).exists()
        )
        self.assertEqual(top_snapshot.name, "TOPs")
        self.assertEqual(top_snapshot.description, "Topic of the day.")
        self.assertEqual(top_snapshot.position, 1)
        self.assertTrue(top_snapshot.is_visible)
        self.assertIsNone(top_snapshot.source_series_section_id)

        # The sibling snapshot's provenance is untouched.
        check_in_snapshot.refresh_from_db()
        self.assertEqual(
            check_in_snapshot.source_series_section_id,
            self.check_in.pk,
        )

        # Agenda item, its Note, and the participant survive.
        item.refresh_from_db()
        self.assertTrue(MeetingItem.objects.filter(pk=item.pk).exists())
        self.assertEqual(item.meeting_section_id, top_snapshot.pk)
        self.assertEqual(
            MeetingNote.objects.filter(meeting_item=item).count(),
            1,
        )
        self.assertTrue(
            MeetingParticipant.objects.filter(
                meeting=meeting.pk,
                user=self.chris,
            ).exists()
        )

    def test_deleting_section_keeps_materialized_recurrence_occurrence(
        self,
    ):
        series = self.create_group_series()
        recurrence = self._create_recurrence(series)
        meeting = self._materialize(
            recurrence,
            self._occurrence(recurrence, 5),
            "Standup 1",
        )
        top_snapshot, item = self._populate_meeting(meeting)
        self.assertEqual(
            top_snapshot.source_series_section, self.top,
        )

        delete_series_section(series_section=self.top, actor=self.alex)

        # The materialized occurrence survives with its content.
        meeting.refresh_from_db()
        self.assertTrue(Meeting.objects.filter(pk=meeting.pk).exists())
        self.assertEqual(meeting.recurrence_id, recurrence.pk)
        top_snapshot.refresh_from_db()
        self.assertTrue(
            MeetingSection.objects.filter(pk=top_snapshot.pk).exists()
        )
        self.assertEqual(top_snapshot.name, "TOPs")
        self.assertIsNone(top_snapshot.source_series_section_id)
        item.refresh_from_db()
        self.assertTrue(MeetingItem.objects.filter(pk=item.pk).exists())

        # The Recurrence itself (and its Template link) survives.
        recurrence.refresh_from_db()
        self.assertEqual(recurrence.series_id, series.pk)


class SectionDeletionFutureSnapshotsTest(SectionDeletionBase):
    """Future occurrences omit the deleted Section."""

    def test_new_one_time_meeting_omits_deleted_section(self):
        series = self.create_group_series()
        first = create_meeting_from_series(
            meeting_series=series,
            actor=self.alex,
            scheduled_at=self.scheduled_at,
        )
        self.assertEqual(first.meeting_sections.count(), 2)

        delete_series_section(series_section=self.top, actor=self.alex)

        second = create_meeting_from_series(
            meeting_series=series,
            actor=self.alex,
            scheduled_at=self.scheduled_at + timedelta(days=7),
        )
        sections = list(second.meeting_sections.all())
        self.assertEqual([section.name for section in sections], ["Check-In"])
        self.assertEqual(
            sections[0].source_series_section_id,
            self.check_in.pk,
        )

        # The existing Meeting is untouched.
        self.assertEqual(first.meeting_sections.count(), 2)

    def test_later_materialized_occurrence_omits_deleted_section(
        self,
    ):
        series = self.create_group_series()
        recurrence = self._create_recurrence(series)
        first_meeting = self._materialize(
            recurrence,
            self._occurrence(recurrence, 5),
            "Standup 1",
        )
        self.assertEqual(first_meeting.meeting_sections.count(), 2)

        delete_series_section(series_section=self.top, actor=self.alex)

        # The Recurrence remains usable: a later still-virtual
        # occurrence materializes and omits the deleted Section.
        second_meeting = self._materialize(
            recurrence,
            self._occurrence(recurrence, 6),
            "Standup 2",
        )
        self.assertNotEqual(
            second_meeting.pk, first_meeting.pk,
        )
        sections = list(second_meeting.meeting_sections.all())
        self.assertEqual([section.name for section in sections], ["Check-In"])

        # The first materialized Meeting is untouched.
        self.assertEqual(first_meeting.meeting_sections.count(), 2)
        recurrence.refresh_from_db()
        self.assertEqual(recurrence.series_id, series.pk)

    def test_deleting_last_section_leaves_zero_section_template(
        self,
    ):
        series = create_meeting_series(
            research_group=self.group,
            actor=self.alex,
            title="Solo Template",
        )
        only = create_series_section(
            meeting_series=series,
            actor=self.alex,
            name="Agenda",
        )

        self.login(self.alex)
        response = self.delete(only)
        self.assertEqual(
            response.status_code, status.HTTP_204_NO_CONTENT
        )

        # The Template survives with zero Sections.
        self.assertTrue(
            MeetingSeries.objects.filter(pk=series.pk).exists()
        )
        self.assertEqual(
            MeetingSeriesSection.objects.filter(
                meeting_series=series
            ).count(),
            0,
        )

        # A new Meeting gets no implicit replacement Section.
        meeting = create_meeting_from_series(
            meeting_series=series,
            actor=self.alex,
            scheduled_at=self.scheduled_at,
        )
        self.assertEqual(meeting.meeting_sections.count(), 0)


class SectionDeletionFollowUpRecommendationTest(SectionDeletionBase):
    """Follow-up recommendation after provenance loss (SET_NULL):
    the existing name fallback works where names match, and no
    recommendation is fabricated where they do not."""

    def setUp(self):
        super().setUp()

        self.series = create_meeting_series(
            research_group=self.group,
            actor=self.alex,
            title="Weekly",
        )
        self.series_section = create_series_section(
            meeting_series=self.series,
            actor=self.alex,
            name="For your Info",
        )
        self.source_meeting = create_meeting_from_series(
            meeting_series=self.series,
            actor=self.alex,
            scheduled_at=self.scheduled_at,
        )
        self.source_section = self.source_meeting.meeting_sections.get()
        self.source_item = create_meeting_item(
            meeting=self.source_meeting,
            meeting_section=self.source_section,
            actor=self.alex,
            title="Continue experiment",
        )
        self.target_meeting = create_meeting_from_series(
            meeting_series=self.series,
            actor=self.alex,
            scheduled_at=self.scheduled_at + timedelta(days=7),
        )
        self.target_section = self.target_meeting.meeting_sections.get()

        self.client.force_login(self.alex)

    def _delete_section(self):
        delete_series_section(
            series_section=self.series_section,
            actor=self.alex,
        )
        self.source_section.refresh_from_db()
        self.assertIsNone(self.source_section.source_series_section_id)
        self.target_section.refresh_from_db()
        self.assertIsNone(self.target_section.source_series_section_id)

    def _candidate(self):
        response = self.client.get(
            f"/api/meeting-items/{self.source_item.pk}"
            "/follow-up-targets/"
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        candidates = {
            meeting["id"]: meeting
            for meeting in response.json()["meetings"]
        }
        return candidates[self.target_meeting.pk]

    def test_name_fallback_still_recommends_after_provenance_loss(
        self,
    ):
        self._delete_section()

        candidate = self._candidate()
        self.assertEqual(
            candidate["recommendedSectionId"], self.target_section.pk,
        )
        self.assertEqual(
            candidate["sections"][0]["id"], self.target_section.pk,
        )
        self.assertIsNone(
            candidate["sections"][0]["sourceSeriesSectionId"],
        )

    def test_no_recommendation_fabricated_when_names_differ(self):
        self._delete_section()
        self.target_section.name = "Renamed"
        self.target_section.save(update_fields=["name"])

        candidate = self._candidate()
        self.assertIsNone(candidate["recommendedSectionId"])
