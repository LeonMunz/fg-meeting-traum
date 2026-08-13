from django.conf import settings
from django.db import models


class ResearchGroup(models.Model):
    """A Research Group is the shared organizational context."""

    name = models.CharField(max_length=255)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.RESTRICT,
        related_name="created_research_groups",
    )

    class Meta:
        db_table = "research_groups_research_group"
        verbose_name = "research group"
        verbose_name_plural = "research groups"

    def __str__(self):
        return self.name


class ResearchGroupMembership(models.Model):
    """Links a User to a ResearchGroup with a specific role."""

    class Role(models.TextChoices):
        ADMIN = "admin", "Admin"
        MEMBER = "member", "Member"

    research_group = models.ForeignKey(
        ResearchGroup,
        on_delete=models.CASCADE,
        related_name="memberships",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="research_group_memberships",
    )
    role = models.CharField(max_length=16, choices=Role.choices)
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "research_groups_membership"
        unique_together = ("research_group", "user")
        constraints = [
            models.UniqueConstraint(
                fields=["research_group", "user"],
                name="%(app_label)s_%(class)s_unique_group_user",
            )
        ]

    def __str__(self):
        return f"{self.user.username} → {self.research_group.name} ({self.role})"
