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
  archiveProject,
  deleteProject,
  getProject,
  getProjectWorkItemConfiguration,
  listProjectMemberships,
  listResearchGroupMembers,
  updateProject,
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
// the unit test; the Settings contract under test does not involve it.
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
    name: 'Settings Project',
    description: 'Persisted project description.',
    status: 'paused',
    archivedAt: null,
    currentUserRole: 'owner',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
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

const GROUP_MEMBERS: ApiResearchGroupMember[] = [
  {
    id: 1,
    username: 'alex',
    firstName: 'Alex',
    lastName: '',
    researchGroupRole: 'admin',
  },
]

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
    memberships = [ALEX_OWNER],
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

async function renderSettingsPage(project?: ApiProject) {
  render(
    <MemoryRouter
      initialEntries={['/projects/7/settings']}
    >
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

  // The Settings heading only renders once the Project payload
  // has loaded, so this doubles as the data-loaded gate.
  await screen.findByRole('heading', {
    name: 'Project settings',
  })

  if (project) {
    // The name input carries the persisted value once loaded.
    await waitFor(() => {
      expect(
        screen.getByLabelText('Project name'),
      ).toHaveValue(project.name)
    })
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Project Settings page', () => {
  it('renders the Project settings heading and description', async () => {
    mockProjectData()

    await renderSettingsPage()

    expect(
      screen.getByRole('heading', {
        name: 'Project settings',
      }),
    ).toBeVisible()

    expect(
      screen.getByText(
        'Manage the project identity and lifecycle.',
        { exact: false },
      ),
    ).toBeVisible()
  })

  it('does not render Members/Access management UI', async () => {
    mockProjectData()

    await renderSettingsPage()

    expect(
      screen.queryByRole('button', {
        name: /Add member/i,
      }),
    ).toBeNull()

    expect(
      screen.queryAllByRole('combobox'),
    ).toHaveLength(0)

    expect(
      screen.queryByRole('button', {
        name: /^Remove$/,
      }),
    ).toBeNull()

    expect(
      screen.queryByText('Role'),
    ).toBeNull()
  })

  it('loads the persisted name, description and status', async () => {
    const project = makeProject({
      name: 'Settings Project',
      description: 'Persisted project description.',
      status: 'paused',
    })

    mockProjectData({ project })

    await renderSettingsPage(project)

    expect(
      screen.getByLabelText('Project name'),
    ).toHaveValue('Settings Project')

    expect(
      screen.getByLabelText('Description'),
    ).toHaveValue('Persisted project description.')

    expect(
      screen.getByRole('radio', {
        name: 'Paused',
      }),
    ).toBeChecked()

    expect(
      screen.getByRole('radio', {
        name: 'Active',
      }),
    ).not.toBeChecked()

    expect(
      screen.getByRole('radio', {
        name: 'Completed',
      }),
    ).not.toBeChecked()
  })

  it('enables Save changes when the editable settings differ', async () => {
    mockProjectData()

    await renderSettingsPage()

    const saveButton = screen.getByRole('button', {
      name: 'Save changes',
    })

    expect(saveButton).toBeDisabled()

    fireEvent.change(
      screen.getByLabelText('Project name'),
      {
        target: {
          value: 'Renamed settings project',
        },
      },
    )

    expect(saveButton).toBeEnabled()

    fireEvent.change(
      screen.getByLabelText('Description'),
      {
        target: {
          value: 'A changed description.',
        },
      },
    )

    expect(saveButton).toBeEnabled()

    fireEvent.click(
      screen.getByRole('radio', {
        name: 'Completed',
      }),
    )

    expect(saveButton).toBeEnabled()
  })

  it('lets the segmented control select each canonical status', async () => {
    mockProjectData()

    await renderSettingsPage()

    const activeRadio = screen.getByRole('radio', {
      name: 'Active',
    })
    const pausedRadio = screen.getByRole('radio', {
      name: 'Paused',
    })
    const completedRadio = screen.getByRole('radio', {
      name: 'Completed',
    })

    // The persisted status is committed by the load effect; wait
    // for the settled state before interacting.
    await waitFor(() => {
      expect(pausedRadio).toBeChecked()
    })

    fireEvent.click(activeRadio)
    expect(activeRadio).toBeChecked()
    expect(pausedRadio).not.toBeChecked()

    fireEvent.click(completedRadio)
    expect(completedRadio).toBeChecked()
    expect(activeRadio).not.toBeChecked()

    fireEvent.click(pausedRadio)
    expect(pausedRadio).toBeChecked()
  })

  it('restores persisted values and disables Save changes on Cancel', async () => {
    mockProjectData()

    await renderSettingsPage()

    fireEvent.change(
      screen.getByLabelText('Project name'),
      {
        target: {
          value: 'Renamed settings project',
        },
      },
    )

    fireEvent.click(
      screen.getByRole('radio', {
        name: 'Completed',
      }),
    )

    const saveButton = screen.getByRole('button', {
      name: 'Save changes',
    })

    expect(saveButton).toBeEnabled()

    fireEvent.click(screen.getByRole('button', {
      name: 'Cancel',
    }))

    expect(
      screen.getByLabelText('Project name'),
    ).toHaveValue('Settings Project')

    expect(
      screen.getByLabelText('Description'),
    ).toHaveValue('Persisted project description.')

    expect(
      screen.getByRole('radio', {
        name: 'Paused',
      }),
    ).toBeChecked()

    expect(saveButton).toBeDisabled()
  })

  it('saves changed values through the existing updateProject mutation', async () => {
    const project = makeProject()

    vi.mocked(updateProject).mockResolvedValue(
      makeProject({
        name: 'Renamed settings project',
        description: 'A changed description.',
        status: 'completed',
      }),
    )

    mockProjectData({ project })

    await renderSettingsPage(project)

    fireEvent.change(
      screen.getByLabelText('Project name'),
      {
        target: {
          value: 'Renamed settings project',
        },
      },
    )

    fireEvent.change(
      screen.getByLabelText('Description'),
      {
        target: {
          value: 'A changed description.',
        },
      },
    )

    fireEvent.click(
      screen.getByRole('radio', {
        name: 'Completed',
      }),
    )

    fireEvent.click(screen.getByRole('button', {
      name: 'Save changes',
    }))

    await waitFor(() => {
      expect(updateProject).toHaveBeenCalledWith(7, {
        name: 'Renamed settings project',
        description: 'A changed description.',
        status: 'completed',
      })
    })
  })

  it('returns to a clean, unchanged state after a successful save', async () => {
    const project = makeProject()

    const updated = makeProject({
      name: 'Renamed settings project',
      status: 'paused',
    })

    vi.mocked(updateProject).mockResolvedValue(
      updated,
    )

    mockProjectData({ project })

    await renderSettingsPage(project)

    fireEvent.change(
      screen.getByLabelText('Project name'),
      {
        target: {
          value: 'Renamed settings project',
        },
      },
    )

    fireEvent.click(screen.getByRole('button', {
      name: 'Save changes',
    }))

    await screen.findByText(
      'All changes are saved.',
      { exact: true },
    )

    expect(
      screen.getByLabelText('Project name'),
    ).toHaveValue('Renamed settings project')

    expect(
      screen.getByRole('radio', {
        name: 'Paused',
      }),
    ).toBeChecked()

    expect(
      screen.getByRole('button', {
        name: 'Save changes',
      }),
    ).toBeDisabled()
  })

  it('presents read-only settings to a non-owner Project member', async () => {
    mockProjectData({
      memberships: [ALEX_MEMBER],
    })

    await renderSettingsPage()

    // The role is resolved from the membership list, which settles
    // after the Project payload; wait for the read-only state.
    expect(
      await screen.findByText('Read-only settings'),
    ).toBeVisible()

    expect(
      screen.getByLabelText('Project name'),
    ).toBeDisabled()

    expect(
      screen.getByLabelText('Description'),
    ).toBeDisabled()

    for (const name of ['Active', 'Paused', 'Completed']) {
      expect(
        screen.getByRole('radio', { name }),
      ).toBeDisabled()
    }

    expect(
      screen.queryByRole('button', {
        name: 'Save changes',
      }),
    ).toBeNull()

    expect(
      screen.queryByRole('button', {
        name: 'Cancel',
      }),
    ).toBeNull()

    // Lifecycle actions stay owner-only as well.
    expect(
      screen.queryByRole('button', {
        name: 'Archive',
      }),
    ).toBeNull()

    expect(
      screen.queryByRole('button', {
        name: 'Delete',
      }),
    ).toBeNull()
  })

  it('archives the project through the existing confirmation flow', async () => {
    const project = makeProject()

    vi.mocked(archiveProject).mockResolvedValue(
      makeProject({
        archivedAt: NOW,
      }),
    )

    mockProjectData({ project })

    await renderSettingsPage(project)

    fireEvent.click(screen.getByRole('button', {
      name: 'Archive',
    }))

    const dialog = await screen.findByRole(
      'alertdialog',
      { name: 'Archive project?' },
    )

    fireEvent.click(within(dialog).getByRole('button', {
      name: 'Archive project',
    }))

    await waitFor(() => {
      expect(archiveProject).toHaveBeenCalledWith(7)
    })

    expect(
      screen.getByText('Archived project'),
    ).toBeVisible()
  })

  it('keeps deletion unavailable while the Project contains work', async () => {
    mockProjectData({
      workItems: [makeWorkItem()],
    })

    await renderSettingsPage()

    // The deletion rule settles once the work-item list has
    // loaded; the reason text only renders in that settled state.
    expect(
      await screen.findByText(
        'This project contains 1 work item, so permanent deletion is unavailable.',
        { exact: false },
      ),
    ).toBeVisible()

    expect(
      screen.getByRole('button', {
        name: 'Delete',
      }),
    ).toBeDisabled()
  })

  it('deletes an empty Project through the existing confirmation flow', async () => {
    const project = makeProject()

    vi.mocked(deleteProject).mockResolvedValue(
      { detail: 'Project deleted.' },
    )

    mockProjectData({ project })

    await renderSettingsPage(project)

    const deleteButton = await screen.findByRole(
      'button',
      {
        name: 'Delete',
      },
    )

    // Deletion is only enabled once the work-item list has settled
    // as empty; wait for that state.
    await waitFor(() => {
      expect(deleteButton).toBeEnabled()
    })

    fireEvent.click(deleteButton)

    const dialog = await screen.findByRole(
      'alertdialog',
      { name: 'Delete project permanently?' },
    )

    fireEvent.click(within(dialog).getByRole('button', {
      name: 'Delete project',
    }))

    await waitFor(() => {
      expect(deleteProject).toHaveBeenCalledWith(7)
    })
  })
})
