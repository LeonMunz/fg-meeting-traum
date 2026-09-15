"""Home "Needs attention" — Work Item candidate read model.

This module provides the reusable backend read service that derives,
for one authenticated user, the Work Items that personally require
the user's attention.

This slice covers exactly one candidate family — the user's own
ASSIGNED, OPEN Work Items that are:

- ``overdue`` — canonical date-only ``due_date`` strictly before the
  current Django application-local date, or
- ``blocked`` — canonical non-empty ``blockedReason``
  (``docs/domain/foundation.md`` §11: ``blockedReason`` present
  → blocked; NULL/empty → not blocked).

Canonical semantics are REUSED, never re-interpreted:

- **Assignment**: a current ``WorkItemAssignee`` row for the user —
  the same relational assignment the My Work projections query.
- **Current read authorization**: the identical current-membership
  boundary of personal My Work (``PersonalMyWorkView``): current
  ``ProjectMembership`` with role ``owner``/``member`` AND current
  ``ResearchGroupMembership`` in the Project's Research Group.
  Losing Project or Research Group membership removes the Work Item
  from this read model immediately; historical assignment rows alone
  never grant visibility.

  The ``owner``/``member`` role set is not a Home-specific rule: it
  is exactly the canonical assignee-eligible role set. Assigning a
  Work Item requires the ``PROJECT_WORK`` capability
  (``_validate_assignee_eligibility``), which only ``owner`` and
  ``member`` hold (``PROJECT_ROLE_CAPABILITIES``; a viewer holds only
  ``PROJECT_READ``). ``docs/domain/foundation.md`` §9: "A `viewer`
  cannot be assigned." The canonical mutation paths make the
  violating state unreachable: role demotion to viewer and
  membership removal are blocked while assignments exist
  (``_check_assignments_block_mutation``) or the assignments are
  atomically resolved in the same operation
  (``change_membership_role(assignment_resolution=...)``). The
  read-time role filter therefore applies the assignment
  eligibility invariant at read time, as defense in depth.
- **Completion exclusion**: the canonical status semantic category
  (``docs/domain/foundation.md`` §12) — a Work Item whose
  ``status_definition.category`` is ``done`` is complete and never
  an attention candidate, even with a stale past ``due_date`` or
  stale blocked metadata.

The read model returns **one candidate per Work Item** with explicit
stable machine-readable reason codes (``overdue``, ``blocked``) —
never display sentences, never one row per reason. A Work Item that
is both overdue and blocked appears exactly once with both codes.

Bounded responsibility: this service provides Work Item attention
candidates only. It does not decide how many rows Home shows, how
candidate families are prioritized against each other, or any
summary counts — the later Home composition layer decides those.

Deferred (NOT part of this read model): due-soon candidates (no
canonical due-soon threshold exists in this repository), Meeting
preparation, Follow-up attention, and all other Home candidate
families. Canonical domain reference: ``docs/domain/home.md``.
"""

from dataclasses import dataclass
from datetime import date

from django.db import models
from django.db.models import Case, F, Q, When
from django.utils import timezone

from projects.models import ProjectMembership, WorkItemStatusDefinition

from .models import WorkItem


# Stable machine-readable attention reason codes. Never localized,
# never display sentences — the Home composition layer renders copy.
ATTENTION_REASON_OVERDUE = "overdue"
ATTENTION_REASON_BLOCKED = "blocked"


@dataclass(frozen=True)
class WorkItemAttentionCandidate:
    """One Work Item requiring the user's attention.

    Carries only what a later Home composition layer needs to
    rank/render the candidate; the canonical Work Item (and its full
    API representation) remains reachable through ``work_item_id``.
    """

    work_item_id: int
    title: str
    project_id: int
    project_name: str
    due_date: date | None
    # Current semantic status category: todo / in_progress / review
    # (``done`` candidates are excluded by construction).
    status_category: str
    blocked_reason: str | None
    # Stable reason codes, canonical order: overdue before blocked.
    attention_reasons: tuple[str, ...]


