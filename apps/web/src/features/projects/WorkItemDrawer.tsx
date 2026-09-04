import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  FormEvent,
  ReactNode,
} from 'react'

import { ApiError } from '../../api/client'
import { RichMarkdownEditor } from '../../components/editor/RichMarkdownEditor'
import {
  isMarkdownContentEmpty,
  markdownToPlainText,
} from '../../components/editor/markdownExtensions'
import type {
  ApiProjectWorkItemConfiguration,
  ApiUpdateWorkItemInput,
  ApiWorkItem,
  ApiWorkItemComment,
  ApiWorkItemHistoryActor,
  ApiWorkItemHistoryChanges,
  ApiWorkItemHistoryEvent,
  ApiWorkItemStatus,
  ApiWorkItemType,
} from '../../api/types'
import {
  createWorkItemComment,
  deleteWorkItemComment,
  listWorkItemComments,
  listWorkItemHistory,
  updateWorkItemComment,
} from '../../api/work-items'
import {
  resolveStatusDefinitionIdByCategory,
  resolveWorkItemStatusSelectValue,
} from './workItemMapping'
import {
  WorkItemActionMenuTrigger,
  WorkItemDeleteDialog,
} from './workItemDelete'

export type WorkItemFormInput = {
  title: string
  description: string
  typeDefinitionId: number
  statusDefinitionId: number | null
  assigneeIds: string[]
  parentId: string | null
  dueDate: string | null
  blockedReason: string | null
}

type AssigneeOption = {
  id: string
  name: string
  initials: string
}

type ParentOption = {
  id: string
  title: string
  type: ApiWorkItemType
}

type WorkItemDrawerProps = {
  open: boolean
  mode: 'create' | 'edit'
  projectName: string
  item: ApiWorkItem | null
  readOnly: boolean
  currentUserId: number | null
  workItemConfiguration: ApiProjectWorkItemConfiguration | null
  assignees: AssigneeOption[]
  parentItems: ParentOption[]
  onClose: () => void
  onCreate: (
    input: WorkItemFormInput,
  ) => Promise<void>
  onPatch: (
    workItemId: number,
    patch: ApiUpdateWorkItemInput,
  ) => Promise<void>
  onDelete?: (workItemId: number) => Promise<void>
  onRequestDelete?: (workItemId: number) => void
  deleteDialogOpen?: boolean
  isDeletingWorkItem?: boolean
  deleteError?: string | null
  onCancelDelete?: () => void
  onConfirmDelete?: () => void
}

const typeOptions: Array<{
  value: ApiWorkItemType
  label: string
  icon: string
}> = [
  {
    value: 'epic',
    label: 'Epic',
    icon: 'account_tree',
  },
  {
    value: 'milestone',
    label: 'Milestone',
    icon: 'flag',
  },
  {
    value: 'deliverable',
    label: 'Deliverable',
    icon: 'inventory_2',
  },
  {
    value: 'task',
    label: 'Task',
    icon: 'check_box_outline_blank',
  },
]

const statusOptions: Array<{
  value: ApiWorkItemStatus
  label: string
}> = [
  {
    value: 'todo',
    label: 'To do',
  },
  {
    value: 'in_progress',
    label: 'In progress',
  },
  {
    value: 'review',
    label: 'Review',
  },
  {
    value: 'done',
    label: 'Done',
  },
]

// Icon for a Project-configured type definition by its display name.
// Falls back to the generic task icon for custom types we do not know.
function typeIconForName(name: string): string {
  const match = typeOptions.find(
    (option) =>
      option.label.toLowerCase() === name.trim().toLowerCase(),
  )
  return match ? match.icon : 'check_box_outline_blank'
}

/* ── History presentation helpers ─────────────────────────────────
 * Map the typed backend history contract (see api/types.ts) to
 * compact, readable timeline rows. Never render raw JSON — every
 * field of `changes` a UI can encounter is translated to plain text
 * here, and only fields actually present in the response are used.
 */

function getStatusLabel(value: ApiWorkItemStatus): string {
  return (
    statusOptions.find((option) => option.value === value)
      ?.label ?? value
  )
}

function getTypeLabel(value: ApiWorkItemType): string {
  return (
    typeOptions.find((option) => option.value === value)
      ?.label ?? value
  )
}

// Mirrors ProjectDetailPage's getPersonName display-name convention
// (firstName + lastName, falling back to username).
function getActorDisplayName(
  actor: ApiWorkItemHistoryActor | null,
): string {
  if (!actor) {
    // Neutral system representation — never fabricate a user.
    return 'Someone'
  }

  const fullName = `${actor.firstName} ${actor.lastName}`.trim()
  return fullName || actor.username
}

function formatHistoryShortDate(isoDate: string): string {
  const [year, month, day] = isoDate
    .split('-')
    .map(Number)

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return isoDate
  }

  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(year, month - 1, day))
}

function formatMeetingOriginDate(
  isoDateTime: string,
): string {
  const date = new Date(
    isoDateTime,
  )

  if (Number.isNaN(date.getTime())) {
    return isoDateTime
  }

  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
  }).format(date)
}

function formatHistoryRelativeTime(
  isoDateTime: string,
): string {
  const date = new Date(isoDateTime)

  if (Number.isNaN(date.getTime())) {
    return ''
  }

  const diffMs = Date.now() - date.getTime()
  const diffMinutes = Math.round(diffMs / 60_000)

  if (diffMinutes < 1) {
    return 'Just now'
  }

  if (diffMinutes < 60) {
    return `${diffMinutes} min ago`
  }

  const diffHours = Math.round(diffMinutes / 60)

  if (diffHours < 24) {
    return `${diffHours} h ago`
  }

  const day = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  )
  const now = new Date()
  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  )
  const diffDays = Math.round(
    (today.getTime() - day.getTime()) / 86_400_000,
  )

  if (diffDays === 1) {
    return 'Yesterday'
  }

  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
  }).format(date)
}

function formatHistoryAbsoluteTime(
  isoDateTime: string,
): string {
  const date = new Date(isoDateTime)

  if (Number.isNaN(date.getTime())) {
    return isoDateTime
  }

  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function summarizeAssignees(
  added: ApiWorkItemHistoryActor[],
  removed: ApiWorkItemHistoryActor[],
): string {
  const parts: string[] = []

  if (added.length > 0) {
    parts.push(
      `+ ${added
        .map((actor) => getActorDisplayName(actor))
        .join(', ')}`,
    )
  }

  if (removed.length > 0) {
    parts.push(
      `− ${removed
        .map((actor) => getActorDisplayName(actor))
        .join(', ')}`,
    )
  }

  return parts.join('   ')
}

function summarizeParentRef(
  ref: { id: number; title: string | null } | null,
): string {
  if (!ref) {
    return 'None'
  }

  return ref.title ?? `Work Item #${ref.id}`
}

// Fixed, stable ordering for multi-field updates — never depends on
// object key insertion order from the API response.
const HISTORY_CHANGE_FIELD_ORDER = [
  'title',
  'description',
  'type',
  'status',
  'dueDate',
  'blockedReason',
  'parent',
  'assignees',
] as const

type HistoryChangeField =
  (typeof HISTORY_CHANGE_FIELD_ORDER)[number]

function getChangedHistoryFields(
  changes: ApiWorkItemHistoryChanges,
): HistoryChangeField[] {
  return HISTORY_CHANGE_FIELD_ORDER.filter(
    (field) => changes[field] !== undefined,
  )
}

// Compact "Label   value summary" line used when a single event
// changed MULTIPLE fields at once (see HISTORY_CHANGE_FIELD_ORDER).
function describeHistoryFieldCompact(
  field: HistoryChangeField,
  changes: ApiWorkItemHistoryChanges,
): { label: string; text: string } {
  switch (field) {
    case 'title': {
      const change = changes.title
      return {
        label: 'Title',
        text: `${change?.from ?? ''} → ${change?.to ?? ''}`,
      }
    }
    case 'description':
      return { label: 'Description', text: 'Changed' }
    case 'type': {
      const change = changes.type
      return {
        label: 'Type',
        text: change
          ? `${getTypeLabel(change.from)} → ${getTypeLabel(change.to)}`
          : '',
      }
    }
    case 'status': {
      const change = changes.status
      return {
        label: 'Status',
        text: change
          ? `${getStatusLabel(change.from)} → ${getStatusLabel(change.to)}`
          : '',
      }
    }
    case 'dueDate': {
      const change = changes.dueDate
      const from = change?.from
        ? formatHistoryShortDate(change.from)
        : 'None'
      const to = change?.to
        ? formatHistoryShortDate(change.to)
        : 'None'
      return { label: 'Due date', text: `${from} → ${to}` }
    }
    case 'blockedReason': {
      const change = changes.blockedReason
      if (!change || change.from == null) {
        return { label: 'Blocked', text: 'Marked blocked' }
      }
      if (change.to == null) {
        return { label: 'Blocked', text: 'Unblocked' }
      }
      return { label: 'Blocked', text: 'Reason changed' }
    }
    case 'parent': {
      const change = changes.parent
      return {
        label: 'Parent',
        text: change
          ? `${summarizeParentRef(change.from)} → ${summarizeParentRef(change.to)}`
          : '',
      }
    }
    case 'assignees': {
      const change = changes.assignees
      return {
        label: 'Assignees',
        text: change
          ? summarizeAssignees(change.added, change.removed)
          : '',
      }
    }
  }
}

type HistoryRowDescription = {
  primary: string
  // Secondary line(s) below the primary sentence — no label prefix
  // for a single-field event (natural wording), labeled for a
  // multi-field event (compact aligned list).
  lines: Array<{ label: string | null; text: string }>
}

function describeSingleHistoryField(
  actorName: string,
  field: HistoryChangeField,
  changes: ApiWorkItemHistoryChanges,
): HistoryRowDescription {
  switch (field) {
    case 'title': {
      const change = changes.title
      return {
        primary: `${actorName} renamed this work item`,
        lines: change
          ? [
              {
                label: null,
                text: `${change.from} → ${change.to}`,
              },
            ]
          : [],
      }
    }
    case 'description':
      return {
        primary: `${actorName} changed the description`,
        lines: [],
      }
    case 'type': {
      const change = changes.type
      return {
        primary: `${actorName} changed type`,
        lines: change
          ? [
              {
                label: null,
                text: `${getTypeLabel(change.from)} → ${getTypeLabel(change.to)}`,
              },
            ]
          : [],
      }
    }
    case 'status': {
      const change = changes.status
      return {
        primary: `${actorName} changed status`,
        lines: change
          ? [
              {
                label: null,
                text: `${getStatusLabel(change.from)} → ${getStatusLabel(change.to)}`,
              },
            ]
          : [],
      }
    }
    case 'dueDate': {
      const change = changes.dueDate

      if (!change || (change.from == null && change.to == null)) {
        return {
          primary: `${actorName} changed due date`,
          lines: [],
        }
      }

      if (change.from == null) {
        return {
          primary: `${actorName} set due date`,
          lines: [
            {
              label: null,
              text: formatHistoryShortDate(change.to as string),
            },
          ],
        }
      }

      if (change.to == null) {
        return {
          primary: `${actorName} removed due date`,
          lines: [],
        }
      }

      return {
        primary: `${actorName} changed due date`,
        lines: [
          {
            label: null,
            text: `${formatHistoryShortDate(change.from)} → ${formatHistoryShortDate(change.to)}`,
          },
        ],
      }
    }
    case 'blockedReason': {
      const change = changes.blockedReason

      if (!change || (change.from == null && change.to == null)) {
        return {
          primary: `${actorName} changed the blocked reason`,
          lines: [],
        }
      }

      if (change.from == null) {
        return {
          primary: `${actorName} marked this work item as blocked`,
          // The stored reason is canonical Markdown (see
          // markdownExtensions.ts) — this quiet History line is plain
          // text, not rendered content, so it reads the reason
          // naturally instead of showing raw "**"/"- " syntax.
          lines: change.to
            ? [
                {
                  label: null,
                  text: markdownToPlainText(
                    change.to,
                    'compact',
                  ),
                },
              ]
            : [],
        }
      }

      if (change.to == null) {
        return {
          primary: `${actorName} unblocked this work item`,
          lines: [],
        }
      }

      return {
        primary: `${actorName} changed the blocked reason`,
        lines: [
          {
            label: null,
            text: markdownToPlainText(change.to, 'compact'),
          },
        ],
      }
    }
    case 'parent': {
      const change = changes.parent

      if (!change || (change.from == null && change.to == null)) {
        return {
          primary: `${actorName} changed parent`,
          lines: [],
        }
      }

      if (change.from == null) {
        return {
          primary: `${actorName} added parent`,
          lines: [
            {
              label: null,
              text: summarizeParentRef(change.to),
            },
          ],
        }
      }

      if (change.to == null) {
        return {
          primary: `${actorName} removed parent`,
          lines: [
            {
              label: null,
              text: summarizeParentRef(change.from),
            },
          ],
        }
      }

      return {
        primary: `${actorName} changed parent`,
        lines: [
          {
            label: null,
            text: `${summarizeParentRef(change.from)} → ${summarizeParentRef(change.to)}`,
          },
        ],
      }
    }
    case 'assignees': {
      const change = changes.assignees
      const added = change?.added ?? []
      const removed = change?.removed ?? []

      if (added.length === 1 && removed.length === 0) {
        return {
          primary: `${getActorDisplayName(added[0])} was assigned`,
          lines: [],
        }
      }

      if (removed.length === 1 && added.length === 0) {
        return {
          primary: `${getActorDisplayName(removed[0])} was unassigned`,
          lines: [],
        }
      }

      return {
        primary: `${actorName} changed assignees`,
        lines: [
          {
            label: null,
            text: summarizeAssignees(added, removed),
          },
        ],
      }
    }
  }
}

function describeWorkItemHistoryEvent(
  event: ApiWorkItemHistoryEvent,
): HistoryRowDescription {
  const actorName = getActorDisplayName(event.actor)

  if (event.eventType === 'work_item.created') {
    return {
      primary: `${actorName} created this work item`,
      lines: [],
    }
  }

  const changedFields = getChangedHistoryFields(
    event.changes,
  )

  if (changedFields.length === 0) {
    // Defensive only — the backend never emits an empty update event.
    return {
      primary: `${actorName} updated this work item`,
      lines: [],
    }
  }

  if (changedFields.length === 1) {
    return describeSingleHistoryField(
      actorName,
      changedFields[0],
      event.changes,
    )
  }

  return {
    primary: `${actorName} updated this work item`,
    lines: changedFields.map((field) =>
      describeHistoryFieldCompact(field, event.changes),
    ),
  }
}

function getWorkItemHistoryErrorMessage(
  error: unknown,
): string {
  if (
    error instanceof ApiError &&
    error.detail &&
    typeof error.detail === 'object' &&
    'error' in error.detail
  ) {
    const detail = error.detail as { error?: unknown }

    if (typeof detail.error === 'string') {
      return detail.error
    }
  }

  return 'History could not be loaded.'
}

/* ── Comment presentation helpers ─────────────────────────────── */

function getActorInitials(
  actor: ApiWorkItemHistoryActor,
): string {
  const initials = [actor.firstName, actor.lastName]
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value[0]?.toUpperCase())
    .join('')

  return (
    initials ||
    actor.username.slice(0, 2).toUpperCase()
  )
}

