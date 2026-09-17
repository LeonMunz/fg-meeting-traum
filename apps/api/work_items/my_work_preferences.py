"""Canonical personal My Work preferences — read / normalize / persist.

My Work preferences are personal view state over the canonical
Work Items (``docs/domain/foundation.md`` §14a): Board vs List
presentation plus the user's selected Research Group, Project, and
semantic Work Item type kind filters. They persist server-side
across navigation, reload, logout/login, and devices.

Invariants enforced here (the single normalization boundary for
the preference snapshot):

- **Preferences are never authorization.** They grant no
  membership and never grant access to any Research Group,
  Project, or Work Item. Every read and write is constrained by
  the user's CURRENT access; the current memberships are always
  authoritative over stored IDs.
- **Research Group selections** retain only groups the user
  currently belongs to (the same current-membership boundary
  ``GET /api/research-groups/`` lists).
- **Project selections** retain only Projects the user currently
  has effective access to (the canonical
  ``get_accessible_project_qs`` boundary: current
  ProjectMembership + current ResearchGroupMembership). When a
  non-empty Research Group selection survives, selected Projects
  must also belong to one of those selected groups; an empty
  group selection means all currently accessible groups, so
  Projects are then constrained only by current access.
- **Type selections** retain only canonical
  ``WorkItemTypeDefinition.Kind`` values (``task`` / ``epic`` /
  ``milestone`` / ``deliverable``). A kind is never inferred from
  a display name; a custom definition named after a canonical
  kind is not a semantic type filter value, and a kind value does
  not require any project-local definition to exist.
- **Stale selections are sanitized on the next load, and the
  cleaned state is persisted** (never returned as a temporary
  projection only).
- **Atomicity**: a complete normalized snapshot is persisted in
  one transaction; no partially updated category state can be
  observed.
- **The contract is a complete snapshot**: a PATCH replaces the
  whole normalized state (it is not an incremental toggle).
  Missing / null fields fail closed to their defaults;
  structurally invalid payloads are rejected (400) without
  persisting anything.
"""

from django.db import transaction

from projects.models import WorkItemTypeDefinition
from projects.services import get_accessible_project_qs
from research_groups.models import ResearchGroupMembership

from .models import MyWorkPreferences

# ── Canonical values ──────────────────────────────────────────────

VIEW_MODE_BOARD = "board"
VIEW_MODE_LIST = "list"
VIEW_MODES = (VIEW_MODE_BOARD, VIEW_MODE_LIST)
DEFAULT_VIEW_MODE = VIEW_MODE_BOARD

#: The complete set of canonical semantic Work Item type kinds
#: (``WorkItemTypeDefinition.Kind``). Nothing else may be persisted
#: as a semantic type filter value — not display names, not
#: arbitrary strings, not project-local definition identifiers.
VALID_WORK_ITEM_TYPE_KINDS = frozenset(
    WorkItemTypeDefinition.Kind.values
)


class MyWorkPreferencesError(ValueError):
    """Structural violation of the snapshot contract (API: 400)."""


# ── Snapshot shape ────────────────────────────────────────────────


def default_my_work_snapshot() -> dict:
    """The default preference snapshot for a user with no row."""
    return {
        "viewMode": DEFAULT_VIEW_MODE,
        "researchGroupIds": [],
        "projectIds": [],
        "workItemTypes": [],
    }


def _dedupe(items):
    """Order-preserving deduplication."""
    seen = set()
    result = []
    for item in items:
        if item not in seen:
            seen.add(item)
            result.append(item)
    return result


def _row_to_snapshot(prefs: MyWorkPreferences) -> dict:
    """Read a persisted row into the API snapshot shape.

    ID lists are returned in a deterministic ascending-PK order
    (the M2M selections are unordered sets; presentation order is
    not part of the filter semantics).
    """
    return {
        "viewMode": prefs.view_mode,
        "researchGroupIds": sorted(
            prefs.research_groups.values_list("pk", flat=True)
        ),
        "projectIds": sorted(
            prefs.projects.values_list("pk", flat=True)
        ),
        "workItemTypes": list(prefs.work_item_types or []),
    }


def _snapshots_equal(a: dict, b: dict) -> bool:
    return (
        a["viewMode"] == b["viewMode"]
        and set(a["researchGroupIds"]) == set(b["researchGroupIds"])
        and set(a["projectIds"]) == set(b["projectIds"])
        and set(a["workItemTypes"]) == set(b["workItemTypes"])
    )


# ── Current-access boundaries (canonical helpers) ─────────────────


def _accessible_research_group_ids(user) -> set:
    """IDs of the Research Groups the user currently belongs to.

    ResearchGroupMembership is the canonical group-access relation
    (both roles grant group read); this is the same current
    membership boundary ``GET /api/research-groups/`` lists.
    """
    return set(
        ResearchGroupMembership.objects.filter(user=user)
        .values_list("research_group_id", flat=True)
    )


