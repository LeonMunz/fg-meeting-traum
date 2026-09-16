"""Home "Continue working" — LIMITED V1 personal recency read model.

This module provides the reusable backend read service that derives,
for one authenticated user, the complete LIMITED V1
``Continue working`` candidate list over the two supported V1 object
types: **Work Items** and **Meetings**.

``Continue working`` means **recent personal persisted mutation** —
NOT "last opened". Existing persistence can reliably identify only
the current user's own attributable persisted actions. It cannot
identify last opened / last viewed, passive Meeting attendance,
navigation history, or edit sessions without attributable
persistence; none of those is a V1 signal (last-opened tracking
remains unimplemented).

Supported V1 qualifying signals (the existing actor-attributed
Activity family only — the event system is NOT expanded for this
read model):

- **Work Items** — the user is the ``actor`` of at least one
  supported Work Item ``AuditEvent``:

  - ``work_item.created``
  - ``work_item.updated``

  (one event per logical operation; a pure within-column Board
  reorder and a label-only change record no event at all, so they
  are not personal actions by construction).
- **Meetings** — the user is the ``actor`` of one of the existing
  attributable Meeting event types:

  - ``meeting.created``
  - ``meeting.rescheduled``
  - ``meeting.completed``
  - ``meeting.agenda_item_added``
  - ``meeting.follow_up_scheduled``

  ``meeting.follow_up_scheduled`` is anchored to the **target**
  Meeting (the event's ``meeting`` FK); it may contribute personal
  recency to the target Meeting only, the candidate exposes only
  the target Meeting, and current read access to the target is
  mandatory. Source Meeting metadata is never exposed here:
  unlike the Activity feed, no source-Meeting readability is
  consulted because no source-related event semantics are
  projected (the user is the actor of the event, and only the
  continuation object plus the user's own action timestamp are
  surfaced).
- **Meeting Note creation** — the user **authored** a
  ``MeetingNote`` (``author == user``); the Note's
  ``created_at`` is the personal-action timestamp and the Note maps
  to its parent Meeting. A Meeting Note is never a standalone Home
  candidate. ``MeetingNote.updated_at`` is deliberately NOT used:
  Note edits are not editor-attributed.

Explicitly NOT V1 signals (documented unsupported interactions —
never inferred from generic timestamps, never added here):

- Work Item comments (never recorded as events),
- label-only Work Item changes (no event recorded),
- being assigned by another user (receiving an assignment is
  someone else's action),
- pure within-column Board reorder (no event recorded),
- object reads / opens (no persistence exists),
- passive Meeting participation / invitations,
- Meeting start / reopen, participant add/remove,
- MeetingItem outcome transitions, section changes,
- Meeting Note edits,
- actual attendance / presence.

Qualification requires, in addition to a personal action, that the
object is **live** and that the user can read it **today** through
the canonical read rule — historical action never grants current
visibility, and an inaccessible object produces **no candidate row
at all** (no title, timestamp, or metadata leak):

- **Work Item read** — the identical current-membership boundary of
  the Activity feed and Work Item reads: current
  ``ProjectMembership`` (any role — owner/member/viewer all grant
  ``PROJECT_READ``) in the Work Item's Project AND current
  ``ResearchGroupMembership`` in the Project's Research Group.
  Losing either membership removes the candidate immediately;
  deleted Work Items fail closed.
- **Meeting read** — the canonical ``MEETING_READ`` rule: creator
  or explicit current ``MeetingParticipant``. Research Group or
  Project membership, ownership, admin status, or Meeting **write**
  access alone never grant a candidate. Losing Meeting read access
  (e.g. participant removal) removes historical candidates
  immediately; deleted Meetings fail closed.

Recency semantics:

- The personal-action timestamp is the event's ``created_at``
  (``AuditEvent.created_at``) or the authored Note's
  ``created_at`` — NEVER the object's generic ``updated_at``,
  current assignment, Project ownership, or another user's action.
- **Multiple personal actions collapse to one candidate** per
  ``(domain, object_id)`` using the LATEST qualifying personal
  timestamp.
- ``Continue working`` is recency-oriented, not
  responsibility-oriented: a currently readable Work Item remains a
  candidate when the user is no longer assigned, is assigned to
  someone else, or its status category is ``done``. Only current
  read authorization is required — Home "My work"'s
  active/assignment filters are deliberately NOT applied here.

No recency horizon exists for Continue working: none is invented.
The service returns the COMPLETE currently readable mutation-based
candidate set, with NO display row limit — the later Home
composition layer decides how many recent rows to show.

Candidate contract: a small structured representation — domain,
object ID, title, ``latest_personal_activity_at``, the current
access scope/context, and a domain-specific detail block (Work
Item: Project ID/name — current Work Item read implies Project read
— semantic status category, due date; Meeting: status,
``scheduled_at`` — only data safe under ``MEETING_READ``, no
Project names). The context is one stable additive structure for
both domains (``kind`` / ``id`` / ``name``): a Work Item candidate
carries its owning Project (kind ``project``) and a Meeting
candidate carries its owning Research Group (kind
``research_group``) — display metadata derived only from the
already-authorized candidate row, never an access grant. No raw
``AuditEvent`` payload, no source Meeting details, no rendered
sentences; the canonical object remains reachable by ID.

Deterministic ordering: one flat list sorted by
``latest_personal_activity_at`` DESC, then
``domain_rank`` (Work Item 0 < Meeting 1) as an exact-timestamp
tie-break only, then ``object_id`` ASC. No relevance scoring.

Query strategy: a fixed, small number of bounded queries
(independent of candidate count) — one aggregate of the user's
latest qualifying Work Item event per Work Item, one bounded fetch
of the currently readable live Work Items, one aggregate of the
user's latest qualifying Meeting event per Meeting, one aggregate of
the user's latest authored Note per parent Meeting, and one bounded
fetch of the currently readable live Meetings — followed by a
deterministic in-memory merge. No one-query-per-candidate, no
loading of every ``AuditEvent`` row, no N+1.

Bounded responsibility: this service provides candidates only, for
later Home composition. It is not exposed through HTTP yet.

Canonical domain reference: ``docs/domain/home.md``.
"""

