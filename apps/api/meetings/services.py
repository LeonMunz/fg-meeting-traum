from datetime import datetime as dt_datetime, timezone as dt_timezone

from zoneinfo import ZoneInfo

from django.db import IntegrityError, models, transaction
from django.utils import timezone
from django.db.models import Max

from audit_history.services import record_audit_event
from authorization.capabilities import Capability
from authorization.service import (
    has_group_capability,
    has_project_capability,
    resolve_meeting_scope,
)
from projects.models import ProjectMembership
from research_groups.models import ResearchGroupMembership

from work_items.services import (
    WorkItemDomainError,
    create_work_item,
)

from .models import (
    Meeting,
    MeetingItem,
    MeetingItemFollowUp,
    MeetingItemWorkItem,
    MeetingNote,
    MeetingParticipant,
    MeetingRecurrence,
    MeetingRecurrenceExclusion,
    MeetingRecurrenceParticipant,
    MeetingSection,
    MeetingSeries,
    MeetingSeriesSection,
)
from .recurrence import (
    RecurrenceError,
    MeetingRecurrenceOccurrence,
    calculate_recurrence_occurrences,
    derive_occurrence_identity,
    validate_recurrence_definition,
)


class MeetingDomainError(Exception):
    def __init__(self, message):
        self.message = message
        super().__init__(message)


class MeetingFollowUpConflictError(MeetingDomainError):
    """An active schedule exists and requires explicit rescheduling."""


class MeetingAuditEventType:
    """Event types recorded for Meeting history.

    Intentionally coarse: ONE event per logical operation (not one per
    changed field). Update details live in AuditEvent.data["changes"].
    """

    CREATED = "meeting.created"
    RESCHEDULED = "meeting.rescheduled"
    COMPLETED = "meeting.completed"
    CANCELLED = "meeting.cancelled"
    AGENDA_ITEM_ADDED = "meeting.agenda_item_added"
    FOLLOW_UP_SCHEDULED = "meeting.follow_up_scheduled"


def _iso8601_utc(value):
    """Stable machine-readable UTC ISO-8601 form of a datetime value.

    Persisted Activity data stores structured values, never rendered
    strings; a scheduled datetime is stored exactly this way so a later
    projection can render it without re-interpreting formats.
    """
    if value is None:
        return None
    if timezone.is_naive(value):
        value = timezone.make_aware(value)
    return value.astimezone(dt_timezone.utc).isoformat()


def _require_research_group_membership(*, research_group, user):
    if not has_group_capability(
        user,
        research_group.pk,
        Capability.GROUP_READ,
    ):
        raise MeetingDomainError(
            "User is not a member of this Research Group."
        )


def _has_canonical_meeting_read_access(*, meeting, user):
    """Canonical Meeting read-access rule.

    A Meeting is visible/readable iff the user:

    1. created the Meeting (``created_by``), or
    2. is an explicit ``MeetingParticipant``.

    Research Group membership, Project membership, ownership, or
    admin status alone must NOT grant Meeting visibility. A
    Meeting invitation grants Meeting read access only — it does
    NOT create Research Group membership, Project membership,
    Project permissions, or access to otherwise protected Work
    Items.
    """
    scope = resolve_meeting_scope(user, meeting)
    return scope is not None and scope.has(Capability.MEETING_READ)


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

    if not has_project_capability(
        user, project.pk, Capability.PROJECT_READ
    ):
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

    if not has_project_capability(
        user, project.pk, Capability.PROJECT_WORK
    ):
        raise MeetingDomainError(
            "A viewer cannot modify Project Meeting content."
        )


def _require_live_meeting(*, meeting):
    if meeting.status != Meeting.Status.LIVE:
        raise MeetingDomainError(
            "This action is only available during a Live Meeting."
        )


def _ordered_not_discussed_items(*, meeting):
    """Items in canonical agenda order: Section.position, then item
    position (item position is unique within a section), then id."""
    return (
        MeetingItem.objects
        .filter(
            meeting=meeting,
            outcome=MeetingItem.Outcome.NOT_DISCUSSED,
        )
        .select_related("meeting_section")
        .order_by(
            "meeting_section__position",
            "meeting_section__id",
            "position",
            "id",
        )
    )


def _select_first_not_discussed_for_meeting(*, meeting):
    first = _ordered_not_discussed_items(meeting=meeting).first()
    if first is None:
        return None

    _set_current_item(
        meeting=meeting,
        item_pk=first.pk,
    )
    return first



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


def _has_can_meet_participant_add_access(*, meeting, user):
    """A Meeting creator or existing participant may add participants."""
    if meeting.created_by_id == user.pk:
        return True
    return MeetingParticipant.objects.filter(
        meeting=meeting,
        user=user,
    ).exists()


