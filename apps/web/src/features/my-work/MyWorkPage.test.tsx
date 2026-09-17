// @vitest-environment happy-dom

import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
  waitFor,
} from '@testing-library/react'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  MemoryRouter,
  Route,
  Routes,
  useParams,
} from 'react-router'

import {
  getProjectWorkItemConfiguration,
  getProject,
  listProjectMemberships,
} from '../../api/projects'
import { ApiError } from '../../api/client'
import {
  deleteWorkItem,
  listMyWork,
  listProjectWorkItems,
  transitionWorkItemStatus,
  updateWorkItem,
} from '../../api/work-items'
import {
  fetchMyWorkPreferences,
  updateMyWorkPreferences,
} from '../../api/my-work-preferences'
import type {
  ApiMyWorkPreferences,
  ApiPersonalWorkItem,
  ApiProject,
  ApiProjectMembership,
  ApiProjectWorkItemConfiguration,
  ApiWorkItem,
} from '../../api/types'

import { MyWorkPage } from './MyWorkPage'

// The page must talk to exactly one personal endpoint and must NOT
// fan out to per-Project / per-Research-Group requests to render
// status, type, or names. Mock the whole API surface so any stray
// call is a test failure. `updateWorkItem` is mocked too: My Work
// drag/drop must NEVER use the ordinary status PATCH (it would
// reposition the item on the Project Board) — a call to it is a
// test failure.
vi.mock('../../api/work-items', () => ({
  listMyWork: vi.fn(),
  transitionWorkItemStatus: vi.fn(),
  updateWorkItem: vi.fn(),
  createWorkItem: vi.fn(),
  deleteWorkItem: vi.fn(),
  listProjectWorkItems: vi.fn(),
}))

// The persisted personal My Work preference snapshot. The page must
// load it (in parallel with the items) before rendering the final
// view and must PATCH the COMPLETE snapshot on a view-mode change.
// Mocked at the module boundary so any call is observable.
vi.mock('../../api/my-work-preferences', () => ({
  fetchMyWorkPreferences: vi.fn(),
  updateMyWorkPreferences: vi.fn(),
}))

vi.mock('../../api/projects', () => ({
  getProjectWorkItemConfiguration: vi.fn(),
  getProject: vi.fn(),
  listProjectMemberships: vi.fn(),
  listResearchGroupMembers: vi.fn(),
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

// The REAL canonical drawer is covered by its own unit suites and the
// E2E spec (it pulls the RichMarkdownEditor/Tiptap graph). The page
// under test here must mount the canonical module (this mock stands
// in for it at the module boundary) and pass it the clicked item —
// the stub renders exactly the props it receives, which is what the
// drawer-contract assertions below read back.
vi.mock('../projects/WorkItemDrawer', () => ({
  WorkItemDrawer: (props: Record<string, any>) => (
    <div
      data-testid="work-item-drawer"
      data-project-name={props.projectName}
      data-read-only={String(Boolean(props.readOnly))}
      data-work-item-inspector-boundary="true"
    >
      {props.item ? (
        <h2 data-testid="work-item-drawer-title">
          {props.item.title}
        </h2>
      ) : null}

      <button
        type="button"
        onClick={() => props.onClose()}
      >
        Close work item drawer
      </button>

      {props.item ? (
        <button
          type="button"
          data-testid="drawer-apply-patch"
          onClick={() => {
            void props.onPatch(props.item.id, {
              title: 'Patched title',
            })
          }}
        >
          Apply canonical patch
        </button>
      ) : null}

      {props.item ? (
        <button
          type="button"
          data-testid="drawer-request-delete"
          onClick={() =>
            props.onRequestDelete?.(props.item.id)
          }
        >
          Request delete
        </button>
      ) : null}
    </div>
  ),
}))

// Configurable Research Group list so the page-local group filter
// (shown only with more than one group) can be exercised. Reset to []
// after every test.
let mockGroups: Array<{ id: number; name: string }> = []

vi.mock('../research-group/useResearchGroup', () => ({
  useResearchGroup: () => ({ groups: mockGroups }),
}))

const PROJECT_A = 7
const PROJECT_B = 12
const GROUP_A = 1
const GROUP_B = 2

/** The default server snapshot for a user with no preference row:
 *  Board mode + three empty (unrestricted) filter arrays. */
const DEFAULT_PREFERENCES: ApiMyWorkPreferences = {
  viewMode: 'board',
  researchGroupIds: [],
  projectIds: [],
  workItemTypes: [],
}

function makePreferences(
  overrides: Partial<ApiMyWorkPreferences> = {},
): ApiMyWorkPreferences {
  return {
    ...DEFAULT_PREFERENCES,
    researchGroupIds: [
      ...DEFAULT_PREFERENCES.researchGroupIds,
    ],
    projectIds: [...DEFAULT_PREFERENCES.projectIds],
    workItemTypes: [
      ...DEFAULT_PREFERENCES.workItemTypes,
    ],
    ...overrides,
  }
}

function makeItem(
  overrides: Partial<ApiPersonalWorkItem> = {},
): ApiPersonalWorkItem {
  return {
    id: 100,
    projectId: PROJECT_A,
    title: 'Prepare samples',
    description: '',
    typeDefinitionId: 4,
    statusDefinitionId: 11,
    boardPosition: null,
    labelDefinitionIds: [],
    assigneeIds: [1],
    parentId: null,
    dueDate: null,
    blockedReason: null,
    completedAt: null,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    createdById: 1,
    meetingOrigin: null,
    projectName: 'Project Alpha',
    researchGroupId: GROUP_A,
    researchGroupName: 'Research Group A',
    // Neutral project-local type name — deliberately none of the
    // built-in semantic kind words (Task/Epic/Milestone/Deliverable)
    // so a test can prove the page renders the payload value and
    // never a hardcoded fallback or inferred kind.
    typeName: 'Sample Batch',
    statusName: 'Ready for Lab',
    statusCategory: 'in_progress',
    // Canonical contract: custom / unclassified types carry a null
    // kind. Tests that exercise a canonical kind set it explicitly.
    typeKind: null,
    statusTargets: [],
    ...overrides,
  } as ApiPersonalWorkItem
}

// ── Lazy drawer-context fixtures ─────────────────────────

// The owning Project as the canonical endpoint returns it. The name
// deliberately DIFFERS from the item's payload `projectName` so a
// test can prove the drawer receives the fetched Project context
// (not the display metadata from the My Work payload).
function makeProject(
  projectId: number,
  overrides: Partial<ApiProject> = {},
): ApiProject {
  return {
    id: projectId,
    researchGroupId: GROUP_A,
    name: `Drawer Project ${projectId}`,
    description: '',
    status: 'active',
    archivedAt: null,
    currentUserRole: 'owner',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    ...overrides,
  }
}

function makeConfiguration(): ApiProjectWorkItemConfiguration {
  return {
    types: [
      {
        id: 4,
        name: 'Sample Batch',
        order: 0,
        active: true,
      },
    ],
    statuses: [
      {
        id: 11,
        name: 'Ready for Lab',
        category: 'in_progress',
        order: 0,
        active: true,
        isDefault: false,
      },
    ],
    labels: [],
  }
}

function makeMemberships(): ApiProjectMembership[] {
  return [
    {
      id: 1,
      role: 'owner',
      addedAt: null,
      user: {
        id: 1,
        username: 'alex',
        firstName: 'Alex',
        lastName: 'Lange',
      },
    },
    {
      id: 2,
      role: 'member',
      addedAt: null,
      user: {
        id: 2,
        username: 'bee',
        firstName: 'Bee',
        lastName: 'Bo',
      },
    },
    {
      id: 3,
      role: 'viewer',
      addedAt: null,
      user: {
        id: 3,
        username: 'vee',
        firstName: 'Vee',
        lastName: 'Viewer',
      },
    },
  ]
}

function makeProjectWorkItems(): ApiWorkItem[] {
  return [
    {
      id: 900,
      projectId: PROJECT_A,
      title: 'Parent sample item',
      description: '',
      typeDefinitionId: 4,
      statusDefinitionId: 11,
      boardPosition: null,
      labelDefinitionIds: [],
      assigneeIds: [],
      parentId: null,
      dueDate: null,
      blockedReason: null,
      completedAt: null,
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
      createdById: 1,
      meetingOrigin: null,
    },
  ]
}

// Wire the four lazy drawer-context reads to canonical-looking
// responses for the item's owning Project.
function mockDrawerContext() {
  vi.mocked(getProject).mockImplementation(
    async (projectId) => makeProject(projectId),
  )
  vi.mocked(
    getProjectWorkItemConfiguration,
  ).mockResolvedValue(makeConfiguration())
  vi.mocked(listProjectMemberships).mockResolvedValue(
    makeMemberships(),
  )
  vi.mocked(listProjectWorkItems).mockResolvedValue(
    makeProjectWorkItems(),
  )
}

function isoDaysFromNow(days: number) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Render inside a router that also resolves the canonical Project
// Work Items target so row-open navigation can be observed.
function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/my-work']}>
      <Routes>
        <Route
          path="/my-work"
          element={<MyWorkPage />}
        />

        <Route
          path="/projects/:projectId/work-items"
          element={<WorkItemsTarget />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

function WorkItemsTarget() {
  const { projectId } = useParams()
  return (
    <div
      data-testid="work-items-target"
      data-project-id={projectId}
    >
      Canonical work items target
    </div>
  )
}

// Click the presentation-only Board/List switch. The two buttons
// expose their view name as the accessible name (the icon is
// aria-hidden).
async function switchView(
  util: {
    getByRole: (
      role: string,
      options?: { name?: string | RegExp },
    ) => HTMLElement
  },
  label: 'Board' | 'List',
) {
  await act(async () => {
    fireEvent.click(
      util.getByRole('button', { name: label }),
    )
  })
}

// Open the Research Group multi-select popover and toggle ONE group's
// checkbox (addressed by its accessible name — the group name). This
// is the behavioral path a user takes; it exercises the toggle ->
// popover -> checkbox flow, not internal state.
async function selectResearchGroup(
  util: {
    getByRole: (
      role: string,
      options?: { name?: string | RegExp },
    ) => HTMLElement
  },
  groupName: string,
) {
  await act(async () => {
    fireEvent.click(
      util.getByRole('button', {
        name: /Research groups,/,
      }),
    )
  })

  await act(async () => {
    fireEvent.click(
      util.getByRole('checkbox', {
        name: groupName,
      }),
    )
  })
}

// The `data-work-item-id` of every card inside one semantic column.
function columnCardIds(
  container: HTMLElement,
  category: string,
): string[] {
  const col = container.querySelector(
    `[data-board-column="${category}"]`,
  )

  if (!col) {
    return []
  }

  return Array.from(
    col.querySelectorAll('[data-work-item-id]'),
  ).map(
    (el) =>
      el.getAttribute('data-work-item-id') as string,
  )
}

// The semantic column heading labels in DOM (render) order.
function columnHeadingLabels(
  container: HTMLElement,
): string[] {
  return Array.from(
    container.querySelectorAll(
      '[data-board-column] h2',
    ),
  ).map(
    (el) => (el.textContent ?? '').trim(),
  )
}

// Every test starts from the server's DEFAULT snapshot (Board +
// empty filter arrays) unless it opts into a specific persisted
// preference. `updateMyWorkPreferences` echoes the COMPLETE
// snapshot it is given (the normalized server response), so tests
// can assert on the exact payload that was sent.
beforeEach(() => {
  vi.mocked(fetchMyWorkPreferences).mockResolvedValue(
    makePreferences(),
  )
  vi.mocked(updateMyWorkPreferences).mockImplementation(
    async (snapshot: ApiMyWorkPreferences) =>
      snapshot,
  )
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mockGroups = []
})

describe('My Work List View — canonical personal endpoint', () => {
  it('loads from GET /api/me/work-items/ and renders one assigned item', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem(),
    ])

    const { getByText } = renderPage()

    await waitFor(() => {
      expect(
        getByText('Prepare samples'),
      ).toBeInTheDocument()
    })

    // Exactly one canonical request, no query narrowing.
    expect(listMyWork).toHaveBeenCalledTimes(1)
    expect(listMyWork).toHaveBeenCalledWith()
  })

  it('makes no per-Project or per-Research-Group request to render status/context/names', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem(),
      makeItem({
        id: 101,
        projectId: PROJECT_B,
        researchGroupId: GROUP_B,
        title: 'Calibrate robot',
        projectName: 'Project Beta',
        researchGroupName: 'Research Group B',
        statusName: 'Awaiting Calibration',
        statusCategory: 'review',
      }),
    ])

    const { getByText } = renderPage()

    await waitFor(() => {
      expect(
        getByText('Calibrate robot'),
      ).toBeInTheDocument()
    })

    // Names + concrete status come straight from the payload — no
    // Project configuration or Project fetch is issued.
    expect(
      getProjectWorkItemConfiguration,
    ).not.toHaveBeenCalled()
    expect(getProject).not.toHaveBeenCalled()
  })

  it('renders items from two Projects together', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 100,
        projectId: PROJECT_A,
        title: 'Alpha item',
        projectName: 'Project Alpha',
      }),
      makeItem({
        id: 101,
        projectId: PROJECT_B,
        title: 'Beta item',
        projectName: 'Project Beta',
      }),
    ])

    const { getByText } = renderPage()

    await waitFor(() => {
      expect(
        getByText('Alpha item'),
      ).toBeInTheDocument()
      expect(
        getByText('Beta item'),
      ).toBeInTheDocument()
    })
  })

  it('renders items from two Research Groups together', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 100,
        researchGroupId: GROUP_A,
        title: 'Group A item',
        researchGroupName: 'Research Group A',
      }),
      makeItem({
        id: 101,
        researchGroupId: GROUP_B,
        title: 'Group B item',
        researchGroupName: 'Research Group B',
      }),
    ])

    const { getByText } = renderPage()

    await waitFor(() => {
      expect(
        getByText('Group A item'),
      ).toBeInTheDocument()
      expect(
        getByText('Group B item'),
      ).toBeInTheDocument()
    })
  })

  it('displays the Project name and Research Group name on the row', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        projectName: 'Project Alpha',
        researchGroupName: 'Research Group A',
      }),
    ])

    const { getByText } = renderPage()

    await waitFor(() => {
      expect(
        getByText('Project Alpha'),
      ).toBeInTheDocument()
      expect(
        getByText('Research Group A'),
      ).toBeInTheDocument()
    })
  })
})

describe('My Work List View — status and type presentation', () => {
  it('displays the concrete statusName (project-local status)', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        statusName: 'Ready for Lab',
        statusCategory: 'in_progress',
      }),
    ])

    const { getByText, getByRole, container } =
      renderPage()

    // The persisted view (the default Board) resolves first; the
    // switch to List happens on the loaded page.
    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-board-column]',
        ),
      ).not.toBeNull()
    })

    // The concrete statusName is the List View's status column (the
    // Kanban card deliberately does NOT render it — the column
    // communicates the semantic status).
    await switchView({ getByRole }, 'List')

    await waitFor(() => {
      expect(
        getByText('Ready for Lab'),
      ).toBeInTheDocument()
    })
  })

  it('does not replace the concrete statusName with the semantic category label (List view)', async () => {
    // statusCategory is "in_progress". The Kanban deliberately names
    // its semantic column "In progress", so this List-specific
    // assertion (that the concrete status is never replaced by the
    // category label) runs in the List view.
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        statusName: 'Ready for Lab',
        statusCategory: 'in_progress',
      }),
    ])

    const { queryByText, getByRole, container } =
      renderPage()

    // The persisted view (the default Board) resolves first; the
    // switch to List happens on the loaded page.
    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-board-column]',
        ),
      ).not.toBeNull()
    })

    await switchView({ getByRole }, 'List')

    await waitFor(() => {
      expect(
        queryByText('Ready for Lab'),
      ).not.toBeNull()
    })

    // No semantic-category stand-in text for the status.
    expect(
      queryByText('In progress'),
    ).toBeNull()
    expect(queryByText('In Progress')).toBeNull()
  })

  it('renders the configured typeName from the payload as visible row text', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        typeDefinitionId: 4,
        typeName: 'Robot Data Analysis',
      }),
    ])

    const { container, getByText } = renderPage()

    await waitFor(() => {
      expect(
        getByText('Robot Data Analysis'),
      ).toBeInTheDocument()
    })

    // The type name is row metadata of the Work Item cell — the
    // exact payload value, not a remap.
    expect(
      container
        .querySelector('[data-work-item-id="100"]')
        ?.textContent,
    ).toContain('Robot Data Analysis')
  })

  it('shows different type names for Work Items from different Projects', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 100,
        projectId: PROJECT_A,
        title: 'Alpha item',
        projectName: 'Project Alpha',
        typeName: 'Research Milestone',
      }),
      makeItem({
        id: 101,
        projectId: PROJECT_B,
        title: 'Beta item',
        projectName: 'Project Beta',
        typeName: 'Robot Data Analysis',
      }),
    ])

    const { getByText } = renderPage()

    await waitFor(() => {
      expect(
        getByText('Alpha item'),
      ).toBeInTheDocument()
    })

    expect(
      getByText('Research Milestone'),
    ).toBeInTheDocument()
    expect(
      getByText('Robot Data Analysis'),
    ).toBeInTheDocument()
  })

  it('does not fall back to a hardcoded "Task" label for the type', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        typeDefinitionId: 4,
        typeName: 'Robot Data Analysis',
      }),
    ])

    const { getByText, queryByText } =
      renderPage()

    await waitFor(() => {
      expect(
        getByText('Robot Data Analysis'),
      ).toBeInTheDocument()
    })

    expect(queryByText('Task')).toBeNull()
  })

  it('keeps the neutral Work Item icon and infers no semantic type kind or icon from typeName', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        typeDefinitionId: 4,
        typeName: 'Robot Data Analysis',
      }),
    ])

    const { container, getByText } =
      renderPage()

    await waitFor(() => {
      expect(
        getByText('Prepare samples'),
      ).toBeInTheDocument()
    })

    // Canonical presentation: the neutral Work Item icon is shown —
    // no semantic type icon (epic / milestone / deliverable glyph)
    // is derived from the configured type name.
    const icons = Array.from(
      container.querySelectorAll(
        '.material-symbols-outlined',
      ),
    )
    expect(
      icons.some(
        (icon) =>
          icon.textContent?.trim() === 'assignment',
      ),
    ).toBe(true)
    expect(
      icons.some(
        (icon) =>
          ['account_tree', 'flag', 'inventory_2'].includes(
            icon.textContent?.trim(),
          ),
      ),
    ).toBe(false)
  })
})

