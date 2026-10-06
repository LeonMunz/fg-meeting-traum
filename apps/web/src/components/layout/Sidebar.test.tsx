// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { StrictMode, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MemoryRouter,
  useLocation,
  useNavigate,
} from 'react-router'

import {
  fetchProjectQuickAccess,
  fetchGlobalProjectQuickAccess,
  recordProjectOpen,
} from '../../api/project-quick-access'
import { getProject } from '../../api/projects'
import {
  fetchWorkspaceNavigationPreferences,
  updateWorkspaceNavigationPreferences,
} from '../../api/workspace-navigation-preferences'
import type {
  ApiProject,
  ApiProjectQuickAccessItem,
  ApiResearchGroup,
  ApiWorkspaceNavigationPreferences,
} from '../../api/types'
import type {
  ResearchGroupContextValue,
} from '../../features/research-group/ResearchGroupContext'
import { useResearchGroup } from '../../features/research-group/useResearchGroup'

import { Sidebar } from './Sidebar'

vi.mock(
  '../../api/workspace-navigation-preferences',
  () => ({
    fetchWorkspaceNavigationPreferences: vi.fn(),
    updateWorkspaceNavigationPreferences: vi.fn(),
  }),
)

vi.mock(
  '../../api/project-quick-access',
  () => ({
    fetchProjectQuickAccess: vi.fn(),
    fetchGlobalProjectQuickAccess: vi.fn(),
    recordProjectOpen: vi.fn(),
  }),
)

vi.mock('../../api/projects', () => ({
  getProject: vi.fn(),
}))

vi.mock(
  '../../features/research-group/useResearchGroup',
  () => ({
    useResearchGroup: vi.fn(),
  }),
)

const GROUP_A: ApiResearchGroup = {
  id: 11,
  name: 'Bravo Group',
  role: 'member',
}

const GROUP_B: ApiResearchGroup = {
  id: 22,
  name: 'Alpha Group',
  role: 'admin',
}

const GROUP_C: ApiResearchGroup = {
  id: 33,
  name: 'Charlie Group',
  role: 'member',
}

/*
 * The GLOBAL Quick Access snapshot: deliberately NOT in id, name,
 * or lastOpenedAt order (nulls interleaved, Research Groups
 * interleaved) so any client-side re-sort or re-ranking would be
 * visible.
 */
const PAPER_ONE: ApiProjectQuickAccessItem = {
  id: 201,
  researchGroupId: 11,
  name: 'Paper One',
  lastOpenedAt: '2026-09-02T08:00:00Z',
}

const PAPER_TWO: ApiProjectQuickAccessItem = {
  id: 102,
  researchGroupId: 22,
  name: 'Paper Two',
  lastOpenedAt: null,
}

const PAPER_THREE: ApiProjectQuickAccessItem = {
  id: 303,
  researchGroupId: 11,
  name: 'Paper Three',
  lastOpenedAt: '2026-10-01T08:00:00Z',
}

const PAPER_FOUR: ApiProjectQuickAccessItem = {
  id: 104,
  researchGroupId: 22,
  name: 'Paper Four',
  lastOpenedAt: null,
}

const PAPER_FIVE: ApiProjectQuickAccessItem = {
  id: 505,
  researchGroupId: 33,
  name: 'Paper Five',
  lastOpenedAt: '2026-09-15T08:00:00Z',
}

const GLOBAL_SNAPSHOT: ApiProjectQuickAccessItem[] = [
  PAPER_ONE,
  PAPER_TWO,
  PAPER_THREE,
  PAPER_FOUR,
  PAPER_FIVE,
]

/** The Project metadata (bounded getProject) per fixture id. */
function projectFixture(
  item: ApiProjectQuickAccessItem,
  overrides: Partial<ApiProject> = {},
): ApiProject {
  return {
    id: item.id,
    researchGroupId: item.researchGroupId,
    name: item.name,
    description: '',
    status: 'active',
    archivedAt: null,
    currentUserRole: 'member',
    createdAt: '2026-01-01T08:00:00Z',
    updatedAt: '2026-01-01T08:00:00Z',
    ...overrides,
  }
}

const OUTSIDE_PROJECT: ApiProject = {
  id: 999,
  researchGroupId: 22,
  name: 'Outside Project',
  description: '',
  status: 'active',
  archivedAt: null,
  currentUserRole: 'member',
  createdAt: '2026-01-02T08:00:00Z',
  updatedAt: '2026-01-02T08:00:00Z',
}

function projectForId(
  id: number,
  overrides: Partial<ApiProject> = {},
): ApiProject {
  if (id === 999) {
    return { ...OUTSIDE_PROJECT, ...overrides }
  }

  const item = GLOBAL_SNAPSHOT.find(
    (candidate) => candidate.id === id,
  )

  if (item === undefined) {
    throw new Error(`No fixture Project for id ${id}`)
  }

  return projectFixture(item, overrides)
}

function preferences(
  overrides: Partial<ApiWorkspaceNavigationPreferences> = {},
): ApiWorkspaceNavigationPreferences {
  return {
    researchGroupOrder: [GROUP_A.id, GROUP_B.id, GROUP_C.id],
    expandedResearchGroups: [],
    expandedProjectSections: [],
    ...overrides,
  }
}

function contextValue(
  overrides: Partial<ResearchGroupContextValue> = {},
): ResearchGroupContextValue {
  return {
    groups: [GROUP_A, GROUP_B, GROUP_C],
    activeResearchGroupId: GROUP_A.id,
    activeResearchGroup: GROUP_A,
    loading: false,
    error: null,
    setActiveResearchGroupId: vi.fn(),
    reloadResearchGroups: vi.fn(),
    addResearchGroup: vi.fn(),
    ...overrides,
  }
}

/**
 * Read-only location probe plus an imperative navigation control
 * for driving route changes the Sidebar itself does not originate
 * (tab switches, list → Project entries, leaving the current
 * context).
 */
function TestNavigation() {
  const location = useLocation()
  const navigate = useNavigate()
  const [target, setTarget] = useState('')

  return (
    <div aria-label="Test navigation">
      <output aria-label="Current location">
        {`${location.pathname}${location.search}`}
      </output>

      <input
        aria-label="Navigate to"
        value={target}
        onChange={(event) => setTarget(event.target.value)}
      />

      <button
        type="button"
        aria-label="Navigate"
        onClick={() => {
          if (target !== '') {
            navigate(target)
          }
        }}
      >
        go
      </button>
    </div>
  )
}