def _current_application_date() -> date:
    """Current date in the Django application timezone.

    ``WorkItem.due_date`` is a date-only field, so the overdue
    comparison uses the application-timezone current date (never a
    user-specific timezone). This is the single point where the
    read model observes "today", which keeps the behavior
    deterministically testable without a wall-clock dependency.
    """
    return timezone.localdate()


def _open_category_filter() -> Q:
    """Canonical completion exclusion: not category ``done``."""
    return ~Q(
        status_definition__category=WorkItemStatusDefinition.Category.DONE,
    )


def _attention_filter(today: date) -> Q:
    """Overdue or blocked, in one disjunction.

    ``due_date < today`` is the canonical overdue semantics (same as
    the existing Project Overview "Needs Attention" derivation, where
    ``dueInDays < 0`` means strictly before the current date; a due
    date of exactly today is NOT overdue). SQL comparison semantics
    exclude ``due_date IS NULL`` automatically.

    ``blocked_reason > ''`` is the canonical blocked rule
    (``blockedReason`` present → blocked; the field defaults to ``""``
    which means unblocked, so an empty value is not ``> ''``).
    """
    return Q(due_date__lt=today) | Q(blocked_reason__gt="")


def _overdue_group_order(today: date):
    """Overdue items (group 0) sort before blocked-only items (1).

    An item that is both overdue and blocked belongs to the overdue
    group and still carries both reason codes.
    """
    return Case(
        When(due_date__lt=today, then=0),
        default=1,
        output_field=models.IntegerField(),
    )


def get_work_item_attention_candidates(*, user) -> list[WorkItemAttentionCandidate]:
    """Return the current user's Work Item "Needs attention" candidates.

    A Work Item qualifies iff ALL of the following hold:

    1. the user is currently assigned to it (``WorkItemAssignee``),
    2. the user's CURRENT read authorization still covers it:
       current ``ProjectMembership`` (role ``owner``/``member``) in
       the Work Item's Project AND current ``ResearchGroupMembership``
       in the Project's Research Group — the identical boundary of
       personal My Work,
    3. it is not complete (status category is not ``done``), and
    4. it is overdue (date-only ``due_date`` strictly before the
       current application-timezone date) and/or blocked (canonical
       non-empty ``blocked_reason``).

    Deterministic ordering (single query; no hidden numeric score):

    1. overdue items before blocked-only items,
    2. earliest ``due_date`` first (``NULLS LAST``),
    3. stable tie-break on Work Item ID.

    Read-only projection over the canonical ``WorkItem`` table: no
    rows are created, no Work Item is duplicated, and no Work Item
    internals beyond the candidate fields are exposed.
    """
    today = _current_application_date()

    queryset = (
        WorkItem.objects.filter(
            # 3. canonical completion exclusion (category ``done``)
            _open_category_filter(),
            # 4. overdue and/or blocked
            _attention_filter(today),
            # 1. current assignment to the user
            assignee_relations__user=user,
            # 2. current Project membership (owner/member = the
            #    canonical assignee-eligible roles) in the Work
            #    Item's Project AND current Research Group
            #    membership in the Project's Research Group — the
            #    identical current-membership boundary of personal
            #    My Work
            project__memberships__user=user,
            project__memberships__role__in=[
                ProjectMembership.Role.OWNER,
                ProjectMembership.Role.MEMBER,
            ],
            project__research_group__memberships__user=user,
        )
        .distinct()
        .select_related("project", "status_definition")
        .order_by(
            _overdue_group_order(today),
            F("due_date").asc(nulls_last=True),
            "pk",
        )
    )

    candidates: list[WorkItemAttentionCandidate] = []

    for work_item in queryset:
        reasons: list[str] = []

        if work_item.due_date is not None and work_item.due_date < today:
            reasons.append(ATTENTION_REASON_OVERDUE)

        if work_item.blocked_reason:
            reasons.append(ATTENTION_REASON_BLOCKED)

        candidates.append(
            WorkItemAttentionCandidate(
                work_item_id=work_item.pk,
                title=work_item.title,
                project_id=work_item.project_id,
                project_name=work_item.project.name,
                due_date=work_item.due_date,
                status_category=work_item.status_definition.category,
                blocked_reason=work_item.blocked_reason or None,
                attention_reasons=tuple(reasons),
            )
        )

    return candidates
