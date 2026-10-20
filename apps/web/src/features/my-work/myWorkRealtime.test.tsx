// @vitest-environment happy-dom

// RT-05 — My Work realtime integration.
//
// Focused React integration tests with a controllable Mock
// EventSource and controlled API promises: they mount the REAL
// MyWorkPage (real loadMyWork / refreshMyWork / request-sequence /
// pending-move machinery, real myWorkRealtime adapter) and assert
// the rendered board/list plus the ACTUAL listMyWork /
// fetchMyWorkPreferences / updateMyWorkPreferences calls.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import { me } from '../../api/auth'
import {
  listMyWork,
  reorderMyWorkItem,
  transitionWorkItemStatus,
  updateWorkItem,
} from '../../api/work-items'
import {
  fetchMyWorkPreferences,
  updateMyWorkPreferences,
} from '../../api/my-work-preferences'
import { WORK_ITEM_CREATED_EVENT } from '../../components/layout/workItemInvalidation'
import type {
  ApiMyWorkPreferences,
  ApiPersonalWorkItem,
  ApiUser,
  ApiWorkItemStatus,
} from '../../api/types'

import { MyWorkPage } from './MyWorkPage'

vi.mock('../../api/work-items', () => ({
  listMyWork: vi.fn(),
  reorderMyWorkItem: vi.fn(),
  // Kept observable: a board drag must NEVER issue the standalone
  // status-transition request (or the ordinary status PATCH).
  transitionWorkItemStatus: vi.fn(),
  updateWorkItem: vi.fn(),
  createWorkItem: vi.fn(),
  deleteWorkItem: vi.fn(),
  listProjectWorkItems: vi.fn(),
}))

vi.mock('../../api/my-work-preferences', () => ({
  fetchMyWorkPreferences: vi.fn(),
  updateMyWorkPreferences: vi.fn(),
}))

vi.mock('../../api/projects', () => ({
  getProjectWorkItemConfiguration: vi.fn(),
  getProject: vi.fn(),
  listProjectMemberships: vi.fn(),
  listResearchGroupMembers: vi.fn(),
}))

vi.mock('../../api/auth', () => ({
  me: vi.fn(),
}))

// The session is a mutable box so a test can simulate session loss
// (logout / server-side invalidation) on the mounted page.
const TEST_USER: ApiUser = {
  id: 1,
  username: 'alex',
  firstName: 'Alex',
  lastName: '',
  email: 'alex@example.com',
}

const mockSessionUser: {
  current: ApiUser | null
} = {
  current: TEST_USER,
}

vi.mock('../../api/useSession', () => ({
  useSession: () => ({
    user: mockSessionUser.current,
    handleAuthenticationLost: () => {},
  }),
}))

// The canonical drawer is covered by its own suites; the page under
// test must mount the canonical module (this mock stands in for it
// at the module boundary) and renders nothing.
vi.mock('../projects/WorkItemDrawer', () => ({
  WorkItemDrawer: () => null,
}))

vi.mock('../research-group/useResearchGroup', () => ({
  useResearchGroup: () => ({ groups: [] }),
}))

/* ── Mock EventSource (controllable stand-in) ──────────────────── */

interface MockEvent {
  type: string
  data?: string
  [key: string]: unknown
}

type MockListener = (event: MockEvent) => void

class MockEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2

  static instances: MockEventSource[] = []

  url: string
  withCredentials: boolean
  readyState: number
  closed: boolean
  listeners: Map<string, Set<MockListener>>

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url
    this.withCredentials = init?.withCredentials ?? false
    this.readyState = MockEventSource.CONNECTING
    this.closed = false
    this.listeners = new Map()
    MockEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: MockListener): void {
    let set = this.listeners.get(type)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
  }

  removeEventListener(type: string, listener: MockListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  close(): void {
    this.closed = true
    this.readyState = MockEventSource.CLOSED
  }

  fire(type: string, data?: string): void {
    const event: MockEvent = { type }
    if (data !== undefined) event.data = data
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }
}

function lastSource(): MockEventSource {
  const instances = MockEventSource.instances
  return instances[instances.length - 1]!
}

/** A valid `open` handshake on the named instance. */
function openHandshake(source: MockEventSource, userId = 1): void {
  act(() => {
    source.readyState = MockEventSource.OPEN
    source.fire('open', JSON.stringify({ userId }))
  })
}

/** A connection-level interruption (RC-1: same instance). */
function connectingError(source: MockEventSource): void {
  act(() => {
    source.readyState = MockEventSource.CONNECTING
    source.fire('error')
  })
}

/** A response-level failure (RC-2/RC-4: controlled reconnect). */
function terminalFailure(source: MockEventSource): void {
  act(() => {
    source.readyState = MockEventSource.CLOSED
    source.fire('error')
  })
}

/** One validated `my_work_changed` invalidation (empty payload). */
function fireMyWorkChanged(source: MockEventSource): void {
  act(() => {
    source.fire('my_work_changed', JSON.stringify({}))
  })
}

/** One `work_item_changed` invalidation for the given Project. */
function fireWorkItemChanged(
  source: MockEventSource,
  projectId: number,
): void {
  act(() => {
    source.fire(
      'work_item_changed',
      JSON.stringify({ projectId }),
    )
  })
}

/** Let queued microtasks + React updates settle. */
async function settle(): Promise<void> {
  await act(async () => {})
  await act(async () => {})
}

/* ── Fixtures ──────────────────────────────────────────────────── */

const ALL_TARGETS: Array<{
  statusCategory: ApiWorkItemStatus
  statusDefinitionId: number
  statusName: string
}> = [
  {
    statusCategory: 'todo',
    statusDefinitionId: 21,
    statusName: 'To do',
  },
  {
    statusCategory: 'in_progress',
    statusDefinitionId: 22,
    statusName: 'In Progress',
  },
  {
    statusCategory: 'review',
    statusDefinitionId: 23,
    statusName: 'Review',
  },
  {
    statusCategory: 'done',
    statusDefinitionId: 24,
    statusName: 'Done',
  },
]

