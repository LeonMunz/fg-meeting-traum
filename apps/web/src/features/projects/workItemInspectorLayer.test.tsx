// @vitest-environment happy-dom

// LAYER-OWNERSHIP REGRESSION — Work Item overlay vs. shell chrome.
//
// Root cause this spec pins:
// `.fg-route-content` (the AppShell <main>, the ONE named View Transition
// surface) carries `view-transition-name`, and per CSS View Transitions
// §2.1.1 (Rendering Consolidation) an element whose computed
// `view-transition-name` is not none — at ANY time, not only while a
// transition runs — forms a stacking context. While the edit inspector
// was rendered inside that <main> as route content of the Project page,
// its z-40 competed only WITHIN the route-content context (effective
// z=0 at the root level), so the sticky TopBar (z-20, a sibling of the
// <main> in the root stacking context) painted over the inspector's
// top-right corner.
//
// The fix is layer ownership, not a z-index escalation: the inspector
// and the create modal portal to document.body (the application overlay
// root), where their z values compete in the root stacking context.
//
// This spec reproduces the production containment relationship by
// mounting the page inside a `<main class="fg-route-content">` wrapper
// (the AppShell chrome itself is irrelevant to the contract — the
// stacking boundary is the <main>) and asserts the placement contract
// against the REAL (deliberately unmocked) WorkItemDrawer:
//   - the edit inspector root is a direct child of document.body and
//     NOT a descendant of the route content surface,
//   - the Project route remains mounted behind the inspector,
//   - the board keeps reserving the 520px rail while the inspector is
//     open (and releases it when the inspector closes),
//   - the page-level outside-click close still works across the portal,
//   - the create modal's scrim lives on the same overlay root and its
//     outside-click dismissal still works,
//   - the delete confirmation overlay (the shared page-level dialog
//     and the drawer's standalone fallback) lives on the same overlay
//     root, outside the route content surface AND outside the
//     inspector's boundary / stacking owner, and Cancel still closes
//     only the dialog (inspector / drawer stay open, no delete call).
//
// SCOPE: happy-dom has no layout engine, so this spec proves the
// DOM-level layer ownership/placement contract, not paint order or
// pixel geometry (the browser-visible result is covered by
// e2e/project-work-item-inspector.spec.ts and the manual visual check).

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
  deleteWorkItem,
  listProjectWorkItems,
} from '../../api/work-items'
import type {
  ApiProject,
  ApiProjectWorkItemConfiguration,
  ApiWorkItem,
} from '../../api/types'

import { ProjectDetailPage } from './ProjectDetailPage'
import { WorkItemDrawer } from './WorkItemDrawer'

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