describe('My Work List View — due date', () => {
  it('renders the due date when present (established convention)', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        dueDate: isoDaysFromNow(1),
      }),
    ])

    const { getByText } = renderPage()

    // Established convention: tomorrow's due date renders as "Tomorrow".
    await waitFor(() => {
      expect(
        getByText('Tomorrow'),
      ).toBeInTheDocument()
    })
  })

  it('follows the established empty due convention in the List view', async () => {
    // The '—' empty-due convention is a List presentation detail; the
    // Kanban card simply omits the due line when there is none.
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        dueDate: null,
      }),
    ])

    const { getByText, getByRole, container } =
      renderPage()

    // The persisted view (the default Board) resolves first; the
    // switch to List happens on the loaded page.
    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-board-column]',
        ),
      ).not.toBeNull()
    })

    await switchView({ getByRole }, 'List')

    await waitFor(() => {
      expect(
        getByText('Prepare samples'),
      ).toBeInTheDocument()
    })

    // The established empty due convention is the em-dash.
    expect(
      getByText('—'),
    ).toBeInTheDocument()
  })
})

describe('My Work List View — loading / empty / error', () => {
  it('renders a stable themed board skeleton while the personal endpoint is in flight', async () => {
    let resolveList:
      | ((items: ApiPersonalWorkItem[]) => void)
      | undefined

    vi.mocked(listMyWork).mockReturnValue(
      new Promise<ApiPersonalWorkItem[]>(
        (resolve) => {
          resolveList = resolve
        },
      ),
    )

    const { getByText, queryByText, container } =
      renderPage()

    await act(async () => {
      await Promise.resolve()
    })

    // The loading state occupies the final content region as a
    // board-shaped skeleton (status text kept for assistive tech),
    // with one placeholder column per semantic column and NO real
    // board rendered yet.
    expect(
      getByText('Loading your work…'),
    ).toBeInTheDocument()
    expect(
      container.querySelector(
        '[data-my-work-board-skeleton]',
      ),
    ).not.toBeNull()
    expect(
      container.querySelectorAll(
        '[data-my-work-skeleton-column]',
      ).length,
    ).toBe(4)
    expect(
      container.querySelectorAll(
        '[data-board-column]',
      ).length,
    ).toBe(0)
    expect(
      queryByText('Prepare samples'),
    ).toBeNull()

    await act(async () => {
      resolveList!([makeItem()])
    })

    // The skeleton is replaced in place by the real board.
    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-my-work-board-skeleton]',
        ),
      ).toBeNull()
    })
    await waitFor(() => {
      expect(
        container.querySelectorAll(
          '[data-board-column]',
        ).length,
      ).toBe(4)
    })
    expect(
      queryByText('Loading your work…'),
    ).toBeNull()
  })

  it('renders the personal empty state for an empty response', async () => {
    vi.mocked(listMyWork).mockResolvedValue(
      [],
    )

    const { getByText, queryByText } =
      renderPage()

    await waitFor(() => {
      expect(
        getByText('Nothing assigned to you'),
      ).toBeInTheDocument()
    })

    // The empty state is personal — it does not claim that no Work
    // Items exist globally.
    expect(
      queryByText('Prepare samples'),
    ).toBeNull()
  })

  it('keeps an API failure page-local (role=alert) without breaking the shell', async () => {
    vi.mocked(listMyWork).mockRejectedValue(
      new Error('boom'),
    )

    const { getByRole, queryByText } =
      renderPage()

    await waitFor(() => {
      expect(
        getByRole('alert'),
      ).toBeInTheDocument()
    })

    // Page-local error copy, not a global crash / empty-success.
    expect(
      getByRole('alert').textContent,
    ).toContain("My Work couldn't be loaded")

    // No items fabricated from the failed load.
    expect(
      queryByText('Prepare samples'),
    ).toBeNull()
  })

  it('reloads the personal endpoint on retry', async () => {
    vi.mocked(listMyWork)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([
        makeItem(),
      ])

    const { getByRole, getByText } =
      renderPage()

    await waitFor(() => {
      expect(
        getByRole('alert'),
      ).toBeInTheDocument()
    })

    await act(async () => {
      fireEvent.click(
        getByRole('button', {
          name: /Try again/,
        }),
      )
    })

    // The retry re-issues the canonical personal request.
    await waitFor(() => {
      expect(
        getByText('Prepare samples'),
      ).toBeInTheDocument()
    })
    expect(
      vi.mocked(listMyWork).mock.calls.length,
    ).toBeGreaterThanOrEqual(2)
  })
})

describe('My Work List View — row interaction', () => {
  it('opens an item via the canonical Project Work Items interaction (rows keep navigating)', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 100,
        projectId: PROJECT_A,
      }),
    ])

    const { getByRole, container } = renderPage()

    // The persisted view (the default Board) resolves first; the
    // switch to List happens on the loaded page.
    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-board-column]',
        ),
      ).not.toBeNull()
    })

    // The List row (the Kanban card carries the same accessible
    // name — switch views first so this is genuinely the row).
    await switchView({ getByRole }, 'List')

    const row = () =>
      getByRole('button', {
        name: 'Open Prepare samples',
      })

    await waitFor(() => {
      expect(row()).toBeInTheDocument()
    })

    await act(async () => {
      fireEvent.click(row())
    })

    // Navigation reaches the item's canonical Project Work Items
    // surface (acting on the real Work Item, not a local copy).
    await waitFor(() => {
      expect(
        document.querySelector(
          '[data-testid="work-items-target"]',
        ),
      ).toHaveAttribute(
        'data-project-id',
        String(PROJECT_A),
      )
    })

    // And no drawer was mounted by the row click.
    expect(
      container.querySelector(
        '[data-testid="work-item-drawer"]',
      ),
    ).toBeNull()
  })
})

describe('My Work List View — ordering', () => {
  it('preserves backend item order in the List view (active first; completed last)', async () => {
    // Backend order is authoritative. The one established
    // presentation rule: completed (category done) items render last,
    // as a stable partition — active items keep their backend order.
    // (List-specific: the Kanban groups by category instead.)
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 1,
        title: 'A first',
        statusCategory: 'todo',
        statusName: 'Todo',
      }),
      makeItem({
        id: 2,
        title: 'B done',
        statusCategory: 'done',
        statusName: 'Done',
      }),
      makeItem({
        id: 3,
        title: 'C third',
        statusCategory: 'todo',
        statusName: 'Todo',
      }),
    ])

    const { container, getByRole } =
      renderPage()

    await switchView({ getByRole }, 'List')

    await waitFor(() => {
      expect(
        container.querySelectorAll(
          '[data-work-item-id]',
        ).length,
      ).toBe(3)
    })

    const idsInDomOrder = Array.from(
      container.querySelectorAll(
        '[data-work-item-id]',
      ),
    ).map((el) => el.getAttribute('data-work-item-id'))

    // A(1) and C(3) keep backend relative order; B(2, done) moves
    // to the end.
    expect(idsInDomOrder).toEqual(['1', '3', '2'])
  })
})

describe('My Work List View — authoritative API result', () => {
  it('does not keep a stale local copy when a refetch no longer returns an item (assignment removed)', async () => {
    vi.mocked(listMyWork)
      .mockResolvedValueOnce([
        makeItem({
          id: 100,
          title: 'Prepare samples',
        }),
        makeItem({
          id: 101,
          title: 'Other item',
        }),
      ])
      .mockResolvedValueOnce([
        makeItem({
          id: 101,
          title: 'Other item',
        }),
      ])

    const {
      unmount,
      getByText,
    } = renderPage()

    await waitFor(() => {
      expect(
        getByText('Prepare samples'),
      ).toBeInTheDocument()
      expect(
        getByText('Other item'),
      ).toBeInTheDocument()
    })

    // Leaving the page (e.g. to mutate the item on its
    // canonical Project surface) and returning remounts the
    // page; the fresh endpoint result is authoritative and an
    // item no longer returned (assignment removed) must not
    // survive from local state.
    unmount()

    const second = renderPage()

    await waitFor(() => {
      expect(
        second.getByText('Other item'),
      ).toBeInTheDocument()
    })

    expect(
      second.queryByText('Prepare samples'),
    ).toBeNull()

    // Exactly one request per mount — the page never composes
    // its list from anything but the canonical endpoint.
    expect(
      vi.mocked(listMyWork).mock.calls.length,
    ).toBe(2)
  })
})

describe('My Work Kanban — default, switch, and single data source', () => {
  it('defaults to the Kanban view (semantic columns, not the List)', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        statusCategory: 'in_progress',
      }),
    ])

    const { container, queryByText } =
      renderPage()

    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-board-column="in_progress"]',
        ),
      ).not.toBeNull()
    })

    // All four global columns render; the List table header does not.
    expect(columnHeadingLabels(container)).toEqual([
      'Todo',
      'In progress',
      'Review',
      'Done',
    ])
    expect(queryByText('Work item')).toBeNull()
  })

  it('selects the List view', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem(),
    ])

    const { container, getByText, getByRole } =
      renderPage()

    await waitFor(() => {
      expect(
        container.querySelector('[data-board-column]'),
      ).not.toBeNull()
    })

    await switchView({ getByRole }, 'List')

    await waitFor(() => {
      expect(getByText('Work item')).toBeInTheDocument()
    })

    // The Kanban board is gone.
    expect(
      container.querySelector('[data-board-column]'),
    ).toBeNull()
  })

  it('switches back to Kanban', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem(),
    ])

    const { container, getByText, queryByText, getByRole } =
      renderPage()

    await waitFor(() => {
      expect(
        container.querySelector('[data-board-column]'),
      ).not.toBeNull()
    })

    await switchView({ getByRole }, 'List')
    await waitFor(() => {
      expect(getByText('Work item')).toBeInTheDocument()
    })

    await switchView({ getByRole }, 'Board')
    await waitFor(() => {
      expect(
        container.querySelector('[data-board-column]'),
      ).not.toBeNull()
    })
    expect(queryByText('Work item')).toBeNull()
  })

  it('does not refetch /api/me/work-items/ when switching views', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem(),
    ])

    const { container, getByText, getByRole } =
      renderPage()

    await waitFor(() => {
      expect(
        container.querySelector('[data-board-column]'),
      ).not.toBeNull()
    })

    await switchView({ getByRole }, 'List')
    await waitFor(() => {
      expect(getByText('Work item')).toBeInTheDocument()
    })

    await switchView({ getByRole }, 'Board')
    await waitFor(() => {
      expect(
        container.querySelector('[data-board-column]'),
      ).not.toBeNull()
    })

    // Presentation-only: exactly one canonical request, and no
    // Project configuration or Project fetch.
    expect(listMyWork).toHaveBeenCalledTimes(1)
    expect(
      getProjectWorkItemConfiguration,
    ).not.toHaveBeenCalled()
    expect(getProject).not.toHaveBeenCalled()
  })
})

describe('My Work Kanban — columns and grouping', () => {
  it('renders exactly the four global columns in fixed order', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        statusCategory: 'todo',
      }),
    ])

    const { container } = renderPage()

    await waitFor(() => {
      expect(
        container.querySelector('[data-board-column]'),
      ).not.toBeNull()
    })

    expect(columnHeadingLabels(container)).toEqual([
      'Todo',
      'In progress',
      'Review',
      'Done',
    ])
  })

  it('places an item in each semantic column by statusCategory', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 1,
        title: 'Todo item',
        statusCategory: 'todo',
        statusName: 'Backlog',
      }),
      makeItem({
        id: 2,
        title: 'Progress item',
        statusCategory: 'in_progress',
        statusName: 'Ready for Lab',
      }),
      makeItem({
        id: 3,
        title: 'Review item',
        statusCategory: 'review',
        statusName: 'In Review',
      }),
      makeItem({
        id: 4,
        title: 'Done item',
        statusCategory: 'done',
        statusName: 'Complete',
      }),
    ])

    const { container } = renderPage()

    await waitFor(() => {
      expect(
        container.querySelectorAll(
          '[data-work-item-id]',
        ).length,
      ).toBe(4)
    })

    expect(columnCardIds(container, 'todo')).toEqual(['1'])
    expect(
      columnCardIds(container, 'in_progress'),
    ).toEqual(['2'])
    expect(columnCardIds(container, 'review')).toEqual(['3'])
    expect(columnCardIds(container, 'done')).toEqual(['4'])
  })

  it('groups by statusCategory, not statusName (distinct names, same category, same column)', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 1,
        title: 'Alpha',
        statusCategory: 'in_progress',
        statusName: 'Ready for Lab',
      }),
      makeItem({
        id: 2,
        title: 'Beta',
        statusCategory: 'in_progress',
        statusName: 'On the Bench',
      }),
    ])

    const { container, queryByText } =
      renderPage()

    await waitFor(() => {
      expect(
        container.querySelectorAll(
          '[data-work-item-id]',
        ).length,
      ).toBe(2)
    })

    // Both land in the In progress column despite different names.
    expect(columnCardIds(container, 'in_progress')).toEqual([
      '1',
      '2',
    ])

    // The Kanban cards do NOT render the concrete statusName (the
    // column communicates the semantic status); the names exist only
    // in the data contract.
    expect(queryByText('Ready for Lab')).toBeNull()
    expect(queryByText('On the Bench')).toBeNull()
  })

  it('preserves the relative API order within a column', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 11,
        title: 'First',
        statusCategory: 'todo',
      }),
      makeItem({
        id: 12,
        title: 'Second',
        statusCategory: 'todo',
      }),
      makeItem({
        id: 13,
        title: 'Third',
        statusCategory: 'todo',
      }),
    ])

    const { container } = renderPage()

    await waitFor(() => {
      expect(
        container.querySelectorAll(
          '[data-work-item-id]',
        ).length,
      ).toBe(3)
    })

    expect(columnCardIds(container, 'todo')).toEqual([
      '11',
      '12',
      '13',
    ])
  })

  it('does not reorder global cards by Project boardPosition', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 1,
        title: 'Higher position',
        statusCategory: 'todo',
        boardPosition: 100,
      }),
      makeItem({
        id: 2,
        title: 'Lower position',
        statusCategory: 'todo',
        boardPosition: 1,
      }),
    ])

    const { container } = renderPage()

    await waitFor(() => {
      expect(
        container.querySelectorAll(
          '[data-work-item-id]',
        ).length,
      ).toBe(2)
    })

    // Canonical API order (1 then 2), NOT boardPosition (2 then 1).
    expect(columnCardIds(container, 'todo')).toEqual([
      '1',
      '2',
    ])
  })

  it('keeps all four semantic columns rendered even when three are empty', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        statusCategory: 'todo',
      }),
    ])

    const { container } = renderPage()

    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-board-column="todo"]',
        ),
      ).not.toBeNull()
    })

    // All four columns render; three are empty.
    expect(columnHeadingLabels(container)).toEqual([
      'Todo',
      'In progress',
      'Review',
      'Done',
    ])

    expect(columnCardIds(container, 'todo')).toEqual(['100'])
    expect(columnCardIds(container, 'in_progress')).toEqual([])
    expect(columnCardIds(container, 'review')).toEqual([])
    expect(columnCardIds(container, 'done')).toEqual([])
  })

  it('shows the personal empty state (no columns) for an empty response', async () => {
    vi.mocked(listMyWork).mockResolvedValue([])

    const { container, getByText } =
      renderPage()

    await waitFor(() => {
      expect(
        getByText('Nothing assigned to you'),
      ).toBeInTheDocument()
    })

    expect(
      container.querySelector('[data-board-column]'),
    ).toBeNull()
  })
})