def _accessible_project_ids(user, selected_group_ids) -> set:
    """IDs of the Projects the user currently has effective access to.

    Reuses the canonical accessible-Project boundary
    (``get_accessible_project_qs``: current ProjectMembership,
    whose composite FK structurally requires a current
    ResearchGroupMembership in the Project's group). When a
    non-empty Research Group selection exists, selected Projects
    must also belong to one of those selected groups.
    """
    projects = get_accessible_project_qs(user)
    if selected_group_ids:
        projects = projects.filter(
            research_group_id__in=selected_group_ids
        )
    return set(projects.values_list("pk", flat=True))


# ── Normalization ─────────────────────────────────────────────────


def _sanitize_snapshot(user, snapshot: dict) -> dict:
    """Normalize a complete snapshot against the user's CURRENT access.

    Drops (never persists, never returns):
    - Research Group IDs the user no longer belongs to,
    - Project IDs the user no longer has effective access to,
    - Projects outside a non-empty surviving Research Group
      selection,
    - type values that are not canonical semantic kind values.
    """
    accessible_groups = _accessible_research_group_ids(user)
    groups = _dedupe(
        group_id
        for group_id in snapshot["researchGroupIds"]
        if group_id in accessible_groups
    )
    accessible_projects = _accessible_project_ids(user, groups)
    projects = _dedupe(
        project_id
        for project_id in snapshot["projectIds"]
        if project_id in accessible_projects
    )
    types = _dedupe(
        kind for kind in snapshot["workItemTypes"]
        if kind in VALID_WORK_ITEM_TYPE_KINDS
    )
    return {
        "viewMode": snapshot["viewMode"],
        "researchGroupIds": groups,
        "projectIds": projects,
        "workItemTypes": types,
    }


def _persist_snapshot(user, snapshot: dict) -> None:
    """Atomically persist the complete normalized snapshot."""
    with transaction.atomic():
        prefs, _ = MyWorkPreferences.objects.get_or_create(
            user=user,
            defaults={
                "view_mode": snapshot["viewMode"],
                "work_item_types": list(snapshot["workItemTypes"]),
            },
        )
        prefs.view_mode = snapshot["viewMode"]
        prefs.work_item_types = list(snapshot["workItemTypes"])
        prefs.save(
            update_fields=["view_mode", "work_item_types", "updated_at"]
        )
        prefs.research_groups.set(snapshot["researchGroupIds"])
        prefs.projects.set(snapshot["projectIds"])


# ── Public operations ─────────────────────────────────────────────


def get_my_work_preferences(user) -> dict:
    """Return the user's current My Work preference snapshot.

    No row → the default snapshot (board + three empty filter
    arrays); a clean read does not create a row.

    With a row → the persisted state sanitized against CURRENT
    access. If sanitization changed anything, the cleaned state is
    persisted before being returned, so stale inaccessible
    selections never survive a read.
    """
    prefs = MyWorkPreferences.objects.filter(user=user).first()
    if prefs is None:
        return default_my_work_snapshot()

    stored = _row_to_snapshot(prefs)
    snapshot = _sanitize_snapshot(user, stored)
    if not _snapshots_equal(snapshot, stored):
        _persist_snapshot(user, snapshot)
    return snapshot


def update_my_work_preferences(user, payload) -> dict:
    """Normalize + atomically persist a complete-snapshot PATCH.

    Returns the normalized snapshot that was persisted. Structurally
    invalid payloads raise ``MyWorkPreferencesError`` (API: 400)
    and persist nothing.
    """
    if not isinstance(payload, dict):
        raise MyWorkPreferencesError(
            "The request body must be a JSON object."
        )

    view_mode = payload.get("viewMode")
    if view_mode is None:
        view_mode = DEFAULT_VIEW_MODE
    elif view_mode not in VIEW_MODES:
        raise MyWorkPreferencesError("viewMode must be 'board' or 'list'.")

    snapshot = _sanitize_snapshot(
        user,
        {
            "viewMode": view_mode,
            "researchGroupIds": _id_list(payload, "researchGroupIds"),
            "projectIds": _id_list(payload, "projectIds"),
            "workItemTypes": _string_list(payload, "workItemTypes"),
        },
    )
    _persist_snapshot(user, snapshot)
    return snapshot


# ── Structural payload validation (fail-closed) ───────────────────


def _id_list(payload: dict, field: str) -> list:
    """Validate a complete-snapshot ID array (missing/null → [])."""
    value = payload.get(field)
    if value is None:
        return []
    if not isinstance(value, list) or any(
        isinstance(item, bool) or not isinstance(item, int)
        for item in value
    ):
        raise MyWorkPreferencesError(
            f"{field} must be an array of integer IDs."
        )
    return value


def _string_list(payload: dict, field: str) -> list:
    """Validate a complete-snapshot string array (missing/null → [])."""
    value = payload.get(field)
    if value is None:
        return []
    if not isinstance(value, list) or any(
        not isinstance(item, str) for item in value
    ):
        raise MyWorkPreferencesError(
            f"{field} must be an array of strings."
        )
    return value
