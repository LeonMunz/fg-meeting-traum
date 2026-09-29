// @vitest-environment happy-dom

import {
  cleanup,
  render,
  screen,
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

vi.mock('./WorkItemDrawer', () => ({
  WorkItemDrawer: () => null,
}))

const NOW = '2026-09-01T00:00:00Z'

const SHORT_TITLE = 'Short title'
// 100 characters, no spaces: far wider than a standard column.
const UNBROKEN_TITLE =
  'interoperabilitaetsuntersuchungsergebnisberichtedatenvergleichsprotokolldokumentationsergebnisse2026'

function makeProject(
  overrides: Partial<ApiProject> = {},
): ApiProject {
  return {
    id: 7,
    researchGroupId: 1,
    name: 'Board Card Title Project',
    description: 'Persisted project description.',
    status: 'active',
    archivedAt: null,
    currentUserRole: 'owner',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function makeMembership(
  role: 'owner' | 'member' | 'viewer',
): ApiProjectMembership {
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

async function renderWorkItemsBoard(workItems: ApiWorkItem[]) {
  vi.mocked(getProject).mockResolvedValue(makeProject())
  vi.mocked(getProjectWorkItemConfiguration).mockResolvedValue(
    CONFIGURATION,
  )
  vi.mocked(listProjectWorkItems).mockResolvedValue(workItems)
  vi.mocked(listProjectMemberships).mockResolvedValue([
    makeMembership('owner'),
  ])
  vi.mocked(listResearchGroupMembers).mockResolvedValue(GROUP_MEMBERS)

  render(
    <MemoryRouter initialEntries={['/projects/7/work-items']}>
      <Routes>
        <Route
          path="/projects/:projectId/:tab"
          element={<ProjectDetailPage />}
        />
      </Routes>
    </MemoryRouter>,
  )

  // The Todo column header only renders once the Work Item
  // payload has loaded, so this doubles as the data-loaded gate.
  await screen.findByText('To do')
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Project Board card title length contract', () => {
  it('pins the card title to the one-line ellipsis contract without truncating the stored title', async () => {
    await renderWorkItemsBoard([
      makeWorkItem({ id: 1, title: SHORT_TITLE }),
      makeWorkItem({ id: 2, title: UNBROKEN_TITLE }),
    ])

    const shortCard = screen.getByRole('button', {
      name: `Open ${SHORT_TITLE}`,
    })
    // Matching by the COMPLETE title proves the stored title is
    // not truncated anywhere in the card's accessible contract.
    const longCard = screen.getByRole('button', {
      name: `Open ${UNBROKEN_TITLE}`,
    })

    for (const card of [shortCard, longCard]) {
      const title = within(card).getByRole('heading', { level: 3 })
      // `truncate` is the one-line ellipsis contract
      // (overflow: hidden; text-overflow: ellipsis; white-space:
      // nowrap). Without it, a long title either wraps and grows
      // the card height or overflows onto the action menu.
      expect(title.className).toContain('truncate')
    }
  })

  it('keeps the standard Board track sizing and no intrinsic width floor on the grid', async () => {
    await renderWorkItemsBoard([
      makeWorkItem({ id: 2, title: UNBROKEN_TITLE }),
    ])

    const column = document.querySelector(
      '[data-board-column="todo"]',
    ) as HTMLElement
    expect(column).not.toBeNull()

    const grid = column.parentElement as HTMLElement
    // The grid must not use its content's intrinsic (max-content)
    // width as a floor: that rule is what lets a very long
    // unbroken title inflate every column track.
    expect(grid.className).not.toContain('min-w-max')
    // The standard column track sizing stays unchanged.
    expect(grid.style.gridTemplateColumns).toBe(
      'repeat(4, minmax(260px, 1fr))',
    )
  })
})