describe('My Work Kanban — visual contract', () => {
  // The card for the given Work Item (default fixture id).
  function cardFor(
    container: HTMLElement,
    id: number = 100,
  ) {
    return container.querySelector(
      `[data-work-item-id="${id}"]`,
    ) as HTMLElement
  }

  // The type icon is the FIRST material symbol in the card (the
  // top type/title row); exception-footer icons come after it.
  function typeIcon(card: HTMLElement) {
    return card.querySelector(
      '.material-symbols-outlined',
    ) as HTMLElement
  }

  it('renders a lane container for all four semantic categories', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      todoItem(),
    ])

    const { container } = renderPage()

    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-work-item-id="100"]',
        ),
      ).not.toBeNull()
    })

    // All four lanes render in fixed order even though only one
    // holds a card.
    expect(
      Array.from(
        container.querySelectorAll(
          '[data-board-column]'
        )
      ).map(
        (lane) =>
          (lane as HTMLElement).dataset
            .boardColumn,
      ),
    ).toEqual([
      'todo',
      'in_progress',
      'review',
      'done',
    ])
  })

  it('replaces the legacy single-select with the Research groups toolbar toggle', async () => {
    mockGroups = [
      { id: GROUP_A, name: 'Research Group A' },
      { id: GROUP_B, name: 'Research Group B' },
    ]

    vi.mocked(listMyWork).mockResolvedValue([
      todoItem(),
    ])

    const { container, getByRole } = renderPage()

    await waitFor(() => {
      expect(
        getByRole('button', {
          name: 'Research groups, none selected',
        }),
      ).toBeInTheDocument()
    })

    // The legacy native single-select is gone entirely (there is no
    // separate transient filter state — the persisted snapshot is the
    // only source of truth).
    expect(
      container.querySelector(
        'select[aria-label="Filter by research group"]',
      ),
    ).toBeNull()
    expect(
      container.querySelector('select'),
    ).toBeNull()
  })

  it('labels the view switch Board (not Kanban)', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      todoItem(),
    ])

    const { getByRole, queryByRole } =
      renderPage()

    await waitFor(() => {
      expect(
        getByRole('button', { name: 'Board' }),
      ).toHaveAttribute('aria-pressed', 'true')
    })

    // The old "Kanban" label is gone; the same toggle keeps the
    // List option.
    expect(
      queryByRole('button', {
        name: 'Kanban',
      }),
    ).toBeNull()
    expect(
      getByRole('button', { name: 'List' }),
    ).toHaveAttribute('aria-pressed', 'false')
  })

  it('exposes icon + written status + count in each column header', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      todoItem({ id: 1 }),
      todoItem({ id: 2, statusCategory: 'in_progress' }),
      todoItem({ id: 3, statusCategory: 'review' }),
      todoItem({ id: 4, statusCategory: 'done' }),
    ])

    const { container } = renderPage()

    await waitFor(() => {
      expect(
        container.querySelectorAll(
          '[data-work-item-id]',
        ).length,
      ).toBe(4)
    })

    // Each column header communicates the semantic status through
    // icon + WRITTEN label + count (never color alone).
    const expected: Array<
      [category: string, icon: string, label: string]
    > = [
      ['todo', 'circle', 'Todo'],
      ['in_progress', 'progress_activity', 'In progress'],
      ['review', 'circle_notifications', 'Review'],
      ['done', 'check_circle', 'Done'],
    ]

    for (
      const [category, icon, label] of
        expected
    ) {
      const column = container.querySelector(
        `[data-board-column="${category}"]`,
      ) as HTMLElement
      const header =
        column.firstElementChild as HTMLElement
      const iconSpan = header.querySelector(
        '.material-symbols-outlined',
      ) as HTMLElement

      expect(iconSpan.textContent?.trim()).toBe(icon)
      // The written status remains visible in the heading.
      expect(
        column.querySelector('h2')?.textContent,
      ).toBe(label)
      // One item per column → the quiet count is 1.
      expect(column.textContent).toContain('1')
    }
  })

  it('does not render the concrete statusName on Kanban cards', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        statusName: 'Ready for Lab',
        statusCategory: 'in_progress',
      }),
    ])

    const { container } = renderPage()

    const card = await waitForCard(
      container,
      100,
    )

    // The column communicates the semantic status; the card must
    // not repeat it.
    expect(card.textContent).not.toContain(
      'Ready for Lab',
    )
    expect(
      columnHeadingLabels(container),
    ).toEqual([
      'Todo',
      'In progress',
      'Review',
      'Done',
    ])
  })

  it('selects the semantic type presentation from typeKind, never from typeName', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      todoItem({
        id: 1,
        title: 'Task item',
        typeKind: 'task',
        typeName: 'Tasky',
      }),
      todoItem({
        id: 2,
        title: 'Epic item',
        typeKind: 'epic',
        typeName: 'Big Push',
      }),
      todoItem({
        id: 3,
        title: 'Milestone item',
        typeKind: 'milestone',
        typeName: 'M1',
      }),
      todoItem({
        id: 4,
        title: 'Deliverable item',
        typeKind: 'deliverable',
        typeName: 'Handoff',
      }),
    ])

    const { container } = renderPage()

    await waitFor(() => {
      expect(
        container.querySelectorAll(
          '[data-work-item-id]',
        ).length,
      ).toBe(4)
    })

    // The semantic presentation is keyed by typeKind: each kind
    // gets its own icon + semantic token.
    const expected: Array<
      [id: number, icon: string, token: string, typeName: string]
    > = [
      [1, 'assignment', 'text-work-type-task', 'Tasky'],
      [2, 'account_tree', 'text-work-type-epic', 'Big Push'],
      [3, 'flag', 'text-work-type-milestone', 'M1'],
      [4, 'deployed_code', 'text-work-type-deliverable', 'Handoff'],
    ]

    for (
      const [id, icon, token, typeName] of
        expected
    ) {
      const card = cardFor(container, id)
      const iconSpan = typeIcon(card)

      expect(iconSpan.textContent?.trim()).toBe(icon)
      // The semantic type token (not an inline color).
      expect(iconSpan.className).toContain(token)
      // The displayed type text remains the concrete typeName.
      expect(card.textContent).toContain(typeName)
    }
  })

  it('keeps a null typeKind visually neutral even when the typeName looks canonical', async () => {
    // A CUSTOM type literally named "Epic" has typeKind null: it
    // must stay neutral (no epic icon/token) while still showing
    // its real name.
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        statusCategory: 'todo',
        typeKind: null,
        typeName: 'Epic',
      }),
    ])

    const { container } = renderPage()

    const card = await waitForCard(
      container,
      100,
    )

    const iconSpan = typeIcon(card)

    // The neutral Work Item icon + neutral (tertiary) color —
    // never the semantic epic presentation.
    expect(iconSpan.textContent?.trim()).toBe(
      'assignment',
    )
    expect(iconSpan.className).toContain(
      'text-text-tertiary',
    )
    expect(iconSpan.className).not.toContain(
      'text-work-type-',
    )

    // The real configured name is displayed.
    expect(card.textContent).toContain('Epic')
  })

  it('renders every card as Research Group › Project (group first)', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 1,
        statusCategory: 'todo',
        projectName: 'Project Alpha',
        researchGroupName: 'Research Group A',
      }),
      makeItem({
        id: 2,
        statusCategory: 'review',
        projectName: 'Project Beta',
        researchGroupName: 'Research Group B',
      }),
    ])

    const { container } = renderPage()

    await waitFor(() => {
      expect(
        container.querySelectorAll(
          '[data-work-item-id]',
        ).length,
      ).toBe(2)
    })

    // The breadcrumb reads Research Group › Project — the group
    // comes FIRST (not the reverse), on the card itself.
    expect(
      cardFor(container, 1).textContent,
    ).toContain(
      'Research Group A › Project Alpha',
    )
    expect(
      cardFor(container, 2).textContent,
    ).toContain(
      'Research Group B › Project Beta',
    )
  })

  it('renders no assignee UI on Kanban cards', async () => {
    // The session user is "Alex" (username alex); neither form may
    // surface on the card.
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        statusCategory: 'todo',
        assigneeIds: [1],
      }),
    ])

    const { container } = renderPage()

    const card = await waitForCard(
      container,
      100,
    )

    expect(card.textContent).not.toContain('Alex')
    expect(card.textContent).not.toContain('alex')
  })

  it('renders no due metadata when the item has no due date', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        statusCategory: 'todo',
        dueDate: null,
        blockedReason: null,
      }),
    ])

    const { container } = renderPage()

    const card = await waitForCard(
      container,
      100,
    )

    // No due row, no exception wording.
    expect(card.textContent).not.toMatch(
      /Due today|overdue|Tomorrow|Today|Mon|Tue|Wed|Thu|Fri|Sat|Sun/,
    )
  })

  it('renders a future due date as neutral compact date metadata', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        statusCategory: 'todo',
        dueDate: isoDaysFromNow(3),
      }),
    ])

    const { container } = renderPage()

    const card = await waitForCard(
      container,
      100,
    )

    // The established short-date convention (same date logic as
    // the List).
    const d = new Date()
    d.setDate(d.getDate() + 3)
    const expected =
      new Intl.DateTimeFormat('en', {
        month: 'short',
        day: 'numeric',
      }).format(d)

    expect(card.textContent).toContain(expected)
    expect(card.textContent).not.toContain(
      'Due today',
    )
    expect(card.textContent).not.toContain(
      'overdue',
    )
  })

  it('renders Due today explicitly when the item is due today', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        statusCategory: 'todo',
        dueDate: isoDaysFromNow(0),
      }),
    ])

    const { container } = renderPage()

    const card = await waitForCard(
      container,
      100,
    )

    expect(card.textContent).toContain('Due today')
  })

  it('renders an overdue due as explicit overdue text', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        dueDate: isoDaysFromNow(-3),
        statusCategory: 'todo',
      }),
    ])

    const { container } = renderPage()

    const card = await waitForCard(
      container,
      100,
    )

    expect(card.textContent).toContain('3d overdue')
  })

  it('keeps the blocked state visible on the card', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        blockedReason: 'Waiting on reagents',
      }),
    ])

    const { container } = renderPage()

    const card = await waitForCard(
      container,
      100,
    )

    // Explicit "Blocked" text (icon + text, not a filled pill);
    // the native tooltip carries the reason.
    const blocked = card.querySelector(
      '[title="Waiting on reagents"]',
    ) as HTMLElement
    expect(blocked).not.toBeNull()
    expect(blocked.textContent).toContain('Blocked')
  })

  it('lets blocked and the due state coexist in one exception footer', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        statusCategory: 'todo',
        blockedReason: 'Waiting on reagents',
        dueDate: isoDaysFromNow(-12),
      }),
    ])

    const { container } = renderPage()

    const card = await waitForCard(
      container,
      100,
    )

    // Both exceptions render together.
    expect(card.textContent).toContain('Blocked')
    expect(card.textContent).toContain('12d overdue')
  })

  it('omits the exception footer for a completely normal item', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        statusCategory: 'todo',
        dueDate: null,
        blockedReason: null,
      }),
    ])

    const { container } = renderPage()

    const card = await waitForCard(
      container,
      100,
    )

    // Exactly three information groups (type+title, type label,
    // breadcrumb) — no reserved empty footer — and only the type
    // icon (no exception icons).
    expect(card.children.length).toBe(3)
    expect(
      card.querySelectorAll(
        '.material-symbols-outlined',
      ).length,
    ).toBe(1)
  })

  it('keeps empty semantic columns rendered (header + count, no cards)', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        statusCategory: 'todo',
      }),
    ])

    const { container } = renderPage()

    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-board-column="todo"]',
        ),
      ).not.toBeNull()
    })

    // All four columns render; three are empty.
    expect(columnHeadingLabels(container)).toEqual([
      'Todo',
      'In progress',
      'Review',
      'Done',
    ])

    // Empty columns keep their header with a quiet "0" count and
    // no cards (no decorative empty-state placeholder).
    expect(columnCardIds(container, 'todo')).toEqual(['100'])
    expect(columnCardIds(container, 'in_progress')).toEqual([])
    expect(columnCardIds(container, 'review')).toEqual([])
    expect(columnCardIds(container, 'done')).toEqual([])

    for (
      const category of [
        'in_progress',
        'review',
        'done',
      ]
    ) {
      const column = container.querySelector(
        `[data-board-column="${category}"]`,
      ) as HTMLElement

      expect(column.querySelector('h2')).not.toBeNull()
      expect(column.textContent).toContain('0')
    }
  })
})

describe('My Work Kanban — interaction, filter, and contract', () => {
  it('opens the canonical WorkItemDrawer in place on card click (no navigation)', async () => {
    mockDrawerContext()

    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 100,
        projectId: PROJECT_A,
      }),
    ])

    const { getByRole, container } = renderPage()

    const card = () =>
      getByRole('button', {
        name: 'Open Prepare samples',
      })

    await waitFor(() => {
      expect(card()).toBeInTheDocument()
    })

    await act(async () => {
      fireEvent.click(card())
    })

    // The canonical drawer (mocked at the module boundary) is
    // mounted over My Work with the CLICKED item and the fetched
    // owning-Project context (the fetched project name — not the
    // payload's display name — proves the lazy context is used).
    const drawer = () =>
      container.querySelector(
        '[data-testid="work-item-drawer"]',
      ) as HTMLElement

    await waitFor(() => {
      expect(drawer()).not.toBeNull()
    })

    expect(drawer().textContent).toContain(
      'Prepare samples',
    )
    expect(drawer()).toHaveAttribute(
      'data-project-name',
      `Drawer Project ${PROJECT_A}`,
    )
    expect(drawer()).toHaveAttribute(
      'data-read-only',
      'false',
    )

    // The pathname stays on /my-work: the canonical Project Work
    // Items target is never rendered, and the My Work board is
    // still rendered underneath.
    expect(
      container.querySelector(
        '[data-testid="work-items-target"]',
      ),
    ).toBeNull()
    expect(card()).toBeInTheDocument()
  })

  it('opens a card with the keyboard (Enter)', async () => {
    mockDrawerContext()

    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 100,
        projectId: PROJECT_A,
      }),
    ])

    const { getByRole, container } = renderPage()

    const card = () =>
      getByRole('button', {
        name: 'Open Prepare samples',
      })

    await waitFor(() => {
      expect(card()).toBeInTheDocument()
    })

    await act(async () => {
      fireEvent.keyDown(card(), { key: 'Enter' })
    })

    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-testid="work-item-drawer"]',
        ),
      ).not.toBeNull()
    })
  })

  it('opens a card with the keyboard (Space)', async () => {
    mockDrawerContext()

    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 100,
        projectId: PROJECT_A,
      }),
    ])

    const { getByRole, container } = renderPage()

    const card = () =>
      getByRole('button', {
        name: 'Open Prepare samples',
      })

    await waitFor(() => {
      expect(card()).toBeInTheDocument()
    })

    await act(async () => {
      fireEvent.keyDown(card(), { key: ' ' })
    })

    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-testid="work-item-drawer"]',
        ),
      ).not.toBeNull()
    })
  })

  it('closing the drawer returns to the board without navigation, keeping the Research Group filter and the Kanban view', async () => {
    mockGroups = [
      { id: GROUP_A, name: 'Research Group A' },
      { id: GROUP_B, name: 'Research Group B' },
    ]

    mockDrawerContext()

    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 100,
        projectId: PROJECT_A,
        researchGroupId: GROUP_A,
        statusCategory: 'todo',
      }),
      makeItem({
        id: 2,
        title: 'Group B item',
        researchGroupId: GROUP_B,
        researchGroupName: 'Research Group B',
        statusCategory: 'todo',
      }),
    ])

    const { getByRole, container } = renderPage()

    const card = () =>
      getByRole('button', {
        name: 'Open Prepare samples',
      })

    await waitFor(() => {
      expect(card()).toBeInTheDocument()
    })

    // Apply the Research Group A filter via the multiselect popover.
    await selectResearchGroup(
      { getByRole },
      'Research Group A',
    )
    await waitFor(() => {
      expect(
        container.querySelector('[data-work-item-id="2"]'),
      ).toBeNull()
    })

    // Open the card, then close the drawer.
    await act(async () => {
      fireEvent.click(card())
    })

    const drawer = () =>
      container.querySelector(
        '[data-testid="work-item-drawer"]',
      ) as HTMLElement

    await waitFor(() => {
      expect(drawer()).not.toBeNull()
    })

    await act(async () => {
      fireEvent.click(
        drawer().querySelector(
          'button',
        ) as HTMLElement,
      )
    })

    // Drawer is gone, the board is exactly as before, no
    // navigation happened, and the view + filter selections
    // survived.
    await waitFor(() => {
      expect(drawer()).toBeNull()
    })

    expect(
      container.querySelector(
        '[data-testid="work-items-target"]',
      ),
    ).toBeNull()
    expect(card()).toBeInTheDocument()
    // The applied chip is still present (the filter survived).
    expect(
      getByRole('button', {
        name:
          'Remove Research Group filter Research Group A',
      }),
    ).toBeInTheDocument()
    expect(
      getByRole('button', { name: 'Board' }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      getByRole('button', { name: 'List' }),
    ).toHaveAttribute('aria-pressed', 'false')
  })

  it('filters the Kanban when a Research Group is selected in the popover', async () => {
    mockGroups = [
      { id: GROUP_A, name: 'Research Group A' },
      { id: GROUP_B, name: 'Research Group B' },
    ]

    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 1,
        title: 'Group A item',
        researchGroupId: GROUP_A,
        researchGroupName: 'Research Group A',
        statusCategory: 'todo',
      }),
      makeItem({
        id: 2,
        title: 'Group B item',
        researchGroupId: GROUP_B,
        researchGroupName: 'Research Group B',
        statusCategory: 'todo',
      }),
    ])

    const { container, getByRole } = renderPage()

    await waitFor(() => {
      expect(
        container.querySelectorAll(
          '[data-work-item-id]',
        ).length,
      ).toBe(2)
    })

    await selectResearchGroup(
      { getByRole },
      'Research Group A',
    )

    await waitFor(() => {
      expect(columnCardIds(container, 'todo')).toEqual(['1'])
    })
    // The other group's item is gone; other columns stay empty.
    expect(
      columnCardIds(container, 'in_progress'),
    ).toEqual([])
    expect(
      container.querySelector('[data-work-item-id="2"]'),
    ).toBeNull()
    // The filter is presentation-only: no refetch of the personal
    // endpoint.
    expect(listMyWork).toHaveBeenCalledTimes(1)
  })

  it('preserves the Research Group filter across List/Board switching', async () => {
    mockGroups = [
      { id: GROUP_A, name: 'Research Group A' },
      { id: GROUP_B, name: 'Research Group B' },
    ]

    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 1,
        title: 'Group A item',
        researchGroupId: GROUP_A,
        researchGroupName: 'Research Group A',
        statusCategory: 'todo',
      }),
      makeItem({
        id: 2,
        title: 'Group B item',
        researchGroupId: GROUP_B,
        researchGroupName: 'Research Group B',
        statusCategory: 'todo',
      }),
    ])

    const {
      container,
      getByText,
      queryByText,
      getByRole,
    } = renderPage()

    await waitFor(() => {
      expect(
        container.querySelectorAll(
          '[data-work-item-id]',
        ).length,
      ).toBe(2)
    })

    // Filter to Group A while in the Board view.
    await selectResearchGroup(
      { getByRole },
      'Research Group A',
    )
    await waitFor(() => {
      expect(columnCardIds(container, 'todo')).toEqual(['1'])
    })

    // Switch to List — the selection must be preserved.
    await switchView({ getByRole }, 'List')
    await waitFor(() => {
      expect(getByText('Work item')).toBeInTheDocument()
    })
    expect(getByText('Group A item')).toBeInTheDocument()
    expect(queryByText('Group B item')).toBeNull()

    // Switch back to Board — still filtered.
    await switchView({ getByRole }, 'Board')
    await waitFor(() => {
      expect(
        container.querySelector('[data-board-column]'),
      ).not.toBeNull()
    })
    expect(columnCardIds(container, 'todo')).toEqual(['1'])
  })

  it('parses statusTargets but issues no mutation or extra request', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        statusTargets: [
          {
            statusCategory: 'todo',
            statusDefinitionId: 21,
            statusName: 'To do',
          },
          {
            statusCategory: 'in_progress',
            statusDefinitionId: 22,
            statusName: 'Doing',
          },
          {
            statusCategory: 'review',
            statusDefinitionId: 23,
            statusName: 'Review',
          },
          {
            statusCategory: 'done',
            statusDefinitionId: 24,
            statusName: 'Done',
          },
        ],
      }),
    ])

    const { container, getByText, getByRole } =
      renderPage()

    await waitFor(() => {
      expect(
        container.querySelector('[data-board-column]'),
      ).not.toBeNull()
    })

    await switchView({ getByRole }, 'List')
    await waitFor(() => {
      expect(getByText('Work item')).toBeInTheDocument()
    })

    // Exactly one canonical request; the presence of statusTargets
    // triggers no configuration fetch and no mutation.
    expect(listMyWork).toHaveBeenCalledTimes(1)
    expect(
      getProjectWorkItemConfiguration,
    ).not.toHaveBeenCalled()
    expect(getProject).not.toHaveBeenCalled()
  })
})

