"""Safe deletion of an unreferenced, not-discussed agenda item.

Covers the domain contract of ``delete_meeting_item`` and the
``DELETE /api/meeting-items/{id}/`` endpoint:

- an authorized user deletes an eligible Upcoming MeetingItem
  (204; the item no longer exists; detail 404; list excludes it;
  siblings/ordering intact; subsequent creation has no position
  conflict);
- unauthorized users cannot delete or discover protected items
  (non-leaking 404 / generic 403);
- project-scoped Meeting permissions are enforced by the server;
- Live / Completed / Cancelled Meetings reject deletion (409);
- non-``not_discussed`` outcomes are protected (409);
- Notes, Work Item links, and follow-up source/target references
  (including historical cancelled records) protect the item (409);
- the Meeting's current item cannot be deleted (409);
- rejected requests cause no partial writes.
"""

from datetime import timedelta

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
from work_items.models import WorkItem

from .models import (
    Meeting,
    MeetingItem,
    MeetingItemFollowUp,
    MeetingItemWorkItem,
    MeetingNote,
    MeetingSection,
)
from .services import (
    MeetingDomainError,
    MeetingItemDeletionBlockedError,
    add_meeting_participant,
    cancel_meeting_item_follow_up,
    create_meeting,
    create_meeting_item,
    create_work_item_from_meeting_item,
    delete_meeting_item,
    schedule_meeting_item_follow_up,
    update_meeting_item,
)


User = get_user_model()


class MeetingItemDeletionBase(TestCase):
    def setUp(self):
        self.client = APIClient()

        self.alex = User.objects.create_user(
            username="item-del-alex",
            password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="item-del-chris",
            password="Pass1!",
        )
        self.laura = User.objects.create_user(
            username="item-del-laura",
            password="Pass1!",
        )
        self.olga = User.objects.create_user(
            username="item-del-olga",
            password="Pass1!",
        )
        self.maria = User.objects.create_user(
            username="item-del-maria",
            password="Pass1!",
        )

        self.group = ResearchGroup.objects.create(
            name="Item Deletion Group",
            created_by=self.alex,
        )

        for user, role in [
            (self.alex, ResearchGroupMembership.Role.ADMIN),
            (self.chris, ResearchGroupMembership.Role.MEMBER),
            (self.laura, ResearchGroupMembership.Role.MEMBER),
            (self.olga, ResearchGroupMembership.Role.MEMBER),
        ]:
            ResearchGroupMembership.objects.create(
                research_group=self.group,
                user=user,
                role=role,
            )

        self.project = create_project(
            research_group=self.group,
            creator=self.alex,
            name="Deletion Link Project",
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
        # A Project owner who is NOT the Meeting creator and NOT a
        # participant: Project ownership alone grants no Meeting
        # access.
        add_project_membership(
            project=self.project,
            actor=self.alex,
            target_user=self.olga,
            role=ProjectMembership.Role.OWNER,
        )

        self.scheduled_at = (
            timezone.now().replace(microsecond=0)
            + timedelta(days=1)
        )

    def login(self, user):
        self.client.logout()
        self.client.force_login(user)

    def create_group_meeting(self, **kwargs):
        return create_meeting(
            research_group=self.group,
            actor=self.alex,
            title=kwargs.pop("title", "Deletion Weekly"),
            scheduled_at=self.scheduled_at,
            **kwargs,
        )

    def create_project_meeting(self, **kwargs):
        meeting = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title=kwargs.pop("title", "Deletion Project Weekly"),
            scheduled_at=self.scheduled_at,
            scope=Meeting.Scope.PROJECT,
            project=self.project,
            **kwargs,
        )
        if (
            self.laura not in meeting.participant_relations.values_list(
                "user",
                flat=True,
            )
        ):
            add_meeting_participant(
                meeting=meeting,
                actor=self.alex,
                target_user=self.laura,
            )
        return meeting

    def section_of(self, meeting):
        return MeetingSection.objects.get(meeting=meeting)

    def create_item(self, meeting, title):
        return create_meeting_item(
            meeting=meeting,
            meeting_section=self.section_of(meeting),
            actor=self.alex,
            title=title,
        )

    def delete(self, item):
        return self.client.delete(f"/api/meeting-items/{item.pk}/")

    def run_to_status(self, meeting, target):
        self.login(self.alex)
        if target in ("live", "completed"):
            response = self.client.post(
                f"/api/meetings/{meeting.pk}/start",
                {},
                format="json",
            )
            self.assertEqual(response.status_code, status.HTTP_200_OK)
        if target == "completed":
            response = self.client.post(
                f"/api/meetings/{meeting.pk}/end",
                {},
                format="json",
            )
            self.assertEqual(response.status_code, status.HTTP_200_OK)


