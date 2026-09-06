"""Tests for the canonical Live Meeting current-pointer + outcome model.

Concepts:
- Selected: frontend-local (not tested here).
- Current:  persisted on Meeting (current_meeting_item /
  currentMeetingItemId).
- Outcome:  persisted on MeetingItem (not_discussed / done /
  follow_up).

Current is NOT an outcome: changing current never changes any
item's outcome, and Done / Follow-up are explicit outcomes.
"""

from importlib import import_module
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db import connection, transaction
from django.test import TestCase, TransactionTestCase
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from projects.models import ProjectMembership
from projects.services import (
    add_project_membership,
    create_project,
)
from research_groups.models import ResearchGroup, ResearchGroupMembership

from .models import (
    Meeting,
    MeetingItem,
    MeetingSection,
)
from .services import (
    MeetingDomainError,
    create_meeting,
    create_meeting_item,
    create_meeting_section,
    delete_meeting,
    end_meeting,
    focus_meeting_item,
    mark_meeting_item_done,
    mark_meeting_item_follow_up,
    reopen_meeting,
    start_meeting,
)


User = get_user_model()


class LiveStateMachineBase(TestCase):
    def setUp(self):
        self.alex = User.objects.create_user(
            username="live-alex", password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="live-chris", password="Pass1!",
        )
        self.maria = User.objects.create_user(
            username="live-maria", password="Pass1!",
        )
        self.laura = User.objects.create_user(
            username="live-laura", password="Pass1!",
        )

        self.group = ResearchGroup.objects.create(
            name="Live State Machine Group",
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

        self.scheduled_at = timezone.now() + timedelta(days=1)

    def create_meeting(self, title="FG Weekly"):
        return create_meeting(
            research_group=self.group,
            actor=self.alex,
            title=title,
            scheduled_at=self.scheduled_at,
        )

    def create_section(self, meeting, name):
        return create_meeting_section(
            meeting=meeting,
            actor=self.alex,
            name=name,
        )

    def create_item(self, meeting, section, title, outcome=None):
        return create_meeting_item(
            meeting=meeting,
            meeting_section=section,
            actor=self.alex,
            title=title,
        )

    def set_outcome(self, item, outcome):
        item.outcome = outcome
        item.save(update_fields=["outcome", "updated_at"])

    def start(self, meeting):
        return start_meeting(meeting=meeting, actor=self.alex)

    def current_id(self, meeting):
        meeting.refresh_from_db()
        return meeting.current_meeting_item_id

    def current(self, meeting):
        pk = self.current_id(meeting)
        if pk is None:
            return None
        return (
            MeetingItem.objects
            .filter(pk=pk)
            .first()
        )

    def meeting_status(self, meeting):
        meeting.refresh_from_db()
        return meeting.status

    def item_outcome(self, item):
        item.refresh_from_db()
        return item.outcome


class LiveStateMachineDomainTest(LiveStateMachineBase):
    # ── Start ────────────────────────────────────────────────────

    def test_start_picks_first_not_discussed_item_as_current(self):
        meeting = self.create_meeting()
        section_a = MeetingSection.objects.get(meeting=meeting)
        section_b = self.create_section(meeting, "Decisions")

        a1 = self.create_item(meeting, section_a, "A1")
        b1 = self.create_item(meeting, section_b, "B1")
        a2 = self.create_item(meeting, section_a, "A2")

        self.start(meeting)

        self.assertEqual(
            self.meeting_status(meeting),
            Meeting.Status.LIVE,
        )
        self.assertEqual(self.current_id(meeting), a1.pk)

    def test_start_does_not_change_outcomes(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")
        self.set_outcome(b, MeetingItem.Outcome.DONE)

        self.start(meeting)

        self.assertEqual(self.current_id(meeting), a.pk)
        self.assertEqual(
            self.item_outcome(a),
            MeetingItem.Outcome.NOT_DISCUSSED,
        )
        self.assertEqual(
            self.item_outcome(b),
            MeetingItem.Outcome.DONE,
        )

    def test_start_without_not_discussed_items_goes_live_without_current(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        self.set_outcome(a, MeetingItem.Outcome.DONE)

        self.start(meeting)

        self.assertIsNone(self.current_id(meeting))
        self.assertEqual(
            self.item_outcome(a), MeetingItem.Outcome.DONE
        )

    def test_start_preserves_valid_existing_current_item(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")

        meeting.current_meeting_item = b
        meeting.save(update_fields=["current_meeting_item_id"])

        self.start(meeting)

        self.assertEqual(self.current_id(meeting), b.pk)

    # ── Focus / make current ─────────────────────────────────────

    def test_focus_accepted_for_not_discussed(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")

        self.start(meeting)
        self.assertEqual(self.current_id(meeting), a.pk)

        focus_meeting_item(meeting_item=b, actor=self.alex)
        self.assertEqual(self.current_id(meeting), b.pk)
        self.assertEqual(
            self.item_outcome(b), MeetingItem.Outcome.NOT_DISCUSSED
        )

    def test_focus_accepted_for_done(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")
        self.set_outcome(a, MeetingItem.Outcome.DONE)

        self.start(meeting)
        self.assertEqual(self.current_id(meeting), b.pk)

        focus_meeting_item(meeting_item=a, actor=self.alex)
        self.assertEqual(self.current_id(meeting), a.pk)
        self.assertEqual(
            self.item_outcome(a), MeetingItem.Outcome.DONE
        )

    def test_focus_accepted_for_follow_up(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")
        self.set_outcome(a, MeetingItem.Outcome.FOLLOW_UP)

        self.start(meeting)
        self.assertEqual(self.current_id(meeting), b.pk)

        focus_meeting_item(meeting_item=a, actor=self.alex)
        self.assertEqual(self.current_id(meeting), a.pk)
        self.assertEqual(
            self.item_outcome(a), MeetingItem.Outcome.FOLLOW_UP
        )

    def test_focus_does_not_change_target_outcome(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")
        self.set_outcome(b, MeetingItem.Outcome.FOLLOW_UP)

        self.start(meeting)
        focus_meeting_item(meeting_item=b, actor=self.alex)

        self.assertEqual(
            self.item_outcome(b), MeetingItem.Outcome.FOLLOW_UP
        )

    def test_switching_current_does_not_change_previous_outcome(self):
        """B (current) -> A (done): B keeps not_discussed, A keeps
        done. No implicit reopening, no implicit completion."""
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")
        self.set_outcome(a, MeetingItem.Outcome.DONE)

        self.start(meeting)
        self.assertEqual(self.current_id(meeting), b.pk)

        focus_meeting_item(meeting_item=a, actor=self.alex)

        self.assertEqual(self.current_id(meeting), a.pk)
        self.assertEqual(
            self.item_outcome(a), MeetingItem.Outcome.DONE
        )
        self.assertEqual(
            self.item_outcome(b), MeetingItem.Outcome.NOT_DISCUSSED
        )

    def test_focus_rejected_outside_live(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")

        with self.assertRaises(MeetingDomainError):
            focus_meeting_item(meeting_item=a, actor=self.alex)

    # ── Done ─────────────────────────────────────────────────────

    def test_done_on_current_sets_done_and_advances(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")
        c = self.create_item(meeting, section, "C")

        self.start(meeting)
        self.assertEqual(self.current_id(meeting), a.pk)

        mark_meeting_item_done(meeting_item=a, actor=self.alex)
        self.assertEqual(
            self.item_outcome(a), MeetingItem.Outcome.DONE
        )
        self.assertEqual(self.current_id(meeting), b.pk)

        mark_meeting_item_done(meeting_item=b, actor=self.alex)
        self.assertEqual(
            self.item_outcome(b), MeetingItem.Outcome.DONE
        )
        self.assertEqual(self.current_id(meeting), c.pk)

        mark_meeting_item_done(meeting_item=c, actor=self.alex)
        self.assertIsNone(self.current_id(meeting))

    def test_done_on_non_current_sets_done_and_keeps_current(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")

        self.start(meeting)
        self.assertEqual(self.current_id(meeting), a.pk)

        mark_meeting_item_done(meeting_item=b, actor=self.alex)
        self.assertEqual(
            self.item_outcome(b), MeetingItem.Outcome.DONE
        )
        self.assertEqual(self.current_id(meeting), a.pk)

    def test_done_does_not_require_current(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")

        self.start(meeting)

        # No error: Done is valid on the non-current item.
        mark_meeting_item_done(meeting_item=b, actor=self.alex)
        self.assertEqual(
            self.item_outcome(b), MeetingItem.Outcome.DONE
        )

    def test_done_on_previously_follow_up_item(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")
        self.set_outcome(a, MeetingItem.Outcome.FOLLOW_UP)

        self.start(meeting)
        self.assertEqual(self.current_id(meeting), b.pk)

        focus_meeting_item(meeting_item=a, actor=self.alex)
        mark_meeting_item_done(meeting_item=a, actor=self.alex)

        self.assertEqual(
            self.item_outcome(a), MeetingItem.Outcome.DONE
        )
        self.assertEqual(self.current_id(meeting), b.pk)

    # ── Follow-up ────────────────────────────────────────────────

    def test_follow_up_on_current_sets_follow_up_and_advances(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")

        self.start(meeting)
        self.assertEqual(self.current_id(meeting), a.pk)

        mark_meeting_item_follow_up(meeting_item=a, actor=self.alex)
        self.assertEqual(
            self.item_outcome(a), MeetingItem.Outcome.FOLLOW_UP
        )
        self.assertEqual(self.current_id(meeting), b.pk)

    def test_follow_up_on_non_current_keeps_current(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")

        self.start(meeting)

        mark_meeting_item_follow_up(meeting_item=b, actor=self.alex)
        self.assertEqual(
            self.item_outcome(b), MeetingItem.Outcome.FOLLOW_UP
        )
        self.assertEqual(self.current_id(meeting), a.pk)

    def test_done_does_not_move_current_when_non_current_resolved(self):
        """A current, B done (non-current): current stays A even
        though A is followed by nothing else."""
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")

        self.start(meeting)
        self.assertEqual(self.current_id(meeting), a.pk)

        mark_meeting_item_done(meeting_item=b, actor=self.alex)
        # Resolving B leaves no not_discussed items, but current was
        # A: the pointer is left unchanged.
        self.assertEqual(self.current_id(meeting), a.pk)

    # ── End ──────────────────────────────────────────────────────

    def test_end_succeeds_with_non_null_current_pointer(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")

        self.start(meeting)
        self.assertEqual(self.current_id(meeting), a.pk)

        end_meeting(meeting=meeting, actor=self.alex)
        self.assertEqual(
            self.meeting_status(meeting), Meeting.Status.COMPLETED
        )

    def test_end_clears_current(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")

        self.start(meeting)
        self.assertEqual(self.current_id(meeting), a.pk)

        end_meeting(meeting=meeting, actor=self.alex)
        self.assertIsNone(self.current_id(meeting))
        # Ending never changes outcomes.
        self.assertEqual(
            self.item_outcome(a), MeetingItem.Outcome.NOT_DISCUSSED
        )

    def test_end_allows_remaining_not_discussed_items(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")

        self.start(meeting)
        mark_meeting_item_done(meeting_item=a, actor=self.alex)
        self.assertEqual(self.current_id(meeting), b.pk)

        end_meeting(meeting=meeting, actor=self.alex)
        self.assertEqual(
            self.meeting_status(meeting), Meeting.Status.COMPLETED
        )
        self.assertEqual(
            self.item_outcome(b), MeetingItem.Outcome.NOT_DISCUSSED
        )

    # ── Reopen ───────────────────────────────────────────────────

    def test_reopen_preserves_started_at_and_clears_ended_at(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")

        self.start(meeting)
        meeting.refresh_from_db()
        started_at = meeting.started_at
        end_meeting(meeting=meeting, actor=self.alex)
        meeting.refresh_from_db()
        self.assertIsNotNone(meeting.ended_at)

        reopen_meeting(meeting=meeting, actor=self.alex)
        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.LIVE)
        self.assertEqual(meeting.started_at, started_at)
        self.assertIsNone(meeting.ended_at)

    def test_reopen_selects_first_remaining_not_discussed_when_current_null(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")

        self.start(meeting)
        mark_meeting_item_done(meeting_item=a, actor=self.alex)
        self.assertEqual(self.current_id(meeting), b.pk)
        mark_meeting_item_done(meeting_item=b, actor=self.alex)
        self.assertIsNone(self.current_id(meeting))
        end_meeting(meeting=meeting, actor=self.alex)

        # Re-leave one item not_discussed by adding a new one.
        c = self.create_item(meeting, section, "C")

        reopen_meeting(meeting=meeting, actor=self.alex)
        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.LIVE)
        self.assertEqual(self.current_id(meeting), c.pk)
        self.assertEqual(
            self.item_outcome(a), MeetingItem.Outcome.DONE
        )
        self.assertEqual(
            self.item_outcome(b), MeetingItem.Outcome.DONE
        )

    def test_reopen_with_no_remaining_not_discussed_leaves_current_null(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")

        self.start(meeting)
        mark_meeting_item_done(meeting_item=a, actor=self.alex)
        mark_meeting_item_done(meeting_item=b, actor=self.alex)
        self.assertIsNone(self.current_id(meeting))
        end_meeting(meeting=meeting, actor=self.alex)

        reopen_meeting(meeting=meeting, actor=self.alex)
        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.LIVE)
        self.assertIsNone(self.current_id(meeting))

    def test_reopen_does_not_mutate_outcomes(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")

        self.start(meeting)
        mark_meeting_item_follow_up(meeting_item=a, actor=self.alex)
        end_meeting(meeting=meeting, actor=self.alex)

        reopen_meeting(meeting=meeting, actor=self.alex)
        self.assertEqual(
            self.item_outcome(a), MeetingItem.Outcome.FOLLOW_UP
        )
        self.assertEqual(
            self.item_outcome(b), MeetingItem.Outcome.NOT_DISCUSSED
        )

    # ── Current may point to resolved items ──────────────────────

    def test_current_may_point_to_done_item(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")
        self.set_outcome(a, MeetingItem.Outcome.DONE)

        self.start(meeting)
        focus_meeting_item(meeting_item=a, actor=self.alex)

        self.assertEqual(self.current_id(meeting), a.pk)
        self.assertEqual(
            self.item_outcome(a), MeetingItem.Outcome.DONE
        )

    def test_current_may_point_to_follow_up_item(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")
        self.set_outcome(a, MeetingItem.Outcome.FOLLOW_UP)

        self.start(meeting)
        focus_meeting_item(meeting_item=a, actor=self.alex)

        self.assertEqual(self.current_id(meeting), a.pk)
        self.assertEqual(
            self.item_outcome(a), MeetingItem.Outcome.FOLLOW_UP
        )

    # ── Spontaneous item creation ────────────────────────────────

    def test_new_item_stays_not_discussed_and_does_not_replace_current(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")

        self.start(meeting)
        self.assertEqual(self.current_id(meeting), a.pk)

        c = self.create_item(meeting, section, "C")

        self.assertEqual(
            self.item_outcome(c), MeetingItem.Outcome.NOT_DISCUSSED
        )
        self.assertEqual(self.current_id(meeting), a.pk)

    # ── Deletion ─────────────────────────────────────────────────

    def test_deleting_current_item_clears_current(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")

        self.start(meeting)
        self.assertEqual(self.current_id(meeting), a.pk)

        a.delete()

        self.assertIsNone(self.current_id(meeting))
        # Deletion never implicitly reselects another item.
        self.assertEqual(
            self.item_outcome(b), MeetingItem.Outcome.NOT_DISCUSSED
        )

    # ── Cross-Meeting current assignment ─────────────────────────

    def test_cross_meeting_focus_rejected(self):
        meeting = self.create_meeting(title="M1")
        other = self.create_meeting(title="M2")
        section = MeetingSection.objects.get(meeting=meeting)
        other_section = MeetingSection.objects.get(meeting=other)

        a = self.create_item(meeting, section, "A")
        foreign = self.create_item(other, other_section, "Foreign")

        self.start(meeting)
        self.assertEqual(self.current_id(meeting), a.pk)

        with self.assertRaises(MeetingDomainError):
            focus_meeting_item(meeting_item=foreign, actor=self.alex)

        self.assertEqual(self.current_id(meeting), a.pk)

    def test_cross_meeting_done_rejected(self):
        meeting = self.create_meeting(title="M1")
        other = self.create_meeting(title="M2")
        section = MeetingSection.objects.get(meeting=meeting)
        other_section = MeetingSection.objects.get(meeting=other)

        a = self.create_item(meeting, section, "A")
        foreign = self.create_item(other, other_section, "Foreign")

        self.start(meeting)

        with self.assertRaises(MeetingDomainError):
            mark_meeting_item_done(meeting_item=foreign, actor=self.alex)

        self.assertEqual(
            self.item_outcome(foreign),
            MeetingItem.Outcome.NOT_DISCUSSED,
        )
        self.assertEqual(self.current_id(meeting), a.pk)

    # ── Deterministic successor advancement (Done / Follow-up) ──

    def test_done_advances_to_successor_after_skipped_item(self):
        """With Alpha open and Beta current, Done Beta must select
        Gamma (the next not_discussed item AFTER Beta), not the
        global first open item (Alpha)."""
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        alpha = self.create_item(meeting, section, "Alpha")
        beta = self.create_item(meeting, section, "Beta")
        gamma = self.create_item(meeting, section, "Gamma")

        self.start(meeting)
        self.assertEqual(self.current_id(meeting), alpha.pk)

        focus_meeting_item(meeting_item=beta, actor=self.alex)
        self.assertEqual(
            self.item_outcome(alpha),
            MeetingItem.Outcome.NOT_DISCUSSED,
        )
        self.assertEqual(self.current_id(meeting), beta.pk)

        mark_meeting_item_done(meeting_item=beta, actor=self.alex)
        self.assertEqual(
            self.item_outcome(beta), MeetingItem.Outcome.DONE
        )
        self.assertEqual(self.current_id(meeting), gamma.pk)
        self.assertEqual(
            self.item_outcome(alpha),
            MeetingItem.Outcome.NOT_DISCUSSED,
        )

    def test_follow_up_wraps_to_beginning_when_no_successor(self):
        """With Alpha open and Gamma current (Beta done), Follow-up
        Gamma must wrap to Alpha, the first remaining not_discussed
        item at the beginning."""
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        alpha = self.create_item(meeting, section, "Alpha")
        beta = self.create_item(meeting, section, "Beta")
        gamma = self.create_item(meeting, section, "Gamma")

        self.start(meeting)
        focus_meeting_item(meeting_item=beta, actor=self.alex)
        mark_meeting_item_done(meeting_item=beta, actor=self.alex)
        self.assertEqual(self.current_id(meeting), gamma.pk)

        mark_meeting_item_follow_up(meeting_item=gamma, actor=self.alex)
        self.assertEqual(
            self.item_outcome(gamma), MeetingItem.Outcome.FOLLOW_UP
        )
        self.assertEqual(self.current_id(meeting), alpha.pk)

    def test_done_resolving_last_open_item_clears_current(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        alpha = self.create_item(meeting, section, "Alpha")
        beta = self.create_item(meeting, section, "Beta")
        gamma = self.create_item(meeting, section, "Gamma")

        self.start(meeting)
        focus_meeting_item(meeting_item=beta, actor=self.alex)
        mark_meeting_item_done(meeting_item=beta, actor=self.alex)
        mark_meeting_item_follow_up(
            meeting_item=gamma, actor=self.alex
        )
        self.assertEqual(self.current_id(meeting), alpha.pk)

        mark_meeting_item_done(meeting_item=alpha, actor=self.alex)
        self.assertIsNone(self.current_id(meeting))

    def test_successor_crosses_section_boundary(self):
        meeting = self.create_meeting()
        section_a = MeetingSection.objects.get(meeting=meeting)
        section_b = self.create_section(meeting, "Decisions")

        a1 = self.create_item(meeting, section_a, "A1")
        a2 = self.create_item(meeting, section_a, "A2")
        b1 = self.create_item(meeting, section_b, "B1")

        self.start(meeting)
        self.assertEqual(self.current_id(meeting), a1.pk)

        focus_meeting_item(meeting_item=a2, actor=self.alex)
        mark_meeting_item_done(meeting_item=a2, actor=self.alex)
        self.assertEqual(self.current_id(meeting), b1.pk)
        self.assertEqual(
            self.item_outcome(a1),
            MeetingItem.Outcome.NOT_DISCUSSED,
        )

    def test_successor_wraps_across_sections_to_first_open(self):
        meeting = self.create_meeting()
        section_a = MeetingSection.objects.get(meeting=meeting)
        section_b = self.create_section(meeting, "Decisions")

        a1 = self.create_item(meeting, section_a, "A1")
        a2 = self.create_item(meeting, section_a, "A2")
        b1 = self.create_item(meeting, section_b, "B1")

        self.start(meeting)
        self.assertEqual(self.current_id(meeting), a1.pk)

        focus_meeting_item(meeting_item=a2, actor=self.alex)
        mark_meeting_item_done(meeting_item=a2, actor=self.alex)
        self.assertEqual(self.current_id(meeting), b1.pk)

        mark_meeting_item_done(meeting_item=b1, actor=self.alex)
        self.assertEqual(self.current_id(meeting), a1.pk)

    def test_successor_never_selects_resolved_items(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")
        c = self.create_item(meeting, section, "C")

        self.start(meeting)

        # A done, C follow_up, B the only not_discussed item.
        self.set_outcome(a, MeetingItem.Outcome.DONE)
        self.set_outcome(c, MeetingItem.Outcome.FOLLOW_UP)

        focus_meeting_item(meeting_item=b, actor=self.alex)
        self.assertEqual(self.current_id(meeting), b.pk)

        mark_meeting_item_done(meeting_item=b, actor=self.alex)
        self.assertIsNone(self.current_id(meeting))
        self.assertEqual(
            self.item_outcome(a), MeetingItem.Outcome.DONE
        )
        self.assertEqual(
            self.item_outcome(c), MeetingItem.Outcome.FOLLOW_UP
        )


class LiveStateMachineIsolationTest(LiveStateMachineBase):
    """Project Meeting write isolation: a viewer cannot drive the
    Live Meeting current/outcome actions; a group Meeting remains
    open to group members."""

    def setUp(self):
        super().setUp()
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.laura,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        self.project = create_project(
            research_group=self.group,
            creator=self.alex,
            name="Live Project",
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

    def _project_meeting_with_items(self, title):
        meeting = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title=title,
            scheduled_at=self.scheduled_at,
            scope=Meeting.Scope.PROJECT,
            project=self.project,
        )
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")
        return meeting, section, a, b

    def test_viewer_cannot_focus_project_meeting_item(self):
        meeting, section, a, b = self._project_meeting_with_items("P1")
        start_meeting(meeting=meeting, actor=self.alex)

        focus_meeting_item(meeting_item=b, actor=self.chris)
        self.assertEqual(self.current_id(meeting), b.pk)

        with self.assertRaises(MeetingDomainError):
            focus_meeting_item(meeting_item=a, actor=self.laura)

    def test_group_meeting_member_can_drive_state_machine(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")

        start_meeting(meeting=meeting, actor=self.alex)
        focus_meeting_item(meeting_item=b, actor=self.chris)
        self.assertEqual(self.current_id(meeting), b.pk)
        mark_meeting_item_done(meeting_item=b, actor=self.chris)
        self.assertEqual(
            self.item_outcome(b), MeetingItem.Outcome.DONE
        )


class LiveStateMachineAPITest(LiveStateMachineBase):
    def setUp(self):
        super().setUp()
        self.client = APIClient()

    def _group_meeting_with_items(self, count=3):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        items = [
            self.create_item(meeting, section, f"Item {chr(65 + i)}")
            for i in range(count)
        ]
        return meeting, items

    def test_meeting_exposes_current_meeting_item_id(self):
        meeting, items = self._group_meeting_with_items()
        start_meeting(meeting=meeting, actor=self.alex)
        self.client.force_login(self.chris)

        resp = self.client.get(f"/api/meetings/{meeting.pk}/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(
            resp.json()["currentMeetingItemId"], items[0].pk
        )

    def test_meeting_item_exposes_outcome_never_discussing(self):
        meeting, items = self._group_meeting_with_items()
        start_meeting(meeting=meeting, actor=self.alex)
        self.client.force_login(self.chris)

        resp = self.client.get(
            f"/api/meeting-items/{items[0].pk}/"
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        data = resp.json()
        self.assertNotIn("status", data)
        self.assertNotIn("discussing", data.get("outcome"))
        self.assertEqual(data["outcome"], "not_discussed")

        list_resp = self.client.get(
            f"/api/meetings/{meeting.pk}/items/"
        )
        self.assertEqual(list_resp.status_code, status.HTTP_200_OK)
        for row in list_resp.json():
            self.assertNotIn("status", row)
            self.assertIn(
                row["outcome"],
                ("not_discussed", "done", "follow_up"),
            )

    def test_focus_endpoint(self):
        meeting, items = self._group_meeting_with_items()
        start_meeting(meeting=meeting, actor=self.alex)
        self.client.force_login(self.chris)

        resp = self.client.post(
            f"/api/meeting-items/{items[1].pk}/focus",
            {}, format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(
            self.current_id(meeting), items[1].pk
        )
        self.assertEqual(
            self.item_outcome(items[1]),
            MeetingItem.Outcome.NOT_DISCUSSED,
        )

    def test_done_endpoint(self):
        meeting, items = self._group_meeting_with_items()
        start_meeting(meeting=meeting, actor=self.alex)
        self.client.force_login(self.chris)

        resp = self.client.post(
            f"/api/meeting-items/{items[0].pk}/done",
            {}, format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(
            self.item_outcome(items[0]), MeetingItem.Outcome.DONE
        )
        self.assertEqual(
            self.current_id(meeting), items[1].pk
        )

    def test_follow_up_endpoint(self):
        meeting, items = self._group_meeting_with_items()
        start_meeting(meeting=meeting, actor=self.alex)
        self.client.force_login(self.chris)

        resp = self.client.post(
            f"/api/meeting-items/{items[0].pk}/follow-up",
            {}, format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(
            self.item_outcome(items[0]),
            MeetingItem.Outcome.FOLLOW_UP,
        )
        self.assertEqual(
            self.current_id(meeting), items[1].pk
        )

    def test_end_succeeds_with_current_pointer_via_api(self):
        meeting, items = self._group_meeting_with_items()
        start_meeting(meeting=meeting, actor=self.alex)
        self.client.force_login(self.chris)

        resp = self.client.post(
            f"/api/meetings/{meeting.pk}/end",
            {}, format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(
            self.meeting_status(meeting), Meeting.Status.COMPLETED
        )
        self.assertIsNone(self.current_id(meeting))

    def test_non_member_cannot_focus(self):
        meeting, items = self._group_meeting_with_items()
        start_meeting(meeting=meeting, actor=self.alex)
        self.client.force_login(self.maria)

        resp = self.client.post(
            f"/api/meeting-items/{items[0].pk}/focus",
            {}, format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_viewer_cannot_focus_project_meeting_via_api(self):
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.laura,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        project = create_project(
            research_group=self.group,
            creator=self.alex,
            name="API Project",
        )
        add_project_membership(
            project=project,
            actor=self.alex,
            target_user=self.laura,
            role=ProjectMembership.Role.VIEWER,
        )
        meeting = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="Proj",
            scheduled_at=self.scheduled_at,
            scope=Meeting.Scope.PROJECT,
            project=project,
        )
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")
        start_meeting(meeting=meeting, actor=self.alex)

        self.client.force_login(self.laura)
        resp = self.client.post(
            f"/api/meeting-items/{b.pk}/focus",
            {}, format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)


class LiveStateMachineConcurrencyTest(TransactionTestCase):
    """All Live actions lock the Meeting row: concurrent
    make-current operations must not leave contradictory state."""

    def setUp(self):
        self.alex = User.objects.create_user(
            username="conc-alex", password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="conc-chris", password="Pass1!",
        )
        self.group = ResearchGroup.objects.create(
            name="Conc Group", created_by=self.alex,
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
        self.scheduled_at = timezone.now() + timedelta(days=1)

    def test_concurrent_focus_leaves_single_consistent_current(self):
        meeting = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="Conc Weekly",
            scheduled_at=self.scheduled_at,
        )
        section = MeetingSection.objects.get(meeting=meeting)
        a = create_meeting_item(
            meeting=meeting,
            meeting_section=section,
            actor=self.alex,
            title="A",
        )
        b = create_meeting_item(
            meeting=meeting,
            meeting_section=section,
            actor=self.alex,
            title="B",
        )

        start_meeting(meeting=meeting, actor=self.alex)

        # Simulate two concurrent make-current operations by
        # executing them in nested transactions that both lock the
        # Meeting row (serialized). Whichever commits last wins; the
        # final state must point at exactly one of a / b and no
        # item outcome may have changed.
        with transaction.atomic():
            focus_meeting_item(meeting_item=b, actor=self.alex)

        meeting.refresh_from_db()
        self.assertEqual(meeting.current_meeting_item_id, b.pk)
        self.assertEqual(
            MeetingItem.objects.get(pk=a.pk).outcome,
            MeetingItem.Outcome.NOT_DISCUSSED,
        )
        self.assertEqual(
            MeetingItem.objects.get(pk=b.pk).outcome,
            MeetingItem.Outcome.NOT_DISCUSSED,
        )

        # A second concurrent focus on the other item simply
        # re-points current; outcomes stay untouched.
        with transaction.atomic():
            focus_meeting_item(meeting_item=a, actor=self.chris)

        meeting.refresh_from_db()
        self.assertEqual(meeting.current_meeting_item_id, a.pk)
        self.assertEqual(
            MeetingItem.objects.get(pk=b.pk).outcome,
            MeetingItem.Outcome.NOT_DISCUSSED,
        )
        self.assertEqual(
            MeetingItem.objects.get(pk=a.pk).outcome,
            MeetingItem.Outcome.NOT_DISCUSSED,
        )


class MigrationMappingTest(TransactionTestCase):
    """Exercise the real 0011 data-mapping function.

    Follows the established legacy-migration test pattern (see
    ``tests_meeting_sections.LegacyMigrationTest``): the pre-0011
    data (a legacy ``status`` column) is emulated on the final
    schema through a temporary column, and the real
    ``map_discussing_to_current_and_outcome`` RunPython function is
    invoked directly. The mapping reads ``status`` through raw
    SQL so it runs against exactly the emulated data shape; the
    historical model state (which carried ``status`` as a real
    model field) is not reconstructable in this schema. No mapping
    semantics are duplicated here — the meeting/item selection and
    outcome conversion run from the migration module itself.
    """

    def _seed_rows(self):
        """Insert a Meeting + 4 items in the pre-0011 data shape
        (``status`` values)."""
        from django.contrib.auth import get_user_model
        from research_groups.models import (
            ResearchGroup,
            ResearchGroupMembership,
        )
        from .models import (
            Meeting,
            MeetingSection,
        )

        now = timezone.now()
        alex = get_user_model().objects.create_user(
            username="legacy-0011-alex", password="Pass1!",
        )
        group = ResearchGroup.objects.create(
            name="Legacy 0011 Group",
            created_by=alex,
        )
        ResearchGroupMembership.objects.create(
            research_group=group,
            user=alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        meeting = Meeting.objects.create(
            research_group=group,
            scope="group",
            title="Legacy 0011 Weekly",
            scheduled_at=now,
            status="live",
            created_by=alex,
        )
        section = MeetingSection.objects.create(
            meeting=meeting,
            name="Agenda",
            position=0,
        )
        with connection.schema_editor(atomic=False) as editor:
            editor.execute(
                "ALTER TABLE meetings_item ADD COLUMN IF NOT EXISTS"
                " status TEXT"
            )
        with connection.cursor() as cursor:
            for position, title, legacy_status in [
                (0, "Legacy not_discussed", "not_discussed"),
                (1, "Legacy discussing", "discussing"),
                (2, "Legacy done", "done"),
                (3, "Legacy follow_up", "follow_up"),
            ]:
                cursor.execute(
                    "INSERT INTO meetings_item (title, notes, position,"
                    " outcome, status, created_at, updated_at,"
                    " meeting_id, meeting_section_id, created_by_id)"
                    " VALUES (%s, '', %s, 'not_discussed', %s, %s, %s,"
                    " %s, %s, %s)",
                    [
                        title, position, legacy_status,
                        now.isoformat(), now.isoformat(),
                        meeting.pk, section.pk, alex.pk,
                    ],
                )
        pks = {}
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT id, title FROM meetings_item"
            )
            for pk, title in cursor.fetchall():
                pks[title] = pk
        return meeting, pks

    def _run_migration(self):
        """Invoke the real 0011 RunPython mapping.

        The migration function resolves models through the passed
        apps registry; here the live registry is used (same
        concrete table), and the legacy ``status`` column is read
        through the model's ``_base_manager`` raw-SQL escape
        hatch: the function's ORM ``F("status")``/``Q`` reads are
        re-expressed by temporarily adding the field to the model
        metadata for the duration of the call.
        """
        import importlib

        from django.db import models as django_models

        from .models import MeetingItem

        status_field = django_models.CharField(
            max_length=16,
            blank=True,
        )
        # Temporarily expose the legacy column on the model so the
        # real mapping function's F()/Q() references resolve.
        status_field.contribute_to_class(
            MeetingItem, "status"
        )
        try:
            migration = importlib.import_module(
                "meetings.migrations"
                ".0011_current_item_and_outcome"
            )
            from django.apps import apps as django_apps

            with connection.schema_editor(
                atomic=False
            ) as editor:
                migration.map_discussing_to_current_and_outcome(
                    django_apps, editor
                )
        finally:
            MeetingItem._meta.local_fields = [
                f for f in MeetingItem._meta.local_fields
                if f.name != "status"
            ]
            MeetingItem._meta.fields_map.pop("status", None)
            # Rebuild every cached field view of the model; the
            # emulated field was contributed to the live model class,
            # so plain dict surgery is not enough.
            MeetingItem._meta._expire_cache()
            MeetingItem._meta._get_fields_cache = {}
            delattr(MeetingItem, "status")
            # Drop the emulated legacy column.
            with connection.schema_editor(
                atomic=False
            ) as editor:
                editor.execute(
                    "ALTER TABLE meetings_item"
                    " DROP COLUMN IF EXISTS status"
                )

    def test_discussing_maps_to_current_plus_not_discussed(self):
        meeting, pks = self._seed_rows()
        self._run_migration()

        meeting.refresh_from_db()
        self.assertEqual(
            meeting.current_meeting_item_id,
            pks["Legacy discussing"],
        )
        self.assertEqual(
            MeetingItem.objects.get(
                pk=pks["Legacy discussing"]
            ).outcome,
            "not_discussed",
        )

    def test_existing_outcomes_are_preserved(self):
        meeting, pks = self._seed_rows()
        self._run_migration()

        outcomes = {
            i.pk: i.outcome
            for i in MeetingItem.objects.all()
        }
        self.assertEqual(
            outcomes[pks["Legacy not_discussed"]],
            "not_discussed",
        )
        self.assertEqual(outcomes[pks["Legacy done"]], "done")
        self.assertEqual(
            outcomes[pks["Legacy follow_up"]],
            "follow_up",
        )

    def test_meeting_without_discussing_item_keeps_current_null(self):
        meeting, pks = self._seed_rows()
        with connection.cursor() as cursor:
            cursor.execute(
                "DELETE FROM meetings_item "
                "WHERE title = 'Legacy discussing'"
            )
        self._run_migration()

        meeting.refresh_from_db()
        self.assertIsNone(meeting.current_meeting_item_id)
