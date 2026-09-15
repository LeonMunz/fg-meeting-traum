"""Home "Today & next" — timeline candidate read model tests.

Proves the canonical semantics of
``home_timeline.timeline.get_home_timeline_candidates``:

- half-open 7-calendar-day window including Today (Meetings on
  ``scheduled_at``, Work Items on date-only ``due_date``)
- Meeting lifecycle: only ``upcoming`` (live / completed / stale
  past excluded)
- Meeting authorization: canonical ``MEETING_READ`` (creator or
  explicit current participant) — Group/Project membership, admin
  status, and ownership grant nothing; participant removal revokes
  at read time
- Work Item authorization: current assignment + current
  Project/Research Group eligibility (My Work boundary) —
  membership removal revokes at read time; ``done`` excluded
- overdue excluded by the forward window (Needs attention's
  responsibility); blocked due-in-window items REMAIN eligible in
  both read models (behavioral overlap)
- Meeting follow-ups are never separate timeline candidates
- deterministic cross-domain ordering ``(sort_at, domain_rank,
  object_id)``: Work Items as all-day entries, Work Item wins exact
  midnight ties, ID ascending within a domain
- flat unbounded result (no 7-row truncation, no buckets)
- bounded query count: two domain queries, no N+1

Time is frozen for every test: ``_observe_clock`` is patched to a
fixed single observation, so no test depends on the wall clock.
"""

from datetime import date, datetime, time, timedelta
from unittest import mock

from django.contrib.auth import get_user_model
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from research_groups.models import ResearchGroup, ResearchGroupMembership
from projects.models import ProjectMembership
from projects.services import create_project, add_project_membership

from meetings.models import Meeting, MeetingParticipant
from meetings.services import (
    create_meeting,
    create_meeting_item,
    end_meeting,
    schedule_meeting_item_follow_up,
    start_meeting,
)

from work_items.models import WorkItemAssignee
from work_items.services import create_work_item
from work_items.home_attention import get_work_item_attention_candidates

from home_timeline.timeline import (
    DOMAIN_MEETING,
    DOMAIN_WORK_ITEM,
    get_home_timeline_candidates,
)

# Frozen single clock observation for every test in this module:
# Today = 2026-09-15; window = [2026-09-15T00:00, 2026-09-22T00:00).
TODAY = date(2026, 9, 15)
WINDOW_START = timezone.make_aware(datetime(2026, 9, 15))
WINDOW_END = WINDOW_START + timedelta(days=7)

User = get_user_model()

SEED_PASSWORD = "DevPass1!"


def _create_standard_data():
    """Create the standard Foundation 4 test scenario + an outsider.

    Paper XYZ:
      Alex: owner (Research Group admin)
      Chris: member
      Laura: viewer
      Maria: no ProjectMembership (Research Group member only)
      Outsider: no memberships at all
    """
    alex = User.objects.create_user(username="alex", password=SEED_PASSWORD)
    chris = User.objects.create_user(username="chris", password=SEED_PASSWORD)
    maria = User.objects.create_user(username="maria", password=SEED_PASSWORD)
    laura = User.objects.create_user(username="laura", password=SEED_PASSWORD)
    outsider = User.objects.create_user(
        username="outsider", password=SEED_PASSWORD,
    )

    group = ResearchGroup.objects.create(name="FG Example", created_by=alex)
    for user, role in (
        (alex, ResearchGroupMembership.Role.ADMIN),
        (chris, ResearchGroupMembership.Role.MEMBER),
        (maria, ResearchGroupMembership.Role.MEMBER),
        (laura, ResearchGroupMembership.Role.MEMBER),
    ):
        ResearchGroupMembership.objects.create(
            research_group=group, user=user, role=role,
        )

    paper_xyz = create_project(
        research_group=group, creator=alex, name="Paper XYZ"
    )
    add_project_membership(
        project=paper_xyz, actor=alex,
        target_user=chris, role=ProjectMembership.Role.MEMBER,
    )
    add_project_membership(
        project=paper_xyz, actor=alex,
        target_user=laura, role=ProjectMembership.Role.VIEWER,
    )

    return {
        "group": group,
        "alex": alex,
        "chris": chris,
        "maria": maria,
        "laura": laura,
        "outsider": outsider,
        "paper_xyz": paper_xyz,
    }