function getWorkItemCommentsErrorMessage(
  error: unknown,
): string {
  if (
    error instanceof ApiError &&
    error.detail &&
    typeof error.detail === 'object' &&
    'error' in error.detail
  ) {
    const detail = error.detail as { error?: unknown }

    if (typeof detail.error === 'string') {
      return detail.error
    }
  }

  return 'Comments could not be loaded.'
}

function getWorkItemCommentActionErrorMessage(
  error: unknown,
  fallback: string,
): string {
  if (
    error instanceof ApiError &&
    error.detail &&
    typeof error.detail === 'object' &&
    'error' in error.detail
  ) {
    const detail = error.detail as { error?: unknown }

    if (typeof detail.error === 'string') {
      return detail.error
    }
  }

  return fallback
}


// Comments and History events are different typed sources, merged
// presentation-side only — never combined into a fake backend event.
type ActivityFeedItem =
  | {
      kind: 'comment'
      key: string
      createdAt: string
      comment: ApiWorkItemComment
    }
  | {
      kind: 'history'
      key: string
      createdAt: string
      event: ApiWorkItemHistoryEvent
    }

function buildActivityFeed(
  comments: ApiWorkItemComment[],
  historyEvents: ApiWorkItemHistoryEvent[],
): ActivityFeedItem[] {
  const items: ActivityFeedItem[] = [
    ...comments.map(
      (comment): ActivityFeedItem => ({
        kind: 'comment',
        key: `comment-${comment.id}`,
        createdAt: comment.createdAt,
        comment,
      }),
    ),
    ...historyEvents.map(
      (event): ActivityFeedItem => ({
        kind: 'history',
        key: `history-${event.id}`,
        createdAt: event.createdAt,
        event,
      }),
    ),
  ]

  // Newest first, matching both sources' native ordering. Array.sort
  // is stable, so events with an identical timestamp keep their
  // original relative order instead of jittering between renders.
  items.sort(
    (a, b) =>
      new Date(b.createdAt).getTime() -
      new Date(a.createdAt).getTime(),
  )

  return items
}

export function WorkItemDrawer({
  open,
  mode,
  projectName,
  item,
  readOnly,
  currentUserId,
  workItemConfiguration,
  assignees,
  parentItems,
  onClose,
  onCreate,
  onPatch,
  onDelete,
  onRequestDelete,
  deleteDialogOpen,
  isDeletingWorkItem,
  deleteError,
  onCancelDelete,
  onConfirmDelete,
}: WorkItemDrawerProps) {
  if (!open) {
    return null
  }

  if (mode === 'edit') {
    if (!item) {
      return null
    }

    return (
      <WorkItemInspector
        projectName={projectName}
        item={item}
        readOnly={readOnly}
        currentUserId={currentUserId}
        workItemConfiguration={workItemConfiguration}
        assignees={assignees}
        parentItems={parentItems}
        onClose={onClose}
        onPatch={onPatch}
        onDelete={onDelete}
        onRequestDelete={onRequestDelete}
        deleteDialogOpen={deleteDialogOpen}
        isDeletingWorkItem={isDeletingWorkItem}
        deleteError={deleteError}
        onCancelDelete={onCancelDelete}
        onConfirmDelete={onConfirmDelete}
      />
    )
  }

  return (
    <CreateWorkItemPanel
      projectName={projectName}
      readOnly={readOnly}
      workItemConfiguration={workItemConfiguration}
      assignees={assignees}
      parentItems={parentItems}
      onClose={onClose}
      onCreate={onCreate}
    />
  )
}

/* ── Create mode (unchanged behavior) ─────────────────────────────── */

