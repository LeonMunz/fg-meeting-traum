// @vitest-environment happy-dom

import {
  describe,
  expect,
  it,
} from 'vitest'

import type { ApiWorkItem } from '../../api/types'

import { applyWorkItemBoardMove } from './workItemBoardMove'

const NOW = '2026-09-01T00:00:00Z'

const TODO = 10
const IN_PROGRESS = 11

function makeItem(
  id: number,
  statusDefinitionId: number,
  boardPosition: number | null,
  title = `Work item ${id}`,
): ApiWorkItem {
  return {
    id,
    projectId: 7,
    title,
    description: '',
    typeDefinitionId: 4,
    statusDefinitionId,
    boardPosition,
    labelDefinitionIds: [],
    assigneeIds: [],
    parentId: null,
    dueDate: null,
    blockedReason: null,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    createdById: 1,
    meetingOrigin: null,
  }
}

function columnOf(
  items: ApiWorkItem[],
  statusDefinitionId: number,
): Array<{ id: number; boardPosition: number | null }> {
  const column = items
    .filter(
      (item) =>
        item.statusDefinitionId === statusDefinitionId,
    )
    .sort((left, right) => {
      const leftPosition = left.boardPosition
      const rightPosition = right.boardPosition
      const leftHas = leftPosition != null
      const rightHas = rightPosition != null

      if (leftHas && rightHas) {
        if (leftPosition !== rightPosition) {
          return leftPosition - rightPosition
        }
      } else if (leftHas !== rightHas) {
        return leftHas ? -1 : 1
      }

      return left.id - right.id
    })

  return column.map((item) => ({
    id: item.id,
    boardPosition: item.boardPosition,
  }))
}

