/**
 * Pure helpers that resolve an ApiWorkItem's configurable type/status
 * definition IDs against a Project's Work Item configuration.
 *
 * These are the same values the Project Board and List render from, so
 * they are unit-tested in isolation to guarantee a WorkItem that only
 * carries definition IDs (the canonical backend contract) never maps to
 * `undefined` — which used to crash the List view.
 *
 * STATUS CONTRACT: an item whose status cannot be resolved (missing
 * configuration, unknown ID, or an invalid category) is explicitly
 * `null` — never folded into a guessed category. Rendering keeps it
 * out of every Board column and status-dependent mutation path.
 */

import type {
  ApiProjectWorkItemConfiguration,
  ApiWorkItem,
  ApiWorkItemStatusDefinition,
  ApiWorkItemTypeDefinition,
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

/**
 * The resolved semantic category of a Work Item's concrete
 * StatusDefinition. `null` = UNRESOLVED: the configuration is missing
 * (e.g. a failed Config-GET) or the referenced definition cannot be
 * resolved. Callers must keep such items out of every status column
 * and status-dependent mutation — they are never guessed into `todo`.
 */
export type ResolvedWorkItemStatus = DemoWorkItemStatus | null

export const workItemTypeLabels: Record<
  DemoWorkItemType,
  string
> = {
  epic: 'Epic',
  milestone: 'Milestone',
  deliverable: 'Deliverable',
  task: 'Task',
}

/**
 * Resolve a Work Item's concrete `statusDefinitionId` against the
 * Project's Work Item configuration and return its fixed semantic
 * category. An INACTIVE definition an existing Work Item still
 * references is valid and resolves to its stored category.
 *
 * Returns `null` — never a guessed category — when the configuration
 * is missing, the ID is unknown, or the definition's category is not
 * one of the four fixed semantic categories.
 */
export function resolveWorkItemStatus(
  statusDefinitionId: number | null | undefined,
  config: ApiProjectWorkItemConfiguration | null,
): ResolvedWorkItemStatus {
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
  // Unresolvable: no configuration (a failed Config-GET is NOT an
  // empty configuration), an unknown ID, or a category outside the
  // four fixed semantic categories. Nothing is invented.
  return null
}

/**
 * Resolve the concrete TypeDefinition referenced by a Work Item's
 * canonical `typeDefinitionId` — a pure ID lookup against the
 * Project's Work Item configuration. Returns the definition as
 * configured (including inactive definitions an existing Work Item
 * may still reference), or null when the configuration is missing
 * or cannot resolve the ID. Nothing is inferred: no fallback
 * definition, no name matching.
 */
export function resolveWorkItemTypeDefinition(
  typeDefinitionId: number | null | undefined,
  config: ApiProjectWorkItemConfiguration | null,
): ApiWorkItemTypeDefinition | null {
  if (config && typeDefinitionId != null) {
    return (
      config.types.find(
        (candidate) => candidate.id === typeDefinitionId,
      ) ?? null
    )
  }
  return null
}

export function resolveWorkItemType(
  typeDefinitionId: number | null | undefined,
  config: ApiProjectWorkItemConfiguration | null,
): DemoWorkItemType {
  // Semantic kind is the definition's stored, system-assigned
  // `kind` — NEVER inferred from the configurable display name
  // (foundation.md §3a.1 runtime rule). A renamed canonical
  // definition keeps its kind; a custom (kind null) definition or
  // an unresolvable ID keeps the neutral `task` presentation
  // fallback (same as the pre-kind behavior, unchanged).
  const def = resolveWorkItemTypeDefinition(
    typeDefinitionId,
    config,
  )
  if (
    def != null &&
    (def.kind === 'epic' ||
      def.kind === 'milestone' ||
      def.kind === 'deliverable' ||
      def.kind === 'task')
  ) {
    return def.kind
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

/**
 * Resolve the concrete StatusDefinition referenced by a Work Item's
 * canonical `statusDefinitionId` — a pure ID lookup against the
 * Project's Work Item configuration. Returns the definition as
 * configured (including inactive definitions an existing Work Item
 * may still reference), or null when the configuration is missing
 * or cannot resolve the ID. Nothing is inferred: no fallback
 * definition, no name or semantic-category matching.
 */
export function resolveWorkItemStatusDefinition(
  statusDefinitionId: number | null | undefined,
  config: ApiProjectWorkItemConfiguration | null,
): ApiWorkItemStatusDefinition | null {
  if (config && statusDefinitionId != null) {
    return (
      config.statuses.find(
        (candidate) => candidate.id === statusDefinitionId,
      ) ?? null
    )
  }
  return null
}

export interface ResolvedWorkItemDisplay {
  type: DemoWorkItemType
  status: ResolvedWorkItemStatus
  typeLabel: string
}

/**
 * Resolve a WorkItem's display type/status/typeLabel from its definition
 * IDs and the Project configuration. Always returns a fully populated
 * value (never `undefined`), so the Board and List can render it safely.
 * An unresolved status is reported as `null`, not a guessed category.
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
 * Resolve the concrete StatusDefinition that a CROSS-category Board drop
 * moves a Work Item to. The Board columns are fixed status categories
 * (todo/in_progress/review/done), and a category may hold SEVERAL
 * concrete active StatusDefinitions; the canonical provisional target is
 * the first ACTIVE definition of the category by configured `order`,
 * with a stable `id` tie-break (foundation.md Section 15). The result is
 * the explicit `statusDefinitionId` of the reorder request — the server
 * re-validates it under the Project lock. Returns null when the Project
 * has no matching ACTIVE status definition (the drop must be prevented,
 * never guessed).
 *
 * The minimum is taken over (order, id) explicitly; the payload order is
 * not assumed. This function is the cross-category target resolution
 * only — a SAME-category drop keeps the item's own StatusDefinition and
 * must never resolve through it.
 */
export function resolveStatusDefinitionIdByCategory(
  statusCategory: DemoWorkItemStatus,
  config: ApiProjectWorkItemConfiguration | null,
): number | null {
  if (!config) {
    return null
  }

  let match: ApiWorkItemStatusDefinition | null = null

  for (const candidate of config.statuses) {
    if (
      !candidate.active ||
      candidate.category !== statusCategory
    ) {
      continue
    }
    if (
      match === null ||
      candidate.order < match.order ||
      (candidate.order === match.order &&
        candidate.id < match.id)
    ) {
      match = candidate
    }
  }

  return match ? match.id : null
}
