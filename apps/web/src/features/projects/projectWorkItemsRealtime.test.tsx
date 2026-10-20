// @vitest-environment happy-dom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import {
  MemoryRouter,
  Route,
  Routes,
  useNavigate,
} from 'react-router'
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
  getProject,
  getProjectWorkItemConfiguration,
  listProjectMemberships,
  listResearchGroupMembers,
} from '../../api/projects'
import {
  listProjectWorkItems,
  reorderWorkItem,
} from '../../api/work-items'
import type {
  ApiProject,
  ApiProjectMembership,
  ApiProjectWorkItemConfiguration,
  ApiResearchGroupMember,
  ApiUser,
  ApiWorkItem,
} from '../../api/types'

import { ProjectDetailPage } from './ProjectDetailPage'

vi.mock('../../api/projects', () => ({
  getProject: vi.fn(),
  getProjectWorkItemConfiguration: vi.fn(),
  listProjectMemberships: vi.fn(),
  listResearchGroupMembers: vi.fn(),
  addProjectMembership: vi.fn(),
  archiveProject: vi.fn(),
  deleteProject: vi.fn(),
  removeProjectMembership: vi.fn(),
  restoreProject: vi.fn(),
  updateProject: vi.fn(),
  updateProjectMembership: vi.fn(),
}))

vi.mock('../../api/work-items', () => ({
  createWorkItem: vi.fn(),
  deleteWorkItem: vi.fn(),
  listProjectWorkItems: vi.fn(),
  reorderWorkItem: vi.fn(),
  updateWorkItem: vi.fn(),
}))

vi.mock('../../api/auth', () => ({
  me: vi.fn(),
}))

// The session is a mutable box so a test can simulate session loss
// (logout / server-side invalidation) on the mounted page. The hook
// reads the session on every render, exactly like the app's
// SessionProvider state does.
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

vi.mock('../research-group/useSyncResearchGroupContext', () => ({
  useSyncResearchGroupContext: () => {},
}))

