"""Domain-level tests for safe cancellation of scheduled follow-ups."""

from datetime import timedelta

from django.contrib.auth import get_user_model
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
    create_meeting,
    create_meeting_item,
    create_meeting_section,
    cancel_meeting_item_follow_up,
    schedule_meeting_item_follow_up,
    update_meeting_item,
)


User = get_user_model()


class CancelFollowUpBase(TestCase):
    """Shared fixtures: one source item in an upcoming source meeting,
    one upcoming target meeting, and a helper to schedule a follow-up."""

    def setUp(self):
        self.actor = User.objects.create_user(
            username="cancel-actor", password="Pass1!",
        )
        self.other = User.objects.create_user(
            username="cancel-other", password="Pass1!",
        )
        self.group = ResearchGroup.objects.create(
            name="Cancel group", created_by=self.actor,
        )
        for user in (self.actor, self.other):
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
            title="Source topic",
        )

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

    def _schedule(self):
        return schedule_meeting_item_follow_up(
            source_meeting_item=self.source_item,
            target_meeting=self.target_meeting,
            target_meeting_section=self.target_section,
            actor=self.actor,
        )

    def _cancel(self, follow_up, *, actor=None):
        return cancel_meeting_item_follow_up(
            follow_up_id=follow_up.pk,
            actor=actor or self.actor,
        )