class DeleteEligibleItemApiTest(MeetingItemDeletionBase):
    """Scenarios 1-6: the successful deletion path."""

    def test_authorized_user_deletes_eligible_upcoming_item(self):
        meeting = self.create_group_meeting()
        item = self.create_item(meeting, "Eligible topic")

        self.login(self.chris)
        response = self.delete(item)

        self.assertEqual(
            response.status_code,
            status.HTTP_204_NO_CONTENT,
        )
        self.assertEqual(response.content, b"")
        self.assertFalse(
            MeetingItem.objects.filter(pk=item.pk).exists()
        )

    def test_re_reading_deleted_item_detail_is_404(self):
        meeting = self.create_group_meeting()
        item = self.create_item(meeting, "Gone topic")

        self.login(self.alex)
        self.assertEqual(
            self.delete(item).status_code,
            status.HTTP_204_NO_CONTENT,
        )

        response = self.client.get(f"/api/meeting-items/{item.pk}/")
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_parent_item_list_excludes_deleted_item(self):
        meeting = self.create_group_meeting()
        first = self.create_item(meeting, "First topic")
        deleted = self.create_item(meeting, "Deleted topic")
        third = self.create_item(meeting, "Third topic")

        self.login(self.alex)
        self.assertEqual(
            self.delete(deleted).status_code,
            status.HTTP_204_NO_CONTENT,
        )

        listing = self.client.get(
            f"/api/meetings/{meeting.pk}/items/",
        )
        self.assertEqual(
            [entry["id"] for entry in listing.json()],
            [first.pk, third.pk],
        )

    def test_sibling_items_and_ordering_remain_valid(self):
        meeting = self.create_group_meeting()
        first = self.create_item(meeting, "First topic")
        middle = self.create_item(meeting, "Middle topic")
        last = self.create_item(meeting, "Last topic")

        positions_before = {
            entry.pk: entry.position
            for entry in (first, middle, last)
        }

        self.login(self.alex)
        self.assertEqual(
            self.delete(middle).status_code,
            status.HTTP_204_NO_CONTENT,
        )

        first.refresh_from_db()
        last.refresh_from_db()
        self.assertEqual(
            first.position,
            positions_before[first.pk],
        )
        self.assertEqual(
            last.position,
            positions_before[last.pk],
        )
        # No outcome or title drift on the siblings.
        self.assertEqual(
            first.outcome,
            MeetingItem.Outcome.NOT_DISCUSSED,
        )
        self.assertEqual(
            last.outcome,
            MeetingItem.Outcome.NOT_DISCUSSED,
        )
        self.assertEqual(first.title, "First topic")
        self.assertEqual(last.title, "Last topic")

        listing = self.client.get(
            f"/api/meetings/{meeting.pk}/items/",
        )
        self.assertEqual(
            [entry["id"] for entry in listing.json()],
            [first.pk, last.pk],
        )

    def test_subsequent_creation_succeeds_without_position_conflict(
        self,
    ):
        meeting = self.create_group_meeting()
        first = self.create_item(meeting, "First topic")
        middle = self.create_item(meeting, "Middle topic")
        last = self.create_item(meeting, "Last topic")

        self.login(self.alex)
        self.assertEqual(
            self.delete(middle).status_code,
            status.HTTP_204_NO_CONTENT,
        )

        # Creation allocates max(position) + 1 per Section: the gap
        # left by the deletion must not collide or renumber.
        response = self.client.post(
            f"/api/meetings/{meeting.pk}/items/",
            {
                "meetingSectionId": self.section_of(meeting).pk,
                "title": "Follow-on topic",
            },
            format="json",
        )
        self.assertEqual(
            response.status_code,
            status.HTTP_201_CREATED,
        )
        created = MeetingItem.objects.get(pk=response.json()["id"])
        self.assertEqual(created.position, 3)

        listing = self.client.get(
            f"/api/meetings/{meeting.pk}/items/",
        )
        self.assertEqual(
            [entry["id"] for entry in listing.json()],
            [first.pk, last.pk, created.pk],
        )

    def test_unknown_item_id_is_404(self):
        self.login(self.alex)

        response = self.client.delete("/api/meeting-items/999999/")

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_deletion_removes_only_the_item_row(self):
        meeting = self.create_group_meeting()
        section = self.section_of(meeting)
        item = self.create_item(meeting, "Only topic")
        sibling = self.create_item(meeting, "Sibling topic")

        self.login(self.alex)
        self.assertEqual(
            self.delete(item).status_code,
            status.HTTP_204_NO_CONTENT,
        )

        meeting.refresh_from_db()
        section.refresh_from_db()
        sibling.refresh_from_db()
        self.assertTrue(
            Meeting.objects.filter(pk=meeting.pk).exists()
        )
        self.assertEqual(meeting.title, "Deletion Weekly")
        self.assertTrue(
            MeetingSection.objects.filter(pk=section.pk).exists()
        )
        self.assertEqual(
            MeetingItem.objects.filter(meeting=meeting).count(),
            1,
        )
        self.assertEqual(
            MeetingItem.objects.get(
                meeting=meeting,
            ).pk,
            sibling.pk,
        )


