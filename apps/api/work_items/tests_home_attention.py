"""Home "Needs attention" — Work Item candidate read model tests.

Proves the canonical semantics of
``work_items.home_attention.get_work_item_attention_candidates``:

- only the user's own currently assigned Work Items
- current read authorization (Project + Research Group membership)
- canonical completion exclusion (status category ``done``)
- canonical overdue semantics (date-only ``due_date`` strictly
  before the current application-timezone date; due-today is NOT
  overdue)
- canonical blocked semantics (non-empty ``blockedReason``)
- one candidate per Work Item with stable reason codes
- deterministic ordering (overdue group first, earliest due first
  NULLS LAST, Work Item ID tie-break)
- canonical Work Item type identity/name exposed as display metadata
  (the Project-configured ``WorkItemTypeDefinition``; no semantic
  discriminator exists on the type and none is inferred)
- bounded query count (no N+1 per candidate row)

Time is frozen for every test: ``_current_application_date`` is
patched to a fixed date, so no test depends on the wall clock.
"""

from datetime import date, timedelta
from unittest import mock

from django.contrib.auth import get_user_model
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from research_groups.models import ResearchGroup, ResearchGroupMembership
from projects.models import ProjectMembership
from projects.services import create_project, add_project_membership

from work_items.home_attention import (
    ATTENTION_REASON_BLOCKED,
    ATTENTION_REASON_OVERDUE,
    get_work_item_attention_candidates,
)
from work_items.models import WorkItemAssignee
from work_items.services import create_work_item

# Frozen application date for every test in this module.
TODAY = date(2026, 9, 15)

User = get_user_model()

SEED_PASSWORD = "DevPass1!"


