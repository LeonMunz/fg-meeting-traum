from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import IntegrityError
from django.test import TestCase
from django.utils import timezone

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
    create_meeting,
    create_meeting_item,
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
        self.assertEqual(
            self.source_meeting.current_meeting_item,
            self.source_item,
        )
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

                with self.assertRaises(MeetingDomainError):
                    self._schedule(
                        target_meeting=target,
                        target_meeting_section=section,
                    )

                self._assert_no_schedule_writes()

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

    def test_identical_retry_reuses_existing_schedule(self):
        first = self._schedule()

        second = self._schedule()

        self.assertEqual(second.pk, first.pk)
        self.assertEqual(MeetingItemFollowUp.objects.count(), 1)
        self.assertEqual(
            MeetingItem.objects.filter(meeting=self.target_meeting).count(),
            1,
        )

    def test_conflicting_retry_is_rejected_without_changes(self):
        existing = self._schedule()
        other_target = self._create_meeting("Other target", days=14)
        other_section = MeetingSection.objects.get(meeting=other_target)

        with self.assertRaises(MeetingDomainError):
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
