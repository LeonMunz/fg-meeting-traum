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
  ApiWorkItemStatus,
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

export interface ApiMyWorkReorderInput {
  // The target My Work column — one of the four fixed semantic
  // categories. Same category as the item's current status:
  // personal ordering ONLY (no status mutation); different
  // category: the backend resolves the concrete project-local
  // status target and applies the canonical transition atomically
  // with the personal position (foundation.md Section 14b).
  statusCategory: ApiWorkItemStatus
  // The Work Item that must FOLLOW the moved one in the target
  // column; null = end of the column. Never the moved Work Item
  // itself.
  beforeWorkItemId: number | null
}

/**
 * Atomic My Work Board move: places the Work Item at an exact
 * position in the requesting user's personal My Work column for
 * the requested semantic category.
 *
 * One request covers the whole operation — same-column reordering
 * (personal ordering only, no status mutation) and cross-column
 * moves (canonical status transition + personal position in ONE
 * server transaction). The standalone `transitionWorkItemStatus`
 * request is a different operation (no positional anchor) and must
 * NOT be called in addition for a board drag.
 *
 * The response is the moved Work Item as serialized for the
 * requesting user; My Work reconciles by the subsequent
 * authoritative `listMyWork()` refetch, so the returned object is
 * informational for the caller.
 */
export async function reorderMyWorkItem(
  workItemId: number,
  input: ApiMyWorkReorderInput,
): Promise<ApiWorkItem> {
  return apiPost<ApiWorkItem>(
    `/api/me/work-items/${workItemId}/reorder/`,
    input,
  )
}
