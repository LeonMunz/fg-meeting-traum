"""Home aggregate API view.

``GET /api/home/`` — read-only, authenticated, user-scoped,
non-paginated Home aggregate.

This view composes the four already-implemented Home read-model
services, called independently:

- ``work_items.home_attention.get_work_item_attention_candidates``
  (Needs attention)
- ``home_timeline.timeline.get_home_timeline_candidates``
  (Today & next)
- ``work_items.home_my_work.get_home_my_work_candidates``
  (My work)
- ``home_continue.continue_working.get_continue_working_candidates``
  (Continue working)

**Composition + serialization only.** Eligibility predicates,
authorization rules, ordering, time windows, deduplication, and
completion semantics all remain in the read-model services and are
never re-derived, re-sorted, or re-authorized here. The order each
service returns is authoritative; the view serializes it as-is. No
query consolidation, no shared request clock, no row limits, no
summary counts, no cross-section deduplication are introduced here
(the independent per-service behavior is the settled V1 contract).

Stable top-level contract — exactly four section keys, always
present, never omitted, never ``null``:

    {
        "needsAttention": [...],
        "todayAndNext": [...],
        "myWork": [...],
        "continueWorking": [...]
    }

An empty section serializes to ``[]``. Each section returns the
COMPLETE candidate array of its read model (the later 7-visible-row
rule for Today & next is a UI presentation rule, not an API rule).
A Work Item may legitimately appear in multiple sections at the same
time (each Home module answers a different question).

**Activity stays separate** (``GET /api/activity/``) and is never
embedded in this response.

Authorization: ``IsAuthenticated`` through the existing session
authentication stack (anonymous requests are rejected with 401).
The user scope comes from the authenticated request identity
(``request.user``), never from a client-supplied user ID. Per-
candidate authorization is enforced inside each read-model service;
the view never grants or widens access.
"""

from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from home_continue.continue_working import (
    ContinueMeetingDetails,
    get_continue_working_candidates,
)
from home_timeline.timeline import (
    MeetingTimelineDetails,
    get_home_timeline_candidates,
)
from work_items.home_attention import (
    get_work_item_attention_candidates,
)
from work_items.home_my_work import get_home_my_work_candidates


# ── Section serialization ──
#
# Every serializer maps ONE read-model candidate dataclass onto the
# stable JSON shape and nothing else: the fields present in the
# candidate are the fields serialized. No model instances, no
# serializer-only internals, no derived permissions or context.
# Dates and datetimes are passed through as ``date`` / ``datetime``
# objects; DRF's JSON encoder renders them with the normal API
# ISO-8601 conventions (dates ``YYYY-MM-DD``, datetimes
# timezone-aware) — no manual local-time conversion.


def _serialize_needs_attention(candidate):
    """One ``Needs attention`` Work Item candidate."""
    return {
        "workItemId": candidate.work_item_id,
        "title": candidate.title,
        "projectId": candidate.project_id,
        "projectName": candidate.project_name,
        # Canonical Work Item type identity (Project-configured
        # WorkItemTypeDefinition) — display metadata for the row's
        # type icon; not inferred from status/title/ordering.
        "workItemType": {
            "id": candidate.type_definition_id,
            "name": candidate.type_name,
        },
        "dueDate": candidate.due_date,
        "statusCategory": candidate.status_category,
        "blockedReason": candidate.blocked_reason,
        # Stable machine-readable reason codes in the read model's
        # canonical order (overdue before blocked).
        "attentionReasons": list(candidate.attention_reasons),
    }


def _serialize_timeline_meeting(details):
    """Today & next Meeting detail block (MeetingTimelineDetails)."""
    return {
        "meetingId": details.meeting_id,
        "scheduledAt": details.scheduled_at,
        "status": details.status,
        "scope": details.scope,
        "researchGroupId": details.research_group_id,
        "projectId": details.project_id,
    }


