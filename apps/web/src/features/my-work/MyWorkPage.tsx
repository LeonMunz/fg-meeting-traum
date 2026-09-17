import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useNavigate } from 'react-router'

import { ApiError } from '../../api/client'
import type {
  ApiMyWorkPreferences,
  ApiMyWorkViewMode,
  ApiPersonalWorkItem,
  ApiProject,
  ApiProjectWorkItemConfiguration,
  ApiUpdateWorkItemInput,
  ApiWorkItemStatus,
  ApiWorkItemType,
  ApiWorkItemTypeKind,
} from '../../api/types'
import {
  createWorkItem,
  deleteWorkItem,
  listMyWork,
  listProjectWorkItems,
  transitionWorkItemStatus,
  updateWorkItem,
} from '../../api/work-items'
import {
  fetchMyWorkPreferences,
  updateMyWorkPreferences,
} from '../../api/my-work-preferences'
import {
  getProject,
  getProjectWorkItemConfiguration,
  listProjectMemberships,
} from '../../api/projects'
import { useSession } from '../../api/useSession'
import { useResearchGroup } from '../research-group/useResearchGroup'
import type { WorkItemFormInput } from '../projects/WorkItemDrawer'
import { WorkItemDeleteDialog } from '../projects/workItemDelete'
import {
  buildCreateWorkItemInput,
  resolveWorkItemType,
} from '../projects/workItemMapping'

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
 * Kanban (Board view): four fixed semantic columns (Todo / In progress /
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
 * Kanban card presentation (the approved compact personal-board
 * visual contract): column = semantic status, icon + label = Work
 * Item type, breadcrumb = provenance (`Research Group › Project`),
 * footer = exceptions only. The type icon + secondary label are
 * driven by the machine-readable `typeKind` ONLY (task / epic /
 * milestone / deliverable; `null` = the neutral Work Item
 * presentation) — never inferred from the `typeName` display name,
 * which is always shown as the type label text. The concrete
 * `statusName` is NOT rendered on Kanban cards: the column already
 * communicates the semantic status (it stays in the data contract
 * and in the List View).
 *
 * List rows navigate to the item's canonical Project Work Items
 * surface (the same navigation the cross-project Home rows use) —
 * unchanged. Kanban CARDS open the SAME canonical WorkItemDrawer the
 * Project Work Items board mounts, in place over My Work: the URL
 * stays on /my-work and no Project board is visited. Only the
 * selected card's OWNING Project drawer context is lazy-loaded on
 * open (Project, Work Item configuration, Project memberships,
 * Project Work Items — exactly the reads the drawer contract
 * requires) — never on page load and never for other Projects; the
 * selected Work Item itself already comes from the canonical My
 * Work payload. Drawer mutations keep the canonical Project-board
 * semantics (ordinary PATCH / create / delete, never the drag
 * status transition) and every successful mutation triggers one
 * authoritative GET /api/me/work-items/ refresh.
 *
 * Persisted view mode (My Work preferences): the authenticated
 * user's preference snapshot (GET /api/me/preferences/my-work/) is
 * loaded IN PARALLEL with the Work Items and the final interactive
 * view renders only once BOTH have resolved — the persisted
 * viewMode decides Board vs List, so a persisted List preference
 * can never flash through a default Board first. Changing
 * Board/List updates the complete preference snapshot locally
 * (the not-yet-applied filter arrays are retained untouched) and
 * persists the COMPLETE snapshot after a short debounce; the
 * normalized server response is authoritative and replaces the
 * local snapshot. A failed save keeps the locally chosen mode and
 * shows a page-local non-fatal notice (no revert, no reset to
 * defaults). There is no localStorage / module-level cache: a
 * fresh authenticated mount always loads the active user's server
 * preference.
 */

// Lazy: WorkItemDrawer pulls in RichMarkdownEditor -> Tiptap/ProseMirror,
// by far the heaviest dependency graph in the app. Nothing on My Work
// needs it until a card is actually opened, so it stays out of the
// initial page bundle and is fetched on first use (the same lazy
// treatment the Project Work Items page applies).
const WorkItemDrawer = lazy(() =>
  import('../projects/WorkItemDrawer').then(
    (module) => ({
      default: module.WorkItemDrawer,
    }),
  ),
)

// The exact option shapes the canonical WorkItemDrawer contract
// consumes (mirroring the Project board's mappings).
type DrawerAssigneeOption = {
  id: string
  name: string
  initials: string
}

type DrawerParentOption = {
  id: string
  title: string
  type: ApiWorkItemType
}

// Lazy per-Project drawer context: loaded ONLY when a card of that
// Project is opened (never on page load, never for cards of other
// Projects).
type MyWorkDrawerContext = {
  project: ApiProject
  configuration: ApiProjectWorkItemConfiguration | null
  assignees: DrawerAssigneeOption[]
  parentItems: DrawerParentOption[]
}

type MyWorkDrawerState =
  | { status: 'idle' }
  | { status: 'loading'; projectId: number }
  | { status: 'error'; projectId: number; message: string }
  | {
      status: 'ready'
      projectId: number
      context: MyWorkDrawerContext
    }

// Quiet placeholder for the brief window while the selected card's
// lazy Project drawer context (and, on first open, the drawer chunk
// itself) loads. Renders the final inspector's OWN chrome — the
// same fixed-rail dimensions, surface, border, and shadow — with
// restrained pulse bars in the header and field positions, so a
// card open reads as "the drawer shell appears, then the content
// resolves inside it" and never exposes a raw white/default panel
// (the legacy surface-container-lowest token is not dark-adapted —
// it renders pure white in BOTH themes). My Work stays visible
// underneath; the data-work-item-inspector-boundary marker keeps
// the outside-click-close effect from misreading a click on the
// shell as an outside click.
function DrawerLoadingShell() {
  return (
    <div
      data-work-item-inspector-boundary="true"
      data-my-work-drawer-shell="true"
      className="fixed inset-y-0 right-0 z-40 w-full sm:w-[520px]"
    >
      <div className="flex h-full w-full flex-col border-l border-border-structural bg-surface shadow-2xl shadow-color">
        <div className="flex shrink-0 items-start justify-between gap-6 border-b border-border-structural px-7 py-5">
          <div className="min-w-0 flex-1">
            <div className="h-6 w-28 animate-pulse rounded bg-surface-hover" />

            <div className="mt-2 h-4 w-40 animate-pulse rounded bg-surface-hover" />
          </div>

          <div className="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-surface-hover" />
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-hidden px-7 py-7">
          <div className="h-3 w-24 animate-pulse rounded bg-surface-hover" />

          <div className="h-8 w-3/4 animate-pulse rounded bg-surface-hover" />

          <div className="h-24 w-full animate-pulse rounded-lg bg-surface-hover" />

          <div className="h-8 w-1/2 animate-pulse rounded bg-surface-hover" />
        </div>
      </div>
    </div>
  )
}

// Person name/initials mapping — identical to the Project board's,
// so the drawer's assignee options read the same in both places.
function getPersonName(
  firstName: string,
  lastName: string,
  username: string,
) {
  const fullName = `${firstName} ${lastName}`.trim()
  return fullName || username
}

function getPersonInitials(
  firstName: string,
  lastName: string,
  username: string,
) {
  const initials = [firstName, lastName]
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value[0]?.toUpperCase())
    .join('')

  return initials || username.slice(0, 2).toUpperCase()
}

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
 * neutral for types WITHOUT a canonical kind; the semantic type
 * icon mapping is driven by `typeKind` (WORK_TYPE_PRESENTATION). */