function navigateTo(path: string) {
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Navigate to' }),
    { target: { value: path } },
  )

  fireEvent.click(
    screen.getByRole('button', { name: 'Navigate' }),
  )
}

function renderSidebar(
  value: ResearchGroupContextValue,
  initialEntry = '/projects?group=11',
) {
  vi.mocked(useResearchGroup).mockReturnValue(value)

  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Sidebar />
      <TestNavigation />
    </MemoryRouter>,
  )
}

/** Wait until the tree has hydrated (preference GET resolved). */
async function waitForTree() {
  await waitFor(() => {
    expect(
      screen.getByRole('navigation', {
        name: 'Research groups',
      }),
    ).toBeInTheDocument()
  })
}

/** Wait until the global Quick Access rows have rendered. */
async function waitForQuickAccess() {
  await waitFor(() => {
    expect(
      screen
        .getByRole('navigation', { name: 'Quick access' })
        .querySelectorAll('button'),
    ).toHaveLength(GLOBAL_SNAPSHOT.length)
  })
}

/** The visible Quick Access row names in DOM order. */
function quickAccessRowNames(): string[] {
  const navigation = screen.getByRole('navigation', {
    name: 'Quick access',
  })

  return Array.from(
    navigation.querySelectorAll('button'),
  ).map(
    (button) => button.textContent?.trim() ?? '',
  )
}

function quickAccessRow(name: string) {
  return within(
    screen.getByRole('navigation', {
      name: 'Quick access',
    }),
  ).getByRole('button', { name })
}

/** The chevron (disclosure) control of a group row. */
function chevronFor(name: string) {
  return screen.getByRole('button', {
    name: new RegExp(`^(Expand|Collapse) ${name}$`),
  })
}

/** The row container of a group (chevron's parent). */
function rowFor(name: string) {
  // chevron → row div → the row's outer container (the children
  // container is a sibling of the inner row div).
  return chevronFor(name)
    .parentElement?.parentElement as HTMLElement
}

/** The group label (navigation) button. */
function labelFor(name: string) {
  return screen.getByRole('button', { name })
}

/**
 * The group names in rendered DOM order (the label buttons are the
 * only buttons carrying a bare group name).
 */
function renderedGroupNames() {
  const navigation = screen.getByRole('navigation', {
    name: 'Research groups',
  })

  return Array.from(navigation.querySelectorAll('button'))
    .map((button) => button.textContent?.trim() ?? '')
    .filter((text) =>
      [
        'Bravo Group',
        'Alpha Group',
        'Charlie Group',
      ].includes(text),
    )
}

beforeEach(() => {
  vi.clearAllMocks()

  vi.mocked(fetchWorkspaceNavigationPreferences).mockResolvedValue(
    preferences(),
  )

  // The server normally echoes the complete snapshot back
  // normalized; the tests that need a different answer override
  // this.
  vi.mocked(updateWorkspaceNavigationPreferences).mockImplementation(
    async (snapshot) => snapshot,
  )

  vi.mocked(fetchGlobalProjectQuickAccess).mockResolvedValue(
    GLOBAL_SNAPSHOT,
  )

  vi.mocked(fetchProjectQuickAccess).mockResolvedValue([])

  vi.mocked(recordProjectOpen).mockImplementation(
    async (projectId) => ({
      projectId,
      lastOpenedAt: '2026-10-05T08:00:00Z',
    }),
  )

  vi.mocked(getProject).mockImplementation(
    async (projectId) => projectForId(projectId),
  )
})

afterEach(cleanup)

describe('Sidebar structure (frozen IA)', () => {
  it('renders exactly ONE global Quick Access section with restrained labels', async () => {
    renderSidebar(contextValue())
    await waitForTree()
    await waitForQuickAccess()

    // Exactly one Quick Access section, in its own nav.
    expect(
      screen.getAllByRole('navigation', {
        name: 'Quick access',
      }),
    ).toHaveLength(1)

    // The section labels of the approved IA.
    expect(screen.getByText('Quick Access')).toBeInTheDocument()
    expect(
      screen.getByText('Research Groups'),
    ).toBeInTheDocument()

    // Section order: Personal (first nav), Quick Access,
    // Research Groups.
    const navigations = screen.getAllByRole('navigation')
    expect(
      navigations.map((nav) => nav.getAttribute('aria-label')),
    ).toEqual([
      null,
      'Quick access',
      'Research groups',
      null,
    ])
  })

  it('never renders Project shortcuts below any Research Group', async () => {
    renderSidebar(contextValue())
    await waitForTree()
    await waitForQuickAccess()

    // Expand EVERY group: no Project row may appear under any of
    // them, and each expanded group shows EXACTLY two rows.
    for (const name of [
      'Bravo Group',
      'Alpha Group',
      'Charlie Group',
    ]) {
      fireEvent.click(chevronFor(name))
    }

    for (const name of [
      'Bravo Group',
      'Alpha Group',
      'Charlie Group',
    ]) {
      const row = rowFor(name)
      const links = within(row).getAllByRole('link')

      expect(links.map((link) => link.textContent?.trim())).toEqual([
        'folder_openProjects',
        'groupsMeetings',
      ])

      for (const project of GLOBAL_SNAPSHOT) {
        expect(
          within(row).queryByRole('button', {
            name: project.name,
          }),
        ).toBeNull()
        expect(
          within(row).queryByRole('link', {
            name: new RegExp(project.name),
          }),
        ).toBeNull()
      }
    }
  })

  it('has no Projects disclosure and no third hierarchy level', async () => {
    renderSidebar(contextValue())
    await waitForTree()
    await waitForQuickAccess()

    fireEvent.click(chevronFor('Bravo Group'))

    const row = rowFor('Bravo Group')

    // The Projects row is a plain link, not a disclosure: no
    // chevron controls it, and no child row can expand further.
    // The ONLY disclosure in the whole row container is the
    // group's own chevron (in either state).
    const projects = within(row).getByRole('link', {
      name: /Projects/,
    })
    expect(projects.closest('button')).toBeNull()
    expect(
      within(row).queryAllByRole('button', {
        name: /^(Expand|Collapse) /,
      }),
    ).toHaveLength(1) // only the group's own chevron
  })

  it('has no Research Group overflow / three-dot menu (QA-12)', async () => {
    renderSidebar(contextValue())
    await waitForTree()
    await waitForQuickAccess()

    expect(
      screen.queryAllByRole('button', {
        name: /More options for /,
      }),
    ).toHaveLength(0)
    expect(
      screen.queryByRole('menu'),
    ).not.toBeInTheDocument()

    // Even the admin row (Alpha Group) carries no overflow.
    expect(
      within(rowFor('Alpha Group')).queryAllByRole(
        'button',
        { name: /More options/ },
      ),
    ).toHaveLength(0)
  })
})