def _at(day: date, hour: int = 10, minute: int = 0) -> datetime:
    """Aware application-timezone datetime at ``day hour:minute``."""
    return timezone.make_aware(datetime.combine(day, time(hour, minute)))


def _iso(d: date) -> str:
    return d.isoformat()


class _TimelineBase(TestCase):
    """Base with the frozen single clock observation."""

    def setUp(self):
        super().setUp()
        self.data = _create_standard_data()
        self.project = self.data["paper_xyz"]
        self.task_type = self.project.type_definitions.get(name="Task")
        self.done_status = self.project.status_definitions.get(name="Done")
        self._clock_patch = mock.patch(
            "home_timeline.timeline._observe_clock",
            return_value=(TODAY, WINDOW_START, WINDOW_END),
        )
        self._clock_patch.start()
        self.addCleanup(self._clock_patch.stop)

    # ── fixtures ──

    def _make_wi(self, *, title, assignees=(), due_date=None,
                 blocked_reason=None, status_id=None):
        return create_work_item(
            project=self.project,
            actor=self.data["alex"],
            type_definition_id=self.task_type.pk,
            title=title,
            status_definition_id=status_id,
            assignee_ids=[u.pk for u in assignees],
            due_date=_iso(due_date) if due_date is not None else None,
            blocked_reason=blocked_reason,
        )

    def _make_meeting(self, *, title, scheduled_at, actor=None,
                      participants=(), scope=Meeting.Scope.GROUP,
                      project=None, status=None):
        return create_meeting(
            research_group=self.data["group"],
            actor=actor or self.data["alex"],
            title=title,
            scheduled_at=scheduled_at,
            status=status,
            scope=scope,
            project=project,
            participants=participants,
        )

    # ── projection helpers ──

    def _candidates(self, user):
        return get_home_timeline_candidates(user=user)

    def _pairs(self, user):
        """Ordered (domain, object_id) list."""
        return [(c.domain, c.object_id) for c in self._candidates(user)]

    def _meeting_ids(self, user):
        return [
            c.object_id
            for c in self._candidates(user)
            if c.domain == DOMAIN_MEETING
        ]

    def _wi_ids(self, user):
        return [
            c.object_id
            for c in self._candidates(user)
            if c.domain == DOMAIN_WORK_ITEM
        ]


# ── Window boundaries ──


class WindowBoundaryTest(_TimelineBase):

    def test_meeting_today_appears(self):
        m = self._make_meeting(
            title="Today", scheduled_at=_at(TODAY, 10),
        )
        self.assertEqual(self._meeting_ids(self.data["alex"]), [m.pk])

    def test_meeting_exactly_at_start_of_today_included(self):
        m = self._make_meeting(
            title="Midnight today", scheduled_at=WINDOW_START,
        )
        self.assertEqual(self._meeting_ids(self.data["alex"]), [m.pk])

    def test_meeting_tomorrow_appears(self):
        m = self._make_meeting(
            title="Tomorrow", scheduled_at=_at(TODAY + timedelta(days=1), 9),
        )
        self.assertEqual(self._meeting_ids(self.data["alex"]), [m.pk])

    def test_meeting_today_plus_six_appears(self):
        m = self._make_meeting(
            title="Today+6", scheduled_at=_at(TODAY + timedelta(days=6), 18),
        )
        self.assertEqual(self._meeting_ids(self.data["alex"]), [m.pk])

    def test_meeting_exactly_at_start_of_today_plus_seven_excluded(self):
        m = self._make_meeting(
            title="Today+7 boundary", scheduled_at=WINDOW_END,
        )
        self.assertEqual(self._meeting_ids(self.data["alex"]), [])
        self.assertFalse(m.scheduled_at < WINDOW_END)

    def test_meeting_before_start_of_today_excluded(self):
        m = self._make_meeting(
            title="Yesterday", scheduled_at=_at(TODAY - timedelta(days=1), 23, 59),
        )
        self.assertEqual(self._meeting_ids(self.data["alex"]), [])

    def test_work_item_due_today_appears(self):
        wi = self._make_wi(
            title="Due today", assignees=[self.data["chris"]],
            due_date=TODAY,
        )
        self.assertEqual(self._wi_ids(self.data["chris"]), [wi.pk])

    def test_work_item_due_today_plus_six_appears(self):
        wi = self._make_wi(
            title="Due today+6", assignees=[self.data["chris"]],
            due_date=TODAY + timedelta(days=6),
        )
        self.assertEqual(self._wi_ids(self.data["chris"]), [wi.pk])

    def test_work_item_due_today_plus_seven_excluded(self):
        wi = self._make_wi(
            title="Due today+7 boundary", assignees=[self.data["chris"]],
            due_date=TODAY + timedelta(days=7),
        )
        self.assertEqual(self._wi_ids(self.data["chris"]), [])

    def test_overdue_work_item_excluded(self):
        wi = self._make_wi(
            title="Overdue", assignees=[self.data["chris"]],
            due_date=TODAY - timedelta(days=1),
        )
        self.assertEqual(self._wi_ids(self.data["chris"]), [])
        self.assertNotIn(wi.pk, self._wi_ids(self.data["chris"]))

    def test_work_item_without_due_date_excluded(self):
        wi = self._make_wi(
            title="No due date", assignees=[self.data["chris"]],
        )
        self.assertEqual(self._wi_ids(self.data["chris"]), [])


