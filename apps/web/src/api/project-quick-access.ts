/**
 * Personal Project Quick Access API
 * (POST /api/me/projects/{projectId}/open/,
 * GET /api/research-groups/{researchGroupId}/project-quick-access/,
 * GET /api/me/project-quick-access/).
 *
 * Thin client contract: the backend owns ALL ranking, access
 * filtering, archived-Project filtering, server-owned timestamps,
 * and the max-five bound. The client records an explicit Project
 * open with an empty body (the server owns the timestamp) and
 * returns server responses unchanged — no normalization,
 * re-sorting, or trimming here.
 */

import { apiGet, apiPost } from './client'

import type {
  ApiProjectNavigationOpen,
  ApiProjectQuickAccessItem,
} from './types'

/**
 * Record the authenticated user's explicit open of a Project.
 * The request body is empty — no timestamp or other client-owned
 * data is sent; the server owns `lastOpenedAt`. Returns the
 * server confirmation unchanged.
 */
export async function recordProjectOpen(
  projectId: number,
): Promise<ApiProjectNavigationOpen> {
  return apiPost<ApiProjectNavigationOpen>(
    `/api/me/projects/${projectId}/open/`,
    {},
  )
}

/**
 * Fetch the personal Project Quick Access list (max five
 * candidates) for a Research Group in the exact server order
 * (personal recency ranking, access and archived filtering are
 * backend-owned). Returns the server array unchanged.
 */
export async function fetchProjectQuickAccess(
  researchGroupId: number,
): Promise<ApiProjectQuickAccessItem[]> {
  return apiGet<ApiProjectQuickAccessItem[]>(
    `/api/research-groups/${researchGroupId}/project-quick-access/`,
  )
}

/**
 * Fetch the GLOBAL personal Project Quick Access snapshot (max
 * five candidates across ALL accessible Research Groups) in the
 * exact server order (global personal recency ranking, access and
 * archived filtering are backend-owned). Returns the server array
 * unchanged — no Research Group fan-out, no client-side sorting or
 * truncation.
 */
export async function fetchGlobalProjectQuickAccess(): Promise<
  ApiProjectQuickAccessItem[]
> {
  return apiGet<ApiProjectQuickAccessItem[]>('/api/me/project-quick-access/')
}