def _create_standard_data():
    """Create the standard Foundation 4 test scenario.

    Paper XYZ:
      Alex: owner
      Chris: member
      Laura: viewer
      Maria: no ProjectMembership (but Research Group member)
    """
    alex = User.objects.create_user(username="alex", password=SEED_PASSWORD)
    chris = User.objects.create_user(username="chris", password=SEED_PASSWORD)
    maria = User.objects.create_user(username="maria", password=SEED_PASSWORD)
    laura = User.objects.create_user(username="laura", password=SEED_PASSWORD)

    group = ResearchGroup.objects.create(name="FG Example", created_by=alex)
    ResearchGroupMembership.objects.create(
        research_group=group, user=alex,
        role=ResearchGroupMembership.Role.ADMIN,
    )
    ResearchGroupMembership.objects.create(
        research_group=group, user=chris,
        role=ResearchGroupMembership.Role.MEMBER,
    )
    ResearchGroupMembership.objects.create(
        research_group=group, user=maria,
        role=ResearchGroupMembership.Role.MEMBER,
    )
    ResearchGroupMembership.objects.create(
        research_group=group, user=laura,
        role=ResearchGroupMembership.Role.MEMBER,
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
    # Maria has NO membership in Paper XYZ

    return {
        "group": group,
        "alex": alex,
        "chris": chris,
        "maria": maria,
        "laura": laura,
        "paper_xyz": paper_xyz,
    }


def _iso(d: date) -> str:
    return d.isoformat()


class _HomeAttentionBase(TestCase):
    """Base with the frozen application date."""

    def setUp(self):
        super().setUp()
        self.data = _create_standard_data()
        self.project = self.data["paper_xyz"]
        self.task_type = self.project.type_definitions.get(name="Task")
        self.done_status = self.project.status_definitions.get(name="Done")
        self._clock_patch = mock.patch(
            "work_items.home_attention._current_application_date",
            return_value=TODAY,
        )
        self._clock_patch.start()
        self.addCleanup(self._clock_patch.stop)

    def _make(self, *, title, assignees=(), due_date=None,
              blocked_reason=None, status_id=None, type_id=None):
        return create_work_item(
            project=self.project,
            actor=self.data["alex"],
            type_definition_id=type_id or self.task_type.pk,
            title=title,
            status_definition_id=status_id,
            assignee_ids=[u.pk for u in assignees],
            due_date=_iso(due_date) if due_date is not None else None,
            blocked_reason=blocked_reason,
        )

    def _candidates(self, user):
        return get_work_item_attention_candidates(user=user)

    def _candidate_ids(self, user):
        return [c.work_item_id for c in self._candidates(user)]


# ── Assignment ──


class HomeAttentionAssignmentTest(_HomeAttentionBase):

    def test_assigned_overdue_work_item_appears(self):
        wi = self._make(
            title="Overdue for Chris",
            assignees=[self.data["chris"]],
            due_date=TODAY - timedelta(days=1),
        )
        self.assertEqual(self._candidate_ids(self.data["chris"]), [wi.pk])

    def test_assigned_blocked_work_item_appears(self):
        wi = self._make(
            title="Blocked for Chris",
            assignees=[self.data["chris"]],
            blocked_reason="Waiting on data access",
        )
        self.assertEqual(self._candidate_ids(self.data["chris"]), [wi.pk])

    def test_unassigned_overdue_blocked_work_item_does_not_appear(self):
        self._make(
            title="Unassigned overdue+blocked",
            due_date=TODAY - timedelta(days=5),
            blocked_reason="Stuck",
        )
        for user in (self.data["alex"], self.data["chris"],
                     self.data["maria"]):
            self.assertEqual(self._candidate_ids(user), [],
                             f"{user.username} must not see it")

    def test_work_item_assigned_only_to_another_user_does_not_appear(self):
        wi = self._make(
            title="Alex's overdue task",
            assignees=[self.data["alex"]],
            due_date=TODAY - timedelta(days=2),
        )
        self.assertNotIn(wi.pk, self._candidate_ids(self.data["chris"]))
        # ...but the assigned user does see it
        self.assertEqual(self._candidate_ids(self.data["alex"]), [wi.pk])


# ── Authorization ──


class HomeAttentionAuthorizationTest(_HomeAttentionBase):

    def test_assigned_work_item_in_readable_project_appears(self):
        wi = self._make(
            title="Visible to Chris",
            assignees=[self.data["chris"]],
            due_date=TODAY - timedelta(days=1),
        )
        self.assertEqual(self._candidate_ids(self.data["chris"]), [wi.pk])

    def test_project_membership_removal_removes_candidate(self):
        wi = self._make(
            title="Then revoked",
            assignees=[self.data["chris"]],
            due_date=TODAY - timedelta(days=1),
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
        self.assertEqual(self._candidate_ids(self.data["chris"]), [])

    def test_research_group_membership_removal_removes_candidate(self):
        wi = self._make(
            title="Group membership revoked",
            assignees=[self.data["chris"]],
            blocked_reason="Blocked",
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
        self.assertEqual(self._candidate_ids(self.data["chris"]), [])

    def test_research_group_member_without_project_membership_sees_nothing(
        self,
    ):
        wi = self._make(
            title="Not Maria's project",
            assignees=[self.data["chris"]],
            due_date=TODAY - timedelta(days=1),
        )
        self.assertEqual(self._candidate_ids(self.data["maria"]), [])
        self.assertNotIn(wi.pk, self._candidate_ids(self.data["maria"]))

    def test_project_owner_without_assignment_sees_nothing(self):
        """Ownership of the Project never creates attention items."""
        self._make(
            title="Chris's overdue task",
            assignees=[self.data["chris"]],
            due_date=TODAY - timedelta(days=1),
        )
        self.assertEqual(self._candidate_ids(self.data["alex"]), [])

    def test_invalid_viewer_assignment_row_is_excluded(self):
        """A viewer holding an assignment row is excluded.

        This pins the CANONICAL assignment invariant, not a
        Home-specific role rule:

        - A viewer cannot be assigned (foundation.md §9; assignment
          eligibility is the ``PROJECT_WORK`` capability, held only
          by ``owner``/``member`` — pinned by
          ``work_items.tests_api`` ``test_viewer_assignee_rejected``
          and ``work_items.tests_invariants``
          ``StaleAssigneeMembershipTest``).
        - Canonical mutation paths never leave such a row behind:
          demoting an assigned user to viewer or removing their
          membership is blocked (``_check_assignments_block_mutation``)
          or the assignments are atomically resolved in the same
          operation (``change_membership_role`` with an
          ``assignment_resolution``).

        The violating row below is therefore only creatable by
        direct ORM manipulation; the read model must not trust it.
        The query's owner/member role filter is the same
        assignee-eligibility invariant applied at read time
        (defense in depth, identical to personal My Work).
        """
        wi = self._make(
            title="Demoted to viewer",
            assignees=[self.data["chris"]],
            due_date=TODAY - timedelta(days=1),
        )
        membership = ProjectMembership.objects.get(
            project=self.project, user=self.data["chris"],
        )
        membership.role = ProjectMembership.Role.VIEWER
        membership.save(update_fields=["role"])

        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=wi, user=self.data["chris"],
            ).exists()
        )
        self.assertEqual(self._candidate_ids(self.data["chris"]), [])

    def test_canonical_demotion_of_assigned_user_is_blocked(self):
        """Evidence for the invariant this slice relies on: the
        canonical role-change path refuses to demote an assigned
        member to viewer without resolving the assignment, so a
        viewer can never hold a valid assignment row.
        """
        from projects.services import change_membership_role

        wi = self._make(
            title="Assigned then demoted",
            assignees=[self.data["chris"]],
            due_date=TODAY - timedelta(days=1),
        )
        membership = ProjectMembership.objects.get(
            project=self.project, user=self.data["chris"],
        )
        with self.assertRaises(Exception) as ctx:
            change_membership_role(
                membership=membership,
                actor=self.data["alex"],
                new_role=ProjectMembership.Role.VIEWER,
            )
        self.assertIn("unassigned", str(ctx.exception))
        # The assignment row survived the blocked mutation ...
        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=wi, user=self.data["chris"],
            ).exists()
        )
        # ... and the item remains a valid candidate for Chris.
        self.assertEqual(self._candidate_ids(self.data["chris"]), [wi.pk])


