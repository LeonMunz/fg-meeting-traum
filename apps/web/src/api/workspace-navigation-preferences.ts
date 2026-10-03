/**
 * Personal workspace navigation preferences API
 * (GET/PATCH /api/me/preferences/workspace-navigation/).
 *
 * The client contract is a COMPLETE current snapshot, not
 * incremental toggle actions: `updateWorkspaceNavigationPreferences`
 * sends the complete snapshot and the returned normalized server
 * snapshot is authoritative for what is now persisted.
 */

import { apiGet, apiPatch } from './client'

import type {
  ApiWorkspaceNavigationPreferences,
} from './types'

/** The authenticated user's persisted workspace navigation snapshot. */
export async function fetchWorkspaceNavigationPreferences(): Promise<
  ApiWorkspaceNavigationPreferences
> {
  return apiGet<ApiWorkspaceNavigationPreferences>(
    '/api/me/preferences/workspace-navigation/',
  )
}

/**
 * Persist the COMPLETE current preference snapshot atomically.
 * Returns the normalized server snapshot (authoritative).
 */
export async function updateWorkspaceNavigationPreferences(
  snapshot: ApiWorkspaceNavigationPreferences,
): Promise<ApiWorkspaceNavigationPreferences> {
  return apiPatch<ApiWorkspaceNavigationPreferences>(
    '/api/me/preferences/workspace-navigation/',
    snapshot,
  )
}
