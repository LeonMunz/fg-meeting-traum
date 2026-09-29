// @vitest-environment happy-dom

// Focused regression guard: long Work Item titles must never change
// the My Work Board card or column geometry. The approved My Work
// card size (min-h-[88px], px-3 py-2.5, existing typography) stays
// unchanged; the title stays one visual line with ellipsis, the
// board keeps its standard minmax(260px, 1fr) tracks, and the grid
// carries NO intrinsic (max-content) width floor that a very long
// unbroken title could inflate.
//
// The unit environment has no layout engine, so the geometry is
// pinned as a DOM contract: the grid classes, the track template,
// the card classes, and the title classes must stay exactly the
// approved standard for short, spaced, and unbroken titles alike —
// which is what makes the rendered card pixel-identical across
// title lengths.

import {
  cleanup,
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
  fetchMyWorkPreferences,
  updateMyWorkPreferences,
} from '../../api/my-work-preferences'
import { listMyWork } from '../../api/work-items'
import type {
  ApiMyWorkPreferences,
  ApiPersonalWorkItem,
} from '../../api/types'

import { MyWorkPage } from './MyWorkPage'

// The page must talk to exactly one personal endpoint and must NOT
// fan out to per-Project / per-Research-Group requests. Mock the
// whole API surface so any stray call is a test failure (same
// boundary as the main My Work suite).
vi.mock('../../api/work-items', () => ({
  listMyWork: vi.fn(),
  reorderMyWorkItem: vi.fn(),
  transitionWorkItemStatus: vi.fn(),
  updateWorkItem: vi.fn(),
  createWorkItem: vi.fn(),
  deleteWorkItem: vi.fn(),
  listProjectWorkItems: vi.fn(),
}))

vi.mock('../../api/my-work-preferences', () => ({
  fetchMyWorkPreferences: vi.fn(),
  updateMyWorkPreferences: vi.fn(),
}))