# ── Completion ──


class HomeAttentionCompletionTest(_HomeAttentionBase):

    def test_completed_overdue_work_item_does_not_appear(self):
        wi = self._make(
            title="Done but past due",
            assignees=[self.data["chris"]],
            due_date=TODAY - timedelta(days=10),
            status_id=self.done_status.pk,
        )
        self.assertEqual(wi.status_definition.category, "done")
        self.assertEqual(self._candidate_ids(self.data["chris"]), [])

    def test_completed_work_item_with_blocked_metadata_does_not_appear(self):
        wi = self._make(
            title="Done with stale blocked reason",
            assignees=[self.data["chris"]],
            blocked_reason="Stale metadata",
            due_date=TODAY - timedelta(days=1),
            status_id=self.done_status.pk,
        )
        self.assertEqual(self._candidate_ids(self.data["chris"]), [])


# ── Overdue semantics ──


class HomeAttentionOverdueTest(_HomeAttentionBase):

    def test_past_due_open_work_item_receives_overdue(self):
        wi = self._make(
            title="Past due",
            assignees=[self.data["chris"]],
            due_date=TODAY - timedelta(days=1),
        )
        candidates = self._candidates(self.data["chris"])
        self.assertEqual(len(candidates), 1)
        self.assertEqual(
            candidates[0].attention_reasons, (ATTENTION_REASON_OVERDUE,)
        )

    def test_future_due_work_item_does_not_receive_overdue(self):
        self._make(
            title="Due next week",
            assignees=[self.data["chris"]],
            due_date=TODAY + timedelta(days=7),
        )
        self.assertEqual(self._candidate_ids(self.data["chris"]), [])

    def test_due_exactly_today_is_not_overdue(self):
        """Boundary: a date-only due value of the current date is NOT
        overdue (strictly-before semantics)."""
        self._make(
            title="Due today",
            assignees=[self.data["chris"]],
            due_date=TODAY,
        )
        self.assertEqual(self._candidate_ids(self.data["chris"]), [])

    def test_due_yesterday_is_overdue(self):
        """Boundary: the day before the current date IS overdue."""
        self._make(
            title="Due yesterday",
            assignees=[self.data["chris"]],
            due_date=TODAY - timedelta(days=1),
        )
        candidates = self._candidates(self.data["chris"])
        self.assertEqual(len(candidates), 1)
        self.assertEqual(
            candidates[0].attention_reasons, (ATTENTION_REASON_OVERDUE,)
        )

    def test_work_item_without_due_value_is_not_overdue(self):
        self._make(
            title="No due date",
            assignees=[self.data["chris"]],
        )
        self.assertEqual(self._candidate_ids(self.data["chris"]), [])


