// @vitest-environment happy-dom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  MemoryRouter,
  Route,
  Routes,
} from 'react-router'

import {
  getProject,
  getProjectWorkItemConfiguration,
  listProjectMemberships,
  listResearchGroupMembers,
} from '../../api/projects'
import { listProjectWorkItems } from '../../api/work-items'
import type {
  ApiProject,
  ApiProjectWorkItemConfiguration,
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
// the unit test, while the rail contract under test is a page-level
// layout concern. The lazy chunk only needs to resolve to some drawer;
// the real WorkItemDrawer is covered by its own unit tests and E2E.
vi.mock('./WorkItemDrawer', () => ({
  WorkItemDrawer: () => null,
}))

const NOW = '2026-09-01T00:00:00Z'

const PROJECT: ApiProject = {
  id: 7,
  researchGroupId: 1,
  name: 'Inspector Rail Project',
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
    {
      id: 11,
      name: 'In progress',
      category: 'in_progress',
      order: 1,
      active: true,
      isDefault: false,
    },
    {
      id: 12,
      name: 'Review',
      category: 'review',
      order: 2,
      active: true,
      isDefault: false,
    },
    {
      id: 13,
      name: 'Done',
      category: 'done',
      order: 3,
      active: true,
      isDefault: false,
    },
  ],
  labels: [],
}

const WORK_ITEM: ApiWorkItem = {
  id: 5,
  projectId: 7,
  title: 'Rail task',
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
}

// The Work Item panel section (the "Work Items" card).
function workItemsSection(): HTMLElement {
  const heading = screen.getByRole('heading', {
    name: 'Work Items',
  })

  const section = heading.closest('section')

  if (!section) {
    throw new Error('Work Items section not found.')
  }

  return section
}

function renderPage() {
  return render(
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
          element={<ProjectDetailPage />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// SCOPE: happy-dom has no layout engine, so this spec proves the
// page-level state contract, not pixel geometry: while the non-modal
// edit inspector is open, the Work Items panel must reserve the
// inspector's fixed 520px right-edge rail (xl:mr-[520px]) so the
// opaque drawer never covers Board cards, List rows, or toolbar
// targets; closed and create-modal states must not reserve it.
// Real-browser hit-testing of the reserved rail is covered by
// e2e/project-work-item-inspector.spec.ts.
describe('Work Item inspector rail reservation', () => {
  it('reserves the 520px inspector rail only while the edit inspector is open', async () => {
    vi.mocked(getProject).mockResolvedValue(PROJECT)
    vi.mocked(listProjectMemberships).mockResolvedValue([])
    vi.mocked(listResearchGroupMembers).mockResolvedValue([])
    vi.mocked(listProjectWorkItems).mockResolvedValue([
      WORK_ITEM,
    ])
    vi.mocked(
      getProjectWorkItemConfiguration,
    ).mockResolvedValue(CONFIGURATION)

    renderPage()

    await waitFor(() =>
      expect(workItemsSection()).toBeVisible(),
    )

    // Closed: no rail reserved, panel is full width.
    expect(workItemsSection()).not.toHaveClass(
      'xl:mr-[520px]',
    )

    // Opening a Work Item (edit inspector) reserves the rail so the
    // fixed 520px drawer no longer overlaps workspace targets.
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Open Rail task',
      }),
    )

    await waitFor(() =>
      expect(workItemsSection()).toHaveClass(
        'xl:mr-[520px]',
      ),
    )

    // Create mode is a modal with its own backdrop — it must not
    // reserve the rail (the page behind is blocked anyway).
    fireEvent.click(
      screen.getByRole('button', {
        name: /New work item/,
      }),
    )

    await waitFor(() =>
      expect(workItemsSection()).not.toHaveClass(
        'xl:mr-[520px]',
      ),
    )
  })
})
