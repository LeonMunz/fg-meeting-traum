/**
 * Pure, server-mirroring transform for optimistic Project Board drag/drop.
 *
 * The server's `reposition_work_item` (POST /api/work-items/{id}/reorder/)
 * is the authority for status and ordering: it changes the moved Work
 * Item's `status_definition` (cross-column drops) and inserts it at an
 * exact position in ONE atomic operation, then normalizes the whole
 * TARGET column to explicit positions 1..N in render order
 * (`board_position ASC NULLS LAST, created_at, id`). The source column
 * is never renumbered (it keeps its positions, now with a gap).
 *
 * This helper applies exactly that shape to the local `ApiWorkItem`
 * collection so the Board renders the intended result immediately,
 * before the mutation resolves:
 *
 * - the moved item takes the target `statusDefinitionId` and the
 *   position implied by the drop slot;
 * - every other item of the target column is renumbered 1..N in the
 *   new render order (the server normalization);
 * - the source column and every other item are left untouched.
 *
 * It operates on the FULL collection, never on a filtered/visible
 * subset, so active Board filters/search cannot corrupt the canonical
 * state. It returns the SAME array reference whenever it cannot apply
 * the move confidently (unknown item, or an insertion anchor that is
 * not in the target column — a drop the server would reject), so
 * callers can skip the state update and let the server answer.
 */

import type { ApiWorkItem } from '../../api/types'

/**
 * Board render order: explicit positions first (ascending), then
 * unpositioned items in creation order (server id). This mirrors the
 * server column ordering, with `id` standing in for `created_at` in
 * the tie-break the same way the Board's own order does.
 */
function compareBoardRenderOrder(
  left: ApiWorkItem,
  right: ApiWorkItem,
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

  return left.id - right.id
}

export function applyWorkItemBoardMove(
  items: ApiWorkItem[],
  workItemId: number,
  statusDefinitionId: number,
  beforeWorkItemId: number | null,
): ApiWorkItem[] {
  const moved = items.find((item) => item.id === workItemId)

  if (!moved) {
    return items
  }

  // Target column in render order, without the moved item (covers
  // both same-column reorders and cross-column moves).
  const targetColumn = items
    .filter(
      (item) =>
        item.id !== workItemId &&
        item.statusDefinitionId === statusDefinitionId,
    )
    .sort(compareBoardRenderOrder)

  let insertAt = targetColumn.length

  if (beforeWorkItemId != null) {
    const anchorIndex = targetColumn.findIndex(
      (item) => item.id === beforeWorkItemId,
    )

    if (anchorIndex === -1) {
      // The anchor is not in the target status column (it may belong
      // to another definition of the same category, or it is the
      // moved item itself). The server rejects such a drop; do not
      // guess a local position.
      return items
    }

    insertAt = anchorIndex
  }

  const movedOptimistic: ApiWorkItem = {
    ...moved,
    statusDefinitionId,
    boardPosition: insertAt + 1,
  }

  const newTargetOrder = [
    ...targetColumn.slice(0, insertAt),
    movedOptimistic,
    ...targetColumn.slice(insertAt),
  ]

  // Server normalization: the whole target column receives explicit
  // positions 1..N in the new render order.
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
