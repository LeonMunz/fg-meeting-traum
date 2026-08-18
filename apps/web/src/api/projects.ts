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
  ApiDeleteProjectResponse,
  ApiProject,
  ApiProjectMembership,
  ApiRemoveProjectMembershipInput,
  ApiResearchGroupMember,
  ApiUpdateProjectInput,
  ApiUpdateProjectMembershipInput,
} from './types'

export async function listProjects(
  researchGroupId: number,
  options?: {
    includeArchived?: boolean
  },
): Promise<ApiProject[]> {
  const query =
    options?.includeArchived === true
      ? '?includeArchived=true'
      : ''

  return apiGet<ApiProject[]>(
    `/api/research-groups/${researchGroupId}/projects/${query}`,
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

export async function archiveProject(
  projectId: number,
): Promise<ApiProject> {
  return apiPost<ApiProject>(
    `/api/projects/${projectId}/archive/`,
    {},
  )
}

export async function restoreProject(
  projectId: number,
): Promise<ApiProject> {
  return apiPost<ApiProject>(
    `/api/projects/${projectId}/restore/`,
    {},
  )
}

export async function deleteProject(
  projectId: number,
): Promise<ApiDeleteProjectResponse> {
  return apiDelete<ApiDeleteProjectResponse>(
    `/api/projects/${projectId}/`,
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
  input?: ApiRemoveProjectMembershipInput,
): Promise<ApiDeleteProjectMembershipResponse> {
  return apiDelete<ApiDeleteProjectMembershipResponse>(
    `/api/projects/${projectId}/memberships/${membershipId}/`,
    input,
  )
}

export async function listResearchGroupMembers(
  researchGroupId: number,
): Promise<ApiResearchGroupMember[]> {
  return apiGet<ApiResearchGroupMember[]>(
    `/api/research-groups/${researchGroupId}/members/`,
  )
}