const DEFAULT_PREFERENCES: ApiMyWorkPreferences = {
  viewMode: 'board',
  researchGroupIds: [],
  projectIds: [],
  workItemTypes: [],
}

function makePreferences(
  overrides: Partial<ApiMyWorkPreferences> = {},
): ApiMyWorkPreferences {
  return {
    ...DEFAULT_PREFERENCES,
    researchGroupIds: [
      ...DEFAULT_PREFERENCES.researchGroupIds,
    ],
    projectIds: [...DEFAULT_PREFERENCES.projectIds],
    workItemTypes: [
      ...DEFAULT_PREFERENCES.workItemTypes,
    ],
    ...overrides,
  }
}

function makeItem(
  overrides: Partial<ApiPersonalWorkItem> = {},
): ApiPersonalWorkItem {
  return {
    id: 100,
    projectId: 7,
    title: 'Alpha',
    description: '',
    typeDefinitionId: 4,
    statusDefinitionId: 21,
    boardPosition: null,
    labelDefinitionIds: [],
    assigneeIds: [1],
    parentId: null,
    dueDate: null,
    blockedReason: null,
    completedAt: null,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    createdById: 1,
    meetingOrigin: null,
    projectName: 'Project Alpha',
    researchGroupId: 1,
    researchGroupName: 'Research Group A',
    typeName: 'Sample Batch',
    statusName: 'To do',
    statusCategory: 'todo',
    typeKind: null,
    statusTargets: ALL_TARGETS,
    myWorkBoardPosition: null,
    actionPermissions: { canDelete: true },
    ...overrides,
  } as ApiPersonalWorkItem
}

const TODO_ITEM = makeItem({ id: 100, title: 'Alpha' })
const BETA_ITEM = makeItem({
  id: 200,
  title: 'Beta',
  createdAt: '2026-09-02T00:00:00Z',
})

/* ── API mock helpers ──────────────────────────────────────────── */

/**
 * Answer queue for `listMyWork` (first entry = initial load; the
 * last entry repeats for every later call). Returns the call log
 * (1-based call number per call, in order).
 */
function queueMyWork(
  queues: ApiPersonalWorkItem[][],
): number[] {
  const calls: number[] = []

  vi.mocked(listMyWork).mockImplementation(() => {
    calls.push(calls.length + 1)

    return Promise.resolve(
      queues[Math.min(calls.length - 1, queues.length - 1)],
    )
  })

  return calls
}

