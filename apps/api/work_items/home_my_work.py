"""Home "My work" — Work Item candidate read model.

This module provides the reusable backend read service that derives,
for one authenticated user, the Work Items that are currently the
user's active personal responsibility.

The candidate set is the canonical PERSONAL MY WORK boundary,
reused from ``work_items.personal_my_work.personal_my_work_queryset``
(the same query source as ``GET /api/me/work-items/`` and the
per-Research-Group My Work endpoint):

- **Assignment**: a current ``WorkItemAssignee`` row for the user.
  Unassigned Work Items, Work Items assigned to someone else, and
  Work Items the user merely owns the Project for never qualify.
- **Current read authorization is mandatory**: current
  ``ProjectMembership`` (role ``owner``/``member`` — the canonical
  assignee-eligible roles) in the Work Item's Project AND current
  ``ResearchGroupMembership`` in the Project's Research Group.
  Losing Project or Research Group membership removes the Work
  Item immediately; historical assignment rows alone never grant
  visibility. The ``owner``/``member`` role filter is the
  assignment-eligibility invariant applied at read time (defense
  in depth), identical to personal My Work — general Work Item
  readability (e.g. a viewer's ``PROJECT_READ``) is NOT My Work
  eligibility.

One explicitly documented projection delta versus the personal
My Work ENDPOINT:

- **Active-only**: Home "My work" represents active
  responsibility, not historical completed work, so a Work Item
  whose ``status_definition.category`` is ``done`` (canonical
  completion, ``docs/domain/foundation.md`` §12 — category
  semantics, never display-name matching) is excluded. The
  personal My Work endpoint deliberately keeps completed items
  (the My Work page shows them, sorted last; ``foundation.md``
  §14 lists "Done" as a possible UI filter) and is unchanged.
  This is the same completion rule the other Home Work Item
  read models apply.

Responsibility-oriented, not urgency/time-oriented: there is no
overdue/blocked reason ranking and no time window here. A Work
Item may therefore legitimately also appear in Home "Needs
attention" and/or "Today & next" — the overlap is intentional
(each Home module answers a different question) and NO
cross-module suppression is applied.

Bounded responsibility: this service provides the COMPLETE
canonical personal My Work candidate set (active). It does not
apply any Home row limit, truncation, or summary counts — the
later Home composition layer decides visible row limits,
"show more", and layout.

Deterministic ordering: the existing My Work projections declare
no canonical ordering (no model ``Meta.ordering``, no
``order_by`` in the views); Home "my work" is a compact
responsibility list, so it orders by stable Work Item ID
ascending — the task-bounded "stable final ID tie-break", with
no invented relevance score and no duplication of the Needs-
attention urgency ranking or the Today-&-next chronological
merge.

Candidate contract: only structured, composition-relevant data —
Work Item identity, title, Project identity/name, Work Item type
identity/name, current semantic status category, due value, and
blocked reason. No rendered sentences, no model instances, no
arbitrary model internals; the canonical Work Item (and its full
API representation) remains reachable through ``work_item_id``.

Canonical domain reference: ``docs/domain/home.md``.
"""

from dataclasses import dataclass
from datetime import date

from django.db.models import Q

from projects.models import WorkItemStatusDefinition

from .personal_my_work import personal_my_work_queryset


def _open_category_filter() -> Q:
    """Canonical completion exclusion: not category ``done``."""
    return ~Q(
        status_definition__category=WorkItemStatusDefinition.Category.DONE,
    )


@dataclass(frozen=True)
class HomeMyWorkCandidate:
    """One of the user's active personal Work Items.

    Carries only what a later Home composition layer needs to
    render the candidate; the canonical Work Item (and its full
    API representation) remains reachable through
    ``work_item_id``.
    """

    work_item_id: int
    title: str
    project_id: int
    project_name: str
    type_definition_id: int
    type_name: str
    # Current semantic status category: todo / in_progress /
    # review (``done`` candidates are excluded by construction).
    status_category: str
    due_date: date | None
    blocked_reason: str | None


def get_home_my_work_candidates(*, user) -> list[HomeMyWorkCandidate]:
    """Return the current user's Home "My work" candidates.

    A Work Item qualifies iff ALL of the following hold:

    1. the user is currently assigned to it (``WorkItemAssignee``),
    2. the user's CURRENT read authorization still covers it:
       current ``ProjectMembership`` (role ``owner``/``member``)
       in the Work Item's Project AND current
       ``ResearchGroupMembership`` in the Project's Research
       Group — the identical boundary of personal My Work, and
    3. it is not complete (status category is not ``done``).

    Deterministic ordering: Work Item ID ascending (stable ID
    tie-break; the existing My Work projections declare no
    canonical ordering and none is invented here).

    Read-only projection over the canonical ``WorkItem`` table:
    one bounded query with eager-loaded relations (no N+1), no
    rows are created, no Work Item is duplicated, and no Work
    Item internals beyond the candidate fields are exposed.
    """
    candidates: list[HomeMyWorkCandidate] = []

    queryset = (
        personal_my_work_queryset(user)
        .filter(_open_category_filter())
        .select_related("project", "type_definition", "status_definition")
        .order_by("pk")
    )

    for work_item in queryset:
        candidates.append(
            HomeMyWorkCandidate(
                work_item_id=work_item.pk,
                title=work_item.title,
                project_id=work_item.project_id,
                project_name=work_item.project.name,
                type_definition_id=work_item.type_definition_id,
                type_name=work_item.type_definition.name,
                status_category=work_item.status_definition.category,
                due_date=work_item.due_date,
                blocked_reason=work_item.blocked_reason or None,
            )
        )

    return candidates
