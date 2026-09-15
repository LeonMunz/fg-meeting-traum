"""Activity API views.

The aggregate Activity feed is a read-only projection over the
canonical ``audit_history.AuditEvent`` persistence. It exposes the
currently supported Activity events: Work Item events
(``work_item.created`` / ``work_item.updated``), Meeting events
(``meeting.created`` / ``meeting.rescheduled`` / ``meeting.completed``
/ ``meeting.agenda_item_added`` / ``meeting.follow_up_scheduled``),
and Project events
(``project.member_assignments_resolved`` /
``project.ownership_resolved_for_offboarding`` /
``project.archived`` / ``project.restored`` / ``project.deleted``),
and Research Group events
(``research_group.member_offboarded``).

Authorization is evaluated at READ time and is identical to the
underlying object's read rule: an Activity event is returned only if
the requester can read the affected object TODAY.

- Work Item events: the requester has a current
  ``ProjectMembership`` (owner/member/viewer) in the Work Item's
  Project AND a current ``ResearchGroupMembership`` in the Project's
  Research Group.
- Project events: the identical canonical Project read rule, applied
  to the event's own Project (the affected object itself). Archiving
  is not deletion: an archived Project keeps normal read
  authorization. ``project.deleted`` fails closed: the event is
  recorded before the Project row is deleted, its ``project`` FK is
  nulled by the deletion, and a Project that no longer exists can
  never be read again — so deleted-Project events stay durably
  persisted but are never returned (never authorized from the
  retained ``research_group`` scope, actor, subject user, or payload).
- Research Group events: the requester has a current
  ``ResearchGroupMembership`` in the event's Research Group — the
  canonical ``GROUP_READ`` rule (both the ``member`` and the
  ``admin`` role grant read). Losing group membership immediately
  removes the historical Research Group events. The event's
  ``subject_user`` (the offboarded member) is event context and
  never an authorization input. Research Group deletion is not
  supported: the event's ``research_group`` FK is NOT NULL and
  RESTRICT, so a retained Research Group event always references an
  existing group whose current read authorization is evaluable.
- Meeting events: the requester created the Meeting or is an explicit
  ``MeetingParticipant`` — the canonical ``MEETING_READ`` rule; group
  or Project membership alone never grants Meeting visibility.
- ``meeting.follow_up_scheduled`` references BOTH the source and the
  target Meeting: it is returned only if the requester can read BOTH
  Meetings today (the event stores source Meeting metadata, so
  target-only readability must not leak the source).

The ``project`` / ``research_group`` FKs stored on the event are
query hints only — they are never an independent permission grant.
Losing access to the underlying object immediately removes its
historical events from the feed (no privacy bypass).

Filtering happens in the database, BEFORE pagination. Inaccessible
events never reach Python, so they cannot leak titles, actors,
context, ordering, or page behavior.
"""

from django.db import models
from django.db.models import Case, Q, When
from django.db.models.expressions import Func
from django.db.models.fields import CharField
from django.db.models.functions import Cast
from django.db.models.lookups import Exact, In
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from meetings.models import Meeting
from meetings.services import MeetingAuditEventType
from projects.models import ProjectMembership
from projects.services import ProjectAuditEventType
from research_groups.models import ResearchGroupMembership
from research_groups.services import ResearchGroupAuditEventType
from work_items.services import WorkItemAuditEventType

from .models import AuditEvent
from .serializers import ActivityEventSerializer


def _parse_bounded_int(value, *, default, minimum, maximum):
    """Parse an optional bounded integer query param.

    Returns ``(int, error)``. ``error`` is a non-None message string on
    failure (caller answers 400), else ``None``. Mirrors the
    PersonalMyWorkView ``group`` param parsing convention.
    """
    if value is None or value == "":
        return default, None

    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None, "must be a valid integer."

    if parsed < minimum or parsed > maximum:
        return None, f"must be between {minimum} and {maximum}."

    return parsed, None


class _JsonbTypeof(Func):
    """``jsonb_typeof()``: the JSON type of a jsonb value, as text.

    PostgreSQL's ``::bigint`` cast of a jsonb value raises for every
    non-numeric type (string, boolean, object, array, JSON null) and
    silently rounds non-integer numbers — neither is acceptable in an
    authorization predicate. This lets the feed type-check a stored
    JSON reference *before* any conversion that can raise.
    """

    function = "jsonb_typeof"
    output_field = CharField()


