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

// The real drawer pulls the RichMarkdownEditor/Tiptap graph into
// the unit test, while the contract under test here is the
// PAGE-level outside-interaction close boundary (ProjectDetailPage's
// contextual-selection effect). The stub keeps exactly that surface
// of the real drawer: the inspector boundary marker, ordinary
// in-drawer text targets (title / description), and the explicit
// close button. The real drawer is covered by its own unit suites
// and e2e/project-work-item-inspector.spec.ts.
vi.mock('./WorkItemDrawer', () => ({
  WorkItemDrawer: (props: Record<string, any>) => (
    <div
      data-work-item-inspector-boundary="true"
      data-testid="work-item-inspector-stub"
    >
      <span
        data-testid="inspector-stub-title"
      >
        {props.item?.title ?? ''}
      </span>
      <p
        data-testid="inspector-stub-description"
      >
        {props.item?.description ?? ''}
      </p>
      <button
        type="button"
        aria-label="Close work item"
        onClick={() => props.onClose()}
      >
        close
      </button>
    </div>
  ),
}))

const NOW = '2026-09-01T00:00:00Z'

const PROJECT: ApiProject = {
  id: 7,
  researchGroupId: 1,
  name: 'Outside Click Project',
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
  overrides: Partial<ApiWorkItem>,
): ApiWorkItem {
  return {
    id: 5,
    projectId: 7,
    title: 'Outside click task A',
    description: 'Select me inside the drawer.',
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
  } as ApiWorkItem
}

const TASK_A = makeWorkItem({ id: 5 })
const TASK_B = makeWorkItem({
  id: 6,
  title: 'Outside click task B',
  statusDefinitionId: 11,
  boardPosition: 1,
})

// The Work Item panel section (the "Work Items" card) — an inert,
// unmarked page target: not the inspector boundary, not a Work
// Item target, not the keep-open view switch. A genuine outside
// click landing here must dismiss.
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

function renderLoadedPage() {
  vi.mocked(getProject).mockResolvedValue(PROJECT)
  vi.mocked(listProjectMemberships).mockResolvedValue([])
  vi.mocked(listResearchGroupMembers).mockResolvedValue([])
  vi.mocked(
    getProjectWorkItemConfiguration,
  ).mockResolvedValue(CONFIGURATION)
  vi.mocked(listProjectWorkItems).mockResolvedValue([
    TASK_A,
    TASK_B,
  ])

  return renderPage()
}

