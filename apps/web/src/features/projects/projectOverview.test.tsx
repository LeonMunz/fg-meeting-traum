// @vitest-environment happy-dom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
  ApiWorkItem,
} from '../../api/types'

import { ProjectDetailPage } from './ProjectDetailPage'
import {
  applyWorkItemBoardMove,
  compareWorkItemBoardOrder,
} from './workItemBoardMove'

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

vi.mock('../../api/useSession', () => ({
  useSession: () => ({
    user: {
      id: 1,
      username: 'alex',
      name: 'Alex',
    },
  }),
}))

vi.mock('../research-group/useSyncResearchGroupContext', () => ({
  useSyncResearchGroupContext: () => {},
}))

// The real drawer pulls the entire RichMarkdownEditor/Tiptap graph into
// the unit test; the Overview contract under test only needs the row
// selection behavior, which is driven by page state.
vi.mock('./WorkItemDrawer', () => ({
  WorkItemDrawer: () => null,
}))

const NOW = '2026-09-01T00:00:00Z'

function makeProject(
  overrides: Partial<ApiProject> = {},
): ApiProject {
  return {
    id: 7,
    researchGroupId: 1,
    name: 'Overview Project',
    description: 'Persisted project description.',
    status: 'active',
    archivedAt: null,
    currentUserRole: 'owner',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function makeMembership(role: 'owner' | 'member' | 'viewer'): ApiProjectMembership {
  return {
    id: 1,
    role,
    addedAt: NOW,
    user: {
      id: 1,
      username: 'alex',
      firstName: 'Alex',
      lastName: '',
    },
  }
}

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
    {
      id: 5,
      name: 'Milestone',
      kind: 'milestone',
      order: 1,
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
    id: 42,
    projectId: 7,
    title: 'Existing work',
    description: '',
    typeDefinitionId: 4,
    statusDefinitionId: 10,
    boardPosition: null,
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

function mockProjectData(options: {
  project?: ApiProject
  memberships?: ApiProjectMembership[]
  workItems?: ApiWorkItem[]
  configuration?: ApiProjectWorkItemConfiguration
} = {}) {
  const {
    project = makeProject(),
    memberships = [makeMembership('owner')],
    workItems = [],
    configuration = CONFIGURATION,
  } = options

  vi.mocked(getProject).mockResolvedValue(project)
  vi.mocked(getProjectWorkItemConfiguration).mockResolvedValue(
    configuration,
  )
  vi.mocked(listProjectWorkItems).mockResolvedValue(
    workItems,
  )
  vi.mocked(listProjectMemberships).mockResolvedValue(
    memberships,
  )
  vi.mocked(listResearchGroupMembers).mockResolvedValue(
    GROUP_MEMBERS,
  )
}

async function renderOverviewPage(project?: ApiProject) {
  render(
    <MemoryRouter initialEntries={['/projects/7/overview']}>
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

  // The About heading only renders once the Project payload
  // has loaded, so this doubles as the data-loaded gate.
  await screen.findByRole('heading', { name: 'About' })

  if (project) {
    await waitFor(() => {
      expect(
        screen.getByRole('heading', {
          name: project.name,
        }),
      ).toBeVisible()
    })
  }
}

afterEach(() => {
  cleanup()
  // resetAllMocks (not just clearAllMocks): a failed test may leave
  // queued once-implementations (held promises) behind, and vitest
  // keeps them for the next test — the next initial load would then
  // consume a foreign never-resolving promise. Every test sets its
  // own mocks before rendering, so a full reset is safe and keeps
  // the isolation outcome-independent.
  vi.resetAllMocks()
})

describe('Project Overview page', () => {
  it('uses a semantic loading shell shaped like the Project workspace', () => {
    mockProjectData()

    render(
      <MemoryRouter
        initialEntries={['/projects/7/work-items?preview=loading']}
      >
        <Routes>
          <Route
            path="/projects/:projectId/:tab"
            element={<ProjectDetailPage />}
          />
        </Routes>
      </MemoryRouter>,
    )

    const loadingShell = screen.getByRole('status', {
      name: 'Loading project',
    })

    expect(
      within(loadingShell).getByRole('navigation', {
        name: 'Loading project sections',
      }),
    ).toBeInTheDocument()

    expect(
      within(loadingShell).getByRole('region', {
        name: 'Loading project work items',
      }),
    ).toBeInTheDocument()

    expect(
      within(loadingShell).getAllByRole('group', {
        name: /Loading .* work items/,
      }),
    ).toHaveLength(4)

    expect(
      within(loadingShell).queryByRole('progressbar'),
    ).not.toBeInTheDocument()
  })

  it('shows the Work Items workspace frame with the stable header surface from the first destination frame', async () => {
    mockProjectData()

    let resolveProject!: (project: ApiProject) => void
    vi.mocked(getProject).mockImplementation(
      () =>
        new Promise<ApiProject>((resolve) => {
          resolveProject = resolve
        }),
    )

    render(
      <MemoryRouter
        initialEntries={['/projects/7/work-items']}
      >
        <Routes>
          <Route
            path="/projects/:projectId/:tab"
            element={<ProjectDetailPage />}
          />
        </Routes>
      </MemoryRouter>,
    )

    // First destination frame: the loading shell already carries
    // the real Work Items header band, so the header region is
    // never blank or a foreign (e.g. legacy white) surface while
    // the Project loads.
    const loadingShell = screen.getByRole('status', {
      name: 'Loading project',
    })
    const region = within(loadingShell).getByRole('region', {
      name: 'Loading project work items',
    })
    const heading = within(region).getByRole('heading', {
      name: 'Work Items',
    })

    // Surface invariant of the header band: no behavioral proxy
    // for the resolved background exists in this environment, so
    // the approved token class is the contract.
    expect(
      heading.closest('.bg-work-items-header'),
    ).not.toBeNull()

    // Data resolves in place: the shell goes away and the loaded
    // workspace keeps the same Work Items heading - one stable
    // header, no swap to a differently-surfaced band.
    resolveProject(makeProject())
    await screen.findByText('No work items yet.')

    expect(
      screen.queryByRole('status', {
        name: 'Loading project',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.getAllByRole('heading', {
        name: 'Work Items',
      }),
    ).toHaveLength(1)
  })

  it('renders the About, Milestones and Needs Attention sections', async () => {
    mockProjectData()

    await renderOverviewPage(makeProject())

    expect(
      screen.getByRole('heading', { name: 'About' }),
    ).toBeVisible()

    expect(
      screen.getByRole('heading', {
        name: 'Milestones',
      }),
    ).toBeVisible()

    expect(
      screen.getByRole('heading', {
        name: 'Needs Attention',
      }),
    ).toBeVisible()
  })

  it('renders the persisted project description', async () => {
    mockProjectData()

    await renderOverviewPage(makeProject())

    expect(
      screen.getByText('Description'),
    ).toBeVisible()

    expect(
      screen.getByText('Persisted project description.'),
    ).toBeVisible()
  })

  it('shows the canonical empty states without a description or work items', async () => {
    mockProjectData({
      project: makeProject({ description: '' }),
    })

    await renderOverviewPage(makeProject({ description: '' }))

    expect(
      screen.getByText('No description yet.'),
    ).toBeVisible()

    expect(
      screen.getByText('No milestones yet.'),
    ).toBeVisible()

    expect(
      screen.getByText('Nothing needs attention right now.'),
    ).toBeVisible()
  })

  it('renders Edit for an owner with an existing description', async () => {
    mockProjectData()

    await renderOverviewPage(makeProject())

    expect(
      screen.getByRole('button', { name: 'Edit' }),
    ).toBeVisible()
  })

  it('does not render Edit for a viewer', async () => {
    mockProjectData({
      project: makeProject({ currentUserRole: 'viewer' }),
      memberships: [makeMembership('viewer')],
    })

    await renderOverviewPage(
      makeProject({ currentUserRole: 'viewer' }),
    )

    expect(
      screen.queryByRole('button', { name: 'Edit' }),
    ).toBeNull()
  })

  it('does not render Edit for an owner without a description', async () => {
    mockProjectData({
      project: makeProject({ description: '' }),
    })

    await renderOverviewPage(makeProject({ description: '' }))

    expect(
      screen.queryByRole('button', { name: 'Edit' }),
    ).toBeNull()

    expect(
      screen.getByRole('button', { name: 'Add description' }),
    ).toBeVisible()
  })

  it('renders milestone work items in the Milestones section', async () => {
    mockProjectData({
      workItems: [
        makeWorkItem({
          id: 43,
          title: 'Ship Q3 release',
          typeDefinitionId: 5,
          assigneeIds: [1],
        }),
      ],
    })

    await renderOverviewPage(makeProject())

    expect(
      screen.getByRole('button', {
        name: 'Open Ship Q3 release',
      }),
    ).toBeVisible()

    expect(
      screen.queryByText('No milestones yet.'),
    ).toBeNull()
  })

  it('renders an eligible blocked work item in Needs Attention', async () => {
    mockProjectData({
      workItems: [
        makeWorkItem({
          id: 44,
          title: 'Ingest corpus',
          statusDefinitionId: 11,
          blockedReason: 'Waiting on data access',
        }),
      ],
    })

    await renderOverviewPage(makeProject())

    const row = screen.getByRole('button', {
      name: 'Open Ingest corpus',
    })

    expect(row).toBeVisible()

    expect(
      screen.getByText('Blocked', { exact: true }),
    ).toBeVisible()

    expect(
      screen.queryByText('Nothing needs attention right now.'),
    ).toBeNull()
  })

  it('selects the work item when a Needs Attention row is opened', async () => {
    mockProjectData({
      workItems: [
        makeWorkItem({
          id: 45,
          title: 'Write literature review',
          blockedReason: 'Awaiting supervisor feedback',
        }),
      ],
    })

    await renderOverviewPage(makeProject())

    const row = screen.getByRole('button', {
      name: 'Open Write literature review',
    })

    expect(row).not.toHaveAttribute('data-selected')

    fireEvent.click(row)

    await waitFor(() => {
      expect(row).toHaveAttribute('data-selected', 'true')
    })
  })
})

// ── Project Board drag & drop continuity ──────────────
//
// A user mutation of an already-rendered Board must never remove
// the Board while the server mutation + canonical revalidation
// run: drop → optimistic move → silent reconciliation (or
// rollback on failure), with the Board mounted throughout.

/**
 * Minimal DataTransfer stand-in for native HTML5 drag/drop in
 * happy-dom (same pattern as the My Work Kanban tests): React's
 * synthetic drag events read `dataTransfer` straight off the
 * native event.
 */
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

// Deterministic geometry for the insertion-slot behavior: the board
// measures the VISIBLE cards' bounding boxes on dragover, and
// happy-dom reports zeroed rects by default.
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
  // happy-dom's global DragEvent is a plain Event alias —
  // constructor init (clientY, dataTransfer) is dropped — so the
  // native event is shaped manually.
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

  return overEvent
}

/**
 * The native HTML5 drag sequence the Board relies on: dragstart on
 * the card (id lands on dataTransfer), dragover + drop on the target
 * column, dragend back on the card.
 *
 * `clientY` selects the vertical drop position inside the target
 * column; omitted = after the last card (the column end).
 */
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

/** The card ids of a Board column in rendered order. */
function columnCardIds(
  container: HTMLElement,
  status: string,
): string[] {
  return Array.from(
    boardColumn(
      container,
      status,
    ).querySelectorAll('[data-work-item-id]'),
  ).map((el) => el.getAttribute('data-work-item-id') ?? '')
}

const BOARD_COLUMN_LABELS = [
  'To do',
  'In progress',
  'Review',
  'Done',
]

function expectBoardStillRendered(
  container: HTMLElement,
) {
  // All four columns, header + toolbar included, and no destination
  // loading shell (neither the page-level one nor the panel's).
  for (const status of [
    'todo',
    'in_progress',
    'review',
    'done',
  ]) {
    expect(
      container.querySelector(
        `[data-board-column="${status}"]`,
      ),
    ).not.toBeNull()
  }

  for (const label of BOARD_COLUMN_LABELS) {
    expect(screen.getByText(label)).toBeInTheDocument()
  }

  expect(
    screen.queryByRole('region', {
      name: 'Loading project work items',
    }),
  ).toBeNull()
}

/**
 * Renders the Work Items tab and waits until the Board is visible.
 * Mocks are set up by the caller BEFORE calling this helper; the
 * helper itself never (re)configures any API mock.
 */
async function renderWorkItemsBoard(firstCardTitle: string) {
  const rendered = render(
    <MemoryRouter
      initialEntries={['/projects/7/work-items']}
    >
      <Routes>
        <Route
          path="/projects/:projectId/:tab"
          element={<ProjectDetailPage />}
        />
      </Routes>
    </MemoryRouter>,
  )

  // The Board only exists once the initial Work Items fetch has
  // resolved, so this doubles as the data-loaded gate.
  await screen.findByRole('button', {
    name: `Open ${firstCardTitle}`,
  })

  return rendered
}

describe('Project Board drag & drop continuity', () => {
  const ALPHA = makeWorkItem({
    id: 101,
    title: 'Alpha',
    statusDefinitionId: 10,
    boardPosition: 1,
  })
  const BETA = makeWorkItem({
    id: 102,
    title: 'Beta',
    statusDefinitionId: 10,
    boardPosition: 2,
  })
  const GAMMA = makeWorkItem({
    id: 103,
    title: 'Gamma',
    statusDefinitionId: 11,
    boardPosition: 1,
  })

  it('moves the card locally before the mutation resolves, with the board continuously rendered', async () => {
    mockProjectData({ workItems: [ALPHA, BETA, GAMMA] })

    // The mutation never settles: every assertion below runs while
    // it is still pending.
    vi.mocked(reorderWorkItem).mockImplementation(
      () => new Promise<ApiWorkItem>(() => {}),
    )

    const { container } = await renderWorkItemsBoard(
      'Alpha',
    )

    expect(columnCardIds(container, 'todo')).toEqual([
      '101',
      '102',
    ])

    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Alpha' }),
      'in_progress',
    )

    // The mutation request carries the canonical status definition
    // of the target column and the insertion anchor (null = end).
    expect(reorderWorkItem).toHaveBeenCalledWith(
      101,
      {
        statusDefinitionId: 11,
        beforeWorkItemId: null,
      },
    )

    // While the mutation is STILL PENDING, the card is already at
    // its dropped position.
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '103',
      '101',
    ])
    expect(columnCardIds(container, 'todo')).toEqual(['102'])

    // No duplicates, no missing cards.
    expect(
      screen.getAllByRole('button', { name: 'Open Alpha' }),
    ).toHaveLength(1)
    expect(
      screen.getByRole('button', { name: 'Open Beta' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Open Gamma' }),
    ).toBeInTheDocument()

    // The whole board stayed rendered: no initial-loading shell
    // replaced it.
    expectBoardStillRendered(container)
  })

  it('reconciles silently with the canonical server ordering after a successful mutation', async () => {
    let resolveReorder!: (item: ApiWorkItem) => void
    let resolveRefresh!: (items: ApiWorkItem[]) => void

    mockProjectData({ workItems: [ALPHA, BETA, GAMMA] })

    // Explicit deterministic call sequence:
    // 1st call — the initial load, resolves immediately.
    // 2nd call — the post-drop revalidation, deferred until the
    // assertions below need it.
    vi.mocked(listProjectWorkItems)
      .mockResolvedValueOnce([ALPHA, BETA, GAMMA])
      .mockImplementationOnce(
        () =>
          new Promise<ApiWorkItem[]>((resolve) => {
            resolveRefresh = resolve
          }),
      )

    vi.mocked(reorderWorkItem).mockImplementation(
      () =>
        new Promise<ApiWorkItem>((resolve) => {
          resolveReorder = resolve
        }),
    )

    const { container } = await renderWorkItemsBoard(
      'Alpha',
    )

    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Alpha' }),
      'in_progress',
    )

    expect(reorderWorkItem).toHaveBeenCalledWith(
      101,
      {
        statusDefinitionId: 11,
        beforeWorkItemId: null,
      },
    )
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '103',
      '101',
    ])

    // The mutation resolves → the canonical revalidation starts.
    await act(async () => {
      resolveReorder({
        ...ALPHA,
        statusDefinitionId: 11,
        boardPosition: 2,
      })
    })

    // While the revalidation is UNRESOLVED: the board is still
    // mounted, the moved card is still visible, and no loading
    // shell replaced the board.
    expect(listProjectWorkItems).toHaveBeenCalledTimes(2)
    expectBoardStillRendered(container)
    expect(
      screen.getByRole('button', { name: 'Open Alpha' }),
    ).toBeInTheDocument()
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '103',
      '101',
    ])

    // Resolve with the canonical server ordering (here the server
    // numbered Alpha first in the column, as if a concurrent move
    // had settled): the board reconciles to it without a reset.
    await act(async () => {
      resolveRefresh([
        BETA,
        { ...GAMMA, boardPosition: 2 },
        {
          ...ALPHA,
          statusDefinitionId: 11,
          boardPosition: 1,
        },
      ])
    })

    expect(
      screen.queryByRole('region', {
        name: 'Loading project work items',
      }),
    ).toBeNull()
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '101',
      '103',
    ])
    expect(columnCardIds(container, 'todo')).toEqual(['102'])
  })

  it('rolls the card back to its exact original position when the mutation fails, without replacing the board', async () => {
    mockProjectData({ workItems: [ALPHA, BETA, GAMMA] })

    let rejectReorder!: (error: Error) => void
    vi.mocked(reorderWorkItem).mockImplementation(
      () =>
        new Promise<ApiWorkItem>((_resolve, reject) => {
          rejectReorder = reject
        }),
    )

    const { container } = await renderWorkItemsBoard(
      'Alpha',
    )

    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Alpha' }),
      'in_progress',
    )

    // The optimistic move happened before the failure was known.
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '103',
      '101',
    ])

    await act(async () => {
      rejectReorder(new Error('boom'))
    })

    await waitFor(() => {
      expect(
        screen.getByRole('alert'),
      ).toHaveTextContent('Work item could not be moved.')
    })

    // The board never disappeared during the rollback.
    expectBoardStillRendered(container)

    // The EXACT previous collection is restored: Alpha is back in
    // its original column and original slot, Gamma untouched.
    expect(columnCardIds(container, 'todo')).toEqual([
      '101',
      '102',
    ])
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '103',
    ])

    // A failed mutation never triggers a destructive full-board
    // reload to recover.
    expect(listProjectWorkItems).toHaveBeenCalledTimes(1)

    // The existing error treatment is dismissible.
    fireEvent.click(
      screen.getByRole('button', { name: 'Dismiss' }),
    )

    expect(screen.queryByRole('alert')).toBeNull()
    expect(columnCardIds(container, 'todo')).toEqual([
      '101',
      '102',
    ])
  })

  it('reorders within the same column at the exact dropped position', async () => {
    const DELTA = makeWorkItem({
      id: 104,
      title: 'Delta',
      statusDefinitionId: 10,
      boardPosition: 3,
    })

    let resolveReorder!: (item: ApiWorkItem) => void
    let resolveRefresh!: (items: ApiWorkItem[]) => void

    mockProjectData({
      workItems: [ALPHA, BETA, DELTA, GAMMA],
    })

    vi.mocked(listProjectWorkItems)
      .mockResolvedValueOnce([ALPHA, BETA, DELTA, GAMMA])
      .mockImplementationOnce(
        () =>
          new Promise<ApiWorkItem[]>((resolve) => {
            resolveRefresh = resolve
          }),
      )

    vi.mocked(reorderWorkItem).mockImplementation(
      () =>
        new Promise<ApiWorkItem>((resolve) => {
          resolveReorder = resolve
        }),
    )

    const { container } = await renderWorkItemsBoard(
      'Alpha',
    )

    // Drag DELTA (third card in the To do column) to the FRONT of
    // the same column: above the first card's midpoint.
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Delta' }),
      'todo',
      STUB_CARD_TOP + 20,
    )

    // Same-column reorder: the canonical status definition is kept
    // and the anchor is the card that must follow the moved one.
    expect(reorderWorkItem).toHaveBeenCalledWith(
      104,
      {
        statusDefinitionId: 10,
        beforeWorkItemId: 101,
      },
    )

    // The optimistic position matches the intended drop position,
    // and the board stayed rendered while the mutation was pending.
    expect(columnCardIds(container, 'todo')).toEqual([
      '104',
      '101',
      '102',
    ])
    expectBoardStillRendered(container)

    await act(async () => {
      resolveReorder({ ...DELTA, boardPosition: 1 })
    })

    expect(listProjectWorkItems).toHaveBeenCalledTimes(2)
    expectBoardStillRendered(container)

    // The successful reconciliation preserves the canonical order.
    await act(async () => {
      resolveRefresh([
        { ...DELTA, boardPosition: 1 },
        { ...ALPHA, boardPosition: 2 },
        { ...BETA, boardPosition: 3 },
        GAMMA,
      ])
    })

    expect(columnCardIds(container, 'todo')).toEqual([
      '104',
      '101',
      '102',
    ])
    expect(
      screen.queryByRole('region', {
        name: 'Loading project work items',
      }),
    ).toBeNull()
  })

  // ----------------------------------------------------------------
  // AP-02 category contract: a Board column is a semantic status
  // CATEGORY that may hold several concrete StatusDefinitions; a
  // same-category drop is a pure reorder (the item keeps its own
  // definition), a cross-category drop resolves the FIRST ACTIVE
  // target definition by configured order, and a missing active
  // target prevents the drop entirely.
  // ----------------------------------------------------------------

  const MIXED_CONFIG: ApiProjectWorkItemConfiguration = {
    types: CONFIGURATION.types,
    labels: [],
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
        id: 12,
        name: 'Planned',
        category: 'todo',
        order: 1,
        active: true,
        isDefault: false,
      },
      {
        id: 11,
        name: 'In progress',
        category: 'in_progress',
        order: 2,
        active: true,
        isDefault: false,
      },
      {
        id: 13,
        name: 'Actively in progress',
        category: 'in_progress',
        order: 3,
        active: true,
        isDefault: false,
      },
      {
        id: 14,
        name: 'Review',
        category: 'review',
        order: 4,
        active: false,
        isDefault: false,
      },
    ],
  }

  const PLANNED_BETA = makeWorkItem({
    id: 102,
    title: 'Beta',
    statusDefinitionId: 12,
    boardPosition: 2,
  })

  it('same-category drop between mixed definitions: pure reorder, own definition and the other-definition anchor are kept', async () => {
    // Todo category holds TWO definitions: Alpha/Gamma on 10, Beta on
    // 12. All three render in the ONE "To do" column.
    const mixedAlpha = makeWorkItem({
      id: 101,
      title: 'Alpha',
      statusDefinitionId: 10,
      boardPosition: 1,
    })
    const mixedGamma = makeWorkItem({
      id: 103,
      title: 'Gamma',
      statusDefinitionId: 10,
      boardPosition: 3,
    })

    mockProjectData({
      configuration: MIXED_CONFIG,
      workItems: [mixedAlpha, PLANNED_BETA, mixedGamma],
    })

    vi.mocked(reorderWorkItem).mockImplementation(
      () => new Promise<ApiWorkItem>(() => {}),
    )

    const { container } = await renderWorkItemsBoard(
      'Alpha',
    )

    // The ONE todo column shows all three concrete definitions.
    expect(columnCardIds(container, 'todo')).toEqual([
      '101',
      '102',
      '103',
    ])

    // Drag Gamma (third card) to the gap before Beta (second card):
    // Beta is on the OTHER todo definition — a valid category anchor.
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Gamma' }),
      'todo',
      STUB_CARD_TOP +
        1 * (STUB_CARD_HEIGHT + STUB_CARD_GAP) +
        20,
    )

    // The request targets Gamma's OWN definition (10) and the
    // other-definition anchor (102): a pure reorder that must never
    // flip Gamma to 12 (Planned).
    expect(reorderWorkItem).toHaveBeenCalledTimes(1)
    expect(reorderWorkItem).toHaveBeenCalledWith(
      103,
      {
        statusDefinitionId: 10,
        beforeWorkItemId: 102,
      },
    )

    // Optimistic visual order: Alpha, Gamma, Beta — while the
    // mutation is still pending and the board stayed mounted.
    expect(columnCardIds(container, 'todo')).toEqual([
      '101',
      '103',
      '102',
    ])
    expectBoardStillRendered(container)
  })

  it('cross-category drop resolves the first active target definition by configured order', async () => {
    mockProjectData({
      configuration: MIXED_CONFIG,
      workItems: [ALPHA, BETA, GAMMA],
    })

    vi.mocked(reorderWorkItem).mockImplementation(
      () => new Promise<ApiWorkItem>(() => {}),
    )

    const { container } = await renderWorkItemsBoard(
      'Alpha',
    )

    // Drag Alpha into "In progress": the category holds TWO active
    // definitions (11 order 2, 13 order 3) — the request must carry
    // the first by order (11), not the second.
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Alpha' }),
      'in_progress',
    )

    expect(reorderWorkItem).toHaveBeenCalledWith(
      101,
      {
        statusDefinitionId: 11,
        beforeWorkItemId: null,
      },
    )

    // Optimistic: Alpha is on the resolved definition 11 in the
    // in_progress column, Gamma untouched.
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '103',
      '101',
    ])
    expectBoardStillRendered(container)
  })

  it('cross-category drop into a category without ANY active definition is prevented with the existing error, no request, no move', async () => {
    mockProjectData({
      configuration: MIXED_CONFIG,
      workItems: [ALPHA, BETA, GAMMA],
    })

    vi.mocked(reorderWorkItem).mockImplementation(
      () => new Promise<ApiWorkItem>(() => {}),
    )

    const { container } = await renderWorkItemsBoard(
      'Alpha',
    )

    // "Review" has only the INACTIVE definition 14.
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Alpha' }),
      'review',
    )

    // No invalid reorder request is ever sent.
    expect(reorderWorkItem).not.toHaveBeenCalled()

    // The existing understandable error is shown...
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'No matching status is configured for this Project.',
      )
    })

    // ...and the card did not move at all.
    expect(columnCardIds(container, 'todo')).toEqual([
      '101',
      '102',
    ])
    expect(columnCardIds(container, 'review')).toEqual([])
    expectBoardStillRendered(container)
  })

  it('same-category drop to the column end is a REAL move when the item is not last (no longer a no-op)', async () => {
    mockProjectData({ workItems: [ALPHA, BETA] })

    vi.mocked(reorderWorkItem).mockImplementation(
      () => new Promise<ApiWorkItem>(() => {}),
    )

    const { container } = await renderWorkItemsBoard(
      'Alpha',
    )

    // Drag Alpha (first card) to the END of its own column — a
    // missing anchor must not make this a no-op.
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Alpha' }),
      'todo',
    )

    expect(reorderWorkItem).toHaveBeenCalledWith(
      101,
      {
        statusDefinitionId: 10,
        beforeWorkItemId: null,
      },
    )
    expect(columnCardIds(container, 'todo')).toEqual([
      '102',
      '101',
    ])
  })

  it('a genuine no-op (item already at the desired slot) sends no request and changes nothing', async () => {
    mockProjectData({ workItems: [ALPHA, BETA] })

    vi.mocked(reorderWorkItem).mockImplementation(
      () => new Promise<ApiWorkItem>(() => {}),
    )

    const { container } = await renderWorkItemsBoard(
      'Alpha',
    )

    // Beta is already the LAST card of the todo column: dropping it
    // at the column end is the order that already holds.
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Beta' }),
      'todo',
    )

    expect(reorderWorkItem).not.toHaveBeenCalled()
    expect(listProjectWorkItems).toHaveBeenCalledTimes(1)
    expect(columnCardIds(container, 'todo')).toEqual([
      '101',
      '102',
    ])
  })

  it('a late revalidation answer never rolls back a newer pending optimistic drop', async () => {
    mockProjectData({ workItems: [ALPHA, BETA, GAMMA] })

    // Call sequence for the canonical list:
    // 1 — initial load (resolves immediately),
    // 2 — ALPHA drop revalidation (held),
    // 3 — BETA drop revalidation (held).
    let resolveAlphaRefresh!: (items: ApiWorkItem[]) => void
    let resolveBetaRefresh!: (items: ApiWorkItem[]) => void
    let resolveAlphaReorder!: (item: ApiWorkItem) => void
    let resolveBetaReorder!: (item: ApiWorkItem) => void
    let reorderCalls = 0

    vi.mocked(listProjectWorkItems)
      .mockResolvedValueOnce([ALPHA, BETA, GAMMA])
      .mockImplementationOnce(
        () =>
          new Promise<ApiWorkItem[]>((resolve) => {
            resolveAlphaRefresh = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<ApiWorkItem[]>((resolve) => {
            resolveBetaRefresh = resolve
          }),
      )

    vi.mocked(reorderWorkItem).mockImplementation(
      () =>
        new Promise<ApiWorkItem>((resolve) => {
          reorderCalls += 1
          if (reorderCalls === 1) {
            resolveAlphaReorder = resolve
          } else {
            resolveBetaReorder = resolve
          }
        }),
    )

    const { container } = await renderWorkItemsBoard(
      'Alpha',
    )

    // Drop 1: Alpha -> in_progress. Optimistic + revalidation held.
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Alpha' }),
      'in_progress',
    )
    await act(async () => {
      resolveAlphaReorder({ ...ALPHA, statusDefinitionId: 11 })
    })

    // Drop 2 (NEWER): Beta -> in_progress while the ALPHA
    // revalidation is STILL in flight.
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Beta' }),
      'in_progress',
    )

    // The BETA optimistic move is on screen...
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '103',
      '101',
      '102',
    ])
    expect(columnCardIds(container, 'todo')).toEqual([])

    // ...and the STALE Alpha revalidation answers with the canonical
    // state from BEFORE the Beta drop. It must NOT clobber the
    // newer pending optimistic state.
    await act(async () => {
      resolveAlphaRefresh([
        BETA,
        { ...GAMMA, boardPosition: 2 },
        { ...ALPHA, statusDefinitionId: 11, boardPosition: 1 },
      ])
    })

    expectBoardStillRendered(container)
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '103',
      '101',
      '102',
    ])
    expect(columnCardIds(container, 'todo')).toEqual([])

    // The BETA drop settles through its OWN revalidation, and the
    // board reconciles to the canonical final order.
    await act(async () => {
      resolveBetaReorder({ ...BETA, statusDefinitionId: 11 })
    })
    await act(async () => {
      resolveBetaRefresh([
        { ...ALPHA, statusDefinitionId: 11, boardPosition: 1 },
        { ...BETA, statusDefinitionId: 11, boardPosition: 2 },
        { ...GAMMA, boardPosition: 3 },
      ])
    })

    // Exactly three canonical reads in total: the initial load plus
    // one revalidation per settled drop.
    expect(listProjectWorkItems).toHaveBeenCalledTimes(3)

    expect(
      screen.queryByRole('region', {
        name: 'Loading project work items',
      }),
    ).toBeNull()
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '101',
      '102',
      '103',
    ])
  })

  // ----------------------------------------------------------------
  // AP-02 revalidation race: the fetch effect's sequence guard only
  // skips a stale answer when a drop STARTS after the revalidation
  // request is issued. A drop that is ALREADY in flight (started
  // before the request) is not covered: the answer's server snapshot
  // can miss that still-pending drop, and applying it would roll the
  // newer drop's card back. The two timelines below pin the exact
  // interleavings with controlled promises (no timers).
  // ----------------------------------------------------------------

  it('an older drop revalidation answered while a newer drop is still in flight never rolls back the newer drop', async () => {
    mockProjectData({ workItems: [ALPHA, BETA, GAMMA] })

    // Call sequence for the canonical list:
    // 1 — initial load (resolves immediately),
    // 2 — ALPHA drop revalidation (issued after BOTH drops started,
    //      answered with a snapshot that still LACKS the BETA move),
    // 3 — BETA drop revalidation (the final canonical state).
    let resolveAlphaRefresh!: (items: ApiWorkItem[]) => void
    let resolveBetaRefresh!: (items: ApiWorkItem[]) => void
    let resolveAlphaReorder!: (item: ApiWorkItem) => void
    let resolveBetaReorder!: (item: ApiWorkItem) => void
    let reorderCalls = 0

    vi.mocked(listProjectWorkItems)
      .mockResolvedValueOnce([ALPHA, BETA, GAMMA])
      .mockImplementationOnce(
        () =>
          new Promise<ApiWorkItem[]>((resolve) => {
            resolveAlphaRefresh = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<ApiWorkItem[]>((resolve) => {
            resolveBetaRefresh = resolve
          }),
      )

    vi.mocked(reorderWorkItem).mockImplementation(
      () =>
        new Promise<ApiWorkItem>((resolve) => {
          reorderCalls += 1
          if (reorderCalls === 1) {
            resolveAlphaReorder = resolve
          } else {
            resolveBetaReorder = resolve
          }
        }),
    )

    const { container } = await renderWorkItemsBoard(
      'Alpha',
    )

    // Drop 1: Alpha -> in_progress (mutation held).
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Alpha' }),
      'in_progress',
    )

    // Drop 2 (NEWER): Beta -> in_progress, BEFORE the ALPHA
    // revalidation is issued. Both optimistic moves are on screen.
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Beta' }),
      'in_progress',
    )

    expect(columnCardIds(container, 'in_progress')).toEqual([
      '103',
      '101',
      '102',
    ])
    expect(columnCardIds(container, 'todo')).toEqual([])

    // Mutation 1 (Alpha) settles: its revalidation is issued while
    // Drop 2 (Beta) is STILL pending, so the server snapshot cannot
    // contain the Beta mutation.
    await act(async () => {
      resolveAlphaReorder({
        ...ALPHA,
        statusDefinitionId: 11,
      })
    })

    // The ALPHA revalidation answers with the canonical state from
    // BEFORE the Beta drop: Beta is back in To do, Alpha alone (and
    // ahead of Gamma) in In progress. Mutation 2 is still open.
    await act(async () => {
      resolveAlphaRefresh([
        { ...BETA, boardPosition: 2 },
        { ...GAMMA, boardPosition: 1 },
        {
          ...ALPHA,
          statusDefinitionId: 11,
          boardPosition: 2,
        },
      ])
    })

    // The visible Beta card must REMAIN at its optimistic In
    // progress position: the stale answer must not roll the newer
    // in-flight drop back.
    expectBoardStillRendered(container)
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '103',
      '101',
      '102',
    ])
    expect(columnCardIds(container, 'todo')).toEqual([])

    // Mutation 2 (Beta) settles: its own revalidation carries the
    // canonical end state.
    await act(async () => {
      resolveBetaReorder({
        ...BETA,
        statusDefinitionId: 11,
      })
    })

    await act(async () => {
      resolveBetaRefresh([
        { ...ALPHA, statusDefinitionId: 11, boardPosition: 1 },
        { ...BETA, statusDefinitionId: 11, boardPosition: 2 },
        { ...GAMMA, boardPosition: 3 },
      ])
    })

    // After ALL mutations settled, the authoritative server state is
    // adopted: the final canonical order, not the stale snapshot.
    expect(
      screen.queryByRole('region', {
        name: 'Loading project work items',
      }),
    ).toBeNull()
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '101',
      '102',
      '103',
    ])
    expect(columnCardIds(container, 'todo')).toEqual([])
  })

  it('a delayed answer of the older revalidation never replaces the already-applied newer revalidation', async () => {
    mockProjectData({ workItems: [ALPHA, BETA, GAMMA] })

    // Call sequence for the canonical list:
    // 1 — initial load (resolves immediately),
    // 2 — ALPHA drop revalidation (superseded; answers LATE),
    // 3 — BETA drop revalidation (answers with the CURRENT state).
    let resolveAlphaRefresh!: (items: ApiWorkItem[]) => void
    let resolveBetaRefresh!: (items: ApiWorkItem[]) => void
    let resolveAlphaReorder!: (item: ApiWorkItem) => void
    let resolveBetaReorder!: (item: ApiWorkItem) => void
    let reorderCalls = 0

    vi.mocked(listProjectWorkItems)
      .mockResolvedValueOnce([ALPHA, BETA, GAMMA])
      .mockImplementationOnce(
        () =>
          new Promise<ApiWorkItem[]>((resolve) => {
            resolveAlphaRefresh = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<ApiWorkItem[]>((resolve) => {
            resolveBetaRefresh = resolve
          }),
      )

    vi.mocked(reorderWorkItem).mockImplementation(
      () =>
        new Promise<ApiWorkItem>((resolve) => {
          reorderCalls += 1
          if (reorderCalls === 1) {
            resolveAlphaReorder = resolve
          } else {
            resolveBetaReorder = resolve
          }
        }),
    )

    const { container } = await renderWorkItemsBoard(
      'Alpha',
    )

    // Drop 1: Alpha -> in_progress (mutation held).
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Alpha' }),
      'in_progress',
    )

    // Drop 2 (NEWER): Beta -> in_progress (mutation held).
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Beta' }),
      'in_progress',
    )

    expect(columnCardIds(container, 'in_progress')).toEqual([
      '103',
      '101',
      '102',
    ])

    // Mutation 1 (Alpha) settles: revalidation A is issued.
    await act(async () => {
      resolveAlphaReorder({
        ...ALPHA,
        statusDefinitionId: 11,
      })
    })

    // Mutation 2 (Beta) settles BEFORE A answers: revalidation B is
    // issued and supersedes A.
    await act(async () => {
      resolveBetaReorder({
        ...BETA,
        statusDefinitionId: 11,
      })
    })

    // B answers with the CURRENT canonical state (both moves).
    await act(async () => {
      resolveBetaRefresh([
        { ...ALPHA, statusDefinitionId: 11, boardPosition: 1 },
        { ...BETA, statusDefinitionId: 11, boardPosition: 2 },
        { ...GAMMA, boardPosition: 3 },
      ])
    })

    // The STALE Alpha answer arrives LATER, with the snapshot from
    // before the Beta drop. It must not replace the already-applied
    // newer state.
    await act(async () => {
      resolveAlphaRefresh([
        { ...BETA, boardPosition: 2 },
        { ...GAMMA, boardPosition: 1 },
        {
          ...ALPHA,
          statusDefinitionId: 11,
          boardPosition: 2,
        },
      ])
    })

    expect(
      screen.queryByRole('region', {
        name: 'Loading project work items',
      }),
    ).toBeNull()
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '101',
      '102',
      '103',
    ])
    expect(columnCardIds(container, 'todo')).toEqual([])
  })

  it('a late failure of a superseded drop never rolls back the newer drop', async () => {
    mockProjectData({ workItems: [ALPHA, BETA, GAMMA] })

    let rejectAlphaReorder!: (error: Error) => void
    let resolveBetaReorder!: (item: ApiWorkItem) => void
    let resolveBetaRefresh!: (items: ApiWorkItem[]) => void
    let reorderCalls = 0

    vi.mocked(listProjectWorkItems)
      .mockResolvedValueOnce([ALPHA, BETA, GAMMA])
      .mockImplementationOnce(
        () =>
          new Promise<ApiWorkItem[]>((resolve) => {
            resolveBetaRefresh = resolve
          }),
      )

    vi.mocked(reorderWorkItem).mockImplementation(
      () =>
        new Promise<ApiWorkItem>((resolve, reject) => {
          reorderCalls += 1
          if (reorderCalls === 1) {
            rejectAlphaReorder = reject
          } else {
            resolveBetaReorder = resolve
          }
        }),
    )

    const { container } = await renderWorkItemsBoard(
      'Alpha',
    )

    // Drop 1: Alpha -> in_progress (reorder will FAIL later).
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Alpha' }),
      'in_progress',
    )

    // Drop 2 (NEWER): Beta -> in_progress; it settles.
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Beta' }),
      'in_progress',
    )

    // While Alpha's (failed) mutation is still pending, BOTH cards
    // are optimistically in in_progress: Gamma, Alpha, Beta.
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '103',
      '101',
      '102',
    ])

    await act(async () => {
      resolveBetaReorder({ ...BETA, statusDefinitionId: 11 })
    })
    await act(async () => {
      resolveBetaRefresh([
        ALPHA,
        { ...BETA, statusDefinitionId: 11, boardPosition: 1 },
        { ...GAMMA, boardPosition: 2 },
      ])
    })

    // The NEWER drop is settled on screen from its OWN revalidation:
    // the canonical state puts Alpha back in todo (its move never
    // succeeded) and Beta ahead of Gamma in in_progress.
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '102',
      '103',
    ])
    expect(columnCardIds(container, 'todo')).toEqual(['101'])

    // Now the SUPERSEDED Alpha drop fails late: it must not roll
    // the board back (it no longer owns the Board state) and must
    // not surface a drop error.
    await act(async () => {
      rejectAlphaReorder(new Error('boom'))
    })

    expect(
      screen.queryByRole('alert'),
    ).toBeNull()
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '102',
      '103',
    ])
  })

  // ----------------------------------------------------------------
  // AP-02 canonical reconciliation: when TWO overlapping drops both
  // fail, each drop's rollback snapshot contains the OTHER drop's
  // optimistic change (the newer snapshot captured the board while
  // the older optimistic move was on it). The sequence guard
  // permanently skips the older drop's rollback, so snapshot
  // restoration alone can never restore the server state: the
  // moment the LAST in-flight drop settles, exactly ONE canonical
  // revalidation must adopt the authoritative backend state. The
  // controlled promises below pin both failure orders (no timers),
  // asserting the final visible order against the actually
  // simulated backend payload and the real API call sequence.
  // ----------------------------------------------------------------

  it('two overlapping failed drops (newer fails first): the board settles on the canonical server state, not the stale optimistic order', async () => {
    mockProjectData({ workItems: [ALPHA, BETA, GAMMA] })

    // Call sequence for the canonical list:
    // 1 — initial load (resolves immediately),
    // 2 — the post-settlement canonical reconciliation (held; the
    //      simulated backend never applied either move).
    let resolveReconciliation!: (items: ApiWorkItem[]) => void
    let rejectAlphaReorder!: (error: Error) => void
    let rejectBetaReorder!: (error: Error) => void
    let reorderCalls = 0

    vi.mocked(listProjectWorkItems)
      .mockResolvedValueOnce([ALPHA, BETA, GAMMA])
      .mockImplementationOnce(
        () =>
          new Promise<ApiWorkItem[]>((resolve) => {
            resolveReconciliation = resolve
          }),
      )

    vi.mocked(reorderWorkItem).mockImplementation(
      () =>
        new Promise<ApiWorkItem>((_resolve, reject) => {
          reorderCalls += 1
          if (reorderCalls === 1) {
            rejectAlphaReorder = reject
          } else {
            rejectBetaReorder = reject
          }
        }),
    )

    const { container } = await renderWorkItemsBoard(
      'Alpha',
    )

    // Drop 1: Alpha -> in_progress (mutation held).
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Alpha' }),
      'in_progress',
    )

    // Drop 2 (NEWER): Beta -> in_progress (mutation held). Its
    // rollback snapshot therefore contains Drop 1's optimistic
    // state.
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Beta' }),
      'in_progress',
    )

    expect(columnCardIds(container, 'in_progress')).toEqual([
      '103',
      '101',
      '102',
    ])
    expect(columnCardIds(container, 'todo')).toEqual([])

    // Mutation 2 (Beta, newer) fails FIRST: its rollback restores
    // its own snapshot — which still contains Alpha's optimistic
    // move.
    await act(async () => {
      rejectBetaReorder(new Error('boom'))
    })

    await waitFor(() => {
      expect(
        screen.getByRole('alert'),
      ).toHaveTextContent('Work item could not be moved.')
    })
    expect(columnCardIds(container, 'todo')).toEqual(['102'])
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '103',
      '101',
    ])

    // Mutation 1 (Alpha, older) now ALSO fails. Its rollback may
    // never run (a newer drop started in the meantime) — the
    // cohort must settle through a canonical revalidation instead
    // of keeping Alpha's failed optimistic move.
    await act(async () => {
      rejectAlphaReorder(new Error('boom'))
    })

    // Exactly ONE canonical reconciliation read is owed by the
    // settled failed cohort ...
    expect(listProjectWorkItems).toHaveBeenCalledTimes(2)
    // ... while the board stays fully rendered.
    expectBoardStillRendered(container)

    // Simulated backend: NEITHER move was applied — the canonical
    // state is exactly the initial board.
    await act(async () => {
      resolveReconciliation([ALPHA, BETA, GAMMA])
    })

    // The visible order matches the AUTHORITATIVE server state:
    // no failed optimistic move remains visible.
    expect(columnCardIds(container, 'todo')).toEqual([
      '101',
      '102',
    ])
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '103',
    ])
    expectBoardStillRendered(container)

    // No refresh loop: exactly the initial load plus the one
    // canonical reconciliation.
    expect(listProjectWorkItems).toHaveBeenCalledTimes(2)
    // The failed-drop error remains understandable on screen.
    expect(
      screen.getByRole('alert'),
    ).toHaveTextContent('Work item could not be moved.')
  })

  it('two overlapping failed drops (older fails first): the board settles on the canonical server state, not the stale optimistic order', async () => {
    mockProjectData({ workItems: [ALPHA, BETA, GAMMA] })

    // Call sequence for the canonical list:
    // 1 — initial load (resolves immediately),
    // 2 — the post-settlement canonical reconciliation (held; the
    //      simulated backend never applied either move).
    let resolveReconciliation!: (items: ApiWorkItem[]) => void
    let rejectAlphaReorder!: (error: Error) => void
    let rejectBetaReorder!: (error: Error) => void
    let reorderCalls = 0

    vi.mocked(listProjectWorkItems)
      .mockResolvedValueOnce([ALPHA, BETA, GAMMA])
      .mockImplementationOnce(
        () =>
          new Promise<ApiWorkItem[]>((resolve) => {
            resolveReconciliation = resolve
          }),
      )

    vi.mocked(reorderWorkItem).mockImplementation(
      () =>
        new Promise<ApiWorkItem>((_resolve, reject) => {
          reorderCalls += 1
          if (reorderCalls === 1) {
            rejectAlphaReorder = reject
          } else {
            rejectBetaReorder = reject
          }
        }),
    )

    const { container } = await renderWorkItemsBoard(
      'Alpha',
    )

    // Drop 1: Alpha -> in_progress (mutation held).
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Alpha' }),
      'in_progress',
    )

    // Drop 2 (NEWER): Beta -> in_progress (mutation held).
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Beta' }),
      'in_progress',
    )

    expect(columnCardIds(container, 'in_progress')).toEqual([
      '103',
      '101',
      '102',
    ])
    expect(columnCardIds(container, 'todo')).toEqual([])

    // Mutation 1 (Alpha, OLDER) fails FIRST: a newer drop is in
    // flight, so its rollback is skipped and its optimistic state
    // stays on the board.
    await act(async () => {
      rejectAlphaReorder(new Error('boom'))
    })

    expect(
      screen.queryByRole('alert'),
    ).toBeNull()
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '103',
      '101',
      '102',
    ])
    expect(columnCardIds(container, 'todo')).toEqual([])

    // Mutation 2 (Beta, newer) now fails: its rollback restores a
    // snapshot that STILL contains Alpha's failed move, and as the
    // last settled drop of the failed cohort it must trigger the
    // canonical reconciliation.
    await act(async () => {
      rejectBetaReorder(new Error('boom'))
    })

    await waitFor(() => {
      expect(
        screen.getByRole('alert'),
      ).toHaveTextContent('Work item could not be moved.')
    })
    // Exactly ONE canonical reconciliation read is owed ...
    expect(listProjectWorkItems).toHaveBeenCalledTimes(2)
    expectBoardStillRendered(container)

    // Simulated backend: NEITHER move was applied.
    await act(async () => {
      resolveReconciliation([ALPHA, BETA, GAMMA])
    })

    // The visible order matches the AUTHORITATIVE server state.
    expect(columnCardIds(container, 'todo')).toEqual([
      '101',
      '102',
    ])
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '103',
    ])
    expect(listProjectWorkItems).toHaveBeenCalledTimes(2)
  })

  it('a successful older drop is not lost when the newer drop fails: the final display matches the simulated backend', async () => {
    mockProjectData({ workItems: [ALPHA, BETA, GAMMA] })

    // Call sequence for the canonical list:
    // 1 — initial load,
    // 2 — the revalidation of Alpha's SUCCESSFUL move (held).
    let resolveAlphaReorder!: (item: ApiWorkItem) => void
    let rejectBetaReorder!: (error: Error) => void
    let resolveAlphaRefresh!: (items: ApiWorkItem[]) => void
    let reorderCalls = 0

    vi.mocked(listProjectWorkItems)
      .mockResolvedValueOnce([ALPHA, BETA, GAMMA])
      .mockImplementationOnce(
        () =>
          new Promise<ApiWorkItem[]>((resolve) => {
            resolveAlphaRefresh = resolve
          }),
      )

    vi.mocked(reorderWorkItem).mockImplementation(
      () =>
        new Promise<ApiWorkItem>((resolve, reject) => {
          reorderCalls += 1
          if (reorderCalls === 1) {
            resolveAlphaReorder = resolve
          } else {
            rejectBetaReorder = reject
          }
        }),
    )

    const { container } = await renderWorkItemsBoard(
      'Alpha',
    )

    // Drop 1: Alpha -> in_progress (mutation held).
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Alpha' }),
      'in_progress',
    )

    // Drop 2 (NEWER): Beta -> in_progress (mutation held).
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Beta' }),
      'in_progress',
    )

    // Mutation 1 (Alpha) SUCCEEDS: its canonical revalidation
    // starts.
    await act(async () => {
      resolveAlphaReorder({
        ...ALPHA,
        statusDefinitionId: 11,
        boardPosition: 1,
      })
    })
    expect(listProjectWorkItems).toHaveBeenCalledTimes(2)

    // Mutation 2 (Beta) FAILS: its rollback restores its snapshot
    // (which contains Alpha's successful move) — the successful
    // move must not be lost by the other drop's rollback.
    await act(async () => {
      rejectBetaReorder(new Error('boom'))
    })

    await waitFor(() => {
      expect(
        screen.getByRole('alert'),
      ).toHaveTextContent('Work item could not be moved.')
    })
    expectBoardStillRendered(container)

    // Simulated backend: ONLY Alpha's move was applied.
    await act(async () => {
      resolveAlphaRefresh([
        BETA,
        { ...ALPHA, statusDefinitionId: 11, boardPosition: 1 },
        { ...GAMMA, boardPosition: 2 },
      ])
    })

    // The successful move is retained, the failed move reverted —
    // exactly the simulated backend state.
    expect(columnCardIds(container, 'todo')).toEqual(['102'])
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '101',
      '103',
    ])
    // The successful drop's own revalidation IS the canonical
    // settlement: no extra reconciliation refresh (no loop).
    expect(listProjectWorkItems).toHaveBeenCalledTimes(2)
  })

  it('a failed older drop is reconciled when the newer drop succeeds: the final display matches the simulated backend', async () => {
    mockProjectData({ workItems: [ALPHA, BETA, GAMMA] })

    // Call sequence for the canonical list:
    // 1 — initial load,
    // 2 — the revalidation of Beta's SUCCESSFUL move (held).
    let rejectAlphaReorder!: (error: Error) => void
    let resolveBetaReorder!: (item: ApiWorkItem) => void
    let resolveBetaRefresh!: (items: ApiWorkItem[]) => void
    let reorderCalls = 0

    vi.mocked(listProjectWorkItems)
      .mockResolvedValueOnce([ALPHA, BETA, GAMMA])
      .mockImplementationOnce(
        () =>
          new Promise<ApiWorkItem[]>((resolve) => {
            resolveBetaRefresh = resolve
          }),
      )

    vi.mocked(reorderWorkItem).mockImplementation(
      () =>
        new Promise<ApiWorkItem>((resolve, reject) => {
          reorderCalls += 1
          if (reorderCalls === 1) {
            rejectAlphaReorder = reject
          } else {
            resolveBetaReorder = resolve
          }
        }),
    )

    const { container } = await renderWorkItemsBoard(
      'Alpha',
    )

    // Drop 1: Alpha -> in_progress (mutation held).
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Alpha' }),
      'in_progress',
    )

    // Drop 2 (NEWER): Beta -> in_progress (mutation held).
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Beta' }),
      'in_progress',
    )

    // Mutation 1 (Alpha) FAILS while Beta is still in flight: its
    // rollback is skipped and its optimistic state persists.
    await act(async () => {
      rejectAlphaReorder(new Error('boom'))
    })

    expect(
      screen.queryByRole('alert'),
    ).toBeNull()
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '103',
      '101',
      '102',
    ])

    // Mutation 2 (Beta) SUCCEEDS: its revalidation must adopt the
    // canonical state, in which Alpha's move is NOT applied.
    await act(async () => {
      resolveBetaReorder({
        ...BETA,
        statusDefinitionId: 11,
        boardPosition: 1,
      })
    })
    expect(listProjectWorkItems).toHaveBeenCalledTimes(2)

    // Simulated backend: ONLY Beta's move was applied.
    await act(async () => {
      resolveBetaRefresh([
        ALPHA,
        { ...BETA, statusDefinitionId: 11, boardPosition: 1 },
        { ...GAMMA, boardPosition: 2 },
      ])
    })

    // The failed move is gone, the successful move retained —
    // exactly the simulated backend state.
    expect(columnCardIds(container, 'todo')).toEqual(['101'])
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '102',
      '103',
    ])
    expect(listProjectWorkItems).toHaveBeenCalledTimes(2)
  })

  it('still shows the destination loading shell until the initial Work Items load resolves', async () => {
    mockProjectData({ workItems: [ALPHA, BETA, GAMMA] })

    let resolveList!: (items: ApiWorkItem[]) => void
    vi.mocked(listProjectWorkItems).mockImplementation(
      () =>
        new Promise<ApiWorkItem[]>((resolve) => {
          resolveList = resolve
        }),
    )

    const { container } = render(
      <MemoryRouter
        initialEntries={['/projects/7/work-items']}
      >
        <Routes>
          <Route
            path="/projects/:projectId/:tab"
            element={<ProjectDetailPage />}
          />
        </Routes>
      </MemoryRouter>,
    )

    // The page-level skeleton goes away as soon as the PROJECT
    // payload resolves. From that moment until the Work Items
    // payload resolves, the Work Items tab shows the destination
    // loading shell — and no Board column exists.
    await waitFor(() => {
      expect(
        screen.queryByRole('status', {
          name: 'Loading project',
        }),
      ).toBeNull()
    })

    await screen.findByRole('region', {
      name: 'Loading project work items',
    })

    expect(
      container.querySelector('[data-board-column]'),
    ).toBeNull()

    // Data resolves in place into the real Board — the legitimate
    // first-load loading UI is not suppressed.
    await act(async () => {
      resolveList([ALPHA, BETA, GAMMA])
    })

    expect(
      screen.queryByRole('region', {
        name: 'Loading project work items',
      }),
    ).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Open Alpha' }),
    ).toBeInTheDocument()
  })
})

