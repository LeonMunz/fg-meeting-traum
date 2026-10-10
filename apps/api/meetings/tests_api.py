from datetime import datetime, timedelta

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from rest_framework import status
from rest_framework.test import APIClient

from projects.models import ProjectMembership
from projects.services import (
    add_project_membership,
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
)
from .services import (
    add_meeting_participant,
    create_meeting,
    create_meeting_item,
)


User = get_user_model()


class MeetingApiTest(TestCase):
    def setUp(self):
        self.client = APIClient()

        self.alex = User.objects.create_user(
            username="meeting-api-alex",
            password="Pass1!",
            first_name="Alex",
        )
        self.chris = User.objects.create_user(
            username="meeting-api-chris",
            password="Pass1!",
            first_name="Chris",
        )
        self.laura = User.objects.create_user(
            username="meeting-api-laura",
            password="Pass1!",
            first_name="Laura",
        )
        self.maria = User.objects.create_user(
            username="meeting-api-maria",
            password="Pass1!",
            first_name="Maria",
        )

        self.group = ResearchGroup.objects.create(
            name="Meeting API Group",
            created_by=self.alex,
        )

        for user, role in [
            (
                self.alex,
                ResearchGroupMembership.Role.ADMIN,
            ),
            (
                self.chris,
                ResearchGroupMembership.Role.MEMBER,
            ),
            (
                self.laura,
                ResearchGroupMembership.Role.MEMBER,
            ),
        ]:
            ResearchGroupMembership.objects.create(
                research_group=self.group,
                user=user,
                role=role,
            )

        self.scheduled_at = (
            timezone.now()
            .replace(microsecond=0)
            + timedelta(days=1)
        )

    def login(self, user):
        self.client.logout()
        self.client.force_login(user)

    def create_default_meeting(
        self,
        *,
        actor=None,
        title="FG Weekly",
    ):
        return create_meeting(
            research_group=self.group,
            actor=actor or self.alex,
            title=title,
            scheduled_at=self.scheduled_at,
        )

    def test_authentication_is_required(self):
        response = self.client.get(
            f"/api/research-groups/{self.group.pk}/meetings/"
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_401_UNAUTHORIZED,
        )

    def test_group_member_can_create_meeting(self):
        self.login(self.alex)

        response = self.client.post(
            f"/api/research-groups/{self.group.pk}/meetings/",
            {
                "title": "API Weekly",
                "scheduledAt": self.scheduled_at.isoformat(),
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_201_CREATED,
        )

        data = response.json()

        self.assertEqual(data["title"], "API Weekly")
        self.assertEqual(
            data["researchGroupId"],
            self.group.pk,
        )
        self.assertEqual(data["status"], "upcoming")
        self.assertIsNone(data["startedAt"])
        self.assertIsNone(data["endedAt"])
        self.assertEqual(
            data["participantIds"],
            [self.alex.pk],
        )

    def test_create_meeting_rejects_outside_group_initial_participants(self):
        self.login(self.alex)

        # maria is not a Research Group member: the create request is
        # rejected and nothing is persisted, with no membership created
        # as a side effect.
        response = self.client.post(
            f"/api/research-groups/{self.group.pk}/meetings/",
            {
                "title": "API Weekly with guests",
                "scheduledAt": self.scheduled_at.isoformat(),
                "participantIds": [
                    self.alex.pk,
                    self.chris.pk,
                    self.maria.pk,
                ],
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(
            Meeting.objects.filter(
                title="API Weekly with guests"
            ).count(),
            0,
        )
        self.assertFalse(
            ResearchGroupMembership.objects.filter(
                research_group=self.group,
                user=self.maria,
            ).exists()
        )

        # Eligible current Research Group members can be initial
        # participants; duplicates are collapsed.
        response = self.client.post(
            f"/api/research-groups/{self.group.pk}/meetings/",
            {
                "title": "API Weekly with members",
                "scheduledAt": self.scheduled_at.isoformat(),
                "participantIds": [
                    self.alex.pk,
                    self.chris.pk,
                    self.laura.pk,
                    self.chris.pk,
                ],
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        data = response.json()
        self.assertEqual(
            data["participantIds"],
            [self.alex.pk, self.chris.pk, self.laura.pk],
        )
        self.assertEqual(
            MeetingParticipant.objects.filter(
                meeting_id=data["id"],
            ).count(),
            3,
        )

    def test_invalid_initial_participant_rolls_back_entire_create(self):
        meeting_count = Meeting.objects.count()
        participant_count = MeetingParticipant.objects.count()
        missing_user_id = User.objects.order_by("-pk").first().pk + 1000
        self.login(self.alex)

        response = self.client.post(
            f"/api/research-groups/{self.group.pk}/meetings/",
            {
                "title": "Must not persist",
                "scheduledAt": self.scheduled_at.isoformat(),
                "participantIds": [self.chris.pk, missing_user_id],
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("participantIds", response.json())
        self.assertEqual(Meeting.objects.count(), meeting_count)
        self.assertEqual(
            MeetingParticipant.objects.count(),
            participant_count,
        )

    def test_non_member_cannot_create_meeting(self):
        self.login(self.maria)

        response = self.client.post(
            f"/api/research-groups/{self.group.pk}/meetings/",
            {
                "title": "Forbidden",
                "scheduledAt": self.scheduled_at.isoformat(),
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_404_NOT_FOUND,
        )

    def test_group_member_can_list_meetings(self):
        meeting = self.create_default_meeting()
        add_meeting_participant(
            meeting=meeting, actor=self.alex, target_user=self.chris,
        )

        self.login(self.chris)

        response = self.client.get(
            f"/api/research-groups/{self.group.pk}/meetings/"
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_200_OK,
        )
        self.assertEqual(
            [item["id"] for item in response.json()],
            [meeting.pk],
        )

    def test_non_member_meeting_list_is_empty(self):
        self.create_default_meeting()

        self.login(self.maria)

        response = self.client.get(
            f"/api/research-groups/{self.group.pk}/meetings/"
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_200_OK,
        )
        self.assertEqual(response.json(), [])

    def test_group_member_can_read_meeting(self):
        meeting = self.create_default_meeting()
        add_meeting_participant(
            meeting=meeting, actor=self.alex, target_user=self.chris,
        )

        self.login(self.chris)

        response = self.client.get(
            f"/api/meetings/{meeting.pk}/"
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_200_OK,
        )
        self.assertEqual(
            response.json()["id"],
            meeting.pk,
        )

    def test_non_member_cannot_read_meeting(self):
        meeting = self.create_default_meeting()

        self.login(self.maria)

        response = self.client.get(
            f"/api/meetings/{meeting.pk}/"
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_404_NOT_FOUND,
        )

    def test_group_member_can_patch_meeting(self):
        meeting = self.create_default_meeting()
        add_meeting_participant(
            meeting=meeting, actor=self.alex, target_user=self.chris,
        )

        new_scheduled_at = (
            self.scheduled_at + timedelta(hours=3)
        )

        self.login(self.chris)

        response = self.client.patch(
            f"/api/meetings/{meeting.pk}/",
            {
                "title": "Updated Weekly",
                "scheduledAt": new_scheduled_at.isoformat(),
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_200_OK,
        )

        meeting.refresh_from_db()

        self.assertEqual(
            meeting.title,
            "Updated Weekly",
        )
        self.assertEqual(
            meeting.scheduled_at,
            new_scheduled_at,
        )
        # Lifecycle cannot be moved via PATCH.
        self.assertEqual(
            meeting.status,
            "upcoming",
        )

    def test_invalid_scheduled_at_is_rejected(self):
        meeting = self.create_default_meeting()

        self.login(self.alex)

        response = self.client.patch(
            f"/api/meetings/{meeting.pk}/",
            {
                "scheduledAt": "not-a-date",
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_400_BAD_REQUEST,
        )

    def test_invalid_meeting_status_is_rejected(self):
        meeting = self.create_default_meeting()

        self.login(self.alex)

        response = self.client.patch(
            f"/api/meetings/{meeting.pk}/",
            {
                "status": "invalid",
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_400_BAD_REQUEST,
        )

    def test_start_meeting_endpoint(self):
        meeting = self.create_default_meeting()

        self.login(self.alex)

        response = self.client.post(
            f"/api/meetings/{meeting.pk}/start",
            {},
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_200_OK,
        )

        data = response.json()
        self.assertEqual(data["status"], "live")
        self.assertIsNotNone(data["startedAt"])
        self.assertIsNone(data["endedAt"])

        meeting.refresh_from_db()
        self.assertEqual(meeting.status, "live")
        self.assertIsNotNone(meeting.started_at)
        self.assertEqual(meeting.scheduled_at, self.scheduled_at)

    def test_start_meeting_rejects_repeat(self):
        meeting = self.create_default_meeting()
        self.login(self.alex)

        self.assertEqual(
            self.client.post(
                f"/api/meetings/{meeting.pk}/start",
                {},
                format="json",
            ).status_code,
            status.HTTP_200_OK,
        )

        response = self.client.post(
            f"/api/meetings/{meeting.pk}/start",
            {},
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_400_BAD_REQUEST,
        )

        # Still live; repeated start must not alter the recorded start.
        meeting.refresh_from_db()
        self.assertEqual(meeting.status, "live")

    def test_end_meeting_endpoint(self):
        meeting = self.create_default_meeting()
        self.login(self.alex)

        self.client.post(
            f"/api/meetings/{meeting.pk}/start",
            {},
            format="json",
        )

        response = self.client.post(
            f"/api/meetings/{meeting.pk}/end",
            {},
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_200_OK,
        )

        data = response.json()
        self.assertEqual(data["status"], "completed")
        self.assertIsNotNone(data["startedAt"])
        self.assertIsNotNone(data["endedAt"])

    def test_end_meeting_rejects_upcoming(self):
        meeting = self.create_default_meeting()
        self.login(self.alex)

        response = self.client.post(
            f"/api/meetings/{meeting.pk}/end",
            {},
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_400_BAD_REQUEST,
        )

        meeting.refresh_from_db()
        self.assertEqual(meeting.status, "upcoming")
        self.assertIsNone(meeting.ended_at)

    def test_completed_meeting_cannot_restart_or_end(self):
        meeting = self.create_default_meeting()
        self.login(self.alex)

        self.client.post(
            f"/api/meetings/{meeting.pk}/start",
            {},
            format="json",
        )
        self.client.post(
            f"/api/meetings/{meeting.pk}/end",
            {},
            format="json",
        )

        self.assertEqual(
            self.client.post(
                f"/api/meetings/{meeting.pk}/start",
                {},
                format="json",
            ).status_code,
            status.HTTP_400_BAD_REQUEST,
        )
        self.assertEqual(
            self.client.post(
                f"/api/meetings/{meeting.pk}/end",
                {},
                format="json",
            ).status_code,
            status.HTTP_400_BAD_REQUEST,
        )

    def test_reopen_meeting_endpoint(self):
        meeting = self.create_default_meeting()
        self.login(self.alex)

        self.client.post(f"/api/meetings/{meeting.pk}/start", {}, format="json")
        self.client.post(f"/api/meetings/{meeting.pk}/end", {}, format="json")
        meeting.refresh_from_db()
        started_at = meeting.started_at

        response = self.client.post(
            f"/api/meetings/{meeting.pk}/reopen",
            {},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        self.assertEqual(data["status"], "live")
        self.assertIsNone(data["endedAt"])
        # Original start is preserved (same instant), not reset.
        self.assertEqual(
            datetime.fromisoformat(data["startedAt"]).replace(tzinfo=None),
            started_at.replace(tzinfo=None),
        )

        meeting.refresh_from_db()
        self.assertEqual(meeting.status, "live")
        self.assertIsNone(meeting.ended_at)

    def test_reopen_rejects_upcoming_and_live(self):
        # upcoming
        upcoming = self.create_default_meeting()
        self.login(self.alex)
        self.assertEqual(
            self.client.post(
                f"/api/meetings/{upcoming.pk}/reopen",
                {},
                format="json",
            ).status_code,
            status.HTTP_400_BAD_REQUEST,
        )
        upcoming.refresh_from_db()
        self.assertEqual(upcoming.status, "upcoming")

        # live
        live = self.create_default_meeting()
        self.client.post(f"/api/meetings/{live.pk}/start", {}, format="json")
        self.assertEqual(
            self.client.post(
                f"/api/meetings/{live.pk}/reopen",
                {},
                format="json",
            ).status_code,
            status.HTTP_400_BAD_REQUEST,
        )
        live.refresh_from_db()
        self.assertEqual(live.status, "live")

    def test_reopened_meeting_can_be_ended_again(self):
        meeting = self.create_default_meeting()
        self.login(self.alex)
        self.client.post(f"/api/meetings/{meeting.pk}/start", {}, format="json")
        self.client.post(f"/api/meetings/{meeting.pk}/end", {}, format="json")
        self.client.post(f"/api/meetings/{meeting.pk}/reopen", {}, format="json")

        end = self.client.post(
            f"/api/meetings/{meeting.pk}/end",
            {},
            format="json",
        )
        self.assertEqual(end.status_code, status.HTTP_200_OK)
        self.assertEqual(end.json()["status"], "completed")
        self.assertIsNotNone(end.json()["endedAt"])

    def test_non_member_cannot_reopen(self):
        meeting = self.create_default_meeting()
        self.login(self.maria)

        self.assertEqual(
            self.client.post(
                f"/api/meetings/{meeting.pk}/reopen",
                {},
                format="json",
            ).status_code,
            status.HTTP_404_NOT_FOUND,
        )

    def test_status_cannot_be_set_via_patch(self):
        meeting = self.create_default_meeting()
        self.login(self.alex)

        for target in ("live", "completed"):
            response = self.client.patch(
                f"/api/meetings/{meeting.pk}/",
                {"status": target},
                format="json",
            )
            self.assertEqual(
                response.status_code,
                status.HTTP_400_BAD_REQUEST,
            )

        meeting.refresh_from_db()
        self.assertEqual(meeting.status, "upcoming")

    def test_started_ended_timestamps_cannot_be_set_via_patch(self):
        meeting = self.create_default_meeting()
        self.login(self.alex)

        for field in ("startedAt", "endedAt"):
            response = self.client.patch(
                f"/api/meetings/{meeting.pk}/",
                {field: "2020-01-01T00:00:00Z"},
                format="json",
            )
            self.assertEqual(
                response.status_code,
                status.HTTP_400_BAD_REQUEST,
            )

    def test_non_member_cannot_start_or_end(self):
        meeting = self.create_default_meeting()

        # maria is not a member of the group.
        self.login(self.maria)

        self.assertEqual(
            self.client.post(
                f"/api/meetings/{meeting.pk}/start",
                {},
                format="json",
            ).status_code,
            status.HTTP_404_NOT_FOUND,
        )
        self.assertEqual(
            self.client.post(
                f"/api/meetings/{meeting.pk}/end",
                {},
                format="json",
            ).status_code,
            status.HTTP_404_NOT_FOUND,
        )

        meeting.refresh_from_db()
        self.assertEqual(meeting.status, "upcoming")

    def test_meeting_research_group_cannot_be_changed(self):
        meeting = self.create_default_meeting()

        self.login(self.alex)

        response = self.client.patch(
            f"/api/meetings/{meeting.pk}/",
            {
                "researchGroupId": 999,
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_400_BAD_REQUEST,
        )

        meeting.refresh_from_db()

        self.assertEqual(
            meeting.research_group,
            self.group,
        )

    def test_group_member_can_be_added_as_participant(self):
        meeting = self.create_default_meeting()

        self.login(self.alex)

        response = self.client.post(
            f"/api/meetings/{meeting.pk}/participants/",
            {
                "userId": self.chris.pk,
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_201_CREATED,
        )
        self.assertEqual(
            response.json()["user"]["id"],
            self.chris.pk,
        )

    def test_non_group_member_cannot_be_added_as_participant(self):
        meeting = self.create_default_meeting()

        self.login(self.alex)

        # maria is not a current Research Group member of the
        # Meeting's Research Group, so the group Meeting rejects her.
        response = self.client.post(
            f"/api/meetings/{meeting.pk}/participants/",
            {
                "userId": self.maria.pk,
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_400_BAD_REQUEST,
        )
        self.assertFalse(
            MeetingParticipant.objects.filter(
                meeting=meeting,
                user=self.maria,
            ).exists()
        )
        self.assertFalse(
            ResearchGroupMembership.objects.filter(
                research_group=self.group,
                user=self.maria,
            ).exists()
        )

    def test_participants_can_be_listed(self):
        meeting = self.create_default_meeting()

        add_meeting_participant(
            meeting=meeting,
            actor=self.alex,
            target_user=self.chris,
        )
        add_meeting_participant(
            meeting=meeting,
            actor=self.alex,
            target_user=self.laura,
        )

        self.login(self.laura)

        response = self.client.get(
            f"/api/meetings/{meeting.pk}/participants/"
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_200_OK,
        )

        user_ids = [
            participant["user"]["id"]
            for participant in response.json()
        ]

        self.assertEqual(
            user_ids,
            [
                self.alex.pk,
                self.chris.pk,
                self.laura.pk,
            ],
        )

    def test_participant_delete_is_scoped_to_meeting(self):
        first = self.create_default_meeting(
            title="First",
        )
        second = self.create_default_meeting(
            title="Second",
        )

        second_participant = add_meeting_participant(
            meeting=second,
            actor=self.alex,
            target_user=self.chris,
        )

        self.login(self.alex)

        response = self.client.delete(
            (
                f"/api/meetings/{first.pk}/participants/"
                f"{second_participant.pk}/"
            )
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_404_NOT_FOUND,
        )

        self.assertTrue(
            MeetingParticipant.objects.filter(
                pk=second_participant.pk,
            ).exists()
        )

    def test_participant_can_be_deleted(self):
        meeting = self.create_default_meeting()

        participant = add_meeting_participant(
            meeting=meeting,
            actor=self.alex,
            target_user=self.chris,
        )

        self.login(self.alex)

        response = self.client.delete(
            (
                f"/api/meetings/{meeting.pk}/participants/"
                f"{participant.pk}/"
            )
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_204_NO_CONTENT,
        )

        self.assertFalse(
            MeetingParticipant.objects.filter(
                pk=participant.pk,
            ).exists()
        )

    def test_group_member_can_create_meeting_item(self):
        meeting = self.create_default_meeting()
        add_meeting_participant(
            meeting=meeting, actor=self.alex, target_user=self.chris,
        )

        self.login(self.chris)

        section = MeetingSection.objects.get(meeting=meeting)

        response = self.client.post(
            f"/api/meetings/{meeting.pk}/items/",
            {
                "meetingSectionId": section.pk,
                "title": "Rewrite introduction",
                "notes": "Discuss scope.",
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_201_CREATED,
        )

        data = response.json()

        self.assertEqual(
            data["meetingId"],
            meeting.pk,
        )
        self.assertEqual(
            data["title"],
            "Rewrite introduction",
        )
        self.assertEqual(data["position"], 0)
        self.assertEqual(data["outcome"], "not_discussed")
        self.assertNotIn("status", data)
        self.assertEqual(data["workItemIds"], [])

    def test_created_meeting_item_response_carries_content(self):
        meeting = self.create_default_meeting()
        add_meeting_participant(
            meeting=meeting, actor=self.alex, target_user=self.chris,
        )

        self.login(self.chris)

        section = MeetingSection.objects.get(meeting=meeting)

        response = self.client.post(
            f"/api/meetings/{meeting.pk}/items/",
            {
                "meetingSectionId": section.pk,
                "title": "Rewrite introduction",
                "notes": "Discuss scope.",
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_201_CREATED,
        )

        data = response.json()

        # The legacy fields keep their exact contract...
        self.assertEqual(data["title"], "Rewrite introduction")
        self.assertEqual(data["contextNotes"], "Discuss scope.")
        self.assertEqual(data["notes"], [])
        # ...and the new persisted Markdown content is exposed
        # alongside them.
        self.assertEqual(
            data["content"],
            "Rewrite introduction\n\nDiscuss scope.",
        )

    def test_meeting_item_detail_exposes_content(self):
        meeting = self.create_default_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        create_meeting_item(
            meeting=meeting,
            meeting_section=section,
            actor=self.alex,
            title="First",
            notes="Initial context.",
        )

        self.login(self.alex)

        response = self.client.get(
            f"/api/meetings/{meeting.pk}/items/"
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()[0]

        self.assertEqual(data["title"], "First")
        self.assertEqual(data["contextNotes"], "Initial context.")
        self.assertEqual(
            data["content"],
            "First\n\nInitial context.",
        )

    def test_updated_meeting_item_response_carries_rederived_content(self):
        meeting = self.create_default_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        item = create_meeting_item(
            meeting=meeting,
            meeting_section=section,
            actor=self.alex,
            title="First",
            notes="Initial.",
        )

        self.login(self.alex)

        response = self.client.patch(
            f"/api/meeting-items/{item.pk}/",
            {"title": "First (renamed)"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)

        data = response.json()

        self.assertEqual(data["title"], "First (renamed)")
        self.assertEqual(data["contextNotes"], "Initial.")
        self.assertEqual(
            data["content"],
            "First (renamed)\n\nInitial.",
        )

    def test_create_rejects_client_supplied_content(self):
        meeting = self.create_default_meeting()
        self.login(self.alex)

        section = MeetingSection.objects.get(meeting=meeting)

        response = self.client.post(
            f"/api/meetings/{meeting.pk}/items/",
            {
                "meetingSectionId": section.pk,
                "title": "First",
                "content": "# Explicit markdown",
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_400_BAD_REQUEST,
        )
        self.assertIn("error", response.json())
        self.assertFalse(
            MeetingItem.objects.filter(meeting=meeting).exists()
        )

    def test_patch_rejects_client_supplied_content(self):
        meeting = self.create_default_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        item = create_meeting_item(
            meeting=meeting,
            meeting_section=section,
            actor=self.alex,
            title="First",
        )

        self.login(self.alex)

        response = self.client.patch(
            f"/api/meeting-items/{item.pk}/",
            {"content": "# Explicit markdown"},
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_400_BAD_REQUEST,
        )
        self.assertIn("error", response.json())

        # The rejection leaves the derived content untouched.
        item.refresh_from_db()
        self.assertEqual(item.content, "First")

    def test_group_member_can_list_meeting_items(self):
        meeting = self.create_default_meeting()
        add_meeting_participant(
            meeting=meeting, actor=self.alex, target_user=self.chris,
        )

        section = MeetingSection.objects.get(meeting=meeting)
        first = create_meeting_item(
            meeting=meeting,
            meeting_section=section,
            actor=self.alex,
            title="First",
        )
        second = create_meeting_item(
            meeting=meeting,
            meeting_section=section,
            actor=self.alex,
            title="Second",
        )

        self.login(self.chris)

        response = self.client.get(
            f"/api/meetings/{meeting.pk}/items/"
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_200_OK,
        )

        self.assertEqual(
            [item["id"] for item in response.json()],
            [
                first.pk,
                second.pk,
            ],
        )

    def test_group_member_can_patch_meeting_item(self):
        meeting = self.create_default_meeting()
        add_meeting_participant(
            meeting=meeting, actor=self.alex, target_user=self.chris,
        )

        item = create_meeting_item(
            meeting=meeting,
            meeting_section=MeetingSection.objects.get(meeting=meeting),
            actor=self.alex,
            title="Discussion",
        )

        self.login(self.chris)

        response = self.client.patch(
            f"/api/meeting-items/{item.pk}/",
            {
                "title": "Updated discussion",
                "notes": "Agreed.",
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_200_OK,
        )

        item.refresh_from_db()

        self.assertEqual(
            item.title,
            "Updated discussion",
        )
        self.assertEqual(
            item.notes,
            "Agreed.",
        )
        self.assertEqual(
            item.outcome,
            MeetingItem.Outcome.NOT_DISCUSSED,
        )

    def test_meeting_item_status_cannot_be_set_via_generic_patch(self):
        """Legacy compatibility: the removed `status`/`discussing`
        contract is rejected by the generic PATCH, so old clients
        cannot reintroduce the pre-0011 status field."""
        meeting = self.create_default_meeting()
        add_meeting_participant(
            meeting=meeting, actor=self.alex, target_user=self.chris,
        )

        item = create_meeting_item(
            meeting=meeting,
            meeting_section=MeetingSection.objects.get(meeting=meeting),
            actor=self.alex,
            title="Discussion",
        )

        self.login(self.chris)

        response = self.client.patch(
            f"/api/meeting-items/{item.pk}/",
            {
                "status": "discussing",
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_400_BAD_REQUEST,
        )

        item.refresh_from_db()

        self.assertEqual(
            item.outcome,
            MeetingItem.Outcome.NOT_DISCUSSED,
        )

    def test_meeting_item_outcome_cannot_be_set_via_generic_patch(self):
        meeting = self.create_default_meeting()
        add_meeting_participant(
            meeting=meeting, actor=self.alex, target_user=self.chris,
        )

        item = create_meeting_item(
            meeting=meeting,
            meeting_section=MeetingSection.objects.get(meeting=meeting),
            actor=self.alex,
            title="Discussion",
        )

        self.login(self.chris)

        response = self.client.patch(
            f"/api/meeting-items/{item.pk}/",
            {
                "outcome": "done",
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_400_BAD_REQUEST,
        )

        item.refresh_from_db()

        self.assertEqual(
            item.outcome,
            MeetingItem.Outcome.NOT_DISCUSSED,
        )

    def test_invalid_meeting_item_status_is_rejected(self):
        meeting = self.create_default_meeting()

        item = create_meeting_item(
            meeting=meeting,
            meeting_section=MeetingSection.objects.get(meeting=meeting),
            actor=self.alex,
            title="Discussion",
        )

        self.login(self.alex)

        response = self.client.patch(
            f"/api/meeting-items/{item.pk}/",
            {
                "status": "invalid",
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_400_BAD_REQUEST,
        )

    def test_meeting_item_cannot_be_moved_between_meetings(self):
        meeting = self.create_default_meeting()

        other = self.create_default_meeting(
            title="Other meeting",
        )

        item = create_meeting_item(
            meeting=meeting,
            meeting_section=MeetingSection.objects.get(meeting=meeting),
            actor=self.alex,
            title="Discussion",
        )

        self.login(self.alex)

        response = self.client.patch(
            f"/api/meeting-items/{item.pk}/",
            {
                "meetingId": other.pk,
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_400_BAD_REQUEST,
        )

        item.refresh_from_db()

        self.assertEqual(
            item.meeting,
            meeting,
        )

    def test_non_member_cannot_read_meeting_item(self):
        meeting = self.create_default_meeting()

        item = create_meeting_item(
            meeting=meeting,
            meeting_section=MeetingSection.objects.get(meeting=meeting),
            actor=self.alex,
            title="Private discussion",
        )

        self.login(self.maria)

        response = self.client.get(
            f"/api/meeting-items/{item.pk}/"
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_404_NOT_FOUND,
        )

    def test_meeting_create_requires_csrf_for_session_auth(self):
        client = APIClient(
            enforce_csrf_checks=True,
        )
        client.force_login(self.alex)

        url = (
            f"/api/research-groups/"
            f"{self.group.pk}/meetings/"
        )

        payload = {
            "title": "CSRF Weekly",
            "scheduledAt": self.scheduled_at.isoformat(),
        }

        denied = client.post(
            url,
            payload,
            format="json",
        )

        self.assertEqual(
            denied.status_code,
            status.HTTP_403_FORBIDDEN,
        )

        client.get("/api/auth/csrf/")

        csrf_token = (
            client.cookies["csrftoken"].value
        )

        allowed = client.post(
            url,
            payload,
            format="json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )

        self.assertEqual(
            allowed.status_code,
            status.HTTP_201_CREATED,
        )

    def test_stale_live_meeting_remains_live_and_can_be_ended(self):
        """A live Meeting past its scheduled time stays live (no
        auto-completion) and an authorized user can explicitly end it."""
        meeting = self.create_default_meeting()
        self.login(self.alex)

        self.client.post(
            f"/api/meetings/{meeting.pk}/start",
            {},
            format="json",
        )
        meeting.refresh_from_db()
        self.assertEqual(meeting.status, "live")

        # Simulate "far beyond the scheduled time" by moving the planned
        # timestamp into the past while the meeting stays live. No code
        # path may turn this into completed on its own.
        from datetime import timedelta

        meeting.scheduled_at = meeting.scheduled_at - timedelta(days=2)
        meeting.save(update_fields=["scheduled_at"])
        meeting.refresh_from_db()
        self.assertEqual(meeting.scheduled_at < timezone.now(), True)
        self.assertEqual(meeting.status, "live")
        self.assertIsNone(meeting.ended_at)

        # The stored representation must still be live (no auto-completion).
        read = self.client.get(f"/api/meetings/{meeting.pk}/")
        self.assertEqual(read.status_code, status.HTTP_200_OK)
        self.assertEqual(read.json()["status"], "live")
        self.assertIsNone(read.json()["endedAt"])

        # An authorized user can explicitly end it; that records the end.
        end = self.client.post(
            f"/api/meetings/{meeting.pk}/end",
            {},
            format="json",
        )
        self.assertEqual(end.status_code, status.HTTP_200_OK)
        self.assertEqual(end.json()["status"], "completed")
        self.assertIsNotNone(end.json()["endedAt"])
# ─────────────────────────────────────────────────────────────────
# Meeting access model — canonical read-access rule.
#
# A Meeting is visible/readable iff the user is the creator OR an
# explicit MeetingParticipant. Project membership (and, for a group
# Meeting, plain group membership) alone must NOT grant Meeting
# visibility to a user who is not a participant. Adding a
# participant requires only that the actor is the creator or an
# existing participant; the target user may be any existing
# application user without Research Group or Project membership.
# Meeting invitation grants Meeting read access only — it never
# creates Research Group or Project membership or Project
# permissions.
#
# The project-scoped Meeting below is used because its scope
# membership requires Project access, so a group member who is
# neither the creator, a participant, nor a Project member is a
# clean "denied" case under the new rule.
# ─────────────────────────────────────────────────────────────────


class MeetingAccessModelTest(TestCase):
    def setUp(self):
        self.client = APIClient()

        # Creator.
        self.alex = User.objects.create_user(
            username="access-alex", password="Pass1!",
        )
        # Group member WITHOUT Project membership (non-participant).
        self.chris = User.objects.create_user(
            username="access-chris", password="Pass1!",
        )
        # External user in neither the group nor the Project.
        self.sofia = User.objects.create_user(
            username="access-sofia", password="Pass1!",
        )
        self.group = ResearchGroup.objects.create(
            name="Access Group", created_by=self.alex,
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
        self.project = create_project(
            research_group=self.group,
            creator=self.alex,
            name="Access Project",
        )
        self.scheduled_at = timezone.now() + timedelta(days=1)

    def login(self, user):
        self.client.logout()
        self.client.force_login(user)

    def _project_meeting(self):
        return create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="P-Weekly",
            scheduled_at=self.scheduled_at,
            scope=Meeting.Scope.PROJECT,
            project=self.project,
        )

    # ── read access: creator and participants ────────────────────
    def test_creator_can_list_and_read_project_meeting(self):
        meeting = self._project_meeting()
        self.login(self.alex)

        listing = self.client.get(
            f"/api/research-groups/{self.group.pk}/meetings/"
        )
        self.assertEqual(listing.status_code, status.HTTP_200_OK)
        self.assertIn(
            meeting.pk,
            [m["id"] for m in listing.json()],
        )
        detail = self.client.get(f"/api/meetings/{meeting.pk}/")
        self.assertEqual(detail.status_code, status.HTTP_200_OK)

    def test_explicit_participant_can_list_and_read_project_meeting(self):
        meeting = self._project_meeting()
        add_project_membership(
            project=self.project,
            actor=self.alex,
            target_user=self.chris,
            role=ProjectMembership.Role.MEMBER,
        )
        add_meeting_participant(
            meeting=meeting, actor=self.alex, target_user=self.chris,
        )
        self.login(self.chris)

        listing = self.client.get(
            f"/api/research-groups/{self.group.pk}/meetings/"
        )
        self.assertEqual(listing.status_code, status.HTTP_200_OK)
        self.assertIn(
            meeting.pk,
            [m["id"] for m in listing.json()],
        )
        detail = self.client.get(f"/api/meetings/{meeting.pk}/")
        self.assertEqual(detail.status_code, status.HTTP_200_OK)

    def test_group_member_non_participant_cannot_read_project_meeting(self):
        meeting = self._project_meeting()
        # chris is a group member, not a participant, and not a
        # Project member.
        self.login(self.chris)

        listing = self.client.get(
            f"/api/research-groups/{self.group.pk}/meetings/"
        )
        self.assertEqual(listing.status_code, status.HTTP_200_OK)
        self.assertNotIn(
            meeting.pk,
            [m["id"] for m in listing.json()],
        )
        detail = self.client.get(f"/api/meetings/{meeting.pk}/")
        self.assertEqual(detail.status_code, status.HTTP_404_NOT_FOUND)

    def test_project_member_non_participant_cannot_read_project_meeting(self):
        meeting = self._project_meeting()
        add_project_membership(
            project=self.project,
            actor=self.alex,
            target_user=self.chris,
            role=ProjectMembership.Role.MEMBER,
        )
        # chris now has Project membership but is still NOT a
        # participant of this Meeting, and NOT the creator.
        self.login(self.chris)

        listing = self.client.get(
            f"/api/research-groups/{self.group.pk}/meetings/"
        )
        self.assertEqual(listing.status_code, status.HTTP_200_OK)
        self.assertNotIn(
            meeting.pk,
            [m["id"] for m in listing.json()],
        )
        detail = self.client.get(f"/api/meetings/{meeting.pk}/")
        self.assertEqual(detail.status_code, status.HTTP_404_NOT_FOUND)

    def test_group_admin_non_participant_cannot_read_project_meeting(self):
        meeting = self._project_meeting()
        admin2 = User.objects.create_user(
            username="access-admin2", password="Pass1!",
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=admin2,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        self.login(admin2)
        detail = self.client.get(f"/api/meetings/{meeting.pk}/")
        self.assertEqual(detail.status_code, status.HTTP_404_NOT_FOUND)

    # ── participant whose Project access later lapses ───────────
    def test_participant_whose_project_access_was_revoked_loses_read(self):
        """Canonical project Meeting read boundary: the
        creator/participant relationship AND a valid current
        ProjectMembership are both required. A stale participant
        relation (Project access removed later) grants neither read
        nor write access — non-leaking 404 on the detail and no
        discovery through the permission-filtered list."""
        meeting = self._project_meeting()
        add_project_membership(
            project=self.project,
            actor=self.alex,
            target_user=self.chris,
            role=ProjectMembership.Role.MEMBER,
        )
        add_meeting_participant(
            meeting=meeting, actor=self.alex, target_user=self.chris,
        )
        self.login(self.chris)

        # While the Project access is current, the participant reads.
        detail = self.client.get(f"/api/meetings/{meeting.pk}/")
        self.assertEqual(detail.status_code, status.HTTP_200_OK)

        # Removing the ProjectMembership revokes Meeting read: the
        # stale participant row alone grants nothing.
        self.project.memberships.filter(user=self.chris).delete()
        detail = self.client.get(f"/api/meetings/{meeting.pk}/")
        self.assertEqual(detail.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(
            detail.json(), {"error": "Meeting not found"}
        )
        write_response = self.client.patch(
            f"/api/meetings/{meeting.pk}/",
            {"title": "Revoked write"},
            format="json",
        )
        self.assertEqual(
            write_response.status_code,
            status.HTTP_404_NOT_FOUND,
        )

        # Discovery: the Meeting no longer appears in the
        # permission-filtered list for the stale participant.
        listing = self.client.get(
            f"/api/research-groups/{self.group.pk}/meetings/"
        )
        self.assertEqual(listing.status_code, status.HTTP_200_OK)
        self.assertNotIn(
            meeting.pk, [row["id"] for row in listing.json()]
        )

    def test_external_user_without_participation_cannot_read(self):
        meeting = self._project_meeting()
        self.login(self.sofia)
        detail = self.client.get(f"/api/meetings/{meeting.pk}/")
        self.assertEqual(detail.status_code, status.HTTP_404_NOT_FOUND)

    def test_meeting_access_does_not_grant_project_access(self):
        group_meeting = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="G-Weekly",
            scheduled_at=self.scheduled_at,
        )
        # chris is a Research Group member (so he reads the group
        # Meeting) but holds NO ProjectMembership.
        self.login(self.chris)

        # Read access to the Meeting (current group member).
        detail = self.client.get(f"/api/meetings/{group_meeting.pk}/")
        self.assertEqual(detail.status_code, status.HTTP_200_OK)

        # But NO Project access: the project detail and work items
        # remain 404.
        project_response = self.client.get(
            f"/api/projects/{self.project.pk}/"
        )
        self.assertEqual(
            project_response.status_code,
            status.HTTP_404_NOT_FOUND,
        )
        work_items = self.client.get(
            f"/api/projects/{self.project.pk}/work-items/"
        )
        self.assertEqual(work_items.status_code, status.HTTP_404_NOT_FOUND)

    # ── participant add: eligible users only ───────────────────
    def test_creator_cannot_add_user_without_project_access(self):
        meeting = self._project_meeting()
        self.login(self.alex)
        # sofia has no ProjectMembership, so the Project Meeting
        # rejects her; nothing is created as a side effect.
        response = self.client.post(
            f"/api/meetings/{meeting.pk}/participants/",
            {"userId": self.sofia.pk},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(
            MeetingParticipant.objects.filter(
                meeting=meeting,
                user=self.sofia,
            ).exists()
        )
        self.assertFalse(
            ProjectMembership.objects.filter(
                project=self.project,
                user=self.sofia,
            ).exists()
        )

    def test_participant_cannot_add_user_without_project_access(self):
        meeting = self._project_meeting()
        add_project_membership(
            project=self.project,
            actor=self.alex,
            target_user=self.chris,
            role=ProjectMembership.Role.MEMBER,
        )
        add_meeting_participant(
            meeting=meeting, actor=self.alex, target_user=self.chris,
        )
        self.login(self.chris)
        response = self.client.post(
            f"/api/meetings/{meeting.pk}/participants/",
            {"userId": self.sofia.pk},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_non_participant_group_member_cannot_add(self):
        meeting = self._project_meeting()
        # chris is a group member, not the creator, not a
        # participant.
        self.login(self.chris)
        # 404: she cannot see the meeting at all, so the POST is
        # denied via the same Meeting-not-found path.
        response = self.client.post(
            f"/api/meetings/{meeting.pk}/participants/",
            {"userId": self.sofia.pk},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_participant_add_does_not_create_group_membership(self):
        meeting = self._project_meeting()
        self.login(self.alex)
        self.client.post(
            f"/api/meetings/{meeting.pk}/participants/",
            {"userId": self.sofia.pk},
            format="json",
        )
        self.assertFalse(
            ResearchGroupMembership.objects.filter(
                research_group=self.group,
                user=self.sofia,
            ).exists()
        )

    def test_participant_add_does_not_create_project_membership(self):
        meeting = self._project_meeting()
        self.login(self.alex)
        self.client.post(
            f"/api/meetings/{meeting.pk}/participants/",
            {"userId": self.sofia.pk},
            format="json",
        )
        self.assertFalse(
            ProjectMembership.objects.filter(
                project=self.project,
                user=self.sofia,
            ).exists()
        )

    # ── nested read endpoints honor the rule ────────────────────
    def test_items_endpoint_denied_for_non_participant(self):
        meeting = self._project_meeting()
        self.login(self.chris)
        response = self.client.get(
            f"/api/meetings/{meeting.pk}/items/"
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_items_endpoint_allowed_for_participant(self):
        meeting = self._project_meeting()
        add_project_membership(
            project=self.project,
            actor=self.alex,
            target_user=self.chris,
            role=ProjectMembership.Role.MEMBER,
        )
        add_meeting_participant(
            meeting=meeting, actor=self.alex, target_user=self.chris,
        )
        self.login(self.chris)
        response = self.client.get(
            f"/api/meetings/{meeting.pk}/items/"
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
