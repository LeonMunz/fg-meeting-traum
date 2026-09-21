// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'

import type { ApiPersonalWorkItem } from '../../api/types'

import {
  deriveMyWorkProjectOptions,
  filterMyWorkItemsByProject,
  normalizeMyWorkProjectIdsForGroupScope,
} from './myWorkProjectFilter'

function item(
  overrides: Partial<ApiPersonalWorkItem>,
): ApiPersonalWorkItem {
  return {
    projectId: 7,
    projectName: 'Project Alpha',
    researchGroupId: 1,
    ...overrides,
  } as ApiPersonalWorkItem
}

describe('deriveMyWorkProjectOptions (payload-derived options)', () => {
  const items = [
    item({
      id: 1,
      projectId: 12,
      projectName: 'Project Beta',
      researchGroupId: 2,
    }),
    item({
      id: 2,
      projectId: 7,
      projectName: 'Project Alpha',
      researchGroupId: 1,
    }),
    item({
      id: 3,
      projectId: 7,
      projectName: 'Project Alpha',
      researchGroupId: 1,
    }),
    item({
      id: 4,
      projectId: 14,
      projectName: 'Project Delta',
      researchGroupId: 1,
    }),
  ]

  it('exposes every represented Project once, in Project ID order, with no Research Group selection', () => {
    const options =
      deriveMyWorkProjectOptions(items, [])

    // Project 7 appears twice in the payload but only once as an
    // option; deterministic ID order regardless of payload order.
    expect(options).toEqual([
      { id: 7, name: 'Project Alpha' },
      { id: 12, name: 'Project Beta' },
      { id: 14, name: 'Project Delta' },
    ])
  })

  it('exposes no options for an empty payload', () => {
    expect(
      deriveMyWorkProjectOptions([], []),
    ).toEqual([])
  })

  it('narrows to Projects of the selected Research Group (single selection)', () => {
    const options =
      deriveMyWorkProjectOptions(items, [1])

    expect(options).toEqual([
      { id: 7, name: 'Project Alpha' },
      { id: 14, name: 'Project Delta' },
    ])
  })

  it('narrowing uses OR across multiple selected Research Groups', () => {
    const options =
      deriveMyWorkProjectOptions(items, [1, 2])

    expect(options).toEqual([
      { id: 7, name: 'Project Alpha' },
      { id: 12, name: 'Project Beta' },
      { id: 14, name: 'Project Delta' },
    ])
  })

  it('yields no options when the selected group holds no represented Project', () => {
    expect(
      deriveMyWorkProjectOptions(items, [99]),
    ).toEqual([])
  })
})

describe('filterMyWorkItemsByProject (OR semantics)', () => {
  const items = [
    item({ id: 1, projectId: 7 }),
    item({ id: 2, projectId: 12 }),
    item({ id: 3, projectId: 14 }),
    item({ id: 4, projectId: 7 }),
  ]

  it('returns every item unchanged for an empty selection', () => {
    const result =
      filterMyWorkItemsByProject(items, [])

    // No restriction: same reference, same items.
    expect(result).toBe(items)
  })

  it('keeps only items whose Project matches a single selection', () => {
    const result =
      filterMyWorkItemsByProject(items, [12])

    expect(result.map((i) => i.id)).toEqual([2])
  })

  it('uses OR semantics across multiple selected Projects', () => {
    const result = filterMyWorkItemsByProject(
      items,
      [7, 14],
    )

    // 7 OR 14 → items 1, 3, 4 (item 2's Project 12 excluded).
    expect(result.map((i) => i.id)).toEqual([
      1,
      3,
      4,
    ])
  })

  it('yields zero results when the selected Project holds no items', () => {
    const result =
      filterMyWorkItemsByProject(items, [999])

    expect(result).toEqual([])
  })
})

describe('normalizeMyWorkProjectIdsForGroupScope (group → project dependency)', () => {
  const items = [
    item({ id: 1, projectId: 7, researchGroupId: 1 }),
    item({ id: 2, projectId: 12, researchGroupId: 2 }),
    item({ id: 3, projectId: 14, researchGroupId: 1 }),
  ]

  it('keeps every selection in the unrestricted scope (empty group selection)', () => {
    expect(
      normalizeMyWorkProjectIdsForGroupScope(
        [7, 12],
        items,
        [],
      ),
    ).toEqual([7, 12])
  })

  it('is a no-op for an empty selection', () => {
    expect(
      normalizeMyWorkProjectIdsForGroupScope(
        [],
        items,
        [1],
      ),
    ).toEqual([])
  })

  it('keeps selected Projects that belong to the active Research Group scope', () => {
    expect(
      normalizeMyWorkProjectIdsForGroupScope(
        [7, 14],
        items,
        [1],
      ),
    ).toEqual([7, 14])
  })

  it('drops selected Projects that belong to a Research Group outside the active scope', () => {
    // 12 belongs to group 2, which is not in the active scope.
    expect(
      normalizeMyWorkProjectIdsForGroupScope(
        [7, 12, 14],
        items,
        [1],
      ),
    ).toEqual([7, 14])
  })

  it('keeps a Project NOT represented by the payload (the server sanitizes what the client cannot judge)', () => {
    // 999 is not in the payload: its group is unknown to the
    // client, so it is kept — never dropped client-side.
    expect(
      normalizeMyWorkProjectIdsForGroupScope(
        [7, 999],
        items,
        [1],
      ),
    ).toEqual([7, 999])
  })

  it('preserves the persisted ascending ID order', () => {
    expect(
      normalizeMyWorkProjectIdsForGroupScope(
        [7, 14],
        items,
        [1, 2],
      ),
    ).toEqual([7, 14])
  })
})
