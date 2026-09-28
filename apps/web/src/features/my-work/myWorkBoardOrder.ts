import type {
  ApiPersonalWorkItem,
  ApiWorkItemStatus,
} from '../../api/types'

/**
 * Render order of ONE My Work Board column over an already-loaded
 * canonical `GET /api/me/work-items/` payload (foundation.md
 * Section 14b):
 *
 *   1. explicitly positioned items in this category,
 *      `myWorkBoardPosition` ASCENDING;
 *   2. unpositioned items (no row, or a stale row from a different
 *      category → `null`) in the existing canonical fallback order
 *      (creation order: `created_at`, then Work Item ID — the
 *      order the API returns, i.e. the input order here).
 *
 * Presentation only: the List View never uses this ordering and the
 * top-level payload order is never reordered by it. `WorkItem
 * .boardPosition` (Project-local) is never an input.
 */
export function orderMyWorkBoardColumn(
  items: readonly ApiPersonalWorkItem[],
  category: ApiWorkItemStatus,
): ApiPersonalWorkItem[] {
  const inColumn = items.filter(
    (item) => item.statusCategory === category,
  )

  // Array.filter keeps input (canonical) order; a stable sort keeps
  // equal positions (which the server never emits — positions are
  // normalized to unique 1..N) deterministic too.
  const positioned = inColumn
    .filter(
      (item) => item.myWorkBoardPosition != null,
    )
    .sort(
      (left, right) =>
        (left.myWorkBoardPosition as number) -
        (right.myWorkBoardPosition as number),
    )

  const unpositioned = inColumn.filter(
    (item) => item.myWorkBoardPosition == null,
  )

  return [...positioned, ...unpositioned]
}

export interface MyWorkBoardDropResolution {
  // The target My Work column.
  statusCategory: ApiWorkItemStatus
  // The Work Item that must FOLLOW the moved one in the target
  // column (null = end of the column). Never the moved Work Item
  // itself.
  beforeWorkItemId: number | null
  // True when the move changes nothing: a SAME-column drop whose
  // resulting render order is already the persisted one. Cross-
  // column moves are never no-ops (the status changes).
  isNoOp: boolean
}

/**
 * Convert a VISIBLE insertion point into the exact My Work reorder
 * anchor (foundation.md Section 14b): `statusCategory` +
 * `beforeWorkItemId`.
 *
 * The anchor is resolved against the COMPLETE loaded target column
 * (`fullColumn`, in board render order), never against the filtered
 * visible list (`visibleColumn`): filters are presentation-only and
 * must not reorder cards that are currently hidden.
 *
 * - Dropping before a visible card sends THAT card as
 *   `beforeWorkItemId` (the visible gap sits exactly at that
 *   card's slot in the full order).
 * - Dropping after the last visible card sends the FIRST full-order
 *   card that follows the visible tail — a hidden card trailing the
 *   visible list stays AFTER the moved one, so hidden cards keep
 *   their relative order. Only when nothing follows does the move
 *   land at the column end (`null`).
 * - Dropping into the moved item's own "before" gap (same column)
 *   changes nothing → `isNoOp` (the caller sends no request).
 *
 * `fullColumn` and `visibleColumn` must be the same-category
 * projections of the same loaded payload (visible ⊆ full), in
 * `orderMyWorkBoardColumn` render order.
 */
export function resolveMyWorkBoardDrop(
  category: ApiWorkItemStatus,
  movedItem: ApiPersonalWorkItem,
  fullColumn: readonly ApiPersonalWorkItem[],
  visibleColumn: readonly ApiPersonalWorkItem[],
  visibleIndex: number,
): MyWorkBoardDropResolution {
  const sameColumn =
    movedItem.statusCategory === category

  // Clamp defensively (the board only emits 0..visible.length).
  const index = Math.max(
    0,
    Math.min(visibleIndex, visibleColumn.length),
  )

  // The full-order slot of the visible gap: before visible card i
  // = that card's slot; after the last visible card = the slot
  // right after it (slot 0 for an empty visible column).
  let gapFullIndex: number

  if (index < visibleColumn.length) {
    const beforeCard = visibleColumn[index]
    gapFullIndex = fullColumn.findIndex(
      (item) => item.id === beforeCard.id,
    )
  } else {
    const lastVisible =
      visibleColumn[visibleColumn.length - 1]
    gapFullIndex =
      lastVisible === undefined
        ? 0
        : fullColumn.findIndex(
            (item) =>
              item.id === lastVisible.id,
          ) + 1
  }

  // The first full-order card at/after the gap is the card the
  // moved one must be placed BEFORE (null = effective end).
  let beforeWorkItemId: number | null =
    gapFullIndex < fullColumn.length
      ? fullColumn[gapFullIndex].id
      : null

  let isNoOp = false

  if (sameColumn) {
    if (beforeWorkItemId === movedItem.id) {
      // Dropped into its own "before" gap: the item stays put.
      isNoOp = true
    } else {
      // Simulate the server's normalization over the FULL column
      // and compare with the current render order: an identical id
      // sequence means the persisted order is already exactly this
      // placement (e.g. dropped directly before the card that
      // already follows, or at the end while already last).
      const withoutMoved = fullColumn.filter(
        (item) => item.id !== movedItem.id,
      )

      const anchorSlot =
        beforeWorkItemId === null
          ? withoutMoved.length
          : withoutMoved.findIndex(
              (item) =>
                item.id === beforeWorkItemId,
            )

      const simulated = [
        ...withoutMoved.slice(0, anchorSlot),
        movedItem,
        ...withoutMoved.slice(anchorSlot),
      ]

      isNoOp =
        simulated.length === fullColumn.length &&
        simulated.every(
          (item, i) => item.id === fullColumn[i].id,
        )
    }
  }

  return {
    statusCategory: category,
    beforeWorkItemId,
    isNoOp,
  }
}
