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
        on_delete=models.SET_NULL,
        related_name="children",
        null=True,
        blank=True,
    )
    # Manual Board position within the Project/status-definition column.
    #
    # NULL = unsorted (server appends to the end of its column, ordered by
    # (board_position, created_at, id)). Reordering within a column is an
    # O(number of moved items) relative move — see
    # `work_items.services.reposition_work_item` — not a global renumber.
    board_position = models.IntegerField(null=True, blank=True)
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


class MyWorkPreferences(models.Model):
    """Persisted personal My Work view state for one user.

    My Work preferences are personal view state over the canonical
    Work Items (``docs/domain/foundation.md`` §14/§14a): the Board
    vs List presentation plus the user's selected Research Group,
    Project, and semantic Work Item type kind filters.

    Invariants:

    - One row per user (OneToOne). The row is created on first
      explicit save; a read with no row answers the default
      snapshot.
    - Preferences are NEVER authorization. They grant no
      membership, never grant access to any Research Group,
      Project, or Work Item, and never mutate Work Items,
      assignments, statuses, Memberships, or Project/Research
      Group data. Every read and write is re-sanitized against
      the user's CURRENT access by
      ``work_items.my_work_preferences``; stale inaccessible
      selections are dropped and the cleaned state is persisted.
    - Research Group and Project selections are relational (M2M to
      the canonical ``ResearchGroup`` / ``Project`` rows), never
      opaque ID lists.
    - ``work_item_types`` holds ONLY canonical semantic type kind
      values (``WorkItemTypeDefinition.Kind``: ``task`` / ``epic``
      / ``milestone`` / ``deliverable``). Display names, arbitrary
      project-local type names, and definition IDs are never
      persisted and never interpreted.
    - An empty selection means "no restriction" within the user's
      current access.
    """

    class ViewMode(models.TextChoices):
        BOARD = "board", "Board"
        LIST = "list", "List"

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="my_work_preferences",
    )
    view_mode = models.CharField(
        max_length=8,
        choices=ViewMode.choices,
        default=ViewMode.BOARD,
    )
    # Selected My Work filter targets. A row here is a presentation
    # filter over canonical rows — it confers no access on its own.
    # An empty selection means no restriction.
    research_groups = models.ManyToManyField(
        "research_groups.ResearchGroup",
        blank=True,
        related_name="my_work_preferences",
        db_table="work_items_myworkpreferences_research_groups",
    )
    projects = models.ManyToManyField(
        Project,
        blank=True,
        related_name="my_work_preferences",
        db_table="work_items_myworkpreferences_projects",
    )
    # Canonical semantic Work Item type kinds only
    # (WorkItemTypeDefinition.Kind values). Empty list = no
    # restriction. Never display names, never definition IDs.
    work_item_types = models.JSONField(default=list)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "work_items_my_work_preferences"
        verbose_name = "my work preferences"
        verbose_name_plural = "my work preferences"

    def __str__(self):
        return (
            f"MyWorkPreferences(user={self.user_id}, "
            f"view={self.view_mode})"
        )
