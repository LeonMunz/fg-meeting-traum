// @vitest-environment happy-dom

// Project-page integration boundary for the unified Work Item
// creation: the Project page no longer owns a create Drawer. Its
// "New work item" entry emits ONE typed launch request
// (quickCreateLaunch.ts) carrying the page's actual Research Group
// and Project IDs, and the centrally managed QuickCreate controller
// (TopBar) opens the canonical create-mode WorkItemDrawer with that
// context. The page keeps owning:
//   - the entry (hidden for read-only Projects),
//   - the created-Work Item invalidation (refresh ONLY when the
//     created item actually belongs to this Project),
//   - the non-modal edit-mode inspector (unchanged).

import {
  act,
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
import {
  listProjectWorkItems,
} from '../../api/work-items'
import type {
  ApiProject,
  ApiProjectWorkItemConfiguration,
  ApiWorkItem,
} from '../../api/types'

import {
  OPEN_QUICK_CREATE_WORK_ITEM_EVENT,
  type QuickCreateWorkItemLaunch,
} from '../../components/layout/quickCreateLaunch'
import {
  WORK_ITEM_CREATED_EVENT,
  type WorkItemCreatedDetail,
} from '../../components/layout/workItemInvalidation'

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

// The page-level drawer is the edit-mode inspector only; the create
// Drawer is owned by the (unrendered here) QuickCreate controller.
vi.mock('./WorkItemDrawer', () => ({
  WorkItemDrawer: () => null,
}))

const NOW = '2026-09-01T00:00:00Z'

const PROJECT: ApiProject = {
  id: 7,
  researchGroupId: 1,
  name: 'Create Launch Project',
  description: '',
  status: 'active',
  archivedAt: null,
  currentUserRole: 'owner',
  createdAt: NOW,
  updatedAt: NOW,
}

const ARCHIVED_PROJECT: ApiProject = {
  ...PROJECT,
  archivedAt: NOW,
}

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
  ],
  labels: [],
}

const WORK_ITEM: ApiWorkItem = {
  id: 5,
  projectId: 7,
  title: 'Existing task',
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

function renderPage(
  project: ApiProject = PROJECT,
) {
  vi.mocked(getProject).mockResolvedValue(project)
  vi.mocked(
    listProjectMemberships,
  ).mockResolvedValue([])
  vi.mocked(
    listResearchGroupMembers,
  ).mockResolvedValue([])
  vi.mocked(
    listProjectWorkItems,
  ).mockResolvedValue([])
  vi.mocked(
    getProjectWorkItemConfiguration,
  ).mockResolvedValue(CONFIGURATION)

  return render(
    <MemoryRouter
      initialEntries={[
        `/projects/${project.id}/work-items`,
      ]}
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

function installedLaunchListener() {
  const launches: QuickCreateWorkItemLaunch[] = []
  const listener = (event: Event) => {
    launches.push(
      (event as CustomEvent<QuickCreateWorkItemLaunch>).detail,
    )
  }
  window.addEventListener(
    OPEN_QUICK_CREATE_WORK_ITEM_EVENT,
    listener,
  )
  return {
    launches,
    dispose() {
      window.removeEventListener(
        OPEN_QUICK_CREATE_WORK_ITEM_EVENT,
        listener,
      )
    },
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Project page — unified Work Item create launch', () => {
  it('dispatches the typed launch with the page Research Group and Project, without opening a local create Drawer', async () => {
    const launches = installedLaunchListener()

    renderPage()
    const createButton = await screen.findByRole('button', {
      name: /New work item/,
    })

    fireEvent.click(createButton)

    // Exactly ONE typed launch request, carrying the page's ACTUAL
    // Research Group and Project — the context the central
    // controller validates before preselecting.
    expect(launches.launches).toEqual([
      { researchGroupId: 1, projectId: 7 },
    ])

    // No page-local create Drawer: the page-level drawer state is
    // the edit-mode inspector only, and the mocked drawer never
    // renders a create dialog.
    expect(
      screen.queryByRole('dialog'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', {
        name: 'Create work item',
      }),
    ).not.toBeInTheDocument()

    // The entry stays available (the central Drawer is the only
    // create surface).
    expect(createButton).toBeVisible()

    launches.dispose()
  })

  it('does not offer the launch entry for a read-only (archived) Project', async () => {
    const launches = installedLaunchListener()

    renderPage(ARCHIVED_PROJECT)

    // Archived Projects are read-only: no create entry at all.
    await screen.findByRole('heading', {
      name: 'Create Launch Project',
    })
    expect(
      screen.queryByRole('button', {
        name: /New work item/,
      }),
    ).not.toBeInTheDocument()
    expect(launches.launches).toEqual([])

    launches.dispose()
  })

  it('refreshes Work Items only when a created Work Item actually belongs to this Project', async () => {
    renderPage()
    await screen.findByRole('button', {
      name: /New work item/,
    })

    // Synchronize on the initial Work Items load itself: the Work
    // Items surface (with this entry) paints in the first commit of
    // the loaded Project, while the load is issued by a passive
    // effect that React flushes in a SEPARATE task — button
    // visibility alone does not prove the load has been issued.
    // Waiting for the observable load makes the baseline call count
    // deterministic (and guarantees the creation-event listener is
    // registered before the dispatches below).
    await waitFor(() =>
      expect(
        vi.mocked(listProjectWorkItems).mock.calls.length,
      ).toBeGreaterThanOrEqual(1),
    )

    const initialListCalls =
      vi.mocked(listProjectWorkItems).mock.calls.length
    expect(initialListCalls).toBeGreaterThanOrEqual(1)

    // A created Work Item from ANOTHER Project (e.g. the user
    // switched the target in the central Drawer) must NOT
    // refresh this Project's view.
    window.dispatchEvent(
      new CustomEvent<WorkItemCreatedDetail>(
        WORK_ITEM_CREATED_EVENT,
        {
          detail: {
            ...WORK_ITEM,
            id: 999,
            projectId: 8,
            title: 'Foreign item',
          },
        },
      ),
    )
    // Let React settle: a (wrong) refresh for a foreign Project
    // would surface as an additional list call by now.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(
      vi.mocked(listProjectWorkItems).mock.calls.length,
    ).toBe(initialListCalls)

    // A created Work Item belonging to THIS Project refreshes the
    // canonical list (no optimistic append, no navigation).
    window.dispatchEvent(
      new CustomEvent<WorkItemCreatedDetail>(
        WORK_ITEM_CREATED_EVENT,
        {
          detail: WORK_ITEM,
        },
      ),
    )
    await waitFor(() =>
      expect(
        vi.mocked(listProjectWorkItems).mock.calls.length,
      ).toBe(initialListCalls + 1),
    )
  })
})