// Open the edit inspector for a Board card and wait until the
// stub drawer (the lazy chunk) has actually mounted, so the
// outside-click effect is registered against the real boundary.
async function openInspector(
  title: string,
) {
  await screen.findByRole('button', {
    name: `Open ${title}`,
  })

  await act(async () => {
    fireEvent.click(
      screen.getByRole('button', {
        name: `Open ${title}`,
      }),
    )
  })

  await screen.findByTestId(
    'work-item-inspector-stub',
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// SCOPE: happy-dom has no layout engine and no real text-selection
// engine, so a "drag the selection across the drawer's edge" is
// simulated at the event level: a PRIMARY pointerdown inside the
// inspector boundary, followed by a click whose target lands
// OUTSIDE (exactly where browsers target the trailing click of a
// cross-boundary drag — the down/up common ancestor). The contract
// under test is the page-level dismissal state machine: inside-
// started gestures never dismiss, fresh outside press+clicks
// still do, and every protected target keeps its protection.
describe(
  'Work Item inspector — outside-interaction close (gesture origin)',
  () => {
    it('stays open when the pointer gesture starts inside the Description and the click lands outside', async () => {
      renderLoadedPage()
      await openInspector(TASK_A.title)

      const description = screen.getByTestId(
        'inspector-stub-description',
      )

      // Press inside the Description, drag beyond the drawer's
      // edge, release outside: the trailing click's target is
      // outside the inspector.
      await act(async () => {
        fireEvent.pointerDown(description, {
          button: 0,
        })
        fireEvent.click(workItemsSection())
      })

      // The gesture ORIGINATED inside — the inspector stays open.
      expect(
        screen.getByTestId('work-item-inspector-stub'),
      ).toBeInTheDocument()
    })

    it('stays open when the pointer gesture starts on in-drawer title text and the click lands outside (no Description special-case)', async () => {
      renderLoadedPage()
      await openInspector(TASK_A.title)

      const title = screen.getByTestId(
        'inspector-stub-title',
      )

      await act(async () => {
        fireEvent.pointerDown(title, { button: 0 })
        fireEvent.click(workItemsSection())
      })

      expect(
        screen.getByTestId('work-item-inspector-stub'),
      ).toBeInTheDocument()
    })

    it('closes on a fresh outside press+click', async () => {
      renderLoadedPage()
      await openInspector(TASK_A.title)

      const outside = workItemsSection()

      await act(async () => {
        fireEvent.pointerDown(outside, { button: 0 })
        fireEvent.click(outside)
      })

      await waitFor(() =>
        expect(
          screen.queryByTestId('work-item-inspector-stub'),
        ).not.toBeInTheDocument(),
      )
    })

    it('does not leave stale suppression behind: inside-started drag-out does not close, then the NEXT fresh outside click DOES close', async () => {
      renderLoadedPage()
      await openInspector(TASK_A.title)

      const outside = workItemsSection()
      const description = screen.getByTestId(
        'inspector-stub-description',
      )

      // Gesture 1: starts inside, click lands outside — no close.
      await act(async () => {
        fireEvent.pointerDown(description, {
          button: 0,
        })
        fireEvent.click(outside)
      })

      expect(
        screen.getByTestId('work-item-inspector-stub'),
      ).toBeInTheDocument()

      // Gesture 2: a fresh outside press+click — must close.
      await act(async () => {
        fireEvent.pointerDown(outside, { button: 0 })
        fireEvent.click(outside)
      })

      await waitFor(() =>
        expect(
          screen.queryByTestId('work-item-inspector-stub'),
        ).not.toBeInTheDocument(),
      )
    })

    it('keeps a click that starts and lands fully inside the drawer open', async () => {
      renderLoadedPage()
      await openInspector(TASK_A.title)

      const description = screen.getByTestId(
        'inspector-stub-description',
      )

      await act(async () => {
        fireEvent.pointerDown(description, {
          button: 0,
        })
        fireEvent.click(description)
      })

      expect(
        screen.getByTestId('work-item-inspector-stub'),
      ).toBeInTheDocument()
    })

    it('ignores a non-primary (right-button) press inside, so a later fresh outside click still closes', async () => {
      renderLoadedPage()
      await openInspector(TASK_A.title)

      const outside = workItemsSection()
      const description = screen.getByTestId(
        'inspector-stub-description',
      )

      // Right-button press inside: contextmenu, no trailing
      // click — must not arm the origin record.
      await act(async () => {
        fireEvent.pointerDown(description, {
          button: 2,
        })
      })

      // Fresh outside press+click — closes.
      await act(async () => {
        fireEvent.pointerDown(outside, { button: 0 })
        fireEvent.click(outside)
      })

      await waitFor(() =>
        expect(
          screen.queryByTestId('work-item-inspector-stub'),
        ).not.toBeInTheDocument(),
      )
    })

    it('keeps canonical Work Item targets protected: clicking another Board card switches in place instead of closing', async () => {
      renderLoadedPage()
      await openInspector(TASK_A.title)

      const cardB = screen.getByRole('button', {
        name: `Open ${TASK_B.title}`,
      })

      await act(async () => {
        fireEvent.pointerDown(cardB, { button: 0 })
        fireEvent.click(cardB)
      })

      // Still open — and now showing B.
      expect(
        screen.getByTestId('work-item-inspector-stub'),
      ).toBeInTheDocument()
      await waitFor(() =>
        expect(
          screen.getByTestId('inspector-stub-title'),
        ).toHaveTextContent(TASK_B.title),
      )
    })

    it('keeps the Board/List view switch protected: switching views does not close the inspector', async () => {
      renderLoadedPage()
      await openInspector(TASK_A.title)

      const listToggle = screen.getByRole('button', {
        name: 'List',
      })

      await act(async () => {
        fireEvent.pointerDown(listToggle, {
          button: 0,
        })
        fireEvent.click(listToggle)
      })

      // The view switched to List...
      expect(
        screen.getByRole('button', { name: 'List' }),
      ).toBeInTheDocument()
      // ...and the inspector stayed open on the same item.
      expect(
        screen.getByTestId('work-item-inspector-stub'),
      ).toBeInTheDocument()
      expect(
        screen.getByTestId('inspector-stub-title'),
      ).toHaveTextContent(TASK_A.title)
    })

    it('still closes through the explicit close button', async () => {
      renderLoadedPage()
      await openInspector(TASK_A.title)

      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', {
            name: 'Close work item',
          }),
        )
      })

      await waitFor(() =>
        expect(
          screen.queryByTestId('work-item-inspector-stub'),
        ).not.toBeInTheDocument(),
      )
    })
  },
)