function CreateWorkItemPanel({
  projectName,
  readOnly,
  workItemConfiguration,
  assignees,
  parentItems,
  onClose,
  onCreate,
}: {
  projectName: string
  readOnly: boolean
  workItemConfiguration: ApiProjectWorkItemConfiguration | null
  assignees: AssigneeOption[]
  parentItems: ParentOption[]
  onClose: () => void
  onCreate: (
    input: WorkItemFormInput,
  ) => Promise<void>
}) {
  const formRef =
    useRef<HTMLFormElement>(null)

  const [title, setTitle] =
    useState('')
  const [
    description,
    setDescription,
  ] = useState('')
  const [
    typeDefinitionId,
    setTypeDefinitionId,
  ] = useState<number | null>(null)
  const [
    statusDefinitionId,
    setStatusDefinitionId,
  ] = useState<number | null>(null)
  const [
    assigneeIds,
    setAssigneeIds,
  ] = useState<string[]>([])
  const [parentId, setParentId] =
    useState('')
  const [dueDate, setDueDate] =
    useState('')
  const [blocked, setBlocked] =
    useState(false)
  const [
    blockedReason,
    setBlockedReason,
  ] = useState('')

  const [
    assigneePickerOpen,
    setAssigneePickerOpen,
  ] = useState(false)
  const [
    assigneeQuery,
    setAssigneeQuery,
  ] = useState('')

  const [submitting, setSubmitting] =
    useState(false)
  const [
    submitError,
    setSubmitError,
  ] = useState<string | null>(null)

  const sortedAssignees = useMemo(
    () =>
      [...assignees].sort(
        (left, right) =>
          left.name.localeCompare(
            right.name,
          ),
      ),
    [assignees],
  )

  const selectedAssignees =
    useMemo(
      () =>
        sortedAssignees.filter(
          (assignee) =>
            assigneeIds.includes(
              assignee.id,
            ),
        ),
      [
        assigneeIds,
        sortedAssignees,
      ],
    )

  const filteredAssignees =
    useMemo(() => {
      const normalizedQuery =
        assigneeQuery
          .trim()
          .toLowerCase()

      if (!normalizedQuery) {
        return sortedAssignees
      }

      return sortedAssignees.filter(
        (assignee) =>
          assignee.name
            .toLowerCase()
            .includes(
              normalizedQuery,
            ),
      )
    }, [
      assigneeQuery,
      sortedAssignees,
    ])

  const activeTypeDefinitions =
    useMemo(
      () =>
        (workItemConfiguration?.types ?? [])
          .filter((definition) => definition.active)
          .sort(
            (left, right) =>
              left.order - right.order,
          ),
      [workItemConfiguration],
    )

  const activeStatusDefinitions =
    useMemo(
      () =>
        (workItemConfiguration?.statuses ?? [])
          .filter((definition) => definition.active)
          .sort(
            (left, right) =>
              left.order - right.order,
          ),
      [workItemConfiguration],
    )

  const availableParentItems =
    useMemo(
      () =>
        [...parentItems].sort(
          (left, right) =>
            left.title.localeCompare(
              right.title,
            ),
        ),
      [parentItems],
    )

  // Seed type/status once the Project's Work Item configuration arrives:
  // the default type (the configured 'Task' type when present, otherwise
  // the first configured type), and the Project's default status.
  useEffect(() => {
    if (typeDefinitionId == null) {
      const defaultType =
        activeTypeDefinitions.find(
          (definition) =>
            definition.name.trim().toLowerCase() === 'task',
        ) ?? activeTypeDefinitions[0]
      if (defaultType) {
        setTypeDefinitionId(defaultType.id)
      }
    }
    if (statusDefinitionId == null) {
      const defaultStatus =
        activeStatusDefinitions.find(
          (definition) => definition.isDefault,
        ) ?? activeStatusDefinitions[0]
      if (defaultStatus) {
        setStatusDefinitionId(defaultStatus.id)
      }
    }
  }, [
    activeTypeDefinitions,
    activeStatusDefinitions,
    typeDefinitionId,
    statusDefinitionId,
  ])

  useEffect(() => {
    setAssigneePickerOpen(false)
    setAssigneeQuery('')
    setSubmitting(false)
    setSubmitError(null)
  }, [])

  useEffect(() => {
    const handleKeyDown = (
      event: KeyboardEvent,
    ) => {
      if (
        event.key === 'Escape' &&
        !submitting
      ) {
        if (assigneePickerOpen) {
          setAssigneePickerOpen(
            false,
          )
          setAssigneeQuery('')
          return
        }

        onClose()
        return
      }

      if (
        event.key === 'Enter' &&
        (event.metaKey ||
          event.ctrlKey) &&
        !submitting
      ) {
        event.preventDefault()
        formRef.current
          ?.requestSubmit()
      }
    }

    document.addEventListener(
      'keydown',
      handleKeyDown,
    )

    return () => {
      document.removeEventListener(
        'keydown',
        handleKeyDown,
      )
    }
  }, [
    assigneePickerOpen,
    onClose,
    submitting,
  ])

  const toggleAssignee = (
    assigneeId: string,
  ) => {
    setAssigneeIds((current) =>
      current.includes(assigneeId)
        ? current.filter(
            (id) =>
              id !== assigneeId,
          )
        : [
            ...current,
            assigneeId,
          ],
    )
  }

  const removeAssignee = (
    assigneeId: string,
  ) => {
    setAssigneeIds((current) =>
      current.filter(
        (id) =>
          id !== assigneeId,
      ),
    )
  }

  const normalizedBlockedReason =
    blocked
      ? blockedReason.trim()
      : ''

  const canSubmit =
    !readOnly &&
    !submitting &&
    title.trim().length > 0 &&
    typeDefinitionId != null &&
    (
      !blocked ||
      normalizedBlockedReason
        .length > 0
    )

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault()

    if (!canSubmit) {
      return
    }

    const input: WorkItemFormInput = {
      title: title.trim(),
      description:
        description.trim(),
      typeDefinitionId:
        typeDefinitionId as number,
      statusDefinitionId,
      assigneeIds,
      parentId:
        parentId || null,
      dueDate:
        dueDate || null,
      blockedReason:
        blocked
          ? normalizedBlockedReason
          : null,
    }

    setSubmitting(true)
    setSubmitError(null)

    try {
      await onCreate(input)
      onClose()
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : 'Work item could not be created.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/30"
      onMouseDown={(event) => {
        if (
          event.target ===
            event.currentTarget &&
          !submitting
        ) {
          onClose()
        }
      }}
    >
      <div
        role="dialog"
        aria-modal={true}
        aria-labelledby="work-item-drawer-title"
        className="ml-auto flex h-full w-full max-w-[660px] flex-col border-l border-outline-variant bg-surface-container-lowest shadow-2xl"
      >
        <form
          ref={formRef}
          onSubmit={handleSubmit}
          className="flex min-h-0 flex-1 flex-col"
        >
          <header className="flex shrink-0 items-start justify-between gap-6 border-b border-outline-variant px-7 py-5">
            <div className="min-w-0">
              <h2
                id="work-item-drawer-title"
                className="text-lg font-semibold tracking-tight text-on-surface"
              >
                New work item
              </h2>

              <div className="mt-1 flex items-center gap-1.5 text-sm text-on-surface-variant">
                <span
                  aria-hidden="true"
                  className="material-symbols-outlined text-[16px]"
                >
                  folder
                </span>

                <span className="truncate">
                  {projectName}
                </span>
              </div>
            </div>

            <button
              type="button"
              disabled={submitting}
              onClick={onClose}
              aria-label="Close work item"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface disabled:cursor-wait disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-[20px]">
                close
              </span>
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-7 py-7">
            {readOnly && (
              <div className="mb-6 rounded-lg bg-surface-container-low px-4 py-3 text-sm text-on-surface-variant">
                This work item is read-only.
              </div>
            )}

            <div className="space-y-7">
              <div className="space-y-5">
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-on-surface">
                    Title
                  </span>

                  <input
                    autoFocus
                    required
                    value={title}
                    disabled={readOnly}
                    onChange={(event) =>
                      setTitle(
                        event.target.value,
                      )
                    }
                    placeholder="What needs to be done?"
                    className="h-11 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3.5 text-sm text-on-surface outline-none transition placeholder:text-on-surface-variant/55 focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:cursor-default disabled:bg-surface-container-low disabled:text-on-surface-variant"
                  />
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-on-surface">
                    Description
                    <span className="ml-1.5 font-normal text-on-surface-variant">
                      · Optional
                    </span>
                  </span>

                  <textarea
                    value={description}
                    disabled={readOnly}
                    rows={5}
                    onChange={(event) =>
                      setDescription(
                        event.target.value,
                      )
                    }
                    placeholder="Add context, expected outcome, or relevant notes…"
                    className="min-h-[128px] w-full resize-y rounded-lg border border-outline-variant bg-surface-container-lowest px-3.5 py-3 text-sm leading-6 text-on-surface outline-none transition placeholder:text-on-surface-variant/55 focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:cursor-default disabled:bg-surface-container-low disabled:text-on-surface-variant"
                  />
                </label>
              </div>

              <fieldset>
                <legend className="mb-2 text-sm font-medium text-on-surface">
                  Type
                </legend>

                {activeTypeDefinitions.length > 0 ? (
                  <div
                    className="grid gap-0 overflow-hidden rounded-lg border border-outline-variant"
                    style={{
                      gridTemplateColumns:
                        `repeat(${
                          Math.min(
                            activeTypeDefinitions.length,
                            4,
                          )
                        }, minmax(0, 1fr))`,
                    }}
                  >
                    {activeTypeDefinitions.map(
                      (definition, index) => {
                        const selected =
                          typeDefinitionId ===
                          definition.id

                        return (
                          <label
                            key={definition.id}
                            className={[
                              'relative flex min-w-0 cursor-pointer items-center justify-center gap-1.5 px-2 py-2.5 text-xs font-medium transition',
                              index > 0
                                ? 'border-l border-outline-variant'
                                : '',
                              selected
                                ? 'bg-secondary-container text-on-surface'
                                : 'bg-surface-container-lowest text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface',
                              readOnly
                                ? 'cursor-default'
                                : '',
                            ].join(' ')}
                          >
                            <input
                              type="radio"
                              name="work-item-type"
                              value={definition.id}
                              checked={selected}
                              disabled={
                                readOnly
                              }
                              onChange={() =>
                                setTypeDefinitionId(
                                  definition.id,
                                )
                              }
                              className="absolute inset-0 cursor-pointer appearance-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary disabled:cursor-default"
                            />

                            <span
                              aria-hidden="true"
                              className="pointer-events-none material-symbols-outlined text-[16px]"
                            >
                              {typeIconForName(
                                definition.name,
                              )}
                            </span>

                            <span className="pointer-events-none truncate">
                              {definition.name}
                            </span>
                          </label>
                        )
                      },
                    )}
                  </div>
                ) : (
                  <p className="rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2.5 text-xs text-on-surface-variant">
                    {readOnly
                      ? 'No type definitions.'
                      : 'No Work Item types are configured for this Project.'}
                  </p>
                )}
              </fieldset>

              <div className="grid grid-cols-2 gap-4">
                <label>
                  <span className="mb-1.5 block text-sm font-medium text-on-surface">
                    Status
                  </span>

                  <select
                    value={
                      statusDefinitionId == null
                        ? ''
                        : statusDefinitionId
                    }
                    disabled={
                      readOnly ||
                      activeStatusDefinitions.length === 0
                    }
                    onChange={(event) =>
                      setStatusDefinitionId(
                        Number(event.target.value),
                      )
                    }
                    className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:cursor-default disabled:bg-surface-container-low disabled:text-on-surface-variant"
                  >
                    {activeStatusDefinitions.map(
                      (definition) => (
                        <option
                          key={definition.id}
                          value={definition.id}
                        >
                          {definition.name}
                        </option>
                      ),
                    )}
                  </select>
                </label>

                <label>
                  <span className="mb-1.5 block text-sm font-medium text-on-surface">
                    Due date
                  </span>

                  <input
                    type="date"
                    value={dueDate}
                    disabled={readOnly}
                    onChange={(event) =>
                      setDueDate(
                        event.target.value,
                      )
                    }
                    className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:cursor-default disabled:bg-surface-container-low disabled:text-on-surface-variant"
                  />
                </label>
              </div>

              <fieldset>
                <legend className="mb-1.5 text-sm font-medium text-on-surface">
                  Assignees
                </legend>

                {selectedAssignees.length >
                0 ? (
                  <div className="mb-2 flex flex-wrap gap-2">
                    {selectedAssignees.map(
                      (assignee) => (
                        <span
                          key={
                            assignee.id
                          }
                          className="inline-flex h-8 items-center gap-2 rounded-full bg-surface-container-high px-2.5 text-xs font-medium text-on-surface"
                        >
                          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-container-lowest text-[8px] font-semibold">
                            {
                              assignee.initials
                            }
                          </span>

                          {
                            assignee.name
                          }

                          {!readOnly && (
                            <button
                              type="button"
                              onClick={() =>
                                removeAssignee(
                                  assignee.id,
                                )
                              }
                              aria-label={`Remove ${assignee.name}`}
                              className="material-symbols-outlined text-[14px] text-on-surface-variant hover:text-on-surface"
                            >
                              close
                            </button>
                          )}
                        </span>
                      ),
                    )}
                  </div>
                ) : readOnly ? (
                  <p className="text-sm text-on-surface-variant">
                    Unassigned
                  </p>
                ) : null}

                {!readOnly && (
                  <div className="relative">
                    <button
                      type="button"
                      aria-expanded={
                        assigneePickerOpen
                      }
                      onClick={() =>
                        setAssigneePickerOpen(
                          (current) =>
                            !current,
                        )
                      }
                      className="flex h-10 w-full items-center justify-between rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface-variant transition hover:border-primary/40 hover:text-on-surface"
                    >
                      <span>
                        Add assignee…
                      </span>

                      <span
                        aria-hidden="true"
                        className="material-symbols-outlined text-[18px]"
                      >
                        {
                          assigneePickerOpen
                            ? 'expand_less'
                            : 'expand_more'
                        }
                      </span>
                    </button>

                    {assigneePickerOpen && (
                      <div className="mt-2 overflow-hidden rounded-lg border border-outline-variant bg-surface-container-lowest shadow-sm">
                        <div className="border-b border-outline-variant p-2">
                          <label className="relative block">
                            <span className="sr-only">
                              Search assignees
                            </span>

                            <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-[17px] text-on-surface-variant">
                              search
                            </span>

                            <input
                              autoFocus
                              type="search"
                              value={
                                assigneeQuery
                              }
                              onChange={(
                                event,
                              ) =>
                                setAssigneeQuery(
                                  event
                                    .target
                                    .value,
                                )
                              }
                              placeholder="Search members…"
                              className="h-9 w-full rounded-md border border-outline-variant bg-surface-container-lowest pl-9 pr-3 text-sm text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
                            />
                          </label>
                        </div>

                        <div className="max-h-52 overflow-y-auto">
                          {filteredAssignees.length >
                          0 ? (
                            filteredAssignees.map(
                              (
                                assignee,
                              ) => {
                                const selected =
                                  assigneeIds.includes(
                                    assignee.id,
                                  )

                                return (
                                  <label
                                    key={
                                      assignee.id
                                    }
                                    className="flex cursor-pointer items-center gap-3 px-3 py-2.5 transition hover:bg-surface-container-low"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={
                                        selected
                                      }
                                      onChange={() =>
                                        toggleAssignee(
                                          assignee.id,
                                        )
                                      }
                                      className="h-4 w-4 rounded border-outline accent-primary"
                                    />

                                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-[9px] font-semibold text-on-surface">
                                      {
                                        assignee.initials
                                      }
                                    </span>

                                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-on-surface">
                                      {
                                        assignee.name
                                      }
                                    </span>
                                  </label>
                                )
                              },
                            )
                          ) : (
                            <div className="px-3 py-4 text-sm text-on-surface-variant">
                              No matching members.
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </fieldset>

              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-on-surface">
                  Parent
                </span>

                <select
                  value={parentId}
                  disabled={readOnly}
                  onChange={(event) =>
                    setParentId(
                      event.target.value,
                    )
                  }
                  className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:cursor-default disabled:bg-surface-container-low disabled:text-on-surface-variant"
                >
                  <option value="">
                    No parent
                  </option>

                  {availableParentItems.map(
                    (candidate) => (
                      <option
                        key={
                          candidate.id
                        }
                        value={
                          candidate.id
                        }
                      >
                        {candidate.title}
                      </option>
                    ),
                  )}
                </select>
              </label>

              <div>
                <label className="inline-flex cursor-pointer items-center gap-2.5 text-sm font-medium text-on-surface">
                  <input
                    type="checkbox"
                    checked={blocked}
                    disabled={readOnly}
                    onChange={(event) =>
                      setBlocked(
                        event.target.checked,
                      )
                    }
                    className="h-4 w-4 rounded border-outline accent-primary"
                  />

                  Blocked
                </label>

                {blocked && (
                  <label className="mt-4 block">
                    <span className="mb-1.5 block text-sm font-medium text-on-surface">
                      Blocked reason
                    </span>

                    <textarea
                      required
                      value={
                        blockedReason
                      }
                      disabled={
                        readOnly
                      }
                      rows={3}
                      onChange={(event) =>
                        setBlockedReason(
                          event.target.value,
                        )
                      }
                      placeholder="What is preventing progress?"
                      className="w-full resize-y rounded-lg border border-outline-variant bg-surface-container-lowest px-3.5 py-2.5 text-sm leading-6 text-on-surface outline-none transition placeholder:text-on-surface-variant/55 focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:cursor-default disabled:bg-surface-container-low disabled:text-on-surface-variant"
                    />
                  </label>
                )}
              </div>
            </div>
          </div>

          {submitError && (
            <div
              role="alert"
              className="shrink-0 border-t border-error/20 bg-error-container/35 px-7 py-3 text-sm text-error"
            >
              {submitError}
            </div>
          )}

          <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-outline-variant bg-surface-container-low/45 px-7 py-4">
            <span className="hidden text-xs text-on-surface-variant sm:block">
              {readOnly
                ? ''
                : 'Ctrl/⌘ + Enter to save'}
            </span>

            <div className="ml-auto flex items-center gap-3">
              {readOnly ? (
                <button
                  type="button"
                  onClick={onClose}
                  className="h-9 rounded-lg px-4 text-sm font-medium text-on-surface transition hover:bg-surface-container-high"
                >
                  Close
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={
                      submitting
                    }
                    onClick={onClose}
                    className="h-9 rounded-lg px-4 text-sm font-medium text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface disabled:cursor-wait disabled:opacity-50"
                  >
                    Cancel
                  </button>

                  <button
                    type="submit"
                    disabled={
                      !canSubmit
                    }
                    className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {submitting
                      ? 'Creating…'
                      : 'Create work item'}
                  </button>
                </>
              )}
            </div>
          </footer>
        </form>
      </div>
    </div>
  )
}

/* ── Edit mode: read-first inspector with partial autosave ────────── */

type SaveStatus =
  | 'idle'
  | 'saving'
  | 'saved'
  | 'error'

function PropertyRow({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="flex items-start gap-4 py-2">
      <span className="w-24 shrink-0 pt-1.5 text-sm text-on-surface-variant">
        {label}
      </span>

      <div className="min-w-0 flex-1">
        {children}
      </div>
    </div>
  )
}

const compactControlClassName =
  'h-9 w-full rounded-lg border border-transparent bg-transparent px-2 text-sm font-medium text-on-surface outline-none transition hover:border-outline-variant hover:bg-surface-container-low focus:border-primary focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary/15 disabled:cursor-default disabled:hover:border-transparent disabled:hover:bg-transparent'

function WorkItemInspector({
  projectName,
  item,
  readOnly,
  currentUserId,
  workItemConfiguration,
  assignees,
  parentItems,
  onClose,
  onPatch,
  onDelete,
  onRequestDelete,
  deleteDialogOpen,
  isDeletingWorkItem,
  deleteError,
  onCancelDelete,
  onConfirmDelete,
}: {
  projectName: string
  item: ApiWorkItem
  readOnly: boolean
  currentUserId: number | null
  workItemConfiguration: ApiProjectWorkItemConfiguration | null
  assignees: AssigneeOption[]
  parentItems: ParentOption[]
  onClose: () => void
  onPatch: (
    workItemId: number,
    patch: ApiUpdateWorkItemInput,
  ) => Promise<void>
  onDelete?: (workItemId: number) => Promise<void>
  onRequestDelete?: (workItemId: number) => void
  deleteDialogOpen?: boolean
  isDeletingWorkItem?: boolean
  deleteError?: string | null
  onCancelDelete?: () => void
  onConfirmDelete?: () => void
}) {
  const [saveStatus, setSaveStatus] =
    useState<SaveStatus>('idle')
  const [saveError, setSaveError] =
    useState<string | null>(null)
  const savedTimeoutRef = useRef<
    ReturnType<typeof setTimeout> | null
  >(null)

  // Deletion is a destructive, object-level action exposed from the
  // drawer header. When the parent wires the shared page-level flow
  // (onRequestDelete), the page renders the single confirmation dialog;
  // otherwise the drawer keeps a self-contained fallback so it still
  // works standalone (e.g. tests). Either way there is at most ONE
  // dialog shown at a time.
  const [
    localDeleteDialogOpen,
    setLocalDeleteDialogOpen,
  ] = useState(false)
  const [
    localDeletingWorkItem,
    setLocalDeletingWorkItem,
  ] = useState(false)
  const [
    localDeleteWorkItemError,
    setLocalDeleteWorkItemError,
  ] = useState<string | null>(null)

  // Serializes every partial PATCH for this Work Item so requests are
  // sent (and settled) strictly in the order they were invoked. This is
  // what prevents overlapping PATCHes: the next one is not sent until
  // the previous has fully resolved, so out-of-order responses can
  // never clobber apiWorkItems with a stale snapshot, and the shared
  // save indicator always reflects the most recently settled request.
  const patchQueueRef = useRef<
    Promise<void>
  >(Promise.resolve())
  const queuedPatchCountRef = useRef(0)

  const inspectorStatusDefinitions =
    useMemo(
      () =>
        (workItemConfiguration?.statuses ?? [])
          .filter((definition) => definition.active)
          .sort(
            (left, right) =>
              left.order - right.order,
          ),
      [workItemConfiguration],
    )

  // The controlled <select> must render the option that matches the Work
  // Item's *actual* status — the same value the Board column and the
  // persisted API agree on. Derive it from the canonical definition ID
  // (with the resolved category as a fallback) rather than from the
  // legacy fixed-string `item.status`, which the API no longer populates.
  const statusSelectValue = useMemo(
    () =>
      resolveWorkItemStatusSelectValue(
        item,
        item.status ?? 'todo',
        workItemConfiguration,
      ),
    [
      item,
      workItemConfiguration,
    ],
  )

  const [titleEditing, setTitleEditing] =
    useState(false)
  const [titleDraft, setTitleDraft] =
    useState('')
  const titleCancelledRef = useRef(false)

  const [
    descriptionEditing,
    setDescriptionEditing,
  ] = useState(false)

  const [
    blockedReasonEditing,
    setBlockedReasonEditing,
  ] = useState(false)

  // No local draft state, mirroring Description — the editable
  // RichMarkdownEditor below always starts from `item.blockedReason ??
  // ''` (canonical for an existing reason, empty for a fresh pending
  // block) and reports its live Markdown via onChange/onCommit, so
  // there is nothing here that can go stale or race (see
  // commitBlockedReasonEdit). Escape-suppresses-the-following-blur is
  // likewise handled internally by RichMarkdownEditor itself, so no
  // local "was this cancelled" ref is needed either.

  // A Work Item must never be canonically blocked without a non-empty
  // reason (blockedReason === null means unblocked; there is no
  // separate blocked boolean in the API). Activating the Blocked
  // switch therefore only enters this local "pending block" state —
  // it reveals the reason editor but does not PATCH — until a valid
  // reason is committed. If it's abandoned (empty reason, Escape, or
  // switching to another Work Item with nothing typed) the item stays
  // canonically unblocked and nothing is sent to the API.
  const [pendingBlock, setPendingBlock] =
    useState(false)

  const [
    assigneePickerOpen,
    setAssigneePickerOpen,
  ] = useState(false)
  const [
    assigneeQuery,
    setAssigneeQuery,
  ] = useState('')

  useEffect(() => {
    setTitleEditing(false)
    setDescriptionEditing(false)
    setBlockedReasonEditing(false)
    setPendingBlock(false)
    setAssigneePickerOpen(false)
    setAssigneeQuery('')
    setSaveStatus('idle')
    setSaveError(null)
    setLocalDeleteDialogOpen(false)
    setLocalDeletingWorkItem(false)
    setLocalDeleteWorkItemError(null)
  }, [item.id])

  useEffect(
    () => () => {
      if (savedTimeoutRef.current) {
        clearTimeout(
          savedTimeoutRef.current,
        )
      }
    },
    [],
  )

  // ── History ──────────────────────────────────────────────────
  //
  // Read-only, fetched independently from apiWorkItems — history is
  // not part of the canonical Work Item shape, so it never becomes a
  // second canonical Work Item state.
  const [historyStatus, setHistoryStatus] = useState<
    'loading' | 'ready' | 'error'
  >('loading')
  const [historyEvents, setHistoryEvents] = useState<
    ApiWorkItemHistoryEvent[]
  >([])
  const [historyError, setHistoryError] = useState<
    string | null
  >(null)

  // Always holds the CURRENTLY displayed Work Item id, updated
  // synchronously every render (not via an effect) so async callbacks
  // (patch settlement) can tell whether the item they were queued for
  // is still the one on screen.
  const currentItemIdRef = useRef(item.id)
  currentItemIdRef.current = item.id

  // Monotonically increasing token: only the response matching the
  // most recently issued request is ever applied. This is what makes
  // switching Work Items race-safe — a late response for a Work Item
  // that is no longer selected is simply discarded, never rendered.
  const historyRequestIdRef = useRef(0)

  function fetchHistory(workItemId: number) {
    const requestId = ++historyRequestIdRef.current

    // Clear immediately so a stale item's events are never shown
    // while the new item's history is in flight.
    setHistoryStatus('loading')
    setHistoryEvents([])
    setHistoryError(null)

    listWorkItemHistory(workItemId)
      .then((events) => {
        if (historyRequestIdRef.current !== requestId) {
          return
        }

        setHistoryEvents(events)
        setHistoryStatus('ready')
      })
      .catch((error) => {
        if (historyRequestIdRef.current !== requestId) {
          return
        }

        setHistoryEvents([])
        setHistoryStatus('error')
        setHistoryError(
          getWorkItemHistoryErrorMessage(error),
        )
      })
  }

  useEffect(() => {
    // Re-fetch whenever the selected Work Item changes — history is
    // fetched for the selected Work Item only, never the whole Project.
    fetchHistory(item.id)
  }, [item.id])

  // ── Comments ─────────────────────────────────────────────────
  //
  // Human discussion. Fetched independently, exactly like History
  // above, and merged with it presentation-side only into the
  // Activity feed below — comments never become a second canonical
  // Work Item state, and are never turned into fake History events.
  const [comments, setComments] = useState<
    ApiWorkItemComment[]
  >([])
  const [commentsStatus, setCommentsStatus] = useState<
    'loading' | 'ready' | 'error'
  >('loading')
  const [commentsError, setCommentsError] = useState<
    string | null
  >(null)

  const commentsRequestIdRef = useRef(0)

  function fetchComments(workItemId: number) {
    const requestId = ++commentsRequestIdRef.current

    setCommentsStatus('loading')
    setComments([])
    setCommentsError(null)

    listWorkItemComments(workItemId)
      .then((list) => {
        if (commentsRequestIdRef.current !== requestId) {
          return
        }

        setComments(list)
        setCommentsStatus('ready')
      })
      .catch((error) => {
        if (commentsRequestIdRef.current !== requestId) {
          return
        }

        setComments([])
        setCommentsStatus('error')
        setCommentsError(
          getWorkItemCommentsErrorMessage(error),
        )
      })
  }

  useEffect(() => {
    // Re-fetch whenever the selected Work Item changes — same
    // race-safety contract as History's fetch above.
    fetchComments(item.id)
  }, [item.id])

  // Per-Work-Item comment drafts, keyed by Work Item id. A ref (not
  // state) so it survives Work Item switching without becoming a
  // second canonical Work Item state — `commentDraft` below is a
  // reactive mirror of only the CURRENTLY selected item's entry, so
  // the composer stays a normal controlled textarea.
  const commentDraftsRef = useRef<
    Record<number, string>
  >({})

  const [commentDraft, setCommentDraft] = useState('')
  const [
    commentComposerExpanded,
    setCommentComposerExpanded,
  ] = useState(false)
  const [commentSubmitStatus, setCommentSubmitStatus] =
    useState<'idle' | 'submitting'>('idle')
  const [commentSubmitError, setCommentSubmitError] =
    useState<string | null>(null)

  const [editingCommentId, setEditingCommentId] =
    useState<number | null>(null)
  const [editingCommentBody, setEditingCommentBody] =
    useState('')
  const [commentEditStatus, setCommentEditStatus] =
    useState<'idle' | 'saving'>('idle')
  const [commentEditError, setCommentEditError] =
    useState<string | null>(null)

  const [
    confirmingDeleteCommentId,
    setConfirmingDeleteCommentId,
  ] = useState<number | null>(null)
  const [
    commentDeleteStatus,
    setCommentDeleteStatus,
  ] = useState<'idle' | 'deleting'>('idle')
  const [commentDeleteError, setCommentDeleteError] =
    useState<string | null>(null)

  const [
    commentActionsMenuOpenId,
    setCommentActionsMenuOpenId,
  ] = useState<number | null>(null)

  useEffect(() => {
    // Restore this Work Item's draft (if any) and reset every other
    // piece of comment UI state — mirrors the property-editor reset
    // effect above.
    const draft = commentDraftsRef.current[item.id] ?? ''
    setCommentDraft(draft)
    setCommentComposerExpanded(Boolean(draft.trim()))
    setCommentSubmitStatus('idle')
    setCommentSubmitError(null)
    setEditingCommentId(null)
    setEditingCommentBody('')
    setCommentEditStatus('idle')
    setCommentEditError(null)
    setConfirmingDeleteCommentId(null)
    setCommentDeleteStatus('idle')
    setCommentDeleteError(null)
    setCommentActionsMenuOpenId(null)
  }, [item.id])

  function handleCommentDraftChange(value: string) {
    commentDraftsRef.current[item.id] = value
    setCommentDraft(value)
  }

  function collapseCommentComposer() {
    // Esc collapses the editor but explicitly KEEPS the draft.
    setCommentComposerExpanded(false)
  }

  function cancelCommentComposer() {
    // Cancel is a deliberate "never mind" — unlike Esc, it discards
    // the draft.
    delete commentDraftsRef.current[item.id]
    setCommentDraft('')
    setCommentComposerExpanded(false)
    setCommentSubmitError(null)
  }

  async function submitComment() {
    const workItemId = item.id
    const body = commentDraft.trim()

    // Markdown that trims to something non-empty can still serialize to
    // visually blank content (e.g. an empty bullet item) — see
    // isMarkdownContentEmpty.
    if (
      isMarkdownContentEmpty(body, 'compact') ||
      commentSubmitStatus === 'submitting'
    ) {
      return
    }

    setCommentSubmitStatus('submitting')
    setCommentSubmitError(null)

    try {
      const created = await createWorkItemComment(
        workItemId,
        { body },
      )

      // Sent successfully — clear this Work Item's draft
      // regardless of whether the inspector has since switched
      // away from it, so it never reappears unsent.
      delete commentDraftsRef.current[workItemId]

      if (currentItemIdRef.current === workItemId) {
        setComments((current) => [
          created,
          ...current,
        ])
        setCommentDraft('')
        setCommentComposerExpanded(false)
        setCommentSubmitStatus('idle')
      }
    } catch (error) {
      if (currentItemIdRef.current === workItemId) {
        setCommentSubmitStatus('idle')
        setCommentSubmitError(
          getWorkItemCommentActionErrorMessage(
            error,
            'Comment could not be posted.',
          ),
        )
      }
    }
  }

  function startEditingComment(
    comment: ApiWorkItemComment,
  ) {
    setCommentActionsMenuOpenId(null)
    setConfirmingDeleteCommentId(null)
    setEditingCommentId(comment.id)
    setEditingCommentBody(comment.body)
    setCommentEditError(null)
  }

  function cancelEditingComment() {
    // Esc/Cancel drops the in-progress edit without touching the
    // original comment.
    setEditingCommentId(null)
    setEditingCommentBody('')
    setCommentEditError(null)
  }

  async function saveEditingComment() {
    if (editingCommentId === null) {
      return
    }

    const body = editingCommentBody.trim()
    if (
      isMarkdownContentEmpty(body, 'compact') ||
      commentEditStatus === 'saving'
    ) {
      return
    }

    const commentId = editingCommentId

    setCommentEditStatus('saving')
    setCommentEditError(null)

    try {
      const updated = await updateWorkItemComment(
        commentId,
        { body },
      )

      setComments((current) =>
        current.map((existing) =>
          existing.id === commentId
            ? updated
            : existing,
        ),
      )
      setEditingCommentId(null)
      setEditingCommentBody('')
      setCommentEditStatus('idle')
    } catch (error) {
      setCommentEditStatus('idle')
      setCommentEditError(
        getWorkItemCommentActionErrorMessage(
          error,
          'Comment could not be saved.',
        ),
      )
    }
  }

  function requestDeleteComment(commentId: number) {
    setCommentActionsMenuOpenId(null)
    setEditingCommentId(null)
    setConfirmingDeleteCommentId(commentId)
    setCommentDeleteError(null)
  }

  function cancelDeleteComment() {
    setConfirmingDeleteCommentId(null)
    setCommentDeleteError(null)
  }

  async function confirmDeleteComment() {
    if (
      confirmingDeleteCommentId === null ||
      commentDeleteStatus === 'deleting'
    ) {
      return
    }

    const commentId = confirmingDeleteCommentId

    setCommentDeleteStatus('deleting')
    setCommentDeleteError(null)

    try {
      await deleteWorkItemComment(commentId)

      setComments((current) =>
        current.filter(
          (existing) => existing.id !== commentId,
        ),
      )
      setConfirmingDeleteCommentId(null)
      setCommentDeleteStatus('idle')
    } catch (error) {
      setCommentDeleteStatus('idle')
      setCommentDeleteError(
        getWorkItemCommentActionErrorMessage(
          error,
          'Comment could not be deleted.',
        ),
      )
    }
  }

  const activityFeed = useMemo(
    () => buildActivityFeed(comments, historyEvents),
    [comments, historyEvents],
  )

  // When the parent wires the shared page-level flow (onRequestDelete),
  // the page owns the single confirmation dialog. Otherwise the drawer
  // falls back to a self-contained dialog so it still works standalone.
  const useSharedDelete = onRequestDelete != null

  const effectiveDeleteOpen = useSharedDelete
    ? deleteDialogOpen === true
    : localDeleteDialogOpen
  const effectiveDeleting = useSharedDelete
    ? isDeletingWorkItem === true
    : localDeletingWorkItem
  const effectiveDeleteError = useSharedDelete
    ? deleteError ?? null
    : localDeleteWorkItemError

  function requestDelete() {
    if (useSharedDelete) {
      onRequestDelete(item.id)
      return
    }

    setLocalDeleteWorkItemError(null)
    setLocalDeleteDialogOpen(true)
  }

  function cancelDelete() {
    if (useSharedDelete) {
      if (effectiveDeleting) {
        return
      }
      onCancelDelete?.()
      return
    }

    if (localDeletingWorkItem) {
      return
    }

    setLocalDeleteDialogOpen(false)
  }

  async function confirmDelete() {
    if (useSharedDelete) {
      onConfirmDelete?.()
      return
    }

    if (localDeletingWorkItem || onDelete == null) {
      return
    }

    setLocalDeletingWorkItem(true)
    setLocalDeleteWorkItemError(null)

    try {
      await onDelete(item.id)

      // Success: close the dialog. The drawer closes itself because the
      // parent removes the deleted item from the collection.
      setLocalDeleteDialogOpen(false)
    } catch (error) {
      // Failure: keep the drawer and dialog open and surface the error.
      setLocalDeleteWorkItemError(
        getWorkItemCommentActionErrorMessage(
          error,
          'Work item could not be deleted.',
        ),
      )
    } finally {
      setLocalDeletingWorkItem(false)
    }
  }

  useEffect(() => {
    const handleKeyDown = (
      event: KeyboardEvent,
    ) => {
      if (event.key !== 'Escape') {
        return
      }

      if (assigneePickerOpen) {
        event.preventDefault()
        setAssigneePickerOpen(false)
        setAssigneeQuery('')
        return
      }

      if (titleEditing) {
        event.preventDefault()
        setTitleEditing(false)
        return
      }

      if (descriptionEditing) {
        event.preventDefault()
        setDescriptionEditing(false)
        return
      }

      if (blockedReasonEditing) {
        event.preventDefault()
        cancelBlockedReasonEdit()
        return
      }

      if (commentActionsMenuOpenId !== null) {
        event.preventDefault()
        setCommentActionsMenuOpenId(null)
        return
      }

      if (confirmingDeleteCommentId !== null) {
        event.preventDefault()
        cancelDeleteComment()
        return
      }

      if (editingCommentId !== null) {
        event.preventDefault()
        cancelEditingComment()
        return
      }

      if (commentComposerExpanded) {
        event.preventDefault()
        collapseCommentComposer()
        return
      }

      onClose()
    }

    document.addEventListener(
      'keydown',
      handleKeyDown,
    )

    return () => {
      document.removeEventListener(
        'keydown',
        handleKeyDown,
      )
    }
  }, [
    assigneePickerOpen,
    blockedReasonEditing,
    commentActionsMenuOpenId,
    commentComposerExpanded,
    confirmingDeleteCommentId,
    descriptionEditing,
    editingCommentId,
    onClose,
    titleEditing,
  ])

  const sortedAssignees = useMemo(
    () =>
      [...assignees].sort(
        (left, right) =>
          left.name.localeCompare(
            right.name,
          ),
      ),
    [assignees],
  )

  // For the comment composer's idle-state avatar. `assignees` is
  // already scoped to non-viewer Project members — exactly the
  // population that can comment — so the current user is present
  // whenever the composer itself is shown.
  const currentUserInitials =
    (currentUserId !== null &&
      assignees.find(
        (assignee) =>
          assignee.id === String(currentUserId),
      )?.initials) ||
    '?'

  const itemAssigneeIds = useMemo(
    () =>
      item.assigneeIds.map(String),
    [item.assigneeIds],
  )

  const selectedAssignees = useMemo(
    () =>
      sortedAssignees.filter(
        (assignee) =>
          itemAssigneeIds.includes(
            assignee.id,
          ),
      ),
    [
      itemAssigneeIds,
      sortedAssignees,
    ],
  )

  const filteredAssignees = useMemo(() => {
    const normalizedQuery = assigneeQuery
      .trim()
      .toLowerCase()

    if (!normalizedQuery) {
      return sortedAssignees
    }

    return sortedAssignees.filter(
      (assignee) =>
        assignee.name
          .toLowerCase()
          .includes(normalizedQuery),
    )
  }, [
    assigneeQuery,
    sortedAssignees,
  ])

  const availableParentItems = useMemo(
    () =>
      [...parentItems]
        .filter(
          (candidate) =>
            candidate.id !==
            String(item.id),
        )
        .sort((left, right) =>
          left.title.localeCompare(
            right.title,
          ),
        ),
    [item.id, parentItems],
  )

  const selectedTypeOption =
    typeOptions.find(
      (option) =>
        option.value === item.type,
    ) ?? typeOptions[3]

  const isBlocked =
    item.blockedReason !== null

  // What the Blocked switch/reason editor show: canonically blocked,
  // OR a not-yet-persisted pending block (reason editor open, item
  // still unblocked until that reason is committed).
  const displayBlocked =
    isBlocked || pendingBlock

  function patchField(
    patch: ApiUpdateWorkItemInput,
  ): Promise<boolean> {
    const workItemId = item.id

    queuedPatchCountRef.current += 1

    const runPatch =
      async (): Promise<boolean> => {
        if (savedTimeoutRef.current) {
          clearTimeout(
            savedTimeoutRef.current,
          )
          savedTimeoutRef.current = null
        }

        setSaveStatus('saving')
        setSaveError(null)

        try {
          await onPatch(
            workItemId,
            patch,
          )

          queuedPatchCountRef.current -= 1

          // Only flash "Saved" once nothing else is queued behind
          // this request — otherwise the next queued patch is about
          // to flip the indicator back to "Saving…" anyway. Refresh
          // History on the same condition: once per drained batch of
          // serialized patches, not once per individual PATCH.
          if (
            queuedPatchCountRef.current ===
            0
          ) {
            setSaveStatus('saved')
            savedTimeoutRef.current =
              setTimeout(() => {
                setSaveStatus('idle')
              }, 1600)

            // Only refresh if this Work Item is still the one on
            // screen — if the inspector has since switched to
            // another Work Item, that switch already fetched its
            // own History, and this settling patch must not touch it.
            if (
              currentItemIdRef.current ===
              workItemId
            ) {
              fetchHistory(workItemId)
            }
          }

          return true
        } catch (error) {
          queuedPatchCountRef.current -= 1

          setSaveStatus('error')
          setSaveError(
            error instanceof Error
              ? error.message
              : 'Work item could not be saved.',
          )

          return false
        }
      }

    // Chain this patch onto the queue for this Work Item so it is
    // sent only after every previously invoked patch has settled —
    // requests (and their responses) can then never overlap or
    // arrive out of order. The queue tail always resolves (never
    // rejects), so a failed request cannot wedge later ones.
    const result = patchQueueRef.current.then(
      runPatch,
    )

    patchQueueRef.current = result.then(
      () => undefined,
      () => undefined,
    )

    return result
  }

  function startTitleEdit() {
    if (readOnly) {
      return
    }

    setTitleDraft(item.title)
    setTitleEditing(true)
  }

  async function commitTitleEdit() {
    const trimmed = titleDraft.trim()

    if (!trimmed || trimmed === item.title) {
      setTitleEditing(false)
      return
    }

    const success = await patchField({
      title: trimmed,
    })

    if (success) {
      setTitleEditing(false)
    }
  }

  function startDescriptionEdit() {
    if (readOnly) {
      return
    }

    setDescriptionEditing(true)
  }

  // Takes the committed Markdown directly from RichMarkdownEditor's
  // onCommit (fired on blur) rather than reading it back out of React
  // state — the editor owns its own live document between renders, so
  // there is no local descriptionDraft state to go stale or race.
  async function commitDescriptionEdit(markdown: string) {
    const trimmed = markdown.trim()

    if (trimmed === item.description.trim()) {
      setDescriptionEditing(false)
      return
    }

    const success = await patchField({
      description: trimmed,
    })

    if (success) {
      setDescriptionEditing(false)
    }
  }

  function startBlockedReasonEdit() {
    if (readOnly) {
      return
    }

    setBlockedReasonEditing(true)
  }

  // Esc during a pending new block AND Esc while editing an already-
  // blocked item's reason both resolve to the same thing: leave edit
  // mode, drop any not-yet-committed pending block. For an existing
  // blocked item `pendingBlock` is already false, so this just exits
  // to the read view, which always shows `item.blockedReason` — the
  // canonical, still-blocked value — never the abandoned draft.
  function cancelBlockedReasonEdit() {
    setBlockedReasonEditing(false)
    setPendingBlock(false)
  }

  // Takes the committed Markdown directly from RichMarkdownEditor's
  // onCommit (fired on blur), the same pattern commitDescriptionEdit
  // uses — the editor owns its own live document between renders, so
  // there is no local draft state to go stale or race.
  async function commitBlockedReasonEdit(markdown: string) {
    const trimmed = markdown.trim()
    const current = item.blockedReason ?? ''

    // Use the same "has meaningful content" check Comments use —
    // `.trim()` alone would let visually-empty Markdown (e.g. an empty
    // bullet item) through. Never PATCH, never mark the item as
    // blocked — revert (or stay at) Blocked: No. This also covers
    // clearing an existing reason to empty, which reverts to the
    // last-saved reason rather than creating blockedReason: "".
    if (isMarkdownContentEmpty(trimmed, 'compact')) {
      setBlockedReasonEditing(false)
      setPendingBlock(false)
      return
    }

    if (trimmed === current) {
      setBlockedReasonEditing(false)
      return
    }

    const success = await patchField({
      blockedReason: trimmed,
    })

    // Only a successful PATCH makes the item canonically blocked —
    // on failure, keep the editing state so the save error is visible
    // and the user can retry (see patchField's own saveStatus/
    // saveError handling); the canonical reason (still unset or still
    // the old value) remains what read mode would show.
    if (success) {
      setBlockedReasonEditing(false)
      setPendingBlock(false)
    }
  }

  function handleBlockedToggle(
    nextBlocked: boolean,
  ) {
    if (readOnly) {
      return
    }

    if (nextBlocked) {
      setBlockedReasonEditing(true)
      setPendingBlock(true)
      return
    }

    // Turning off a not-yet-persisted pending block just cancels it
    // locally — there is nothing blocked to PATCH away yet.
    if (pendingBlock) {
      cancelBlockedReasonEdit()
      return
    }

    setBlockedReasonEditing(false)
    void patchField({
      blockedReason: null,
    })
  }

  function handleAssigneeToggle(
    assigneeId: string,
  ) {
    if (readOnly) {
      return
    }

    const nextIds = itemAssigneeIds.includes(
      assigneeId,
    )
      ? itemAssigneeIds.filter(
          (id) => id !== assigneeId,
        )
      : [...itemAssigneeIds, assigneeId]

    void patchField({
      assigneeIds: nextIds.map(Number),
    })
  }

  function handleTypeChange(
    nextType: ApiWorkItemType,
  ) {
    if (nextType === item.type) {
      return
    }

    void patchField({ type: nextType })
  }

  function handleStatusChange(
    nextStatus: ApiWorkItemStatus,
  ) {
    if (nextStatus === item.status) {
      return
    }

    const statusDefinitionId =
      resolveStatusDefinitionIdByCategory(
        nextStatus,
        workItemConfiguration,
      )

    if (statusDefinitionId == null) {
      return
    }

    void patchField({
      statusDefinitionId,
    })
  }

  function handleParentChange(
    value: string,
  ) {
    const nextParentId = value
      ? Number(value)
      : null

    if (nextParentId === item.parentId) {
      return
    }

    void patchField({
      parentId: nextParentId,
    })
  }

  function handleDueDateChange(
    value: string,
  ) {
    const nextDueDate = value || null

    if (nextDueDate === item.dueDate) {
      return
    }

    void patchField({
      dueDate: nextDueDate,
    })
  }

  return (
    <div
      // Marks the entire inspector panel as an "inside the inspector"
      // interaction region for ProjectDetailPage's outside-click close
      // boundary — any click landing inside this subtree (including
      // menus/pickers that render within it) must never be treated as
      // an outside click.
      data-work-item-inspector-boundary="true"
      className="fixed inset-y-0 right-0 z-40 w-full sm:w-[520px]"
    >
      <div
        role="region"
        aria-labelledby="work-item-drawer-title"
        className="flex h-full w-full flex-col border-l border-outline-variant bg-surface-container-lowest shadow-2xl"
      >
        <header className="flex shrink-0 items-start justify-between gap-6 border-b border-outline-variant px-7 py-5">
          <div className="min-w-0">
            <h2
              id="work-item-drawer-title"
              className="text-lg font-semibold tracking-tight text-on-surface"
            >
              Work item
            </h2>

            <div className="mt-1 flex items-center gap-1.5 text-sm text-on-surface-variant">
              <span
                aria-hidden="true"
                className="material-symbols-outlined text-[16px]"
              >
                folder
              </span>

              <span className="truncate">
                {projectName}
              </span>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            {saveStatus === 'saving' && (
              <span className="text-xs font-medium text-on-surface-variant">
                Saving…
              </span>
            )}

            {saveStatus === 'saved' && (
              <span className="text-xs font-medium text-on-surface-variant">
                Saved
              </span>
            )}

            {saveStatus === 'error' && (
              <span
                role="alert"
                title={
                  saveError ?? undefined
                }
                className="max-w-[180px] truncate text-xs font-medium text-error"
              >
                {saveError ??
                  'Could not save.'}
              </span>
            )}

            {onDelete != null && (
              <WorkItemActionMenuTrigger
                label="Work item actions"
                size="lg"
                onAction={(action) => {
                  if (action === 'delete') {
                    requestDelete()
                  }
                }}
              />
            )}

            <button
              type="button"
              onClick={onClose}
              aria-label="Close work item"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface"
            >
              <span className="material-symbols-outlined text-[20px]">
                close
              </span>
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col px-7 py-7">
          {readOnly && (
            <div className="mb-6 rounded-lg bg-surface-container-low px-4 py-3 text-sm text-on-surface-variant">
              This work item is read-only.
            </div>
          )}

          <div className="min-h-0 shrink-0 space-y-7 overflow-y-auto">
            <div>
              <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
                <span
                  aria-hidden="true"
                  className="material-symbols-outlined text-[15px]"
                >
                  {
                    selectedTypeOption.icon
                  }
                </span>

                <span>
                  {
                    selectedTypeOption.label
                  }
                </span>

                <span aria-hidden="true">
                  ·
                </span>

                <span>#{item.id}</span>
              </div>

              {titleEditing ? (
                <input
                  autoFocus
                  value={titleDraft}
                  onChange={(event) =>
                    setTitleDraft(
                      event.target.value,
                    )
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      event.currentTarget.blur()
                    } else if (
                      event.key === 'Escape'
                    ) {
                      event.preventDefault()
                      titleCancelledRef.current = true
                      setTitleEditing(false)
                    }
                  }}
                  onBlur={() => {
                    if (
                      titleCancelledRef.current
                    ) {
                      titleCancelledRef.current = false
                      return
                    }

                    void commitTitleEdit()
                  }}
                  aria-label="Work item title"
                  className="-mx-3 w-full rounded-lg border border-primary bg-surface-container-lowest px-3 py-1.5 text-2xl font-semibold tracking-tight text-on-surface outline-none focus:ring-2 focus:ring-primary/15"
                />
              ) : (
                <div
                  role={
                    readOnly
                      ? undefined
                      : 'button'
                  }
                  tabIndex={
                    readOnly
                      ? undefined
                      : 0
                  }
                  onClick={startTitleEdit}
                  onKeyDown={(event) => {
                    if (
                      readOnly
                    ) {
                      return
                    }

                    if (
                      event.key === 'Enter' ||
                      event.key === ' '
                    ) {
                      event.preventDefault()
                      startTitleEdit()
                    }
                  }}
                  className={[
                    '-mx-3 rounded-lg px-3 py-1.5 text-2xl font-semibold tracking-tight text-on-surface',
                    readOnly
                      ? ''
                      : 'cursor-text transition hover:bg-surface-container-low',
                  ].join(' ')}
                >
                  {item.title}
                </div>
              )}
            </div>

            {item.meetingOrigin != null && (
              <div className="rounded-lg border border-outline-variant/70 bg-surface-container-low/50 px-4 py-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
                  <span
                    aria-hidden="true"
                    className="material-symbols-outlined text-[15px]"
                  >
                    meeting_room
                  </span>

                  <span>Created from</span>
                </div>

                <div className="mt-2 text-sm text-on-surface">
                  {
                    item.meetingOrigin
                      .meetingTitle
                  }

                  <span className="text-on-surface-variant">
                    {' · '}
                    {formatMeetingOriginDate(
                      item.meetingOrigin
                        .scheduledAt,
                    )}
                  </span>
                </div>

                <div className="mt-1 text-xs text-on-surface-variant">
                  {
                    item.meetingOrigin
                      .meetingItemTitle
                  }
                </div>

                <div className="mt-2 text-xs font-medium text-on-surface-variant">
                  Source note
                </div>

                <p className="mt-1 whitespace-pre-wrap text-sm text-on-surface">
                  {
                    item.meetingOrigin
                      .noteContent
                  }
                </p>
              </div>
            )}

            <div>
              <span className="mb-1.5 block text-sm font-medium text-on-surface">
                Description
              </span>

              {descriptionEditing ? (
                <RichMarkdownEditor
                  value={item.description}
                  autoFocus
                  variant="full"
                  ariaLabel="Work item description"
                  placeholder="Add context, expected outcome, or relevant notes…"
                  onCommit={(markdown) =>
                    void commitDescriptionEdit(markdown)
                  }
                  onEscape={() =>
                    setDescriptionEditing(false)
                  }
                  className="-mx-3.5 rounded-lg border border-primary bg-surface-container-lowest px-3.5 py-2.5 focus-within:ring-2 focus-within:ring-primary/15"
                />
              ) : (
                <div
                  role={
                    readOnly
                      ? undefined
                      : 'button'
                  }
                  tabIndex={
                    readOnly
                      ? undefined
                      : 0
                  }
                  onClick={(event) => {
                    // A click that landed on a link inside the rendered
                    // Description (read mode still renders real <a>
                    // tags — see RichMarkdownEditor) should navigate,
                    // not also enter edit mode.
                    if (
                      (
                        event.target as HTMLElement
                      ).closest('a')
                    ) {
                      return
                    }

                    startDescriptionEdit()
                  }}
                  onKeyDown={(event) => {
                    if (readOnly) {
                      return
                    }

                    if (
                      event.key === 'Enter' ||
                      event.key === ' '
                    ) {
                      event.preventDefault()
                      startDescriptionEdit()
                    }
                  }}
                  className={[
                    '-mx-3.5 min-h-[44px] rounded-lg px-3.5 py-2.5',
                    item.description
                      ? ''
                      : 'text-sm leading-6 text-on-surface-variant/70',
                    readOnly
                      ? ''
                      : 'transition hover:bg-surface-container-low',
                  ].join(' ')}
                >
                  {item.description ? (
                    <RichMarkdownEditor
                      value={item.description}
                      readOnly
                      variant="full"
                      className={
                        readOnly ? '' : 'cursor-text'
                      }
                    />
                  ) : (
                    'Add a description…'
                  )}
                </div>
              )}
            </div>

            <div className="border-t border-outline-variant pt-5">
              <PropertyRow label="Type">
                <select
                  value={item.type}
                  disabled={readOnly}
                  onChange={(event) =>
                    handleTypeChange(
                      event.target
                        .value as ApiWorkItemType,
                    )
                  }
                  aria-label="Type"
                  className={
                    compactControlClassName
                  }
                >
                  {typeOptions.map(
                    (option) => (
                      <option
                        key={option.value}
                        value={option.value}
                      >
                        {option.label}
                      </option>
                    ),
                  )}
                </select>
              </PropertyRow>

              <PropertyRow label="Status">
                <select
                  value={
                    statusSelectValue == null
                      ? ''
                      : statusSelectValue
                  }
                  disabled={
                    readOnly ||
                    inspectorStatusDefinitions.length === 0
                  }
                  onChange={(event) => {
                    const option =
                      inspectorStatusDefinitions.find(
                        (definition) =>
                          String(definition.id) ===
                          event.target.value,
                      )
                    if (option) {
                      handleStatusChange(
                        option.category as ApiWorkItemStatus,
                      )
                    }
                  }}
                  aria-label="Status"
                  className={
                    compactControlClassName
                  }
                >
                  {inspectorStatusDefinitions.map(
                    (definition) => (
                      <option
                        key={definition.id}
                        value={definition.id}
                      >
                        {definition.name}
                      </option>
                    ),
                  )}
                </select>
              </PropertyRow>

              <PropertyRow label="Assignees">
                <div className="flex flex-wrap items-center gap-2 py-1">
                  {selectedAssignees.map(
                    (assignee) => (
                      <span
                        key={assignee.id}
                        className="inline-flex h-7 items-center gap-1.5 rounded-full bg-surface-container-high py-0.5 pl-1 pr-2 text-xs font-medium text-on-surface"
                      >
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-container-lowest text-[8px] font-semibold">
                          {
                            assignee.initials
                          }
                        </span>

                        {assignee.name}

                        {!readOnly && (
                          <button
                            type="button"
                            onClick={() =>
                              handleAssigneeToggle(
                                assignee.id,
                              )
                            }
                            aria-label={`Remove ${assignee.name}`}
                            className="material-symbols-outlined text-[13px] text-on-surface-variant hover:text-on-surface"
                          >
                            close
                          </button>
                        )}
                      </span>
                    ),
                  )}

                  {selectedAssignees.length ===
                    0 &&
                    readOnly && (
                      <span className="text-sm text-on-surface-variant">
                        Unassigned
                      </span>
                    )}

                  {!readOnly && (
                    <div className="relative">
                      <button
                        type="button"
                        aria-expanded={
                          assigneePickerOpen
                        }
                        aria-label="Add assignee"
                        onClick={() =>
                          setAssigneePickerOpen(
                            (current) =>
                              !current,
                          )
                        }
                        className="flex h-7 items-center gap-1 rounded-full border border-dashed border-outline-variant px-2.5 text-xs font-medium text-on-surface-variant transition hover:border-primary/40 hover:text-on-surface"
                      >
                        <span
                          aria-hidden="true"
                          className="material-symbols-outlined text-[14px]"
                        >
                          add
                        </span>
                        Assign
                      </button>

                      {assigneePickerOpen && (
                        <div className="absolute right-0 z-10 mt-2 w-64 overflow-hidden rounded-lg border border-outline-variant bg-surface-container-lowest shadow-sm">
                          <div className="border-b border-outline-variant p-2">
                            <label className="relative block">
                              <span className="sr-only">
                                Search assignees
                              </span>

                              <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-[17px] text-on-surface-variant">
                                search
                              </span>

                              <input
                                autoFocus
                                type="search"
                                value={
                                  assigneeQuery
                                }
                                onChange={(
                                  event,
                                ) =>
                                  setAssigneeQuery(
                                    event
                                      .target
                                      .value,
                                  )
                                }
                                placeholder="Search members…"
                                className="h-9 w-full rounded-md border border-outline-variant bg-surface-container-lowest pl-9 pr-3 text-sm text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
                              />
                            </label>
                          </div>

                          <div className="max-h-52 overflow-y-auto">
                            {filteredAssignees.length >
                            0 ? (
                              filteredAssignees.map(
                                (
                                  assignee,
                                ) => {
                                  const selected =
                                    itemAssigneeIds.includes(
                                      assignee.id,
                                    )

                                  return (
                                    <label
                                      key={
                                        assignee.id
                                      }
                                      className="flex cursor-pointer items-center gap-3 px-3 py-2.5 transition hover:bg-surface-container-low"
                                    >
                                      <input
                                        type="checkbox"
                                        checked={
                                          selected
                                        }
                                        onChange={() =>
                                          handleAssigneeToggle(
                                            assignee.id,
                                          )
                                        }
                                        className="h-4 w-4 rounded border-outline accent-primary"
                                      />

                                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-[9px] font-semibold text-on-surface">
                                        {
                                          assignee.initials
                                        }
                                      </span>

                                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-on-surface">
                                        {
                                          assignee.name
                                        }
                                      </span>
                                    </label>
                                  )
                                },
                              )
                            ) : (
                              <div className="px-3 py-4 text-sm text-on-surface-variant">
                                No matching members.
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </PropertyRow>

              <PropertyRow label="Due date">
                <input
                  type="date"
                  value={item.dueDate ?? ''}
                  disabled={readOnly}
                  onChange={(event) =>
                    handleDueDateChange(
                      event.target.value,
                    )
                  }
                  aria-label="Due date"
                  className={
                    compactControlClassName
                  }
                />
              </PropertyRow>

              <PropertyRow label="Parent">
                <select
                  value={
                    item.parentId == null
                      ? ''
                      : String(
                          item.parentId,
                        )
                  }
                  disabled={readOnly}
                  onChange={(event) =>
                    handleParentChange(
                      event.target.value,
                    )
                  }
                  aria-label="Parent"
                  className={
                    compactControlClassName
                  }
                >
                  <option value="">
                    No parent
                  </option>

                  {availableParentItems.map(
                    (candidate) => (
                      <option
                        key={candidate.id}
                        value={candidate.id}
                      >
                        {candidate.title}
                      </option>
                    ),
                  )}
                </select>
              </PropertyRow>

              <PropertyRow label="Blocked">
                <div>
                  <div className="flex items-center gap-3 py-1">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={
                        displayBlocked
                      }
                      aria-label="Blocked"
                      disabled={readOnly}
                      onClick={() =>
                        handleBlockedToggle(
                          !displayBlocked,
                        )
                      }
                      className={[
                        'relative h-6 w-11 shrink-0 rounded-full transition',
                        displayBlocked
                          ? 'bg-primary'
                          : 'bg-surface-container-high',
                        readOnly
                          ? 'cursor-default'
                          : 'cursor-pointer',
                      ].join(' ')}
                    >
                      <span
                        className={[
                          'absolute top-0.5 h-5 w-5 rounded-full bg-surface-container-lowest shadow transition',
                          displayBlocked
                            ? 'left-[22px]'
                            : 'left-0.5',
                        ].join(' ')}
                      />
                    </button>

                    <span className="text-sm text-on-surface">
                      {displayBlocked
                        ? 'Yes'
                        : 'No'}
                    </span>
                  </div>

                  {displayBlocked &&
                    (blockedReasonEditing ? (
                      <RichMarkdownEditor
                        // Empty for a fresh pending block (item.blockedReason
                        // is still null), canonical Markdown when editing an
                        // already-blocked item — see startBlockedReasonEdit /
                        // handleBlockedToggle.
                        value={
                          item.blockedReason ?? ''
                        }
                        autoFocus
                        variant="compact"
                        ariaLabel="Blocked reason"
                        placeholder="Why is this work item blocked?"
                        onCommit={(markdown) =>
                          void commitBlockedReasonEdit(
                            markdown,
                          )
                        }
                        onEscape={
                          cancelBlockedReasonEdit
                        }
                        className="-mx-3 mt-2 rounded-lg border border-primary bg-surface-container-lowest px-3 py-2 focus-within:ring-2 focus-within:ring-primary/15"
                      />
                    ) : (
                      <div
                        role={
                          readOnly
                            ? undefined
                            : 'button'
                        }
                        tabIndex={
                          readOnly
                            ? undefined
                            : 0
                        }
                        onClick={(event) => {
                          // A click on a link inside the rendered reason
                          // (read mode still renders real <a> tags — see
                          // RichMarkdownEditor) should navigate, not also
                          // enter edit mode.
                          if (
                            (
                              event.target as HTMLElement
                            ).closest('a')
                          ) {
                            return
                          }

                          startBlockedReasonEdit()
                        }}
                        onKeyDown={(
                          event,
                        ) => {
                          if (readOnly) {
                            return
                          }

                          if (
                            event.key ===
                              'Enter' ||
                            event.key ===
                              ' '
                          ) {
                            event.preventDefault()
                            startBlockedReasonEdit()
                          }
                        }}
                        className={[
                          '-mx-3 mt-2 rounded-lg px-3 py-2',
                          item.blockedReason
                            ? ''
                            : 'text-sm leading-6 text-on-surface-variant/70',
                          readOnly
                            ? ''
                            : 'transition hover:bg-surface-container-low',
                        ].join(' ')}
                      >
                        {item.blockedReason ? (
                          <RichMarkdownEditor
                            value={
                              item.blockedReason
                            }
                            readOnly
                            variant="compact"
                            className={
                              readOnly
                                ? ''
                                : 'cursor-text'
                            }
                          />
                        ) : (
                          'Add a reason…'
                        )}
                      </div>
                    ))}
                </div>
              </PropertyRow>
            </div>

            <div className="mt-7 flex min-h-0 flex-1 flex-col border-t border-outline-variant pt-5">
              <h3 className="mb-3 shrink-0 text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
                Activity
              </h3>

              {!readOnly && (
                <div className="mb-4 min-h-0 shrink-0">
                  {!commentComposerExpanded ? (
                    <button
                      type="button"
                      onClick={() =>
                        setCommentComposerExpanded(
                          true,
                        )
                      }
                      className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left text-sm text-on-surface-variant transition hover:bg-surface-container-low"
                    >
                      <span
                        aria-hidden="true"
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary"
                      >
                        {currentUserInitials}
                      </span>
                      Add a comment…
                    </button>
                  ) : (
                    <div
                      className="rounded-lg border border-outline-variant bg-surface-container-lowest p-2.5"
                      onKeyDown={(event) => {
                        // The editor's own contenteditable
                        // handleKeyDown doesn't preventDefault Cmd/Ctrl
                        // +Enter (it isn't a Markdown editing command),
                        // so it bubbles here exactly like it used to
                        // bubble from the plain textarea.
                        if (
                          (event.metaKey ||
                            event.ctrlKey) &&
                          event.key === 'Enter'
                        ) {
                          event.preventDefault()
                          submitComment()
                        }
                      }}
                    >
                      <RichMarkdownEditor
                        value={commentDraft}
                        onChange={
                          handleCommentDraftChange
                        }
                        onEscape={
                          collapseCommentComposer
                        }
                        autoFocus
                        variant="compact"
                        ariaLabel="Comment"
                        placeholder="Add a comment…"
                        className="[&_.fg-prose]:min-h-[3.75rem]"
                      />

                      {commentSubmitError && (
                        <p
                          role="alert"
                          className="mt-1 text-xs text-error"
                        >
                          {commentSubmitError}
                        </p>
                      )}

                      <div className="mt-2 flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={
                            cancelCommentComposer
                          }
                          className="h-8 rounded-md px-3 text-xs font-medium text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface"
                        >
                          Cancel
                        </button>

                        <button
                          type="button"
                          disabled={
                            isMarkdownContentEmpty(
                              commentDraft,
                              'compact',
                            ) ||
                            commentSubmitStatus ===
                              'submitting'
                          }
                          onClick={submitComment}
                          className="h-8 rounded-md bg-primary px-3 text-xs font-semibold text-on-primary transition hover:opacity-90 disabled:opacity-40"
                        >
                          {commentSubmitStatus ===
                          'submitting'
                            ? 'Posting…'
                            : 'Comment'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {historyStatus === 'loading' &&
                commentsStatus === 'loading' && (
                  <p className="text-xs text-on-surface-variant/70">
                    Loading activity…
                  </p>
                )}

              {historyStatus === 'error' && (
                <div
                  role="alert"
                  className="mb-2 flex items-center gap-2.5 text-xs text-on-surface-variant"
                >
                  <span className="text-error">
                    {historyError ??
                      'History could not be loaded.'}
                  </span>

                  <button
                    type="button"
                    onClick={() =>
                      fetchHistory(item.id)
                    }
                    className="font-medium text-primary underline-offset-2 hover:underline"
                  >
                    Retry
                  </button>
                </div>
              )}

              {commentsStatus === 'error' && (
                <div
                  role="alert"
                  className="mb-2 flex items-center gap-2.5 text-xs text-on-surface-variant"
                >
                  <span className="text-error">
                    {commentsError ??
                      'Comments could not be loaded.'}
                  </span>

                  <button
                    type="button"
                    onClick={() =>
                      fetchComments(item.id)
                    }
                    className="font-medium text-primary underline-offset-2 hover:underline"
                  >
                    Retry
                  </button>
                </div>
              )}

              {historyStatus !== 'loading' &&
                commentsStatus !== 'loading' &&
                activityFeed.length === 0 && (
                  <p className="text-xs text-on-surface-variant/70">
                    No activity yet.
                  </p>
                )}

              {activityFeed.length > 0 && (
                // Explicit label: a Comment's own body can now contain
                // a nested Markdown list, which also carries the
                // implicit ARIA `list` role — without this, that inner
                // list would be indistinguishable from the outer
                // Activity feed itself to anything querying by role.
                <ul
                  aria-label="Activity"
                  className="max-h-[320px] min-h-0 flex-1 overflow-y-auto pr-1"
                >
                  {activityFeed.map(
                    (entry, index) => {
                      const isLast =
                        index ===
                        activityFeed.length - 1

                      if (entry.kind === 'history') {
                        const event = entry.event
                        const description =
                          describeWorkItemHistoryEvent(
                            event,
                          )

                        return (
                          <li
                            key={entry.key}
                            className="flex gap-2.5"
                          >
                            <div className="flex flex-col items-center">
                              <span
                                aria-hidden="true"
                                className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-on-surface-variant/60"
                              />

                              {!isLast && (
                                <span
                                  aria-hidden="true"
                                  className="mt-1 w-px flex-1 bg-outline-variant/50"
                                />
                              )}
                            </div>

                            <div
                              className={[
                                'min-w-0 flex-1',
                                isLast
                                  ? 'pb-0.5'
                                  : 'pb-3.5',
                              ].join(' ')}
                            >
                              <p className="truncate text-sm text-on-surface">
                                {description.primary}
                              </p>

                              {description.lines.map(
                                (
                                  line,
                                  lineIndex,
                                ) =>
                                  line.label ? (
                                    <div
                                      key={
                                        lineIndex
                                      }
                                      className="mt-0.5 flex gap-2 text-xs text-on-surface-variant"
                                    >
                                      <span className="w-16 shrink-0 text-on-surface-variant/60">
                                        {
                                          line.label
                                        }
                                      </span>
                                      <span className="min-w-0 truncate">
                                        {
                                          line.text
                                        }
                                      </span>
                                    </div>
                                  ) : (
                                    <p
                                      key={
                                        lineIndex
                                      }
                                      className="mt-0.5 truncate text-xs text-on-surface-variant"
                                    >
                                      {line.text}
                                    </p>
                                  ),
                              )}

                              <p
                                title={formatHistoryAbsoluteTime(
                                  event.createdAt,
                                )}
                                className="mt-1 text-[11px] text-on-surface-variant/60"
                              >
                                {formatHistoryRelativeTime(
                                  event.createdAt,
                                )}
                              </p>
                            </div>
                          </li>
                        )
                      }

                      // Comments carry more visual weight than
                      // quiet system History — an avatar, a
                      // readable body, no timeline dot/connector.
                      const comment = entry.comment
                      const isOwn =
                        currentUserId !== null &&
                        comment.author.id ===
                          currentUserId
                      const isEditingThis =
                        editingCommentId ===
                        comment.id
                      const isConfirmingDeleteThis =
                        confirmingDeleteCommentId ===
                        comment.id
                      const isEdited =
                        new Date(
                          comment.updatedAt,
                        ).getTime() -
                          new Date(
                            comment.createdAt,
                          ).getTime() >
                        2000

                      return (
                        <li
                          key={entry.key}
                          className={[
                            'group flex gap-2.5',
                            isLast
                              ? 'pb-0.5'
                              : 'pb-4',
                          ].join(' ')}
                        >
                          <span
                            aria-hidden="true"
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-secondary-container text-[11px] font-semibold text-on-secondary-container"
                          >
                            {getActorInitials(
                              comment.author,
                            )}
                          </span>

                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex min-w-0 items-baseline gap-2">
                                <span className="truncate text-sm font-medium text-on-surface">
                                  {getActorDisplayName(
                                    comment.author,
                                  )}
                                </span>
                                <span
                                  title={formatHistoryAbsoluteTime(
                                    comment.createdAt,
                                  )}
                                  className="shrink-0 text-xs text-on-surface-variant/70"
                                >
                                  {formatHistoryRelativeTime(
                                    comment.createdAt,
                                  )}
                                  {isEdited &&
                                    ' · edited'}
                                </span>
                              </div>

                              {isOwn &&
                                !isEditingThis &&
                                !isConfirmingDeleteThis && (
                                  <div className="relative shrink-0 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100">
                                    <button
                                      type="button"
                                      aria-label="Comment actions"
                                      aria-expanded={
                                        commentActionsMenuOpenId ===
                                        comment.id
                                      }
                                      onClick={() =>
                                        setCommentActionsMenuOpenId(
                                          (
                                            current,
                                          ) =>
                                            current ===
                                            comment.id
                                              ? null
                                              : comment.id,
                                        )
                                      }
                                      className="flex h-6 w-6 items-center justify-center rounded text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface"
                                    >
                                      <span
                                        aria-hidden="true"
                                        className="material-symbols-outlined text-[16px]"
                                      >
                                        more_horiz
                                      </span>
                                    </button>

                                    {commentActionsMenuOpenId ===
                                      comment.id && (
                                      <div className="absolute right-0 z-10 mt-1 w-28 overflow-hidden rounded-lg border border-outline-variant bg-surface-container-lowest shadow-sm">
                                        <button
                                          type="button"
                                          onClick={() =>
                                            startEditingComment(
                                              comment,
                                            )
                                          }
                                          className="block w-full px-3 py-2 text-left text-xs text-on-surface transition hover:bg-surface-container-low"
                                        >
                                          Edit
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            requestDeleteComment(
                                              comment.id,
                                            )
                                          }
                                          className="block w-full px-3 py-2 text-left text-xs text-error transition hover:bg-surface-container-low"
                                        >
                                          Delete
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                )}
                            </div>

                            {isEditingThis ? (
                              <div
                                className="mt-1 rounded-md border border-outline-variant bg-surface-container-lowest p-2"
                                onKeyDown={(
                                  event,
                                ) => {
                                  if (
                                    (event.metaKey ||
                                      event.ctrlKey) &&
                                    event.key ===
                                      'Enter'
                                  ) {
                                    event.preventDefault()
                                    saveEditingComment()
                                  }
                                }}
                              >
                                <RichMarkdownEditor
                                  value={
                                    editingCommentBody
                                  }
                                  onChange={
                                    setEditingCommentBody
                                  }
                                  onEscape={
                                    cancelEditingComment
                                  }
                                  autoFocus
                                  variant="compact"
                                  ariaLabel="Edit comment"
                                />

                                {commentEditError && (
                                  <p
                                    role="alert"
                                    className="mt-1 text-xs text-error"
                                  >
                                    {
                                      commentEditError
                                    }
                                  </p>
                                )}

                                <div className="mt-1.5 flex items-center justify-end gap-2">
                                  <button
                                    type="button"
                                    onClick={
                                      cancelEditingComment
                                    }
                                    className="h-7 rounded-md px-2.5 text-xs font-medium text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface"
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    type="button"
                                    disabled={
                                      isMarkdownContentEmpty(
                                        editingCommentBody,
                                        'compact',
                                      ) ||
                                      commentEditStatus ===
                                        'saving'
                                    }
                                    onClick={
                                      saveEditingComment
                                    }
                                    className="h-7 rounded-md bg-primary px-2.5 text-xs font-semibold text-on-primary transition hover:opacity-90 disabled:opacity-40"
                                  >
                                    {commentEditStatus ===
                                    'saving'
                                      ? 'Saving…'
                                      : 'Save'}
                                  </button>
                                </div>
                              </div>
                            ) : isConfirmingDeleteThis ? (
                              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-on-surface-variant">
                                <span>
                                  Delete this
                                  comment?
                                </span>

                                {commentDeleteError && (
                                  <span
                                    role="alert"
                                    className="text-error"
                                  >
                                    {
                                      commentDeleteError
                                    }
                                  </span>
                                )}

                                <button
                                  type="button"
                                  onClick={
                                    cancelDeleteComment
                                  }
                                  className="font-medium text-on-surface-variant underline-offset-2 hover:underline"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  disabled={
                                    commentDeleteStatus ===
                                    'deleting'
                                  }
                                  onClick={
                                    confirmDeleteComment
                                  }
                                  className="font-medium text-error underline-offset-2 hover:underline disabled:opacity-50"
                                >
                                  {commentDeleteStatus ===
                                  'deleting'
                                    ? 'Deleting…'
                                    : 'Delete'}
                                </button>
                              </div>
                            ) : (
                              // Same compact Markdown surface as the
                              // composer/edit — readOnly means no
                              // border, no toolbar, no contenteditable,
                              // just the formatted body (see
                              // RichMarkdownEditor).
                              <RichMarkdownEditor
                                value={comment.body}
                                readOnly
                                variant="compact"
                                className="mt-0.5 break-words"
                              />
                            )}
                          </div>
                        </li>
                      )
                    },
                  )}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>

      {effectiveDeleteOpen && (
        <WorkItemDeleteDialog
          open={effectiveDeleteOpen}
          deleting={effectiveDeleting}
          error={effectiveDeleteError}
          onCancel={cancelDelete}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </div>
  )
}