def _require_can_meet_participant_adder(*, meeting, user):
    if not _has_can_meet_participant_add_access(
        meeting=meeting,
        user=user,
    ):
        raise MeetingDomainError(
            "Only a Meeting creator or participant may add participants."
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


@transaction.atomic
def delete_meeting_series(*, meeting_series, actor):
    """Permanently delete one Meeting Template (MeetingSeries).

    Uses the existing scoped Template write rule (MEETING_SERIES_WRITE
    via the authorization kernel: group scope → the group's read
    members; project scope → Project owner/member, non-archived
    Projects only), so a user who could not manage the Template cannot
    delete it either.

    Deletes the Template together with its Template-owned Sections
    through the existing relational CASCADE semantics.

    Existing Meeting occurrences are NOT owned by the Template: they
    are independent snapshots. Deleting the Template never deletes an
    occurrence; it only clears the occurrence's provenance reference
    (``Meeting.series`` is SET_NULL) and the section snapshots' source
    pointer (``MeetingSection.source_series_section`` is SET_NULL)
    while every snapshot's own content is preserved.

    Recurrences referencing the Template are NOT deleted either: the
    reference is cleared (``MeetingRecurrence.series`` is SET_NULL, the
    same preservation semantics as ``Meeting.series``), and the
    recurrence's rule, title, and materialized Meetings all survive.
    The recurrence then behaves like a legacy template-less recurrence:
    its existing materialized Meetings remain fully usable, but
    materializing a still-virtual occurrence is an explicit domain
    error until a Template is associated again.

    Sibling Templates are independent records and are never touched.
    """
    # Serialize against concurrent Template lifecycle operations and
    # revalidate against the current persisted state (e.g. a Project
    # archived after the caller loaded the Template): the authorization
    # decision must never be made on a stale related object.
    MeetingSeries.objects.select_for_update().get(pk=meeting_series.pk)
    meeting_series = (
        MeetingSeries.objects
        .select_related("research_group", "project")
        .get(pk=meeting_series.pk)
    )

    _require_series_write_access(meeting_series=meeting_series, user=actor)

    meeting_series.delete()


# ── MeetingRecurrence (recurring-meeting schedules) ─────────────


def create_meeting_recurrence(
    *,
    research_group,
    actor,
    title,
    meeting_series,
    frequency,
    interval,
    start_date,
    local_time,
    timezone_name,
    scope=MeetingRecurrence.Scope.GROUP,
    project=None,
    weekdays=(),
    end_mode=MeetingRecurrence.EndMode.NO_END,
    end_date=None,
    occurrence_count=None,
    participants=(),
):
    """Persist one recurring-meeting schedule (V1 recurrence language).

    Uses the canonical scoped Meeting write rule (group scope → group
    read members; project scope → Project owner/member, non-archived
    Projects only), exactly like Meeting creation.

    ``title`` is the canonical title of the recurring SERIES (required,
    non-blank after strip, at most 255 characters — the same constraints
    and normalization conventions as Meeting / MeetingSeries titles). It
    identifies the series even when zero Meetings have been materialized
    and is the DEFAULT title of a Meeting when a future occurrence is
    materialized; once a Meeting exists, its title is Meeting-owned and
    never rewritten from the recurrence. It is INDEPENDENT of the
    Template's title: it is never derived from a Template, and renaming
    a Template never changes it.

    ``meeting_series`` is the canonical Meeting Template (required):
    the Template whose active Sections are the content source for
    FUTURE materializations of this schedule. It must be a PERSISTED
    Template whose scope matches the recurrence's scope exactly (group
    scope ↔ a group-scoped Template of the same Research Group; project
    scope ↔ the Template of the same Project), and the actor must hold
    the canonical Template write rule of that scope (the same scoped
    write rule the recurrence itself requires — a read-only/viewer
    actor can never bind a Template).

    ``participants`` is the optional intended participant set of the
    recurring SERIES (default: empty): the users who become concrete
    ``MeetingParticipant``s of a Meeting when a FUTURE occurrence is
    materialized. Omitted or empty is valid. It carries participant
    IDENTITY only — no attendance, RSVP, or presence state. Eligibility
    is exactly the canonical Meeting-participant rule: every entry must
    be an EXISTING application user — Research Group membership,
    Project membership, and Project role are NOT requirements (the same
    rule ordinary Meeting creation applies; no authorization is
    broadened or granted by the intent). Duplicate entries are
    normalized to one persisted intent each (the same convention as
    create-time Meeting participants). The creator MAY be included in
    the set: materialization deduplicates through the canonical
    creator-first participant initialization, so it never creates
    duplicate ``MeetingParticipant`` rows. The intent is persisted
    atomically with the recurrence, and a later change of the set never
    rewrites any already-materialized Meeting — only FUTURE
    materializations pick it up.

    The V1 definition is validated before anything is persisted and must
    be internally consistent:

    - frequency is ``daily`` / ``weekly`` / ``monthly``;
    - interval is a positive integer;
    - weekly schedules need one or more weekdays (0 = Monday .. 6 =
      Sunday), and the start date's weekday must be part of the pattern,
      so the start date is always the first actual occurrence;
    - non-weekly schedules must not carry weekdays;
    - timezone_name must be a valid IANA timezone;
    - end mode is ``no_end`` / ``end_date`` / ``count`` with exactly the
      matching fields: end date is inclusive and never before the start
      date; count is positive and INCLUDES the first occurrence; end date
      and count are mutually exclusive;
    - creating a schedule never creates any Meeting row.

    Raises MeetingDomainError on any authorization or validation failure.
    """
    _require_scoped_write_access(
        research_group=research_group,
        scope=scope,
        project=project,
        user=actor,
    )

    title = str(title or "").strip()
    if not title:
        raise MeetingDomainError("Recurrence title is required.")

    if meeting_series is None or meeting_series.pk is None:
        raise MeetingDomainError(
            "A recurrence requires a persisted Meeting Template."
        )
    template = MeetingSeries.objects.select_related(
        "research_group", "project",
    ).filter(pk=meeting_series.pk).first()
    if template is None:
        raise MeetingDomainError(
            "A recurrence requires a persisted Meeting Template."
        )
    if template.research_group_id != research_group.pk:
        raise MeetingDomainError(
            "The Meeting Template must belong to the recurrence's "
            "Research Group."
        )
    if scope == MeetingRecurrence.Scope.GROUP:
        if (
            template.scope != MeetingSeries.Scope.GROUP
            or template.project_id is not None
        ):
            raise MeetingDomainError(
                "A group-scoped recurrence requires a group-scoped "
                "Meeting Template."
            )
    else:
        if (
            template.scope != MeetingSeries.Scope.PROJECT
            or template.project_id != project.pk
        ):
            raise MeetingDomainError(
                "A project-scoped recurrence requires the Meeting "
                "Template of the same Project."
            )
    _require_series_write_access(meeting_series=template, user=actor)

    try:
        normalized_weekdays = validate_recurrence_definition(
            frequency=frequency,
            interval=interval,
            weekdays=weekdays,
            start_date=start_date,
            local_time=local_time,
            timezone_name=timezone_name,
            end_mode=end_mode,
            end_date=end_date,
            occurrence_count=occurrence_count,
        )
    except RecurrenceError as exc:
        raise MeetingDomainError(str(exc)) from exc

    # The intended participant set is validated BEFORE anything is
    # persisted, with exactly the canonical Meeting-participant
    # eligibility: every participant must be an EXISTING application
    # user — Research Group membership, Project membership, and Project
    # role are NOT requirements (the same rule ordinary Meeting
    # creation applies). The set is a SET: duplicate entries are
    # normalized to one persisted intent each. This validation grants
    # no access to anyone and broadens no authorization.
    participants_by_id = {}
    for participant in participants:
        if participant.pk is None:
            raise MeetingDomainError(
                "Every recurrence participant must be an existing "
                "application user."
            )
        participants_by_id[participant.pk] = participant

    # The intent is persisted atomically with the recurrence: a failed
    # creation leaves no recurrence and no participant intents behind.
    with transaction.atomic():
        recurrence = MeetingRecurrence.objects.create(
            research_group=research_group,
            scope=scope,
            project=project,
            title=title,
            series=template,
            frequency=frequency,
            interval=interval,
            weekdays=list(normalized_weekdays),
            start_date=start_date,
            local_time=local_time,
            timezone_name=timezone_name,
            end_mode=end_mode,
            end_date=end_date,
            occurrence_count=occurrence_count,
            created_by=actor,
        )
        MeetingRecurrenceParticipant.objects.bulk_create([
            MeetingRecurrenceParticipant(recurrence=recurrence, user=user)
            for user in participants_by_id.values()
        ])

    return recurrence


def expand_meeting_recurrence_occurrences(
    *,
    meeting_recurrence,
    range_start,
    range_end,
):
    """Deterministically expand one persisted recurrence for a bounded window.

    Read-only domain operation: calculates the occurrence values (stable
    occurrence identity + original local wall-clock start + DST-correct
    aware start) whose original local start falls inside the explicitly
    bounded, timezone-aware window ``[range_start, range_end]`` (inclusive
    on both ends). There is deliberately NO unbounded "return every
    occurrence" variant: ``range_start`` and ``range_end`` are required
    keyword arguments.

    Expansion works in the schedule's stored IANA timezone in local
    wall-clock time (the configured local time is preserved across DST
    transitions), respects daily/weekly/monthly intervals, treats the
    end date as inclusive, treats the count as the total number of
    meetings including the first, skips nonexistent monthly dates, and
    never returns occurrences outside the requested window.

    Expansion creates no Meeting rows and stays independent of persisted
    concrete Meetings. Access to the recurrence row is the caller's
    responsibility (a future API slice enforces the scoped read rule);
    expansion itself grants no access.
    """
    if meeting_recurrence.pk is None:
        raise MeetingDomainError(
            "Only persisted recurrences can be expanded: stable occurrence "
            "identities require a schedule id."
        )
    if range_start is None or range_end is None:
        raise MeetingDomainError(
            "Expansion requires an explicitly bounded range."
        )
    if range_start.tzinfo is None or range_end.tzinfo is None:
        raise MeetingDomainError(
            "Expansion range boundaries must be timezone-aware datetimes."
        )
    if range_start > range_end:
        raise MeetingDomainError(
            "The expansion range start must not be after the range end."
        )

    try:
        return calculate_recurrence_occurrences(
            recurrence_id=meeting_recurrence.pk,
            frequency=meeting_recurrence.frequency,
            interval=meeting_recurrence.interval,
            weekdays=meeting_recurrence.weekdays,
            start_date=meeting_recurrence.start_date,
            local_time=meeting_recurrence.local_time,
            timezone_name=meeting_recurrence.timezone_name,
            end_mode=meeting_recurrence.end_mode,
            end_date=meeting_recurrence.end_date,
            occurrence_count=meeting_recurrence.occurrence_count,
            range_start=range_start,
            range_end=range_end,
        )
    except RecurrenceError as exc:
        raise MeetingDomainError(str(exc)) from exc


def expand_effective_meeting_recurrence_occurrences(
    *,
    meeting_recurrence,
    range_start,
    range_end,
):
    """Expand one persisted recurrence into its EFFECTIVE occurrence set.

    The effective occurrence set is the RAW rule expansion (the full
    recurrence-rule semantics of
    ``expand_meeting_recurrence_occurrences``) with persisted
    single-occurrence exclusions filtered out AFTER rule generation:

    - the recurrence rule itself is never mutated and re-expanding it
      RAW produces the identical series;
    - an excluded occurrence simply drops out of the result: it
      consumes nothing and generates NO replacement occurrence (a
      COUNT-limited series does not grow, an end-date-limited series
      does not extend);
    - siblings keep their identities, original starts, and order.

    Read-only: creates or mutates no persistence state. Access to the
    recurrence row is the caller's responsibility, exactly like the raw
    expansion.
    """
    occurrences = expand_meeting_recurrence_occurrences(
        meeting_recurrence=meeting_recurrence,
        range_start=range_start,
        range_end=range_end,
    )
    if not occurrences:
        return []

    # One bounded query over the requested window: (recurrence,
    # original_scheduled_at) is unique, so the exclusion set is exact
    # and needs no per-occurrence lookup.
    excluded_starts = set(
        MeetingRecurrenceExclusion.objects.filter(
            recurrence=meeting_recurrence,
            original_scheduled_at__in=[
                occurrence.original_start for occurrence in occurrences
            ],
        ).values_list("original_scheduled_at", flat=True)
    )
    if not excluded_starts:
        return occurrences

    return [
        occurrence
        for occurrence in occurrences
        if occurrence.original_start not in excluded_starts
    ]


def _require_valid_recurrence_occurrence(*, recurrence, occurrence):
    """Reject any value that is not a genuine occurrence of the recurrence.

    The candidate must be a calculated ``MeetingRecurrenceOccurrence`` and:

    - carry the canonical identity for exactly this schedule
      (``derive_occurrence_identity`` over the recurrence id, the
      original local wall-clock start, and the stored timezone) — a
      forged or foreign occurrence identity is rejected;
    - actually be produced by the recurrence rule: membership is proven
      by re-expanding the rule over the bounded window from the first
      occurrence to the candidate's original start (inclusive) and
      requiring the candidate to be the LAST occurrence of that
      expansion. That single check rejects occurrences whose wall-clock
      time or date the rule never produces and occurrences beyond the
      end-date / count contract (occurrences before the window consume
      the count too).

    The validation cost is bounded by the number of occurrences up to the
    candidate — the same work as the equivalent bounded expansion.
    """
    if not isinstance(occurrence, MeetingRecurrenceOccurrence):
        raise MeetingDomainError(
            "Materialization requires a calculated recurrence occurrence."
        )
    if occurrence.original_local.tzinfo is not None:
        raise MeetingDomainError(
            "The occurrence's original local start must be a naive "
            "wall-clock datetime."
        )
    if occurrence.original_start.tzinfo is None:
        raise MeetingDomainError(
            "The occurrence's original start must be timezone-aware."
        )

    if occurrence.occurrence_id != derive_occurrence_identity(
        recurrence_id=recurrence.pk,
        original_local=occurrence.original_local,
        timezone_name=recurrence.timezone_name,
    ):
        raise MeetingDomainError(
            "The occurrence's identity does not belong to this recurrence."
        )

    tz = ZoneInfo(recurrence.timezone_name)
    window_start = dt_datetime.combine(
        recurrence.start_date, recurrence.local_time,
    ).replace(tzinfo=tz)

    if occurrence.original_start < window_start:
        raise MeetingDomainError(
            "The occurrence is before the recurrence's first occurrence."
        )

    try:
        occurrences = expand_meeting_recurrence_occurrences(
            meeting_recurrence=recurrence,
            range_start=window_start,
            range_end=occurrence.original_start,
        )
    except MeetingDomainError as exc:
        raise MeetingDomainError(
            "The provided occurrence is not a valid occurrence of this "
            "recurrence."
        ) from exc

    if not occurrences or occurrences[-1] != occurrence:
        raise MeetingDomainError(
            "The provided occurrence is not a valid occurrence of this "
            "recurrence."
        )


def materialize_meeting_recurrence_occurrence(
    *,
    recurrence,
    occurrence,
    actor,
    title=None,
):
    """Materialize one calculated occurrence into a concrete Meeting.

    A calculated occurrence stays virtual until persistent meeting state
    is required; this is the ONLY operation that creates a concrete
    ``Meeting`` for a recurrence occurrence (creating or expanding a
    recurrence never creates Meeting rows).

    The operation is IDEMPOTENT: the first call creates the Meeting and
    repeated calls for the same recurrence occurrence return the
    already-materialized Meeting without creating duplicates. The unique
    ``(recurrence, original_scheduled_at)`` constraint makes duplicates
    impossible even when two materializations race: the loser of the
    race has its transaction rolled back and returns the winner's row.

    The materialized Meeting is a normal concrete FG Meeting (no parallel
    recurrence-specific Meeting type): it inherits the recurrence's
    Research Group / scope / Project, starts as ``upcoming``, is created
    by ``actor``, and is initialized from the recurrence's canonical
    Meeting Template (see **Template** below) with the creator as
    participant.

    **Participants:** the recurrence's persisted intended participant
    set (``MeetingRecurrenceParticipant``) is SNAPSHOT into the new
    Meeting as concrete ``MeetingParticipant`` rows through the SAME
    canonical Meeting-participant initialization as ordinary Meeting
    creation (``_create_initial_meeting_participants``): the creator is
    always included, and every intended participant is included exactly
    once (if the creator is also an intended participant, no duplicate
    row is created). The snapshot is taken from the recurrence row
    locked for this materialization — the set's CURRENT state at first
    materialization — and is the ONLY time the recurrence's set feeds a
    Meeting: an idempotent replay returns the existing Meeting without
    re-snapshotting, and a later change of the recurrence's participant
    set never rewrites any already-materialized Meeting (the snapshot is
    Meeting-owned, exactly like the Template Section snapshots). A
    recurrence with an EMPTY set yields exactly the creator as
    participant, exactly as before this snapshot existed.

    **Title:** the Recurrence owns the canonical series title. A newly
    materialized Meeting DEFAULTS its title to ``recurrence.title``; an
    explicitly supplied non-blank ``title`` is a creation-time override
    that wins for the first creation only. The title is applied ONLY
    when the Meeting row is created: an idempotent replay returns the
    existing Meeting and never overwrites its (possibly renamed) title
    from the recurrence or from the request. A later change of
    ``recurrence.title`` never rewrites any already-materialized
    Meeting's title — once a Meeting exists, its title is Meeting-owned.
    The title is never derived from the Template: the recurrence title
    wins even when the Template's title differs.

    **Template:** the recurrence's canonical Meeting Template
    (``recurrence.series``, read from the row lock) is the content
    source of a NEW occurrence: its ACTIVE Sections are snapshotted
    into the new Meeting through the same canonical
    Template-instantiation logic as ``create_meeting_from_series``
    (the Meeting carries ``series=<Template>`` and every snapshot keeps
    its ``source_series_section`` pointer). A recurrence WITHOUT a
    Template — a legacy row from before the Template linkage, or one
    whose Template was later deleted (``SET_NULL``) — cannot materialize
    a STILL-VIRTUAL occurrence: there is no canonical content source,
    and the operation raises a domain error instead of silently
    creating an empty/standalone Meeting. Replaying an
    ALREADY-MATERIALIZED occurrence always returns the existing
    Meeting, template or not. Once a Meeting exists, its Sections and
    content are Meeting-owned snapshots: later Template edits — and
    even changing the recurrence's Template reference — never rewrite
    it; only FUTURE materializations use the (newly) associated
    Template.

    The Meeting persists its immutable occurrence provenance:

    - ``recurrence`` — the MeetingRecurrence that produced it;
    - ``original_scheduled_at`` — the occurrence's original scheduled
      start (the same instant the expansion returned). The canonical
      occurrence identity is the Slice-1 UUIDv5 derived from the
      recurrence id, this original start in the stored timezone, and the
      timezone name — it never depends on ``scheduled_at``.

    ``scheduled_at`` is initialized to the occurrence's original start
    but is the Meeting's OWN editable planned time: a later override may
    move it without redefining the original occurrence identity.

    The candidate occurrence is validated against the recurrence before
    anything is persisted (``_require_valid_recurrence_occurrence``):
    callers cannot invent arbitrary recurrence ids or original starts to
    create recurring Meetings outside the recurrence rule.

    A persistent single-occurrence EXCLUSION is an additional
    eligibility gate, checked under the recurrence row lock (below):
    an excluded occurrence is a genuine raw occurrence but is NOT
    materializable — materializing it raises a domain error and
    persists nothing. Virtual reschedule inherits this gate because it
    materializes through this operation.

    Authorization reuses the canonical scoped Meeting write rule (group
    scope → group read members; project scope → Project owner/member,
    non-archived Projects only), exactly like Meeting creation.
    """
    if recurrence.pk is None:
        raise MeetingDomainError(
            "Only persisted recurrences can be materialized: stable "
            "occurrence identities require a schedule id."
        )

    _require_scoped_write_access(
        research_group=recurrence.research_group,
        scope=recurrence.scope,
        project=recurrence.project,
        user=actor,
    )

    title = str(title or "").strip()
    if not title:
        # No caller-supplied title: the recurrence owns the canonical
        # series title and it is the default for the new Meeting.
        title = recurrence.title.strip()
    if not title:
        raise MeetingDomainError("Meeting title is required.")

    _require_valid_recurrence_occurrence(
        recurrence=recurrence,
        occurrence=occurrence,
    )

    try:
        with transaction.atomic():
            existing = Meeting.objects.filter(
                recurrence=recurrence,
                original_scheduled_at=occurrence.original_start,
            ).first()
            if existing is not None:
                return existing

            # Serialize against a concurrent exclusion of this
            # recurrence, then re-check exclusion under the lock: an
            # excluded occurrence is not materializable, and a
            # concurrent exclusion cannot commit after this check.
            # ``FOR NO KEY UPDATE`` (not ``FOR UPDATE``): the two domain
            # writers still serialize against each other (the lock mode
            # conflicts with itself), but it is compatible with the FK
            # ``FOR KEY SHARE`` check a concurrent in-flight Meeting
            # insert performs at commit time (Django creates FKs
            # DEFERRABLE INITIALLY DEFERRED) — a plain ``FOR UPDATE``
            # here deadlocked with such a transaction. The lock row is
            # reused as the authoritative recurrence state (including
            # the CURRENT Template reference) for this materialization;
            # the Template is fetched separately, so the lock query
            # never joins the nullable Template relation.
            locked_recurrence = MeetingRecurrence.objects.select_for_update(
                no_key=True,
            ).get(pk=recurrence.pk)

            # The recurrence's canonical Template is the ONLY content
            # source of a new occurrence. A recurrence without a
            # Template — a legacy row from before the Template linkage,
            # or one whose Template was deleted (SET_NULL) — cannot
            # materialize a still-virtual occurrence: an explicit
            # domain error, never a silently created empty/standalone
            # Meeting. (An already-materialized occurrence was returned
            # above, template or not.)
            meeting_series = (
                MeetingSeries.objects
                .filter(pk=locked_recurrence.series_id)
                .first()
            )
            if meeting_series is None:
                raise MeetingDomainError(
                    "This recurrence has no Meeting Template: a "
                    "still-virtual occurrence cannot be materialized "
                    "without a canonical content source."
                )

            if MeetingRecurrenceExclusion.objects.filter(
                recurrence=recurrence,
                original_scheduled_at=occurrence.original_start,
            ).exists():
                raise MeetingDomainError(
                    "This occurrence is excluded from the recurrence: "
                    "an excluded occurrence cannot be materialized."
                )

            meeting = Meeting.objects.create(
                research_group=recurrence.research_group,
                scope=recurrence.scope,
                project=recurrence.project,
                recurrence=recurrence,
                original_scheduled_at=occurrence.original_start,
                series=meeting_series,
                title=title,
                scheduled_at=occurrence.original_start,
                status=Meeting.Status.UPCOMING,
                created_by=actor,
            )

            # The Template's active Sections are snapshotted into the
            # new Meeting through the canonical Template-instantiation
            # logic shared with create_meeting_from_series: internal
            # structure of the creation operation, no separate event.
            _snapshot_series_sections(
                meeting=meeting,
                meeting_series=meeting_series,
            )

            # The recurrence's persisted intended participant set is
            # snapshotted into concrete MeetingParticipant rows
            # through the canonical Meeting-participant initialization
            # (creator first, then the unique intended participants —
            # a creator who is also an intended participant yields
            # exactly one row). The set is read under the recurrence
            # row lock already held for this materialization: it is
            # the authoritative CURRENT set for the FIRST creation
            # only — a replay returns above, and a later change of the
            # set never rewrites this Meeting.
            initial_participants = [
                relation.user
                for relation in MeetingRecurrenceParticipant.objects.filter(
                    recurrence_id=locked_recurrence.pk,
                ).select_related("user").order_by("id")
            ]

            _create_initial_meeting_participants(
                meeting=meeting,
                actor=actor,
                participants=initial_participants,
            )

            # Recorded inside the same atomic block as the creation: a
            # rolled-back materialization leaves no AuditEvent behind.
            record_audit_event(
                research_group=meeting.research_group,
                actor=actor,
                event_type=MeetingAuditEventType.CREATED,
                project=meeting.project,
                meeting=meeting,
                data={},
            )

        return meeting
    except IntegrityError:
        # A concurrent materialization of the same occurrence won the
        # race: the unique constraint rejected our insert and rolled the
        # transaction back. The winner's row is the canonical Meeting.
        return Meeting.objects.get(
            recurrence=recurrence,
            original_scheduled_at=occurrence.original_start,
        )


def reschedule_meeting_recurrence_occurrence(
    *,
    recurrence,
    occurrence,
    scheduled_at,
    actor,
    title,
):
    """Reschedule ONE occurrence ("only this meeting").

    This is the first single-occurrence override semantic: it moves the
    concrete ``Meeting`` that was materialized from exactly this
    occurrence while leaving the recurrence rule, the immutable
    occurrence identity, and every other occurrence in the series
    untouched.

    The move is represented by a concrete Meeting (V1):

    - ``original_scheduled_at`` stays the immutable occurrence
      identity — it is never changed;
    - ``scheduled_at`` becomes the new actual planned meeting time;
    - ``Meeting.recurrence`` keeps pointing at the same
      MeetingRecurrence — the rule is NOT mutated, no new recurrence
      identity is generated, and no second Meeting is created for the
      same occurrence.

    If the occurrence is still VIRTUAL, it is first materialized
    through the canonical idempotent materialization path
    (``materialize_meeting_recurrence_occurrence``), and the same
    concrete Meeting is then moved — one all-or-nothing operation, so
    a failed move never leaves an orphaned materialized Meeting
    behind. If the occurrence already has a concrete Meeting, that row
    is reused and only its ``scheduled_at`` changes.

    Preconditions, enforced before anything is persisted:

    - the canonical scoped Meeting write rule of the Recurrence's
      scope (group scope → group read members; project scope →
      Project owner/member, non-archived Projects only), exactly like
      Meeting creation and occurrence materialization;
    - the candidate must be a genuine occurrence of EXACTLY this
      recurrence (``_require_valid_recurrence_occurrence``: derived
      identity match AND bounded rule membership);
    - an EXCLUDED virtual occurrence is rejected through the canonical
      materialization gate (the move would first materialize it):
      nothing is created, moved, or de-excluded, and no
      ``meeting.created`` / ``meeting.rescheduled`` event is recorded;
    - a CANCELLED already-materialized occurrence is rejected:
      rescheduling is the only override operation that could move the
      concrete Meeting, so it must not silently reactivate a cancelled
      Meeting (the exclusion written by the cancellation stays in
      place, and the ``original_scheduled_at`` identity is preserved);
    - a non-blank ``title`` is ALWAYS required: it is the Meeting
      title used when the reschedule must first materialize a virtual
      occurrence, and it is NEVER used to overwrite the title of an
      already-materialized Meeting.

    The time change itself is delegated to the canonical
    ``update_meeting`` domain operation, which preserves recurrence
    provenance (it only touches ``title`` / ``scheduled_at`` /
    ``updated_at``) and records exactly one structured
    ``meeting.rescheduled`` event for a real date-time change; a
    no-op (same value) reschedule changes nothing and records no
    event. A first-time reschedule of a virtual occurrence therefore
    produces exactly one ``meeting.created`` event (from
    materialization) plus one ``meeting.rescheduled`` event (from the
    move); a no-op move of a virtual occurrence produces the
    ``meeting.created`` event only.
    """
    if recurrence.pk is None:
        raise MeetingDomainError(
            "Only persisted recurrences can be rescheduled: stable "
            "occurrence identities require a schedule id."
        )

    _require_scoped_write_access(
        research_group=recurrence.research_group,
        scope=recurrence.scope,
        project=recurrence.project,
        user=actor,
    )

    _require_valid_recurrence_occurrence(
        recurrence=recurrence,
        occurrence=occurrence,
    )

    title = str(title or "").strip()
    if not title:
        raise MeetingDomainError("Meeting title is required.")

    meeting = Meeting.objects.filter(
        recurrence=recurrence,
        original_scheduled_at=occurrence.original_start,
    ).first()
    if meeting is not None:
        # A cancelled Meeting is terminal: a reschedule would silently
        # reactivate the cancelled occurrence. The exclusion written by
        # the cancellation stays in place; restoring the occurrence is
        # a separate, deferred operation.
        if meeting.status == Meeting.Status.CANCELLED:
            raise MeetingDomainError(
                "A cancelled Meeting cannot be rescheduled: the "
                "occurrence stays excluded."
            )
        # Already materialized: move the existing row only. The
        # request's title is deliberately NOT applied — a reschedule
        # never renames an existing Meeting. The canonical Meeting
        # update preserves recurrence provenance and records the
        # meeting.rescheduled event; it re-checks the scoped write
        # rule for the Meeting itself.
        return update_meeting(
            meeting=meeting,
            actor=actor,
            scheduled_at=scheduled_at,
        )

    # Virtual occurrence: the canonical idempotent materialization
    # creates the concrete Meeting (title, provenance, default
    # Section, creator participant, meeting.created event), then the
    # same row is moved. The outer atomic makes the whole operation
    # all-or-nothing: a failed move rolls the materialization back.
    # The unique (recurrence, original_scheduled_at) constraint keeps
    # duplicates impossible even when two requests race.
    with transaction.atomic():
        meeting = materialize_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=occurrence,
            actor=actor,
            title=title,
        )
        return update_meeting(
            meeting=meeting,
            actor=actor,
            scheduled_at=scheduled_at,
        )


