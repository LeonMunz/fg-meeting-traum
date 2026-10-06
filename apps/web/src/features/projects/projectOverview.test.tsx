// @vitest-environment happy-dom

import {
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
import { listProjectWorkItems } from '../../api/work-items'
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