# ── Meeting lifecycle ──


class MeetingLifecycleTest(_TimelineBase):

    def test_upcoming_meeting_appears(self):
        m = self._make_meeting(
            title="Upcoming", scheduled_at=_at(TODAY + timedelta(days=1), 12),
        )
        self.assertEqual(m.status, Meeting.Status.UPCOMING)
        self.assertEqual(self._meeting_ids(self.data["alex"]), [m.pk])

    def test_live_meeting_does_not_appear(self):
        m = self._make_meeting(
            title="Then live", scheduled_at=_at(TODAY + timedelta(days=1), 12),
        )
        start_meeting(meeting=m, actor=self.data["alex"])
        m.refresh_from_db()
        self.assertEqual(m.status, Meeting.Status.LIVE)
        self.assertEqual(self._meeting_ids(self.data["alex"]), [])

    def test_completed_meeting_does_not_appear(self):
        m = self._make_meeting(
            title="Then completed", scheduled_at=_at(TODAY + timedelta(days=1), 12),
        )
        start_meeting(meeting=m, actor=self.data["alex"])
        end_meeting(meeting=m, actor=self.data["alex"])
        m.refresh_from_db()
        self.assertEqual(m.status, Meeting.Status.COMPLETED)
        self.assertEqual(self._meeting_ids(self.data["alex"]), [])

    def test_past_stale_upcoming_meeting_does_not_appear(self):
        m = self._make_meeting(
            title="Stale upcoming", scheduled_at=_at(TODAY - timedelta(days=3), 9),
        )
        self.assertEqual(m.status, Meeting.Status.UPCOMING)
        self.assertEqual(self._meeting_ids(self.data["alex"]), [])


# ── Meeting authorization ──


