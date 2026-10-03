"""Canonical personal workspace navigation preferences — read / normalize / persist.

Workspace navigation preferences are personal view state over the
canonical Research Groups (``docs/domain/foundation.md`` §2): the
user's preferred sidebar Research Group ordering plus which Research
Groups — and whose Projects child node — the user manually left
expanded. They persist server-side across navigation, reload,
logout/login, and devices.

Invariants enforced here (the single normalization boundary for
the preference snapshot):

- **Preferences are never authorization.** They grant no
  membership and never grant access to any Research Group. Every
  read and write is constrained by the user's CURRENT
  ResearchGroupMembership (the same current-membership boundary
  ``GET /api/research-groups/`` lists).
- **The default Research Group order is deterministic**: the
  user's currently accessible Research Groups ordered by
  ``created_at`` ASC, then primary key ASC. It is the answer for a
  user with no preference row and the fallback order for accessible
  Research Groups missing from a stored order.
- **Stored ordering normalization**: the user's stored order is
  preserved for still-accessible Research Groups, stale /
  inaccessible IDs are discarded, and currently accessible
  Research Groups missing from the stored order are appended in the
  deterministic default order. The result contains each accessible
  Research Group exactly once.
- **Expanded-state normalization**: stale / inaccessible Research
  Group IDs are discarded; only currently accessible Research
  Groups survive; no duplicates.
- **Stale selections are sanitized on the next load, and the
  cleaned state is persisted** (never returned as a temporary
  projection only).
- **Atomicity**: a complete normalized snapshot is persisted in
  one transaction; no partially updated state can be observed.
- **The contract is a complete snapshot**: a PATCH replaces the
  whole normalized state (it is not an incremental toggle).
  Missing / null fields fail closed to their defaults (empty
  arrays); structurally invalid payloads are rejected (400) without
  persisting anything.
- **Route-driven / contextual expansion is NOT represented**: the
  persisted state records only the user's manual expansion choice.
"""

from django.db import transaction

from .models import ResearchGroup, WorkspaceNavigationPreferences


class WorkspaceNavigationPreferencesError(ValueError):
    """Structural violation of the snapshot contract (API: 400)."""


# ── Snapshot shape ────────────────────────────────────────────────


