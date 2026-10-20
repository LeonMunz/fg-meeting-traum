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
  ApiWorkItemTypeKind,
} from '../../api/types'
import {
  createWorkItem,
  deleteWorkItem,
  listMyWork,
  listProjectWorkItems,
  reorderMyWorkItem,
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
import type { WorkItemEventStreamStatus } from '../../api/work-item-events'
import { WORK_ITEM_CREATED_EVENT } from '../../components/layout/workItemInvalidation'
import type { WorkItemFormInput } from '../projects/WorkItemDrawer'
import {
  WorkItemActionMenuTrigger,
  WorkItemDeleteDialog,
} from '../projects/workItemDelete'
import {
  buildCreateWorkItemInput,
} from '../projects/workItemMapping'
import { WorkItemCard } from '../work-items/WorkItemCard'
import { getWorkItemDueFields } from '../work-items/workItemDue'
import {
  orderMyWorkBoardColumn,
  resolveMyWorkBoardDrop,
} from './myWorkBoardOrder'
import {
  collapseResearchGroupChips,
  filterMyWorkItemsByResearchGroup,
  formatWorkItemResultCount,
} from './myWorkGroupFilter'
import {
  filterMyWorkItemsByWorkItemType,
  sortWorkItemTypes,
  workItemTypeChips,
} from './myWorkTypeFilter'
import {
  deriveMyWorkProjectOptions,
  filterMyWorkItemsByProject,
  normalizeMyWorkProjectIdsForGroupScope,
} from './myWorkProjectFilter'
import {
  MyWorkFilterCommandMenu,
  type MyWorkFilterCommandMenuHandle,
} from './MyWorkFilterCommandMenu'
import { MyWorkRealtime } from './myWorkRealtime'

// Stable empty references so a null preference snapshot never
// allocates a fresh array each render (keeps the filter memos
// stable).
const EMPTY_RESEARCH_GROUP_IDS: readonly number[] = []
const EMPTY_PROJECT_IDS: readonly number[] = []
const EMPTY_WORK_ITEM_TYPES: readonly ApiWorkItemTypeKind[] = []

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
 * Review / Done) grouped SOLELY by `statusCategory`. Within a column,
 * explicitly positioned cards render first in `myWorkBoardPosition`
 * ascending order, then unpositioned cards in the existing canonical
 * fallback order (creation order — the API order); the List View
 * ordering is unchanged.
 *
 * Drag/drop places a card at an EXACT position: within its own column
 * or at a precise insertion point in another valid semantic column,
 * with an insertion indicator between cards. A drop resolves to the
 * one atomic My Work reorder request
 * (`POST /api/me/work-items/{id}/reorder/` with `statusCategory` +
 * `beforeWorkItemId`): a same-column drop is personal ordering only
 * (no status mutation, no history event), and a cross-column drop
 * carries the canonical status transition (the concrete target
 * resolved by the item's own `statusTargets` on the server) plus the
 * personal position in ONE transaction — the standalone
 * transition-status request is never issued for a board drag. The
 * item's current category is a valid destination (reordering only);
 * a category without a statusTarget (for a cross-column move) is not
 * a drop destination. The visible insertion point is converted into
 * an anchor over the COMPLETE loaded payload (never the filtered
 * visible list), so presentation filters never reorder hidden
 * cards. Exactly one authoritative My Work refetch follows a
 * successful move; a failed move leaves the previous visible order
 * intact with the established non-fatal error treatment. The
 * persisted ordering is the server's personal
 * `myWorkBoardPosition` state — no client-side order copy.
 *
 * Kanban card presentation: the shared `WorkItemCard`
 * (features/work-items) renders the card — the SAME component the
 * Project Work Items Board uses — so the card surface, title,
 * exception footer, and geometry are ONE cross-board contract. On
 * My Work the card shows: the title, the concrete `typeName` as
 * type TEXT, the provenance breadcrumb (`Research Group › Project`),
 * and the exception footer (Blocked and/or due state). No type
 * icon: the type text is colored by the machine-readable
 * `typeKind` ONLY (task / epic / milestone / deliverable; `null` =
 * neutral) — never inferred from the `typeName` display name. The
 * concrete `statusName` is NOT rendered on Kanban cards: the column
 * already communicates the semantic status (it stays in the data
 * contract and in the List View). The shared compact action menu
 * (the three-dot "Work item actions" / "Delete work item" — the SAME
 * `WorkItemActionMenuTrigger` + `WorkItemDeleteDialog` the Project
 * board uses) renders on a card ONLY when that item's own
 * server-derived `actionPermissions.canDelete` is true: the My Work
 * projection structurally guarantees a current owner/member
 * membership, so the payload flag (which mirrors the canonical
 * delete guard, incl. the archived-Project read-only rule) is the
 * ONLY permission input — never the open drawer's read-only state
 * (which describes the open card's Project, not the card's) and
 * never a per-Project request. A card-originated delete confirms
 * through the SAME page-level dialog + delete operation, minus the
 * drawer-context guard.
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
 * (the filter arrays are retained untouched) and
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

// Which surface requested the page-level delete confirmation:
// 'drawer' requests keep the drawer context's read-only guard (the
// drawer is open IN exactly that item's Project context); 'card'
// requests come from a board card already gated by that item's own
// server-derived actionPermissions.canDelete and must NEVER consult
// the drawer's read-only state (it describes the OPEN card's
// Project — possibly a different one — not this item's).
type WorkItemDeleteOrigin = 'drawer' | 'card'

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

/** Neutral generic Work Item icon for the My Work LIST rows. The
 * Kanban card no longer renders a type icon at all — the concrete
 * `typeName` is card text, semantically colored by the shared
 * card's machine-readable `typeKind` handling. The List keeps its
 * established neutral icon + type-name row text. */
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

/**
 * The restrained filtered-empty state: assigned work EXISTS, but the
 * active filter categories yield zero results. Deliberately
 * distinct from the "Nothing assigned to you" unfiltered empty state
 * (no illustration). "Clear filters" removes the active Research
 * Group, Project, and Work Item Type selections (the implemented
 * filter categories).
 */
function FilteredEmptyState({
  onClear,
}: {
  onClear: () => void
}) {
  return (
    <div className="mt-6 flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-outline-variant bg-surface-container-lowest px-6 py-12 text-center">
      <h2 className="text-base font-semibold text-on-surface">
        No work items match these filters.
      </h2>

      <button
        type="button"
        onClick={onClear}
        className="mt-3 text-sm font-semibold text-on-surface-variant underline-offset-2 transition hover:text-on-surface hover:underline"
      >
        Clear filters
      </button>
    </div>
  )
}

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

  // The command menu owns its transient open/view/search/focus state.
  // The handle exists only so applied-row overflow summaries can open
  // the corresponding category directly.
  const filterMenuRef = useRef<
    MyWorkFilterCommandMenuHandle | null
  >(null)

  // The COMPLETE persisted My Work preference snapshot (the server
  // is the source of truth). `null` until the initial GET has
  // resolved — the final view is unknown until then, so the page
  // stays in its loading skeleton: a persisted List preference can
  // never flash through a default Board first. The viewMode plus
  // the three implemented filter categories (researchGroupIds,
  // projectIds, workItemTypes) are actively consumed.
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

  // Cards with an in-flight board move: duplicate drops of the same
  // card are ignored while the atomic reorder request +
  // authoritative refetch run, and the card shows restrained
  // pending feedback (no optimistic relocation is made).
  const [pendingMoveItemIds, setPendingMoveItemIds] = useState<
    ReadonlySet<number>
  >(() => new Set())

  // The established board error pattern for a failed drop mutation
  // (page-local, dismissible — no global notification architecture).
  const [statusDropError, setStatusDropError] = useState<
    string | null
  >(null)

  // The established non-fatal error treatment for a failed
  // POST-MUTATION revalidation (page-local, dismissible, plus an
  // explicit retry of the authoritative refetch). The mutation
  // itself succeeded — only the revalidation failed, so the last
  // authoritative payload stays on screen (no optimistic state was
  // introduced, so nothing false is rendered).
  const [refreshError, setRefreshError] = useState<
    string | null
  >(null)

  // Monotonic request guard for GET /api/me/work-items/ (shared by
  // the initial `loadMyWork` and every `refreshMyWork`): each
  // request takes the next sequence number, and only the MOST
  // RECENT request may settle the items state — a delayed stale
  // response (success OR failure) must never overwrite a newer
  // authoritative snapshot (the same contract the Home Activity
  // rail applies to its feed).
  const itemsRequestSeq = useRef(0)
  // RT-05: a canonical items GET (the initial load or a silent
  // refetch) is in flight for the mounted surface. A realtime
  // invalidation arriving while a fetch is in flight is HELD (not
  // issued as a parallel request) and re-requested exactly once
  // when the fetch settles — so the final server state is never
  // lost and a fast event burst never floods the endpoint.
  const myWorkItemsInFlightRef = useRef(false)
  // RT-05: a realtime invalidation (a personal event or a valid
  // open handshake — RC-5) arrived while an items fetch was in
  // flight or a personal board move was pending. It is
  // re-requested exactly once when the surface is quiescent
  // again. The flag is consumed, never looped on.
  const myWorkRealtimePendingRef = useRef(false)
  // RT-05: synchronous mirror of pendingMoveItemIds for the
  // coalescing guards: an async settle callback runs before the
  // state update commits, so the ref is updated FIRST — a flush
  // never sees a just-settled move as still pending.
  const pendingMoveItemIdsRef = useRef<ReadonlySet<number>>(
    new Set(),
  )
  // RT-05: whether the mounted surface has observed at least one
  // valid open handshake. Only AFTER the first connection does a
  // non-connected state mean sync-paused — the very first
  // connection is normal startup, not a degraded mode.
  const myWorkStreamEverConnectedRef = useRef(false)
  // RT-05: the Work Item event stream connection state for the
  // mounted surface (reported by the lifecycle adapter).
  const [myWorkStreamStatus, setMyWorkStreamStatus] =
    useState<WorkItemEventStreamStatus>('idle')
  // Forward ref so loadMyWork / refreshMyWork (defined before the
  // flush callback) can settle a held invalidation without a
  // circular callback dependency.
  const flushMyWorkRealtimeInvalidationRef = useRef<() => void>(
    () => {},
  )

  const loadMyWork = useCallback(
    async () => {
      // The load takes the next list-request sequence number; a
      // delayed (stale) response must never settle the items state
      // over a newer authoritative snapshot.
      const seq = ++itemsRequestSeq.current

      myWorkItemsInFlightRef.current = true

      setLoading(true)
      setError(null)
      setPreferenceSaveError(null)
      setRefreshError(null)

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

        if (seq === itemsRequestSeq.current) {
          setItems(loadedItems)
        }
        // The preference snapshot has exactly one writer (the load
        // — a refetch never fetches it), so it applies regardless
        // of a superseding list request; keeping it out of the
        // sequence guard guarantees the final view (viewMode) is
        // known as soon as any load settles.
        setPreferences(loadedPreferences)
        // The GET snapshot is what the server currently persists —
        // the baseline a changed local snapshot is diffed against
        // (a fresh authenticated mount always re-loads it; nothing
        // preference-related is cached across users or mounts).
        setSavedPreferences(loadedPreferences)
      } catch (loadError) {
        // A superseded load's failure must not blank the payload
        // or surface the page-level error (the newer request owns
        // the state).
        if (seq === itemsRequestSeq.current) {
          setItems([])
          setPreferences(null)
          setSavedPreferences(null)
          setError(
            getErrorMessage(
              loadError,
              'My Work could not be loaded.',
            ),
          )
        }
      } finally {
        // `loadMyWork` is the only writer of the page-level
        // loading flag (a refetch never sets it), and a new load
        // can only start from the settled error state — so the
        // flag always clears here, even if a refetch superseded
        // this load's list response in the meantime.
        myWorkItemsInFlightRef.current = false
        setLoading(false)
        // RT-05: the surface is quiescent again — honor a realtime
        // invalidation (or the initial-connect handshake) held
        // while this load was in flight: exactly one follow-up
        // items fetch, coordinated AFTER the load settled, and the
        // preference snapshot above stays the load's single
        // preference read.
        flushMyWorkRealtimeInvalidationRef.current()
      }
    },
    [],
  )

  useEffect(() => {
    void loadMyWork()
  }, [loadMyWork])

  // Authoritative, SILENT refetch of the canonical personal
  // projection, used after a successful Work Item mutation (and on
  // the global Work Item creation event). Unlike `loadMyWork` it
  // does not toggle the page-level loading state — the rest of the
  // board is preserved while the server result replaces the
  // payload.
  //
  // Mutation and revalidation are handled separately: a failure
  // here NEVER undoes or re-reports the already successful
  // mutation — it surfaces as the visible, retryable
  // `refreshError` notice while the last authoritative payload
  // stays on screen. A delayed stale response — success OR
  // failure — never overwrites a newer authoritative snapshot (the
  // shared monotonic request guard). This function never throws,
  // so every call site (including the fire-and-forget
  // `WORK_ITEM_CREATED_EVENT` listener) is safe.
  const refreshMyWork = useCallback(async () => {
    const seq = ++itemsRequestSeq.current

    myWorkItemsInFlightRef.current = true

    try {
      const nextItems = await listMyWork()

      // A newer request owns the snapshot now — this response is
      // stale and must not overwrite its result.
      if (seq !== itemsRequestSeq.current) {
        return
      }

      setItems(nextItems)
      // A fresh authoritative snapshot supersedes any earlier
      // page-level load error and any earlier refresh failure.
      setError(null)
      setRefreshError(null)
    } catch (refreshFailure) {
      // A superseded (stale) failure must not surface either.
      if (seq !== itemsRequestSeq.current) {
        return
      }

      // Visible + repeatable: the notice offers an explicit retry
      // of the authoritative refetch.
      setRefreshError(
        getErrorMessage(
          refreshFailure,
          'My Work could not be refreshed.',
        ),
      )
    } finally {
      myWorkItemsInFlightRef.current = false
      // RT-05: the surface is quiescent again — honor a realtime
      // invalidation held while this fetch was in flight (exactly
      // one follow-up fetch; the flush consumes the held flag, so
      // no unbounded fetch loop is possible).
      flushMyWorkRealtimeInvalidationRef.current()
    }
  }, [])

  useEffect(() => {
    const handleWorkItemCreated = () => {
      void refreshMyWork()
    }

    window.addEventListener(
      WORK_ITEM_CREATED_EVENT,
      handleWorkItemCreated,
    )

    return () => {
      window.removeEventListener(
        WORK_ITEM_CREATED_EVENT,
        handleWorkItemCreated,
      )
    }
  }, [refreshMyWork])

  /**
   * RT-05: one realtime invalidation for the My Work surface (a
   * my_work_changed event or a valid open handshake — RC-5).
   * Requests one canonical SILENT revalidation of
   * GET /api/me/work-items/ — never a Work Item field derived
   * from the event, and never the persisted preferences.
   * Coalesced: while an items fetch is in flight or a personal
   * board move is pending, the invalidation is held
   * (myWorkRealtimePendingRef) and re-requested exactly once when
   * the surface is quiescent again — so fast event bursts yield
   * at most one in-flight plus one follow-up fetch, and a pending
   * move's position is never clobbered by a response that could
   * predate the move's commit.
   */
  const requestMyWorkRealtimeInvalidation = useCallback(() => {
    if (
      myWorkItemsInFlightRef.current ||
      pendingMoveItemIdsRef.current.size > 0
    ) {
      myWorkRealtimePendingRef.current = true
      return
    }

    void refreshMyWork()
  }, [refreshMyWork])

  /**
   * RT-05: called when an items fetch settles or a pending board
   * move settles (success or failure — a failed move's error
   * surface is not itself a revalidation, so a held invalidation
   * must still be honored). Flushes the held invalidation with
   * exactly one canonical revalidation, and only while the
   * surface is quiescent again.
   */
  const flushMyWorkRealtimeInvalidation = useCallback(() => {
    if (!myWorkRealtimePendingRef.current) {
      return
    }

    if (
      myWorkItemsInFlightRef.current ||
      pendingMoveItemIdsRef.current.size > 0
    ) {
      return
    }

    myWorkRealtimePendingRef.current = false
    void refreshMyWork()
  }, [refreshMyWork])

  flushMyWorkRealtimeInvalidationRef.current =
    flushMyWorkRealtimeInvalidation

  // RT-05: the stream connection state (reported by the lifecycle
  // adapter). Only a LOST-then-recovering stream is presented — a
  // subdued, non-blocking sync-paused line under the page heading.
  const handleMyWorkStreamStatus = useCallback(
    (status: WorkItemEventStreamStatus) => {
      if (status === 'connected') {
        myWorkStreamEverConnectedRef.current = true
      }

      setMyWorkStreamStatus(status)
    },
    [],
  )

  // RT-05: degraded-mode presentation — a valid open handshake was
  // observed before, and the stream is now down (native or
  // controlled reconnection in flight).
  const myWorkSyncPaused =
    myWorkStreamEverConnectedRef.current &&
    (myWorkStreamStatus === 'reconnecting' ||
      myWorkStreamStatus === 'connecting')

  // Board/List switch: update the COMPLETE preference snapshot
  // locally — only `viewMode` changes, the three filter arrays are
  // retained untouched (the implemented categories keep their
  // selections) — and owe a
  // debounced save
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

  // Monotonic guard: only the most recent drawer intent (card open
  // — including a cache hit — or close) may resolve into state, so
  // a fast card switch or a close must never let a stale in-flight
  // load clobber the newer selection or resurrect a closed
  // drawer.
  const drawerLoadSeqRef = useRef(0)

  // The Project of the currently selected drawer item, tracked
  // synchronously by the selection mutators below: an in-flight
  // context response is identity-checked against it at apply time
  // (a response for Project X must never resolve into a selection
  // of Project Y). The render re-checks the same identity before
  // mounting the drawer.
  const selectedDrawerProjectIdRef = useRef<number | null>(null)

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
    // Closing is a new intent: an in-flight context load must not
    // restore a closed drawer (or leave its context in state) when
    // it resolves late.
    drawerLoadSeqRef.current += 1
    selectedDrawerProjectIdRef.current = null
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

          // Project identity: this context may only resolve into
          // drawer state for the Project of the currently selected
          // Work Item (the render re-checks the same identity
          // before mounting the drawer).
          if (
            selectedDrawerProjectIdRef.current !==
            projectId
          ) {
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

          // A late failure for a Project that is no longer
          // selected must not surface as the drawer error.
          if (
            selectedDrawerProjectIdRef.current !==
            projectId
          ) {
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

      // A new selection is a new intent: it invalidates every
      // older in-flight context load — INCLUDING a cache hit, where
      // no new request (and thus no seq bump inside
      // loadDrawerContext) would supersede a stale response.
      drawerLoadSeqRef.current += 1
      selectedDrawerProjectIdRef.current =
        item.projectId

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
  //
  // Same gesture-origin rule as the Project page's equivalent
  // effect: the dismissal decision also looks at where the pointer
  // gesture ORIGINATED. The latest primary pointerdown records
  // whether it started inside the inspector boundary, and the
  // following click consumes that record — a click whose gesture
  // started inside the inspector (e.g. a text selection dragged
  // across the drawer's edge and released outside, whose click
  // target the browser places at the down/up common ancestor,
  // outside) never dismisses. The record is overwritten by every
  // primary pointerdown and consumed by every click, so a later
  // fresh outside press+click dismisses exactly as before — no
  // stale suppression survives.
  useEffect(() => {
    if (
      selectedDrawerItem == null ||
      drawerState.status !== 'ready'
    ) {
      return
    }

    // Origin record of the latest pointer gesture (see the
    // gesture-origin rule above). A plain closure variable: it
    // lives exactly as long as this listener registration and is
    // rebuilt fresh whenever the effect re-registers.
    let gestureStartedInsideInspector = false

    function handleDocumentPointerDownCapture(
      event: PointerEvent,
    ) {
      // Only primary-button gestures produce a trailing `click`;
      // right/middle presses never touch the record.
      if (event.button !== 0) {
        return
      }

      gestureStartedInsideInspector =
        event.target instanceof Element &&
        event.target.closest(
          '[data-work-item-inspector-boundary]',
        ) !== null
    }

    function handleDocumentClickCapture(
      event: MouseEvent,
    ) {
      // Consume this click's gesture origin FIRST, unconditionally:
      // a real click always follows exactly one primary pointerdown
      // (already recorded above), and a click with no pointerdown
      // (e.g. keyboard activation) must never inherit a stale
      // record from an unrelated earlier gesture.
      const gestureStartedInside =
        gestureStartedInsideInspector
      gestureStartedInsideInspector = false

      const target = event.target

      if (!(target instanceof Element)) {
        return
      }

      // The gesture ORIGINATED inside the inspector (e.g. a text
      // selection started in the drawer and dragged outside): this
      // is an inside interaction, never an outside dismissal —
      // regardless of where the click's target landed.
      if (gestureStartedInside) {
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

      closeDrawer()
    }

    document.addEventListener(
      'pointerdown',
      handleDocumentPointerDownCapture,
      true,
    )

    document.addEventListener(
      'click',
      handleDocumentClickCapture,
      true,
    )

    return () => {
      document.removeEventListener(
        'pointerdown',
        handleDocumentPointerDownCapture,
        true,
      )

      document.removeEventListener(
        'click',
        handleDocumentClickCapture,
        true,
      )
    }
  }, [
    selectedDrawerItem,
    drawerState.status,
    closeDrawer,
  ])

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
  // shared dialog + flow the Project board uses. The origin
  // (drawer vs. board card) decides whether the confirm path keeps
  // the drawer-context read-only guard (see WorkItemDeleteOrigin).
  const [workItemDeleteTarget, setWorkItemDeleteTarget] =
    useState<{
      workItemId: number
      origin: WorkItemDeleteOrigin
    } | null>(null)
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

  // Core delete operation shared by BOTH request origins: the
  // canonical delete API call + ONE authoritative My Work refresh
  // (the refetched payload decides the card's presence). NO
  // drawer-context gate here: `drawerReadOnly` describes the OPEN
  // card's Project, not the deleted item's Project, so it must
  // never gate a card-originated delete (and the drawer-originated
  // path applies its own guard below).
  const performWorkItemDelete = useCallback(
    async (workItemId: number) => {
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
    [refreshMyWork],
  )

  const handleDrawerDeleteWorkItem = useCallback(
    async (workItemId: number) => {
      // Drawer-originated deletes keep the drawer context's
      // read-only guard: the drawer is open IN exactly this item's
      // Project context, so its state IS the item's permission
      // context.
      if (drawerReadOnly) {
        throw new Error(drawerReadOnlyMessage)
      }

      await performWorkItemDelete(workItemId)
    },
    [
      drawerReadOnly,
      drawerReadOnlyMessage,
      performWorkItemDelete,
    ],
  )

  const requestWorkItemDelete = useCallback(
    (
      workItemId: number,
      origin: WorkItemDeleteOrigin = 'drawer',
    ) => {
      setDeleteWorkItemError(null)
      setWorkItemDeleteTarget({
        workItemId,
        origin,
      })
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

    const {
      workItemId: targetId,
      origin,
    } = workItemDeleteTarget

    try {
      if (origin === 'drawer') {
        await handleDrawerDeleteWorkItem(targetId)
      } else {
        // Card-originated: the item's own server-derived
        // actionPermissions.canDelete gated the menu; the server
        // remains the authoritative final gate.
        await performWorkItemDelete(targetId)
      }
    } catch {
      // Already surfaced via setDeleteWorkItemError.
    } finally {
      setIsDeletingWorkItem(false)
    }
  }, [
    isDeletingWorkItem,
    workItemDeleteTarget,
    handleDrawerDeleteWorkItem,
    performWorkItemDelete,
  ])

  // Server ordering (`created_at`, ID tie-break) is authoritative.
  // The single established presentation rule: completed items render
  // last — a stable partition, so backend relative order is
  // preserved within each group.
  // ── Persisted filter categories (Research Group + Project +
  // Work Item Type) ──
  // The single source of truth for all three selections is the
  // persisted preference snapshot (`researchGroupIds` /
  // `projectIds` / `workItemTypes`).
  const selectedGroupIds =
    preferences?.researchGroupIds ??
    EMPTY_RESEARCH_GROUP_IDS
  const hasGroupFilter =
    selectedGroupIds.length > 0

  const selectedProjectIds =
    preferences?.projectIds ??
    EMPTY_PROJECT_IDS
  const hasProjectFilter =
    selectedProjectIds.length > 0

  const selectedTypeKinds =
    preferences?.workItemTypes ??
    EMPTY_WORK_ITEM_TYPES
  const hasTypeFilter =
    selectedTypeKinds.length > 0

  const hasActiveFilter =
    hasGroupFilter || hasProjectFilter || hasTypeFilter

  // The canonical accessible Research Group id → name map, used to
  // label applied chips (NEVER derived from Work Items — a selected
  // group may hold zero assigned items and still be named here).
  const groupNameById = useMemo(() => {
    const map = new Map<number, string>()
    for (const group of groups) {
      map.set(group.id, group.name)
    }
    return map
  }, [groups])

  // The canonical project id → name map from the LOADED My Work
  // payload, used to label applied chips (a selected Project that
  // no longer appears in the payload keeps filtering but has no
  // resolvable chip label — the same treatment an unknown group
  // gets).
  const projectNameById = useMemo(() => {
    const map = new Map<number, string>()
    for (const item of items) {
      if (!map.has(item.projectId)) {
        map.set(item.projectId, item.projectName)
      }
    }
    return map
  }, [items])

  // The Projects option set derived from the loaded canonical
  // payload (presentation-only — no request of any kind), narrowed
  // to the active Research Group scope.
  const projectOptions = useMemo(
    () =>
      deriveMyWorkProjectOptions(
        items,
        selectedGroupIds,
      ),
    [items, selectedGroupIds],
  )

  // PRESENTATION-ONLY category filters over the canonical payload —
  // never a refetch of /api/me/work-items/. Within each category the
  // selections combine OR; the active categories combine
  // RESTRICTIVELY (an item must satisfy every active category).
  // Empty selection = no restriction (the exact reference is
  // preserved for memo stability). The Work Item Type category
  // matches the machine-readable `typeKind` only — a custom type's
  // display name is never consulted, and a `typeKind` of `null`
  // (custom / unclassified) never matches any selected kind.
  const filteredItems = useMemo(
    () =>
      filterMyWorkItemsByWorkItemType(
        filterMyWorkItemsByProject(
          filterMyWorkItemsByResearchGroup(
            items,
            selectedGroupIds,
          ),
          selectedProjectIds,
        ),
        selectedTypeKinds,
      ),
    [
      items,
      selectedGroupIds,
      selectedProjectIds,
      selectedTypeKinds,
    ],
  )

  // Exact-positional Kanban drop: ONE atomic My Work reorder
  // (`POST /api/me/work-items/{id}/reorder/`) — the whole operation
  // in one request. Same semantic category: personal ordering only
  // (no status mutation, no history event, Project `board_position`
  // untouched). Different category: the backend resolves the
  // concrete project-local target from the item's `statusTargets`
  // rule and applies the canonical status transition atomically
  // with the personal position — the standalone transition-status
  // request is never issued for a board drag, and the ordinary
  // status PATCH is not used either. The visible insertion point
  // (`visibleIndex` into the column's FILTERED render order) is
  // converted into `beforeWorkItemId` over the COMPLETE loaded
  // payload, so presentation filters never reorder hidden cards.
  // The board then renders the authoritative refetched My Work
  // payload — no optimistic relocation is ever made.
  const handleBoardDrop = useCallback(
    async (
      itemId: number,
      category: ApiWorkItemStatus,
      visibleIndex: number,
    ) => {
      const item = items.find(
        (candidate) => candidate.id === itemId,
      )

      if (!item) {
        return
      }

      // At most one in-flight move per card: a second drop of the
      // same card while the first is pending is ignored.
      if (pendingMoveItemIds.has(itemId)) {
        return
      }

      // Cross-column destinations are valid ONLY where the item's
      // statusTargets resolve a concrete project-local status — the
      // same gate the board uses for drop availability. No target →
      // the column cannot accept the card: no request, no fallback
      // status is invented and none is chosen by name. The current
      // category is always a valid destination (reordering only).
      if (item.statusCategory !== category) {
        const target = item.statusTargets.find(
          (candidate) =>
            candidate.statusCategory === category,
        )

        if (!target) {
          return
        }
      }

      // Exact anchor over the COMPLETE loaded payload — the
      // filtered visible list is never treated as the persisted
      // column (foundation.md Section 14b).
      const fullColumn = orderMyWorkBoardColumn(
        items,
        category,
      )
      const visibleColumn = orderMyWorkBoardColumn(
        filteredItems,
        category,
      )
      const {
        beforeWorkItemId,
        isNoOp,
      } = resolveMyWorkBoardDrop(
        category,
        item,
        fullColumn,
        visibleColumn,
        visibleIndex,
      )

      // A placement that leaves the persisted order unchanged
      // (same column, same slot — including the card's own
      // "before" gap) sends nothing: no request, no refetch.
      if (isNoOp) {
        return
      }

      const nextPendingMoves = new Set(pendingMoveItemIdsRef.current)
      nextPendingMoves.add(itemId)
      pendingMoveItemIdsRef.current = nextPendingMoves
      setPendingMoveItemIds(nextPendingMoves)
      setStatusDropError(null)

      try {
        // Exactly the two contract fields: the target column and
        // the exact anchor (null = end). Never boardPosition,
        // never a statusDefinitionId — the backend owns both the
        // target-status resolution and the personal order.
        await reorderMyWorkItem(itemId, {
          statusCategory: category,
          beforeWorkItemId,
        })

        // The server result is authoritative: the refetched
        // payload — not local inference — decides the persisted
        // order and the card's final column / concrete
        // statusName that remain on screen.
        //
        // Mutation and revalidation are handled separately:
        // `refreshMyWork` never throws, so only a FAILED MOVE can
        // reach the catch below. A failed revalidation is surfaced
        // by `refreshMyWork` itself (visible + retryable) and is
        // never reported as a failed move.
        //
        // RT-05: this move's own revalidation is the settle for
        // any realtime invalidation held while the move was
        // pending — its response postdates every change such an
        // event could name (the event was delivered before this
        // mutation's response, and this request is issued after
        // it), so the held flag is consumed with it: one fetch,
        // not two.
        myWorkRealtimePendingRef.current = false

        await refreshMyWork()
      } catch (mutationError) {
        // No optimistic relocation was made, so the previous
        // visible order is intact by construction (no false
        // order or status is left on screen); expose the failure
        // with the established board error pattern and allow a
        // retry by dragging again.
        setStatusDropError(
          getErrorMessage(
            mutationError,
            'Work item could not be moved.',
          ),
        )
      } finally {
        const nextPendingMoves = new Set(pendingMoveItemIdsRef.current)
        nextPendingMoves.delete(itemId)
        pendingMoveItemIdsRef.current = nextPendingMoves
        setPendingMoveItemIds(nextPendingMoves)
        // RT-05: the move has settled (success or failure) — honor
        // a realtime invalidation held while it was pending, if
        // the surface is quiescent again (no other move pending,
        // no fetch in flight).
        flushMyWorkRealtimeInvalidation()
      }
    },
    [
      items,
      filteredItems,
      pendingMoveItemIds,
      refreshMyWork,
      flushMyWorkRealtimeInvalidation,
    ],
  )


  // The selected groups resolved to renderable chips (id + name).
  const selectedGroupChips = useMemo(() => {
    const chips: Array<{
      id: number
      name: string
    }> = []

    for (const id of selectedGroupIds) {
      const name = groupNameById.get(id)
      if (name !== undefined) {
        chips.push({ id, name })
      }
    }

    return chips
  }, [selectedGroupIds, groupNameById])

  const collapsedChips =
    collapseResearchGroupChips(selectedGroupChips)

  // The selected Projects resolved to renderable chips (id + name).
  const selectedProjectChips = useMemo(() => {
    const chips: Array<{
      id: number
      name: string
    }> = []

    for (const id of selectedProjectIds) {
      const name = projectNameById.get(id)
      if (name !== undefined) {
        chips.push({ id, name })
      }
    }

    return chips
  }, [selectedProjectIds, projectNameById])

  // The SAME approved chip-density rule as the Research Group
  // category (up to six individual chips; above that the first two +
  // a "+N" summary) bounds the applied-filter summary in BOTH categories.
  const collapsedProjectChips =
    collapseResearchGroupChips(selectedProjectChips)

  // The selected Work Item Types resolved to renderable chips
  // (canonical label per kind, canonical kind order — never
  // derived from a Work Item's typeName), bounded by the SAME
  // approved chip-density rule.
  const selectedTypeChips = useMemo(
    () => workItemTypeChips(selectedTypeKinds),
    [selectedTypeKinds],
  )

  const collapsedTypeChips =
    collapseResearchGroupChips(selectedTypeChips)

  const resultCount = formatWorkItemResultCount(
    filteredItems.length,
  )

  // Toggle one Research Group in the persisted selection. The list is
  // kept in ascending-PK order — the exact deterministic order the
  // server returns — so the complete-snapshot dirty check stays exact.
  // A scope change can also INVALIDATE selected Projects — see the
  // normalization inside.
  const handleGroupToggle = useCallback(
    (groupId: number, checked: boolean) => {
      if (preferences == null) {
        return
      }

      const selected = new Set(
        preferences.researchGroupIds,
      )

      if (checked) {
        selected.add(groupId)
      } else {
        selected.delete(groupId)
      }

      const nextGroupIds =
        Array.from(selected).sort((a, b) => a - b)

      // The group → project dependency (canonical §14a semantics —
      // the server sanitizes the same way on every read/write): a
      // scope change that invalidates selected Projects normalizes
      // `projectIds` in the SAME snapshot update, so no impossible
      // filter state survives the change and the debounced save
      // persists the normalized snapshot.
      setPreferences({
        ...preferences,
        researchGroupIds: nextGroupIds,
        projectIds: normalizeMyWorkProjectIdsForGroupScope(
          preferences.projectIds,
          items,
          nextGroupIds,
        ),
      })
    },
    [preferences, items],
  )

  const handleRemoveGroupChip = useCallback(
    (groupId: number) => {
      handleGroupToggle(groupId, false)
    },
    [handleGroupToggle],
  )

  // The Research Groups popover "Clear" clears ONLY the Research
  // Group selection (`researchGroupIds`) — the Project selection is
  // untouched. (Clearing the group scope invalidates nothing: the
  // unrestricted scope keeps every Project selection valid.)
  const handleClearGroupFilter = useCallback(() => {
    if (preferences == null) {
      return
    }

    setPreferences({
      ...preferences,
      researchGroupIds: [],
    })
  }, [preferences])

  // The Projects popover "Clear" clears ONLY the Project selection
  // (`projectIds`) — the Research Group selection is untouched.
  const handleClearProjectFilter = useCallback(() => {
    if (preferences == null) {
      return
    }

    setPreferences({
      ...preferences,
      projectIds: [],
    })
  }, [preferences])

  // "Clear filters" (toolbar summary + filtered-empty state) clears ALL
  // THREE implemented filter categories — Research Groups, Projects,
  // and Work Item Types — in one complete snapshot. Unrelated
  // preference fields (`viewMode`) are preserved untouched.
  const handleClearFilters = useCallback(() => {
    if (preferences == null) {
      return
    }

    setPreferences({
      ...preferences,
      researchGroupIds: [],
      projectIds: [],
      workItemTypes: [],
    })
  }, [preferences])

  // Toggle one Work Item Type in the persisted selection (canonical
  // kind order, the deterministic treatment the RG / Project
  // selections get from their ascending-ID order).
  const handleTypeToggle = useCallback(
    (kind: ApiWorkItemTypeKind, checked: boolean) => {
      if (preferences == null) {
        return
      }

      const selected = new Set(
        preferences.workItemTypes,
      )

      if (checked) {
        selected.add(kind)
      } else {
        selected.delete(kind)
      }

      setPreferences({
        ...preferences,
        workItemTypes: sortWorkItemTypes(
          Array.from(selected),
        ),
      })
    },
    [preferences],
  )

  const handleRemoveTypeChip = useCallback(
    (kind: ApiWorkItemTypeKind) => {
      handleTypeToggle(kind, false)
    },
    [handleTypeToggle],
  )

  // The Work Item Types popover "Clear" clears ONLY the Work Item
  // Type selection (`workItemTypes`) — the Research Group and
  // Project selections are untouched.
  const handleClearTypeFilter = useCallback(() => {
    if (preferences == null) {
      return
    }

    setPreferences({
      ...preferences,
      workItemTypes: [],
    })
  }, [preferences])

  // Toggle one Project in the persisted selection (ascending-PK
  // order, exactly like the Research Group selection).
  const handleProjectToggle = useCallback(
    (projectId: number, checked: boolean) => {
      if (preferences == null) {
        return
      }

      const selected = new Set(
        preferences.projectIds,
      )

      if (checked) {
        selected.add(projectId)
      } else {
        selected.delete(projectId)
      }

      setPreferences({
        ...preferences,
        projectIds: Array.from(selected).sort(
          (a, b) => a - b,
        ),
      })
    },
    [preferences],
  )

  const handleRemoveProjectChip = useCallback(
    (projectId: number) => {
      handleProjectToggle(projectId, false)
    },
    [handleProjectToggle],
  )

  // Applied-row "+N" summaries open the corresponding command view;
  // the menu moves focus into that view.
  const openGroupFilter = useCallback(() => {
    filterMenuRef.current?.openCategory('research-group')
  }, [])

  const openProjectFilter = useCallback(() => {
    filterMenuRef.current?.openCategory('project')
  }, [])

  const openTypeFilter = useCallback(() => {
    filterMenuRef.current?.openCategory('work-item-type')
  }, [])

  const orderedItems = useMemo(() => {
    const active = filteredItems.filter(
      (item) => item.statusCategory !== 'done',
    )
    const completed = filteredItems.filter(
      (item) => item.statusCategory === 'done',
    )

    return [...active, ...completed]
  }, [filteredItems])

  // The List renders exactly the ordered filtered set (identical to
  // the Board's item set — switching views never changes the filter).
  const visibleItems = orderedItems

  // Global Kanban grouping over the SAME filtered payload. The group
  // filter applies equally. Within each column the PERSONAL board
  // order renders: explicitly positioned cards first
  // (`myWorkBoardPosition` ascending), then unpositioned cards in
  // the canonical fallback order (the API's creation order —
  // `orderMyWorkBoardColumn` preserves input order for the
  // unpositioned tail). Project `boardPosition` is never a global
  // ordering input; the List View keeps its own unchanged order.
  const kanbanColumns = useMemo(() => {
    return GLOBAL_STATUS_COLUMNS.map((column) => ({
      value: column.value,
      label: column.label,
      items: orderMyWorkBoardColumn(
        filteredItems,
        column.value,
      ),
    }))
  }, [filteredItems])

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
          className="grid items-start gap-3"
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
        <header>
          <h1 className="text-[28px] font-semibold leading-[34px] tracking-[-0.015em] text-text">
            My Work
          </h1>

          {/* RT-05: subdued, non-blocking sync-paused display
              (degraded mode) — shown only AFTER the stream has
              connected once, while a reconnection is in flight.
              Never for the very first connection (normal
              startup), never as a modal, toast, or loading shell:
              existing data stays visible and fully usable. */}
          {myWorkSyncPaused && (
            <p
              role="status"
              className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-work-content-muted"
            >
              <span
                aria-hidden="true"
                className="material-symbols-outlined text-[14px]"
              >
                cloud_off
              </span>
              Sync paused — reconnecting
            </p>
          )}
        </header>

        {/* One responsive toolbar: applied filters share the row with
         * the right-aligned Board/List and Filter action group when
         * space allows. At narrow widths the applied-filter summary
         * wraps below the action group; below the sm breakpoint the
         * action group itself wraps (Board/List stack, then Filter)
         * so every control stays inside the content region and never
         * overflows under the fixed Sidebar. */}
        <div
          role="toolbar"
          aria-label="My Work controls"
          className="mt-4 flex w-full flex-wrap items-center justify-end gap-x-4 gap-y-2"
        >
          {/* Applied filters are rendered ONLY while at least one
           * implemented filter category is active (an active filter
           * must never be invisible). Shows the current filtered
           * result count (after ALL active categories), the
           * selected-group chips, then the selected-Project chips,
           * then the selected-Work-Item-Type chips (each
           * density-collapsed), and a "Clear filters" action that
           * clears ALL THREE implemented categories. */}
          {hasActiveFilter && (
            <div
              role="group"
              aria-label="Applied filters"
              className="order-2 flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-2 sm:order-1 sm:w-auto sm:flex-1"
            >
              <span className="shrink-0 text-[11px] leading-4 text-text-tertiary">
                {resultCount}
              </span>

              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                {collapsedChips.chips.map((chip) => (
                  <span
                    key={chip.id}
                    title={`FG: ${chip.name}`}
                    className="flex h-6 max-w-[220px] items-center gap-1.5 rounded border border-border-subtle bg-surface-muted pl-2 pr-[7px]"
                  >
                    <span className="min-w-0 truncate text-[11px] font-medium leading-4 text-text">
                      FG: {chip.name}
                    </span>

                    <button
                      type="button"
                      aria-label={`Remove Research Group filter ${chip.name}`}
                      onClick={() =>
                        handleRemoveGroupChip(chip.id)
                      }
                      className="shrink-0 rounded text-text-tertiary transition hover:text-text focus-visible:outline-2 focus-visible:outline focus-visible:outline-focus"
                    >
                      <span
                        aria-hidden="true"
                        className="material-symbols-outlined icon-stable text-[12px]"
                      >
                        close
                      </span>
                    </button>
                  </span>
                ))}

                {collapsedChips.overflowCount != null && (
                  // Shrinkable (label truncates) so the summary chip
                  // cannot push the toolbar past the narrow column
                  // width and overflow the document.
                  <button
                    type="button"
                    onClick={openGroupFilter}
                    className="flex h-6 min-w-0 max-w-full items-center overflow-hidden text-ellipsis whitespace-nowrap rounded border border-border-subtle bg-surface-muted px-2 text-[11px] font-medium leading-4 text-text transition hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline focus-visible:outline-focus"
                  >
                    Research groups: +{collapsedChips.overflowCount}
                  </button>
                )}

                {collapsedProjectChips.chips.map((chip) => (
                  <span
                    key={`project-${chip.id}`}
                    title={`PJ: ${chip.name}`}
                    className="flex h-6 max-w-[220px] items-center gap-1.5 rounded border border-border-subtle bg-surface-muted pl-2 pr-[7px]"
                  >
                    <span className="min-w-0 truncate text-[11px] font-medium leading-4 text-text">
                      PJ: {chip.name}
                    </span>

                    <button
                      type="button"
                      aria-label={`Remove Project filter ${chip.name}`}
                      onClick={() =>
                        handleRemoveProjectChip(
                          chip.id,
                        )
                      }
                      className="shrink-0 rounded text-text-tertiary transition hover:text-text focus-visible:outline-2 focus-visible:outline focus-visible:outline-focus"
                    >
                      <span
                        aria-hidden="true"
                        className="material-symbols-outlined icon-stable text-[12px]"
                      >
                        close
                      </span>
                    </button>
                  </span>
                ))}

                {collapsedProjectChips.overflowCount != null && (
                  // Shrinkable (label truncates) so the summary chip
                  // cannot push the toolbar past the narrow column
                  // width and overflow the document.
                  <button
                    type="button"
                    onClick={openProjectFilter}
                    className="flex h-6 min-w-0 max-w-full items-center overflow-hidden text-ellipsis whitespace-nowrap rounded border border-border-subtle bg-surface-muted px-2 text-[11px] font-medium leading-4 text-text transition hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline focus-visible:outline-focus"
                  >
                    Projects: +{collapsedProjectChips.overflowCount}
                  </button>
                )}

                {collapsedTypeChips.chips.map((chip) => (
                  <span
                    key={`type-${chip.kind}`}
                    title={`WT: ${chip.label}`}
                    className="flex h-6 max-w-[220px] items-center gap-1.5 rounded border border-border-subtle bg-surface-muted pl-2 pr-[7px]"
                  >
                    <span className="min-w-0 truncate text-[11px] font-medium leading-4 text-text">
                      WT: {chip.label}
                    </span>

                    <button
                      type="button"
                      aria-label={`Remove Work Item Type filter ${chip.label}`}
                      onClick={() =>
                        handleRemoveTypeChip(chip.kind)
                      }
                      className="shrink-0 rounded text-text-tertiary transition hover:text-text focus-visible:outline-2 focus-visible:outline focus-visible:outline-focus"
                    >
                      <span
                        aria-hidden="true"
                        className="material-symbols-outlined icon-stable text-[12px]"
                      >
                        close
                      </span>
                    </button>
                  </span>
                ))}

                {collapsedTypeChips.overflowCount != null && (
                  // Shrinkable (label truncates) so the summary chip
                  // cannot push the toolbar past the narrow column
                  // width and overflow the document.
                  <button
                    type="button"
                    onClick={openTypeFilter}
                    className="flex h-6 min-w-0 max-w-full items-center overflow-hidden text-ellipsis whitespace-nowrap rounded border border-border-subtle bg-surface-muted px-2 text-[11px] font-medium leading-4 text-text transition hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline focus-visible:outline-focus"
                  >
                    Work item types: +{collapsedTypeChips.overflowCount}
                  </button>
                )}
              </div>

              <button
                type="button"
                onClick={handleClearFilters}
                className="shrink-0 text-[11px] font-semibold leading-4 text-text-muted transition hover:text-text focus-visible:outline-2 focus-visible:outline focus-visible:outline-focus"
              >
                Clear filters
              </button>
            </div>
          )}

          <div className="order-1 ml-auto flex max-w-full flex-wrap items-center justify-end gap-2 sm:order-2 sm:flex-nowrap sm:shrink-0">
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
              className="inline-flex h-auto max-w-full flex-wrap items-center rounded-[5px] border border-border-structural bg-segmented-bg p-0.5 sm:h-8 sm:shrink-0 sm:flex-nowrap"
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
                  className="material-symbols-outlined icon-stable text-[14px]"
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
                  className="material-symbols-outlined icon-stable text-[14px]"
                >
                  view_list
                </span>
                List
              </button>
            </div>

            <MyWorkFilterCommandMenu
              ref={filterMenuRef}
              researchGroupOptions={groups}
              selectedResearchGroupIds={selectedGroupIds}
              onResearchGroupToggle={handleGroupToggle}
              onClearResearchGroups={handleClearGroupFilter}
              projectOptions={projectOptions}
              selectedProjectIds={selectedProjectIds}
              onProjectToggle={handleProjectToggle}
              onClearProjects={handleClearProjectFilter}
              selectedWorkItemTypes={selectedTypeKinds}
              onWorkItemTypeToggle={handleTypeToggle}
              onClearWorkItemTypes={handleClearTypeFilter}
              onClearAll={handleClearFilters}
            />
          </div>
        </div>

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

      {/* Non-fatal post-mutation revalidation failure: the
       * mutation itself succeeded — only the authoritative
       * refetch failed. The established page-local dismissible
       * error treatment, plus an explicit retry of the refetch.
       * Shown in BOTH views (a revalidation can fail from any
       * mutation entry or the global creation event). */}
      {refreshError !== null && (
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
            {refreshError}
          </p>

          <button
            type="button"
            onClick={() =>
              void refreshMyWork()
            }
            className="shrink-0 text-xs font-semibold text-work-item-error underline-offset-2 hover:underline"
          >
            Retry
          </button>

          <button
            type="button"
            onClick={() =>
              setRefreshError(null)
            }
            className="ml-2 shrink-0 text-xs font-semibold text-work-item-error underline-offset-2 hover:underline"
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
      ) : items.length === 0 ? (
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
        <>
          <MyWorkBoard
            columns={kanbanColumns}
            onOpen={openWorkItemCard}
            onRequestDelete={(item) =>
              requestWorkItemDelete(
                item.id,
                'card',
              )
            }
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
            onDrop={(itemId, category, visibleIndex) =>
              void handleBoardDrop(
                itemId,
                category,
                visibleIndex,
              )
            }
          />

          {/* A zero-result ACTIVE filter in Board mode: all four
           * lanes stay visible with counts of 0, plus the restrained
           * filtered-empty state (distinct from "nothing assigned"). */}
          {filteredItems.length === 0 && (
            <FilteredEmptyState
              onClear={handleClearFilters}
            />
          )}
        </>
      ) : filteredItems.length === 0 ? (
        <FilteredEmptyState
          onClear={handleClearFilters}
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
        drawerContext != null &&
        drawerState.projectId ===
          selectedDrawerItem.projectId && (
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
        drawerState.projectId ===
          selectedDrawerItem.projectId && (
          <DrawerLoadingShell />
        )}

      {/* Lazy drawer-context failure: stays on /my-work with the
       * established page-local error pattern — Retry re-issues the
       * reads, Dismiss returns to the board. Never navigates. */}
      {selectedDrawerItem != null &&
        drawerState.status === 'error' &&
        drawerState.projectId ===
          selectedDrawerItem.projectId && (
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

      {/* RT-05: realtime lifecycle for the mounted My Work
          surface — the stream opens only for an authenticated
          session (the hook's session gate) and closes on unmount,
          logout, or session loss. No second reconnection
          implementation, no global EventSource singleton. */}
      <MyWorkRealtime
        onInvalidation={requestMyWorkRealtimeInvalidation}
        onStreamStatus={handleMyWorkStreamStatus}
      />
    </div>
  )
}


/**
 * Global My Work Kanban with exact-positional drag/drop.
 *
 * Four fixed semantic columns (Todo / In progress / Review / Done)
 * rendered over the SAME canonical `GET /api/me/work-items/`
 * payload the List renders. Grouping is by `statusCategory` only;
 * within a column the personal board order renders (positioned
 * cards first by `myWorkBoardPosition` ascending, then
 * unpositioned in the canonical fallback order).
 *
 * Drag/drop reuses the Project Work Items Board's native HTML5
 * mechanism (draggable card, column drop zones, `dataTransfer`
 * item id). While a drag is active, each column presents its DROP
 * AVAILABILITY for that specific dragged item: the item's OWN
 * category (within-column reordering) and every different
 * category its `statusTargets` resolve to a concrete
 * project-local definition are valid targets — the hovered lane
 * takes a subtle accent tint plus a 1px inset ring; categories
 * without a target (for a cross-column move) are unavailable
 * (quiet dim, and the browser drop is refused because `dragover`
 * is not accepted). The PRIMARY positional signal is a precise
 * insertion indicator BETWEEN cards at the exact landing spot
 * (absolutely positioned in the gap — changing the insertion
 * target never shifts layout), covering before-first,
 * between-cards, and after-last; an empty valid column shows a
 * full-column drop target. No decoration exists when no drag is
 * active. Dropping reports the visible insertion index; the page
 * resolves the exact `beforeWorkItemId` anchor over the COMPLETE
 * loaded payload and issues exactly one atomic My Work reorder
 * request plus one authoritative refetch — no separate
 * status-transition request, no optimistic relocation, no Project
 * `board_position`.
 * At narrow widths the board scrolls horizontally inside its own
 * region — the document itself never overflows.
 */
function MyWorkBoard({
  columns,
  onOpen,
  onRequestDelete,
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
  onRequestDelete: (item: ApiPersonalWorkItem) => void
  draggedItemId: number | null
  pendingItemIds: ReadonlySet<number>
  statusDropError: string | null
  onDismissStatusDropError: () => void
  onDragStart: (itemId: number) => void
  onDragEnd: () => void
  onDrop: (
    itemId: number,
    category: ApiWorkItemStatus,
    visibleIndex: number,
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

  // The precise insertion slot while a drag hovers a column: the
  // hovered column plus the index of the card the dragged card
  // would be inserted BEFORE (`items.length` = after the last
  // card). null = no column hovered yet. The indicator LINE is
  // the primary positional signal (see the column rendering); the
  // lane tint/ring is only the restrained active-drop highlight.
  const [dragIndicator, setDragIndicator] = useState<{
    category: ApiWorkItemStatus
    index: number
  } | null>(null)

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

      <div
        data-testid="my-work-board-scroller"
        className="overflow-x-auto"
      >
        <div
          className="grid items-start gap-3"
          style={{
            gridTemplateColumns: `repeat(${columns.length}, minmax(260px, 1fr))`,
          }}
        >
          {columns.map((column) => {
            // Drop availability for the ACTIVE drag. The item's
            // OWN category is a valid destination (within-column
            // reordering), and a different category is valid where
            // the item's statusTargets resolve a concrete
            // project-local definition — the board never invents a
            // fallback status.
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
              (isSameCategory || hasStatusTarget)
            const isUnavailable =
              draggedItem != null &&
              !isValidDropTarget

            // The precise insertion slot while hovering THIS
            // column: the index of the card the dragged card would
            // be inserted before (items.length = after the last
            // card). null = not currently hovering this column.
            const indicatorIndex =
              dragIndicator?.category ===
              column.value
                ? dragIndicator.index
                : null

            const handleColumnDragOver = (
              event: React.DragEvent<HTMLDivElement>,
            ) => {
              if (!isValidDropTarget) {
                // NOT preventing the default makes the browser
                // refuse the drop — no card can land in this
                // column and no move can occur.
                return
              }

              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'

              // Precise slot: the first visible card whose
              // vertical midpoint is BELOW the pointer is the card
              // the dragged card would be inserted before; the
              // pointer below every midpoint = after the last card
              // (and the only slot of an empty column).
              const y = event.clientY
              let index = column.items.length
              const cards =
                event.currentTarget.querySelectorAll(
                  '[data-my-work-board-card]',
                )

              for (let i = 0; i < column.items.length; i += 1) {
                const card = cards.item(i)

                if (!card) {
                  continue
                }

                const rect =
                  card.getBoundingClientRect()

                if (y < rect.top + rect.height / 2) {
                  index = i
                  break
                }
              }

              setDragIndicator((current) =>
                current?.category ===
                  column.value &&
                current.index === index
                  ? current
                  : {
                      category: column.value,
                      index,
                    },
              )
            }
            const handleColumnDragLeave = (
              event: React.DragEvent<HTMLDivElement>,
            ) => {
              // Moving into a child is not a real leave.
              if (
                event.currentTarget.contains(
                  event.relatedTarget as Node | null,
                )
              ) {
                return
              }

              setDragIndicator((current) =>
                current?.category === column.value
                  ? null
                  : current,
              )
            }

            const handleColumnDrop = (
              event: React.DragEvent<HTMLDivElement>,
            ) => {
              event.preventDefault()

              const droppedId =
                event.dataTransfer.getData(
                  'text/plain',
                )

              const numericId = Number(droppedId)

              // The slot this column was last hovered at. A drop
              // only lands where dragover accepted — i.e. the
              // indicator is set — so the fallback (the end) is a
              // backstop; it is the only slot an empty column has.
              const index =
                dragIndicator?.category ===
                column.value
                  ? dragIndicator.index
                  : column.items.length

              setDragIndicator(null)

              // Backstop: only the actively dragged item can be
              // dropped (stale/foreign payloads are ignored).
              if (
                !Number.isInteger(numericId) ||
                numericId !== draggedItemId
              ) {
                return
              }

              onDrop(numericId, column.value, index)
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

              {/* Card area: one relative wrapper per card carries
                  the precise insertion indicator (absolutely
                  positioned in the gap — changing the insertion
                  target never shifts layout). An empty VALID
                  column shows an obvious full-column drop target
                  for the whole drag; empty columns otherwise stay
                  visible (header + count) with no decorative
                  placeholder. */}
              <div className="flex flex-1 flex-col gap-2">
                {column.items.length === 0 ? (
                  isValidDropTarget ? (
                    <div
                      data-my-work-empty-drop-target
                      aria-hidden="true"
                      className="min-h-[88px] flex-1 rounded-md border border-dashed border-work-lane-drag-ring"
                    />
                  ) : null
                ) : (
                  column.items.map((item, itemIndex) => (
                    <div
                      key={item.id}
                      data-my-work-board-card={item.id}
                      className="relative"
                    >
                      {/* Before this card. */}
                      {indicatorIndex === itemIndex ? (
                        <div
                          data-my-work-insertion-indicator
                          aria-hidden="true"
                          className="absolute left-0 right-0 top-[-5px] h-0.5 rounded-full bg-interaction-primary"
                        />
                      ) : null}

                      {/* After this card (the last one). */}
                      {indicatorIndex ===
                      column.items.length &&
                      itemIndex ===
                        column.items.length - 1 ? (
                        <div
                          data-my-work-insertion-indicator
                          aria-hidden="true"
                          className="absolute left-0 right-0 top-[calc(100%+3px)] h-0.5 rounded-full bg-interaction-primary"
                        />
                      ) : null}

                      <WorkItemCard
                        id={String(item.id)}
                        title={item.title}
                        typeName={item.typeName}
                        typeKind={item.typeKind}
                        statusCategory={item.statusCategory}
                        dueDate={item.dueDate}
                        blockedReason={item.blockedReason}
                        provenance={{
                          researchGroupName:
                            item.researchGroupName,
                          projectName: item.projectName,
                        }}
                        dragging={
                          draggedItemId === item.id
                        }
                        pending={
                          pendingItemIds.has(
                            item.id,
                          )
                        }
                        onOpen={() => onOpen(item)}
                        onDragStart={() =>
                          onDragStart(item.id)
                        }
                        onDragEnd={() => {
                          setDragIndicator(null)
                          onDragEnd()
                        }}
                        actions={
                          item.actionPermissions
                            ?.canDelete === true
                            ? (
                                <WorkItemActionMenuTrigger
                                  label="Work item actions"
                                  size="sm"
                                  onAction={(action) => {
                                    if (action === 'delete') {
                                      onRequestDelete(item)
                                    }
                                  }}
                                />
                              )
                            : undefined
                        }
                      />
                    </div>
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