const WORK_ITEM_TYPE_ICON = 'assignment'

// Semantic presentation of the four fixed global columns: icon +
// written status label + count. The written label is ALWAYS visible,
// so the icon and accent reinforce the meaning — never color alone.
const COLUMN_PRESENTATION: Record<
  ApiWorkItemStatus,
  {
    icon: string
    iconClassName: string
  }
> = {
  todo: {
    icon: 'circle',
    iconClassName: 'text-work-status-todo',
  },
  in_progress: {
    icon: 'progress_activity',
    iconClassName: 'text-work-status-in-progress',
  },
  review: {
    icon: 'circle_notifications',
    iconClassName: 'text-work-status-review',
  },
  done: {
    icon: 'check_circle',
    iconClassName: 'text-work-status-done',
  },
}

// Semantic Work Item type presentation, keyed ONLY by the
// machine-readable `typeKind` — never by the `typeName` display
// string. A `typeKind` of `null` (custom / unclassified project
// type) keeps the existing neutral Work Item icon + neutral text: a
// custom type named e.g. "Epic" stays visually neutral.
const WORK_TYPE_PRESENTATION: Record<
  ApiWorkItemTypeKind,
  {
    icon: string
    iconClassName: string
    labelClassName: string
  }
> = {
  task: {
    icon: 'assignment',
    iconClassName: 'text-work-type-task',
    labelClassName: 'text-work-type-task',
  },
  epic: {
    icon: 'account_tree',
    iconClassName: 'text-work-type-epic',
    labelClassName: 'text-work-type-epic',
  },
  milestone: {
    icon: 'flag',
    iconClassName: 'text-work-type-milestone',
    labelClassName: 'text-work-type-milestone',
  },
  deliverable: {
    icon: 'deployed_code',
    iconClassName: 'text-work-type-deliverable',
    labelClassName: 'text-work-type-deliverable',
  },
}

// Neutral fallback for `typeKind === null` (custom / unclassified
// types): the existing neutral Work Item icon + tertiary text.
const NEUTRAL_WORK_TYPE_PRESENTATION = {
  icon: WORK_ITEM_TYPE_ICON,
  iconClassName: 'text-text-tertiary',
  labelClassName: 'text-text-tertiary',
}

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

// Due-date presentation for the Kanban card's exception footer —
// reuses the repository's existing date logic (getWorkItemDueFields),
// no second date interpretation. No due date (or a completed item)
// renders NOTHING; a future due date is neutral metadata; due today
// is an explicit warning; overdue is an explicit danger.
type CardDueState =
  | { kind: 'none' }
  | { kind: 'future'; label: string }
  | { kind: 'today' }
  | { kind: 'overdue'; label: string }