def default_workspace_navigation_snapshot(default_order) -> dict:
    """The default preference snapshot for a user with no row.

    ``default_order`` is the deterministic default order of the
    user's currently accessible Research Groups (``created_at``
    ASC, primary key ASC).
    """
    return {
        "researchGroupOrder": list(default_order),
        "expandedResearchGroups": [],
        "expandedProjectSections": [],
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


def _row_to_snapshot(prefs: WorkspaceNavigationPreferences) -> dict:
    """Read a persisted row into the API snapshot shape."""
    return {
        "researchGroupOrder": list(prefs.research_group_order or []),
        "expandedResearchGroups": list(
            prefs.expanded_research_groups or []
        ),
        "expandedProjectSections": list(
            prefs.expanded_project_sections or []
        ),
    }


def _snapshots_equal(a: dict, b: dict) -> bool:
    return (
        a["researchGroupOrder"] == b["researchGroupOrder"]
        and set(a["expandedResearchGroups"])
        == set(b["expandedResearchGroups"])
        and set(a["expandedProjectSections"])
        == set(b["expandedProjectSections"])
    )


# ── Current-access boundary (canonical helper) ────────────────────


def _accessible_group_order(user) -> list:
    """The deterministic default order of the user's accessible groups.

    ResearchGroupMembership is the canonical group-access relation
    (both roles grant group read); this is the same current
    membership boundary ``GET /api/research-groups/`` lists, in the
    deterministic default order: ``created_at`` ASC, then primary
    key ASC.
    """
    return list(
        ResearchGroup.objects.filter(memberships__user=user)
        .order_by("created_at", "pk")
        .values_list("pk", flat=True)
    )


# ── Normalization ─────────────────────────────────────────────────


def _sanitize_snapshot(default_order, snapshot: dict) -> dict:
    """Normalize a complete snapshot against the user's CURRENT access.

    Drops (never persists, never returns):
    - Research Group IDs the user no longer belongs to,
    - duplicates (order-preserving for the order list).

    Appends:
    - currently accessible Research Groups missing from the stored
      order, in the deterministic default order.
    """
    accessible = set(default_order)
    stored_order = _dedupe(
        group_id
        for group_id in snapshot["researchGroupOrder"]
        if group_id in accessible
    )
    kept = set(stored_order)
    return {
        "researchGroupOrder": stored_order
        + [group_id for group_id in default_order if group_id not in kept],
        "expandedResearchGroups": _dedupe(
            group_id
            for group_id in snapshot["expandedResearchGroups"]
            if group_id in accessible
        ),
        "expandedProjectSections": _dedupe(
            group_id
            for group_id in snapshot["expandedProjectSections"]
            if group_id in accessible
        ),
    }


def _persist_snapshot(user, snapshot: dict) -> None:
    """Atomically persist the complete normalized snapshot."""
    with transaction.atomic():
        prefs, _ = WorkspaceNavigationPreferences.objects.get_or_create(
            user=user,
            defaults={
                "research_group_order": list(
                    snapshot["researchGroupOrder"]
                ),
                "expanded_research_groups": list(
                    snapshot["expandedResearchGroups"]
                ),
                "expanded_project_sections": list(
                    snapshot["expandedProjectSections"]
                ),
            },
        )
        prefs.research_group_order = list(
            snapshot["researchGroupOrder"]
        )
        prefs.expanded_research_groups = list(
            snapshot["expandedResearchGroups"]
        )
        prefs.expanded_project_sections = list(
            snapshot["expandedProjectSections"]
        )
        prefs.save(
            update_fields=[
                "research_group_order",
                "expanded_research_groups",
                "expanded_project_sections",
                "updated_at",
            ]
        )


# ── Public operations ─────────────────────────────────────────────


def get_workspace_navigation_preferences(user) -> dict:
    """Return the user's current workspace navigation snapshot.

    No row → the default snapshot (all accessible Research Groups
    in the deterministic default order, nothing expanded); a clean
    read does not create a row.

    With a row → the persisted state sanitized against CURRENT
    access. If sanitization changed anything, the cleaned state is
    persisted before being returned, so stale inaccessible group
    IDs never survive a read.
    """
    default_order = _accessible_group_order(user)
    prefs = (
        WorkspaceNavigationPreferences.objects.filter(user=user).first()
    )
    if prefs is None:
        return default_workspace_navigation_snapshot(default_order)

    stored = _row_to_snapshot(prefs)
    snapshot = _sanitize_snapshot(default_order, stored)
    if not _snapshots_equal(snapshot, stored):
        _persist_snapshot(user, snapshot)
    return snapshot


def update_workspace_navigation_preferences(user, payload) -> dict:
    """Normalize + atomically persist a complete-snapshot PATCH.

    Returns the normalized snapshot that was persisted. Structurally
    invalid payloads raise ``WorkspaceNavigationPreferencesError``
    (API: 400) and persist nothing.
    """
    if not isinstance(payload, dict):
        raise WorkspaceNavigationPreferencesError(
            "The request body must be a JSON object."
        )

    snapshot = _sanitize_snapshot(
        _accessible_group_order(user),
        {
            "researchGroupOrder": _id_list(
                payload, "researchGroupOrder"
            ),
            "expandedResearchGroups": _id_list(
                payload, "expandedResearchGroups"
            ),
            "expandedProjectSections": _id_list(
                payload, "expandedProjectSections"
            ),
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
        raise WorkspaceNavigationPreferencesError(
            f"{field} must be an array of integer IDs."
        )
    return value