from dataclasses import dataclass
from datetime import date, datetime

from django.db.models import F, Q
from django.db.models.aggregates import Max

from audit_history.models import AuditEvent
from meetings.models import Meeting, MeetingNote
from meetings.services import MeetingAuditEventType
from projects.models import ProjectMembership
from work_items.models import WorkItem
from work_items.services import WorkItemAuditEventType

# Stable machine-readable candidate domain codes.
DOMAIN_MEETING = "meeting"
DOMAIN_WORK_ITEM = "work_item"

# Exact-timestamp tie resolution only: Work Items sort before
# Meetings at the same ``latest_personal_activity_at``.
DOMAIN_RANK = {
    DOMAIN_WORK_ITEM: 0,
    DOMAIN_MEETING: 1,
}

# The V1 supported Work Item personal-action events: the existing
# actor-attributed Work Item Activity family (one event per logical
# operation). Deliberately NOT extended to comment, label, or
# reorder interactions (no V1 canonical personal-action event
# exists for them, and the event system is not broadened here).
# Stable machine-readable display-context kinds. One stable additive
# structure for both domains: Work Item → owning Project, Meeting →
# owning Research Group. Display metadata only — eligibility,
# authorization, ordering, and deduplication are never derived from
# it.
CONTEXT_KIND_PROJECT = "project"
CONTEXT_KIND_RESEARCH_GROUP = "research_group"


_WORK_ITEM_EVENT_TYPES = [
    WorkItemAuditEventType.CREATED,
    WorkItemAuditEventType.UPDATED,
]

# The V1 supported Meeting personal-action events: the existing
# attributable Meeting event types. ``FOLLOW_UP_SCHEDULED`` is
# anchored to the target Meeting; only the target is exposed.
# Deliberately NOT extended to Meeting start/reopen, participant
# changes, outcome transitions, section changes, or attendance.
_MEETING_EVENT_TYPES = [
    MeetingAuditEventType.CREATED,
    MeetingAuditEventType.RESCHEDULED,
    MeetingAuditEventType.COMPLETED,
    MeetingAuditEventType.AGENDA_ITEM_ADDED,
    MeetingAuditEventType.FOLLOW_UP_SCHEDULED,
]


@dataclass(frozen=True)
class ContinueWorkItemDetails:
    """Work Item-specific composition data.

    Current Work Item read implies Project read, so the Project
    identity/name is safe to attach.
    """

    work_item_id: int
    project_id: int
    project_name: str
    # Current semantic status category (todo / in_progress / review
    # / done): a ``done`` Work Item remains a candidate here —
    # Continue working is recency-oriented, not
    # responsibility-oriented.
    status_category: str
    due_date: date | None