describe('Sidebar personal navigation', () => {
  it('renders Notes directly with Home and My Work, in that order', async () => {
    renderSidebar(contextValue())
    await waitForTree()

    // The personal navigation is the first (unlabeled) nav in the
    // aside, ahead of the Quick Access and research-group sections.
    const personalNav = screen.getAllByRole('navigation')[0]
    const entries = Array.from(personalNav.children)

    expect(entries.map((entry) => entry.textContent)).toEqual([
      'homeHome',
      'assignmentMy Work',
      'sticky_note_2Notes',
    ])
  })

  it('points Notes at /notes without any research-group scoping', async () => {
    renderSidebar(contextValue())
    await waitForTree()

    const notes = screen.getByRole('link', { name: /Notes/ })
    expect(notes).toHaveAttribute('href', '/notes')
    expect(notes.getAttribute('href')).not.toContain('group')
  })

  it('highlights Notes when /notes is active', async () => {
    renderSidebar(contextValue(), '/notes')
    await waitForTree()

    expect(
      screen.getByRole('link', { name: /Notes/ }),
    ).toHaveAttribute('aria-current', 'page')
  })

  it('keeps the Notifications destination in the bottom zone', async () => {
    renderSidebar(contextValue())
    await waitForTree()

    const notifications = screen.getByRole('link', {
      name: /Notifications/,
    })

    expect(notifications).toHaveAttribute(
      'href',
      '/notifications',
    )
  })
})

