from django.db import models, transaction
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
    MeetingSection,
    MeetingSeries,
    MeetingSeriesSection,
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


# ── MeetingSeries ────────────────────────────────────────────────


@transaction.atomic
def create_meeting_series(
    *,
    research_group,
    actor,
    title,
    description="",
):
    _require_research_group_membership(
        research_group=research_group,
        user=actor,
    )

    title = title.strip()
    if not title:
        raise MeetingDomainError("Series title is required.")

    return MeetingSeries.objects.create(
        research_group=research_group,
        title=title,
        description=description.strip(),
        created_by=actor,
    )


def update_meeting_series(
    *,
    meeting_series,
    actor,
    title=None,
    description=None,
    is_archived=None,
):
    _require_research_group_membership(
        research_group=meeting_series.research_group,
        user=actor,
    )

    update_fields = []

    if title is not None:
        title = title.strip()
        if not title:
            raise MeetingDomainError("Series title is required.")
        meeting_series.title = title
        update_fields.append("title")

    if description is not None:
        meeting_series.description = description.strip()
        update_fields.append("description")

    if is_archived is not None:
        meeting_series.is_archived = is_archived
        update_fields.append("is_archived")

    if update_fields:
        update_fields.append("updated_at")
        meeting_series.save(update_fields=update_fields)

    return meeting_series


# ── MeetingSeriesSection ─────────────────────────────────────────


@transaction.atomic
def create_series_section(
    *,
    meeting_series,
    actor,
    name,
    description="",
):
    _require_research_group_membership(
        research_group=meeting_series.research_group,
        user=actor,
    )

    name = name.strip()
    if not name:
        raise MeetingDomainError("Section name is required.")

    # Serialize position allocation for this Series.
    MeetingSeries.objects.select_for_update().get(pk=meeting_series.pk)

    max_position = (
        MeetingSeriesSection.objects
        .filter(meeting_series=meeting_series)
        .aggregate(value=Max("position"))["value"]
    )

    position = (
        max_position + 1
        if max_position is not None
        else 0
    )

    return MeetingSeriesSection.objects.create(
        meeting_series=meeting_series,
        name=name,
        description=description.strip(),
        position=position,
    )


def update_series_section(
    *,
    series_section,
    actor,
    name=None,
    description=None,
    is_active=None,
):
    _require_research_group_membership(
        research_group=series_section.meeting_series.research_group,
        user=actor,
    )

    update_fields = []

    if name is not None:
        name = name.strip()
        if not name:
            raise MeetingDomainError("Section name is required.")
        series_section.name = name
        update_fields.append("name")

    if description is not None:
        series_section.description = description.strip()
        update_fields.append("description")

    if is_active is not None:
        series_section.is_active = is_active
        update_fields.append("is_active")

    if update_fields:
        series_section.save(update_fields=update_fields)

    return series_section


@transaction.atomic
def reorder_series_sections(
    *,
    meeting_series,
    actor,
    section_ids,
):
    """Reorder sections by setting positions based on the provided ID list.

    section_ids is an ordered list of MeetingSeriesSection IDs.
    Only sections belonging to the given series are reordered.
    """
    _require_research_group_membership(
        research_group=meeting_series.research_group,
        user=actor,
    )

    if not section_ids:
        raise MeetingDomainError("Section order list is required.")

    # Validate all IDs belong to this series.
    sections = (
        MeetingSeriesSection.objects
        .filter(meeting_series=meeting_series, pk__in=section_ids)
    )

    if len(sections) != len(section_ids):
        raise MeetingDomainError(
            "One or more sections do not belong to this series."
        )

    # Require that all sections of the series are included in the
    # reorder list. A partial list would leave unlisted sections at
    # their old positions, causing unique constraint violations.
    total_sections = MeetingSeriesSection.objects.filter(
        meeting_series=meeting_series,
    ).count()
    if len(section_ids) != total_sections:
        raise MeetingDomainError(
            "Reorder must include all sections of the series."
        )

    # Two-phase update to avoid unique constraint violations:
    # Phase 1: shift all positions to a high range (above any valid index).
    # Phase 2: set final positions.
    offset = len(section_ids)
    MeetingSeriesSection.objects.filter(
        meeting_series=meeting_series,
        pk__in=section_ids,
    ).update(position=models.F("position") + offset)

    for new_position, section_id in enumerate(section_ids):
        MeetingSeriesSection.objects.filter(
            pk=section_id,
            meeting_series=meeting_series,
        ).update(position=new_position)


# ── Meeting occurrence from Series (snapshot) ────────────────────


@transaction.atomic
def create_meeting_from_series(
    *,
    meeting_series,
    actor,
    title=None,
    scheduled_at=None,
    status=None,
):
    """Create a Meeting occurrence from a Series.

    Snapshots only active Series sections into MeetingSection records.
    Later Series changes never mutate existing MeetingSection snapshots.
    """
    _require_research_group_membership(
        research_group=meeting_series.research_group,
        user=actor,
    )

    if scheduled_at is None:
        raise MeetingDomainError("scheduled_at is required.")

    meeting_title = (title or meeting_series.title).strip()
    if not meeting_title:
        raise MeetingDomainError("Meeting title is required.")

    meeting_status = status or Meeting.Status.UPCOMING
    if meeting_status not in Meeting.Status.values:
        raise MeetingDomainError("Invalid Meeting status.")

    meeting = Meeting.objects.create(
        research_group=meeting_series.research_group,
        series=meeting_series,
        title=meeting_title,
        scheduled_at=scheduled_at,
        status=meeting_status,
        created_by=actor,
    )

    # Creator becomes a participant.
    MeetingParticipant.objects.create(
        meeting=meeting,
        user=actor,
    )

    # Snapshot active series sections.
    active_sections = (
        MeetingSeriesSection.objects
        .filter(meeting_series=meeting_series, is_active=True)
        .order_by("position", "id")
    )

    for idx, series_section in enumerate(active_sections):
        MeetingSection.objects.create(
            meeting=meeting,
            source_series_section=series_section,
            name=series_section.name,
            description=series_section.description,
            position=idx,
            is_visible=True,
        )

    return meeting


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
    type_definition_id,
    title,
    description="",
    status_definition_id=None,
    assignee_ids=None,
    parent_id=None,
    due_date=None,
    blocked_reason=None,
    label_definition_ids=None,
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
            type_definition_id=type_definition_id,
            title=title,
            description=description,
            status_definition_id=status_definition_id,
            assignee_ids=assignee_ids,
            parent_id=parent_id,
            due_date=due_date,
            blocked_reason=blocked_reason,
            label_definition_ids=label_definition_ids,
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