/* ── Rendering + board helpers ─────────────────────────────────── */

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/my-work']}>
      <Routes>
        <Route
          path="/my-work"
          element={<MyWorkPage />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

/** The `data-work-item-id` of every card inside one column. */
function columnCardIds(
  container: HTMLElement,
  category: string,
): string[] {
  const col = container.querySelector(
    `[data-board-column="${category}"]`,
  )

  if (!col) {
    return []
  }

  return Array.from(
    col.querySelectorAll('[data-work-item-id]'),
  ).map(
    (el) =>
      el.getAttribute('data-work-item-id') as string,
  )
}

// Click the presentation-only Board/List switch.
async function switchView(
  label: 'Board' | 'List',
): Promise<void> {
  await act(async () => {
    fireEvent.click(
      screen.getByRole('button', { name: label }),
    )
  })
}

/** The rendered sync-paused indicator, if any. */
function syncPausedIndicator(): HTMLElement | null {
  return screen
    .queryAllByRole('status')
    .find(
      (el) =>
        el.textContent?.includes('Sync paused'),
    ) ?? null
}

/* ── Board drag & drop (native HTML5 sequence) ─────────────────── */

function makeDataTransfer(): {
  setData: (type: string, value: string) => void
  getData: (type: string) => string
  effectAllowed: string
  dropEffect: string
} {
  let data = ''

  return {
    setData: (_type: string, value: string) => {
      data = value
    },
    getData: () => data,
    effectAllowed: '',
    dropEffect: '',
  }
}

const STUB_CARD_TOP = 100
const STUB_CARD_HEIGHT = 88
const STUB_CARD_GAP = 8

function stubColumnCardRects(
  column: HTMLElement,
): void {
  Array.from(
    column.querySelectorAll<HTMLElement>(
      '[data-my-work-board-card]',
    ),
  ).forEach((card, i) => {
    const top =
      STUB_CARD_TOP +
      i * (STUB_CARD_HEIGHT + STUB_CARD_GAP)

    card.getBoundingClientRect = () =>
      ({
        top,
        bottom: top + STUB_CARD_HEIGHT,
        left: 0,
        right: 260,
        width: 260,
        height: STUB_CARD_HEIGHT,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect
  })
}

async function fireColumnDragOver(
  column: HTMLElement,
  dataTransfer: unknown,
  clientY: number,
): Promise<void> {
  const overEvent = new DragEvent('dragover', {
    bubbles: true,
    cancelable: true,
  })
  Object.defineProperty(overEvent, 'clientY', {
    configurable: true,
    value: clientY,
  })
  Object.defineProperty(overEvent, 'dataTransfer', {
    configurable: true,
    value: dataTransfer,
  })

  await act(async () => {
    fireEvent(column, overEvent)
  })
}

/**
 * The native HTML5 drag sequence the board relies on. `clientY`
 * selects the precise vertical drop position inside the target
 * column (the column's visible card wrappers are stubbed to the
 * standard geometry first). Omitted = after the last card.
 */
async function dragCardToColumn(
  container: HTMLElement,
  card: HTMLElement,
  category: string,
  clientY?: number,
): Promise<void> {
  const column = container.querySelector(
    `[data-board-column="${category}"]`,
  ) as HTMLElement

  stubColumnCardRects(column)

  const cards = Array.from(
    column.querySelectorAll(
      '[data-my-work-board-card]',
    ),
  )

  const y =
    clientY ??
    STUB_CARD_TOP +
      cards.length *
      (STUB_CARD_HEIGHT + STUB_CARD_GAP)

  const dataTransfer = makeDataTransfer()

  await act(async () => {
    fireEvent.dragStart(card, { dataTransfer })
  })

  await fireColumnDragOver(column, dataTransfer, y)

  await act(async () => {
    fireEvent.drop(column, { dataTransfer })
    fireEvent.dragEnd(card, { dataTransfer })
  })
}

beforeEach(() => {
  MockEventSource.instances = []
  mockSessionUser.current = TEST_USER
  vi.mocked(me).mockResolvedValue(TEST_USER)
  // RC-3 backoff: deterministic 0 ms delays in reconnect tests.
  vi.spyOn(Math, 'random').mockReturnValue(0)
  vi.stubGlobal('EventSource', MockEventSource)
  vi.mocked(fetchMyWorkPreferences).mockResolvedValue(
    makePreferences(),
  )
  vi.mocked(updateMyWorkPreferences).mockImplementation(
    async (snapshot: ApiMyWorkPreferences) =>
      snapshot,
  )
})

afterEach(() => {
  cleanup()
  // resetAllMocks: a failed test may leave held promises behind,
  // and vitest would hand them to the next test.
  vi.resetAllMocks()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/* ── 1. Stream lifecycle ───────────────────────────────────────── */

describe('My Work realtime — stream lifecycle', () => {
  it('opens exactly one stream for the authenticated My Work surface', async () => {
    queueMyWork([[TODO_ITEM]])

    renderPage()
    await screen.findByRole('button', {
      name: 'Open Alpha',
    })

    expect(MockEventSource.instances).toHaveLength(1)
    const source = MockEventSource.instances[0]!
    expect(source.url).toBe('/api/work-items/events/')
    expect(source.withCredentials).toBe(true)

    // A valid handshake never spawns a second instance.
    openHandshake(source)
    await settle()

    expect(MockEventSource.instances).toHaveLength(1)
    expect(source.closed).toBe(false)
  })

  it('closes the stream on unmount and on session loss', async () => {
    queueMyWork([[TODO_ITEM]])

    const rendered = renderPage()
    await screen.findByRole('button', {
      name: 'Open Alpha',
    })
    const source = lastSource()
    openHandshake(source)
    await settle()

    // Unmount closes the stream; no new instance.
    await act(async () => {
      rendered.unmount()
    })
    expect(source.closed).toBe(true)
    expect(MockEventSource.instances).toHaveLength(1)

    // Session loss on a fresh mount: the hook's session gate
    // stops the stream — no new EventSource, no fresh auth check.
    const rendered2 = renderPage()
    await screen.findByRole('button', {
      name: 'Open Alpha',
    })
    const second = lastSource()
    expect(MockEventSource.instances).toHaveLength(2)

    mockSessionUser.current = null
    await act(async () => {
      rendered2.rerender(
        <MemoryRouter initialEntries={['/my-work']}>
          <Routes>
            <Route
              path="/my-work"
              element={<MyWorkPage />}
            />
          </Routes>
        </MemoryRouter>,
      )
    })

    expect(second.closed).toBe(true)
    expect(MockEventSource.instances).toHaveLength(2)
    expect(me).not.toHaveBeenCalled()
  })

  it('starts no stream for an unauthenticated mount', async () => {
    mockSessionUser.current = null
    queueMyWork([[TODO_ITEM]])

    renderPage()
    await waitFor(() =>
      expect(listMyWork).toHaveBeenCalledTimes(1))
    await settle()

    // No EventSource, no fresh auth check, no stream request.
    expect(MockEventSource.instances).toHaveLength(0)
    expect(me).not.toHaveBeenCalled()
  })
})

/* ── 2. Personal invalidations ─────────────────────────────────── */

describe('My Work realtime — personal invalidations', () => {
  it('updates the Board and the List authoritatively on my_work_changed', async () => {
    const ADDED = makeItem({
      id: 300,
      title: 'Added by teammate',
      createdAt: '2026-09-03T00:00:00Z',
    })
    const MORE = makeItem({
      id: 400,
      title: 'One more',
      createdAt: '2026-09-04T00:00:00Z',
    })
    queueMyWork([
      [TODO_ITEM],
      [TODO_ITEM],
      [TODO_ITEM, ADDED],
      [TODO_ITEM, ADDED, MORE],
    ])

    const { container } = renderPage()
    await screen.findByRole('button', {
      name: 'Open Alpha',
    })
    const source = lastSource()
    openHandshake(source)
    await waitFor(() =>
      expect(listMyWork).toHaveBeenCalledTimes(2))

    // Board phase: the new assignment appears from the
    // authoritative refetch (canonical payload order: no personal
    // position yet, so created_at/id order).
    fireMyWorkChanged(source)
    await screen.findByRole('button', {
      name: 'Open Added by teammate',
    })
    expect(listMyWork).toHaveBeenCalledTimes(3)
    expect(columnCardIds(container, 'todo')).toEqual([
      '100',
      '300',
    ])

    // List phase: switching views is presentation-only (no
    // refetch), and the List renders the SAME canonical payload.
    await switchView('List')
    expect(
      screen.getByRole('button', {
        name: 'Open Added by teammate',
      }),
    ).toBeInTheDocument()
    expect(listMyWork).toHaveBeenCalledTimes(3)

    fireMyWorkChanged(source)
    await screen.findByRole('button', {
      name: 'Open One more',
    })
    expect(listMyWork).toHaveBeenCalledTimes(4)
  })

  it('does not refetch My Work on work_item_changed', async () => {
    queueMyWork([[TODO_ITEM]])

    renderPage()
    await screen.findByRole('button', {
      name: 'Open Alpha',
    })
    const source = lastSource()
    openHandshake(source)
    await waitFor(() =>
      expect(listMyWork).toHaveBeenCalledTimes(2))

    // A project-scope invalidation is not My Work's: no refetch,
    // the rendered board is untouched.
    fireWorkItemChanged(source, 7)
    await settle()
    await settle()

    expect(listMyWork).toHaveBeenCalledTimes(2)
    expect(
      screen.getByRole('button', { name: 'Open Alpha' }),
    ).toBeInTheDocument()
  })

  it('removes the card when an assignment is removed', async () => {
    queueMyWork([
      [TODO_ITEM, BETA_ITEM],
      [TODO_ITEM, BETA_ITEM],
      [TODO_ITEM],
    ])

    renderPage()
    await screen.findByRole('button', {
      name: 'Open Beta',
    })
    const source = lastSource()
    openHandshake(source)
    await waitFor(() =>
      expect(listMyWork).toHaveBeenCalledTimes(2))

    fireMyWorkChanged(source)
    await waitFor(() =>
      expect(listMyWork).toHaveBeenCalledTimes(3))

    await waitFor(() =>
      expect(
        screen.queryByRole('button', {
          name: 'Open Beta',
        }),
      ).toBeNull())

    expect(
      screen.getByRole('button', { name: 'Open Alpha' }),
    ).toBeInTheDocument()
  })

  it('shows new assignment data without a reload', async () => {
    const NEW = makeItem({
      id: 500,
      title: 'Newly assigned',
      createdAt: '2026-09-05T00:00:00Z',
    })
    queueMyWork([
      [TODO_ITEM],
      [TODO_ITEM],
      [TODO_ITEM, NEW],
    ])

    renderPage()
    await screen.findByRole('button', {
      name: 'Open Alpha',
    })
    const source = lastSource()
    openHandshake(source)
    await waitFor(() =>
      expect(listMyWork).toHaveBeenCalledTimes(2))

    fireMyWorkChanged(source)
    await screen.findByRole('button', {
      name: 'Open Newly assigned',
    })
    expect(listMyWork).toHaveBeenCalledTimes(3)
  })
})

/* ── 3. RC-5: authoritative refetch on every open handshake ────── */

describe('My Work realtime — RC-5 reconnection', () => {
  it('refetches once on the initial open handshake', async () => {
    const LATE = makeItem({
      id: 600,
      title: 'Late change',
      createdAt: '2026-09-06T00:00:00Z',
    })
    queueMyWork([
      [TODO_ITEM],
      [TODO_ITEM, LATE],
    ])

    renderPage()
    await screen.findByRole('button', {
      name: 'Open Alpha',
    })
    const source = lastSource()

    openHandshake(source)
    await waitFor(() =>
      expect(listMyWork).toHaveBeenCalledTimes(2))
    await screen.findByRole('button', {
      name: 'Open Late change',
    })

    // One handshake = exactly one refetch (no doubling).
    await settle()
    expect(listMyWork).toHaveBeenCalledTimes(2)
  })

  it('refetches once on the native reconnect handshake', async () => {
    const LATE = makeItem({
      id: 600,
      title: 'Late change',
      createdAt: '2026-09-06T00:00:00Z',
    })
    queueMyWork([
      [TODO_ITEM],
      [TODO_ITEM],
      [TODO_ITEM, LATE],
    ])

    renderPage()
    await screen.findByRole('button', {
      name: 'Open Alpha',
    })
    const source = lastSource()
    openHandshake(source)
    await waitFor(() =>
      expect(listMyWork).toHaveBeenCalledTimes(2))

    // A connection-level interruption (native retry, RC-1): the
    // SAME instance is kept and no auth check is issued.
    connectingError(source)
    expect(MockEventSource.instances).toHaveLength(1)
    expect(me).not.toHaveBeenCalled()

    // The re-established stream sends a fresh open handshake —
    // exactly one authoritative refetch follows.
    openHandshake(source)
    await waitFor(() =>
      expect(listMyWork).toHaveBeenCalledTimes(3))
    await screen.findByRole('button', {
      name: 'Open Late change',
    })

    await settle()
    expect(listMyWork).toHaveBeenCalledTimes(3)
  })

  it('refetches once on the controlled reconnect handshake', async () => {
    const LATE = makeItem({
      id: 600,
      title: 'Late change',
      createdAt: '2026-09-06T00:00:00Z',
    })
    queueMyWork([
      [TODO_ITEM],
      [TODO_ITEM],
      [TODO_ITEM, LATE],
    ])

    renderPage()
    await screen.findByRole('button', {
      name: 'Open Alpha',
    })
    const first = lastSource()
    openHandshake(first)
    await waitFor(() =>
      expect(listMyWork).toHaveBeenCalledTimes(2))

    // A response-level failure: the closed instance is dropped and
    // a controlled reconnect follows the fresh auth check
    // (RC-2 / RC-4).
    terminalFailure(first)
    expect(me).toHaveBeenCalledTimes(1)
    expect(first.readyState).toBe(MockEventSource.CLOSED)

    // RC-3 backoff (deterministic 0 ms) — exactly one NEW
    // instance, never the closed one.
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 20)
      })
    })
    const second = lastSource()
    expect(MockEventSource.instances).toHaveLength(2)
    expect(second).not.toBe(first)

    // The new connection's open handshake refetches the surface
    // exactly once.
    openHandshake(second)
    await waitFor(() =>
      expect(listMyWork).toHaveBeenCalledTimes(3))
    await screen.findByRole('button', {
      name: 'Open Late change',
    })

    await settle()
    expect(listMyWork).toHaveBeenCalledTimes(3)
  })
})

