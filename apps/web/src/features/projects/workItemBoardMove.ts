/**
 * Pure, server-mirroring transform for optimistic Project Board drag/drop.
 *
 * The server's `reposition_work_item` (POST /api/work-items/{id}/reorder/)
 * is the authority for status and ordering (foundation.md Section 15):
 *
 * - A Board column is one semantic status CATEGORY (todo /
 *   in_progress / review / done), not one concrete StatusDefinition:
 *   every Work Item whose current StatusDefinition belongs to the
 *   category shares the one column and the one project-wide ordering.
 * - Same category as the moved item's current status: a PURE reorder.
 *   The item's concrete StatusDefinition is NEVER changed — not to
 *   the requested same-category definition, not to anything — even
 *   when the item references an inactive definition.
 * - Different category: a real status change to the requested
 *   definition, which the caller must have resolved to an ACTIVE
 *   definition of the Project's own configuration.
 * - The anchor (`beforeWorkItemId`) may reference ANY concrete
 *   StatusDefinition of the target category; null = end of the column.
 * - Every reorder normalizes the FULL target category column to
 *   explicit positions 1..N in render order
 *   (`board_position ASC NULLS LAST, created_at, id`). The other
 *   categories are never renumbered.
 *
 * This helper applies exactly that shape to the local `ApiWorkItem`
 * collection so the Board renders the intended result immediately,
 * before the mutation resolves:
 *
 * - the moved item lands in the target category at the position
 *   implied by the drop slot;
 * - its concrete `statusDefinitionId` changes ONLY for a
 *   cross-category move (to `targetStatusDefinitionId`);
 * - every item of the target category is renumbered 1..N in the new
 *   render order (the server normalization);
 * - every other category keeps its exact items (object references).
 *
 * It operates on the FULL collection, never on a filtered/visible
 * subset, so active Board filters/search cannot corrupt the canonical
 * state. It returns the SAME array reference whenever it cannot apply
 * the move confidently:
 *   - the Work Item is unknown;
 *   - the anchor is unknown, belongs to another category, or is the
 *     moved item itself (a drop the server would reject);
 *   - a same-category move whose desired order already IS the current
 *     canonical order (a genuine no-op — no request is needed).
 * Callers can therefore skip the state update AND the mutation
 * request whenever the return value is the input reference.
 */

import type {
  ApiProjectWorkItemConfiguration,
  ApiWorkItem,
} from '../../api/types'
import { resolveWorkItemStatus } from './workItemMapping'

/**
 * Category column render order — the server's canonical column order:
 * explicit `boardPosition` first (ascending, NULLS LAST), then
 * `createdAt`, then a stable `id` tie-break
 * (foundation.md Section 15: `board_position ASC NULLS LAST,
 * created_at, id`). Pre-existing NULL positions and legacy
 * overlapping position values stay deterministic through the same
 * rule the backend renders with.
 *
 * The comparator reads only the structural
 * `WorkItemBoardOrderKey` fields, which BOTH the canonical
 * `ApiWorkItem` and the Board view model satisfy — the Board's
 * render sort and this optimistic transform therefore share ONE
 * implementation and cannot drift apart again.
 */
export interface WorkItemBoardOrderKey {
  id: number | string
  boardPosition: number | null
  createdAt: string
}

export function compareWorkItemBoardOrder(
  left: WorkItemBoardOrderKey,
  right: WorkItemBoardOrderKey,
): number {
  const leftPosition = left.boardPosition
  const rightPosition = right.boardPosition

  const leftHas = leftPosition != null
  const rightHas = rightPosition != null

  if (leftHas && rightHas) {
    if (leftPosition !== rightPosition) {
      return leftPosition - rightPosition
    }
  } else if (leftHas !== rightHas) {
    // Positioned items render before unpositioned ones.
    return leftHas ? -1 : 1
  }

  // Equal (or unpositioned) positions: creation order, then the
  // stable id — the backend's exact tie-break sequence.
  const leftCreated = Date.parse(left.createdAt)
  const rightCreated = Date.parse(right.createdAt)
  if (
    !Number.isNaN(leftCreated) &&
    !Number.isNaN(rightCreated) &&
    leftCreated !== rightCreated
  ) {
    return leftCreated < rightCreated ? -1 : 1
  }

  // `ApiWorkItem.id` is numeric; the Board view model carries the
  // same id as a string (String(item.id)) — numeric conversion is
  // an exact round-trip for both.
  return Number(left.id) - Number(right.id)
}

export function applyWorkItemBoardMove(
  items: ApiWorkItem[],
  config: ApiProjectWorkItemConfiguration | null,
  workItemId: number,
  statusDefinitionId: number,
  beforeWorkItemId: number | null,
): ApiWorkItem[] {
  const moved = items.find((item) => item.id === workItemId)

  if (!moved) {
    return items
  }

  // Both categories come from the canonical `statusDefinitionId`
  // resolved against the Project configuration — never from the
  // optional legacy `status` string. An unresolvable definition
  // falls back to `todo`, exactly like the Board column the card is
  // rendered in (resolveWorkItemDisplay).
  const categoryOf = (item: ApiWorkItem) =>
    resolveWorkItemStatus(item.statusDefinitionId, config)

  const targetCategory = resolveWorkItemStatus(
    statusDefinitionId,
    config,
  )
  const sameCategory =
    targetCategory === categoryOf(moved)

  // The FULL target category column in canonical render order
  // (covers same-category reorders and cross-category moves; every
  // concrete StatusDefinition of the category is in this one list).
  const fullTargetColumn = items
    .filter((item) => categoryOf(item) === targetCategory)
    .sort(compareWorkItemBoardOrder)

  const movedIndex = fullTargetColumn.findIndex(
    (item) => item.id === workItemId,
  )

  const targetColumn = fullTargetColumn.filter(
    (item) => item.id !== workItemId,
  )

  let insertAt = targetColumn.length

  if (beforeWorkItemId != null) {
    const anchorIndex = targetColumn.findIndex(
      (item) => item.id === beforeWorkItemId,
    )

    if (anchorIndex === -1) {
      // The anchor is unknown, belongs to another category, or is
      // the moved item itself. The server rejects such a drop; do
      // not guess a local position.
      return items
    }

    insertAt = anchorIndex
  }

  if (sameCategory && movedIndex === insertAt) {
    // A genuine no-op: the moved item already sits at the desired
    // slot of the canonical category order. The desired result
    // already holds — no state update and no request.
    return items
  }

  const movedOptimistic: ApiWorkItem = {
    ...moved,
    // A pure same-category reorder NEVER changes the concrete
    // StatusDefinition — only a cross-category move applies the
    // caller-resolved active target definition.
    statusDefinitionId: sameCategory
      ? moved.statusDefinitionId
      : statusDefinitionId,
    boardPosition: insertAt + 1,
  }

  const newTargetOrder = [
    ...targetColumn.slice(0, insertAt),
    movedOptimistic,
    ...targetColumn.slice(insertAt),
  ]

  // Server normalization: the FULL target category column receives
  // explicit positions 1..N in the new render order.
  const positionById = new Map<number, number>()
  newTargetOrder.forEach((item, index) => {
    positionById.set(item.id, index + 1)
  })

  return items.map((item) => {
    if (item.id === workItemId) {
      return movedOptimistic
    }

    const newPosition = positionById.get(item.id)

    if (newPosition == null || newPosition === item.boardPosition) {
      return item
    }

    return { ...item, boardPosition: newPosition }
  })
}
