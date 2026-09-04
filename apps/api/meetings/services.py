from django.db import IntegrityError, models, transaction
from django.utils import timezone
from django.db.models import Max

from projects.models import ProjectMembership
from research_groups.models import ResearchGroupMembership

from work_items.services import (
    WorkItemDomainError,
    create_work_item,
)

from .models import (
    Meeting,
    MeetingItem,
    MeetingItemWorkItem,
    MeetingNote,
    MeetingParticipant,
    MeetingSection,
    MeetingSeries,
    MeetingSeriesSection,
)


class MeetingDomainError(Exception):
    def __init__(self, message):
        self.message = message
        super().__init__(message)


PROJECT_READ_ROLES = {
    ProjectMembership.Role.OWNER,
    ProjectMembership.Role.MEMBER,
    ProjectMembership.Role.VIEWER,
}
PROJECT_WRITE_ROLES = {
    ProjectMembership.Role.OWNER,
    ProjectMembership.Role.MEMBER,
}


def _require_research_group_membership(*, research_group, user):
    if not ResearchGroupMembership.objects.filter(
        research_group=research_group,
        user=user,
    ).exists():
        raise MeetingDomainError(
            "User is not a member of this Research Group."
        )


def _require_scoped_read_access(
    *,
    research_group,
    scope,
    project,
    user,
):
    _require_research_group_membership(
        research_group=research_group,
        user=user,
    )

    if scope == Meeting.Scope.GROUP:
        if project is not None:
            raise MeetingDomainError(
                "A group-scoped Meeting cannot reference a Project."
            )
        return

    if scope != Meeting.Scope.PROJECT:
        raise MeetingDomainError("Invalid Meeting scope.")

    if project is None:
        raise MeetingDomainError(
            "A project-scoped Meeting requires a Project."
        )

    if project.research_group_id != research_group.pk:
        raise MeetingDomainError(
            "Project must belong to the Meeting's Research Group."
        )

    membership = ProjectMembership.objects.filter(
        project=project,
        user=user,
    ).first()
    if membership is None or membership.role not in PROJECT_READ_ROLES:
        raise MeetingDomainError(
            "User does not have access to this Project."
        )


def _require_scoped_write_access(
    *,
    research_group,
    scope,
    project,
    user,
):
    _require_scoped_read_access(
        research_group=research_group,
        scope=scope,
        project=project,
        user=user,
    )

    if scope == Meeting.Scope.GROUP:
        return

    if project.archived_at is not None:
        raise MeetingDomainError(
            "Archived Projects are read-only. Restore the Project first."
        )

    membership = ProjectMembership.objects.get(
        project=project,
        user=user,
    )
    if membership.role not in PROJECT_WRITE_ROLES:
        raise MeetingDomainError(
            "A viewer cannot modify Project Meeting content."
        )


def _require_series_write_access(*, meeting_series, user):
    _require_scoped_write_access(
        research_group=meeting_series.research_group,
        scope=meeting_series.scope,
        project=meeting_series.project,
        user=user,
    )


def _require_meeting_write_access(*, meeting, user):
    _require_scoped_write_access(
        research_group=meeting.research_group,
        scope=meeting.scope,
        project=meeting.project,
        user=user,
    )


# ── MeetingSeries ────────────────────────────────────────────────


