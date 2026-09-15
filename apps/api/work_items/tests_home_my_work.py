"""Home "My work" — Work Item candidate read model tests.

Proves the canonical semantics of
``work_items.home_my_work.get_home_my_work_candidates``:

- canonical equivalence with the personal My Work boundary
  (shared query source ``work_items.personal_my_work``):
  everything canonical personal My Work qualifies (that is not
  complete) qualifies for Home, and everything personal My Work
  excludes for assignment/eligibility reasons is excluded
- current assignment only (owner/member assignees qualify;
  unassigned, other users' assignments, and stale viewer rows
  never do)
- current read authorization is mandatory (Project membership +
  Research Group membership removal removes the candidate
  immediately; canonical assignment-resolving demotion is
  consistent)
- explicit active-only projection: status category ``done`` is
  excluded by CATEGORY (never by status display name), while the
  personal My Work ENDPOINT is deliberately unchanged (it keeps
  completed items — pinned in tests_personal_my_work.py)
- data contract: only the intended structured Home fields, plain
  values, passthrough title/blocked reason, no rendered
  sentences, no model internals
- intentional cross-module overlap: a Work Item may appear in
  Home "My work" AND "Needs attention" AND "Today & next"; no
  suppression
- deterministic ordering: stable Work Item ID ascending (no
  urgency/time ranking; the existing My Work projections declare
  no canonical ordering)
- complete candidate set: no Home row limit
- bounded query count (no N+1 per candidate row)

This read model observes no clock at all, so no test here
depends on the wall calendar (the Today-&-next overlap tests use
the real application clock with a due date inside the window).
"""

import dataclasses
from datetime import date, timedelta

from django.contrib.auth import get_user_model
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.db.models import Q
from django.utils import timezone

from projects.models import (
    ProjectMembership,
    WorkItemStatusDefinition,
)
from projects.services import (
    ASSIGNMENT_RESOLUTION_UNASSIGN,
    add_project_membership,
    change_membership_role,
    create_project,
)
from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)

from home_timeline.timeline import (
    DOMAIN_WORK_ITEM,
    get_home_timeline_candidates,
)
from work_items.home_attention import get_work_item_attention_candidates
from work_items.home_my_work import (
    HomeMyWorkCandidate,
    get_home_my_work_candidates,
)
from work_items.models import WorkItem, WorkItemAssignee
from work_items.personal_my_work import personal_my_work_queryset
from work_items.services import create_work_item

User = get_user_model()

SEED_PASSWORD = "DevPass1!"


def _create_standard_data():
    """Create the standard Foundation 4 scenario, plus a second
    Research Group to prove the cross-group union.

    Paper XYZ (FG Example):
      Alex: owner
      Chris: member
      Laura: viewer
      Maria: no ProjectMembership (but Research Group member)

    Robot Study (Robotics Lab):
      Alex: owner
      Chris: member
    """
    alex = User.objects.create_user(username="alex", password=SEED_PASSWORD)
    chris = User.objects.create_user(username="chris", password=SEED_PASSWORD)
    maria = User.objects.create_user(username="maria", password=SEED_PASSWORD)
    laura = User.objects.create_user(username="laura", password=SEED_PASSWORD)

    group_a = ResearchGroup.objects.create(
        name="FG Example", created_by=alex,
    )
    group_b = ResearchGroup.objects.create(
        name="Robotics Lab", created_by=alex,
    )

    for group in (group_a, group_b):
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
        research_group=group_a, creator=alex, name="Paper XYZ"
    )
    robot_study = create_project(
        research_group=group_b, creator=alex, name="Robot Study"
    )

    add_project_membership(
        project=paper_xyz, actor=alex,
        target_user=chris, role=ProjectMembership.Role.MEMBER,
    )
    add_project_membership(
        project=paper_xyz, actor=alex,
        target_user=laura, role=ProjectMembership.Role.VIEWER,
    )
    add_project_membership(
        project=robot_study, actor=alex,
        target_user=chris, role=ProjectMembership.Role.MEMBER,
    )
    # Maria has NO membership in either Project

    return {
        "group_a": group_a,
        "group_b": group_b,
        "alex": alex,
        "chris": chris,
        "maria": maria,
        "laura": laura,
        "paper_xyz": paper_xyz,
        "robot_study": robot_study,
    }