/* ── 4. Initial-load coordination, coalescing, race protection ─── */

describe('My Work realtime — coalescing and race protection', () => {
  it('an event during the initial load causes no bad items or preferences state', async () => {
    // The initial load's items GET stays held (only the FIRST
    // call); the preferences GET resolves normally (the two are
    // loaded in parallel). Later calls (the coordinated follow-up)
    // resolve normally.
    let callCount = 0
    let resolveItems:
      | ((items: ApiPersonalWorkItem[]) => void)
      | null = null
    vi.mocked(listMyWork).mockImplementation(() => {
      callCount += 1
      if (callCount === 1) {
        return new Promise<ApiPersonalWorkItem[]>((resolve) => {
          resolveItems = resolve
        })
      }

      return Promise.resolve([TODO_ITEM])
    })

    renderPage()
    await waitFor(() =>
      expect(listMyWork).toHaveBeenCalledTimes(1))
    // Still loading: no card yet.
    expect(
      screen.queryByRole('button', {
        name: 'Open Alpha',
      }),
    ).toBeNull()

    // The initial open handshake arrives while the load is in
    // flight: HELD — no parallel items GET, no preferences
    // re-read.
    const source = lastSource()
    expect(MockEventSource.instances).toHaveLength(1)
    openHandshake(source)
    await settle()
    expect(listMyWork).toHaveBeenCalledTimes(1)
    expect(fetchMyWorkPreferences).toHaveBeenCalledTimes(1)

    // A personal event while the load is in flight: also held.
    fireMyWorkChanged(source)
    await settle()
    expect(listMyWork).toHaveBeenCalledTimes(1)
    expect(fetchMyWorkPreferences).toHaveBeenCalledTimes(1)

    // The load settles: the surface is quiescent, the held
    // invalidation flushes with exactly ONE follow-up items fetch —
    // still no second preferences GET, no preferences PATCH.
    await act(async () => {
      resolveItems?.([TODO_ITEM])
    })
    await screen.findByRole('button', {
      name: 'Open Alpha',
    })
    await waitFor(() =>
      expect(listMyWork).toHaveBeenCalledTimes(2))
    expect(fetchMyWorkPreferences).toHaveBeenCalledTimes(1)
    expect(updateMyWorkPreferences).not.toHaveBeenCalled()

    // No further fetch follows the settled coordination.
    await settle()
    expect(listMyWork).toHaveBeenCalledTimes(2)
  })

  it('coalesces a burst of events into one in-flight plus one follow-up fetch', async () => {
    const BURST = makeItem({
      id: 700,
      title: 'Burst final',
      createdAt: '2026-09-07T00:00:00Z',
    })
    queueMyWork([
      [TODO_ITEM],
      [TODO_ITEM],
      [TODO_ITEM, BURST],
    ])

    renderPage()
    await screen.findByRole('button', {
      name: 'Open Alpha',
    })
    const source = lastSource()
    openHandshake(source)
    await waitFor(() =>
      expect(listMyWork).toHaveBeenCalledTimes(2))

    // Five fast events: at most ONE in-flight plus ONE follow-up
    // fetch (no request flood), and the final state lands.
    act(() => {
      for (let i = 0; i < 5; i += 1) {
        fireMyWorkChanged(source)
      }
    })
    await screen.findByRole('button', {
      name: 'Open Burst final',
    })
    expect(listMyWork).toHaveBeenCalledTimes(4)

    // ...and no further fetch follows the settled burst.
    await settle()
    expect(listMyWork).toHaveBeenCalledTimes(4)
  })

  it('does not lose an event that arrives while a refetch is in flight', async () => {
    const MID = makeItem({
      id: 701,
      title: 'Mid change',
      createdAt: '2026-09-08T00:00:00Z',
    })
    const FINAL = makeItem({
      id: 702,
      title: 'Final change',
      createdAt: '2026-09-09T00:00:00Z',
    })
    const calls: number[] = []
    let resolveThird:
      | ((items: ApiPersonalWorkItem[]) => void)
      | null = null
    let resolveFourth:
      | ((items: ApiPersonalWorkItem[]) => void)
      | null = null

    vi.mocked(listMyWork).mockImplementation(() => {
      calls.push(calls.length + 1)
      if (calls.length === 1) return Promise.resolve([TODO_ITEM])
      if (calls.length === 2) return Promise.resolve([TODO_ITEM])
      if (calls.length === 3) {
        return new Promise<ApiPersonalWorkItem[]>((resolve) => {
          resolveThird = resolve
        })
      }

      return new Promise<ApiPersonalWorkItem[]>((resolve) => {
        resolveFourth = resolve
      })
    })

    renderPage()
    await screen.findByRole('button', {
      name: 'Open Alpha',
    })
    const source = lastSource()
    openHandshake(source)
    await waitFor(() => expect(calls).toHaveLength(2))

    // Event A triggers a refetch that is held in flight.
    fireMyWorkChanged(source)
    await waitFor(() => expect(calls).toHaveLength(3))

    // Event B arrives while that fetch is in flight: coalesced,
    // not lost (no 4th fetch yet).
    fireMyWorkChanged(source)
    await settle()
    expect(calls).toHaveLength(3)

    // The in-flight answer settles with a state that predates
    // Event B: Event A's change is adopted.
    await act(async () => {
      resolveThird?.([TODO_ITEM, MID])
    })
    await screen.findByRole('button', {
      name: 'Open Mid change',
    })

    // The held invalidation flushes exactly ONE follow-up fetch,
    // and its answer adopts the FINAL server state.
    await waitFor(() => expect(calls).toHaveLength(4))
    await act(async () => {
      resolveFourth?.([TODO_ITEM, MID, FINAL])
    })
    await screen.findByRole('button', {
      name: 'Open Final change',
    })
    expect(calls).toHaveLength(4)
  })

  it('a delayed stale answer never overwrites a newer snapshot', async () => {
    const NEWER = makeItem({
      id: 703,
      title: 'Newer change',
      createdAt: '2026-09-10T00:00:00Z',
    })
    let resolveStaleLoad:
      | ((items: ApiPersonalWorkItem[]) => void)
      | null = null
    let call = 0

    vi.mocked(listMyWork).mockImplementation(() => {
      call += 1
      if (call === 1) {
        // The initial load stays in flight; its answer is STALE
        // (it predates the external change).
        return new Promise<ApiPersonalWorkItem[]>((resolve) => {
          resolveStaleLoad = resolve
        })
      }

      return Promise.resolve([TODO_ITEM, NEWER])
    })

    renderPage()
    await waitFor(() =>
      expect(listMyWork).toHaveBeenCalledTimes(1))
    expect(
      screen.queryByRole('button', {
        name: 'Open Alpha',
      }),
    ).toBeNull()

    // A global creation event starts a refresh while the initial
    // load is still in flight — two overlapping items GETs.
    window.dispatchEvent(
      new CustomEvent(WORK_ITEM_CREATED_EVENT, {
        detail: { projectId: 7 },
      }),
    )
    await waitFor(() =>
      expect(listMyWork).toHaveBeenCalledTimes(2))

    // The stale initial load now answers AFTER the newer snapshot
    // was applied: the request-sequence guard discards it.
    await act(async () => {
      resolveStaleLoad?.([TODO_ITEM])
    })
    await settle()

    // The NEWER snapshot is what renders — not the stale load's
    // single item.
    await screen.findByRole('button', {
      name: 'Open Newer change',
    })
    expect(
      screen.getByRole('button', { name: 'Open Alpha' }),
    ).toBeInTheDocument()
    expect(listMyWork).toHaveBeenCalledTimes(2)
  })
})

