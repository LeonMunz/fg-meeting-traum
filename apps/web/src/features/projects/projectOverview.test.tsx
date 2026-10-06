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
} from 'react-router'
import {
  afterEach,
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
} = {}) {
  const {
    project = makeProject(),
    memberships = [makeMembership('owner')],
    workItems = [],
  } = options

  vi.mocked(getProject).mockResolvedValue(project)
  vi.mocked(getProjectWorkItemConfiguration).mockResolvedValue(
    CONFIGURATION,
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
  vi.clearAllMocks()
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
