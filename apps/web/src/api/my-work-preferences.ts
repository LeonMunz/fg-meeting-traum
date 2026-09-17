/**
 * Personal My Work preferences API
 * (GET/PATCH /api/me/preferences/my-work/).
 *
 * The client contract is a COMPLETE current snapshot, not
 * incremental toggle actions: `updateMyWorkPreferences` sends the
 * complete snapshot and the returned normalized server snapshot is
 * authoritative for what is now persisted.
 */

import { apiGet, apiPatch } from './client'

import type {
  ApiMyWorkPreferences,
} from './types'

/** The authenticated user's persisted My Work preference snapshot. */
export async function fetchMyWorkPreferences(): Promise<ApiMyWorkPreferences> {
  return apiGet<ApiMyWorkPreferences>(
    '/api/me/preferences/my-work/',
  )
}

/**
 * Persist the COMPLETE current preference snapshot atomically.
 * Returns the normalized server snapshot (authoritative).
 */
export async function updateMyWorkPreferences(
  snapshot: ApiMyWorkPreferences,
): Promise<ApiMyWorkPreferences> {
  return apiPatch<ApiMyWorkPreferences>(
    '/api/me/preferences/my-work/',
    snapshot,
  )
}
