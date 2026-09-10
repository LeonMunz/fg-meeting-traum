from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import IntegrityError
from django.test import TestCase
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from projects.models import ProjectMembership
from projects.services import add_project_membership, create_project

from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)

from .models import (
    Meeting,
    MeetingItem,
    MeetingItemFollowUp,
    MeetingNote,
    MeetingSection,
)
from .services import (
    MeetingDomainError,
    MeetingFollowUpConflictError,
    create_meeting,
    create_meeting_item,
    create_meeting_section,
    schedule_meeting_item_follow_up,
)


User = get_user_model()


class ScheduleMeetingItemFollowUpTest(TestCase):
    def setUp(self):
        self.actor = User.objects.create_user(
            username="follow-up-scheduler",
            password="Pass1!",
        )
        self.outsider = User.objects.create_user(
            username="follow-up-outsider",
            password="Pass1!",
        )
        self.group = ResearchGroup.objects.create(
            name="Follow-up scheduling group",
            created_by=self.actor,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.actor,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        self.source_meeting = self._create_meeting("Source", days=0)
        self.target_meeting = self._create_meeting("Target", days=7)
        self.source_section = MeetingSection.objects.get(
            meeting=self.source_meeting,
        )
        self.target_section = MeetingSection.objects.get(
            meeting=self.target_meeting,
        )
        self.source_item = create_meeting_item(
            meeting=self.source_meeting,
            meeting_section=self.source_section,
            actor=self.actor,
            title="Continue the experiment",
            notes="Historical item notes",
        )

    def _create_meeting(self, title, *, days, group=None, actor=None):
        return create_meeting(
            research_group=group or self.group,
            actor=actor or self.actor,
            title=f"{title} Meeting",
            scheduled_at=timezone.now() + timedelta(days=days),
        )

    def _schedule(self, **overrides):
        values = {
            "source_meeting_item": self.source_item,
            "target_meeting": self.target_meeting,
            "target_meeting_section": self.target_section,
            "actor": self.actor,
        }
        values.update(overrides)
        return schedule_meeting_item_follow_up(**values)

    def test_schedules_distinct_open_item_with_concrete_traceability(self):
        create_meeting_item(
            meeting=self.target_meeting,
            meeting_section=self.target_section,
            actor=self.actor,
            title="Existing target item",
        )
        self.source_item.outcome = MeetingItem.Outcome.DONE
        self.source_item.save(update_fields=["outcome", "updated_at"])
        self.source_meeting.current_meeting_item = self.source_item
        self.source_meeting.save(
            update_fields=["current_meeting_item", "updated_at"],
        )
        MeetingNote.objects.create(
            meeting_item=self.source_item,
            author=self.actor,
            content="Historical discussion note",
        )

        follow_up = self._schedule()

        self.source_item.refresh_from_db()
        self.source_meeting.refresh_from_db()
        target_item = follow_up.target_meeting_item
        self.assertEqual(self.source_item.meeting, self.source_meeting)
        self.assertNotEqual(target_item.pk, self.source_item.pk)
        self.assertEqual(target_item.meeting, self.target_meeting)
        self.assertEqual(target_item.meeting_section, self.target_section)
        self.assertEqual(target_item.title, self.source_item.title)
        self.assertEqual(target_item.position, 1)
        self.assertEqual(
            target_item.outcome,
            MeetingItem.Outcome.NOT_DISCUSSED,
        )
        self.assertEqual(target_item.notes, "")
        self.assertFalse(target_item.note_relations.exists())
        self.assertFalse(target_item.work_item_relations.exists())
        self.assertEqual(
            self.source_item.outcome,
            MeetingItem.Outcome.FOLLOW_UP,
        )
        self.assertIsNone(self.source_meeting.current_meeting_item)
        self.assertEqual(follow_up.source_meeting_item, self.source_item)
        self.assertEqual(follow_up.target_meeting, self.target_meeting)
        self.assertEqual(
            follow_up.target_meeting_section,
            self.target_section,
        )
        self.assertEqual(follow_up.target_meeting_item, target_item)
        self.assertEqual(
            follow_up.status,
            MeetingItemFollowUp.Status.SCHEDULED,
        )
        self.assertEqual(follow_up.created_by, self.actor)

    def test_scheduling_current_advances_across_sections_and_skips_resolved(self):
        later_source_item = create_meeting_item(
            meeting=self.source_meeting,
            meeting_section=self.source_section,
            actor=self.actor,
            title="Already done",
        )
        later_source_item.outcome = MeetingItem.Outcome.DONE
        later_source_item.save(update_fields=["outcome", "updated_at"])
        next_section = create_meeting_section(
            meeting=self.source_meeting,
            actor=self.actor,
            name="Decisions",
        )
        followed_up_item = create_meeting_item(
            meeting=self.source_meeting,
            meeting_section=next_section,
            actor=self.actor,
            title="Already followed up",
        )
        followed_up_item.outcome = MeetingItem.Outcome.FOLLOW_UP
        followed_up_item.save(update_fields=["outcome", "updated_at"])
        next_open_item = create_meeting_item(
            meeting=self.source_meeting,
            meeting_section=next_section,
            actor=self.actor,
            title="Next open item",
        )
        self.source_meeting.current_meeting_item = self.source_item
        self.source_meeting.save(
            update_fields=["current_meeting_item", "updated_at"],
        )

        self._schedule()

        self.source_meeting.refresh_from_db()
        self.assertEqual(
            self.source_meeting.current_meeting_item,
            next_open_item,
        )

    def test_scheduling_non_current_item_preserves_current(self):
        current_item = create_meeting_item(
            meeting=self.source_meeting,
            meeting_section=self.source_section,
            actor=self.actor,
            title="Current discussion",
        )
        self.source_meeting.current_meeting_item = current_item
        self.source_meeting.save(
            update_fields=["current_meeting_item", "updated_at"],
        )

        self._schedule()

        self.source_meeting.refresh_from_db()
        self.assertEqual(
            self.source_meeting.current_meeting_item,
            current_item,
        )

    def test_scheduling_current_without_later_open_item_clears_current(self):
        last_item = create_meeting_item(
            meeting=self.source_meeting,
            meeting_section=self.source_section,
            actor=self.actor,
            title="Last agenda item",
        )
        self.source_meeting.current_meeting_item = last_item
        self.source_meeting.save(
            update_fields=["current_meeting_item", "updated_at"],
        )

        self._schedule(source_meeting_item=last_item)

        self.source_meeting.refresh_from_db()
        self.assertIsNone(self.source_meeting.current_meeting_item)
        self.source_item.refresh_from_db()
        self.assertEqual(
            self.source_item.outcome,
            MeetingItem.Outcome.NOT_DISCUSSED,
        )

    def test_live_and_completed_targets_are_rejected_without_writes(self):
        for target_status in (
            Meeting.Status.LIVE,
            Meeting.Status.COMPLETED,
        ):
            with self.subTest(target_status=target_status):
                target = self._create_meeting(target_status, days=14)
                section = MeetingSection.objects.get(meeting=target)
                target.status = target_status
                target.save(update_fields=["status", "updated_at"])
                self.source_meeting.current_meeting_item = self.source_item
                self.source_meeting.save(
                    update_fields=["current_meeting_item", "updated_at"],
                )

                with self.assertRaises(MeetingDomainError):
                    self._schedule(
                        target_meeting=target,
                        target_meeting_section=section,
                    )

                self._assert_no_schedule_writes()
                self.source_meeting.refresh_from_db()
                self.assertEqual(
                    self.source_meeting.current_meeting_item,
                    self.source_item,
                )

    def test_source_meeting_cannot_be_target(self):
        with self.assertRaises(MeetingDomainError):
            self._schedule(
                target_meeting=self.source_meeting,
                target_meeting_section=self.source_section,
            )

        self._assert_no_schedule_writes()

    def test_section_from_another_meeting_is_rejected(self):
        other = self._create_meeting("Other target", days=21)
        other_section = MeetingSection.objects.get(meeting=other)

        with self.assertRaises(MeetingDomainError):
            self._schedule(target_meeting_section=other_section)

        self._assert_no_schedule_writes()

    def test_hidden_target_section_is_rejected(self):
        self.target_section.is_visible = False
        self.target_section.save(update_fields=["is_visible"])

        with self.assertRaises(MeetingDomainError):
            self._schedule()

        self._assert_no_schedule_writes()

    def test_actor_without_target_write_access_is_rejected(self):
        other_group = ResearchGroup.objects.create(
            name="Private target group",
            created_by=self.outsider,
        )
        ResearchGroupMembership.objects.create(
            research_group=other_group,
            user=self.outsider,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        inaccessible_target = self._create_meeting(
            "Inaccessible target",
            days=7,
            group=other_group,
            actor=self.outsider,
        )
        inaccessible_section = MeetingSection.objects.get(
            meeting=inaccessible_target,
        )

        with self.assertRaises(MeetingDomainError):
            self._schedule(
                target_meeting=inaccessible_target,
                target_meeting_section=inaccessible_section,
            )

        self._assert_no_schedule_writes()

    def test_failure_after_follow_up_insert_rolls_back_every_write(self):
        self.source_meeting.current_meeting_item = self.source_item
        self.source_meeting.save(
            update_fields=["current_meeting_item", "updated_at"],
        )
        original_create = MeetingItemFollowUp.objects.create

        def create_then_fail(**kwargs):
            original_create(**kwargs)
            raise IntegrityError("forced failure after follow-up insert")

        with patch.object(
            MeetingItemFollowUp.objects,
            "create",
            side_effect=create_then_fail,
        ):
            with self.assertRaises(IntegrityError):
                self._schedule()

        self._assert_no_schedule_writes()
        self.source_meeting.refresh_from_db()
        self.assertEqual(
            self.source_meeting.current_meeting_item,
            self.source_item,
        )

    def test_identical_retry_reuses_existing_schedule(self):
        next_item = create_meeting_item(
            meeting=self.source_meeting,
            meeting_section=self.source_section,
            actor=self.actor,
            title="Next item",
        )
        later_item = create_meeting_item(
            meeting=self.source_meeting,
            meeting_section=self.source_section,
            actor=self.actor,
            title="Later item",
        )
        self.source_meeting.current_meeting_item = self.source_item
        self.source_meeting.save(
            update_fields=["current_meeting_item", "updated_at"],
        )
        first = self._schedule()

        self.source_meeting.refresh_from_db()
        self.assertEqual(self.source_meeting.current_meeting_item, next_item)

        second = self._schedule()

        self.source_meeting.refresh_from_db()
        self.assertEqual(second.pk, first.pk)
        self.assertEqual(self.source_meeting.current_meeting_item, next_item)
        self.assertNotEqual(self.source_meeting.current_meeting_item, later_item)
        self.assertEqual(MeetingItemFollowUp.objects.count(), 1)
        self.assertEqual(
            MeetingItem.objects.filter(meeting=self.target_meeting).count(),
            1,
        )

    def test_conflicting_retry_is_rejected_without_changes(self):
        existing = self._schedule()
        other_target = self._create_meeting("Other target", days=14)
        other_section = MeetingSection.objects.get(meeting=other_target)

        with self.assertRaises(MeetingFollowUpConflictError):
            self._schedule(
                target_meeting=other_target,
                target_meeting_section=other_section,
            )

        existing.refresh_from_db()
        self.source_item.refresh_from_db()
        self.assertEqual(MeetingItemFollowUp.objects.count(), 1)
        self.assertEqual(existing.target_meeting, self.target_meeting)
        self.assertEqual(existing.target_meeting_section, self.target_section)
        self.assertEqual(
            MeetingItem.objects.filter(meeting=other_target).count(),
            0,
        )
        self.assertEqual(
            self.source_item.outcome,
            MeetingItem.Outcome.FOLLOW_UP,
        )

    def _assert_no_schedule_writes(self):
        self.source_item.refresh_from_db()
        self.assertEqual(
            self.source_item.outcome,
            MeetingItem.Outcome.NOT_DISCUSSED,
        )
        self.assertEqual(MeetingItemFollowUp.objects.count(), 0)
        self.assertEqual(
            MeetingItem.objects.exclude(pk=self.source_item.pk).count(),
            0,
        )


class ScheduleMeetingItemFollowUpAPITest(TestCase):
    def setUp(self):
        self.actor = User.objects.create_user(
            username="follow-up-api-actor",
            password="Pass1!",
        )
        self.viewer = User.objects.create_user(
            username="follow-up-api-viewer",
            password="Pass1!",
        )
        self.outsider = User.objects.create_user(
            username="follow-up-api-outsider",
            password="Pass1!",
        )
        self.group = ResearchGroup.objects.create(
            name="Follow-up API group",
            created_by=self.actor,
        )
        for user in (self.actor, self.viewer):
            ResearchGroupMembership.objects.create(
                research_group=self.group,
                user=user,
                role=ResearchGroupMembership.Role.MEMBER,
            )

        self.source_meeting = self._create_meeting("Source", days=0)
        self.target_meeting = self._create_meeting("Target", days=7)
        self.source_section = MeetingSection.objects.get(
            meeting=self.source_meeting,
        )
        self.target_section = MeetingSection.objects.get(
            meeting=self.target_meeting,
        )
        self.source_item = create_meeting_item(
            meeting=self.source_meeting,
            meeting_section=self.source_section,
            actor=self.actor,
            title="Continue the API experiment",
        )
        self.client = APIClient()
        self.client.force_login(self.actor)

    def _create_meeting(
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
            title=f"{title} Meeting",
            scheduled_at=timezone.now() + timedelta(days=days),
            scope=scope,
            project=project,
        )

    def _post(self, **payload):
        data = {
            "targetMeetingId": self.target_meeting.pk,
            "targetMeetingSectionId": self.target_section.pk,
        }
        data.update(payload)
        return self.client.post(
            (
                f"/api/meeting-items/{self.source_item.pk}"
                "/schedule-follow-up"
            ),
            data,
            format="json",
        )

    def _assert_no_schedule_writes(self, *, meeting=None):
        self.source_item.refresh_from_db()
        self.assertEqual(
            self.source_item.outcome,
            MeetingItem.Outcome.NOT_DISCUSSED,
        )
        self.assertEqual(MeetingItemFollowUp.objects.count(), 0)
        self.assertEqual(
            MeetingItem.objects.filter(
                meeting=meeting or self.target_meeting,
            ).count(),
            0,
        )

    def test_post_schedules_and_reload_exposes_compact_active_schedule(self):
        before = self.client.get(
            f"/api/meeting-items/{self.source_item.pk}/"
        )
        self.assertEqual(before.status_code, status.HTTP_200_OK)
        self.assertIsNone(before.json()["followUpSchedule"])

        response = self._post()

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        self.assertEqual(
            set(data),
            {
                "id",
                "status",
                "sourceMeetingItemId",
                "sourceOutcome",
                "targetMeetingId",
                "targetMeetingTitle",
                "targetMeetingScheduledAt",
                "targetMeetingSectionId",
                "targetMeetingSectionName",
                "targetMeetingItemId",
                "createdAt",
                "updatedAt",
            },
        )
        self.assertEqual(data["status"], "scheduled")
        self.assertEqual(data["sourceMeetingItemId"], self.source_item.pk)
        self.assertEqual(data["sourceOutcome"], "follow_up")
        self.assertEqual(data["targetMeetingId"], self.target_meeting.pk)
        self.assertEqual(data["targetMeetingTitle"], "Target Meeting")
        self.assertEqual(
            data["targetMeetingSectionId"],
            self.target_section.pk,
        )
        self.assertEqual(
            data["targetMeetingSectionName"],
            self.target_section.name,
        )

        self.source_item.refresh_from_db()
        self.assertEqual(
            self.source_item.outcome,
            MeetingItem.Outcome.FOLLOW_UP,
        )
        target_item = MeetingItem.objects.get(
            pk=data["targetMeetingItemId"],
        )
        self.assertEqual(target_item.meeting, self.target_meeting)
        self.assertEqual(target_item.meeting_section, self.target_section)

        detail = self.client.get(
            f"/api/meeting-items/{self.source_item.pk}/"
        )
        listed = self.client.get(
            f"/api/meetings/{self.source_meeting.pk}/items/"
        )
        self.assertEqual(
            detail.json()["followUpSchedule"],
            data,
        )
        self.assertEqual(
            listed.json()[0]["followUpSchedule"],
            data,
        )

    def test_identical_retry_returns_existing_schedule_without_duplicates(self):
        first = self._post()
        second = self._post()

        self.assertEqual(first.status_code, status.HTTP_200_OK)
        self.assertEqual(second.status_code, status.HTTP_200_OK)
        self.assertEqual(second.json(), first.json())
        self.assertEqual(MeetingItemFollowUp.objects.count(), 1)
        self.assertEqual(
            MeetingItem.objects.filter(meeting=self.target_meeting).count(),
            1,
        )

    def test_conflicting_schedule_returns_409_and_preserves_original(self):
        first = self._post().json()
        other = self._create_meeting("Other target", days=14)
        other_section = MeetingSection.objects.get(meeting=other)

        response = self._post(
            targetMeetingId=other.pk,
            targetMeetingSectionId=other_section.pk,
        )

        self.assertEqual(response.status_code, status.HTTP_409_CONFLICT)
        follow_up = MeetingItemFollowUp.objects.get()
        self.assertEqual(follow_up.pk, first["id"])
        self.assertEqual(follow_up.target_meeting, self.target_meeting)
        self.assertEqual(MeetingItem.objects.filter(meeting=other).count(), 0)

    def test_live_and_completed_targets_return_400_without_orphans(self):
        for meeting_status in (Meeting.Status.LIVE, Meeting.Status.COMPLETED):
            with self.subTest(meeting_status=meeting_status):
                target = self._create_meeting(meeting_status, days=14)
                section = MeetingSection.objects.get(meeting=target)
                target.status = meeting_status
                target.save(update_fields=["status", "updated_at"])

                response = self._post(
                    targetMeetingId=target.pk,
                    targetMeetingSectionId=section.pk,
                )

                self.assertEqual(
                    response.status_code,
                    status.HTTP_400_BAD_REQUEST,
                )
                self._assert_no_schedule_writes(meeting=target)

    def test_source_meeting_and_foreign_section_return_400_without_orphans(self):
        cases = (
            (self.source_meeting, self.source_section),
            (self.target_meeting, self.source_section),
        )
        for target, section in cases:
            with self.subTest(target=target.pk, section=section.pk):
                response = self._post(
                    targetMeetingId=target.pk,
                    targetMeetingSectionId=section.pk,
                )
                self.assertEqual(
                    response.status_code,
                    status.HTTP_400_BAD_REQUEST,
                )
                self._assert_no_schedule_writes()

    def test_invalid_and_inaccessible_ids_follow_api_conventions(self):
        missing_field = self.client.post(
            (
                f"/api/meeting-items/{self.source_item.pk}"
                "/schedule-follow-up"
            ),
            {"targetMeetingId": self.target_meeting.pk},
            format="json",
        )
        self.assertEqual(
            missing_field.status_code,
            status.HTTP_400_BAD_REQUEST,
        )
        self.assertIn("targetMeetingSectionId", missing_field.json())

        missing_target = self._post(targetMeetingId=999999)
        missing_section = self._post(targetMeetingSectionId=999999)
        self.assertEqual(missing_target.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(missing_section.status_code, status.HTTP_404_NOT_FOUND)

        missing_source = self.client.post(
            "/api/meeting-items/999999/schedule-follow-up",
            {
                "targetMeetingId": self.target_meeting.pk,
                "targetMeetingSectionId": self.target_section.pk,
            },
            format="json",
        )
        self.assertEqual(missing_source.status_code, status.HTTP_404_NOT_FOUND)

        self.client.force_login(self.outsider)
        inaccessible_source = self._post()
        self.assertEqual(
            inaccessible_source.status_code,
            status.HTTP_404_NOT_FOUND,
        )
        self._assert_no_schedule_writes()

    def test_inaccessible_and_unwritable_targets_are_rejected(self):
        other_group = ResearchGroup.objects.create(
            name="Private target group",
            created_by=self.outsider,
        )
        ResearchGroupMembership.objects.create(
            research_group=other_group,
            user=self.outsider,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        private_target = self._create_meeting(
            "Private target",
            days=14,
            group=other_group,
            actor=self.outsider,
        )
        private_section = MeetingSection.objects.get(meeting=private_target)
        inaccessible = self._post(
            targetMeetingId=private_target.pk,
            targetMeetingSectionId=private_section.pk,
        )
        self.assertEqual(inaccessible.status_code, status.HTTP_404_NOT_FOUND)
        self._assert_no_schedule_writes(meeting=private_target)

        project = create_project(
            research_group=self.group,
            creator=self.actor,
            name="Read-only target",
        )
        add_project_membership(
            project=project,
            actor=self.actor,
            target_user=self.viewer,
            role=ProjectMembership.Role.VIEWER,
        )
        project_target = self._create_meeting(
            "Project target",
            days=21,
            scope=Meeting.Scope.PROJECT,
            project=project,
        )
        project_section = MeetingSection.objects.get(meeting=project_target)

        self.client.force_login(self.viewer)
        unwritable = self._post(
            targetMeetingId=project_target.pk,
            targetMeetingSectionId=project_section.pk,
        )
        # self.viewer is not a participant of the source meeting,
        # so the source is not visible to her (404).
        self.assertEqual(unwritable.status_code, status.HTTP_404_NOT_FOUND)
        self._assert_no_schedule_writes(meeting=project_target)

    def test_unwritable_source_is_rejected(self):
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
        source = self._create_meeting(
            "Project source",
            days=0,
            scope=Meeting.Scope.PROJECT,
            project=project,
        )
        section = MeetingSection.objects.get(meeting=source)
        self.source_item = create_meeting_item(
            meeting=source,
            meeting_section=section,
            actor=self.actor,
            title="Read-only item",
        )

        self.client.force_login(self.viewer)
        response = self._post()
        # self.viewer is not a participant of the source meeting,
        # so the source is not visible to her (404).
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self._assert_no_schedule_writes()

    def test_cancelled_schedule_is_not_exposed_as_active(self):
        response = self._post()
        follow_up = MeetingItemFollowUp.objects.get(pk=response.json()["id"])
        follow_up.status = MeetingItemFollowUp.Status.CANCELLED
        follow_up.save(update_fields=["status", "updated_at"])

        detail = self.client.get(
            f"/api/meeting-items/{self.source_item.pk}/"
        )
        self.assertEqual(detail.status_code, status.HTTP_200_OK)
        self.assertIsNone(detail.json()["followUpSchedule"])
