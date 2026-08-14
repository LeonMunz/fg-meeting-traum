"""Domain tests for WorkItem, WorkItemAssignee, and application services.

Covers:
- WorkItem model/choices
- WorkItemAssignee uniqueness
- Assignee eligibility (owner/member eligible, viewer/non-member rejected)
- Hierarchy validation (same-project, no self-parent, no cycles)
- Completion semantics (done sets completed_at, reopen clears)
- Blocked semantics (blocked_reason only, no is_blocked)
- Service-layer operations
"""

from datetime import date

from django.contrib.auth import get_user_model
from django.db import IntegrityError
from django.test import TestCase
from django.utils import timezone

from research_groups.models import ResearchGroup, ResearchGroupMembership
from projects.models import Project, ProjectMembership
from projects.services import create_project, add_project_membership

from work_items.models import WorkItem, WorkItemAssignee
from work_items.services import (
    WorkItemDomainError,
    create_work_item,
    update_work_item,
    _require_project_write_access,
    _validate_assignee_eligibility,
)

User = get_user_model()


# ── Setup helpers ──


def _create_test_scenario():
    """Create the standard test scenario with users and project.

    Returns dict with group, alex (owner), chris (member), laura (viewer),
    maria (no membership), paper_xyz project.
    """
    group = ResearchGroup.objects.create(
        name="FG Test",
        created_by=User.objects.create_user(username="alex", password="Pass1!"),
    )
    alex = User.objects.get(username="alex")
    ResearchGroupMembership.objects.create(
        research_group=group, user=alex, role=ResearchGroupMembership.Role.ADMIN,
    )

    chris = User.objects.create_user(username="chris", password="Pass1!")
    ResearchGroupMembership.objects.create(
        research_group=group, user=chris, role=ResearchGroupMembership.Role.MEMBER,
    )

    laura = User.objects.create_user(username="laura", password="Pass1!")
    ResearchGroupMembership.objects.create(
        research_group=group, user=laura, role=ResearchGroupMembership.Role.MEMBER,
    )

    maria = User.objects.create_user(username="maria", password="Pass1!")
    ResearchGroupMembership.objects.create(
        research_group=group, user=maria, role=ResearchGroupMembership.Role.MEMBER,
    )

    paper_xyz = create_project(research_group=group, creator=alex, name="Paper XYZ")
    add_project_membership(project=paper_xyz, actor=alex, target_user=chris, role=ProjectMembership.Role.MEMBER)
    add_project_membership(project=paper_xyz, actor=alex, target_user=laura, role=ProjectMembership.Role.VIEWER)

    return {
        "group": group,
        "alex": alex,
        "chris": chris,
        "laura": laura,
        "maria": maria,
        "paper_xyz": paper_xyz,
    }


# ── Model Tests ──