describe('Sidebar research group tree', () => {
  it('renders all accessible Research Groups in the preference order returned by the server', async () => {
    vi.mocked(fetchWorkspaceNavigationPreferences).mockResolvedValue(
      preferences({
        researchGroupOrder: [GROUP_C.id, GROUP_A.id, GROUP_B.id],
      }),
    )

    renderSidebar(contextValue())
    await waitForTree()

    expect(renderedGroupNames()).toEqual([
      'Charlie Group',
      'Bravo Group',
      'Alpha Group',
    ])
  })

  it('keeps the provider order only as the unresolved fallback (no final tree before the preference resolves)', async () => {
    let resolvePreferences:
      | ((snapshot: ApiWorkspaceNavigationPreferences) => void)
      | undefined

    vi.mocked(fetchWorkspaceNavigationPreferences).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePreferences = resolve
        }),
    )

    renderSidebar(contextValue())

    // While the preference is unresolved the zone shows its loading
    // state — no group row may render in an incorrect fallback
    // order.
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByText('Bravo Group')).not.toBeInTheDocument()

    await act(async () => {
      resolvePreferences?.(
        preferences({
          researchGroupOrder: [GROUP_C.id, GROUP_A.id, GROUP_B.id],
        }),
      )
    })

    expect(renderedGroupNames()).toEqual([
      'Charlie Group',
      'Bravo Group',
      'Alpha Group',
    ])
  })

  it('renders collapsed Research Groups for the default (no-preference) snapshot', async () => {
    // No ?group= scope: nothing is contextually revealed.
    renderSidebar(contextValue(), '/my-work')
    await waitForTree()

    for (const name of [
      'Bravo Group',
      'Alpha Group',
      'Charlie Group',
    ]) {
      expect(chevronFor(name)).toHaveAttribute(
        'aria-expanded',
        'false',
      )
    }

    expect(
      screen.queryByRole('link', { name: 'Projects' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: 'Meetings' }),
    ).not.toBeInTheDocument()
  })

  it('expands a group via its chevron, revealing Projects and Meetings without navigating', async () => {
    renderSidebar(contextValue(), '/meetings?group=11')
    await waitForTree()

    expect(
      screen.getByRole('status', { name: 'Current location' }),
    ).toHaveTextContent('/meetings?group=11')

    fireEvent.click(chevronFor('Bravo Group'))

    expect(chevronFor('Bravo Group')).toHaveAttribute(
      'aria-expanded',
      'true',
    )

    const row = rowFor('Bravo Group')
    expect(within(row).getByRole('link', { name: 'Projects' })).toHaveAttribute(
      'href',
      '/projects?group=11',
    )
    expect(within(row).getByRole('link', { name: 'Meetings' })).toHaveAttribute(
      'href',
      '/meetings?group=11',
    )

    // Expansion is a local disclosure only: no navigation.
    expect(
      screen.getByRole('status', { name: 'Current location' }),
    ).toHaveTextContent('/meetings?group=11')
  })

  it('collapses the group again on the second chevron click', async () => {
    renderSidebar(contextValue(), '/my-work')
    await waitForTree()

    fireEvent.click(chevronFor('Bravo Group'))
    expect(chevronFor('Bravo Group')).toHaveAttribute(
      'aria-expanded',
      'true',
    )

    fireEvent.click(chevronFor('Bravo Group'))
    expect(chevronFor('Bravo Group')).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(
      within(rowFor('Bravo Group')).queryByRole('link', {
        name: 'Projects',
      }),
    ).not.toBeInTheDocument()
  })

  it('navigates the group name to the Research Group Overview without side effects (QA-11)', async () => {
    const setActiveResearchGroupId = vi.fn()

    renderSidebar(
      contextValue({ setActiveResearchGroupId }),
      '/meetings?group=11',
    )
    await waitForTree()

    fireEvent.click(labelFor('Alpha Group'))

    // Pure navigation to the approved Overview route — no
    // contextual list switching, no select-in-place.
    expect(
      screen.getByRole('status', { name: 'Current location' }),
    ).toHaveTextContent('/groups/22')
    expect(setActiveResearchGroupId).not.toHaveBeenCalled()

    // The label must not toggle the manual expansion state —
    // even though the route now contextually reveals the group.
    expect(
      screen.getByRole('button', { name: 'Expand Alpha Group' }),
    ).toBeInTheDocument()
  })

  it('navigates the group name to the Overview from a personal page (no select-in-place)', async () => {
    const setActiveResearchGroupId = vi.fn()
    renderSidebar(contextValue({ setActiveResearchGroupId }), '/')
    await waitForTree()

    fireEvent.click(labelFor('Alpha Group'))

    expect(
      screen.getByRole('status', { name: 'Current location' }),
    ).toHaveTextContent('/groups/22')
    expect(setActiveResearchGroupId).not.toHaveBeenCalled()
  })

  it('navigates the group name to the Overview from a Project detail route', async () => {
    renderSidebar(contextValue(), '/projects/303/work-items')
    await waitForTree()

    fireEvent.click(labelFor('Bravo Group'))

    expect(
      screen.getByRole('status', { name: 'Current location' }),
    ).toHaveTextContent('/groups/11')
  })

  it('emphasizes the group name on its Overview route only (QA-14/QA-15)', async () => {
    renderSidebar(contextValue(), '/groups/22')
    await waitForTree()

    expect(labelFor('Alpha Group')).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(labelFor('Bravo Group')).not.toHaveAttribute(
      'aria-current',
    )

    // Expansion stays independent: no group is manually expanded.
    expect(chevronFor('Alpha Group')).toHaveAttribute(
      'aria-expanded',
      'true',
    ) // contextual reveal by the Overview route
    expect(
      screen.getByRole('button', { name: 'Expand Alpha Group' }),
    ).toBeInTheDocument() // manual state still collapsed
  })

  it('does not emphasize any group name outside a group route', async () => {
    // The provider carries an active group — selection must NOT
    // follow it; only the route selects.
    renderSidebar(contextValue(), '/my-work')
    await waitForTree()

    for (const name of [
      'Bravo Group',
      'Alpha Group',
      'Charlie Group',
    ]) {
      expect(labelFor(name)).not.toHaveAttribute(
        'aria-current',
      )
    }
  })

  it('expansion alone never creates selected styling (QA-15)', async () => {
    renderSidebar(contextValue(), '/my-work')
    await waitForTree()

    fireEvent.click(chevronFor('Bravo Group'))
    expect(chevronFor('Bravo Group')).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(labelFor('Bravo Group')).not.toHaveAttribute(
      'aria-current',
    )
  })

  it('hydrates the expansion state from the server after remount/reload', async () => {
    vi.mocked(fetchWorkspaceNavigationPreferences).mockResolvedValue(
      preferences({
        expandedResearchGroups: [GROUP_B.id],
      }),
    )

    const first = renderSidebar(contextValue())
    await waitForTree()

    expect(chevronFor('Alpha Group')).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(
      within(rowFor('Alpha Group')).getByRole('link', {
        name: 'Projects',
      }),
    ).toBeInTheDocument()

    first.unmount()

    // A fresh mount (reload) re-loads the server snapshot and
    // restores the manual expansion state.
    renderSidebar(contextValue())
    await waitForTree()

    expect(chevronFor('Alpha Group')).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(
      fetchWorkspaceNavigationPreferences,
    ).toHaveBeenCalledTimes(2)
  })

  it('persists a manual expansion change as the COMPLETE preference snapshot', async () => {
    renderSidebar(contextValue())
    await waitForTree()

    vi.useFakeTimers()

    try {
      fireEvent.click(chevronFor('Bravo Group'))

      // Nothing is sent before the debounce window elapses.
      expect(
        updateWorkspaceNavigationPreferences,
      ).not.toHaveBeenCalled()

      await act(async () => {
        vi.advanceTimersByTime(300)
      })
    } finally {
      vi.useRealTimers()
    }

    // Exactly one PATCH — the complete current snapshot with ONLY
    // expandedResearchGroups changed.
    expect(
      updateWorkspaceNavigationPreferences,
    ).toHaveBeenCalledTimes(1)
    expect(
      vi.mocked(updateWorkspaceNavigationPreferences).mock
        .calls[0][0],
    ).toEqual({
      researchGroupOrder: [GROUP_A.id, GROUP_B.id, GROUP_C.id],
      expandedResearchGroups: [GROUP_A.id],
      expandedProjectSections: [],
    })
  })

  it('keeps a stale in-flight save from overwriting a newer local expansion', async () => {
    let resolveStale:
      | ((snapshot: ApiWorkspaceNavigationPreferences) => void)
      | undefined

    // The FIRST save hangs; its (stale) normalized answer drops
    // the newer local toggle on purpose.
    vi.mocked(updateWorkspaceNavigationPreferences)
      .mockImplementationOnce(() =>
        new Promise((resolve) => {
          resolveStale = resolve
        }),
      )
      .mockImplementation(async (snapshot) => snapshot)

    renderSidebar(contextValue())
    await waitForTree()

    vi.useFakeTimers()

    try {
      // Toggle 1: expand Bravo → first save goes in flight.
      fireEvent.click(chevronFor('Bravo Group'))
      await act(async () => {
        vi.advanceTimersByTime(300)
      })

      // Toggle 2 (supersedes the in-flight save): expand Alpha.
      fireEvent.click(chevronFor('Alpha Group'))
      await act(async () => {
        vi.advanceTimersByTime(300)
      })

      // The stale response resolves: it becomes the persisted
      // baseline, but must NOT clobber the newer local state.
      await act(async () => {
        resolveStale?.(
          preferences({
            expandedResearchGroups: [GROUP_A.id],
          }),
        )
      })
    } finally {
      vi.useRealTimers()
    }

    // The UI still shows the NEWER local state: both groups
    // expanded.
    expect(chevronFor('Bravo Group')).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(chevronFor('Alpha Group')).toHaveAttribute(
      'aria-expanded',
      'true',
    )

    // The superseding save carried the newer complete snapshot.
    const supersedingCall =
      vi.mocked(updateWorkspaceNavigationPreferences).mock
        .calls[1][0] as ApiWorkspaceNavigationPreferences
    expect(supersedingCall.expandedResearchGroups).toEqual([
      GROUP_A.id,
      GROUP_B.id,
    ])
  })

  it('reveals the route-context group without persisting it as manual expansion', async () => {
    // The stored snapshot has nothing expanded, but the current
    // route points inside Alpha Group.
    renderSidebar(contextValue(), '/projects?group=22')
    await waitForTree()

    // Contextual reveal: the group is visible (its chevron reports
    // the visible state)…
    expect(chevronFor('Alpha Group')).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(
      within(rowFor('Alpha Group')).getByRole('link', {
        name: 'Projects',
      }),
    ).toBeInTheDocument()

    // …yet the MANUAL state is still "collapsed" (the chevron's
    // accessible name reflects what a click would do).
    expect(
      screen.getByRole('button', { name: 'Expand Alpha Group' }),
    ).toBeInTheDocument()

    vi.useFakeTimers()

    try {
      // No manual change happened — nothing may be persisted,
      // however long the debounce window is waited out.
      await act(async () => {
        vi.advanceTimersByTime(1000)
      })
    } finally {
      vi.useRealTimers()
    }

    expect(
      updateWorkspaceNavigationPreferences,
    ).not.toHaveBeenCalled()
  })

  it('reveals the group contextually on its Overview route without persisting', async () => {
    renderSidebar(contextValue(), '/groups/22')
    await waitForTree()

    expect(chevronFor('Alpha Group')).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(
      screen.getByRole('button', { name: 'Expand Alpha Group' }),
    ).toBeInTheDocument()

    vi.useFakeTimers()

    try {
      await act(async () => {
        vi.advanceTimersByTime(1000)
      })
    } finally {
      vi.useRealTimers()
    }

    expect(
      updateWorkspaceNavigationPreferences,
    ).not.toHaveBeenCalled()
  })

  it('reveals the current Project owning group contextually without persisting', async () => {
    // Paper Two (id 102) belongs to Alpha Group (22).
    renderSidebar(
      contextValue(),
      '/projects/102/work-items',
    )
    await waitForTree()

    await waitFor(() => {
      expect(chevronFor('Alpha Group')).toHaveAttribute(
        'aria-expanded',
        'true',
      )
    })
    expect(
      screen.getByRole('button', { name: 'Expand Alpha Group' }),
    ).toBeInTheDocument()

    vi.useFakeTimers()

    try {
      await act(async () => {
        vi.advanceTimersByTime(1000)
      })
    } finally {
      vi.useRealTimers()
    }

    expect(
      updateWorkspaceNavigationPreferences,
    ).not.toHaveBeenCalled()
  })

  it('navigates to the existing Projects destination from a Projects child', async () => {
    renderSidebar(contextValue(), '/meetings?group=11')
    await waitForTree()

    fireEvent.click(chevronFor('Bravo Group'))

    fireEvent.click(
      within(rowFor('Bravo Group')).getByRole('link', {
        name: 'Projects',
      }),
    )

    expect(
      screen.getByRole('status', { name: 'Current location' }),
    ).toHaveTextContent('/projects?group=11')
  })

  it('navigates to the existing Meetings destination from a Meetings child', async () => {
    renderSidebar(contextValue(), '/projects?group=11')
    await waitForTree()

    fireEvent.click(chevronFor('Alpha Group'))

    fireEvent.click(
      within(rowFor('Alpha Group')).getByRole('link', {
        name: 'Meetings',
      }),
    )

    expect(
      screen.getByRole('status', { name: 'Current location' }),
    ).toHaveTextContent('/meetings?group=22')
  })

  it('emphasizes the scoped child row only for its own group scope', async () => {
    renderSidebar(contextValue(), '/projects?group=22')
    await waitForTree()

    const alphaProjects = within(rowFor('Alpha Group')).getByRole(
      'link',
      { name: /Projects/ },
    )
    const bravoProjects = within(rowFor('Bravo Group')).queryByRole(
      'link',
      { name: /Projects/ },
    )

    // Alpha is scoped and revealed by the route: its Projects row
    // is active…
    expect(alphaProjects.className).toContain('font-semibold')

    // …while Bravo (collapsed, different scope) renders nothing.
    expect(bravoProjects).toBeNull()
  })

  it('no longer renders the legacy placeholder destinations', async () => {
    renderSidebar(contextValue())
    await waitForTree()

    for (const label of [
      'Calendar',
      'KVP',
      'Knowledge',
      'Data',
      'People',
    ]) {
      expect(
        screen.queryByText(label, { exact: true }),
      ).not.toBeInTheDocument()
    }
  })

  it('keeps the Sidebar usable when the preference load fails, without ever saving over stored state', async () => {
    vi.mocked(fetchWorkspaceNavigationPreferences).mockRejectedValue(
      new Error('preference unavailable'),
    )

    // No ?group= scope: nothing is contextually revealed.
    renderSidebar(contextValue(), '/my-work')
    await waitForTree()

    // Failure fallback: provider order, everything collapsed.
    expect(renderedGroupNames()).toEqual([
      'Bravo Group',
      'Alpha Group',
      'Charlie Group',
    ])
    expect(chevronFor('Bravo Group')).toHaveAttribute(
      'aria-expanded',
      'false',
    )

    // The disclosure still works locally…
    fireEvent.click(chevronFor('Bravo Group'))
    expect(chevronFor('Bravo Group')).toHaveAttribute(
      'aria-expanded',
      'true',
    )

    vi.useFakeTimers()

    try {
      await act(async () => {
        vi.advanceTimersByTime(1000)
      })
    } finally {
      vi.useRealTimers()
    }

    // …but without a server baseline nothing is written, so the
    // stored preferences can never be clobbered.
    expect(
      updateWorkspaceNavigationPreferences,
    ).not.toHaveBeenCalled()
  })
})

