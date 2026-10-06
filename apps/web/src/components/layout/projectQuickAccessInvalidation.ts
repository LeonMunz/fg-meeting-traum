/**
 * Explicit lifecycle invalidation for the global Sidebar Quick
 * Access snapshot (frozen contract QA-9:
 * docs/design/workspace-sidebar/IMPLEMENTATION_CONTRACT.md).
 *
 * The stable session snapshot is never refetched by navigation
 * (QA-2/QA-3/QA-6/QA-9). It is reconciled ONLY on explicit
 * lifecycle evidence that the candidate set itself may be
 * invalid. Today that is a SUCCESSFUL permanent Project
 * deletion, which the route-driven evidence path (the
 * authoritative `getProject` failure for the current Project)
 * cannot observe: the app navigates away from the concrete
 * Project route as soon as the delete succeeds, so
 * `currentProjectId` is already `null` when any late response
 * would arrive.
 *
 * This module is the single, bounded signal: the successful
 * delete path dispatches exactly ONE window event, and the
 * Sidebar (the only consumer of the global snapshot) answers
 * with exactly ONE authoritative global refetch through the
 * same race-guarded path as every other reconciliation. The
 * event carries NO payload — the backend remains the sole
 * authority for the replacement snapshot (no client-side
 * filtering, re-ranking, or name-based mutation of the
 * candidate set).
 */

/**
 * Window event name signaling that the global Quick Access
 * candidate set is invalid and must be reconciled
 * authoritatively.
 */
export const PROJECT_QUICK_ACCESS_INVALIDATED_EVENT =
  'fg-workspace:project-quick-access-invalidated'

/**
 * Signal that the current global Quick Access candidate set is
 * invalid. Bounded: one dispatch per successful lifecycle
 * mutation; the Sidebar consumes it as one global refetch.
 * No-argument by contract — never carry Project identity here.
 */
export function invalidateProjectQuickAccess(): void {
  window.dispatchEvent(
    new CustomEvent(PROJECT_QUICK_ACCESS_INVALIDATED_EVENT),
  )
}