class MeetingAuthorizationTest(_TimelineBase):

    def test_creator_sees_candidate(self):
        m = self._make_meeting(
            title="Alex's meeting", scheduled_at=_at(TODAY + timedelta(days=1), 10),
            actor=self.data["alex"],
        )
        self.assertEqual(self._meeting_ids(self.data["alex"]), [m.pk])

    def test_explicit_participant_sees_candidate(self):
        m = self._make_meeting(
            title="With Chris", scheduled_at=_at(TODAY + timedelta(days=1), 10),
            actor=self.data["alex"],
            participants=[self.data["chris"]],
        )
        self.assertEqual(self._meeting_ids(self.data["chris"]), [m.pk])

    def test_project_member_without_meeting_read_does_not_see(self):
        # Project-scoped meeting in Paper XYZ: Chris is a Project
        # MEMBER but neither creator nor participant → no read.
        m = self._make_meeting(
            title="Project meeting", scheduled_at=_at(TODAY + timedelta(days=1), 10),
            actor=self.data["alex"],
            scope=Meeting.Scope.PROJECT,
            project=self.project,
            participants=[self.data["laura"]],
        )
        self.assertEqual(self._meeting_ids(self.data["chris"]), [])
        # ... and the participant does see it.
        self.assertEqual(self._meeting_ids(self.data["laura"]), [m.pk])

    def test_research_group_admin_without_meeting_read_does_not_see(self):
        # Chris (plain member) creates; Alex is the Research Group
        # ADMIN and a group member — admin status grants nothing.
        m = self._make_meeting(
            title="Chris's group meeting",
            scheduled_at=_at(TODAY + timedelta(days=2), 10),
            actor=self.data["chris"],
            participants=[self.data["maria"]],
        )
        self.assertEqual(self._meeting_ids(self.data["alex"]), [])
        # A plain Research Group member without read also sees nothing.
        self.assertEqual(self._meeting_ids(self.data["laura"]), [])
        # The explicit participant sees it.
        self.assertEqual(self._meeting_ids(self.data["maria"]), [m.pk])

    def test_outsider_does_not_see(self):
        m = self._make_meeting(
            title="Insider meeting", scheduled_at=_at(TODAY + timedelta(days=1), 10),
            actor=self.data["alex"],
            participants=[self.data["chris"]],
        )
        self.assertEqual(self._pairs(self.data["outsider"]), [])
        self.assertEqual(self._meeting_ids(self.data["chris"]), [m.pk])

    def test_participant_removal_removes_candidate_at_read_time(self):
        m = self._make_meeting(
            title="Laura invited", scheduled_at=_at(TODAY + timedelta(days=1), 10),
            actor=self.data["alex"],
            participants=[self.data["laura"]],
        )
        self.assertEqual(self._meeting_ids(self.data["laura"]), [m.pk])

        # Revocation at read time: the participant row is removed ...
        removed = MeetingParticipant.objects.filter(
            meeting=m, user=self.data["laura"],
        ).delete()
        self.assertGreaterEqual(removed[0], 1)

        # ... and the candidate is immediately gone.
        self.assertEqual(self._meeting_ids(self.data["laura"]), [])


# ── Work Item authorization ──


class WorkItemAuthorizationTest(_TimelineBase):

    def test_assigned_eligible_work_item_appears(self):
        wi = self._make_wi(
            title="Chris's due task", assignees=[self.data["chris"]],
            due_date=TODAY + timedelta(days=2),
        )
        self.assertEqual(self._wi_ids(self.data["chris"]), [wi.pk])

    def test_unassigned_item_does_not(self):
        wi = self._make_wi(
            title="Unassigned due task", due_date=TODAY + timedelta(days=1),
        )
        for user in (self.data["alex"], self.data["chris"]):
            self.assertEqual(self._wi_ids(user), [])
        self.assertFalse(wi.assignee_relations.exists())

    def test_item_assigned_only_to_another_user_does_not(self):
        wi = self._make_wi(
            title="Alex's due task", assignees=[self.data["alex"]],
            due_date=TODAY + timedelta(days=1),
        )
        self.assertEqual(self._wi_ids(self.data["chris"]), [])
        self.assertEqual(self._wi_ids(self.data["alex"]), [wi.pk])

    def test_project_membership_removal_removes_it(self):
        wi = self._make_wi(
            title="Then revoked", assignees=[self.data["chris"]],
            due_date=TODAY + timedelta(days=1),
        )
        ProjectMembership.objects.filter(
            project=self.project, user=self.data["chris"],
        ).delete()

        # The stale assignment row still exists ...
        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=wi, user=self.data["chris"],
            ).exists()
        )
        # ... but the candidate is gone.
        self.assertEqual(self._wi_ids(self.data["chris"]), [])

    def test_research_group_membership_removal_removes_it(self):
        wi = self._make_wi(
            title="Group membership revoked",
            assignees=[self.data["chris"]],
            due_date=TODAY + timedelta(days=1),
        )
        # The composite FK requires the ProjectMembership to go first.
        ProjectMembership.objects.filter(
            project=self.project, user=self.data["chris"],
        ).delete()
        ResearchGroupMembership.objects.filter(
            research_group=self.data["group"], user=self.data["chris"],
        ).delete()

        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=wi, user=self.data["chris"],
            ).exists()
        )
        self.assertEqual(self._wi_ids(self.data["chris"]), [])

    def test_done_item_excluded(self):
        wi = self._make_wi(
            title="Done in window", assignees=[self.data["chris"]],
            due_date=TODAY + timedelta(days=1),
            status_id=self.done_status.pk,
        )
        self.assertEqual(
            wi.status_definition.category, "done",
        )
        self.assertEqual(self._wi_ids(self.data["chris"]), [])