describe('Sidebar global Quick Access data (QA-1..QA-8)', () => {
  it('uses the GLOBAL client exactly once per cold load and never the per-RG client (QA-8)', async () => {
    renderSidebar(contextValue())
    await waitForTree()
    await waitForQuickAccess()

    expect(
      fetchGlobalProjectQuickAccess,
    ).toHaveBeenCalledTimes(1)
    expect(
      fetchProjectQuickAccess,
    ).not.toHaveBeenCalled()

    // Expanding groups must not fan out per-group requests.
    fireEvent.click(chevronFor('Bravo Group'))
    fireEvent.click(chevronFor('Alpha Group'))

    expect(
      fetchGlobalProjectQuickAccess,
    ).toHaveBeenCalledTimes(1)
    expect(
      fetchProjectQuickAccess,
    ).not.toHaveBeenCalled()
  })

  it('renders the snapshot in the exact server order (no client sort)', async () => {
    renderSidebar(contextValue())
    await waitForTree()
    await waitForQuickAccess()

    expect(quickAccessRowNames()).toEqual([
      'Paper One',
      'Paper Two',
      'Paper Three',
      'Paper Four',
      'Paper Five',
    ])
  })

  it('never renders more than five rows (max-five presentation)', async () => {
    vi.mocked(fetchGlobalProjectQuickAccess).mockResolvedValue([
      ...GLOBAL_SNAPSHOT,
      {
        id: 606,
        researchGroupId: 33,
        name: 'Paper Six',
        lastOpenedAt: null,
      },
    ])

    renderSidebar(contextValue())
    await waitForTree()

    const navigation = await screen.findByRole('navigation', {
      name: 'Quick access',
    })

    await waitFor(() => {
      expect(navigation.querySelectorAll('button')).toHaveLength(5)
    })

    expect(
      quickAccessRowNames(),
    ).not.toContain('Paper Six')
  })

  it('shows a compact loading state while the snapshot loads (section stays present)', async () => {
    let resolveQA:
      | ((items: ApiProjectQuickAccessItem[]) => void)
      | undefined

    vi.mocked(fetchGlobalProjectQuickAccess).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveQA = resolve
        }),
    )

    renderSidebar(contextValue())

    expect(
      screen.getByRole('status', {
        name: 'Loading quick access',
      }),
    ).toBeInTheDocument()
    expect(screen.getByText('Quick Access')).toBeInTheDocument()

    await act(async () => {
      resolveQA?.(GLOBAL_SNAPSHOT)
    })

    await waitForQuickAccess()
  })

  it('shows a compact error with a working Retry (one new request)', async () => {
    vi.mocked(fetchGlobalProjectQuickAccess)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(GLOBAL_SNAPSHOT)

    renderSidebar(contextValue())

    const retry = await screen.findByRole('button', {
      name: 'Retry',
    })
    expect(retry.closest('nav')).not.toBeNull()

    fireEvent.click(retry)

    // Retry performs exactly ONE new global request.
    await waitForQuickAccess()
    expect(
      fetchGlobalProjectQuickAccess,
    ).toHaveBeenCalledTimes(2)
    expect(
      screen.queryByRole('button', { name: 'Retry' }),
    ).not.toBeInTheDocument()
  })

  it('keeps the section present for an empty result', async () => {
    vi.mocked(fetchGlobalProjectQuickAccess).mockResolvedValue([])

    renderSidebar(contextValue())
    await waitForTree()

    await waitFor(() => {
      expect(
        screen.getByText('No quick access projects.'),
      ).toBeInTheDocument()
    })
    expect(
      screen.getByRole('navigation', { name: 'Quick access' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Quick Access')).toBeInTheDocument()
  })

  it('ignores a stale in-flight response in favor of the newer request (QA-9 race guard)', async () => {
    // The cold load (request A) stays pending; the lifecycle
    // reconciliation (request B) supersedes it.
    const pending: Array<
      (items: ApiProjectQuickAccessItem[]) => void
    > = []

    vi.mocked(fetchGlobalProjectQuickAccess).mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(resolve)
        }),
    )
    vi.mocked(getProject).mockRejectedValue(
      new Error('no longer readable'),
    )

    // Entering a concrete Project whose authoritative getProject
    // fails is the lifecycle evidence that triggers the
    // reconciliation refetch (request B).
    renderSidebar(contextValue(), '/projects/999/work-items')
    await waitForTree()

    // B has been requested once the evidence resolved.
    await waitFor(() => {
      expect(pending).toHaveLength(2)
    })

    const stale = [
      ...GLOBAL_SNAPSHOT,
      {
        id: 999,
        researchGroupId: 22,
        name: 'Outside Project',
        lastOpenedAt: '2026-10-02T08:00:00Z',
      },
    ]
    const fresh = GLOBAL_SNAPSHOT.slice(0, 4)

    // A (the cold load) resolves LATE with the stale answer…
    await act(async () => {
      pending[0]?.(stale)
    })

    // …and B resolves with the authoritative answer.
    await act(async () => {
      pending[1]?.(fresh)
    })

    // The stale response never overwrote the newer one — and the
    // reconciled Project (999) is not resurrected from the stale
    // answer.
    await waitFor(() => {
      expect(quickAccessRowNames()).toEqual([
        'Paper One',
        'Paper Two',
        'Paper Three',
        'Paper Four',
      ])
    })
    expect(
      quickAccessRowNames(),
    ).not.toContain('Outside Project')
  })
})

