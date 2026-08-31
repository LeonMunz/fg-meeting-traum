"""API tests for MeetingSeries, MeetingSeriesSection, and MeetingSection."""

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from rest_framework import status
from rest_framework.test import APIClient

from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)

from .models import (
    MeetingSection,
    MeetingSeries,
    MeetingSeriesSection,
)
from .services import (
    create_meeting_from_series,
    create_series_section,
)


User = get_user_model()


class MeetingSeriesApiTest(TestCase):
    """API tests for MeetingSeries CRUD."""

    def setUp(self):
        self.client = APIClient()

        self.alex = User.objects.create_user(
            username="api-series-alex", password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="api-series-chris", password="Pass1!",
        )
        self.maria = User.objects.create_user(
            username="api-series-maria", password="Pass1!",
        )

        self.group = ResearchGroup.objects.create(
            name="API Series Group", created_by=self.alex,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.chris,
            role=ResearchGroupMembership.Role.MEMBER,
        )

        self.series = MeetingSeries.objects.create(
            research_group=self.group,
            title="FG Weekly",
            description="Weekly meeting.",
            created_by=self.alex,
        )

    def login(self, user):
        self.client.logout()
        self.client.force_login(user)

    # ── List / Create ────────────────────────────────────────────

    def test_authentication_is_required(self):
        response = self.client.get(
            f"/api/research-groups/{self.group.pk}/meeting-series/",
        )
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_group_member_can_list_series(self):
        self.login(self.chris)
        response = self.client.get(
            f"/api/research-groups/{self.group.pk}/meeting-series/",
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.json()), 1)
        self.assertEqual(response.json()[0]["id"], self.series.pk)

    def test_non_member_series_list_is_empty(self):
        self.login(self.maria)
        response = self.client.get(
            f"/api/research-groups/{self.group.pk}/meeting-series/",
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.json(), [])

    def test_group_member_can_create_series(self):
        self.login(self.alex)
        response = self.client.post(
            f"/api/research-groups/{self.group.pk}/meeting-series/",
            {
                "title": "Sprint Planning",
                "description": "Bi-weekly sprint planning.",
            },
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        data = response.json()
        self.assertEqual(data["title"], "Sprint Planning")
        self.assertEqual(data["description"], "Bi-weekly sprint planning.")
        self.assertFalse(data["isArchived"])
        self.assertEqual(data["researchGroupId"], self.group.pk)

    def test_non_member_cannot_create_series(self):
        self.login(self.maria)
        response = self.client.post(
            f"/api/research-groups/{self.group.pk}/meeting-series/",
            {"title": "Forbidden"},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    # ── Detail / Patch ───────────────────────────────────────────

    def test_group_member_can_read_series(self):
        self.login(self.chris)
        response = self.client.get(
            f"/api/meeting-series/{self.series.pk}/",
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.json()["id"], self.series.pk)

    def test_non_member_cannot_read_series(self):
        self.login(self.maria)
        response = self.client.get(
            f"/api/meeting-series/{self.series.pk}/",
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_group_member_can_patch_series(self):
        self.login(self.chris)
        response = self.client.patch(
            f"/api/meeting-series/{self.series.pk}/",
            {
                "title": "FG Weekly Updated",
                "description": "Updated description.",
                "isArchived": True,
            },
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.series.refresh_from_db()
        self.assertEqual(self.series.title, "FG Weekly Updated")
        self.assertTrue(self.series.is_archived)

    def test_cannot_change_series_research_group(self):
        self.login(self.alex)
        response = self.client.patch(
            f"/api/meeting-series/{self.series.pk}/",
            {"researchGroupId": 999},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)


class MeetingSeriesSectionApiTest(TestCase):
    """API tests for MeetingSeriesSection CRUD and reorder."""

    def setUp(self):
        self.client = APIClient()

        self.alex = User.objects.create_user(
            username="api-sec-alex", password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="api-sec-chris", password="Pass1!",
        )
        self.maria = User.objects.create_user(
            username="api-sec-maria", password="Pass1!",
        )

        self.group = ResearchGroup.objects.create(
            name="API Section Group", created_by=self.alex,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.chris,
            role=ResearchGroupMembership.Role.MEMBER,
        )

        self.series = MeetingSeries.objects.create(
            research_group=self.group,
            title="FG Weekly",
            created_by=self.alex,
        )

        self.s1 = create_series_section(
            meeting_series=self.series, actor=self.alex, name="Check-In",
        )
        self.s2 = create_series_section(
            meeting_series=self.series, actor=self.alex, name="TOPs",
        )

    def login(self, user):
        self.client.logout()
        self.client.force_login(user)

    # ── List / Create ────────────────────────────────────────────

    def test_group_member_can_list_sections(self):
        self.login(self.chris)
        response = self.client.get(
            f"/api/meeting-series/{self.series.pk}/sections/",
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        self.assertEqual(len(data), 2)
        self.assertEqual(data[0]["name"], "Check-In")
        self.assertEqual(data[1]["name"], "TOPs")

    def test_non_member_cannot_list_sections(self):
        self.login(self.maria)
        response = self.client.get(
            f"/api/meeting-series/{self.series.pk}/sections/",
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_group_member_can_create_section(self):
        self.login(self.alex)
        response = self.client.post(
            f"/api/meeting-series/{self.series.pk}/sections/",
            {"name": "Projekte", "description": "Project updates."},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        data = response.json()
        self.assertEqual(data["name"], "Projekte")
        self.assertEqual(data["position"], 2)
        self.assertTrue(data["isActive"])

    # ── Detail / Patch ───────────────────────────────────────────

    def test_group_member_can_read_section(self):
        self.login(self.chris)
        response = self.client.get(
            f"/api/meeting-series-sections/{self.s1.pk}/",
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.json()["name"], "Check-In")

    def test_non_member_cannot_read_section(self):
        self.login(self.maria)
        response = self.client.get(
            f"/api/meeting-series-sections/{self.s1.pk}/",
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_group_member_can_patch_section(self):
        self.login(self.chris)
        response = self.client.patch(
            f"/api/meeting-series-sections/{self.s1.pk}/",
            {"name": "Quick Check-In", "isActive": False},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.s1.refresh_from_db()
        self.assertEqual(self.s1.name, "Quick Check-In")
        self.assertFalse(self.s1.is_active)

    def test_cannot_change_section_position_via_patch(self):
        self.login(self.alex)
        response = self.client.patch(
            f"/api/meeting-series-sections/{self.s1.pk}/",
            {"position": 99},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    # ── Reorder ──────────────────────────────────────────────────

    def test_group_member_can_reorder_sections(self):
        self.login(self.alex)
        response = self.client.patch(
            f"/api/meeting-series/{self.series.pk}/sections/reorder/",
            {"sectionIds": [self.s2.pk, self.s1.pk]},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        self.assertEqual(data[0]["name"], "TOPs")
        self.assertEqual(data[0]["position"], 0)
        self.assertEqual(data[1]["name"], "Check-In")
        self.assertEqual(data[1]["position"], 1)

    def test_non_member_cannot_reorder_sections(self):
        self.login(self.maria)
        response = self.client.patch(
            f"/api/meeting-series/{self.series.pk}/sections/reorder/",
            {"sectionIds": [self.s1.pk, self.s2.pk]},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_partial_reorder_rejected_with_400(self):
        """A reorder with only some section IDs must return 400."""
        self.login(self.alex)
        response = self.client.patch(
            f"/api/meeting-series/{self.series.pk}/sections/reorder/",
            {"sectionIds": [self.s2.pk]},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("all sections", response.json()["error"])


class MeetingOccurrenceApiTest(TestCase):
    """API tests for creating Meeting occurrences from a Series."""

    def setUp(self):
        self.client = APIClient()

        self.alex = User.objects.create_user(
            username="api-occ-alex", password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="api-occ-chris", password="Pass1!",
        )
        self.maria = User.objects.create_user(
            username="api-occ-maria", password="Pass1!",
        )

        self.group = ResearchGroup.objects.create(
            name="API Occurrence Group", created_by=self.alex,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.chris,
            role=ResearchGroupMembership.Role.MEMBER,
        )

        self.series = MeetingSeries.objects.create(
            research_group=self.group,
            title="FG Weekly",
            created_by=self.alex,
        )
        create_series_section(
            meeting_series=self.series, actor=self.alex, name="Check-In",
        )
        create_series_section(
            meeting_series=self.series, actor=self.alex, name="TOPs",
        )

        self.scheduled_at = (
            timezone.now().replace(microsecond=0) + timedelta(days=1)
        )

    def login(self, user):
        self.client.logout()
        self.client.force_login(user)

    def test_group_member_can_create_occurrence(self):
        self.login(self.alex)
        response = self.client.post(
            f"/api/meeting-series/{self.series.pk}/occurrences/",
            {
                "scheduledAt": self.scheduled_at.isoformat(),
            },
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        data = response.json()
        self.assertEqual(data["seriesId"], self.series.pk)
        self.assertEqual(data["title"], "FG Weekly")
        self.assertEqual(data["status"], "upcoming")
        self.assertEqual(len(data["participantIds"]), 1)

    def test_non_member_cannot_create_occurrence(self):
        self.login(self.maria)
        response = self.client.post(
            f"/api/meeting-series/{self.series.pk}/occurrences/",
            {
                "scheduledAt": self.scheduled_at.isoformat(),
            },
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_occurrence_can_override_title(self):
        self.login(self.alex)
        response = self.client.post(
            f"/api/meeting-series/{self.series.pk}/occurrences/",
            {
                "title": "FG Weekly — Special",
                "scheduledAt": self.scheduled_at.isoformat(),
            },
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.json()["title"], "FG Weekly — Special")

    def test_occurrence_sections_are_snapshotted(self):
        self.login(self.alex)
        response = self.client.post(
            f"/api/meeting-series/{self.series.pk}/occurrences/",
            {
                "scheduledAt": self.scheduled_at.isoformat(),
            },
            format="json",
        )
        meeting_id = response.json()["id"]

        # Check sections endpoint.
        sections_response = self.client.get(
            f"/api/meetings/{meeting_id}/sections/",
        )
        self.assertEqual(sections_response.status_code, status.HTTP_200_OK)
        sections = sections_response.json()
        self.assertEqual(len(sections), 2)
        self.assertEqual(sections[0]["name"], "Check-In")
        self.assertEqual(sections[1]["name"], "TOPs")

    def test_non_member_cannot_read_meeting_sections(self):
        meeting = create_meeting_from_series(
            meeting_series=self.series,
            actor=self.alex,
            scheduled_at=self.scheduled_at,
        )
        self.login(self.maria)
        response = self.client.get(
            f"/api/meetings/{meeting.pk}/sections/",
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_series_section_rename_does_not_affect_existing_occurrence(self):
        self.login(self.alex)

        # Create first occurrence.
        response = self.client.post(
            f"/api/meeting-series/{self.series.pk}/occurrences/",
            {
                "scheduledAt": self.scheduled_at.isoformat(),
            },
            format="json",
        )
        meeting_id = response.json()["id"]

        # Rename a series section.
        section = MeetingSeriesSection.objects.get(
            meeting_series=self.series, name="Check-In",
        )
        section.name = "Renamed Check-In"
        section.save(update_fields=["name"])

        # Read the meeting sections — should still say "Check-In".
        sections_response = self.client.get(
            f"/api/meetings/{meeting_id}/sections/",
        )
        sections = sections_response.json()
        names = [s["name"] for s in sections]
        self.assertIn("Check-In", names)
        self.assertNotIn("Renamed Check-In", names)

    def test_second_occurrence_gets_updated_structure(self):
        self.login(self.alex)

        # Create first occurrence.
        self.client.post(
            f"/api/meeting-series/{self.series.pk}/occurrences/",
            {
                "scheduledAt": self.scheduled_at.isoformat(),
            },
            format="json",
        )

        # Deactivate "TOPs" and add "Projekte".
        top_section = MeetingSeriesSection.objects.get(
            meeting_series=self.series, name="TOPs",
        )
        top_section.is_active = False
        top_section.save(update_fields=["is_active"])

        create_series_section(
            meeting_series=self.series,
            actor=self.alex,
            name="Projekte",
        )

        # Create second occurrence.
        response = self.client.post(
            f"/api/meeting-series/{self.series.pk}/occurrences/",
            {
                "scheduledAt": (
                    self.scheduled_at + timedelta(days=7)
                ).isoformat(),
            },
            format="json",
        )
        meeting_id = response.json()["id"]

        sections_response = self.client.get(
            f"/api/meetings/{meeting_id}/sections/",
        )
        names = [
            s["name"]
            for s in sections_response.json()
        ]
        self.assertIn("Check-In", names)
        self.assertIn("Projekte", names)
        self.assertNotIn("TOPs", names)