/**
 * Project-switch hygiene for in-flight Board drops.
 *
 * The route renders ONE mounted ProjectDetailPage instance for every
 * `/projects/:projectId/...` URL (no route key), so navigating from
 * Project A to Project B reuses the same component: its Board-drop
 * state (sequences, pending mutations, snapshots) outlives the A
 * context. The regression under test: a drop started in A whose
 * reorder mutation is still in flight when the user switches to B —
 * its settle callback must never touch B's Work Item state
 * (rollback snapshot, drop error, revalidation). A fast A → B → A
 * must not be confused with "still in A": the second A is a NEW
 * project context.
 */
describe('Project Board drops do not leak across a project switch', () => {
  const PROJECT_A = makeProject({
    id: 7,
    name: 'Project A',
  })
  const PROJECT_B = makeProject({
    id: 8,
    name: 'Project B',
  })

  const A_ALPHA = makeWorkItem({
    id: 101,
    title: 'Alpha',
    projectId: 7,
    statusDefinitionId: 10,
    boardPosition: 1,
  })
  const A_BETA = makeWorkItem({
    id: 102,
    title: 'Beta',
    projectId: 7,
    statusDefinitionId: 10,
    boardPosition: 2,
  })
  const A_GAMMA = makeWorkItem({
    id: 103,
    title: 'Gamma',
    projectId: 7,
    statusDefinitionId: 11,
    boardPosition: 1,
  })
  // Created in Project A while the user was away (e.g. by another
  // member): it exists in the FRESH A load but not in the A1
  // pre-drop snapshot the stale drop callback captured.
  const A_ETA = makeWorkItem({
    id: 104,
    title: 'Eta',
    projectId: 7,
    statusDefinitionId: 10,
    boardPosition: 3,
  })

  const B_DELTA = makeWorkItem({
    id: 201,
    title: 'Delta',
    projectId: 8,
    statusDefinitionId: 10,
    boardPosition: 1,
  })
  const B_EPSILON = makeWorkItem({
    id: 202,
    title: 'Epsilon',
    projectId: 8,
    statusDefinitionId: 10,
    boardPosition: 2,
  })

  let navigateTo: ((to: string) => void) | null = null

  function NavigationProbe() {
    navigateTo = useNavigate()
    return null
  }

  type Deferred<T> = {
    resolve: (value: T) => void
    reject: (reason: Error) => void
  }

  /**
   * Both projects over one mounted page instance. `workItemQueues`
   * controls the per-project `listProjectWorkItems` answers call by
   * call (first entry = initial load; the last entry repeats for
   * every later revalidation of that project); the returned object
   * counts the calls per project.
   */
  function mockTwoProjects(
    workItemQueues: Record<number, ApiWorkItem[][]>,
  ) {
    const listCalls: Record<number, number> = {}

    vi.mocked(getProject).mockImplementation((id) =>
      Promise.resolve(id === 7 ? PROJECT_A : PROJECT_B),
    )
    vi.mocked(getProjectWorkItemConfiguration).mockResolvedValue(
      CONFIGURATION,
    )
    vi.mocked(listProjectMemberships).mockResolvedValue([
      makeMembership('owner'),
    ])
    vi.mocked(listResearchGroupMembers).mockResolvedValue(
      GROUP_MEMBERS,
    )
    vi.mocked(listProjectWorkItems).mockImplementation((id) => {
      listCalls[id] = (listCalls[id] ?? 0) + 1
      const queue = workItemQueues[id]

      return Promise.resolve(
        queue[Math.min(listCalls[id] - 1, queue.length - 1)],
      )
    })

    return listCalls
  }

  /** Every reorder mutation is held until the test settles it. */
  function holdReorders() {
    const reorders: Array<Deferred<ApiWorkItem>> = []

    vi.mocked(reorderWorkItem).mockImplementation(() =>
      new Promise<ApiWorkItem>((resolve, reject) => {
        reorders.push({ resolve, reject })
      }),
    )

    return reorders
  }

  async function renderSwitchableBoard() {
    const rendered = render(
      <MemoryRouter initialEntries={['/projects/7/work-items']}>
        <NavigationProbe />

        <Routes>
          <Route
            path="/projects/:projectId/:tab"
            element={<ProjectDetailPage />}
          />
        </Routes>
      </MemoryRouter>,
    )

    // The Board only exists once Project A's initial Work Items
    // fetch has resolved.
    await screen.findByRole('button', { name: 'Open Alpha' })

    return rendered
  }

  async function switchToProjectB() {
    await act(async () => {
      navigateTo?.('/projects/8/work-items')
    })

    // Project B's own Work Items are fully loaded.
    await screen.findByRole('button', { name: 'Open Delta' })
  }

  it('a stale failed drop from the abandoned project never clobbers the new project board', async () => {
    const listCalls = mockTwoProjects({
      7: [[A_ALPHA, A_BETA, A_GAMMA]],
      8: [
        [B_DELTA, B_EPSILON],
        [
          B_EPSILON,
          { ...B_DELTA, statusDefinitionId: 11, boardPosition: 1 },
        ],
      ],
    })
    const reorders = holdReorders()

    const { container } = await renderSwitchableBoard()

    // Drop Alpha (todo -> in_progress) in Project A; the mutation
    // stays in flight.
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Alpha' }),
      'in_progress',
    )
    expect(reorderWorkItem).toHaveBeenCalledWith(
      101,
      { statusDefinitionId: 11, beforeWorkItemId: null },
    )
    expect(columnCardIds(container, 'todo')).toEqual(['102'])
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '103',
      '101',
    ])

    // Switch to Project B inside the SAME mounted page instance.
    await switchToProjectB()
    expect(columnCardIds(container, 'todo')).toEqual([
      '201',
      '202',
    ])
    expect(screen.queryByRole('button', { name: 'Open Alpha' })).toBeNull()

    // The STALE Project A mutation now fails.
    await act(async () => {
      reorders[0].reject(new Error('boom'))
    })

    // Project B's Board keeps exclusively its own Work Items: the
    // abandoned A snapshot (Alpha/Beta/Gamma) never re-appears.
    expect(columnCardIds(container, 'todo')).toEqual([
      '201',
      '202',
    ])
    expect(columnCardIds(container, 'in_progress')).toEqual([])
    expect(screen.queryByRole('button', { name: 'Open Alpha' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open Beta' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open Gamma' })).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Open Epsilon' }),
    ).toBeInTheDocument()

    // No A-related drop error is surfaced in Project B.
    expect(screen.queryByRole('alert')).toBeNull()

    // No A-related revalidation was triggered for the new project.
    expect(listCalls[8]).toBe(1)

    // A subsequent VALID drop in Project B still works ...
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Delta' }),
      'in_progress',
    )
    expect(reorderWorkItem).toHaveBeenLastCalledWith(
      201,
      { statusDefinitionId: 11, beforeWorkItemId: null },
    )
    expect(columnCardIds(container, 'in_progress')).toEqual(['201'])
    expect(columnCardIds(container, 'todo')).toEqual(['202'])

    // ... and its OWN revalidation reconciles it.
    await act(async () => {
      reorders[1].resolve({
        ...B_DELTA,
        statusDefinitionId: 11,
        boardPosition: 1,
      })
    })
    await waitFor(() => {
      expect(listCalls[8]).toBe(2)
      expect(columnCardIds(container, 'in_progress')).toEqual(['201'])
    })
    expect(columnCardIds(container, 'todo')).toEqual(['202'])
    expectBoardStillRendered(container)
  })

  it('a stale successful drop from the abandoned project never revalidates the new project', async () => {
    const listCalls = mockTwoProjects({
      7: [[A_ALPHA, A_BETA, A_GAMMA]],
      8: [
        [B_DELTA, B_EPSILON],
        [
          B_EPSILON,
          { ...B_DELTA, statusDefinitionId: 11, boardPosition: 1 },
        ],
      ],
    })
    const reorders = holdReorders()

    const { container } = await renderSwitchableBoard()

    // Drop Alpha in Project A; the mutation stays in flight.
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Alpha' }),
      'in_progress',
    )
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '103',
      '101',
    ])

    // Switch to Project B; it fully loads its own Work Items.
    await switchToProjectB()
    expect(columnCardIds(container, 'todo')).toEqual([
      '201',
      '202',
    ])

    // The STALE Project A mutation now succeeds.
    await act(async () => {
      reorders[0].resolve({
        ...A_ALPHA,
        statusDefinitionId: 11,
        boardPosition: 2,
      })
    })

    // Project B's state is untouched: the abandoned drop triggers
    // NO revalidation of the new project (no extra fetch, no
    // re-set of B's collection) ...
    expect(listCalls[8]).toBe(1)
    expect(columnCardIds(container, 'todo')).toEqual([
      '201',
      '202',
    ])
    expect(screen.queryByRole('alert')).toBeNull()

    // ... and the Board stays exactly as loaded.
    expectBoardStillRendered(container)

    // Project B remains operable: a fresh drop in B works end to
    // end with its own revalidation.
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Delta' }),
      'in_progress',
    )
    expect(reorderWorkItem).toHaveBeenLastCalledWith(
      201,
      { statusDefinitionId: 11, beforeWorkItemId: null },
    )
    expect(columnCardIds(container, 'in_progress')).toEqual(['201'])
    expect(columnCardIds(container, 'todo')).toEqual(['202'])

    await act(async () => {
      reorders[1].resolve({
        ...B_DELTA,
        statusDefinitionId: 11,
        boardPosition: 1,
      })
    })
    await waitFor(() => {
      expect(listCalls[8]).toBe(2)
      expect(columnCardIds(container, 'in_progress')).toEqual(['201'])
    })
    expect(columnCardIds(container, 'todo')).toEqual(['202'])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a stale failed drop from the first A never clobbers the fresh A board after A → B → A', async () => {
    const listCalls = mockTwoProjects({
      7: [
        [A_ALPHA, A_BETA, A_GAMMA],
        // FRESH A2 load: the same items plus Eta, created by
        // someone else while the user was away.
        [A_ALPHA, A_BETA, A_GAMMA, A_ETA],
      ],
      8: [[B_DELTA, B_EPSILON]],
    })
    const reorders = holdReorders()

    const { container } = await renderSwitchableBoard()

    // Drop Alpha in Project A (context A1); the mutation stays in
    // flight.
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Alpha' }),
      'in_progress',
    )

    // A1 → B → A: back on Project A in the same mounted instance,
    // but a FRESH A context (re-fetched project + Work Items).
    await switchToProjectB()
    expect(columnCardIds(container, 'todo')).toEqual([
      '201',
      '202',
    ])

    await act(async () => {
      navigateTo?.('/projects/7/work-items')
    })
    await screen.findByRole('button', { name: 'Open Eta' })
    expect(columnCardIds(container, 'todo')).toEqual([
      '101',
      '102',
      '104',
    ])
    expect(columnCardIds(container, 'in_progress')).toEqual(['103'])

    // The STALE A1 mutation now fails.
    await act(async () => {
      reorders[0].reject(new Error('boom'))
    })

    // The fresh A board is untouched: the A1 snapshot (without Eta)
    // is NOT restored, no A1 drop error surfaces, and no A-related
    // revalidation is triggered for the fresh context.
    expect(columnCardIds(container, 'todo')).toEqual([
      '101',
      '102',
      '104',
    ])
    expect(columnCardIds(container, 'in_progress')).toEqual(['103'])
    expect(screen.queryByRole('alert')).toBeNull()
    expect(listCalls[7]).toBe(2)
    expectBoardStillRendered(container)
  })

  it('a stale successful drop from the first A never revalidates the fresh A board after A → B → A', async () => {
    const listCalls = mockTwoProjects({
      7: [
        [A_ALPHA, A_BETA, A_GAMMA],
        // FRESH A2 initial load: the in-flight A1 move is not
        // visible yet — A2 re-fetches the pre-move state.
        [A_ALPHA, A_BETA, A_GAMMA],
        // The revalidation of the FRESH A2 drop below reconciles
        // the column after ITS move.
        [
          { ...A_BETA, statusDefinitionId: 11, boardPosition: 1 },
          { ...A_GAMMA, boardPosition: 2 },
          A_ALPHA,
        ],
      ],
      8: [[B_DELTA, B_EPSILON]],
    })
    const reorders = holdReorders()

    const { container } = await renderSwitchableBoard()

    // Drop Alpha in Project A (context A1); the mutation stays in
    // flight.
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Alpha' }),
      'in_progress',
    )
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '103',
      '101',
    ])

    // A1 → B → A: fresh A context in the same mounted instance.
    await switchToProjectB()

    await act(async () => {
      navigateTo?.('/projects/7/work-items')
    })
    await screen.findByRole('button', { name: 'Open Alpha' })
    expect(columnCardIds(container, 'todo')).toEqual([
      '101',
      '102',
    ])
    expect(columnCardIds(container, 'in_progress')).toEqual(['103'])

    // The STALE A1 mutation now succeeds.
    await act(async () => {
      reorders[0].resolve({
        ...A_ALPHA,
        statusDefinitionId: 11,
        boardPosition: 2,
      })
    })

    // The fresh A context is not revalidated by the abandoned drop:
    // no extra fetch, the board stays exactly as A2 loaded it.
    expect(listCalls[7]).toBe(2)
    expect(columnCardIds(container, 'todo')).toEqual([
      '101',
      '102',
    ])
    expect(columnCardIds(container, 'in_progress')).toEqual(['103'])
    expect(screen.queryByRole('alert')).toBeNull()

    // The fresh A instance stays operable: a NEW drop in A works
    // end to end with its own revalidation.
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Beta' }),
      'in_progress',
    )
    expect(reorderWorkItem).toHaveBeenLastCalledWith(
      102,
      { statusDefinitionId: 11, beforeWorkItemId: null },
    )
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '103',
      '102',
    ])
    expect(columnCardIds(container, 'todo')).toEqual(['101'])

    await act(async () => {
      reorders[1].resolve({
        ...A_BETA,
        statusDefinitionId: 11,
        boardPosition: 1,
      })
    })
    await waitFor(() => {
      expect(listCalls[7]).toBe(3)
      expect(columnCardIds(container, 'in_progress')).toEqual([
        '102',
        '103',
      ])
    })
    expect(columnCardIds(container, 'todo')).toEqual(['101'])
    expect(screen.queryByRole('alert')).toBeNull()
    expectBoardStillRendered(container)
  })
})

