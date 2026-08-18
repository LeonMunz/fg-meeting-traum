from typing import Optional

from .models import AuditEvent


class AuditHistoryError(Exception):
    """Raised when an AuditEvent would be internally inconsistent."""

    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


def record_audit_event(
    *,
    research_group,
    actor,
    event_type: str,
    subject_user=None,
    project=None,
    work_item=None,
    data: Optional[dict] = None,
) -> AuditEvent:
    """Append one immutable historical event.

    Permission checks belong to the calling domain operation.

    The event must remain scoped to exactly one Research Group. Optional
    Project and WorkItem references therefore have to belong to that scope.
    """

    normalized_event_type = (
        event_type or ""
    ).strip()

    if not normalized_event_type:
        raise AuditHistoryError(
            "Audit event type is required."
        )

    if len(normalized_event_type) > 80:
        raise AuditHistoryError(
            "Audit event type is too long."
        )

    if data is None:
        data = {}

    if not isinstance(data, dict):
        raise AuditHistoryError(
            "Audit event data must be an object."
        )

    if (
        project is not None
        and project.research_group_id
        != research_group.pk
    ):
        raise AuditHistoryError(
            "Audit event Project must belong to "
            "the same Research Group."
        )

    if work_item is not None:
        work_item_project = (
            work_item.project
        )

        if (
            work_item_project.research_group_id
            != research_group.pk
        ):
            raise AuditHistoryError(
                "Audit event WorkItem must belong to "
                "the same Research Group."
            )

        if (
            project is not None
            and work_item.project_id
            != project.pk
        ):
            raise AuditHistoryError(
                "Audit event WorkItem must belong to "
                "the referenced Project."
            )

    return AuditEvent.objects.create(
        research_group=research_group,
        actor=actor,
        event_type=normalized_event_type,
        subject_user=subject_user,
        project=project,
        work_item=work_item,
        data=data,
    )
