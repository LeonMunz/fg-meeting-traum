// @vitest-environment happy-dom
/**
 * Research Group workspace — router integration contract.
 *
 * Renders the CANONICAL application route configuration
 * (`appRoutes`) through a real MemoryRouter + the production
 * data-router composition (`DataRouterApp`, the same component
 * `main.tsx` mounts), and drives REAL navigation (tab link
 * clicks, programmatic navigation, Back/Forward) over the four
 * workspace areas:
 *
 *   /groups/:groupId            → Overview   (index)
 *   /groups/:groupId/projects   → Projects
 *   /groups/:groupId/meetings   → Meetings
 *   /groups/:groupId/settings   → Settings   (admin only)
 *
 * The API boundary is mocked at the typed client layer; every
 * page, the shared workspace layout, the scope hook, and the
 * Research Group provider run UNMOCKED, so the assertions cover
 * the real wiring: the persistent shared header + tab bar, the
 * path-authoritative Research Group scoping, the admin-only
 * Settings tab, the not-found gate for invalid / inaccessible
 * groups, the Meetings `?tab=` state, and the unchanged legacy
 * global list routes.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import {
  createMemoryRouter,
} from 'react-router'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import { me } from '../../api/auth'
import * as meetingsApi from '../../api/meetings'
import * as projectsApi from '../../api/projects'
import {
  addResearchGroupMembership,
  getResearchGroup,
  listResearchGroups,
  listResearchGroupMemberships,
  searchResearchGroupMemberCandidates,
  updateResearchGroup,
} from '../../api/research-groups'
import {
  fetchGlobalProjectQuickAccess,
} from '../../api/project-quick-access'
import {
  fetchWorkspaceNavigationPreferences,
} from '../../api/workspace-navigation-preferences'
import type {
  ApiMeeting,
  ApiProject,
  ApiResearchGroup,
  ApiResearchGroupMembership,
  ApiUser,
} from '../../api/types'

import { DataRouterApp } from '../../app/App'
import { appRoutes } from '../../app/routes'

vi.mock('../../api/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/auth')>()),
  me: vi.fn(),
}))

vi.mock('../../api/research-groups', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/research-groups')>()),
  listResearchGroups: vi.fn(),
  getResearchGroup: vi.fn(),
  listResearchGroupMemberships: vi.fn(),
  updateResearchGroup: vi.fn(),
  updateResearchGroupMembership: vi.fn(),
  createResearchGroup: vi.fn(),
  getResearchGroupMemberOffboardingPreview: vi.fn(),
  searchResearchGroupMemberCandidates: vi.fn(),
  addResearchGroupMembership: vi.fn(),
}))

vi.mock('../../api/project-quick-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/project-quick-access')>()),
  fetchGlobalProjectQuickAccess: vi.fn(),
  recordProjectOpen: vi.fn(),
}))

vi.mock(
  '../../api/workspace-navigation-preferences',
  async (importOriginal) => ({
    ...(
      await importOriginal<
        typeof import(
          '../../api/workspace-navigation-preferences'
        )
      >()
    ),
    fetchWorkspaceNavigationPreferences: vi.fn(),
    updateWorkspaceNavigationPreferences: vi.fn(),
  }),
)

vi.mock('../../api/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/projects')>()),
  getProject: vi.fn(),
  listProjects: vi.fn(),
  createProject: vi.fn(),
}))

vi.mock('../../api/meetings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/meetings')>()),
  listMeetings: vi.fn(),
  listPersonalMeetingRecurrenceOccurrences: vi.fn(),
  listMeetingRecurrences: vi.fn(),
  createMeeting: vi.fn(),
}))

const USER: ApiUser = {
  id: 1,
  username: 'alex',
  firstName: 'Alex',
  lastName: '',
  email: 'alex@example.com',
}

const GROUP_A: ApiResearchGroup = {
  id: 11,
  name: 'Aurora Research',
  role: 'admin',
}

const GROUP_B: ApiResearchGroup = {
  id: 22,
  name: 'Beacon Lab',
  role: 'admin',
}

const PROJECT_A: ApiProject = {
  id: 201,
  researchGroupId: 11,
  name: 'Aurora Paper',
  description: 'Project description',
  status: 'active',
  archivedAt: null,
  currentUserRole: 'owner',
  createdAt: '2026-01-01T08:00:00Z',
  updatedAt: '2026-10-01T08:00:00Z',
}

const PROJECT_B: ApiProject = {
  id: 202,
  researchGroupId: 22,
  name: 'Beacon Paper',
  description: 'Project description',
  status: 'active',
  archivedAt: null,
  currentUserRole: 'owner',
  createdAt: '2026-01-01T08:00:00Z',
  updatedAt: '2026-10-01T08:00:00Z',
}

function makeMeeting(
  researchGroupId: number,
  id: number,
  title: string,
): ApiMeeting {
  return {
    id,
    researchGroupId,
    scope: 'group',
    projectId: null,
    seriesId: null,
    title,
    scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    startedAt: null,
    endedAt: null,
    status: 'upcoming',
    currentMeetingItemId: null,
    participantIds: [],
    actionPermissions: {
      canEdit: true,
      canDelete: true,
      canCancel: false,
    },
    createdById: 1,
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-01T08:00:00Z',
  }
}

const MEETING_A = makeMeeting(11, 301, 'Aurora Sync')
const MEETING_B = makeMeeting(22, 302, 'Beacon Sync')

const MEMBERSHIP: ApiResearchGroupMembership = {
  id: 1,
  role: 'admin',
  joinedAt: null,
  user: {
    id: 1,
    username: 'alex',
    firstName: 'Alex',
    lastName: '',
  },
}

/** All groups currently offered to the signed-in user. */
let currentGroups: ApiResearchGroup[] = [
  GROUP_A,
  GROUP_B,
]