describe('Project Board canonical order for unnormalized (legacy) positions', () => {
  // createdAt values that deliberately CONTRADICT the id order, so
  // any comparator that skips the created_at tie-break renders the
  // wrong order.
  const T1 = '2026-01-01T00:00:00Z'
  const T2 = '2026-01-02T00:00:00Z'
  const T3 = '2026-01-03T00:00:00Z'

  it('renders equal explicit positions in createdAt order (higher id, earlier createdAt first)', async () => {
    const laterCreated = makeWorkItem({
      id: 201,
      title: 'Later created',
      boardPosition: 5,
      createdAt: T2,
    })
    const earlierCreated = makeWorkItem({
      id: 202,
      title: 'Earlier created',
      boardPosition: 5,
      createdAt: T1,
    })

    mockProjectData({ workItems: [laterCreated, earlierCreated] })

    const { container } = await renderWorkItemsBoard(
      'Later created',
    )

    expect(columnCardIds(container, 'todo')).toEqual([
      '202',
      '201',
    ])
  })

  it('renders NULL positions in createdAt order (higher id, earlier createdAt first)', async () => {
    const laterCreated = makeWorkItem({
      id: 201,
      title: 'Later created',
      boardPosition: null,
      createdAt: T2,
    })
    const earlierCreated = makeWorkItem({
      id: 202,
      title: 'Earlier created',
      boardPosition: null,
      createdAt: T1,
    })

    mockProjectData({ workItems: [laterCreated, earlierCreated] })

    const { container } = await renderWorkItemsBoard(
      'Later created',
    )

    expect(columnCardIds(container, 'todo')).toEqual([
      '202',
      '201',
    ])
  })

  it('decides identical createdAt by ascending id', async () => {
    const lowerId = makeWorkItem({
      id: 201,
      title: 'Twin, lower id',
      boardPosition: null,
      createdAt: T1,
    })
    const higherId = makeWorkItem({
      id: 202,
      title: 'Twin, higher id',
      boardPosition: null,
      createdAt: T1,
    })

    mockProjectData({ workItems: [higherId, lowerId] })

    const { container } = await renderWorkItemsBoard(
      'Twin, lower id',
    )

    expect(columnCardIds(container, 'todo')).toEqual([
      '201',
      '202',
    ])
  })

  it('renders explicit positions before NULL ones, each group in (createdAt, id) order', async () => {
    const positionOne = makeWorkItem({
      id: 301,
      title: 'Position one',
      boardPosition: 1,
      createdAt: T3,
    })
    const positionTwo = makeWorkItem({
      id: 302,
      title: 'Position two',
      boardPosition: 2,
      createdAt: T2,
    })
    const unsortedLaterCreated = makeWorkItem({
      id: 303,
      title: 'Unsorted, later created',
      boardPosition: null,
      createdAt: T2,
    })
    const unsortedEarlierCreated = makeWorkItem({
      id: 304,
      title: 'Unsorted, earlier created',
      boardPosition: null,
      createdAt: T1,
    })

    mockProjectData({
      workItems: [
        positionOne,
        positionTwo,
        unsortedLaterCreated,
        unsortedEarlierCreated,
      ],
    })

    const { container } = await renderWorkItemsBoard(
      'Position one',
    )

    expect(columnCardIds(container, 'todo')).toEqual([
      '301',
      '302',
      '304',
      '303',
    ])
  })

  it('optimistic reorder from a legacy column uses the visually correct anchor, and the transform agrees with the render', async () => {
    // All three are unpositioned; the createdAt order contradicts
    // the id order, so only the canonical comparator agrees with
    // the server column order.
    const late = makeWorkItem({
      id: 401,
      title: 'Late',
      boardPosition: null,
      createdAt: T3,
    })
    const early = makeWorkItem({
      id: 402,
      title: 'Early',
      boardPosition: null,
      createdAt: T1,
    })
    const mid = makeWorkItem({
      id: 403,
      title: 'Mid',
      boardPosition: null,
      createdAt: T2,
    })

    mockProjectData({ workItems: [late, early, mid] })

    vi.mocked(reorderWorkItem).mockImplementation(
      () => new Promise<ApiWorkItem>(() => {}),
    )

    const { container } = await renderWorkItemsBoard('Early')

    // The VISIBLE column follows the canonical (created_at, id)
    // order — the server renders the column exactly like this.
    expect(columnCardIds(container, 'todo')).toEqual([
      '402',
      '403',
      '401',
    ])

    // Drag the visually LAST card (Late, id 401) to the very top:
    // the anchor must be the first VISIBLE card (Early, 402).
    await dropCardOnBoardColumn(
      container,
      screen.getByRole('button', { name: 'Open Late' }),
      'todo',
      STUB_CARD_TOP + 20,
    )

    // The request anchors on the visually correct card — never on
    // an id the user cannot see at that slot.
    expect(reorderWorkItem).toHaveBeenCalledTimes(1)
    expect(reorderWorkItem).toHaveBeenCalledWith(
      401,
      {
        statusDefinitionId: 10,
        beforeWorkItemId: 402,
      },
    )

    // The rendered board and the optimistic transform yield the
    // SAME order from the same starting order.
    const transformedOrder = applyWorkItemBoardMove(
      [late, early, mid],
      CONFIGURATION,
      401,
      10,
      402,
    )
      .filter((item) => item.statusDefinitionId === 10)
      .sort(compareWorkItemBoardOrder)
      .map((item) => String(item.id))

    expect(columnCardIds(container, 'todo')).toEqual(
      transformedOrder,
    )
    expect(columnCardIds(container, 'todo')).toEqual([
      '401',
      '402',
      '403',
    ])
  })
})