describe('My Work Kanban — lazy Project drawer context', () => {
  it('fetches no Project drawer context during normal initial rendering', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 1,
        title: 'Alpha item',
        projectId: PROJECT_A,
      }),
      makeItem({
        id: 2,
        title: 'Beta item',
        projectId: PROJECT_B,
      }),
    ])

    const { container, getByRole } = renderPage()

    await waitFor(() => {
      expect(
        container.querySelectorAll(
          '[data-work-item-id]',
        ).length,
      ).toBe(2)
    })

    // Repeated renders (view switching) without opening a card
    // must never create a per-Project configuration fan-out.
    await switchView({ getByRole }, 'List')
    await waitFor(() => {
      expect(
        getByRole('button', {
          name: 'Open Alpha item',
        }),
      ).toBeInTheDocument()
    })

    await switchView({ getByRole }, 'Board')
    await waitFor(() => {
      expect(
        container.querySelectorAll(
          '[data-board-column]',
        ).length,
      ).toBe(4)
    })

    expect(
      getProjectWorkItemConfiguration,
    ).not.toHaveBeenCalled()
    expect(getProject).not.toHaveBeenCalled()
    expect(listProjectMemberships).not.toHaveBeenCalled()
    expect(listProjectWorkItems).not.toHaveBeenCalled()
  })

  it('fetches only the owning Project context when a card opens', async () => {
    mockDrawerContext()

    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 1,
        title: 'Alpha item',
        projectId: PROJECT_A,
      }),
      makeItem({
        id: 2,
        title: 'Beta item',
        projectId: PROJECT_B,
      }),
    ])

    const { getByRole, container } = renderPage()

    await waitFor(() => {
      expect(
        getByRole('button', {
          name: 'Open Alpha item',
        }),
      ).toBeInTheDocument()
    })

    await act(async () => {
      fireEvent.click(
        getByRole('button', {
          name: 'Open Alpha item',
        }),
      )
    })

    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-testid="work-item-drawer"]',
        ),
      ).not.toBeNull()
    })

    // Exactly the drawer-contract reads, once each, for the
    // OWNING Project only.
    expect(getProject).toHaveBeenCalledTimes(1)
    expect(getProject).toHaveBeenCalledWith(PROJECT_A)
    expect(
      getProjectWorkItemConfiguration,
    ).toHaveBeenCalledTimes(1)
    expect(
      getProjectWorkItemConfiguration,
    ).toHaveBeenCalledWith(PROJECT_A)
    expect(listProjectMemberships).toHaveBeenCalledTimes(1)
    expect(
      listProjectMemberships,
    ).toHaveBeenCalledWith(PROJECT_A)
    expect(listProjectWorkItems).toHaveBeenCalledTimes(1)
    expect(listProjectWorkItems).toHaveBeenCalledWith(
      PROJECT_A,
    )

    // The My Work payload stays the one canonical read.
    expect(listMyWork).toHaveBeenCalledTimes(1)
  })

  it('does not fetch drawer context for unrelated Projects', async () => {
    mockDrawerContext()

    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 1,
        title: 'Alpha item',
        projectId: PROJECT_A,
      }),
      makeItem({
        id: 2,
        title: 'Beta item',
        projectId: PROJECT_B,
      }),
    ])

    const { getByRole, container } = renderPage()

    await waitFor(() => {
      expect(
        getByRole('button', {
          name: 'Open Alpha item',
        }),
      ).toBeInTheDocument()
    })

    await act(async () => {
      fireEvent.click(
        getByRole('button', {
          name: 'Open Alpha item',
        }),
      )
    })

    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-testid="work-item-drawer"]',
        ),
      ).not.toBeNull()
    })

    expect(
      getProject,
    ).not.toHaveBeenCalledWith(PROJECT_B)
    expect(
      getProjectWorkItemConfiguration,
    ).not.toHaveBeenCalledWith(PROJECT_B)
    expect(
      listProjectMemberships,
    ).not.toHaveBeenCalledWith(PROJECT_B)
    expect(
      listProjectWorkItems,
    ).not.toHaveBeenCalledWith(PROJECT_B)
  })

  it('re-opens a card of the same Project without duplicate context requests', async () => {
    mockDrawerContext()

    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 100,
        projectId: PROJECT_A,
      }),
    ])

    const { getByRole, container } = renderPage()

    const card = () =>
      getByRole('button', {
        name: 'Open Prepare samples',
      })

    await waitFor(() => {
      expect(card()).toBeInTheDocument()
    })

    await act(async () => {
      fireEvent.click(card())
    })

    const drawer = () =>
      container.querySelector(
        '[data-testid="work-item-drawer"]',
      ) as HTMLElement

    await waitFor(() => {
      expect(drawer()).not.toBeNull()
    })

    // Close, then re-open the same card.
    await act(async () => {
      fireEvent.click(
        drawer().querySelector(
          'button',
        ) as HTMLElement,
      )
    })

    await waitFor(() => {
      expect(drawer()).toBeNull()
    })

    await act(async () => {
      fireEvent.click(card())
    })

    await waitFor(() => {
      expect(drawer()).not.toBeNull()
    })

    // One set of context reads for the whole session — the
    // second open hit the session cache.
    expect(getProject).toHaveBeenCalledTimes(1)
    expect(
      getProjectWorkItemConfiguration,
    ).toHaveBeenCalledTimes(1)
    expect(listProjectMemberships).toHaveBeenCalledTimes(1)
    expect(listProjectWorkItems).toHaveBeenCalledTimes(1)
  })

  it('passes the clicked Work Item — not merely the first of the Project — to the drawer', async () => {
    mockDrawerContext()

    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 1,
        title: 'First project item',
        projectId: PROJECT_A,
      }),
      makeItem({
        id: 2,
        title: 'Second project item',
        projectId: PROJECT_A,
        statusCategory: 'todo',
      }),
    ])

    const { getByRole, container } = renderPage()

    await waitFor(() => {
      expect(
        getByRole('button', {
          name: 'Open Second project item',
        }),
      ).toBeInTheDocument()
    })

    await act(async () => {
      fireEvent.click(
        getByRole('button', {
          name: 'Open Second project item',
        }),
      )
    })

    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-testid="work-item-drawer"]',
        ),
      ).not.toBeNull()
    })

    // The drawer carries the clicked item's identity, and ONLY one
    // drawer is mounted.
    const drawer = container.querySelector(
      '[data-testid="work-item-drawer"]',
    ) as HTMLElement
    expect(
      container.querySelectorAll(
        '[data-testid="work-item-drawer"]',
      ).length,
    ).toBe(1)
    expect(
      drawer.querySelector(
        '[data-testid="work-item-drawer-title"]',
      )?.textContent,
    ).toBe('Second project item')
  })

  it('keeps the drawer open across a List/Kanban view switch (same selected item)', async () => {
    mockDrawerContext()

    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 100,
        projectId: PROJECT_A,
      }),
    ])

    const { getByRole, container } = renderPage()

    await waitFor(() => {
      expect(
        getByRole('button', {
          name: 'Open Prepare samples',
        }),
      ).toBeInTheDocument()
    })

    await act(async () => {
      fireEvent.click(
        getByRole('button', {
          name: 'Open Prepare samples',
        }),
      )
    })

    const drawer = () =>
      container.querySelector(
        '[data-testid="work-item-drawer"]',
      ) as HTMLElement

    await waitFor(() => {
      expect(drawer()).not.toBeNull()
    })

    // Switching views must not close the drawer (keep-open
    // boundary marker) and must not re-fetch.
    await switchView({ getByRole }, 'List')

    expect(drawer()).not.toBeNull()
    expect(drawer().textContent).toContain(
      'Prepare samples',
    )
    expect(getProject).toHaveBeenCalledTimes(1)

    await switchView({ getByRole }, 'Board')

    expect(drawer()).not.toBeNull()
  })

  it('renders a failed drawer-context load in place with retry, without navigating', async () => {
    vi.mocked(getProject).mockRejectedValue(
      new Error('boom'),
    )

    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 100,
        projectId: PROJECT_A,
      }),
    ])

    const { getByRole, container } = renderPage()

    const card = () =>
      getByRole('button', {
        name: 'Open Prepare samples',
      })

    await waitFor(() => {
      expect(card()).toBeInTheDocument()
    })

    await act(async () => {
      fireEvent.click(card())
    })

    // The failure is exposed in place (role=alert) — no
    // navigation, the board underneath is intact.
    const alert = () =>
      container.querySelector('[role="alert"]')

    await waitFor(() => {
      expect(alert()).not.toBeNull()
    })

    expect(
      container.querySelector(
        '[data-testid="work-items-target"]',
      ),
    ).toBeNull()
    expect(card()).toBeInTheDocument()

    // Retry re-issues the context reads and the drawer opens.
    vi.mocked(getProject).mockImplementation(
      async (projectId) => makeProject(projectId),
    )

    await act(async () => {
      fireEvent.click(
        getByRole('button', { name: 'Retry' }),
      )
    })

    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-testid="work-item-drawer"]',
        ),
      ).not.toBeNull()
    })

    expect(getProject).toHaveBeenCalledTimes(2)
  })

  it('shows the drawer shell while the lazy context resolves, then the drawer replaces it and closes normally', async () => {
    // The Project read resolves last: the shell is visible for a
    // real (bounded) window before the context is ready.
    let resolveProject:
      | ((project: ApiProject) => void)
      | undefined

    vi.mocked(getProject).mockReturnValue(
      new Promise<ApiProject>((resolve) => {
        resolveProject = resolve
      }),
    )
    vi.mocked(
      getProjectWorkItemConfiguration,
    ).mockResolvedValue(makeConfiguration())
    vi.mocked(listProjectMemberships).mockResolvedValue(
      makeMemberships(),
    )
    vi.mocked(listProjectWorkItems).mockResolvedValue(
      makeProjectWorkItems(),
    )

    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 100,
        projectId: PROJECT_A,
      }),
    ])

    const { getByRole, container } = renderPage()

    const card = () =>
      getByRole('button', {
        name: 'Open Prepare samples',
      })

    await waitFor(() => {
      expect(card()).toBeInTheDocument()
    })

    // The shell renders immediately after the card open.
    await act(async () => {
      fireEvent.click(card())
    })

    const shell = () =>
      container.querySelector(
        '[data-my-work-drawer-shell]',
      )

    await waitFor(() => {
      expect(shell()).not.toBeNull()
    })

    // No drawer yet, no navigation, board still underneath.
    expect(
      container.querySelector(
        '[data-testid="work-item-drawer"]',
      ),
    ).toBeNull()
    expect(
      container.querySelector(
        '[data-testid="work-items-target"]',
      ),
    ).toBeNull()
    expect(card()).toBeInTheDocument()

    // The context resolves: the drawer replaces the shell in
    // place, and the shell is gone.
    await act(async () => {
      resolveProject!(makeProject(PROJECT_A))
    })

    const drawer = () =>
      container.querySelector(
        '[data-testid="work-item-drawer"]',
      ) as HTMLElement

    await waitFor(() => {
      expect(drawer()).not.toBeNull()
    })
    expect(shell()).toBeNull()

    // The fallback did not interfere with close: closing the
    // drawer returns to the board without navigation.
    await act(async () => {
      fireEvent.click(
        drawer().querySelector(
          'button',
        ) as HTMLElement,
      )
    })

    await waitFor(() => {
      expect(drawer()).toBeNull()
    })
    expect(
      container.querySelector(
        '[data-testid="work-items-target"]',
      ),
    ).toBeNull()
    expect(card()).toBeInTheDocument()
  })
})

