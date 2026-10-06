// @vitest-environment happy-dom
/**
 * Route transition foundation — behavioral contract.
 *
 * These tests run the REAL chrome (AppShell + Sidebar + TopBar/
 * UserMenu + SettingsLayout) through the REAL data router
 * (`createMemoryRouter` + the `react-router/dom` RouterProvider),
 * with `document.startViewTransition` stubbed at the browser-API
 * boundary. They assert that global navigation sources opt into
 * the native View Transition integration (the transition callback
 * is the one that commits the navigation), that unopted navigation
 * stays a plain navigation, and that browsers without View
 * Transition support navigate normally.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Navigate,
  Outlet,
  useNavigate,
} from 'react-router'
import { createMemoryRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'

import type {
  ApiProject,
  ApiProjectQuickAccessItem,
  ApiResearchGroup,
  ApiUser,
  ApiWorkspaceNavigationPreferences,
} from '../../api/types'
import type {
  ResearchGroupContextValue,
} from '../../features/research-group/ResearchGroupContext'
import { useResearchGroup } from '../../features/research-group/useResearchGroup'

import { AppShell } from './AppShell'
import { SettingsLayout } from './SettingsLayout'

/* ── Mocks (same seams as Sidebar.test.tsx / TopBar.test.tsx) ──── */

const sessionUser: ApiUser = {
  id: 1,
  username: 'alex',
  firstName: 'Alex',
  lastName: '',
  email: 'alex@example.com',
}

vi.mock('../../api/useSession', () => ({
  useSession: () => ({
    user: sessionUser,
    loading: false,
    error: null,
    login: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    setAuthenticatedUser: vi.fn(),
  }),
}))

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

import {
  fetchGlobalProjectQuickAccess,
  recordProjectOpen,
} from '../../api/project-quick-access'
import { getProject } from '../../api/projects'
import { fetchWorkspaceNavigationPreferences } from '../../api/workspace-navigation-preferences'

const GROUP_A: ApiResearchGroup = {
  id: 11,
  name: 'Bravo Group',
  role: 'member',
}

const PAPER_ONE: ApiProjectQuickAccessItem = {
  id: 201,
  researchGroupId: 11,
  name: 'Paper One',
  lastOpenedAt: '2026-09-02T08:00:00Z',
}

const PROJECT_ONE: ApiProject = {
  id: 201,
  researchGroupId: 11,
  name: 'Paper One',
  description: '',
  status: 'active',
  archivedAt: null,
  currentUserRole: 'owner',
  createdAt: '2026-01-01T08:00:00Z',
  updatedAt: '2026-01-01T08:00:00Z',
}

function contextValue(): ResearchGroupContextValue {
  return {
    groups: [GROUP_A],
    activeResearchGroupId: GROUP_A.id,
    activeResearchGroup: GROUP_A,
    loading: false,
    error: null,
    setActiveResearchGroupId: vi.fn(),
    reloadResearchGroups: vi.fn(),
    addResearchGroup: vi.fn(),
  }
}

/* ── Test route tree over the real chrome ──────────────────────── */

function PageLabel({ text }: { text: string }) {
  return <div>{text}</div>
}

/** A deliberate NON-opted-in programmatic navigation control. */
function PlainNavButton() {
  const navigate = useNavigate()

  return (
    <button
      type="button"
      aria-label="Plain nav to Meetings"
      onClick={() => navigate('/meetings')}
    >
      plain nav
    </button>
  )
}

function testRoutes() {
  return [
    {
      element: (
        <AppShell>
          <Outlet />
        </AppShell>
      ),
      children: [
        {
          index: true,
          element: (
            <>
              <PageLabel text="Home page content" />
              <PlainNavButton />
            </>
          ),
        },
        {
          path: 'my-work',
          element: <PageLabel text="My Work page content" />,
        },
        {
          path: 'notes',
          element: <PageLabel text="Notes page content" />,
        },
        {
          path: 'projects',
          element: <PageLabel text="Projects page content" />,
        },
        {
          path: 'projects/:projectId/work-items',
          element: <PageLabel text="Project detail page content" />,
        },
        {
          path: 'meetings',
          element: <PageLabel text="Meetings page content" />,
        },
        {
          path: 'notifications',
          element: <PageLabel text="Notifications page content" />,
        },
        {
          path: 'profile',
          element: <PageLabel text="Profile page content" />,
        },
        {
          path: 'settings',
          element: <SettingsLayout />,
          children: [
            {
              index: true,
              element: <Navigate to="appearance" replace />,
            },
            {
              path: 'appearance',
              element: <PageLabel text="Appearance page content" />,
            },
            {
              path: 'invitations',
              element: <PageLabel text="Invitations page content" />,
            },
          ],
        },
        {
          path: '*',
          element: <Navigate to="/" replace />,
        },
      ],
    },
  ]
}

/* ── Browser View Transition API boundary stub ─────────────────── */

