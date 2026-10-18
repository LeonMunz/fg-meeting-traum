// @vitest-environment happy-dom

import {
  describe,
  expect,
  it,
} from 'vitest'

import type {
  ApiProjectWorkItemConfiguration,
  ApiWorkItem,
} from '../../api/types'

import {
  applyWorkItemBoardMove,
  compareWorkItemBoardOrder,
} from './workItemBoardMove'

// ------------------------------------------------------------------
// Fixture: one todo category with TWO concrete active definitions
// (Open def 10, Planned def 20) — the mixed-definition Board the
// backend (AP-01) supports — plus one definition each for the other
// categories.
// ------------------------------------------------------------------

const NOW = '2026-09-01T00:00:00Z'

const OPEN = 10
const PLANNED = 20
const IN_PROGRESS = 11
const REVIEW = 12
const DONE = 13
const LEGACY_TODO = 15

const CONFIG: ApiProjectWorkItemConfiguration = {
  types: [
    { id: 4, name: 'Task', kind: 'task', order: 0, active: true },
  ],
  statuses: [
    {
      id: OPEN,
      name: 'Open',
      category: 'todo',
      order: 0,
      active: true,
      isDefault: true,
    },
    {
      id: PLANNED,
      name: 'Planned',
      category: 'todo',
      order: 1,
      active: true,
      isDefault: false,
    },
    {
      id: IN_PROGRESS,
      name: 'In Progress',
      category: 'in_progress',
      order: 2,
      active: true,
      isDefault: false,
    },
    {
      id: REVIEW,
      name: 'Review',
      category: 'review',
      order: 3,
      active: true,
      isDefault: false,
    },
    {
      id: DONE,
      name: 'Done',
      category: 'done',
      order: 4,
      active: true,
      isDefault: false,
    },
    // An INACTIVE definition an existing Work Item may still
    // reference (deactivation, not removal).
    {
      id: LEGACY_TODO,
      name: 'Legacy Todo',
      category: 'todo',
      order: 5,
      active: false,
      isDefault: false,
    },
  ],
  labels: [],
}

function makeItem(
  id: number,
  statusDefinitionId: number,
  boardPosition: number | null,
  options: {
    title?: string
    createdAt?: string
  } = {},
): ApiWorkItem {
  return {
    id,
    projectId: 7,
    title: options.title ?? `Work item ${id}`,
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
    createdAt: options.createdAt ?? NOW,
    updatedAt: NOW,
    createdById: 1,
    meetingOrigin: null,
  }
}

/** The visible column: every item of the semantic category in render order. */
function categoryColumn(
  items: ApiWorkItem[],
  category: 'todo' | 'in_progress' | 'review' | 'done',
): Array<{ id: number; boardPosition: number | null }> {
  const categoryIds: Record<
    string,
    number[]
  > = {
    todo: [OPEN, PLANNED, LEGACY_TODO],
    in_progress: [IN_PROGRESS],
    review: [REVIEW],
    done: [DONE],
  }

  const ids = categoryIds[category]

  return items
    .filter((item) => ids.includes(item.statusDefinitionId))
    .sort(compareWorkItemBoardOrder)
    .map((item) => ({
      id: item.id,
      boardPosition: item.boardPosition,
    }))
}

// The canonical mixed todo column used across the regression suite:
// A(Open, 1)  B(Planned, 2)  C(Open, 3)
function mixedTodoItems(): ApiWorkItem[] {
  return [
    makeItem(1, OPEN, 1, { title: 'A' }),
    makeItem(2, PLANNED, 2, { title: 'B' }),
    makeItem(3, OPEN, 3, { title: 'C' }),
  ]
}