/* ── 5. Personal reorder protection ────────────────────────────── */

describe('My Work realtime — personal reorder protection', () => {
  /**
   * Start a real same-category reorder (Beta before Alpha) and
   * leave the mutation in flight. Returns the settle handles.
   */
  function startPendingReorder() {
    let resolveReorder:
      | ((item: ApiPersonalWorkItem) => void)
      | null = null
    let rejectReorder:
      | ((reason: Error) => void)
      | null = null

    vi.mocked(reorderMyWorkItem).mockImplementation(
      () =>
        new Promise<ApiPersonalWorkItem>(
          (resolve, reject) => {
            resolveReorder = resolve
            rejectReorder = reject
          },
        ),
    )

    return {
      resolve: async () => {
        await act(async () => {
          resolveReorder?.({
            ...BETA_ITEM,
            myWorkBoardPosition: 1,
          })
        })
      },
      reject: async () => {
        await act(async () => {
          rejectReorder?.(new Error('boom'))
        })
      },
    }
  }

  it('an event during a personal reorder does not change the position early', async () => {
    queueMyWork([[TODO_ITEM, BETA_ITEM]])

    const { container } = renderPage()
    await screen.findByRole('button', {
      name: 'Open Beta',
    })
    const source = lastSource()
    openHandshake(source)
    await waitFor(() =>
      expect(listMyWork).toHaveBeenCalledTimes(2))
    expect(columnCardIds(container, 'todo')).toEqual([
      '100',
      '200',
    ])

    // Start a same-category reorder (Beta to the top); the
    // mutation stays in flight. No optimistic relocation exists,
    // so the visible order is still the persisted one.
    const reorder = startPendingReorder()
    await dragCardToColumn(
      container,
      screen.getByRole('button', { name: 'Open Beta' }),
      'todo',
      STUB_CARD_TOP + 20,
    )
    expect(reorderMyWorkItem).toHaveBeenCalledTimes(1)
    expect(reorderMyWorkItem).toHaveBeenCalledWith(
      200,
      {
        statusCategory: 'todo',
        beforeWorkItemId: 100,
      },
    )

    // The reorder's own (self-echo) invalidation arrives while
    // the move is pending: it may NOT issue a fetch whose answer
    // could predate the move's commit.
    fireMyWorkChanged(source)
    await settle()

    expect(listMyWork).toHaveBeenCalledTimes(2)
    // The visible position is unchanged while the move is in
    // flight (no premature adoption, no optimistic move).
    expect(columnCardIds(container, 'todo')).toEqual([
      '100',
      '200',
    ])

    // Cleanup: settle the mutation so no promise leaks.
    await reorder.resolve()
  })

  it('shows the persisted server order after a successful reorder', async () => {
    const AFTER = [
      { ...BETA_ITEM, myWorkBoardPosition: 1 },
      { ...TODO_ITEM, myWorkBoardPosition: 2 },
    ]
    queueMyWork([
      [TODO_ITEM, BETA_ITEM],
      [TODO_ITEM, BETA_ITEM],
      AFTER,
    ])

    const { container } = renderPage()
    await screen.findByRole('button', {
      name: 'Open Beta',
    })
    const source = lastSource()
    openHandshake(source)
    await waitFor(() =>
      expect(listMyWork).toHaveBeenCalledTimes(2))

    const reorder = startPendingReorder()
    await dragCardToColumn(
      container,
      screen.getByRole('button', { name: 'Open Beta' }),
      'todo',
      STUB_CARD_TOP + 20,
    )

    // The self-echo event is held while the move is pending and
    // is CONSUMED by the move's own revalidation — one fetch, not
    // two.
    fireMyWorkChanged(source)
    await settle()
    expect(listMyWork).toHaveBeenCalledTimes(2)

    // The drag used exactly the atomic My Work reorder — never
    // the standalone status transition or the ordinary PATCH.
    expect(transitionWorkItemStatus).not.toHaveBeenCalled()
    expect(updateWorkItem).not.toHaveBeenCalled()

    // The mutation succeeds: the move's own authoritative
    // revalidation adopts the persisted server order.
    await reorder.resolve()
    await waitFor(() =>
      expect(listMyWork).toHaveBeenCalledTimes(3))
    expect(columnCardIds(container, 'todo')).toEqual([
      '200',
      '100',
    ])

    // No extra fetch follows the consumed self-echo.
    await settle()
    expect(listMyWork).toHaveBeenCalledTimes(3)
  })

  it('keeps a failed reorder separate and still honors the held invalidation', async () => {
    const EXTERNAL = makeItem({
      id: 704,
      title: 'External change',
      createdAt: '2026-09-11T00:00:00Z',
    })
    const payloads: ApiPersonalWorkItem[][] = [
      [TODO_ITEM, BETA_ITEM],
      [TODO_ITEM, BETA_ITEM],
      [TODO_ITEM, BETA_ITEM, EXTERNAL],
    ]
    const calls: number[] = []
    let resolveThird:
      | ((items: ApiPersonalWorkItem[]) => void)
      | null = null

    vi.mocked(listMyWork).mockImplementation(() => {
      calls.push(calls.length + 1)
      if (calls.length <= 2) {
        return Promise.resolve(payloads[calls.length - 1])
      }

      // The FAILED move's honored revalidation stays held here.
      return new Promise<ApiPersonalWorkItem[]>((resolve) => {
        resolveThird = resolve
      })
    })

    const { container } = renderPage()
    await screen.findByRole('button', {
      name: 'Open Beta',
    })
    const source = lastSource()
    openHandshake(source)
    await waitFor(() => expect(calls).toHaveLength(2))

    const reorder = startPendingReorder()
    await dragCardToColumn(
      container,
      screen.getByRole('button', { name: 'Open Beta' }),
      'todo',
      STUB_CARD_TOP + 20,
    )

    // An EXTERNAL event arrives while the move is pending.
    fireMyWorkChanged(source)
    await settle()
    expect(calls).toHaveLength(2)

    // The mutation fails: the drop error surfaces, the visible
    // order is intact (no optimistic move was made) — and the
    // held invalidation is honored with exactly one canonical
    // revalidation, independent of the failed mutation.
    await reorder.reject()
    await waitFor(() => expect(calls).toHaveLength(3))
    expect(columnCardIds(container, 'todo')).toEqual([
      '100',
      '200',
    ])
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Work item could not be moved.',
    )

    // The revalidation answer adopts the external change —
    // mutation failure and revalidation are correctly separated.
    await act(async () => {
      resolveThird?.(payloads[2])
    })
    await screen.findByRole('button', {
      name: 'Open External change',
    })
    expect(calls).toHaveLength(3)
  })

  it('keeps the rendered data when a realtime revalidation fails (no retry loop)', async () => {
    let call = 0
    vi.mocked(listMyWork).mockImplementation(() => {
      call += 1
      if (call >= 3) {
        return Promise.reject(new Error('network down'))
      }

      return Promise.resolve([TODO_ITEM])
    })

    renderPage()
    await screen.findByRole('button', {
      name: 'Open Alpha',
    })
    const source = lastSource()
    openHandshake(source)
    await waitFor(() => expect(call).toBe(2))

    fireMyWorkChanged(source)
    await waitFor(() => expect(call).toBe(3))
    await settle()

    // The rendered board is NOT removed by the failed
    // revalidation; the existing error surface reports it.
    expect(
      screen.getByRole('button', { name: 'Open Alpha' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'My Work could not be refreshed.',
    )

    // No retry loop: the failed revalidation does not re-arm.
    await settle()
    expect(call).toBe(3)
  })
})

/* ── 6. Persisted preferences stay untouched ───────────────────── */

describe('My Work realtime — persisted preferences', () => {
  it('preserves the persisted view mode and filters across a realtime refetch', async () => {
    const PROJECT_B_ITEM = makeItem({
      id: 200,
      title: 'Beta',
      projectId: 12,
      projectName: 'Project Beta',
      researchGroupId: 2,
      researchGroupName: 'Research Group B',
      createdAt: '2026-09-02T00:00:00Z',
    })
    const PROJECT_B_NEW = makeItem({
      id: 201,
      title: 'Beta new',
      projectId: 12,
      projectName: 'Project Beta',
      researchGroupId: 2,
      researchGroupName: 'Research Group B',
      createdAt: '2026-09-03T00:00:00Z',
    })
    // Persisted personal view state: LIST mode with the Project B
    // filter active (the Project A item is filtered out).
    vi.mocked(fetchMyWorkPreferences).mockResolvedValue(
      makePreferences({
        viewMode: 'list',
        projectIds: [12],
      }),
    )
    queueMyWork([
      [TODO_ITEM, PROJECT_B_ITEM],
      [TODO_ITEM, PROJECT_B_ITEM],
      [TODO_ITEM, PROJECT_B_ITEM, PROJECT_B_NEW],
    ])

    renderPage()
    // List view from the persisted snapshot; only the filtered
    // Project B item renders.
    await screen.findByRole('button', {
      name: 'Open Beta',
    })
    expect(
      screen.queryByRole('button', {
        name: 'Open Alpha',
      }),
    ).toBeNull()
    const source = lastSource()
    openHandshake(source)
    await waitFor(() =>
      expect(listMyWork).toHaveBeenCalledTimes(2))

    // The realtime refetch replaces the ITEMS only: the new item
    // appears, the view mode (List) and the project filter
    // survive, and the filtered-out Project A item stays hidden.
    fireMyWorkChanged(source)
    await screen.findByRole('button', {
      name: 'Open Beta new',
    })
    expect(listMyWork).toHaveBeenCalledTimes(3)
    expect(
      screen.getByRole('button', { name: 'Open Beta' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', {
        name: 'Open Alpha',
      }),
    ).toBeNull()
    // The Board button is still present (view switch available);
    // the List view is still active (no items section hidden).
    expect(
      screen.getByRole('button', { name: 'List' }),
    ).toBeInTheDocument()

    // No preferences GET or PATCH through the realtime path.
    expect(fetchMyWorkPreferences).toHaveBeenCalledTimes(1)
    expect(updateMyWorkPreferences).not.toHaveBeenCalled()
  })

  it('keeps a locally chosen (unsaved) view mode across a realtime refetch', async () => {
    const NEW = makeItem({
      id: 800,
      title: 'Gamma',
      createdAt: '2026-09-06T00:00:00Z',
    })
    // Persisted: List.
    vi.mocked(fetchMyWorkPreferences).mockResolvedValue(
      makePreferences({ viewMode: 'list' }),
    )
    queueMyWork([
      [TODO_ITEM],
      [TODO_ITEM],
      [TODO_ITEM, NEW],
    ])

    const { container } = renderPage()
    await screen.findByRole('button', {
      name: 'Open Alpha',
    })
    const source = lastSource()
    openHandshake(source)
    await waitFor(() =>
      expect(listMyWork).toHaveBeenCalledTimes(2))

    // Local (NOT yet saved) view change: List → Board. The
    // debounced save is the page's own logic, not realtime's.
    await switchView('Board')
    expect(container.querySelector('[data-board-column]')).not.toBeNull()

    // The realtime refetch must not revert the local choice.
    fireMyWorkChanged(source)
    await screen.findByRole('button', {
      name: 'Open Gamma',
    })
    expect(listMyWork).toHaveBeenCalledTimes(3)
    expect(container.querySelector('[data-board-column]')).not.toBeNull()
    // The local choice is still what renders.
    expect(
      screen.queryByRole('button', {
        name: 'Open Alpha',
      }),
    ).toBeInTheDocument()

    // The page's OWN debounce eventually saves the local change —
    // exactly once, with the locally chosen snapshot. The realtime
    // refetch above issues no preferences request of its own.
    await waitFor(() =>
      expect(updateMyWorkPreferences).toHaveBeenCalledTimes(1))
    expect(updateMyWorkPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ viewMode: 'board' }),
    )
    expect(fetchMyWorkPreferences).toHaveBeenCalledTimes(1)
  })

  it('issues no preferences GET or PATCH through realtime', async () => {
    const NEW = makeItem({
      id: 801,
      title: 'Gamma',
      createdAt: '2026-09-07T00:00:00Z',
    })
    queueMyWork([
      [TODO_ITEM],
      [TODO_ITEM],
      [TODO_ITEM, NEW],
      [TODO_ITEM, NEW],
    ])

    renderPage()
    await screen.findByRole('button', {
      name: 'Open Alpha',
    })
    const source = lastSource()
    openHandshake(source)
    await waitFor(() =>
      expect(listMyWork).toHaveBeenCalledTimes(2))

    // Several personal refetches in a row (initial handshake
    // already issued one above).
    fireMyWorkChanged(source)
    await waitFor(() =>
      expect(listMyWork).toHaveBeenCalledTimes(3))
    fireMyWorkChanged(source)
    await waitFor(() =>
      expect(listMyWork).toHaveBeenCalledTimes(4))
    await settle()

    // Exactly ONE preferences GET (the initial load) and NO
    // preferences PATCH — across every realtime refetch.
    expect(fetchMyWorkPreferences).toHaveBeenCalledTimes(1)
    expect(updateMyWorkPreferences).not.toHaveBeenCalled()
  })
})