@dataclass(frozen=True)
class ContinueMeetingDetails:
    """Meeting-specific composition data.

    Exposes only data safe under canonical ``MEETING_READ``. No
    Project names: Meeting read never implies Project read. No
    source Meeting data of any kind. The owning Research Group
    context (kind/id/name) is carried on the candidate itself —
    approved display metadata derived from the already-authorized
    Meeting row.
    """

    meeting_id: int
    status: str
    scheduled_at: datetime


@dataclass(frozen=True)
class ContinueContext:
    """Current access scope/context of one candidate (display metadata).

    - Work Item candidate → the owning Project (current Work Item read
      implies Project read), kind ``project``.
    - Meeting candidate → the owning Research Group (the Meeting row's
      own ``research_group`` relation), kind ``research_group``.

    The context is derived only from the candidate object itself,
    which the read model has already authorized as readable — it
    never widens eligibility, authorization, or ordering.
    """

    kind: str
    id: int
    name: str


@dataclass(frozen=True)
class ContinueWorkingCandidate:
    """One flat Continue-working candidate (Work Item or Meeting).

    Carries only what a later Home composition layer needs to
    render the candidate; the canonical object (and its full API
    representation) remains reachable through ``object_id``.
    ``latest_personal_activity_at`` is the current user's LATEST
    qualifying personal action for this object. ``context`` is the
    current access scope of the candidate (Work Item → owning
    Project; Meeting → owning Research Group).
    """

    domain: str
    object_id: int
    title: str
    latest_personal_activity_at: datetime
    details: ContinueWorkItemDetails | ContinueMeetingDetails
    context: ContinueContext


def _readable_project_ids(user):
    """Projects the user can read RIGHT NOW — the canonical Work Item
    read rule as one DB-level subquery (identical to the Activity
    feed's rule): current ``ProjectMembership`` (any role grants
    ``PROJECT_READ``) AND current ``ResearchGroupMembership`` in the
    Project's Research Group.
    """
    return (
        ProjectMembership.objects
        .filter(
            user=user,
            project__research_group__memberships__user=user,
        )
        .values_list("project_id", flat=True)
    )


def _readable_meeting_ids(user):
    """Meetings the user can read RIGHT NOW — the canonical
    ``MEETING_READ`` rule (creator-or-explicit-current-participant)
    as one DB-level subquery (identical to the Activity feed's and
    the Today-&-next rule). Group/Project membership, ownership,
    admin status, and Meeting write access grant nothing.
    """
    return (
        Meeting.objects
        .filter(Q(created_by=user) | Q(participant_relations__user=user))
        .values_list("pk", flat=True)
    )


def _work_item_candidates(*, user, readable_project_ids):
    """Latest qualifying personal Work Item action per Work Item,
    restricted to Work Items in currently readable Projects; then a
    single bounded fetch of the live, currently readable Work
    Items. Two queries, constant in candidate count.

    Deleted Work Items fail closed: the event's ``work_item`` FK is
    nulled by an allowed hard delete, and the live fetch re-checks
    current Project read authorization on the live row.
    """
    rows = (
        AuditEvent.objects
        .filter(
            actor=user,
            work_item__isnull=False,
            event_type__in=_WORK_ITEM_EVENT_TYPES,
            work_item__project_id__in=readable_project_ids,
        )
        .values("work_item_id")
        .annotate(latest=Max("created_at"))
    )
    latest_by_id = {
        row["work_item_id"]: row["latest"] for row in rows
    }
    if not latest_by_id:
        return []

    work_items = (
        WorkItem.objects
        .filter(
            pk__in=latest_by_id.keys(),
            project_id__in=readable_project_ids,
        )
        .select_related("project", "status_definition")
        .order_by("pk")
    )
    return [
        ContinueWorkingCandidate(
            domain=DOMAIN_WORK_ITEM,
            object_id=work_item.pk,
            title=work_item.title,
            latest_personal_activity_at=latest_by_id[work_item.pk],
            details=ContinueWorkItemDetails(
                work_item_id=work_item.pk,
                project_id=work_item.project_id,
                project_name=work_item.project.name,
                status_category=work_item.status_definition.category,
                due_date=work_item.due_date,
            ),
            context=ContinueContext(
                kind=CONTEXT_KIND_PROJECT,
                id=work_item.project_id,
                name=work_item.project.name,
            ),
        )
        for work_item in work_items
    ]