describe('applyWorkItemBoardMove', () => {
  it('moves a card cross-column to the end of the target column and renumbers it', () => {
    const items = [
      makeItem(1, TODO, 1, 'Alpha'),
      makeItem(2, TODO, 2, 'Beta'),
      makeItem(3, IN_PROGRESS, 1, 'Gamma'),
    ]

    const next = applyWorkItemBoardMove(
      items,
      1,
      IN_PROGRESS,
      null,
    )

    expect(next).not.toBe(items)

    // The moved item carries the target status and the position
    // implied by the drop slot.
    const moved = next.find((item) => item.id === 1)
    expect(moved?.statusDefinitionId).toBe(IN_PROGRESS)
    expect(moved?.boardPosition).toBe(2)

    // The whole target column is normalized to 1..N in render order.
    expect(columnOf(next, IN_PROGRESS)).toEqual([
      { id: 3, boardPosition: 1 },
      { id: 1, boardPosition: 2 },
    ])

    // The source column is NOT renumbered: the server keeps the
    // surviving positions (now with a gap).
    expect(columnOf(next, TODO)).toEqual([
      { id: 2, boardPosition: 2 },
    ])
  })

  it('moves a card cross-column before an explicit anchor', () => {
    const items = [
      makeItem(1, TODO, 1, 'Alpha'),
      makeItem(2, TODO, 2, 'Beta'),
      makeItem(3, IN_PROGRESS, 1, 'Gamma'),
      makeItem(4, IN_PROGRESS, 2, 'Delta'),
    ]

    const next = applyWorkItemBoardMove(
      items,
      2,
      IN_PROGRESS,
      3,
    )

    expect(columnOf(next, IN_PROGRESS)).toEqual([
      { id: 2, boardPosition: 1 },
      { id: 3, boardPosition: 2 },
      { id: 4, boardPosition: 3 },
    ])
    expect(columnOf(next, TODO)).toEqual([
      { id: 1, boardPosition: 1 },
    ])
  })

  it('reorders within the same column and renumbers the column', () => {
    const items = [
      makeItem(1, TODO, 1, 'Alpha'),
      makeItem(2, TODO, 2, 'Beta'),
      makeItem(3, TODO, 3, 'Gamma'),
    ]

    // Drag Gamma to the front (before Alpha).
    const next = applyWorkItemBoardMove(
      items,
      3,
      TODO,
      1,
    )

    expect(columnOf(next, TODO)).toEqual([
      { id: 3, boardPosition: 1 },
      { id: 1, boardPosition: 2 },
      { id: 2, boardPosition: 3 },
    ])
    // No status change on a same-column reorder.
    expect(next.find((item) => item.id === 3)?.statusDefinitionId)
      .toBe(TODO)
  })

  it('inserts mid-column when dropped before the second card', () => {
    const items = [
      makeItem(1, TODO, 1, 'Alpha'),
      makeItem(2, TODO, 2, 'Beta'),
      makeItem(3, TODO, 3, 'Gamma'),
    ]

    const next = applyWorkItemBoardMove(
      items,
      1,
      TODO,
      3,
    )

    expect(columnOf(next, TODO)).toEqual([
      { id: 2, boardPosition: 1 },
      { id: 1, boardPosition: 2 },
      { id: 3, boardPosition: 3 },
    ])
  })

  it('handles unpositioned (null) items: positioned first, then creation order', () => {
    const items = [
      // In-progress column: Gamma positioned, Zeta unpositioned.
      makeItem(3, IN_PROGRESS, 1, 'Gamma'),
      makeItem(6, IN_PROGRESS, null, 'Zeta'),
      // Todo column: the card to move.
      makeItem(1, TODO, 1, 'Alpha'),
    ]

    // End of the in-progress column: after the unpositioned item.
    const toEnd = applyWorkItemBoardMove(
      items,
      1,
      IN_PROGRESS,
      null,
    )

    expect(columnOf(toEnd, IN_PROGRESS)).toEqual([
      { id: 3, boardPosition: 1 },
      { id: 6, boardPosition: 2 },
      { id: 1, boardPosition: 3 },
    ])

    // Before the unpositioned anchor: between Gamma and Zeta.
    const beforeZeta = applyWorkItemBoardMove(
      items,
      1,
      IN_PROGRESS,
      6,
    )

    expect(columnOf(beforeZeta, IN_PROGRESS)).toEqual([
      { id: 3, boardPosition: 1 },
      { id: 1, boardPosition: 2 },
      { id: 6, boardPosition: 3 },
    ])
  })

  it('appends to the end when the target column is empty', () => {
    const items = [
      makeItem(1, TODO, 1, 'Alpha'),
      makeItem(2, IN_PROGRESS, 1, 'Gamma'),
    ]

    const next = applyWorkItemBoardMove(
      items,
      2,
      TODO,
      null,
    )

    // Todo column was [Alpha pos 1] before the move.
    expect(columnOf(next, TODO)).toEqual([
      { id: 1, boardPosition: 1 },
      { id: 2, boardPosition: 2 },
    ])
  })

  it('returns the same array when the anchor is unknown (server-rejected drop)', () => {
    const items = [
      makeItem(1, TODO, 1, 'Alpha'),
      makeItem(3, IN_PROGRESS, 1, 'Gamma'),
    ]

    expect(
      applyWorkItemBoardMove(items, 1, IN_PROGRESS, 999),
    ).toBe(items)
  })

  it('returns the same array when the anchor is in another column', () => {
    const items = [
      makeItem(1, TODO, 1, 'Alpha'),
      makeItem(2, TODO, 2, 'Beta'),
      makeItem(3, IN_PROGRESS, 1, 'Gamma'),
    ]

    // Beta is a TODO item: the server rejects it as an anchor for an
    // IN_PROGRESS drop.
    expect(
      applyWorkItemBoardMove(items, 1, IN_PROGRESS, 2),
    ).toBe(items)
  })

  it('returns the same array when the anchor is the moved item itself', () => {
    const items = [
      makeItem(1, TODO, 1, 'Alpha'),
      makeItem(2, TODO, 2, 'Beta'),
    ]

    expect(
      applyWorkItemBoardMove(items, 1, TODO, 1),
    ).toBe(items)
  })

  it('returns the same array for an unknown Work Item', () => {
    const items = [makeItem(1, TODO, 1, 'Alpha')]

    expect(
      applyWorkItemBoardMove(items, 42, IN_PROGRESS, null),
    ).toBe(items)
  })

  it('does not mutate the input collection or unchanged items', () => {
    const items = [
      makeItem(1, TODO, 1, 'Alpha'),
      makeItem(2, TODO, 2, 'Beta'),
      makeItem(3, IN_PROGRESS, 1, 'Gamma'),
    ]

    const next = applyWorkItemBoardMove(
      items,
      1,
      IN_PROGRESS,
      null,
    )

    // Input untouched.
    expect(items[0].boardPosition).toBe(1)
    expect(items[0].statusDefinitionId).toBe(TODO)

    // The source-column survivor keeps its exact object reference
    // (nothing about it changed).
    expect(next.find((item) => item.id === 2)).toBe(items[1])
    // The untouched target item keeps its reference (position 1 = 1).
    expect(next.find((item) => item.id === 3)).toBe(items[2])
    // The moved item is a NEW object.
    expect(next.find((item) => item.id === 1)).not.toBe(
      items[0],
    )
  })

  it('keeps unrelated items stable while mirrors a concurrent filter-safe move', () => {
    // The transform works on the FULL collection even when a filter
    // would hide parts of it: the anchor and every renumbered slot are
    // resolved against the complete column state, never a visible
    // subset.
    const items = [
      makeItem(1, TODO, 1, 'Alpha'),
      makeItem(2, TODO, 2, 'Beta'),
      makeItem(3, TODO, 3, 'Gamma'),
      makeItem(4, IN_PROGRESS, 1, 'Delta'),
    ]

    const next = applyWorkItemBoardMove(
      items,
      3,
      TODO,
      1,
    )

    expect(columnOf(next, TODO)).toEqual([
      { id: 3, boardPosition: 1 },
      { id: 1, boardPosition: 2 },
      { id: 2, boardPosition: 3 },
    ])
    expect(columnOf(next, IN_PROGRESS)).toEqual([
      { id: 4, boardPosition: 1 },
    ])
  })
})
