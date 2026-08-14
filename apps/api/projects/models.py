from django.conf import settings
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