describe('applyWorkItemBoardMove — mixed concrete definitions in ONE category', () => {
  it('reorders within the category: drop C between A and B keeps A, C, B with every definition preserved (server shape)', () => {
    const items = mixedTodoItems()

    // Drop C before B — the anchor B is on ANOTHER definition of the
    // same category, which the backend accepts as a valid anchor.
    const next = applyWorkItemBoardMove(
      items,
      CONFIG,
      3,
      OPEN,
      2,
    )

    expect(next).not.toBe(items)

    // Visual category order: A, C, B.
    expect(categoryColumn(next, 'todo').map((i) => i.id))
      .toEqual([1, 3, 2])

    // The whole category is normalized to explicit 1..3.
    expect(categoryColumn(next, 'todo')).toEqual([
      { id: 1, boardPosition: 1 },
      { id: 3, boardPosition: 2 },
      { id: 2, boardPosition: 3 },
    ])

    // A pure same-category reorder never changes any definition.
    expect(next.find((i) => i.id === 1)?.statusDefinitionId)
      .toBe(OPEN)
    expect(next.find((i) => i.id === 2)?.statusDefinitionId)
      .toBe(PLANNED)
    expect(next.find((i) => i.id === 3)?.statusDefinitionId)
      .toBe(OPEN)
  })

  it('never flips the concrete definition when the requested same-category definition is the OTHER one', () => {
    const items = mixedTodoItems()

    // The request targets the todo category via the Planned
    // definition (def 20), but C is on Open (def 10): the server
    // treats this as a pure reorder and keeps C on Open. The
    // optimistic transform must mirror that exactly.
    const next = applyWorkItemBoardMove(
      items,
      CONFIG,
      3,
      PLANNED,
      2,
    )

    expect(next.find((i) => i.id === 3)?.statusDefinitionId)
      .toBe(OPEN)
    expect(categoryColumn(next, 'todo').map((i) => i.id))
      .toEqual([1, 3, 2])
  })

  it('keeps an INACTIVE referenced definition sortable and preserves it', () => {
    const items = [
      makeItem(1, OPEN, 1, { title: 'A' }),
      // D still references the deactivated Legacy Todo definition.
      makeItem(4, LEGACY_TODO, 2, { title: 'D' }),
      makeItem(2, PLANNED, 3, { title: 'B' }),
    ]

    // Drag D to the front of the todo category column.
    const next = applyWorkItemBoardMove(
      items,
      CONFIG,
      4,
      OPEN,
      1,
    )

    expect(next.find((i) => i.id === 4)?.statusDefinitionId)
      .toBe(LEGACY_TODO)
    expect(categoryColumn(next, 'todo')).toEqual([
      { id: 4, boardPosition: 1 },
      { id: 1, boardPosition: 2 },
      { id: 2, boardPosition: 3 },
    ])
  })

  it('accepts an anchor from a different definition in both directions', () => {
    // Open item before a Planned anchor.
    const first = applyWorkItemBoardMove(
      mixedTodoItems(),
      CONFIG,
      1,
      PLANNED,
      2,
    )
    expect(categoryColumn(first, 'todo').map((i) => i.id))
      .toEqual([1, 2, 3])
    expect(first.find((i) => i.id === 1)?.statusDefinitionId)
      .toBe(OPEN)

    // Planned item before an Open anchor.
    const second = applyWorkItemBoardMove(
      mixedTodoItems(),
      CONFIG,
      2,
      OPEN,
      1,
    )
    expect(categoryColumn(second, 'todo').map((i) => i.id))
      .toEqual([2, 1, 3])
    expect(second.find((i) => i.id === 2)?.statusDefinitionId)
      .toBe(PLANNED)
  })
})

describe('applyWorkItemBoardMove — cross-category moves', () => {
  it('applies the caller-resolved active target definition and the anchor position in one shape', () => {
    const items = [
      makeItem(1, OPEN, 1, { title: 'A' }),
      makeItem(2, IN_PROGRESS, 1, { title: 'X' }),
      makeItem(3, IN_PROGRESS, 2, { title: 'Y' }),
    ]

    // Move A into in_progress before Y. The concrete target is the
    // one the caller resolved (here IN_PROGRESS, def 11).
    const next = applyWorkItemBoardMove(
      items,
      CONFIG,
      1,
      IN_PROGRESS,
      3,
    )

    expect(next.find((i) => i.id === 1)?.statusDefinitionId)
      .toBe(IN_PROGRESS)
    expect(categoryColumn(next, 'in_progress')).toEqual([
      { id: 2, boardPosition: 1 },
      { id: 1, boardPosition: 2 },
      { id: 3, boardPosition: 3 },
    ])

    // The source category is not renumbered: A left it, and no
    // other todo item remains.
    expect(categoryColumn(next, 'todo')).toEqual([
    ])

    // A concrete source survivor keeps its exact legacy position
    // (the server renumbers only the target category).
    const withSurvivor = [
      makeItem(1, OPEN, 1, { title: 'A' }),
      makeItem(5, OPEN, 3, { title: 'S' }),
      makeItem(2, IN_PROGRESS, 1, { title: 'X' }),
    ]

    const nextWithSurvivor = applyWorkItemBoardMove(
      withSurvivor,
      CONFIG,
      1,
      IN_PROGRESS,
      null,
    )

    expect(categoryColumn(nextWithSurvivor, 'todo')).toEqual([
      { id: 5, boardPosition: 3 },
    ])
  })

  it('moves into an empty target category at position 1', () => {
    const items = [
      makeItem(1, OPEN, 1, { title: 'A' }),
    ]

    const next = applyWorkItemBoardMove(
      items,
      CONFIG,
      1,
      DONE,
      null,
    )

    expect(next.find((i) => i.id === 1)?.statusDefinitionId)
      .toBe(DONE)
    expect(next.find((i) => i.id === 1)?.boardPosition)
      .toBe(1)
    expect(categoryColumn(next, 'todo')).toEqual([])
  })
})

