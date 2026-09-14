// @vitest-environment happy-dom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { useEffect } from 'react'
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from 'react-router'
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import {
  addProjectMembership,
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
// the unit test; the header member-cluster contract under test does not
// involve the drawer.
vi.mock('./WorkItemDrawer', () => ({
  WorkItemDrawer: () => null,
}))

const NOW = '2026-09-01T00:00:00Z'

const PROJECT: ApiProject = {
  id: 7,
  researchGroupId: 1,
  name: 'Header Member Project',
  description: '',
  status: 'active',
  archivedAt: null,
  currentUserRole: 'owner',
  createdAt: NOW,
  updatedAt: NOW,
}

const CONFIGURATION: ApiProjectWorkItemConfiguration = {
  types: [
    {
      id: 4,
      name: 'Task',
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
  ],
  labels: [],
}

function membership(
  id: number,
  userId: number,
  username: string,
  firstName: string,
  role: 'owner' | 'member' | 'viewer',
): ApiProjectMembership {
  return {
    id,
    role,
    addedAt: NOW,
    user: {
      id: userId,
      username,
      firstName,
      lastName: '',
    },
  }
}

const ALEX_OWNER = membership(1, 1, 'alex', 'Alex', 'owner')

const ALEX_MEMBER = membership(1, 1, 'alex', 'Alex', 'member')

const CHRIS_MEMBER = membership(2, 2, 'chris', 'Chris', 'member')

const GROUP_MEMBERS: ApiResearchGroupMember[] = [
  {
    id: 1,
    username: 'alex',
    firstName: 'Alex',
    lastName: '',
    researchGroupRole: 'admin',
  },
  {
    id: 2,
    username: 'chris',
    firstName: 'Chris',
    lastName: '',
    researchGroupRole: 'member',
  },
  {
    id: 3,
    username: 'laura',
    firstName: 'Laura',
    lastName: '',
    researchGroupRole: 'member',
  },
]

function mockProjectData(
  memberships: ApiProjectMembership[],
) {
  vi.mocked(getProject).mockResolvedValue(PROJECT)
  vi.mocked(getProjectWorkItemConfiguration).mockResolvedValue(
    CONFIGURATION,
  )
  vi.mocked(listProjectWorkItems).mockResolvedValue([])
  vi.mocked(listProjectMemberships).mockResolvedValue(
    memberships,
  )
  vi.mocked(listResearchGroupMembers).mockResolvedValue(
    GROUP_MEMBERS,
  )
}

function LocationProbe({
  onPath,
}: {
  onPath: (path: string) => void
}) {
  const { pathname } = useLocation()

  useEffect(() => {
    onPath(pathname)
  }, [onPath, pathname])

  return null
}

function renderPage() {
  const paths: string[] = []
  const onPath = (path: string) => {
    paths.push(path)
  }

  render(
    <MemoryRouter
      initialEntries={['/projects/7/work-items']}
    >
      <Routes>
        <Route
          path="/projects/:projectId"
          element={<ProjectDetailPage />}
        />

        <Route
          path="/projects/:projectId/:tab"
          element={
            <>
              <ProjectDetailPage />
              <LocationProbe onPath={onPath} />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  )

  return { paths }
}

async function openAddMemberDialogFromHeader() {
  fireEvent.click(
    await screen.findByRole('button', {
      name: 'Add project member',
    }),
  )

  return screen.getByRole('dialog', {
    name: 'Add project member',
  })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Project Header add-member shortcut', () => {
  it('shows the add-member action for a Project owner', async () => {
    mockProjectData([ALEX_OWNER])

    renderPage()

    const addButton = await screen.findByRole(
      'button',
      { name: 'Add project member' },
    )

    expect(addButton).toHaveAttribute(
      'title',
      'Add project member',
    )
  })

  it('does not show the action for an unauthorized Project member', async () => {
    mockProjectData([ALEX_MEMBER])

    renderPage()

    // Wait until the member list has actually loaded so the
    // absence below is meaningful, not a pre-load snapshot.
    await screen.findByText('Member', { exact: true })

    expect(
      screen.queryByRole('button', {
        name: 'Add project member',
      }),
    ).not.toBeInTheDocument()
  })

  it('opens the Add-member dialog from the Work Items tab without navigating', async () => {
    mockProjectData([ALEX_OWNER])

    const { paths } = renderPage()

    const dialog = await openAddMemberDialogFromHeader()

    expect(dialog).toBeVisible()

    // The shortcut must not navigate to Settings or any
    // other route.
    expect(
      paths.every(
        (path) => path === '/projects/7/work-items',
      ),
    ).toBe(true)
  })

  it('uses the same Add-member dialog as Settings -> Access', async () => {
    mockProjectData([ALEX_OWNER])

    renderPage()

    // The header opens the dialog ...
    const fromHeader = await openAddMemberDialogFromHeader()

    expect(
      within(fromHeader).getByLabelText('Select person'),
    ).toBeInTheDocument()

    // ... and Settings -> Access opens the same shared dialog.
    fireEvent.click(
      within(fromHeader).getByRole('button', {
        name: 'Cancel',
      }),
    )

    fireEvent.click(
      screen.getByRole('link', {
        name: 'Settings',
      }),
    )

    fireEvent.click(
      await screen.findByRole('button', {
        name: /Add member/,
      }),
    )

    const fromSettings = screen.getByRole('dialog', {
      name: 'Add project member',
    })

    expect(fromSettings).toBeVisible()
    expect(
      within(fromSettings).getByLabelText('Select person'),
    ).toBeInTheDocument()
  })

  it('adds a member through the header dialog and updates the header cluster without a reload', async () => {
    mockProjectData([ALEX_OWNER])
    vi.mocked(addProjectMembership).mockResolvedValue(
      CHRIS_MEMBER,
    )

    const { paths } = renderPage()

    const dialog = await openAddMemberDialogFromHeader()

    fireEvent.change(
      within(dialog).getByLabelText('Select person'),
      { target: { value: 'chris' } },
    )

    fireEvent.click(
      within(dialog).getByRole('button', {
        name: /@chris/,
      }),
    )

    fireEvent.click(
      within(dialog).getByRole('button', {
        name: /Add member/,
      }),
    )

    // The canonical membership mutation is used with the
    // dialog's default role.
    expect(addProjectMembership).toHaveBeenCalledWith(
      7,
      { userId: 2, role: 'member' },
    )

    // Success closes the dialog and the new member appears in
    // the header member cluster — no navigation, no reload.
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', {
          name: 'Add project member',
        }),
      ).not.toBeInTheDocument(),
    )

    expect(screen.getByTitle('Chris')).toBeInTheDocument()

    expect(
      paths.every(
        (path) => path === '/projects/7/work-items',
      ),
    ).toBe(true)
  })

  it('keeps an in-flight search query and selection when the page re-renders behind the dialog', async () => {
    mockProjectData([ALEX_OWNER])

    renderPage()

    const dialog =
      await openAddMemberDialogFromHeader()

    const search =
      within(dialog).getByLabelText(
        'Select person',
      )

    fireEvent.change(search, {
      target: { value: 'chr' },
    })

    // Filtering is active: only Chris matches.
    expect(
      within(dialog).queryByRole('button', {
        name: /@maria/,
      }),
    ).not.toBeInTheDocument()

    // Selecting replaces the search with the selected row.
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: /@chris/,
      }),
    )

    expect(
      within(dialog).queryByLabelText(
        'Select person',
      ),
    ).not.toBeInTheDocument()
    expect(
      within(dialog).getByText('Chris'),
    ).toBeInTheDocument()

    // A canonical parent re-render trigger (the cross-flow
    // work-item-created refresh event) must not wipe the
    // in-flight query or the selection.
    window.dispatchEvent(
      new CustomEvent(
        'fg-workspace:work-item-created',
        {
          detail: { projectId: 7 },
        },
      ),
    )

    await waitFor(() =>
      expect(
        listProjectWorkItems,
      ).toHaveBeenCalledTimes(2),
    )

    // The dialog still shows the same selection without a
    // search, and the filtered pool is unchanged.
    expect(
      within(dialog).queryByLabelText(
        'Select person',
      ),
    ).not.toBeInTheDocument()
    expect(
      within(dialog).getByText('Chris'),
    ).toBeInTheDocument()
    expect(
      within(dialog).queryByRole('button', {
        name: /@maria/,
      }),
    ).not.toBeInTheDocument()
  })

  it('keeps current Project members excluded from the header dialog candidates', async () => {
    mockProjectData([ALEX_OWNER, CHRIS_MEMBER])

    renderPage()

    const dialog = await openAddMemberDialogFromHeader()

    expect(
      within(dialog).queryByRole('button', {
        name: /@chris/,
      }),
    ).not.toBeInTheDocument()

    expect(
      within(dialog).getByRole('button', {
        name: /@laura/,
      }),
    ).toBeInTheDocument()
  })
})