/* ── 7. Session loss and unmount: no late state updates ────────── */

describe('My Work realtime — session loss and unmount', () => {
  it('session loss and unmount prevent late state updates', async () => {
    const LATE = makeItem({
      id: 900,
      title: 'Late change',
      createdAt: '2026-09-12T00:00:00Z',
    })
    const calls: number[] = []
    let resolveEventFetch:
      | ((items: ApiPersonalWorkItem[]) => void)
      | null = null

    vi.mocked(listMyWork).mockImplementation(() => {
      calls.push(calls.length + 1)
      if (calls.length <= 2) return Promise.resolve([TODO_ITEM])

      return new Promise<ApiPersonalWorkItem[]>((resolve) => {
        resolveEventFetch = resolve
      })
    })

    const rendered = renderPage()
    await screen.findByRole('button', {
      name: 'Open Alpha',
    })
    const source = lastSource()
    openHandshake(source)
    await waitFor(() => expect(calls).toHaveLength(2))

    // An event refetch is in flight when the session is lost.
    fireMyWorkChanged(source)
    await waitFor(() => expect(calls).toHaveLength(3))

    // Session loss: the app's session state clears (the hook's
    // session gate stops the stream) and the app redirects away,
    // which unmounts the surface.
    mockSessionUser.current = null
    await act(async () => {
      rendered.rerender(
        <MemoryRouter initialEntries={['/my-work']}>
          <Routes>
            <Route
              path="/my-work"
              element={<MyWorkPage />}
            />
          </Routes>
        </MemoryRouter>,
      )
    })
    expect(source.closed).toBe(true)
    expect(MockEventSource.instances).toHaveLength(1)

    await act(async () => {
      rendered.unmount()
    })

    // The stale in-flight answer settles after the unmount: no
    // side effects, no new fetch, no crash.
    await act(async () => {
      resolveEventFetch?.([TODO_ITEM, LATE])
    })
    await settle()
    expect(calls).toHaveLength(3)
    expect(MockEventSource.instances).toHaveLength(1)
  })
})

