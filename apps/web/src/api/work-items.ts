import {
  apiGet,
  apiPatch,
  apiPost,
} from './client'

import type {
  ApiCreateWorkItemInput,
  ApiUpdateWorkItemInput,
  ApiWorkItem,
} from './types'

export async function listProjectWorkItems(
  projectId: number,
): Promise<ApiWorkItem[]> {
  return apiGet<ApiWorkItem[]>(
    `/api/projects/${projectId}/work-items/`,
  )
}

export async function createWorkItem(
  projectId: number,
  input: ApiCreateWorkItemInput,
): Promise<ApiWorkItem> {
  return apiPost<ApiWorkItem>(
    `/api/projects/${projectId}/work-items/`,
    input,
  )
}

export async function getWorkItem(
  workItemId: number,
): Promise<ApiWorkItem> {
  return apiGet<ApiWorkItem>(
    `/api/work-items/${workItemId}/`,
  )
}

export async function updateWorkItem(
  workItemId: number,
  input: ApiUpdateWorkItemInput,
): Promise<ApiWorkItem> {
  return apiPatch<ApiWorkItem>(
    `/api/work-items/${workItemId}/`,
    input,
  )
}

export async function listMyWork(
  researchGroupId: number,
): Promise<ApiWorkItem[]> {
  return apiGet<ApiWorkItem[]>(
    `/api/research-groups/${researchGroupId}/my-work/`,
  )
}
