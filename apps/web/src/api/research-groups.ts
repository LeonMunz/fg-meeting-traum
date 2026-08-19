import {
  apiGet,
  apiPatch,
  apiPost,
} from './client'

import type {
  ApiAddResearchGroupMembershipInput,
  ApiResearchGroup,
  ApiResearchGroupMemberCandidate,
  ApiResearchGroupMembership,
  ApiResearchGroupMemberOffboardingInput,
  ApiResearchGroupMemberOffboardingPreview,
  ApiResearchGroupMemberOffboardingResponse,
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


export async function searchResearchGroupMemberCandidates(
  researchGroupId: number,
  query: string,
): Promise<ApiResearchGroupMemberCandidate[]> {
  const params = new URLSearchParams({
    q: query,
  })

  return apiGet<ApiResearchGroupMemberCandidate[]>(
    `/api/research-groups/${researchGroupId}/member-candidates/?${params.toString()}`,
  )
}

export async function addResearchGroupMembership(
  researchGroupId: number,
  input: ApiAddResearchGroupMembershipInput,
): Promise<ApiResearchGroupMembership> {
  return apiPost<ApiResearchGroupMembership>(
    `/api/research-groups/${researchGroupId}/memberships/`,
    input,
  )
}


/** Preview dependencies before removing a Research Group member. */
export async function getResearchGroupMemberOffboardingPreview(
  researchGroupId: number,
  membershipId: number,
): Promise<ApiResearchGroupMemberOffboardingPreview> {
  return apiGet<ApiResearchGroupMemberOffboardingPreview>(
    `/api/research-groups/${researchGroupId}/memberships/${membershipId}/offboarding/`,
  )
}

/** Resolve current responsibilities and remove a Research Group member. */
export async function offboardResearchGroupMember(
  researchGroupId: number,
  membershipId: number,
  input: ApiResearchGroupMemberOffboardingInput,
): Promise<ApiResearchGroupMemberOffboardingResponse> {
  return apiPost<ApiResearchGroupMemberOffboardingResponse>(
    `/api/research-groups/${researchGroupId}/memberships/${membershipId}/offboarding/`,
    input,
  )
}
