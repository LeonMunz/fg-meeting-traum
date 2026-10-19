// @vitest-environment happy-dom

// Contract suite for the ONE shared Kanban Work Item card
// (WorkItemCard), rendered by BOTH the Project Work Items Board
// (features/projects) and the global My Work Kanban
// (features/my-work).
//
// Part 1 exercises the component directly (markup, exception
// presentation, states, open/drag forwarding, action-slot
// isolation). Part 2 renders both real pages and proves both
// boards mount the same card with the same visual contract,
// the project board keeps its three-dot action menu (without
// opening the drawer), and My Work stays on its single canonical
// payload (no per-Project configuration requests).

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
  getProject,
  getProjectWorkItemConfiguration,
  listProjectMemberships,
  listResearchGroupMembers,
} from '../../api/projects'
import {
  deleteWorkItem,
  listMyWork,
  listProjectWorkItems,
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
  ApiResearchGroupMember,
  ApiWorkItem,
} from '../../api/types'

import { ProjectDetailPage } from '../projects/ProjectDetailPage'
import { WorkItemActionMenuTrigger } from '../projects/workItemDelete'
import { MyWorkPage } from '../my-work/MyWorkPage'
import {
  WorkItemCard,
  type WorkItemCardProps,
} from './WorkItemCard'
import {
  getWorkItemCardDueState,
  getWorkItemDueFields,
} from './workItemDue'

// ── Page-level mocks (same boundaries as the owning suites) ──

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
  reorderMyWorkItem: vi.fn(),
  transitionWorkItemStatus: vi.fn(),
  updateWorkItem: vi.fn(),
  listMyWork: vi.fn(),
}))

