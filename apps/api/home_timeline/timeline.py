"""Home "Today & next" — cross-domain timeline candidate read model.

This module provides the reusable backend read service that derives,
for one authenticated user, the complete V1 ``Today & next``
candidate list: the union of the user's upcoming readable Meetings
and assigned due Work Items inside the next **7 calendar days
including Today**.

Settled V1 contract (``docs/domain/home.md``):

- **Window** (half-open, observed exactly once per read operation):

  - Meetings: ``start_of_today <= scheduled_at < start_of_today + 7 days``
  - Work Items: ``today <= due_date < today + 7 days``

  The end boundary is exclusive. There is no user-specific timezone
  model: all comparisons use the configured Django application
  timezone (currently UTC).

- **Meeting candidates** — a Meeting qualifies iff ALL of:

  1. ``status == upcoming`` (live and completed are excluded),
  2. ``scheduled_at`` is inside the window (past/stale upcoming
     Meetings before start-of-today are excluded),
  3. the requester currently has canonical ``MEETING_READ`` —
     creator (``created_by``) or explicit current
     ``MeetingParticipant``. Research Group membership/admin, Project
     membership, ownership, and Meeting write permission never grant
     timeline eligibility.

- **Work Item candidates** — a Work Item qualifies iff ALL of:

  1. the user is currently assigned (``WorkItemAssignee``),
  2. the user's CURRENT read authorization still covers it: current
     ``ProjectMembership`` (role ``owner``/`member` — the canonical
     assignee-eligible roles) in the Work Item's Project AND current
     ``ResearchGroupMembership`` in the Project's Research Group
     (the identical boundary of personal My Work and Home
     ``Needs attention``),
  3. the status semantic category is not ``done``,
  4. ``due_date`` is non-null and inside the window.

  Overdue Work Items (``due_date < today``) fall outside the forward
  window and are therefore excluded by construction — they remain
  the responsibility of ``Needs attention``. A **blocked** Work Item
  with a due date inside the window REMAINS eligible: ``Needs
  attention`` communicates the problem, ``Today & next`` communicates
  the time obligation; the two read models are behaviorally disjoint
  on overdue and intentionally overlapping on blocked-dated items.

- **Meeting follow-ups are NOT a candidate type.** If a follow-up
  targets an upcoming readable Meeting inside the window, that target
  Meeting already represents the future time event exactly once; no
  separate row is produced, and a follow-up whose target the user
  cannot read produces nothing. Activity events are never timeline
  state.

- **Candidate contract**: one flat chronologically ordered list (no
  backend buckets, no row limit — the later Home composition layer
  applies the settled 7-row presentation rule). Each candidate
  exposes domain, object identity, title, calendar date, a
  deterministic chronological sort point, and a small
  domain-specific detail block. No rendered sentences.

- **Deterministic cross-domain ordering**: sort key
  ``(sort_at, domain_rank, object_id)`` where ``sort_at`` is the
  Meeting's exact ``scheduled_at`` or the start of the Work Item's
  due date in the application timezone (date-only Work Items behave
  like all-day entries), ``domain_rank`` is
  Work Item (0) < Meeting (1) for exact-instant ties only, and
  ``object_id`` ascending breaks same-domain ties. No relevance
  scoring.

Query strategy: exactly two bounded domain queries (one Meeting, one
Work Item) with eager relation loading, plus an in-memory
deterministic merge. No N+1, no caching, no UNION, no polymorphic
persistence.

Bounded responsibility: this service returns candidates only. It
does not decide how many rows Home shows, how families are
prioritized against each other, or any summary counts.

Canonical domain reference: ``docs/domain/home.md``.
"""

from dataclasses import dataclass
from datetime import date, datetime, timedelta

from django.db.models import Q
from django.utils import timezone

from meetings.models import Meeting
from projects.models import ProjectMembership, WorkItemStatusDefinition
from work_items.models import WorkItem