describe('My Work Kanban — canonical drawer mutations', () => {
  it('uses the ordinary canonical PATCH and triggers one authoritative My Work refresh', async () => {
    mockDrawerContext()

    const updated = makeItem({
      id: 100,
      projectId: PROJECT_A,
      title: 'Patched title',
    })

    vi.mocked(listMyWork)
      .mockResolvedValueOnce([
        makeItem({
          id: 100,
          projectId: PROJECT_A,
        }),
      ])
      .mockResolvedValueOnce([updated])
    vi.mocked(updateWorkItem).mockResolvedValue(updated)

    const { getByRole, container } = renderPage()

    const card = () =>
      getByRole('button', {
        name: 'Open Prepare samples',
      })

    await waitFor(() => {
      expect(card()).toBeInTheDocument()
    })

    await act(async () => {
      fireEvent.click(card())
    })

    const drawer = () =>
      container.querySelector(
        '[data-testid="work-item-drawer"]',
      ) as HTMLElement

    await waitFor(() => {
      expect(drawer()).not.toBeNull()
    })

    await act(async () => {
      fireEvent.click(
        drawer().querySelector(
          '[data-testid="drawer-apply-patch"]',
        ) as HTMLElement,
      )
    })

    // Canonical drawer semantics: the ordinary PATCH (never the
    // drag transition-status operation).
    expect(updateWorkItem).toHaveBeenCalledTimes(1)
    expect(updateWorkItem).toHaveBeenCalledWith(
      100,
      expect.objectContaining({
        title: 'Patched title',
      }),
    )
    expect(
      transitionWorkItemStatus,
    ).not.toHaveBeenCalled()

    // Exactly one authoritative My Work refresh after the
    // successful mutation.
    await waitFor(() => {
      expect(listMyWork).toHaveBeenCalledTimes(2)
    })
  })

  it('reflects the refetched Work Item data in the card', async () => {
    mockDrawerContext()

    const before = makeItem({
      id: 100,
      projectId: PROJECT_A,
    })
    const after = makeItem({
      id: 100,
      projectId: PROJECT_A,
      title: 'Patched title',
    })

    vi.mocked(listMyWork)
      .mockResolvedValueOnce([before])
      .mockResolvedValueOnce([after])
    vi.mocked(updateWorkItem).mockResolvedValue(after)

    const { getByRole, container } = renderPage()

    await waitFor(() => {
      expect(
        getByRole('button', {
          name: 'Open Prepare samples',
        }),
      ).toBeInTheDocument()
    })

    await act(async () => {
      fireEvent.click(
        getByRole('button', {
          name: 'Open Prepare samples',
        }),
      )
    })

    const drawer = () =>
      container.querySelector(
        '[data-testid="work-item-drawer"]',
      ) as HTMLElement

    await waitFor(() => {
      expect(drawer()).not.toBeNull()
    })

    await act(async () => {
      fireEvent.click(
        drawer().querySelector(
          '[data-testid="drawer-apply-patch"]',
        ) as HTMLElement,
      )
    })

    // The refetched payload (not the mutation response, not a
    // local copy) renders: the card now carries the new title.
    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-work-item-id="100"]',
        )?.textContent,
      ).toContain('Patched title')
    })
  })

  it('unmounts the drawer and drops the card when the authoritative refetch no longer returns the item', async () => {
    mockDrawerContext()

    const item = makeItem({
      id: 100,
      projectId: PROJECT_A,
    })

    vi.mocked(listMyWork)
      .mockResolvedValueOnce([item])
      .mockResolvedValueOnce([])
    vi.mocked(updateWorkItem).mockResolvedValue(item)

    const { getByRole, container } = renderPage()

    await waitFor(() => {
      expect(
        getByRole('button', {
          name: 'Open Prepare samples',
        }),
      ).toBeInTheDocument()
    })

    await act(async () => {
      fireEvent.click(
        getByRole('button', {
          name: 'Open Prepare samples',
        }),
      )
    })

    const drawer = () =>
      container.querySelector(
        '[data-testid="work-item-drawer"]',
      )

    await waitFor(() => {
      expect(drawer()).not.toBeNull()
    })

    await act(async () => {
      fireEvent.click(
        (container.querySelector(
          '[data-testid="work-item-drawer"]',
        ) as HTMLElement).querySelector(
          '[data-testid="drawer-apply-patch"]',
        ) as HTMLElement,
      )
    })

    // The item is gone from the authoritative payload: the card
    // disappears AND the drawer unmounts on its own (no stale
    // second copy).
    await waitFor(() => {
      expect(drawer()).toBeNull()
    })
    expect(
      container.querySelector(
        '[data-work-item-id="100"]',
      ),
    ).toBeNull()
  })

  it('deletes the Work Item through the shared confirmation and refreshes My Work authoritatively', async () => {
    mockDrawerContext()

    const item = makeItem({
      id: 100,
      projectId: PROJECT_A,
    })

    vi.mocked(listMyWork)
      .mockResolvedValueOnce([item])
      .mockResolvedValueOnce([])
    vi.mocked(deleteWorkItem).mockResolvedValue(undefined)

    const { getByRole, container } = renderPage()

    await waitFor(() => {
      expect(
        getByRole('button', {
          name: 'Open Prepare samples',
        }),
      ).toBeInTheDocument()
    })

    await act(async () => {
      fireEvent.click(
        getByRole('button', {
          name: 'Open Prepare samples',
        }),
      )
    })

    const drawer = () =>
      container.querySelector(
        '[data-testid="work-item-drawer"]',
      ) as HTMLElement

    await waitFor(() => {
      expect(drawer()).not.toBeNull()
    })

    // The shared page-level confirmation dialog opens.
    await act(async () => {
      fireEvent.click(
        drawer().querySelector(
          '[data-testid="drawer-request-delete"]',
        ) as HTMLElement,
      )
    })

    const confirm = () =>
      container.querySelector(
        '[role="dialog"] button',
      ) as HTMLElement

    const deleteConfirm = () =>
      Array.from(
        container.querySelectorAll(
          '[role="dialog"] button',
        ),
      ).find(
        (button) =>
          button.textContent ===
          'Delete work item',
      ) as HTMLElement

    await waitFor(() => {
      expect(deleteConfirm()).toBeDefined()
    })

    await act(async () => {
      fireEvent.click(deleteConfirm())
    })

    // Canonical delete + one authoritative refresh; the item
    // disappears from the board and the drawer unmounts.
    expect(deleteWorkItem).toHaveBeenCalledTimes(1)
    expect(deleteWorkItem).toHaveBeenCalledWith(100)
    expect(
      updateWorkItem,
    ).not.toHaveBeenCalled()

    await waitFor(() => {
      expect(listMyWork).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-work-item-id="100"]',
        ),
      ).toBeNull()
    })
    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-testid="work-item-drawer"]',
        ),
      ).toBeNull()
    })
    expect(confirm()).toBeNull()
  })

  it('does not open the drawer for a successful drag/drop, and a normal click still opens it after drag functionality exists', async () => {
    const item = todoItem()
    const moved = {
      ...item,
      statusDefinitionId: 22,
      statusName: 'In Progress',
      statusCategory: 'in_progress' as const,
    }

    vi.mocked(listMyWork)
      .mockResolvedValueOnce([item])
      .mockResolvedValueOnce([moved])
    vi.mocked(transitionWorkItemStatus).mockResolvedValue(moved)
    mockDrawerContext()

    const { container } = renderPage()

    const card = await waitForCard(
      container,
      100,
    )

    // Successful drag → status transition only, no drawer.
    await dragCardToColumn(
      container,
      card,
      'in_progress',
    )

    await waitFor(() => {
      expect(
        columnCardIds(
          container,
          'in_progress',
        ),
      ).toContain('100')
    })

    expect(
      container.querySelector(
        '[data-testid="work-item-drawer"]',
      ),
    ).toBeNull()

    // A normal click on the (moved) card still opens the drawer.
    const movedCard = container.querySelector(
      '[data-work-item-id="100"]',
    ) as HTMLElement

    await act(async () => {
      fireEvent.click(movedCard)
    })

    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-testid="work-item-drawer"]',
        ),
      ).not.toBeNull()
    })
  })
})

// ── Cross-category drag & drop ──────────────────────────

/**
 * Minimal DataTransfer stand-in for native HTML5 drag/drop in
 * happy-dom. React's synthetic drag events read `dataTransfer`
 * straight off the native event, so the object passed through
 * `fireEvent`'s event init is what the handlers see.
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

/**
 * The native HTML5 drag sequence the board relies on: dragstart on
 * the card (id lands on dataTransfer), dragover + drop on the target
 * column, dragend back on the card.
 */
async function dragCardToColumn(
  container: HTMLElement,
  card: HTMLElement,
  category: string,
) {
  const column = container.querySelector(
    `[data-board-column="${category}"]`,
  ) as HTMLElement

  const dataTransfer = makeDataTransfer()

  await act(async () => {
    fireEvent.dragStart(card, { dataTransfer })
  })

  await act(async () => {
    fireEvent.dragOver(column, { dataTransfer })
    fireEvent.drop(column, { dataTransfer })
    fireEvent.dragEnd(card, { dataTransfer })
  })
}

// The initial load is async; wait for the card to render before
// interacting with it.
async function waitForCard(
  container: HTMLElement,
  id: number,
) {
  await waitFor(() => {
    expect(
      container.querySelector(
        `[data-work-item-id="${id}"]`,
      ),
    ).not.toBeNull()
  })

  return container.querySelector(
    `[data-work-item-id="${id}"]`,
  ) as HTMLElement
}

const ALL_TARGETS = [
  {
    statusCategory: 'todo' as const,
    statusDefinitionId: 21,
    statusName: 'To do',
  },
  {
    statusCategory: 'in_progress' as const,
    statusDefinitionId: 22,
    statusName: 'In Progress',
  },
  {
    statusCategory: 'review' as const,
    statusDefinitionId: 23,
    statusName: 'Review',
  },
  {
    statusCategory: 'done' as const,
    statusDefinitionId: 24,
    statusName: 'Done',
  },
]

function todoItem(
  overrides: Partial<ApiPersonalWorkItem> = {},
) {
  return makeItem({
    id: 100,
    title: 'Prepare samples',
    statusDefinitionId: 11,
    statusName: 'Ready for Lab',
    statusCategory: 'todo',
    statusTargets: ALL_TARGETS,
    ...overrides,
  })
}

describe('My Work Kanban — cross-category drag and drop', () => {
  it('moves a card from todo to in_progress with one canonical mutation and one authoritative refetch', async () => {
    const item = todoItem()
    const moved = {
      ...item,
      statusDefinitionId: 22,
      statusName: 'In Progress',
      statusCategory: 'in_progress' as const,
    }

    vi.mocked(listMyWork)
      .mockResolvedValueOnce([item])
      .mockResolvedValueOnce([moved])
    vi.mocked(transitionWorkItemStatus).mockResolvedValue(moved)

    const { container } = renderPage()

    const card = await waitForCard(
      container,
      100,
    )

    await dragCardToColumn(
      container,
      card,
      'in_progress',
    )

    await waitFor(() => {
      expect(
        columnCardIds(
          container,
          'in_progress',
        ),
      ).toContain('100')
    })

    // Exactly one canonical mutation, through the canonical
    // status-only transition, sending ONLY the concrete target
    // statusDefinitionId from the item's statusTargets — the
    // exact-match assertion also proves no boardPosition (or any
    // other field) was sent. The ordinary status PATCH must NOT be
    // used for My Work drag/drop.
    expect(transitionWorkItemStatus).toHaveBeenCalledTimes(1)
    expect(transitionWorkItemStatus).toHaveBeenCalledWith(
      100,
      22,
    )
    expect(updateWorkItem).not.toHaveBeenCalled()

    // Exactly one authoritative My Work refetch after the
    // successful mutation (the initial load + the post-mutation
    // refetch — nothing else).
    expect(listMyWork).toHaveBeenCalledTimes(2)

    // No Project configuration or Project fetch for the move —
    // statusTargets already carried the concrete target.
    expect(
      getProjectWorkItemConfiguration,
    ).not.toHaveBeenCalled()
    expect(getProject).not.toHaveBeenCalled()

    // The refetched payload is what renders: the card sits in the
    // returned category (the concrete statusName is NOT rendered on
    // the card — the column says so), and the Project / Research
    // Group context is intact.
    expect(
      columnCardIds(container, 'todo'),
    ).not.toContain('100')

    const movedCard = container.querySelector(
      '[data-work-item-id="100"]',
    ) as HTMLElement
    expect(movedCard.textContent).toContain(
      'Project Alpha',
    )
    expect(movedCard.textContent).toContain(
      'Research Group A',
    )
    // No redundant concrete status on the card itself.
    expect(movedCard.textContent).not.toContain(
      'In Progress',
    )

    // No accidental navigation from the drag gesture itself:
    // the canonical Project Work Items target is NOT rendered.
    expect(
      container.querySelector(
        '[data-testid="work-items-target"]',
      ),
    ).toBeNull()

    // And no accidental drawer open from the drag gesture.
    expect(
      container.querySelector(
        '[data-testid="work-item-drawer"]',
      ),
    ).toBeNull()

    // The view remains Kanban (the switch did not flip).
    expect(
      container
        .querySelectorAll('[data-board-column]')
        .length,
    ).toBe(4)
  })

  it('resolves the mutation target from statusTargets, never from status names', async () => {
    // The item's CURRENT status is named "In Progress" (a name from
    // a DIFFERENT project), and the in_progress target is named
    // "On deck" — neither name matches the column label. The
    // mutation must use the target's statusDefinitionId (33).
    const item = todoItem({
      statusName: 'In Progress',
      statusTargets: [
        {
          statusCategory: 'in_progress',
          statusDefinitionId: 33,
          statusName: 'On deck',
        },
      ],
    })
    const moved = {
      ...item,
      statusDefinitionId: 33,
      statusName: 'On deck',
      statusCategory: 'in_progress' as const,
    }

    vi.mocked(listMyWork)
      .mockResolvedValueOnce([item])
      .mockResolvedValueOnce([moved])
    vi.mocked(transitionWorkItemStatus).mockResolvedValue(moved)

    const { container } = renderPage()

    const card = await waitForCard(
      container,
      100,
    )

    await dragCardToColumn(
      container,
      card,
      'in_progress',
    )

    await waitFor(() => {
      expect(
        columnCardIds(
          container,
          'in_progress',
        ),
      ).toContain('100')
    })

    // The target's ID is authoritative; display names (the item's
    // own, the target's, or the column's) never participate.
    expect(transitionWorkItemStatus).toHaveBeenCalledWith(
      100,
      33,
    )
    expect(updateWorkItem).not.toHaveBeenCalled()

    // The refetched payload is what renders: the card sits in the
    // target category. The concrete statusName is NOT rendered on
    // the card (the column communicates the semantic status), so
    // neither the item's old name nor the target's name surfaces.
    const movedCard = container.querySelector(
      '[data-work-item-id="100"]',
    ) as HTMLElement
    expect(movedCard.textContent).not.toContain('On deck')
  })

  it('performs no mutation and no refetch for a same-category drop', async () => {
    const item = todoItem()

    vi.mocked(listMyWork).mockResolvedValue([item])
    vi.mocked(transitionWorkItemStatus).mockResolvedValue(item)

    const { container } = renderPage()

    const card = await waitForCard(
      container,
      100,
    )

    // Drop back into the item's OWN semantic column (this board
    // has no within-column reordering).
    await dragCardToColumn(
      container,
      card,
      'todo',
    )

    expect(transitionWorkItemStatus).not.toHaveBeenCalled()
    expect(listMyWork).toHaveBeenCalledTimes(1)

    // The card stays where it was.
    expect(columnCardIds(container, 'todo')).toEqual(
      ['100'],
    )
  })

  it('prevents mutation and refetch when the item has no statusTarget for the drop category', async () => {
    // Only a `done` target exists — dropping into in_progress /
    // review must be a no-op (no fallback status is invented, none
    // is chosen by name).
    const item = todoItem({
      statusTargets: [
        {
          statusCategory: 'done',
          statusDefinitionId: 24,
          statusName: 'Done',
        },
      ],
    })

    vi.mocked(listMyWork).mockResolvedValue([item])
    vi.mocked(transitionWorkItemStatus).mockResolvedValue(item)

    const { container } = renderPage()

    const card = await waitForCard(
      container,
      100,
    )

    await dragCardToColumn(
      container,
      card,
      'in_progress',
    )

    expect(transitionWorkItemStatus).not.toHaveBeenCalled()
    expect(listMyWork).toHaveBeenCalledTimes(1)
    expect(columnCardIds(container, 'todo')).toEqual(
      ['100'],
    )

    // The SAME card can still move to a category it DOES have a
    // target for.
    const doneTargetCard = container.querySelector(
      '[data-work-item-id="100"]',
    ) as HTMLElement
    vi.mocked(listMyWork).mockResolvedValue([
      {
        ...item,
        statusDefinitionId: 24,
        statusName: 'Done',
        statusCategory: 'done',
      },
    ])

    await dragCardToColumn(
      container,
      doneTargetCard,
      'done',
    )

    await waitFor(() => {
      expect(
        columnCardIds(container, 'done'),
      ).toContain('100')
    })
    expect(transitionWorkItemStatus).toHaveBeenCalledTimes(1)
    expect(transitionWorkItemStatus).toHaveBeenCalledWith(
      100,
      24,
    )
  })

  it('distinguishes valid vs unavailable drop destinations only while a drag is active', async () => {
    // Targets exist for in_progress + done; review is missing and
    // todo is the item's own category.
    const item = todoItem({
      statusTargets: [
        {
          statusCategory: 'in_progress',
          statusDefinitionId: 22,
          statusName: 'In Progress',
        },
        {
          statusCategory: 'done',
          statusDefinitionId: 24,
          statusName: 'Done',
        },
      ],
    })

    vi.mocked(listMyWork).mockResolvedValue([item])

    const { container } = renderPage()

    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-work-item-id="100"]',
        ),
      ).not.toBeNull()
    })

    // No drag active → no availability decoration at all.
    for (const category of [
      'todo',
      'in_progress',
      'review',
      'done',
    ]) {
      expect(
        container.querySelector(
          `[data-board-column="${category}"][data-board-column-drop-state]`,
        ),
      ).toBeNull()
    }

    // Drag active → valid targets marked valid, the own category
    // and the target-less category marked unavailable.
    const card = container.querySelector(
      '[data-work-item-id="100"]',
    ) as HTMLElement

    await act(async () => {
      fireEvent.dragStart(card, {
        dataTransfer: makeDataTransfer(),
      })
    })

    expect(
      container.querySelector(
        '[data-board-column="in_progress"]',
      )?.getAttribute(
        'data-board-column-drop-state',
      ),
    ).toBe('valid')
    expect(
      container.querySelector(
        '[data-board-column="done"]',
      )?.getAttribute(
        'data-board-column-drop-state',
      ),
    ).toBe('valid')
    expect(
      container.querySelector(
        '[data-board-column="todo"]',
      )?.getAttribute(
        'data-board-column-drop-state',
      ),
    ).toBe('unavailable')
    expect(
      container.querySelector(
        '[data-board-column="review"]',
      )?.getAttribute(
        'data-board-column-drop-state',
      ),
    ).toBe('unavailable')

    // Drag cancelled → all decoration is removed again.
    await act(async () => {
      fireEvent.dragEnd(card, {
        dataTransfer: makeDataTransfer(),
      })
    })

    for (const category of [
      'todo',
      'in_progress',
      'review',
      'done',
    ]) {
      expect(
        container.querySelector(
          `[data-board-column="${category}"][data-board-column-drop-state]`,
        ),
      ).toBeNull()
    }
  })

  it('keeps the card in its authoritative category on mutation failure and allows a retry', async () => {
    const item = todoItem()
    const moved = {
      ...item,
      statusDefinitionId: 22,
      statusName: 'In Progress',
      statusCategory: 'in_progress' as const,
    }

    vi.mocked(transitionWorkItemStatus)
      .mockRejectedValueOnce(
        new ApiError(403, {
          error:
            'You do not have permission to update this work item.',
        }),
      )
      .mockResolvedValueOnce(moved)

    // First load returns the original item; every later authoritative
    // refetch (only the one after the successful retry) returns the
    // moved item.
    vi.mocked(listMyWork)
      .mockResolvedValueOnce([item])
      .mockResolvedValue([moved])

    const { container } = renderPage()

    const card = await waitForCard(
      container,
      100,
    )

    // First attempt fails.
    await dragCardToColumn(
      container,
      card,
      'in_progress',
    )

    // No refetch after a failed mutation; the card remains in its
    // authoritative (previous) category — no optimistic state is
    // left behind.
    expect(listMyWork).toHaveBeenCalledTimes(1)
    expect(columnCardIds(container, 'todo')).toEqual(
      ['100'],
    )

    // The failure is exposed with the established board error
    // pattern.
    await waitFor(() => {
      expect(
        container.querySelector('[role="alert"]'),
      ).not.toBeNull()
    })
    expect(
      container.querySelector(
        '[role="alert"]',
      )?.textContent,
    ).toContain(
      'You do not have permission to update this work item.',
    )

    // Dismiss, then retry by dragging again — the second attempt
    // succeeds and the board renders the refetched state.
    await act(async () => {
      fireEvent.click(
        container.querySelector(
          '[role="alert"] button',
        ) as HTMLElement,
      )
    })
    expect(
      container.querySelector('[role="alert"]'),
    ).toBeNull()

    const retryCard = container.querySelector(
      '[data-work-item-id="100"]',
    ) as HTMLElement
    await dragCardToColumn(
      container,
      retryCard,
      'in_progress',
    )

    await waitFor(() => {
      expect(
        columnCardIds(
          container,
          'in_progress',
        ),
      ).toContain('100')
    })

    expect(transitionWorkItemStatus).toHaveBeenCalledTimes(2)
    expect(listMyWork).toHaveBeenCalledTimes(2)
  })

  it('does not create a duplicate mutation for a drop of a card that is already pending', async () => {
    const item = todoItem()
    const moved = {
      ...item,
      statusDefinitionId: 22,
      statusName: 'In Progress',
      statusCategory: 'in_progress' as const,
    }

    // A mutation that never resolves on its own, so the second
    // drop of the same card lands while the first is still in
    // flight.
    let resolveFirstMutation: (
      value: ApiPersonalWorkItem,
    ) => void = () => undefined
    vi.mocked(transitionWorkItemStatus).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFirstMutation = resolve
        }),
    )

    vi.mocked(listMyWork)
      .mockResolvedValueOnce([item])
      .mockResolvedValueOnce([moved])

    const { container } = renderPage()

    const card = await waitForCard(
      container,
      100,
    )

    // First drop → mutation in flight.
    await dragCardToColumn(
      container,
      card,
      'in_progress',
    )

    expect(transitionWorkItemStatus).toHaveBeenCalledTimes(1)

    // The card is still in its original column (no optimistic
    // relocation) and pending; a second full drag + drop of the
    // SAME card must not start a second mutation.
    expect(columnCardIds(container, 'todo')).toEqual(
      ['100'],
    )

    const pendingCard = container.querySelector(
      '[data-work-item-id="100"]',
    ) as HTMLElement
    await dragCardToColumn(
      container,
      pendingCard,
      'in_progress',
    )

    expect(transitionWorkItemStatus).toHaveBeenCalledTimes(1)

    // Completing the first mutation triggers exactly one
    // authoritative refetch.
    await act(async () => {
      resolveFirstMutation(moved)
    })

    await waitFor(() => {
      expect(
        columnCardIds(
          container,
          'in_progress',
        ),
      ).toContain('100')
    })

    expect(transitionWorkItemStatus).toHaveBeenCalledTimes(1)
    expect(listMyWork).toHaveBeenCalledTimes(2)
  })

  it('keeps the Research Group filter and the Kanban view after a successful move', async () => {
    mockGroups = [
      { id: GROUP_A, name: 'Research Group A' },
      { id: GROUP_B, name: 'Research Group B' },
    ]

    const item = todoItem({
      researchGroupId: GROUP_A,
      researchGroupName: 'Research Group A',
    })
    const otherItem = makeItem({
      id: 200,
      title: 'Other group item',
      projectId: PROJECT_B,
      researchGroupId: GROUP_B,
      researchGroupName: 'Research Group B',
      statusCategory: 'todo',
    })
    const moved = {
      ...item,
      statusDefinitionId: 22,
      statusName: 'In Progress',
      statusCategory: 'in_progress' as const,
    }

    vi.mocked(listMyWork)
      .mockResolvedValueOnce([item, otherItem])
      .mockResolvedValueOnce([moved, otherItem])
    vi.mocked(transitionWorkItemStatus).mockResolvedValue(moved)

    const { container, getByRole } = renderPage()

    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-work-item-id="100"]',
        ),
      ).not.toBeNull()
    })

    // Apply the Research Group A filter via the multiselect popover.
    await selectResearchGroup(
      { getByRole },
      'Research Group A',
    )
    await waitFor(() => {
      expect(
        container.querySelector('[data-work-item-id="200"]'),
      ).toBeNull()
    })

    const card = container.querySelector(
      '[data-work-item-id="100"]',
    ) as HTMLElement
    await dragCardToColumn(
      container,
      card,
      'in_progress',
    )

    await waitFor(() => {
      expect(
        columnCardIds(
          container,
          'in_progress',
        ),
      ).toContain('100')
    })

    // The filter selection survives the move (the applied chip is
    // still present and the other group's item is still hidden).
    expect(
      getByRole('button', {
        name:
          'Remove Research Group filter Research Group A',
      }),
    ).toBeInTheDocument()
    expect(
      container.querySelector('[data-work-item-id="200"]'),
    ).toBeNull()

    // The view is still Kanban.
    expect(
      getByRole('button', {
        name: 'Board',
      }),
    ).toHaveAttribute('aria-pressed', 'true')

    // The filtered group's item still renders (context intact).
    expect(
      columnCardIds(container, 'in_progress'),
    ).toEqual(['100'])
  })

  it('lets the refetched statusCategory — not the drop column — decide the final column', async () => {
    // The drop targets `in_progress`, but the authoritative
    // refetched payload reports the item in `review` (e.g. the
    // server applied its own canonical status). The board must
    // render the payload, not the drop location.
    const item = todoItem()
    const refetched = {
      ...item,
      statusDefinitionId: 23,
      statusName: 'Review',
      statusCategory: 'review' as const,
    }

    vi.mocked(listMyWork)
      .mockResolvedValueOnce([item])
      .mockResolvedValueOnce([refetched])
    vi.mocked(transitionWorkItemStatus).mockResolvedValue(refetched)

    const { container } = renderPage()

    const card = await waitForCard(
      container,
      100,
    )

    await dragCardToColumn(
      container,
      card,
      'in_progress',
    )

    await waitFor(() => {
      expect(
        columnCardIds(container, 'review'),
      ).toContain('100')
    })

    // The card is NOT in the column it was dropped on.
    expect(
      columnCardIds(container, 'in_progress'),
    ).not.toContain('100')
  })

  it('keeps normal card clicks opening the canonical drawer while draggable', async () => {
    mockDrawerContext()

    const item = todoItem()

    vi.mocked(listMyWork).mockResolvedValue([item])

    const { container } = renderPage()

    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-work-item-id="100"]',
        ),
      ).not.toBeNull()
    })

    // The card is a draggable element…
    const card = container.querySelector(
      '[data-work-item-id="100"]',
    ) as HTMLElement
    // (React renders the `draggable` HTML attribute; happy-dom
    // does not expose the IDL property, so assert the attribute.)
    expect(card.getAttribute('draggable')).toBe(
      'true',
    )

    // …but a plain click (no drag) still opens the item — now via
    // the canonical drawer in place, never via navigation.
    await act(async () => {
      fireEvent.click(card)
    })

    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-testid="work-item-drawer"]',
        ),
      ).not.toBeNull()
    })

    expect(
      container.querySelector(
        '[data-testid="work-items-target"]',
      ),
    ).toBeNull()

    // And no mutation was triggered by the click.
    expect(transitionWorkItemStatus).not.toHaveBeenCalled()
  })

  it('leaves the List View rows non-draggable', async () => {
    const item = todoItem()

    vi.mocked(listMyWork).mockResolvedValue([item])

    const { container, getByRole } = renderPage()

    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-work-item-id="100"]',
        ),
      ).not.toBeNull()
    })

    // Switch to the List view — the same item renders as a row.
    await switchView({ getByRole }, 'List')
    await waitFor(() => {
      expect(
        getByRole('button', {
          name: 'Open Prepare samples',
        }),
      ).toBeInTheDocument()
    })

    const row = container.querySelector(
      '[data-work-item-id="100"]',
    ) as HTMLElement
    // The List row is NOT a drag source (only the Kanban card is).
    expect(
      row.hasAttribute('draggable'),
    ).toBe(false)
    expect(row.getAttribute('draggable')).toBeNull()
  })
})

