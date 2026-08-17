import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { useNavigate } from 'react-router'

import { ApiError } from '../../api/client'
import { listProjects } from '../../api/projects'
import type {
  ApiProject,
  ApiWorkItem,
  ApiWorkItemStatus,
} from '../../api/types'
import {
  listMyWork,
  updateWorkItem,
} from '../../api/work-items'
import { useResearchGroup } from '../research-group/useResearchGroup'

const statusLabels: Record<ApiWorkItemStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  review: 'Review',
  done: 'Done',
}

const typeLabels: Record<ApiWorkItem['type'], string> = {
  epic: 'Epic',
  milestone: 'Milestone',
  deliverable: 'Deliverable',
  task: 'Task',
}

const typeIcons: Record<ApiWorkItem['type'], string> = {
  epic: 'account_tree',
  milestone: 'flag',
  deliverable: 'inventory_2',
  task: 'check_box_outline_blank',
}

function getErrorMessage(
  error: unknown,
  fallback: string,
) {
  if (
    error instanceof ApiError &&
    error.detail &&
    typeof error.detail === 'object' &&
    'error' in error.detail
  ) {
    const detail = error.detail as {
      error?: unknown
    }

    if (typeof detail.error === 'string') {
      return detail.error
    }
  }

  return fallback
}

function formatDueDate(value: string | null) {
  if (!value) {
    return 'No due date'
  }

  const [year, month, day] = value.split('-').map(Number)

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return value
  }

  const dueDate = new Date(year, month - 1, day)

  const now = new Date()

  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  )

  const diffDays = Math.round(
    (dueDate.getTime() - today.getTime()) /
      86_400_000,
  )

  if (diffDays === 0) {
    return 'Due today'
  }

  if (diffDays === 1) {
    return 'Due tomorrow'
  }

  if (diffDays === -1) {
    return 'Due yesterday'
  }

  const formatted = new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
  }).format(dueDate)

  if (diffDays < 0) {
    return `Overdue · ${formatted}`
  }

  return `Due ${formatted}`
}