# Stable machine-readable candidate domain codes. A future Calendar
# provider would add its own code + rank entry; Meeting and Work
# Item semantics are never redefined.
DOMAIN_MEETING = "meeting"
DOMAIN_WORK_ITEM = "work_item"

# Exact-instant tie resolution only: Work Items sort before
# Meetings at the same ``sort_at``.
DOMAIN_RANK = {
    DOMAIN_WORK_ITEM: 0,
    DOMAIN_MEETING: 1,
}

# V1 horizon: 7 calendar days including Today.
HORIZON_DAYS = 7


@dataclass(frozen=True)
class MeetingTimelineDetails:
    """Meeting-specific composition data.

    Project/Research Group context carries exactly the IDs the
    canonical Meeting read exposes (``researchGroupId`` / nullable
    ``projectId`` / ``scope``); Meeting read never implies Project
    read, so no Project name is attached.
    """

    meeting_id: int
    scheduled_at: datetime
    status: str
    scope: str
    research_group_id: int
    project_id: int | None


@dataclass(frozen=True)
class WorkItemTimelineDetails:
    """Work Item-specific composition data (same boundary as the
    Home ``Needs attention`` candidate)."""

    work_item_id: int
    project_id: int
    project_name: str
    due_date: date
    # Current semantic status category: todo / in_progress / review
    # (``done`` candidates are excluded by construction).
    status_category: str
    blocked_reason: str | None


@dataclass(frozen=True)
class HomeTimelineCandidate:
    """One flat timeline candidate (Meeting or Work Item).

    Carries only what a later Home composition layer needs to
    bucket/render the candidate; the canonical object (and its full
    API representation) remains reachable through ``object_id``.
    """

    domain: str
    object_id: int
    title: str
    # Application-timezone calendar date for bucketing (a date-only
    # Work Item is its own due date; a Meeting is the date of its
    # ``scheduled_at``).
    calendar_date: date
    # Deterministic chronological sort point (aware, application
    # timezone). Meetings: exact ``scheduled_at``. Work Items: start
    # of the due date (all-day entry).
    sort_at: datetime
    details: MeetingTimelineDetails | WorkItemTimelineDetails

    def sort_key(self):
        """Canonical V1 sort key: (sort_at, domain_rank, object_id)."""
        return (self.sort_at, DOMAIN_RANK[self.domain], self.object_id)


def _observe_clock() -> tuple[date, datetime, datetime]:
    """Observe the current application time EXACTLY ONCE per read.

    Returns ``(today, window_start, window_end)`` where the window
    is the half-open application-timezone interval
    ``[window_start, window_start + 7 days)`` covering Today through
    Today + 6. All date and datetime eligibility derives from this
    single observation; tests freeze this one function.
    """
    now = timezone.now()
    today = now.date()
    window_start = timezone.make_aware(
        datetime.combine(today, datetime.min.time())
    )
    return (
        today,
        window_start,
        window_start + timedelta(days=HORIZON_DAYS),
    )


def _meeting_candidates(*, user, window_start, window_end):
    """One bounded query: the user's upcoming readable Meetings
    inside the window.

    Canonical ``MEETING_READ`` at query level: creator or explicit
    current participant (the identical predicate of the Meeting list
    scope filter and the Activity feed's readable-Meeting rule).
    Group/Project membership, ownership, and admin status grant
    nothing.
    """
    return (
        Meeting.objects.filter(
            Q(created_by=user) | Q(participant_relations__user=user),
            status=Meeting.Status.UPCOMING,
            scheduled_at__gte=window_start,
            scheduled_at__lt=window_end,
        )
        .distinct()
        .select_related("research_group", "project")
    )