# ── Blocked semantics ──


class HomeAttentionBlockedTest(_HomeAttentionBase):

    def test_canonically_blocked_open_work_item_receives_blocked(self):
        wi = self._make(
            title="Blocked",
            assignees=[self.data["chris"]],
            blocked_reason="Waiting on infra",
        )
        candidates = self._candidates(self.data["chris"])
        self.assertEqual(
            [c.work_item_id for c in candidates], [wi.pk]
        )
        self.assertEqual(
            candidates[0].attention_reasons, (ATTENTION_REASON_BLOCKED,)
        )
        self.assertEqual(
            candidates[0].blocked_reason, "Waiting on infra"
        )

    def test_unblocked_work_item_does_not_receive_blocked(self):
        self._make(
            title="Not blocked",
            assignees=[self.data["chris"]],
            blocked_reason="",
        )
        self.assertEqual(self._candidate_ids(self.data["chris"]), [])


# ── Combined reason + candidate data ──


class HomeAttentionCombinedTest(_HomeAttentionBase):

    def test_overdue_and_blocked_work_item_appears_exactly_once(self):
        self._make(
            title="Both overdue and blocked",
            assignees=[self.data["chris"]],
            due_date=TODAY - timedelta(days=3),
            blocked_reason="Waiting on review",
        )
        self._make(
            title="Unrelated overdue",
            assignees=[self.data["chris"]],
            due_date=TODAY - timedelta(days=1),
        )
        ids = self._candidate_ids(self.data["chris"])
        self.assertEqual(len(ids), 2)
        # The combined item must appear exactly once, not twice.
        self.assertEqual(len(set(ids)), len(ids))

    def test_combined_work_item_carries_both_stable_reason_codes(self):
        self._make(
            title="Both",
            assignees=[self.data["chris"]],
            due_date=TODAY - timedelta(days=3),
            blocked_reason="Waiting on review",
        )
        (candidate,) = self._candidates(self.data["chris"])
        self.assertEqual(
            candidate.attention_reasons,
            (ATTENTION_REASON_OVERDUE, ATTENTION_REASON_BLOCKED),
        )

    def test_candidate_data_carries_composition_fields(self):
        self._make(
            title="Field check",
            assignees=[self.data["chris"]],
            due_date=TODAY - timedelta(days=2),
            blocked_reason="Blocked reason text",
        )
        (candidate,) = self._candidates(self.data["chris"])
        self.assertEqual(candidate.title, "Field check")
        self.assertEqual(candidate.project_id, self.project.pk)
        self.assertEqual(candidate.project_name, "Paper XYZ")
        self.assertEqual(candidate.due_date, TODAY - timedelta(days=2))
        self.assertEqual(candidate.status_category, "todo")
        self.assertEqual(candidate.blocked_reason, "Blocked reason text")
        self.assertIsInstance(candidate.work_item_id, int)