class WorkItemModelTest(TestCase):
    """Test WorkItem model basics."""

    def setUp(self):
        self.user = User.objects.create_user(username="creator", password="Pass1!")
        self.group = ResearchGroup.objects.create(name="FG Test", created_by=self.user)
        ResearchGroupMembership.objects.create(
            research_group=self.group, user=self.user,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        self.project = Project.objects.create(
            name="Test Project", research_group=self.group, created_by=self.user,
        )

    def test_work_item_belongs_to_project(self):
        wi = WorkItem.objects.create(
            project=self.project, type=WorkItem.Type.TASK,
            title="Test Task", created_by=self.user,
        )
        self.assertEqual(wi.project, self.project)

    def test_epic_type(self):
        wi = WorkItem.objects.create(
            project=self.project, type=WorkItem.Type.EPIC,
            title="Epic", created_by=self.user,
        )
        self.assertEqual(wi.type, "epic")

    def test_milestone_type(self):
        wi = WorkItem.objects.create(
            project=self.project, type=WorkItem.Type.MILESTONE,
            title="Milestone", created_by=self.user,
        )
        self.assertEqual(wi.type, "milestone")

    def test_deliverable_type(self):
        wi = WorkItem.objects.create(
            project=self.project, type=WorkItem.Type.DELIVERABLE,
            title="Deliverable", created_by=self.user,
        )
        self.assertEqual(wi.type, "deliverable")

    def test_task_type(self):
        wi = WorkItem.objects.create(
            project=self.project, type=WorkItem.Type.TASK,
            title="Task", created_by=self.user,
        )
        self.assertEqual(wi.type, "task")

    def test_todo_status(self):
        wi = WorkItem.objects.create(
            project=self.project, type=WorkItem.Type.TASK,
            title="Task", status=WorkItem.Status.TODO, created_by=self.user,
        )
        self.assertEqual(wi.status, "todo")

    def test_in_progress_status(self):
        wi = WorkItem.objects.create(
            project=self.project, type=WorkItem.Type.TASK,
            title="Task", status=WorkItem.Status.IN_PROGRESS, created_by=self.user,
        )
        self.assertEqual(wi.status, "in_progress")

    def test_review_status(self):
        wi = WorkItem.objects.create(
            project=self.project, type=WorkItem.Type.TASK,
            title="Task", status=WorkItem.Status.REVIEW, created_by=self.user,
        )
        self.assertEqual(wi.status, "review")

    def test_done_status(self):
        wi = WorkItem.objects.create(
            project=self.project, type=WorkItem.Type.TASK,
            title="Task", status=WorkItem.Status.DONE, created_by=self.user,
        )
        self.assertEqual(wi.status, "done")

    def test_due_date_is_date(self):
        wi = WorkItem.objects.create(
            project=self.project, type=WorkItem.Type.TASK,
            title="Task", created_by=self.user,
            due_date=date(2025, 12, 31),
        )
        self.assertEqual(wi.due_date, date(2025, 12, 31))

    def test_parent_nullable(self):
        wi = WorkItem.objects.create(
            project=self.project, type=WorkItem.Type.TASK,
            title="Task", created_by=self.user,
        )
        self.assertIsNone(wi.parent)

    def test_completed_at_nullable(self):
        wi = WorkItem.objects.create(
            project=self.project, type=WorkItem.Type.TASK,
            title="Task", created_by=self.user,
        )
        self.assertIsNone(wi.completed_at)

    def test_blocked_reason_blank(self):
        wi = WorkItem.objects.create(
            project=self.project, type=WorkItem.Type.TASK,
            title="Task", created_by=self.user,
        )
        self.assertEqual(wi.blocked_reason, "")


class WorkItemAssigneeModelTest(TestCase):
    """Test WorkItemAssignee model and constraints."""

    def setUp(self):
        self.data = _create_test_scenario()

    def test_create_assignee(self):
        wi = WorkItem.objects.create(
            project=self.data["paper_xyz"], type=WorkItem.Type.TASK,
            title="Test", created_by=self.data["alex"],
        )
        assignee = WorkItemAssignee.objects.create(
            work_item=wi, user=self.data["chris"],
        )
        self.assertEqual(assignee.work_item, wi)
        self.assertEqual(assignee.user, self.data["chris"])

    def test_duplicate_assignee_rejected(self):
        wi = WorkItem.objects.create(
            project=self.data["paper_xyz"], type=WorkItem.Type.TASK,
            title="Test", created_by=self.data["alex"],
        )
        WorkItemAssignee.objects.create(work_item=wi, user=self.data["chris"])
        with self.assertRaises(IntegrityError):
            WorkItemAssignee.objects.create(work_item=wi, user=self.data["chris"])

    def test_multiple_eligible_assignees(self):
        wi = WorkItem.objects.create(
            project=self.data["paper_xyz"], type=WorkItem.Type.TASK,
            title="Test", created_by=self.data["alex"],
        )
        WorkItemAssignee.objects.create(work_item=wi, user=self.data["alex"])
        WorkItemAssignee.objects.create(work_item=wi, user=self.data["chris"])
        self.assertEqual(wi.assignee_relations.count(), 2)


# ── Assignee Eligibility Tests ──


class AssigneeEligibilityTest(TestCase):
    """Test assignee eligibility rules."""

    def setUp(self):
        self.data = _create_test_scenario()

    def test_owner_eligible(self):
        try:
            _validate_assignee_eligibility(self.data["paper_xyz"], self.data["alex"])
        except WorkItemDomainError:
            self.fail("Owner should be eligible for assignment")

    def test_member_eligible(self):
        try:
            _validate_assignee_eligibility(self.data["paper_xyz"], self.data["chris"])
        except WorkItemDomainError:
            self.fail("Member should be eligible for assignment")

    def test_viewer_rejected(self):
        with self.assertRaises(WorkItemDomainError) as ctx:
            _validate_assignee_eligibility(self.data["paper_xyz"], self.data["laura"])
        self.assertIn("viewer", str(ctx.exception.message).lower())

    def test_no_membership_rejected(self):
        with self.assertRaises(WorkItemDomainError) as ctx:
            _validate_assignee_eligibility(self.data["paper_xyz"], self.data["maria"])
        self.assertIn("ProjectMembership", ctx.exception.message)

    def test_no_project_membership_rejected_via_create(self):
        with self.assertRaises(WorkItemDomainError):
            create_work_item(
                project=self.data["paper_xyz"],
                actor=self.data["alex"],
                type=WorkItem.Type.TASK,
                title="Test",
                assignee_ids=[self.data["maria"].pk],
            )

    def test_viewer_assignee_rejected_via_create(self):
        with self.assertRaises(WorkItemDomainError):
            create_work_item(
                project=self.data["paper_xyz"],
                actor=self.data["alex"],
                type=WorkItem.Type.TASK,
                title="Test",
                assignee_ids=[self.data["laura"].pk],
            )


# ── Hierarchy Tests ──


class HierarchyValidationTest(TestCase):
    """Test WorkItem hierarchy rules."""

    def setUp(self):
        self.data = _create_test_scenario()

    def test_valid_same_project_parent(self):
        parent = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.EPIC,
            title="Epic",
        )
        child = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="Child Task",
            parent_id=parent.pk,
        )
        self.assertEqual(child.parent, parent)

    def test_self_parent_rejected(self):
        wi = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="Self Parent",
        )
        with self.assertRaises(WorkItemDomainError):
            update_work_item(
                work_item=wi,
                actor=self.data["alex"],
                parent_id=wi.pk,
            )

    def test_cross_project_parent_rejected(self):
        other_project = create_project(
            research_group=self.data["group"],
            creator=self.data["alex"],
            name="Other Project",
        )
        other_parent = create_work_item(
            project=other_project,
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="Other Task",
        )
        with self.assertRaises(WorkItemDomainError):
            create_work_item(
                project=self.data["paper_xyz"],
                actor=self.data["alex"],
                type=WorkItem.Type.TASK,
                title="Bad Child",
                parent_id=other_parent.pk,
            )

    def test_simple_cycle_rejected(self):
        a = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="A",
        )
        b = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="B",
            parent_id=a.pk,
        )
        with self.assertRaises(WorkItemDomainError):
            update_work_item(
                work_item=a,
                actor=self.data["alex"],
                parent_id=b.pk,
            )

    def test_deeper_cycle_rejected(self):
        a = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="A",
        )
        b = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="B",
            parent_id=a.pk,
        )
        c = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="C",
            parent_id=b.pk,
        )
        with self.assertRaises(WorkItemDomainError):
            update_work_item(
                work_item=a,
                actor=self.data["alex"],
                parent_id=c.pk,
            )

    def test_parent_can_be_cleared(self):
        parent = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.EPIC,
            title="Epic",
        )
        child = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="Child",
            parent_id=parent.pk,
        )
        update_work_item(
            work_item=child,
            actor=self.data["alex"],
            parent_id=None,
        )
        child.refresh_from_db()
        self.assertIsNone(child.parent)

    def test_no_rigid_type_parent_matrix(self):
        task_parent = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="Parent Task",
        )
        task_child = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="Child Task",
            parent_id=task_parent.pk,
        )
        self.assertEqual(task_child.parent, task_parent)

        epic_child = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.EPIC,
            title="Child Epic",
            parent_id=task_parent.pk,
        )
        self.assertEqual(epic_child.parent, task_parent)


