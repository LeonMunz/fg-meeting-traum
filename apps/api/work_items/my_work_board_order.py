"""Canonical My Work Board ordering — personal, server-persisted.

My Work Board ordering is PERSONAL, SERVER-PERSISTED view state over
the canonical Work Items (``docs/domain/foundation.md`` §14b). It is
NOT the Project Board:

- The persisted relation is ``MyWorkBoardPosition`` — one row per
  (user, Work Item) holding a 1-based ``position`` within exactly one
  fixed semantic status category (``status_category``). A position is
  applied ONLY in the category it was created for; a row whose
  category no longer matches the Work Item's current status category
  is stale and positions the Work Item nowhere.
- ``WorkItem.board_position`` stays Project-local and is never read,
  written, or renumbered here.
- Ordering is personal: a move touches ONLY the requesting user's
  rows. Other users' ordering is untouched.
- Concurrency: the user's personal column spans all of the user's
  Work Items across Projects, so a single Project row cannot
  serialize the user's moves. Every move therefore acquires the
  canonical User row lock FIRST inside its transaction
  (``select_for_update`` on the User row), before any other lock:
  same-user My Work reorder operations serialize on that one stable
  per-user row and can never normalize the same personal column
  from a stale snapshot. The canonical Project / moved Work Item
  row locks are taken ONLY on the cross-category path, where the
  canonical status mutation requires them; the personal
  ``MyWorkBoardPosition`` locks remain user-specific. The canonical
  sibling Work Items used to compute the personal column are READ,
  never locked: a personal reorder never mutates a Work Item row,
  so different users do NOT contend on canonical sibling WorkItem
  rows merely because their personal My Work columns overlap (the
  pre-fix cross-user ABBA lock cycle on shared canonical WorkItem
  rows is eliminated). Cross-category moves may still legitimately
  contend on the canonical Project / moved WorkItem locks — the
  canonical status mutation requires them — when they mutate
  shared canonical domain state.
- The rows are view state, never authorization: they grant no
  membership and never grant access to any Work Item. Every read and
  write is constrained by the user's CURRENT My Work projection
  (``work_items.personal_my_work``); lost assignment/access never
  makes stale personal metadata visible.

One atomic move operation (``move_my_work_item``):

- Same semantic category: no Work Item status mutation, no Work Item
  audit/history event — only the requesting user's personal ordering
  changes.
- Different semantic category: the concrete target
  ``WorkItemStatusDefinition`` is resolved with the same canonical
  Project-local rule the My Work read payload uses for
  ``statusTargets`` (active definition in that category owned by the
  Work Item's Project; first by configured status order, stable
  definition-ID tie-break). The canonical status change goes through
  ``transition_work_item_status`` (authorization, archived/read-only
  rules, completion semantics, exactly one ``work_item.updated``
  history event for a real change), and the personal target position
  is written in the SAME transaction — a failed placement never
  leaves the Work Item in a new status with the personal move
  missing, and vice versa.

Column semantics: the user's My Work column for one semantic category
is the user's current My Work projection restricted to that category
(Work Items across Projects). It renders by effective personal order:
explicitly positioned items first (``position`` ascending), then
unpositioned items in canonical creation order (``created_at``,
``id``) — an item with no applicable personal position is unsorted
and appears after explicitly positioned items. On every move the
target column is normalized: all of its items receive explicit
positions 1..N in their resulting render order.
"""

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import F

from projects.models import Project, WorkItemStatusDefinition

from .models import MyWorkBoardPosition, WorkItem
from .personal_my_work import personal_my_work_queryset
from .services import (
    WorkItemDomainError,
    transition_work_item_status,
)

# The fixed semantic categories a My Work Board column can target
# (WorkItemStatusDefinition.Category values).
MY_WORK_STATUS_CATEGORIES = WorkItemStatusDefinition.Category.values


def resolve_my_work_status_target(
    project: Project, category: str
) -> WorkItemStatusDefinition | None:
    """The concrete project-local StatusDefinition a My Work
    cross-category move into ``category`` resolves to, or ``None``.

    Canonical rule (identical to the My Work read payload
    ``statusTargets`` resolution): eligible targets are owned by the
    Work Item's own Project, ``active``, and in ``category``; when
    several are eligible the first by the Project's configured status
    order wins, with a stable status-definition ID tie-break. Display
    names never participate in resolution. A category with no active
    definition yields ``None`` (no artificial statuses are invented).
    """
    return (
        WorkItemStatusDefinition.objects.filter(
            project=project,
            category=category,
            active=True,
        )
        .order_by("order", "id")
        .first()
    )