describe('Sidebar Quick Access spatial stability (QA-2..QA-6, QA-9)', () => {
  it('keeps the snapshot order stable while navigating (QA-3)', async () => {
    renderSidebar(contextValue())
    await waitForTree()
    await waitForQuickAccess()

    const before = quickAccessRowNames()

    // Enter a snapshot Project through its shortcut.
    fireEvent.click(quickAccessRow('Paper Three'))
    expect(
      screen.getByRole('status', { name: 'Current location' }),
    ).toHaveTextContent('/projects/303/work-items')

    // The snapshot is untouched: same rows, same order.
    expect(quickAccessRowNames()).toEqual(before)
    expect(
      fetchGlobalProjectQuickAccess,
    ).toHaveBeenCalledTimes(1)
  })

  it('keeps a current Project in its exact snapshot slot (QA-4)', async () => {
    renderSidebar(
      contextValue(),
      '/projects/303/work-items',
    )
    await waitForTree()
    await waitForQuickAccess()

    // Paper Three is third in the snapshot and stays third —
    // only the active emphasis changed.
    expect(quickAccessRowNames()).toEqual([
      'Paper One',
      'Paper Two',
      'Paper Three',
      'Paper Four',
      'Paper Five',
    ])
    expect(
      quickAccessRow('Paper Three'),
    ).toHaveAttribute('aria-current', 'true')

    for (const name of [
      'Paper One',
      'Paper Two',
      'Paper Four',
      'Paper Five',
    ]) {
      expect(quickAccessRow(name)).not.toHaveAttribute(
        'aria-current',
      )
    }
  })

  it('does not refetch or reorder on cross-Research-Group Project navigation (QA-9)', async () => {
    // Start inside Paper Three (Bravo Group, 11).
    renderSidebar(
      contextValue(),
      '/projects/303/work-items',
    )
    await waitForTree()
    await waitForQuickAccess()

    const before = quickAccessRowNames()

    // Navigate to Paper Two (Alpha Group, 22) — a different
    // Research Group.
    navigateTo('/projects/102/work-items')

    await waitFor(() => {
      expect(
        quickAccessRow('Paper Two'),
      ).toHaveAttribute('aria-current', 'true')
    })

    // The global snapshot is group-independent: no refetch, no
    // reorder.
    expect(quickAccessRowNames()).toEqual(before)
    expect(
      fetchGlobalProjectQuickAccess,
    ).toHaveBeenCalledTimes(1)
  })

  it('does not invalidate or reorder after a successful recordProjectOpen (QA-6)', async () => {
    renderSidebar(
      contextValue(),
      '/projects/303/work-items',
    )
    await waitForTree()
    await waitForQuickAccess()

    const before = quickAccessRowNames()

    await waitFor(() => {
      expect(recordProjectOpen).toHaveBeenCalledWith(303)
    })

    expect(recordProjectOpen).toHaveBeenCalledTimes(1)
    expect(quickAccessRowNames()).toEqual(before)
    expect(
      fetchGlobalProjectQuickAccess,
    ).toHaveBeenCalledTimes(1)
  })

  it('appends the current Project to a partial snapshot (QA-5)', async () => {
    vi.mocked(fetchGlobalProjectQuickAccess).mockResolvedValue(
      GLOBAL_SNAPSHOT.slice(0, 4),
    )

    renderSidebar(
      contextValue(),
      '/projects/999/work-items',
    )
    await waitForTree()

    await waitFor(() => {
      expect(quickAccessRowNames()).toEqual([
        'Paper One',
        'Paper Two',
        'Paper Three',
        'Paper Four',
        'Outside Project',
      ])
    })
  })

  it('replaces only the fifth slot for a full snapshot (QA-5)', async () => {
    renderSidebar(
      contextValue(),
      '/projects/999/work-items',
    )
    await waitForTree()

    await waitFor(() => {
      expect(quickAccessRowNames()).toEqual([
        'Paper One',
        'Paper Two',
        'Paper Three',
        'Paper Four',
        'Outside Project',
      ])
    })

    // The displaced fifth candidate is not duplicated.
    expect(
      screen.queryByRole('button', { name: 'Paper Five' }),
    ).not.toBeInTheDocument()
  })

  it('restores the normal snapshot presentation when leaving the current context (QA-5)', async () => {
    renderSidebar(
      contextValue(),
      '/projects/999/work-items',
    )
    await waitForTree()

    await waitFor(() => {
      expect(
        quickAccessRowNames().at(-1),
      ).toBe('Outside Project')
    })

    // Leaving the concrete Project ends the contextual context.
    navigateTo('/my-work')

    await waitFor(() => {
      expect(quickAccessRowNames()).toEqual([
        'Paper One',
        'Paper Two',
        'Paper Three',
        'Paper Four',
        'Paper Five',
      ])
    })
  })

  it('never persists the contextual substitution', async () => {
    renderSidebar(
      contextValue(),
      '/projects/999/work-items',
    )
    await waitForTree()

    await waitFor(() => {
      expect(
        quickAccessRowNames().at(-1),
      ).toBe('Outside Project')
    })

    vi.useFakeTimers()

    try {
      await act(async () => {
        vi.advanceTimersByTime(1000)
      })
    } finally {
      vi.useRealTimers()
    }

    expect(
      updateWorkspaceNavigationPreferences,
    ).not.toHaveBeenCalled()
  })

  it('keeps an archived current Project visible contextually while open (QA-9)', async () => {
    vi.mocked(fetchGlobalProjectQuickAccess).mockResolvedValue(
      GLOBAL_SNAPSHOT.slice(0, 4),
    )
    vi.mocked(getProject).mockImplementation(
      async (projectId) =>
        projectForId(projectId, {
          archivedAt: '2026-10-01T08:00:00Z',
        }),
    )

    renderSidebar(
      contextValue(),
      '/projects/999/work-items',
    )
    await waitForTree()

    // The archived current Project is not an eligible candidate,
    // but it stays visible contextually while being viewed.
    await waitFor(() => {
      expect(
        quickAccessRowNames().at(-1),
      ).toBe('Outside Project')
    })
  })

  it('reconciles the snapshot when the current Project is no longer readable (QA-9 evidence)', async () => {
    vi.mocked(getProject).mockRejectedValue(
      new Error('Project not found'),
    )

    renderSidebar(
      contextValue(),
      '/projects/999/work-items',
    )
    await waitForTree()

    // Evidence (authoritative getProject failure) → one
    // reconciliation refetch…
    await waitFor(() => {
      expect(
        fetchGlobalProjectQuickAccess,
      ).toHaveBeenCalledTimes(2)
    })

    // …and no contextual row is fabricated for the unreadable
    // Project.
    await waitFor(() => {
      expect(
        screen.queryByRole('button', {
          name: 'Outside Project',
        }),
      ).not.toBeInTheDocument()
    })
    expect(quickAccessRowNames()).toEqual([
      'Paper One',
      'Paper Two',
      'Paper Three',
      'Paper Four',
      'Paper Five',
    ])
  })
})

