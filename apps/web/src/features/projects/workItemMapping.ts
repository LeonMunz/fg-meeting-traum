/**
 * Pure helpers that resolve an ApiWorkItem's configurable type/status
 * definition IDs against a Project's Work Item configuration.
 *
 * These are the same values the Project Board and List render from, so
 * they are unit-tested in isolation to guarantee a WorkItem that only
 * carries definition IDs (the canonical backend contract) never maps to
 * `undefined` — which used to crash the List view.
 */

import type {
  ApiProjectWorkItemConfiguration,
  ApiWorkItem,
  ApiWorkItemStatus,
} from '../../api/types'

export type DemoWorkItemType =
  | 'epic'
  | 'milestone'
  | 'deliverable'
  | 'task'

export type DemoWorkItemStatus =
  | 'todo'
  | 'in_progress'
  | 'review'
  | 'done'

export const workItemTypeLabels: Record<
  DemoWorkItemType,
  string
> = {
  epic: 'Epic',
  milestone: 'Milestone',
  deliverable: 'Deliverable',
  task: 'Task',
}

const DEMO_TYPE_KEY_BY_NAME: Record<
  string,
  DemoWorkItemType
> = {
  epic: 'epic',
  milestone: 'milestone',
  deliverable: 'deliverable',
  task: 'task',
}

export function resolveWorkItemStatus(
  statusDefinitionId: number | null | undefined,
  config: ApiProjectWorkItemConfiguration | null,
): DemoWorkItemStatus {
  if (config && statusDefinitionId != null) {
    const def = config.statuses.find(
      (candidate) => candidate.id === statusDefinitionId,
    )
    if (def) {
      const category = def.category as DemoWorkItemStatus
      if (
        category === 'todo' ||
        category === 'in_progress' ||
        category === 'review' ||
        category === 'done'
      ) {
        return category
      }
    }
  }
  return 'todo'
}

export function resolveWorkItemType(
  typeDefinitionId: number | null | undefined,
  config: ApiProjectWorkItemConfiguration | null,
): DemoWorkItemType {
  if (config && typeDefinitionId != null) {
    const def = config.types.find(
      (candidate) => candidate.id === typeDefinitionId,
    )
    if (def) {
      const key =
        DEMO_TYPE_KEY_BY_NAME[def.name.trim().toLowerCase()]
      if (key) {
        return key
      }
    }
  }
  return 'task'
}

export function resolveWorkItemTypeName(
  typeDefinitionId: number | null | undefined,
  config: ApiProjectWorkItemConfiguration | null,
): string | null {
  if (config && typeDefinitionId != null) {
    const def = config.types.find(
      (candidate) => candidate.id === typeDefinitionId,
    )
    if (def) {
      return def.name
    }
  }
  return null
}

export interface ResolvedWorkItemDisplay {
  type: DemoWorkItemType
  status: DemoWorkItemStatus
  typeLabel: string
}

/**
 * Resolve a WorkItem's display type/status/typeLabel from its definition
 * IDs and the Project configuration. Always returns a fully populated
 * value (never `undefined`), so the Board and List can render it safely.
 */
export function resolveWorkItemDisplay(
  item: Pick<ApiWorkItem, 'typeDefinitionId' | 'statusDefinitionId'>,
  config: ApiProjectWorkItemConfiguration | null,
): ResolvedWorkItemDisplay {
  const type = resolveWorkItemType(item.typeDefinitionId, config)
  const status = resolveWorkItemStatus(item.statusDefinitionId, config)
  const typeLabel =
    resolveWorkItemTypeName(item.typeDefinitionId, config) ??
    workItemTypeLabels[type]

  return { type, status, typeLabel }
}

import type { ApiCreateWorkItemInput } from '../../api/types'

export interface WorkItemCreateFormState {
  title: string
  description: string
  typeDefinitionId: number | null
  statusDefinitionId: number | null
  assigneeIds: string[]
  parentId: string | null
  dueDate: string | null
  blockedReason: string | null
}

/**
 * Build the canonical create payload (definition IDs, not legacy
 * type/status strings) from the create-form state. Throws when no type
 * definition is selected, matching the backend's required field.
 */
export function buildCreateWorkItemInput(
  form: WorkItemCreateFormState,
): ApiCreateWorkItemInput {
  if (form.typeDefinitionId == null) {
    throw new Error('A Work Item type is required.')
  }

  const input: ApiCreateWorkItemInput = {
    typeDefinitionId: form.typeDefinitionId,
    title: form.title.trim(),
    description: form.description.trim(),
  }

  if (form.statusDefinitionId != null) {
    input.statusDefinitionId = form.statusDefinitionId
  }

  const assigneeIds = form.assigneeIds
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id))
  if (assigneeIds.length > 0) {
    input.assigneeIds = assigneeIds
  }

  if (form.parentId != null) {
    const parentId = Number(form.parentId)
    if (Number.isInteger(parentId)) {
      input.parentId = parentId
    }
  }

  if (form.dueDate != null) {
    input.dueDate = form.dueDate
  }

  if (form.blockedReason != null) {
    input.blockedReason = form.blockedReason
  }

  return input
}

/**
 * Resolve the status definition ID for a Board column's status category.
 * The Board columns are fixed status categories (todo/in_progress/review/
 * done); a Project's configured status definition that maps to that
 * category is the canonical target for a status change. Returns null when
 * the Project has no matching active status definition.
 */
export function resolveStatusDefinitionIdByCategory(
  statusCategory: DemoWorkItemStatus,
  config: ApiProjectWorkItemConfiguration | null,
): number | null {
  if (!config) {
    return null
  }
  const match = config.statuses.find(
    (candidate) =>
      candidate.active &&
      candidate.category === statusCategory,
  )
  return match ? match.id : null
}

/**
 * Resolve the status definition ID that currently represents a Work Item's
 * status, given the item's resolved status category. This is the inverse of
 * `resolveStatusDefinitionIdByCategory` and is the value a controlled
 * status <select> (whose options are status definitions) must render.
 *
 * Reads the item's canonical `statusDefinitionId` when present and the
 * category only as a fallback, so the selected option always matches what
 * the Board column and the persisted API state agree on.
 */
export function resolveWorkItemStatusSelectValue(
  item: {
    statusDefinitionId?: number | null
    status?: ApiWorkItemStatus | null
  },
  statusCategory: DemoWorkItemStatus,
  config: ApiProjectWorkItemConfiguration | null,
): number | null {
  if (
    config &&
    item.statusDefinitionId != null &&
    config.statuses.some(
      (candidate) => candidate.id === item.statusDefinitionId,
    )
  ) {
    return item.statusDefinitionId
  }

  // Fall back to matching by resolved category (covers legacy items that
  // only carry a fixed-string `status`).
  return resolveStatusDefinitionIdByCategory(
    statusCategory,
    config,
  )
}