// Full export surface: the REAL WorkItemDrawer (not mocked in this
// spec) additionally imports the comment/history clients; empty
// arrays keep the inspector's Activity feed in its quiet empty state
// without any network.
vi.mock('../../api/work-items', () => ({
  createWorkItem: vi.fn(),
  deleteWorkItem: vi.fn(),
  listProjectWorkItems: vi.fn(),
  reorderWorkItem: vi.fn(),
  updateWorkItem: vi.fn(),
  createWorkItemComment: vi.fn(),
  deleteWorkItemComment: vi.fn(),
  listWorkItemComments: vi.fn(async () => []),
  listWorkItemHistory: vi.fn(async () => []),
  updateWorkItemComment: vi.fn(),
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

// Deliberately NOT mocking './WorkItemDrawer': this spec's contract is
// about where the REAL drawer places its overlay root.

const NOW = '2026-09-01T00:00:00Z'

const PROJECT: ApiProject = {
  id: 7,
  researchGroupId: 1,
  name: 'Layer Contract Project',
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
  title: 'Layer task',
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

// The AppShell <main> — the named View Transition surface and, per the
// View Transitions spec, the stacking context that traps anything
// rendered inside it.
function routeContent(): HTMLElement {
  const main = document.querySelector<HTMLElement>(
    'main.fg-route-content',
  )

  if (!main) {
    throw new Error('route content surface not found.')
  }

  return main
}

// The Work Items panel section (the "Work Items" card).
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
  const page = (
    <ProjectDetailPage />
  )

  return render(
    <MemoryRouter
      initialEntries={['/projects/7/work-items']}
    >
      <Routes>
        <Route
          path="/projects/:projectId"
          element={
            <main className="fg-route-content">
              {page}
            </main>
          }
        />

        <Route
          path="/projects/:projectId/:tab"
          element={
            <main className="fg-route-content">
              {page}
            </main>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

async function openEditInspector() {
  // The board card only exists once the fixture Work Item has reached
  // the rendered list.
  await screen.findByRole('button', {
    name: 'Open Layer task',
  })

  fireEvent.click(
    screen.getByRole('button', {
      name: 'Open Layer task',
    }),
  )

  // The real drawer is a lazy chunk; wait for the REAL inspector
  // region (the lazy fallback shell carries the boundary marker but
  // no role, so this resolves to the portaled inspector only).
  const region = await screen.findByRole('region', {
    name: 'Work item',
  })

  const root = region.parentElement!

  // The region is the inner panel; the overlay root (the
  // `data-work-item-inspector-boundary` element) is its parent.
  if (
    root.getAttribute(
      'data-work-item-inspector-boundary',
    ) !== 'true'
  ) {
    throw new Error(
      'expected the region parent to be the inspector overlay root.',
    )
  }

  return root
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Work Item overlay layer ownership', () => {
  it('renders the edit inspector on the document.body overlay root, not inside the route content', async () => {
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

    const inspectorRoot = await openEditInspector()

    // LAYER CONTRACT: the overlay root is a direct child of
    // document.body — the application overlay root — and NOT a
    // descendant of the route content surface whose
    // `view-transition-name` traps stacking.
    expect(
      inspectorRoot.parentElement,
    ).toBe(document.body)
    expect(
      routeContent().contains(inspectorRoot),
    ).toBe(false)

    // The rail stays viewport-fixed in place: placement classes are
    // unchanged (the fix moves DOM ownership, not geometry).
    expect(inspectorRoot).toHaveClass(
      'fixed',
      'inset-y-0',
      'right-0',
      'z-40',
    )

    // The Project route remains mounted BEHIND the inspector.
    const section = workItemsSection()
    expect(routeContent().contains(section)).toBe(true)

    // Board rail reservation stays active while the inspector is
    // open (independent of DOM placement).
    expect(section).toHaveClass('xl:mr-[520px]')
  })

  it('still closes the portaled inspector on an outside click and releases the rail', async () => {
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

    const inspectorRoot = await openEditInspector()

    // A click landing outside the inspector boundary (and outside any
    // Work Item target / keep-open control) closes it — across the
    // portal, through the page-level capture-phase boundary check.
    fireEvent.click(
      screen.getByRole('heading', {
        name: 'Work Items',
      }),
    )

    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-work-item-inspector-boundary]',
        ),
      ).toBeNull(),
    )
    expect(
      document.body.contains(inspectorRoot),
    ).toBe(false)

    // Rail reservation released with the inspector.
    expect(workItemsSection()).not.toHaveClass(
      'xl:mr-[520px]',
    )
  })

  it('renders the create modal scrim on the same overlay root and keeps its outside-click dismissal', async () => {
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

    await screen.findByRole('button', {
      name: 'Open Layer task',
    })

    fireEvent.click(
      screen.getByRole('button', {
        name: /New work item/,
      }),
    )

    // The create dialog panel; its direct parent is the scrim.
    const dialog = await screen.findByRole('dialog')
    const scrim = dialog.parentElement!

    // Same overlay-root contract as the edit inspector: the scrim
    // (fixed inset-0 z-50) is a direct child of document.body and
    // outside the route content surface.
    expect(scrim.parentElement).toBe(document.body)
    expect(routeContent().contains(dialog)).toBe(false)

    // Create-mode behavior preserved: a press on the scrim itself
    // dismisses the modal.
    fireEvent.mouseDown(scrim)

    await waitFor(() =>
      expect(screen.queryByRole('dialog')).toBeNull(),
    )
  })

  it('renders the delete confirmation overlay on the overlay root, outside the route content and the inspector boundary, and keeps the inspector open on Cancel', async () => {
    vi.mocked(getProject).mockResolvedValue(PROJECT)
    vi.mocked(listProjectMemberships).mockResolvedValue([])
    vi.mocked(listResearchGroupMembers).mockResolvedValue([])
    vi.mocked(listProjectWorkItems).mockResolvedValue([
      WORK_ITEM,
    ])
    vi.mocked(
      getProjectWorkItemConfiguration,
    ).mockResolvedValue(CONFIGURATION)
    vi.mocked(deleteWorkItem).mockResolvedValue(undefined)

    renderPage()

    const inspectorRoot = await openEditInspector()
    const region = screen.getByRole('region', {
      name: 'Work item',
    })

    // The drawer's own header trigger (the Board card carries a
    // second, distinct trigger — scope to the inspector region).
    fireEvent.click(
      within(region).getByRole('button', {
        name: 'Work item actions',
      }),
    )

    await screen.findByRole('menuitem', {
      name: 'Delete work item',
    })
    fireEvent.click(
      screen.getByRole('menuitem', {
        name: 'Delete work item',
      }),
    )

    // The dialog panel; its direct parent is the overlay scrim.
    const dialog = await screen.findByRole('dialog', {
      name: 'Delete work item?',
    })
    const scrim = dialog.parentElement!

    // LAYER CONTRACT: the overlay root is a direct child of
    // document.body — the application overlay root — NOT a
    // descendant of the route content surface whose
    // `view-transition-name` traps stacking, and NOT inside the
    // inspector's boundary / stacking owner either. Rendered in
    // place, the portaled z-40 inspector painted over this
    // "z-50" overlay wherever the two overlapped and its rail
    // intercepted the dialog's pointer input (the CI failure).
    expect(scrim.parentElement).toBe(document.body)
    expect(routeContent().contains(scrim)).toBe(false)
    expect(inspectorRoot.contains(scrim)).toBe(false)

    // The viewport-centered geometry and scrim are unchanged —
    // the fix moves DOM ownership, not placement.
    expect(scrim).toHaveClass('fixed', 'inset-0', 'z-50')

    // The keep-open marker still shields the open inspector from
    // the page-level outside-click boundary.
    expect(scrim).toHaveAttribute(
      'data-work-item-inspector-keep-open',
      'true',
    )

    // The accessibility contract is unchanged: the labelled modal
    // dialog (getByRole already resolves the labelled title).
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    const labelledBy = dialog.getAttribute(
      'aria-labelledby',
    )
    expect(labelledBy).toBeTruthy()
    expect(
      document.getElementById(labelledBy!),
    ).toHaveTextContent('Delete work item?')

    // The Project route remains mounted BEHIND the overlay.
    expect(
      routeContent().contains(workItemsSection()),
    ).toBe(true)

    // Cancel closes ONLY the dialog: the inspector stays open
    // and no delete request is made.
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: /Cancel/,
      }),
    )

    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', {
          name: 'Delete work item?',
        }),
      ).not.toBeInTheDocument(),
    )
    expect(
      document.body.contains(inspectorRoot),
    ).toBe(true)
    expect(
      screen.getByRole('region', {
        name: 'Work item',
      }),
    ).toBeVisible()
    expect(deleteWorkItem).not.toHaveBeenCalled()
  })

  it('renders the standalone drawer delete overlay outside the inspector boundary and keeps the drawer open on Cancel', async () => {
    // The drawer's self-contained fallback (no page-level
    // onRequestDelete wiring): pre-fix, this overlay rendered
    // INSIDE the inspector's own z-40 boundary element, so the
    // dialog was owned by the inspector layer.
    const onDelete = vi
      .fn()
      .mockResolvedValue(undefined)
    const onClose = vi.fn()

    render(
      <WorkItemDrawer
        open={true}
        mode="edit"
        projectName={PROJECT.name}
        item={WORK_ITEM}
        readOnly={false}
        currentUserId={1}
        workItemConfiguration={CONFIGURATION}
        assignees={[]}
        parentItems={[]}
        onClose={onClose}
        onCreate={vi.fn()}
        onPatch={vi.fn()}
        onDelete={onDelete}
      />,
    )

    const region = await screen.findByRole('region', {
      name: 'Work item',
    })
    const inspectorRoot = region.parentElement!

    expect(inspectorRoot).toHaveAttribute(
      'data-work-item-inspector-boundary',
      'true',
    )
    expect(inspectorRoot.parentElement).toBe(
      document.body,
    )

    fireEvent.click(
      within(region).getByRole('button', {
        name: 'Work item actions',
      }),
    )
    await screen.findByRole('menuitem', {
      name: 'Delete work item',
    })
    fireEvent.click(
      screen.getByRole('menuitem', {
        name: 'Delete work item',
      }),
    )

    const dialog = await screen.findByRole('dialog', {
      name: 'Delete work item?',
    })
    const scrim = dialog.parentElement!

    // LAYER CONTRACT: the overlay root is a direct child of
    // document.body and NOT a descendant of the inspector's
    // boundary / stacking owner.
    expect(scrim.parentElement).toBe(document.body)
    expect(inspectorRoot.contains(scrim)).toBe(false)
    expect(scrim).toHaveClass('fixed', 'inset-0', 'z-50')

    // Cancel closes ONLY the dialog: the drawer stays open and
    // no delete request is made.
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: /Cancel/,
      }),
    )

    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', {
          name: 'Delete work item?',
        }),
      ).not.toBeInTheDocument(),
    )
    expect(
      document.body.contains(inspectorRoot),
    ).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    expect(onDelete).not.toHaveBeenCalled()
  })
})
