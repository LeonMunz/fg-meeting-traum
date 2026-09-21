/**
 * Pure helpers for the My Work Project multi-select filter.
 *
 * Like the Research Group filter, the Project filter is
 * PRESENTATION-ONLY over the canonical `GET /api/me/work-items/`
 * payload: it never triggers a refetch and never changes what the
 * server returns. The single source of truth for the selection is
 * the persisted preference snapshot field `preferences.projectIds`
 * (there is no separate transient filter state).
 *
 * The Project option set is derived from the CURRENTLY LOADED
 * canonical My Work data — the payload already carries `projectId`
 * + `projectName` (plus the item's `researchGroupId`) on every item,
 * so no additional request of any kind is needed.
 *
 * These helpers are deliberately side-effect free so the filter
 * semantics (option derivation, OR grouping, group-scope
 * normalization) can be unit-tested in isolation from the page.
 */

import type {
  ApiPersonalWorkItem,
} from '../../api/types'

/** A Project option in the filter popover (id + display name). */
export interface ProjectFilterOption {
  id: number
  name: string
}

/**
 * Derive the Projects option set from the loaded canonical My Work
 * payload (never from a request).
 *
 * - Every Project REPRESENTED by the payload is an option (one entry
 *   per `projectId`, name from the payload — a Project appears once
 *   no matter how many assigned items it holds).
 * - No Research Group selection: EVERY represented Project (the
 *   unrestricted case).
 * - A non-empty Research Group selection: only Projects whose items
 *   belong to one of the selected Research Groups (the group →
 *   project dependency of the canonical preference contract).
 *
 * Deterministic order: Project ID ascending — the exact order the
 * server uses for preference ID lists, so the options never reorder
 * on unrelated payload churn.
 */
export function deriveMyWorkProjectOptions(
  items: readonly ApiPersonalWorkItem[],
  selectedGroupIds: readonly number[],
): ProjectFilterOption[] {
  const groupScope =
    selectedGroupIds.length > 0
      ? new Set(selectedGroupIds)
      : null

  const byProject = new Map<
    number,
    { name: string; researchGroupId: number }
  >()

  for (const item of items) {
    if (!byProject.has(item.projectId)) {
      byProject.set(item.projectId, {
        name: item.projectName,
        researchGroupId:
          item.researchGroupId,
      })
    }
  }

  const options: ProjectFilterOption[] = []

  for (const [
    id,
    { name, researchGroupId },
  ] of byProject) {
    if (
      groupScope !== null &&
      !groupScope.has(researchGroupId)
    ) {
      continue
    }

    options.push({ id, name })
  }

  return options.sort((a, b) => a.id - b.id)
}

/**
 * OR semantics over the canonical My Work payload for the Project
 * category (mirroring the Research Group filter):
 *
 * - An EMPTY selection means "no Project restriction": every item
 *   remains visible (the array reference is returned unchanged so
 *   callers can rely on memo stability).
 * - A non-empty selection keeps an item when its `projectId`
 *   matches ANY of the selected IDs (OR, not AND).
 *
 * Categories combine RESTRICTIVELY with the Research Group filter
 * (an item must satisfy BOTH active categories) — that composition
 * happens in the page by applying one category after the other. A
 * Project that currently contains zero assigned items may still be
 * selected and legitimately yield zero results; that is a valid
 * filtered-empty state, not an error.
 */
export function filterMyWorkItemsByProject(
  items: readonly ApiPersonalWorkItem[],
  selectedProjectIds: readonly number[],
): ApiPersonalWorkItem[] {
  if (selectedProjectIds.length === 0) {
    return items as ApiPersonalWorkItem[]
  }

  const allowed = new Set(selectedProjectIds)

  return items.filter((item) =>
    allowed.has(item.projectId),
  )
}

/**
 * Normalize the persisted Project selection after a Research Group
 * scope change (the group → project dependency of the canonical
 * preference contract: with a NON-EMPTY Research Group selection,
 * selected Projects must belong to one of those selected groups —
 * `docs/domain/foundation.md` §14a).
 *
 * Validity is evaluated from the LOADED My Work payload (project →
 * research group). A Project not represented by the payload cannot
 * be evaluated against the group scope client-side and is KEPT: the
 * server sanitizes selections against CURRENT access on every
 * read/write and is the authority — the client never drops a
 * selection it cannot judge. The unrestricted case (empty group
 * scope) invalidates nothing.
 *
 * Input order is preserved (the persisted ascending ID order), so
 * the normalized list is directly storable back into the complete
 * snapshot without re-sorting.
 */
export function normalizeMyWorkProjectIdsForGroupScope(
  selectedProjectIds: readonly number[],
  items: readonly ApiPersonalWorkItem[],
  selectedGroupIds: readonly number[],
): number[] {
  if (selectedProjectIds.length === 0) {
    return []
  }

  if (selectedGroupIds.length === 0) {
    return [...selectedProjectIds]
  }

  const projectGroupById = new Map<
    number,
    number
  >()

  for (const item of items) {
    if (!projectGroupById.has(item.projectId)) {
      projectGroupById.set(
        item.projectId,
        item.researchGroupId,
      )
    }
  }

  const allowedGroups =
    new Set(selectedGroupIds)

  return selectedProjectIds.filter(
    (projectId) => {
      const groupId =
        projectGroupById.get(
          projectId,
        )

      return (
        groupId === undefined ||
        allowedGroups.has(groupId)
      )
    },
  )
}
