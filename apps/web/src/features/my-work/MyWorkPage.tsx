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
import {
  listMyWork,
  transitionWorkItemStatus,
} from '../../api/work-items'
import { useResearchGroup } from '../research-group/useResearchGroup'

type GroupFilter = 'all' | number

/**
 * Personal cross-project My Work (List + Kanban).
 *
 * The page renders exactly what the canonical personal endpoint
 * `GET /api/me/work-items/` returns — one request, no per-Project or
 * per-Research-Group requests. Project / Research Group names and the
 * concrete project-local status (`statusName`) come from the payload
 * itself, so no Project configuration is fetched for display. Both the
 * List and the Kanban render the SAME canonical payload; switching
 * views is presentation-only and never refetches.
 *
 * List: the row presentation mirrors the Project Work Items List View
 * conventions (54px rows, 11px column labels, semantic status glyphs,
 * due-date labels, hover treatment) expanded to personal
 * cross-project scope.
 *
 * Kanban (default): four fixed semantic columns (Todo / In progress /
 * Review / Done) grouped SOLELY by `statusCategory`, preserving the
 * canonical API order within each column. Cross-category drag/drop
 * moves a card to the concrete project-local status resolved by that
 * item's own `statusTargets` (at most one target per semantic
 * category, derived read-only from the item's Project): exactly one
 * canonical Work Item status mutation is issued, then the board
 * re-renders the authoritative refetched payload. The item's current
 * category is never a mutation target and a category without a
 * target is not a drop destination. No global card ordering exists,
 * no within-column reordering is supported, and no My Work-specific
 * status or position state is introduced.
 *
 * The Work Item type is shown as the concrete project-local `typeName`
 * from the payload — a display name, not a semantic discriminator: no
 * Task/Epic/Milestone/Deliverable kind or type-specific icon is
 * inferred from it. The neutral canonical Work Item icon remains (a
 * semantic type icon mapping is future work).
 *
 * Opening a row / card navigates to the item's canonical Project Work
 * Items surface (the same navigation the cross-project Home rows use);
 * the drawer and its mutations stay in their owning feature.
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

// Presentation-only personal view. No persistence (no localStorage /
// URL query / backend preference) — a reload returns to the default
// Kanban. Both views render the SAME canonical payload.
type MyWorkView = 'kanban' | 'list'

// Fixed global semantic columns for the personal Kanban. Grouping is
// by the Work Item's `statusCategory` only (a fixed domain attribute
// of its concrete StatusDefinition) — never by the concrete statusName,
// the statusDefinitionId, boardPosition, Project, or Research Group.
const GLOBAL_STATUS_COLUMNS: Array<{
  value: ApiWorkItemStatus
  label: string
}> = [
  { value: 'todo', label: 'Todo' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'review', label: 'Review' },
  { value: 'done', label: 'Done' },
]

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

  // Presentation-only view switch — see MyWorkView. Switching between
  // List and Kanban is purely presentational: it never refetches
  // /api/me/work-items/, fetches Project configuration, or fetches
  // Projects / Research Groups individually.
  const [view, setView] = useState<MyWorkView>('kanban')

  // Kanban drag state (native HTML5 drag-and-drop — the same
  // mechanism the Project Work Items Board uses). Only the Kanban is
  // draggable; the List stays behaviorally unchanged. `draggedItemId`
  // drives the valid/unavailable drop-target presentation while a
  // drag is active; nothing is decorated when no drag is active.
  const [draggedItemId, setDraggedItemId] = useState<
    number | null
  >(null)

  // Cards with an in-flight status mutation: duplicate drops of the
  // same card are ignored and the card shows restrained pending
  // feedback while the mutation + authoritative refetch run.
  const [pendingMoveItemIds, setPendingMoveItemIds] = useState<
    ReadonlySet<number>
  >(() => new Set())

  // The established board error pattern for a failed drop mutation
  // (page-local, dismissible — no global notification architecture).
  const [statusDropError, setStatusDropError] = useState<
    string | null
  >(null)

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

  // Authoritative, SILENT refetch of the canonical personal
  // projection, used after a successful Kanban status mutation.
  // Unlike `loadMyWork` it does not toggle the page-level loading
  // state — the rest of the board is preserved while the server
  // result replaces the payload.
  const refreshMyWork = useCallback(async () => {
    try {
      setItems(await listMyWork())
      setError(null)
    } catch {
      // The mutation already succeeded; keep the last authoritative
      // payload (no optimistic state was introduced, so nothing
      // false is rendered) — the next load reconciles.
    }
  }, [])

  // Cross-category Kanban drop: mutates the SAME canonical Work
  // Item through the canonical status-only transition
  // (`POST /api/work-items/{id}/transition-status/`) — the
  // dedicated status change that preserves the item's project-local
  // `board_position` (no Project-board reposition, no sibling
  // renumbering). The ordinary status PATCH is NOT used here: it
  // would reposition the item to the end of the target column. The
  // board then renders the authoritative refetched My Work payload.
  const handleKanbanDrop = useCallback(
    async (
      itemId: number,
      category: ApiWorkItemStatus,
    ) => {
      const item = items.find(
        (candidate) => candidate.id === itemId,
      )

      // A drop into the item's CURRENT category is a no-op by
      // contract: this board has no within-column reordering, so no
      // mutation and no refetch.
      if (!item || item.statusCategory === category) {
        return
      }

      // The concrete target comes ONLY from the item's
      // statusTargets (its Project's first active status definition
      // in the target category). No target → not a valid drop: no
      // mutation, no refetch, no fallback status is invented and no
      // status is chosen by name.
      const target = item.statusTargets.find(
        (candidate) =>
          candidate.statusCategory === category,
      )

      if (!target) {
        return
      }

      // At most one in-flight mutation per card: a second drop of
      // the same card while the first is pending is ignored.
      if (pendingMoveItemIds.has(itemId)) {
        return
      }

      setPendingMoveItemIds((current) =>
        new Set(current).add(itemId),
      )
      setStatusDropError(null)

      try {
        // Only the concrete target statusDefinitionId is sent —
        // never boardPosition, never an insertion anchor, never any
        // My Work ordering state (no global card ordering exists).
        await transitionWorkItemStatus(
          itemId,
          target.statusDefinitionId,
        )

        // The backend result is authoritative: the refetched
        // payload — not local inference — decides the card's final
        // column (its returned statusCategory) and concrete
        // statusName.
        await refreshMyWork()
      } catch (mutationError) {
        // No optimistic relocation was made, so the card remains in
        // its authoritative category; expose the failure with the
        // established board error pattern and allow a retry by
        // dragging again.
        setStatusDropError(
          getErrorMessage(
            mutationError,
            'Work item could not be moved.',
          ),
        )
      } finally {
        setPendingMoveItemIds((current) => {
          const next = new Set(current)
          next.delete(itemId)
          return next
        })
      }
    },
    [items, pendingMoveItemIds, refreshMyWork],
  )

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

  // Global Kanban grouping over the SAME canonical payload. The group
  // filter applies equally. Within each column the canonical API order
  // is preserved (Array.filter keeps relative order); Project
  // `boardPosition` is never a global ordering input and no global
  // sort is introduced.
  const kanbanColumns = useMemo(() => {
    const source =
      groupFilter === 'all'
        ? items
        : items.filter(
            (item) =>
              item.researchGroupId ===
              groupFilter,
          )

    return GLOBAL_STATUS_COLUMNS.map((column) => ({
      value: column.value,
      label: column.label,
      items: source.filter(
        (item) =>
          item.statusCategory === column.value,
      ),
    }))
  }, [groupFilter, items])

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

        {/* Controls: the group filter (only with more than one group)
         *  and the presentation-only List/Kanban switch. Grouped so the
         *  title stays left and the controls wrap together below it in
         *  the narrow column without forcing the document wider. */}
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-3">
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

          {/* List/Kanban switch — same segmented control pattern as the
           *  Project Work Items view switch. Presentation-only: it does
           *  not refetch, fetch Project configuration, or persist. Each
           *  button exposes its name and pressed state. */}
          <div
            role="group"
            aria-label="My Work view"
            className="inline-flex max-w-full flex-wrap rounded-lg border border-border-structural bg-segmented-bg p-1"
          >
            <button
              type="button"
              aria-pressed={view === 'kanban'}
              onClick={() => setView('kanban')}
              className={[
                'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition',
                view === 'kanban'
                  ? 'bg-segmented-selected text-segmented-selected-text shadow-sm'
                  : 'text-work-content-muted hover:text-work-content-text',
              ].join(' ')}
            >
              <span
                aria-hidden="true"
                className="material-symbols-outlined text-[17px]"
              >
                view_kanban
              </span>
              Kanban
            </button>

            <button
              type="button"
              aria-pressed={view === 'list'}
              onClick={() => setView('list')}
              className={[
                'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition',
                view === 'list'
                  ? 'bg-segmented-selected text-segmented-selected-text shadow-sm'
                  : 'text-work-content-muted hover:text-work-content-text',
              ].join(' ')}
            >
              <span
                aria-hidden="true"
                className="material-symbols-outlined text-[17px]"
              >
                view_list
              </span>
              List
            </button>
          </div>
        </div>

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
      ) : view === 'kanban' ? (
        <MyWorkBoard
          columns={kanbanColumns}
          onOpen={openItem}
          draggedItemId={draggedItemId}
          pendingItemIds={pendingMoveItemIds}
          statusDropError={statusDropError}
          onDismissStatusDropError={() =>
            setStatusDropError(null)
          }
          onDragStart={(itemId) =>
            setDraggedItemId(itemId)
          }
          onDragEnd={() =>
            setDraggedItemId(null)
          }
          onDrop={(itemId, category) =>
            void handleKanbanDrop(
              itemId,
              category,
            )
          }
        />
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


/**
 * Global My Work Kanban with cross-category drag/drop.
 *
 * Four fixed semantic columns (Todo / In progress / Review / Done)
 * rendered over the SAME canonical `GET /api/me/work-items/` payload
 * the List renders. Grouping is by `statusCategory` only; within a
 * column the canonical API order is preserved.
 *
 * Drag/drop reuses the Project Work Items Board's native HTML5
 * mechanism (draggable card, column drop zones, `dataTransfer` item
 * id). While a drag is active, each column presents its DROP
 * AVAILABILITY for that specific dragged item: a different category
 * that the item's `statusTargets` resolves to a concrete
 * project-local definition for is a valid target (quiet ring,
 * emphasized on hover — the Project Board's drop-target language);
 * the item's own category and categories without a target are
 * unavailable (quiet dim, and the browser drop is refused because
 * `dragover` is not accepted). No decoration exists when no drag is
 * active. Dropping issues exactly one canonical status mutation and
 * one authoritative My Work refetch — no global card ordering, no
 * within-column reordering, no `boardPosition`. At narrow widths the
 * board scrolls horizontally inside its own region — the document
 * itself never overflows.
 */
function MyWorkBoard({
  columns,
  onOpen,
  draggedItemId,
  pendingItemIds,
  statusDropError,
  onDismissStatusDropError,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  columns: Array<{
    value: ApiWorkItemStatus
    label: string
    items: ApiPersonalWorkItem[]
  }>
  onOpen: (item: ApiPersonalWorkItem) => void
  draggedItemId: number | null
  pendingItemIds: ReadonlySet<number>
  statusDropError: string | null
  onDismissStatusDropError: () => void
  onDragStart: (itemId: number) => void
  onDragEnd: () => void
  onDrop: (
    itemId: number,
    category: ApiWorkItemStatus,
  ) => void
}) {
  // The dragged item, looked up in the SAME canonical payload the
  // board renders — its `statusTargets` (not any status name) decide
  // which columns are valid drop destinations for this drag. A card
  // with a pending mutation offers no valid targets: its in-flight
  // mutation is the only thing that may move it.
  const draggedItem = useMemo(() => {
    if (draggedItemId == null) {
      return null
    }

    if (pendingItemIds.has(draggedItemId)) {
      return null
    }

    return (
      columns
        .flatMap((column) => column.items)
        .find(
          (item) => item.id === draggedItemId,
        ) ?? null
    )
  }, [columns, draggedItemId, pendingItemIds])

  // The column currently hovered by a valid drag (pure UI state,
  // cleared on drop/drag-end).
  const [dragOverColumn, setDragOverColumn] = useState<
    ApiWorkItemStatus | null
  >(null)

  return (
    <section className="mt-8 overflow-hidden rounded-xl border border-border-structural bg-surface-quiet shadow-sm">
      {statusDropError && (
        <div
          role="alert"
          className="flex items-start gap-2.5 border-b border-work-item-error-border bg-work-item-error-bg px-6 py-3 text-sm text-work-item-error"
        >
          <span
            aria-hidden="true"
            className="material-symbols-outlined mt-0.5 text-[18px]"
          >
            error
          </span>

          <p className="flex-1">{statusDropError}</p>

          <button
            type="button"
            onClick={onDismissStatusDropError}
            className="shrink-0 text-xs font-semibold text-work-item-error underline-offset-2 hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="overflow-x-auto bg-workspace">
        <div
          className="grid min-w-max gap-3 p-4"
          style={{
            gridTemplateColumns: `repeat(${columns.length}, minmax(260px, 1fr))`,
          }}
        >
          {columns.map((column) => {
            // Drop availability for the ACTIVE drag. The current
            // category is never a mutation target (no within-column
            // reordering exists here), and a category the item's
            // statusTargets do not cover is unavailable — the board
            // never invents a fallback status.
            const isSameCategory =
              draggedItem?.statusCategory ===
              column.value
            const hasStatusTarget =
              draggedItem?.statusTargets.some(
                (target) =>
                  target.statusCategory ===
                  column.value,
              ) ?? false
            const isValidDropTarget =
              draggedItem != null &&
              !isSameCategory &&
              hasStatusTarget
            const isDragOver =
              isValidDropTarget &&
              dragOverColumn === column.value
            const isUnavailable =
              draggedItem != null &&
              !isValidDropTarget

            const handleColumnDragOver = (
              event: React.DragEvent,
            ) => {
              if (!isValidDropTarget) {
                // NOT preventing the default makes the browser
                // refuse the drop — the card returns to its own
                // column and no mutation can occur.
                return
              }

              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'

              if (dragOverColumn !== column.value) {
                setDragOverColumn(column.value)
              }
            }

            const handleColumnDragLeave = (
              event: React.DragEvent,
            ) => {
              if (
                event.currentTarget.contains(
                  event.relatedTarget as
                    | Node
                    | null,
                )
              ) {
                return
              }

              setDragOverColumn((current) =>
                current === column.value
                  ? null
                  : current,
              )
            }

            const handleColumnDrop = (
              event: React.DragEvent,
            ) => {
              event.preventDefault()

              const droppedId =
                event.dataTransfer.getData(
                  'text/plain',
                )
              setDragOverColumn(null)

              const numericId = Number(droppedId)

              // Backstop: only the actively dragged item can be
              // dropped (stale/foreign payloads are ignored).
              if (
                !Number.isInteger(numericId) ||
                numericId !== draggedItemId
              ) {
                return
              }

              onDrop(numericId, column.value)
            }

            return (
              <div
                key={column.value}
                data-board-column={column.value}
                data-board-column-drop-state={
                  draggedItem == null
                    ? undefined
                    : isValidDropTarget
                      ? 'valid'
                      : 'unavailable'
                }
                onDragOver={handleColumnDragOver}
                onDragLeave={handleColumnDragLeave}
                onDrop={handleColumnDrop}
                className={[
                  'flex min-h-[26rem] min-w-0 flex-col rounded-lg transition-colors',
                  isDragOver
                    ? 'bg-drag-target-bg ring-1 ring-inset ring-drag-target-ring'
                    : isValidDropTarget
                      ? 'bg-board-column ring-1 ring-inset ring-drag-target-ring/30'
                      : isUnavailable
                        ? 'bg-board-column opacity-60'
                        : 'bg-board-column',
                ].join(' ')}
              >
              <div className="flex items-center gap-1.5 px-3 py-2.5">
                <h2 className="text-[13px] font-semibold text-work-content-text">
                  {column.label}
                </h2>

                <span className="text-xs text-text-work-faded-70">
                  {column.items.length}
                </span>
              </div>

              <div className="flex flex-1 flex-col gap-2 px-2 pb-3">
                {column.items.length === 0 ? (
                  <div className="flex min-h-10 items-center justify-center rounded-md px-2 py-3 text-[11px] text-text-work-faded-70">
                    No items
                  </div>
                ) : (
                  column.items.map((item) => (
                    <MyWorkBoardCard
                      key={item.id}
                      item={item}
                      onOpen={onOpen}
                      dragging={
                        draggedItemId === item.id
                      }
                      pendingMove={
                        pendingItemIds.has(
                          item.id,
                        )
                      }
                      onDragStart={onDragStart}
                      onDragEnd={() => {
                        setDragOverColumn(null)
                        onDragEnd()
                      }}
                    />
                  ))
                )}
              </div>
            </div>
          )
          })}
        </div>
      </div>
    </section>
  )
}

/**
 * My Work Kanban card with cross-category drag.
 *
 * Understandable without Project context: title, the concrete
 * project-local `typeName`, the concrete project-local `statusName`
 * (the column already communicates the broad state, so the concrete
 * status stays visible as detail), Project + Research Group, and the
 * due / blocked state. The neutral canonical Work Item icon is used —
 * no semantic type icon mapping. Opening uses the same canonical
 * navigation as the List (the item's Project Work Items surface).
 *
 * Drag reuses the Project Work Items Board card's native HTML5
 * convention: the whole card is `draggable` (grab cursor),
 * `dragstart` carries the Work Item id on `dataTransfer`, and the
 * drag ghost is browser-native (the card itself dims while the drag
 * is active). A native HTML5 drag never dispatches a trailing
 * "click", so click/Enter/Space keep opening the item exactly as
 * before. A pending mutation shows restrained feedback
 * (dimmed + progress cursor) without moving the card optimistically.
 */
function MyWorkBoardCard({
  item,
  onOpen,
  dragging,
  pendingMove,
  onDragStart,
  onDragEnd,
}: {
  item: ApiPersonalWorkItem
  onOpen: (item: ApiPersonalWorkItem) => void
  dragging: boolean
  pendingMove: boolean
  onDragStart: (itemId: number) => void
  onDragEnd: () => void
}) {
  const status =
    statusGlyphs[item.statusCategory] ??
    statusGlyphs.todo

  const due = getDueDisplay(
    item.statusCategory,
    getWorkItemDueFields(item.dueDate),
  )

  // Show the due value only when meaningful: a completed item or an
  // item with no due date renders '—' in the List but nothing here.
  const showDue =
    due.label != null && due.label !== '—'

  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={`Open ${item.title}`}
      data-work-item-id={item.id}
      draggable
      onClick={() => onOpen(item)}
      onKeyDown={(event) => {
        if (
          event.key === 'Enter' ||
          event.key === ' '
        ) {
          event.preventDefault()
          onOpen(item)
        }
      }}
      onDragStart={(event) => {
        event.dataTransfer.setData(
          'text/plain',
          String(item.id),
        )
        event.dataTransfer.effectAllowed = 'move'
        onDragStart(item.id)
      }}
      onDragEnd={onDragEnd}
      className={[
        'rounded-lg border bg-surface px-3 py-2.5 transition hover:bg-work-surface-hover',
        item.blockedReason
          ? 'border-work-item-error-border'
          : 'border-border-structural/50',
        dragging
          ? 'opacity-40'
          : pendingMove
            ? 'cursor-progress opacity-60'
            : 'cursor-grab active:cursor-grabbing',
      ].join(' ')}
    >
      <div className="flex items-start gap-2">
        <span
          title={item.typeName}
          aria-label={item.typeName}
          className="material-symbols-outlined mt-0.5 shrink-0 text-[15px] text-work-content-muted"
        >
          {WORK_ITEM_TYPE_ICON}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start gap-2">
            <h3 className="min-w-0 flex-1 text-sm font-semibold leading-5 text-work-content-text">
              {item.title}
            </h3>

            {item.blockedReason && (
              <span
                title={item.blockedReason}
                className="mt-0.5 shrink-0 text-[11px] font-semibold text-work-item-error"
              >
                · Blocked
              </span>
            )}
          </div>

          <div className="mt-1 truncate text-[11px] text-work-content-muted">
            {item.typeName}
          </div>
        </div>
      </div>

      <div
        className={[
          'mt-2 flex items-center gap-1.5 pl-[23px] text-xs',
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

      <div className="mt-1 flex min-w-0 items-center gap-1 pl-[23px] text-[11px] text-text-work-faded-75">
        <span className="truncate">
          {item.projectName}
        </span>

        <span
          aria-hidden="true"
          className="shrink-0"
        >
          ·
        </span>

        <span className="truncate">
          {item.researchGroupName}
        </span>
      </div>

      {showDue && (
        <div
          className={[
            'mt-1 pl-[23px] text-[11px]',
            due.attention
              ? 'font-semibold text-work-item-error'
              : 'font-normal text-work-content-muted',
          ].join(' ')}
        >
          {due.label}
        </div>
      )}
    </article>
  )
}
