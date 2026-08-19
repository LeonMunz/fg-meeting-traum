import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  FormEvent,
} from 'react'

import type {
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
  onUpdate: (
    workItemId: number,
    input: WorkItemFormInput,
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
  onUpdate,
}: WorkItemDrawerProps) {
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
        [...parentItems]
          .filter(
            (candidate) =>
              candidate.id !==
              String(item?.id ?? ''),
          )
          .sort((left, right) =>
            left.title.localeCompare(
              right.title,
            ),
          ),
      [
        item?.id,
        parentItems,
      ],
    )

  useEffect(() => {
    if (!open) {
      return
    }

    if (
      mode === 'edit' &&
      item
    ) {
      setTitle(item.title)
      setDescription(
        item.description,
      )
      setType(item.type)
      setStatus(item.status)
      setAssigneeIds(
        item.assigneeIds.map(
          String,
        ),
      )
      setParentId(
        item.parentId == null
          ? ''
          : String(item.parentId),
      )
      setDueDate(
        item.dueDate ?? '',
      )
      setBlocked(
        item.blockedReason !== null,
      )
      setBlockedReason(
        item.blockedReason ?? '',
      )
    } else {
      setTitle('')
      setDescription('')
      setType('task')
      setStatus('todo')
      setAssigneeIds([])
      setParentId('')
      setDueDate('')
      setBlocked(false)
      setBlockedReason('')
    }

    setAssigneePickerOpen(false)
    setAssigneeQuery('')
    setSubmitting(false)
    setSubmitError(null)
  }, [
    item,
    mode,
    open,
  ])

  useEffect(() => {
    if (!open) {
      return
    }

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
    open,
    submitting,
  ])

  if (!open) {
    return null
  }

  if (
    mode === 'edit' &&
    !item
  ) {
    return null
  }

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
      if (
        mode === 'edit' &&
        item
      ) {
        await onUpdate(
          item.id,
          input,
        )
      } else {
        await onCreate(input)
      }

      onClose()
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : mode === 'edit'
            ? 'Work item could not be updated.'
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
        aria-modal="true"
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
                {mode === 'create'
                  ? 'New work item'
                  : 'Work item'}
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
                      ? mode ===
                        'create'
                        ? 'Creating…'
                        : 'Saving…'
                      : mode ===
                          'create'
                        ? 'Create work item'
                        : 'Save changes'}
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
