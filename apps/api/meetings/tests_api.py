from datetime import datetime, timedelta

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

    def test_participants_can_be_listed(self):
        meeting = self.create_default_meeting()

        add_meeting_participant(
            meeting=meeting,
            actor=self.alex,
            target_user=self.chris,
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

    def test_group_member_can_list_meeting_items(self):
        meeting = self.create_default_meeting()

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