describe('My Work preferences — hydration and view mode persistence', () => {
  it('issues the preferences GET on the initial My Work load', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem(),
    ])

    renderPage()

    // One canonical items request + the personal preference
    // snapshot, loaded together on mount.
    await waitFor(() => {
      expect(
        fetchMyWorkPreferences,
      ).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(listMyWork).toHaveBeenCalledTimes(1)
    })
  })

  it('renders the List as the FIRST final state for a persisted viewMode "list"', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem(),
    ])
    let resolvePrefs:
      | ((p: ApiMyWorkPreferences) => void)
      | undefined
    vi.mocked(fetchMyWorkPreferences).mockReturnValue(
      new Promise<ApiMyWorkPreferences>(
        (resolve) => {
          resolvePrefs = resolve
        },
      ),
    )

    const { container, getByRole } =
      renderPage()

    // Let the items load settle while the preference
    // snapshot is still unknown.
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      await Promise.resolve()
    })

    // The final view is still unknown: the skeleton — NO
    // Board, NO List, and no button claims a pressed view.
    expect(
      container.querySelector(
        '[data-my-work-board-skeleton]',
      ),
    ).not.toBeNull()
    expect(
      container.querySelector(
        '[data-board-column]',
      ),
    ).toBeNull()
    expect(
      getByRole('button', { name: 'Board' }),
    ).toHaveAttribute('aria-pressed', 'false')
    expect(
      getByRole('button', { name: 'List' }),
    ).toHaveAttribute('aria-pressed', 'false')

    // The persisted List preference arrives: the first
    // (and only) final state is the List.
    await act(async () => {
      resolvePrefs!(
        makePreferences({ viewMode: 'list' }),
      )
    })

    await waitFor(() => {
      expect(
        getByRole('button', { name: 'List' }),
      ).toHaveAttribute('aria-pressed', 'true')
    })
    expect(
      container.querySelector(
        '[data-board-column]',
      ),
    ).toBeNull()
  })

  it('renders the Board for a persisted viewMode "board"', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        statusCategory: 'in_progress',
      }),
    ])

    const { container, getByRole } =
      renderPage()

    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-board-column="in_progress"]',
        ),
      ).not.toBeNull()
    })

    expect(
      getByRole('button', { name: 'Board' }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      getByRole('button', { name: 'List' }),
    ).toHaveAttribute('aria-pressed', 'false')
  })

  it('shows no final Board flash before a persisted List preference is known', async () => {
    let resolveItems:
      | ((items: ApiPersonalWorkItem[]) => void)
      | undefined
    let resolvePrefs:
      | ((p: ApiMyWorkPreferences) => void)
      | undefined
    vi.mocked(listMyWork).mockReturnValue(
      new Promise<ApiPersonalWorkItem[]>(
        (resolve) => {
          resolveItems = resolve
        },
      ),
    )
    vi.mocked(fetchMyWorkPreferences).mockReturnValue(
      new Promise<ApiMyWorkPreferences>(
        (resolve) => {
          resolvePrefs = resolve
        },
      ),
    )

    const { container } = renderPage()

    // Neither load has resolved: skeleton only.
    await act(async () => {
      await Promise.resolve()
    })
    expect(
      container.querySelector(
        '[data-my-work-board-skeleton]',
      ),
    ).not.toBeNull()

    // The ITEMS have loaded, but the persisted view is
    // still unknown: the page must NOT render the default
    // Board (or any final view) — still the skeleton.
    await act(async () => {
      resolveItems!([makeItem()])
    })
    expect(
      container.querySelector(
        '[data-my-work-board-skeleton]',
      ),
    ).not.toBeNull()
    expect(
      container.querySelector(
        '[data-board-column]',
      ),
    ).toBeNull()

    // The preference arrives as a persisted List: the first
    // final view is the List — the Board never flashed.
    await act(async () => {
      resolvePrefs!(
        makePreferences({ viewMode: 'list' }),
      )
    })
    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-my-work-board-skeleton]',
        ),
      ).toBeNull()
    })
    expect(
      container.querySelector(
        '[data-board-column]',
      ),
    ).toBeNull()
  })

  it('updates the UI immediately on Board → List (no save round-trip first)', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem(),
    ])

    const { container, getByRole, getByText } =
      renderPage()
    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-board-column]',
        ),
      ).not.toBeNull()
    })

    // The switch is a local snapshot update: the List is
    // rendered synchronously — no debounce wait, no PATCH
    // round-trip, no items refetch.
    await switchView({ getByRole }, 'List')

    expect(
      getByText('Work item'),
    ).toBeInTheDocument()
    expect(
      container.querySelector(
        '[data-board-column]',
      ),
    ).toBeNull()
    expect(
      getByRole('button', { name: 'List' }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      updateMyWorkPreferences,
    ).not.toHaveBeenCalled()
  })

  it('does not refetch /api/me/work-items/ when switching and persisting the view mode', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem(),
    ])

    const { container, getByRole } =
      renderPage()
    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-board-column]',
        ),
      ).not.toBeNull()
    })

    vi.useFakeTimers()
    try {
      await switchView({ getByRole }, 'List')
      await act(async () => {
        vi.advanceTimersByTime(300)
      })
      await switchView({ getByRole }, 'Board')
      await act(async () => {
        vi.advanceTimersByTime(300)
      })
    } finally {
      vi.useRealTimers()
    }

    // Two switches + two persisted saves: still exactly ONE
    // canonical personal items request for the whole mount.
    expect(
      listMyWork,
    ).toHaveBeenCalledTimes(1)
  })

  it('PATCHes the COMPLETE preference snapshot when the view mode changes', async () => {
    const loaded = makePreferences({
      researchGroupIds: [GROUP_A],
      projectIds: [PROJECT_A],
      workItemTypes: ['milestone'],
    })
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem(),
    ])
    vi.mocked(fetchMyWorkPreferences).mockResolvedValue(loaded)

    const { container, getByRole } =
      renderPage()
    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-board-column]',
        ),
      ).not.toBeNull()
    })

    vi.useFakeTimers()
    try {
      await switchView({ getByRole }, 'List')

      // Nothing is sent before the debounce window elapses.
      expect(
        updateMyWorkPreferences,
      ).not.toHaveBeenCalled()

      await act(async () => {
        vi.advanceTimersByTime(300)
      })
    } finally {
      vi.useRealTimers()
    }

    // Exactly one PATCH — the COMPLETE current snapshot with
    // ONLY viewMode changed (not an incremental action).
    expect(
      updateMyWorkPreferences,
    ).toHaveBeenCalledTimes(1)
    expect(
      vi.mocked(updateMyWorkPreferences).mock
        .calls[0][0],
    ).toEqual({
      viewMode: 'list',
      researchGroupIds: [GROUP_A],
      projectIds: [PROJECT_A],
      workItemTypes: ['milestone'],
    })
  })

  it('keeps the loaded researchGroupIds / projectIds / workItemTypes unchanged across view-mode saves', async () => {
    const loaded = makePreferences({
      researchGroupIds: [GROUP_A],
      projectIds: [
        PROJECT_A,
        PROJECT_B,
      ],
      workItemTypes: [
        'task',
        'epic',
      ],
    })
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem(),
    ])
    vi.mocked(fetchMyWorkPreferences).mockResolvedValue(loaded)

    const { container, getByRole } =
      renderPage()
    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-board-column]',
        ),
      ).not.toBeNull()
    })

    vi.useFakeTimers()
    try {
      // Board → List (save), then List → Board (save).
      await switchView({ getByRole }, 'List')
      await act(async () => {
        vi.advanceTimersByTime(300)
      })
      await switchView({ getByRole }, 'Board')
      await act(async () => {
        vi.advanceTimersByTime(300)
      })
    } finally {
      vi.useRealTimers()
    }

    // Both saves carry the LOADED filter arrays unchanged —
    // a view-mode change never zeros or rewrites them.
    const calls = vi.mocked(
      updateMyWorkPreferences,
    ).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0][0]).toEqual({
      viewMode: 'list',
      researchGroupIds: [GROUP_A],
      projectIds: [PROJECT_A, PROJECT_B],
      workItemTypes: ['task', 'epic'],
    })
    expect(calls[1][0]).toEqual({
      viewMode: 'board',
      researchGroupIds: [GROUP_A],
      projectIds: [PROJECT_A, PROJECT_B],
      workItemTypes: ['task', 'epic'],
    })
  })

  it('coalesces rapid view-mode changes into a single latest-snapshot save', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem(),
    ])

    const { container, getByRole } =
      renderPage()
    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-board-column]',
        ),
      ).not.toBeNull()
    })

    vi.useFakeTimers()
    try {
      // Three toggles inside one debounce window.
      await switchView({ getByRole }, 'List')
      await switchView({ getByRole }, 'Board')
      await switchView({ getByRole }, 'List')

      // No overlapping / stale saves: nothing is sent while
      // the window is open.
      expect(
        updateMyWorkPreferences,
      ).not.toHaveBeenCalled()

      await act(async () => {
        vi.advanceTimersByTime(300)
      })
    } finally {
      vi.useRealTimers()
    }

    // Exactly one PATCH — the LATEST complete snapshot.
    expect(
      updateMyWorkPreferences,
    ).toHaveBeenCalledTimes(1)
    expect(
      vi.mocked(updateMyWorkPreferences).mock
        .calls[0][0].viewMode,
    ).toBe('list')
  })

  it('treats the successful PATCH response as the authoritative local preference', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem(),
    ])
    // The server will sanitize this snapshot on the next
    // write: research group 99 is no longer accessible.
    vi.mocked(
      fetchMyWorkPreferences,
    ).mockResolvedValue(
      makePreferences({
        researchGroupIds: [
          GROUP_A,
          99,
        ],
        projectIds: [PROJECT_A],
        workItemTypes: ['task'],
      }),
    )
    vi.mocked(
      updateMyWorkPreferences,
    ).mockImplementation(
      async (snapshot: ApiMyWorkPreferences) =>
        ({
          ...snapshot,
          researchGroupIds: snapshot.researchGroupIds.filter(
            (id) => id === GROUP_A,
          ),
        }),
    )

    const { container, getByRole } =
      renderPage()
    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-board-column]',
        ),
      ).not.toBeNull()
    })

    vi.useFakeTimers()
    try {
      // Save #1: the response comes back SANITIZED (99
      // dropped) — it must replace the local snapshot.
      await switchView({ getByRole }, 'List')
      await act(async () => {
        vi.advanceTimersByTime(300)
      })
      // Save #2: the NEXT payload proves which snapshot the
      // client is holding.
      await switchView({ getByRole }, 'Board')
      await act(async () => {
        vi.advanceTimersByTime(300)
      })
    } finally {
      vi.useRealTimers()
    }

    const calls = vi.mocked(
      updateMyWorkPreferences,
    ).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0][0]).toMatchObject({
      viewMode: 'list',
      researchGroupIds: [GROUP_A, 99],
    })
    // The local state was reconciled to the normalized
    // server response — the second save carries the
    // sanitized IDs, not the pre-sanitization draft.
    expect(calls[1][0]).toEqual({
      viewMode: 'board',
      researchGroupIds: [GROUP_A],
      projectIds: [PROJECT_A],
      workItemTypes: ['task'],
    })
  })

  it('keeps the locally selected view mode when the save fails', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem(),
    ])

    const { container, getByRole, getByText } =
      renderPage()
    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-board-column]',
        ),
      ).not.toBeNull()
    })

    vi.mocked(updateMyWorkPreferences).mockRejectedValue(
      new ApiError(500, null),
    )

    vi.useFakeTimers()
    try {
      await switchView({ getByRole }, 'List')
      await act(async () => {
        vi.advanceTimersByTime(300)
      })
    } finally {
      vi.useRealTimers()
    }

    // The locally chosen List is KEPT — no revert to the
    // previously persisted Board, and the content (now the
    // List) remains rendered.
    expect(
      getByRole('button', { name: 'List' }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      getByRole('button', { name: 'Board' }),
    ).toHaveAttribute('aria-pressed', 'false')
    expect(
      container.querySelector(
        '[data-board-column]',
      ),
    ).toBeNull()
    expect(
      getByText('Prepare samples'),
    ).toBeInTheDocument()
  })

  it('shows the standard non-fatal save error notification when the save fails', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem(),
    ])

    const { container, getByRole, getByText, queryByRole } =
      renderPage()
    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-board-column]',
        ),
      ).not.toBeNull()
    })

    vi.mocked(updateMyWorkPreferences).mockRejectedValue(
      new Error('network down'),
    )

    vi.useFakeTimers()
    try {
      await switchView({ getByRole }, 'List')
      await act(async () => {
        vi.advanceTimersByTime(300)
      })
    } finally {
      vi.useRealTimers()
    }

    // The standard small non-fatal notification — page-local,
    // dismissible, NOT a modal / page-level fatal error.
    const alert = getByRole('alert')
    expect(
      alert.textContent,
    ).toContain(
      "Couldn't save your My Work preferences.",
    )
    expect(
      getByText('Prepare samples'),
    ).toBeInTheDocument()

    // Dismiss clears it.
    await act(async () => {
      fireEvent.click(
        within(alert).getByRole('button', {
          name: 'Dismiss',
        }),
      )
    })
    expect(
      queryByRole('alert'),
    ).toBeNull()
  })

  it('follows the page initial-load error/retry behavior when the preference GET fails', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem(),
    ])
    vi.mocked(fetchMyWorkPreferences)
      .mockRejectedValueOnce(new Error('pref boom'))
      .mockResolvedValue(makePreferences())

    const { getByRole, getByText, container } =
      renderPage()

    // A failed initial preference load is the page's
    // initial-load error — NOT a silently assumed default
    // view, and NOT the non-fatal save notice.
    await waitFor(() => {
      expect(
        getByRole('alert'),
      ).toBeInTheDocument()
    })
    expect(
      getByRole('alert').textContent,
    ).toContain("My Work couldn't be loaded")
    expect(
      container.querySelector(
        '[data-board-column]',
      ),
    ).toBeNull()
    expect(
      container.querySelector(
        '[data-my-work-board-skeleton]',
      ),
    ).toBeNull()

    // Retry re-issues BOTH initial loads.
    await act(async () => {
      fireEvent.click(
        getByRole('button', {
          name: /Try again/,
        }),
      )
    })

    await waitFor(() => {
      expect(
        getByText('Prepare samples'),
      ).toBeInTheDocument()
    })
    expect(
      listMyWork,
    ).toHaveBeenCalledTimes(2)
    expect(
      fetchMyWorkPreferences,
    ).toHaveBeenCalledTimes(2)
  })

  it('re-loads preferences on a fresh mount instead of reusing the previous mount\'s in-memory snapshot', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem(),
    ])
    vi.mocked(fetchMyWorkPreferences)
      .mockResolvedValueOnce(
        makePreferences({ viewMode: 'board' }),
      )

    const first = renderPage()
    await waitFor(() => {
      expect(
        first.container.querySelector(
          '[data-board-column]',
        ),
      ).not.toBeNull()
    })
    first.unmount()

    // A fresh authenticated mount (e.g. a different user after
    // logout/login) must load the server preference again.
    vi.mocked(fetchMyWorkPreferences)
      .mockResolvedValueOnce(
        makePreferences({ viewMode: 'list' }),
      )

    const second = renderPage()
    await waitFor(() => {
      expect(
        second.getByText('Work item'),
      ).toBeInTheDocument()
    })

    expect(
      second.container.querySelector(
        '[data-board-column]',
      ),
    ).toBeNull()
    expect(
      fetchMyWorkPreferences,
    ).toHaveBeenCalledTimes(2)
    expect(
      listMyWork,
    ).toHaveBeenCalledTimes(2)
  })
})