def effective_my_work_board_positions(
    user, work_item_ids
) -> dict[int, int]:
    """Bulk effective personal My Work positions for a user's items.

    Returns ``{work_item_id: position}`` containing ONLY the Work
    Items with an APPLICABLE personal position — a stored row is
    effective only when its ``status_category`` still matches the
    Work Item's CURRENT status category (stale rows from another
    category position the Work Item nowhere; items with no row are
    absent from the result and therefore ``null``). One constant
    query per call; the caller passes only Work Items it is already
    authorized to return, so this never widens the My Work boundary.
    """
    if not work_item_ids:
        return {}
    return dict(
        MyWorkBoardPosition.objects.filter(
            user=user,
            work_item_id__in=list(work_item_ids),
            # A position applies only in the semantic category it was
            # created for: the Work Item's CURRENT status category
            # must equal the row's stored category.
            work_item__status_definition__category=F("status_category"),
        ).values_list("work_item_id", "position")
    )


def _user_column(
    user, category: str, exclude_pk: int
) -> tuple[list[WorkItem], dict[int, int]]:
    """Read and render the user's current My Work column for one
    semantic category (excluding one Work Item).

    Returns the column in its effective render order — explicitly
    positioned items first (``position`` ascending), then unpositioned
    items in canonical creation order — plus the stored positions.
    Called INSIDE the move transaction, under the per-user User row
    lock. Sibling Work Items are READ, never ``select_for_update()``
    locked: a personal reorder never mutates a canonical Work Item
    row, and a Work Item may be assigned to several users — locking
    the shared canonical rows here would only let two users holding
    different User-row locks deadlock on each other's overlapping
    columns. Only the requesting user's own ``MyWorkBoardPosition``
    rows are locked (the rows this move writes).
    """
    column_ids = list(
        personal_my_work_queryset(user)
        .filter(status_definition__category=category)
        .exclude(pk=exclude_pk)
        .values_list("pk", flat=True)
    )
    column_items = list(
        WorkItem.objects.filter(pk__in=column_ids).order_by("created_at", "id")
    )
    stored_positions = {
        work_item_id: position
        for work_item_id, position in MyWorkBoardPosition.objects.filter(
            user=user,
            status_category=category,
            work_item_id__in=column_ids,
        )
        .select_for_update()
        .values_list("work_item_id", "position")
    }
    # Effective render order: positioned first (position ASC), then
    # unpositioned in canonical creation order.
    column_items.sort(
        key=lambda wi: (
            (0, stored_positions[wi.pk])
            if wi.pk in stored_positions
            else (1, 0)
        )
        + (wi.created_at, wi.pk)
    )
    return column_items, stored_positions