def _iso(d: date) -> str:
    return d.isoformat()


class _HomeMyWorkBase(TestCase):
    def setUp(self):
        super().setUp()
        self.data = _create_standard_data()
        self.project = self.data["paper_xyz"]
        self.task_type = self.project.type_definitions.get(name="Task")
        self.done_status = self.project.status_definitions.get(name="Done")

    def _make(self, *, title, project=None, assignees=(), due_date=None,
              blocked_reason=None, status_id=None):
        project = project or self.project
        return create_work_item(
            project=project,
            actor=self.data["alex"],
            type_definition_id=project.type_definitions.get(name="Task").pk,
            title=title,
            status_definition_id=status_id,
            assignee_ids=[u.pk for u in assignees],
            due_date=_iso(due_date) if due_date is not None else None,
            blocked_reason=blocked_reason,
        )

    def _candidates(self, user):
        return get_home_my_work_candidates(user=user)

    def _candidate_ids(self, user):
        return [c.work_item_id for c in self._candidates(user)]

    def _personal_my_work_ids(self, user, *, open_only=False):
        queryset = personal_my_work_queryset(user)
        if open_only:
            queryset = queryset.filter(
                ~Q(status_definition__category=
                   WorkItemStatusDefinition.Category.DONE)
            )
        return list(queryset.values_list("pk", flat=True))


# ── Canonical equivalence with personal My Work ──


class HomeMyWorkEquivalenceTest(_HomeMyWorkBase):
    """Home "My work" must be exactly the canonical personal My
    Work boundary, active-only — no Home-specific role,
    membership, or assignment rules."""

    def test_personal_my_work_candidates_also_home_candidates(self):
        self._make(title="Plain open work", assignees=[self.data["chris"]])
        self._make(
            title="Overdue work",
            assignees=[self.data["chris"]],
            due_date=date(2000, 1, 1),
        )
        self._make(
            title="Blocked work",
            assignees=[self.data["chris"]],
            blocked_reason="Waiting",
        )
        self.assertEqual(
            sorted(self._candidate_ids(self.data["chris"])),
            sorted(self._personal_my_work_ids(self.data["chris"],
                                              open_only=True)),
        )

    def test_done_item_still_in_personal_my_work_but_not_home(self):
        """Pins the documented projection delta: canonical personal
        My Work (and its endpoint) keeps completed items; Home "my
        work" is active-only. The endpoint-side half is pinned in
        tests_personal_my_work.py."""
        wi = self._make(
            title="Completed work",
            assignees=[self.data["chris"]],
            status_id=self.done_status.pk,
        )
        self.assertIn(
            wi.pk, self._personal_my_work_ids(self.data["chris"])
        )
        self.assertNotIn(wi.pk, self._candidate_ids(self.data["chris"]))

    def test_unassigned_item_excluded_everywhere(self):
        wi = self._make(title="Unassigned")
        for user in (self.data["alex"], self.data["chris"]):
            self.assertNotIn(wi.pk, self._personal_my_work_ids(user))
            self.assertNotIn(wi.pk, self._candidate_ids(user))

    def test_other_users_assignment_excluded_everywhere(self):
        wi = self._make(
            title="Alex's item", assignees=[self.data["alex"]]
        )
        self.assertNotIn(wi.pk, self._personal_my_work_ids(self.data["chris"]))
        self.assertNotIn(wi.pk, self._candidate_ids(self.data["chris"]))
        # ...and it is Home material for the assigned user.
        self.assertEqual(self._candidate_ids(self.data["alex"]), [wi.pk])

    def test_stale_viewer_assignment_excluded_everywhere(self):
        wi = self._make(
            title="Demoted viewer row", assignees=[self.data["chris"]],
        )
        membership = ProjectMembership.objects.get(
            project=self.project, user=self.data["chris"],
        )
        membership.role = ProjectMembership.Role.VIEWER
        membership.save(update_fields=["role"])

        self.assertNotIn(
            wi.pk, self._personal_my_work_ids(self.data["chris"])
        )
        self.assertNotIn(wi.pk, self._candidate_ids(self.data["chris"]))

    def test_owner_and_member_assignees_qualify(self):
        wi_owner = self._make(title="Owner item", assignees=[self.data["alex"]])
        wi_member = self._make(title="Member item", assignees=[self.data["chris"]])
        self.assertEqual(self._candidate_ids(self.data["alex"]), [wi_owner.pk])
        self.assertEqual(self._candidate_ids(self.data["chris"]), [wi_member.pk])

    def test_cross_group_union_in_single_read(self):
        wi_a = self._make(
            title="Group A item", assignees=[self.data["chris"]],
        )
        wi_b = self._make(
            title="Group B item",
            project=self.data["robot_study"],
            assignees=[self.data["chris"]],
        )
        self.assertEqual(
            self._candidate_ids(self.data["chris"]),
            [wi_a.pk, wi_b.pk],
        )

    def test_group_scoped_shared_querysource_matches(self):
        """The per-Research-Group My Work variant of the shared
        query source (the query behind
        GET /api/research-groups/{id}/my-work/) is the same
        boundary restricted to one group."""
        wi_a = self._make(
            title="Group A item", assignees=[self.data["chris"]],
        )
        self._make(
            title="Group B item",
            project=self.data["robot_study"],
            assignees=[self.data["chris"]],
        )
        scoped = list(
            personal_my_work_queryset(
                self.data["chris"], group_id=self.data["group_a"].pk,
            ).values_list("pk", flat=True)
        )
        self.assertEqual(scoped, [wi_a.pk])


