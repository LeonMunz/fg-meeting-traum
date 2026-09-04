"""Tests for the canonical Live MeetingItem state machine."""

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db import connection, transaction
from django.db.utils import IntegrityError
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

    def create_item(self, meeting, section, title):
        return create_meeting_item(
            meeting=meeting,
            meeting_section=section,
            actor=self.alex,
            title=title,
        )

    def start(self, meeting):
        return start_meeting(meeting=meeting, actor=self.alex)

    def current(self, meeting):
        return (
            MeetingItem.objects
            .filter(
                meeting=meeting,
                status=MeetingItem.Status.DISCUSSING,
            )
            .first()
        )

    def meeting_status(self, meeting):
        meeting.refresh_from_db()
        return meeting.status

    def item_status(self, item):
        item.refresh_from_db()
        return item.status


class LiveStateMachineDomainTest(LiveStateMachineBase):
    # ── Start ────────────────────────────────────────────────────

    def test_start_selects_first_item_in_canonical_order(self):
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
        current = self.current(meeting)
        self.assertIsNotNone(current)
        self.assertEqual(current, a1)
        self.assertNotEqual(current, b1)
        self.assertNotEqual(current, a2)

    def test_start_without_items_goes_live_without_current(self):
        meeting = self.create_meeting()
        self.start(meeting)
        self.assertEqual(
            self.meeting_status(meeting),
            Meeting.Status.LIVE,
        )
        self.assertIsNone(self.current(meeting))

    # ── Focus ────────────────────────────────────────────────────

    def test_focus_transition(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")

        self.start(meeting)
        self.assertEqual(self.current(meeting), a)

        focus_meeting_item(meeting_item=b, actor=self.alex)
        self.assertEqual(
            self.item_status(b), MeetingItem.Status.DISCUSSING
        )
        self.assertEqual(
            self.item_status(a), MeetingItem.Status.NOT_DISCUSSED
        )
        self.assertEqual(self.current(meeting), b)

    def test_focus_rejected_when_item_not_not_discussed(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")

        self.start(meeting)
        focus_meeting_item(meeting_item=b, actor=self.alex)

        with self.assertRaises(MeetingDomainError):
            focus_meeting_item(meeting_item=b, actor=self.alex)

        self.assertEqual(
            self.item_status(b), MeetingItem.Status.DISCUSSING
        )

    def test_focus_rejected_outside_live(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")

        with self.assertRaises(MeetingDomainError):
            focus_meeting_item(meeting_item=a, actor=self.alex)

    def test_at_most_one_discussing_per_meeting(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")

        self.start(meeting)
        focus_meeting_item(meeting_item=b, actor=self.alex)

        count = MeetingItem.objects.filter(
            meeting=meeting,
            status=MeetingItem.Status.DISCUSSING,
        ).count()
        self.assertEqual(count, 1)

    # ── Done ─────────────────────────────────────────────────────

    def test_done_advances_to_deterministic_next_item(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")
        c = self.create_item(meeting, section, "C")

        self.start(meeting)
        self.assertEqual(self.current(meeting), a)

        mark_meeting_item_done(meeting_item=a, actor=self.alex)
        self.assertEqual(
            self.item_status(a), MeetingItem.Status.DONE
        )
        self.assertEqual(self.current(meeting), b)

        mark_meeting_item_done(meeting_item=b, actor=self.alex)
        self.assertEqual(self.current(meeting), c)

        mark_meeting_item_done(meeting_item=c, actor=self.alex)
        self.assertIsNone(self.current(meeting))

    def test_done_non_current_rejected(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")

        self.start(meeting)
        self.assertEqual(self.current(meeting), a)

        with self.assertRaises(MeetingDomainError):
            mark_meeting_item_done(meeting_item=b, actor=self.alex)

        self.assertEqual(
            self.item_status(b), MeetingItem.Status.NOT_DISCUSSED
        )

    # ── Follow-up ────────────────────────────────────────────────

    def test_follow_up_advances_to_deterministic_next_item(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")

        self.start(meeting)
        self.assertEqual(self.current(meeting), a)

        mark_meeting_item_follow_up(meeting_item=a, actor=self.alex)
        self.assertEqual(
            self.item_status(a), MeetingItem.Status.FOLLOW_UP
        )
        self.assertEqual(self.current(meeting), b)

    def test_follow_up_non_current_rejected(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")

        self.start(meeting)

        with self.assertRaises(MeetingDomainError):
            mark_meeting_item_follow_up(
                meeting_item=b, actor=self.alex
            )
        self.assertEqual(
            self.item_status(b), MeetingItem.Status.NOT_DISCUSSED
        )

    # ── End ──────────────────────────────────────────────────────

    def test_end_rejected_while_discussing(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")

        self.start(meeting)
        self.assertEqual(self.current(meeting), a)

        with self.assertRaises(MeetingDomainError):
            end_meeting(meeting=meeting, actor=self.alex)

        self.assertEqual(
            self.meeting_status(meeting), Meeting.Status.LIVE
        )

    def test_end_succeeds_with_undiscussed_but_no_discussing(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")

        self.start(meeting)
        mark_meeting_item_done(meeting_item=a, actor=self.alex)
        mark_meeting_item_done(meeting_item=b, actor=self.alex)
        self.assertIsNone(self.current(meeting))

        end_meeting(meeting=meeting, actor=self.alex)
        self.assertEqual(
            self.meeting_status(meeting), Meeting.Status.COMPLETED
        )

    # ── Reopen ───────────────────────────────────────────────────

    def test_reopen_preserves_started_at_and_clears_ended_at(self):
        meeting = self.create_meeting()
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

    def test_reopen_selects_first_not_discussed_when_none_current(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")

        self.start(meeting)
        mark_meeting_item_done(meeting_item=a, actor=self.alex)
        self.assertEqual(self.current(meeting), b)
        mark_meeting_item_follow_up(meeting_item=b, actor=self.alex)
        self.assertIsNone(self.current(meeting))
        end_meeting(meeting=meeting, actor=self.alex)

        reopen_meeting(meeting=meeting, actor=self.alex)
        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.LIVE)
        self.assertIsNone(self.current(meeting))
        self.assertEqual(
            self.item_status(a), MeetingItem.Status.DONE
        )
        self.assertEqual(
            self.item_status(b), MeetingItem.Status.FOLLOW_UP
        )


    # ── Deterministic successor advancement (Done / Follow-up) ──

    def test_done_advances_to_successor_after_skipped_item(self):
        """Case A: with Alpha open and Beta current, Done Beta must
        select Gamma (the next open item AFTER Beta), not the global
        first open item (Alpha)."""
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        alpha = self.create_item(meeting, section, "Alpha")
        beta = self.create_item(meeting, section, "Beta")
        gamma = self.create_item(meeting, section, "Gamma")

        self.start(meeting)
        self.assertEqual(self.current(meeting), alpha)

        focus_meeting_item(meeting_item=beta, actor=self.alex)
        self.assertEqual(
            self.item_status(alpha),
            MeetingItem.Status.NOT_DISCUSSED,
        )
        self.assertEqual(self.current(meeting), beta)

        mark_meeting_item_done(meeting_item=beta, actor=self.alex)
        self.assertEqual(
            self.item_status(beta), MeetingItem.Status.DONE
        )
        # Successor after Beta is Gamma — not Alpha.
        self.assertEqual(self.current(meeting), gamma)
        self.assertEqual(
            self.item_status(alpha),
            MeetingItem.Status.NOT_DISCUSSED,
        )

    def test_follow_up_wraps_to_beginning_when_no_successor(self):
        """Case B: with Alpha open and Gamma current (Beta done),
        Follow-up Gamma must wrap to Alpha, the first remaining
        not_discussed item at the beginning."""
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        alpha = self.create_item(meeting, section, "Alpha")
        beta = self.create_item(meeting, section, "Beta")
        gamma = self.create_item(meeting, section, "Gamma")

        self.start(meeting)
        focus_meeting_item(meeting_item=beta, actor=self.alex)
        mark_meeting_item_done(meeting_item=beta, actor=self.alex)
        self.assertEqual(self.current(meeting), gamma)

        mark_meeting_item_follow_up(meeting_item=gamma, actor=self.alex)
        self.assertEqual(
            self.item_status(gamma), MeetingItem.Status.FOLLOW_UP
        )
        # Wrap: the only remaining not_discussed item is Alpha.
        self.assertEqual(self.current(meeting), alpha)

    def test_done_resolving_last_open_item_clears_current(self):
        """Case C: when no not_discussed items remain after
        resolution, the Meeting has no current item."""
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
        self.assertEqual(self.current(meeting), alpha)

        mark_meeting_item_done(meeting_item=alpha, actor=self.alex)
        self.assertIsNone(self.current(meeting))
        self.assertEqual(
            MeetingItem.objects.filter(
                meeting=meeting,
                status=MeetingItem.Status.DISCUSSING,
            ).count(),
            0,
        )

    def test_successor_crosses_section_boundary(self):
        """Case D: the item at the end of Section A advances to the
        first open item in Section B in canonical order."""
        meeting = self.create_meeting()
        section_a = MeetingSection.objects.get(meeting=meeting)
        section_b = self.create_section(meeting, "Decisions")

        a1 = self.create_item(meeting, section_a, "A1")
        a2 = self.create_item(meeting, section_a, "A2")
        b1 = self.create_item(meeting, section_b, "B1")

        self.start(meeting)
        self.assertEqual(self.current(meeting), a1)

        focus_meeting_item(meeting_item=a2, actor=self.alex)
        mark_meeting_item_done(meeting_item=a2, actor=self.alex)
        # A2 is last in Section A; the successor is B1 in Section B.
        self.assertEqual(self.current(meeting), b1)
        self.assertEqual(
            self.item_status(a1),
            MeetingItem.Status.NOT_DISCUSSED,
        )

    def test_successor_wraps_across_sections_to_first_open(self):
        """Case D (wrap): resolving the last item of the whole
        agenda wraps to the first remaining open item, which may be
        in an earlier section."""
        meeting = self.create_meeting()
        section_a = MeetingSection.objects.get(meeting=meeting)
        section_b = self.create_section(meeting, "Decisions")

        a1 = self.create_item(meeting, section_a, "A1")
        a2 = self.create_item(meeting, section_a, "A2")
        b1 = self.create_item(meeting, section_b, "B1")

        self.start(meeting)
        focus_meeting_item(meeting_item=a2, actor=self.alex)
        mark_meeting_item_done(meeting_item=a2, actor=self.alex)
        self.assertEqual(self.current(meeting), b1)

        mark_meeting_item_done(meeting_item=b1, actor=self.alex)
        # B1 was last in canonical order; wrap to A1 (A2 done).
        self.assertEqual(self.current(meeting), a1)

    def test_successor_never_selects_resolved_items(self):
        """Case E: done / follow_up items are never selected as the
        successor, even when they sit between open items."""
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")
        c = self.create_item(meeting, section, "C")

        self.start(meeting)

        # A done, C follow_up, B the only open item.
        a.status = MeetingItem.Status.DONE
        a.save(update_fields=["status", "updated_at"])
        c.status = MeetingItem.Status.FOLLOW_UP
        c.save(update_fields=["status", "updated_at"])

        focus_meeting_item(meeting_item=b, actor=self.alex)
        self.assertEqual(self.current(meeting), b)

        # Resolving B leaves no open items: the done (A) and
        # follow_up (C) items must never be selected.
        mark_meeting_item_done(meeting_item=b, actor=self.alex)
        self.assertIsNone(self.current(meeting))
        self.assertEqual(
            self.item_status(a), MeetingItem.Status.DONE
        )
        self.assertEqual(
            self.item_status(c), MeetingItem.Status.FOLLOW_UP
        )


class LiveStateMachineIsolationTest(LiveStateMachineBase):
    """Project Meeting write isolation: a viewer cannot drive the
    Live MeetingItem state machine; a group Meeting remains open
    to group members."""

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
        self.assertEqual(self.current(meeting), b)

        with self.assertRaises(MeetingDomainError):
            focus_meeting_item(meeting_item=a, actor=self.laura)

    def test_group_meeting_member_can_drive_state_machine(self):
        meeting = self.create_meeting()
        section = MeetingSection.objects.get(meeting=meeting)
        a = self.create_item(meeting, section, "A")
        b = self.create_item(meeting, section, "B")

        start_meeting(meeting=meeting, actor=self.alex)
        focus_meeting_item(meeting_item=b, actor=self.chris)
        self.assertEqual(self.current(meeting), b)
        mark_meeting_item_done(meeting_item=b, actor=self.chris)
        self.assertEqual(
            self.item_status(b), MeetingItem.Status.DONE
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
            self.item_status(items[1]),
            MeetingItem.Status.DISCUSSING,
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
            self.item_status(items[0]), MeetingItem.Status.DONE
        )
        self.assertEqual(
            self.item_status(items[1]),
            MeetingItem.Status.DISCUSSING,
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
            self.item_status(items[0]),
            MeetingItem.Status.FOLLOW_UP,
        )
        self.assertEqual(
            self.item_status(items[1]),
            MeetingItem.Status.DISCUSSING,
        )

    def test_end_rejected_while_discussing_via_api(self):
        meeting, items = self._group_meeting_with_items()
        start_meeting(meeting=meeting, actor=self.alex)
        self.client.force_login(self.chris)

        resp = self.client.post(
            f"/api/meetings/{meeting.pk}/end",
            {}, format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(
            self.meeting_status(meeting), Meeting.Status.LIVE
        )

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
    """The database conditional uniqueness constraint is the last
    line of defense against concurrent double focus."""

    def setUp(self):
        self.alex = User.objects.create_user(
            username="conc-alex", password="Pass1!",
        )
        self.group = ResearchGroup.objects.create(
            name="Conc Group", created_by=self.alex,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        self.scheduled_at = timezone.now() + timedelta(days=1)

    def test_database_constraint_enforces_single_discussing(self):
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

        a.status = MeetingItem.Status.DISCUSSING
        a.save(update_fields=["status", "updated_at"])

        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                b.status = MeetingItem.Status.DISCUSSING
                b.save(update_fields=["status", "updated_at"])


class MigrationMappingTest(TestCase):
    """Exercise the real 0010 data-mapping function.

    Builds the historical project state right after 0009 (via the
    real migration graph), seeds legacy rows through that
    historical state's models, and then invokes the actual
    ``map_legacy_statuses`` RunPython function with that state's
    apps registry. No mapping logic is duplicated here.
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from django.db.migrations.executor import MigrationExecutor

        executor = MigrationExecutor(connection)
        cls.project_state = executor.loader.project_state(
            ("meetings", "0009_alter_meetingitem_status_and_more")
        )

    def setUp(self):
        self.apps = self.project_state.apps

    def _seed_legacy_rows(self):
        """Insert legacy rows using the historical (0009) state
        models so the migration runs against exactly the pre-0010
        schema. All fields are passed explicitly: historical state
        models do not evaluate ``related`` defaults."""
        from django.utils import timezone as _tz

        user_model = self.apps.get_model("accounts", "User")
        group_model = self.apps.get_model("research_groups", "ResearchGroup")
        meeting_model = self.apps.get_model("meetings", "Meeting")
        section_model = self.apps.get_model(
            "meetings", "MeetingSection"
        )
        item_model = self.apps.get_model("meetings", "MeetingItem")

        creator = user_model.objects.create_user(
            username="legacy-mapping-creator",
            password="Pass1!",
        )
        group = group_model.objects.create(
            name="Legacy Mapping Group",
            created_by=creator,
        )
        legacy_meeting = meeting_model.objects.create(
            research_group=group,
            scope="group",
            title="Legacy Weekly",
            scheduled_at=_tz.now(),
            status="upcoming",
            created_by=creator,
        )
        legacy_section = section_model.objects.create(
            meeting=legacy_meeting,
            name="Agenda",
            position=0,
        )

        open_item = item_model.objects.create(
            meeting=legacy_meeting,
            meeting_section=legacy_section,
            title="Legacy open",
            position=0,
            status="open",
            created_by=creator,
        )
        discussed_item = item_model.objects.create(
            meeting=legacy_meeting,
            meeting_section=legacy_section,
            title="Legacy discussed",
            position=1,
            status="discussed",
            created_by=creator,
        )
        return open_item, discussed_item

    def _run_migration(self):
        from importlib import import_module

        migration = import_module(
            "meetings.migrations"
            ".0010_meetingitem_status_data_mapping"
        )
        migration.map_legacy_statuses(self.apps, None)

    def _final_status(self, pk):
        return (
            MeetingItem.objects.get(pk=pk).status
        )

    def test_open_maps_to_not_discussed(self):
        open_item, _ = self._seed_legacy_rows()
        self._run_migration()
        self.assertEqual(
            self._final_status(open_item.pk),
            "not_discussed",
        )

    def test_discussed_maps_to_done(self):
        _, discussed_item = self._seed_legacy_rows()
        self._run_migration()
        self.assertEqual(
            self._final_status(discussed_item.pk),
            "done",
        )

    def test_mapping_covers_exactly_the_documented_pair(self):
        open_item, discussed_item = self._seed_legacy_rows()
        self._run_migration()
        self.assertEqual(
            self._final_status(open_item.pk),
            MeetingItem.Status.NOT_DISCUSSED,
        )
        self.assertEqual(
            self._final_status(discussed_item.pk),
            MeetingItem.Status.DONE,
        )