/* ── 8. Degraded mode ──────────────────────────────────────────── */

describe('My Work realtime — degraded mode', () => {
  it('keeps the surface operable while the stream is down', async () => {
    queueMyWork([[TODO_ITEM]])

    renderPage()
    await screen.findByRole('button', {
      name: 'Open Alpha',
    })
    const first = lastSource()
    openHandshake(first)
    await waitFor(() =>
      expect(listMyWork).toHaveBeenCalledTimes(2))
    // No indicator for the normal initial connection.
    expect(syncPausedIndicator()).toBeNull()

    // The stream suffers a response-level failure: degraded mode.
    terminalFailure(first)
    expect(me).toHaveBeenCalledTimes(1)

    // A subdued, non-blocking sync-paused indicator appears —
    // no modal, no toast, no loading shell; existing data stays
    // visible.
    expect(syncPausedIndicator()).not.toBeNull()
    expect(
      screen.getByRole('status').textContent,
    ).toContain('Sync paused')
    expect(
      screen.getByRole('button', { name: 'Open Alpha' }),
    ).toBeInTheDocument()

    // The surface stays operable while the stream is down: a
    // Board/List switch is presentation-only and works without a
    // refetch.
    await switchView('List')
    expect(
      screen.getByRole('button', { name: 'Open Alpha' }),
    ).toBeInTheDocument()
    expect(listMyWork).toHaveBeenCalledTimes(2)
    // Still degraded: the indicator remains until the stream is
    // re-established.
    expect(syncPausedIndicator()).not.toBeNull()

    // The controlled reconnect lands: the indicator goes away and
    // the open handshake refetches the surface once (RC-5).
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 20)
      })
    })
    const second = lastSource()
    expect(MockEventSource.instances).toHaveLength(2)
    openHandshake(second)
    await waitFor(() =>
      expect(listMyWork).toHaveBeenCalledTimes(3))
    expect(syncPausedIndicator()).toBeNull()
  })

  it('shows no sync-paused indicator while the stream is connected', async () => {
    queueMyWork([[TODO_ITEM]])

    renderPage()
    await screen.findByRole('button', {
      name: 'Open Alpha',
    })
    const source = lastSource()
    openHandshake(source)
    await waitFor(() =>
      expect(listMyWork).toHaveBeenCalledTimes(2))
    await settle()

    // Connected: no indicator (a quiet surface shows nothing).
    expect(syncPausedIndicator()).toBeNull()
    // A personal event while connected refetches silently — no
    // indicator, no modal, no toast, no loading shell.
    fireMyWorkChanged(source)
    await waitFor(() =>
      expect(listMyWork).toHaveBeenCalledTimes(3))
    expect(syncPausedIndicator()).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Open Alpha' }),
    ).toBeInTheDocument()
  })
})
