from django.conf import settings
from django.db import models

from projects.models import (
    Project,
    WorkItemLabelDefinition,
    WorkItemStatusDefinition,
    WorkItemTypeDefinition,
)


class WorkItem(models.Model):
    """A single Work Item belonging to exactly one Project.

    All actionable project work (Epics, Milestones, Deliverables, Tasks)
    uses this single canonical model. The type and status are determined
    by project-scoped definition ForeignKeys.
    """

    project = models.ForeignKey(
        Project,
        on_delete=models.CASCADE,
        related_name="work_items",
    )
    type_definition = models.ForeignKey(
        WorkItemTypeDefinition,
        on_delete=models.RESTRICT,
        related_name="work_items",
    )
    status_definition = models.ForeignKey(
        WorkItemStatusDefinition,
        on_delete=models.RESTRICT,
        related_name="work_items",
    )
    title = models.CharField(max_length=255)
    description = models.TextField(default="", blank=True)
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
        return f"[{self.type_definition.name}] {self.title} ({self.project.name})"


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
        return f"{self.user.username} → [{self.work_item.type_definition.name}] {self.work_item.title}"


class WorkItemComment(models.Model):
    """A human comment on a WorkItem.

    Distinct from AuditEvent: comments are human discussion, not
    system-recorded property history — they are never merged into the
    audit trail, only combined with it presentation-side.

    on_delete semantics mirror WorkItemAssignee: CASCADE from the
    WorkItem (a comment has no meaning once its WorkItem is gone),
    RESTRICT from the author so a comment's historical identity
    remains addressable even after an account is disabled.
    """

    work_item = models.ForeignKey(
        WorkItem,
        on_delete=models.CASCADE,
        related_name="comments",
    )
    author = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.RESTRICT,
        related_name="work_item_comments",
    )
    body = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "work_items_comment"
        verbose_name = "work item comment"
        verbose_name_plural = "work item comments"
        ordering = ["-created_at", "-id"]

    def __str__(self):
        return f"Comment by {self.author.username} on [{self.work_item.type_definition.name}] {self.work_item.title}"


class WorkItemLabel(models.Model):
    """Relational join between WorkItem and WorkItemLabelDefinition.

    Constraint: UNIQUE(work_item_id, label_id).
    Domain rule (enforced in application logic): label.project ==
    work_item.project.
    """

    work_item = models.ForeignKey(
        WorkItem,
        on_delete=models.CASCADE,
        related_name="label_relations",
    )
    label = models.ForeignKey(
        WorkItemLabelDefinition,
        on_delete=models.CASCADE,
        related_name="work_item_relations",
    )

    class Meta:
        db_table = "work_items_workitem_label"
        verbose_name = "work item label"
        verbose_name_plural = "work item labels"
        constraints = [
            models.UniqueConstraint(
                fields=["work_item", "label"],
                name="%(app_label)s_%(class)s_unique_work_item_label",
            )
        ]

    def __str__(self):
        return f"{self.label.name} → [{self.work_item.type_definition.name}] {self.work_item.title}"