# ── Blocked / overdue vs Needs attention overlap ──


class BlockedAndAttentionOverlapTest(_TimelineBase):
    """The two read models are tested BEHAVIORALLY, side by side —
    never by coupling the implementations."""

    def _attention_wi_ids(self, user):
        return [
            c.work_item_id
            for c in get_work_item_attention_candidates(user=user)
        ]

    def _with_frozen_attention_clock(self):
        patcher = mock.patch(
            "work_items.home_attention._current_application_date",
            return_value=TODAY,
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_blocked_due_in_window_work_item_remains_in_timeline(self):
        wi = self._make_wi(
            title="Blocked but due soon",
            assignees=[self.data["chris"]],
            due_date=TODAY + timedelta(days=3),
            blocked_reason="Waiting on dataset access",
        )
        self.assertEqual(self._wi_ids(self.data["chris"]), [wi.pk])
        (candidate,) = self._candidates(self.data["chris"])
        self.assertEqual(candidate.details.blocked_reason,
                         "Waiting on dataset access")

    def test_same_work_item_independently_qualifies_for_needs_attention(self):
        self._with_frozen_attention_clock()
        wi = self._make_wi(
            title="Blocked and due soon",
            assignees=[self.data["chris"]],
            due_date=TODAY + timedelta(days=3),
            blocked_reason="Blocked",
        )
        self.assertIn(wi.pk, self._wi_ids(self.data["chris"]))
        self.assertIn(wi.pk, self._attention_wi_ids(self.data["chris"]))

    def test_overdue_work_item_absent_from_timeline_but_in_attention(self):
        self._with_frozen_attention_clock()
        wi = self._make_wi(
            title="Overdue", assignees=[self.data["chris"]],
            due_date=TODAY - timedelta(days=1),
        )
        # Timeline: absent (forward window only).
        self.assertEqual(self._wi_ids(self.data["chris"]), [])
        # Needs attention: still included (its canonical semantics).
        self.assertEqual(self._attention_wi_ids(self.data["chris"]), [wi.pk])


# ── Meeting follow-ups are not candidates ──


class FollowUpNotACandidateTest(_TimelineBase):

    def test_follow_up_target_meeting_not_duplicated(self):
        source = self._make_meeting(
            title="Past standup",
            scheduled_at=_at(TODAY - timedelta(days=2), 9),
        )
        target = self._make_meeting(
            title="Next standup",
            scheduled_at=_at(TODAY + timedelta(days=2), 9),
        )
        source_section = source.meeting_sections.first()
        target_section = target.meeting_sections.first()
        source_item = create_meeting_item(
            meeting=source,
            meeting_section=source_section,
            actor=self.data["alex"],
            title="Carry-over topic",
        )
        schedule_meeting_item_follow_up(
            source_meeting_item=source_item,
            target_meeting=target,
            target_meeting_section=target_section,
            actor=self.data["alex"],
        )

        # The target Meeting represents the future time event exactly
        # once; the follow-up adds no extra row of any kind.
        candidates = self._candidates(self.data["alex"])
        self.assertEqual(self._meeting_ids(self.data["alex"]), [target.pk])
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0].domain, DOMAIN_MEETING)

    def test_unreadable_target_follow_up_produces_nothing(self):
        source = self._make_meeting(
            title="Past sync",
            scheduled_at=_at(TODAY - timedelta(days=2), 9),
        )
        # Created by Chris (the creator is auto-participant); Alex is
        # neither creator nor participant → Alex cannot read it.
        # Group-scoped MEETING_WRITE is GROUP_READ, so Alex may still
        # schedule the follow-up into it.
        target = self._make_meeting(
            title="Next sync (Chris only)",
            scheduled_at=_at(TODAY + timedelta(days=2), 9),
            actor=self.data["chris"],
        )
        source_section = source.meeting_sections.first()
        target_section = target.meeting_sections.first()
        source_item = create_meeting_item(
            meeting=source,
            meeting_section=source_section,
            actor=self.data["alex"],
            title="Carry-over",
        )
        schedule_meeting_item_follow_up(
            source_meeting_item=source_item,
            target_meeting=target,
            target_meeting_section=target_section,
            actor=self.data["alex"],
        )

        # Alex cannot read the target Meeting: the follow-up must not
        # leak it (no target row, no follow-up row).
        self.assertEqual(self._candidates(self.data["alex"]), [])
        # ... while Chris sees exactly the target Meeting once.
        self.assertEqual(self._meeting_ids(self.data["chris"]), [target.pk])


