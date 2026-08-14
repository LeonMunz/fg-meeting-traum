from django.conf import settings
from django.db import models

from projects.models import Project


class WorkItem(models.Model):
    """A single Work Item belonging to exactly one Project.

    All actionable project work (Epics, Milestones, Deliverables, Tasks)
    uses this single canonical model.
    """

    class Type(models.TextChoices):
        EPIC = "epic", "Epic"
        MILESTONE = "milestone", "Milestone"
        DELIVERABLE = "deliverable", "Deliverable"
        TASK = "task", "Task"

    class Status(models.TextChoices):
        TODO = "todo", "To Do"
        IN_PROGRESS = "in_progress", "In Progress"
        REVIEW = "review", "Review"
        DONE = "done", "Done"

    project = models.ForeignKey(
        Project,
        on_delete=models.CASCADE,
        related_name="work_items",
    )
    type = models.CharField(max_length=16, choices=Type.choices)
    title = models.CharField(max_length=255)
    description = models.TextField(default="", blank=True)
    status = models.CharField(
        max_length=16,
        choices=Status.choices,
        default=Status.TODO,
    )
    parent = models.ForeignKey(
        "self",
        on_delete=models.CASCADE,
        related_name="children",
        null=True,
        blank=True,
    )
    due_date = models.DateField(null=True, blank=True)
    blocked_reason = models.TextField(default="", blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.RESTRICT,
        related_name="created_work_items",
    )

    class Meta:
        db_table = "work_items_work_item"
        verbose_name = "work item"
        verbose_name_plural = "work items"

    def __str__(self):
        return f"[{self.type}] {self.title} ({self.project.name})"


class WorkItemAssignee(models.Model):
    """Relational join between WorkItem and User for assignees.

    Constraint: UNIQUE(work_item_id, user_id).
    Domain rule (enforced in application logic): the assigned user must
    have ProjectMembership in the WorkItem's Project with role 'owner'
    or 'member'. A viewer cannot be assigned.
    """

    work_item = models.ForeignKey(
        WorkItem,
        on_delete=models.CASCADE,
        related_name="assignee_relations",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.RESTRICT,
        related_name="work_item_assignments",
    )

    class Meta:
        db_table = "work_items_assignee"
        verbose_name = "work item assignee"
        verbose_name_plural = "work item assignees"
        constraints = [
            models.UniqueConstraint(
                fields=["work_item", "user"],
                name="%(app_label)s_%(class)s_unique_work_item_user",
            )
        ]

    def __str__(self):
        return f"{self.user.username} → [{self.work_item.type}] {self.work_item.title}"
