from django.contrib.auth import get_user_model
from django.test import TestCase

from rest_framework import status
from rest_framework.test import APIClient

from projects.models import ProjectMembership
from projects.services import add_project_membership, create_project
from research_groups.models import ResearchGroup, ResearchGroupMembership

from .models import Meeting, MeetingParticipant, MeetingSeries


User = get_user_model()


class MeetingParticipantCandidateApiTest(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.creator = User.objects.create_user(
            username="candidate-creator",
            password="Pass1!",
            first_name="Casey",
            last_name="Creator",
        )
        self.group_member = User.objects.create_user(
            username="candidate-group-member",
            password="Pass1!",
            first_name="Morgan",
            last_name="Member",
        )
        self.external_user = User.objects.create_user(
            username="candidate-external",
            password="Pass1!",
            first_name="Erin",
            last_name="External",
        )
        self.viewer = User.objects.create_user(
            username="candidate-viewer",
            password="Pass1!",
            first_name="Val",
            last_name="Viewer",
        )
        self.inactive_user = User.objects.create_user(
            username="candidate-inactive",
            password="Pass1!",
            is_active=False,
        )

        self.group = ResearchGroup.objects.create(
            name="Candidate Group",
            created_by=self.creator,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.creator,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.group_member,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.viewer,
            role=ResearchGroupMembership.Role.MEMBER,
        )

        self.project = create_project(
            research_group=self.group,
            creator=self.creator,
            name="Candidate Project",
        )
        add_project_membership(
            project=self.project,
            actor=self.creator,
            target_user=self.viewer,
            role=ProjectMembership.Role.VIEWER,
        )

        self.group_series = MeetingSeries.objects.create(
            research_group=self.group,
            scope=MeetingSeries.Scope.GROUP,
            title="Candidate Group Template",
            created_by=self.creator,
        )
        self.project_series = MeetingSeries.objects.create(
            research_group=self.group,
            scope=MeetingSeries.Scope.PROJECT,
            project=self.project,
            title="Candidate Project Template",
            created_by=self.creator,
        )

    def login(self, user):
        self.client.logout()
        self.client.force_login(user)

    def snapshot_row_counts(self):
        return {
            "meetings": Meeting.objects.count(),
            "participants": MeetingParticipant.objects.count(),
            "group_memberships": ResearchGroupMembership.objects.count(),
            "project_memberships": ProjectMembership.objects.count(),
        }

    def test_standalone_search_returns_group_member_and_external_user(self):
        before = self.snapshot_row_counts()
        self.login(self.creator)

        response = self.client.get(
            f"/api/research-groups/{self.group.pk}/meetings/participant-candidates/",
            {"q": "candidate"},
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        by_username = {
            candidate["username"]: candidate
            for candidate in response.json()
        }
        self.assertIn(self.group_member.username, by_username)
        self.assertIn(self.external_user.username, by_username)
        self.assertEqual(
            set(by_username[self.external_user.username]),
            {"id", "username", "firstName", "lastName"},
        )
        self.assertEqual(
            by_username[self.external_user.username],
            {
                "id": self.external_user.pk,
                "username": "candidate-external",
                "firstName": "Erin",
                "lastName": "External",
            },
        )
        self.assertEqual(self.snapshot_row_counts(), before)
        self.assertFalse(
            ResearchGroupMembership.objects.filter(
                research_group=self.group,
                user=self.external_user,
            ).exists()
        )

    def test_project_meeting_search_returns_user_without_project_access(self):
        before = self.snapshot_row_counts()
        self.login(self.creator)

        response = self.client.get(
            f"/api/research-groups/{self.group.pk}/meetings/participant-candidates/",
            {
                "scope": Meeting.Scope.PROJECT,
                "projectId": self.project.pk,
                "q": "candidate-external",
            },
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            [candidate["id"] for candidate in response.json()],
            [self.external_user.pk],
        )
        self.assertFalse(
            ProjectMembership.objects.filter(
                project=self.project,
                user=self.external_user,
            ).exists()
        )
        self.assertEqual(self.snapshot_row_counts(), before)

    def test_standalone_search_reuses_create_authorization(self):
        self.login(self.external_user)
        group_response = self.client.get(
            f"/api/research-groups/{self.group.pk}/meetings/participant-candidates/",
            {"q": "candidate"},
        )
        self.assertEqual(group_response.status_code, status.HTTP_404_NOT_FOUND)

        self.login(self.viewer)
        project_response = self.client.get(
            f"/api/research-groups/{self.group.pk}/meetings/participant-candidates/",
            {
                "scope": Meeting.Scope.PROJECT,
                "projectId": self.project.pk,
                "q": "candidate",
            },
        )
        self.assertEqual(project_response.status_code, status.HTTP_403_FORBIDDEN)

    def test_occurrence_search_returns_external_user(self):
        before = self.snapshot_row_counts()
        self.login(self.creator)

        response = self.client.get(
            f"/api/meeting-series/{self.group_series.pk}/participant-candidates/",
            {"q": "candidate-external"},
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            response.json(),
            [
                {
                    "id": self.external_user.pk,
                    "username": "candidate-external",
                    "firstName": "Erin",
                    "lastName": "External",
                }
            ],
        )
        self.assertEqual(self.snapshot_row_counts(), before)

    def test_occurrence_search_reuses_create_authorization(self):
        self.login(self.external_user)
        group_response = self.client.get(
            f"/api/meeting-series/{self.group_series.pk}/participant-candidates/",
            {"q": "candidate"},
        )
        self.assertEqual(group_response.status_code, status.HTTP_404_NOT_FOUND)

        self.login(self.viewer)
        project_response = self.client.get(
            f"/api/meeting-series/{self.project_series.pk}/participant-candidates/",
            {"q": "candidate"},
        )
        self.assertEqual(project_response.status_code, status.HTTP_403_FORBIDDEN)

    def test_search_uses_existing_query_and_inactive_user_conventions(self):
        self.login(self.creator)
        url = (
            f"/api/research-groups/{self.group.pk}"
            "/meetings/participant-candidates/"
        )

        self.assertEqual(self.client.get(url, {"q": "c"}).json(), [])
        response = self.client.get(url, {"q": "candidate-inactive"})
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.json(), [])