// ── Research Group multi-select filter (this slice) ──────────────
// Behavioral coverage for the persistent Research Groups multi-select
// filter over the canonical My Work payload. The selection lives ONLY
// in `preferences.researchGroupIds`; the popover drives it and the
// Board/List/counts/chips are all derived from it.
describe('My Work — Research Group multi-select filter', () => {
  const GROUP_C = 3

  const TWO_GROUPS = [
    { id: GROUP_A, name: 'Research Group A' },
    { id: GROUP_B, name: 'Research Group B' },
  ]

  const THREE_GROUPS = [
    { id: GROUP_A, name: 'Research Group A' },
    { id: GROUP_B, name: 'Research Group B' },
    { id: GROUP_C, name: 'Research Group C' },
  ]

  function groupItems() {
    return [
      makeItem({
        id: 1,
        title: 'Group A one',
        researchGroupId: GROUP_A,
        researchGroupName: 'Research Group A',
        statusCategory: 'todo',
      }),
      makeItem({
        id: 2,
        title: 'Group B one',
        researchGroupId: GROUP_B,
        researchGroupName: 'Research Group B',
        statusCategory: 'todo',
      }),
      makeItem({
        id: 3,
        title: 'Group A two',
        researchGroupId: GROUP_A,
        researchGroupName: 'Research Group A',
        statusCategory: 'in_progress',
      }),
    ]
  }

  // Open the popover once (idempotent guard) and toggle the named
  // group's checkbox. The menu stays open after a selection, so this
  // can be called repeatedly within one open popover.
  async function toggleGroup(
    util: {
      queryByRole: (
        role: string,
        options?: { name?: string | RegExp },
      ) => HTMLElement | null
      getByRole: (
        role: string,
        options?: { name?: string | RegExp },
      ) => HTMLElement
    },
    groupName: string,
  ) {
    const dialogOpen = () =>
      util.queryByRole('dialog', {
        name: 'Research groups',
      }) != null

    if (!dialogOpen()) {
      await act(async () => {
        fireEvent.click(
          util.getByRole('button', {
            name: /Research groups,/,
          }),
        )
      })
    }

    await act(async () => {
      fireEvent.click(
        util.getByRole('checkbox', {
          name: groupName,
        }),
      )
    })
  }

  function columnCount(
    container: HTMLElement,
    category: string,
  ): number {
    const col = container.querySelector(
      `[data-board-column="${category}"]`,
    ) as HTMLElement
    const header =
      col.firstElementChild as HTMLElement
    const countSpan =
      header.lastElementChild as HTMLElement

    return Number(countSpan.textContent)
  }

  it('shows every assigned Work Item when no Research Group is selected', async () => {
    mockGroups = TWO_GROUPS
    vi.mocked(listMyWork).mockResolvedValue(
      groupItems(),
    )

    const { container } = renderPage()

    await waitFor(() => {
      expect(
        container.querySelectorAll(
          '[data-work-item-id]',
        ).length,
      ).toBe(3)
    })
  })

  it('renders the Research groups toolbar toggle with an inactive accessible name', async () => {
    mockGroups = TWO_GROUPS
    vi.mocked(listMyWork).mockResolvedValue(
      groupItems(),
    )

    const { getByRole } = renderPage()

    await waitFor(() => {
      expect(
        getByRole('button', {
          name: 'Research groups, none selected',
        }),
      ).toBeInTheDocument()
    })
  })

  it('uses OR semantics (not AND) across multiple selected groups', async () => {
    mockGroups = THREE_GROUPS
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 1,
        title: 'A one',
        researchGroupId: GROUP_A,
        researchGroupName: 'Research Group A',
        statusCategory: 'todo',
      }),
      makeItem({
        id: 2,
        title: 'B one',
        researchGroupId: GROUP_B,
        researchGroupName: 'Research Group B',
        statusCategory: 'todo',
      }),
      makeItem({
        id: 3,
        title: 'C one',
        researchGroupId: GROUP_C,
        researchGroupName: 'Research Group C',
        statusCategory: 'todo',
      }),
      makeItem({
        id: 4,
        title: 'A two',
        researchGroupId: GROUP_A,
        researchGroupName: 'Research Group A',
        statusCategory: 'todo',
      }),
    ])

    const { container, getByRole, queryByRole } =
      renderPage()

    await waitFor(() => {
      expect(
        container.querySelectorAll(
          '[data-work-item-id]',
        ).length,
      ).toBe(4)
    })

    // Select A and B (menu stays open for the second).
    await toggleGroup(
      { getByRole, queryByRole },
      'Research Group A',
    )
    await toggleGroup(
      { getByRole, queryByRole },
      'Research Group B',
    )

    // OR: A or B visible; C excluded (an AND would be empty).
    await waitFor(() => {
      expect(
        Array.from(
          container.querySelectorAll(
            '[data-work-item-id]',
          ),
        )
          .map((el) =>
            el.getAttribute(
              'data-work-item-id',
            )
          )
          .sort(),
      ).toEqual(['1', '2', '4'])
    })
  })

  it('renders the identical filtered result in the List', async () => {
    mockGroups = TWO_GROUPS
    vi.mocked(listMyWork).mockResolvedValue(
      groupItems(),
    )

    const { getByRole, queryByRole, getByText, queryByText } =
      renderPage()

    await waitFor(() => {
      expect(
        getByRole('button', { name: 'Board' }),
      ).toHaveAttribute('aria-pressed', 'true')
    })

    await toggleGroup(
      { getByRole, queryByRole },
      'Research Group A',
    )
    await switchView({ getByRole }, 'List')

    await waitFor(() => {
      expect(
        getByText('Work item'),
      ).toBeInTheDocument()
    })

    // The List shows exactly the Group A items — the same set the
    // Board shows.
    expect(
      getByText('Group A one'),
    ).toBeInTheDocument()
    expect(
      getByText('Group A two'),
    ).toBeInTheDocument()
    expect(
      queryByText('Group B one'),
    ).toBeNull()
  })

  it('derives the Board column counts from the filtered set', async () => {
    mockGroups = TWO_GROUPS
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 1,
        title: 'A todo 1',
        researchGroupId: GROUP_A,
        researchGroupName: 'Research Group A',
        statusCategory: 'todo',
      }),
      makeItem({
        id: 2,
        title: 'A todo 2',
        researchGroupId: GROUP_A,
        researchGroupName: 'Research Group A',
        statusCategory: 'todo',
      }),
      makeItem({
        id: 3,
        title: 'A in progress',
        researchGroupId: GROUP_A,
        researchGroupName: 'Research Group A',
        statusCategory: 'in_progress',
      }),
      makeItem({
        id: 4,
        title: 'B todo',
        researchGroupId: GROUP_B,
        researchGroupName: 'Research Group B',
        statusCategory: 'todo',
      }),
    ])

    const { container, getByRole, queryByRole } =
      renderPage()

    await waitFor(() => {
      expect(
        container.querySelectorAll(
          '[data-work-item-id]',
        ).length,
      ).toBe(4)
    })

    await toggleGroup(
      { getByRole, queryByRole },
      'Research Group A',
    )

    await waitFor(() => {
      expect(
        columnCount(container, 'todo'),
      ).toBe(2)
    })
    expect(
      columnCount(container, 'in_progress'),
    ).toBe(1)
    expect(
      columnCount(container, 'review'),
    ).toBe(0)
    expect(
      columnCount(container, 'done'),
    ).toBe(0)
  })

  it('does not refetch /api/me/work-items/ when the filter changes', async () => {
    mockGroups = TWO_GROUPS
    vi.mocked(listMyWork).mockResolvedValue(
      groupItems(),
    )

    const { getByRole, queryByRole } = renderPage()

    await waitFor(() => {
      expect(
        getByRole('button', { name: 'Board' }),
      ).toHaveAttribute('aria-pressed', 'true')
    })
    expect(listMyWork).toHaveBeenCalledTimes(1)

    await toggleGroup(
      { getByRole, queryByRole },
      'Research Group A',
    )
    await toggleGroup(
      { getByRole, queryByRole },
      'Research Group B',
    )

    // Two filter changes, still exactly one personal request.
    expect(listMyWork).toHaveBeenCalledTimes(1)
  })

  it('PATCHes the COMPLETE snapshot and preserves projectIds / workItemTypes on an RG change', async () => {
    mockGroups = TWO_GROUPS
    vi.mocked(listMyWork).mockResolvedValue(
      groupItems(),
    )
    // Seed the persisted snapshot with non-empty (not-yet-active)
    // Project / Type selections that an RG change must not touch.
    vi.mocked(fetchMyWorkPreferences).mockResolvedValue(
      makePreferences({
        projectIds: [PROJECT_A],
        workItemTypes: ['task'],
      }),
    )

    const { getByRole, queryByRole } = renderPage()

    await waitFor(() => {
      expect(
        getByRole('button', { name: 'Board' }),
      ).toHaveAttribute('aria-pressed', 'true')
    })

    vi.useFakeTimers()
    try {
      await toggleGroup(
        { getByRole, queryByRole },
        'Research Group A',
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })
    } finally {
      vi.useRealTimers()
    }

    expect(
      updateMyWorkPreferences,
    ).toHaveBeenCalledTimes(1)
    expect(
      vi.mocked(updateMyWorkPreferences)
        .mock.calls[0][0],
    ).toEqual({
      viewMode: 'board',
      researchGroupIds: [GROUP_A],
      projectIds: [PROJECT_A],
      workItemTypes: ['task'],
    })
  })

  it('applies persisted researchGroupIds on the first final render', async () => {
    mockGroups = TWO_GROUPS
    vi.mocked(listMyWork).mockResolvedValue(
      groupItems(),
    )
    vi.mocked(fetchMyWorkPreferences).mockResolvedValue(
      makePreferences({
        researchGroupIds: [GROUP_A],
      }),
    )

    const { container, getByRole } = renderPage()

    // Once the final view resolves, the persisted filter is ALREADY
    // applied — Group B items are never shown.
    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-my-work-board-skeleton]',
        ),
      ).toBeNull()
    })

    expect(
      container.querySelector('[data-work-item-id="1"]'),
    ).not.toBeNull()
    expect(
      container.querySelector('[data-work-item-id="2"]'),
    ).toBeNull()
    expect(
      getByRole('button', {
        name: 'Research groups, 1 selected',
      }),
    ).toBeInTheDocument()
  })

  it('shows no unfiltered final render before a persisted RG filter is known', async () => {
    let resolveItems:
      | ((items: ApiPersonalWorkItem[]) => void)
      | undefined
    let resolvePrefs:
      | ((p: ApiMyWorkPreferences) => void)
      | undefined
    vi.mocked(listMyWork).mockReturnValue(
      new Promise<ApiPersonalWorkItem[]>(
        (resolve) => {
          resolveItems = resolve
        },
      ),
    )
    vi.mocked(fetchMyWorkPreferences).mockReturnValue(
      new Promise<ApiMyWorkPreferences>(
        (resolve) => {
          resolvePrefs = resolve
        },
      ),
    )

    const { container } = renderPage()

    // Neither resolved: skeleton only.
    await act(async () => {
      await Promise.resolve()
    })
    expect(
      container.querySelector(
        '[data-my-work-board-skeleton]',
      ),
    ).not.toBeNull()

    // Items resolved but the persisted filter is still unknown:
    // no final (unfiltered) content may render.
    await act(async () => {
      resolveItems!(groupItems())
    })
    expect(
      container.querySelector(
        '[data-board-column]',
      ),
    ).toBeNull()
    expect(
      container.querySelector(
        '[data-work-item-id]',
      ),
    ).toBeNull()

    // The persisted filter arrives: the FIRST final render is the
    // already-filtered view (Group B never flashes).
    await act(async () => {
      resolvePrefs!(
        makePreferences({
          researchGroupIds: [GROUP_A],
        }),
      )
    })
    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-my-work-board-skeleton]',
        ),
      ).toBeNull()
    })
    expect(
      container.querySelector('[data-work-item-id="1"]'),
    ).not.toBeNull()
    expect(
      container.querySelector('[data-work-item-id="2"]'),
    ).toBeNull()
  })

  it('removes a server-dropped (stale) Research Group from the UI and filtering', async () => {
    mockGroups = TWO_GROUPS
    vi.mocked(listMyWork).mockResolvedValue(
      groupItems(),
    )
    // The server sanitizes the write: Group B is no longer
    // accessible, so it is dropped from the normalized response.
    vi.mocked(updateMyWorkPreferences).mockImplementation(
      async (snapshot: ApiMyWorkPreferences) => ({
        ...snapshot,
        researchGroupIds: snapshot.researchGroupIds.filter(
          (id) => id === GROUP_A,
        ),
      }),
    )

    const { container, getByRole, queryByRole } =
      renderPage()

    await waitFor(() => {
      expect(
        container.querySelectorAll(
          '[data-work-item-id]',
        ).length,
      ).toBe(3)
    })

    vi.useFakeTimers()
    try {
      await toggleGroup(
        { getByRole, queryByRole },
        'Research Group A',
      )
      await toggleGroup(
        { getByRole, queryByRole },
        'Research Group B',
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })
    } finally {
      vi.useRealTimers()
    }

    // Reconciled to the authoritative response: Group B is gone from
    // the chips and from filtering; the toggle count reflects one.
    await waitFor(() => {
      expect(
        getByRole('button', {
          name: 'Research groups, 1 selected',
        }),
      ).toBeInTheDocument()
    })
    expect(
      getByRole('button', {
        name:
          'Remove Research Group filter Research Group A',
      }),
    ).toBeInTheDocument()
    expect(
      queryByRole('button', {
        name:
          'Remove Research Group filter Research Group B',
      }),
    ).toBeNull()
    // Filtering recalculated from the authoritative result.
    expect(
      container.querySelector('[data-work-item-id="1"]'),
    ).not.toBeNull()
    expect(
      container.querySelector('[data-work-item-id="2"]'),
    ).toBeNull()
  })

  it('shows the applied row only while a Research Group filter is active', async () => {
    mockGroups = TWO_GROUPS
    vi.mocked(listMyWork).mockResolvedValue(
      groupItems(),
    )

    const { getByRole, queryByRole } = renderPage()

    await waitFor(() => {
      expect(
        getByRole('button', { name: 'Board' }),
      ).toHaveAttribute('aria-pressed', 'true')
    })

    // No active filter → no applied row.
    expect(
      queryByRole('button', { name: 'Clear filters' }),
    ).toBeNull()

    await toggleGroup(
      { getByRole, queryByRole },
      'Research Group A',
    )

    // Active filter → the applied row (with Clear filters) appears.
    await waitFor(() => {
      expect(
        getByRole('button', { name: 'Clear filters' }),
      ).toBeInTheDocument()
    })
  })

  it('renders a visible applied chip per selected Research Group', async () => {
    mockGroups = TWO_GROUPS
    vi.mocked(listMyWork).mockResolvedValue(
      groupItems(),
    )

    const { getByRole, queryByRole } = renderPage()

    await waitFor(() => {
      expect(
        getByRole('button', { name: 'Board' }),
      ).toHaveAttribute('aria-pressed', 'true')
    })

    await toggleGroup(
      { getByRole, queryByRole },
      'Research Group A',
    )

    await waitFor(() => {
      expect(
        getByRole('button', {
          name:
            'Remove Research Group filter Research Group A',
        }),
      ).toBeInTheDocument()
    })
    // The chip label shows the "FG: <name>" convention.
    expect(
      document.body.textContent,
    ).toContain('FG: Research Group A')
  })

  it('keeps the active toggle count in step with the number selected', async () => {
    mockGroups = TWO_GROUPS
    vi.mocked(listMyWork).mockResolvedValue(
      groupItems(),
    )

    const { getByRole, queryByRole } = renderPage()

    await waitFor(() => {
      expect(
        getByRole('button', {
          name: 'Research groups, none selected',
        }),
      ).toBeInTheDocument()
    })

    await toggleGroup(
      { getByRole, queryByRole },
      'Research Group A',
    )
    await waitFor(() => {
      expect(
        getByRole('button', {
          name: 'Research groups, 1 selected',
        }),
      ).toBeInTheDocument()
    })

    await toggleGroup(
      { getByRole, queryByRole },
      'Research Group B',
    )
    await waitFor(() => {
      expect(
        getByRole('button', {
          name: 'Research groups, 2 selected',
        }),
      ).toBeInTheDocument()
    })
  })

  it('removes only the targeted Research Group when a chip is removed', async () => {
    mockGroups = TWO_GROUPS
    vi.mocked(listMyWork).mockResolvedValue(
      groupItems(),
    )

    const { container, getByRole, queryByRole } =
      renderPage()

    await waitFor(() => {
      expect(
        container.querySelectorAll(
          '[data-work-item-id]',
        ).length,
      ).toBe(3)
    })

    await toggleGroup(
      { getByRole, queryByRole },
      'Research Group A',
    )
    await toggleGroup(
      { getByRole, queryByRole },
      'Research Group B',
    )

    await act(async () => {
      fireEvent.click(
        getByRole('button', {
          name:
            'Remove Research Group filter Research Group A',
        }),
      )
    })

    // Only Group A removed: the Group B chip remains and Group A
    // items are now hidden (Group B items visible).
    await waitFor(() => {
      expect(
        getByRole('button', {
          name:
            'Remove Research Group filter Research Group B',
        }),
      ).toBeInTheDocument()
    })
    expect(
      queryByRole('button', {
        name:
          'Remove Research Group filter Research Group A',
      }),
    ).toBeNull()
    expect(
      container.querySelector('[data-work-item-id="1"]'),
    ).toBeNull()
    expect(
      container.querySelector('[data-work-item-id="2"]'),
    ).not.toBeNull()
  })

  it('clears all selected Research Groups from the popover Clear action', async () => {
    mockGroups = TWO_GROUPS
    vi.mocked(listMyWork).mockResolvedValue(
      groupItems(),
    )

    const { container, getByRole, queryByRole } =
      renderPage()

    await waitFor(() => {
      expect(
        container.querySelectorAll(
          '[data-work-item-id]',
        ).length,
      ).toBe(3)
    })

    await toggleGroup(
      { getByRole, queryByRole },
      'Research Group A',
    )
    await toggleGroup(
      { getByRole, queryByRole },
      'Research Group B',
    )

    // The popover Clear action (exact name, distinct from
    // "Clear filters").
    await act(async () => {
      fireEvent.click(
        getByRole('button', { name: 'Clear' }),
      )
    })

    await waitFor(() => {
      expect(
        container.querySelectorAll(
          '[data-work-item-id]',
        ).length,
      ).toBe(3)
    })
    expect(
      getByRole('button', {
        name: 'Research groups, none selected',
      }),
    ).toBeInTheDocument()
  })

  it('Clear filters removes the RG filter without zeroing projectIds / workItemTypes', async () => {
    mockGroups = TWO_GROUPS
    vi.mocked(listMyWork).mockResolvedValue(
      groupItems(),
    )
    vi.mocked(fetchMyWorkPreferences).mockResolvedValue(
      makePreferences({
        researchGroupIds: [GROUP_A],
        projectIds: [PROJECT_A],
        workItemTypes: ['task'],
      }),
    )

    const { getByRole } = renderPage()

    await waitFor(() => {
      expect(
        getByRole('button', { name: 'Clear filters' }),
      ).toBeInTheDocument()
    })

    vi.useFakeTimers()
    try {
      await act(async () => {
        fireEvent.click(
          getByRole('button', { name: 'Clear filters' }),
        )
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })
    } finally {
      vi.useRealTimers()
    }

    // The snapshot sent clears ONLY researchGroupIds; the not-yet-
    // active project / type selections are preserved untouched.
    expect(
      vi.mocked(updateMyWorkPreferences)
        .mock.calls[0][0],
    ).toEqual({
      viewMode: 'board',
      researchGroupIds: [],
      projectIds: [PROJECT_A],
      workItemTypes: ['task'],
    })
  })

  it('shows the current filtered result count in the applied row', async () => {
    mockGroups = TWO_GROUPS
    vi.mocked(listMyWork).mockResolvedValue(
      groupItems(),
    )

    const { getByRole, queryByRole, getByText } =
      renderPage()

    await waitFor(() => {
      expect(
        getByRole('button', { name: 'Board' }),
      ).toHaveAttribute('aria-pressed', 'true')
    })

    await toggleGroup(
      { getByRole, queryByRole },
      'Research Group A',
    )

    // Two Group A items → "2 work items".
    await waitFor(() => {
      expect(
        getByText('2 work items'),
      ).toBeInTheDocument()
    })
  })

  it('shows the filtered-empty state when an active filter yields zero items', async () => {
    mockGroups = TWO_GROUPS
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 1,
        title: 'Group A one',
        researchGroupId: GROUP_A,
        researchGroupName: 'Research Group A',
        statusCategory: 'todo',
      }),
    ])

    const { container, getByRole, queryByRole } =
      renderPage()

    await waitFor(() => {
      expect(
        container.querySelector('[data-work-item-id="1"]'),
      ).not.toBeNull()
    })

    // Select the group that holds no assigned items.
    await toggleGroup(
      { getByRole, queryByRole },
      'Research Group B',
    )

    await waitFor(() => {
      expect(
        document.body.textContent,
      ).toContain(
        'No work items match these filters.',
      )
    })
    // The active filter is never hidden: the applied chip remains.
    expect(
      getByRole('button', {
        name:
          'Remove Research Group filter Research Group B',
      }),
    ).toBeInTheDocument()
    // All four Board lanes stay visible with counts of 0.
    for (
      const category of [
        'todo',
        'in_progress',
        'review',
        'done',
      ]
    ) {
      expect(
        columnCount(container, category),
      ).toBe(0)
    }
  })

  it('restores items when Clear filters is used on a zero-result filter', async () => {
    mockGroups = TWO_GROUPS
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 1,
        title: 'Group A one',
        researchGroupId: GROUP_A,
        researchGroupName: 'Research Group A',
        statusCategory: 'todo',
      }),
    ])

    const { container, getByRole, queryByRole } =
      renderPage()

    await waitFor(() => {
      expect(
        container.querySelector('[data-work-item-id="1"]'),
      ).not.toBeNull()
    })

    await toggleGroup(
      { getByRole, queryByRole },
      'Research Group B',
    )
    await waitFor(() => {
      expect(
        document.body.textContent,
      ).toContain(
        'No work items match these filters.',
      )
    })

    // Click the "Clear filters" inside the filtered-empty state
    // (scoped, since the applied row carries its own Clear filters).
    const emptyStateHeading = getByRole('heading', {
      name: 'No work items match these filters.',
    })
    await act(async () => {
      fireEvent.click(
        within(emptyStateHeading.parentElement as HTMLElement)
          .getByRole('button', {
            name: 'Clear filters',
          }),
      )
    })

    await waitFor(() => {
      expect(
        container.querySelector('[data-work-item-id="1"]'),
      ).not.toBeNull()
    })
    expect(
      document.body.textContent,
    ).not.toContain(
      'No work items match these filters.',
    )
  })

  it('omits the search field at eight or fewer available groups', async () => {
    mockGroups = TWO_GROUPS
    vi.mocked(listMyWork).mockResolvedValue(
      groupItems(),
    )

    const { getByRole, queryByRole } = renderPage()

    await waitFor(() => {
      expect(
        getByRole('button', { name: 'Board' }),
      ).toHaveAttribute('aria-pressed', 'true')
    })

    await act(async () => {
      fireEvent.click(
        getByRole('button', {
          name: 'Research groups, none selected',
        }),
      )
    })

    expect(
      queryByRole('searchbox', {
        name: 'Search research groups',
      }),
    ).toBeNull()
  })

  it('shows a search field above eight groups that filters the options', async () => {
    mockGroups = Array.from(
      { length: 9 },
      (_, index) => ({
        id: index + 1,
        name: `Group ${index + 1}`,
      }),
    )
    vi.mocked(listMyWork).mockResolvedValue([])

    const { getByRole, queryByRole } = renderPage()

    await waitFor(() => {
      expect(
        getByRole('button', { name: 'Board' }),
      ).toHaveAttribute('aria-pressed', 'true')
    })

    await act(async () => {
      fireEvent.click(
        getByRole('button', {
          name: 'Research groups, none selected',
        }),
      )
    })

    const search = getByRole('searchbox', {
      name: 'Search research groups',
    })
    expect(search).toBeInTheDocument()

    // All nine options render initially.
    expect(
      getByRole('checkbox', { name: 'Group 1' }),
    ).toBeInTheDocument()
    expect(
      getByRole('checkbox', { name: 'Group 9' }),
    ).toBeInTheDocument()

    // The search query is transient local filtering.
    await act(async () => {
      fireEvent.change(search, {
        target: { value: 'Group 9' },
      })
    })
    expect(
      getByRole('checkbox', { name: 'Group 9' }),
    ).toBeInTheDocument()
    expect(
      queryByRole('checkbox', { name: 'Group 1' }),
    ).toBeNull()
    expect(
      queryByRole('checkbox', { name: 'Group 2' }),
    ).toBeNull()
  })

  it('keeps the multiselect menu open after a checkbox selection', async () => {
    mockGroups = TWO_GROUPS
    vi.mocked(listMyWork).mockResolvedValue(
      groupItems(),
    )

    const { getByRole, queryByRole } = renderPage()

    await waitFor(() => {
      expect(
        getByRole('button', { name: 'Board' }),
      ).toHaveAttribute('aria-pressed', 'true')
    })

    await act(async () => {
      fireEvent.click(
        getByRole('button', {
          name: 'Research groups, none selected',
        }),
      )
    })
    expect(
      getByRole('dialog', { name: 'Research groups' }),
    ).toBeInTheDocument()

    // Selecting a group does NOT close the menu (no Apply button).
    await act(async () => {
      fireEvent.click(
        getByRole('checkbox', {
          name: 'Research Group A',
        }),
      )
    })
    expect(
      queryByRole('dialog', { name: 'Research groups' }),
    ).not.toBeNull()
    // The second option is still reachable in the same open menu.
    expect(
      getByRole('checkbox', { name: 'Research Group B' }),
    ).toBeInTheDocument()
  })

  it('collapses more than six selections into the first two chips plus a +N summary', async () => {
    const seven = Array.from(
      { length: 7 },
      (_, index) => ({
        id: index + 1,
        name: `Group ${index + 1}`,
      }),
    )
    mockGroups = seven
    vi.mocked(listMyWork).mockResolvedValue([])
    vi.mocked(fetchMyWorkPreferences).mockResolvedValue(
      makePreferences({
        researchGroupIds: [1, 2, 3, 4, 5, 6, 7],
      }),
    )

    const { getByRole, queryByRole } = renderPage()

    await waitFor(() => {
      expect(
        getByRole('button', {
          name: 'Research groups, 7 selected',
        }),
      ).toBeInTheDocument()
    })

    // First two individual chips...
    expect(
      getByRole('button', {
        name: 'Remove Research Group filter Group 1',
      }),
    ).toBeInTheDocument()
    expect(
      getByRole('button', {
        name: 'Remove Research Group filter Group 2',
      }),
    ).toBeInTheDocument()
    // ...and the remainder collapsed into a single +N summary.
    expect(
      queryByRole('button', {
        name: 'Remove Research Group filter Group 3',
      }),
    ).toBeNull()
    expect(
      getByRole('button', {
        name: 'Research groups: +5',
      }),
    ).toBeInTheDocument()
  })

  it('keeps the locally filtered state and shows the save warning when the save fails', async () => {
    mockGroups = TWO_GROUPS
    vi.mocked(listMyWork).mockResolvedValue(
      groupItems(),
    )
    vi.mocked(updateMyWorkPreferences).mockRejectedValue(
      new ApiError(500, 'oops'),
    )

    const { container, getByRole, queryByRole } =
      renderPage()

    await waitFor(() => {
      expect(
        container.querySelectorAll(
          '[data-work-item-id]',
        ).length,
      ).toBe(3)
    })

    vi.useFakeTimers()
    try {
      await toggleGroup(
        { getByRole, queryByRole },
        'Research Group A',
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })
    } finally {
      vi.useRealTimers()
    }

    // The local filter is KEPT (Group B item hidden)...
    expect(
      container.querySelector('[data-work-item-id="2"]'),
    ).toBeNull()
    expect(
      container.querySelector('[data-work-item-id="1"]'),
    ).not.toBeNull()
    // ...and the established non-fatal save notice is shown.
    expect(
      document.body.textContent,
    ).toContain(
      "Couldn't save your My Work preferences.",
    )
  })

  it('closes the popover with Escape and returns focus to the toggle', async () => {
    mockGroups = TWO_GROUPS
    vi.mocked(listMyWork).mockResolvedValue(
      groupItems(),
    )

    const { getByRole } = renderPage()

    const toggle =
      (await waitFor(() =>
        getByRole('button', {
          name: 'Research groups, none selected',
        }),
      )) as HTMLButtonElement

    // A native <button>: Tab focusable and Enter/Space activatable
    // by the browser (the popover opens on activation).
    expect(toggle.tagName).toBe('BUTTON')
    expect(toggle).toHaveAttribute('type', 'button')

    // Open (activation) — the popover is a labeled dialog.
    fireEvent.click(toggle)
    await waitFor(() => {
      expect(
        getByRole('dialog', { name: 'Research groups' }),
      ).toBeInTheDocument()
    })

    // Escape closes and returns focus to the toggle.
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => {
      expect(
        document.querySelector('[role="dialog"]'),
      ).toBeNull()
    })
    expect(document.activeElement).toBe(toggle)
  })
})
