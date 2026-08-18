from django.conf import settings
from django.db import models


class AuditEvent(models.Model):
    """Immutable historical record of a meaningful domain action.

    AuditEvent represents history, not current state.

    User references use RESTRICT because historical identities must remain
    addressable even after an account is disabled or anonymized.

    Project and WorkItem references use SET_NULL so historical events survive
    an explicitly allowed hard deletion of a disposable entity.
    """

    research_group = models.ForeignKey(
        "research_groups.ResearchGroup",
        on_delete=models.RESTRICT,
        related_name="audit_events",
    )

    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.RESTRICT,
        related_name="audit_events_as_actor",
    )

    event_type = models.CharField(
        max_length=80,
    )

    subject_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.RESTRICT,
        related_name="audit_events_as_subject",
        null=True,
        blank=True,
    )

    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.SET_NULL,
        related_name="audit_events",
        null=True,
        blank=True,
    )

    work_item = models.ForeignKey(
        "work_items.WorkItem",
        on_delete=models.SET_NULL,
        related_name="audit_events",
        null=True,
        blank=True,
    )

    data = models.JSONField(
        default=dict,
        blank=True,
    )

    created_at = models.DateTimeField(
        auto_now_add=True,
    )

    class Meta:
        db_table = "audit_history_event"
        ordering = [
            "-created_at",
            "-id",
        ]
        indexes = [
            models.Index(
                fields=[
                    "research_group",
                    "-created_at",
                ],
                name="audit_rg_created_idx",
            ),
            models.Index(
                fields=["event_type"],
                name="audit_event_type_idx",
            ),
        ]

    def __str__(self):
        return (
            f"{self.event_type} "
            f"(research_group={self.research_group_id})"
        )
