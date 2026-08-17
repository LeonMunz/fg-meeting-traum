from django.db import transaction
from django.db.models import Max

from research_groups.models import ResearchGroupMembership

from work_items.services import (
    WorkItemDomainError,
    create_work_item,
)

from .models import (
    Meeting,
    MeetingItem,
    MeetingItemWorkItem,
    MeetingParticipant,
)


class MeetingDomainError(Exception):
    def __init__(self, message):
        self.message = message
        super().__init__(message)


def _require_research_group_membership(*, research_group, user):
    if not ResearchGroupMembership.objects.filter(
        research_group=research_group,
        user=user,
    ).exists():
        raise MeetingDomainError(
            "User is not a member of this Research Group."
        )


@transaction.atomic
def create_meeting(
    *,
    research_group,
    actor,
    title,
    scheduled_at,
    status=None,
):
    _require_research_group_membership(
        research_group=research_group,
        user=actor,
    )

    title = title.strip()
    if not title:
        raise MeetingDomainError("Meeting title is required.")

    meeting_status = status or Meeting.Status.UPCOMING
    if meeting_status not in Meeting.Status.values:
        raise MeetingDomainError("Invalid Meeting status.")

    meeting = Meeting.objects.create(
        research_group=research_group,
        title=title,
        scheduled_at=scheduled_at,
        status=meeting_status,
        created_by=actor,
    )

    MeetingParticipant.objects.create(
        meeting=meeting,
        user=actor,
    )

    return meeting


def add_meeting_participant(
    *,
    meeting,
    actor,
    target_user,
):
    _require_research_group_membership(
        research_group=meeting.research_group,
        user=actor,
    )

    _require_research_group_membership(
        research_group=meeting.research_group,
        user=target_user,
    )

    if MeetingParticipant.objects.filter(
        meeting=meeting,
        user=target_user,
    ).exists():
        raise MeetingDomainError(
            "User is already a Meeting participant."
        )

    return MeetingParticipant.objects.create(
        meeting=meeting,
        user=target_user,
    )


@transaction.atomic
def create_meeting_item(
    *,
    meeting,
    actor,
    title,
    notes="",
):
    _require_research_group_membership(
        research_group=meeting.research_group,
        user=actor,
    )

    title = title.strip()
    if not title:
        raise MeetingDomainError(
            "Meeting item title is required."
        )

    # Serialize position allocation for this Meeting.
    Meeting.objects.select_for_update().get(pk=meeting.pk)

    max_position = (
        MeetingItem.objects
        .filter(meeting=meeting)
        .aggregate(value=Max("position"))["value"]
    )

    position = (
        max_position + 1
        if max_position is not None
        else 0
    )

    return MeetingItem.objects.create(
        meeting=meeting,
        title=title,
        notes=notes.strip(),
        position=position,
        created_by=actor,
    )


def update_meeting(
    *,
    meeting,
    actor,
    title=None,
    scheduled_at=None,
    status=None,
):
    _require_research_group_membership(
        research_group=meeting.research_group,
        user=actor,
    )

    update_fields = []

    if title is not None:
        title = title.strip()
        if not title:
            raise MeetingDomainError(
                "Meeting title is required."
            )
        meeting.title = title
        update_fields.append("title")

    if scheduled_at is not None:
        meeting.scheduled_at = scheduled_at
        update_fields.append("scheduled_at")

    if status is not None:
        if status not in Meeting.Status.values:
            raise MeetingDomainError(
                "Invalid Meeting status."
            )
        meeting.status = status
        update_fields.append("status")

    if update_fields:
        update_fields.append("updated_at")
        meeting.save(
            update_fields=update_fields,
        )

    return meeting


def remove_meeting_participant(
    *,
    participant,
    actor,
):
    _require_research_group_membership(
        research_group=participant.meeting.research_group,
        user=actor,
    )

    participant.delete()


def update_meeting_item(
    *,
    meeting_item,
    actor,
    title=None,
    notes=None,
    status=None,
):
    _require_research_group_membership(
        research_group=meeting_item.meeting.research_group,
        user=actor,
    )

    update_fields = []

    if title is not None:
        title = title.strip()
        if not title:
            raise MeetingDomainError(
                "Meeting item title is required."
            )
        meeting_item.title = title
        update_fields.append("title")

    if notes is not None:
        meeting_item.notes = notes.strip()
        update_fields.append("notes")

    if status is not None:
        if status not in MeetingItem.Status.values:
            raise MeetingDomainError(
                "Invalid Meeting item status."
            )
        meeting_item.status = status
        update_fields.append("status")

    if update_fields:
        update_fields.append("updated_at")
        meeting_item.save(
            update_fields=update_fields,
        )

    return meeting_item



@transaction.atomic
def create_work_item_from_meeting_item(
    *,
    meeting_item,
    project,
    actor,
    type,
    title,
    description="",
    status=None,
    assignee_ids=None,
    parent_id=None,
    due_date=None,
    blocked_reason=None,
):
    """Create a canonical WorkItem from a MeetingItem.

    The WorkItem service remains authoritative for Project write access,
    assignee eligibility, hierarchy and WorkItem invariants.

    A Meeting may only create work inside a Project belonging to the same
    Research Group.
    """
    _require_research_group_membership(
        research_group=meeting_item.meeting.research_group,
        user=actor,
    )

    if (
        project.research_group_id
        != meeting_item.meeting.research_group_id
    ):
        raise MeetingDomainError(
            "Project must belong to the Meeting's Research Group."
        )

    try:
        work_item = create_work_item(
            project=project,
            actor=actor,
            type=type,
            title=title,
            description=description,
            status=status,
            assignee_ids=assignee_ids,
            parent_id=parent_id,
            due_date=due_date,
            blocked_reason=blocked_reason,
        )
    except WorkItemDomainError as exc:
        raise MeetingDomainError(
            exc.message
        ) from exc

    MeetingItemWorkItem.objects.create(
        meeting_item=meeting_item,
        work_item=work_item,
        created_by=actor,
    )

    return work_item