# ── Ordering ──


class HomeAttentionOrderingTest(_HomeAttentionBase):

    def setUp(self):
        super().setUp()
        chris = self.data["chris"]
        # Overdue group (sorted by earliest due first):
        self.f_both = self._make(
            title="F both overdue+blocked",
            assignees=[chris],
            due_date=TODAY - timedelta(days=5),
            blocked_reason="blocked",
        )
        self.a_overdue = self._make(
            title="A overdue",
            assignees=[chris],
            due_date=TODAY - timedelta(days=3),
        )
        self.i_overdue_same_due = self._make(
            title="I overdue same due as A",
            assignees=[chris],
            due_date=TODAY - timedelta(days=3),
        )
        self.b_overdue = self._make(
            title="B overdue",
            assignees=[chris],
            due_date=TODAY - timedelta(days=1),
        )
        # Blocked-only group:
        self.d_blocked_due_today = self._make(
            title="D blocked due today",
            assignees=[chris],
            due_date=TODAY,
            blocked_reason="blocked",
        )
        self.c_blocked_due_future = self._make(
            title="C blocked due future",
            assignees=[chris],
            due_date=TODAY + timedelta(days=2),
            blocked_reason="blocked",
        )
        self.e_blocked_no_due = self._make(
            title="E blocked no due",
            assignees=[chris],
            blocked_reason="blocked",
        )
        self.g_blocked_no_due_first = self._make(
            title="G blocked no due (earlier id)",
            assignees=[chris],
            blocked_reason="blocked",
        )
        self.h_blocked_no_due_second = self._make(
            title="H blocked no due (later id)",
            assignees=[chris],
            blocked_reason="blocked",
        )

    def test_overdue_items_sort_before_blocked_only_items(self):
        ids = self._candidate_ids(self.data["chris"])
        overdue_ids = {self.f_both.pk, self.a_overdue.pk,
                       self.i_overdue_same_due.pk, self.b_overdue.pk}
        blocked_only_ids = {self.d_blocked_due_today.pk,
                            self.c_blocked_due_future.pk,
                            self.e_blocked_no_due.pk,
                            self.g_blocked_no_due_first.pk,
                            self.h_blocked_no_due_second.pk}
        self.assertEqual(len(ids), 9)
        last_overdue_index = max(
            ids.index(pk) for pk in overdue_ids
        )
        first_blocked_index = min(
            ids.index(pk) for pk in blocked_only_ids
        )
        self.assertLess(last_overdue_index, first_blocked_index)

    def test_earlier_overdue_items_sort_before_later_overdue_items(self):
        ids = self._candidate_ids(self.data["chris"])
        self.assertLess(ids.index(self.f_both.pk), ids.index(self.b_overdue.pk))
        self.assertLess(ids.index(self.a_overdue.pk), ids.index(self.b_overdue.pk))
        self.assertLess(ids.index(self.f_both.pk), ids.index(self.a_overdue.pk))

    def test_blocked_only_items_sort_by_earliest_due(self):
        ids = self._candidate_ids(self.data["chris"])
        self.assertLess(
            ids.index(self.d_blocked_due_today.pk),
            ids.index(self.c_blocked_due_future.pk),
        )

    def test_blocked_only_without_due_sort_after_dated_blocked_only(self):
        ids = self._candidate_ids(self.data["chris"])
        for no_due in (self.e_blocked_no_due,
                       self.g_blocked_no_due_first,
                       self.h_blocked_no_due_second):
            self.assertGreater(
                ids.index(no_due.pk),
                ids.index(self.c_blocked_due_future.pk),
            )

    def test_full_deterministic_order_with_id_tie_break(self):
        """Complete expected order:

        1. overdue group, earliest due first, ID tie-break for equal
           due dates (A before I — A was created first):
           F (due -5), A (due -3), I (due -3), B (due -1)
        2. blocked-only group, dated first (earliest due first):
           D (due today), C (due +2)
        3. blocked-only without due, ID tie-break:
           E, G, H (creation/ID order)
        """
        ids = self._candidate_ids(self.data["chris"])
        self.assertEqual(ids, [
            self.f_both.pk,
            self.a_overdue.pk,
            self.i_overdue_same_due.pk,
            self.b_overdue.pk,
            self.d_blocked_due_today.pk,
            self.c_blocked_due_future.pk,
            self.e_blocked_no_due.pk,
            self.g_blocked_no_due_first.pk,
            self.h_blocked_no_due_second.pk,
        ])