class _NumericCastField(models.Field):
    """Private ``Cast`` target rendering an unbounded ``numeric``.

    A ``DecimalField`` without precision renders invalid SQL
    (``numeric(None, None)``), and one with a fixed precision can
    overflow on extreme JSON numbers. Unbounded ``numeric`` is
    arbitrary precision: it can neither overflow nor round, which is
    exactly what the authorization predicate needs.
    """

    def cast_db_type(self, connection):
        return "numeric"


# Upper bound on how deep a single request may page. Large enough for
# any realistic Activity rail, small enough to keep the request bounded.
_MAX_OFFSET = 10_000


class ActivityFeedView(APIView):
    """GET /api/activity/

    Reverse-chronological, permission-filtered Activity feed over the
    currently supported Activity events: Work Item events
    (``work_item.created`` / ``work_item.updated``), Meeting events
    (``meeting.created`` / ``meeting.rescheduled`` /
    ``meeting.completed`` / ``meeting.agenda_item_added`` /
    ``meeting.follow_up_scheduled``), Project events
    (``project.member_assignments_resolved`` /
    ``project.ownership_resolved_for_offboarding`` /
    ``project.archived`` / ``project.restored`` /
    ``project.deleted``),
    and Research Group events
    (``research_group.member_offboarded``).

    Ordering is deterministic: newest ``created_at`` first, with the
    stable event ``id`` as the secondary key when timestamps are equal
    (never relies on undefined database ordering).

    Pagination is explicit and bounded via ``?limit=`` / ``?offset=``
    and is applied to the permission-filtered queryset (the
    repository's explicit-bound convention, cf. the Work Item history
    bound). No pagination metadata (count/next/prev) is exposed, so
    no total can reveal inaccessible rows.

    Authorization: authenticated (IsAuthenticated) + per-row read
    authorization through the canonical read boundary of the
    affected object (Project read rule for Work Items and for
    Project events — the affected Project itself, which fails closed
    once deleted; creator-or-participant rule for Meetings; both
    Meetings for a follow-up schedule; current GROUP_READ group
    membership for Research Group events — the subject_user of an
    offboarding event never grants access).
    """

    permission_classes = [IsAuthenticated]

    # Bounded pagination suitable for an Activity rail. The default
    # matches the Work Item history bound; the hard maximum keeps a
    # single request from pulling unbounded audit history.
    DEFAULT_LIMIT = 50
    MAX_LIMIT = 100

    def get(self, request):
        limit, limit_error = _parse_bounded_int(
            request.query_params.get("limit"),
            default=self.DEFAULT_LIMIT,
            minimum=1,
            maximum=self.MAX_LIMIT,
        )
        if limit_error is not None:
            return Response(
                {"error": f"limit {limit_error}"}, status=400,
            )

        offset, offset_error = _parse_bounded_int(
            request.query_params.get("offset"),
            default=0,
            minimum=0,
            maximum=_MAX_OFFSET,
        )
        if offset_error is not None:
            return Response(
                {"error": f"offset {offset_error}"}, status=400,
            )

        user = request.user

        # Projects the user can read RIGHT NOW — the canonical Work
        # Item read rule expressed as one DB-level subquery:
        # current ProjectMembership (owner/member/viewer all grant
        # PROJECT_READ) AND current ResearchGroupMembership in the
        # Project's Research Group (mirrors resolve_project_scope).
        readable_project_ids = (
            ProjectMembership.objects
            .filter(
                user=user,
                project__research_group__memberships__user=user,
            )
            .values_list("project_id", flat=True)
        )

        # Research Groups the user can read RIGHT NOW — the
        # canonical GROUP_READ rule expressed as one DB-level
        # subquery: a current ResearchGroupMembership in that group
        # (both the member and the admin role grant GROUP_READ,
        # mirroring resolve_group_scope and the central role to
        # capability table; default deny for any other role).
        readable_group_ids = (
            ResearchGroupMembership.objects
            .filter(
                user=user,
                role__in=[
                    ResearchGroupMembership.Role.ADMIN,
                    ResearchGroupMembership.Role.MEMBER,
                ],
            )
            .values_list("research_group_id", flat=True)
        )

        # Meetings the user can read RIGHT NOW — the canonical
        # MEETING_READ rule (creator-or-explicit-participant)
        # expressed as one DB-level subquery. Group/Project
        # membership alone is deliberately NOT part of this.
        readable_meeting_ids = (
            Meeting.objects
            .filter(
                Q(created_by=user)
                | Q(participant_relations__user=user)
            )
            .values_list("pk", flat=True)
        )

        # Permission-filter FIRST, on the LIVE object's current access
        # scope. Each branch requires the affected object to still
        # exist: a hard-deleted WorkItem, Meeting, or Project (FK
        # nulled via SET_NULL) is no longer readable, so its events
        # are excluded — deleted-Project events in particular fail
        # closed (their project FK is always nulled after the
        # deletion, and no ProjectMembership can survive the
        # Project's CASCADE delete). A follow-up schedule references
        # BOTH Meetings, so it also requires the stored source
        # Meeting reference to be readable today (stable flat data
        # key; a missing/unknown reference fails closed).
        work_item_events = Q(
            work_item__isnull=False,
            event_type__in=[
                WorkItemAuditEventType.CREATED,
                WorkItemAuditEventType.UPDATED,
            ],
            work_item__project_id__in=readable_project_ids,
        )
        # Project events: the affected object IS the event's own
        # Project, so the canonical Project read rule applies to it
        # directly. ``project__isnull=False`` is the deleted-Project
        # fail-closed: a ``project.deleted`` event's FK is nulled by
        # the deletion and can therefore never match.
        project_events = Q(
            project__isnull=False,
            event_type__in=[
                ProjectAuditEventType.MEMBER_ASSIGNMENTS_RESOLVED,
                ProjectAuditEventType.OWNERSHIP_RESOLVED_FOR_OFFBOARDING,
                ProjectAuditEventType.ARCHIVED,
                ProjectAuditEventType.RESTORED,
                ProjectAuditEventType.DELETED,
            ],
            project_id__in=readable_project_ids,
        )
        # Research Group events: the affected object is the event's
        # own Research Group (its scope). Canonical GROUP_READ rule:
        # a current ResearchGroupMembership in that group (member
        # and admin both grant read). Research Group deletion is
        # not supported, and the NOT NULL / RESTRICT
        # research_group FK guarantees a retained Research Group
        # event always references an existing group, so current
        # read authorization is always evaluable; a requester
        # without current membership matches nothing (fail closed).
        # The event's subject_user (the offboarded member) plays no
        # part in this filter.
        research_group_events = Q(
            event_type=(
                ResearchGroupAuditEventType.MEMBER_OFFBOARDED
            ),
            research_group_id__in=readable_group_ids,
        )
        meeting_events = Q(
            meeting__isnull=False,
            event_type__in=[
                MeetingAuditEventType.CREATED,
                MeetingAuditEventType.RESCHEDULED,
                MeetingAuditEventType.COMPLETED,
                MeetingAuditEventType.AGENDA_ITEM_ADDED,
            ],
            meeting_id__in=readable_meeting_ids,
        )
        follow_up_events = Q(
            event_type=MeetingAuditEventType.FOLLOW_UP_SCHEDULED,
            meeting__isnull=False,
            meeting_id__in=readable_meeting_ids,
        )
        # The stored source Meeting reference is a JSON value; it
        # counts as a supported integer reference only when it is a
        # JSON number. ``jsonb_typeof`` is checked first and the cast
        # lives inside the CASE branch, which PostgreSQL evaluates
        # only for JSON numbers (``::numeric`` is arbitrary
        # precision, so it can neither overflow nor round). Every
        # other shape — missing key, JSON null, string, boolean,
        # object, array — yields NULL and fails closed: the event is
        # simply excluded and a malformed row can never make the
        # endpoint raise. A non-integer number (e.g. 5.5) compares
        # numerically against the readable Meeting IDs and matches
        # nothing — it is never coerced into another Meeting ID.
        follow_up_source_readable = In(
            Case(
                When(
                    Exact(
                        _JsonbTypeof("data__sourceMeetingId"), "number",
                    ),
                    then=Cast(
                        "data__sourceMeetingId",
                        output_field=_NumericCastField(),
                    ),
                ),
                default=None,
                output_field=_NumericCastField(),
            ),
            readable_meeting_ids,
        )

        events = (
            AuditEvent.objects
            .filter(
                work_item_events
                | project_events
                | meeting_events
                | research_group_events
                | (follow_up_events & follow_up_source_readable)
            )
            .select_related(
                "actor",
                "subject_user",
                "research_group",
                "work_item",
                "work_item__project",
                "work_item__project__research_group",
                "meeting",
                "meeting__project",
                "meeting__project__research_group",
                "meeting__research_group",
                "project",
                "project__research_group",
            )
            .order_by("-created_at", "-id")
        )

        # Bounded page taken from the already-filtered queryset.
        page = events[offset: offset + limit]

        serializer = ActivityEventSerializer(page, many=True)
        return Response(serializer.data)
