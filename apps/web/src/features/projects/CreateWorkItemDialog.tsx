import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'

type WorkItemType = 'epic' | 'milestone' | 'deliverable' | 'task'
type WorkItemStatus = 'todo' | 'in_progress' | 'review' | 'done'

type AssigneeOption = {
  id: string
  name: string
  initials: string
}

type ParentOption = {
  id: string
  title: string
  type: WorkItemType
}

type CreateWorkItemDialogProps = {
  open: boolean
  assignees: AssigneeOption[]
  parentItems: ParentOption[]
  onClose: () => void
  onCreate: (input: {
    title: string
    type: WorkItemType
    status: WorkItemStatus
    assigneeIds: string[]
    parentId: string | null
    dueDate: string | null
    blockedReason: string | null
  }) => Promise<void>
}

const typeOptions: Array<{
  value: WorkItemType
  label: string
  icon: string
}> = [
  { value: 'epic', label: 'Epic', icon: 'account_tree' },
  { value: 'milestone', label: 'Milestone', icon: 'flag' },
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
  value: WorkItemStatus
  label: string
}> = [
  { value: 'todo', label: 'To do' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'review', label: 'Review' },
  { value: 'done', label: 'Done' },
]

export function CreateWorkItemDialog({
  open,
  assignees,
  parentItems,
  onClose,
  onCreate,
}: CreateWorkItemDialogProps) {
  const [title, setTitle] = useState('')
  const [type, setType] = useState<WorkItemType>('task')
  const [status, setStatus] = useState<WorkItemStatus>('todo')
  const [assigneeIds, setAssigneeIds] = useState<string[]>([])
  const [parentId, setParentId] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [blockedReason, setBlockedReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] =
    useState<string | null>(null)

  const sortedAssignees = useMemo(
    () => [...assignees].sort((a, b) => a.name.localeCompare(b.name)),
    [assignees],
  )

  const sortedParentItems = useMemo(
    () => [...parentItems].sort((a, b) => a.title.localeCompare(b.title)),
    [parentItems],
  )

  useEffect(() => {
    if (!open) return

    setTitle('')
    setType('task')
    setStatus('todo')
    setAssigneeIds([])
    setParentId('')
    setDueDate('')
    setBlockedReason('')
    setSubmitting(false)
    setSubmitError(null)

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, onClose])

  if (!open) return null

  const toggleAssignee = (assigneeId: string) => {
    setAssigneeIds((current) =>
      current.includes(assigneeId)
        ? current.filter((id) => id !== assigneeId)
        : [...current, assigneeId],
    )
  }

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault()

    const normalizedTitle = title.trim()

    if (!normalizedTitle || submitting) return

    setSubmitting(true)
    setSubmitError(null)

    try {
      await onCreate({
        title: normalizedTitle,
        type,
        status,
        assigneeIds,
        parentId: parentId || null,
        dueDate: dueDate || null,
        blockedReason: blockedReason.trim() || null,
      })

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-work-item-title"
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-outline-variant bg-surface-container-lowest shadow-xl"
      >
        <form onSubmit={handleSubmit}>
          <div className="flex items-start justify-between gap-6 border-b border-outline-variant px-6 py-5">
            <div>
              <h2
                id="create-work-item-title"
                className="text-lg font-semibold tracking-tight text-on-surface"
              >
                New work item
              </h2>

              <p className="mt-1 text-sm text-on-surface-variant">
                Create work that belongs to this project.
              </p>
            </div>

            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface"
            >
              <span className="material-symbols-outlined text-[20px]">
                close
              </span>
            </button>
          </div>

          <div className="space-y-6 px-6 py-6">
            <div>
              <label
                htmlFor="work-item-title"
                className="mb-1.5 block text-sm font-medium text-on-surface"
              >
                Title
              </label>

              <input
                id="work-item-title"
                autoFocus
                required
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="What needs to be done?"
                className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none transition placeholder:text-on-surface-variant/60 focus:border-primary focus:ring-2 focus:ring-primary/15"
              />
            </div>

            <fieldset>
              <legend className="text-sm font-medium text-on-surface">
                Type
              </legend>

              <div className="mt-2 grid grid-cols-2 gap-2">
                {typeOptions.map((option) => {
                  const selected = type === option.value

                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setType(option.value)}
                      className={[
                        'flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition',
                        selected
                          ? 'border-primary bg-primary-fixed/35 ring-1 ring-primary/15'
                          : 'border-outline-variant hover:bg-surface-container-low',
                      ].join(' ')}
                    >
                      <span className="material-symbols-outlined text-[19px] text-on-surface-variant">
                        {option.icon}
                      </span>

                      <span className="text-sm font-semibold text-on-surface">
                        {option.label}
                      </span>
                    </button>
                  )
                })}
              </div>
            </fieldset>

            <div className="grid grid-cols-2 gap-4">
              <label>
                <span className="mb-1.5 block text-sm font-medium text-on-surface">
                  Status
                </span>

                <select
                  value={status}
                  onChange={(event) =>
                    setStatus(event.target.value as WorkItemStatus)
                  }
                  className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
                >
                  {statusOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span className="mb-1.5 block text-sm font-medium text-on-surface">
                  Due date
                </span>

                <input
                  type="date"
                  value={dueDate}
                  onChange={(event) => setDueDate(event.target.value)}
                  className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
                />
              </label>
            </div>

            <label>
              <span className="mb-1.5 block text-sm font-medium text-on-surface">
                Parent work item
              </span>

              <select
                value={parentId}
                onChange={(event) => setParentId(event.target.value)}
                className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
              >
                <option value="">No parent</option>

                {sortedParentItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>

              <p className="mt-1.5 text-xs text-on-surface-variant">
                Parents are limited to work items in this project.
              </p>
            </label>

            <fieldset>
              <legend className="text-sm font-medium text-on-surface">
                Assignees
              </legend>

              <p className="mt-1 text-xs text-on-surface-variant">
                Only project owners and members can be assigned.
              </p>

              {sortedAssignees.length > 0 ? (
                <div className="mt-3 divide-y divide-outline-variant overflow-hidden rounded-xl border border-outline-variant">
                  {sortedAssignees.map((assignee) => {
                    const selected = assigneeIds.includes(assignee.id)

                    return (
                      <label
                        key={assignee.id}
                        className="flex cursor-pointer items-center gap-3 px-4 py-3 transition hover:bg-surface-container-low"
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleAssignee(assignee.id)}
                          className="h-4 w-4 rounded border-outline accent-primary"
                        />

                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-[10px] font-semibold text-on-surface">
                          {assignee.initials}
                        </div>

                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-on-surface">
                          {assignee.name}
                        </span>
                      </label>
                    )
                  })}
                </div>
              ) : (
                <div className="mt-3 rounded-xl border border-dashed border-outline-variant px-4 py-5 text-sm text-on-surface-variant">
                  No assignable project members.
                </div>
              )}
            </fieldset>

            <label>
              <span className="mb-1.5 block text-sm font-medium text-on-surface">
                Blocked reason
              </span>

              <textarea
                value={blockedReason}
                onChange={(event) => setBlockedReason(event.target.value)}
                rows={3}
                placeholder="Leave empty if this work item is not blocked."
                className="w-full resize-none rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2.5 text-sm leading-6 text-on-surface outline-none transition placeholder:text-on-surface-variant/60 focus:border-primary focus:ring-2 focus:ring-primary/15"
              />

              <p className="mt-1.5 text-xs text-on-surface-variant">
                A work item is blocked whenever a blocked reason is present.
              </p>
            </label>
          </div>

          {submitError && (
            <div
              role="alert"
              className="border-t border-error/20 bg-error-container/35 px-6 py-3 text-sm text-error"
            >
              {submitError}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 border-t border-outline-variant bg-surface-container-low/45 px-6 py-4">
            <button
              type="button"
              onClick={onClose}
              className="h-9 rounded-lg px-4 text-sm font-medium text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface"
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={!title.trim() || submitting}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <span className="material-symbols-outlined text-[18px]">
                add
              </span>
              {submitting ? 'Creating…' : 'Create work item'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