# ── Assignment ──


class HomeMyWorkAssignmentTest(_HomeMyWorkBase):

    def test_current_assignee_sees_open_item(self):
        """No urgency or time filter: an open, undated,
        unblocked item is Home material for its assignee."""
        wi = self._make(title="Open work", assignees=[self.data["chris"]])
        self.assertEqual(self._candidate_ids(self.data["chris"]), [wi.pk])

    def test_unassigned_item_excluded_for_everyone(self):
        self._make(title="Unassigned")
        for user in (self.data["alex"], self.data["chris"],
                     self.data["maria"], self.data["laura"]):
            self.assertEqual(self._candidate_ids(user), [])

    def test_item_assigned_only_to_another_user_excluded(self):
        wi = self._make(
            title="Alex's task", assignees=[self.data["alex"]],
        )
        self.assertNotIn(wi.pk, self._candidate_ids(self.data["chris"]))
        self.assertEqual(self._candidate_ids(self.data["alex"]), [wi.pk])

    def test_project_owner_without_assignment_sees_nothing(self):
        """Ownership of the Project never creates Home work."""
        self._make(title="Chris's task", assignees=[self.data["chris"]])
        self.assertEqual(self._candidate_ids(self.data["alex"]), [])


# ── Authorization / revocation ──


class HomeMyWorkAuthorizationTest(_HomeMyWorkBase):

    def test_project_membership_removal_removes_candidate(self):
        wi = self._make(
            title="Then revoked", assignees=[self.data["chris"]],
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
            title="Group membership revoked", assignees=[self.data["chris"]],
        )
        # The composite FK requires the ProjectMembership to go first.
        ProjectMembership.objects.filter(
            project=self.project, user=self.data["chris"],
        ).delete()
        ResearchGroupMembership.objects.filter(
            research_group=self.data["group_a"], user=self.data["chris"],
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
        self._make(
            title="Not Maria's project", assignees=[self.data["chris"]],
        )
        self.assertEqual(self._candidate_ids(self.data["maria"]), [])

    def test_invalid_viewer_assignment_row_is_excluded(self):
        """A viewer holding an assignment row is excluded.

        This pins the CANONICAL assignment invariant, not a
        Home-specific role rule: a viewer cannot be assigned
        (``PROJECT_WORK`` capability — ``owner``/``member`` only),
        and the canonical mutation paths never leave such a row
        behind. The violating row is therefore only creatable by
        direct ORM manipulation; the read model must not trust
        it (read-time role filter, identical to personal My Work).
        General Work Item readability (``PROJECT_READ``) is NOT
        My Work eligibility.
        """
        wi = self._make(
            title="Demoted to viewer", assignees=[self.data["chris"]],
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
        viewer can never hold a valid assignment row."""
        wi = self._make(
            title="Assigned then demoted", assignees=[self.data["chris"]],
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

    def test_canonical_demotion_with_unassign_resolution_removes_candidate(
        self,
    ):
        """The canonical assignment-resolving demotion removes the
        WorkItemAssignee row atomically — the item then
        disappears from Home "My work" (it is no longer anyone's
        assignment)."""
        wi = self._make(
            title="Demoted with resolution", assignees=[self.data["chris"]],
        )
        membership = ProjectMembership.objects.get(
            project=self.project, user=self.data["chris"],
        )
        change_membership_role(
            membership=membership,
            actor=self.data["alex"],
            new_role=ProjectMembership.Role.VIEWER,
            assignment_resolution=ASSIGNMENT_RESOLUTION_UNASSIGN,
        )
        self.assertFalse(
            WorkItemAssignee.objects.filter(
                work_item=wi, user=self.data["chris"],
            ).exists()
        )
        self.assertEqual(self._candidate_ids(self.data["chris"]), [])


# ── Completion (active-only projection) ──


class HomeMyWorkCompletionTest(_HomeMyWorkBase):

    def test_done_item_excluded(self):
        wi = self._make(
            title="Done", assignees=[self.data["chris"]],
            status_id=self.done_status.pk,
        )
        self.assertEqual(wi.status_definition.category, "done")
        self.assertEqual(self._candidate_ids(self.data["chris"]), [])

    def test_done_item_with_stale_due_and_blocked_metadata_excluded(self):
        self._make(
            title="Done with stale metadata",
            assignees=[self.data["chris"]],
            due_date=date(2000, 1, 1),
            blocked_reason="Stale metadata",
            status_id=self.done_status.pk,
        )
        self.assertEqual(self._candidate_ids(self.data["chris"]), [])

    def test_exclusion_is_by_category_not_status_name(self):
        """A done-CATEGORY status with no "done" in its name is
        excluded; a non-done status named like completion work is
        not — category semantics, never display-name matching."""
        shipped = WorkItemStatusDefinition.objects.create(
            project=self.project, name="Shipped",
            category=WorkItemStatusDefinition.Category.DONE,
            order=99,
        )
        review_alias = WorkItemStatusDefinition.objects.create(
            project=self.project, name="Finished (awaiting sign-off)",
            category=WorkItemStatusDefinition.Category.REVIEW,
            order=98,
        )
        wi_shipped = self._make(
            title="Shipped but not done",
            assignees=[self.data["chris"]],
            status_id=shipped.pk,
        )
        wi_review = self._make(
            title="Finished alias",
            assignees=[self.data["chris"]],
            status_id=review_alias.pk,
        )
        ids = self._candidate_ids(self.data["chris"])
        self.assertNotIn(wi_shipped.pk, ids)
        self.assertIn(wi_review.pk, ids)

    def test_all_open_categories_are_candidates(self):
        statuses = self.project.status_definitions.filter(
            category__in=[
                WorkItemStatusDefinition.Category.TODO,
                WorkItemStatusDefinition.Category.IN_PROGRESS,
                WorkItemStatusDefinition.Category.REVIEW,
            ]
        )
        pks = []
        for status in statuses:
            wi = self._make(
                title=f"Open in {status.name}",
                assignees=[self.data["chris"]],
                status_id=status.pk,
            )
            pks.append(wi.pk)
        self.assertEqual(
            sorted(self._candidate_ids(self.data["chris"])), sorted(pks)
        )


# ── Data contract ──


class HomeMyWorkDataContractTest(_HomeMyWorkBase):

    EXPECTED_FIELDS = {
        "work_item_id",
        "title",
        "project_id",
        "project_name",
        "type_definition_id",
        "type_name",
        "status_category",
        "due_date",
        "blocked_reason",
    }

    def test_candidate_exposes_exactly_the_intended_fields(self):
        fields = {f.name for f in dataclasses.fields(HomeMyWorkCandidate)}
        self.assertEqual(fields, self.EXPECTED_FIELDS)

    def test_candidate_values_are_plain_and_passthrough(self):
        wi = self._make(
            title="Field check",
            assignees=[self.data["chris"]],
            due_date=date(2026, 10, 1),
            blocked_reason="Blocked reason text",
        )
        (candidate,) = self._candidates(self.data["chris"])
        self.assertIsInstance(candidate.work_item_id, int)
        self.assertEqual(candidate.work_item_id, wi.pk)
        self.assertIsInstance(candidate.title, str)
        self.assertEqual(candidate.title, "Field check")
        self.assertIsInstance(candidate.project_id, int)
        self.assertEqual(candidate.project_id, self.project.pk)
        self.assertIsInstance(candidate.project_name, str)
        self.assertEqual(candidate.project_name, "Paper XYZ")
        self.assertIsInstance(candidate.type_definition_id, int)
        self.assertEqual(candidate.type_definition_id, self.task_type.pk)
        self.assertIsInstance(candidate.type_name, str)
        self.assertEqual(candidate.type_name, "Task")
        self.assertIsInstance(candidate.status_category, str)
        self.assertEqual(candidate.status_category, "todo")
        self.assertEqual(candidate.due_date, date(2026, 10, 1))
        self.assertEqual(candidate.blocked_reason, "Blocked reason text")

    def test_unblocked_item_has_none_blocked_reason(self):
        self._make(
            title="Not blocked", assignees=[self.data["chris"]],
            blocked_reason="",
        )
        (candidate,) = self._candidates(self.data["chris"])
        self.assertIsNone(candidate.blocked_reason)

    def test_no_model_instance_or_model_internal_leaks(self):
        self._make(title="Internals", assignees=[self.data["chris"]])
        (candidate,) = self._candidates(self.data["chris"])
        for value in dataclasses.astuple(candidate):
            self.assertNotIsInstance(value, WorkItem)
            self.assertNotIsInstance(value, ProjectMembership)
        # No Work Item internals beyond the candidate fields.
        for internal in ("description", "board_position", "completed_at",
                         "assigneeIds", "work_item"):
            self.assertNotIn(
                internal, {f.name for f in dataclasses.fields(candidate)},
                f"{internal} must not be part of the candidate",
            )

    def test_no_rendered_sentence_is_generated(self):
        """title and blocked_reason pass through untouched — the
        composition layer renders copy, never this read model."""
        self._make(
            title="Exact title with ! punctuation",
            assignees=[self.data["chris"]],
            blocked_reason="Exact reason — untouched",
        )
        (candidate,) = self._candidates(self.data["chris"])
        self.assertEqual(candidate.title, "Exact title with ! punctuation")
        self.assertEqual(
            candidate.blocked_reason, "Exact reason — untouched"
        )


# ── Cross-module overlap (no suppression) ──


class HomeMyWorkOverlapTest(_HomeMyWorkBase):
    """A Work Item may legitimately appear in "My work", "Needs
    attention", and "Today & next" for different reasons. Each
    module answers a different question; this read model must
    never suppress the overlap."""

    def test_blocked_item_in_my_work_and_needs_attention(self):
        wi = self._make(
            title="Blocked", assignees=[self.data["chris"]],
            blocked_reason="Waiting on data",
        )
        self.assertIn(wi.pk, self._candidate_ids(self.data["chris"]))
        attention_ids = [
            c.work_item_id
            for c in get_work_item_attention_candidates(
                user=self.data["chris"]
            )
        ]
        self.assertIn(wi.pk, attention_ids)

    def test_due_in_window_item_in_my_work_and_today_next(self):
        wi = self._make(
            title="Due soon",
            assignees=[self.data["chris"]],
            due_date=timezone.localdate() + timedelta(days=2),
        )
        self.assertIn(wi.pk, self._candidate_ids(self.data["chris"]))
        timeline_ids = [
            c.object_id
            for c in get_home_timeline_candidates(user=self.data["chris"])
            if c.domain == DOMAIN_WORK_ITEM
        ]
        self.assertIn(wi.pk, timeline_ids)

    def test_blocked_and_due_today_item_in_all_three_modules(self):
        wi = self._make(
            title="Blocked and due today",
            assignees=[self.data["chris"]],
            due_date=timezone.localdate(),
            blocked_reason="Waiting on review",
        )
        self.assertIn(wi.pk, self._candidate_ids(self.data["chris"]))
        attention_ids = [
            c.work_item_id
            for c in get_work_item_attention_candidates(
                user=self.data["chris"]
            )
        ]
        self.assertIn(wi.pk, attention_ids)
        timeline_ids = [
            c.object_id
            for c in get_home_timeline_candidates(user=self.data["chris"])
            if c.domain == DOMAIN_WORK_ITEM
        ]
        self.assertIn(wi.pk, timeline_ids)

    def test_done_item_in_no_home_module(self):
        """A completed item leaves every Home Work Item module —
        but remains in the personal My Work endpoint (pinned in
        tests_personal_my_work.py)."""
        self._make(
            title="Done",
            assignees=[self.data["chris"]],
            due_date=timezone.localdate() - timedelta(days=5),
            blocked_reason="Stale",
            status_id=self.done_status.pk,
        )
        self.assertEqual(self._candidate_ids(self.data["chris"]), [])
        self.assertEqual(
            [
                c.work_item_id
                for c in get_work_item_attention_candidates(
                    user=self.data["chris"]
                )
            ],
            [],
        )
        self.assertEqual(
            [
                c.object_id
                for c in get_home_timeline_candidates(user=self.data["chris"])
                if c.domain == DOMAIN_WORK_ITEM
            ],
            [],
        )


# ── Ordering ──


class HomeMyWorkOrderingTest(_HomeMyWorkBase):
    """Home "My work" is a compact responsibility list: no
    urgency ranking (Needs attention) and no chronological merge
    (Today & next). The existing My Work projections declare no
    canonical ordering, so the read model uses the stable Work
    Item ID ordering — deterministic, no invented relevance
    score."""

    def setUp(self):
        super().setUp()
        chris = self.data["chris"]
        # Deliberately "urgent" items first: if the read model
        # ranked by urgency or time, these would sort ahead of the
        # plain items created later.
        self.wi_overdue_blocked = self._make(
            title="Overdue + blocked (id 1)",
            assignees=[chris],
            due_date=date(2000, 1, 1),
            blocked_reason="blocked",
        )
        self.wi_blocked = self._make(
            title="Blocked (id 2)",
            assignees=[chris],
            blocked_reason="blocked",
        )
        self.wi_plain = self._make(
            title="Plain open (id 3)",
            assignees=[chris],
        )
        self.wi_future_due = self._make(
            title="Due far in the future (id 4)",
            assignees=[chris],
            due_date=date(2999, 12, 31),
        )

    def test_orders_by_stable_work_item_id_ascending(self):
        self.assertEqual(
            self._candidate_ids(self.data["chris"]),
            [
                self.wi_overdue_blocked.pk,
                self.wi_blocked.pk,
                self.wi_plain.pk,
                self.wi_future_due.pk,
            ],
        )

    def test_repeated_reads_are_deterministic(self):
        self.assertEqual(
            self._candidate_ids(self.data["chris"]),
            self._candidate_ids(self.data["chris"]),
        )


# ── No row limit + query behavior ──


class HomeMyWorkQueryCountTest(_HomeMyWorkBase):
    """Behavioral query-count regression for the Home "My work"
    read model.

    The candidate provider must not add one query per candidate
    row for Project / type definition / status definition
    context — those relations are eager-loaded with
    ``select_related`` on the single bounded query. The read
    model returns the COMPLETE candidate set: no Home row limit.
    """

    def _add_items(self, count, start=0):
        for i in range(start, start + count):
            self._make(
                title=f"QC work {i}",
                assignees=[self.data["chris"]],
            )

    def test_full_set_returned_and_query_count_bounded(self):
        # Page 1: 2 candidate rows.
        self._add_items(2)
        with CaptureQueriesContext(connection) as small_ctx:
            small_ids = self._candidate_ids(self.data["chris"])
        self.assertEqual(len(small_ids), 2)

        # Page 2: 14 candidate rows (7x the rows, same shape) —
        # all of them returned (no Home row limit).
        self._add_items(12, start=2)
        with CaptureQueriesContext(connection) as large_ctx:
            large_ids = self._candidate_ids(self.data["chris"])
        self.assertEqual(len(large_ids), 14)

        # Invariant: 7x the candidate rows add ZERO queries — a
        # per-row relation lookup (Project / type / status
        # definition N+1) would make the second call issue 12 more
        # queries.
        self.assertEqual(
            len(small_ctx.captured_queries),
            len(large_ctx.captured_queries),
            "Home My Work query count must not scale with "
            "candidate row count; every serialized relation must "
            "be eager-loaded on the candidate queryset.",
        )