# ── Completion Semantics Tests ──


class CompletionSemanticsTest(TestCase):
    """Test completed_at transition behavior."""

    def setUp(self):
        self.data = _create_test_scenario()

    def test_done_sets_completed_at(self):
        wi = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="Test",
            status=WorkItem.Status.TODO,
        )
        self.assertIsNone(wi.completed_at)

        update_work_item(
            work_item=wi,
            actor=self.data["alex"],
            status=WorkItem.Status.DONE,
        )
        wi.refresh_from_db()
        self.assertIsNotNone(wi.completed_at)

    def test_reopen_clears_completed_at(self):
        wi = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="Test",
            status=WorkItem.Status.DONE,
        )
        self.assertIsNotNone(wi.completed_at)

        update_work_item(
            work_item=wi,
            actor=self.data["alex"],
            status=WorkItem.Status.REVIEW,
        )
        wi.refresh_from_db()
        self.assertIsNone(wi.completed_at)
        self.assertEqual(wi.status, "review")

    def test_editing_done_item_without_reopening_preserves_completed_at(self):
        wi = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="Test",
            status=WorkItem.Status.DONE,
        )
        original_completed_at = wi.completed_at
        self.assertIsNotNone(original_completed_at)

        update_work_item(
            work_item=wi,
            actor=self.data["alex"],
            title="Updated Title",
        )
        wi.refresh_from_db()
        self.assertEqual(wi.completed_at, original_completed_at)
        self.assertEqual(wi.title, "Updated Title")

    def test_client_cannot_set_completed_at(self):
        wi = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="Test",
            status=WorkItem.Status.TODO,
        )
        self.assertIsNone(wi.completed_at)

        arbitrary_time = timezone.now()
        wi.completed_at = arbitrary_time
        wi.save(update_fields=["completed_at"])

        update_work_item(
            work_item=wi,
            actor=self.data["alex"],
            title="Updated",
        )
        wi.refresh_from_db()
        self.assertIsNone(wi.completed_at)

    def test_create_as_done_sets_completed_at(self):
        wi = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="Done from start",
            status=WorkItem.Status.DONE,
        )
        self.assertIsNotNone(wi.completed_at)


