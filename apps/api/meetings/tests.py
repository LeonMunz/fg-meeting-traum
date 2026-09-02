from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

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
    MeetingDomainError,
    add_meeting_participant,
    create_meeting,
    create_meeting_item,
    end_meeting,
    remove_meeting_participant,
    reopen_meeting,
    start_meeting,
    update_meeting_item,
    update_meeting,
)


User = get_user_model()


class MeetingDomainTest(TestCase):
    def setUp(self):
        self.alex = User.objects.create_user(
            username="alex-meeting",
            password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="chris-meeting",
            password="Pass1!",
        )
        self.maria = User.objects.create_user(
            username="maria-meeting",
            password="Pass1!",
        )

        self.group = ResearchGroup.objects.create(
            name="Meeting Research Group",
            created_by=self.alex,
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

        self.scheduled_at = (
            timezone.now() + timedelta(days=1)
        )

    def create_default_meeting(self):
        return create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="FG Weekly",
            scheduled_at=self.scheduled_at,
        )

    def test_research_group_member_can_create_meeting(self):
        meeting = self.create_default_meeting()

        self.assertEqual(
            meeting.status,
            Meeting.Status.UPCOMING,
        )
        self.assertEqual(
            meeting.research_group,
            self.group,
        )
        self.assertEqual(
            meeting.created_by,
            self.alex,
        )

    def test_creator_becomes_participant(self):
        meeting = self.create_default_meeting()

        self.assertTrue(
            MeetingParticipant.objects.filter(
                meeting=meeting,
                user=self.alex,
            ).exists()
        )

    def test_non_group_member_cannot_create_meeting(self):
        with self.assertRaises(MeetingDomainError):
            create_meeting(
                research_group=self.group,
                actor=self.maria,
                title="Forbidden",
                scheduled_at=self.scheduled_at,
            )

    def test_meeting_requires_title(self):
        with self.assertRaises(MeetingDomainError):
            create_meeting(
                research_group=self.group,
                actor=self.alex,
                title="   ",
                scheduled_at=self.scheduled_at,
            )

    def test_invalid_meeting_status_is_rejected(self):
        with self.assertRaises(MeetingDomainError):
            create_meeting(
                research_group=self.group,
                actor=self.alex,
                title="Invalid",
                scheduled_at=self.scheduled_at,
                status="invalid",
            )

    def test_group_member_can_be_added_as_participant(self):
        meeting = self.create_default_meeting()

        participant = add_meeting_participant(
            meeting=meeting,
            actor=self.alex,
            target_user=self.chris,
        )

        self.assertEqual(
            participant.user,
            self.chris,
        )

    def test_non_group_member_cannot_be_participant(self):
        meeting = self.create_default_meeting()

        with self.assertRaises(MeetingDomainError):
            add_meeting_participant(
                meeting=meeting,
                actor=self.alex,
                target_user=self.maria,
            )

    def test_duplicate_participant_is_rejected(self):
        meeting = self.create_default_meeting()

        add_meeting_participant(
            meeting=meeting,
            actor=self.alex,
            target_user=self.chris,
        )

        with self.assertRaises(MeetingDomainError):
            add_meeting_participant(
                meeting=meeting,
                actor=self.alex,
                target_user=self.chris,
            )

    def test_meeting_items_receive_sequential_positions(self):
        meeting = self.create_default_meeting()

        section = MeetingSection.objects.get(meeting=meeting)
        first = create_meeting_item(
            meeting=meeting,
            meeting_section=section,
            actor=self.alex,
            title="First item",
        )
        second = create_meeting_item(
            meeting=meeting,
            meeting_section=section,
            actor=self.alex,
            title="Second item",
        )

        self.assertEqual(first.position, 0)
        self.assertEqual(second.position, 1)

    def test_non_group_member_cannot_create_meeting_item(self):
        meeting = self.create_default_meeting()

        with self.assertRaises(MeetingDomainError):
            create_meeting_item(
                meeting=meeting,
                meeting_section=MeetingSection.objects.get(meeting=meeting),
                actor=self.maria,
                title="Forbidden item",
            )

    def test_meeting_metadata_can_be_updated(self):
        meeting = self.create_default_meeting()
        new_scheduled_at = (
            self.scheduled_at + timedelta(hours=2)
        )

        update_meeting(
            meeting=meeting,
            actor=self.alex,
            title="Updated Weekly",
            scheduled_at=new_scheduled_at,
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
        # Metadata edits must not move the lifecycle.
        self.assertEqual(
            meeting.status,
            Meeting.Status.UPCOMING,
        )

    def test_start_meeting_sets_status_and_started_at(self):
        meeting = self.create_default_meeting()

        started = start_meeting(meeting=meeting, actor=self.alex)

        self.assertEqual(started.status, Meeting.Status.LIVE)
        self.assertIsNotNone(started.started_at)
        self.assertIsNone(started.ended_at)

        # scheduled timestamp is preserved, not overwritten.
        self.assertEqual(started.scheduled_at, self.scheduled_at)

    def test_start_meeting_rejects_live_and_completed(self):
        meeting = self.create_default_meeting()
        start_meeting(meeting=meeting, actor=self.alex)

        with self.assertRaises(MeetingDomainError):
            start_meeting(meeting=meeting, actor=self.alex)

    def test_end_meeting_requires_live(self):
        meeting = self.create_default_meeting()

        with self.assertRaises(MeetingDomainError):
            end_meeting(meeting=meeting, actor=self.alex)

    def test_end_meeting_sets_status_and_ended_at(self):
        meeting = self.create_default_meeting()
        start_meeting(meeting=meeting, actor=self.alex)

        ended = end_meeting(meeting=meeting, actor=self.alex)

        self.assertEqual(ended.status, Meeting.Status.COMPLETED)
        self.assertIsNotNone(ended.ended_at)
        self.assertIsNotNone(ended.started_at)
        self.assertEqual(ended.scheduled_at, self.scheduled_at)

    def test_completed_meeting_cannot_restart(self):
        meeting = self.create_default_meeting()
        start_meeting(meeting=meeting, actor=self.alex)
        end_meeting(meeting=meeting, actor=self.alex)

        with self.assertRaises(MeetingDomainError):
            start_meeting(meeting=meeting, actor=self.alex)
        with self.assertRaises(MeetingDomainError):
            end_meeting(meeting=meeting, actor=self.alex)


    def test_reopen_completed_meeting_returns_to_live(self):
        meeting = self.create_default_meeting()
        start_meeting(meeting=meeting, actor=self.alex)
        meeting.refresh_from_db()
        started_at = meeting.started_at
        end_meeting(meeting=meeting, actor=self.alex)

        reopened = reopen_meeting(meeting=meeting, actor=self.alex)

        self.assertEqual(reopened.status, Meeting.Status.LIVE)
        self.assertIsNone(reopened.ended_at)
        # Original started_at is preserved.
        self.assertEqual(reopened.started_at, started_at)
        self.assertEqual(reopened.scheduled_at, self.scheduled_at)

    def test_reopen_rejects_upcoming_and_live(self):
        upcoming = self.create_default_meeting()
        with self.assertRaises(MeetingDomainError):
            reopen_meeting(meeting=upcoming, actor=self.alex)

        live = self.create_default_meeting()
        start_meeting(meeting=live, actor=self.alex)
        with self.assertRaises(MeetingDomainError):
            reopen_meeting(meeting=live, actor=self.alex)

    def test_reopened_meeting_can_be_ended_again(self):
        meeting = self.create_default_meeting()
        start_meeting(meeting=meeting, actor=self.alex)
        end_meeting(meeting=meeting, actor=self.alex)
        reopen_meeting(meeting=meeting, actor=self.alex)

        ended = end_meeting(meeting=meeting, actor=self.alex)
        self.assertEqual(ended.status, Meeting.Status.COMPLETED)
        self.assertIsNotNone(ended.ended_at)

    def test_update_meeting_does_not_accept_status(self):
        meeting = self.create_default_meeting()

        update_meeting(
            meeting=meeting,
            actor=self.alex,
            title="No lifecycle here",
        )

        meeting.refresh_from_db()
        self.assertEqual(meeting.title, "No lifecycle here")
        self.assertEqual(meeting.status, Meeting.Status.UPCOMING)

    def test_meeting_participant_can_be_removed(self):
        meeting = self.create_default_meeting()

        participant = add_meeting_participant(
            meeting=meeting,
            actor=self.alex,
            target_user=self.chris,
        )

        remove_meeting_participant(
            participant=participant,
            actor=self.alex,
        )

        self.assertFalse(
            MeetingParticipant.objects.filter(
                meeting=meeting,
                user=self.chris,
            ).exists()
        )

    def test_meeting_item_can_be_marked_discussed(self):
        meeting = self.create_default_meeting()

        item = create_meeting_item(
            meeting=meeting,
            meeting_section=MeetingSection.objects.get(meeting=meeting),
            actor=self.alex,
            title="Discussion",
        )

        update_meeting_item(
            meeting_item=item,
            actor=self.chris,
            status=MeetingItem.Status.DISCUSSED,
            notes="Reviewed by the group.",
        )

        item.refresh_from_db()

        self.assertEqual(
            item.status,
            MeetingItem.Status.DISCUSSED,
        )
        self.assertEqual(
            item.notes,
            "Reviewed by the group.",
        )
