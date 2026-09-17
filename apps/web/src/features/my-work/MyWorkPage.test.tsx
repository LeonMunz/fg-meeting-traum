// @vitest-environment happy-dom

import {
  act,
  cleanup,
  fireEvent,
  render,
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
  useParams,
} from 'react-router'

import {
  getProjectWorkItemConfiguration,
  getProject,
} from '../../api/projects'
import { listMyWork } from '../../api/work-items'
import type {
  ApiPersonalWorkItem,
} from '../../api/types'

import { MyWorkPage } from './MyWorkPage'

// The page must talk to exactly one personal endpoint and must NOT
// fan out to per-Project / per-Research-Group requests to render
// status, type, or names. Mock the whole API surface so any stray
// call is a test failure.
vi.mock('../../api/work-items', () => ({
  listMyWork: vi.fn(),
}))

vi.mock('../../api/projects', () => ({
  getProjectWorkItemConfiguration: vi.fn(),
  getProject: vi.fn(),
  listProjectMemberships: vi.fn(),
  listResearchGroupMembers: vi.fn(),
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
    statusTargets: [],
    ...overrides,
  } as ApiPersonalWorkItem
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

// Click the presentation-only List/Kanban switch. The two buttons
// expose their view name as the accessible name (the icon is
// aria-hidden).
async function switchView(
  util: {
    getByRole: (
      role: string,
      options?: { name?: string | RegExp },
    ) => HTMLElement
  },
  label: 'Kanban' | 'List',
) {
  await act(async () => {
    fireEvent.click(
      util.getByRole('button', { name: label }),
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

    const { getByText } = renderPage()

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

    const { queryByText, getByRole } =
      renderPage()

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

    const { getByText, getByRole } =
      renderPage()

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
  it('renders a loading state while the personal endpoint is in flight', async () => {
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

    const { getByText, queryByText } =
      renderPage()

    await act(async () => {
      await Promise.resolve()
    })

    expect(
      getByText('Loading your work…'),
    ).toBeInTheDocument()
    expect(
      queryByText('Prepare samples'),
    ).toBeNull()

    await act(async () => {
      resolveList!([])
    })

    await waitFor(() => {
      expect(
        queryByText('Loading your work…'),
      ).toBeNull()
    })
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
  it('opens an item via the canonical Project Work Items interaction', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 100,
        projectId: PROJECT_A,
      }),
    ])

    const { getByRole } = renderPage()

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

    await switchView({ getByRole }, 'Kanban')
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

    await switchView({ getByRole }, 'Kanban')
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

    const { container, getByText } = renderPage()

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

    // Both concrete status names remain visible.
    expect(getByText('Ready for Lab')).toBeInTheDocument()
    expect(getByText('On the Bench')).toBeInTheDocument()
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

  it('keeps an empty semantic column visible with a quiet empty state', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        statusCategory: 'todo',
      }),
    ])

    const { container, getAllByText } =
      renderPage()

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
    expect(getAllByText('No items').length).toBe(3)
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

describe('My Work Kanban — card content', () => {
  it('shows type, concrete status, Project, and Research Group', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 100,
        title: 'Prepare samples',
        typeName: 'Sample Batch',
        statusName: 'Ready for Lab',
        projectName: 'Project Alpha',
        researchGroupName: 'Research Group A',
      }),
    ])

    const { container, getByText } = renderPage()

    await waitFor(() => {
      expect(
        getByText('Prepare samples'),
      ).toBeInTheDocument()
    })

    const card = container.querySelector(
      '[data-work-item-id="100"]',
    )

    // Concrete project-local type name.
    expect(card?.textContent).toContain('Sample Batch')
    // Concrete project-local status name.
    expect(getByText('Ready for Lab')).toBeInTheDocument()
    // Cross-Project + cross-Research-Group context.
    expect(getByText('Project Alpha')).toBeInTheDocument()
    expect(getByText('Research Group A')).toBeInTheDocument()
  })

  it('keeps the due state visible on the card', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        dueDate: isoDaysFromNow(1),
      }),
    ])

    const { getByText } = renderPage()

    await waitFor(() => {
      expect(getByText('Tomorrow')).toBeInTheDocument()
    })
  })

  it('renders an overdue due with the attention convention', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        dueDate: isoDaysFromNow(-3),
        statusCategory: 'todo',
      }),
    ])

    const { getByText } = renderPage()

    await waitFor(() => {
      expect(getByText('3d overdue')).toBeInTheDocument()
    })
  })

  it('keeps the blocked state visible on the card', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        blockedReason: 'Waiting on reagents',
      }),
    ])

    const { getByText } = renderPage()

    await waitFor(() => {
      expect(getByText('· Blocked')).toBeInTheDocument()
    })
  })
})

describe('My Work Kanban — interaction, filter, and contract', () => {
  it('opens a card via the canonical Project Work Items interaction', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 100,
        projectId: PROJECT_A,
      }),
    ])

    const { getByRole } = renderPage()

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
  })

  it('opens a card with the keyboard (Enter)', async () => {
    vi.mocked(listMyWork).mockResolvedValue([
      makeItem({
        id: 100,
        projectId: PROJECT_A,
      }),
    ])

    const { getByRole } = renderPage()

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
        document.querySelector(
          '[data-testid="work-items-target"]',
        ),
      ).toHaveAttribute(
        'data-project-id',
        String(PROJECT_A),
      )
    })
  })

  it('applies the Research Group filter to the Kanban', async () => {
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

    const { container, getByLabelText } =
      renderPage()

    await waitFor(() => {
      expect(
        container.querySelectorAll(
          '[data-work-item-id]',
        ).length,
      ).toBe(2)
    })

    fireEvent.change(
      getByLabelText('Filter by research group'),
      { target: { value: String(GROUP_A) } },
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
  })

  it('preserves the Research Group filter selection across List/Kanban switching', async () => {
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
      getByLabelText,
    } = renderPage()

    await waitFor(() => {
      expect(
        container.querySelectorAll(
          '[data-work-item-id]',
        ).length,
      ).toBe(2)
    })

    // Filter to Group A while in the Kanban.
    fireEvent.change(
      getByLabelText('Filter by research group'),
      { target: { value: String(GROUP_A) } },
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

    // Switch back to Kanban — still filtered.
    await switchView({ getByRole }, 'Kanban')
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