class DeleteItemAuthorizationTest(MeetingItemDeletionBase):
    """Scenarios 7-8: authorization is enforced by the server and
    never leaks the existence or the protection reason."""

    def test_group_non_member_gets_404_and_item_survives(self):
        meeting = self.create_group_meeting()
        item = self.create_item(meeting, "Protected topic")

        self.login(self.maria)
        response = self.delete(item)

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertTrue(
            MeetingItem.objects.filter(pk=item.pk).exists()
        )

    def test_archived_project_meeting_participant_gets_generic_403(
        self,
    ):
        meeting = self.create_project_meeting()
        item = self.create_item(meeting, "Archived topic")
        archive_project(project=self.project, actor=self.alex)

        # Archived Projects are read-only for Meeting collaboration:
        # a participant may still READ the Meeting (read access is
        # intact) but holds no MEETING_WRITE, so the deletion is
        # forbidden — with the generic mutation message, never an
        # eligibility detail.
        self.login(self.chris)
        add_meeting_participant(
            meeting=meeting,
            actor=self.alex,
            target_user=self.chris,
        )
        response = self.delete(item)

        self.assertEqual(
            response.status_code,
            status.HTTP_403_FORBIDDEN,
        )
        # Generic mutation message: no eligibility detail leaks.
        self.assertEqual(
            response.json()["error"],
            "You do not have permission to modify "
            "this Project Meeting resource.",
        )
        self.assertTrue(
            MeetingItem.objects.filter(pk=item.pk).exists()
        )

    def test_project_owner_without_participation_gets_404(self):
        meeting = self.create_project_meeting()
        item = self.create_item(meeting, "Project topic")

        # Olga owns the Project but is neither the Meeting creator
        # nor an explicit participant: Project ownership alone
        # grants no Meeting access — the item is indistinguishable
        # from nonexistent.
        self.login(self.olga)
        response = self.delete(item)

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertTrue(
            MeetingItem.objects.filter(pk=item.pk).exists()
        )

    def test_project_member_non_participant_gets_404(self):
        meeting = self.create_project_meeting()
        item = self.create_item(meeting, "Project topic")

        self.login(self.chris)
        response = self.delete(item)

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertTrue(
            MeetingItem.objects.filter(pk=item.pk).exists()
        )

    def test_service_rejects_actor_without_write_access(self):
        meeting = self.create_project_meeting()
        item = self.create_item(meeting, "Archived topic")
        archive_project(project=self.project, actor=self.alex)

        with self.assertRaises(MeetingDomainError):
            delete_meeting_item(
                meeting_item=item,
                actor=self.chris,
            )

        self.assertTrue(
            MeetingItem.objects.filter(pk=item.pk).exists()
        )

    def test_group_member_without_participation_may_delete(
        self,
    ):
        # Group Meetings are fully collaborative: any current
        # Research Group member holds MEETING_WRITE even without a
        # MeetingParticipant relation.
        meeting = self.create_group_meeting()
        item = self.create_item(meeting, "Group topic")

        self.login(self.chris)
        self.assertEqual(
            self.delete(item).status_code,
            status.HTTP_204_NO_CONTENT,
        )
        self.assertFalse(
            MeetingItem.objects.filter(pk=item.pk).exists()
        )