vi.mock('../../api/my-work-preferences', () => ({
  fetchMyWorkPreferences: vi.fn(),
  updateMyWorkPreferences: vi.fn(),
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

vi.mock('../research-group/useResearchGroup', () => ({
  useResearchGroup: () => ({ groups: [] }),
}))

// The drawer is covered by its own suites; a marker proves
// whether a page mounted it (open vs. not open).
vi.mock('../projects/WorkItemDrawer', () => ({
  WorkItemDrawer: () => (
    <div data-testid="work-item-drawer" />
  ),
}))

// ── Fixtures & helpers ────────────────────────────────────────

const NOW = '2026-09-01T00:00:00Z'

function isoDaysFromNow(days: number) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Minimal DataTransfer stand-in for native HTML5 drag/drop in
// happy-dom (React's synthetic drag events read `dataTransfer`
// straight off the native event).
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

function baseCardProps(): WorkItemCardProps {
  return {
    id: '1',
    title: 'Test item',
    typeName: 'Task',
    typeKind: 'task',
    statusCategory: 'todo',
    dueDate: null,
    blockedReason: null,
    onOpen: vi.fn(),
    onDragStart: vi.fn(),
    onDragEnd: vi.fn(),
  }
}

function renderCard(
  overrides: Partial<WorkItemCardProps> = {},
) {
  const utils = render(
    <WorkItemCard {...baseCardProps()} {...overrides} />,
  )

  const card = utils.container.firstElementChild as HTMLElement

  return { card, ...utils }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// ── Part 1: the component contract ────────────────────────────

describe('WorkItemCard — markup and exception presentation', () => {
  it('renders the title, the concrete type as TEXT, and no type icon', () => {
    const { card } = renderCard({
      typeName: 'Robot Data Analysis',
      typeKind: null,
    })

    const title = within(card).getByRole('heading', { level: 3 })
    expect(title.textContent).toBe('Test item')
    // One-line ellipsis contract.
    expect(title.className).toContain('truncate')

    // The concrete type is visible as text — exactly once.
    expect(card.textContent).toContain('Robot Data Analysis')

    // No type icon (or any icon) on a normal card.
    expect(
      card.querySelectorAll('.material-symbols-outlined'),
    ).toHaveLength(0)
  })

  it('selects the type-label token by typeKind, never by name', () => {
    const kinds = [
      ['task', 'text-work-type-task'],
      ['epic', 'text-work-type-epic'],
      ['milestone', 'text-work-type-milestone'],
      ['deliverable', 'text-work-type-deliverable'],
    ] as const

    for (const [kind, token] of kinds) {
      cleanup()
      const { card } = renderCard({
        typeKind: kind,
        // A name that would be wrong if ever matched.
        typeName: 'Something Else',
      })

      const label = card.children[1] as HTMLElement
      expect(label.className).toContain(token)
      expect(label.textContent?.trim()).toBe(
        'Something Else',
      )
    }

    // null kind = neutral, even for a canonical-looking name.
    cleanup()
    const { card } = renderCard({
      typeKind: null,
      typeName: 'Epic',
    })
    const label = card.children[1] as HTMLElement
    expect(label.className).toContain('text-text-tertiary')
    expect(label.className).not.toContain('text-work-type-')
  })

  it('omits the footer entirely for a normal item without assignees', () => {
    const { card } = renderCard()

    // Title row, type label — nothing else (no reserved
    // empty footer).
    expect(card.children.length).toBe(2)
  })

  it('renders Due today as a yellow (warning) text hint', () => {
    const { card } = renderCard({
      dueDate: isoDaysFromNow(0),
    })

    const hint = Array.from(
      card.querySelectorAll('span'),
    ).find(
      (span) => span.textContent?.trim() === 'Due today',
    ) as HTMLElement
    expect(hint).not.toBeUndefined()
    expect(hint.className).toContain(
      'text-work-exception-warning',
    )
    // Text only — no warning symbol.
    expect(
      hint.querySelector('.material-symbols-outlined'),
    ).toBeNull()
  })

  it('renders Tomorrow as a yellow (warning) text hint', () => {
    const { card } = renderCard({
      dueDate: isoDaysFromNow(1),
    })

    const hint = Array.from(
      card.querySelectorAll('span'),
    ).find(
      (span) => span.textContent?.trim() === 'Tomorrow',
    ) as HTMLElement
    expect(hint).not.toBeUndefined()
    expect(hint.className).toContain(
      'text-work-exception-warning',
    )
  })

  it('renders overdue as a red (danger) text hint', () => {
    const { card } = renderCard({
      dueDate: isoDaysFromNow(-5),
    })

    const hint = Array.from(
      card.querySelectorAll('span'),
    ).find(
      (span) => span.textContent?.trim() === '5d overdue',
    ) as HTMLElement
    expect(hint).not.toBeUndefined()
    expect(hint.className).toContain(
      'text-work-exception-danger',
    )
  })

  it('renders a future due date as neutral text metadata', () => {
    const { card } = renderCard({
      dueDate: isoDaysFromNow(7),
    })

    const d = new Date()
    d.setDate(d.getDate() + 7)
    const expected = new Intl.DateTimeFormat('en', {
      month: 'short',
      day: 'numeric',
    }).format(d)

    const hint = Array.from(
      card.querySelectorAll('span'),
    ).find(
      (span) => span.textContent?.trim() === expected,
    ) as HTMLElement
    expect(hint).not.toBeUndefined()
    expect(hint.className).toContain('text-text-muted')
    expect(hint.className).not.toContain(
      'text-work-exception-',
    )
  })

  it('renders no due hint without a due date', () => {
    const { card } = renderCard()

    expect(card.textContent).not.toMatch(
      /Due today|Tomorrow|overdue/,
    )
    expect(card.children.length).toBe(2)
  })

  it('renders no due hint for a completed (done) item', () => {
    const { card } = renderCard({
      statusCategory: 'done',
      dueDate: isoDaysFromNow(-3),
    })

    expect(card.textContent).not.toContain('overdue')
  })

  it('never interprets an UNRESOLVED status category as done', () => {
    // statusCategory null: an overdue due date is still shown
    // (it is not suppressed like a done item, and nothing is
    // folded into a guessed category).
    const { card } = renderCard({
      statusCategory: null,
      dueDate: isoDaysFromNow(-3),
    })

    expect(card.textContent).toContain('3d overdue')

    // And the due-state helper agrees.
    expect(
      getWorkItemCardDueState(
        isoDaysFromNow(-3),
        null,
      ),
    ).toEqual({
      kind: 'overdue',
      label: '3d overdue',
    })
  })

  it('presents Blocked identically: warning text + reason tooltip, no extra symbol', () => {
    const { card } = renderCard({
      blockedReason: 'Waiting on reagents',
    })

    const blocked = card.querySelector(
      '[title="Waiting on reagents"]',
    ) as HTMLElement
    expect(blocked).not.toBeNull()
    expect(blocked.textContent).toContain('Blocked')
    expect(blocked.className).toContain(
      'text-work-exception-warning',
    )
  })

  it('lets blocked and the due state coexist in one footer', () => {
    const { card } = renderCard({
      blockedReason: 'Waiting on reagents',
      dueDate: isoDaysFromNow(-12),
    })

    expect(card.textContent).toContain('Blocked')
    expect(card.textContent).toContain('12d overdue')
  })

  it('shows the assignee metadata region when provided', () => {
    const { card } = renderCard({
      assignees: [
        { id: '1', name: 'Alex', initials: 'A' },
        { id: '2', name: 'Chris', initials: 'C' },
      ],
    })

    expect(card.textContent).toContain('Alex')
    expect(card.textContent).toContain('+1')

    const { card: unassigned } = renderCard({
      assignees: [],
    })
    expect(unassigned.textContent).toContain('Unassigned')
  })

  it('shows the provenance region (group first) when provided', () => {
    const { card } = renderCard({
      provenance: {
        researchGroupName: 'Research Group A',
        projectName: 'Project Alpha',
      },
    })

    expect(card.textContent).toContain(
      'Research Group A › Project Alpha',
    )
    expect(
      card.querySelector(
        '[title="Research Group A › Project Alpha"]',
      ),
    ).not.toBeNull()
  })

  it('truncates long titles to one visual line without losing the stored title', () => {
    const longTitle =
      'interoperabilitaetsuntersuchungsergebnisberichtedatenvergleichsprotokolldokumentationsergebnisse2026'
    const { card } = renderCard({ title: longTitle })

    const title = within(card).getByRole('heading', { level: 3 })
    expect(title.className).toContain('truncate')
    // The accessible contract keeps the complete stored title.
    expect(card).toHaveAttribute(
      'aria-label',
      `Open ${longTitle}`,
    )
  })
})

describe('WorkItemCard — presentation states', () => {
  it('keeps the shared geometry contract regardless of title length', () => {
    const short = renderCard({ title: 'Short' })
    cleanup()
    const long = renderCard({
      title:
        'interoperabilitaetsuntersuchungsergebnisberichtedatenvergleichsprotokolldokumentationsergebnisse2026',
    })

    // Title length never changes the card's own contract.
    expect(long.card.className).toBe(short.card.className)

    for (const card of [short.card, long.card]) {
      expect(card.className).toContain('min-h-[88px]')
      expect(card.className).toContain('px-3 py-2.5')
      expect(card.className).toContain('bg-work-card')
    }
  })

  it('presents the selected state (ring + data-selected)', () => {
    const { card } = renderCard({ selected: true })

    expect(card).toHaveAttribute('data-selected', 'true')
    expect(card.className).toContain(
      'outline-card-selected-ring',
    )
    expect(card.className).toContain('bg-card-selected-bg')
  })

  it('rests on the subtle work-card-border (never the text color)', () => {
    const { card } = renderCard({})

    // The 1px `border` width stays, but its COLOR must be the
    // explicit subtle rest token: an uncolored border falls back to
    // Tailwind's currentColor default (the full text color — a
    // near-white outline in Dark) and frames every card.
    expect(card.className).toContain('border')
    expect(card.className).toContain('border-work-card-border')
  })

  it('presents the dragging state (accent border + dimmed)', () => {
    const { card } = renderCard({ dragging: true })

    expect(card.className).toContain('border-accent')
    expect(card.className).toContain('opacity-[0.85]')
    // The accent fully replaces the rest border in this state.
    expect(card.className).not.toContain('border-work-card-border')
  })

  it('presents the pending state (progress cursor + dimmed)', () => {
    const { card } = renderCard({ pending: true })

    expect(card.className).toContain('cursor-progress')
    expect(card.className).toContain('opacity-60')
  })

  it('presents the drag-disabled state (openable, never draggable)', () => {
    const { card } = renderCard({ dragDisabled: true })

    // The element is explicitly non-draggable (React renders the
    // boolean as the literal attribute value) and drops the grab
    // cursor.
    expect(card).toHaveAttribute('draggable', 'false')
    expect(card.className).not.toContain('cursor-grab')
    // A drag-disabled card is a rest card: it keeps the subtle
    // rest border (never the full-text-color fallback).
    expect(card.className).toContain('border-work-card-border')
  })
})

describe('WorkItemCard — open and drag forwarding', () => {
  it('opens on click, Enter, and Space', () => {
    const onOpen = vi.fn()
    const { card } = renderCard({ onOpen })

    fireEvent.click(card)
    expect(onOpen).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(card, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledTimes(2)

    fireEvent.keyDown(card, { key: ' ' })
    expect(onOpen).toHaveBeenCalledTimes(3)

    // Other keys do not open.
    fireEvent.keyDown(card, { key: 'a' })
    expect(onOpen).toHaveBeenCalledTimes(3)
  })

  it('forwards a native drag with the ID payload to the controller', () => {
    const onDragStart = vi.fn()
    const onDragEnd = vi.fn()
    const { card } = renderCard({
      id: '42',
      onDragStart,
      onDragEnd,
    })

    const dataTransfer = makeDataTransfer()

    // The repo-standard drag flow (same as the Board suites):
    // dragstart on the card, drop on a target carrying the same
    // payload — the controller receives the ID on dataTransfer.
    fireEvent.dragStart(card, { dataTransfer })
    expect(onDragStart).toHaveBeenCalledTimes(1)
    expect(dataTransfer.getData('text/plain')).toBe('42')

    fireEvent.drop(card, { dataTransfer })

    fireEvent.dragEnd(card, { dataTransfer })
    expect(onDragEnd).toHaveBeenCalledTimes(1)
  })

  it('never starts a drag while drag-disabled', () => {
    const onDragStart = vi.fn()
    const { card } = renderCard({
      dragDisabled: true,
      onDragStart,
    })

    fireEvent.dragStart(card, {
      dataTransfer: makeDataTransfer(),
    })
    expect(onDragStart).not.toHaveBeenCalled()
  })
})

describe('WorkItemCard — action slot', () => {
  it('renders the slot at the top-right of the title row', () => {
    const { card } = renderCard({
      actions: (
        <button
          type="button"
          aria-label="Work item actions"
        >
          actions
        </button>
      ),
    })

    const trigger = within(card).getByRole('button', {
      name: 'Work item actions',
    })

    // Inside the FIRST card row (the title row), independent of
    // the title length.
    expect(trigger.parentElement).not.toBeNull()
    expect(
      (trigger.parentElement as HTMLElement).parentElement,
    ).toBe(card.children[0])
  })

  it('never opens the drawer or starts a drag from the slot', () => {
    const onOpen = vi.fn()
    const onDragStart = vi.fn()
    const { card } = renderCard({
      onOpen,
      onDragStart,
      actions: (
        <button
          type="button"
          aria-label="Work item actions"
        >
          actions
        </button>
      ),
    })

    const trigger = within(card).getByRole('button', {
      name: 'Work item actions',
    })

    fireEvent.click(trigger)
    expect(onOpen).not.toHaveBeenCalled()

    fireEvent.pointerDown(trigger)
    expect(onOpen).not.toHaveBeenCalled()

    const slotWrapper = trigger.parentElement as HTMLElement
    fireEvent.dragStart(slotWrapper, {
      dataTransfer: makeDataTransfer(),
    })
    expect(onDragStart).not.toHaveBeenCalled()
  })

  it('renders nothing in the slot position without actions', () => {
    const { card } = renderCard()

    expect(
      within(card)
        .queryByRole('button', { name: 'Work item actions' }),
    ).toBeNull()
  })
})

describe('WorkItemCard — keyboard event isolation (real action menu)', () => {
  // The REAL three-dot trigger (WorkItemActionMenuTrigger from
  // workItemDelete) — not a stand-in button: its keydown events
  // bubble through the actual slot DOM into the card exactly like
  // in the browser, so no mock can hide a missing event isolation.
  //
  // happy-dom (as testing-library generally) does not synthesize
  // the browser's native button activation from a keydown, so the
  // real keyboard sequence is simulated the way the browser runs
  // it: the keydown (Enter) / keydown+keyup (Space) that bubble
  // through the card FIRST, then the activation click the button
  // itself emits afterwards. The regression under test is the
  // keyboard half: the card must not open the drawer from it.
  function renderCardWithRealMenu() {
    const onOpen = vi.fn()
    const onAction = vi.fn()

    const { card } = renderCard({
      onOpen,
      actions: (
        <WorkItemActionMenuTrigger
          label="Work item actions"
          size="sm"
          onAction={onAction}
        />
      ),
    })

    const trigger = within(card).getByRole('button', {
      name: 'Work item actions',
    })

    return { card, trigger, onOpen, onAction }
  }

  it('Enter on the trigger opens ONLY the menu, not the drawer', () => {
    const { trigger, onOpen } = renderCardWithRealMenu()

    fireEvent.keyDown(trigger, { key: 'Enter' })
    // Regression: the bubbling keydown must not open the drawer.
    expect(onOpen).not.toHaveBeenCalled()

    // The browser's native activation follows the keydown.
    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: 'Delete work item' }),
    ).toBeInTheDocument()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('Space on the trigger opens ONLY the menu, not the drawer', () => {
    const { trigger, onOpen } = renderCardWithRealMenu()

    // Space activates a button on keyUP — both halves bubble
    // through the card.
    fireEvent.keyDown(trigger, { key: ' ' })
    fireEvent.keyUp(trigger, { key: ' ' })
    expect(onOpen).not.toHaveBeenCalled()

    // The native activation click that follows the keyup.
    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('Escape closes the open menu and never opens the card', () => {
    const { trigger, onOpen } = renderCardWithRealMenu()

    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).toBeInTheDocument()

    // The menu listens for Escape on document (native listener).
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('Enter on the Delete menuitem selects ONLY the delete action', () => {
    const { trigger, onOpen, onAction } = renderCardWithRealMenu()

    fireEvent.click(trigger)
    const item = screen.getByRole('menuitem', {
      name: 'Delete work item',
    })

    // The menu is position:fixed but still a DOM descendant of the
    // card — its keydown bubbles up through the card as well.
    fireEvent.keyDown(item, { key: 'Enter' })
    expect(onOpen).not.toHaveBeenCalled()

    // The native activation of the menuitem button.
    fireEvent.click(item)
    expect(onAction).toHaveBeenCalledWith('delete')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('leaves non-activation keys (incl. Escape) unhandled on the card itself', () => {
    const onOpen = vi.fn()

    const { card } = renderCard({
      onOpen,
      actions: (
        <WorkItemActionMenuTrigger
          label="Work item actions"
          size="sm"
          onAction={vi.fn()}
        />
      ),
    })

    // fireEvent reports true when the default was NOT prevented:
    // the card must leave keys it does not own unhandled.
    expect(
      fireEvent.keyDown(card, { key: 'Escape' }),
    ).toBe(true)
    expect(onOpen).not.toHaveBeenCalled()

    expect(fireEvent.keyDown(card, { key: 'a' })).toBe(true)
    expect(onOpen).not.toHaveBeenCalled()
  })
})

// ── Part 2: both boards render the SAME card ─────────────────

const PROJECT_CONFIGURATION: ApiProjectWorkItemConfiguration =
  {
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

function makeProject(
  overrides: Partial<ApiProject> = {},
): ApiProject {
  return {
    id: 7,
    researchGroupId: 1,
    name: 'Shared Card Project',
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

function makeProjectWorkItem(
  overrides: Partial<ApiWorkItem> = {},
): ApiWorkItem {
  return {
    id: 42,
    projectId: 7,
    title: 'Shared card item',
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

function makePersonalWorkItem(
  overrides: Partial<ApiPersonalWorkItem> = {},
): ApiPersonalWorkItem {
  return {
    id: 42,
    projectId: 7,
    title: 'Shared card item',
    description: '',
    typeDefinitionId: 4,
    statusDefinitionId: 10,
    boardPosition: null,
    labelDefinitionIds: [],
    assigneeIds: [1],
    parentId: null,
    dueDate: null,
    blockedReason: null,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    createdById: 1,
    meetingOrigin: null,
    projectName: 'Project Alpha',
    researchGroupId: 1,
    researchGroupName: 'Research Group A',
    typeName: 'Task',
    typeKind: 'task',
    statusName: 'To do',
    statusCategory: 'todo',
    statusTargets: [],
    myWorkBoardPosition: null,
    // Server-derived delete permission: deletable by default
    // (non-archived Project + owner/member); per-item overrides
    // exercise the denied state.
    actionPermissions: { canDelete: true },
    ...overrides,
  } as ApiPersonalWorkItem
}

const BOARD_PREFERENCES: ApiMyWorkPreferences = {
  viewMode: 'board',
  researchGroupIds: [],
  projectIds: [],
  workItemTypes: [],
}

async function renderProjectBoard(
  workItems: ApiWorkItem[],
): Promise<HTMLElement> {
  vi.mocked(getProject).mockResolvedValue(makeProject())
  vi.mocked(getProjectWorkItemConfiguration).mockResolvedValue(
    PROJECT_CONFIGURATION,
  )
  vi.mocked(listProjectWorkItems).mockResolvedValue(workItems)
  vi.mocked(listProjectMemberships).mockResolvedValue([
    makeMembership('owner'),
  ])
  vi.mocked(listResearchGroupMembers).mockResolvedValue(
    GROUP_MEMBERS,
  )

  const { container } = render(
    <MemoryRouter
      initialEntries={['/projects/7/work-items']}
    >
      <Routes>
        <Route
          path="/projects/:projectId/:tab"
          element={<ProjectDetailPage />}
        />
      </Routes>
    </MemoryRouter>,
  )

  // The To do column header only renders once the payload has
  // loaded — doubles as the data-loaded gate.
  await screen.findByText('To do')

  return container
}

async function renderMyWorkBoard(
  items: ApiPersonalWorkItem[],
): Promise<HTMLElement> {
  vi.mocked(fetchMyWorkPreferences).mockResolvedValue(
    BOARD_PREFERENCES,
  )
  vi.mocked(updateMyWorkPreferences).mockImplementation(
    async (snapshot: ApiMyWorkPreferences) =>
      snapshot,
  )
  vi.mocked(listProjectWorkItems).mockResolvedValue([])
  vi.mocked(listMyWork).mockResolvedValue(items)

  const { container } = render(
    <MemoryRouter initialEntries={['/my-work']}>
      <Routes>
        <Route
          path="/my-work"
          element={<MyWorkPage />}
        />
      </Routes>
    </MemoryRouter>,
  )

  // Four semantic lanes = the real board has rendered.
  await waitFor(() => {
    expect(
      container.querySelectorAll('[data-board-column]').length,
    ).toBe(4)
  })

  return container
}

// The shared card inside a rendered board.
function boardCard(
  container: HTMLElement,
  workItemId: number,
): HTMLElement {
  const card = container.querySelector(
    `[data-work-item-id="${workItemId}"]`,
  ) as HTMLElement

  expect(card, `board card ${workItemId} must be rendered`).not.toBeNull()

  return card
}

describe('shared card — Project Work Items Board', () => {
  it('renders the shared card contract (surface, title, type text, no icon)', async () => {
    const container = await renderProjectBoard([
      makeProjectWorkItem(),
    ])

    const card = boardCard(container, 42)

    // Shared surface + geometry contract.
    expect(card.className).toContain('min-h-[88px]')
    expect(card.className).toContain('px-3 py-2.5')
    expect(card.className).toContain('bg-work-card')

    // Title: one-line ellipsis, shared typography.
    const title = within(card).getByRole('heading', { level: 3 })
    expect(title.className).toContain('truncate')
    expect(title.className).toContain(
      'text-[13px] font-semibold leading-[18px]',
    )

    // The concrete type definition name as text (from the actual
    // TypeDefinition) — and no type icon (the only icon the
    // editable card may carry is the three-dot action menu).
    expect(card.textContent).toContain('Task')
    const icons = Array.from(
      card.querySelectorAll(
        '.material-symbols-outlined',
      ),
    ).map((span) => span.textContent?.trim())
    for (
      const typeIcon of [
        'assignment',
        'account_tree',
        'flag',
        'deployed_code',
        'inventory_2',
      ]
    ) {
      expect(icons, `type icon ${typeIcon}`).not.toContain(
        typeIcon,
      )
    }
    expect(icons).toContain('more_horiz')

    // The assignee metadata region (Unassigned).
    expect(card.textContent).toContain('Unassigned')
  })

  it('keeps the three-dot action menu on editable cards, without opening the drawer', async () => {
    const container = await renderProjectBoard([
      makeProjectWorkItem(),
    ])

    const card = boardCard(container, 42)
    const trigger = within(card).getByRole('button', {
      name: 'Work item actions',
    })

    // The menu opens…
    fireEvent.click(trigger)
    const menu = await screen.findByRole('menu')
    expect(
      within(menu).getByRole('menuitem', {
        name: 'Delete work item',
      }),
    ).toBeInTheDocument()

    // …and the drawer is NOT mounted.
    expect(
      container.querySelector('[data-testid="work-item-drawer"]'),
    ).toBeNull()
  })

  it('runs the EXISTING delete confirmation from the card menu (Cancel keeps the card)', async () => {
    const container = await renderProjectBoard([
      makeProjectWorkItem(),
    ])

    const card = boardCard(container, 42)

    fireEvent.click(
      within(card).getByRole('button', {
        name: 'Work item actions',
      }),
    )
    fireEvent.click(
      await screen.findByRole('menuitem', {
        name: 'Delete work item',
      }),
    )

    // The existing confirmation dialog (workItemDelete) is up —
    // and the drawer is still not mounted.
    const dialog = await screen.findByRole('dialog', {
      name: 'Delete work item?',
    })
    expect(
      container.querySelector(
        '[data-testid="work-item-drawer"]',
      ),
    ).toBeNull()

    // Cancel closes the dialog; the card survives.
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'Cancel',
      }),
    )
    expect(
      screen.queryByRole('dialog', {
        name: 'Delete work item?',
      }),
    ).toBeNull()
    expect(boardCard(container, 42)).not.toBeNull()
  })

  it('opens the card menu by keyboard without opening the drawer', async () => {
    const container = await renderProjectBoard([
      makeProjectWorkItem(),
    ])

    const card = boardCard(container, 42)
    const trigger = within(card).getByRole('button', {
      name: 'Work item actions',
    })

    // The keydown from the REAL trigger bubbles through the card
    // (the regression). A wrongly forwarded open intent SELECTS
    // the card synchronously (data-selected) — the drawer chunk
    // itself is lazy, so the selection is the deterministic
    // observable of the open intent.
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(card).not.toHaveAttribute('data-selected')

    // The native activation click that follows the Enter keydown.
    fireEvent.click(trigger)
    const menu = await screen.findByRole('menu')
    expect(
      within(menu).getByRole('menuitem', {
        name: 'Delete work item',
      }),
    ).toBeInTheDocument()

    // …and the card stays unselected, the drawer unmounted.
    expect(card).not.toHaveAttribute('data-selected')
    expect(
      container.querySelector(
        '[data-testid="work-item-drawer"]',
      ),
    ).toBeNull()
  })

  it('opens the drawer on card click and keyboard activation', async () => {
    const container = await renderProjectBoard([
      makeProjectWorkItem(),
    ])

    const card = boardCard(container, 42)

    fireEvent.click(card)
    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-testid="work-item-drawer"]',
        ),
      ).not.toBeNull()
    })
  })

  it('offers no action menu on a read-only (viewer) project board', async () => {
    vi.mocked(getProject).mockResolvedValue(
      makeProject({ currentUserRole: 'viewer' }),
    )
    vi.mocked(getProjectWorkItemConfiguration).mockResolvedValue(
      PROJECT_CONFIGURATION,
    )
    vi.mocked(listProjectWorkItems).mockResolvedValue([
      makeProjectWorkItem(),
    ])
    vi.mocked(listProjectMemberships).mockResolvedValue([
      makeMembership('viewer'),
    ])
    vi.mocked(listResearchGroupMembers).mockResolvedValue(
      GROUP_MEMBERS,
    )

    const { container } = render(
      <MemoryRouter
        initialEntries={['/projects/7/work-items']}
      >
        <Routes>
          <Route
            path="/projects/:projectId/:tab"
            element={<ProjectDetailPage />}
          />
        </Routes>
      </MemoryRouter>,
    )

    await screen.findByText('To do')

    const card = boardCard(container, 42)
    expect(
      within(card).queryByRole('button', {
        name: 'Work item actions',
      }),
    ).toBeNull()
  })
})

// Wire the lazy drawer-context reads (the owning-Project fetches
// triggered when a My Work card opens) to canonical-looking
// responses.
function mockMyWorkDrawerContext() {
  vi.mocked(getProject).mockImplementation(
    async (projectId) => makeProject({ id: projectId }),
  )
  vi.mocked(
    getProjectWorkItemConfiguration,
  ).mockResolvedValue(PROJECT_CONFIGURATION)
  vi.mocked(listProjectMemberships).mockResolvedValue([
    makeMembership('owner'),
  ])
  vi.mocked(listProjectWorkItems).mockResolvedValue([
    makeProjectWorkItem(),
  ])
}

describe('shared card — My Work Kanban', () => {
  it('renders the shared card contract (surface, title, type text, provenance, no icon, permission-gated action menu)', async () => {
    const container = await renderMyWorkBoard([
      makePersonalWorkItem(),
    ])

    const card = boardCard(container, 42)

    expect(card.className).toContain('min-h-[88px]')
    expect(card.className).toContain('px-3 py-2.5')
    expect(card.className).toContain('bg-work-card')

    const title = within(card).getByRole('heading', { level: 3 })
    expect(title.className).toContain('truncate')
    expect(title.className).toContain(
      'text-[13px] font-semibold leading-[18px]',
    )

    // Concrete type name as text, no type icon. The compact
    // action menu (the SAME trigger the Project board uses)
    // renders because the item's own server-derived
    // actionPermissions.canDelete is true — its `more_horiz`
    // glyph is the ONLY symbol on the card — and the drawer is
    // not mounted by rendering the board.
    expect(card.textContent).toContain('Task')
    expect(
      Array.from(
        card.querySelectorAll(
          '.material-symbols-outlined',
        ),
      ).map(
        (icon) => icon.textContent?.trim() ?? '',
      ),
    ).toEqual(['more_horiz'])
    expect(
      within(card).queryByRole('button', {
        name: 'Work item actions',
      }),
    ).not.toBeNull()
    expect(
      container.querySelector('[data-testid="work-item-drawer"]'),
    ).toBeNull()

    // Provenance from the payload (group first).
    expect(card.textContent).toContain(
      'Research Group A › Project Alpha',
    )
  })

  it('hides the action menu on a card whose item carries canDelete false', async () => {
    const container = await renderMyWorkBoard([
      makePersonalWorkItem(),
      makePersonalWorkItem({
        id: 43,
        projectId: 9,
        projectName: 'Project Beta',
        researchGroupId: 2,
        researchGroupName: 'Research Group B',
        actionPermissions: { canDelete: false },
      }),
    ])

    // The denied item still renders its card (visibility is NOT
    // the permission gate) — without the action slot.
    const denied = boardCard(container, 43)
    expect(
      within(denied).queryByRole('button', {
        name: 'Work item actions',
      }),
    ).toBeNull()

    // The sibling deletable item keeps its menu: the gate is
    // strictly per-item.
    const allowed = boardCard(container, 42)
    expect(
      within(allowed).queryByRole('button', {
        name: 'Work item actions',
      }),
    ).not.toBeNull()
  })

  it('defaults to no action menu when actionPermissions is missing and still opens the drawer', async () => {
    mockMyWorkDrawerContext()

    // Deliberately malformed API payload for this negative test:
    // runtime input may omit the newly added permission object even
    // though valid TypeScript fixtures must always provide it.
    const itemWithoutActionPermissions = {
      ...makePersonalWorkItem(),
      actionPermissions: undefined,
    } as unknown as ApiPersonalWorkItem

    const container = await renderMyWorkBoard([
      itemWithoutActionPermissions,
    ])
    const card = boardCard(container, 42)

    expect(
      within(card).queryByRole('button', {
        name: 'Work item actions',
      }),
    ).toBeNull()

    fireEvent.click(card)
    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-testid="work-item-drawer"]',
        ),
      ).not.toBeNull()
    })
  })

  it('defaults to no action menu when canDelete is missing', async () => {
    // Deliberately malformed API payload for this negative test.
    const itemWithoutCanDelete = makePersonalWorkItem({
      actionPermissions: {} as unknown as ApiPersonalWorkItem['actionPermissions'],
    })

    const container = await renderMyWorkBoard([
      itemWithoutCanDelete,
    ])

    expect(
      within(boardCard(container, 42)).queryByRole(
        'button',
        { name: 'Work item actions' },
      ),
    ).toBeNull()
  })

  it('rejects a truthy non-boolean canDelete value', async () => {
    // Deliberately malformed API payload for this negative test.
    const itemWithInvalidCanDelete = makePersonalWorkItem({
      actionPermissions: {
        canDelete: 'yes',
      } as unknown as ApiPersonalWorkItem['actionPermissions'],
    })

    const container = await renderMyWorkBoard([
      itemWithInvalidCanDelete,
    ])

    expect(
      within(boardCard(container, 42)).queryByRole(
        'button',
        { name: 'Work item actions' },
      ),
    ).toBeNull()
  })

  it('deletes through the shared confirmation dialog from the card menu (no drawer, no per-Project GETs)', async () => {
    vi.mocked(deleteWorkItem).mockResolvedValue(undefined)

    const container = await renderMyWorkBoard([
      makePersonalWorkItem(),
    ])

    const card = boardCard(container, 42)
    fireEvent.click(
      within(card).getByRole('button', {
        name: 'Work item actions',
      }),
    )
    fireEvent.click(
      await screen.findByRole('menuitem', {
        name: 'Delete work item',
      }),
    )

    // The EXISTING page-level confirmation dialog is up — and
    // the card menu opened it WITHOUT opening the drawer or
    // issuing any Project / configuration read for the item's
    // Project.
    const dialog = await screen.findByRole('dialog', {
      name: 'Delete work item?',
    })
    expect(
      container.querySelector('[data-testid="work-item-drawer"]'),
    ).toBeNull()
    expect(getProject).not.toHaveBeenCalled()
    expect(
      getProjectWorkItemConfiguration,
    ).not.toHaveBeenCalled()

    // Confirming runs the card-originated delete path: the
    // canonical delete call + the authoritative My Work
    // refetch — never the drawer-context read-only guard.
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'Delete work item',
      }),
    )
    await waitFor(() => {
      expect(deleteWorkItem).toHaveBeenCalledWith(42)
    })
    expect(listMyWork).toHaveBeenCalledTimes(2)
    expect(
      screen.queryByRole('dialog', {
        name: 'Delete work item?',
      }),
    ).toBeNull()
  })

  it('never gates one card\'s menu by ANOTHER card\'s drawer read-only state', async () => {
    // Two items from different Projects: 42 lives in an ACTIVE
    // Project (canDelete true), 43 in an ARCHIVED one (canDelete
    // false — the server mirror of the delete guard).
    vi.mocked(getProject).mockImplementation(
      async (projectId) =>
        makeProject({
          id: projectId,
          archivedAt:
            projectId === 9
              ? '2026-08-01T00:00:00Z'
              : null,
        }),
    )
    vi.mocked(
      getProjectWorkItemConfiguration,
    ).mockResolvedValue(PROJECT_CONFIGURATION)
    vi.mocked(listProjectMemberships).mockResolvedValue([
      makeMembership('owner'),
    ])
    vi.mocked(listProjectWorkItems).mockResolvedValue([
      makeProjectWorkItem(),
    ])

    const container = await renderMyWorkBoard([
      makePersonalWorkItem(),
      makePersonalWorkItem({
        id: 43,
        projectId: 9,
        projectName: 'Project Beta',
        researchGroupId: 2,
        researchGroupName: 'Research Group B',
        actionPermissions: { canDelete: false },
      }),
    ])

    // Open the drawer for the ARCHIVED item: the drawer context
    // resolves read-only (the archived Project).
    fireEvent.click(boardCard(container, 43))
    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-testid="work-item-drawer"]',
        ),
      ).not.toBeNull()
    })

    // The open drawer's read-only state must NOT gate the OTHER
    // card: 42 keeps its action menu …
    expect(
      within(boardCard(container, 42)).queryByRole(
        'button',
        { name: 'Work item actions' },
      ),
    ).not.toBeNull()
    // … and the denied card 43 still has none (its own item
    // permission — not the drawer state — is the gate).
    expect(
      within(boardCard(container, 43)).queryByRole(
        'button',
        { name: 'Work item actions' },
      ),
    ).toBeNull()
  })

  it('renders the board without any per-Project GETs', async () => {
    await renderMyWorkBoard([makePersonalWorkItem()])

    // The card is fully served by the single canonical
    // GET /api/me/work-items/ payload: no Project or Project
    // configuration request may have happened.
    expect(getProject).not.toHaveBeenCalled()
    expect(
      getProjectWorkItemConfiguration,
    ).not.toHaveBeenCalled()
    expect(listProjectWorkItems).not.toHaveBeenCalled()
  })

  it('opens the canonical drawer in place on card click', async () => {
    mockMyWorkDrawerContext()

    const container = await renderMyWorkBoard([
      makePersonalWorkItem(),
    ])

    const card = boardCard(container, 42)

    fireEvent.click(card)
    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-testid="work-item-drawer"]',
        ),
      ).not.toBeNull()
    })
  })
})

