// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'

import type { ApiPersonalWorkItem } from '../../api/types'

import {
  collapseResearchGroupChips,
  filterMyWorkItemsByResearchGroup,
  formatWorkItemResultCount,
} from './myWorkGroupFilter'

function item(
  id: number,
  researchGroupId: number,
): ApiPersonalWorkItem {
  return {
    id,
    researchGroupId,
  } as ApiPersonalWorkItem
}

describe('filterMyWorkItemsByResearchGroup (OR semantics)', () => {
  it('returns every item unchanged for an empty selection', () => {
    const items = [
      item(1, 10),
      item(2, 20),
      item(3, 30),
    ]

    const result =
      filterMyWorkItemsByResearchGroup(items, [])

    // No restriction: same reference, same items.
    expect(result).toBe(items)
  })

  it('keeps only items whose group matches a single selection', () => {
    const items = [
      item(1, 10),
      item(2, 20),
      item(3, 10),
    ]

    const result =
      filterMyWorkItemsByResearchGroup(items, [20])

    expect(
      result.map((i) => i.id),
    ).toEqual([2])
  })

  it('uses OR semantics across multiple selections', () => {
    const items = [
      item(1, 10),
      item(2, 20),
      item(3, 30),
      item(4, 10),
    ]

    const result = filterMyWorkItemsByResearchGroup(
      items,
      [10, 30],
    )

    // 10 OR 30 → items 1, 3, 4 (item 2's group 20 is excluded).
    expect(
      result.map((i) => i.id),
    ).toEqual([1, 3, 4])
  })

  it('yields zero results when the selected group holds no items', () => {
    const items = [
      item(1, 10),
    ]

    const result =
      filterMyWorkItemsByResearchGroup(items, [999])

    expect(result).toEqual([])
  })
})

describe('collapseResearchGroupChips (chip density)', () => {
  const groups = (n: number) =>
    Array.from(
      { length: n },
      (_, index) => ({
        id: index + 1,
        name: `Group ${index + 1}`,
      }),
    )

  it('shows individual chips up to six selections', () => {
    const result = collapseResearchGroupChips(
      groups(6),
    )

    expect(result.chips).toHaveLength(6)
    expect(result.overflowCount).toBeNull()
  })

  it('shows all individual chips for fewer than six', () => {
    const result = collapseResearchGroupChips(
      groups(2),
    )

    expect(result.chips).toHaveLength(2)
    expect(result.overflowCount).toBeNull()
  })

  it('collapses above six to the first two plus a +N summary', () => {
    const result = collapseResearchGroupChips(
      groups(9),
    )

    // First two individual chips + "+7" summary (9 - 2).
    expect(result.chips).toEqual([
      { id: 1, name: 'Group 1' },
      { id: 2, name: 'Group 2' },
    ])
    expect(result.overflowCount).toBe(7)
  })

  it('collapses exactly seven to the first two plus +5', () => {
    const result = collapseResearchGroupChips(
      groups(7),
    )

    expect(result.chips).toHaveLength(2)
    expect(result.overflowCount).toBe(5)
  })
})

describe('formatWorkItemResultCount (result copy)', () => {
  it('is singular for exactly one item', () => {
    expect(formatWorkItemResultCount(1)).toBe(
      '1 work item',
    )
  })

  it('is plural for more than one item', () => {
    expect(formatWorkItemResultCount(12)).toBe(
      '12 work items',
    )
  })

  it('is plural for zero items', () => {
    expect(formatWorkItemResultCount(0)).toBe(
      '0 work items',
    )
  })
})