def exclude_meeting_recurrence_occurrence(
    *,
    recurrence,
    occurrence,
    actor,
):
    """Persistently exclude ONE virtual occurrence of a recurrence.

    The operation removes the occurrence from the recurrence's
    EFFECTIVE occurrence set by persisting exactly one
    ``MeetingRecurrenceExclusion`` row keyed by (recurrence, immutable
    original scheduled start). It is the persistence basis for a later
    "cancel/delete this one meeting" operation.

    Enforced semantics:

    - the recurrence must be persisted (stable occurrence identities
      require a schedule id);
    - the candidate must be a genuine occurrence of EXACTLY this
      recurrence (``_require_valid_recurrence_occurrence``: derived
      identity match AND bounded rule membership) — forged identities,
      foreign occurrences, off-rule wall-clock times, and occurrences
      beyond the end-date / count contract are rejected before anything
      is persisted;
    - the occurrence must still be VIRTUAL: if a concrete Meeting was
      already materialized from it, the operation is REJECTED with a
      domain error and leaves that Meeting completely unchanged (no
      deletion, no lifecycle/status change, no exclusion row). The
      check runs under the recurrence row lock (see below) so a
      concurrent materialization cannot commit after it. Cancellation/
      deletion of an already-materialized occurrence is a separate,
      deferred operation;
    - the operation creates exactly ONE exclusion record and NOTHING
      else: zero Meeting rows, zero Sections, zero participants, zero
      audit events. It never routes through materialization;
    - IDEMPOTENT: excluding the same occurrence repeatedly returns the
      existing exclusion row without creating duplicates. The unique
      ``(recurrence, original_scheduled_at)`` constraint makes
      duplicates impossible even when two exclusions race (the losing
      transaction is rolled back and the winner's row is returned);
    - the raw occurrence validation above is deliberately UNCHANGED
      (raw rule membership, not effective-set membership): re-
      excluding an already-excluded occurrence stays idempotent. The
      exclusion is only consumed as a gate on the materialization side;
    - the recurrence rule is NOT mutated: no rule field, end mode, or
      identity changes, and the raw rule still produces the same
      occurrences. The exclusion consumes no occurrence and generates
      no replacement.

    Authorization reuses the canonical scoped Meeting write rule
    (group scope → group read members; project scope → Project
    owner/member, non-archived Projects only), exactly like Meeting
    creation and occurrence materialization.

    No audit event is recorded: the exclusion neither creates nor
    mutates any Meeting, and no canonical recurrence-level audit event
    family exists — no new audit taxonomy is introduced for this
    operation (an explicit decision, see docs/domain/meetings.md §5a).
    """
    if recurrence.pk is None:
        raise MeetingDomainError(
            "Only persisted recurrences can have occurrences excluded: "
            "stable occurrence identities require a schedule id."
        )

    _require_scoped_write_access(
        research_group=recurrence.research_group,
        scope=recurrence.scope,
        project=recurrence.project,
        user=actor,
    )

    _require_valid_recurrence_occurrence(
        recurrence=recurrence,
        occurrence=occurrence,
    )

    existing = MeetingRecurrenceExclusion.objects.filter(
        recurrence=recurrence,
        original_scheduled_at=occurrence.original_start,
    ).first()
    if existing is not None:
        return existing

    try:
        with transaction.atomic():
            # Serialize against a concurrent materialization of this
            # recurrence, then check materialization state under the
            # lock: excluding an already-materialized occurrence is
            # rejected, and a concurrent materialization cannot commit
            # after this check.
            # ``FOR NO KEY UPDATE`` for the same reason as in
            # ``materialize_meeting_recurrence_occurrence``: it
            # serializes the two domain writers without deadlocking
            # against an in-flight raw Meeting insert's deferred FK
            # check.
            MeetingRecurrence.objects.select_for_update(no_key=True).get(
                pk=recurrence.pk
            )
            if Meeting.objects.filter(
                recurrence=recurrence,
                original_scheduled_at=occurrence.original_start,
            ).exists():
                raise MeetingDomainError(
                    "This occurrence already has a concrete Meeting: "
                    "excluding an already-materialized occurrence is "
                    "not supported. Cancellation or deletion of the "
                    "concrete Meeting is a separate operation."
                )
            return MeetingRecurrenceExclusion.objects.create(
                recurrence=recurrence,
                original_scheduled_at=occurrence.original_start,
                created_by=actor,
            )
    except IntegrityError:
        # A concurrent exclusion of the same occurrence won the race:
        # the unique constraint rejected our insert and rolled the
        # transaction back. The winner's row is the canonical one.
        return MeetingRecurrenceExclusion.objects.get(
            recurrence=recurrence,
            original_scheduled_at=occurrence.original_start,
        )