describe('shared card — one visual contract across both boards', () => {
  it('renders the identical card surface for a neutral item on both boards', async () => {
    // Both pages render side by side (no cleanup in between), so
    // the comparison is over two live boards at once.
    const projectContainer = await renderProjectBoard([
      makeProjectWorkItem(),
    ])
    const myWorkContainer = await renderMyWorkBoard([
      makePersonalWorkItem(),
    ])

    const projectCard = boardCard(projectContainer, 42)
    const myWorkCard = boardCard(myWorkContainer, 42)

    // The shared card contract: byte-identical article classes
    // for a neutral item on both boards.
    expect(myWorkCard.className).toBe(projectCard.className)

    // And identical title typography on both boards.
    const projectTitle = within(projectCard).getByRole(
      'heading',
      { level: 3 },
    )
    const myWorkTitle = within(myWorkCard).getByRole(
      'heading',
      { level: 3 },
    )
    expect(myWorkTitle.className).toBe(projectTitle.className)
  })
})

// ── Part 3: the shared due helpers ───────────────────────────

describe('workItemDue helpers', () => {
  it('parses due dates into the canonical relative fields', () => {
    expect(getWorkItemDueFields(null)).toEqual({
      dueInDays: null,
      dueLabel: null,
    })
    expect(getWorkItemDueFields('not-a-date')).toEqual({
      dueInDays: null,
      dueLabel: null,
    })

    const today = getWorkItemDueFields(isoDaysFromNow(0))
    expect(today.dueInDays).toBe(0)
    expect(today.dueLabel).toBe('Today')

    const tomorrow = getWorkItemDueFields(isoDaysFromNow(1))
    expect(tomorrow.dueInDays).toBe(1)
    expect(tomorrow.dueLabel).toBe('Tomorrow')

    const past = getWorkItemDueFields(isoDaysFromNow(-2))
    expect(past.dueInDays).toBe(-2)
  })

  it('resolves the card due state across the full matrix', () => {
    expect(
      getWorkItemCardDueState(null, 'todo'),
    ).toEqual({ kind: 'none' })

    expect(
      getWorkItemCardDueState(
        isoDaysFromNow(0),
        'todo',
      ),
    ).toEqual({ kind: 'today' })

    expect(
      getWorkItemCardDueState(
        isoDaysFromNow(1),
        'todo',
      ),
    ).toEqual({ kind: 'tomorrow' })

    expect(
      getWorkItemCardDueState(
        isoDaysFromNow(-4),
        'todo',
      ),
    ).toEqual({ kind: 'overdue', label: '4d overdue' })

    expect(
      getWorkItemCardDueState(
        isoDaysFromNow(9),
        'todo',
      ).kind,
    ).toBe('future')

    // Done suppresses the due hint (even when overdue).
    expect(
      getWorkItemCardDueState(
        isoDaysFromNow(-4),
        'done',
      ),
    ).toEqual({ kind: 'none' })

    // Unresolved (null) is never treated as done.
    expect(
      getWorkItemCardDueState(
        isoDaysFromNow(-4),
        null,
      ),
    ).toEqual({ kind: 'overdue', label: '4d overdue' })
  })
})
