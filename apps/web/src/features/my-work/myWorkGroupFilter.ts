/**
 * Pure helpers for the My Work Research Group multi-select filter.
 *
 * The filter is PRESENTATION-ONLY over the canonical
 * `GET /api/me/work-items/` payload: it never triggers a refetch and
 * never changes what the server returns. The single source of truth
 * for the selection is the persisted preference snapshot field
 * `preferences.researchGroupIds` (there is no separate transient
 * filter state).
 *
 * These helpers are deliberately side-effect free so the filter
 * semantics (OR grouping, chip density, result-count copy) can be
 * unit-tested in isolation from the page.
 */

import type {
  ApiPersonalWorkItem,
} from '../../api/types'

/**
 * OR semantics over the canonical My Work payload.
 *
 * - An EMPTY selection means "no Research Group restriction": every
 *   assigned Work Item remains visible (the array reference is
 *   returned unchanged so callers can rely on memo stability).
 * - A non-empty selection keeps an item when its `researchGroupId`
 *   matches ANY of the selected IDs (OR, not AND).
 *
 * A Research Group that currently contains zero assigned items may
 * still be selected and legitimately yield zero results; that is a
 * valid filtered-empty state, not an error.
 */
export function filterMyWorkItemsByResearchGroup(
  items: readonly ApiPersonalWorkItem[],
  selectedGroupIds: readonly number[],
): ApiPersonalWorkItem[] {
  if (selectedGroupIds.length === 0) {
    return items as ApiPersonalWorkItem[]
  }

  const allowed = new Set(selectedGroupIds)

  return items.filter((item) =>
    allowed.has(item.researchGroupId),
  )
}

/** A selected Research Group that can be rendered as an applied chip. */
export interface ResearchGroupChip {
  id: number
  name: string
}

export interface CollapsedResearchGroupChips {
  /** The individual chips to render (always in selection order). */
  chips: ResearchGroupChip[]
  /**
   * The number of selected values hidden behind the "+N" summary, or
   * `null` when every selection fits as an individual chip.
   */
  overflowCount: number | null
}

/**
 * The approved chip-density rule for the applied-filters row.
 *
 * - Up to `maxChips` (6) selected values: every one renders as an
 *   individual chip (`overflowCount` is `null`).
 * - Above `maxChips`: the first `collapsedChips` (2) render as
 *   individual chips and the remainder collapses into a single
 *   "+N" summary (`overflowCount` = total - 2), so an arbitrary
 *   number of selections can never explode the row's height.
 */
export function collapseResearchGroupChips(
  selected: readonly ResearchGroupChip[],
  options?: {
    maxChips?: number
    collapsedChips?: number
  },
): CollapsedResearchGroupChips {
  const maxChips = options?.maxChips ?? 6
  const collapsedChips = options?.collapsedChips ?? 2

  if (selected.length <= maxChips) {
    return {
      chips: [...selected],
      overflowCount: null,
    }
  }

  return {
    chips: selected.slice(0, collapsedChips),
    overflowCount: selected.length - collapsedChips,
  }
}

/**
 * The applied-row result-count copy over the CURRENT filtered result:
 * "1 work item" (singular) / "N work items" (plural, including 0).
 */
export function formatWorkItemResultCount(
  count: number,
): string {
  return count === 1
    ? '1 work item'
    : `${count} work items`
}