def _work_item_candidates(*, user, today):
    """One bounded query: the user's assigned open due Work Items
    inside the window.

    Reuses the exact assignment/read invariants of personal My Work
    and Home ``Needs attention``:

    - current ``WorkItemAssignee`` row for the user,
    - current ``ProjectMembership`` (``owner``/``member`` — the
      canonical assignee-eligible roles) in the Work Item's Project,
    - current ``ResearchGroupMembership`` in the Project's Research
      Group,
    - status category not ``done``,
    - ``due_date`` non-null and inside ``[today, today + 7 days)``
      (overdue is excluded by the forward window; a blocked item
      stays eligible).
    """
    window_end_date = today + timedelta(days=HORIZON_DAYS)
    return (
        WorkItem.objects.filter(
            ~Q(
                status_definition__category=WorkItemStatusDefinition.Category.DONE,
            ),
            due_date__gte=today,
            due_date__lt=window_end_date,
            assignee_relations__user=user,
            project__memberships__user=user,
            project__memberships__role__in=[
                ProjectMembership.Role.OWNER,
                ProjectMembership.Role.MEMBER,
            ],
            project__research_group__memberships__user=user,
        )
        .distinct()
        .select_related("project", "status_definition")
    )


def _to_meeting_candidate(meeting: Meeting) -> HomeTimelineCandidate:
    # With USE_TZ=True, ``scheduled_at`` is already returned in the
    # application timezone; ``.date()``/``.astimezone()`` keep the
    # candidate timezone-explicit regardless.
    app_tz = timezone.get_current_timezone()
    scheduled_at = meeting.scheduled_at.astimezone(app_tz)
    return HomeTimelineCandidate(
        domain=DOMAIN_MEETING,
        object_id=meeting.pk,
        title=meeting.title,
        calendar_date=scheduled_at.date(),
        sort_at=scheduled_at,
        details=MeetingTimelineDetails(
            meeting_id=meeting.pk,
            scheduled_at=scheduled_at,
            status=meeting.status,
            scope=meeting.scope,
            research_group_id=meeting.research_group_id,
            project_id=meeting.project_id,
        ),
    )


def _to_work_item_candidate(work_item: WorkItem) -> HomeTimelineCandidate:
    # Date-only due date → all-day entry: sort point is the START of
    # the due date in the application timezone.
    sort_at = timezone.make_aware(
        datetime.combine(work_item.due_date, datetime.min.time())
    )
    return HomeTimelineCandidate(
        domain=DOMAIN_WORK_ITEM,
        object_id=work_item.pk,
        title=work_item.title,
        calendar_date=work_item.due_date,
        sort_at=sort_at,
        details=WorkItemTimelineDetails(
            work_item_id=work_item.pk,
            project_id=work_item.project_id,
            project_name=work_item.project.name,
            due_date=work_item.due_date,
            status_category=work_item.status_definition.category,
            blocked_reason=work_item.blocked_reason or None,
        ),
    )


def get_home_timeline_candidates(*, user) -> list[HomeTimelineCandidate]:
    """Return the current user's complete V1 ``Today & next``
    candidate list.

    Combines the two eligible families (upcoming readable Meetings,
    assigned readable open due Work Items) inside the 7-calendar-day
    window including Today, and returns ONE flat chronologically
    ordered list sorted by ``(sort_at, domain_rank, object_id)``.

    No row limit, no buckets, no rendered sentences: the later Home
    composition layer applies the settled 7-row presentation rule
    and derives display buckets from ``calendar_date``.

    Read-only: exactly two bounded domain queries with eager
    relations plus an in-memory deterministic merge.
    """
    today, window_start, window_end = _observe_clock()

    candidates: list[HomeTimelineCandidate] = [
        _to_meeting_candidate(meeting)
        for meeting in _meeting_candidates(
            user=user, window_start=window_start, window_end=window_end,
        )
    ]
    candidates.extend(
        _to_work_item_candidate(work_item)
        for work_item in _work_item_candidates(user=user, today=today)
    )
    candidates.sort(key=HomeTimelineCandidate.sort_key)
    return candidates