function renderWorkspace(
  initialPath: string,
) {
  const router = createMemoryRouter(appRoutes, {
    initialEntries: [initialPath],
  })

  render(
    <DataRouterApp
      router={router}
    />,
  )

  return router
}

function tabNav() {
  return screen.getByRole('navigation', {
    name: 'Research group sections',
  })
}

function headingLevels() {
  return screen
    .getAllByRole('heading')
    .map((heading) => [
      heading.tagName,
      heading.textContent,
    ])
}

beforeEach(() => {
  vi.clearAllMocks()

  currentGroups = [GROUP_A, GROUP_B]

  vi.mocked(me).mockResolvedValue(USER)

  vi.mocked(listResearchGroups).mockImplementation(
    () =>
      Promise.resolve(
        currentGroups.map((group) => ({ ...group })),
      ),
  )

  vi.mocked(getResearchGroup).mockImplementation(
    async (id: number) => {
      const group =
        currentGroups.find(
          (candidate) => candidate.id === id,
        )

      if (!group) {
        throw new Error('Not found')
      }

      return { ...group }
    },
  )

  vi.mocked(listResearchGroupMemberships)
    .mockResolvedValue([MEMBERSHIP])

  vi.mocked(searchResearchGroupMemberCandidates)
    .mockResolvedValue([])

  vi.mocked(addResearchGroupMembership)
    .mockResolvedValue({ ...MEMBERSHIP })

  vi.mocked(updateResearchGroup)
    .mockImplementation(async (
      id: number,
      input: { name: string },
    ) => {
      const group =
        currentGroups.find(
          (candidate) => candidate.id === id,
        )
      expect(group).toBeDefined()

      return { ...group!, name: input.name }
    })

  vi.mocked(projectsApi.listProjects)
    .mockImplementation(
      async (groupId: number) => {
        return [PROJECT_A, PROJECT_B].filter(
          (project) =>
            project.researchGroupId ===
            groupId,
        )
      },
    )

  vi.mocked(meetingsApi.listMeetings)
    .mockImplementation(
      async (groupId: number) => {
        return [MEETING_A, MEETING_B].filter(
          (meeting) =>
            meeting.researchGroupId ===
            groupId,
        )
      },
    )

  vi.mocked(
    meetingsApi
      .listPersonalMeetingRecurrenceOccurrences,
  ).mockResolvedValue([])

  vi.mocked(
    meetingsApi.listMeetingRecurrences,
  ).mockResolvedValue([])

  vi.mocked(fetchGlobalProjectQuickAccess)
    .mockResolvedValue([])

  vi.mocked(fetchWorkspaceNavigationPreferences)
    .mockResolvedValue({
      researchGroupOrder: [],
      expandedResearchGroups: [],
      expandedProjectSections: [],
    })
})

afterEach(() => {
  cleanup()
})

