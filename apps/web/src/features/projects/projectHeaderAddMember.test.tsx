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
  removeProjectMembership,
  updateProjectMembership,
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

const CHRIS_OWNER = membership(2, 2, 'chris', 'Chris', 'owner')

const CHRIS_VIEWER = membership(2, 2, 'chris', 'Chris', 'viewer')

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

function renderPage(
  initialPath = '/projects/7/work-items',
) {
  const paths: string[] = []
  const onPath = (path: string) => {
    paths.push(path)
  }

  render(
    <MemoryRouter
      initialEntries={[initialPath]}
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

  it('uses the same Add-member dialog as Members -> Add member', async () => {
    mockProjectData([ALEX_OWNER])

    renderPage()

    // The header opens the dialog ...
    const fromHeader = await openAddMemberDialogFromHeader()

    expect(
      within(fromHeader).getByLabelText('Select person'),
    ).toBeInTheDocument()

    // ... and Members -> Add member opens the same shared
    // dialog.
    fireEvent.click(
      within(fromHeader).getByRole('button', {
        name: 'Cancel',
      }),
    )

    fireEvent.click(
      screen.getByRole('link', {
        name: 'Members',
      }),
    )

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Add member',
      }),
    )

    const fromMembers = screen.getByRole('dialog', {
      name: 'Add project member',
    })

    expect(fromMembers).toBeVisible()
    expect(
      within(fromMembers).getByLabelText('Select person'),
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

describe('Project Members tab', () => {
  it('renders the Project tabs in order: Work Items, Overview, Members, Settings', async () => {
    mockProjectData([ALEX_OWNER])

    renderPage()

    await screen.findByRole('button', {
      name: 'Add project member',
    })

    const nav = screen.getByRole('navigation')

    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([
      'Work Items',
      'Overview',
      'Members',
      'Settings',
    ])
  })

  it('opens the Members tab and shows the heading, count and current members', async () => {
    mockProjectData([ALEX_OWNER, CHRIS_MEMBER])

    renderPage('/projects/7/members')

    expect(
      await screen.findByRole('heading', {
        name: 'Members',
        level: 2,
      }),
    ).toBeInTheDocument()

    // Count badge reflects the current membership count.
    expect(screen.getByText('2', { exact: true })).toBeInTheDocument()

    // Both members render with name and username.
    expect(screen.getByText('Alex')).toBeInTheDocument()
    expect(screen.getByText('@alex', { exact: true })).toBeInTheDocument()
    expect(screen.getByText('Chris')).toBeInTheDocument()
    expect(screen.getByText('@chris', { exact: true })).toBeInTheDocument()
  })

  it('renders the current role of each member', async () => {
    mockProjectData([ALEX_OWNER, CHRIS_MEMBER])

    renderPage('/projects/7/members')

    expect(
      await screen.findByRole('combobox', {
        name: 'Role for Alex',
      }),
    ).toHaveValue('owner')

    expect(
      screen.getByRole('combobox', {
        name: 'Role for Chris',
      }),
    ).toHaveValue('member')
  })

  it('no longer contains Access or member management in Settings', async () => {
    mockProjectData([ALEX_OWNER, CHRIS_MEMBER])

    renderPage()

    await screen.findByRole('button', {
      name: 'Add project member',
    })

    fireEvent.click(
      screen.getByRole('link', { name: 'Settings' }),
    )

    // The Settings form still renders ...
    expect(screen.getByLabelText('Project name')).toBeInTheDocument()

    // ... but the extracted membership UI is gone.
    expect(
      screen.queryByText('Access', { exact: true }),
    ).not.toBeInTheDocument()

    expect(
      screen.queryByRole('button', {
        name: /Add member/,
      }),
    ).not.toBeInTheDocument()

    expect(
      screen.queryByRole('combobox'),
    ).not.toBeInTheDocument()

    expect(
      screen.queryByRole('button', {
        name: 'Remove',
      }),
    ).not.toBeInTheDocument()

    expect(
      screen.queryByText('@chris', { exact: true }),
    ).not.toBeInTheDocument()
  })

  it('adds a member from the Members tab through the shared dialog and updates the list immediately', async () => {
    mockProjectData([ALEX_OWNER])
    vi.mocked(addProjectMembership).mockResolvedValue(
      CHRIS_MEMBER,
    )

    renderPage('/projects/7/members')

    await screen.findByText('@alex', { exact: true })

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Add member',
      }),
    )

    const dialog = screen.getByRole('dialog', {
      name: 'Add project member',
    })

    expect(dialog).toBeVisible()

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

    expect(addProjectMembership).toHaveBeenCalledWith(
      7,
      { userId: 2, role: 'member' },
    )

    // Success closes the dialog and the new member appears
    // in the Members list and header cluster without a
    // reload.
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', {
          name: 'Add project member',
        }),
      ).not.toBeInTheDocument(),
    )

    expect(
      screen.getByText('@chris', { exact: true }),
    ).toBeInTheDocument()
    expect(screen.getByText('Chris')).toBeInTheDocument()
    expect(screen.getByTitle('Chris')).toBeInTheDocument()

    // The count badge reflects the new member.
    expect(screen.getByText('2', { exact: true })).toBeInTheDocument()
  })

  it('changes a member role from the Members tab as before', async () => {
    mockProjectData([ALEX_OWNER, CHRIS_MEMBER])
    vi.mocked(updateProjectMembership).mockResolvedValue(
      CHRIS_VIEWER,
    )

    renderPage('/projects/7/members')

    const select = await screen.findByRole('combobox', {
      name: 'Role for Chris',
    })

    expect(select).toHaveValue('member')

    fireEvent.change(select, {
      target: { value: 'viewer' },
    })

    expect(updateProjectMembership).toHaveBeenCalledWith(
      7,
      2,
      { role: 'viewer' },
    )

    await waitFor(() =>
      expect(
        screen.getByRole('combobox', {
          name: 'Role for Chris',
        }),
      ).toHaveValue('viewer'),
    )
  })

  it('removes a member from the Members tab as before', async () => {
    mockProjectData([ALEX_OWNER, CHRIS_MEMBER])
    vi.mocked(removeProjectMembership).mockResolvedValue({
      detail: 'Project membership removed.',
    })

    renderPage('/projects/7/members')

    await screen.findByText('@chris', { exact: true })

    // Two rows render: the last owner's action stays disabled,
    // Chris' action is the enabled one.
    const removeButtons = screen.getAllByRole('button', {
      name: 'Remove',
    })

    expect(removeButtons).toHaveLength(2)
    expect(removeButtons[0]).toBeDisabled()

    fireEvent.click(removeButtons[1])

    const confirmDialog = screen.getByRole('alertdialog')

    fireEvent.click(
      within(confirmDialog).getByRole('button', {
        name: 'Remove member',
      }),
    )

    expect(removeProjectMembership).toHaveBeenCalledWith(
      7,
      2,
    )

    await waitFor(() =>
      expect(
        screen.queryByText('@chris', { exact: true }),
      ).not.toBeInTheDocument(),
    )
  })

  it('keeps the last-owner protection in the Members tab', async () => {
    mockProjectData([ALEX_OWNER])

    renderPage('/projects/7/members')

    const select = await screen.findByRole('combobox', {
      name: 'Role for Alex',
    })

    expect(
      screen.getByText('Last owner', { exact: true }),
    ).toBeInTheDocument()

    expect(
      within(select).getByRole('option', {
        name: 'Member',
      }),
    ).toBeDisabled()

    expect(
      within(select).getByRole('option', {
        name: 'Viewer',
      }),
    ).toBeDisabled()

    expect(
      screen.getByRole('button', {
        name: 'Remove',
      }),
    ).toBeDisabled()
  })

  it('gives a non-owner Project member no membership controls', async () => {
    mockProjectData([ALEX_MEMBER, CHRIS_OWNER])

    renderPage('/projects/7/members')

    // Wait until the member list has actually loaded so the
    // absence below is meaningful, not a pre-load snapshot.
    await screen.findByText('Owner', { exact: true })

    expect(
      screen.queryByRole('button', {
        name: /Add member/,
      }),
    ).not.toBeInTheDocument()

    expect(
      screen.queryByRole('combobox'),
    ).not.toBeInTheDocument()

    expect(
      screen.queryByRole('button', {
        name: 'Remove',
      }),
    ).not.toBeInTheDocument()

    // Roles remain visible as plain labels: the header pill,
    // the Member column header and Alex' row label.
    expect(
      screen.getAllByText('Member', { exact: true }),
    ).toHaveLength(3)
  })
})