describe('Project Work Items status configuration safety', () => {
  // The panel persists the user's Board/List view preference under a
  // fixed user+project key; a test that switches the view must not
  // leak that preference into the next test's mount.
  beforeEach(() => {
    window.localStorage.clear()
  })

  const CONFIG_WITH_DONE: ApiProjectWorkItemConfiguration = {
    ...CONFIGURATION,
    statuses: [
      ...CONFIGURATION.statuses,
      {
        id: 13,
        name: 'Done',
        category: 'done',
        order: 2,
        active: true,
        isDefault: false,
      },
    ],
  }

  function mockFailedConfigurationGet(
    workItems: ApiWorkItem[],
  ) {
    vi.mocked(getProject).mockResolvedValue(makeProject())
    vi.mocked(getProjectWorkItemConfiguration).mockRejectedValue(
      new Error('configuration unavailable'),
    )
    vi.mocked(listProjectWorkItems).mockResolvedValue(
      workItems,
    )
    vi.mocked(listProjectMemberships).mockResolvedValue([
      makeMembership('owner'),
    ])
    vi.mocked(listResearchGroupMembers).mockResolvedValue(
      GROUP_MEMBERS,
    )
  }

  function renderWorkItemsTab() {
    return render(
      <MemoryRouter
        initialEntries={['/projects/7/work-items']}
      >
        <Routes>
          <Route
            path="/projects/:projectId/:tab"
            element={<ProjectDetailPage />}
          />
        </Routes>
      </MemoryRouter>,
    )
  }

  it('shows a done work item in the done column when the configuration loads', async () => {
    mockProjectData({
      configuration: CONFIG_WITH_DONE,
      workItems: [
        makeWorkItem({
          id: 501,
          title: 'Shipped',
          statusDefinitionId: 13,
          boardPosition: 1,
        }),
      ],
    })

    const { container } = await renderWorkItemsBoard('Shipped')

    expect(columnCardIds(container, 'done')).toEqual(['501'])
    expect(columnCardIds(container, 'todo')).toEqual([])
  })

  it('shows a retryable error state — never a guessed Todo card — when the configuration GET fails', async () => {
    mockFailedConfigurationGet([
      makeWorkItem({
        id: 502,
        title: 'Orphan',
        statusDefinitionId: 10,
        boardPosition: 1,
      }),
    ])

    const { container } = renderWorkItemsTab()

    // The Work Items fetch settled, the configuration GET failed:
    // the surface is in the explicit error state with a retry.
    await screen.findByRole('button', { name: 'Retry' })

    // No guessed column membership: the item is on NO column, the
    // board offers no drop targets, and nothing is sent.
    expect(
      screen.queryByRole('button', { name: 'Open Orphan' }),
    ).not.toBeInTheDocument()
    expect(
      container.querySelector('[data-board-column]'),
    ).toBeNull()
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(reorderWorkItem).not.toHaveBeenCalled()
  })

  it('recovers through Retry: the configuration is fetched again and the item lands in its real column', async () => {
    vi.mocked(getProject).mockResolvedValue(makeProject())
    vi.mocked(getProjectWorkItemConfiguration)
      .mockRejectedValueOnce(
        new Error('first attempt fails'),
      )
      .mockResolvedValueOnce(CONFIG_WITH_DONE)
    vi.mocked(listProjectWorkItems).mockResolvedValue([
      makeWorkItem({
        id: 503,
        title: 'Finished',
        statusDefinitionId: 13,
        boardPosition: 1,
      }),
    ])
    vi.mocked(listProjectMemberships).mockResolvedValue([
      makeMembership('owner'),
    ])
    vi.mocked(listResearchGroupMembers).mockResolvedValue(
      GROUP_MEMBERS,
    )

    const { container } = renderWorkItemsTab()

    const retry = await screen.findByRole(
      'button',
      { name: 'Retry' },
    )

    expect(
      screen.queryByRole('button', {
        name: 'Open Finished',
      }),
    ).not.toBeInTheDocument()

    await act(async () => {
      fireEvent.click(retry)
    })

    await screen.findByRole('button', {
      name: 'Open Finished',
    })

    // Exactly one retry request — no page reload, no double fetch.
    expect(getProjectWorkItemConfiguration).toHaveBeenCalledTimes(2)
    expect(columnCardIds(container, 'done')).toEqual(['503'])
  })

  it('keeps the error state when the retry fails again', async () => {
    mockFailedConfigurationGet([
      makeWorkItem({
        id: 504,
        title: 'Still here',
        statusDefinitionId: 10,
        boardPosition: 1,
      }),
    ])

    const { container } = renderWorkItemsTab()

    const retry = await screen.findByRole(
      'button',
      { name: 'Retry' },
    )

    await act(async () => {
      fireEvent.click(retry)
    })

    await waitFor(() => {
      expect(
        getProjectWorkItemConfiguration,
      ).toHaveBeenCalledTimes(2)
    })

    // Still the explicit error state — no guessed card, no board.
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', {
        name: 'Open Still here',
      }),
    ).not.toBeInTheDocument()
    expect(
      container.querySelector('[data-board-column]'),
    ).toBeNull()
    expect(reorderWorkItem).not.toHaveBeenCalled()
  })

  it('an unknown statusDefinitionId never lands in a guessed Todo column', async () => {
    mockProjectData({
      configuration: CONFIG_WITH_DONE,
      workItems: [
        makeWorkItem({
          id: 505,
          title: 'Mystery',
          statusDefinitionId: 999,
          boardPosition: 1,
        }),
        makeWorkItem({
          id: 506,
          title: 'Ordinary',
          statusDefinitionId: 10,
          boardPosition: 2,
        }),
      ],
    })

    const { container } = await renderWorkItemsBoard('Ordinary')

    expect(columnCardIds(container, 'todo')).toEqual(['506'])
    // The unresolved item belongs to NO column on the Board.
    expect(
      container.querySelector('[data-work-item-id="505"]'),
    ).toBeNull()

    // The List names the condition instead of inventing a status.
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'List' }),
      )
    })
    expect(
      screen.getByText('Status unavailable'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Open Mystery' }),
    ).toBeInTheDocument()
  })

  it('an inactive but referenced status definition still resolves to its category', async () => {
    const configWithInactiveDone: ApiProjectWorkItemConfiguration = {
      ...CONFIGURATION,
      statuses: [
        ...CONFIGURATION.statuses,
        {
          id: 13,
          name: 'Done (legacy)',
          category: 'done',
          order: 2,
          active: false,
          isDefault: false,
        },
      ],
    }

    mockProjectData({
      configuration: configWithInactiveDone,
      workItems: [
        makeWorkItem({
          id: 507,
          title: 'Legacy done',
          statusDefinitionId: 13,
          boardPosition: 1,
        }),
      ],
    })

    const { container } =
      await renderWorkItemsBoard('Legacy done')

    expect(columnCardIds(container, 'done')).toEqual(['507'])
    expect(columnCardIds(container, 'todo')).toEqual([])
  })

  it('sends no reorder request while status resolution is unavailable', async () => {
    // A failed configuration GET leaves no rendered Board at all:
    // no columns, no cards, no drop targets — a drag sequence fired
    // at the surface must not produce a single mutation request.
    mockFailedConfigurationGet([
      makeWorkItem({
        id: 508,
        title: 'Untouchable',
        statusDefinitionId: 10,
        boardPosition: 1,
      }),
    ])

    const { container } = renderWorkItemsTab()

    await screen.findByRole('button', { name: 'Retry' })

    expect(
      container.querySelector('[data-board-column]'),
    ).toBeNull()
    expect(
      screen.queryByRole('button', {
        name: 'Open Untouchable',
      }),
    ).not.toBeInTheDocument()
    expect(reorderWorkItem).not.toHaveBeenCalled()
  })

  it('a late configuration answer from the abandoned project never changes the new project', async () => {
    // Project A maps status definition 10 to `todo`; Project B maps
    // the SAME id to `done`. A's delayed answer must not re-map B's
    // items into foreign Board data (and must not import an error).
    const PROJECT_A = makeProject({
      id: 7,
      name: 'Project A',
    })
    const PROJECT_B = makeProject({
      id: 8,
      name: 'Project B',
    })

    const CONFIG_A: ApiProjectWorkItemConfiguration = {
      ...CONFIGURATION,
      statuses: [
        {
          id: 10,
          name: 'Todo A',
          category: 'todo',
          order: 0,
          active: true,
          isDefault: true,
        },
      ],
    }
    const CONFIG_B: ApiProjectWorkItemConfiguration = {
      ...CONFIGURATION,
      statuses: [
        {
          id: 10,
          name: 'Done B',
          category: 'done',
          order: 0,
          active: true,
          isDefault: true,
        },
      ],
    }

    const aItem = makeWorkItem({
      id: 301,
      title: 'A item',
      projectId: 7,
      statusDefinitionId: 10,
      boardPosition: 1,
    })
    const bItem = makeWorkItem({
      id: 302,
      title: 'B item',
      projectId: 8,
      statusDefinitionId: 10,
      boardPosition: 1,
    })

    let releaseAConfig:
      | ((value: ApiProjectWorkItemConfiguration) => void)
      | null = null

    vi.mocked(getProject).mockImplementation((id) =>
      Promise.resolve(id === 7 ? PROJECT_A : PROJECT_B),
    )
    vi.mocked(getProjectWorkItemConfiguration).mockImplementation(
      (id) =>
        id === 7
          ? new Promise(
              (resolve) => {
                releaseAConfig = resolve
              },
            )
          : Promise.resolve(CONFIG_B),
    )
    vi.mocked(listProjectMemberships).mockResolvedValue([
      makeMembership('owner'),
    ])
    vi.mocked(listResearchGroupMembers).mockResolvedValue(
      GROUP_MEMBERS,
    )
    vi.mocked(listProjectWorkItems).mockImplementation((id) =>
      Promise.resolve(id === 7 ? [aItem] : [bItem]),
    )

    let navigateTo: ((to: string) => void) | null = null

    function NavigationProbe() {
      navigateTo = useNavigate()
      return null
    }

    const { container } = render(
      <MemoryRouter
        initialEntries={['/projects/7/work-items']}
      >
        <NavigationProbe />

        <Routes>
          <Route
            path="/projects/:projectId/:tab"
            element={<ProjectDetailPage />}
          />
        </Routes>
      </MemoryRouter>,
    )

    // Switch to Project B and wait until B's Board is loaded with
    // B's OWN configuration answer.
    await act(async () => {
      navigateTo?.('/projects/8/work-items')
    })
    await screen.findByRole('button', { name: 'Open B item' })

    // B's item resolves through B's configuration (10 = done).
    expect(columnCardIds(container, 'done')).toEqual(['302'])

    // Now the abandoned Project A's configuration finally answers.
    await act(async () => {
      releaseAConfig?.(CONFIG_A)
    })

    // B's Board is unchanged: same item, same column — no foreign
    // data and no imported error state.
    expect(columnCardIds(container, 'done')).toEqual(['302'])
    expect(columnCardIds(container, 'todo')).toEqual([])
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
