import { apiGet } from './client'
import type { ApiResearchGroup } from './types'

/** List Research Groups the current user belongs to. */
export async function listResearchGroups(): Promise<ApiResearchGroup[]> {
  return apiGet<ApiResearchGroup[]>('/api/research-groups/')
}

/** Get a Research Group by ID. Returns 404 if not accessible. */
export async function getResearchGroup(
  id: number,
): Promise<ApiResearchGroup> {
  return apiGet<ApiResearchGroup>(`/api/research-groups/${id}/`)
}
