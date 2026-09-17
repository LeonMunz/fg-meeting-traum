import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { useNavigate } from 'react-router'

import { ApiError } from '../../api/client'
import type {
  ApiPersonalWorkItem,
  ApiWorkItemStatus,
} from '../../api/types'
import { listMyWork } from '../../api/work-items'
import { useResearchGroup } from '../research-group/useResearchGroup'

type GroupFilter = 'all' | number

/**
 * Personal cross-project My Work List View.
 *
 * The page renders exactly what the canonical personal endpoint
 * `GET /api/me/work-items/` returns — one request, no per-Project or
 * per-Research-Group requests. Project / Research Group names and the
 * concrete project-local status (`statusName`) come from the payload
 * itself, so no Project configuration is fetched for display.
 *
 * The row presentation mirrors the Project Work Items List View
 * conventions (54px rows, 11px column labels, semantic status glyphs,
 * due-date labels, hover treatment) expanded to personal
 * cross-project scope. The Work Item type is shown as the concrete
 * project-local `typeName` from the payload — a display name, not a
 * semantic discriminator: no Task/Epic/Milestone/Deliverable kind or
 * type-specific icon is inferred from it. The neutral canonical Work
 * Item icon remains (a semantic type icon mapping is future work).
 *
 * Opening a row navigates to the item's canonical Project Work Items
 * surface (the same navigation the cross-project Home rows use); the
 * drawer and its mutations stay in their owning feature.
 */

// ── Presentation helpers ────────────────────────────────

// Semantic status styling (glyph + tone) per fixed category — the same
// mapping the Project Work Items List renders. The visible text is the
// concrete `statusName`, never the category.
const statusGlyphs: Record<
  ApiWorkItemStatus,
  {
    glyph: string
    className: string
  }
> = {
  todo: {
    glyph: '○',
    className: 'text-text-muted',
  },
  in_progress: {
    glyph: '◐',
    className: 'text-interaction-primary',
  },
  review: {
    glyph: '●',
    className: 'text-text',
  },
  done: {
    glyph: '✓',
    className: 'text-success-text',
  },
}

/** Neutral generic Work Item icon (see page doc). The concrete
 * `typeName` is rendered as row text; the icon intentionally stays
 * neutral — no semantic type icon mapping exists yet. */
const WORK_ITEM_TYPE_ICON = 'assignment'

function getWorkItemDueFields(
  dueDate: string | null,
) {
  if (!dueDate) {
    return {
      dueInDays: null,
      dueLabel: null,
    }
  }

  const [year, month, day] =
    dueDate.split('-').map(Number)

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return {
      dueInDays: null,
      dueLabel: null,
    }
  }

  const targetDate = new Date(
    year,
    month - 1,
    day,
  )

  const now = new Date()

  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  )

  const dueInDays = Math.round(
    (targetDate.getTime() -
      today.getTime()) /
      86_400_000,
  )

  const dueLabel =
    dueInDays === 0
      ? 'Today'
      : dueInDays === 1
        ? 'Tomorrow'
        : new Intl.DateTimeFormat('en', {
            month: 'short',
            day: 'numeric',
          }).format(targetDate)

  return {
    dueInDays,
    dueLabel,
  }
}