@transaction.atomic
def cancel_meeting_recurrence_occurrence(
    *,
    meeting,
    actor,
):
    """Cancel ONE materialized recurring occurrence ("only this meeting").

    This is the materialized counterpart of
    ``exclude_meeting_recurrence_occurrence`` (which handles a VIRTUAL
    occurrence with an exclusion only): the occurrence already has a
    concrete ``Meeting``, and cancelling it PRESERVES that Meeting.

    Canonical final state of one cancellation:

    - the Meeting row survives with its primary key, its
      ``recurrence`` FK, its immutable ``original_scheduled_at``
      occurrence identity, its current ``scheduled_at`` (a moved
      Meeting keeps its moved time — the exclusion is keyed to the
      ORIGINAL occurrence, not to the moved time), its title, and all
      Meeting-specific content (Sections, agenda items, notes,
      participants, Work Item links, audit history);
    - ``status`` becomes ``cancelled`` — a TERMINAL Meeting state
      reachable ONLY through this operation. No generic lifecycle
      operation exists (start / end / reopen each accept exactly one
      source status and none of them produces ``cancelled``), and the
      Meeting PATCH surface rejects the ``status`` field, so no
      alternate unvalidated path can cancel a recurring Meeting. A
      cancelled Meeting cannot transition back to upcoming / live /
      completed (all three lifecycle actions reject it), and there is
      no restore / reactivate in V1;
    - exactly ONE ``MeetingRecurrenceExclusion`` exists for
      ``(recurrence, original_scheduled_at)``: the cancelled
      occurrence drops out of the EFFECTIVE occurrence set (raw
      expansion unchanged, no replacement occurrence, siblings
      untouched), and the canonical materialization / virtual
      reschedule gates keep it out of the effective set going forward.

    Preconditions, enforced before anything is persisted:

    - a persisted Meeting with BOTH recurrence provenance fields
      (``recurrence`` and ``original_scheduled_at`` — a paired
      invariant): a standalone / non-recurring Meeting has no
      occurrence identity to cancel, and a still-virtual occurrence
      has no concrete Meeting (use
      ``exclude_meeting_recurrence_occurrence`` for that; this
      operation never materializes);
    - the canonical scoped Meeting write rule (group scope → group
      read members; project scope → Project owner/member,
      non-archived Projects only) — the same rule every other Meeting
      mutation uses;
    - the Meeting status must be ``upcoming``: a ``live`` or
      ``completed`` Meeting is rejected and left completely unchanged
      (historical / in-progress Meetings are never retroactively
      treated as if they never happened).

    Atomicity / locking: the Meeting row is locked
    (``SELECT … FOR UPDATE``) to serialize against concurrent
    lifecycle transitions and deletion on the same Meeting, and the
    exclusion insert takes the SAME ``MeetingRecurrence`` row lock
    (``FOR NO KEY UPDATE``) as materialization and virtual exclusion,
    with a re-check under the lock: the final persisted state can
    never be "Meeting cancelled but no exclusion" or "exclusion
    created but Meeting still active", and a racing concurrent
    exclusion is reused rather than duplicated. No new locking
    architecture is introduced.

    Inconsistent-pair repair: if an exclusion for the same occurrence
    already exists while the Meeting is still active (a state the
    normal domain flows prevent), the existing exclusion is REUSED and
    the Meeting cancellation completes — no duplicate exclusion.

    IDEMPOTENT: cancelling the same already-cancelled Meeting again
    returns the same Meeting row and the same exclusion row, keeps
    the status cancelled, changes no content, and records NO further
    ``meeting.cancelled`` event (if the exclusion were missing — a
    state this operation itself cannot produce — it is re-created as
    part of the replay, converging to the canonical final state).

    Audit: exactly ONE ``meeting.cancelled`` event is recorded for the
    first successful cancellation, inside the same transaction as the
    status change and the exclusion (a rollback leaves no orphaned
    event); an idempotent replay records none. No recurrence-wide
    audit taxonomy is introduced.
    """
    if meeting.pk is None:
        raise MeetingDomainError(
            "Only persisted Meetings can be cancelled."
        )

    # Canonical scoped Meeting write rule — the same rule every other
    # Meeting mutation enforces.
    _require_meeting_write_access(meeting=meeting, user=actor)

    # The locked row is a separate instance; the caller's instance is
    # refreshed at the end so it reflects the authoritative state
    # (same convention as start/end/reopen).
    caller_meeting = meeting

    with transaction.atomic():
        # Serialize against concurrent lifecycle transitions,
        # cancellation, and deletion on this Meeting, then re-read the
        # authoritative state under the lock.
        meeting = Meeting.objects.select_for_update().get(pk=meeting.pk)

        if meeting.recurrence_id is None or (
            meeting.original_scheduled_at is None
        ):
            raise MeetingDomainError(
                "Cancellation applies to a materialized recurring "
                "occurrence: this Meeting has no recurrence "
                "provenance."
            )

        already_cancelled = (
            meeting.status == Meeting.Status.CANCELLED
        )
        if not already_cancelled and (
            meeting.status != Meeting.Status.UPCOMING
        ):
            raise MeetingDomainError(
                "Only an upcoming Meeting can be cancelled: live and "
                "completed Meetings cannot be cancelled."
            )

        # Ensure exactly ONE exclusion keyed by the immutable original
        # occurrence. The re-check under the Slice-6 recurrence row
        # lock reuses a racing exclusion instead of duplicating it.
        exclusion = MeetingRecurrenceExclusion.objects.filter(
            recurrence_id=meeting.recurrence_id,
            original_scheduled_at=meeting.original_scheduled_at,
        ).first()
        if exclusion is None:
            # ``FOR NO KEY UPDATE`` (not ``FOR UPDATE``): the same
            # Slice-6 invariant as materialization / virtual
            # exclusion — it serializes the domain writers without
            # deadlocking against an in-flight raw Meeting insert's
            # deferred FK ``FOR KEY SHARE`` check.
            MeetingRecurrence.objects.select_for_update(no_key=True).get(
                pk=meeting.recurrence_id
            )
            exclusion = MeetingRecurrenceExclusion.objects.filter(
                recurrence_id=meeting.recurrence_id,
                original_scheduled_at=meeting.original_scheduled_at,
            ).first()
            if exclusion is None:
                exclusion = MeetingRecurrenceExclusion.objects.create(
                    recurrence_id=meeting.recurrence_id,
                    original_scheduled_at=meeting.original_scheduled_at,
                    created_by=actor,
                )

        if already_cancelled:
            # Idempotent replay: same Meeting row, same exclusion row,
            # status stays cancelled, no content changes, no event.
            caller_meeting.refresh_from_db()
            return caller_meeting

        # Terminal transition. Only ``status`` (and ``updated_at``)
        # changes: every provenance and content field is preserved.
        meeting.status = Meeting.Status.CANCELLED
        meeting.save(update_fields=["status", "updated_at"])

        # Recorded inside the same atomic block as the status change
        # and the exclusion: a rollback leaves no orphaned event, and
        # the idempotent replay path above never reaches this point.
        record_audit_event(
            research_group=meeting.research_group,
            actor=actor,
            event_type=MeetingAuditEventType.CANCELLED,
            project=meeting.project,
            meeting=meeting,
            data={
                "changes": {
                    "originalScheduledAt": _iso8601_utc(
                        meeting.original_scheduled_at,
                    ),
                    "scheduledAt": _iso8601_utc(meeting.scheduled_at),
                }
            },
        )

    caller_meeting.refresh_from_db()
    return caller_meeting


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


