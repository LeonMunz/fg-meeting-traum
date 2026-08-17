import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
} from './client'

import type {
  ApiAddProjectMembershipInput,
  ApiCreateProjectInput,
  ApiDeleteProjectMembershipResponse,
  ApiProject,
  ApiProjectMembership,
  ApiResearchGroupMember,
  ApiUpdateProjectInput,
  ApiUpdateProjectMembershipInput,
} from './types'

export async function listProjects(
  researchGroupId: number,
): Promise<ApiProject[]> {
  return apiGet<ApiProject[]>(
    `/api/research-groups/${researchGroupId}/projects/`,
  )
}

export async function createProject(
  researchGroupId: number,
  input: ApiCreateProjectInput,
): Promise<ApiProject> {
  return apiPost<ApiProject>(
    `/api/research-groups/${researchGroupId}/projects/`,
    input,
  )
}

export async function getProject(
  projectId: number,
): Promise<ApiProject> {
  return apiGet<ApiProject>(
    `/api/projects/${projectId}/`,
  )
}

export async function updateProject(
  projectId: number,
  input: ApiUpdateProjectInput,
): Promise<ApiProject> {
  return apiPatch<ApiProject>(
    `/api/projects/${projectId}/`,
    input,
  )
}

export async function listProjectMemberships(
  projectId: number,
): Promise<ApiProjectMembership[]> {
  return apiGet<ApiProjectMembership[]>(
    `/api/projects/${projectId}/memberships/`,
  )
}

export async function addProjectMembership(
  projectId: number,
  input: ApiAddProjectMembershipInput,
): Promise<ApiProjectMembership> {
  return apiPost<ApiProjectMembership>(
    `/api/projects/${projectId}/memberships/`,
    input,
  )
}

export async function updateProjectMembership(
  projectId: number,
  membershipId: number,
  input: ApiUpdateProjectMembershipInput,
): Promise<ApiProjectMembership> {
  return apiPatch<ApiProjectMembership>(
    `/api/projects/${projectId}/memberships/${membershipId}/`,
    input,
  )
}

export async function removeProjectMembership(
  projectId: number,
  membershipId: number,
): Promise<ApiDeleteProjectMembershipResponse> {
  return apiDelete<ApiDeleteProjectMembershipResponse>(
    `/api/projects/${projectId}/memberships/${membershipId}/`,
  )
}

export async function listResearchGroupMembers(
  researchGroupId: number,
): Promise<ApiResearchGroupMember[]> {
  return apiGet<ApiResearchGroupMember[]>(
    `/api/research-groups/${researchGroupId}/members/`,
  )
}