# ── Deterministic cross-domain ordering ──


class OrderingTest(_TimelineBase):

    def setUp(self):
        super().setUp()
        chris = self.data["chris"]
        self.m_today_pm = self._make_meeting(
            title="Today 15:00 meeting",
            scheduled_at=_at(TODAY, 15),
            participants=[chris],
        )
        self.m_tomorrow_am = self._make_meeting(
            title="Tomorrow 09:00 meeting",
            scheduled_at=_at(TODAY + timedelta(days=1), 9),
            participants=[chris],
        )
        self.wi_today = self._make_wi(
            title="Due today", assignees=[chris], due_date=TODAY,
        )
        self.wi_tomorrow = self._make_wi(
            title="Due tomorrow", assignees=[chris],
            due_date=TODAY + timedelta(days=1),
        )

    def test_full_mixed_chronological_order(self):
        self.assertEqual(
            self._pairs(self.data["chris"]),
            [
                (DOMAIN_WORK_ITEM, self.wi_today.pk),       # today 00:00
                (DOMAIN_MEETING, self.m_today_pm.pk),       # today 15:00
                (DOMAIN_WORK_ITEM, self.wi_tomorrow.pk),    # tomorrow 00:00
                (DOMAIN_MEETING, self.m_tomorrow_am.pk),    # tomorrow 09:00
            ],
        )

    def test_earlier_date_sorts_before_later_date(self):
        order = self._pairs(self.data["chris"])
        self.assertLess(
            order.index((DOMAIN_MEETING, self.m_today_pm.pk)),
            order.index((DOMAIN_MEETING, self.m_tomorrow_am.pk)),
        )
        self.assertLess(
            order.index((DOMAIN_WORK_ITEM, self.wi_today.pk)),
            order.index((DOMAIN_WORK_ITEM, self.wi_tomorrow.pk)),
        )

    def test_two_meetings_same_day_sort_by_exact_scheduled_at(self):
        order = self._pairs(self.data["chris"])
        self.assertLess(
            order.index((DOMAIN_MEETING, self.m_today_pm.pk)),
            order.index((DOMAIN_MEETING, self.m_tomorrow_am.pk)),
        )
        # Same-day exact-time check: a later meeting the same day must
        # not sort before the earlier one.
        later = self._make_meeting(
            title="Today 18:00 meeting",
            scheduled_at=_at(TODAY, 18),
            participants=[self.data["chris"]],
        )
        order = self._pairs(self.data["chris"])
        self.assertLess(
            order.index((DOMAIN_MEETING, self.m_today_pm.pk)),
            order.index((DOMAIN_MEETING, later.pk)),
        )

    def test_work_item_sorts_before_timed_meeting_same_day(self):
        order = self._pairs(self.data["chris"])
        self.assertLess(
            order.index((DOMAIN_WORK_ITEM, self.wi_today.pk)),
            order.index((DOMAIN_MEETING, self.m_today_pm.pk)),
        )

    def test_work_item_sorts_before_meeting_at_exact_midnight(self):
        m_midnight = self._make_meeting(
            title="Today midnight meeting",
            scheduled_at=WINDOW_START,
            participants=[self.data["chris"]],
        )
        order = self._pairs(self.data["chris"])
        self.assertLess(
            order.index((DOMAIN_WORK_ITEM, self.wi_today.pk)),
            order.index((DOMAIN_MEETING, m_midnight.pk)),
        )

    def test_same_domain_equal_time_sorts_by_id_ascending(self):
        # Two meetings at the exact same instant: creation order
        # (ID) decides.
        first = self._make_meeting(
            title="Same instant A",
            scheduled_at=_at(TODAY + timedelta(days=4), 12),
            participants=[self.data["chris"]],
        )
        second = self._make_meeting(
            title="Same instant B",
            scheduled_at=_at(TODAY + timedelta(days=4), 12),
            participants=[self.data["chris"]],
        )
        self.assertLess(first.pk, second.pk)
        # Two Work Items with the same due date: creation order
        # (ID) decides.
        wi_first = self._make_wi(
            title="Same due A", assignees=[self.data["chris"]],
            due_date=TODAY + timedelta(days=5),
        )
        wi_second = self._make_wi(
            title="Same due B", assignees=[self.data["chris"]],
            due_date=TODAY + timedelta(days=5),
        )
        self.assertLess(wi_first.pk, wi_second.pk)

        order = self._pairs(self.data["chris"])
        self.assertLess(
            order.index((DOMAIN_MEETING, first.pk)),
            order.index((DOMAIN_MEETING, second.pk)),
        )
        self.assertLess(
            order.index((DOMAIN_WORK_ITEM, wi_first.pk)),
            order.index((DOMAIN_WORK_ITEM, wi_second.pk)),
        )

    def test_mixed_output_deterministic_across_repeated_reads(self):
        first_read = self._candidates(self.data["chris"])
        second_read = self._candidates(self.data["chris"])
        self.assertEqual(
            [(c.domain, c.object_id, c.sort_at, c.calendar_date, c.title)
             for c in first_read],
            [(c.domain, c.object_id, c.sort_at, c.calendar_date, c.title)
             for c in second_read],
        )
        self.assertEqual(len(first_read), 4)


