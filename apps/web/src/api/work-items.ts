import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
} from './client'

import type {
  ApiCreateWorkItemCommentInput,
  ApiCreateWorkItemInput,
  ApiPersonalWorkItem,
  ApiUpdateWorkItemCommentInput,
  ApiUpdateWorkItemInput,
  ApiWorkItem,
  ApiWorkItemComment,
  ApiWorkItemHistoryEvent,
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

export async function deleteWorkItem(
  workItemId: number,
): Promise<void> {
  return apiDelete<void>(
    `/api/work-items/${workItemId}/`,
  )
}

export interface ApiReorderWorkItemInput {
  statusDefinitionId?: number | null
  beforeWorkItemId?: number | null
}

export async function reorderWorkItem(
  workItemId: number,
  input: ApiReorderWorkItemInput,
): Promise<ApiWorkItem> {
  return apiPost<ApiWorkItem>(
    `/api/work-items/${workItemId}/reorder/`,
    input,
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

/**
 * Canonical status-only transition: changes the Work Item's
 * concrete `statusDefinitionId` WITHOUT changing its project-local
 * `board_position` (no Project-board reposition, no sibling
 * renumbering). The dedicated "status change that preserves Project
 * board order" counterpart to `updateWorkItem` (which repositions a
 * status-changed item to the end of the target column) and to
 * `reorderWorkItem` (which sets an exact position).
 *
 * The body carries exactly the target `statusDefinitionId` — no
 * board position, no insertion anchor, no other state.
 */
export async function transitionWorkItemStatus(
  workItemId: number,
  statusDefinitionId: number,
): Promise<ApiWorkItem> {
  return apiPost<ApiWorkItem>(
    `/api/work-items/${workItemId}/transition-status/`,
    { statusDefinitionId },
  )
}

export async function listWorkItemHistory(
  workItemId: number,
): Promise<ApiWorkItemHistoryEvent[]> {
  return apiGet<ApiWorkItemHistoryEvent[]>(
    `/api/work-items/${workItemId}/history/`,
  )
}

export async function listWorkItemComments(
  workItemId: number,
): Promise<ApiWorkItemComment[]> {
  return apiGet<ApiWorkItemComment[]>(
    `/api/work-items/${workItemId}/comments/`,
  )
}

export async function createWorkItemComment(
  workItemId: number,
  input: ApiCreateWorkItemCommentInput,
): Promise<ApiWorkItemComment> {
  return apiPost<ApiWorkItemComment>(
    `/api/work-items/${workItemId}/comments/`,
    input,
  )
}

export async function updateWorkItemComment(
  commentId: number,
  input: ApiUpdateWorkItemCommentInput,
): Promise<ApiWorkItemComment> {
  return apiPatch<ApiWorkItemComment>(
    `/api/work-item-comments/${commentId}/`,
    input,
  )
}

export async function deleteWorkItemComment(
  commentId: number,
): Promise<void> {
  await apiDelete<void>(
    `/api/work-item-comments/${commentId}/`,
  )
}

export async function listMyWork(
  researchGroupId?: number,
): Promise<ApiPersonalWorkItem[]> {
  const query =
    researchGroupId == null
      ? ''
      : `?group=${researchGroupId}`

  return apiGet<ApiPersonalWorkItem[]>(
    `/api/me/work-items/${query}`,
  )
}
