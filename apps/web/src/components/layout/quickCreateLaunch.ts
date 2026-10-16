/**
 * Typed launch mechanism for the centrally managed Work Item Quick
 * Create controller (the QuickCreate component in the TopBar).
 *
 * A Project-local "New work item" entry (the Project page's Work
 * Items surface) does NOT own a create Drawer of its own: it emits
 * ONE launch request carrying the source Project's actual Research
 * Group and Project IDs, and the QuickCreate controller opens the
 * same canonical create-mode Work Item Drawer with that context as
 * the EDITABLE initial selection. The controller — not the emitting
 * page — validates the context against current eligibility (active,
 * non-archived, owner/member) before preselecting anything; an
 * ineligible source Project is never silently substituted.
 *
 * This mirrors the established `workItemInvalidation.ts` pattern
 * (named window CustomEvent + bounded typed detail + one dispatcher
 * helper) so the route-level Project page and the shell-level
 * TopBar stay decoupled without a second Drawer or a duplicated
 * loading/authorization/request-sequencing implementation.
 */

export const OPEN_QUICK_CREATE_WORK_ITEM_EVENT =
  'fg-workspace:open-quick-create-work-item'

export type QuickCreateWorkItemLaunch = {
  /** The Research Group that owns the source Project. */
  researchGroupId: number
  /** The Project the entry was opened from (the source Project). */
  projectId: number
}

export function requestQuickCreateWorkItem(
  launch: QuickCreateWorkItemLaunch,
) {
  window.dispatchEvent(
    new CustomEvent<QuickCreateWorkItemLaunch>(
      OPEN_QUICK_CREATE_WORK_ITEM_EVENT,
      {
        detail: launch,
      },
    ),
  )
}