vi.mock('./WorkItemDrawer', () => ({
  WorkItemDrawer: () => null,
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

/** One `work_item_changed` invalidation for the given Project. */
function fireWorkItemChanged(projectId: number): void {
  act(() => {
    lastSource().fire(
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

const NOW = '2026-10-01T00:00:00Z'

const PROJECT_A: ApiProject = {
  id: 7,
  researchGroupId: 1,
  name: 'Project A',
  description: 'A project.',
  status: 'active',
  archivedAt: null,
  currentUserRole: 'owner',
  createdAt: NOW,
  updatedAt: NOW,
}

const PROJECT_B: ApiProject = {
  id: 8,
  researchGroupId: 1,
  name: 'Project B',
  description: 'B project.',
  status: 'active',
  archivedAt: null,
  currentUserRole: 'owner',
  createdAt: NOW,
  updatedAt: NOW,
}

const MEMBERSHIP = {
  id: 1,
  role: 'owner',
  addedAt: NOW,
  user: {
    id: 1,
    username: 'alex',
    firstName: 'Alex',
    lastName: '',
  },
} satisfies ApiProjectMembership

const GROUP_MEMBERS: ApiResearchGroupMember[] = [
  {
    id: 1,
    username: 'alex',
    firstName: 'Alex',
    lastName: '',
    researchGroupRole: 'admin',
  },
]

const CONFIGURATION: ApiProjectWorkItemConfiguration = {
  types: [
    {
      id: 4,
      name: 'Task',
      kind: 'task',
      order: 0,
      active: true,
    },
  ],
  statuses: [
    {
      id: 10,
      name: 'To do',
      category: 'todo',
      order: 0,
      active: true,
      isDefault: true,
    },
    {
      id: 11,
      name: 'In progress',
      category: 'in_progress',
      order: 1,
      active: true,
      isDefault: false,
    },
  ],
  labels: [],
}

function makeWorkItem(
  overrides: Partial<ApiWorkItem> = {},
): ApiWorkItem {
  return {
    id: 101,
    projectId: 7,
    title: 'Alpha',
    description: '',
    typeDefinitionId: 4,
    statusDefinitionId: 10,
    boardPosition: 1,
    labelDefinitionIds: [],
    assigneeIds: [],
    parentId: null,
    dueDate: null,
    blockedReason: null,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    createdById: 1,
    meetingOrigin: null,
    ...overrides,
  }
}

const ALPHA = makeWorkItem({ id: 101, title: 'Alpha' })
const BETA = makeWorkItem({
  id: 102,
  title: 'Beta',
  boardPosition: 2,
})

/* ── API mock helpers ──────────────────────────────────────────── */

interface ListCall {
  projectId: number
  n: number
}

/**
 * Per-project answer queues for `listProjectWorkItems` (first entry
 * = initial load; the last entry repeats for every later call of
 * that project). Returns the call log (projectId per call, in
 * order).
 */
function queueWorkItems(
  queues: Record<number, ApiWorkItem[][]>,
): ListCall[] {
  const calls: ListCall[] = []

  vi.mocked(listProjectWorkItems).mockImplementation(
    (projectId: number) => {
      const n =
        calls.filter(
          (call) => call.projectId === projectId,
        ).length + 1
      calls.push({ projectId, n })
      const queue = queues[projectId] ?? [[]]

      return Promise.resolve(
        queue[Math.min(n - 1, queue.length - 1)],
      )
    },
  )

  return calls
}

function mockBaseProjectData(): void {
  vi.mocked(getProject).mockImplementation((id) =>
    Promise.resolve(id === 7 ? PROJECT_A : PROJECT_B),
  )
  vi.mocked(getProjectWorkItemConfiguration).mockResolvedValue(
    CONFIGURATION,
  )
  vi.mocked(listProjectMemberships).mockResolvedValue([
    MEMBERSHIP,
  ])
  vi.mocked(listResearchGroupMembers).mockResolvedValue(
    GROUP_MEMBERS,
  )
}

type Deferred<T> = {
  resolve: (value: T) => void
  reject: (reason: Error) => void
}

/** Every reorder mutation is held until the test settles it. */
function holdReorders(): Deferred<ApiWorkItem>[] {
  const reorders: Deferred<ApiWorkItem>[] = []

  vi.mocked(reorderWorkItem).mockImplementation(() =>
    new Promise<ApiWorkItem>((resolve, reject) => {
      reorders.push({ resolve, reject })
    }),
  )

  return reorders
}

/* ── Board drag & drop helpers (same native HTML5 sequence the
       existing Board continuity tests use) ─────────────────────── */

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

function stubBoardColumnCardRects(column: HTMLElement) {
  Array.from(
    column.querySelectorAll<HTMLElement>(
      '[data-board-card]',
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

async function fireBoardColumnDragOver(
  column: HTMLElement,
  dataTransfer: unknown,
  clientY: number,
) {
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

async function dropCardOnBoardColumn(
  container: HTMLElement,
  card: HTMLElement,
  columnStatus: string,
  clientY?: number,
) {
  const column = boardColumn(container, columnStatus)
  stubBoardColumnCardRects(column)

  const cards = Array.from(
    column.querySelectorAll('[data-board-card]'),
  )

  const y =
    clientY ??
    STUB_CARD_TOP +
      cards.length * (STUB_CARD_HEIGHT + STUB_CARD_GAP)

  const dataTransfer = makeDataTransfer()

  await act(async () => {
    fireEvent.dragStart(card, { dataTransfer })
  })

  await fireBoardColumnDragOver(column, dataTransfer, y)

  await act(async () => {
    fireEvent.drop(column, { dataTransfer })
    fireEvent.dragEnd(card, { dataTransfer })
  })
}

function boardColumn(
  container: HTMLElement,
  status: string,
): HTMLElement {
  return container.querySelector(
    `[data-board-column="${status}"]`,
  ) as HTMLElement
}

function columnCardIds(
  container: HTMLElement,
  status: string,
): string[] {
  return Array.from(
    boardColumn(container, status).querySelectorAll(
      '[data-work-item-id]',
    ),
  ).map((el) => el.getAttribute('data-work-item-id') ?? '')
}

/* ── Page rendering ────────────────────────────────────────────── */

let navigateTo: ((to: string) => void) | null = null

function NavigationProbe() {
  navigateTo = useNavigate()
  return null
}

async function go(path: string): Promise<void> {
  await act(async () => {
    navigateTo?.(path)
  })
}

/**
 * Renders the mounted page at `path`. Both Project A and B routes
 * resolve to the SAME page instance, so project switches exercise
 * the real generation machinery.
 */
function renderProjectPage(path: string) {
  navigateTo = null

  return render(
    <MemoryRouter initialEntries={[path]}>
      <NavigationProbe />

      <Routes>
        <Route
          path="/projects/:projectId"
          element={<ProjectDetailPage />}
        />

        <Route
          path="/projects/:projectId/:tab"
          element={<ProjectDetailPage />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

/** Renders the Work Items tab and waits for the Board to exist. */
async function renderWorkItemsBoard(firstCardTitle: string) {
  const rendered = renderProjectPage('/projects/7/work-items')

  await screen.findByRole('button', {
    name: `Open ${firstCardTitle}`,
  })

  return rendered
}

beforeEach(() => {
  MockEventSource.instances = []
  mockSessionUser.current = TEST_USER
  vi.mocked(me).mockReset().mockResolvedValue(TEST_USER)
  // RC-3 backoff: deterministic 0 ms delays in reconnect tests.
  vi.spyOn(Math, 'random').mockReturnValue(0)
  vi.stubGlobal('EventSource', MockEventSource)
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

describe('Project Work Items realtime — stream lifecycle', () => {
  it('opens exactly one stream for the authenticated Work Items surface', async () => {
    mockBaseProjectData()
    queueWorkItems({ 7: [[ALPHA]] })

    await renderWorkItemsBoard('Alpha')

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

  it('starts no stream on a non-Work-Items tab', async () => {
    mockBaseProjectData()
    queueWorkItems({ 7: [[]] })

    renderProjectPage('/projects/7/overview')
    await screen.findByRole('heading', { name: 'About' })

    expect(MockEventSource.instances).toHaveLength(0)
  })

  it('closes the stream on tab leave and on unmount', async () => {
    mockBaseProjectData()
    queueWorkItems({ 7: [[ALPHA]] })

    const rendered = await renderWorkItemsBoard('Alpha')
    const source = lastSource()
    openHandshake(source)
    await settle()

    // Leave the surface: the connection closes, no new instance.
    await go('/projects/7/overview')
    await screen.findByRole('heading', { name: 'About' })

    expect(source.closed).toBe(true)
    expect(MockEventSource.instances).toHaveLength(1)

    // Re-entering the surface opens a fresh connection (a NEW
    // controller — stop is terminal by design).
    await go('/projects/7/work-items')
    await screen.findByRole('button', { name: 'Open Alpha' })
    expect(MockEventSource.instances).toHaveLength(2)
    expect(MockEventSource.instances[1]!.closed).toBe(false)

    // Unmount closes it again.
    await act(async () => {
      rendered.unmount()
    })
    expect(MockEventSource.instances[1]!.closed).toBe(true)
    expect(MockEventSource.instances).toHaveLength(2)
  })

  it('closes the stream and discards in-flight answers on session loss', async () => {
    mockBaseProjectData()
    const calls = queueWorkItems({ 7: [[ALPHA]] })

    let resolveThird: (items: ApiWorkItem[]) => void = () => {}
    vi.mocked(listProjectWorkItems).mockImplementation(
      (projectId: number) => {
        const n =
          calls.filter(
            (call) => call.projectId === projectId,
          ).length + 1
        calls.push({ projectId, n })
        if (n === 3) {
          return new Promise<ApiWorkItem[]>((resolve) => {
            resolveThird = resolve
          })
        }
        return Promise.resolve([ALPHA])
      },
    )

    const rendered = await renderWorkItemsBoard('Alpha')
    const source = lastSource()
    openHandshake(source)
    await waitFor(() => expect(calls).toHaveLength(2))

    // An event refetch is in flight when the session is lost.
    fireWorkItemChanged(7)
    await waitFor(() => expect(calls).toHaveLength(3))

    // Session loss: the app's session state clears (the hook's
    // session gate stops the stream) and the surface leaves with
    // it — the app redirects to the sign-in surface.
    mockSessionUser.current = null
    await act(async () => {
      rendered.rerender(
        <MemoryRouter initialEntries={['/projects/7/work-items']}>
          <NavigationProbe />

          <Routes>
            <Route
              path="/projects/:projectId"
              element={<ProjectDetailPage />}
            />

            <Route
              path="/projects/:projectId/:tab"
              element={<ProjectDetailPage />}
            />
          </Routes>
        </MemoryRouter>,
      )
    })

    expect(source.closed).toBe(true)
    expect(MockEventSource.instances).toHaveLength(1)

    // The redirect unmounts the protected surface.
    await act(async () => {
      rendered.unmount()
    })

    // The stale in-flight answer settles after the unmount: no
    // side effects, no new fetch, no crash.
    await act(async () => {
      resolveThird([ALPHA, BETA])
    })
    await settle()

    expect(calls).toHaveLength(3)
    expect(MockEventSource.instances).toHaveLength(1)
  })
})

/* ── 2. Project-scoped invalidations ───────────────────────────── */

describe('Project Work Items realtime — project invalidations', () => {
  it('refetches the canonical list for an event of the open Project', async () => {
    const EXTERNAL = makeWorkItem({
      id: 500,
      title: 'External change',
      boardPosition: 3,
    })
    mockBaseProjectData()
    const calls = queueWorkItems({
      7: [
        [ALPHA],
        [ALPHA],
        [ALPHA, EXTERNAL],
      ],
    })

    await renderWorkItemsBoard('Alpha')
    const source = lastSource()
    openHandshake(source)
    await waitFor(() => expect(calls).toHaveLength(2))

    fireWorkItemChanged(7)

    // The RENDERED card and the ACTUAL API call are the contract:
    // one canonical revalidation of the open Project's list.
    await screen.findByRole('button', {
      name: 'Open External change',
    })
    expect(calls).toEqual([
      { projectId: 7, n: 1 },
      { projectId: 7, n: 2 },
      { projectId: 7, n: 3 },
    ])
  })

  it('ignores events for other Projects', async () => {
    mockBaseProjectData()
    const calls = queueWorkItems({ 7: [[ALPHA]] })

    await renderWorkItemsBoard('Alpha')
    const source = lastSource()
    openHandshake(source)
    await waitFor(() => expect(calls).toHaveLength(2))

    fireWorkItemChanged(8)
    await settle()

    // No refetch, the rendered Board is untouched.
    expect(calls).toHaveLength(2)
    expect(
      screen.getByRole('button', { name: 'Open Alpha' }),
    ).toBeInTheDocument()
  })

  it('does not consume my_work_changed in this slice', async () => {
    mockBaseProjectData()
    const calls = queueWorkItems({ 7: [[ALPHA]] })

    await renderWorkItemsBoard('Alpha')
    const source = lastSource()
    openHandshake(source)
    await waitFor(() => expect(calls).toHaveLength(2))

    act(() => {
      source.fire('my_work_changed', JSON.stringify({}))
    })
    await settle()

    expect(calls).toHaveLength(2)
  })

  it('coalesces a burst of events into a single extra fetch', async () => {
    const EXTERNAL = makeWorkItem({
      id: 500,
      title: 'External change',
      boardPosition: 3,
    })
    mockBaseProjectData()
    const calls = queueWorkItems({
      7: [
        [ALPHA],
        [ALPHA],
        [ALPHA, EXTERNAL],
      ],
    })

    await renderWorkItemsBoard('Alpha')
    const source = lastSource()
    openHandshake(source)
    await waitFor(() => expect(calls).toHaveLength(2))

    // Five fast events for the open Project: at most ONE extra
    // request (no request flood), and the final state lands.
    act(() => {
      for (let i = 0; i < 5; i += 1) {
        source.fire(
          'work_item_changed',
          JSON.stringify({ projectId: 7 }),
        )
      }
    })
    await settle()

    expect(calls).toHaveLength(3)
    await screen.findByRole('button', {
      name: 'Open External change',
    })

    // ...and no further fetch follows the settled burst.
    await settle()
    expect(calls).toHaveLength(3)
  })

  it('does not lose an event that arrives while a fetch is in flight', async () => {
    const MID = makeWorkItem({
      id: 501,
      title: 'Mid change',
      boardPosition: 2,
    })
    const FINAL = makeWorkItem({
      id: 502,
      title: 'Final change',
      boardPosition: 3,
    })
    mockBaseProjectData()
    const calls = queueWorkItems({ 7: [[ALPHA]] })

    let resolveThird: (items: ApiWorkItem[]) => void = () => {}
    let resolveFourth: (items: ApiWorkItem[]) => void = () => {}
    vi.mocked(listProjectWorkItems).mockImplementation(
      (projectId: number) => {
        const n =
          calls.filter(
            (call) => call.projectId === projectId,
          ).length + 1
        calls.push({ projectId, n })
        if (n === 1) return Promise.resolve([ALPHA])
        if (n === 2) return Promise.resolve([ALPHA])
        if (n === 3) {
          return new Promise<ApiWorkItem[]>((resolve) => {
            resolveThird = resolve
          })
        }
        return new Promise<ApiWorkItem[]>((resolve) => {
          resolveFourth = resolve
        })
      },
    )

    await renderWorkItemsBoard('Alpha')
    const source = lastSource()
    openHandshake(source)
    await waitFor(() => expect(calls).toHaveLength(2))

    // Event A triggers a refetch that is held in flight.
    fireWorkItemChanged(7)
    await waitFor(() => expect(calls).toHaveLength(3))

    // Event B arrives while that fetch is in flight: coalesced,
    // not lost (no 4th fetch yet).
    fireWorkItemChanged(7)
    await settle()
    expect(calls).toHaveLength(3)

    // The in-flight answer settles with a state that predates
    // Event B: Event A's change is adopted.
    await act(async () => {
      resolveThird([ALPHA, MID])
    })
    await screen.findByRole('button', { name: 'Open Mid change' })

    // The held invalidation flushes exactly ONE follow-up fetch
    // (held here as well), and its answer adopts the FINAL server
    // state.
    await waitFor(() => expect(calls).toHaveLength(4))
    await act(async () => {
      resolveFourth([ALPHA, FINAL])
    })
    await screen.findByRole('button', {
      name: 'Open Final change',
    })
    expect(calls).toHaveLength(4)
  })
})

/* ── 3. RC-5: authoritative revalidation on every open handshake ── */

describe('Project Work Items realtime — RC-5 reconnection', () => {
  it('revalidates once on the native reconnect handshake', async () => {
    const EXTERNAL = makeWorkItem({
      id: 500,
      title: 'External change',
      boardPosition: 3,
    })
    mockBaseProjectData()
    const calls = queueWorkItems({
      7: [
        [ALPHA],
        [ALPHA],
        [ALPHA, EXTERNAL],
      ],
    })

    await renderWorkItemsBoard('Alpha')
    const source = lastSource()
    openHandshake(source)
    await waitFor(() => expect(calls).toHaveLength(2))

    // A connection-level interruption (native retry, RC-1): the
    // SAME instance is kept and no auth check is issued.
    connectingError(source)
    expect(MockEventSource.instances).toHaveLength(1)
    expect(me).not.toHaveBeenCalled()

    // The re-established stream sends a fresh open handshake —
    // exactly one authoritative revalidation follows.
    openHandshake(source)
    await waitFor(() => expect(calls).toHaveLength(3))
    await screen.findByRole('button', {
      name: 'Open External change',
    })

    await settle()
    expect(calls).toHaveLength(3)
  })

  it('revalidates once on the controlled reconnect handshake', async () => {
    const EXTERNAL = makeWorkItem({
      id: 500,
      title: 'External change',
      boardPosition: 3,
    })
    mockBaseProjectData()
    const calls = queueWorkItems({
      7: [
        [ALPHA],
        [ALPHA],
        [ALPHA, EXTERNAL],
      ],
    })

    await renderWorkItemsBoard('Alpha')
    const first = lastSource()
    openHandshake(first)
    await waitFor(() => expect(calls).toHaveLength(2))

    // A response-level failure: the closed instance is dropped and
    // a controlled reconnect follows the fresh auth check (RC-2 /
    // RC-4).
    terminalFailure(first)
    expect(me).toHaveBeenCalledTimes(1)
    // The response-level failure already put the instance into
    // the spec's terminal state; the controller drops it (it is
    // never reused).
    expect(first.readyState).toBe(MockEventSource.CLOSED)

    // RC-3 backoff (deterministic 0 ms) — exactly one NEW
    // instance, never the closed one.
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 20)
      })
    })
    expect(MockEventSource.instances).toHaveLength(2)
    expect(MockEventSource.instances[1]).not.toBe(first)

    // The new connection's open handshake revalidates the open
    // surface exactly once.
    openHandshake(MockEventSource.instances[1]!)
    await waitFor(() => expect(calls).toHaveLength(3))
    await screen.findByRole('button', {
      name: 'Open External change',
    })

    await settle()
    expect(calls).toHaveLength(3)
  })
})

/* ── 4. Optimistic drop protection ─────────────────────────────── */

describe('Project Work Items realtime — optimistic drop protection', () => {
  it('does not roll back an optimistic drop for an event during the pending mutation', async () => {
    mockBaseProjectData()
    const calls = queueWorkItems({ 7: [[ALPHA, BETA]] })
    holdReorders()

    const { container } = await renderWorkItemsBoard('Alpha')
    const source = lastSource()
    openHandshake(source)
    await waitFor(() => expect(calls).toHaveLength(2))

    // Drop Alpha (todo → in_progress); the mutation stays in flight.
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Alpha' }),
      'in_progress',
    )
    expect(reorderWorkItem).toHaveBeenCalledTimes(1)
    expect(columnCardIds(container, 'todo')).toEqual(['102'])
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '101',
    ])

    // An external event for the same Project arrives while the
    // drop is pending: it may NOT issue a fetch whose answer
    // would predate the drop (the existing drop guards would
    // discard it), and the optimistic card stays put.
    fireWorkItemChanged(7)
    await settle()

    expect(calls).toHaveLength(2)
    expect(columnCardIds(container, 'todo')).toEqual(['102'])
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '101',
    ])
  })

  it('shows the canonical server state after a successful drop', async () => {
    const EXTERNAL = makeWorkItem({
      id: 500,
      title: 'External change',
      statusDefinitionId: 11,
      boardPosition: 2,
    })
    const MOVED = makeWorkItem({
      id: 101,
      title: 'Alpha',
      statusDefinitionId: 11,
      boardPosition: 1,
    })
    mockBaseProjectData()
    const calls = queueWorkItems({
      7: [
        [ALPHA],
        [ALPHA],
        [MOVED, EXTERNAL],
      ],
    })
    const reorders = holdReorders()

    const { container } = await renderWorkItemsBoard('Alpha')
    const source = lastSource()
    openHandshake(source)
    await waitFor(() => expect(calls).toHaveLength(2))

    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Alpha' }),
      'in_progress',
    )
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '101',
    ])

    // The mutation succeeds; the drop's own canonical
    // revalidation adopts the authoritative server state
    // (including the concurrent external change).
    await act(async () => {
      reorders[0].resolve(MOVED)
    })
    await screen.findByRole('button', {
      name: 'Open External change',
    })
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '101',
      '500',
    ])
    expect(calls).toHaveLength(3)
  })

  it('rolls back a failed drop and still honors the held invalidation', async () => {
    mockBaseProjectData()
    const calls = queueWorkItems({ 7: [[ALPHA, BETA]] })
    const reorders = holdReorders()

    const { container } = await renderWorkItemsBoard('Alpha')
    const source = lastSource()
    openHandshake(source)
    await waitFor(() => expect(calls).toHaveLength(2))

    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Alpha' }),
      'in_progress',
    )

    // An external event arrives while the drop is pending.
    fireWorkItemChanged(7)
    await settle()
    expect(calls).toHaveLength(2)

    // The mutation fails: the optimistic move rolls back and the
    // drop error surfaces.
    await act(async () => {
      reorders[0].reject(new Error('boom'))
    })
    expect(columnCardIds(container, 'todo')).toEqual([
      '101',
      '102',
    ])
    expect(columnCardIds(container, 'in_progress')).toEqual([])
    expect(
      screen.getByText('Work item could not be moved.'),
    ).toBeInTheDocument()

    // The held invalidation is processed after the LAST pending
    // drop settles — exactly one canonical revalidation.
    await waitFor(() => expect(calls).toHaveLength(3))
    await settle()
    expect(calls).toHaveLength(3)
    expect(columnCardIds(container, 'todo')).toEqual([
      '101',
      '102',
    ])
  })
})

/* ── 5. Project switches (A → B → A) ───────────────────────────── */

describe('Project Work Items realtime — project switches', () => {
  const A1 = makeWorkItem({ id: 101, title: 'A One' })
  const A2 = makeWorkItem({
    id: 102,
    title: 'A Two',
    boardPosition: 2,
  })
  const A3 = makeWorkItem({
    id: 103,
    title: 'A Three',
    boardPosition: 3,
  })
  const B1 = makeWorkItem({
    id: 201,
    title: 'B One',
    projectId: 8,
  })

  it('protects A → B → A from stale events and stale answers', async () => {
    mockBaseProjectData()
    const calls = queueWorkItems({
      7: [[A1, A2]],
      8: [[B1]],
    })

    // Hold A's event-triggered refetch so it can settle STALE,
    // after the user has already left Project A.
    let resolveStaleA: (items: ApiWorkItem[]) => void = () => {}
    vi.mocked(listProjectWorkItems).mockImplementation(
      (projectId: number) => {
        const n =
          calls.filter(
            (call) => call.projectId === projectId,
          ).length + 1
        calls.push({ projectId, n })
        if (projectId === 8) return Promise.resolve([B1])
        if (n === 1) return Promise.resolve([A1, A2])
        if (n === 2) return Promise.resolve([A1, A2])
        if (n === 3) {
          return new Promise<ApiWorkItem[]>((resolve) => {
            resolveStaleA = resolve
          })
        }
        // Fresh re-entry into A: the authoritative server state
        // (A Three was created while the user was away).
        return Promise.resolve([A1, A2, A3])
      },
    )

    const { container } = await renderWorkItemsBoard('A One')
    const source = lastSource()
    openHandshake(source)
    await waitFor(() => expect(calls).toHaveLength(2))

    // An event for A triggers a refetch that is still in flight
    // when the user switches projects.
    fireWorkItemChanged(7)
    await waitFor(() =>
      expect(calls.some((c) => c.n === 3 && c.projectId === 7))
        .toBe(true),
    )

    // A → B inside the SAME mounted page instance.
    await go('/projects/8/work-items')
    await screen.findByRole('button', { name: 'Open B One' })
    expect(columnCardIds(container, 'todo')).toEqual(['201'])

    // A late event for the ABANDONED project is ignored: no
    // refetch of Project 7 while Project B is open.
    fireWorkItemChanged(7)
    await settle()
    expect(
      calls.filter((c) => c.projectId === 7).length,
    ).toBe(3)

    // An event for the CURRENT project still works on the new
    // surface.
    fireWorkItemChanged(8)
    await settle()
    expect(
      calls.filter((c) => c.projectId === 8).length,
    ).toBe(2)

    // The STALE A refetch now answers: it must not touch the
    // rendered Project B board.
    await act(async () => {
      resolveStaleA([A1, A2])
    })
    await settle()
    expect(columnCardIds(container, 'todo')).toEqual(['201'])
    expect(
      screen.queryByRole('button', { name: 'Open A One' }),
    ).toBeNull()

    // B → A: a FRESH context loads its own canonical state
    // (including A Three).
    await go('/projects/7/work-items')
    await screen.findByRole('button', { name: 'Open A Three' })
    expect(columnCardIds(container, 'todo')).toEqual([
      '101',
      '102',
      '103',
    ])
    expect(
      calls.filter((c) => c.projectId === 7).length,
    ).toBe(4)

    // And a new event for A revalidates the re-entered surface.
    fireWorkItemChanged(7)
    await settle()
    expect(
      calls.filter((c) => c.projectId === 7).length,
    ).toBe(5)
    expect(columnCardIds(container, 'todo')).toEqual([
      '101',
      '102',
      '103',
    ])
  })
})

/* ── 6. Revalidation failure + degraded mode ───────────────────── */

describe('Project Work Items realtime — failure and degraded mode', () => {
  it('keeps the rendered Board when a realtime revalidation fails', async () => {
    mockBaseProjectData()
    const calls = queueWorkItems({ 7: [[ALPHA]] })

    vi.mocked(listProjectWorkItems).mockImplementation(
      (projectId: number) => {
        const n =
          calls.filter(
            (call) => call.projectId === projectId,
          ).length + 1
        calls.push({ projectId, n })
        if (n >= 3) {
          return Promise.reject(new Error('network down'))
        }
        return Promise.resolve([ALPHA])
      },
    )

    await renderWorkItemsBoard('Alpha')
    const source = lastSource()
    openHandshake(source)
    await waitFor(() => expect(calls).toHaveLength(2))

    fireWorkItemChanged(7)
    await waitFor(() => expect(calls).toHaveLength(3))
    await settle()

    // The rendered Board is NOT removed by the failed
    // revalidation; the existing error surface reports it.
    expect(
      screen.getByRole('button', { name: 'Open Alpha' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Work items could not be refreshed.',
    )
    expect(
      screen.queryByRole('region', {
        name: 'Loading project work items',
      }),
    ).toBeNull()

    // No retry loop: the failed revalidation does not re-arm.
    await settle()
    expect(calls).toHaveLength(3)
  })

  it('keeps the Board and manual mutations working while the stream is down', async () => {
    const EXTERNAL = makeWorkItem({
      id: 500,
      title: 'External change',
      boardPosition: 2,
    })
    const MOVED = makeWorkItem({
      id: 101,
      title: 'Alpha',
      statusDefinitionId: 11,
      boardPosition: 1,
    })
    mockBaseProjectData()
    const calls = queueWorkItems({
      7: [
        [ALPHA],
        [ALPHA],
        [MOVED, EXTERNAL],
        [MOVED, EXTERNAL],
      ],
    })
    const reorders = holdReorders()

    const { container } = await renderWorkItemsBoard('Alpha')
    const first = lastSource()
    openHandshake(first)
    await waitFor(() => expect(calls).toHaveLength(2))

    // The stream suffers a response-level failure: degraded mode.
    terminalFailure(first)

    // A subdued, non-blocking sync-paused indicator appears —
    // no modal, no toast, no permanent loading shell.
    expect(screen.getByRole('status')).toHaveTextContent(
      'Sync paused',
    )
    expect(
      screen.getByRole('button', { name: 'Open Alpha' }),
    ).toBeInTheDocument()

    // A regular manual mutation still works while the stream is
    // down, including its own canonical revalidation.
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Alpha' }),
      'in_progress',
    )
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '101',
    ])
    await act(async () => {
      reorders[0].resolve(MOVED)
    })
    await screen.findByRole('button', {
      name: 'Open External change',
    })
    expect(calls).toHaveLength(3)
    // Still degraded: the indicator remains until the stream is
    // re-established.
    expect(screen.getByRole('status')).toHaveTextContent(
      'Sync paused',
    )

    // The controlled reconnect lands: the indicator goes away and
    // the open handshake revalidates the surface once (RC-5).
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 20)
      })
    })
    const second = lastSource()
    expect(MockEventSource.instances).toHaveLength(2)
    openHandshake(second)
    await waitFor(() => expect(calls).toHaveLength(4))
    expect(
      screen
        .queryAllByRole('status')
        .some((el) => el.textContent?.includes('Sync paused')),
    ).toBe(false)
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '101',
    ])
  })
})
