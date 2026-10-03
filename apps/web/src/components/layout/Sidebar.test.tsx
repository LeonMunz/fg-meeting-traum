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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, useLocation } from 'react-router'

import {
  fetchWorkspaceNavigationPreferences,
  updateWorkspaceNavigationPreferences,
} from '../../api/workspace-navigation-preferences'
import type {
  ApiResearchGroup,
  ApiWorkspaceNavigationPreferences,
} from '../../api/types'
import type {
  ResearchGroupContextValue,
} from '../../features/research-group/ResearchGroupContext'
import { useResearchGroup } from '../../features/research-group/useResearchGroup'

import { Sidebar } from './Sidebar'

vi.mock('../../api/workspace-navigation-preferences', () => ({
  fetchWorkspaceNavigationPreferences: vi.fn(),
  updateWorkspaceNavigationPreferences: vi.fn(),
}))

vi.mock('../../features/research-group/useResearchGroup', () => ({
  useResearchGroup: vi.fn(),
}))

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

function LocationProbe() {
  const location = useLocation()

  return <output aria-label="Current location">{`${location.pathname}${location.search}`}</output>
}

function renderSidebar(
  value: ResearchGroupContextValue,
  initialEntry = '/projects?group=11',
) {
  vi.mocked(useResearchGroup).mockReturnValue(value)

  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Sidebar />
      <LocationProbe />
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

/** The group label (selection) button. */
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
})

afterEach(cleanup)

describe('Sidebar personal navigation', () => {
  it('renders Notes directly with Home and My Work, in that order', async () => {
    renderSidebar(contextValue())
    await waitForTree()

    // The personal navigation is the first (unlabeled) nav in the
    // aside, ahead of the research-group section.
    const personalNav = screen.getAllByRole('navigation')[0]
    const entries = Array.from(personalNav.children)

    expect(entries.map((entry) => entry.textContent)).toEqual([
      'homeHome',
      'assignmentMy Work',
      'sticky_note_2Notes',
    ])
  })

  it('points Notes at /notes without any research-group scoping', async () => {
    // An active research group is in effect (the mocked context
    // provides activeResearchGroupId 11) — the group-scoped
    // children carry ?group=…, Notes must not.
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
})

describe('Sidebar research group tree', () => {
  it('renders all accessible Research Groups in the preference order returned by the server', async () => {
    // The provider supplies the groups in its own order; the
    // persisted (server-returned) order must win.
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

  it('navigates by the existing routing model on a label click without toggling expansion', async () => {
    const setActiveResearchGroupId = vi.fn()
    renderSidebar(
      contextValue({ setActiveResearchGroupId }),
      '/meetings?group=11',
    )
    await waitForTree()

    fireEvent.click(labelFor('Alpha Group'))

    // Group list page: the same list under the newly selected
    // group (the former selector's contextual navigation).
    expect(
      screen.getByRole('status', { name: 'Current location' }),
    ).toHaveTextContent('/meetings?group=22')
    expect(setActiveResearchGroupId).toHaveBeenCalledWith(22)

    // The label must not toggle the MANUAL expansion state — the
    // chevron's accessible name (what a click would do) still
    // reads "Expand", even though the route now contextually
    // reveals the group.
    expect(
      screen.getByRole('button', { name: 'Expand Alpha Group' }),
    ).toBeInTheDocument()
  })

  it('selects in place without navigating from a personal page', async () => {
    const setActiveResearchGroupId = vi.fn()
    renderSidebar(contextValue({ setActiveResearchGroupId }), '/')
    await waitForTree()

    fireEvent.click(labelFor('Alpha Group'))

    expect(
      screen.getByRole('status', { name: 'Current location' }),
    ).toHaveTextContent('/')
    expect(setActiveResearchGroupId).toHaveBeenCalledWith(22)
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

  it('keeps expansion state and active-group selection distinct', async () => {
    // Alpha is manually expanded; Bravo is the ACTIVE group but
    // collapsed.
    vi.mocked(fetchWorkspaceNavigationPreferences).mockResolvedValue(
      preferences({
        expandedResearchGroups: [GROUP_B.id],
      }),
    )

    // No ?group= scope: Bravo (active) must not be contextually
    // revealed.
    renderSidebar(contextValue(), '/my-work')
    await waitForTree()

    // Active but collapsed.
    expect(labelFor('Bravo Group')).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(chevronFor('Bravo Group')).toHaveAttribute(
      'aria-expanded',
      'false',
    )

    // Expanded but not active.
    expect(chevronFor('Alpha Group')).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(labelFor('Alpha Group')).not.toHaveAttribute(
      'aria-current',
    )
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

  it('offers the compact group overflow menu with the existing Settings destination for admins only', async () => {
    renderSidebar(contextValue())
    await waitForTree()

    // Admin row carries the affordance; member rows do not.
    const alphaMore = screen.getByRole('button', {
      name: 'More options for Alpha Group',
    })
    expect(
      screen.queryByRole('button', {
        name: 'More options for Bravo Group',
      }),
    ).toBeNull()

    // Opening it must not toggle or navigate the row.
    expect(
      screen.getByRole('status', { name: 'Current location' }),
    ).toHaveTextContent('/projects?group=11')
    expect(chevronFor('Alpha Group')).toHaveAttribute(
      'aria-expanded',
      'false',
    )

    fireEvent.click(alphaMore)

    const menu = screen.getByRole('menu', {
      name: 'Alpha Group options',
    })
    expect(
      within(menu).getByRole('menuitem', { name: 'Settings' }),
    ).toBeInTheDocument()

    // The planned "Members" destination does not exist as an
    // existing route and is deliberately not invented here.
    expect(
      within(menu).queryByRole('menuitem', { name: 'Members' }),
    ).not.toBeInTheDocument()

    fireEvent.click(
      within(menu).getByRole('menuitem', { name: 'Settings' }),
    )

    expect(
      screen.getByRole('status', { name: 'Current location' }),
    ).toHaveTextContent('/groups/22/settings')
    // …and the menu closed.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