interface StartViewTransitionStub {
  startViewTransition?: (
    callback: () => void | Promise<void>,
  ) => { finished: Promise<void> }
}

function startViewTransitionDoc(): StartViewTransitionStub {
  return document as unknown as StartViewTransitionStub
}

let startViewTransition: ReturnType<typeof vi.fn>

/**
 * The stub mirrors the browser contract closely enough for the
 * router integration: the callback performs the DOM update, and
 * `finished` settles once the transition completes.
 */
function installStartViewTransition() {
  startViewTransition = vi.fn((callback: () => void | Promise<void>) => {
    void callback()
    return { finished: Promise.resolve() }
  })

  startViewTransitionDoc().startViewTransition =
    startViewTransition as StartViewTransitionStub['startViewTransition']
}

function uninstallStartViewTransition() {
  delete startViewTransitionDoc().startViewTransition
}

/* ── Harness ───────────────────────────────────────────────────── */

function renderChrome(initialEntry: string) {
  vi.mocked(useResearchGroup).mockReturnValue(contextValue())

  const router = createMemoryRouter(testRoutes(), {
    initialEntries: [initialEntry],
  })

  render(<RouterProvider router={router} />)

  return router
}

/** The Sidebar's personal / Quick Access navigation links. */
function sidebarLink(name: string) {
  return screen.getByRole('link', { name })
}

/** Wait until the Research Group tree has hydrated (preference GET). */
async function waitForGroupTree() {
  await vi.waitFor(() => {
    expect(
      screen.getByRole('navigation', {
        name: 'Research groups',
      }),
    ).toBeInTheDocument()
  })
}

function expandGroup(name: string) {
  fireEvent.click(
    screen.getByRole('button', { name: `Expand ${name}` }),
  )
}

function groupScopedLink(name: string) {
  return within(
    screen.getByRole('navigation', {
      name: 'Research groups',
    }),
  ).getByRole('link', { name })
}

async function waitForQuickAccess() {
  await vi.waitFor(() => {
    expect(
      screen
        .getByRole('navigation', { name: 'Quick access' })
        .querySelectorAll('button'),
    ).toHaveLength(1)
  })
}

/**
 * Assert a committed, transitioned global navigation: the View
 * Transition API was invoked, its callback committed the route
 * update (new page content is on screen inside the scoped <main>),
 * and the URL moved to the expected destination.
 */
async function assertTransitionedNavigation(
  router: ReturnType<typeof createMemoryRouter>,
  expectedPath: string,
  pageText: string,
) {
  await vi.waitFor(() => {
    expect(startViewTransition).toHaveBeenCalled()
  })

  await vi.waitFor(() => {
    expect(screen.getByText(pageText)).toBeInTheDocument()
  })

  // The committed content lives inside the AppShell main region.
  expect(screen.getByText(pageText).closest('main')).not.toBeNull()

  // The route state moved (the transition callback committed the
  // navigation — nothing stays behind the transition).
  expect(
    router.state.location.pathname + router.state.location.search,
  ).toBe(expectedPath)
}

beforeEach(() => {
  vi.clearAllMocks()
  installStartViewTransition()

  vi.mocked(fetchWorkspaceNavigationPreferences).mockResolvedValue({
    researchGroupOrder: [GROUP_A.id],
    expandedResearchGroups: [],
    expandedProjectSections: [],
  } satisfies ApiWorkspaceNavigationPreferences)

  vi.mocked(fetchGlobalProjectQuickAccess).mockResolvedValue([
    PAPER_ONE,
  ])

  vi.mocked(recordProjectOpen).mockImplementation(
    async (projectId) => ({
      projectId,
      lastOpenedAt: '2026-10-05T08:00:00Z',
    }),
  )

  vi.mocked(getProject).mockImplementation(async (projectId) => {
    if (projectId === PAPER_ONE.id) {
      return PROJECT_ONE
    }

    throw new Error(`No fixture Project for id ${projectId}`)
  })
})

afterEach(() => {
  cleanup()
  uninstallStartViewTransition()
})

describe('route transition scope', () => {
  it('names exactly the AppShell main content region (chrome stays unscoped)', () => {
    renderChrome('/')

    const main = document.querySelector('main')
    expect(main).not.toBeNull()
    expect(main?.classList.contains('fg-route-content')).toBe(true)

    // The Sidebar and TopBar are OUTSIDE the transition surface
    // (they are chrome siblings of <main>, not descendants).
    expect(main?.querySelector('aside')).toBeNull()
    expect(main?.querySelector('header')).toBeNull()
    expect(document.querySelector('aside')).not.toBeNull()
    expect(document.querySelector('header')).not.toBeNull()
  })
})