describe('Sidebar central Project-open recording (QA-17)', () => {
  it('records a deep link into a concrete Project exactly once', async () => {
    renderSidebar(
      contextValue(),
      '/projects/303/work-items',
    )
    await waitForTree()

    await waitFor(() => {
      expect(recordProjectOpen).toHaveBeenCalledTimes(1)
      expect(recordProjectOpen).toHaveBeenCalledWith(303)
    })
  })

  it('records a Quick Access shortcut entry exactly once', async () => {
    renderSidebar(contextValue())
    await waitForTree()
    await waitForQuickAccess()

    expect(recordProjectOpen).not.toHaveBeenCalled()

    fireEvent.click(quickAccessRow('Paper One'))

    await waitFor(() => {
      expect(recordProjectOpen).toHaveBeenCalledTimes(1)
      expect(recordProjectOpen).toHaveBeenCalledWith(201)
    })
  })

  it('records a Projects-list entry exactly once', async () => {
    renderSidebar(
      contextValue(),
      '/projects?group=11',
    )
    await waitForTree()

    navigateTo('/projects/104/work-items')

    await waitFor(() => {
      expect(recordProjectOpen).toHaveBeenCalledTimes(1)
      expect(recordProjectOpen).toHaveBeenCalledWith(104)
    })
  })

  it('records each Project of an A → B switch once', async () => {
    renderSidebar(
      contextValue(),
      '/projects/303/work-items',
    )
    await waitForTree()

    await waitFor(() => {
      expect(recordProjectOpen).toHaveBeenCalledWith(303)
    })

    navigateTo('/projects/102/work-items')

    await waitFor(() => {
      expect(recordProjectOpen).toHaveBeenCalledTimes(2)
      expect(recordProjectOpen).toHaveBeenCalledWith(102)
    })
  })

  it('does not re-record tab changes inside the same Project', async () => {
    renderSidebar(
      contextValue(),
      '/projects/303/work-items',
    )
    await waitForTree()

    await waitFor(() => {
      expect(recordProjectOpen).toHaveBeenCalledTimes(1)
    })

    navigateTo('/projects/303/overview')
    navigateTo('/projects/303/members')
    navigateTo('/projects/303/settings')

    // Give any (incorrect) extra write a tick to happen.
    await act(async () => {
      await Promise.resolve()
    })

    expect(recordProjectOpen).toHaveBeenCalledTimes(1)
  })

  it('records a new open when leaving and later re-entering the Project', async () => {
    renderSidebar(
      contextValue(),
      '/projects/303/work-items',
    )
    await waitForTree()

    await waitFor(() => {
      expect(recordProjectOpen).toHaveBeenCalledTimes(1)
    })

    navigateTo('/my-work')
    navigateTo('/projects/303/work-items')

    await waitFor(() => {
      expect(recordProjectOpen).toHaveBeenCalledTimes(2)
      expect(recordProjectOpen).toHaveBeenNthCalledWith(
        2,
        303,
      )
    })
  })

  it('does not duplicate the logical open under StrictMode replay', async () => {
    vi.mocked(useResearchGroup).mockReturnValue(
      contextValue(),
    )

    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/projects/303/work-items']}>
          <Sidebar />
          <TestNavigation />
        </MemoryRouter>
      </StrictMode>,
    )

    await waitFor(() => {
      expect(recordProjectOpen).toHaveBeenCalledTimes(1)
      expect(recordProjectOpen).toHaveBeenCalledWith(303)
    })

    // The cold load also happened exactly once.
    await waitFor(() => {
      expect(
        fetchGlobalProjectQuickAccess,
      ).toHaveBeenCalledTimes(1)
    })
  })

  it('never blocks navigation or rendering when the open write fails', async () => {
    vi.mocked(recordProjectOpen).mockRejectedValue(
      new Error('write unavailable'),
    )

    renderSidebar(
      contextValue(),
      '/projects/303/work-items',
    )
    await waitForTree()
    await waitForQuickAccess()

    // Navigation keeps working and the rows stay rendered.
    navigateTo('/my-work')

    expect(
      screen.getByRole('status', { name: 'Current location' }),
    ).toHaveTextContent('/my-work')
    expect(quickAccessRowNames()).toHaveLength(5)
  })
})