describe('applyWorkItemBoardMove — first / between / last / empty column', () => {
  it('inserts at the FIRST position (anchor = first card)', () => {
    const items = mixedTodoItems()

    const next = applyWorkItemBoardMove(
      items,
      CONFIG,
      3,
      OPEN,
      1,
    )

    expect(categoryColumn(next, 'todo')).toEqual([
      { id: 3, boardPosition: 1 },
      { id: 1, boardPosition: 2 },
      { id: 2, boardPosition: 3 },
    ])
  })

  it('inserts at the LAST position (no anchor) even within the same category', () => {
    const items = mixedTodoItems()

    // A (currently first) dragged to the column end: a real move,
    // NOT a no-op just because the anchor is missing.
    const next = applyWorkItemBoardMove(
      items,
      CONFIG,
      1,
      OPEN,
      null,
    )

    expect(next).not.toBe(items)
    expect(categoryColumn(next, 'todo')).toEqual([
      { id: 2, boardPosition: 1 },
      { id: 3, boardPosition: 2 },
      { id: 1, boardPosition: 3 },
    ])
  })

  it('appends to the end when the target category is empty', () => {
    const items = [
      makeItem(1, OPEN, 1, { title: 'A' }),
      makeItem(2, IN_PROGRESS, 1, { title: 'X' }),
    ]

    const next = applyWorkItemBoardMove(
      items,
      CONFIG,
      2,
      OPEN,
      null,
    )

    expect(next.find((i) => i.id === 2)?.statusDefinitionId)
      .toBe(OPEN)
    expect(categoryColumn(next, 'todo')).toEqual([
      { id: 1, boardPosition: 1 },
      { id: 2, boardPosition: 2 },
    ])
    expect(categoryColumn(next, 'in_progress')).toEqual([])
  })
})