class DeleteItemLifecycleProtectionTest(MeetingItemDeletionBase):
    """Scenarios 9-11: the Meeting lifecycle and the item outcome
    gate deletion; every rejection is a 409 with the item intact."""

    def test_live_meeting_item_cannot_be_deleted(self):
        meeting = self.create_group_meeting()
        item = self.create_item(meeting, "Live topic")
        self.run_to_status(meeting, "live")

        response = self.delete(item)

        self.assertEqual(response.status_code, status.HTTP_409_CONFLICT)
        self.assertIn("upcoming", response.json()["error"])
        item.refresh_from_db()
        self.assertTrue(
            MeetingItem.objects.filter(pk=item.pk).exists()
        )
        self.assertEqual(item.outcome, MeetingItem.Outcome.NOT_DISCUSSED)

    def test_completed_meeting_item_cannot_be_deleted(self):
        meeting = self.create_group_meeting()
        item = self.create_item(meeting, "Completed topic")
        self.run_to_status(meeting, "completed")

        response = self.delete(item)

        self.assertEqual(response.status_code, status.HTTP_409_CONFLICT)
        self.assertTrue(
            MeetingItem.objects.filter(pk=item.pk).exists()
        )

    def test_cancelled_meeting_item_cannot_be_deleted(self):
        meeting = self.create_group_meeting()
        item = self.create_item(meeting, "Cancelled topic")
        # Terminal cancellation state (reached in production through
        # recurrence-aware cancellation): the status gate alone must
        # reject the deletion.
        meeting.status = Meeting.Status.CANCELLED
        meeting.save(update_fields=["status", "updated_at"])

        self.login(self.alex)
        response = self.delete(item)

        self.assertEqual(response.status_code, status.HTTP_409_CONFLICT)
        self.assertTrue(
            MeetingItem.objects.filter(pk=item.pk).exists()
        )

    def test_done_outcome_item_is_protected(self):
        meeting = self.create_group_meeting()
        item = self.create_item(meeting, "Done topic")
        item.outcome = MeetingItem.Outcome.DONE
        item.save(update_fields=["outcome", "updated_at"])

        self.login(self.alex)
        response = self.delete(item)

        self.assertEqual(response.status_code, status.HTTP_409_CONFLICT)
        self.assertIn("not been discussed", response.json()["error"])
        item.refresh_from_db()
        self.assertEqual(item.outcome, MeetingItem.Outcome.DONE)

    def test_follow_up_outcome_item_is_protected(self):
        meeting = self.create_group_meeting()
        item = self.create_item(meeting, "Follow-up topic")
        item.outcome = MeetingItem.Outcome.FOLLOW_UP
        item.save(update_fields=["outcome", "updated_at"])

        self.login(self.alex)
        response = self.delete(item)

        self.assertEqual(response.status_code, status.HTTP_409_CONFLICT)
        item.refresh_from_db()
        self.assertEqual(
            item.outcome,
            MeetingItem.Outcome.FOLLOW_UP,
        )