@transaction.atomic
def create_meeting_series(
    *,
    research_group,
    actor,
    title,
    description="",
    scope=MeetingSeries.Scope.GROUP,
    project=None,
):
    _require_scoped_write_access(
        research_group=research_group,
        scope=scope,
        project=project,
        user=actor,
    )

    title = title.strip()
    if not title:
        raise MeetingDomainError("Series title is required.")

    return MeetingSeries.objects.create(
        research_group=research_group,
        scope=scope,
        project=project,
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
    _require_series_write_access(meeting_series=meeting_series, user=actor)

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
    _require_series_write_access(meeting_series=meeting_series, user=actor)

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
    _require_series_write_access(
        meeting_series=series_section.meeting_series,
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
    _require_series_write_access(meeting_series=meeting_series, user=actor)

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
    _require_series_write_access(meeting_series=meeting_series, user=actor)

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
        scope=meeting_series.scope,
        project=meeting_series.project,
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
    scope=Meeting.Scope.GROUP,
    project=None,
):
    _require_scoped_write_access(
        research_group=research_group,
        scope=scope,
        project=project,
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
        scope=scope,
        project=project,
        title=title,
        scheduled_at=scheduled_at,
        status=meeting_status,
        created_by=actor,
    )

    MeetingParticipant.objects.create(
        meeting=meeting,
        user=actor,
    )

    # A standalone Meeting (no Series) still needs a usable structure.
    # Create a real, occurrence-level default Section.
    MeetingSection.objects.create(
        meeting=meeting,
        name="Agenda",
        description="",
        position=0,
        is_visible=True,
    )

    return meeting


def add_meeting_participant(
    *,
    meeting,
    actor,
    target_user,
):
    _require_meeting_write_access(meeting=meeting, user=actor)

    _require_scoped_read_access(
        research_group=meeting.research_group,
        scope=meeting.scope,
        project=meeting.project,
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
    meeting_section,
    actor,
    title,
    notes="",
):
    _require_meeting_write_access(meeting=meeting, user=actor)

    if meeting_section.meeting_id != meeting.pk:
        raise MeetingDomainError(
            "The Section does not belong to this Meeting."
        )

    title = title.strip()
    if not title:
        raise MeetingDomainError(
            "Meeting item title is required."
        )

    # Serialize position allocation for this Section.
    MeetingSection.objects.select_for_update().get(
        pk=meeting_section.pk,
    )

    max_position = (
        MeetingItem.objects
        .filter(meeting_section=meeting_section)
        .aggregate(value=Max("position"))["value"]
    )

    position = (
        max_position + 1
        if max_position is not None
        else 0
    )

    return MeetingItem.objects.create(
        meeting=meeting,
        meeting_section=meeting_section,
        title=title,
        notes=notes.strip(),
        position=position,
        created_by=actor,
    )


# ── Meeting occurrence Sections (one-off structure) ─────────────


@transaction.atomic
def create_meeting_section(
    *,
    meeting,
    actor,
    name,
    description="",
):
    """Add a one-off Section to a concrete Meeting occurrence.

    This never touches the Series template.
    """
    _require_meeting_write_access(meeting=meeting, user=actor)

    name = name.strip()
    if not name:
        raise MeetingDomainError("Section name is required.")

    # Serialize position allocation for this Meeting.
    Meeting.objects.select_for_update().get(pk=meeting.pk)

    max_position = (
        MeetingSection.objects
        .filter(meeting=meeting)
        .aggregate(value=Max("position"))["value"]
    )

    position = (
        max_position + 1
        if max_position is not None
        else 0
    )

    return MeetingSection.objects.create(
        meeting=meeting,
        name=name,
        description=description.strip(),
        position=position,
        is_visible=True,
    )


def update_meeting_section(
    *,
    section,
    actor,
    name=None,
    description=None,
    is_visible=None,
):
    """Rename / edit / hide-show a Section on one Meeting occurrence.

    Never mutates the Series template.
    """
    _require_meeting_write_access(
        meeting=section.meeting,
        user=actor,
    )

    update_fields = []

    if name is not None:
        name = name.strip()
        if not name:
            raise MeetingDomainError("Section name is required.")
        section.name = name
        update_fields.append("name")

    if description is not None:
        section.description = description.strip()
        update_fields.append("description")

    if is_visible is not None:
        section.is_visible = is_visible
        update_fields.append("is_visible")

    if update_fields:
        section.save(update_fields=update_fields)

    return section


@transaction.atomic
def reorder_meeting_sections(
    *,
    meeting,
    actor,
    section_ids,
):
    """Reorder a Meeting occurrence's Sections by the given ID order.

    All of the Meeting's Sections must be included; a partial list is
    rejected so no Section is left at a stale position.
    """
    _require_meeting_write_access(meeting=meeting, user=actor)

    if not section_ids:
        raise MeetingDomainError("Section order list is required.")

    sections = MeetingSection.objects.filter(
        meeting=meeting,
        pk__in=section_ids,
    )

    if len(sections) != len(section_ids):
        raise MeetingDomainError(
            "One or more sections do not belong to this meeting."
        )

    total_sections = MeetingSection.objects.filter(
        meeting=meeting,
    ).count()
    if len(section_ids) != total_sections:
        raise MeetingDomainError(
            "Reorder must include all sections of the meeting."
        )

    offset = len(section_ids)
    MeetingSection.objects.filter(
        meeting=meeting,
        pk__in=section_ids,
    ).update(position=models.F("position") + offset)

    for new_position, section_id in enumerate(section_ids):
        MeetingSection.objects.filter(
            pk=section_id,
            meeting=meeting,
        ).update(position=new_position)


def update_meeting(
    *,
    meeting,
    actor,
    title=None,
    scheduled_at=None,
):
    """Update editable Meeting metadata (title / scheduled time).

    Lifecycle transitions are intentionally not part of this service.
    Status moves from upcoming to live and from live to completed must
    go through the explicit start/end domain actions below, so clients
    cannot bypass the state machine with an arbitrary status PATCH.
    """
    _require_meeting_write_access(meeting=meeting, user=actor)

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

    if update_fields:
        update_fields.append("updated_at")
        meeting.save(
            update_fields=update_fields,
        )

    return meeting


@transaction.atomic
def start_meeting(*, meeting, actor):
    """Move an upcoming Meeting to live and record the actual start time.

    Only upcoming -> live is valid. Uses server time; an already live or
    completed Meeting cannot be started again.
    """
    _require_meeting_write_access(meeting=meeting, user=actor)

    # Serialize lifecycle transitions for this Meeting so two concurrent
    # start/end requests cannot both observe the old status and both commit.
    Meeting.objects.select_for_update().get(pk=meeting.pk)
    meeting.refresh_from_db()

    if meeting.status != Meeting.Status.UPCOMING:
        raise MeetingDomainError(
            "Only an upcoming Meeting can be started."
        )

    meeting.status = Meeting.Status.LIVE
    meeting.started_at = timezone.now()
    meeting.save(update_fields=["status", "started_at", "updated_at"])

    return meeting


@transaction.atomic
def end_meeting(*, meeting, actor):
    """Move a live Meeting to completed and record the actual end time.

    Only live -> completed is valid. Uses server time; an upcoming or
    already completed Meeting cannot be ended.
    """
    _require_meeting_write_access(meeting=meeting, user=actor)

    # Serialize lifecycle transitions for this Meeting so two concurrent
    # start/end requests cannot both observe the old status and both commit.
    Meeting.objects.select_for_update().get(pk=meeting.pk)
    meeting.refresh_from_db()

    if meeting.status != Meeting.Status.LIVE:
        raise MeetingDomainError(
            "Only a live Meeting can be ended."
        )

    meeting.status = Meeting.Status.COMPLETED
    meeting.ended_at = timezone.now()
    meeting.save(update_fields=["status", "ended_at", "updated_at"])

    return meeting


@transaction.atomic
def reopen_meeting(*, meeting, actor):
    """Reopen a completed Meeting: completed -> live.

    Only a completed Meeting may be reopened. The original started_at is
    preserved and ended_at is cleared. Ending the reopened Meeting later
    records a new ended_at.
    """
    _require_meeting_write_access(meeting=meeting, user=actor)

    # Serialize lifecycle transitions for this Meeting so two concurrent
    # transitions cannot both observe the old status and both commit.
    Meeting.objects.select_for_update().get(pk=meeting.pk)
    meeting.refresh_from_db()

    if meeting.status != Meeting.Status.COMPLETED:
        raise MeetingDomainError(
            "Only a completed Meeting can be reopened."
        )

    meeting.status = Meeting.Status.LIVE
    meeting.ended_at = None
    meeting.save(update_fields=["status", "ended_at", "updated_at"])

    return meeting


@transaction.atomic
def delete_meeting(*, meeting, actor):
    """Permanently delete one Meeting occurrence.

    Uses the existing scoped Meeting write rule. Deletes the Meeting
    together with its Meeting-owned dependents (Sections, Items,
    Participants, MeetingItemWorkItem links) through the existing
    relational CASCADE semantics.

    Canonical Work Items linked from this Meeting are NOT owned by the
    Meeting: deleting the Meeting removes only the origin links, never
    the Work Items. A Meeting Template (MeetingSeries) and sibling
    occurrences are independent records and are never touched.
    """
    _require_meeting_write_access(meeting=meeting, user=actor)

    # Serialize against concurrent lifecycle transitions on this Meeting.
    Meeting.objects.select_for_update().get(pk=meeting.pk)
    meeting.refresh_from_db()

    meeting.delete()


def remove_meeting_participant(
    *,
    participant,
    actor,
):
    _require_meeting_write_access(meeting=participant.meeting, user=actor)

    participant.delete()


def update_meeting_item(
    *,
    meeting_item,
    actor,
    title=None,
    notes=None,
    status=None,
):
    _require_meeting_write_access(meeting=meeting_item.meeting, user=actor)

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
    meeting_note=None,
):
    """Create a canonical WorkItem from a MeetingItem.

    The WorkItem service remains authoritative for Project write access,
    assignee eligibility, hierarchy and WorkItem invariants.

    A Meeting may only create work inside a Project belonging to the same
    Research Group.

    When ``meeting_note`` is provided, the created WorkItem becomes the
    primary WorkItem of that exact Note (Meeting -> MeetingItem ->
    MeetingNote -> WorkItem traceability). The Note must belong to the
    given MeetingItem, and a Note with an existing primary WorkItem is
    rejected: the uniqueness is pre-checked here and also enforced by
    the ``meeting_note`` unique constraint, so a repeated or concurrent
    request cannot create a second primary link.
    """
    _require_meeting_write_access(meeting=meeting_item.meeting, user=actor)

    if (
        project.research_group_id
        != meeting_item.meeting.research_group_id
    ):
        raise MeetingDomainError(
            "Project must belong to the Meeting's Research Group."
        )

    if (
        meeting_item.meeting.scope == Meeting.Scope.PROJECT
        and project.pk != meeting_item.meeting.project_id
    ):
        raise MeetingDomainError(
            "A project Meeting can only create work in its Project."
        )

    if meeting_note is not None:
        if meeting_note.meeting_item_id != meeting_item.pk:
            raise MeetingDomainError(
                "The Note does not belong to this Meeting item."
            )

        if MeetingItemWorkItem.objects.filter(
            meeting_note=meeting_note,
        ).exists():
            raise MeetingDomainError(
                "This Note already has a linked Work Item."
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

    try:
        MeetingItemWorkItem.objects.create(
            meeting_item=meeting_item,
            work_item=work_item,
            meeting_note=meeting_note,
            created_by=actor,
        )
    except IntegrityError:
        # The unique meeting_note constraint is the last line of
        # defense against concurrent duplicate primary links.
        raise MeetingDomainError(
            "This Note already has a linked Work Item."
        )

    return work_item


# ── Meeting Notes ────────────────────────────────────────────────


def _require_note_write_access(*, meeting, user):
    """Notes follow the existing Meeting write authorization model.

    Upcoming Meetings have no discussion to note; Live Meetings are the
    authoring surface. Completed Meetings are protocol: their Notes are
    readable but no longer editable through the Meeting UI.
    """
    _require_meeting_write_access(meeting=meeting, user=user)

    if meeting.status == Meeting.Status.COMPLETED:
        raise MeetingDomainError(
            "Notes cannot be added to a completed Meeting."
        )

    if meeting.status == Meeting.Status.UPCOMING:
        raise MeetingDomainError(
            "Notes cannot be added to an upcoming Meeting."
        )


def list_meeting_item_notes(*, meeting_item, user):
    """Return the Notes for one MeetingItem, ordered deterministically.

    Read access is enforced by the caller (the view resolves the item
    through the scoped Meeting read rule); this helper is read-only.
    """
    return list(
        MeetingNote.objects.filter(
            meeting_item=meeting_item,
        ).select_related("author")
    )


def create_meeting_note(*, meeting_item, actor, content):
    """Create one persistent Note owned by a MeetingItem.

    The author is always the authenticated actor; the client cannot
    spoof it. Content must be non-empty after strip.
    """
    _require_note_write_access(
        meeting=meeting_item.meeting, user=actor,
    )

    cleaned = (content or "").strip()
    if not cleaned:
        raise MeetingDomainError("Note content cannot be empty.")

    with transaction.atomic():
        note = MeetingNote.objects.create(
            meeting_item=meeting_item,
            author=actor,
            content=cleaned,
        )

    return note


def update_meeting_note(*, note, actor, content):
    """Edit an existing Note's content.

    Uses the Meeting write authorization model. The original author is
    preserved.
    """
    _require_note_write_access(
        meeting=note.meeting_item.meeting, user=actor,
    )

    cleaned = (content or "").strip()
    if not cleaned:
        raise MeetingDomainError("Note content cannot be empty.")

    note.content = cleaned
    note.save(update_fields=["content", "updated_at"])

    return note


def delete_meeting_note(*, note, actor):
    """Delete one Note. Only the Note is removed; the MeetingItem,
    the Meeting, and any linked Work Items are untouched."""
    _require_note_write_access(
        meeting=note.meeting_item.meeting, user=actor,
    )

    note.delete()
