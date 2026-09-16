import { apiGet } from './client'

import type { ApiHome } from './types'

/**
 * The authenticated Home aggregate: one read-only, non-paginated
 * response composing the four Home read models (Needs attention,
 * Today & next, My work, Continue working). All four section keys are
 * always present; an empty section is `[]`.
 */
export async function getHome(): Promise<ApiHome> {
  return apiGet<ApiHome>('/api/home/')
}
