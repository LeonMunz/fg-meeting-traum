import {
  apiGet,
  apiPatch,
} from './client'

import type {
  ApiResearchGroup,
  ApiResearchGroupMembership,
  ApiUpdateResearchGroupInput,
  ApiUpdateResearchGroupMembershipInput,
} from './types'

/** List Research Groups the current user belongs to. */
export async function listResearchGroups(): Promise<ApiResearchGroup[]> {
  return apiGet<ApiResearchGroup[]>(
    '/api/research-groups/',
  )
}

/** Get a Research Group by ID. Returns 404 if not accessible. */
export async function getResearchGroup(
  id: number,
): Promise<ApiResearchGroup> {
  return apiGet<ApiResearchGroup>(
    `/api/research-groups/${id}/`,
  )
}

/** Update Research Group metadata. Admin only. */
export async function updateResearchGroup(
  id: number,
  input: ApiUpdateResearchGroupInput,
): Promise<ApiResearchGroup> {
  return apiPatch<ApiResearchGroup>(
    `/api/research-groups/${id}/`,
    input,
  )
}

/** List administrative memberships. Admin only. */
export async function listResearchGroupMemberships(
  researchGroupId: number,
): Promise<ApiResearchGroupMembership[]> {
  return apiGet<ApiResearchGroupMembership[]>(
    `/api/research-groups/${researchGroupId}/memberships/`,
  )
}

/** Change a Research Group membership role. Admin only. */
export async function updateResearchGroupMembership(
  researchGroupId: number,
  membershipId: number,
  input: ApiUpdateResearchGroupMembershipInput,
): Promise<ApiResearchGroupMembership> {
  return apiPatch<ApiResearchGroupMembership>(
    `/api/research-groups/${researchGroupId}/memberships/${membershipId}/`,
    input,
  )
}