function getCardDueState(
  item: ApiPersonalWorkItem,
): CardDueState {
  // Completed items carry no due exception (the List keeps its
  // established '—' convention for them).
  if (item.statusCategory === 'done') {
    return { kind: 'none' }
  }

  const due =
    getWorkItemDueFields(item.dueDate)

  if (due.dueInDays == null) {
    return { kind: 'none' }
  }

  if (due.dueInDays < 0) {
    return {
      kind: 'overdue',
      label: `${Math.abs(due.dueInDays)}d overdue`,
    }
  }

  if (due.dueInDays === 0) {
    return { kind: 'today' }
  }

  return {
    kind: 'future',
    label: due.dueLabel ?? '',
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

// Debounce window for persisting a changed My Work preference
// snapshot (the repository's established 300ms user-preference
// debounce). Rapid Board/List toggles coalesce into a single PATCH
// carrying the LATEST complete snapshot.
const MY_WORK_PREFERENCES_DEBOUNCE_MS = 300

// Structural equality for two complete preference snapshots — the
// dirty check that decides whether a debounced save is owed. The
// server returns sorted ID lists and the client never reorders
// them, so element-wise comparison is exact.
function sameMyWorkPreferences(
  a: ApiMyWorkPreferences,
  b: ApiMyWorkPreferences,
): boolean {
  const sameIdList = (x: number[], y: number[]) =>
    x.length === y.length &&
    x.every((id, index) => id === y[index])

  return (
    a.viewMode === b.viewMode &&
    sameIdList(a.researchGroupIds, b.researchGroupIds) &&
    sameIdList(a.projectIds, b.projectIds) &&
    a.workItemTypes.length === b.workItemTypes.length &&
    a.workItemTypes.every(
      (kind, index) => kind === b.workItemTypes[index],
    )
  )
}

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
  const { user } = useSession()

  const [items, setItems] = useState<
    ApiPersonalWorkItem[]
  >([])
  // Starts `true`: the FIRST paint is the loading skeleton (the
  // final view — Board or List — is unknown until the persisted
  // preference snapshot has resolved, so nothing final may render
  // before the initial load starts).
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<
    string | null
  >(null)
  const [groupFilter, setGroupFilter] =
    useState<GroupFilter>('all')

  // The COMPLETE persisted My Work preference snapshot (the server
  // is the source of truth). `null` until the initial GET has
  // resolved — the final view is unknown until then, so the page
  // stays in its loading skeleton: a persisted List preference can
  // never flash through a default Board first. The viewMode is the
  // only field actively consumed in this slice; the three filter
  // arrays are retained in the snapshot (not yet applied to
  // filtering) and must survive every view-mode save untouched.
  const [preferences, setPreferences] = useState<
    ApiMyWorkPreferences | null
  >(null)

  // The last snapshot known to be persisted server-side (the initial
  // GET result or the latest successful PATCH response — always the
  // normalized server snapshot, never a local draft). The diff
  // against `preferences` is what a debounced save owes.
  const [savedPreferences, setSavedPreferences] =
    useState<ApiMyWorkPreferences | null>(null)

  // Page-local, dismissible notice for a failed preference save —
  // the established non-fatal error treatment of this page (the same
  // as the Kanban drop error). A failed save never reverts the
  // locally chosen view mode and never resets the preferences.
  const [preferenceSaveError, setPreferenceSaveError] =
    useState<string | null>(null)

  // The final view mode — consumed from the persisted preference
  // snapshot. `null` while the snapshot is unknown (initial load /
  // failed load): the page then shows its loading or error
  // treatment, never a guessed view. Switching Board/List is purely
  // presentational for the Work Item data — it never refetches
  // /api/me/work-items/, fetches Project configuration, or fetches
  // Projects / Research Groups individually.
  const view = preferences?.viewMode ?? null

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
      setPreferenceSaveError(null)

      try {
        // One canonical request — the personal projection across
        // every accessible Project and Research Group — plus the
        // authenticated user's persisted My Work preference
        // snapshot, loaded IN PARALLEL (independent GETs; neither
        // depends on the other). The final interactive view renders
        // only once BOTH have resolved: the persisted viewMode
        // decides Board vs List, so no default view can flash
        // before the preference is known. Each response replaces
        // the previous state wholesale; the API results are
        // authoritative (removed assignments disappear, no local
        // stale copy is merged or retained).
        const [
          loadedItems,
          loadedPreferences,
        ] = await Promise.all([
          listMyWork(),
          fetchMyWorkPreferences(),
        ])

        setItems(loadedItems)
        setPreferences(loadedPreferences)
        // The GET snapshot is what the server currently persists —
        // the baseline a changed local snapshot is diffed against
        // (a fresh authenticated mount always re-loads it; nothing
        // preference-related is cached across users or mounts).
        setSavedPreferences(loadedPreferences)
      } catch (loadError) {
        setItems([])
        setPreferences(null)
        setSavedPreferences(null)
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

  // Board/List switch: update the COMPLETE preference snapshot
  // locally — only `viewMode` changes, the three not-yet-applied
  // filter arrays are retained untouched — and owe a debounced save
  // of the complete snapshot (the effect below). Purely
  // presentational for the Work Item data: no /api/me/work-items/
  // refetch, no Project configuration, no Project / Research Group
  // fetch.
  const handleViewModeChange = useCallback(
    (nextMode: ApiMyWorkViewMode) => {
      if (
        preferences == null ||
        preferences.viewMode === nextMode
      ) {
        return
      }

      setPreferences({
        ...preferences,
        viewMode: nextMode,
      })
    },
    [preferences],
  )

  // Debounced persistence of the preference snapshot. Fires only
  // when the local snapshot differs from the last known-persisted
  // one — so the initial load is never "saved back", and rapid
  // Board/List toggles coalesce into a single PATCH carrying the
  // LATEST complete snapshot (the timer is reset on every change).
  // The monotonic sequence guard keeps a superseded in-flight save
  // from clobbering a newer local selection: its normalized
  // response still updates the persisted baseline, and the resulting
  // diff schedules whatever remains unsaved. On failure the locally
  // chosen mode is kept and the standard non-fatal notice is shown
  // (no revert, no reset to defaults, no retry storm — the next
  // user change schedules a fresh complete-snapshot save).
  const preferencesSaveSeqRef = useRef(0)

  useEffect(() => {
    if (
      preferences == null ||
      savedPreferences == null
    ) {
      return
    }

    if (
      sameMyWorkPreferences(
        savedPreferences,
        preferences,
      )
    ) {
      return
    }

    const seq = ++preferencesSaveSeqRef.current
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const normalized =
            await updateMyWorkPreferences(preferences)

          // The returned normalized snapshot is authoritative for
          // what is now persisted — the baseline either way (the
          // server may have dropped stale IDs; it is never assumed
          // to echo the request back unchanged).
          setSavedPreferences(normalized)

          if (seq !== preferencesSaveSeqRef.current) {
            // A newer local change superseded this save: the UI
            // keeps the newer selection.
            return
          }

          setPreferences(normalized)
          setPreferenceSaveError(null)
        } catch {
          if (seq !== preferencesSaveSeqRef.current) {
            return
          }

          // Keep the locally chosen view mode; surface the standard
          // non-fatal save notice.
          setPreferenceSaveError(
            "Couldn't save your My Work preferences.",
          )
        }
      })()
    }, MY_WORK_PREFERENCES_DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [preferences, savedPreferences])

  // ── Canonical Work Item drawer (opened in place from Kanban
  // cards) ────────────────────────────────────────────────
  // A Kanban card is a Work Item surface, not a navigation
  // shortcut: opening it selects the item and lazily resolves the
  // drawer context of its OWNING Project only, then mounts the SAME
  // canonical WorkItemDrawer the Project Work Items board uses. The
  // URL never changes and the My Work board stays rendered
  // underneath.
  const [openWorkItemId, setOpenWorkItemId] = useState<
    number | null
  >(null)
  const [drawerState, setDrawerState] = useState<MyWorkDrawerState>(
    () => ({ status: 'idle' }),
  )

  // Session cache: a Project's drawer context is loaded at most once
  // per page session (re-opening another card of the same Project is
  // instant — no duplicate requests). A failed load is never cached:
  // re-opening or Retry re-issues the reads.
  const drawerContextCacheRef = useRef<
    Record<number, MyWorkDrawerContext>
  >({})

  // Monotonic guard: only the most recent open action may resolve
  // into state (a fast card switch must never let a stale in-flight
  // load clobber the newer one).
  const drawerLoadSeqRef = useRef(0)

  // The selected drawer item, re-resolved against the AUTHORITATIVE
  // My Work payload after every refresh — exactly how the Project
  // board derives its selected item from its Work Item collection:
  // an item no longer returned by the endpoint (assignment removed,
  // access lost, deleted) makes the drawer unmount on its own.
  const selectedDrawerItem = useMemo(
    () =>
      openWorkItemId == null
        ? null
        : items.find((item) => item.id === openWorkItemId) ??
          null,
    [items, openWorkItemId],
  )

  const drawerContext =
    drawerState.status === 'ready'
      ? drawerState.context
      : null

  // Canonical Project-board rule: a viewer or an archived Project
  // renders the drawer read-only. (Assignees are always owner/member,
  // so in practice the archived state is the live case.)
  const drawerReadOnly =
    drawerContext != null &&
    (drawerContext.project.archivedAt !== null ||
      drawerContext.project.currentUserRole === 'viewer')

  const drawerReadOnlyMessage =
    drawerContext?.project.archivedAt != null
      ? 'Archived Projects are read-only. Restore the Project first.'
      : 'A viewer cannot edit Work Items.'

  const closeDrawer = useCallback(() => {
    setOpenWorkItemId(null)
    setDrawerState({ status: 'idle' })
  }, [])

  // Lazy drawer-context load for ONE selected Project: exactly the
  // Project-specific reads the canonical drawer contract requires
  // (the same four reads the Project Work Items page issues),
  // scoped to the selected card's owning Project. The selected
  // Work Item itself is NOT fetched — the canonical My Work payload
  // already carries the full ApiWorkItem shape (ApiPersonalWorkItem
  // extends it).
  const loadDrawerContext = useCallback(
    (projectId: number) => {
      const seq = ++drawerLoadSeqRef.current

      setDrawerState({ status: 'loading', projectId })

      void (async () => {
        try {
          const [
            project,
            configuration,
            memberships,
            projectItems,
          ] = await Promise.all([
            getProject(projectId),
            // A failed/missing configuration degrades the drawer
            // exactly the way the Project page does (null →
            // canonical fallbacks) — it never blocks opening.
            getProjectWorkItemConfiguration(
              projectId,
            ).catch(() => null),
            listProjectMemberships(projectId),
            listProjectWorkItems(projectId),
          ])

          if (seq !== drawerLoadSeqRef.current) {
            return
          }

          const context: MyWorkDrawerContext = {
            project,
            configuration,
            // The Project board's assignee rule: owners first,
            // then name order, viewers excluded.
            assignees: memberships
              .filter((member) => member.role !== 'viewer')
              .map((member) => ({
                id: String(member.user.id),
                name: getPersonName(
                  member.user.firstName,
                  member.user.lastName,
                  member.user.username,
                ),
                initials: getPersonInitials(
                  member.user.firstName,
                  member.user.lastName,
                  member.user.username,
                ),
              }))
              .sort((a, b) => {
                const aIsOwner =
                  memberships.find(
                    (m) =>
                      String(m.user.id) === a.id,
                  )?.role === 'owner'
                const bIsOwner =
                  memberships.find(
                    (m) =>
                      String(m.user.id) === b.id,
                  )?.role === 'owner'

                if (aIsOwner !== bIsOwner) {
                  return aIsOwner ? -1 : 1
                }

                return a.name.localeCompare(b.name)
              }),
            parentItems: projectItems.map(
              (item) => ({
                id: String(item.id),
                title: item.title,
                type: resolveWorkItemType(
                  item.typeDefinitionId,
                  configuration,
                ),
              }),
            ),
          }

          drawerContextCacheRef.current[projectId] =
            context
          setDrawerState({
            status: 'ready',
            projectId,
            context,
          })
        } catch (error) {
          if (seq !== drawerLoadSeqRef.current) {
            return
          }

          // Failure stays page-local: no navigation, the board
          // underneath is untouched, and Retry / re-open
          // re-issues the reads.
          setDrawerState({
            status: 'error',
            projectId,
            message: getErrorMessage(
              error,
              'The Work Item context could not be loaded.',
            ),
          })
        }
      })()
    },
    [],
  )

  // Normal card click / Enter / Space: select the item, lazily
  // resolve its owning Project context (unless already cached this
  // session), and open the drawer. Never navigates.
  const openWorkItemCard = useCallback(
    (item: ApiPersonalWorkItem) => {
      setOpenWorkItemId(item.id)

      const cached =
        drawerContextCacheRef.current[item.projectId]

      if (cached) {
        setDrawerState({
          status: 'ready',
          projectId: item.projectId,
          context: cached,
        })
        return
      }

      loadDrawerContext(item.projectId)
    },
    [loadDrawerContext],
  )

  // Contextual-selection close: while the drawer is open over My
  // Work, any click landing outside both the drawer itself and every
  // canonical Work Item target (Kanban cards / List rows — all
  // marked data-work-item-id) closes it. The List/Kanban switch
  // carries data-work-item-inspector-keep-open so switching views
  // keeps the drawer open on the SAME selected Work Item — the
  // identical boundary semantics the Project Work Items page
  // applies. Capture phase (see the Project page's equivalent
  // effect) so the boundary check always sees the DOM as actually
  // clicked. Native HTML5 drag never dispatches a trailing click, so
  // drag/drop can neither open nor close the drawer.
  useEffect(() => {
    if (
      selectedDrawerItem == null ||
      drawerState.status !== 'ready'
    ) {
      return
    }

    function handleDocumentClickCapture(
      event: MouseEvent,
    ) {
      const target = event.target

      if (!(target instanceof Element)) {
        return
      }

      if (
        target.closest(
          '[data-work-item-inspector-boundary]',
        )
      ) {
        return
      }

      if (target.closest('[data-work-item-id]')) {
        return
      }

      if (
        target.closest(
          '[data-work-item-inspector-keep-open]',
        )
      ) {
        return
      }

      setOpenWorkItemId(null)
      setDrawerState({ status: 'idle' })
    }

    document.addEventListener(
      'click',
      handleDocumentClickCapture,
      true,
    )

    return () => {
      document.removeEventListener(
        'click',
        handleDocumentClickCapture,
        true,
      )
    }
  }, [selectedDrawerItem, drawerState.status])

  // ── Drawer mutations: canonical Project-board semantics ──
  // The drawer edits through the ordinary Work Item API (PATCH /
  // create / delete) — the drag-specific transition-status
  // operation is NEVER substituted for ordinary drawer editing.
  // My Work itself is reconciled by ONE authoritative, silent
  // refetch after each successful mutation (the same mechanism the
  // Kanban drop uses): the refetched payload decides the card's new
  // title / due / status / presence — no manually synchronized
  // second copy.

  // Single, page-level Work Item deletion confirmation — the same
  // shared dialog + flow the Project board uses.
  const [workItemDeleteTarget, setWorkItemDeleteTarget] =
    useState<number | null>(null)
  const [isDeletingWorkItem, setIsDeletingWorkItem] =
    useState(false)
  const [deleteWorkItemError, setDeleteWorkItemError] =
    useState<string | null>(null)

  const handleDrawerCreateWorkItem = useCallback(
    async (input: WorkItemFormInput) => {
      if (drawerReadOnly) {
        throw new Error(drawerReadOnlyMessage)
      }

      const projectId = drawerContext?.project.id

      if (projectId == null || !Number.isInteger(projectId)) {
        throw new Error('Invalid Project ID.')
      }

      await createWorkItem(
        projectId,
        buildCreateWorkItemInput(input),
      )

      await refreshMyWork()
    },
    [
      drawerContext,
      drawerReadOnly,
      drawerReadOnlyMessage,
      refreshMyWork,
    ],
  )

  const handleDrawerPatchWorkItem = useCallback(
    async (
      workItemId: number,
      patch: ApiUpdateWorkItemInput,
    ) => {
      if (drawerReadOnly) {
        throw new Error(drawerReadOnlyMessage)
      }

      if (
        !Number.isInteger(workItemId) ||
        patch.assigneeIds?.some(
          (id) => !Number.isInteger(id),
        )
      ) {
        throw new Error('Invalid Work Item or assignee ID.')
      }

      if (
        patch.parentId != null &&
        !Number.isInteger(patch.parentId)
      ) {
        throw new Error('Invalid parent Work Item ID.')
      }

      // Ordinary canonical PATCH (Project-board semantics,
      // including the server-side reposition-to-end behavior).
      await updateWorkItem(workItemId, patch)

      // Authoritative My Work refresh: the refetched payload — not
      // the mutation response — updates the card underneath.
      await refreshMyWork()
    },
    [
      drawerReadOnly,
      drawerReadOnlyMessage,
      refreshMyWork,
    ],
  )

  const handleDrawerDeleteWorkItem = useCallback(
    async (workItemId: number) => {
      if (drawerReadOnly) {
        throw new Error(drawerReadOnlyMessage)
      }

      if (!Number.isInteger(workItemId)) {
        throw new Error('Invalid Work Item ID.')
      }

      setIsDeletingWorkItem(true)
      setDeleteWorkItemError(null)

      try {
        await deleteWorkItem(workItemId)
      } catch (error) {
        // Failure: keep the item visible and surface the error in
        // the shared confirmation dialog (the drawer stays open).
        const message = getErrorMessage(
          error,
          'Work item could not be deleted.',
        )

        setDeleteWorkItemError(message)
        throw new Error(message)
      }

      await refreshMyWork()
      setWorkItemDeleteTarget(null)
    },
    [
      drawerReadOnly,
      drawerReadOnlyMessage,
      refreshMyWork,
    ],
  )

  const requestWorkItemDelete = useCallback(
    (workItemId: number) => {
      setDeleteWorkItemError(null)
      setWorkItemDeleteTarget(workItemId)
    },
    [],
  )

  const cancelWorkItemDelete = useCallback(() => {
    if (isDeletingWorkItem) {
      return
    }

    setWorkItemDeleteTarget(null)
  }, [isDeletingWorkItem])

  const confirmWorkItemDelete = useCallback(async () => {
    if (isDeletingWorkItem || workItemDeleteTarget == null) {
      return
    }

    const targetId = workItemDeleteTarget

    try {
      await handleDrawerDeleteWorkItem(targetId)
    } catch {
      // Already surfaced via setDeleteWorkItemError.
    } finally {
      setIsDeletingWorkItem(false)
    }
  }, [
    isDeletingWorkItem,
    workItemDeleteTarget,
    handleDrawerDeleteWorkItem,
  ])

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

  // Themed board skeleton: the final board's OWN geometry — the
  // same transparent canvas region (no outer panel), the same
  // four-column grid, the same column min-height, and card-shaped
  // pulse bars at the card min-height — with restrained pulse bars
  // (the app's established skeleton convention). It occupies the
  // final content region from the first paint, so the load never
  // exposes a raw white/default panel and the board resolves in
  // place with no layout shift. It is the ONLY thing rendered
  // while the Work Items and the persisted preference snapshot
  // resolve: the final view is unknown until the preference is
  // known, so no Board (or List) can flash before hydration.
  const boardSkeleton = (
    <section
      aria-busy="true"
      data-my-work-board-skeleton="true"
      className="mt-6"
    >
      <span className="sr-only">
        Loading your work…
      </span>

      <div className="overflow-x-auto">
        <div
          className="grid min-w-max items-start gap-3"
          style={{
            gridTemplateColumns: `repeat(${GLOBAL_STATUS_COLUMNS.length}, minmax(260px, 1fr))`,
          }}
        >
          {GLOBAL_STATUS_COLUMNS.map(
            (column) => (
              <div
                key={column.value}
                data-my-work-skeleton-column="true"
                className="flex min-h-[max(520px,calc(100vh-245px))] flex-col rounded-md bg-work-lane-surface px-2 pb-4"
              >
                <div className="mb-1 flex h-10 items-center border-b border-work-lane-divider px-1">
                  <span
                    aria-hidden="true"
                    className={`material-symbols-outlined shrink-0 text-[14px] opacity-60 ${COLUMN_PRESENTATION[column.value].iconClassName}`}
                  >
                    {COLUMN_PRESENTATION[column.value].icon}
                  </span>

                  <div className="ml-1.5 h-3 w-20 animate-pulse rounded bg-surface-hover" />
                </div>

                <div className="flex flex-col gap-2">
                  <div className="h-[88px] animate-pulse rounded-md bg-surface-hover" />

                  <div className="h-[88px] animate-pulse rounded-md bg-surface-hover" />
                </div>
              </div>
            ),
          )}
        </div>
      </div>
    </section>
  )

  return (
    <div className="w-full px-6 py-8 lg:px-8 lg:py-10 xl:px-10">
      {/* Content max width ~1440px, centered: at wide viewports the
       * board keeps its comfortable column width instead of stretching
       * across the whole window. */}
      <div className="mx-auto w-full max-w-[1440px]">
        {/* flex-wrap + a shrinkable select: in the narrow content column
         * (fixed 240px sidebar margin) the title block and the group
         * filter must not force the document wider than the viewport —
         * the filter wraps below the title and shrinks with it. At
         * desktop widths there is ample space and nothing wraps. */}
        <header className="flex flex-wrap items-start justify-between gap-6">
          <div className="min-w-0">
            <h1 className="text-[28px] font-semibold leading-[34px] tracking-[-0.015em] text-text">
              My Work
            </h1>

            <p className="mt-1 text-[12px] font-normal leading-[18px] text-text-muted">
              Everything currently assigned to you.
            </p>
          </div>

          {/* Controls: the group filter (only with more than one group)
           *  and the presentation-only Board/List switch. Grouped so the
           *  title stays left and the controls wrap together below it in
           *  the narrow column without forcing the document wider. */}
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
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
                className="h-8 w-[196px] min-w-0 max-w-full cursor-pointer rounded border border-border-subtle bg-surface-quiet pl-2.5 pr-[30px] text-[13px] font-medium text-text outline-none transition focus:border-focus focus:ring-2 focus:ring-focus/20"
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

            {/* Board/List switch — same segmented control pattern as the
             *  Project Work Items view switch. Presentation-only for the
             *  Work Item data (no refetch, no Project configuration);
             *  the chosen mode is persisted as part of the complete
             *  personal preference snapshot (debounced). The pressed
             *  state reflects the persisted preference. Each button
             *  exposes its name and pressed state. */}
            <div
              role="group"
              aria-label="My Work view"
              className="inline-flex h-8 max-w-full flex-wrap items-center rounded-[5px] border border-border-structural bg-segmented-bg p-0.5"
            >
              <button
                type="button"
                aria-pressed={view === 'board'}
                data-work-item-inspector-keep-open="true"
                onClick={() =>
                  handleViewModeChange('board')
                }
                className={[
                  'inline-flex h-[26px] items-center gap-1.5 rounded px-[9px] text-xs font-medium transition',
                  view === 'board'
                    ? 'bg-segmented-selected text-segmented-selected-text'
                    : 'text-work-content-muted hover:text-work-content-text',
                ].join(' ')}
              >
                <span
                  aria-hidden="true"
                  className="material-symbols-outlined text-[14px]"
                >
                  view_kanban
                </span>
                Board
              </button>

              <button
                type="button"
                aria-pressed={view === 'list'}
                data-work-item-inspector-keep-open="true"
                onClick={() =>
                  handleViewModeChange('list')
                }
                className={[
                  'inline-flex h-[26px] items-center gap-1.5 rounded px-[9px] text-xs font-medium transition',
                  view === 'list'
                    ? 'bg-segmented-selected text-segmented-selected-text'
                    : 'text-work-content-muted hover:text-work-content-text',
                ].join(' ')}
              >
                <span
                  aria-hidden="true"
                  className="material-symbols-outlined text-[14px]"
                >
                  view_list
                </span>
                List
              </button>
            </div>
          </div>

        </header>

      {/* Non-fatal preference save failure: the established
       * page-local dismissible error treatment (the same as the
       * Kanban drop error). The locally chosen view mode is KEPT —
       * no revert, no reset to defaults, no page-level fatal
       * error. */}
      {preferenceSaveError !== null && (
        <div
          role="alert"
          className="mt-4 flex items-start gap-2.5 rounded-md border border-work-item-error-border bg-work-item-error-bg px-4 py-3 text-sm text-work-item-error"
        >
          <span
            aria-hidden="true"
            className="material-symbols-outlined mt-0.5 text-[18px]"
          >
            error
          </span>

          <p className="flex-1">
            {preferenceSaveError}
          </p>

          <button
            type="button"
            onClick={() =>
              setPreferenceSaveError(null)
            }
            className="shrink-0 text-xs font-semibold text-work-item-error underline-offset-2 hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {loading ? boardSkeleton : error ? (
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
      ) : view == null ? (
        // Defensive only: the final view is unknown until the
        // preference snapshot resolves — keep the loading
        // treatment. Unreachable in practice: the snapshot and
        // the loading flag resolve in one batched update.
        boardSkeleton
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
      ) : view === 'board' ? (
        <MyWorkBoard
          columns={kanbanColumns}
          onOpen={openWorkItemCard}
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
        <section className="mt-6 overflow-hidden rounded-xl border border-border-structural bg-surface-quiet shadow-sm">
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

      {/* The SAME canonical WorkItemDrawer the Project Work Items
       * board mounts — opened in place over My Work. The URL stays
       * on /my-work; only the selected card's owning Project
       * context was lazy-loaded. */}
      {selectedDrawerItem != null &&
        drawerState.status === 'ready' &&
        drawerContext != null && (
          <Suspense fallback={<DrawerLoadingShell />}>
            <WorkItemDrawer
              open={true}
              mode="edit"
              projectName={
                drawerContext.project.name
              }
              item={selectedDrawerItem}
              readOnly={drawerReadOnly}
              currentUserId={
                user ? user.id : null
              }
              workItemConfiguration={
                drawerContext.configuration
              }
              assignees={
                drawerContext.assignees
              }
              parentItems={
                drawerContext.parentItems
              }
              onClose={closeDrawer}
              onCreate={
                handleDrawerCreateWorkItem
              }
              onPatch={
                handleDrawerPatchWorkItem
              }
              onDelete={
                handleDrawerDeleteWorkItem
              }
              onRequestDelete={
                requestWorkItemDelete
              }
            />
          </Suspense>
        )}

      {/* Lazy drawer-context still resolving: the established
       * drawer loading treatment — My Work stays rendered
       * underneath and the page never navigates. */}
      {selectedDrawerItem != null &&
        drawerState.status === 'loading' &&
        <DrawerLoadingShell />}

      {/* Lazy drawer-context failure: stays on /my-work with the
       * established page-local error pattern — Retry re-issues the
       * reads, Dismiss returns to the board. Never navigates. */}
      {selectedDrawerItem != null &&
        drawerState.status === 'error' && (
          <div
            role="alert"
            className="fixed inset-y-0 right-0 z-40 flex w-full flex-col items-start gap-3 overflow-y-auto border-l border-outline-variant bg-surface-container-lowest p-6 shadow-2xl sm:w-[520px]"
          >
            <span
              aria-hidden="true"
              className="material-symbols-outlined text-[26px] text-error"
            >
              cloud_off
            </span>

            <h2 className="text-base font-semibold text-on-surface">
              Work item context couldn't be
              loaded
            </h2>

            <p className="text-sm text-on-surface-variant">
              {drawerState.message}
            </p>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  loadDrawerContext(
                    drawerState.projectId,
                  )
                }
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-outline-variant bg-surface px-4 text-sm font-semibold text-on-surface transition hover:bg-surface-container-low"
              >
                <span
                  aria-hidden="true"
                  className="material-symbols-outlined text-[18px]"
                >
                  refresh
                </span>
                Retry
              </button>

              <button
                type="button"
                onClick={closeDrawer}
                className="inline-flex h-9 items-center rounded-lg px-4 text-sm font-semibold text-on-surface-variant transition hover:bg-surface-container-low"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

      {/* Single, page-level deletion confirmation — the same
       * shared dialog the Project board uses. */}
      {workItemDeleteTarget !== null && (
        <WorkItemDeleteDialog
          open={true}
          deleting={isDeletingWorkItem}
          error={deleteWorkItemError}
          onCancel={cancelWorkItemDelete}
          onConfirm={() =>
            void confirmWorkItemDelete()
          }
        />
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
 * project-local definition for is a valid target — the lane itself
 * takes a subtle accent tint plus a 1px inset ring (no standalone
 * dropzone); the item's own category and categories without a
 * target are unavailable (quiet dim, and the browser drop is
 * refused because `dragover` is not accepted). No decoration exists
 * when no drag is active. Dropping issues exactly one canonical
 * status mutation and one authoritative My Work refetch — no global
 * card ordering, no within-column reordering, no `boardPosition`.
 * At narrow widths the board scrolls horizontally inside its own
 * region — the document itself never overflows.
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

  return (
    // The board renders directly on the page canvas: NO outer
    // panel (no shared background, border, radius, or shadow) — the
    // columns and cards provide the visual structure. The
    // horizontal-scroll wrapper stays for narrow layouts but is
    // visually transparent; the document itself never overflows.
    <section className="mt-6">
      {statusDropError && (
        <div
          role="alert"
          className="mb-3 flex items-start gap-2.5 rounded-md border border-work-item-error-border bg-work-item-error-bg px-4 py-3 text-sm text-work-item-error"
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

      <div className="overflow-x-auto">
        <div
          className="grid min-w-max items-start gap-3"
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
            }

            const handleColumnDrop = (
              event: React.DragEvent,
            ) => {
              event.preventDefault()

              const droppedId =
                event.dataTransfer.getData(
                  'text/plain',
                )

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
                onDrop={handleColumnDrop}
                className={[
                  'flex min-h-[max(520px,calc(100vh-245px))] min-w-0 flex-col rounded-md px-2 pb-4 transition-colors',
                  isValidDropTarget
                    ? 'bg-work-lane-drag-tint ring-1 ring-inset ring-work-lane-drag-ring'
                    : 'bg-work-lane-surface',
                  isUnavailable ? 'opacity-60' : '',
                ].join(' ')}
              >
              {/* Column header: icon + WRITTEN status + count. The
                 written label is always visible, so the semantic
                 icon/accent is reinforcement — never color alone.
                 The count is quiet plain text (no pill). The header
                 sits inside the lane on the lane surface with a
                 horizontal bottom divider — no header background,
                 no lane border. */}
              <div className="mb-1 flex h-10 shrink-0 items-center border-b border-work-lane-divider px-1">
                <span
                  aria-hidden="true"
                  className={`material-symbols-outlined shrink-0 text-[14px] ${COLUMN_PRESENTATION[column.value].iconClassName}`}
                >
                  {COLUMN_PRESENTATION[column.value].icon}
                </span>

                <h2 className="ml-1.5 text-[12px] font-semibold leading-[18px] text-text">
                  {column.label}
                </h2>

                <span className="ml-[5px] text-[10px] font-medium leading-[14px] text-control-disabled-foreground">
                  {column.items.length}
                </span>
              </div>

              {/* Empty columns stay visible (header + count) with no
                  decorative placeholder; the lane surface extends
                  below the last card. */}
              <div className="flex flex-col gap-2">
                {column.items.length === 0 ? null : (
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
                      onDragEnd={onDragEnd}
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
 * Compact personal-board card with exactly four information
 * groups, in order:
 *   1. type icon (semantic per `typeKind`; neutral for a null kind)
 *      + title
 *   2. the concrete project-local `typeName` as a secondary label
 *   3. provenance breadcrumb `Research Group › Project` (one line)
 *   4. exception footer — ONLY when an exception exists (blocked
 *      and/or a due date): due state and/or Blocked, icon + text.
 *
 * The concrete `statusName` is NOT rendered: the column already
 * communicates the semantic status, so a card inside "Todo" must
 * not also say "Todo" (the status stays in the data contract and in
 * the List View). No assignee UI.
 *
 * Opening (click / Enter / Space) calls `onOpen`, which opens the
 * canonical WorkItemDrawer IN PLACE over My Work (the List rows keep
 * their navigation behavior — see the page doc).
 *
 * Drag reuses the Project Work Items Board card's native HTML5
 * convention: the whole card is `draggable` (grab cursor),
 * `dragstart` carries the Work Item id on `dataTransfer`, and the
 * drag ghost is browser-native (the card dims to ~0.85 and takes an
 * accent border while the drag is active). A native HTML5 drag never
 * dispatches a trailing "click", so click/Enter/Space keep opening
 * the item exactly as before. A pending mutation shows restrained
 * feedback (dimmed + progress cursor) without moving the card
 * optimistically.
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
  // Type presentation from the machine-readable kind ONLY — a null
  // kind stays neutral, whatever the type is named.
  const typePresentation =
    item.typeKind != null
      ? WORK_TYPE_PRESENTATION[item.typeKind]
      : NEUTRAL_WORK_TYPE_PRESENTATION

  const dueState = getCardDueState(item)

  // The exception footer renders ONLY when at least one
  // exception-relevant property exists; a normal item keeps its
  // density (no reserved empty footer).
  const hasExceptions =
    item.blockedReason != null ||
    dueState.kind !== 'none'

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
        // Functional card surface, 1px subtle border, no shadow.
        // Hover = slightly raised surface + stronger border (no
        // lift/scale animation). Transitions: background/border only,
        // ~120ms. Keyboard focus gets a real focus outline.
        'min-h-[88px] rounded-md border bg-work-card px-3 py-2.5 transition-[background-color,border-color] duration-120',
        'hover:border-border-default hover:bg-work-card-hover',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
        dragging
          ? 'border-accent opacity-[0.85]'
          : pendingMove
            ? 'cursor-progress border-work-card-border opacity-60'
            : 'cursor-grab border-work-card-border active:cursor-grabbing',
      ].join(' ')}
    >
      {/* 1. Type + title — the icon is the semantic type
          (shape + color), the title dominates. */}
      <div className="flex items-start gap-2">
        <span
          aria-hidden="true"
          className={`material-symbols-outlined w-4 shrink-0 text-[16px] ${typePresentation.iconClassName}`}
        >
          {typePresentation.icon}
        </span>

        <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-[18px] text-text">
          {item.title}
        </h3>
      </div>

      {/* 2. Type label — the concrete project-local name, indented
          under the title. Same semantic color as the icon (neutral
          for a null kind); identifiable by shape + text + color,
          never color alone. */}
      <div className={`mt-[3px] truncate pl-6 text-[10px] font-medium leading-[14px] ${typePresentation.labelClassName}`}>
        {item.typeName}
      </div>

      {/* 3. Provenance breadcrumb: Research Group › Project (group
          first). One line with truncation; the native tooltip
          carries the complete string. */}
      <div
        className="mt-2 flex min-w-0 items-center pl-6 text-[10px] leading-[15px]"
        title={`${item.researchGroupName} › ${item.projectName}`}
      >
        <span className="min-w-0 truncate text-text-tertiary">
          {item.researchGroupName}
        </span>

        <span
          aria-hidden="true"
          className="shrink-0 text-control-disabled-foreground"
        >
          {' › '}
        </span>

        <span className="min-w-0 truncate font-medium text-text-muted">
          {item.projectName}
        </span>
      </div>

      {/* 4. Exception footer — only when an exception exists.
          Icon + text (never color alone); blocked and due state may
          coexist. */}
      {hasExceptions && (
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-3 border-t border-work-lane-divider pt-[7px]">
          {item.blockedReason != null && (
            <span
              title={item.blockedReason}
              className="flex items-center gap-1 text-[10px] font-medium leading-[15px] text-work-exception-warning"
            >
              <span
                aria-hidden="true"
                className="material-symbols-outlined text-[13px]"
              >
                block
              </span>
              Blocked
            </span>
          )}

          {dueState.kind === 'overdue' && (
            <span className="flex items-center gap-1 text-[10px] font-medium leading-[15px] text-work-exception-danger">
              <span
                aria-hidden="true"
                className="material-symbols-outlined text-[13px]"
              >
                warning
              </span>
              {dueState.label}
            </span>
          )}

          {dueState.kind === 'today' && (
            <span className="flex items-center gap-1 text-[10px] font-medium leading-[15px] text-work-exception-warning">
              <span
                aria-hidden="true"
                className="material-symbols-outlined text-[13px]"
              >
                event
              </span>
              Due today
            </span>
          )}

          {dueState.kind === 'future' && (
            <span className="flex items-center gap-1 text-[10px] font-medium leading-[15px] text-text-muted">
              <span
                aria-hidden="true"
                className="material-symbols-outlined text-[13px]"
              >
                event
              </span>
              {dueState.label}
            </span>
          )}
        </div>
      )}
    </article>
  )
}