# ── Blocked Semantics Tests ──


class BlockedSemanticsTest(TestCase):
    """Test blocked_reason semantics."""

    def setUp(self):
        self.data = _create_test_scenario()

    def test_blocked_reason_set(self):
        wi = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="Test",
            blocked_reason="Waiting on review",
        )
        self.assertEqual(wi.blocked_reason, "Waiting on review")

    def test_blocked_reason_cleared(self):
        wi = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="Test",
            blocked_reason="Waiting on review",
        )
        update_work_item(
            work_item=wi,
            actor=self.data["alex"],
            blocked_reason="",
        )
        wi.refresh_from_db()
        self.assertEqual(wi.blocked_reason, "")

    def test_no_is_blocked_field(self):
        fields = [f.name for f in WorkItem._meta.get_fields()]
        self.assertNotIn("is_blocked", fields)


# ── Service Create/Update Tests ──


class ServiceCreateUpdateTest(TestCase):
    """Test create_work_item and update_work_item service operations."""

    def setUp(self):
        self.data = _create_test_scenario()

    def test_owner_can_create(self):
        wi = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="Test Task",
        )
        self.assertEqual(wi.title, "Test Task")
        self.assertEqual(wi.created_by, self.data["alex"])

    def test_member_can_create(self):
        wi = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["chris"],
            type=WorkItem.Type.TASK,
            title="Chris Task",
        )
        self.assertEqual(wi.title, "Chris Task")
        self.assertEqual(wi.created_by, self.data["chris"])

    def test_viewer_cannot_create(self):
        with self.assertRaises(WorkItemDomainError):
            create_work_item(
                project=self.data["paper_xyz"],
                actor=self.data["laura"],
                type=WorkItem.Type.TASK,
                title="Viewer Task",
            )

    def test_invalid_type_rejected(self):
        with self.assertRaises(WorkItemDomainError):
            create_work_item(
                project=self.data["paper_xyz"],
                actor=self.data["alex"],
                type="invalid",
                title="Bad Type",
            )

    def test_invalid_status_rejected(self):
        with self.assertRaises(WorkItemDomainError):
            create_work_item(
                project=self.data["paper_xyz"],
                actor=self.data["alex"],
                type=WorkItem.Type.TASK,
                title="Bad Status",
                status="blocked",
            )

    def test_atomic_rollback_on_invalid_assignee(self):
        with self.assertRaises(WorkItemDomainError):
            create_work_item(
                project=self.data["paper_xyz"],
                actor=self.data["alex"],
                type=WorkItem.Type.TASK,
                title="Should Not Exist",
                assignee_ids=[self.data["chris"].pk, self.data["maria"].pk],
            )
        self.assertEqual(
            WorkItem.objects.filter(title="Should Not Exist").count(), 0
        )

    def test_update_title(self):
        wi = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="Original",
        )
        update_work_item(
            work_item=wi,
            actor=self.data["alex"],
            title="Updated",
        )
        wi.refresh_from_db()
        self.assertEqual(wi.title, "Updated")

    def test_update_assignees_replaces(self):
        wi = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="Test",
            assignee_ids=[self.data["alex"].pk],
        )
        self.assertEqual(wi.assignee_relations.count(), 1)

        update_work_item(
            work_item=wi,
            actor=self.data["alex"],
            assignee_ids=[self.data["chris"].pk],
        )
        assignees = list(wi.assignee_relations.values_list("user__pk", flat=True))
        self.assertEqual(assignees, [self.data["chris"].pk])

    def test_invalid_assignee_set_rolls_back(self):
        wi = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="Test",
            assignee_ids=[self.data["alex"].pk],
        )
        with self.assertRaises(WorkItemDomainError):
            update_work_item(
                work_item=wi,
                actor=self.data["alex"],
                assignee_ids=[self.data["chris"].pk, self.data["maria"].pk],
            )
        assignees = list(wi.assignee_relations.values_list("user__pk", flat=True))
        self.assertEqual(assignees, [self.data["alex"].pk])

    def test_project_cannot_be_changed(self):
        import inspect
        sig = inspect.signature(update_work_item)
        self.assertNotIn("project", sig.parameters)

    def test_created_by_cannot_be_changed(self):
        import inspect
        sig = inspect.signature(update_work_item)
        self.assertNotIn("created_by", sig.parameters)

    def test_multiple_assignees(self):
        wi = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="Multi Assign",
            assignee_ids=[self.data["alex"].pk, self.data["chris"].pk],
        )
        assignees = sorted(wi.assignee_relations.values_list("user__pk", flat=True))
        self.assertEqual(
            assignees,
            sorted([self.data["alex"].pk, self.data["chris"].pk]),
        )

    def test_duplicate_ids_in_assignee_list(self):
        wi = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="Duplicate Test",
            assignee_ids=[self.data["alex"].pk, self.data["alex"].pk],
        )
        self.assertEqual(wi.assignee_relations.count(), 1)