export function MyWorkPage() {
  const navigate = useNavigate()

  const {
    activeResearchGroupId,
    activeResearchGroup,
    loading: researchGroupsLoading,
    error: researchGroupsError,
  } = useResearchGroup()

  const [items, setItems] = useState<ApiWorkItem[]>([])
  const [projects, setProjects] = useState<ApiProject[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [updatingItemId, setUpdatingItemId] =
    useState<number | null>(null)

  const loadMyWork = useCallback(async () => {
    if (activeResearchGroupId == null) {
      setItems([])
      setProjects([])
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)

    try {
      const [nextItems, nextProjects] =
        await Promise.all([
          listMyWork(activeResearchGroupId),
          listProjects(activeResearchGroupId),
        ])

      setItems(nextItems)
      setProjects(nextProjects)
    } catch (loadError) {
      setItems([])
      setProjects([])
      setError(
        getErrorMessage(
          loadError,
          'My Work could not be loaded.',
        ),
      )
    } finally {
      setLoading(false)
    }
  }, [activeResearchGroupId])

  useEffect(() => {
    void loadMyWork()
  }, [loadMyWork])

  const projectsById = useMemo(
    () =>
      new Map(
        projects.map((project) => [
          project.id,
          project,
        ]),
      ),
    [projects],
  )

  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => {
      if (a.status === 'done' && b.status !== 'done') {
        return 1
      }

      if (a.status !== 'done' && b.status === 'done') {
        return -1
      }

      if (a.dueDate && b.dueDate) {
        return a.dueDate.localeCompare(b.dueDate)
      }

      if (a.dueDate) return -1
      if (b.dueDate) return 1

      return b.updatedAt.localeCompare(a.updatedAt)
    })
  }, [items])

  const handleStatusChange = async (
    item: ApiWorkItem,
    status: ApiWorkItemStatus,
  ) => {
    if (status === item.status) {
      return
    }

    setUpdatingItemId(item.id)
    setError(null)

    try {
      const updated = await updateWorkItem(
        item.id,
        { status },
      )

      setItems((current) =>
        current.map((candidate) =>
          candidate.id === updated.id
            ? updated
            : candidate,
        ),
      )
    } catch (updateError) {
      setError(
        getErrorMessage(
          updateError,
          'Work item status could not be updated.',
        ),
      )
    } finally {
      setUpdatingItemId(null)
    }
  }

  const pageLoading =
    researchGroupsLoading || loading

  const pageError =
    researchGroupsError || error

  return (
    <div className="w-full px-6 py-8 lg:px-8 lg:py-10 xl:px-10">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight text-on-surface">
          My Work
        </h1>

        <p className="mt-1.5 text-sm leading-6 text-on-surface-variant">
          {activeResearchGroup
            ? `Work assigned to you in ${activeResearchGroup.name}.`
            : 'Work currently assigned to you.'}
        </p>
      </header>

      {pageLoading ? (
        <div className="mt-8 flex min-h-64 items-center justify-center rounded-xl border border-outline-variant bg-surface-container-lowest">
          <span className="material-symbols-outlined mr-2 animate-spin text-[20px] text-on-surface-variant">
            refresh
          </span>

          <span className="text-sm text-on-surface-variant">
            Loading your work…
          </span>
        </div>
      ) : pageError ? (
        <div
          role="alert"
          className="mt-8 flex min-h-64 flex-col items-center justify-center rounded-xl border border-outline-variant bg-surface-container-lowest px-6 py-10 text-center"
        >
          <span className="material-symbols-outlined text-[28px] text-error">
            cloud_off
          </span>

          <h2 className="mt-3 text-base font-semibold text-on-surface">
            My Work couldn't be loaded
          </h2>

          <p className="mt-1 max-w-md text-sm text-on-surface-variant">
            {pageError}
          </p>

          <button
            type="button"
            onClick={() => void loadMyWork()}
            className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg border border-outline-variant px-4 text-sm font-semibold text-on-surface transition hover:bg-surface-container-low"
          >
            <span className="material-symbols-outlined text-[18px]">
              refresh
            </span>
            Try again
          </button>
        </div>
      ) : activeResearchGroupId == null ? (
        <div className="mt-8 rounded-xl border border-dashed border-outline-variant bg-surface-container-lowest px-6 py-12 text-center">
          <p className="text-sm text-on-surface-variant">
            No research group is currently available.
          </p>
        </div>
      ) : sortedItems.length === 0 ? (
        <div className="mt-8 flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-outline-variant bg-surface-container-lowest px-6 py-12 text-center">
          <span className="material-symbols-outlined text-[28px] text-on-surface-variant">
            task_alt
          </span>

          <h2 className="mt-3 text-base font-semibold text-on-surface">
            Nothing assigned to you
          </h2>

          <p className="mt-1 text-sm text-on-surface-variant">
            Assigned project work will appear here.
          </p>
        </div>
      ) : (
        <section className="mt-8 overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest">
          <div className="hidden grid-cols-[minmax(320px,1fr)_170px_150px_160px] border-b border-outline-variant bg-surface-container-low px-6 py-2.5 lg:grid">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-on-surface-variant">
              Work item
            </div>

            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-on-surface-variant">
              Project
            </div>

            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-on-surface-variant">
              Due
            </div>

            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-on-surface-variant">
              Status
            </div>
          </div>

          <div className="divide-y divide-outline-variant/60">
            {sortedItems.map((item) => {
              const project =
                projectsById.get(item.projectId)

              return (
                <article
                  key={item.id}
                  className="grid gap-4 px-6 py-4 lg:grid-cols-[minmax(320px,1fr)_170px_150px_160px] lg:items-center"
                >
                  <button
                    type="button"
                    onClick={() =>
                      navigate(
                        `/projects/${item.projectId}`,
                      )
                    }
                    className="min-w-0 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <span className="material-symbols-outlined shrink-0 text-[17px] text-on-surface-variant">
                        {typeIcons[item.type]}
                      </span>

                      <span className="truncate text-sm font-semibold text-on-surface hover:text-primary">
                        {item.title}
                      </span>
                    </div>

                    <div className="mt-1 flex items-center gap-2 pl-[25px]">
                      <span className="text-xs text-on-surface-variant">
                        {typeLabels[item.type]}
                      </span>

                      {item.blockedReason && (
                        <>
                          <span className="text-outline">
                            ·
                          </span>

                          <span
                            title={item.blockedReason}
                            className="inline-flex items-center gap-1 text-xs font-medium text-error"
                          >
                            <span className="material-symbols-outlined text-[14px]">
                              block
                            </span>
                            Blocked
                          </span>
                        </>
                      )}
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      navigate(
                        `/projects/${item.projectId}`,
                      )
                    }
                    className="truncate text-left text-xs font-medium text-on-surface-variant transition hover:text-primary"
                  >
                    {project?.name ??
                      `Project ${item.projectId}`}
                  </button>

                  <div
                    className={[
                      'text-xs',
                      item.dueDate &&
                      formatDueDate(
                        item.dueDate,
                      ).startsWith('Overdue')
                        ? 'font-medium text-error'
                        : 'text-on-surface-variant',
                    ].join(' ')}
                  >
                    {formatDueDate(item.dueDate)}
                  </div>

                  <select
                    value={item.status}
                    disabled={
                      updatingItemId === item.id
                    }
                    onChange={(event) =>
                      void handleStatusChange(
                        item,
                        event.target
                          .value as ApiWorkItemStatus,
                      )
                    }
                    aria-label={`Status for ${item.title}`}
                    className="h-9 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm font-medium text-on-surface outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:cursor-wait disabled:opacity-50"
                  >
                    {Object.entries(
                      statusLabels,
                    ).map(([value, label]) => (
                      <option
                        key={value}
                        value={value}
                      >
                        {label}
                      </option>
                    ))}
                  </select>
                </article>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}