class DeleteItemRelationshipProtectionTest(MeetingItemDeletionBase):
    """Scenarios 12-14: persistent Notes, Work Item links, and
    follow-up source/target references (including historical
    cancelled records) protect the item and survive the attempt."""

    def test_item_with_notes_is_protected_and_notes_remain(self):
        meeting = self.create_group_meeting()
        item = self.create_item(meeting, "Noted topic")
        note = MeetingNote.objects.create(
            meeting_item=item,
            author=self.alex,
            content="Protocol note.",
        )

        self.login(self.alex)
        response = self.delete(item)

        self.assertEqual(response.status_code, status.HTTP_409_CONFLICT)
        self.assertIn("Meeting Notes", response.json()["error"])
        self.assertTrue(
            MeetingItem.objects.filter(pk=item.pk).exists()
        )
        self.assertTrue(
            MeetingNote.objects.filter(pk=note.pk).exists()
        )
        self.assertEqual(
            MeetingNote.objects.get(pk=note.pk).content,
            "Protocol note.",
        )

    def test_item_with_work_item_link_is_protected(self):
        meeting = self.create_group_meeting()
        item = self.create_item(meeting, "Linked topic")
        work_item = create_work_item_from_meeting_item(
            meeting_item=item,
            project=self.project,
            actor=self.alex,
            type_definition_id=self.project.type_definitions.get(
                name="Task"
            ).pk,
            title="Canonical linked task",
        )

        self.login(self.alex)
        response = self.delete(item)

        self.assertEqual(response.status_code, status.HTTP_409_CONFLICT)
        self.assertIn("Work Items", response.json()["error"])
        self.assertTrue(
            MeetingItem.objects.filter(pk=item.pk).exists()
        )
        self.assertTrue(
            WorkItem.objects.filter(pk=work_item.pk).exists()
        )
        self.assertTrue(
            MeetingItemWorkItem.objects.filter(
                meeting_item=item,
                work_item=work_item,
            ).exists()
        )

    def _schedule_follow_up(self, source_item):
        target_meeting = self.create_group_meeting(
            title="Follow-up target weekly",
        )
        return schedule_meeting_item_follow_up(
            source_meeting_item=source_item,
            target_meeting=target_meeting,
            target_meeting_section=self.section_of(target_meeting),
            actor=self.alex,
        )

    def test_source_of_scheduled_follow_up_is_protected(self):
        meeting = self.create_group_meeting()
        item = self.create_item(meeting, "Scheduled source")
        follow_up = self._schedule_follow_up(item)
        target_item = follow_up.target_meeting_item

        self.login(self.alex)
        response = self.delete(item)

        self.assertEqual(response.status_code, status.HTTP_409_CONFLICT)
        # An actively scheduled source always carries the
        # ``follow_up`` outcome, so the outcome guard (listed
        # before the follow-up reference checks in the contract)
        # rejects first; the persisted relation below proves the
        # source reference itself is intact either way.
        self.assertIn(
            "not been discussed",
            response.json()["error"],
        )
        self.assertTrue(
            MeetingItem.objects.filter(pk=item.pk).exists()
        )
        self.assertTrue(
            MeetingItemFollowUp.objects.filter(pk=follow_up.pk)
            .exists()
        )
        self.assertTrue(
            MeetingItem.objects.filter(pk=target_item.pk).exists()
        )

    def test_target_of_scheduled_follow_up_is_protected(self):
        meeting = self.create_group_meeting()
        item = self.create_item(meeting, "Scheduled source")
        follow_up = self._schedule_follow_up(item)
        target_item = follow_up.target_meeting_item
        target_meeting = follow_up.target_meeting

        self.login(self.alex)
        response = self.client.delete(
            f"/api/meeting-items/{target_item.pk}/"
        )

        self.assertEqual(response.status_code, status.HTTP_409_CONFLICT)
        self.assertIn(
            "target",
            response.json()["error"],
        )
        self.assertTrue(
            MeetingItem.objects.filter(pk=target_item.pk).exists()
        )
        self.assertTrue(
            MeetingItemFollowUp.objects.filter(pk=follow_up.pk)
            .exists()
        )
        self.assertTrue(
            Meeting.objects.filter(pk=target_meeting.pk).exists()
        )

    def test_source_of_cancelled_follow_up_is_protected(self):
        meeting = self.create_group_meeting()
        item = self.create_item(meeting, "Cancelled source")
        follow_up = self._schedule_follow_up(item)
        cancel_meeting_item_follow_up(
            follow_up_id=follow_up.pk,
            actor=self.alex,
        )
        follow_up.refresh_from_db()
        self.assertEqual(
            follow_up.status,
            MeetingItemFollowUp.Status.CANCELLED,
        )

        self.login(self.alex)
        response = self.delete(item)

        self.assertEqual(response.status_code, status.HTTP_409_CONFLICT)
        self.assertIn(
            "source",
            response.json()["error"],
        )

        self.assertTrue(
            MeetingItem.objects.filter(pk=item.pk).exists()
        )
        self.assertTrue(
            MeetingItemFollowUp.objects.filter(pk=follow_up.pk)
            .exists()
        )

    def test_preserved_target_of_cancelled_follow_up_is_protected(
        self,
    ):
        meeting = self.create_group_meeting()
        item = self.create_item(meeting, "Cancelled source")
        follow_up = self._schedule_follow_up(item)
        target_item = follow_up.target_meeting_item

        # Drift the target so the cancellation PRESERVES it (a
        # provably untouched target would be removed and its
        # reference cleared).
        update_meeting_item(
            meeting_item=target_item,
            actor=self.alex,
            content="## Edited target\n\ndrifted content.",
        )
        cancel_meeting_item_follow_up(
            follow_up_id=follow_up.pk,
            actor=self.alex,
        )
        follow_up.refresh_from_db()
        self.assertEqual(
            follow_up.status,
            MeetingItemFollowUp.Status.CANCELLED,
        )
        self.assertEqual(
            follow_up.target_meeting_item_id,
            target_item.pk,
        )

        self.login(self.alex)
        response = self.client.delete(
            f"/api/meeting-items/{target_item.pk}/"
        )

        self.assertEqual(response.status_code, status.HTTP_409_CONFLICT)
        self.assertIn(
            "target",
            response.json()["error"],
        )
        self.assertTrue(
            MeetingItem.objects.filter(pk=target_item.pk).exists()
        )