vi.mock('../../api/projects', () => ({
  getProject: vi.fn(),
  getProjectWorkItemConfiguration: vi.fn(),
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

// The drawer is covered by its own suites; the page under test must
// mount the canonical module, stubbed at the module boundary.
vi.mock('../projects/WorkItemDrawer', () => ({
  WorkItemDrawer: () => null,
}))

vi.mock('../research-group/useResearchGroup', () => ({
  useResearchGroup: () => ({ groups: [] }),
}))

const SHORT_TITLE = 'Prepare samples'
// Far longer than a standard column, but broken into words.
const SPACED_TITLE =
  'Quarterly lab equipment calibration review with the research group safety committee and external auditors'
// 100 characters, no spaces: far wider than a standard column.
const UNBROKEN_TITLE =
  'interoperabilitaetsuntersuchungsergebnisberichtedatenvergleichsprotokolldokumentationsergebnisse2026'

function makeItem(
  overrides: Partial<ApiPersonalWorkItem> = {},
): ApiPersonalWorkItem {
  return {
    id: 100,
    projectId: 7,
    title: SHORT_TITLE,
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
    researchGroupId: 1,
    researchGroupName: 'Research Group A',
    typeName: 'Sample Batch',
    statusName: 'Ready for Lab',
    statusCategory: 'todo',
    typeKind: null,
    statusTargets: [],
    // Unpositioned by default (no personal board row yet).
    myWorkBoardPosition: null,
    ...overrides,
  } as ApiPersonalWorkItem
}

const BOARD_PREFERENCES: ApiMyWorkPreferences = {
  viewMode: 'board',
  researchGroupIds: [],
  projectIds: [],
  workItemTypes: [],
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/my-work']}>
      <Routes>
        <Route
          path="/my-work"
          element={<MyWorkPage />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

async function renderBoard(
  items: ApiPersonalWorkItem[],
) {
  vi.mocked(fetchMyWorkPreferences).mockResolvedValue(
    BOARD_PREFERENCES,
  )
  vi.mocked(updateMyWorkPreferences).mockImplementation(
    async (snapshot: ApiMyWorkPreferences) =>
      snapshot,
  )
  vi.mocked(listMyWork).mockResolvedValue(items)

  const utils = renderPage()

  // Four semantic lanes = the real board (not the skeleton, not
  // the List) has rendered.
  await waitFor(() => {
    expect(
      utils.container.querySelectorAll(
        '[data-board-column]',
      ).length,
    ).toBe(4)
  })

  return utils
}

// The grid that lays out the board columns: the parent of any
// semantic column.
function boardGrid(
  container: HTMLElement,
): HTMLElement {
  const column =
    container.querySelector('[data-board-column]')
  expect(column).not.toBeNull()
  return column!.parentElement as HTMLElement
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('My Work Board card title length contract', () => {
  it('keeps no intrinsic width floor and the standard track contract on the final board', async () => {
    const { container } = await renderBoard([
      makeItem({ id: 1, title: SHORT_TITLE }),
      makeItem({ id: 2, title: UNBROKEN_TITLE }),
    ])

    const grid = boardGrid(container)

    // The grid must not use its content's intrinsic (max-content)
    // width as a floor: that rule is what lets a very long unbroken
    // title inflate every column track.
    expect(grid.className).not.toContain('min-w-max')
    // The standard column track sizing, card gap, and top-aligned
    // lanes stay unchanged.
    expect(grid.className).toContain('grid')
    expect(grid.className).toContain('items-start')
    expect(grid.className).toContain('gap-3')
    expect(grid.style.gridTemplateColumns).toBe(
      'repeat(4, minmax(260px, 1fr))',
    )

    // The horizontal-scroll wrapper for narrow layouts stays, so
    // narrow viewports scroll the board, not the document.
    const scroller = container.querySelector(
      '[data-testid="my-work-board-scroller"]',
    ) as HTMLElement
    expect(scroller).not.toBeNull()
    expect(scroller.className).toContain(
      'overflow-x-auto',
    )
  })

  it('keeps the approved card geometry contract for short, spaced, and unbroken titles', async () => {
    const { container } = await renderBoard([
      makeItem({ id: 1, title: SHORT_TITLE }),
      makeItem({ id: 2, title: SPACED_TITLE }),
      makeItem({ id: 3, title: UNBROKEN_TITLE }),
    ])

    const cards = [
      container.querySelector(
        '[data-work-item-id="1"]',
      ),
      container.querySelector(
        '[data-work-item-id="2"]',
      ),
      container.querySelector(
        '[data-work-item-id="3"]',
      ),
    ] as HTMLElement[]

    const [
      shortCard,
      spacedCard,
      unbrokenCard,
    ] = cards

    for (const card of cards) {
      expect(card).not.toBeNull()
    }

    // Title length must not change the card contract: every card
    // carries the identical approved geometry classes.
    expect(spacedCard.className).toBe(
      shortCard.className,
    )
    expect(unbrokenCard.className).toBe(
      shortCard.className,
    )

    for (const card of cards) {
      // Approved My Work standard: min height and padding stay
      // unchanged (no new fixed height, no padding drift).
      expect(card.className).toContain('min-h-[88px]')
      expect(card.className).toContain('px-3 py-2.5')

      // The title keeps the one-line ellipsis contract
      // (overflow: hidden; text-overflow: ellipsis; white-space:
      // nowrap) and the existing typography.
      const title = within(card).getByRole(
        'heading',
        { level: 3 },
      )
      expect(title.className).toContain('truncate')
      expect(title.className).toContain('min-w-0 flex-1')
      expect(title.className).toContain(
        'text-[13px] font-semibold leading-[18px]',
      )
    }

    // Identical title contract across all three lengths.
    const shortTitle = within(shortCard).getByRole(
      'heading',
      { level: 3 },
    )
    expect(
      within(spacedCard)
        .getByRole('heading', { level: 3 })
        .className,
    ).toBe(shortTitle.className)
    expect(
      within(unbrokenCard)
        .getByRole('heading', { level: 3 })
        .className,
    ).toBe(shortTitle.className)
  })

  it('keeps the complete stored title in the card accessible contract', async () => {
    await renderBoard([
      makeItem({ id: 1, title: SHORT_TITLE }),
      makeItem({ id: 2, title: SPACED_TITLE }),
      makeItem({ id: 3, title: UNBROKEN_TITLE }),
    ])

    // Matching by the COMPLETE title proves the stored title is
    // not truncated anywhere in the card's accessible contract —
    // opening the card still exposes the full stored title.
    expect(
      screen.getByRole('button', {
        name: `Open ${SHORT_TITLE}`,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: `Open ${SPACED_TITLE}`,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: `Open ${UNBROKEN_TITLE}`,
      }),
    ).toBeInTheDocument()
  })

  it('keeps the loading skeleton geometry consistent with the final board', async () => {
    vi.mocked(fetchMyWorkPreferences).mockResolvedValue(
      BOARD_PREFERENCES,
    )
    vi.mocked(listMyWork).mockReturnValue(
      new Promise<ApiPersonalWorkItem[]>(() => {}),
    )

    const { container } = renderPage()

    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-my-work-board-skeleton]',
        ),
      ).not.toBeNull()
    })

    const column = container.querySelector(
      '[data-my-work-skeleton-column]',
    )
    expect(column).not.toBeNull()
    const grid = column!.parentElement as HTMLElement

    // Same track contract and NO intrinsic width floor as the
    // final board, so loading -> final render changes no board
    // geometry.
    expect(grid.className).not.toContain('min-w-max')
    expect(grid.className).toContain('grid')
    expect(grid.className).toContain('items-start')
    expect(grid.className).toContain('gap-3')
    expect(grid.style.gridTemplateColumns).toBe(
      'repeat(4, minmax(260px, 1fr))',
    )
  })
})