describe(
  'Research Group workspace — shared layout + nested routes',
  () => {
    it('renders the Overview with the shared header and the active Overview tab at /groups/11', async () => {
      const router =
        renderWorkspace('/groups/11')

      await screen.findByRole(
        'heading',
        { name: 'Aurora Research', level: 1 },
      )

      // Shared header: exactly ONE H1 (the group name) plus
      // the subdued workspace description.
      expect(headingLevels()).toEqual([
        ['H1', 'Aurora Research'],
      ])

      expect(
        screen.getByText('Research group workspace'),
      ).toBeInTheDocument()

      // The Overview content section is present.
      expect(
        screen.getByText(
          /This is the overview for this research group/,
        ),
      ).toBeInTheDocument()

      // Admins see all four workspace tabs, in order, with
      // Overview active on the index route.
      const tabs =
        within(tabNav()).getAllByRole('link')
      expect(
        tabs.map((tab) => tab.textContent),
      ).toEqual([
        'Overview',
        'Projects',
        'Meetings',
        'Settings',
      ])

      expect(tabs[0]).toHaveAttribute(
        'href',
        '/groups/11',
      )
      expect(tabs[0]).toHaveAttribute(
        'aria-current',
        'page',
      )

      for (const tab of tabs.slice(1)) {
        expect(tab).not.toHaveAttribute(
          'aria-current',
        )
      }

      // One shared constrained frame wraps header + content.
      const frames =
        document.querySelectorAll(
          '[data-fg-workspace-content="constrained"]',
        )
      expect(frames).toHaveLength(1)
      expect(
        frames[0]!.contains(
          screen.getByRole('heading', {
            name: 'Aurora Research',
            level: 1,
          }),
        ),
      ).toBe(true)
      expect(
        frames[0]!.contains(tabNav()),
      ).toBe(true)

      expect(
        router.state.location.pathname,
      ).toBe('/groups/11')
    })

    it('keeps header + tabs when clicking Projects and scopes the list to the URL group', async () => {
      const router =
        renderWorkspace('/groups/11')

      await screen.findByRole(
        'heading',
        { name: 'Aurora Research', level: 1 },
      )

      await fireEvent.click(
        within(tabNav()).getByRole('link', {
          name: 'Projects',
        }),
      )

      await waitFor(() => {
        expect(
          router.state.location.pathname,
        ).toBe('/groups/11/projects')
      })

      // The group 11 project is listed …
      await screen.findByRole(
        'link',
        { name: /Aurora Paper/ },
      )

      // … the group 22 project is NOT.
      expect(
        screen.queryByRole(
          'link',
          { name: /Beacon Paper/ },
        ),
      ).not.toBeInTheDocument()

      expect(
        vi.mocked(projectsApi.listProjects),
      ).toHaveBeenCalledWith(11, {
        includeArchived: true,
      })

      // Header + tab bar survived the tab switch: exactly
      // ONE H1 (the shared group header) …
      expect(
        screen.getAllByRole('heading', {
          level: 1,
        }).map((heading) => heading.textContent),
      ).toEqual(['Aurora Research'])

      // … and a LOCAL H2 page heading (project row titles
      // are H2 as well — match the page heading exactly).
      const pageHeading = screen.getByRole(
        'heading',
        { name: 'Projects', level: 2 },
      )
      expect(pageHeading).toBeInTheDocument()

      expect(
        within(tabNav())
          .getByRole('link', { name: 'Projects' }),
      ).toHaveAttribute('aria-current', 'page')

      expect(
        within(tabNav())
          .getByRole('link', { name: 'Overview' }),
      ).not.toHaveAttribute('aria-current')

      // Project creation stays reachable inside the
      // workspace.
      expect(
        screen.getByRole('button', {
          name: /New project/,
        }),
      ).toBeEnabled()
    })

    it('keeps header + tabs when clicking Meetings and scopes the list to the URL group', async () => {
      const router =
        renderWorkspace('/groups/11')

      await screen.findByRole(
        'heading',
        { name: 'Aurora Research', level: 1 },
      )

      await fireEvent.click(
        within(tabNav()).getByRole('link', {
          name: 'Meetings',
        }),
      )

      await waitFor(() => {
        expect(
          router.state.location.pathname,
        ).toBe('/groups/11/meetings')
      })

      // The group 11 meeting is listed …
      await screen.findByText('Aurora Sync')

      // … the group 22 meeting is NOT.
      expect(
        screen.queryByText('Beacon Sync'),
      ).not.toBeInTheDocument()

      expect(
        vi.mocked(meetingsApi.listMeetings),
      ).toHaveBeenCalledWith(11)

      // Header + tab bar survived: exactly ONE H1 (the
      // shared group header) + the local H2 page heading
      // (list date-group headers are H3 — excluded).
      expect(
        screen.getAllByRole('heading', {
          level: 1,
        }).map((heading) => heading.textContent),
      ).toEqual(['Aurora Research'])

      expect(
        screen.getByRole('heading', {
          name: 'Meetings',
          level: 2,
        }),
      ).toBeInTheDocument()

      expect(
        within(tabNav())
          .getByRole('link', { name: 'Meetings' }),
      ).toHaveAttribute('aria-current', 'page')

      const internalTabs =
        screen.getByRole('tablist', {
          name: 'Meetings',
        })
      expect(
        within(internalTabs)
          .getAllByRole('tab')
          .map((tab) => tab.textContent),
      ).toEqual(['Upcoming', 'Series', 'Past'])
      expect(
        within(internalTabs)
          .getByRole('tab', { name: 'Upcoming' }),
      ).toHaveAttribute('aria-selected', 'true')

      // Meeting creation stays reachable inside the
      // workspace.
      expect(
        screen.getByRole('button', {
          name: /New meeting/,
        }),
      ).toBeEnabled()
    })

    it('shows the existing Settings inside the layout for admins (Settings tab active)', async () => {
      const router =
        renderWorkspace('/groups/11')

      await screen.findByRole(
        'heading',
        { name: 'Aurora Research', level: 1 },
      )

      await fireEvent.click(
        within(tabNav()).getByRole('link', {
          name: 'Settings',
        }),
      )

      await waitFor(() => {
        expect(
          router.state.location.pathname,
        ).toBe('/groups/11/settings')
      })

      // The admin surface renders: internal General /
      // Members navigation + the group rename field …
      await screen.findByLabelText(
        'Research group name',
      )

      // … without the redundant group header: exactly one
      // group-name H1 (the shared header's).
      expect(headingLevels()).toEqual([
        ['H1', 'Aurora Research'],
        ['H2', 'General'],
      ])

      // Settings is the active workspace tab; the
      // non-admin note is absent.
      expect(
        within(tabNav())
          .getByRole('link', { name: 'Settings' }),
      ).toHaveAttribute('aria-current', 'page')

      expect(
        screen.queryByText(
          'Research group settings are managed by admins.',
        ),
      ).not.toBeInTheDocument()

      // Member management stays reachable: the internal
      // Members tab exposes the member row + the Add member
      // action.
      await fireEvent.click(
        screen.getByRole('button', {
          name: 'Members',
        }),
      )

      expect(
        screen.getByRole('button', {
          name: /Add member/,
        }),
      ).toBeInTheDocument()

      // The membership row renders (username line is
      // unique against the TopBar user name).
      expect(
        screen.getByText('@alex'),
      ).toBeInTheDocument()
    })

    it('hides the Settings tab from non-admins and denies the direct URL', async () => {
      currentGroups = [
        { ...GROUP_A, role: 'member' },
        GROUP_B,
      ]

      const router =
        renderWorkspace('/groups/11')

      await screen.findByRole(
        'heading',
        { name: 'Aurora Research', level: 1 },
      )

      // No Settings tab for non-admins.
      const tabs =
        within(tabNav()).getAllByRole('link')
      expect(
        tabs.map((tab) => tab.textContent),
      ).toEqual([
        'Overview',
        'Projects',
        'Meetings',
      ])

      expect(
        screen.queryByRole('link', {
          name: 'Settings',
        }),
      ).not.toBeInTheDocument()

      // Direct URL: the workspace header still renders (the
      // group itself IS accessible) — but the admin surface
      // is refused and no tab is marked active.
      await act(async () => {
        router.navigate('/groups/11/settings')
      })

      expect(
        screen.getByText(
          'Research group settings are managed by admins.',
        ),
      ).toBeInTheDocument()

      expect(
        screen.queryByLabelText(
          'Research group name',
        ),
      ).not.toBeInTheDocument()

      expect(
        screen.queryByRole('button', {
          name: /Add member/,
        }),
      ).not.toBeInTheDocument()

      for (const tab of
        within(tabNav()).getAllByRole('link')
      ) {
        expect(tab).not.toHaveAttribute(
          'aria-current',
        )
      }

      // No group-name H1 from the settings page either.
      expect(
        screen.getAllByRole('heading', { level: 1 }),
      ).toHaveLength(1)
    })

    it('follows the matched route for the active tab, including the Meetings ?tab= deep link', async () => {
      const router =
        renderWorkspace(
          '/groups/11/meetings?tab=series',
        )

      await screen.findByRole(
        'heading',
        { name: 'Aurora Research', level: 1 },
      )

      // The Meetings workspace tab is active on the deep
      // link …
      expect(
        within(tabNav())
          .getByRole('link', { name: 'Meetings' }),
      ).toHaveAttribute('aria-current', 'page')

      // … and the ?tab= parameter drives the INTERNAL tab.
      const internalTabs =
        screen.getByRole('tablist', {
          name: 'Meetings',
        })
      expect(
        within(internalTabs)
          .getByRole('tab', { name: 'Series' }),
      ).toHaveAttribute('aria-selected', 'true')

      // Switching the internal tab back to Upcoming removes
      // the parameter (canonical behavior) and keeps the
      // shared header in place.
      await fireEvent.click(
        within(internalTabs)
          .getByRole('tab', { name: 'Upcoming' }),
      )

      await waitFor(() => {
        expect(
          router.state.location.search,
        ).toBe('')
      })

      expect(
        screen.getByRole('heading', {
          name: 'Aurora Research',
          level: 1,
        }),
      ).toBeInTheDocument()
    })

    it('switching from group 11 to group 22 updates header, scope, and data', async () => {
      const router =
        renderWorkspace('/groups/11/projects')

      await screen.findByRole(
        'link',
        { name: /Aurora Paper/ },
      )

      await act(async () => {
        router.navigate('/groups/22/projects')
      })

      await screen.findByRole(
        'heading',
        { name: 'Beacon Lab', level: 1 },
      )

      // The OLD group is fully gone from the workspace …
      expect(
        screen.queryByRole(
          'heading',
          { name: 'Aurora Research', level: 1 },
        ),
      ).not.toBeInTheDocument()

      // … and the data now belongs to group 22.
      await screen.findByRole(
        'link',
        { name: /Beacon Paper/ },
      )

      expect(
        screen.queryByRole(
          'link',
          { name: /Aurora Paper/ },
        ),
      ).not.toBeInTheDocument()

      // Each group's list was fetched for ITS OWN id — never
      // a cross-group substitution.
      expect(
        vi.mocked(projectsApi.listProjects),
      ).toHaveBeenCalledWith(11, {
        includeArchived: true,
      })

      expect(
        vi.mocked(projectsApi.listProjects),
      ).toHaveBeenCalledWith(22, {
        includeArchived: true,
      })

      // The workspace links now carry the NEW group id.
      expect(
        within(tabNav())
          .getByRole('link', { name: 'Overview' }),
      ).toHaveAttribute('href', '/groups/22')

      expect(
        within(tabNav())
          .getByRole('link', { name: 'Projects' }),
      ).toHaveAttribute(
        'aria-current',
        'page',
      )
    })

    it('shows a not-found view without foreign data for an inaccessible group', async () => {
      const router =
        renderWorkspace('/groups/99')

      expect(
        await screen.findByRole('heading', {
          name: 'Research group',
          level: 1,
        }),
      ).toBeInTheDocument()

      expect(
        screen.getByText(
          'Research group is not available.',
        ),
      ).toBeInTheDocument()

      // No tabs, no header of another group, no foreign
      // data, no scoped fetches at all.
      expect(
        screen.queryByRole('navigation', {
          name: 'Research group sections',
        }),
      ).not.toBeInTheDocument()

      expect(
        screen.queryByRole(
          'heading',
          { name: 'Aurora Research' },
        ),
      ).not.toBeInTheDocument()

      expect(
        screen.queryByRole(
          'heading',
          { name: 'Beacon Lab' },
        ),
      ).not.toBeInTheDocument()

      expect(
        screen.queryByText('Aurora Paper'),
      ).not.toBeInTheDocument()

      expect(
        screen.queryByText('Beacon Paper'),
      ).not.toBeInTheDocument()

      expect(
        vi.mocked(projectsApi.listProjects),
      ).not.toHaveBeenCalled()

      expect(
        vi.mocked(meetingsApi.listMeetings),
      ).not.toHaveBeenCalled()

      expect(
        router.state.location.pathname,
      ).toBe('/groups/99')
    })

    it('shows a not-found view for an unparseable group id without any scoped API call', async () => {
      renderWorkspace('/groups/not-a-group')

      await screen.findByRole(
        'heading',
        { name: 'Research group', level: 1 },
      )

      expect(
        screen.getByText(
          'Research group is not available.',
        ),
      ).toBeInTheDocument()

      expect(
        screen.queryByRole('navigation', {
          name: 'Research group sections',
        }),
      ).not.toBeInTheDocument()

      expect(
        vi.mocked(getResearchGroup),
      ).not.toHaveBeenCalled()

      expect(
        vi.mocked(projectsApi.listProjects),
      ).not.toHaveBeenCalled()
    })

    it('keeps the Meetings ?tab= parameter across internal tab switches and header stability', async () => {
      const router =
        renderWorkspace('/groups/11/meetings?tab=past')

      await screen.findByRole(
        'heading',
        { name: 'Aurora Research', level: 1 },
      )

      // Past deep link: the INTERNAL Past tab is selected …
      const internalTabs =
        screen.getByRole('tablist', {
          name: 'Meetings',
        })
      expect(
        within(internalTabs)
          .getByRole('tab', { name: 'Past' }),
      ).toHaveAttribute('aria-selected', 'true')

      // … the workspace Meetings tab is active …
      expect(
        within(tabNav())
          .getByRole('link', { name: 'Meetings' }),
      ).toHaveAttribute('aria-current', 'page')

      // … and the shared header stays mounted while the
      // internal tab state is driven by the URL.
      await fireEvent.click(
        within(internalTabs)
          .getByRole('tab', { name: 'Series' }),
      )

      await waitFor(() => {
        expect(
          router.state.location.search,
        ).toBe('?tab=series')
      })

      expect(
        screen.getByRole('heading', {
          name: 'Aurora Research',
          level: 1,
        }),
      ).toBeInTheDocument()

      expect(
        within(tabNav())
          .getByRole('link', { name: 'Meetings' }),
      ).toHaveAttribute('aria-current', 'page')
    })

    it('restores the matching area on browser Back/Forward', async () => {
      const router =
        renderWorkspace('/groups/11')

      await screen.findByRole(
        'heading',
        { name: 'Aurora Research', level: 1 },
      )

      await fireEvent.click(
        within(tabNav()).getByRole('link', {
          name: 'Projects',
        }),
      )

      await screen.findByRole(
        'link',
        { name: /Aurora Paper/ },
      )

      await fireEvent.click(
        within(tabNav()).getByRole('link', {
          name: 'Meetings',
        }),
      )

      await screen.findByText('Aurora Sync')

      // Back → Projects area …
      await act(async () => {
        router.navigate(-1)
      })

      await screen.findByRole(
        'link',
        { name: /Aurora Paper/ },
      )

      expect(
        within(tabNav())
          .getByRole('link', { name: 'Projects' }),
      ).toHaveAttribute('aria-current', 'page')

      // … and again → Overview.
      await act(async () => {
        router.navigate(-1)
      })

      await screen.findByText(
        /This is the overview for this research group/,
      )

      expect(
        within(tabNav())
          .getByRole('link', { name: 'Overview' }),
      ).toHaveAttribute('aria-current', 'page')
      expect(
        router.state.location.pathname,
      ).toBe('/groups/11')
    })

    it('keeps the global legacy Projects route unchanged (H1 + subtitle + own frame)', async () => {
      const router =
        renderWorkspace('/groups/11')

      await screen.findByRole(
        'heading',
        { name: 'Aurora Research', level: 1 },
      )

      await act(async () => {
        router.navigate('/projects?group=11')
      })

      // The global page keeps its H1 + group subtitle and
      // renders its OWN constrained frame — the workspace
      // header is gone.
      await screen.findByRole(
        'heading',
        { name: 'Projects', level: 1 },
      )

      expect(
        screen.getByText(
          'Projects you can access in Aurora Research.',
        ),
      ).toBeInTheDocument()

      expect(
        screen.queryByText('Research group workspace'),
      ).not.toBeInTheDocument()

      expect(
        screen.queryByRole('heading', {
          name: 'Aurora Research',
          level: 1,
        }),
      ).not.toBeInTheDocument()

      const frames =
        document.querySelectorAll(
          '[data-fg-workspace-content="constrained"]',
        )
      expect(frames).toHaveLength(1)

      await screen.findByRole(
        'link',
        { name: /Aurora Paper/ },
      )
    })

    it('keeps the global legacy Meetings route unchanged', async () => {
      const router =
        renderWorkspace('/groups/11')

      await screen.findByRole(
        'heading',
        { name: 'Aurora Research', level: 1 },
      )

      await act(async () => {
        router.navigate('/meetings?group=11')
      })

      await screen.findByRole(
        'heading',
        { name: 'Meetings', level: 1 },
      )

      expect(
        screen.getByText(
          'Your meetings in Aurora Research.',
        ),
      ).toBeInTheDocument()

      expect(
        screen.queryByText('Research group workspace'),
      ).not.toBeInTheDocument()

      await screen.findByText('Aurora Sync')
    })

    it('lets a contradictory ?group= never override the workspace path id', async () => {
      const router =
        renderWorkspace(
          '/groups/11/projects?group=22',
        )

      // The PATH id (11) is authoritative …
      await screen.findByRole(
        'link',
        { name: /Aurora Paper/ },
      )

      expect(
        screen.queryByRole(
          'link',
          { name: /Beacon Paper/ },
        ),
      ).not.toBeInTheDocument()

      expect(
        vi.mocked(projectsApi.listProjects),
      ).toHaveBeenCalledWith(11, {
        includeArchived: true,
      })

      expect(
        vi.mocked(projectsApi.listProjects),
      ).not.toHaveBeenCalledWith(22, {
        includeArchived: true,
      })

      // … and the workspace header shows the PATH group.
      expect(
        screen.getByRole('heading', {
          name: 'Aurora Research',
          level: 1,
        }),
      ).toBeInTheDocument()

      expect(
        router.state.location.pathname,
      ).toBe('/groups/11/projects')
    })

    it('updates the shared header group name after a successful rename without reload', async () => {
      // The provider reload after the rename returns the NEW
      // name on the second list fetch.
      const renamedGroup: ApiResearchGroup = {
        id: 11,
        name: 'Aurora Research Two',
        role: 'admin',
      }

      vi.mocked(listResearchGroups)
        .mockResolvedValueOnce(
          currentGroups.map((group) => ({
            ...group,
          })),
        )
        .mockResolvedValueOnce(
          [
            renamedGroup,
            { ...GROUP_B },
          ],
        )

      const router =
        renderWorkspace(
          '/groups/11/settings',
        )

      await screen.findByLabelText(
        'Research group name',
      )

      const nameInput =
        screen.getByLabelText(
          'Research group name',
        ) as HTMLInputElement

      expect(nameInput.value).toBe(
        'Aurora Research',
      )

      fireEvent.change(nameInput, {
        target: {
          value: 'Aurora Research Two',
        },
      })

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Save',
        }),
      )

      // The shared header reflects the rename in place …
      await screen.findByRole(
        'heading',
        {
          name: 'Aurora Research Two',
          level: 1,
        },
      )

      expect(
        screen.queryByRole(
          'heading',
          {
            name: 'Aurora Research',
            level: 1,
          },
        ),
      ).not.toBeInTheDocument()

      // … the rename was persisted through the canonical
      // endpoint …
      expect(
        vi.mocked(updateResearchGroup),
      ).toHaveBeenCalledWith(11, {
        name: 'Aurora Research Two',
      })

      // … and the URL was not changed.
      expect(
        router.state.location.pathname,
      ).toBe('/groups/11/settings')
    })
    it(
      'keeps the Members tab and shows the new member after the add-triggered provider refresh',
      async () => {
        // The add-member flow refreshes the provider group
        // list (a real async round trip). That background
        // refresh of already-available data must not unmount
        // the workspace outlet: the Settings page keeps its
        // internal Members tab and shows the updated
        // membership list under the same shared header.
        const chris: ApiUser = {
          id: 2,
          username: 'chris',
          firstName: 'Chris',
          lastName: '',
          email: 'chris@example.com',
        }

        const CHRIS_MEMBERSHIP:
          ApiResearchGroupMembership = {
          id: 2,
          role: 'member',
          joinedAt: null,
          user: chris,
        }

        let currentMemberships:
          ApiResearchGroupMembership[] = [
            MEMBERSHIP,
          ]

        vi.mocked(
          listResearchGroupMemberships,
        ).mockImplementation(
          () =>
            Promise.resolve(
              currentMemberships.map(
                (membership) => ({
                  ...membership,
                }),
              ),
            ),
        )

        vi.mocked(
          searchResearchGroupMemberCandidates,
        ).mockResolvedValue([
          {
            id: chris.id,
            username: chris.username,
            firstName: chris.firstName,
            lastName: chris.lastName,
          },
        ])

        vi.mocked(
          addResearchGroupMembership,
        ).mockImplementation(
          async () => {
            currentMemberships = [
              ...currentMemberships,
              CHRIS_MEMBERSHIP,
            ]

            return { ...CHRIS_MEMBERSHIP }
          },
        )

        // First call: the provider's initial load (fast).
        // Second call: the background refresh triggered
        // by the successful add - an actual async round
        // trip, so the provider's loading state is real
        // and observable while the list is in flight.
        vi.mocked(listResearchGroups)
          .mockResolvedValueOnce(
            currentGroups.map((group) => ({
              ...group,
            })),
          )
          .mockImplementation(
            () =>
              new Promise<
                ApiResearchGroup[]
              >((resolve) => {
                setTimeout(() => {
                  resolve(
                    currentGroups.map(
                      (group) => ({
                        ...group,
                      }),
                    ),
                  )
                }, 0)
              }),
          )

        // 1) Admin opens the workspace settings (General
        //    is the initial internal tab).
        const router =
          renderWorkspace(
            '/groups/11/settings',
          )

        await screen.findByLabelText(
          'Research group name',
        )

        // 2) Switch to the internal Members tab.
        await fireEvent.click(
          screen.getByRole('button', {
            name: 'Members',
          }),
        )

        await screen.findByRole(
          'heading',
          {
            name: 'Members',
            level: 2,
          },
        )

        expect(
          screen.getByText('@alex'),
        ).toBeInTheDocument()

        // 3) Add chris as a member through the dialog.
        await fireEvent.click(
          screen.getByRole('button', {
            name: /Add member/,
          }),
        )

        const dialog =
          screen.getByRole(
            'dialog',
            { name: 'Add member' },
          )

        fireEvent.change(
          within(dialog).getByLabelText(
            'Search person',
          ),
          {
            target: { value: 'chris' },
          },
        )

        const candidate =
          await within(dialog)
            .findByRole('button', {
              name: /@chris/,
            })

        fireEvent.click(candidate)

        const submitAdd =
          within(dialog).getByRole(
            'button',
            { name: 'Add member' },
          )

        await waitFor(
          () =>
            expect(
              submitAdd,
            ).toBeEnabled(),
        )

        fireEvent.click(submitAdd)

        // 4) The add-triggered provider refresh runs,
        //    then the dialog closes.
        await waitFor(
          () =>
            expect(
              screen.queryByRole(
                'dialog',
                { name: 'Add member' },
              ),
            ).not.toBeInTheDocument(),
        )

        // 5) The Members tab is STILL active: no reset
        //    to General, no settings remount.
        expect(
          screen.getByRole('heading', {
            name: 'Members',
            level: 2,
          }),
        ).toBeInTheDocument()

        expect(
          screen.queryByRole(
            'heading',
            {
              name: 'General',
              level: 2,
            },
          ),
        ).not.toBeInTheDocument()

        // 6) The updated membership list is visible:
        //    the new member with its role ...
        await screen.findByText('@chris')

        expect(
          screen.getByRole('combobox', {
            name: 'Role for Chris',
          }),
        ).toHaveValue('member')

        // ... and the existing member is retained.
        expect(
          screen.getByText('@alex'),
        ).toBeInTheDocument()

        // 7) The shared workspace header survived the
        //    background refresh (no unmount/reload flash).
        expect(
          screen.getByRole('heading', {
            name: 'Aurora Research',
            level: 1,
          }),
        ).toBeInTheDocument()

        // 8) Another member can still be added.
        expect(
          screen.getByRole('button', {
            name: /Add member/,
          }),
        ).toBeEnabled()

        // No unexpected navigation.
        expect(
          router.state.location.pathname,
        ).toBe('/groups/11/settings')
      },
    )
  },
)