def _snapshot_series_sections(*, meeting, meeting_series):
    """Instantiate the Template's active Sections into one Meeting.

    The canonical Template-instantiation logic shared by
    ``create_meeting_from_series`` and recurrence-occurrence
    materialization: only ACTIVE Template Sections are copied into
    occurrence-level ``MeetingSection`` snapshots (Template order:
    position, then id), and every snapshot keeps its
    ``source_series_section`` provenance pointer. After the snapshot
    the occurrence structure is independent of the Template: later
    Template edits never rewrite an existing Meeting.
    """
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


@transaction.atomic
def create_meeting_from_series(
    *,
    meeting_series,
    actor,
    title=None,
    scheduled_at=None,
    status=None,
    participants=(),
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

    _create_initial_meeting_participants(
        meeting=meeting,
        actor=actor,
        participants=participants,
    )

    # Snapshot the active Template Sections (canonical
    # Template-instantiation logic, shared with recurrence
    # materialization).
    _snapshot_series_sections(
        meeting=meeting,
        meeting_series=meeting_series,
    )

    # Recorded inside the same atomic block: if anything above rolls
    # back, no AuditEvent survives either. The section snapshots are
    # internal structure of the creation operation and produce no
    # separate events.
    record_audit_event(
        research_group=meeting.research_group,
        actor=actor,
        event_type=MeetingAuditEventType.CREATED,
        project=meeting.project,
        meeting=meeting,
        data={},
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
    participants=(),
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

    _create_initial_meeting_participants(
        meeting=meeting,
        actor=actor,
        participants=participants,
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

    # The default Section is internal structure of the creation
    # operation, not an agenda mutation: it produces no separate event.
    record_audit_event(
        research_group=meeting.research_group,
        actor=actor,
        event_type=MeetingAuditEventType.CREATED,
        project=meeting.project,
        meeting=meeting,
        data={},
    )

    return meeting


def _create_initial_meeting_participants(
    *,
    meeting,
    actor,
    participants,
):
    """Add the creator and unique initial participants to a Meeting."""
    participants_by_id = {actor.pk: actor}
    for participant in participants:
        participants_by_id[participant.pk] = participant

    MeetingParticipant.objects.bulk_create([
        MeetingParticipant(meeting=meeting, user=participant)
        for participant in participants_by_id.values()
    ])


def add_meeting_participant(
    *,
    meeting,
    actor,
    target_user,
):
    _require_can_meet_participant_adder(
        meeting=meeting,
        user=actor,
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
    record_activity=True,
):
    """Create one agenda item in a Meeting Section.

    ``record_activity`` is an internal emission switch: when another
    domain operation creates an item as an internal step of its own
    logical action (e.g. follow-up scheduling materializes the target
    item), it passes ``record_activity=False`` so the single logical
    operation records exactly one Activity event.
    """
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

    item = MeetingItem.objects.create(
        meeting=meeting,
        meeting_section=meeting_section,
        title=title,
        notes=notes.strip(),
        position=position,
        created_by=actor,
    )

    if record_activity:
        # The position allocation above is an internal ordering detail,
        # not part of the event payload. Recorded inside the same atomic
        # block: a rollback leaves no orphaned event.
        record_audit_event(
            research_group=meeting.research_group,
            actor=actor,
            event_type=MeetingAuditEventType.AGENDA_ITEM_ADDED,
            project=meeting.project,
            meeting=meeting,
            data={
                "changes": {
                    "agendaItem": {
                        "id": item.pk,
                        "title": item.title,
                    }
                }
            },
        )

    return item


@transaction.atomic
def schedule_meeting_item_follow_up(
    *,
    source_meeting_item,
    target_meeting,
    target_meeting_section,
    actor,
):
    """Schedule one source item into an existing upcoming Meeting.

    The source item remains historical. A successful first call appends a
    distinct, open MeetingItem to the explicit target Section, records the
    concrete source-to-target trace, and only then marks the source outcome
    as follow_up. If the source was current when the locked operation began,
    current advances to the next later open agenda item. Repeating the same
    active schedule returns its existing trace without advancing again;
    choosing a different target requires a later reschedule action.
    """
    source_meeting_id = (
        MeetingItem.objects
        .values_list("meeting_id", flat=True)
        .get(pk=source_meeting_item.pk)
    )
    locked_meetings = {
        meeting.pk: meeting
        for meeting in (
            Meeting.objects
            .select_for_update()
            .filter(pk__in={source_meeting_id, target_meeting.pk})
            .order_by("pk")
        )
    }
    source_meeting = locked_meetings[source_meeting_id]
    target_meeting = locked_meetings[target_meeting.pk]
    source_meeting_item = (
        MeetingItem.objects
        .select_for_update()
        .get(pk=source_meeting_item.pk)
    )
    target_meeting_section = MeetingSection.objects.get(
        pk=target_meeting_section.pk,
    )

    _require_meeting_write_access(
        meeting=source_meeting,
        user=actor,
    )
    _require_meeting_write_access(
        meeting=target_meeting,
        user=actor,
    )

    if source_meeting.pk == target_meeting.pk:
        raise MeetingDomainError(
            "The source Meeting cannot be the follow-up target."
        )

    if target_meeting_section.meeting_id != target_meeting.pk:
        raise MeetingDomainError(
            "The Section does not belong to the target Meeting."
        )

    active_follow_up = (
        MeetingItemFollowUp.objects
        .filter(source_meeting_item=source_meeting_item)
        .exclude(status=MeetingItemFollowUp.Status.CANCELLED)
        .first()
    )
    if active_follow_up is not None:
        if (
            active_follow_up.target_meeting_id == target_meeting.pk
            and active_follow_up.target_meeting_section_id
            == target_meeting_section.pk
        ):
            return active_follow_up
        raise MeetingFollowUpConflictError(
            "This Meeting item is already scheduled for follow-up."
        )

    was_current = (
        source_meeting.current_meeting_item_id == source_meeting_item.pk
    )

    if target_meeting.status != Meeting.Status.UPCOMING:
        raise MeetingDomainError(
            "A follow-up target must be an upcoming Meeting."
        )

    if not target_meeting_section.is_visible:
        raise MeetingDomainError(
            "A follow-up target Section must be visible."
        )

    # The target item is an internal step of the scheduling operation:
    # the logical action is "follow-up scheduled", so it records its own
    # event below and no separate agenda_item_added event.
    target_meeting_item = create_meeting_item(
        meeting=target_meeting,
        meeting_section=target_meeting_section,
        actor=actor,
        title=source_meeting_item.title,
        record_activity=False,
    )
    follow_up = MeetingItemFollowUp.objects.create(
        source_meeting_item=source_meeting_item,
        target_meeting=target_meeting,
        target_meeting_section=target_meeting_section,
        target_meeting_item=target_meeting_item,
        # The target item was just created by this operation with a
        # known clean state (no notes, no work links, not_discussed
        # outcome, title copied from source, position = max+1).
        target_pristine=True,
        target_item_created_position=target_meeting_item.position,
        status=MeetingItemFollowUp.Status.SCHEDULED,
        created_by=actor,
    )

    # One event for the whole logical operation, anchored to the target
    # Meeting (the occurrence the follow-up was scheduled INTO). The
    # event's Research Group / Project scope is the target Meeting's
    # scope; the source Meeting is referenced structurally. The flat
    # data["sourceMeetingId"] is the stable machine reference the
    # Activity feed uses to also require source-Meeting readability
    # (the event references source Meeting metadata, so a reader must
    # be able to read BOTH Meetings — no metadata leak).
    record_audit_event(
        research_group=target_meeting.research_group,
        actor=actor,
        event_type=MeetingAuditEventType.FOLLOW_UP_SCHEDULED,
        project=target_meeting.project,
        meeting=target_meeting,
        data={
            "sourceMeetingId": source_meeting.pk,
            "changes": {
                "followUp": {
                    "sourceMeeting": {
                        "id": source_meeting.pk,
                        "title": source_meeting.title,
                    },
                    "sourceItem": {
                        "id": source_meeting_item.pk,
                        "title": source_meeting_item.title,
                    },
                    "targetSection": {
                        "id": target_meeting_section.pk,
                        "name": target_meeting_section.name,
                    },
                    "targetItem": {
                        "id": target_meeting_item.pk,
                        "title": target_meeting_item.title,
                    },
                }
            },
        },
    )

    source_meeting_item.outcome = MeetingItem.Outcome.FOLLOW_UP
    source_meeting_item.save(update_fields=["outcome", "updated_at"])
    if was_current:
        _advance_current_to_next_not_discussed(
            meeting=source_meeting,
            resolved_pk=source_meeting_item.pk,
        )
    return follow_up


# ── Follow-up cancellation ─────────────────────────────────────


@transaction.atomic
def cancel_meeting_item_follow_up(*, follow_up_id, actor):
    """Cancel a concrete scheduled follow-up by its FollowUp ID.

    Product rule: ``follow_up + scheduled → not_discussed + cancelled``.

    Cancellation is a reversal operation, NOT a resolving operation.
    It NEVER advances, reconciles, or changes the Meeting's current
    pointer.

    Atomicity and locking follow the same convention as
    ``schedule_meeting_item_follow_up``: lock both the source and
    target Meetings (in pk order), then the source item, then the
    follow-up record — all before any mutation.

    Behaviour:
    - Already-cancelled FollowUp: idempotent, returns the record.
      Does not alter any other record.
    - Active scheduled FollowUp:
        1. Requires source.outcome == follow_up and the relation is
           the active (non-cancelled) one for that source; otherwise
           rejects with MeetingDomainError.
        2. Requires the target Meeting to still be ``upcoming``;
           otherwise rejects with MeetingDomainError (no mutation).
        3. Changes FollowUp.status → cancelled.
        4. Changes source.outcome → not_discussed.
        5. If the generated target item is provably untouched AND the
           actor has write access to the target Meeting, deletes the
           target item.  Otherwise preserves it.
        6. Never changes ``Meeting.current_meeting_item``.
    """
    # Resolve the follow-up up-front to get both Meeting pks.
    follow_up = MeetingItemFollowUp.objects.filter(
        pk=follow_up_id,
    ).select_related(
        "source_meeting_item__meeting",
        "target_meeting",
    ).first()

    if follow_up is None:
        raise MeetingDomainError("Follow-up not found.")

    source_meeting_pk = (
        MeetingItem.objects
        .values_list("meeting_id", flat=True)
        .get(pk=follow_up.source_meeting_item_id)
    )

    # Lock both Meetings in deterministic pk order, matching the
    # scheduling lock convention.
    locked_meetings = {
        meeting.pk: meeting
        for meeting in (
            Meeting.objects
            .select_for_update()
            .filter(pk__in={source_meeting_pk, follow_up.target_meeting_id})
            .order_by("pk")
        )
    }
    source_meeting = locked_meetings[source_meeting_pk]
    target_meeting = locked_meetings[follow_up.target_meeting_id]

    # Lock the follow-up row (prevents concurrent double-cancel).
    follow_up = MeetingItemFollowUp.objects.select_for_update().get(
        pk=follow_up.pk,
    )

    # ── Write permission on source context ─────────────────────────
    # This check MUST precede the idempotent early-return below:
    # an unauthorized actor must not be able to receive the
    # "already cancelled" success path without canonical source
    # authorization.
    _require_meeting_write_access(meeting=source_meeting, user=actor)

    # ── Idempotent: already cancelled ─────────────────────────────
    if follow_up.status == MeetingItemFollowUp.Status.CANCELLED:
        return follow_up

    # ── Source state consistency ───────────────────────────────────
    # The source item must still reflect the scheduled relation.
    source_item = MeetingItem.objects.select_for_update().get(
        pk=follow_up.source_meeting_item_id,
    )

    if follow_up.status != MeetingItemFollowUp.Status.SCHEDULED:
        raise MeetingDomainError(
            "Only a scheduled follow-up can be cancelled."
        )

    if source_item.outcome != MeetingItem.Outcome.FOLLOW_UP:
        raise MeetingDomainError(
            "The source item is not in a follow-up state; "
            "cancellation is not consistent with the persisted state."
        )

    # Confirm this is the active (non-cancelled) follow-up for the source.
    active = (
        MeetingItemFollowUp.objects
        .filter(source_meeting_item=source_item)
        .exclude(status=MeetingItemFollowUp.Status.CANCELLED)
        .exclude(pk=follow_up.pk)
        .exists()
    )
    if active:
        raise MeetingDomainError(
            "Another active follow-up exists for this source; "
            "cannot cancel a stale relation."
        )

    # ── Target Meeting must still be upcoming ─────────────────────
    if target_meeting.status != Meeting.Status.UPCOMING:
        raise MeetingDomainError(
            "The target Meeting is no longer upcoming; "
            "cancellation is rejected without mutation."
        )

    # ── Perform the cancellation mutations ─────────────────────────
    # Capture the pristine flag BEFORE we clear it.
    was_pristine = follow_up.target_pristine

    follow_up.status = MeetingItemFollowUp.Status.CANCELLED
    follow_up.save(update_fields=["status", "updated_at"])

    source_item.outcome = MeetingItem.Outcome.NOT_DISCUSSED
    source_item.save(update_fields=["outcome", "updated_at"])

    # ── Target cleanup: delete only if provably untouched AND
    #     the actor can write the target Meeting ────────────────────
    if follow_up.target_meeting_item_id is not None:
        target_item = MeetingItem.objects.select_for_update().filter(
            pk=follow_up.target_meeting_item_id,
        ).first()

        has_target_write = True
        try:
            _require_meeting_write_access(meeting=target_meeting, user=actor)
        except MeetingDomainError:
            has_target_write = False

        if target_item is not None and has_target_write and was_pristine:
            # Re-verify the item's persisted state is still clean
            # (defence in depth: catches any drift after scheduling).
            if (
                target_item.outcome == MeetingItem.Outcome.NOT_DISCUSSED
                and target_item.title == source_item.title
                and not target_item.notes
                and not target_item.note_relations.exists()
                and not target_item.work_item_relations.exists()
                and (
                    follow_up.target_meeting_section_id is None
                    or target_item.meeting_section_id
                    == follow_up.target_meeting_section_id
                )
                and (
                    follow_up.target_item_created_position is None
                    or target_item.position
                    == follow_up.target_item_created_position
                )
            ):
                # Clear the follow-up's target reference before
                # deletion so the cancelled trace survives.
                follow_up.target_meeting_item = None
                follow_up.target_pristine = False
                follow_up.save(
                    update_fields=[
                        "target_meeting_item",
                        "target_pristine",
                        "updated_at",
                    ],
                )
                target_item.delete()
            else:
                # Target was mutated; preserve it and clear the
                # pristine flag.
                follow_up.target_pristine = False
                follow_up.save(
                    update_fields=["target_pristine", "updated_at"],
                )
        elif target_item is not None:
            # Cannot delete (no write access or item missing):
            # clear the pristine flag to be conservative.
            follow_up.target_pristine = False
            follow_up.save(
                update_fields=["target_pristine", "updated_at"],
            )
    else:
        # No target item reference (should not happen for a
        # scheduled follow-up, but handle gracefully).
        follow_up.target_pristine = False
        follow_up.save(
            update_fields=["target_pristine", "updated_at"],
        )

    return follow_up


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


@transaction.atomic
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

    A real date-time change records exactly one structured
    ``meeting.rescheduled`` event inside this transaction; a title-only
    or no-op update records no Meeting Activity event.
    """
    _require_meeting_write_access(meeting=meeting, user=actor)

    previous_scheduled_at = meeting.scheduled_at

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

    # One logical reschedule = one event, with the previous/new
    # scheduled datetime as structured values. A title change is not a
    # tracked Meeting Activity aspect, and re-sending the same date-time
    # is a no-op: neither produces an event.
    if (
        scheduled_at is not None
        and _iso8601_utc(meeting.scheduled_at)
        != _iso8601_utc(previous_scheduled_at)
    ):
        record_audit_event(
            research_group=meeting.research_group,
            actor=actor,
            event_type=MeetingAuditEventType.RESCHEDULED,
            project=meeting.project,
            meeting=meeting,
            data={
                "changes": {
                    "scheduledAt": {
                        "from": _iso8601_utc(previous_scheduled_at),
                        "to": _iso8601_utc(meeting.scheduled_at),
                    }
                }
            },
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

    # If the Meeting already has a valid current item, preserve it.
    # Otherwise the first not_discussed item in canonical agenda
    # order becomes current; a Meeting without such an item goes
    # Live with no current item. Starting never mutates any item's
    # outcome.
    current_item = (
        MeetingItem.objects
        .filter(pk=meeting.current_meeting_item_id, meeting=meeting)
        .first()
    )
    if current_item is None:
        _select_first_not_discussed_for_meeting(meeting=meeting)

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

    # The current pointer is NOT a blocking "discussion in
    # progress" status: remaining not_discussed items are allowed,
    # and the current pointer is cleared when the Meeting ends.
    meeting.status = Meeting.Status.COMPLETED
    meeting.ended_at = timezone.now()
    meeting.current_meeting_item_id = None
    meeting.save(
        update_fields=["status", "ended_at", "current_meeting_item_id", "updated_at"],
    )

    # Recorded inside the same atomic block as the lifecycle
    # transition: a rollback leaves no orphaned event.
    record_audit_event(
        research_group=meeting.research_group,
        actor=actor,
        event_type=MeetingAuditEventType.COMPLETED,
        project=meeting.project,
        meeting=meeting,
        data={
            "changes": {
                "endedAt": _iso8601_utc(meeting.ended_at),
            }
        },
    )

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

    # If current is null and not_discussed items are left, the first
    # one in canonical agenda order becomes current; otherwise
    # current may remain null. done / follow_up outcomes are never
    # changed.
    if meeting.current_meeting_item_id is None:
        _select_first_not_discussed_for_meeting(meeting=meeting)

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

    Recurring-occurrence guard: a Meeting with recurrence provenance
    (``recurrence`` set — materialized from a MeetingRecurrence
    occurrence) is REJECTED with a domain error and left completely
    unchanged. Recurrence-aware cancellation (see
    ``cancel_meeting_recurrence_occurrence``) is the way to remove ONE
    materialized occurrence while preserving the Meeting's
    content/history; the generic hard-delete path must not be able to
    bypass it. Standalone (non-recurring) Meetings keep the existing
    hard-delete semantics unchanged.
    """
    _require_meeting_write_access(meeting=meeting, user=actor)

    # Serialize against concurrent lifecycle transitions on this Meeting.
    Meeting.objects.select_for_update().get(pk=meeting.pk)
    meeting.refresh_from_db()

    # Recurrence provenance guard: a Meeting materialized from a
    # MeetingRecurrence occurrence must not be destroyed through the
    # generic hard-delete path. Cancellation is the recurrence-aware
    # way to remove ONE occurrence (it preserves the Meeting row, its
    # content/history, and the occurrence identity via the exclusion);
    # a permanent deletion would bypass all of that. Standalone
    # (non-recurring) Meetings keep the ordinary hard-delete behavior.
    if meeting.recurrence_id is not None:
        raise MeetingDomainError(
            "A recurring Meeting cannot be permanently deleted: use "
            "recurrence-aware cancellation instead."
        )

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
):
    """Update only the free-form MeetingItem fields.

    Status transitions are exclusively driven by the canonical
    domain actions (start / focus / done / follow-up / reopen);
    a generic PATCH must never bypass the Live MeetingItem state
    machine, so ``status`` is not an accepted field here.
    """
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

    if update_fields:
        update_fields.append("updated_at")
        meeting_item.save(
            update_fields=update_fields,
        )

    return meeting_item


# ── Live Meeting current pointer + item outcomes ────────────────
#
# Two distinct concepts:
# - "current" is persisted on the Meeting (current_meeting_item): the
#   official agenda item the group is currently discussing.
# - "outcome" is persisted on the MeetingItem (not_discussed / done /
#   follow_up).
#
# Changing current never changes any item's outcome, and resolving
# an item never implicitly repositions current except via the
# documented advance rule.


def _set_current_item(*, meeting, item_pk):
    """Point the Meeting's current pointer at ``item_pk``.

    The caller must hold the Meeting row lock. The referenced item
    must belong to the Meeting; cross-Meeting assignment is
    rejected here (defense in depth on top of the API surface).
    """
    item = (
        MeetingItem.objects.filter(
            pk=item_pk,
            meeting=meeting,
        )
        .first()
    )
    if item is None:
        raise MeetingDomainError(
            "The item does not belong to this Meeting."
        )

    meeting.current_meeting_item = item
    meeting.save(update_fields=["current_meeting_item_id", "updated_at"])
    return item


@transaction.atomic
def focus_meeting_item(*, meeting_item, actor):
    """Make one item the current item of a Live Meeting.

    Only valid while the Meeting is Live. The target may have ANY
    outcome (not_discussed / done / follow_up): focusing is
    navigation, it never implies completion and never clears a
    historical outcome. The previous current item (if any) keeps
    whatever outcome it already had — switching current never
    implicitly completes the previous item.
    """
    meeting = meeting_item.meeting
    _require_meeting_write_access(meeting=meeting, user=actor)
    _require_live_meeting(meeting=meeting)

    # Serialize against concurrent focus/done/follow-up/end actions
    # on this Meeting.
    Meeting.objects.select_for_update().get(pk=meeting.pk)
    meeting.refresh_from_db()
    _require_live_meeting(meeting=meeting)

    meeting_item.refresh_from_db()
    if meeting_item.meeting_id != meeting.pk:
        raise MeetingDomainError(
            "The item does not belong to this Meeting."
        )

    _set_current_item(
        meeting=meeting,
        item_pk=meeting_item.pk,
    )
    return meeting_item


def _ordered_meeting_items(*, meeting):
    """All of the Meeting's items in canonical agenda order:
    Section.position, then item position (unique within a section),
    then id."""
    return (
        MeetingItem.objects
        .filter(meeting=meeting)
        .select_related("meeting_section")
        .order_by(
            "meeting_section__position",
            "meeting_section__id",
            "position",
            "id",
        )
    )


def _advance_current_to_next_not_discussed(
    *, meeting, resolved_pk, wrap=False,
):
    """Advance the Meeting's current pointer to the next open item
    after the one that was just resolved.

    The successor is the first ``not_discussed`` item strictly AFTER
    ``resolved_pk`` in canonical agenda order (which spans section
    boundaries). ``done`` / ``follow_up`` items are skipped. If no
    later open item exists, the Meeting has no current item. The
    legacy direct follow-up outcome action may request its historical
    one-time wrap behavior. The caller must hold the Meeting row lock;
    no item outcome is mutated here.
    """
    ordered_items = list(_ordered_meeting_items(meeting=meeting))
    order = [item.pk for item in ordered_items]
    if resolved_pk not in order:
        raise MeetingDomainError(
            "The item does not belong to this Meeting."
        )

    index = order.index(resolved_pk)
    candidates = ordered_items[index + 1:]
    if wrap:
        candidates += ordered_items[:index]
    for candidate in candidates:
        if candidate.outcome == MeetingItem.Outcome.NOT_DISCUSSED:
            _set_current_item(
                meeting=meeting,
                item_pk=candidate.pk,
            )
            return

    meeting.current_meeting_item = None
    meeting.save(update_fields=["current_meeting_item_id", "updated_at"])


def _resolve_item_outcome(
    *, meeting_item, actor, outcome, wrap_after_resolved=False,
):
    """Set an explicit outcome on a MeetingItem of a Live Meeting.

    The action is valid for any item of the Meeting — Done and
    Follow-up do not require the item to be current. A previously
    done item may later become follow_up explicitly (and vice
    versa). When the resolved item IS the Meeting's current item,
    the current pointer advances to the next later not_discussed item;
    otherwise the pointer is left unchanged. The legacy direct
    follow-up action retains its historical one-time wrap behavior.
    """
    meeting = meeting_item.meeting
    _require_meeting_write_access(meeting=meeting, user=actor)
    _require_live_meeting(meeting=meeting)

    # Serialize against concurrent focus/done/follow-up/end actions
    # on this Meeting.
    Meeting.objects.select_for_update().get(pk=meeting.pk)
    meeting.refresh_from_db()
    _require_live_meeting(meeting=meeting)

    meeting_item.refresh_from_db()
    if meeting_item.meeting_id != meeting.pk:
        raise MeetingDomainError(
            "The item does not belong to this Meeting."
        )

    was_current = (
        meeting.current_meeting_item_id == meeting_item.pk
    )
    if was_current:
        meeting.refresh_from_db()
        was_current = (
            meeting.current_meeting_item_id == meeting_item.pk
        )

    meeting_item.outcome = outcome
    meeting_item.save(update_fields=["outcome", "updated_at"])

    if was_current:
        _advance_current_to_next_not_discussed(
            meeting=meeting,
            resolved_pk=meeting_item.pk,
            wrap=wrap_after_resolved,
        )
        meeting.refresh_from_db()

    return meeting_item


@transaction.atomic
def mark_meeting_item_done(*, meeting_item, actor):
    """Mark one item done: item.outcome = "done".

    Done does not require the item to be current. When the
    resolved item IS the Meeting's current item, current advances
    to the next later not_discussed item in canonical agenda order;
    when none exists, current becomes null.
    A non-current item's Done leaves current unchanged.
    """
    return _resolve_item_outcome(
        meeting_item=meeting_item,
        actor=actor,
        outcome=MeetingItem.Outcome.DONE,
    )


@transaction.atomic
def reopen_meeting_item(*, meeting_item, actor):
    """Reopen one done item without changing the Meeting's current item.

    This is an outcome correction only. It deliberately does not use the
    resolving helper or reconcile the current pointer, including when
    persisted data points Current at the done item being reopened.
    """
    meeting = meeting_item.meeting
    _require_meeting_write_access(meeting=meeting, user=actor)
    _require_live_meeting(meeting=meeting)

    # Serialize against concurrent focus/done/follow-up/end actions while
    # preserving the current pointer exactly as stored.
    Meeting.objects.select_for_update().get(pk=meeting.pk)
    meeting.refresh_from_db()
    _require_live_meeting(meeting=meeting)

    meeting_item.refresh_from_db()
    if meeting_item.meeting_id != meeting.pk:
        raise MeetingDomainError(
            "The item does not belong to this Meeting."
        )
    if meeting_item.outcome != MeetingItem.Outcome.DONE:
        raise MeetingDomainError(
            "Only a done Meeting item can be reopened."
        )

    meeting_item.outcome = MeetingItem.Outcome.NOT_DISCUSSED
    meeting_item.save(update_fields=["outcome", "updated_at"])
    return meeting_item


@transaction.atomic
def mark_meeting_item_follow_up(*, meeting_item, actor):
    """Mark one item as a follow-up: item.outcome = "follow_up".

    Same current-pointer rule as Done: when the resolved item IS
    the Meeting's current item, current advances to the next
    not_discussed item (wrapping once); a non-current item's
    follow-up leaves current unchanged. A previously done item may
    later become follow_up explicitly. Durable carry-forward is a
    separate future concern.
    """
    return _resolve_item_outcome(
        meeting_item=meeting_item,
        actor=actor,
        outcome=MeetingItem.Outcome.FOLLOW_UP,
        wrap_after_resolved=True,
    )


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