def _serialize_timeline_work_item(details):
    """Today & next Work Item detail block (WorkItemTimelineDetails)."""
    return {
        "workItemId": details.work_item_id,
        "projectId": details.project_id,
        "projectName": details.project_name,
        "dueDate": details.due_date,
        "statusCategory": details.status_category,
        "blockedReason": details.blocked_reason,
    }


def _serialize_today_and_next(candidate):
    """One flat ``Today & next`` timeline candidate.

    Exactly one detail object is non-null: the one matching the
    candidate's domain.
    """
    is_meeting = isinstance(candidate.details, MeetingTimelineDetails)
    return {
        "domain": candidate.domain,
        "objectId": candidate.object_id,
        "title": candidate.title,
        "calendarDate": candidate.calendar_date,
        "sortAt": candidate.sort_at,
        "workItem": (
            None
            if is_meeting
            else _serialize_timeline_work_item(candidate.details)
        ),
        "meeting": (
            _serialize_timeline_meeting(candidate.details)
            if is_meeting
            else None
        ),
    }


def _serialize_my_work(candidate):
    """One ``My work`` Work Item candidate."""
    return {
        "workItemId": candidate.work_item_id,
        "title": candidate.title,
        "projectId": candidate.project_id,
        "projectName": candidate.project_name,
        "typeDefinitionId": candidate.type_definition_id,
        "typeName": candidate.type_name,
        "statusCategory": candidate.status_category,
        "dueDate": candidate.due_date,
        "blockedReason": candidate.blocked_reason,
    }


def _serialize_continue_working(candidate):
    """One flat ``Continue working`` recency candidate.

    Exactly one detail object is non-null: the one matching the
    candidate's domain. No raw ``AuditEvent.data``, no Activity
    text, no source Meeting data — only the fields already safe in
    the candidate dataclass.
    """
    details = candidate.details
    is_meeting = isinstance(details, ContinueMeetingDetails)
    return {
        "domain": candidate.domain,
        "objectId": candidate.object_id,
        "title": candidate.title,
        "latestPersonalActivityAt": candidate.latest_personal_activity_at,
        # Current access scope/context (display metadata): Work Item
        # → owning Project, Meeting → owning Research Group.
        "context": {
            "kind": candidate.context.kind,
            "id": candidate.context.id,
            "name": candidate.context.name,
        },
        "workItem": (
            None
            if is_meeting
            else {
                "workItemId": details.work_item_id,
                "projectId": details.project_id,
                "projectName": details.project_name,
                "statusCategory": details.status_category,
                "dueDate": details.due_date,
            }
        ),
        "meeting": (
            {
                "meetingId": details.meeting_id,
                "status": details.status,
                "scheduledAt": details.scheduled_at,
            }
            if is_meeting
            else None
        ),
    }


# ── View ──


class HomeAggregateView(APIView):
    """GET /api/home/

    The authenticated Home aggregate: the four implemented Home
    read models composed in one stable, non-paginated JSON response.

    Read-only (GET only), authenticated (``IsAuthenticated`` through
    the existing session authentication stack; anonymous requests
    are rejected), and user-scoped (``request.user``). No
    POST/PATCH/DELETE behavior.

    See the module docstring for the stable top-level contract, the
    per-section shapes, and the composition-only guarantees.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        user = request.user
        return Response(
            {
                "needsAttention": [
                    _serialize_needs_attention(candidate)
                    for candidate in get_work_item_attention_candidates(
                        user=user,
                    )
                ],
                "todayAndNext": [
                    _serialize_today_and_next(candidate)
                    for candidate in get_home_timeline_candidates(user=user)
                ],
                "myWork": [
                    _serialize_my_work(candidate)
                    for candidate in get_home_my_work_candidates(user=user)
                ],
                "continueWorking": [
                    _serialize_continue_working(candidate)
                    for candidate in get_continue_working_candidates(
                        user=user,
                    )
                ],
            },
        )