describe('Sidebar workspace-navigation preferences (retained contract)', () => {
  it('does not use expandedProjectSections for presentation', async () => {
    // The stored snapshot leaves "Projects sections" expanded for
    // two groups — the Sidebar must not render ANY third level.
    vi.mocked(fetchWorkspaceNavigationPreferences).mockResolvedValue(
      preferences({
        expandedProjectSections: [GROUP_A.id, GROUP_C.id],
      }),
    )

    renderSidebar(contextValue())
    await waitForTree()

    for (const name of [
      'Bravo Group',
      'Alpha Group',
      'Charlie Group',
    ]) {
      fireEvent.click(chevronFor(name))
    }

    for (const name of [
      'Bravo Group',
      'Alpha Group',
      'Charlie Group',
    ]) {
      const links = within(rowFor(name)).getAllByRole('link')

      // EXACTLY two child rows, nothing else.
      expect(links.map((link) => link.textContent?.trim())).toEqual([
        'folder_openProjects',
        'groupsMeetings',
      ])
    }
  })

  it('round-trips expandedProjectSections without clearing it', async () => {
    vi.mocked(fetchWorkspaceNavigationPreferences).mockResolvedValue(
      preferences({
        expandedProjectSections: [7],
      }),
    )

    renderSidebar(contextValue())
    await waitForTree()

    vi.useFakeTimers()

    try {
      fireEvent.click(chevronFor('Bravo Group'))

      await act(async () => {
        vi.advanceTimersByTime(300)
      })
    } finally {
      vi.useRealTimers()
    }

    expect(
      updateWorkspaceNavigationPreferences,
    ).toHaveBeenCalledTimes(1)

    const payload =
      vi.mocked(updateWorkspaceNavigationPreferences).mock
        .calls[0][0] as ApiWorkspaceNavigationPreferences

    // The complete snapshot keeps the stored value untouched —
    // only the manual expansion changed.
    expect(payload).toEqual({
      researchGroupOrder: [GROUP_A.id, GROUP_B.id, GROUP_C.id],
      expandedResearchGroups: [GROUP_A.id],
      expandedProjectSections: [7],
    })
  })
})

describe('Sidebar group creation (parent render boundary)', () => {
  it('keeps a Create research group entry for users with groups', async () => {
    renderSidebar(contextValue())
    await waitForTree()

    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: 'Create research group',
        }),
      ).toBeVisible()
    })

    expect(
      screen.getByRole('navigation', {
        name: 'Research groups',
      }),
    ).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Bravo Group' }),
    ).toBeVisible()
  })
})
