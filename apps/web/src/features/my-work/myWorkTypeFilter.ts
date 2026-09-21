/**
 * Pure helpers for the My Work Work Item Type multi-select filter.
 *
 * Like the Research Group and Project filters, the Work Item Type
 * filter is PRESENTATION-ONLY over the canonical
 * `GET /api/me/work-items/` payload: it never triggers a refetch and
 * never changes what the server returns. The single source of truth
 * for the selection is the persisted preference snapshot field
 * `preferences.workItemTypes` (there is no separate transient filter
 * state).
 *
 * The option set is the CLOSED canonical set of semantic type kinds —
 * it is NEVER derived from the payload (a kind must stay selectable
 * even while the payload holds no assigned item of that kind) and
 * never from any Work Item's `typeName` display string (canonical
 * semantic rule, `docs/domain/foundation.md` §3a.1 + invariant 26).
 * A `typeKind` of `null` (custom / unclassified project type) is NOT
 * one of the options: the canonical domain contract defines no
 * "Other" / "Unknown" selectable category (foundation.md §14a).
 *
 * These helpers are deliberately side-effect free so the filter
 * semantics (canonical option set, OR grouping, kind matching,
 * selection normalization) can be unit-tested in isolation from the
 * page.
 */

import type {
  ApiPersonalWorkItem,
  ApiWorkItemTypeKind,
} from '../../api/types'

import { workItemTypeLabels } from '../projects/workItemMapping'

/**
 * The canonical semantic kind values in canonical order — the order
 * of the backend `WorkItemTypeDefinition.Kind` choices (`task`,
 * `epic`, `milestone`, `deliverable`). This order is also the
 * deterministic order a persisted selection is normalized into
 * (the treatment the Research Group / Project selections get from
 * their ascending-ID order, keeping the complete-snapshot dirty
 * check exact).
 */
export const WORK_ITEM_TYPE_KINDS: readonly ApiWorkItemTypeKind[] = [
  'task',
  'epic',
  'milestone',
  'deliverable',
]

/** A Work Item Type option in the filter popover. */
export interface WorkItemTypeFilterOption {
  kind: ApiWorkItemTypeKind
  label: string
}

/**
 * The Work Item Type filter option set: exactly the four canonical
 * semantic kinds in canonical order, labeled with the canonical
 * human-readable kind labels (the same mapping the Project Work Item
 * configuration presentation uses — no second independent label
 * mapping).
 */
export const WORK_ITEM_TYPE_FILTER_OPTIONS:
  readonly WorkItemTypeFilterOption[] = WORK_ITEM_TYPE_KINDS.map(
  (kind) => ({
    kind,
    label: workItemTypeLabels[kind],
  }),
)

/**
 * OR semantics over the canonical My Work payload for the Work Item
 * Type category (mirroring the Research Group and Project filters):
 *
 * - An EMPTY selection means "no Work Item Type restriction": every
 *   item remains visible — INCLUDING items whose `typeKind` is `null`
 *   (custom / unclassified types) (the array reference is returned
 *   unchanged so callers can rely on memo stability).
 * - A non-empty selection keeps an item when its `typeKind` matches
 *   ANY of the selected canonical kinds (OR, not AND).
 *
 * Canonical `typeKind = null` behavior: `null` is NOT a canonical
 * kind value, so an unclassified item never matches ANY selected
 * kind — it is hidden whenever at least one kind is selected, and it
 * is the only member of the (unselectable) unclassified remainder.
 * The item's `typeName` display string is never consulted: a custom
 * type named "Task" (`typeKind = null`) never matches the canonical
 * `task` filter, and a canonical-kind item is matched by its kind
 * regardless of what its Project calls it.
 *
 * Categories combine RESTRICTIVELY with the Research Group and
 * Project filters (an item must satisfy ALL active categories) —
 * that composition happens in the page by applying one category
 * after the other. A kind that currently matches zero assigned items
 * may still be selected and legitimately yield zero results; that is
 * a valid filtered-empty state, not an error.
 */
export function filterMyWorkItemsByWorkItemType(
  items: readonly ApiPersonalWorkItem[],
  selectedKinds: readonly ApiWorkItemTypeKind[],
): ApiPersonalWorkItem[] {
  if (selectedKinds.length === 0) {
    return items as ApiPersonalWorkItem[]
  }

  const allowed = new Set<ApiWorkItemTypeKind>(selectedKinds)

  return items.filter(
    (item) =>
      item.typeKind !== null &&
      allowed.has(item.typeKind),
  )
}

/**
 * Normalize a Work Item Type selection into canonical kind order
 * (`task`, `epic`, `milestone`, `deliverable`) — the deterministic
 * order the persisted snapshot is stored, saved, and diffed in.
 */
export function sortWorkItemTypes(
  kinds: readonly ApiWorkItemTypeKind[],
): ApiWorkItemTypeKind[] {
  const order = new Map<ApiWorkItemTypeKind, number>(
    WORK_ITEM_TYPE_KINDS.map((kind, index) => [
      kind,
      index,
    ]),
  )

  return [...kinds].sort(
    (a, b) =>
      (order.get(a) ?? 0) - (order.get(b) ?? 0),
  )
}

/** A selected Work Item Type that can be rendered as an applied chip. */
export interface WorkItemTypeChip {
  kind: ApiWorkItemTypeKind
  label: string
}

/**
 * Resolve a persisted selection to renderable applied chips
 * (canonical label per kind, canonical kind order). The label comes
 * from the canonical kind mapping — NEVER from a Work Item's
 * `typeName` (a chip must render the kind the user selected, not an
 * item that happens to carry a similar display name).
 */
export function workItemTypeChips(
  selectedKinds: readonly ApiWorkItemTypeKind[],
): WorkItemTypeChip[] {
  const labelByKind = new Map<
    ApiWorkItemTypeKind,
    string
  >(
    WORK_ITEM_TYPE_FILTER_OPTIONS.map(
      (option) => [option.kind, option.label],
    ),
  )

  return sortWorkItemTypes(selectedKinds).map(
    (kind) => ({
      kind,
      label: labelByKind.get(kind) ?? kind,
    }),
  )
}