def move_my_work_item(
    *,
    user,
    work_item: WorkItem,
    status_category: str,
    before_work_item_id: int | None = None,
) -> WorkItem:
    """One atomic My Work Board move for the requesting user.

    Moves the Work Item to an exact position in the user's My Work
    column for ``status_category``:

    - ``before_work_item_id`` anchors the insertion immediately
      before that Work Item; ``None`` places it at the end of the
      column (also the empty-column case).
    - Same semantic category as the Work Item's CURRENT status: no
      status mutation, no Work Item history event — only the user's
      personal ordering changes.
    - Different semantic category: the canonical status transition
      (``transition_work_item_status`` semantics — authorization,
      archived/read-only rules, completion semantics, exactly one
      ``work_item.updated`` event for a real change) AND the personal
      position are written in one transaction.

    The target column is normalized to explicit positions 1..N in its
    resulting render order; ONLY the requesting user's rows are
    written. ``WorkItem.board_position`` (Project-local Board order)
    is never read or written.

    Concurrency: the User row of the requesting user is locked FIRST
    inside the transaction — concurrent moves by the same user
    serialize on that one stable per-user row (the personal column
    spans Projects, so the moved item's Project row alone is not a
    sufficient lock root). The canonical Project / moved Work Item
    row locks are taken ONLY on the cross-category path, where the
    canonical status mutation requires them; the same-category
    personal reorder takes no canonical row lock at all (it never
    mutates a Work Item row), and the canonical sibling Work Items
    used to compute the personal column are read, never locked — so
    different users with overlapping assignments never contend on
    canonical Work Item row locks over My Work ordering.

    Raises ``WorkItemDomainError`` (API: 400) on any domain violation;
    the transaction rolls back completely on failure.
    """
    project = work_item.project

    # Pre-flight: the cross-category target must exist BEFORE the
    # transaction (a missing target is a rejected move, not a
    # rollback). Under the lock the transition re-resolves and
    # re-validates the definition (active + same Project).
    if work_item.status_definition.category != status_category:
        if resolve_my_work_status_target(project, status_category) is None:
            raise WorkItemDomainError(
                "The Work Item's Project has no active status "
                f"definition for category '{status_category}'."
            )

    with transaction.atomic():
        # Lock root for the PER-USER ordering invariant: the
        # requesting user's canonical User row, locked FIRST, before
        # any other lock. The personal column spans all of the user's
        # Work Items across Projects, so two moves by the same user in
        # different Projects would otherwise interleave their column
        # reads/writes (a stale-column overwrite). Same-user My Work
        # reorder operations serialize on this one stable per-user
        # row; different users lock different User rows, so they do
        # not contend over personal ordering (cross-category moves
        # may still contend on the canonical Project / moved Work
        # Item locks the status mutation requires).
        get_user_model().objects.select_for_update().get(pk=user.pk)

        if work_item.status_definition.category != status_category:
            # Canonical status-change path: the canonical Project and
            # moved Work Item row locks are taken HERE — only where a
            # canonical Work Item mutation requires them (the
            # canonical transition below re-acquires them as a no-op
            # inside the same transaction).
            locked_project = Project.objects.select_for_update().get(
                pk=project.pk
            )
            work_item = WorkItem.objects.select_for_update().get(
                pk=work_item.pk
            )

            # Re-check under the lock: the Work Item must STILL be in
            # the user's current My Work projection (an assignment or
            # access revocation in the meantime voids the move).
            if not personal_my_work_queryset(user).filter(
                pk=work_item.pk
            ).exists():
                raise WorkItemDomainError(
                    "The Work Item is not in your My Work."
                )

            # Cross-category decision under the lock (a concurrent
            # status change may have moved the Work Item since the
            # pre-check).
            if work_item.status_definition.category != status_category:
                target = resolve_my_work_status_target(
                    locked_project, status_category
                )
                if target is None:
                    raise WorkItemDomainError(
                        "The Work Item's Project has no active status "
                        f"definition for category '{status_category}'."
                    )
                # Canonical status-only transition: authorization,
                # archived/read-only rules, completion semantics, and
                # exactly one work_item.updated history event for a
                # real change. Runs inside THIS transaction, so a
                # failure in the personal placement below rolls the
                # status change back too (and vice versa).
                transition_work_item_status(
                    work_item=work_item,
                    actor=user,
                    status_definition_id=target.pk,
                )
                work_item.refresh_from_db()
        else:
            # Same-category personal reorder: NO canonical Project /
            # Work Item row locks — the move never mutates a Work
            # Item row, so the per-user User row lock above is the
            # only serialization it needs. Fresh (unlocked) read +
            # projection re-check under the per-user lock.
            work_item = WorkItem.objects.get(pk=work_item.pk)
            if not personal_my_work_queryset(user).filter(
                pk=work_item.pk
            ).exists():
                raise WorkItemDomainError(
                    "The Work Item is not in your My Work."
                )

        column_items, _ = _user_column(
            user, status_category, exclude_pk=work_item.pk
        )

        # The anchor must still be in the column under the lock
        # (a concurrent status change may have removed it).
        if before_work_item_id is not None:
            anchor_pks = [wi.pk for wi in column_items]
            if before_work_item_id not in anchor_pks:
                raise WorkItemDomainError(
                    "beforeWorkItemId must reference a Work Item in "
                    "your My Work in the requested category."
                )
            anchor_index = anchor_pks.index(before_work_item_id)
            new_order = (
                column_items[:anchor_index]
                + [work_item]
                + column_items[anchor_index:]
            )
        else:
            new_order = column_items + [work_item]

        # Normalize the user's target column: explicit positions 1..N
        # in the resulting render order. ONLY this user's rows are
        # written; other users' ordering is untouched.
        for index, wi in enumerate(new_order, start=1):
            MyWorkBoardPosition.objects.update_or_create(
                user=user,
                work_item=wi,
                defaults={
                    "status_category": status_category,
                    "position": index,
                },
            )

    return work_item
