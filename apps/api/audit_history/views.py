"""Activity API views.

The aggregate Activity feed is a read-only projection over the
canonical ``audit_history.AuditEvent`` persistence. It exposes only
the currently supported Work Item Activity events.

Authorization is evaluated at READ time and is identical to the
underlying object's read rule: an Activity event is returned only if
the requester can read the affected Work Item TODAY, i.e. has a
current ``ProjectMembership`` (owner/member/viewer) in the Work
Item's Project AND a current ``ResearchGroupMembership`` in the
Project's Research Group. The ``project`` / ``research_group`` FKs
stored on the event are query hints only — they are never an
independent permission grant. Losing access to the underlying object
immediately removes its historical events from the feed (no privacy
bypass).

Filtering happens in the database, BEFORE pagination, on the live
Work Item project. Inaccessible events never reach Python, so they
cannot leak titles, actors, context, ordering, or page behavior.
"""

from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from projects.models import ProjectMembership
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


# Upper bound on how deep a single request may page. Large enough for
# any realistic Activity rail, small enough to keep the request bounded.
_MAX_OFFSET = 10_000


class ActivityFeedView(APIView):
    """GET /api/activity/

    Reverse-chronological, permission-filtered Activity feed over the
    currently supported Work Item Activity events
    (``work_item.created`` / ``work_item.updated``).

    Ordering is deterministic: newest ``created_at`` first, with the
    stable event ``id`` as the secondary key when timestamps are equal
    (never relies on undefined database ordering).

    Pagination is explicit and bounded via ``?limit=`` / ``?offset=``
    and is applied to the permission-filtered queryset (the
    repository's explicit-bound convention, cf. the Work Item history
    bound). No pagination metadata (count/next/prev) is exposed, so
    no total can reveal inaccessible rows.

    Authorization: authenticated (IsAuthenticated) + per-row read
    authorization through the canonical Project read boundary.
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

        # Permission-filter FIRST, on the LIVE Work Item project (the
        # underlying object's current access scope). work_item must
        # exist: a hard-deleted WorkItem (work_item nulled via
        # SET_NULL) is no longer readable, so its events are excluded.
        events = (
            AuditEvent.objects
            .filter(
                work_item__isnull=False,
                event_type__in=[
                    WorkItemAuditEventType.CREATED,
                    WorkItemAuditEventType.UPDATED,
                ],
                work_item__project_id__in=readable_project_ids,
            )
            .select_related(
                "actor",
                "work_item",
                "work_item__project",
                "work_item__project__research_group",
            )
            .order_by("-created_at", "-id")
        )

        # Bounded page taken from the already-filtered queryset.
        page = events[offset: offset + limit]

        serializer = ActivityEventSerializer(page, many=True)
        return Response(serializer.data)
