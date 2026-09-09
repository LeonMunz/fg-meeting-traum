from datetime import timedelta

from django.contrib.auth import get_user_model
from django.core.exceptions import FieldDoesNotExist
from django.db import IntegrityError, transaction
from django.test import TestCase
from django.utils import timezone

from research_groups.models import ResearchGroup

from .models import (
    Meeting,
    MeetingItem,
    MeetingItemFollowUp,
    MeetingSection,
    MeetingSeries,
    MeetingSeriesSection,
)


User = get_user_model()


class MeetingItemFollowUpModelTest(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="follow-up-owner",
            password="Pass1!",
        )
        self.group = ResearchGroup.objects.create(
            name="Follow-up Group",
            created_by=self.user,
        )
        self.series = MeetingSeries.objects.create(
            research_group=self.group,
            title="FG Weekly",
            created_by=self.user,
        )
        self.series_section = MeetingSeriesSection.objects.create(
            meeting_series=self.series,
            name="Research",
            position=0,
        )
        self.source_meeting, self.source_section, self.source_item = (
            self._create_meeting_item("Source", days_from_now=1)
        )
        self.target_meeting, self.target_section, self.target_item = (
            self._create_meeting_item("Target", days_from_now=8)
        )

    def _create_meeting_item(self, title, *, days_from_now):
        meeting = Meeting.objects.create(
            research_group=self.group,
            series=self.series,
            title=f"{title} Meeting",
            scheduled_at=timezone.now() + timedelta(days=days_from_now),
            created_by=self.user,
        )
        section = MeetingSection.objects.create(
            meeting=meeting,
            source_series_section=self.series_section,
            name="Research",
            position=0,
        )
        item = MeetingItem.objects.create(
            meeting=meeting,
            meeting_section=section,
            title=f"{title} Topic Instance",
            position=0,
            created_by=self.user,
        )
        return meeting, section, item

    def _create_follow_up(self, **overrides):
        values = {
            "source_meeting_item": self.source_item,
            "target_meeting": self.target_meeting,
            "target_meeting_section": self.target_section,
            "target_meeting_item": self.target_item,
            "created_by": self.user,
        }
        values.update(overrides)
        return MeetingItemFollowUp.objects.create(**values)

    def test_scheduled_follow_up_preserves_concrete_traceability(self):
        follow_up = self._create_follow_up()

        self.assertEqual(self.target_meeting.status, Meeting.Status.UPCOMING)
        self.assertEqual(follow_up.source_meeting_item, self.source_item)
        self.assertEqual(follow_up.target_meeting, self.target_meeting)
        self.assertEqual(follow_up.target_meeting_section, self.target_section)
        self.assertEqual(follow_up.target_meeting_item, self.target_item)
        self.assertEqual(follow_up.status, MeetingItemFollowUp.Status.SCHEDULED)
        self.assertEqual(
            self.target_item.source_follow_up_schedules.get(),
            follow_up,
        )

    def test_all_concrete_target_references_are_required(self):
        for field_name in (
            "target_meeting",
            "target_meeting_section",
            "target_meeting_item",
        ):
            with self.subTest(field_name=field_name):
                with self.assertRaises(IntegrityError), transaction.atomic():
                    self._create_follow_up(**{field_name: None})

    def test_superseded_series_target_fields_are_not_persisted(self):
        for field_name in (
            "target_mode",
            "target_meeting_series",
            "source_series_section",
        ):
            with self.subTest(field_name=field_name):
                with self.assertRaises(FieldDoesNotExist):
                    MeetingItemFollowUp._meta.get_field(field_name)

    def test_lifecycle_contains_only_concrete_mvp_states(self):
        self.assertEqual(
            set(MeetingItemFollowUp.Status.values),
            {"scheduled", "needs_reschedule", "cancelled"},
        )

    def test_needs_reschedule_retains_original_concrete_target(self):
        follow_up = self._create_follow_up(
            status=MeetingItemFollowUp.Status.NEEDS_RESCHEDULE,
        )

        self.assertEqual(follow_up.target_meeting, self.target_meeting)
        self.assertEqual(follow_up.target_meeting_section, self.target_section)
        self.assertEqual(follow_up.target_meeting_item, self.target_item)

    def test_source_item_cannot_be_reused_as_target(self):
        with self.assertRaises(IntegrityError), transaction.atomic():
            self._create_follow_up(target_meeting_item=self.source_item)

    def test_second_non_cancelled_follow_up_for_source_is_rejected(self):
        self._create_follow_up()

        with self.assertRaises(IntegrityError), transaction.atomic():
            self._create_follow_up(
                status=MeetingItemFollowUp.Status.NEEDS_RESCHEDULE,
            )

    def test_cancelled_history_does_not_block_new_active_follow_up(self):
        cancelled = self._create_follow_up(
            status=MeetingItemFollowUp.Status.CANCELLED,
        )
        active = self._create_follow_up()

        self.assertNotEqual(cancelled.pk, active.pk)
        self.assertEqual(self.source_item.follow_up_schedules.count(), 2)
