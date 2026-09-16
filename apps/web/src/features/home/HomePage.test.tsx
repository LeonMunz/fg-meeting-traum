// @vitest-environment happy-dom

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
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  MemoryRouter,
  useLocation,
} from 'react-router'

import type {
  ApiActivityEvent,
  ApiHome,
  ApiHomeNeedsAttentionItem,
  ApiUser,
} from '../../api/types'

import { App } from '../../app/App'
import { getHome } from '../../api/home'
import { listActivityFeed } from '../../api/activity'
import { HomePage } from './HomePage'

/* ── Mocked session (authenticated) ───────────────────────────── */

const { sessionUser, session } = vi.hoisted(() => {
  const sessionUser: ApiUser = {
    id: 1,
    username: 'alex',
    firstName: 'Alex',
    lastName: '',
    email: 'alex@example.com',
  }
  const session = {
    user: sessionUser,
    loading: false,
    error: null,
    login: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    setAuthenticatedUser: vi.fn(),
  }
  return { sessionUser, session }
})

vi.mock('../../api/useSession', () => ({
  useSession: () => session,
}))

vi.mock('../../api/auth', () => ({
  me: vi.fn().mockResolvedValue(sessionUser),
  login: vi.fn(),
  logout: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../api/research-groups', () => ({
  listResearchGroups: vi
    .fn()
    .mockResolvedValue([
      {
        id: 1,
        name: 'FG Research Group',
        description: '',
        status: 'active',
        createdById: 1,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ]),
}))

vi.mock('../../api/home', () => ({
  getHome: vi.fn(),
}))

vi.mock('../../api/activity', () => ({
  listActivityFeed: vi.fn(),
  ACTIVITY_DOMAINS: [
    'work_item',
    'meeting',
    'project',
    'research_group',
  ],
}))

/* ── Date helpers ─────────────────────────────────────────────── */

function isoDate(offsetDays = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function isoDateTime(
  offsetDays = 0,
  hour = 10,
  minute = 30,
): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  d.setHours(hour, minute, 0, 0)
  return d.toISOString()
}

/* ── Fixtures ─────────────────────────────────────────────────── */

function makeActivity(): ApiActivityEvent[] {
  return [
    {
      id: 1,
      eventType: 'work_item.updated',
      actor: {
        id: 1,
        username: 'alex',
        firstName: 'Alex',
        lastName: '',
      },
      subjectUser: null,
      workItemId: 101,
      workItemTitle: 'Activity Feed WI',
      meetingId: null,
      meetingTitle: null,
      projectId: 7,
      projectName: 'Paper XYZ',
      researchGroupId: 1,
      researchGroupName: 'FG Research Group',
      changes: { marker: 'RAW-PAYLOAD-MARKER' },
      createdAt: isoDateTime(0, 9, 0),
    },
  ]
}

function makeHome(
  overrides: Partial<ApiHome> = {},
): ApiHome {
  return {
    needsAttention: [
      {
        workItemId: 101,
        title: 'Overdue Draft Task',
        projectId: 7,
        projectName: 'Paper XYZ',
        workItemType: { id: 4, name: 'Task' },
        dueDate: isoDate(-2),
        statusCategory: 'in_progress',
        blockedReason: null,
        attentionReasons: ['overdue'],
      },
      {
        workItemId: 102,
        title: 'Blocked Review Task',
        projectId: 7,
        projectName: 'Paper XYZ',
        workItemType: { id: 4, name: 'Task' },
        dueDate: null,
        statusCategory: 'review',
        blockedReason: 'Waiting on data',
        attentionReasons: ['blocked'],
      },
    ],
    todayAndNext: [
      {
        domain: 'work_item',
        objectId: 103,
        title: 'Due Today WI',
        calendarDate: isoDate(0),
        sortAt: isoDateTime(0, 0, 0),
        workItem: {
          workItemId: 103,
          projectId: 7,
          projectName: 'Paper XYZ',
          dueDate: isoDate(0),
          statusCategory: 'todo',
          blockedReason: null,
        },
        meeting: null,
      },
      {
        domain: 'meeting',
        objectId: 201,
        title: 'FG Weekly Meeting',
        calendarDate: isoDate(0),
        sortAt: isoDateTime(0, 10, 30),
        workItem: null,
        meeting: {
          meetingId: 201,
          scheduledAt: isoDateTime(0, 10, 30),
          status: 'upcoming',
          scope: 'group',
          researchGroupId: 1,
          projectId: null,
        },
      },
    ],
    myWork: [
      {
        workItemId: 103,
        title: 'My Active Task',
        projectId: 7,
        projectName: 'Paper XYZ',
        typeDefinitionId: 4,
        typeName: 'Task',
        statusCategory: 'in_progress',
        dueDate: isoDate(4),
        blockedReason: null,
      },
    ],
    continueWorking: [
      {
        domain: 'work_item',
        objectId: 103,
        title: 'Recently Edited WI',
        latestPersonalActivityAt: isoDateTime(0, 8, 0),
        context: { kind: 'project', id: 7, name: 'Paper XYZ' },
        workItem: {
          workItemId: 103,
          projectId: 7,
          projectName: 'Paper XYZ',
          statusCategory: 'in_progress',
          dueDate: null,
        },
        meeting: null,
      },
      {
        domain: 'meeting',
        objectId: 201,
        title: 'Recently Touched Meeting',
        latestPersonalActivityAt: isoDateTime(-1, 9, 0),
        context: { kind: 'research_group', id: 1, name: 'FG Example' },
        workItem: null,
        meeting: {
          meetingId: 201,
          status: 'upcoming',
          scheduledAt: isoDateTime(1, 10, 0),
        },
      },
    ],
    ...overrides,
  }
}

/* ── Render helpers ───────────────────────────────────────────── */

function LocationProbe() {
  const location = useLocation()

  return (
    <output aria-label="Current location">
      {location.pathname}
    </output>
  )
}

function renderApp() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <LocationProbe />
      <App />
    </MemoryRouter>,
  )
}

