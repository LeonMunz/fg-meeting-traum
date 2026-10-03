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


class WorkspaceNavigationPreferences(models.Model):
    """Persisted personal workspace navigation preferences for one user.

    Workspace navigation preferences are personal view state over the
    canonical Research Groups (``docs/domain/foundation.md`` §2): the
    user's preferred sidebar Research Group ordering plus which
    Research Groups — and whose Projects child node — the user
    manually left expanded.

    Invariants:

    - One row per user (OneToOne). The row is created on first
      explicit save; a read with no row answers the default snapshot
      (all currently accessible Research Groups in deterministic
      default order, nothing expanded) and never creates a row.
    - Preferences are NEVER authorization. They grant no membership
      and never grant access to any Research Group. Every read and
      write is re-sanitized against the user's CURRENT
      ResearchGroupMembership by
      ``research_groups.workspace_navigation_preferences``; stale
      inaccessible group IDs are dropped and the cleaned state is
      persisted.
    - ``research_group_order`` holds an ORDERED list of Research
      Group IDs: the user's stored order for still-accessible
      Research Groups, then currently accessible Research Groups
      missing from the stored order in the deterministic default
      order (``created_at`` ASC, primary key ASC). Each accessible
      Research Group appears exactly once.
    - ``expanded_research_groups`` / ``expanded_project_sections``
      hold sets of Research Group IDs (stored as JSON arrays,
      duplicates never persist). ``expanded_project_sections`` is
      keyed by RESEARCH GROUP (whose Projects child node is
      expanded) — concrete Project IDs are never persisted here.
    - Route-driven / contextual expansion is NOT represented by this
      state: it records only the user's manual expansion choice.
    """

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="workspace_navigation_preferences",
    )
    # Ordered Research Group IDs (personal sidebar order).
    research_group_order = models.JSONField(default=list)
    # Research Groups the user manually left expanded.
    expanded_research_groups = models.JSONField(default=list)
    # Research Groups whose Projects child node the user manually
    # left expanded (Research Group IDs, never Project IDs).
    expanded_project_sections = models.JSONField(default=list)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "research_groups_workspace_navigation_preferences"
        verbose_name = "workspace navigation preferences"
        verbose_name_plural = "workspace navigation preferences"

    def __str__(self):
        return f"WorkspaceNavigationPreferences(user={self.user_id})"