def _meeting_candidates(*, user, readable_meeting_ids):
    """Latest qualifying personal Meeting action per Meeting, merging
    the two V1 personal-action sources (attributable Meeting events
    and authored Meeting Notes) with the LATEST timestamp winning.
    Then a single bounded fetch of the live, currently readable
    Meetings. Three queries, constant in candidate count.

    - Meeting events include ``meeting.follow_up_scheduled``; the
      event's ``meeting`` FK IS the target Meeting, so the
      ``readable_meeting_ids`` predicate requires current read
      access to the target. No source Meeting readability is
      consulted and no source Meeting data is projected.
    - Note authorship (``author == user``) uses the Note's
      ``created_at``; ``updated_at`` is never used (Note edits are
      not editor-attributed). A Note maps to its parent Meeting; a
      Meeting Note is never a standalone candidate.

    Deleted Meetings fail closed: the event's ``meeting`` FK is
    nulled by an allowed hard delete, and the live fetch re-checks
    ``MEETING_READ`` on the live row.
    """
    latest_by_id: dict[int, datetime] = {}

    event_rows = (
        AuditEvent.objects
        .filter(
            actor=user,
            meeting__isnull=False,
            event_type__in=_MEETING_EVENT_TYPES,
            meeting_id__in=readable_meeting_ids,
        )
        .values("meeting_id")
        .annotate(latest=Max("created_at"))
    )
    for row in event_rows:
        latest_by_id[row["meeting_id"]] = row["latest"]

    note_rows = (
        MeetingNote.objects
        .filter(
            author=user,
            meeting_item__meeting_id__in=readable_meeting_ids,
        )
        .values(meeting_id=F("meeting_item__meeting_id"))
        .annotate(latest=Max("created_at"))
    )
    for row in note_rows:
        meeting_id = row["meeting_id"]
        latest = row["latest"]
        current = latest_by_id.get(meeting_id)
        if current is None or latest > current:
            latest_by_id[meeting_id] = latest

    if not latest_by_id:
        return []

    meetings = (
        Meeting.objects
        .filter(
            Q(pk__in=latest_by_id.keys())
            & (Q(created_by=user) | Q(participant_relations__user=user)),
        )
        .distinct()
        .select_related("research_group")
        .order_by("pk")
    )
    return [
        ContinueWorkingCandidate(
            domain=DOMAIN_MEETING,
            object_id=meeting.pk,
            title=meeting.title,
            latest_personal_activity_at=latest_by_id[meeting.pk],
            details=ContinueMeetingDetails(
                meeting_id=meeting.pk,
                status=meeting.status,
                scheduled_at=meeting.scheduled_at,
            ),
            context=ContinueContext(
                kind=CONTEXT_KIND_RESEARCH_GROUP,
                id=meeting.research_group_id,
                name=meeting.research_group.name,
            ),
        )
        for meeting in meetings
    ]


def get_continue_working_candidates(*, user) -> list[ContinueWorkingCandidate]:
    """Return the current user's complete LIMITED V1 ``Continue
    working`` candidate list (Work Items + Meetings).

    A candidate exists iff the user has at least one qualifying
    personal persisted mutation on the object (see module
    docstring for the exact V1 signal set), the object is still
    live, and the user can read the object TODAY through its
    canonical read rule. Multiple personal actions on one object
    collapse to one candidate carrying the latest qualifying
    personal timestamp.

    No recency horizon, no display row limit, no relevance
    scoring: the later Home composition layer decides how many
    recent rows to show.

    Deterministic ordering: ``latest_personal_activity_at`` DESC,
    then ``domain_rank`` (Work Item 0 < Meeting 1, exact-timestamp
    tie-break only), then ``object_id`` ASC.

    Read-only: a fixed, small number of bounded queries with eager
    relations plus a deterministic in-memory merge — the query
    count is independent of the candidate count.
    """
    readable_project_ids = _readable_project_ids(user)
    readable_meeting_ids = _readable_meeting_ids(user)

    candidates: list[ContinueWorkingCandidate] = []
    candidates.extend(
        _work_item_candidates(
            user=user, readable_project_ids=readable_project_ids,
        )
    )
    candidates.extend(
        _meeting_candidates(
            user=user, readable_meeting_ids=readable_meeting_ids,
        )
    )

    # Canonical V1 ordering via two stable passes: the first pass
    # establishes the (domain_rank, object_id) ASC secondary order,
    # the second stable pass sorts by the personal timestamp DESC
    # without disturbing exact-timestamp ties.
    candidates.sort(key=lambda c: (DOMAIN_RANK[c.domain], c.object_id))
    candidates.sort(
        key=lambda c: c.latest_personal_activity_at, reverse=True,
    )
    return candidates
