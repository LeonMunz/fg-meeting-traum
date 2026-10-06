/**
 * Pure composition for the global Sidebar Quick Access section
 * (frozen contract: docs/design/workspace-sidebar/
 * IMPLEMENTATION_CONTRACT.md, QA-1..QA-9).
 *
 * The SERVER owns the snapshot: eligibility, ranking, the
 * max-five bound, and the exact order of `snapshot` (the first
 * successful fetch is the stable session snapshot, QA-2). This
 * module never re-sorts, ranks, or filters — it only composes the
 * stable snapshot with the CONTEXTUAL current-Project
 * presentation (QA-4/QA-5):
 *
 * - the snapshot renders in the exact server order (QA-3: visible
 *   ordering never changes while navigating);
 * - at most MAX_PROJECT_SHORTCUTS rows are visible — a defensive
 *   presentation cap, the bound itself is server-owned (QA-1);
 * - a current Project already in the snapshot keeps EXACTLY its
 *   snapshot position (no promotion, no displacement, no
 *   duplication, QA-4);
 * - a current Project OUTSIDE the snapshot occupies the LAST
 *   visible slot while open: appended with a partial snapshot,
 *   displacing only the fifth candidate with a full one (QA-5).
 *   This is CONTEXTUAL PRESENTATION ONLY — the input array is
 *   never mutated, nothing is persisted, and no server value
 *   (e.g. `lastOpenedAt`) is ever fabricated.
 */

import type { ApiProjectQuickAccessItem } from '../../api/types'

/** The maximum number of visible Quick Access rows (QA-1). */
export const MAX_PROJECT_SHORTCUTS = 5

/** One visible Quick Access row after composition. */
export interface ProjectShortcutRow {
  id: number
  name: string
  researchGroupId: number
  /** True only for the contextual current-Project row (QA-5). */
  contextual: boolean
}

/**
 * The resolved metadata of the concrete Project the current route
 * points inside of (bounded `getProject` — the name and owning
 * Research Group are never inferred from the URL). `null` outside
 * any concrete Project route, or while the metadata is unresolved
 * or no longer readable.
 */
export interface CurrentProjectShortcut {
  id: number
  name: string
  researchGroupId: number
}

/**
 * Compose the visible Quick Access rows for the current state.
 *
 * Pure and allocation-only: no mutation of `snapshot`, no
 * client-side sorting, no ranking. Safe to call on every render.
 */
export function composeProjectShortcuts(
  snapshot: ReadonlyArray<ApiProjectQuickAccessItem>,
  currentProject: CurrentProjectShortcut | null,
): ProjectShortcutRow[] {
  const rows: ProjectShortcutRow[] = snapshot
    .slice(0, MAX_PROJECT_SHORTCUTS)
    .map((item) => ({
      id: item.id,
      name: item.name,
      researchGroupId: item.researchGroupId,
      contextual: false,
    }))

  if (currentProject === null) {
    return rows
  }

  // QA-4: an existing candidate stays in its exact snapshot slot.
  if (
    rows.some(
      (row) => row.id === currentProject.id,
    )
  ) {
    return rows
  }

  const contextual: ProjectShortcutRow = {
    id: currentProject.id,
    name: currentProject.name,
    researchGroupId:
      currentProject.researchGroupId,
    contextual: true,
  }

  // QA-5: partial snapshot -> append; full snapshot -> replace
  // only the fifth (last visible) slot.
  if (rows.length < MAX_PROJECT_SHORTCUTS) {
    return [...rows, contextual]
  }

  return [
    ...rows.slice(0, MAX_PROJECT_SHORTCUTS - 1),
    contextual,
  ]
}

/**
 * The concrete Project id a route path points inside of —
 * `/projects/<id>` and every `/projects/<id>/<tab>` subroute —
 * or `null` everywhere else (list pages, personal pages, and
 * every non-Project route). Pure and synchronous.
 */
export function projectIdFromPath(
  pathname: string,
): number | null {
  const match =
    /^\/projects\/(\d+)(?:\/|$)/.exec(pathname)

  if (match === null) {
    return null
  }

  const id = Number(match[1])

  return Number.isInteger(id) && id > 0
    ? id
    : null
}