# ── Work Item type metadata ──


class HomeAttentionTypeMetadataTest(_HomeAttentionBase):
    """Candidates expose the canonical Work Item type identity
    (``type_definition_id`` / ``type_name`` — the Project-configured
    ``WorkItemTypeDefinition``) as display metadata."""

    def test_candidate_exposes_canonical_type_identity(self):
        epic = self.project.type_definitions.get(name="Epic")
        wi = self._make(
            title="Blocked epic",
            assignees=[self.data["chris"]],
            blocked_reason="Stuck",
            type_id=epic.pk,
        )
        (candidate,) = self._candidates(self.data["chris"])
        self.assertEqual(candidate.work_item_id, wi.pk)
        self.assertEqual(candidate.type_definition_id, epic.pk)
        self.assertEqual(candidate.type_name, "Epic")

    def test_distinct_type_definitions_retain_distinct_metadata(self):
        epic = self.project.type_definitions.get(name="Epic")
        task_item = self._make(
            title="Overdue task",
            assignees=[self.data["chris"]],
            due_date=TODAY - timedelta(days=1),
        )
        epic_item = self._make(
            title="Overdue epic",
            assignees=[self.data["chris"]],
            due_date=TODAY - timedelta(days=2),
            type_id=epic.pk,
        )
        by_id = {
            c.work_item_id: c for c in self._candidates(self.data["chris"])
        }
        self.assertEqual(by_id[task_item.pk].type_definition_id,
                         self.task_type.pk)
        self.assertEqual(by_id[task_item.pk].type_name, "Task")
        self.assertEqual(by_id[epic_item.pk].type_definition_id, epic.pk)
        self.assertEqual(by_id[epic_item.pk].type_name, "Epic")


# ── Query behavior ──


class HomeAttentionQueryCountTest(_HomeAttentionBase):
    """Behavioral query-count regression for the attention read model.

    The candidate provider must not add one query per candidate row
    for Project / Work Item type definition / status definition
    context — those relations are eager-loaded with
    ``select_related`` on the single page query.
    """

    def _add_overdue_items(self, count, start=0):
        for i in range(start, start + count):
            self._make(
                title=f"QC overdue {i}",
                assignees=[self.data["chris"]],
                due_date=TODAY - timedelta(days=1 + i),
            )

    def test_candidate_count_does_not_scale_queries(self):
        # Page 1: 2 candidate rows.
        self._add_overdue_items(2)
        with CaptureQueriesContext(connection) as small_ctx:
            small_ids = self._candidate_ids(self.data["chris"])
        self.assertEqual(len(small_ids), 2)

        # Page 2: 14 candidate rows (7x the rows, same shape).
        self._add_overdue_items(12, start=2)
        with CaptureQueriesContext(connection) as large_ctx:
            large_ids = self._candidate_ids(self.data["chris"])
        self.assertEqual(len(large_ids), 14)

        # Invariant: 7x the candidate rows add ZERO queries — a
        # per-row relation lookup (Project / status definition N+1)
        # would make the second call issue 12 more queries.
        self.assertEqual(
            len(small_ctx.captured_queries),
            len(large_ctx.captured_queries),
            "Home attention query count must not scale with candidate "
            "row count; every serialized relation must be "
            "eager-loaded on the candidate queryset.",
        )