describe('applyWorkItemBoardMove — NULL and legacy overlapping positions', () => {
  it('renders NULL positions after explicit ones, in (created_at, id) order, and normalizes on the move', () => {
    const items = [
      // Positioned, then two unpositioned items: the older-created
      // one renders first even though it has the HIGHER id.
      makeItem(3, OPEN, 1, {
        title: 'C',
        createdAt: '2026-09-01T01:00:00Z',
      }),
      makeItem(6, PLANNED, null, {
        title: 'F',
        createdAt: '2026-09-01T02:00:00Z',
      }),
      makeItem(5, OPEN, null, {
        title: 'E',
        createdAt: '2026-09-01T03:00:00Z',
      }),
    ]

    // Canonical render order: C (positioned), then F and E in
    // created_at order (F before E). Verified through a no-op: E is
    // already last, so dropping it at the column end is the order
    // that holds.
    expect(
      applyWorkItemBoardMove(items, CONFIG, 5, OPEN, null),
    ).toBe(items)

    // A REAL move — C dragged to the end — normalizes the whole
    // category to explicit 1..3 while the unpositioned F and E keep
    // their created_at-relative order.
    const next = applyWorkItemBoardMove(
      items,
      CONFIG,
      3,
      OPEN,
      null,
    )

    expect(categoryColumn(next, 'todo')).toEqual([
      { id: 6, boardPosition: 1 },
      { id: 5, boardPosition: 2 },
      { id: 3, boardPosition: 3 },
    ])
  })

  it('is deterministic for overlapping legacy positions (board_position, created_at, id)', () => {
    // Overlapping legacy positions: 1 and 2 share position 1 — the
    // created_at tie-break decides, id last.
    const items = [
      makeItem(1, OPEN, 1, {
        title: 'A',
        createdAt: '2026-09-01T03:00:00Z',
      }),
      makeItem(2, OPEN, 1, {
        title: 'B',
        createdAt: '2026-09-01T02:00:00Z',
      }),
      makeItem(3, OPEN, null, {
        title: 'C',
        createdAt: '2026-09-01T01:00:00Z',
      }),
    ]

    // Canonical order: B (pos 1, earliest created), A (pos 1),
    // C (unpositioned). Drag C to the front.
    const next = applyWorkItemBoardMove(
      items,
      CONFIG,
      3,
      OPEN,
      2,
    )

    expect(categoryColumn(next, 'todo')).toEqual([
      { id: 3, boardPosition: 1 },
      { id: 2, boardPosition: 2 },
      { id: 1, boardPosition: 3 },
    ])
  })

  it('compares equal positions by created_at, then by id', () => {
    const a = makeItem(1, OPEN, 1, { createdAt: '2026-09-01T02:00:00Z' })
    const b = makeItem(2, OPEN, 1, { createdAt: '2026-09-01T01:00:00Z' })
    const c = makeItem(3, OPEN, null, { createdAt: '2026-09-01T01:00:00Z' })
    const d = makeItem(4, OPEN, null, { createdAt: '2026-09-01T01:00:00Z' })

    const sorted = [a, b, c, d].sort(compareWorkItemBoardOrder)
    expect(sorted.map((i) => i.id)).toEqual([2, 1, 3, 4])
  })
})

describe('applyWorkItemBoardMove — filter safety on the full collection', () => {
  it('keeps the relative order of hidden items and normalizes them with the visible ones', () => {
    // Full todo category: A, HIDDEN, B, C. A filter would hide
    // HIDDEN, but the transform must normalize the WHOLE category
    // and never scramble the hidden item relative to its siblings.
    const items = [
      makeItem(1, OPEN, 1, { title: 'A' }),
      makeItem(9, PLANNED, 2, { title: 'HIDDEN' }),
      makeItem(2, OPEN, 3, { title: 'B' }),
      makeItem(3, OPEN, 4, { title: 'C' }),
    ]

    // Drag C before A (a visible anchor): the hidden item keeps its
    // slot between A and B.
    const next = applyWorkItemBoardMove(
      items,
      CONFIG,
      3,
      OPEN,
      1,
    )

    expect(categoryColumn(next, 'todo')).toEqual([
      { id: 3, boardPosition: 1 },
      { id: 1, boardPosition: 2 },
      { id: 9, boardPosition: 3 },
      { id: 2, boardPosition: 4 },
    ])
  })

  it('resolves the anchor against the FULL category, never a visible subset', () => {
    // Same shape: the anchor B is valid even though a filter could
    // hide the item that currently sits between C and B.
    const items = [
      makeItem(1, OPEN, 1, { title: 'A' }),
      makeItem(9, PLANNED, 2, { title: 'HIDDEN' }),
      makeItem(2, OPEN, 3, { title: 'B' }),
      makeItem(3, OPEN, 4, { title: 'C' }),
    ]

    const next = applyWorkItemBoardMove(
      items,
      CONFIG,
      3,
      OPEN,
      2,
    )

    expect(categoryColumn(next, 'todo')).toEqual([
      { id: 1, boardPosition: 1 },
      { id: 9, boardPosition: 2 },
      { id: 3, boardPosition: 3 },
      { id: 2, boardPosition: 4 },
    ])
  })
})

