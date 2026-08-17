from django.conf import settings
from django.db import models

from research_groups.models import ResearchGroup
from work_items.models import WorkItem


class Meeting(models.Model):
    """One concrete meeting occurrence inside a Research Group."""

    class Status(models.TextChoices):
        UPCOMING = "upcoming", "Upcoming"
        LIVE = "live", "Live"
        COMPLETED = "completed", "Completed"

    research_group = models.ForeignKey(
        ResearchGroup,
        on_delete=models.RESTRICT,
        related_name="meetings",
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

    def __str__(self):
        return self.title


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
