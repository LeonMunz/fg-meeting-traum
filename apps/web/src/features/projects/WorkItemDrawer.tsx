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

import type {
  ApiUpdateWorkItemInput,
  ApiWorkItem,
  ApiWorkItemStatus,
  ApiWorkItemType,
} from '../../api/types'

export type WorkItemFormInput = {
  title: string
  description: string
  type: ApiWorkItemType
  status: ApiWorkItemStatus
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

export function WorkItemDrawer({
  open,
  mode,
  projectName,
  item,
  readOnly,
  assignees,
  parentItems,
  onClose,
  onCreate,
  onPatch,
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
        assignees={assignees}
        parentItems={parentItems}
        onClose={onClose}
        onPatch={onPatch}
      />
    )
  }

  return (
    <CreateWorkItemPanel
      projectName={projectName}
      readOnly={readOnly}
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
  assignees,
  parentItems,
  onClose,
  onCreate,
}: {
  projectName: string
  readOnly: boolean
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
  const [type, setType] =
    useState<ApiWorkItemType>('task')
  const [status, setStatus] =
    useState<ApiWorkItemStatus>('todo')
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
      type,
      status,
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

                <div className="grid grid-cols-4 overflow-hidden rounded-lg border border-outline-variant">
                  {typeOptions.map(
                    (option, index) => {
                      const selected =
                        type ===
                        option.value

                      return (
                        <label
                          key={
                            option.value
                          }
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
                            value={
                              option.value
                            }
                            checked={
                              selected
                            }
                            disabled={
                              readOnly
                            }
                            onChange={() =>
                              setType(
                                option.value,
                              )
                            }
                            className="absolute inset-0 cursor-pointer appearance-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary disabled:cursor-default"
                          />

                          <span
                            aria-hidden="true"
                            className="pointer-events-none material-symbols-outlined text-[16px]"
                          >
                            {
                              option.icon
                            }
                          </span>

                          <span className="pointer-events-none truncate">
                            {
                              option.label
                            }
                          </span>
                        </label>
                      )
                    },
                  )}
                </div>
              </fieldset>

              <div className="grid grid-cols-2 gap-4">
                <label>
                  <span className="mb-1.5 block text-sm font-medium text-on-surface">
                    Status
                  </span>

                  <select
                    value={status}
                    disabled={readOnly}
                    onChange={(event) =>
                      setStatus(
                        event.target
                          .value as ApiWorkItemStatus,
                      )
                    }
                    className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:cursor-default disabled:bg-surface-container-low disabled:text-on-surface-variant"
                  >
                    {statusOptions.map(
                      (option) => (
                        <option
                          key={
                            option.value
                          }
                          value={
                            option.value
                          }
                        >
                          {option.label}
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
  assignees,
  parentItems,
  onClose,
  onPatch,
}: {
  projectName: string
  item: ApiWorkItem
  readOnly: boolean
  assignees: AssigneeOption[]
  parentItems: ParentOption[]
  onClose: () => void
  onPatch: (
    workItemId: number,
    patch: ApiUpdateWorkItemInput,
  ) => Promise<void>
}) {
  const [saveStatus, setSaveStatus] =
    useState<SaveStatus>('idle')
  const [saveError, setSaveError] =
    useState<string | null>(null)
  const savedTimeoutRef = useRef<
    ReturnType<typeof setTimeout> | null
  >(null)

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
    descriptionDraft,
    setDescriptionDraft,
  ] = useState('')
  const descriptionCancelledRef =
    useRef(false)

  const [
    blockedReasonEditing,
    setBlockedReasonEditing,
  ] = useState(false)
  const [
    blockedReasonDraft,
    setBlockedReasonDraft,
  ] = useState('')
  const blockedReasonCancelledRef =
    useRef(false)

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
    setAssigneePickerOpen(false)
    setAssigneeQuery('')
    setSaveStatus('idle')
    setSaveError(null)
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
        setBlockedReasonEditing(false)
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
    descriptionEditing,
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
          // to flip the indicator back to "Saving…" anyway.
          if (
            queuedPatchCountRef.current ===
            0
          ) {
            setSaveStatus('saved')
            savedTimeoutRef.current =
              setTimeout(() => {
                setSaveStatus('idle')
              }, 1600)
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

    setDescriptionDraft(item.description)
    setDescriptionEditing(true)
  }

  async function commitDescriptionEdit() {
    const trimmed =
      descriptionDraft.trim()

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

    setBlockedReasonDraft(
      item.blockedReason ?? '',
    )
    setBlockedReasonEditing(true)
  }

  async function commitBlockedReasonEdit() {
    const trimmed =
      blockedReasonDraft.trim()
    const current =
      item.blockedReason ?? ''

    if (!trimmed || trimmed === current) {
      setBlockedReasonEditing(false)
      return
    }

    const success = await patchField({
      blockedReason: trimmed,
    })

    if (success) {
      setBlockedReasonEditing(false)
    }
  }

  function handleBlockedToggle(
    nextBlocked: boolean,
  ) {
    if (readOnly) {
      return
    }

    if (nextBlocked) {
      setBlockedReasonDraft('')
      setBlockedReasonEditing(true)
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

    void patchField({
      status: nextStatus,
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
    <div className="fixed inset-y-0 right-0 z-40 w-full sm:w-[520px]">
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

        <div className="min-h-0 flex-1 overflow-y-auto px-7 py-7">
          {readOnly && (
            <div className="mb-6 rounded-lg bg-surface-container-low px-4 py-3 text-sm text-on-surface-variant">
              This work item is read-only.
            </div>
          )}

          <div className="space-y-7">
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

            <div>
              <span className="mb-1.5 block text-sm font-medium text-on-surface">
                Description
              </span>

              {descriptionEditing ? (
                <textarea
                  autoFocus
                  rows={5}
                  value={descriptionDraft}
                  onChange={(event) =>
                    setDescriptionDraft(
                      event.target.value,
                    )
                  }
                  onKeyDown={(event) => {
                    if (
                      event.key === 'Escape'
                    ) {
                      event.preventDefault()
                      descriptionCancelledRef.current = true
                      setDescriptionEditing(false)
                    }
                  }}
                  onBlur={() => {
                    if (
                      descriptionCancelledRef.current
                    ) {
                      descriptionCancelledRef.current = false
                      return
                    }

                    void commitDescriptionEdit()
                  }}
                  aria-label="Work item description"
                  placeholder="Add context, expected outcome, or relevant notes…"
                  className="min-h-[128px] w-full resize-y rounded-lg border border-primary bg-surface-container-lowest px-3.5 py-3 text-sm leading-6 text-on-surface outline-none focus:ring-2 focus:ring-primary/15"
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
                  onClick={
                    startDescriptionEdit
                  }
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
                    '-mx-3.5 min-h-[44px] whitespace-pre-wrap rounded-lg px-3.5 py-2.5 text-sm leading-6',
                    item.description
                      ? 'text-on-surface'
                      : 'text-on-surface-variant/70',
                    readOnly
                      ? ''
                      : 'cursor-text transition hover:bg-surface-container-low',
                  ].join(' ')}
                >
                  {item.description ||
                    'Add description…'}
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
                  value={item.status}
                  disabled={readOnly}
                  onChange={(event) =>
                    handleStatusChange(
                      event.target
                        .value as ApiWorkItemStatus,
                    )
                  }
                  aria-label="Status"
                  className={
                    compactControlClassName
                  }
                >
                  {statusOptions.map(
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
                        isBlocked
                      }
                      aria-label="Blocked"
                      disabled={readOnly}
                      onClick={() =>
                        handleBlockedToggle(
                          !isBlocked,
                        )
                      }
                      className={[
                        'relative h-6 w-11 shrink-0 rounded-full transition',
                        isBlocked
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
                          isBlocked
                            ? 'left-[22px]'
                            : 'left-0.5',
                        ].join(' ')}
                      />
                    </button>

                    <span className="text-sm text-on-surface">
                      {isBlocked
                        ? 'Yes'
                        : 'No'}
                    </span>
                  </div>

                  {isBlocked &&
                    (blockedReasonEditing ? (
                      <textarea
                        autoFocus
                        rows={2}
                        value={
                          blockedReasonDraft
                        }
                        onChange={(event) =>
                          setBlockedReasonDraft(
                            event.target
                              .value,
                          )
                        }
                        onKeyDown={(
                          event,
                        ) => {
                          if (
                            event.key ===
                            'Escape'
                          ) {
                            event.preventDefault()
                            blockedReasonCancelledRef.current = true
                            setBlockedReasonEditing(
                              false,
                            )
                          }
                        }}
                        onBlur={() => {
                          if (
                            blockedReasonCancelledRef.current
                          ) {
                            blockedReasonCancelledRef.current = false
                            return
                          }

                          void commitBlockedReasonEdit()
                        }}
                        aria-label="Blocked reason"
                        placeholder="What is preventing progress?"
                        className="mt-2 w-full resize-y rounded-lg border border-primary bg-surface-container-lowest px-3 py-2 text-sm leading-6 text-on-surface outline-none focus:ring-2 focus:ring-primary/15"
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
                        onClick={
                          startBlockedReasonEdit
                        }
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
                          '-mx-3 mt-2 whitespace-pre-wrap rounded-lg px-3 py-2 text-sm leading-6',
                          item.blockedReason
                            ? 'text-on-surface'
                            : 'text-on-surface-variant/70',
                          readOnly
                            ? ''
                            : 'cursor-text transition hover:bg-surface-container-low',
                        ].join(' ')}
                      >
                        {item.blockedReason ||
                          'Add a reason…'}
                      </div>
                    ))}
                </div>
              </PropertyRow>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
