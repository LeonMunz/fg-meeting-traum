// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'

import type {
  ApiPersonalWorkItem,
  ApiWorkItemTypeKind,
} from '../../api/types'

import {
  WORK_ITEM_TYPE_FILTER_OPTIONS,
  WORK_ITEM_TYPE_KINDS,
  filterMyWorkItemsByWorkItemType,
  sortWorkItemTypes,
  workItemTypeChips,
} from './myWorkTypeFilter'

function item(
  overrides: Partial<ApiPersonalWorkItem>,
): ApiPersonalWorkItem {
  return {
    id: 1,
    projectId: 7,
    projectName: 'Project Alpha',
    researchGroupId: 1,
    researchGroupName: 'Research Group A',
    // Neutral display name by default; tests override it
    // deliberately (including with canonical-looking names).
    typeName: 'Sample Batch',
    // Custom / unclassified types carry a null kind by default —
    // the canonical contract (foundation.md §3a.1).
    typeKind: null,
    ...overrides,
  } as ApiPersonalWorkItem
}

describe('canonical option set', () => {
  it('exposes exactly the four canonical semantic kinds in canonical order', () => {
    expect(
      WORK_ITEM_TYPE_KINDS,
    ).toEqual([
      'task',
      'epic',
      'milestone',
      'deliverable',
    ])
  })

  it('labels the options with the canonical human-readable kind labels', () => {
    expect(
      WORK_ITEM_TYPE_FILTER_OPTIONS,
    ).toEqual([
      { kind: 'task', label: 'Task' },
      { kind: 'epic', label: 'Epic' },
      {
        kind: 'milestone',
        label: 'Milestone',
      },
      {
        kind: 'deliverable',
        label: 'Deliverable',
      },
    ])
  })

  it('exposes no Other / Unknown / Custom category', () => {
    const kinds = WORK_ITEM_TYPE_FILTER_OPTIONS.map(
      (option) => option.kind,
    )

    expect(kinds).toHaveLength(4)
    expect(kinds).not.toContain(
      'other' as ApiWorkItemTypeKind,
    )
    expect(
      WORK_ITEM_TYPE_FILTER_OPTIONS.map(
        (option) => option.label.toLowerCase(),
      ),
    ).not.toContain('unknown')
  })
})

describe('filterMyWorkItemsByWorkItemType (kind matching)', () => {
  const items = [
    item({
      id: 1,
      typeKind: 'task',
      typeName: 'Task',
    }),
    item({
      id: 2,
      typeKind: 'epic',
      typeName: 'Epic',
    }),
    item({
      id: 3,
      typeKind: 'milestone',
      typeName: 'Milestone',
    }),
    item({
      id: 4,
      typeKind: 'deliverable',
      typeName: 'Deliverable',
    }),
    // Custom / unclassified type.
    item({
      id: 5,
      typeKind: null,
      typeName: 'Experiment',
    }),
    // Custom type whose DISPLAY NAME mimics a canonical kind —
    // the anti-inference fixture (typeKind null is authoritative).
    item({
      id: 6,
      typeKind: null,
      typeName: 'Task',
    }),
    item({
      id: 7,
      typeKind: null,
      typeName: 'Epic',
    }),
  ]

  it('keeps every item (including unclassified types) when no kind is selected', () => {
    const filtered = filterMyWorkItemsByWorkItemType(
      items,
      [],
    )

    expect(
      filtered.map((entry) => entry.id),
    ).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('returns the SAME array reference for an empty selection (memo stability)', () => {
    expect(
      filterMyWorkItemsByWorkItemType(items, []),
    ).toBe(items)
  })

  it('keeps only the items of one selected kind (matched by typeKind)', () => {
    expect(
      filterMyWorkItemsByWorkItemType(items, [
        'task',
      ]).map((entry) => entry.id),
    ).toEqual([1])
  })

  it('uses OR semantics across multiple selected kinds', () => {
    expect(
      filterMyWorkItemsByWorkItemType(items, [
        'milestone',
        'task',
      ]).map((entry) => entry.id),
    ).toEqual([1, 3])
  })

  it('excludes custom / unclassified items (typeKind null) whenever any kind is selected', () => {
    expect(
      filterMyWorkItemsByWorkItemType(items, [
        'epic',
      ]).map((entry) => entry.id),
    ).toEqual([2])
  })

  it('never infers a kind from a canonical-looking typeName (custom "Task" stays unclassified)', () => {
    // id 6 has typeName "Task" but typeKind null: it must NOT
    // match the canonical task filter.
    const byTask = filterMyWorkItemsByWorkItemType(
      items,
      ['task'],
    )

    expect(byTask.map((entry) => entry.id)).toEqual([1])
    expect(
      byTask.some((entry) => entry.id === 6),
    ).toBe(false)
  })

  it('never infers a kind from a canonical-looking typeName for the other canonical names', () => {
    const byEpic = filterMyWorkItemsByWorkItemType(
      items,
      ['epic'],
    )

    // id 7 has typeName "Epic" but typeKind null.
    expect(byEpic.map((entry) => entry.id)).toEqual([2])
    expect(
      byEpic.some((entry) => entry.id === 7),
    ).toBe(false)
  })

  it('matches a canonical kind even when the Project renamed the type (kind, not name, is authoritative)', () => {
    const items = [
      item({
        id: 10,
        typeKind: 'task',
        typeName: 'Experiment step',
      }),
    ]

    expect(
      filterMyWorkItemsByWorkItemType(items, [
        'task',
      ]).map((entry) => entry.id),
    ).toEqual([10])
  })

  it('yields a valid filtered-empty set for a kind without assigned items', () => {
    expect(
      filterMyWorkItemsByWorkItemType(
        [item({ id: 1, typeKind: 'task' })],
        ['milestone'],
      ),
    ).toEqual([])
  })
})

describe('sortWorkItemTypes (canonical selection order)', () => {
  it('normalizes an arbitrary selection into canonical kind order', () => {
    expect(
      sortWorkItemTypes([
        'deliverable',
        'task',
        'milestone',
        'epic',
      ]),
    ).toEqual([
      'task',
      'epic',
      'milestone',
      'deliverable',
    ])
  })

  it('keeps an already-canonical selection unchanged and preserves input for a single value', () => {
    expect(sortWorkItemTypes(['task', 'epic'])).toEqual([
      'task',
      'epic',
    ])
    expect(sortWorkItemTypes(['milestone'])).toEqual([
      'milestone',
    ])
    expect(sortWorkItemTypes([])).toEqual([])
  })
})

describe('workItemTypeChips (applied-row chips)', () => {
  it('resolves canonical labels in canonical kind order (never from item display names)', () => {
    expect(
      workItemTypeChips([
        'deliverable',
        'task',
      ]),
    ).toEqual([
      { kind: 'task', label: 'Task' },
      {
        kind: 'deliverable',
        label: 'Deliverable',
      },
    ])
  })

  it('renders nothing for an empty selection', () => {
    expect(workItemTypeChips([])).toEqual([])
  })
})