class CancelFollowUpDomainTest(CancelFollowUpBase):
    # ── Core happy path ───────────────────────────────────────────

    def test_cancelling_scheduled_follow_up_reopens_source_and_cancels_relation(self):
        follow_up = self._schedule()
        self.source_item.refresh_from_db()
        self.assertEqual(self.source_item.outcome, MeetingItem.Outcome.FOLLOW_UP)
        self.assertEqual(follow_up.status, MeetingItemFollowUp.Status.SCHEDULED)

        result = self._cancel(follow_up)

        result.refresh_from_db()
        self.source_item.refresh_from_db()
        self.assertEqual(result.status, MeetingItemFollowUp.Status.CANCELLED)
        self.assertEqual(
            self.source_item.outcome,
            MeetingItem.Outcome.NOT_DISCUSSED,
        )
        # The follow-up record still exists.
        self.assertTrue(
            MeetingItemFollowUp.objects.filter(pk=follow_up.pk).exists()
        )

    def test_cancellation_preserves_current_when_another_item_is_current(self):
        other_item = create_meeting_item(
            meeting=self.source_meeting,
            meeting_section=self.source_section,
            actor=self.actor,
            title="Current item",
        )
        self.source_meeting.current_meeting_item = other_item
        self.source_meeting.save(
            update_fields=["current_meeting_item", "updated_at"],
        )
        follow_up = self._schedule()

        self._cancel(follow_up)

        self.source_meeting.refresh_from_db()
        self.assertEqual(
            self.source_meeting.current_meeting_item,
            other_item,
        )

    def test_cancellation_preserves_null_current(self):
        follow_up = self._schedule()

        self._cancel(follow_up)

        self.source_meeting.refresh_from_db()
        self.assertIsNone(self.source_meeting.current_meeting_item)

    def test_cancellation_preserves_current_when_source_is_current(self):
        # Unusual persisted state: source item IS the current item.
        self.source_meeting.current_meeting_item = self.source_item
        self.source_meeting.save(
            update_fields=["current_meeting_item", "updated_at"],
        )
        follow_up = self._schedule()
        # Scheduling advances current since source was current.
        # After cancellation, current must remain whatever it was
        # after scheduling — cancellation never touches current.
        self.source_meeting.refresh_from_db()
        current_after_schedule = self.source_meeting.current_meeting_item_id

        self._cancel(follow_up)

        self.source_meeting.refresh_from_db()
        self.assertEqual(
            self.source_meeting.current_meeting_item_id,
            current_after_schedule,
        )

    # ── Idempotency ───────────────────────────────────────────────

    def test_repeated_cancel_is_idempotent(self):
        follow_up = self._schedule()

        first = self._cancel(follow_up)
        self.assertEqual(first.status, MeetingItemFollowUp.Status.CANCELLED)

        second = self._cancel(follow_up)
        second.refresh_from_db()
        self.assertEqual(second.status, MeetingItemFollowUp.Status.CANCELLED)

        # Source was reopened only once.
        self.source_item.refresh_from_db()
        self.assertEqual(
            self.source_item.outcome,
            MeetingItem.Outcome.NOT_DISCUSSED,
        )

        # No new follow-up records.
        self.assertEqual(
            MeetingItemFollowUp.objects.filter(
                source_meeting_item=self.source_item,
            ).count(),
            1,
        )

    def test_cancel_f1_then_schedule_f2_then_cancel_f1_again_does_not_touch_f2(self):
        """Late/old Cancel F1 must never cancel a newer active F2."""
        f1 = self._schedule()
        self._cancel(f1)

        # Now schedule F2 (allowed: one active at a time, F1 is cancelled).
        f2 = self._schedule()
        f2.refresh_from_db()
        self.assertEqual(f2.status, MeetingItemFollowUp.Status.SCHEDULED)
        self.source_item.refresh_from_db()
        self.assertEqual(self.source_item.outcome, MeetingItem.Outcome.FOLLOW_UP)

        # Late retry of F1: idempotent, must not affect F2.
        result = self._cancel(f1)
        result.refresh_from_db()
        self.assertEqual(result.status, MeetingItemFollowUp.Status.CANCELLED)

        f2.refresh_from_db()
        self.source_item.refresh_from_db()
        self.assertEqual(f2.status, MeetingItemFollowUp.Status.SCHEDULED)
        self.assertEqual(self.source_item.outcome, MeetingItem.Outcome.FOLLOW_UP)

    # ── Inconsistent state rejection ──────────────────────────────

    def test_cancel_rejected_when_source_outcome_is_not_follow_up(self):
        follow_up = self._schedule()
        # Simulate drift: source outcome is no longer follow_up.
        self.source_item.outcome = MeetingItem.Outcome.DONE
        self.source_item.save(update_fields=["outcome", "updated_at"])

        with self.assertRaises(MeetingDomainError):
            self._cancel(follow_up)

        # No mutation occurred.
        follow_up.refresh_from_db()
        self.assertEqual(
            follow_up.status,
            MeetingItemFollowUp.Status.SCHEDULED,
        )

    def test_cancel_rejected_when_follow_up_status_is_needs_reschedule(self):
        follow_up = self._schedule()
        # Simulate: follow-up status drifted to needs_reschedule
        # while source is still follow_up.
        follow_up.status = MeetingItemFollowUp.Status.NEEDS_RESCHEDULE
        follow_up.save(update_fields=["status", "updated_at"])

        with self.assertRaises(MeetingDomainError):
            self._cancel(follow_up)

        follow_up.refresh_from_db()
        self.assertEqual(
            follow_up.status,
            MeetingItemFollowUp.Status.NEEDS_RESCHEDULE,
        )

    # ── Historical target Meeting guard ───────────────────────────

    def test_cancel_rejected_when_target_is_live(self):
        follow_up = self._schedule()
        self.target_meeting.status = Meeting.Status.LIVE
        self.target_meeting.save(update_fields=["status", "updated_at"])

        with self.assertRaises(MeetingDomainError):
            self._cancel(follow_up)

        follow_up.refresh_from_db()
        self.source_item.refresh_from_db()
        self.assertEqual(
            follow_up.status,
            MeetingItemFollowUp.Status.SCHEDULED,
        )
        self.assertEqual(
            self.source_item.outcome,
            MeetingItem.Outcome.FOLLOW_UP,
        )

    def test_cancel_rejected_when_target_is_completed(self):
        follow_up = self._schedule()
        self.target_meeting.status = Meeting.Status.COMPLETED
        self.target_meeting.save(update_fields=["status", "updated_at"])

        with self.assertRaises(MeetingDomainError):
            self._cancel(follow_up)

        follow_up.refresh_from_db()
        self.source_item.refresh_from_db()
        self.assertEqual(
            follow_up.status,
            MeetingItemFollowUp.Status.SCHEDULED,
        )
        self.assertEqual(
            self.source_item.outcome,
            MeetingItem.Outcome.FOLLOW_UP,
        )

    # ── Target deletion: pristine → delete ────────────────────────

    def test_pristine_generated_target_is_deleted_on_cancellation(self):
        follow_up = self._schedule()
        target_item_pk = follow_up.target_meeting_item_id
        self.assertIsNotNone(target_item_pk)
        self.assertEqual(
            MeetingItem.objects.filter(pk=target_item_pk).count(),
            1,
        )

        self._cancel(follow_up)

        self.assertEqual(
            MeetingItem.objects.filter(pk=target_item_pk).count(),
            0,
        )
        # The follow-up record still exists and target_meeting_item
        # is now NULL (SET_NULL semantics via explicit clear).
        follow_up.refresh_from_db()
        self.assertIsNone(follow_up.target_meeting_item_id)
        self.assertIsNotNone(follow_up.target_meeting_id)
        self.assertIsNotNone(follow_up.target_meeting_section_id)

    # ── Target preservation: edited title ─────────────────────────

    def test_title_changed_target_is_preserved(self):
        follow_up = self._schedule()
        target_item = follow_up.target_meeting_item
        update_meeting_item(
            meeting_item=target_item,
            actor=self.actor,
            title="Renamed target",
        )

        self._cancel(follow_up)

        target_item.refresh_from_db()
        self.assertTrue(MeetingItem.objects.filter(pk=target_item.pk).exists())
        self.assertEqual(target_item.title, "Renamed target")
        # Follow-up is cancelled, source reopened.
        follow_up.refresh_from_db()
        self.source_item.refresh_from_db()
        self.assertEqual(
            follow_up.status,
            MeetingItemFollowUp.Status.CANCELLED,
        )
        self.assertEqual(
            self.source_item.outcome,
            MeetingItem.Outcome.NOT_DISCUSSED,
        )

    # ── Target preservation: notes added ──────────────────────────

    def test_notes_added_target_is_preserved(self):
        follow_up = self._schedule()
        target_item = follow_up.target_meeting_item
        MeetingNote.objects.create(
            meeting_item=target_item,
            author=self.actor,
            content="A note was added",
        )

        self._cancel(follow_up)

        target_item.refresh_from_db()
        self.assertTrue(MeetingItem.objects.filter(pk=target_item.pk).exists())

    # ── Target preservation: outcome changed ──────────────────────

    def test_outcome_changed_target_is_preserved(self):
        follow_up = self._schedule()
        target_item = follow_up.target_meeting_item
        target_item.outcome = MeetingItem.Outcome.DONE
        target_item.save(update_fields=["outcome", "updated_at"])

        self._cancel(follow_up)

        target_item.refresh_from_db()
        self.assertTrue(MeetingItem.objects.filter(pk=target_item.pk).exists())

    # ── Target preservation: work item linked ─────────────────────

    def test_work_item_linked_target_is_preserved(self):
        from work_items.models import (
            WorkItem,
            WorkItemTypeDefinition,
            WorkItemStatusDefinition,
        )
        from .models import MeetingItemWorkItem

        follow_up = self._schedule()
        target_item = follow_up.target_meeting_item

        project = create_project(
            research_group=self.group,
            creator=self.actor,
            name="Cancel WI project",
        )
        # create_project already creates default definitions.
        type_def = WorkItemTypeDefinition.objects.filter(
            project=project,
        ).first()
        status_def = WorkItemStatusDefinition.objects.filter(
            project=project,
            is_default=True,
        ).first()
        work_item = WorkItem.objects.create(
            project=project,
            title="Test WI",
            type_definition=type_def,
            status_definition=status_def,
            created_by=self.actor,
        )
        MeetingItemWorkItem.objects.create(
            meeting_item=target_item,
            work_item=work_item,
            created_by=self.actor,
        )

        self._cancel(follow_up)

        target_item.refresh_from_db()
        self.assertTrue(MeetingItem.objects.filter(pk=target_item.pk).exists())

    # ── Target preservation: notes field edited ──────────────────

    def test_notes_field_edited_target_is_preserved(self):
        follow_up = self._schedule()
        target_item = follow_up.target_meeting_item
        update_meeting_item(
            meeting_item=target_item,
            actor=self.actor,
            notes="User edited notes",
        )

        self._cancel(follow_up)

        target_item.refresh_from_db()
        self.assertTrue(MeetingItem.objects.filter(pk=target_item.pk).exists())

    # ── Target preservation: position changed (reorder) ─────────

    def test_position_changed_target_is_preserved(self):
        """A meaningful agenda-position edit (reorder) preserves the target."""
        follow_up = self._schedule()
        target_item = follow_up.target_meeting_item
        original_position = target_item.position
        # Simulate a reorder: change the target item's position.
        target_item.position = original_position + 10
        target_item.save(update_fields=["position", "updated_at"])

        self._cancel(follow_up)

        target_item.refresh_from_db()
        self.assertTrue(MeetingItem.objects.filter(pk=target_item.pk).exists())
        self.assertEqual(
            target_item.position,
            original_position + 10,
        )
        # Follow-up cancelled, source reopened.
        follow_up.refresh_from_db()
        self.source_item.refresh_from_db()
        self.assertEqual(
            follow_up.status,
            MeetingItemFollowUp.Status.CANCELLED,
        )
        self.assertEqual(
            self.source_item.outcome,
            MeetingItem.Outcome.NOT_DISCUSSED,
        )

    # ── Target preservation: pre-migration (no provenance) ───────

    def test_follow_up_without_pristine_flag_preserves_target(self):
        """A follow-up created before migration 0013 has
        target_pristine=False and must preserve its target."""
        follow_up = self._schedule()
        # Simulate pre-migration state: clear the pristine flag.
        follow_up.target_pristine = False
        follow_up.save(update_fields=["target_pristine", "updated_at"])

        self._cancel(follow_up)

        target_item_pk = follow_up.target_meeting_item_id
        self.assertIsNotNone(target_item_pk)
        self.assertEqual(
            MeetingItem.objects.filter(pk=target_item_pk).count(),
            1,
        )

    # ── Permissions: no target-write access → preserve ────────────

    def test_no_target_write_access_preserves_target(self):
        """Actor can write source but NOT target: target is preserved."""
        # Create a target in a different group that the actor cannot write.
        other_group = ResearchGroup.objects.create(
            name="Private target group",
            created_by=self.other,
        )
        ResearchGroupMembership.objects.create(
            research_group=other_group,
            user=self.other,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        # The actor is not a member of other_group, so cannot write
        # to a meeting there. But scheduling requires write access on
        # BOTH meetings, so we need a different approach:
        # Use a project meeting where the actor is a viewer on target
        # project but member on source project.
        source_project = create_project(
            research_group=self.group,
            creator=self.actor,
            name="Source project",
        )
        target_project = create_project(
            research_group=self.group,
            creator=self.actor,
            name="Target project",
        )
        # Make 'other' a viewer on target project.
        add_project_membership(
            project=target_project,
            actor=self.actor,
            target_user=self.other,
            role=ProjectMembership.Role.VIEWER,
        )

        source_meeting = create_meeting(
            research_group=self.group,
            actor=self.actor,
            title="Source project meeting",
            scheduled_at=timezone.now() + timedelta(days=0),
            scope=Meeting.Scope.PROJECT,
            project=source_project,
        )
        target_meeting = create_meeting(
            research_group=self.group,
            actor=self.actor,
            title="Target project meeting",
            scheduled_at=timezone.now() + timedelta(days=7),
            scope=Meeting.Scope.PROJECT,
            project=target_project,
        )
        source_section = MeetingSection.objects.get(meeting=source_meeting)
        target_section = MeetingSection.objects.get(meeting=target_meeting)
        source_item = create_meeting_item(
            meeting=source_meeting,
            meeting_section=source_section,
            actor=self.actor,
            title="Source topic",
        )

        # 'other' can write source (member of group, no project
        # restriction for group meetings… actually source_project
        # requires membership). Let's make 'other' a member of
        # source_project and viewer of target_project.
        add_project_membership(
            project=source_project,
            actor=self.actor,
            target_user=self.other,
            role=ProjectMembership.Role.MEMBER,
        )

        # Schedule as 'other' (can write both source and target
        # project meetings at this point since they're members of
        # source_project and viewers of target_project — but viewer
        # can't write!).
        # Actually, scheduling requires write on BOTH meetings.
        # Let's simplify: actor schedules (has write on both),
        # then 'other' (viewer on target) tries to cancel.
        follow_up = schedule_meeting_item_follow_up(
            source_meeting_item=source_item,
            target_meeting=target_meeting,
            target_meeting_section=target_section,
            actor=self.actor,
        )
        target_item_pk = follow_up.target_meeting_item_id

        # 'other' is a member of source_project (can write source)
        # but only a viewer of target_project (cannot write target).
        result = cancel_meeting_item_follow_up(
            follow_up_id=follow_up.pk,
            actor=self.other,
        )
        result.refresh_from_db()
        self.assertEqual(result.status, MeetingItemFollowUp.Status.CANCELLED)

        # Source was reopened.
        source_item.refresh_from_db()
        self.assertEqual(
            source_item.outcome,
            MeetingItem.Outcome.NOT_DISCUSSED,
        )

        # Target item was preserved (actor lacks target write).
        self.assertEqual(
            MeetingItem.objects.filter(pk=target_item_pk).count(),
            1,
        )

    # ── Failed cancellation leaves everything unchanged ───────────

    def test_failed_cancellation_leaves_source_followup_target_and_current_unchanged(self):
        current_item = create_meeting_item(
            meeting=self.source_meeting,
            meeting_section=self.source_section,
            actor=self.actor,
            title="Current",
        )
        self.source_meeting.current_meeting_item = current_item
        self.source_meeting.save(
            update_fields=["current_meeting_item", "updated_at"],
        )
        follow_up = self._schedule()
        self.source_item.refresh_from_db()
        target_item_pk = follow_up.target_meeting_item_id
        source_outcome = self.source_item.outcome
        follow_up_status = follow_up.status
        self.source_meeting.refresh_from_db()
        current_pk = self.source_meeting.current_meeting_item_id

        # Make the target live to force rejection.
        self.target_meeting.status = Meeting.Status.LIVE
        self.target_meeting.save(update_fields=["status", "updated_at"])

        with self.assertRaises(MeetingDomainError):
            self._cancel(follow_up)

        follow_up.refresh_from_db()
        self.source_item.refresh_from_db()
        self.source_meeting.refresh_from_db()
        self.assertEqual(follow_up.status, follow_up_status)
        self.assertEqual(self.source_item.outcome, source_outcome)
        self.assertEqual(
            self.source_meeting.current_meeting_item_id,
            current_pk,
        )
        self.assertEqual(
            MeetingItem.objects.filter(pk=target_item_pk).count(),
            1,
        )

    # ── Cancelled record remains persisted ────────────────────────

    def test_cancelled_follow_up_record_remains_persisted(self):
        follow_up = self._schedule()
        self._cancel(follow_up)

        record = MeetingItemFollowUp.objects.get(pk=follow_up.pk)
        self.assertEqual(record.status, MeetingItemFollowUp.Status.CANCELLED)
        self.assertIsNotNone(record.source_meeting_item_id)
        self.assertIsNotNone(record.target_meeting_id)
        self.assertIsNotNone(record.target_meeting_section_id)
        # target_meeting_item is NULL (item was deleted) but the
        # Meeting and Section references remain.
        self.assertIsNone(record.target_meeting_item_id)

    # ── Re-scheduling after cancellation is not blocked ───────────

    def test_rescheduling_after_cancellation_is_allowed(self):
        f1 = self._schedule()
        self._cancel(f1)

        # A new schedule for the same source should succeed.
        f2 = self._schedule()
        f2.refresh_from_db()
        self.assertEqual(f2.status, MeetingItemFollowUp.Status.SCHEDULED)
        self.assertNotEqual(f1.pk, f2.pk)
        self.source_item.refresh_from_db()
        self.assertEqual(
            self.source_item.outcome,
            MeetingItem.Outcome.FOLLOW_UP,
        )

    # ── Unknown follow-up ID ──────────────────────────────────────

    def test_cancel_unknown_follow_up_raises(self):
        with self.assertRaises(MeetingDomainError):
            cancel_meeting_item_follow_up(
                follow_up_id=999999,
                actor=self.actor,
            )

    # ── Active target deletion via real Django delete() ──────────

    def test_real_target_delete_cannot_orphan_active_follow_up(self):
        """A real target_item.delete() on an active scheduled follow-up
        must be rejected by the persistence invariant
        (meetings_follow_up_active_target_required). The target item
        must still exist afterwards and the follow-up must be
        unchanged."""
        from django.db import IntegrityError, transaction

        follow_up = self._schedule()
        follow_up.refresh_from_db()
        target_item_pk = follow_up.target_meeting_item_id
        self.assertIsNotNone(target_item_pk)
        self.assertEqual(
            follow_up.status,
            MeetingItemFollowUp.Status.SCHEDULED,
        )

        # Attempt real Django deletion of the target item.
        # The SET_NULL on_delete will try to null out
        # target_meeting_item, but the check constraint
        # meetings_follow_up_active_target_required requires a
        # non-NULL target for non-cancelled rows → IntegrityError.
        target_item = MeetingItem.objects.get(pk=target_item_pk)
        with self.assertRaises(IntegrityError), transaction.atomic():
            target_item.delete()

        # The target item must still exist.
        self.assertTrue(
            MeetingItem.objects.filter(pk=target_item_pk).exists()
        )

        # The follow-up must be unchanged.
        follow_up.refresh_from_db()
        self.assertEqual(
            follow_up.status,
            MeetingItemFollowUp.Status.SCHEDULED,
        )
        self.assertEqual(
            follow_up.target_meeting_item_id,
            target_item_pk,
        )

        # The source must still be in follow_up state.
        self.source_item.refresh_from_db()
        self.assertEqual(
            self.source_item.outcome,
            MeetingItem.Outcome.FOLLOW_UP,
        )

    # ── Authorization before idempotent return ────────────────────

    def test_unauthorized_actor_cannot_use_idempotent_cancel_path(self):
        """An unauthorized actor must be denied even when the
        FollowUp is already cancelled. The canonical source write
        permission check must precede the idempotent early-return."""
        follow_up = self._schedule()
        self._cancel(follow_up)
        follow_up.refresh_from_db()
        self.assertEqual(
            follow_up.status,
            MeetingItemFollowUp.Status.CANCELLED,
        )

        # self.other is a group member but let's use a true outsider:
        # a user not in the group at all.
        outsider = User.objects.create_user(
            username="cancel-outsider", password="Pass1!",
        )
        with self.assertRaises(MeetingDomainError):
            cancel_meeting_item_follow_up(
                follow_up_id=follow_up.pk,
                actor=outsider,
            )

        # The follow-up is unchanged.
        follow_up.refresh_from_db()
        self.assertEqual(
            follow_up.status,
            MeetingItemFollowUp.Status.CANCELLED,
        )

    def test_authorized_actor_idempotent_retry_after_denial(self):
        """After an unauthorized actor is denied, the authorized actor
        can still receive the idempotent success with no new mutation."""
        follow_up = self._schedule()
        self._cancel(follow_up)
        follow_up.refresh_from_db()
        source_item_outcome = self.source_item.outcome
        source_meeting_current = self.source_meeting.current_meeting_item_id

        outsider = User.objects.create_user(
            username="cancel-outsider2", password="Pass1!",
        )
        with self.assertRaises(MeetingDomainError):
            cancel_meeting_item_follow_up(
                follow_up_id=follow_up.pk,
                actor=outsider,
            )

        # Authorized actor retry: idempotent success.
        result = cancel_meeting_item_follow_up(
            follow_up_id=follow_up.pk,
            actor=self.actor,
        )
        result.refresh_from_db()
        self.assertEqual(
            result.status,
            MeetingItemFollowUp.Status.CANCELLED,
        )

        # No new mutation: source outcome and current are unchanged.
        self.source_item.refresh_from_db()
        self.source_meeting.refresh_from_db()
        self.assertEqual(
            self.source_item.outcome,
            source_item_outcome,
        )
        self.assertEqual(
            self.source_meeting.current_meeting_item_id,
            source_meeting_current,
        )
        # Only one follow-up record for this source.
        self.assertEqual(
            MeetingItemFollowUp.objects.filter(
                source_meeting_item=self.source_item,
            ).count(),
            1,
        )


class CancelFollowUpApiTest(CancelFollowUpBase):
    """API-level tests for POST /api/meeting-item-follow-ups/{id}/cancel."""

    def setUp(self):
        super().setUp()
        self.client = APIClient()
        self.client.force_login(self.actor)

    def _post_cancel(self, follow_up_id):
        return self.client.post(
            f"/api/meeting-item-follow-ups/{follow_up_id}/cancel",
            {},
            format="json",
        )

    def test_cancel_pristine_target_returns_removed_disposition(self):
        follow_up = self._schedule()

        response = self._post_cancel(follow_up.pk)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.source_item.refresh_from_db()
        self.assertEqual(
            self.source_item.outcome,
            MeetingItem.Outcome.NOT_DISCUSSED,
        )
        self.assertFalse(
            MeetingItem.objects.filter(
                pk=follow_up.target_meeting_item_id,
            ).exists()
        )
        self.assertEqual(response.json(), {
            "id": follow_up.pk,
            "status": "cancelled",
            "sourceMeetingItemId": self.source_item.pk,
            "sourceOutcome": "not_discussed",
            "targetMeetingItemId": None,
            "targetItemDisposition": "removed",
        })

    def test_cancel_pristine_target_meeting_item_read_clears_schedule(self):
        follow_up = self._schedule()

        response = self._post_cancel(follow_up.pk)
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        detail = self.client.get(f"/api/meeting-items/{self.source_item.pk}/")
        self.assertEqual(detail.status_code, status.HTTP_200_OK)
        body = detail.json()
        self.assertEqual(body["outcome"], "not_discussed")
        self.assertIsNone(body["followUpSchedule"])

    def test_cancel_edited_target_returns_preserved_disposition(self):
        follow_up = self._schedule()
        target_item = follow_up.target_meeting_item
        target_item.title = "Edited target title"
        target_item.save(update_fields=["title", "updated_at"])

        response = self._post_cancel(follow_up.pk)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.source_item.refresh_from_db()
        self.assertEqual(
            self.source_item.outcome,
            MeetingItem.Outcome.NOT_DISCUSSED,
        )
        self.assertTrue(
            MeetingItem.objects.filter(pk=target_item.pk).exists()
        )
        self.assertEqual(response.json(), {
            "id": follow_up.pk,
            "status": "cancelled",
            "sourceMeetingItemId": self.source_item.pk,
            "sourceOutcome": "not_discussed",
            "targetMeetingItemId": target_item.pk,
            "targetItemDisposition": "preserved",
        })

    def test_unauthorized_caller_is_rejected(self):
        project = create_project(
            research_group=self.group,
            creator=self.actor,
            name="Read-only project",
        )
        add_project_membership(
            project=project,
            actor=self.actor,
            target_user=self.other,
            role=ProjectMembership.Role.VIEWER,
        )
        project_meeting = self._create_meeting(
            "Project source",
            days=0,
            scope=Meeting.Scope.PROJECT,
            project=project,
        )
        section = MeetingSection.objects.get(meeting=project_meeting)
        project_item = create_meeting_item(
            meeting=project_meeting,
            meeting_section=section,
            actor=self.actor,
            title="Project source topic",
        )
        follow_up = schedule_meeting_item_follow_up(
            source_meeting_item=project_item,
            target_meeting=self.target_meeting,
            target_meeting_section=self.target_section,
            actor=self.actor,
        )

        self.client.force_login(self.other)
        response = self._post_cancel(follow_up.pk)

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        follow_up.refresh_from_db()
        self.assertEqual(
            follow_up.status,
            MeetingItemFollowUp.Status.SCHEDULED,
        )

    def test_non_upcoming_target_is_rejected(self):
        follow_up = self._schedule()
        self.target_meeting.status = Meeting.Status.LIVE
        self.target_meeting.save(update_fields=["status", "updated_at"])

        response = self._post_cancel(follow_up.pk)

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("no longer upcoming", response.json()["error"])
        follow_up.refresh_from_db()
        self.assertEqual(
            follow_up.status,
            MeetingItemFollowUp.Status.SCHEDULED,
        )
        self.source_item.refresh_from_db()
        self.assertEqual(
            self.source_item.outcome,
            MeetingItem.Outcome.FOLLOW_UP,
        )

    def test_already_cancelled_authorized_retry_is_idempotent(self):
        follow_up = self._schedule()
        self._cancel(follow_up)
        follow_up.refresh_from_db()

        response = self._post_cancel(follow_up.pk)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.json(), {
            "id": follow_up.pk,
            "status": "cancelled",
            "sourceMeetingItemId": self.source_item.pk,
            "sourceOutcome": "not_discussed",
            "targetMeetingItemId": None,
            "targetItemDisposition": "removed",
        })

    def test_already_cancelled_preserved_retry_returns_stable_disposition(self):
        follow_up = self._schedule()
        target_item = follow_up.target_meeting_item
        target_item.title = "Edited target title"
        target_item.save(update_fields=["title", "updated_at"])
        self._cancel(follow_up)

        response = self._post_cancel(follow_up.pk)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.json()["targetItemDisposition"], "preserved")
        self.assertEqual(
            response.json()["targetMeetingItemId"],
            target_item.pk,
        )

    def test_unknown_follow_up_is_not_found(self):
        response = self._post_cancel(999999)

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_forbidden_scope_follow_up_is_not_found(self):
        follow_up = self._schedule()

        outsider = User.objects.create_user(
            username="cancel-api-outsider", password="Pass1!",
        )
        self.client.force_login(outsider)
        response = self._post_cancel(follow_up.pk)

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        follow_up.refresh_from_db()
        self.assertEqual(
            follow_up.status,
            MeetingItemFollowUp.Status.SCHEDULED,
        )