# ── Candidate data contract ──


class CandidateContractTest(_TimelineBase):

    def test_meeting_candidate_data_fields(self):
        m = self._make_meeting(
            title="Context check",
            scheduled_at=_at(TODAY + timedelta(days=2), 16, 30),
            scope=Meeting.Scope.PROJECT,
            project=self.project,
        )
        (candidate,) = self._candidates(self.data["alex"])
        self.assertEqual(candidate.domain, DOMAIN_MEETING)
        self.assertEqual(candidate.object_id, m.pk)
        self.assertEqual(candidate.title, "Context check")
        self.assertEqual(candidate.calendar_date, TODAY + timedelta(days=2))
        self.assertEqual(candidate.sort_at, _at(TODAY + timedelta(days=2), 16, 30))
        details = candidate.details
        self.assertEqual(details.meeting_id, m.pk)
        self.assertEqual(details.scheduled_at, candidate.sort_at)
        self.assertEqual(details.status, Meeting.Status.UPCOMING)
        self.assertEqual(details.scope, Meeting.Scope.PROJECT)
        self.assertEqual(details.research_group_id, self.data["group"].pk)
        self.assertEqual(details.project_id, self.project.pk)

    def test_group_scoped_meeting_candidate_has_null_project(self):
        self._make_meeting(
            title="Group meeting",
            scheduled_at=_at(TODAY + timedelta(days=1), 9),
        )
        (candidate,) = self._candidates(self.data["alex"])
        self.assertEqual(candidate.details.scope, Meeting.Scope.GROUP)
        self.assertIsNone(candidate.details.project_id)

    def test_work_item_candidate_data_fields(self):
        wi = self._make_wi(
            title="Data check", assignees=[self.data["chris"]],
            due_date=TODAY + timedelta(days=3),
            blocked_reason="Blocked reason text",
        )
        (candidate,) = self._candidates(self.data["chris"])
        self.assertEqual(candidate.domain, DOMAIN_WORK_ITEM)
        self.assertEqual(candidate.object_id, wi.pk)
        self.assertEqual(candidate.title, "Data check")
        self.assertEqual(candidate.calendar_date, TODAY + timedelta(days=3))
        self.assertEqual(
            candidate.sort_at,
            timezone.make_aware(
                datetime.combine(TODAY + timedelta(days=3), datetime.min.time()),
            ),
        )
        details = candidate.details
        self.assertEqual(details.work_item_id, wi.pk)
        self.assertEqual(details.project_id, self.project.pk)
        self.assertEqual(details.project_name, "Paper XYZ")
        self.assertEqual(details.due_date, TODAY + timedelta(days=3))
        self.assertEqual(details.status_category, "todo")
        self.assertEqual(details.blocked_reason, "Blocked reason text")

    def test_unblocked_work_item_has_null_blocked_reason(self):
        self._make_wi(
            title="Not blocked", assignees=[self.data["chris"]],
            due_date=TODAY + timedelta(days=1),
        )
        (candidate,) = self._candidates(self.data["chris"])
        self.assertIsNone(candidate.details.blocked_reason)