// Due-cell convention of the Project Work Items List: completed items
// show '—', overdue items show 'Nd overdue' with attention tone,
// otherwise the short date label — '—' when absent.
function getDueDisplay(
  statusCategory: ApiWorkItemStatus,
  due: {
    dueInDays: number | null
    dueLabel: string | null
  },
) {
  if (statusCategory === 'done') {
    return {
      label: '—',
      attention: false,
    }
  }

  if (due.dueInDays != null && due.dueInDays < 0) {
    return {
      label: `${Math.abs(due.dueInDays)}d overdue`,
      attention: true,
    }
  }

  return {
    label: due.dueLabel ?? '—',
    attention: false,
  }
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

const gridColumns =
  'xl:grid-cols-[minmax(320px,1fr)_160px_220px_110px]'

export function MyWorkPage() {
  const navigate = useNavigate()
  const { groups } = useResearchGroup()

  const [items, setItems] = useState<
    ApiPersonalWorkItem[]
  >([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<
    string | null
  >(null)
  const [groupFilter, setGroupFilter] =
    useState<GroupFilter>('all')

  const loadMyWork = useCallback(
    async () => {
      setLoading(true)
      setError(null)

      try {
        // One canonical request — the personal projection across
        // every accessible Project and Research Group. The response
        // replaces the previous state wholesale; the API result is
        // authoritative (removed assignments disappear, no local
        // stale copy is merged or retained).
        setItems(await listMyWork())
      } catch (loadError) {
        setItems([])
        setError(
          getErrorMessage(
            loadError,
            'My Work could not be loaded.',
          ),
        )
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    void loadMyWork()
  }, [loadMyWork])

  // Server ordering (`created_at`, ID tie-break) is authoritative.
  // The single established presentation rule: completed items render
  // last — a stable partition, so backend relative order is
  // preserved within each group.
  const orderedItems = useMemo(() => {
    const active = items.filter(
      (item) => item.statusCategory !== 'done',
    )
    const completed = items.filter(
      (item) => item.statusCategory === 'done',
    )

    return [...active, ...completed]
  }, [items])

  const visibleItems = useMemo(
    () =>
      groupFilter === 'all'
        ? orderedItems
        : orderedItems.filter(
            (item) =>
              item.researchGroupId ===
              groupFilter,
          ),
    [groupFilter, orderedItems],
  )

  function openItem(
    item: ApiPersonalWorkItem,
  ) {
    // The item's canonical Project Work Items surface — the same
    // canonical interaction the cross-project Home rows use.
    navigate(
      `/projects/${item.projectId}/work-items`,
    )
  }

  return (
    <div className="w-full px-6 py-8 lg:px-8 lg:py-10 xl:px-10">
      {/* flex-wrap + a shrinkable select: in the narrow content column
       * (fixed 240px sidebar margin) the title block and the group
       * filter must not force the document wider than the viewport —
       * the filter wraps below the title and shrinks with it. At
       * desktop widths there is ample space and nothing wraps. */}
      <header className="flex flex-wrap items-start justify-between gap-6">
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold tracking-tight text-on-surface">
            My Work
          </h1>

          <p className="mt-1.5 text-sm leading-6 text-on-surface-variant">
            Everything currently assigned to you.
          </p>
        </div>

        {groups.length > 1 && (
          <select
            value={groupFilter}
            onChange={(event) => {
              const value =
                event.target.value

              setGroupFilter(
                value === 'all'
                  ? 'all'
                  : Number(value),
              )
            }}
            aria-label="Filter by research group"
            className="h-10 min-w-0 max-w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
          >
            <option value="all">
              All research groups
            </option>

            {groups.map((group) => (
              <option
                key={group.id}
                value={group.id}
              >
                {group.name}
              </option>
            ))}
          </select>
        )}
      </header>

      {loading ? (
        <div className="mt-8 flex min-h-64 items-center justify-center rounded-xl border border-outline-variant bg-surface-container-lowest">
          <span className="material-symbols-outlined mr-2 animate-spin text-[20px] text-on-surface-variant">
            refresh
          </span>

          <span className="text-sm text-on-surface-variant">
            Loading your work…
          </span>
        </div>
      ) : error ? (
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
            {error}
          </p>

          <button
            type="button"
            onClick={() =>
              void loadMyWork()
            }
            className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg border border-outline-variant px-4 text-sm font-semibold text-on-surface transition hover:bg-surface-container-low"
          >
            <span className="material-symbols-outlined text-[18px]">
              refresh
            </span>
            Try again
          </button>
        </div>
      ) : visibleItems.length === 0 ? (
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
        <section className="mt-8 overflow-hidden rounded-xl border border-border-structural bg-surface-quiet shadow-sm">
          <div
            className={[
              'hidden h-9 items-center gap-x-4 border-b border-border-structural/40 px-6',
              gridColumns,
              'xl:grid',
            ].join(' ')}
          >
            <div className="text-[11px] font-normal text-text-work-faded-75">
              Work item
            </div>

            <div className="text-[11px] font-normal text-text-work-faded-75">
              Status
            </div>

            <div className="text-[11px] font-normal text-text-work-faded-75">
              Project
            </div>

            <div className="text-[11px] font-normal text-text-work-faded-75">
              Due
            </div>
          </div>

          <div>
            {visibleItems.map((item, index) => {
              const status =
                statusGlyphs[item.statusCategory] ??
                statusGlyphs.todo

              const due = getDueDisplay(
                item.statusCategory,
                getWorkItemDueFields(
                  item.dueDate,
                ),
              )

              return (
                <div
                  key={item.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Open ${item.title}`}
                  data-work-item-id={item.id}
                  onClick={() =>
                    openItem(item)
                  }
                  onKeyDown={(event) => {
                    if (
                      event.key === 'Enter' ||
                      event.key === ' '
                    ) {
                      event.preventDefault()
                      openItem(item)
                    }
                  }}
                  className={[
                    'grid cursor-pointer gap-x-4 gap-y-1.5 px-6 py-3.5 transition-colors hover:bg-work-surface-hover',
                    gridColumns,
                    'xl:h-[54px] xl:items-center xl:py-0',
                    index > 0
                      ? 'border-t border-border-structural/25'
                      : '',
                  ].join(' ')}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      title={item.typeName}
                      aria-label={item.typeName}
                      className="material-symbols-outlined shrink-0 text-[15px] text-text-work-faded-80"
                    >
                      {WORK_ITEM_TYPE_ICON}
                    </span>

                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-work-content-text">
                        {item.title}
                      </span>

                      <span className="block truncate text-[11px] text-text-work-faded-75">
                        {item.typeName}
                      </span>
                    </span>

                    {item.blockedReason && (
                      <span
                        title={
                          item.blockedReason
                        }
                        className="shrink-0 text-[11px] font-medium text-work-item-error"
                      >
                        · Blocked
                      </span>
                    )}
                  </div>

                  <div
                    className={[
                      'flex min-w-0 items-center gap-2 text-xs font-normal',
                      status.className,
                    ].join(' ')}
                  >
                    <span
                      aria-hidden="true"
                      className="inline-flex w-4 shrink-0 justify-center text-[15px] leading-none"
                    >
                      {status.glyph}
                    </span>

                    <span className="truncate text-work-content-muted">
                      {item.statusName}
                    </span>
                  </div>

                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium text-work-content-muted">
                      {item.projectName}
                    </div>

                    <div className="truncate text-[11px] text-text-work-faded-75">
                      {item.researchGroupName}
                    </div>
                  </div>

                  <div
                    className={[
                      'text-xs',
                      due.attention
                        ? 'font-medium text-work-item-error'
                        : 'font-normal text-work-content-muted',
                    ].join(' ')}
                  >
                    {due.label}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}