describe('global navigation opt-in (native View Transition)', () => {
  it('Home → My Work transitions through the main content region', async () => {
    const router = renderChrome('/')

    fireEvent.click(sidebarLink('My Work'))

    await assertTransitionedNavigation(
      router,
      '/my-work',
      'My Work page content',
    )
  })

  it('My Work → Notes transitions the same way', async () => {
    const router = renderChrome('/my-work')

    fireEvent.click(sidebarLink('Notes'))

    await assertTransitionedNavigation(
      router,
      '/notes',
      'Notes page content',
    )
  })

  it('Notes → Projects (group-scoped row) transitions the same way', async () => {
    const router = renderChrome('/notes')
    await waitForGroupTree()

    expandGroup('Bravo Group')
    fireEvent.click(groupScopedLink('Projects'))

    await assertTransitionedNavigation(
      router,
      '/projects?group=11',
      'Projects page content',
    )
  })

  it('Projects → Meetings (group-scoped row) transitions the same way', async () => {
    const router = renderChrome('/projects')
    await waitForGroupTree()

    expandGroup('Bravo Group')
    fireEvent.click(groupScopedLink('Meetings'))

    await assertTransitionedNavigation(
      router,
      '/meetings?group=11',
      'Meetings page content',
    )
  })

  it('Meetings → Settings (topbar user menu) transitions the same way', async () => {
    renderChrome('/meetings')

    fireEvent.click(screen.getByRole('button', { name: 'Alex' }))
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Settings' }),
    )

    await vi.waitFor(() => {
      expect(startViewTransition).toHaveBeenCalled()
    })

    await vi.waitFor(() => {
      expect(
        screen.getByText('Appearance page content'),
      ).toBeInTheDocument()
    })
  })

  it('Quick Access → Project detail opts into the route transition', async () => {
    const router = renderChrome('/')
    await waitForQuickAccess()

    fireEvent.click(
      within(
        screen.getByRole('navigation', {
          name: 'Quick access',
        }),
      ).getByRole('button', { name: 'Paper One' }),
    )

    await assertTransitionedNavigation(
      router,
      '/projects/201/work-items',
      'Project detail page content',
    )
  })

  it('group-scoped Projects child row transitions the same way', async () => {
    renderChrome('/projects')
    await waitForGroupTree()

    expandGroup('Bravo Group')
    fireEvent.click(groupScopedLink('Projects'))

    await vi.waitFor(() => {
      expect(startViewTransition).toHaveBeenCalled()
    })

    await vi.waitFor(() => {
      expect(
        screen
          .getByRole('navigation', {
            name: 'Research groups',
          })
          .querySelector('[aria-current="page"]'),
      ).toHaveTextContent('Projects')
    })
  })

  it('the Notifications destination transitions the same way', async () => {
    const router = renderChrome('/')

    fireEvent.click(sidebarLink('Notifications'))

    await assertTransitionedNavigation(
      router,
      '/notifications',
      'Notifications page content',
    )
  })

  it('Settings section tabs (plain Router links) transition the same way', async () => {
    renderChrome('/settings/appearance')

    fireEvent.click(screen.getByRole('link', { name: 'Invitations' }))

    await vi.waitFor(() => {
      expect(startViewTransition).toHaveBeenCalled()
    })

    await vi.waitFor(() => {
      expect(
        screen.getByText('Invitations page content'),
      ).toBeInTheDocument()
    })
  })

  it('the user menu Profile destination transitions the same way', async () => {
    const router = renderChrome('/')

    fireEvent.click(screen.getByRole('button', { name: 'Alex' }))
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Profile' }),
    )

    await assertTransitionedNavigation(
      router,
      '/profile',
      'Profile page content',
    )
  })
})

describe('transition boundaries', () => {
  it('a NON-opted-in programmatic navigation does not start a view transition', async () => {
    renderChrome('/')

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Plain nav to Meetings',
      }),
    )

    await vi.waitFor(() => {
      expect(
        screen.getByText('Meetings page content'),
      ).toBeInTheDocument()
    })

    expect(startViewTransition).not.toHaveBeenCalled()
  })

  it('without View Transition support, navigation is ordinary and correct', async () => {
    uninstallStartViewTransition()

    renderChrome('/')

    fireEvent.click(sidebarLink('My Work'))

    await vi.waitFor(() => {
      expect(
        screen.getByText('My Work page content'),
      ).toBeInTheDocument()
    })

    expect(startViewTransition).not.toHaveBeenCalled()
  })

  it('leaves the Sidebar and TopBar mounted across a transition', async () => {
    renderChrome('/')

    const beforeAside = document.querySelector('aside')
    const beforeHeader = document.querySelector('header')

    fireEvent.click(sidebarLink('My Work'))

    await vi.waitFor(() => {
      expect(
        screen.getByText('My Work page content'),
      ).toBeInTheDocument()
    })

    // Same chrome instances — the shell never remounts or blinks
    // out of the page during the route transition.
    expect(document.querySelector('aside')).toBe(beforeAside)
    expect(document.querySelector('header')).toBe(beforeHeader)
  })
})