# ── No truncation / no buckets ──


class NoTruncationTest(_TimelineBase):

    def test_returns_all_eligible_candidates_beyond_seven_rows(self):
        chris = self.data["chris"]
        for i in range(5):
            self._make_meeting(
                title=f"Meeting day {i}",
                scheduled_at=_at(TODAY + timedelta(days=i), 10),
                participants=[chris],
            )
        for i in range(5):
            self._make_wi(
                title=f"Due day {i}", assignees=[chris],
                due_date=TODAY + timedelta(days=i),
            )
        candidates = self._candidates(chris)
        self.assertEqual(len(candidates), 10)
        # Flat chronological list, never a fixed 7-row page.
        for a, b in zip(candidates, candidates[1:]):
            self.assertLessEqual(a.sort_key(), b.sort_key())


# ── Query behavior ──


class QueryCountTest(_TimelineBase):
    """Bounded total query count consistent with the two-domain
    design (one Meeting query + one Work Item query), and NO N+1 on
    Meeting (research group / project) or Work Item (project / status
    definition) context as candidate rows grow."""

    def _add_candidates(self, count, start=0):
        for i in range(start, start + count):
            self._make_meeting(
                title=f"QC meeting {i}",
                scheduled_at=_at(TODAY + timedelta(days=i % 7), 10 + i % 12),
                participants=[self.data["chris"]],
            )
            self._make_wi(
                title=f"QC due {i}", assignees=[self.data["chris"]],
                due_date=TODAY + timedelta(days=i % 7),
            )

    def test_two_domain_queries_total(self):
        self._add_candidates(1)
        with CaptureQueriesContext(connection) as ctx:
            self.assertEqual(len(self._candidates(self.data["chris"])), 2)
        self.assertEqual(
            len(ctx.captured_queries), 2,
            "The read model must issue exactly two bounded domain "
            "queries (Meetings + Work Items) with eager relations.",
        )

    def test_query_count_does_not_scale_with_candidate_rows(self):
        self._add_candidates(1)
        with CaptureQueriesContext(connection) as small_ctx:
            small = self._candidates(self.data["chris"])
        self.assertEqual(len(small), 2)

        self._add_candidates(13, start=1)
        with CaptureQueriesContext(connection) as large_ctx:
            large = self._candidates(self.data["chris"])
        self.assertEqual(len(large), 28)

        # 14x the candidate rows add ZERO queries — a per-row
        # relation lookup (Meeting research group/project N+1 or
        # Work Item project/status definition N+1) would add queries
        # per row.
        self.assertEqual(
            len(small_ctx.captured_queries),
            len(large_ctx.captured_queries),
            "Timeline query count must not scale with candidate row "
            "count; every relation must be eager-loaded on the two "
            "candidate querysets.",
        )