class DeleteItemCurrentPointerTest(MeetingItemDeletionBase):
    """Scenario 15: the Meeting's persisted current item cannot be
    deleted; the pointer itself is never touched by a rejection."""

    def test_current_item_cannot_be_deleted(self):
        meeting = self.create_group_meeting()
        first = self.create_item(meeting, "First topic")
        current = self.create_item(meeting, "Current topic")
        last = self.create_item(meeting, "Last topic")

        meeting.current_meeting_item = current
        meeting.save(update_fields=["current_meeting_item_id"])

        self.login(self.alex)
        response = self.delete(current)

        self.assertEqual(response.status_code, status.HTTP_409_CONFLICT)
        self.assertIn(
            "current item",
            response.json()["error"],
        )
        meeting.refresh_from_db()
        self.assertEqual(
            meeting.current_meeting_item_id,
            current.pk,
        )
        self.assertTrue(
            MeetingItem.objects.filter(pk=current.pk).exists()
        )

    def test_rejection_leaves_sibling_outcomes_and_pointer_unchanged(
        self,
    ):
        meeting = self.create_group_meeting()
        first = self.create_item(meeting, "First topic")
        protected = self.create_item(meeting, "Noted topic")
        MeetingNote.objects.create(
            meeting_item=protected,
            author=self.alex,
            content="Note.",
        )

        first.outcome = MeetingItem.Outcome.DONE
        first.save(update_fields=["outcome", "updated_at"])

        self.login(self.alex)
        response = self.delete(protected)

        self.assertEqual(response.status_code, status.HTTP_409_CONFLICT)

        meeting.refresh_from_db()
        first.refresh_from_db()
        protected.refresh_from_db()
        self.assertIsNone(meeting.current_meeting_item_id)
        self.assertEqual(
            first.outcome,
            MeetingItem.Outcome.DONE,
        )
        self.assertEqual(
            protected.outcome,
            MeetingItem.Outcome.NOT_DISCUSSED,
        )
        self.assertEqual(
            MeetingNote.objects.filter(
                meeting_item=protected,
            ).count(),
            1,
        )


