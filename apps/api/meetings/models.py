from django.conf import settings
from django.db import models

from projects.models import Project
from research_groups.models import ResearchGroup
from work_items.models import WorkItem


class MeetingSeries(models.Model):
    """A recurring meeting format (e.g. 'FG Weekly').

    Not a historical occurrence — defines identity, scope, and the
    default Meeting structure (sections) for future occurrences.
    """

    class Scope(models.TextChoices):
        GROUP = "group", "Research group"
        PROJECT = "project", "Project"

    research_group = models.ForeignKey(
        ResearchGroup,
        on_delete=models.RESTRICT,
        related_name="meeting_series",
    )
    scope = models.CharField(
        max_length=16,
        choices=Scope.choices,
        default=Scope.GROUP,
    )
    project = models.ForeignKey(
        Project,
        on_delete=models.RESTRICT,
        related_name="meeting_series",
        null=True,
        blank=True,
    )
    title = models.CharField(max_length=255)
    description = models.TextField(default="", blank=True)
    is_archived = models.BooleanField(default=False)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.RESTRICT,
        related_name="created_meeting_series",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "meetings_series"
        ordering = ["title", "id"]
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(scope="group", project__isnull=True)
                    | models.Q(scope="project", project__isnull=False)
                ),
                name="meetings_series_scope_project_consistent",
            )
        ]

    def __str__(self):
        return self.title


class MeetingSeriesSection(models.Model):
    """One editable section in a MeetingSeries template.

    Supports name, optional description, deterministic position,
    and active/inactive state. When a Meeting occurrence is created
    from a Series, only active sections are snapshotted.
    """

    meeting_series = models.ForeignKey(
        MeetingSeries,
        on_delete=models.CASCADE,
        related_name="series_sections",
    )
    name = models.CharField(max_length=255)
    description = models.TextField(default="", blank=True)
    position = models.PositiveIntegerField()
    is_active = models.BooleanField(default=True)

    class Meta:
        db_table = "meetings_series_section"
        ordering = ["position", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["meeting_series", "position"],
                name="meetings_series_section_unique_series_position",
            )
        ]

    def __str__(self):
        return f"{self.meeting_series.title}: {self.name}"


class Meeting(models.Model):
    """One concrete meeting occurrence inside a Research Group."""

    class Status(models.TextChoices):
        UPCOMING = "upcoming", "Upcoming"
        LIVE = "live", "Live"
        COMPLETED = "completed", "Completed"

    class Scope(models.TextChoices):
        GROUP = "group", "Research group"
        PROJECT = "project", "Project"

    research_group = models.ForeignKey(
        ResearchGroup,
        on_delete=models.RESTRICT,
        related_name="meetings",
    )
    scope = models.CharField(
        max_length=16,
        choices=Scope.choices,
        default=Scope.GROUP,
    )
    project = models.ForeignKey(
        Project,
        on_delete=models.RESTRICT,
        related_name="meetings",
        null=True,
        blank=True,
    )
    series = models.ForeignKey(
        MeetingSeries,
        on_delete=models.SET_NULL,
        related_name="occurrences",
        null=True,
        blank=True,
    )
    title = models.CharField(max_length=255)
    scheduled_at = models.DateTimeField()
    status = models.CharField(
        max_length=16,
        choices=Status.choices,
        default=Status.UPCOMING,
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.RESTRICT,
        related_name="created_meetings",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "meetings_meeting"
        ordering = ["scheduled_at", "id"]
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(scope="group", project__isnull=True)
                    | models.Q(scope="project", project__isnull=False)
                ),
                name="meetings_meeting_scope_project_consistent",
            )
        ]

    def __str__(self):
        return self.title


class MeetingSection(models.Model):
    """A historical snapshot of a Series section in one Meeting.

    Created when a Meeting occurrence is generated from a Series.
    Later changes to the Series template never mutate this record.
    """

    meeting = models.ForeignKey(
        Meeting,
        on_delete=models.CASCADE,
        related_name="meeting_sections",
    )
    source_series_section = models.ForeignKey(
        MeetingSeriesSection,
        on_delete=models.SET_NULL,
        related_name="snapshots",
        null=True,
        blank=True,
    )
    name = models.CharField(max_length=255)
    description = models.TextField(default="", blank=True)
    position = models.PositiveIntegerField()
    is_visible = models.BooleanField(default=True)

    class Meta:
        db_table = "meetings_section"
        ordering = ["position", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["meeting", "position"],
                name="meetings_section_unique_meeting_position",
            )
        ]

    def __str__(self):
        return f"{self.meeting.title}: {self.name}"


class MeetingParticipant(models.Model):
    """A Research Group member participating in a Meeting."""

    meeting = models.ForeignKey(
        Meeting,
        on_delete=models.CASCADE,
        related_name="participant_relations",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.RESTRICT,
        related_name="meeting_participations",
    )
    added_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "meetings_participant"
        constraints = [
            models.UniqueConstraint(
                fields=["meeting", "user"],
                name="meetings_participant_unique_meeting_user",
            )
        ]

    def __str__(self):
        return f"{self.user.username} → {self.meeting.title}"


class MeetingItem(models.Model):
    """One ordered discussion / agenda item inside a Meeting."""

    class Status(models.TextChoices):
        OPEN = "open", "Open"
        DISCUSSED = "discussed", "Discussed"

    meeting = models.ForeignKey(
        Meeting,
        on_delete=models.CASCADE,
        related_name="items",
    )
    title = models.CharField(max_length=255)
    notes = models.TextField(default="", blank=True)
    position = models.PositiveIntegerField()
    status = models.CharField(
        max_length=16,
        choices=Status.choices,
        default=Status.OPEN,
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.RESTRICT,
        related_name="created_meeting_items",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "meetings_item"
        ordering = ["position", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["meeting", "position"],
                name="meetings_item_unique_meeting_position",
            )
        ]

    def __str__(self):
        return self.title


class MeetingItemWorkItem(models.Model):
    """Historical link from a Meeting item to a canonical WorkItem."""

    meeting_item = models.ForeignKey(
        MeetingItem,
        on_delete=models.CASCADE,
        related_name="work_item_relations",
    )
    work_item = models.ForeignKey(
        WorkItem,
        on_delete=models.CASCADE,
        related_name="meeting_item_relations",
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.RESTRICT,
        related_name="created_meeting_work_item_links",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "meetings_item_work_item"
        constraints = [
            models.UniqueConstraint(
                fields=["meeting_item", "work_item"],
                name="meetings_item_work_item_unique_pair",
            )
        ]

    def __str__(self):
        return f"{self.meeting_item.title} → {self.work_item.title}"