function renderHome() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <LocationProbe />
      <HomePage />
    </MemoryRouter>,
  )
}

function currentLocation(): string {
  return (
    screen
      .getByLabelText('Current location')
      .textContent ?? ''
  )
}

function sectionHeading(title: string) {
  return screen.getByRole('heading', {
    name: title,
    level: 2,
  })
}

function mockSuccessfulLoads(
  home: ApiHome = makeHome(),
  activity: ApiActivityEvent[] = makeActivity(),
) {
  vi.mocked(getHome).mockResolvedValue(home)
  vi.mocked(listActivityFeed).mockResolvedValue(
    activity,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSuccessfulLoads()
})

afterEach(() => {
  cleanup()
})

/* ── Tests ────────────────────────────────────────────────────── */

describe('Home route (authenticated application state)', () => {
  it('renders the Home page at the canonical / route', async () => {
    renderApp()

    // The authenticated shell + Home heading render.
    await waitFor(() => {
      expect(
        screen.getByRole('heading', {
          name: 'Home',
          level: 1,
        }),
      ).toBeInTheDocument()
    })

    // All three primary sections are present.
    expect(
      sectionHeading('Needs attention'),
    ).toBeInTheDocument()
    expect(
      sectionHeading('Today & next'),
    ).toBeInTheDocument()
    expect(
      sectionHeading('Continue working'),
    ).toBeInTheDocument()

    // The full My Work list no longer lives on Home.
    expect(
      screen.queryByRole('heading', {
        name: 'My work',
        level: 2,
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('My Active Task'),
    ).not.toBeInTheDocument()

    // Both independent requests were made.
    expect(getHome).toHaveBeenCalledTimes(1)
    expect(listActivityFeed).toHaveBeenCalledTimes(1)
  })
})

describe('Home section population', () => {
  it('populates the three primary sections from the /api/home/ response', async () => {
    renderHome()

    // Needs attention: title, project, and the backend attention
    // reason labels.
    await waitFor(() => {
      expect(
        screen.getByText('Overdue Draft Task'),
      ).toBeInTheDocument()
    })
    expect(
      screen.getByText('Blocked Review Task'),
    ).toBeInTheDocument()
    expect(screen.getByText('Overdue')).toBeInTheDocument()
    expect(screen.getByText('Blocked')).toBeInTheDocument()

    // Today & next: both a Work Item and a Meeting candidate.
    expect(screen.getByText('Due Today WI')).toBeInTheDocument()
    expect(
      screen.getByText('FG Weekly Meeting'),
    ).toBeInTheDocument()

    // Continue working: both domains.
    expect(
      screen.getByText('Recently Edited WI'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Recently Touched Meeting'),
    ).toBeInTheDocument()

    // The myWork payload arrives but is intentionally not rendered.
    expect(getHome).toHaveBeenCalled()
    expect(
      screen.queryByText('My Active Task'),
    ).not.toBeInTheDocument()
  })

  it('renders sections in the fixed product order', async () => {
    renderHome()

    await waitFor(() => {
      expect(
        sectionHeading('Needs attention'),
      ).toBeInTheDocument()
    })

    // Primary-column headings, in order (the Activity rail has its
    // own heading in the secondary column).
    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent)
      .filter((t) => t !== 'Activity')

    expect(headings).toEqual([
      'Needs attention',
      'Today & next',
      'Continue working',
    ])
  })

  it('does not add KPI/statistic cards above the sections', async () => {
    renderHome()

    await waitFor(() => {
      expect(
        sectionHeading('Needs attention'),
      ).toBeInTheDocument()
    })

    // The only page heading (h1) is "Home"; there are no extra
    // dashboard KPI cards.
    const h1s = screen.getAllByRole('heading', { level: 1 })
    expect(h1s).toHaveLength(1)
    expect(h1s[0]).toHaveTextContent('Home')
  })
})

describe('Activity independence', () => {
  it('comes from its own independent request, not Home', async () => {
    renderHome()

    // The activity object title is not part of any Home section.
    await waitFor(() => {
      expect(
        screen.getByText('Activity Feed WI'),
      ).toBeInTheDocument()
    })

    // It rendered from the independent Activity request.
    expect(listActivityFeed).toHaveBeenCalledTimes(1)
    // The default selection (all four domains) is the canonical
    // unfiltered feed: no `domains` in the request options.
    expect(listActivityFeed).toHaveBeenCalledWith({
      limit: 20,
    })

    // The Activity row is inside the Activity section and reads as
    // the human sentence: actor + verb + object.
    const activitySection = within(
      screen.getByRole('complementary', {
        name: 'Activity',
      }),
    )
    // The primary line is the complete human sentence.
    expect(
      activitySection.getByText(
        (_content, element) =>
          element?.tagName === 'P' &&
          element.textContent === 'Alex updated Activity Feed WI',
      ),
    ).toBeInTheDocument()

    // Context + relative time render together as the secondary
    // metadata line (time wording is relative, so match the
    // context prefix).
    expect(
      activitySection.getByText(/Paper XYZ · /),
    ).toBeInTheDocument()
  })

  it('Activity failure does not hide loaded Home content', async () => {
    vi.mocked(listActivityFeed).mockRejectedValue(
      new Error('activity boom'),
    )

    renderHome()

    // Home content is still visible.
    await waitFor(() => {
      expect(
        screen.getByText('Overdue Draft Task'),
      ).toBeInTheDocument()
    })

    // The Activity rail shows its own error state.
    await waitFor(() => {
      expect(
        screen.getByRole('alert'),
      ).toHaveTextContent(
        "Activity couldn't be loaded.",
      )
    })
  })

  it('navigable Activity events keep their canonical targets', async () => {
    renderHome()

    await waitFor(() => {
      expect(
        screen.getByText(
          (_content, element) =>
            element?.tagName === 'P' &&
            element.textContent === 'Alex updated Activity Feed WI',
        ),
      ).toBeInTheDocument()
    })

    const activitySection = within(
      screen.getByRole('complementary', {
        name: 'Activity',
      }),
    )

    // The Work Item event opens the Work Item's Project read
    // surface.
    fireEvent.click(
      activitySection.getByRole('button', {
        name: /Activity Feed WI/,
      }),
    )

    expect(currentLocation()).toBe(
      '/projects/7/work-items',
    )
  })

  it('non-navigable Activity events remain safe and non-interactive', async () => {
    mockSuccessfulLoads(
      makeHome(),
      [
        {
          id: 2,
          eventType: 'research_group.member_offboarded',
          actor: {
            id: 2,
            username: 'leon',
            firstName: 'Leon',
            lastName: '',
          },
          subjectUser: {
            id: 3,
            username: 'pat',
            firstName: 'Pat',
            lastName: '',
          },
          workItemId: null,
          workItemTitle: null,
          meetingId: null,
          meetingTitle: null,
          projectId: null,
          projectName: null,
          researchGroupId: 1,
          researchGroupName: 'FG Research Group',
          changes: {},
          createdAt: isoDateTime(0, 9, 0),
        },
      ],
    )

    renderHome()

    // The membership event still reads as a meaningful sentence
    // with its subject preserved.
    await waitFor(() => {
      expect(
        screen.getByText(
          (_content, element) =>
            element?.tagName === 'P' &&
            element.textContent ===
              'Leon offboarded a member from FG Research Group',
        ),
      ).toBeInTheDocument()
    })

    const activitySection = within(
      screen.getByRole('complementary', {
        name: 'Activity',
      }),
    )
    expect(
      activitySection.getByText(/for Pat/),
    ).toBeInTheDocument()

    // No canonical target: the row is not interactive.
    // The only button in the section is the header's filter
    // control; the non-navigable row itself renders no button.
    const sectionButtons =
      activitySection.queryAllByRole('button')

    expect(sectionButtons).toHaveLength(1)
    expect(sectionButtons[0]).toHaveAttribute(
      'aria-label',
      'Filter activity',
    )
  })
})

describe('Activity domain filter', () => {
  const DOMAIN_LABELS = [
    'Work Items',
    'Meetings',
    'Projects',
    'Research Groups',
  ]

  function activityRail() {
    return within(
      screen.getByRole('complementary', {
        name: 'Activity',
      }),
    )
  }

  function filterButton() {
    return activityRail().getByRole('button', {
      name: 'Filter activity',
    })
  }

  function openFilter() {
    fireEvent.click(filterButton())

    return within(
      screen.getByRole('dialog', {
        name: 'Filter activity',
      }),
    )
  }

  async function renderLoadedHome() {
    renderHome()

    await waitFor(() => {
      expect(
        screen.getByText('Activity Feed WI'),
      ).toBeInTheDocument()
    })
  }

  it('selects all four categories initially, with no active mark and no Reset', async () => {
    await renderLoadedHome()

    const popover = openFilter()

    for (const label of DOMAIN_LABELS) {
      expect(popover.getByLabelText(label)).toBeChecked()
      expect(popover.getByLabelText(label)).toBeEnabled()
    }

    // The default all-domains state is not marked as active.
    expect(filterButton()).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(
      popover.queryByRole('button', { name: 'Reset' }),
    ).not.toBeInTheDocument()
  })

  it('makes the initial Activity request without a domain filter', async () => {
    await renderLoadedHome()

    // The absent parameter is the canonical all-domains state.
    expect(listActivityFeed).toHaveBeenCalledTimes(1)
    expect(listActivityFeed).toHaveBeenCalledWith({
      limit: 20,
    })
  })

  it('refetches only Activity with the remaining domains when one is deselected', async () => {
    await renderLoadedHome()

    const popover = openFilter()
    fireEvent.click(popover.getByLabelText('Projects'))

    // The independent Activity request repeated with the strict
    // subset; Home was not refetched.
    expect(getHome).toHaveBeenCalledTimes(1)
    expect(listActivityFeed).toHaveBeenCalledTimes(2)
    expect(listActivityFeed).toHaveBeenLastCalledWith({
      limit: 20,
      domains: [
        'work_item',
        'meeting',
        'research_group',
      ],
    })

    // The deselected category is unchecked; the rest remain.
    expect(popover.getByLabelText('Projects')).not.toBeChecked()

    for (const label of [
      'Work Items',
      'Meetings',
      'Research Groups',
    ]) {
      expect(popover.getByLabelText(label)).toBeChecked()
    }

    // The rail keeps rendering server results (the mocked feed
    // resolved again), never a locally filtered stale list.
    await waitFor(() => {
      expect(
        screen.getByText('Activity Feed WI'),
      ).toBeInTheDocument()
    })
  })

  it('serializes multiple selected domains in deterministic canonical order', async () => {
    await renderLoadedHome()

    const popover = openFilter()

    // Deselect in a non-canonical order (Research Groups first,
    // Work Items second); the request order must not follow click
    // order.
    fireEvent.click(popover.getByLabelText('Research Groups'))
    fireEvent.click(popover.getByLabelText('Work Items'))

    expect(listActivityFeed).toHaveBeenLastCalledWith({
      limit: 20,
      domains: ['meeting', 'project'],
    })
  })

  it('does not refetch /api/home/ when the filter changes', async () => {
    await renderLoadedHome()

    const homeCallsBefore = vi.mocked(getHome).mock.calls.length

    const popover = openFilter()
    fireEvent.click(popover.getByLabelText('Meetings'))
    fireEvent.click(popover.getByLabelText('Projects'))

    await waitFor(() => {
      expect(
        vi.mocked(listActivityFeed).mock.calls.length,
      ).toBeGreaterThanOrEqual(3)
    })

    expect(
      vi.mocked(getHome).mock.calls.length,
    ).toBe(homeCallsBefore)
  })

  it('never allows zero selected domains', async () => {
    await renderLoadedHome()

    const popover = openFilter()
    fireEvent.click(popover.getByLabelText('Projects'))
    fireEvent.click(popover.getByLabelText('Research Groups'))
    fireEvent.click(popover.getByLabelText('Meetings'))

    // Only Work Items remains: it cannot be deselected.
    const last = popover.getByLabelText('Work Items')
    expect(last).toBeChecked()
    expect(last).toBeDisabled()

    fireEvent.click(last)
    expect(last).toBeChecked()

    // The last request carries the single remaining domain; no
    // call ever carries an empty selection.
    expect(listActivityFeed).toHaveBeenLastCalledWith({
      limit: 20,
      domains: ['work_item'],
    })

    // Every request that carries a domain filter carries at least
    // one domain (the empty selection never reaches the client).
    for (const [options] of vi.mocked(
      listActivityFeed,
    ).mock.calls) {
      if (options?.domains) {
        expect(options.domains.length).toBeGreaterThanOrEqual(1)
      }
    }
  })

  it('Reset restores all four domains and the unfiltered request', async () => {
    await renderLoadedHome()

    const popover = openFilter()
    fireEvent.click(popover.getByLabelText('Projects'))

    // Reset exists only for a subset state.
    const reset = popover.getByRole('button', {
      name: 'Reset',
    })

    fireEvent.click(reset)

    for (const label of DOMAIN_LABELS) {
      expect(popover.getByLabelText(label)).toBeChecked()
    }

    expect(
      popover.queryByRole('button', { name: 'Reset' }),
    ).not.toBeInTheDocument()
    expect(filterButton()).toHaveAttribute(
      'aria-pressed',
      'false',
    )

    // Back to the canonical unfiltered request.
    expect(listActivityFeed).toHaveBeenLastCalledWith({
      limit: 20,
    })
  })

  it('marks the filter button as active only for a strict subset', async () => {
    await renderLoadedHome()

    const popover = openFilter()

    expect(filterButton()).toHaveAttribute(
      'aria-pressed',
      'false',
    )

    fireEvent.click(popover.getByLabelText('Projects'))
    expect(filterButton()).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    fireEvent.click(
      popover.getByRole('button', { name: 'Reset' }),
    )
    expect(filterButton()).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('keeps Home intact when a filtered Activity request fails, and retry repeats the filter', async () => {
    await renderLoadedHome()

    // The next Activity request (the filter refetch below) fails.
    vi.mocked(listActivityFeed).mockRejectedValueOnce(
      new Error('filtered activity boom'),
    )

    const popover = openFilter()
    fireEvent.click(popover.getByLabelText('Projects'))

    // Wait for the failed refetch to settle into the rail error.
    await waitFor(() => {
      expect(
        screen.getByRole('alert'),
      ).toHaveTextContent(
        "Activity couldn't be loaded.",
      )
    })

    // Home primary content is unaffected by the Activity failure.
    expect(
      screen.getByText('Overdue Draft Task'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Recently Edited WI'),
    ).toBeInTheDocument()

    // The user's filter survives the failure: retry repeats the
    // currently selected domain filter.
    fireEvent.click(
      screen.getByRole('button', { name: 'Try again' }),
    )

    expect(listActivityFeed).toHaveBeenLastCalledWith({
      limit: 20,
      domains: [
        'work_item',
        'meeting',
        'research_group',
      ],
    })
  })

  it('keeps explicit category labels and never exposes backend domain identifiers', async () => {
    await renderLoadedHome()

    const popover = openFilter()

    for (const label of DOMAIN_LABELS) {
      expect(popover.getByLabelText(label)).toBeInTheDocument()
    }

    const text =
      screen
        .getByRole('dialog', {
          name: 'Filter activity',
        })
        .textContent ?? ''
    expect(text).not.toContain('work_item')
    expect(text).not.toContain('research_group')
  })

  it('closes the popover on Escape and returns focus to the trigger', async () => {
    await renderLoadedHome()

    openFilter()
    expect(
      screen.getByRole('dialog', {
        name: 'Filter activity',
      }),
    ).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(
      screen.queryByRole('dialog', {
        name: 'Filter activity',
      }),
    ).not.toBeInTheDocument()
    expect(filterButton()).toHaveFocus()
  })

  it('ignores a stale Activity response when a newer filter refetch resolves first', async () => {
    let resolveStale: (
      events: ApiActivityEvent[],
    ) => void = () => {}

    const staleRequest = new Promise<
      ApiActivityEvent[]
    >((resolve) => {
      resolveStale = resolve
    })

    // Initial load resolves; the first filter refetch stays
    // pending (and will resolve last); the second filter refetch
    // resolves immediately.
    vi.mocked(listActivityFeed)
      .mockResolvedValueOnce(makeActivity())
      .mockReturnValueOnce(staleRequest)
      .mockResolvedValue(makeActivity())

    await renderLoadedHome()

    const popover = openFilter()
    fireEvent.click(popover.getByLabelText('Projects'))
    fireEvent.click(popover.getByLabelText('Research Groups'))

    // The newest filter (work_item + meeting) resolved and
    // rendered.
    await waitFor(() => {
      expect(
        screen.getByText('Activity Feed WI'),
      ).toBeInTheDocument()
    })

    // The stale first refetch now arrives with an empty feed,
    // after the newer one; it must not blank the rail.
    resolveStale([])

    // Let the stale response settle fully (microtasks + render).
    await new Promise((resolve) =>
      setTimeout(resolve, 50),
    )

    expect(
      screen.getByText('Activity Feed WI'),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('No recent activity.'),
    ).not.toBeInTheDocument()

    expect(listActivityFeed).toHaveBeenLastCalledWith({
      limit: 20,
      domains: ['work_item', 'meeting'],
    })
  })
})

describe('Empty states', () => {
  it('hides Needs attention entirely with zero candidates', async () => {
    mockSuccessfulLoads(
      makeHome({ needsAttention: [] }),
      [],
    )

    renderHome()

    await waitFor(() => {
      expect(
        sectionHeading('Today & next'),
      ).toBeInTheDocument()
    })

    // No section, no empty-state copy.
    expect(
      screen.queryByRole('heading', {
        name: 'Needs attention',
        level: 2,
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(
        /requires your attention/i,
      ),
    ).not.toBeInTheDocument()
  })

  it('renders compact empty lines for empty timeline + continue sections', async () => {
    mockSuccessfulLoads(
      makeHome({
        needsAttention: [],
        todayAndNext: [],
        myWork: [],
        continueWorking: [],
      }),
      [],
    )

    renderHome()

    await waitFor(() => {
      expect(
        sectionHeading('Today & next'),
      ).toBeInTheDocument()
    })

    expect(
      screen.getByText(
        'Nothing upcoming in the current window.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Recent work will appear here.'),
    ).toBeInTheDocument()

    // The remaining section headings stay visible when empty.
    expect(
      sectionHeading('Today & next'),
    ).toBeInTheDocument()
    expect(
      sectionHeading('Continue working'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('No recent activity.'),
    ).toBeInTheDocument()
  })
})

describe('Error behavior', () => {
  it('Home failure does not masquerade as successful empty data', async () => {
    vi.mocked(getHome).mockRejectedValue(
      new Error('home boom'),
    )

    renderHome()

    // A real error state is shown (not empty sections).
    await waitFor(() => {
      expect(
        screen.getByRole('alert'),
      ).toHaveTextContent(
        "Home couldn't be loaded",
      )
    })

    // No section headings are fabricated on failure.
    expect(
      screen.queryByRole('heading', {
        name: 'Needs attention',
        level: 2,
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(
        'Nothing currently requires your attention.',
      ),
    ).not.toBeInTheDocument()

    // The app shell / page heading remain usable.
    expect(
      screen.getByRole('heading', {
        name: 'Home',
        level: 1,
      }),
    ).toBeInTheDocument()
  })
})

describe('Needs attention presentation rule', () => {
  it('renders at most 3 rows in backend order', async () => {
    const five: ApiHomeNeedsAttentionItem[] = Array.from(
      { length: 5 },
      (_, i) => ({
        workItemId: 400 + i,
        title: `Attention ${i + 1}`,
        projectId: 7,
        projectName: 'Paper XYZ',
        workItemType: { id: 4, name: 'Task' },
        dueDate: isoDate(-1),
        statusCategory: 'in_progress',
        blockedReason: null,
        attentionReasons: ['overdue'],
      }),
    )

    mockSuccessfulLoads(
      makeHome({ needsAttention: five }),
      [],
    )

    renderHome()

    await waitFor(() => {
      expect(
        screen.getByText('Attention 1'),
      ).toBeInTheDocument()
    })

    // First three render in backend order; the rest are dropped.
    for (let i = 1; i <= 3; i++) {
      expect(screen.getByText(`Attention ${i}`)).toBeInTheDocument()
    }
    expect(
      screen.queryByText('Attention 4'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Attention 5'),
    ).not.toBeInTheDocument()
  })
})

describe('Navigation', () => {
  it('Work Item rows navigate to the canonical Project Work Items surface', async () => {
    renderHome()

    await waitFor(() => {
      expect(
        screen.getByText('Overdue Draft Task'),
      ).toBeInTheDocument()
    })

    fireEvent.click(
      screen.getByText('Overdue Draft Task'),
    )

    expect(currentLocation()).toBe(
      '/projects/7/work-items',
    )
  })

  it('Meeting rows navigate to the canonical Meeting route', async () => {
    renderHome()

    await waitFor(() => {
      expect(
        screen.getByText('FG Weekly Meeting'),
      ).toBeInTheDocument()
    })

    fireEvent.click(
      screen.getByText('FG Weekly Meeting'),
    )

    expect(currentLocation()).toBe('/meetings/201')
  })
})

describe('Today & next presentation rule', () => {
  it('renders at most 5 candidates, in backend order', async () => {
    const eight = Array.from(
      { length: 8 },
      (_, i) => ({
        domain: 'work_item' as const,
        objectId: 300 + i,
        title: `Candidate ${i + 1}`,
        calendarDate: isoDate(0),
        sortAt: isoDateTime(0, 9 + i, 0),
        workItem: {
          workItemId: 300 + i,
          projectId: 7,
          projectName: 'Paper XYZ',
          dueDate: isoDate(0),
          statusCategory: 'todo' as const,
          blockedReason: null,
        },
        meeting: null,
      }),
    )

    mockSuccessfulLoads(
      makeHome({ todayAndNext: eight }),
      [],
    )

    renderHome()

    await waitFor(() => {
      expect(screen.getByText('Candidate 1')).toBeInTheDocument()
    })

    // First five render in backend order; the rest are dropped
    // (no pagination, no reordering).
    for (let i = 1; i <= 5; i++) {
      expect(screen.getByText(`Candidate ${i}`)).toBeInTheDocument()
    }
    expect(
      screen.queryByText('Candidate 6'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Candidate 7'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Candidate 8'),
    ).not.toBeInTheDocument()
  })

  it('renders both Work Item and Meeting timeline candidates', async () => {
    renderHome()

    await waitFor(() => {
      expect(
        screen.getByText('Due Today WI'),
      ).toBeInTheDocument()
    })

    // Both domains present in Today & next.
    expect(
      screen.getByText('FG Weekly Meeting'),
    ).toBeInTheDocument()
    // The Meeting context label distinguishes its domain.
    expect(
      screen.getByText('Research Group Meeting'),
    ).toBeInTheDocument()
  })
})

describe('Continue working semantics', () => {
  it('supports both Work Item and Meeting domains', async () => {
    renderHome()

    await waitFor(() => {
      expect(
        screen.getByText('Recently Edited WI'),
      ).toBeInTheDocument()
    })

    expect(
      screen.getByText('Recently Touched Meeting'),
    ).toBeInTheDocument()
  })

  it('does not label its timestamp as "last opened"', async () => {
    renderHome()

    await waitFor(() => {
      expect(
        screen.getByText('Recently Edited WI'),
      ).toBeInTheDocument()
    })

    const containerText = document.body.textContent ?? ''
    expect(
      /last opened/i.test(containerText),
    ).toBe(false)
    expect(
      /last viewed/i.test(containerText),
    ).toBe(false)
  })

  it('renders at most 4 rows', async () => {
    const six = Array.from(
      { length: 6 },
      (_, i) => ({
        domain: 'work_item' as const,
        objectId: 500 + i,
        title: `Recent ${i + 1}`,
        latestPersonalActivityAt: isoDateTime(0, 8 - i, 0),
        context: { kind: 'project' as const, id: 7, name: 'Paper XYZ' },
        workItem: {
          workItemId: 500 + i,
          projectId: 7,
          projectName: 'Paper XYZ',
          statusCategory: 'in_progress' as const,
          dueDate: null,
        },
        meeting: null,
      }),
    )

    mockSuccessfulLoads(
      makeHome({ continueWorking: six }),
      [],
    )

    renderHome()

    await waitFor(() => {
      expect(screen.getByText('Recent 1')).toBeInTheDocument()
    })

    for (let i = 1; i <= 4; i++) {
      expect(screen.getByText(`Recent ${i}`)).toBeInTheDocument()
    }
    expect(
      screen.queryByText('Recent 5'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Recent 6'),
    ).not.toBeInTheDocument()
  })

  it('never renders the Activity raw payload through Continue working', async () => {
    renderHome()

    await waitFor(() => {
      expect(
        screen.getByText('Recently Edited WI'),
      ).toBeInTheDocument()
    })

    // The raw `changes` marker (only present on the Activity event)
    // must not appear anywhere on the page.
    expect(
      document.body.textContent,
    ).not.toContain('RAW-PAYLOAD-MARKER')
  })
})
