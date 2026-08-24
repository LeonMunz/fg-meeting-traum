from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models


class Project(models.Model):
    """A Project is a protected workspace inside exactly one Research Group."""

    class Status(models.TextChoices):
        ACTIVE = "active", "Active"
        PAUSED = "paused", "Paused"
        COMPLETED = "completed", "Completed"

    name = models.CharField(max_length=255)
    description = models.TextField(default="")
    status = models.CharField(
        max_length=16,
        choices=Status.choices,
        default=Status.ACTIVE,
    )
    archived_at = models.DateTimeField(
        null=True,
        blank=True,
        db_index=True,
    )
    research_group = models.ForeignKey(
        "research_groups.ResearchGroup",
        on_delete=models.RESTRICT,
        related_name="projects",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.RESTRICT,
        related_name="created_projects",
    )

    class Meta:
        db_table = "projects_project"
        verbose_name = "project"
        verbose_name_plural = "projects"

    def __str__(self):
        return f"{self.name} ({self.research_group.name})"


class ProjectMembership(models.Model):
    """Links a User to a Project with a specific role.

    Domain rule: the user must have a ResearchGroupMembership in the
    Project's Research Group. This is enforced in application logic,
    not at the database level (cross-table constraint not supported by PostgreSQL).
    """

    class Role(models.TextChoices):
        OWNER = "owner", "Owner"
        MEMBER = "member", "Member"
        VIEWER = "viewer", "Viewer"

    project = models.ForeignKey(
        Project,
        on_delete=models.CASCADE,
        related_name="memberships",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.RESTRICT,
        related_name="project_memberships",
    )
    role = models.CharField(max_length=16, choices=Role.choices)
    added_at = models.DateTimeField(auto_now_add=True)
    added_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.RESTRICT,
        related_name="project_memberships_added",
    )

    class Meta:
        db_table = "projects_membership"
        verbose_name = "project membership"
        verbose_name_plural = "project memberships"
        constraints = [
            models.UniqueConstraint(
                fields=["project", "user"],
                name="%(app_label)s_%(class)s_unique_project_user",
            )
        ]

    def __str__(self):
        return f"{self.user.username} → {self.project.name} ({self.role})"


# ── Work Item Configuration ──


class WorkItemTypeDefinition(models.Model):
    """A TypeDefinition identifies a kind of work item for a Project.

    Each Project owns its own Types. Name uniqueness is case-insensitive
    within a Project. Inactive definitions still reserve their names.
    """

    project = models.ForeignKey(
        Project,
        on_delete=models.CASCADE,
        related_name="type_definitions",
    )
    name = models.CharField(max_length=255)
    order = models.IntegerField(default=0)
    active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "projects_workitem_type_definition"
        verbose_name = "work item type definition"
        verbose_name_plural = "work item type definitions"
        ordering = ["order", "id"]
        # Case-insensitive name uniqueness enforced at DB level via
        # a functional unique index created in the migration.

    def clean(self):
        if not self.name or not self.name.strip():
            raise ValidationError("Name must not be blank.")

    def __str__(self):
        return f"{self.name} ({self.project.name})"


class WorkItemStatusDefinition(models.Model):
    """A StatusDefinition identifies a workflow status for a Project.

    Each Project owns its own Statuses. Each Status carries a fixed
    semantic category (todo, in_progress, review, done).

    Exactly one active default status per Project, which must be todo.
    """

    class Category(models.TextChoices):
        TODO = "todo", "To Do"
        IN_PROGRESS = "in_progress", "In Progress"
        REVIEW = "review", "Review"
        DONE = "done", "Done"

    project = models.ForeignKey(
        Project,
        on_delete=models.CASCADE,
        related_name="status_definitions",
    )
    name = models.CharField(max_length=255)
    category = models.CharField(
        max_length=16,
        choices=Category.choices,
        default=Category.TODO,
    )
    order = models.IntegerField(default=0)
    active = models.BooleanField(default=True)
    is_default = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "projects_workitem_status_definition"
        verbose_name = "work item status definition"
        verbose_name_plural = "work item status definitions"
        ordering = ["order", "id"]

    def clean(self):
        if not self.name or not self.name.strip():
            raise ValidationError("Name must not be blank.")

    def __str__(self):
        return f"{self.name} ({self.project.name}, {self.category})"


class WorkItemLabelDefinition(models.Model):
    """A LabelDefinition identifies a lightweight category for WorkItems.

    Each Project owns its own Labels. A WorkItem may have zero or
    multiple labels via the WorkItemLabel join model.
    """

    project = models.ForeignKey(
        Project,
        on_delete=models.CASCADE,
        related_name="label_definitions",
    )
    name = models.CharField(max_length=255)
    order = models.IntegerField(default=0)
    active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "projects_workitem_label_definition"
        verbose_name = "work item label definition"
        verbose_name_plural = "work item label definitions"
        ordering = ["order", "id"]

    def clean(self):
        if not self.name or not self.name.strip():
            raise ValidationError("Name must not be blank.")

    def __str__(self):
        return f"{self.name} ({self.project.name})"