describe('applyWorkItemBoardMove — invalid anchors and unknown items', () => {
  it('returns the same array when the anchor is unknown', () => {
    const items = mixedTodoItems()

    expect(
      applyWorkItemBoardMove(items, CONFIG, 1, IN_PROGRESS, 999),
    ).toBe(items)
  })

  it('returns the same array when the anchor belongs to another category', () => {
    const items = [
      makeItem(1, OPEN, 1, { title: 'A' }),
      makeItem(2, IN_PROGRESS, 1, { title: 'X' }),
    ]

    // X is in_progress: the server rejects it as an anchor for a
    // todo drop.
    expect(
      applyWorkItemBoardMove(items, CONFIG, 1, OPEN, 2),
    ).toBe(items)
  })

  it('returns the same array when the anchor is the moved item itself', () => {
    const items = mixedTodoItems()

    expect(
      applyWorkItemBoardMove(items, CONFIG, 1, OPEN, 1),
    ).toBe(items)
  })

  it('returns the same array for an unknown Work Item', () => {
    const items = mixedTodoItems()

    expect(
      applyWorkItemBoardMove(items, CONFIG, 42, IN_PROGRESS, null),
    ).toBe(items)
  })
})

describe('applyWorkItemBoardMove — genuine same-category no-ops', () => {
  it('skips the move when the item already sits directly before the anchor', () => {
    const items = mixedTodoItems()

    // Canonical order A, B, C: dropping B "before C" is exactly the
    // order that already holds — same array, no request.
    expect(
      applyWorkItemBoardMove(items, CONFIG, 2, OPEN, 3),
    ).toBe(items)

    // The same slot expressed as a cross-shape drop (targeting the
    // category through the OTHER definition) is still a no-op.
    expect(
      applyWorkItemBoardMove(items, CONFIG, 2, PLANNED, 3),
    ).toBe(items)
  })

  it('skips the move when the item is already at the end of the category (no anchor)', () => {
    const items = mixedTodoItems()

    // C is already last in the todo category: dropping it at the
    // column end (missing anchor) is a genuine no-op — the same
    // array, no request.
    expect(
      applyWorkItemBoardMove(items, CONFIG, 3, OPEN, null),
    ).toBe(items)
  })

  it('does NOT skip a same-category end-of-column drop when the item is not last (regression)', () => {
    const items = mixedTodoItems()

    // A is first, not last: the same shape of drop (no anchor) is a
    // REAL move and must not be treated as a no-op.
    const next = applyWorkItemBoardMove(
      items,
      CONFIG,
      1,
      OPEN,
      null,
    )

    expect(next).not.toBe(items)
    expect(categoryColumn(next, 'todo').map((i) => i.id))
      .toEqual([2, 3, 1])
  })

  it('skips the no-op even when positions are NULL/unnormalized (order already matches)', () => {
    const items = [
      makeItem(1, OPEN, null, {
        title: 'A',
        createdAt: '2026-09-01T01:00:00Z',
      }),
      makeItem(2, PLANNED, null, {
        title: 'B',
        createdAt: '2026-09-01T02:00:00Z',
      }),
      makeItem(3, OPEN, null, {
        title: 'C',
        createdAt: '2026-09-01T03:00:00Z',
      }),
    ]

    // C is already last in canonical (created_at) order.
    expect(
      applyWorkItemBoardMove(items, CONFIG, 3, OPEN, null),
    ).toBe(items)
  })
})

describe('applyWorkItemBoardMove — input immutability', () => {
  it('does not mutate the input collection or unchanged items', () => {
    const items = [
      makeItem(1, OPEN, 1, { title: 'A' }),
      makeItem(2, PLANNED, 2, { title: 'B' }),
      makeItem(3, IN_PROGRESS, 1, { title: 'X' }),
    ]
    const snapshot = items.map((item) => ({ ...item }))

    const next = applyWorkItemBoardMove(
      items,
      CONFIG,
      1,
      IN_PROGRESS,
      null,
    )

    // Input array and every input object untouched.
    expect(items).toEqual(snapshot)

    // Unchanged items keep their exact object reference.
    expect(next.find((i) => i.id === 2)).toBe(items[1])
    expect(next.find((i) => i.id === 3)).toBe(items[2])

    // The moved item is a NEW object.
    expect(next.find((i) => i.id === 1)).not.toBe(items[0])
  })

  it('keeps unrelated categories on their exact object references', () => {
    const items = mixedTodoItems().concat([
      makeItem(4, DONE, 1, { title: 'Z' }),
    ])

    const next = applyWorkItemBoardMove(
      items,
      CONFIG,
      3,
      OPEN,
      2,
    )

    expect(next.find((i) => i.id === 4)).toBe(items[3])
  })
})