class DeleteItemNoPartialWritesTest(MeetingItemDeletionBase):
    """Scenario 16: a rejected deletion must leave ALL persistence
    byte-for-byte unchanged (no partial writes, no side effects)."""

    def test_rejected_deletion_causes_no_partial_writes(self):
        meeting = self.create_group_meeting()
        sibling = self.create_item(meeting, "Sibling topic")
        protected = self.create_item(meeting, "Noted topic")
        note = MeetingNote.objects.create(
            meeting_item=protected,
            author=self.alex,
            content="Protocol note.",
        )
        work_item = create_work_item_from_meeting_item(
            meeting_item=protected,
            project=self.project,
            actor=self.alex,
            type_definition_id=self.project.type_definitions.get(
                name="Task"
            ).pk,
            title="Canonical linked task",
        )

        before_item = {
            field: getattr(protected, field)
            for field in (
                "title",
                "notes",
                "content",
                "position",
                "outcome",
                "created_at",
                "updated_at",
            )
        }
        before_sibling = {
            field: getattr(sibling, field)
            for field in (
                "title",
                "position",
                "outcome",
                "updated_at",
            )
        }
        before_meeting = {
            field: getattr(meeting, field)
            for field in (
                "title",
                "status",
                "current_meeting_item_id",
                "updated_at",
            )
        }

        self.login(self.alex)
        response = self.delete(protected)

        self.assertEqual(response.status_code, status.HTTP_409_CONFLICT)

        protected.refresh_from_db()
        sibling.refresh_from_db()
        meeting.refresh_from_db()
        self.assertEqual(
            {
                field: getattr(protected, field)
                for field in before_item
            },
            before_item,
        )
        self.assertEqual(
            {
                field: getattr(sibling, field)
                for field in before_sibling
            },
            before_sibling,
        )
        self.assertEqual(
            {
                field: getattr(meeting, field)
                for field in before_meeting
            },
            before_meeting,
        )
        self.assertEqual(
            MeetingNote.objects.filter(meeting_item=protected).count(),
            1,
        )
        self.assertEqual(
            MeetingNote.objects.get(pk=note.pk).content,
            "Protocol note.",
        )
        self.assertTrue(
            WorkItem.objects.filter(pk=work_item.pk).exists()
        )
        self.assertEqual(
            MeetingItemWorkItem.objects.filter(
                meeting_item=protected,
            ).count(),
            1,
        )
        # No follow-up or other item rows were created or removed.
        self.assertEqual(
            MeetingItemFollowUp.objects.filter(
                source_meeting_item=protected,
            ).count(),
            0,
        )
        self.assertEqual(
            MeetingItem.objects.filter(meeting=meeting).count(),
            2,
        )

    def test_successful_deletion_preserves_siblings_and_links_of_others(
        self,
    ):
        meeting = self.create_group_meeting()
        kept = self.create_item(meeting, "Kept topic")
        removed = self.create_item(meeting, "Removed topic")
        work_item = create_work_item_from_meeting_item(
            meeting_item=kept,
            project=self.project,
            actor=self.alex,
            type_definition_id=self.project.type_definitions.get(
                name="Task"
            ).pk,
            title="Canonical kept task",
        )

        self.login(self.alex)
        self.assertEqual(
            self.delete(removed).status_code,
            status.HTTP_204_NO_CONTENT,
        )

        meeting.refresh_from_db()
        kept.refresh_from_db()
        self.assertEqual(
            MeetingItem.objects.filter(meeting=meeting).count(),
            1,
        )
        self.assertEqual(
            MeetingItem.objects.get(meeting=meeting).pk,
            kept.pk,
        )
        self.assertTrue(
            WorkItem.objects.filter(pk=work_item.pk).exists()
        )
        self.assertTrue(
            MeetingItemWorkItem.objects.filter(
                meeting_item=kept,
                work_item=work_item,
            ).exists()
        )
        self.assertEqual(meeting.status, Meeting.Status.UPCOMING)
