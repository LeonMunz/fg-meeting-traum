"""Tests for the seed_dev management command."""

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.test import TestCase, TransactionTestCase
from io import StringIO

from research_groups.models import ResearchGroup, ResearchGroupMembership
from projects.models import (
    Project,
    ProjectMembership,
    WorkItemStatusDefinition,
    WorkItemTypeDefinition,
)
from work_items.models import WorkItem, WorkItemAssignee

User = get_user_model()


class SeedDevIdempotencyTest(TransactionTestCase):
    """Test that seed_dev is idempotent."""

    def test_seed_dev_runs_twice_without_duplicates(self):
        """Running seed_dev twice should not create duplicates."""
        out1 = StringIO()
        call_command("seed_dev", stdout=out1)

        out2 = StringIO()
        call_command("seed_dev", stdout=out2)

        # No duplicate users
        self.assertEqual(User.objects.count(), 4)

        # No duplicate research groups
        self.assertEqual(ResearchGroup.objects.count(), 1)

        # No duplicate projects
        self.assertEqual(Project.objects.count(), 2)

        # WorkItems: 3 seeded (Epic, Task, Milestone)
        self.assertEqual(WorkItem.objects.count(), 3)

        # WorkItemAssignees: 2 (Chris→Task, Alex→Milestone)
        self.assertEqual(WorkItemAssignee.objects.count(), 2)

    def test_seed_dev_creates_expected_work_items(self):
        """Verify the seeded WorkItems have correct attributes."""
        call_command("seed_dev", stdout=StringIO())

        paper_xyz = Project.objects.get(name="Paper XYZ")
        alex = User.objects.get(username="alex")
        chris = User.objects.get(username="chris")

        # Epic: Literature Review
        epic = WorkItem.objects.get(
            project=paper_xyz, title="Literature Review",
        )
        self.assertEqual(epic.type_definition.name, "Epic")
        self.assertEqual(epic.status_definition.name, "In Progress")
        self.assertEqual(epic.created_by, alex)
        self.assertIsNone(epic.parent)

        # Task: Rewrite Introduction
        task = WorkItem.objects.get(
            project=paper_xyz, title="Rewrite Introduction",
        )
        self.assertEqual(task.type_definition.name, "Task")
        self.assertEqual(task.status_definition.name, "Todo")
        self.assertEqual(task.parent, epic)
        self.assertEqual(task.created_by, alex)
        # Assigned to Chris
        assignees = list(task.assignee_relations.values_list("user__pk", flat=True))
        self.assertEqual(assignees, [chris.pk])

        # Milestone: First Draft Complete
        milestone = WorkItem.objects.get(
            project=paper_xyz, title="First Draft Complete",
        )
        self.assertEqual(milestone.type_definition.name, "Milestone")
        self.assertEqual(milestone.status_definition.name, "Todo")
        self.assertEqual(milestone.created_by, alex)
        self.assertIsNotNone(milestone.due_date)
        # Assigned to Alex
        assignees = list(milestone.assignee_relations.values_list("user__pk", flat=True))
        self.assertEqual(assignees, [alex.pk])

    def test_seed_dev_no_work_items_in_maria_project(self):
        """Maria Private Project should have no seeded WorkItems."""
        call_command("seed_dev", stdout=StringIO())

        maria_project = Project.objects.get(name="Maria Private Project")
        self.assertEqual(WorkItem.objects.filter(project=maria_project).count(), 0)

    def test_seed_dev_preserves_existing_work_items(self):
        """Pre-existing WorkItems should not be affected by seed."""
        # Create a project and work item before seeding
        user = User.objects.create_user(username="pre_seed", password="Pass1!")
        group = ResearchGroup.objects.create(name="Pre Seed Group", created_by=user)
        ResearchGroupMembership.objects.create(
            research_group=group, user=user,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        project = Project.objects.create(
            name="Pre Seed Project",
            research_group=group,
            created_by=user,
        )
        task_type = WorkItemTypeDefinition.objects.create(
            project=project, name="Task", order=0,
        )
        todo_status = WorkItemStatusDefinition.objects.create(
            project=project, name="Todo",
            category=WorkItemStatusDefinition.Category.TODO,
            order=0, is_default=True,
        )
        wi = WorkItem.objects.create(
            project=project,
            type_definition=task_type,
            status_definition=todo_status,
            title="Pre-existing Task",
            created_by=user,
        )

        call_command("seed_dev", stdout=StringIO())

        # Pre-existing work item should still exist
        self.assertTrue(WorkItem.objects.filter(pk=wi.pk).exists())
        self.assertEqual(WorkItem.objects.filter(title="Pre-existing Task").count(), 1)
