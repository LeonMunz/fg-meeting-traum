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
  MemoryRouter,
  Route,
  Routes,
  useParams,
} from 'react-router'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import { ApiError } from '../../api/client'
import * as meetingsApi from '../../api/meetings'
import * as projectsApi from '../../api/projects'
import { useResearchGroupListScope } from '../research-group/useResearchGroupListScope'
import { useResearchGroup } from '../research-group/useResearchGroup'
import { MeetingListPage } from './MeetingListPage'

import type {
  ApiMeeting,
  ApiMeetingRecurrence,
  ApiMeetingRecurrenceOccurrence,
  ApiMeetingRecurrenceOverview,
  ApiMeetingSeries,
} from '../../api/types'

vi.mock('../../api/meetings', async (importOriginal) => {
  const actual = await importOriginal<typeof meetingsApi>()
  return {
    ...actual,
    listMeetings: vi.fn(),
    listPersonalMeetingRecurrenceOccurrences: vi.fn(),
    listMeetingRecurrences: vi.fn(),
    materializeMeetingRecurrenceOccurrence: vi.fn(),
    createMeeting: vi.fn(),
    createMeetingFromSeries: vi.fn(),
    createMeetingRecurrence: vi.fn(),
    listMeetingSeries: vi.fn(),
    getMeetingSeries: vi.fn(),
    listMeetingParticipants: vi.fn(),
    searchMeetingSeriesParticipantCandidates: vi.fn(),
    searchStandaloneMeetingParticipantCandidates: vi.fn(),
  }
})

vi.mock('../../api/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof projectsApi>()
  return { ...actual, listProjects: vi.fn() }
})

vi.mock('../research-group/useResearchGroupListScope', () => ({
  useResearchGroupListScope: vi.fn(),
}))

vi.mock('../research-group/useResearchGroup', () => ({
  useResearchGroup: vi.fn(),
}))

/*
 * Fixed clock: Wednesday, September 23, 2026, 09:00 local. All
 * fixtures are built from LOCAL date parts, so the expected local
 * calendar dates (Today / Tomorrow / Fri, Sep 25) hold in every
 * time zone.
 */
const NOW = new Date(2026, 8, 23, 9, 0)

function localIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string {
  return new Date(
    year,
    month - 1,
    day,
    hour,
    minute,
  ).toISOString()
}

function makeMeeting(
  overrides: Partial<ApiMeeting> & { id: number },
): ApiMeeting {
  return {
    researchGroupId: 1,
    scope: 'group',
    projectId: null,
    seriesId: null,
    title: `Meeting ${overrides.id}`,
    scheduledAt: localIso(2026, 9, 23, 10, 0),
    startedAt: null,
    endedAt: null,
    status: 'upcoming',
    currentMeetingItemId: null,
    participantIds: [],
    createdById: 1,
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-01T08:00:00Z',
    ...overrides,
  }
}

function makeOccurrence(
  overrides: Partial<ApiMeetingRecurrenceOccurrence> & {
    occurrenceId: string
  },
): ApiMeetingRecurrenceOccurrence {
  return {
    recurrenceId: 10,
    title: `Occurrence ${overrides.occurrenceId}`,
    originalScheduledAt: localIso(2026, 9, 24, 11, 0),
    scheduledAt: localIso(2026, 9, 24, 11, 0),
    materialized: false,
    meetingId: null,
    meetingSeriesId: 7,
    researchGroupId: 1,
    projectId: null,
    ...overrides,
  }
}

function makeSeriesOverview(
  overrides: Partial<ApiMeetingRecurrenceOverview> & {
    id: number
  },
): ApiMeetingRecurrenceOverview {
  return {
    title: `Series ${overrides.id}`,
    meetingSeriesId: 7,
    researchGroupId: 1,
    scope: 'group',
    projectId: null,
    frequency: 'weekly',
    interval: 1,
    weekdays: [1],
    startDate: '2026-09-22',
    localTime: '10:00',
    timezone: 'Europe/Berlin',
    endDate: null,
    count: null,
    creator: {
      id: 1,
      username: 'ana',
      firstName: 'Ana',
      lastName: 'Lis',
    },
    peopleCount: 1,
    status: 'active',
    nextOccurrenceScheduledAt: localIso(2026, 9, 29, 10, 0),
    ...overrides,
  }
}

const template: ApiMeetingSeries = {
  id: 7,
  researchGroupId: 1,
  scope: 'group',
  projectId: null,
  title: 'Weekly template',
  description: '',
  isArchived: false,
  createdById: 1,
  createdAt: '2026-09-10T08:00:00Z',
  updatedAt: '2026-09-10T08:00:00Z',
}

const createdMeeting: ApiMeeting = {
  id: 11,
  researchGroupId: 1,
  scope: 'group',
  projectId: null,
  seriesId: null,
  title: 'One-time meeting',
  scheduledAt: localIso(2026, 9, 23, 10, 0),
  startedAt: null,
  endedAt: null,
  status: 'upcoming',
  currentMeetingItemId: null,
  participantIds: [1],
  createdById: 1,
  createdAt: '2026-09-10T08:00:00Z',
  updatedAt: '2026-09-10T08:00:00Z',
}

function DetailMarker() {
  const { meetingId } = useParams<{ meetingId: string }>()
  return <div>Meeting detail: {meetingId}</div>
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/meetings']}>
      <Routes>
        <Route
          path="/meetings"
          element={<MeetingListPage />}
        />
        <Route
          path="/meetings/series"
          element={<div>Templates overview page</div>}
        />
        <Route
          path="/meetings/:meetingId"
          element={<DetailMarker />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

/**
 * The header 'New meeting' button — scoped to the page <header>
 * because the empty state renders its own 'New meeting' CTA.
 */
function headerNewMeetingButton() {
  const header = screen
    .getByRole('heading', { name: 'Meetings' })
    .closest('header')!

  return within(header).getByRole('button', {
    name: 'New meeting',
  })
}

async function openCreateDialog() {
  // The header action is disabled while the list loads; the
  // enabled state proves the initial load has settled.
  await waitFor(() => {
    expect(headerNewMeetingButton()).toBeEnabled()
  })
  fireEvent.click(headerNewMeetingButton())
}

function selectTemplate() {
  return screen
    .findByRole('option', { name: 'Weekly template' })
    .then(() => {
      fireEvent.change(
        screen.getByLabelText('Meeting template'),
        { target: { value: '7' } },
      )
    })
}

// The canonical rich fixture set: one-time + virtual + materialized
// + rescheduled + cancelled + completed.
function richFixtures() {
  const oneTime = makeMeeting({
    id: 101,
    title: 'Team Sync',
    scheduledAt: localIso(2026, 9, 23, 10, 0),
    participantIds: [1, 2],
  })
  const cancelled = makeMeeting({
    id: 103,
    title: 'Cancelled one',
    scheduledAt: localIso(2026, 9, 23, 12, 0),
    status: 'cancelled',
  })
  const completed = makeMeeting({
    id: 104,
    title: 'Done already',
    scheduledAt: localIso(2026, 9, 23, 8, 0),
    status: 'completed',
  })
  const materializedMeeting = makeMeeting({
    id: 102,
    title: 'Design Review',
    scheduledAt: localIso(2026, 9, 24, 14, 0),
    participantIds: [1],
  })
  const virtual = makeOccurrence({
    occurrenceId: 'occ-v',
    title: 'Weekly Research Sync',
  })
  const materialized = makeOccurrence({
    occurrenceId: 'occ-m',
    title: 'Design Review',
    originalScheduledAt: localIso(2026, 9, 24, 14, 0),
    scheduledAt: localIso(2026, 9, 24, 14, 0),
    materialized: true,
    meetingId: 102,
  })
  const rescheduled = makeOccurrence({
    occurrenceId: 'occ-r',
    title: 'Rescheduled Board',
    originalScheduledAt: localIso(2026, 9, 29, 15, 0),
    scheduledAt: localIso(2026, 9, 25, 9, 30),
  })

  return {
    meetings: [
      oneTime,
      cancelled,
      completed,
      materializedMeeting,
    ],
    occurrences: [virtual, materialized, rescheduled],
  }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)

  vi.mocked(useResearchGroup).mockReturnValue({
    groups: [{ id: 1, name: 'FG', role: 'admin' }],
    activeResearchGroupId: 1,
    activeResearchGroup: { id: 1, name: 'FG', role: 'admin' },
    loading: false,
    error: null,
    setActiveResearchGroupId: vi.fn(),
    reloadResearchGroups: vi.fn(),
    addResearchGroup: vi.fn(),
  })
  vi.mocked(useResearchGroupListScope).mockReturnValue({
    activeResearchGroupId: 1,
    activeResearchGroup: { id: 1, name: 'FG', role: 'admin' },
    loading: false,
    error: null,
  })
  vi.mocked(projectsApi.listProjects).mockResolvedValue([])
  vi.mocked(meetingsApi.listMeetings).mockResolvedValue([])
  vi.mocked(
    meetingsApi.listPersonalMeetingRecurrenceOccurrences,
  ).mockResolvedValue([])
  vi.mocked(meetingsApi.listMeetingRecurrences).mockResolvedValue([])
  vi.mocked(
    meetingsApi.materializeMeetingRecurrenceOccurrence,
  ).mockResolvedValue(createdMeeting)
  vi.mocked(meetingsApi.listMeetingSeries).mockResolvedValue([
    template,
  ])
  vi.mocked(
    meetingsApi.searchStandaloneMeetingParticipantCandidates,
  ).mockResolvedValue([])
  vi.mocked(
    meetingsApi.searchMeetingSeriesParticipantCandidates,
  ).mockResolvedValue([])
  vi.mocked(meetingsApi.createMeeting).mockResolvedValue(
    createdMeeting,
  )
  vi.mocked(
    meetingsApi.createMeetingFromSeries,
  ).mockResolvedValue(createdMeeting)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('MeetingListPage — shell (header + tabs)', () => {
  it('renders the compact header with right-aligned actions', async () => {
    renderPage()

    const header = screen
      .getByRole('heading', { name: 'Meetings' })
      .closest('header')!

    expect(
      within(header).getByText(
        'Your meetings in FG.',
      ),
    ).toBeVisible()
    expect(
      within(header).getByRole('button', {
        name: /New meeting/,
      }),
    ).toBeVisible()
    expect(
      within(header).getByRole('button', {
        name: /Meeting Templates/,
      }),
    ).toBeVisible()
  })

  it('defaults to the Upcoming tab with Series and Past as structural tabs', async () => {
    renderPage()

    const upcoming = screen.getByRole('tab', {
      name: 'Upcoming',
    })
    const series = screen.getByRole('tab', {
      name: 'Series',
    })
    const past = screen.getByRole('tab', { name: 'Past' })

    expect(upcoming).toHaveAttribute('aria-selected', 'true')
    expect(series).toHaveAttribute('aria-selected', 'false')
    expect(past).toHaveAttribute('aria-selected', 'false')
    // Exactly three top-level tabs — nothing else.
    expect(screen.getAllByRole('tab')).toHaveLength(3)
  })

  it('navigates to the existing Meeting Templates page from the header', async () => {
    renderPage()

    const header = screen
      .getByRole('heading', { name: 'Meetings' })
      .closest('header')!

    fireEvent.click(
      within(header).getByRole('button', {
        name: /Meeting Templates/,
      }),
    )

    await screen.findByText('Templates overview page')
  })

  it('keeps Past as an explicit coming-soon shell without fetching its data', async () => {
    renderPage()

    fireEvent.click(screen.getByRole('tab', { name: 'Past' }))
    expect(
      screen.getByText('Past view is coming soon'),
    ).toBeVisible()

    // No Past data implementation leaked in. (The Series tab is a
    // functional read-only overview — its behavior is pinned in
    // the Series overview tests below.)
    expect(
      meetingsApi.listMeetingSeries,
    ).not.toHaveBeenCalled()
    expect(
      meetingsApi.listMeetingRecurrences,
    ).not.toHaveBeenCalled()
  })
})

describe('MeetingListPage — Upcoming data', () => {
  it('requests concrete Meetings and the personal recurring-occurrence feed for the 42-day window', async () => {
    renderPage()

    await screen.findByText('No upcoming meetings')

    expect(meetingsApi.listMeetings).toHaveBeenCalledWith(1)
    expect(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).toHaveBeenCalledTimes(1)

    const [from, to] =
      vi.mocked(
        meetingsApi.listPersonalMeetingRecurrenceOccurrences,
      ).mock.calls[0]

    // Local midnight of today through local midnight of +42 days.
    expect(from).toBe(
      new Date(2026, 8, 23).toISOString(),
    )
    expect(to).toBe(
      new Date(2026, 8, 23 + 42).toISOString(),
    )
  })

  it('renders one-time, virtual, and materialized recurring items together', async () => {
    const { meetings, occurrences } = richFixtures()
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue(
      meetings,
    )
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue(occurrences)

    renderPage()

    await screen.findByRole('heading', { name: 'Today · Wed, Sep 23' })

    // One-time concrete Meeting.
    expect(screen.getByText('Team Sync')).toBeVisible()
    // Virtual recurring occurrence — a normal row.
    expect(
      screen.getByText('Weekly Research Sync'),
    ).toBeVisible()
    // Materialized occurrence: the concrete Meeting's richer
    // representation wins, the feed adds the recurrence metadata —
    // exactly ONE row.
    expect(screen.getAllByText('Design Review')).toHaveLength(1)
  })

  it('never exposes materialization mechanics in copy', async () => {
    const { meetings, occurrences } = richFixtures()
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue(
      meetings,
    )
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue(occurrences)

    const { container } = renderPage()
    await screen.findByRole('heading', { name: 'Today · Wed, Sep 23' })

    const text = container.textContent ?? ''

    expect(text).not.toMatch(/virtual/i)
    expect(text).not.toMatch(/materialized/i)
    expect(text).not.toMatch(/materialize/i)
    expect(text).not.toMatch(/generated/i)
    expect(text).not.toMatch(/series instance/i)
    expect(text).not.toMatch(/occurrence key/i)
  })

  it('shows the recurring indicator as subtle secondary metadata', async () => {
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue([
      makeOccurrence({
        occurrenceId: 'occ-v',
        title: 'Weekly Research Sync',
      }),
    ])

    renderPage()

    await screen.findByText('Weekly Research Sync')

    const row = screen
      .getByText('Weekly Research Sync')
      .closest('div')!
      .closest('div')!
      .parentElement!

    // The indicator is secondary metadata DIRECTLY beneath the
    // title inside the Meeting content block — not a separate
    // column and not a badge. (The `closest`-chain idiom above
    // resolves `row` to that content block itself.)
    expect(row.children).toHaveLength(2)
    expect(
      within(row.children[1] as HTMLElement).getByText('Recurring'),
    ).toBeVisible()
  })

  it('shows no recurring indicator for one-time Meetings', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 1,
        title: 'One-off',
        scheduledAt: localIso(2026, 9, 23, 10, 0),
      }),
    ])

    renderPage()
    await screen.findByRole('heading', { name: 'Today · Wed, Sep 23' })

    expect(
      screen.queryByText('Recurring'),
    ).not.toBeInTheDocument()
  })

  it('groups items by local date with TODAY / TOMORROW / later labels, ascending', async () => {
    const { meetings, occurrences } = richFixtures()
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue(
      meetings,
    )
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue(occurrences)

    const { container } = renderPage()
    await screen.findByRole('heading', { name: 'Today · Wed, Sep 23' })

    const headings = [
      ...container.querySelectorAll('h3'),
    ].map((h) => h.textContent)

    // Today / Tomorrow: relative word PLUS absolute date; later
    // groups: absolute date only. Ascending by local calendar date.
    expect(headings).toEqual([
      'Today · Wed, Sep 23',
      'Tomorrow · Thu, Sep 24',
      'Fri, Sep 25',
    ])
  })

  it('renders date headers without the all-caps tracking treatment, at 12px/600 on the 32px band, with subtle Today emphasis only', async () => {
    const { meetings, occurrences } = richFixtures()
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue(
      meetings,
    )
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue(occurrences)

    const { container } = renderPage()
    await screen.findByRole('heading', { name: 'Today · Wed, Sep 23' })

    const headings = [...container.querySelectorAll('h3')]
    expect(headings).toHaveLength(3)
    for (const heading of headings) {
      // No all-caps / wide-tracking treatment anymore; 12px /
      // 600 on the 32px header band.
      expect(heading.className).not.toContain(
        'uppercase',
      )
      expect(heading.className).not.toContain(
        'tracking-',
      )
      expect(heading.className).toContain('text-xs')
      expect(heading.className).toContain(
        'font-semibold',
      )
      expect(heading.className).toContain('h-8')
    }

    // The Today group gets slightly stronger text emphasis —
    // and only it (no badge, no accent bar).
    expect(headings[0].className).toContain(
      'text-text',
    )
    expect(headings[0].className).not.toContain(
      'text-text-muted',
    )
    expect(headings[1].className).toContain(
      'text-text-muted',
    )
    expect(headings[2].className).toContain(
      'text-text-muted',
    )
  })

  it('keeps ONE shared list container: no leading gap before the first group, ~8px separation before later groups, no per-day cards', async () => {
    const { meetings, occurrences } = richFixtures()
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue(
      meetings,
    )
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue(occurrences)

    const { container } = renderPage()
    await screen.findByRole('heading', { name: 'Today · Wed, Sep 23' })

    const list = container.querySelector(
      '[aria-label="Upcoming meetings"]',
    )!

    // The section's direct children are exactly the group
    // wrappers — one container, no extra per-day card.
    const groupWrappers = [...list.children] as HTMLElement[]
    expect(groupWrappers).toHaveLength(3)
    for (const wrapper of groupWrappers) {
      expect(wrapper.querySelector('h3')).not.toBeNull()
    }

    // No artificial leading gap before the first group; every
    // later group gets the ~8px visual separation before its
    // header.
    expect(groupWrappers[0].className).not.toContain(
      'mt-',
    )
    expect(groupWrappers[1].className).toContain('mt-2')
    expect(groupWrappers[2].className).toContain('mt-2')

    // Ordinary row dividers stay subtle (unchanged treatment).
    const rowDividers = groupWrappers[1].querySelector(
      '.divide-y',
    )!
    expect(rowDividers.className).toContain(
      'divide-border-subtle',
    )
  })

  it('sorts rows ascending by effective start inside a group', async () => {
    const { meetings, occurrences } = richFixtures()
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue(
      meetings,
    )
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue(occurrences)

    renderPage()
    await screen.findByRole('heading', { name: 'Today · Wed, Sep 23' })

    const tomorrowGroup = within(
      screen
        .getByRole('heading', { name: 'Tomorrow · Thu, Sep 24' })
        .closest('div')!,
    )

    const titles = [
      ...tomorrowGroup
        .getAllByText(/./, {
          selector: 'div.truncate.text-sm',
        }),
    ].map((el) => el.textContent)

    // 11:00 (virtual) before 14:00 (materialized).
    expect(titles).toEqual([
      'Weekly Research Sync',
      'Design Review',
    ])
  })

  it('drops cancelled and completed concrete Meetings', async () => {
    const { meetings, occurrences } = richFixtures()
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue(
      meetings,
    )
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue(occurrences)

    renderPage()
    await screen.findByRole('heading', { name: 'Today · Wed, Sep 23' })

    expect(
      screen.queryByText('Cancelled one'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Done already'),
    ).not.toBeInTheDocument()
  })

  it('reflects the feed as the source of truth for recurring occurrences (excluded ones stay absent)', async () => {
    // An excluded occurrence simply is not in the feed.
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue([
      makeOccurrence({
        occurrenceId: 'occ-kept',
        title: 'Kept occurrence',
      }),
    ])

    renderPage()

    await screen.findByText('Kept occurrence')
    expect(
      screen.queryByText('Excluded occurrence'),
    ).not.toBeInTheDocument()
  })

  it('shows a rescheduled occurrence only at its effective time with the Rescheduled badge', async () => {
    const { meetings, occurrences } = richFixtures()
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue(
      meetings,
    )
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue(occurrences)

    renderPage()
    await screen.findByRole('heading', { name: 'Today · Wed, Sep 23' })

    // No group for the original slot (Sep 29).
    expect(
      screen.queryByText('Tue, Sep 29'),
    ).not.toBeInTheDocument()

    // The row lives in the effective-time group (Fri, Sep 25).
    const friGroup = within(
      screen
        .getByRole('heading', { name: 'Fri, Sep 25' })
        .closest('div')!,
    )

    expect(
      friGroup.getByText('Rescheduled Board'),
    ).toBeVisible()
    expect(friGroup.getByText('09:30')).toBeVisible()
    expect(friGroup.getByText('Rescheduled')).toBeVisible()
    expect(
      friGroup.getByText('Originally Sep 29 · 15:00'),
    ).toBeVisible()
  })

  it('shows an In progress badge for a live Meeting', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 1,
        title: 'Live now',
        scheduledAt: localIso(2026, 9, 23, 8, 30),
        status: 'live',
      }),
    ])

    renderPage()
    await screen.findByRole('heading', { name: 'Today · Wed, Sep 23' })

    const todayGroup = within(
      screen
        .getByRole('heading', { name: 'Today · Wed, Sep 23' })
        .closest('div')!,
    )

    expect(
      todayGroup.getByText('In progress'),
    ).toBeVisible()
  })

  it('shows no status badge for a normal upcoming Meeting', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 1,
        title: 'Plain upcoming',
        scheduledAt: localIso(2026, 9, 23, 10, 0),
      }),
    ])

    renderPage()
    await screen.findByRole('heading', { name: 'Today · Wed, Sep 23' })

    const row = screen
      .getByRole('button', {
        name: 'Open Plain upcoming on Wed, Sep 23 at 10:00',
      })

    expect(
      within(row).queryByText('In progress'),
    ).not.toBeInTheDocument()
    expect(
      within(row).queryByText('Rescheduled'),
    ).not.toBeInTheDocument()
    expect(
      within(row).queryByText('Upcoming'),
    ).not.toBeInTheDocument()
  })

  it('excludes concrete Meetings beyond the canonical 42-day window', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      // +40 local days, near the far edge of the window (local
      // midnight of Nov 4): still visible.
      makeMeeting({
        id: 1,
        title: 'Near far edge',
        scheduledAt: localIso(2026, 11, 2, 10, 0),
      }),
      // +45 local days: outside the window.
      makeMeeting({
        id: 2,
        title: 'Beyond window',
        scheduledAt: localIso(2026, 11, 7, 10, 0),
      }),
      // The stale 2030 fixture class: arbitrarily far, absent.
      makeMeeting({
        id: 3,
        title: 'Stale 2030 meeting',
        scheduledAt: '2030-01-02T10:00:00Z',
      }),
    ])

    renderPage()
    await screen.findByRole('heading', { name: 'Mon, Nov 2' })

    expect(screen.getByText('Near far edge')).toBeVisible()
    expect(
      screen.queryByText('Beyond window'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Stale 2030 meeting'),
    ).not.toBeInTheDocument()
  })

  it('excludes past concrete Meetings while today stays visible', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 1,
        title: 'Yesterday meeting',
        scheduledAt: localIso(2026, 9, 22, 10, 0),
      }),
      makeMeeting({
        id: 2,
        title: 'Today meeting',
        scheduledAt: localIso(2026, 9, 23, 10, 0),
      }),
    ])

    renderPage()
    await screen.findByRole('heading', { name: 'Today · Wed, Sep 23' })

    expect(screen.getByText('Today meeting')).toBeVisible()
    expect(
      screen.queryByText('Yesterday meeting'),
    ).not.toBeInTheDocument()
  })

  it('excludes a rescheduled occurrence whose EFFECTIVE time left the window', async () => {
    // Original slot Sep 26 (inside), rescheduled to Nov 7 (+45 days,
    // outside): the row must not appear at either time.
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 201,
        title: 'Rescheduled away',
        scheduledAt: localIso(2026, 11, 7, 9, 30),
      }),
    ])
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue([
      makeOccurrence({
        occurrenceId: 'occ-res-out',
        title: 'Rescheduled away',
        originalScheduledAt: localIso(2026, 9, 26, 10, 0),
        scheduledAt: localIso(2026, 11, 7, 9, 30),
        materialized: true,
        meetingId: 201,
      }),
    ])

    renderPage()

    // Nothing in the window anymore — the empty state shows and the
    // title is absent from any group.
    await screen.findByText('No upcoming meetings')
    expect(
      screen.queryByText('Rescheduled away'),
    ).not.toBeInTheDocument()
  })

  it('gives live Meetings no unbounded window exception', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 1,
        title: 'Live in window',
        scheduledAt: localIso(2026, 9, 23, 8, 30),
        status: 'live',
      }),
      makeMeeting({
        id: 2,
        title: 'Live beyond window',
        scheduledAt: localIso(2026, 11, 7, 9, 0),
        status: 'live',
      }),
    ])

    renderPage()
    await screen.findByRole('heading', { name: 'Today · Wed, Sep 23' })

    const todayGroup = within(
      screen
        .getByRole('heading', { name: 'Today · Wed, Sep 23' })
        .closest('div')!,
    )

    // The in-window live Meeting keeps its In progress behavior…
    expect(todayGroup.getByText('In progress')).toBeVisible()
    // …while the far-future live Meeting is not shown at all.
    expect(
      screen.queryByText('Live beyond window'),
    ).not.toBeInTheDocument()
  })
})

describe('MeetingListPage — Upcoming research-group scoping', () => {
  it('keeps only the active Research Group\'s recurring occurrences, preserving ordering, dedup, and the single feed request', async () => {
    // Same-group concrete Meetings (the existing group-scoped
    // source — unchanged).
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 201,
        title: 'Alpha sync',
        scheduledAt: localIso(2026, 9, 23, 10, 0),
      }),
      makeMeeting({
        id: 202,
        title: 'Alpha review',
        scheduledAt: localIso(2026, 9, 26, 12, 0),
      }),
    ])

    // The personal occurrence feed is cross-group: rows from
    // several Research Groups arrive in ONE response, interleaved.
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue([
      makeOccurrence({
        occurrenceId: 'occ-g1-a',
        recurrenceId: 30,
        title: 'Group one weekly',
        researchGroupId: 1,
        originalScheduledAt: localIso(2026, 9, 24, 9, 0),
        scheduledAt: localIso(2026, 9, 24, 9, 0),
      }),
      makeOccurrence({
        occurrenceId: 'occ-g2-a',
        recurrenceId: 31,
        title: 'Group two weekly',
        researchGroupId: 2,
        originalScheduledAt: localIso(2026, 9, 24, 10, 0),
        scheduledAt: localIso(2026, 9, 24, 10, 0),
      }),
      // A materialized cross-group occurrence (its concrete
      // Meeting is NOT in the active group's list) must not
      // surface either.
      makeOccurrence({
        occurrenceId: 'occ-g2-b',
        recurrenceId: 31,
        title: 'Group two materialized',
        researchGroupId: 2,
        originalScheduledAt: localIso(2026, 9, 25, 11, 0),
        scheduledAt: localIso(2026, 9, 25, 11, 0),
        materialized: true,
        meetingId: 999,
      }),
      makeOccurrence({
        occurrenceId: 'occ-g1-b',
        recurrenceId: 30,
        title: 'Group one later',
        researchGroupId: 1,
        originalScheduledAt: localIso(2026, 9, 25, 9, 0),
        scheduledAt: localIso(2026, 9, 25, 9, 0),
      }),
      // The active group's materialized occurrence joins its
      // concrete Meeting (deduplication on canonical identity —
      // unchanged): exactly one row.
      makeOccurrence({
        occurrenceId: 'occ-g1-c',
        recurrenceId: 30,
        title: 'Alpha review',
        researchGroupId: 1,
        originalScheduledAt: localIso(2026, 9, 26, 12, 0),
        scheduledAt: localIso(2026, 9, 26, 12, 0),
        materialized: true,
        meetingId: 202,
      }),
    ])

    renderPage()

    await screen.findByText('Group one weekly')

    const section = screen.getByRole('region', {
      name: 'Upcoming meetings',
    })

    // Same-group concrete Meetings remain present.
    expect(screen.getByText('Alpha sync')).toBeVisible()

    // EXACTLY the active group's rows, in effective-scheduledAt
    // order — the interleaved cross-group rows must not enter
    // the list or disturb its ordering.
    const rowTitles = within(section)
      .getAllByRole('button')
      .map((row) => row.getAttribute('aria-label') ?? '')
      .filter((label) => label.startsWith('Open '))
      // Row label format: `Open <title> on <date> at <time>`.
      .map((label) =>
        label.slice(
          'Open '.length,
          label.indexOf(' on '),
        ),
      )
    expect(rowTitles).toEqual([
      'Alpha sync',
      'Group one weekly',
      'Group one later',
      'Alpha review',
    ])

    // Cross-group recurrence rows never enter the rendered
    // Upcoming list (virtual or materialized).
    expect(
      screen.queryByText('Group two weekly'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Group two materialized'),
    ).not.toBeInTheDocument()

    // The materialized same-group occurrence appears EXACTLY
    // once (canonical-identity deduplication unchanged).
    expect(
      screen.getAllByText('Alpha review'),
    ).toHaveLength(1)

    // The scoping is a pure page-level filter: exactly one
    // feed request, no per-row / per-group lookups.
    expect(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).toHaveBeenCalledTimes(1)
    expect(meetingsApi.listMeetings).toHaveBeenCalledTimes(1)
    expect(meetingsApi.getMeetingSeries).not.toHaveBeenCalled()
    expect(
      meetingsApi.listMeetingParticipants,
    ).not.toHaveBeenCalled()
  })

  it("follows the page's active Research Group, not a fixed group", async () => {
    vi.mocked(useResearchGroupListScope).mockReturnValue({
      activeResearchGroupId: 2,
      activeResearchGroup: {
        id: 2,
        name: 'Other FG',
        role: 'admin',
      },
      loading: false,
      error: null,
    })
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 210,
        title: 'Beta sync',
        researchGroupId: 2,
        scheduledAt: localIso(2026, 9, 23, 10, 0),
      }),
    ])
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue([
      makeOccurrence({
        occurrenceId: 'occ-g1-d',
        recurrenceId: 30,
        title: 'First group weekly',
        researchGroupId: 1,
        originalScheduledAt: localIso(2026, 9, 24, 9, 0),
        scheduledAt: localIso(2026, 9, 24, 9, 0),
      }),
      makeOccurrence({
        occurrenceId: 'occ-g2-c',
        recurrenceId: 31,
        title: 'Second group weekly',
        researchGroupId: 2,
        originalScheduledAt: localIso(2026, 9, 24, 11, 0),
        scheduledAt: localIso(2026, 9, 24, 11, 0),
      }),
    ])

    renderPage()

    await screen.findByText('Second group weekly')

    expect(
      screen.queryByText('First group weekly'),
    ).not.toBeInTheDocument()
    // Same-group concrete Meetings remain present under the
    // switched scope.
    expect(screen.getByText('Beta sync')).toBeVisible()
    // The concrete Meeting list follows the same page scope.
    expect(meetingsApi.listMeetings).toHaveBeenCalledWith(2)
    // Still exactly one cross-group feed request — the scope is
    // a client-side filter, not a changed request.
    expect(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).toHaveBeenCalledTimes(1)
  })
})

describe('MeetingListPage — row structure and interaction', () => {
  it('renders the desktop row semantics: Time, Meeting, People, Actions', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 101,
        title: 'Team Sync',
        scheduledAt: localIso(2026, 9, 23, 10, 0),
        participantIds: [1, 2],
      }),
    ])

    renderPage()
    await screen.findByRole('heading', { name: 'Today · Wed, Sep 23' })

    // Time cell.
    expect(screen.getByText('10:00')).toBeVisible()
    // People data appears in exactly the two responsive slots:
    // the standalone desktop People column plus the secondary
    // metadata that carries it on mobile/tablet (CSS hides one of
    // the two per viewport; happy-dom keeps both in the DOM).
    expect(
      screen.getAllByText('2 people'),
    ).toHaveLength(2)
    // Actions cell: the per-row overflow affordance, which lives in
    // the far-right Actions region — never inside the Meeting block.
    const kebab = screen.getByRole('button', {
      name: 'Meeting actions for Team Sync',
    })
    expect(kebab).toBeVisible()

    // The desktop row exposes four distinct regions: Time, Meeting,
    // People, Actions — and the kebab is inside the Actions region.
    const row = screen.getByRole('button', {
      name: 'Open Team Sync on Wed, Sep 23 at 10:00',
    })
    expect(row.children).toHaveLength(4)
    const meetingBlock = row.children[1] as HTMLElement
    expect(
      within(meetingBlock).queryByRole('button'),
    ).toBeNull()
    const actionsRegion = row.children[3] as HTMLElement
    expect(actionsRegion).toContainElement(kebab)
  })

  it('shows participant data only when truthfully available (never fabricated for virtual occurrences)', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 101,
        title: 'Team Sync',
        scheduledAt: localIso(2026, 9, 23, 10, 0),
        participantIds: [1, 2],
      }),
    ])
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue([
      makeOccurrence({
        occurrenceId: 'occ-v',
        title: 'Occurrence row check',
      }),
    ])

    const { container } = renderPage()
    await screen.findByRole('heading', { name: 'Today · Wed, Sep 23' })

    // The concrete row carries its people count in exactly the two
    // responsive slots; the virtual row carries none.
    expect(
      screen.getAllByText('2 people'),
    ).toHaveLength(2)

    const virtualRow = screen
      .getByText('Occurrence row check')
      .parentElement! // Meeting content block
      .parentElement! // the row grid

    // The virtual row keeps the four-region track with an EMPTY
    // People region…
    expect(virtualRow.children).toHaveLength(4)
    // …and no people count is fabricated anywhere in it.
    expect(
      within(virtualRow).queryByText(/people/),
    ).not.toBeInTheDocument()
    expect(container.querySelectorAll('table')).toHaveLength(0)
  })

  it('encodes the responsive layout contract (tablet drops the People column, no horizontal-table dependency)', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 101,
        title: 'Team Sync',
        scheduledAt: localIso(2026, 9, 23, 10, 0),
        participantIds: [1, 2],
      }),
    ])

    const { container } = renderPage()
    await screen.findByRole('heading', { name: 'Today · Wed, Sep 23' })

    const row = screen
      .getByRole('button', {
        name: 'Open Team Sync on Wed, Sep 23 at 10:00',
      })

    // Tablet (768–1099): Time + Meeting + Actions; the standalone
    // People cell is display-removed and its value folds into the
    // secondary metadata instead.
    expect(row.className).toContain(
      'md:max-[1100px]:grid-cols-[88px_minmax(0,1fr)_40px]',
    )
    // Desktop (≥1100): the four semantic columns — compact 104px
    // Time, flexible Meeting (minmax(0,1fr) so the track can
    // shrink and truncate instead of pushing the fixed columns
    // out), 96px nowrap People, 48px Actions.
    expect(row.className).toContain(
      'min-[1100px]:grid-cols-[104px_minmax(0,1fr)_96px_48px]',
    )
    // REGRESSION GUARD (Slice 21 visual fix): the desktop and
    // tablet templates must live in MUTUALLY EXCLUSIVE media
    // ranges. Tailwind v4 emits the px-based min-[1100px] block
    // BEFORE the rem-based md: block in the compiled CSS, so an
    // overlapping plain md:grid-cols-[…] on the same element would
    // win at desktop widths — four visible children in three
    // tracks (Actions wraps to a second row, People clips in the
    // 40px Actions track). That exact class combination was the
    // Slice 21 browser defect.
    expect(row.className).not.toMatch(/(^|\s)md:grid-cols-\[/)
    // Mobile (<768): stacked single column.
    expect(row.className).toContain('grid-cols-1')
    // Compact row geometry: 68px minimum height, 12px block / 16px
    // inline padding.
    expect(row.className).toContain('min-h-[68px]')
    expect(row.className).toContain('py-3')
    expect(row.className).toContain('px-4')

    const peopleCell = row.querySelector(
      '.hidden.min-\\[1100px\\]\\:block',
    )
    expect(peopleCell).not.toBeNull()
    // People never wraps into "1\nperson".
    expect(peopleCell!.className).toContain(
      'whitespace-nowrap',
    )

    const peopleSecondary = row.querySelector(
      '.min-\\[1100px\\]\\:hidden',
    )
    expect(peopleSecondary).not.toBeNull()

    // Note: these class-string assertions pin the breakpoint
    // CONTRACT (which media range carries which template). They
    // cannot prove rendered geometry — happy-dom performs no
    // layout. The browser-visible geometry is verified by the
    // manual browser check at the acceptance viewports.

    // Date group header: compact 32px band, not a card.
    const dateHeader = screen.getByRole('heading', {
      name: 'Today · Wed, Sep 23',
    })
    expect(dateHeader.className).toContain('h-8')
    expect(dateHeader.className).toContain('px-4')

    // No table element and no horizontal-overflow machinery.
    expect(container.querySelectorAll('table')).toHaveLength(0)
    expect(row.className).not.toContain('overflow-x')
  })

  it('keeps People in a dedicated row-level region (never inside the Meeting content block)', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 101,
        title: 'Team Sync',
        scheduledAt: localIso(2026, 9, 23, 10, 0),
        participantIds: [1],
      }),
    ])

    renderPage()
    await screen.findByRole('heading', {
      name: 'Today · Wed, Sep 23',
    })

    const row = screen.getByRole('button', {
      name: 'Open Team Sync on Wed, Sep 23 at 10:00',
    })

    // Four sibling regions at the row level: Time, Meeting,
    // People, Actions.
    expect(row.children).toHaveLength(4)

    // People is the row-level region (index 2), a GRID SIBLING of
    // the Meeting block — never a child of it — and carries the
    // count as one text string.
    const peopleRegion = row.children[2] as HTMLElement
    expect(peopleRegion.textContent).toBe('1 person')
    expect(peopleRegion).toHaveClass(
      'hidden',
      'whitespace-nowrap',
    )
    const meetingBlock = row.children[1] as HTMLElement
    expect(meetingBlock.contains(peopleRegion)).toBe(false)
    // The Meeting block holds title + metadata line only.
    expect(meetingBlock.children).toHaveLength(2)
  })

  it('does not drop the People/Actions regions for a long Meeting title', async () => {
    const longTitle =
      'Very Long Research Coordination Meeting Title That Keeps Growing And Growing'

    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 101,
        title: longTitle,
        scheduledAt: localIso(2026, 9, 23, 17, 30),
        participantIds: [1, 2, 3, 4, 5],
      }),
    ])

    renderPage()
    await screen.findByRole('heading', {
      name: 'Today · Wed, Sep 23',
    })

    const row = screen.getByRole('button', {
      name: `Open ${longTitle} on Wed, Sep 23 at 17:30`,
    })

    // The row keeps its four sibling regions regardless of title
    // length: People and Actions are never sacrificed.
    expect(row.children).toHaveLength(4)
    expect(
      (row.children[2] as HTMLElement).textContent,
    ).toBe('5 people')
    expect(
      within(row.children[3] as HTMLElement).getByRole(
        'button',
        {
          name: `Meeting actions for ${longTitle}`,
        },
      ),
    ).toBeVisible()

    // The long title degrades by truncation inside the flexible
    // minmax(0,1fr) track (min-w-0 cell + truncate title) — it
    // never pushes the fixed columns outside the row.
    const meetingBlock = row.children[1] as HTMLElement
    expect(meetingBlock.className).toContain('min-w-0')
    expect(
      within(meetingBlock).getByText(longTitle),
    ).toHaveClass('truncate')
  })

  it('offers the same Open meeting affordance for a virtual occurrence as for a concrete Meeting', async () => {
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue([
      makeOccurrence({
        occurrenceId: 'occ-v',
        title: 'Weekly Research Sync',
      }),
    ])

    renderPage()
    await screen.findByText('Weekly Research Sync')

    const row = screen
      .getByText('Weekly Research Sync')
      .parentElement! // Meeting content block
      .parentElement! // the row grid

    // The row keeps its four-region track (the Meeting column is
    // NOT pulled into the Actions region)…
    expect(row.children).toHaveLength(4)
    // …and the Actions region carries the SAME per-row overflow
    // affordance as a concrete Meeting row.
    const actionsRegion =
      row.children[3] as HTMLElement
    expect(
      within(actionsRegion).getByRole('button', {
        name:
          'Meeting actions for Weekly Research Sync',
      }),
    ).toBeVisible()

    // The affordance offers the plain "Open meeting" action —
    // never materialization terminology.
    fireEvent.click(
      within(actionsRegion).getByRole('button', {
        name:
          'Meeting actions for Weekly Research Sync',
      }),
    )
    expect(
      screen.getByRole('menuitem', {
        name: 'Open meeting',
      }),
    ).toBeVisible()
  })

  it('keeps the generic "Recurring" metadata and never invents a rule string', async () => {
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue([
      makeOccurrence({
        occurrenceId: 'occ-meta',
        title: 'Weekly Research Sync',
      }),
    ])

    renderPage()
    await screen.findByText('Weekly Research Sync')

    const row = screen
      .getByText('Weekly Research Sync')
      .parentElement! // Meeting content block
      .parentElement! // the row grid
    const meetingBlock = row.children[1] as HTMLElement
    const metaLine = meetingBlock.children[1] as HTMLElement

    // The generic indicator is preserved…
    expect(
      within(metaLine).getByText('Recurring'),
    ).toBeVisible()
    // …and NO recurrence rule string is invented — the feed DTO
    // carries no rule data, and spacing must not be inferred.
    expect(metaLine.textContent).not.toMatch(
      /weekly|every\s+\d|bi-?weekly|bi-?monthly|monthly|yearly|annually/i,
    )
  })

  it('renders no fabricated People count for a virtual occurrence', async () => {
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue([
      makeOccurrence({
        occurrenceId: 'occ-people',
        title: 'Weekly Research Sync',
      }),
    ])

    renderPage()
    await screen.findByText('Weekly Research Sync')

    const row = screen
      .getByText('Weekly Research Sync')
      .parentElement! // Meeting content block
      .parentElement! // the row grid

    // The row-level People region (index 2) stays EMPTY — the feed
    // carries no participant data, so no count is fabricated.
    const peopleRegion =
      row.children[2] as HTMLElement
    expect(peopleRegion.textContent).toBe('')
    // …and no "N person(s)" copy leaks anywhere in the row.
    expect(row.textContent).not.toMatch(
      /\d+\s+people?\b/i,
    )
  })

  it('does not trigger row navigation when the kebab is clicked', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 101,
        title: 'Team Sync',
        scheduledAt: localIso(2026, 9, 23, 10, 0),
      }),
    ])

    renderPage()
    await screen.findByRole('button', {
      name: 'Meeting actions for Team Sync',
    })

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Meeting actions for Team Sync',
      }),
    )

    // The menu opens…
    expect(
      screen.getByRole('menuitem', {
        name: 'Open meeting',
      }),
    ).toBeVisible()
    // …but the row action (open the Meeting) did NOT fire.
    expect(
      screen.queryByText(/Meeting detail:/),
    ).not.toBeInTheDocument()
  })

  it('renders the People count as one semantic string ("1 person")', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 101,
        title: 'Team Sync',
        scheduledAt: localIso(2026, 9, 23, 10, 0),
        participantIds: [1],
      }),
    ])

    renderPage()
    await screen.findByRole('heading', { name: 'Today · Wed, Sep 23' })

    // One semantic string per responsive slot (the desktop People
    // column plus the secondary metadata); never a wrapped
    // "1 / person" pair.
    const labels = screen.getAllByText('1 person')
    expect(labels).toHaveLength(2)
    for (const label of labels) {
      expect(label.textContent).toBe('1 person')
    }
  })

  it('reserves no blank second line for a normal row without secondary information', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 101,
        title: 'Plain upcoming',
        scheduledAt: localIso(2026, 9, 23, 10, 0),
      }),
    ])

    renderPage()
    await screen.findByRole('heading', { name: 'Today · Wed, Sep 23' })

    const row = screen.getByRole('button', {
      name: 'Open Plain upcoming on Wed, Sep 23 at 10:00',
    })

    // The Meeting content block holds exactly the title — no
    // placeholder metadata line.
    const meetingBlock = row.children[1] as HTMLElement
    expect(meetingBlock.children).toHaveLength(1)
    expect(
      within(meetingBlock).getByText('Plain upcoming'),
    ).toBeVisible()

    // The action control lives in the row-level Actions region
    // (grid track 4), never inside the Meeting block — it cannot
    // create a second visual row.
    expect(row.children).toHaveLength(4)
    const actionsRegion = row.children[3] as HTMLElement
    expect(
      within(actionsRegion).getByRole('button'),
    ).toBeVisible()
    expect(
      meetingBlock.contains(actionsRegion),
    ).toBe(false)
  })

  it('navigates to the existing Meeting detail for a concrete row', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 101,
        title: 'Team Sync',
        scheduledAt: localIso(2026, 9, 23, 10, 0),
      }),
    ])

    renderPage()
    await screen.findByRole('button', {
      name: 'Open Team Sync on Wed, Sep 23 at 10:00',
    })

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Open Team Sync on Wed, Sep 23 at 10:00',
      }),
    )

    await screen.findByText('Meeting detail: 101')
  })

  it('navigates from the row actions menu too', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 101,
        title: 'Team Sync',
        scheduledAt: localIso(2026, 9, 23, 10, 0),
      }),
    ])

    renderPage()
    await screen.findByRole('button', {
      name: 'Meeting actions for Team Sync',
    })

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Meeting actions for Team Sync',
      }),
    )
    fireEvent.click(screen.getByRole('menuitem', {
      name: 'Open meeting',
    }))

    await screen.findByText('Meeting detail: 101')
  })

  it('gives same-title same-time occurrences on different dates unique accessible names', async () => {
    // One concrete + two virtual rows share the title AND the clock
    // time but occupy different calendar dates: every row must stay
    // resolvable by its semantic identity alone (no positional
    // disambiguation), and concrete + virtual follow the same
    // naming rule.
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 700,
        title: 'Weekly Research Sync',
        scheduledAt: localIso(2026, 9, 23, 11, 0),
      }),
    ])
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue([
      makeOccurrence({
        occurrenceId: 'occ-a',
        title: 'Weekly Research Sync',
      }),
      makeOccurrence({
        occurrenceId: 'occ-b',
        title: 'Weekly Research Sync',
        originalScheduledAt: localIso(2026, 9, 30, 11, 0),
        scheduledAt: localIso(2026, 9, 30, 11, 0),
      }),
    ])

    renderPage()

    // Each name resolves to exactly one row (strict mode would
    // reject a duplicate accessible name).
    const concreteRow = await screen.findByRole('button', {
      name: 'Open Weekly Research Sync on Wed, Sep 23 at 11:00',
    })
    const firstVirtualRow = screen.getByRole('button', {
      name: 'Open Weekly Research Sync on Thu, Sep 24 at 11:00',
    })
    const secondVirtualRow = screen.getByRole('button', {
      name: 'Open Weekly Research Sync on Wed, Sep 30 at 11:00',
    })

    expect(
      concreteRow.getAttribute('aria-label'),
    ).not.toBe(firstVirtualRow.getAttribute('aria-label'))
    expect(
      firstVirtualRow.getAttribute('aria-label'),
    ).not.toBe(secondVirtualRow.getAttribute('aria-label'))
  })

  it('identifies a rescheduled occurrence by its effective slot, not the original one', async () => {
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue([
      makeOccurrence({
        occurrenceId: 'occ-r',
        title: 'Weekly Research Sync',
        originalScheduledAt: localIso(2026, 9, 30, 11, 0),
        scheduledAt: localIso(2026, 9, 24, 14, 30),
      }),
    ])

    renderPage()

    // The accessible identity carries the EFFECTIVE date/time
    // (where the occurrence appears in Upcoming)…
    const row = await screen.findByRole('button', {
      name: 'Open Weekly Research Sync on Thu, Sep 24 at 14:30',
    })
    expect(row).toHaveAttribute(
      'aria-label',
      'Open Weekly Research Sync on Thu, Sep 24 at 14:30',
    )
    // …and never the original slot.
    expect(
      row.getAttribute('aria-label'),
    ).not.toMatch(/Sep 30/)
  })

})

describe('MeetingListPage — opening Upcoming rows', () => {
  function virtualFixture() {
    return makeOccurrence({
      occurrenceId: 'occ-v',
      title: 'Weekly Research Sync',
    })
  }

  const materializedMeeting: ApiMeeting = {
    ...makeMeeting({
      id: 555,
      title: 'Weekly Research Sync',
      scheduledAt: localIso(2026, 9, 24, 11, 0),
      participantIds: [1],
    }),
  }

  async function renderVirtualList() {
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue([virtualFixture()])

    renderPage()
    await screen.findByRole('button', {
      name: 'Open Weekly Research Sync on Thu, Sep 24 at 11:00',
    })

    return screen.getByRole('button', {
      name: 'Open Weekly Research Sync on Thu, Sep 24 at 11:00',
    }) as HTMLElement
  }

  it('opens a virtual occurrence with exactly one materialization request and navigates to the returned Meeting', async () => {
    const row = await renderVirtualList()
    vi.mocked(
      meetingsApi.materializeMeetingRecurrenceOccurrence,
    ).mockResolvedValue(materializedMeeting)

    fireEvent.click(row)

    await screen.findByText('Meeting detail: 555')

    // The canonical endpoint contract: the stable occurrence
    // identity pair exactly as the feed reported it, plus the
    // concrete Meeting title.
    expect(
      meetingsApi.materializeMeetingRecurrenceOccurrence,
    ).toHaveBeenCalledTimes(1)
    expect(
      meetingsApi.materializeMeetingRecurrenceOccurrence,
    ).toHaveBeenCalledWith(10, {
      occurrenceId: 'occ-v',
      originalScheduledAt: localIso(2026, 9, 24, 11, 0),
      title: 'Weekly Research Sync',
    })
    // No other write path was touched.
    expect(meetingsApi.createMeeting).not.toHaveBeenCalled()
    expect(
      meetingsApi.createMeetingFromSeries,
    ).not.toHaveBeenCalled()
    expect(
      meetingsApi.createMeetingRecurrence,
    ).not.toHaveBeenCalled()
  })

  it('navigates to a materialized occurrence directly, without any materialization request', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 102,
        title: 'Design Review',
        scheduledAt: localIso(2026, 9, 24, 14, 0),
      }),
    ])
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue([
      makeOccurrence({
        occurrenceId: 'occ-m',
        title: 'Design Review',
        originalScheduledAt: localIso(2026, 9, 24, 14, 0),
        scheduledAt: localIso(2026, 9, 24, 14, 0),
        materialized: true,
        meetingId: 102,
      }),
    ])

    renderPage()
    const row = await screen.findByRole('button', {
      name: 'Open Design Review on Thu, Sep 24 at 14:00',
    })

    fireEvent.click(row)

    await screen.findByText('Meeting detail: 102')
    expect(
      meetingsApi.materializeMeetingRecurrenceOccurrence,
    ).not.toHaveBeenCalled()
  })

  it('issues no materialization request from rendering, hovering, or focusing the Upcoming list', async () => {
    const row = await renderVirtualList()

    // The list rendered a virtual occurrence…
    expect(
      meetingsApi.materializeMeetingRecurrenceOccurrence,
    ).not.toHaveBeenCalled()

    // …and neither focus nor hover intent writes anything.
    fireEvent.focus(row)
    fireEvent.mouseEnter(row)
    expect(
      meetingsApi.materializeMeetingRecurrenceOccurrence,
    ).not.toHaveBeenCalled()
  })

  it('matches the concrete Meeting row interaction: pointer, keyboard, and focus behavior', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 101,
        title: 'Team Sync',
        scheduledAt: localIso(2026, 9, 23, 10, 0),
      }),
    ])
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue([virtualFixture()])

    renderPage()
    await screen.findByRole('heading', {
      name: 'Today · Wed, Sep 23',
    })

    const concreteRow = screen.getByRole('button', {
      name: 'Open Team Sync on Wed, Sep 23 at 10:00',
    }) as HTMLElement
    const virtualRow = screen.getByRole('button', {
      name: 'Open Weekly Research Sync on Thu, Sep 24 at 11:00',
    }) as HTMLElement

    // Same interactive contract on both rows.
    for (const row of [concreteRow, virtualRow]) {
      expect(row).toHaveAttribute('role', 'button')
      expect(row).toHaveAttribute('tabindex', '0')
      expect(row.className).toContain('cursor-pointer')
      expect(row.className).toContain('hover:bg-surface-hover')
      expect(row.className).toContain(
        'focus-visible:ring-2',
      )
    }

    // Keyboard activation of the virtual row is an explicit open
    // intent too: Enter resolves the occurrence.
    vi.mocked(
      meetingsApi.materializeMeetingRecurrenceOccurrence,
    ).mockResolvedValue(materializedMeeting)
    fireEvent.keyDown(virtualRow, { key: 'Enter' })

    await screen.findByText('Meeting detail: 555')
    expect(
      meetingsApi.materializeMeetingRecurrenceOccurrence,
    ).toHaveBeenCalledTimes(1)
  })

  it('shows a subtle per-row pending state and blocks duplicate activation while the open is in flight', async () => {
    const row = await renderVirtualList()

    let resolveMaterialize: (
      value: ApiMeeting,
    ) => void
    vi.mocked(
      meetingsApi.materializeMeetingRecurrenceOccurrence,
    ).mockReturnValue(
      new Promise<ApiMeeting>((resolve) => {
        resolveMaterialize = resolve
      }),
    )

    fireEvent.click(row)
    await waitFor(() => {
      expect(row).toHaveAttribute('aria-busy', 'true')
    })

    // Repeated activation (double-click race) while pending is a
    // strict no-op client-side.
    fireEvent.click(row)
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(
      meetingsApi.materializeMeetingRecurrenceOccurrence,
    ).toHaveBeenCalledTimes(1)

    resolveMaterialize!(materializedMeeting)
    await screen.findByText('Meeting detail: 555')

    // Still exactly one request after the flight settles.
    expect(
      meetingsApi.materializeMeetingRecurrenceOccurrence,
    ).toHaveBeenCalledTimes(1)
  })

  it('keeps the user on Upcoming with retryable error feedback when the open fails, and permits retry', async () => {
    const row = await renderVirtualList()
    vi.mocked(
      meetingsApi.materializeMeetingRecurrenceOccurrence,
    ).mockRejectedValue(
      new ApiError(
        400,
        { error: 'The occurrence is no longer available.' },
      ),
    )

    fireEvent.click(row)

    // No navigation to a fabricated Meeting…
    expect(
      screen.queryByText(/Meeting detail:/),
    ).not.toBeInTheDocument()

    // Concise, actionable error feedback.
    const alert = await screen.findByRole('alert')
    expect(
      within(alert).getByText(
        'The meeting couldn\'t be opened.',
      ),
    ).toBeVisible()
    expect(
      within(alert).getByText(
        'The occurrence is no longer available.',
      ),
    ).toBeVisible()
    // The failed open restored the row to its interactive state
    // (pending indicator gone, keyboard-activatable again).
    expect(row).not.toHaveAttribute('aria-busy')
    expect(row).toHaveAttribute('tabindex', '0')

    // Retry through the banner re-issues the same explicit intent.
    vi.mocked(
      meetingsApi.materializeMeetingRecurrenceOccurrence,
    ).mockResolvedValue(materializedMeeting)
    fireEvent.click(
      within(alert).getByRole('button', {
        name: 'Try again',
      }),
    )

    await screen.findByText('Meeting detail: 555')
    expect(
      meetingsApi.materializeMeetingRecurrenceOccurrence,
    ).toHaveBeenCalledTimes(2)
    expect(
      screen.queryByRole('alert'),
    ).toBeNull()
  })
})

describe('MeetingListPage — states (empty / loading / error)', () => {
  it('renders the empty state with a New meeting CTA', async () => {
    const { container } = renderPage()

    await screen.findByText('No upcoming meetings')
    expect(
      screen.getByText(
        'Schedule a meeting or create a recurring series.',
      ),
    ).toBeVisible()

    const cta = within(
      screen
        .getByText('No upcoming meetings')
        .closest('div')!,
    ).getByRole('button', { name: /New meeting/ })

    expect(cta).toBeVisible()

    fireEvent.click(cta)
    await screen.findByRole('dialog', {
      name: 'New meeting',
    })

    // No blank table: the list section is not rendered.
    expect(
      container.querySelector('[aria-label="Upcoming meetings"]'),
    ).toBeNull()
  })

  it('keeps the header and tabs visible while loading, with row skeletons instead of a page spinner', async () => {
    vi.mocked(meetingsApi.listMeetings).mockReturnValue(
      new Promise(() => {}),
    )

    renderPage()

    const skeleton =
      await screen.findByRole('region', {
        name: 'Loading upcoming meetings',
      })
    expect(skeleton).not.toBeNull()
    // Five skeleton rows matching the row geometry.
    expect(
      skeleton!.querySelectorAll('div.min-h-\\[68px\\]').length,
    ).toBe(5)

    // Header + tabs remain visible; no full-page spinner copy.
    expect(
      screen.getByRole('heading', { name: 'Meetings' }),
    ).toBeVisible()
    expect(
      screen.getByRole('tab', { name: 'Upcoming' }),
    ).toBeVisible()
    expect(
      screen.queryByText('Loading meetings…'),
    ).not.toBeInTheDocument()
    // The create action waits for the settled list.
    expect(headerNewMeetingButton()).toBeDisabled()
  })

  it('keeps concrete Meetings visible when the recurrence feed is still loading, with an honest trailing indicator', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 101,
        title: 'Team Sync',
        scheduledAt: localIso(2026, 9, 23, 10, 0),
      }),
    ])

    let resolveOccurrences: (
      value: ApiMeetingRecurrenceOccurrence[],
    ) => void
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockReturnValue(
      new Promise((resolve) => {
        resolveOccurrences = resolve
      }),
    )

    renderPage()
    await screen.findByRole('heading', { name: 'Today · Wed, Sep 23' })

    // Concrete data is already rendered…
    expect(screen.getByText('Team Sync')).toBeVisible()
    // …and the pending feed is indicated, not faked.
    expect(
      screen.getByText('Loading recurring meetings…'),
    ).toBeVisible()

    resolveOccurrences!([
      makeOccurrence({
        occurrenceId: 'occ-v',
        title: 'Weekly Research Sync',
      }),
    ])

    await screen.findByText('Weekly Research Sync')
    expect(
      screen.queryByText('Loading recurring meetings…'),
    ).not.toBeInTheDocument()
  })

  it('shows a compact recoverable error when the recurrence feed fails, preserving concrete Meetings', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 101,
        title: 'Team Sync',
        scheduledAt: localIso(2026, 9, 23, 10, 0),
      }),
    ])
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    )
      .mockRejectedValueOnce(
        new ApiError(500, { error: 'feed down' }),
      )
      .mockResolvedValueOnce([
        makeOccurrence({
          occurrenceId: 'occ-v',
          title: 'Weekly Research Sync',
        }),
      ])

    renderPage()
    await screen.findByRole('alert')

    // Concrete data survived the feed failure.
    expect(screen.getByText('Team Sync')).toBeVisible()
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('feed down')

    // Not the full-page error: the list and the empty-state claim
    // are both absent, and no empty-state copy lies about absence.
    expect(
      screen.queryByText('No upcoming meetings'),
    ).not.toBeInTheDocument()

    // Retry re-fetches ONLY the feed.
    fireEvent.click(
      within(alert).getByRole('button', { name: /Retry/ }),
    )

    await screen.findByText('Weekly Research Sync')
    expect(
      screen.queryByRole('alert'),
    ).not.toBeInTheDocument()
    expect(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).toHaveBeenCalledTimes(2)
    expect(meetingsApi.listMeetings).toHaveBeenCalledTimes(1)
  })

  it('shows the full-page error when concrete Meetings fail, with recovery', async () => {
    vi.mocked(meetingsApi.listMeetings)
      .mockRejectedValueOnce(
        new ApiError(500, { error: 'meetings down' }),
      )
      .mockResolvedValueOnce([
        makeMeeting({
          id: 101,
          title: 'Team Sync',
          scheduledAt: localIso(2026, 9, 23, 10, 0),
        }),
      ])

    renderPage()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('meetings down')

    fireEvent.click(
      within(alert).getByRole('button', {
        name: /Try again/,
      }),
    )

    await screen.findByText('Team Sync')
  })
})

describe('MeetingListPage — Series overview', () => {
  it('issues no Series request while only the Upcoming tab is rendered', async () => {
    renderPage()

    // Wait until the initial Upcoming load has settled (the header
    // action enables only after it does).
    await waitFor(() => {
      expect(headerNewMeetingButton()).toBeEnabled()
    })

    expect(
      meetingsApi.listMeetingRecurrences,
    ).not.toHaveBeenCalled()
  })

  it('fetches the canonical window-free Series overview exactly once when Series is activated', async () => {
    vi.mocked(meetingsApi.listMeetingRecurrences).mockResolvedValue([
      makeSeriesOverview({ id: 301, title: 'Zebra sync' }),
    ])

    renderPage()

    fireEvent.click(screen.getByRole('tab', { name: 'Series' }))
    await screen.findByText('Zebra sync')

    // The canonical personal overview request — no occurrence
    // window parameters, no researchGroupId parameter.
    expect(
      meetingsApi.listMeetingRecurrences,
    ).toHaveBeenCalledTimes(1)
    expect(
      meetingsApi.listMeetingRecurrences,
    ).toHaveBeenCalledWith()
  })

  it('renders exactly one row per returned Series, preserving the backend ordering', async () => {
    vi.mocked(meetingsApi.listMeetingRecurrences).mockResolvedValue([
      makeSeriesOverview({ id: 303, title: 'Zebra sync' }),
      makeSeriesOverview({ id: 301, title: 'Alpha board' }),
      makeSeriesOverview({ id: 302, title: 'Mid review' }),
    ])

    renderPage()

    fireEvent.click(screen.getByRole('tab', { name: 'Series' }))
    await screen.findByText('Zebra sync')

    const section = screen.getByRole('region', {
      name: 'Meeting series',
    })
    const titles = within(section).getAllByText(
      /^(Zebra sync|Alpha board|Mid review)$/,
    )

    // One row per Series, no duplicates, in the backend's order
    // (never re-sorted client-side).
    expect(titles.map((title) => title.textContent)).toEqual([
      'Zebra sync',
      'Alpha board',
      'Mid review',
    ])
  })

  it('renders the human-readable schedule from the structured rule for daily, weekly, and monthly Series', async () => {
    vi.mocked(meetingsApi.listMeetingRecurrences).mockResolvedValue([
      makeSeriesOverview({
        id: 401,
        title: 'Daily standup',
        frequency: 'daily',
        weekdays: [],
        localTime: '09:30',
      }),
      makeSeriesOverview({
        id: 402,
        title: 'Biweekly board',
        frequency: 'weekly',
        interval: 2,
        weekdays: [1, 3],
        localTime: '10:30',
      }),
      makeSeriesOverview({
        id: 403,
        title: 'Monthly report',
        frequency: 'monthly',
        interval: 1,
        startDate: '2026-09-15',
        localTime: '14:00',
        count: 6,
      }),
    ])

    renderPage()

    fireEvent.click(screen.getByRole('tab', { name: 'Series' }))
    await screen.findByText('Daily standup')

    const section = screen.getByRole('region', {
      name: 'Meeting series',
    })

    // Rule summaries from the structured fields — no
    // display-name inference.
    expect(within(section).getByText(/Every day at/)).toBeVisible()
    expect(
      within(section).getByText(
        /Every 2 weeks on Tuesday and Thursday at/,
      ),
    ).toBeVisible()
    expect(
      within(section).getByText(/Every month on day 15 at/),
    ).toBeVisible()
    // End mode from the structured endDate / count fields.
    expect(within(section).getAllByText(/· no end$/)).toHaveLength(2)
    expect(within(section).getByText(/· 6 meetings$/)).toBeVisible()
  })

  it('renders the next effective meeting for active Series (same year and other year)', async () => {
    vi.mocked(meetingsApi.listMeetingRecurrences).mockResolvedValue([
      makeSeriesOverview({
        id: 501,
        title: 'Close sync',
        nextOccurrenceScheduledAt: localIso(2026, 9, 29, 10, 0),
      }),
      makeSeriesOverview({
        id: 502,
        title: 'Distant review',
        nextOccurrenceScheduledAt: localIso(2027, 1, 5, 9, 0),
      }),
    ])

    renderPage()

    fireEvent.click(screen.getByRole('tab', { name: 'Series' }))
    await screen.findByText('Close sync')

    // Each next label appears in exactly the two responsive slots
    // (the desktop next track + the secondary metadata that
    // carries it on mobile/tablet; CSS hides one per viewport,
    // happy-dom keeps both in the DOM).
    expect(screen.getAllByText('Tue, Sep 29 · 10:00')).toHaveLength(2)
    expect(
      screen.getAllByText('Tue, Jan 5, 2027 · 09:00'),
    ).toHaveLength(2)
  })

  it('renders an ended Series with its state and no fabricated next meeting', async () => {
    vi.mocked(meetingsApi.listMeetingRecurrences).mockResolvedValue([
      makeSeriesOverview({
        id: 503,
        title: 'Old project sync',
        status: 'ended',
        nextOccurrenceScheduledAt: null,
        count: 3,
      }),
      makeSeriesOverview({
        id: 504,
        title: 'Still running',
      }),
    ])

    renderPage()

    fireEvent.click(screen.getByRole('tab', { name: 'Series' }))
    await screen.findByText('Old project sync')

    // Derived state rendered restrained, per Series.
    expect(screen.getByText('Ended')).toBeVisible()
    expect(screen.getAllByText('Active')).toHaveLength(1)

    // No next date is fabricated for the ended Series: its row
    // carries nothing in the " · HH:MM" next-meeting shape
    // (the schedule summary ends in the end-condition phrase).
    const endedTitle = screen.getByText('Old project sync')
    const endedRow = endedTitle.parentElement!.parentElement!
    expect(
      within(endedRow).queryAllByText(/ · \d{2}:\d{2}$/),
    ).toHaveLength(0)
  })

  it('renders peopleCount from the API payload (no participant fetch)', async () => {
    vi.mocked(meetingsApi.listMeetingRecurrences).mockResolvedValue([
      makeSeriesOverview({
        id: 601,
        title: 'Solo series',
        peopleCount: 1,
      }),
      makeSeriesOverview({
        id: 602,
        title: 'Crew series',
        peopleCount: 4,
      }),
    ])

    renderPage()

    fireEvent.click(screen.getByRole('tab', { name: 'Series' }))
    await screen.findByText('Solo series')

    // One semantic string per responsive slot (the desktop People
    // track + the secondary metadata; CSS hides one per viewport).
    expect(screen.getAllByText('1 person')).toHaveLength(2)
    expect(screen.getAllByText('4 people')).toHaveLength(2)

    // The overview stays based on its canonical payload: no
    // per-Series detail, Template, or participant requests, and
    // the occurrence feed is not re-used for the Series rows.
    expect(meetingsApi.getMeetingSeries).not.toHaveBeenCalled()
    expect(meetingsApi.listMeetingSeries).not.toHaveBeenCalled()
    expect(
      meetingsApi.listMeetingParticipants,
    ).not.toHaveBeenCalled()
    expect(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).toHaveBeenCalledTimes(1)
  })

  it('keeps the header and tabs visible with a lightweight row-shaped loading state', async () => {
    let resolveSeries!: (
      value: ApiMeetingRecurrenceOverview[],
    ) => void
    vi.mocked(meetingsApi.listMeetingRecurrences).mockReturnValue(
      new Promise((resolve) => {
        resolveSeries = resolve
      }),
    )

    renderPage()

    fireEvent.click(screen.getByRole('tab', { name: 'Series' }))

    const skeleton = await screen.findByRole('region', {
      name: 'Loading meeting series',
    })
    // Three skeleton rows matching the row geometry.
    expect(
      skeleton.querySelectorAll('div.min-h-\\[68px\\]').length,
    ).toBe(3)

    // Header + tabs remain visible; no page spinner copy.
    expect(
      screen.getByRole('heading', { name: 'Meetings' }),
    ).toBeVisible()
    expect(screen.getByRole('tab', { name: 'Series' })).toBeVisible()

    resolveSeries!([
      makeSeriesOverview({ id: 701, title: 'Loaded series' }),
    ])
    await screen.findByText('Loaded series')
    expect(
      screen.queryByRole('region', {
        name: 'Loading meeting series',
      }),
    ).not.toBeInTheDocument()
  })

  it('shows the restrained empty state when the overview is empty', async () => {
    renderPage()

    fireEvent.click(screen.getByRole('tab', { name: 'Series' }))

    expect(await screen.findByText('No meeting series')).toBeVisible()
  })

  it('shows a compact Series-local error with Retry that repeats only the Series request, leaving Upcoming intact', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 101,
        title: 'Team Sync',
        scheduledAt: localIso(2026, 9, 23, 10, 0),
      }),
    ])
    vi.mocked(meetingsApi.listMeetingRecurrences)
      .mockRejectedValueOnce(
        new ApiError(500, { error: 'series down' }),
      )
      .mockRejectedValueOnce(
        new ApiError(500, { error: 'series down' }),
      )
      .mockResolvedValueOnce([
        makeSeriesOverview({ id: 801, title: 'Recovered series' }),
      ])

    renderPage()
    await screen.findByText('Team Sync')

    fireEvent.click(screen.getByRole('tab', { name: 'Series' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('series down')
    expect(
      within(alert).getByRole('button', { name: /Retry/ }),
    ).toBeVisible()

    // Upcoming remains unaffected by the Series failure…
    fireEvent.click(screen.getByRole('tab', { name: 'Upcoming' }))
    expect(screen.getByText('Team Sync')).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    // …re-activation fetches the overview again (still only the
    // Series request)…
    fireEvent.click(screen.getByRole('tab', { name: 'Series' }))
    const secondAlert = await screen.findByRole('alert')
    expect(
      meetingsApi.listMeetingRecurrences,
    ).toHaveBeenCalledTimes(2)
    expect(meetingsApi.listMeetings).toHaveBeenCalledTimes(1)

    // …and Retry repeats ONLY the Series request.
    fireEvent.click(
      within(secondAlert).getByRole('button', { name: /Retry/ }),
    )
    await screen.findByText('Recovered series')
    expect(
      meetingsApi.listMeetingRecurrences,
    ).toHaveBeenCalledTimes(3)
    expect(meetingsApi.listMeetings).toHaveBeenCalledTimes(1)
    expect(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).toHaveBeenCalledTimes(1)
  })

  it('refetches on every Series activation, picking up authoritative server state', async () => {
    let serverState: ApiMeetingRecurrenceOverview[] = [
      makeSeriesOverview({ id: 901, title: 'First series' }),
    ]
    vi.mocked(meetingsApi.listMeetingRecurrences).mockImplementation(
      () => Promise.resolve(serverState),
    )

    renderPage()

    fireEvent.click(screen.getByRole('tab', { name: 'Series' }))
    await screen.findByText('First series')
    expect(
      meetingsApi.listMeetingRecurrences,
    ).toHaveBeenCalledTimes(1)

    // The server gains a Series (created elsewhere, or by a
    // second client): the next activation must obtain the
    // authoritative state, never a fabricated local row.
    serverState = [
      ...serverState,
      makeSeriesOverview({ id: 902, title: 'Second series' }),
    ]

    fireEvent.click(screen.getByRole('tab', { name: 'Upcoming' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Series' }))

    await screen.findByText('Second series')
    expect(
      meetingsApi.listMeetingRecurrences,
    ).toHaveBeenCalledTimes(2)
  })

  it('refetches the Series overview after a Series is created while the tab is active', async () => {
    const createdRecurrence: ApiMeetingRecurrence = {
      id: 44,
      title: 'Created series',
      meetingSeriesId: 7,
      researchGroupId: 1,
      scope: 'group',
      projectId: null,
      frequency: 'weekly',
      interval: 1,
      weekdays: [3],
      startDate: '2026-09-24',
      localTime: '10:30',
      timezone: 'Europe/Berlin',
      endDate: null,
      count: null,
    }
    vi.mocked(
      meetingsApi.createMeetingRecurrence,
    ).mockResolvedValue(createdRecurrence)

    let serverState: ApiMeetingRecurrenceOverview[] = [
      makeSeriesOverview({ id: 911, title: 'Existing series' }),
    ]
    vi.mocked(meetingsApi.listMeetingRecurrences).mockImplementation(
      () => Promise.resolve(serverState),
    )

    renderPage()

    fireEvent.click(screen.getByRole('tab', { name: 'Series' }))
    await screen.findByText('Existing series')

    // Create a recurring series while the Series tab is active;
    // the server state gains the new Series.
    serverState = [
      ...serverState,
      makeSeriesOverview({
        id: createdRecurrence.id,
        title: createdRecurrence.title,
      }),
    ]

    await openCreateDialog()
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Created series' },
    })
    await selectTemplate()
    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: '2026-09-24' },
    })
    fireEvent.change(screen.getByLabelText('Time'), {
      target: { value: '10:30' },
    })
    fireEvent.change(screen.getByLabelText('Repeat'), {
      target: { value: 'weekly' },
    })

    fireEvent.submit(
      screen.getByLabelText('Title').closest('form')!,
    )

    await waitFor(() => {
      expect(
        meetingsApi.createMeetingRecurrence,
      ).toHaveBeenCalledTimes(1)
    })

    // The open Series view is refreshed from the server: the new
    // row appears alongside the existing one — no fabricated
    // local row is relied on.
    await screen.findByText('Created series')
    expect(
      meetingsApi.listMeetingRecurrences,
    ).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Existing series')).toBeVisible()
  })

  it('keeps Series rows read-only: no navigation, no actions, nothing that looks clickable', async () => {
    vi.mocked(meetingsApi.listMeetingRecurrences).mockResolvedValue([
      makeSeriesOverview({ id: 921, title: 'Zebra sync' }),
    ])

    renderPage()

    fireEvent.click(screen.getByRole('tab', { name: 'Series' }))
    await screen.findByText('Zebra sync')

    const section = screen.getByRole('region', {
      name: 'Meeting series',
    })

    // No interactive affordance inside the overview (no row
    // actions menu, no links, no tab stops on the rows)…
    expect(within(section).queryAllByRole('button')).toHaveLength(0)
    expect(within(section).queryAllByRole('link')).toHaveLength(0)
    expect(within(section).queryAllByRole('menu')).toHaveLength(0)
    expect(section.querySelectorAll('[tabindex]')).toHaveLength(0)

    // …and activation does nothing: no navigation, no detail
    // destination is fabricated.
    fireEvent.click(screen.getByText('Zebra sync'))
    expect(
      screen.queryByText(/Meeting detail:/),
    ).not.toBeInTheDocument()
    expect(screen.getByText('Zebra sync')).toBeVisible()
  })

  it('shows only the active Research Group\'s Series, preserving the backend ordering', async () => {
    // The personal overview is cross-group: the backend can return
    // rows from several Research Groups in one response.
    vi.mocked(meetingsApi.listMeetingRecurrences).mockResolvedValue([
      makeSeriesOverview({
        id: 511,
        title: 'Group one alpha',
        researchGroupId: 1,
      }),
      makeSeriesOverview({
        id: 512,
        title: 'Group two series',
        researchGroupId: 2,
      }),
      makeSeriesOverview({
        id: 513,
        title: 'Group one beta',
        researchGroupId: 1,
      }),
      makeSeriesOverview({
        id: 514,
        title: 'Group two again',
        researchGroupId: 2,
        peopleCount: 3,
      }),
      // Project scope belongs to its Research Group — kept when
      // that group is active.
      makeSeriesOverview({
        id: 515,
        title: 'Project series',
        researchGroupId: 1,
        projectId: 5,
      }),
    ])

    renderPage()

    fireEvent.click(screen.getByRole('tab', { name: 'Series' }))
    await screen.findByText('Group one alpha')

    const section = screen.getByRole('region', {
      name: 'Meeting series',
    })
    const titles = within(section).getAllByText(
      /^(Group one alpha|Group one beta|Project series|Group two series|Group two again)$/,
    )

    // Only the active group's rows, in the backend's ordering.
    expect(titles.map((title) => title.textContent)).toEqual([
      'Group one alpha',
      'Group one beta',
      'Project series',
    ])
    expect(
      screen.queryByText('Group two series'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Group two again'),
    ).not.toBeInTheDocument()

    // The scoping is a pure page-level filter: exactly one
    // overview request, no Research Group / detail / participant
    // lookups.
    expect(
      meetingsApi.listMeetingRecurrences,
    ).toHaveBeenCalledTimes(1)
    expect(meetingsApi.listMeetings).toHaveBeenCalledTimes(1)
    expect(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).toHaveBeenCalledTimes(1)
    expect(meetingsApi.getMeetingSeries).not.toHaveBeenCalled()
    expect(meetingsApi.listMeetingSeries).not.toHaveBeenCalled()
    expect(
      meetingsApi.listMeetingParticipants,
    ).not.toHaveBeenCalled()
  })

  it('scopes to the page\'s active Research Group context, not a fixed group', async () => {
    vi.mocked(useResearchGroupListScope).mockReturnValue({
      activeResearchGroupId: 2,
      activeResearchGroup: {
        id: 2,
        name: 'Other FG',
        role: 'admin',
      },
      loading: false,
      error: null,
    })
    vi.mocked(meetingsApi.listMeetingRecurrences).mockResolvedValue([
      makeSeriesOverview({
        id: 521,
        title: 'First group series',
        researchGroupId: 1,
      }),
      makeSeriesOverview({
        id: 522,
        title: 'Second group series',
        researchGroupId: 2,
      }),
    ])

    renderPage()

    fireEvent.click(screen.getByRole('tab', { name: 'Series' }))
    await screen.findByText('Second group series')

    expect(
      screen.queryByText('First group series'),
    ).not.toBeInTheDocument()
    // The concrete Meeting list follows the same page scope.
    expect(meetingsApi.listMeetings).toHaveBeenCalledWith(2)
  })

  it('applies the Meetings page research-group context: no Series request without an active group', async () => {
    vi.mocked(useResearchGroupListScope).mockReturnValue({
      activeResearchGroupId: null,
      activeResearchGroup: null,
      loading: false,
      error: null,
    })

    renderPage()

    // The page-level context gate (the same convention as
    // Upcoming) also applies to the personal Series overview.
    expect(
      await screen.findByText(
        'No research group is currently available.',
      ),
    ).toBeVisible()

    fireEvent.click(screen.getByRole('tab', { name: 'Series' }))
    expect(
      screen.getByText('No research group is currently available.'),
    ).toBeVisible()
    expect(
      meetingsApi.listMeetingRecurrences,
    ).not.toHaveBeenCalled()
  })
})

describe('MeetingListPage create dialog (unchanged behavior)', () => {
  it('routes a recurring submission to createMeetingRecurrence — never to Meeting creation', async () => {
    const recurrence: ApiMeetingRecurrence = {
      id: 42,
      title: 'Weekly Sync',
      meetingSeriesId: 7,
      researchGroupId: 1,
      scope: 'group',
      projectId: null,
      frequency: 'weekly',
      interval: 1,
      weekdays: [1],
      startDate: '2026-09-24',
      localTime: '10:30',
      timezone: 'Europe/Berlin',
      endDate: null,
      count: null,
    }
    vi.mocked(
      meetingsApi.createMeetingRecurrence,
    ).mockResolvedValue(recurrence)

    const { container } = renderPage()
    await openCreateDialog()

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Weekly Sync' },
    })
    await selectTemplate()
    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: '2026-09-24' },
    })
    fireEvent.change(screen.getByLabelText('Time'), {
      target: { value: '10:30' },
    })
    fireEvent.change(screen.getByLabelText('Repeat'), {
      target: { value: 'weekly' },
    })

    fireEvent.submit(
      screen.getByLabelText('Title').closest('form')!,
    )

    await waitFor(() => {
      expect(
        meetingsApi.createMeetingRecurrence,
      ).toHaveBeenCalledTimes(1)
    })
    expect(
      meetingsApi.createMeetingRecurrence,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingSeriesId: 7,
        title: 'Weekly Sync',
        frequency: 'weekly',
        interval: 1,
        weekdays: [3],
        startDate: '2026-09-24',
        localTime: '10:30',
        endDate: null,
        count: null,
      }),
    )
    expect(meetingsApi.createMeeting).not.toHaveBeenCalled()
    expect(
      meetingsApi.createMeetingFromSeries,
    ).not.toHaveBeenCalled()

    // The dialog closes and the SERIES success toast shows —
    // non-modal, outside the list flow — with the feed refetched
    // so the series' occurrences join Upcoming.
    expect(
      screen.queryByRole('dialog'),
    ).not.toBeInTheDocument()
    const toast = screen.getByRole('status')
    expect(toast).toHaveTextContent('Series created')
    expect(toast).toHaveTextContent(
      'Upcoming occurrences are now available.',
    )
    // The toast carries no action button…
    expect(
      within(toast).queryAllByRole('button'),
    ).toHaveLength(0)
    // …and it sits at the page root — outside the tab panel and
    // therefore outside the Upcoming list flow (it cannot shift
    // the agenda).
    expect(toast.parentElement).toBe(
      container.firstElementChild,
    )
    await waitFor(() => {
      expect(
        meetingsApi
          .listPersonalMeetingRecurrenceOccurrences,
      ).toHaveBeenCalledTimes(2)
    })
    expect(
      screen.queryByRole('button', { name: /Weekly Sync/ }),
    ).not.toBeInTheDocument()
  })

  it('shows the series-success toast transiently: it auto-dismisses and the old persistent inline banner is gone', async () => {
    const recurrence: ApiMeetingRecurrence = {
      id: 43,
      title: 'Weekly Sync',
      meetingSeriesId: 7,
      researchGroupId: 1,
      scope: 'group',
      projectId: null,
      frequency: 'weekly',
      interval: 1,
      weekdays: [1],
      startDate: '2026-09-24',
      localTime: '10:30',
      timezone: 'Europe/Berlin',
      endDate: null,
      count: null,
    }
    vi.mocked(
      meetingsApi.createMeetingRecurrence,
    ).mockResolvedValue(recurrence)

    const { container } = renderPage()
    await openCreateDialog()

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Weekly Sync' },
    })
    await selectTemplate()
    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: '2026-09-24' },
    })
    fireEvent.change(screen.getByLabelText('Time'), {
      target: { value: '10:30' },
    })
    fireEvent.change(screen.getByLabelText('Repeat'), {
      target: { value: 'weekly' },
    })

    fireEvent.submit(
      screen.getByLabelText('Title').closest('form')!,
    )

    const toast = await screen.findByRole('status')
    expect(toast).toHaveTextContent('Series created')
    expect(toast).toHaveTextContent(
      'Upcoming occurrences are now available.',
    )

    // The OLD persistent inline banner is absent: no old copy,
    // no inline Dismiss action.
    expect(
      screen.queryByText(
        /Recurring series “.*” created\./,
      ),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(
        'Its occurrences now appear in Upcoming.',
      ),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Dismiss' }),
    ).not.toBeInTheDocument()

    // The toast lives at the page root — outside the tab panel
    // (and thus outside the Upcoming list flow; fixed + non-modal).
    expect(toast.parentElement).toBe(
      container.firstElementChild,
    )

    // It auto-dismisses after ~4.5 s and then stays gone — it
    // never lives permanently in the list flow.
    vi.advanceTimersByTime(4500)
    await waitFor(() => {
      expect(
        screen.queryByRole('status'),
      ).not.toBeInTheDocument()
    })
  })

  it('keeps the dialog open with the error visible when recurrence creation fails', async () => {
    vi.mocked(
      meetingsApi.createMeetingRecurrence,
    ).mockRejectedValue(
      new ApiError(400, {
        error: 'A weekly recurrence requires one or more weekdays.',
      }),
    )

    renderPage()
    await openCreateDialog()

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Weekly Sync' },
    })
    await selectTemplate()
    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: '2026-09-24' },
    })
    fireEvent.change(screen.getByLabelText('Time'), {
      target: { value: '10:30' },
    })
    fireEvent.change(screen.getByLabelText('Repeat'), {
      target: { value: 'weekly' },
    })
    // Configure a value the failure must preserve.
    fireEvent.change(screen.getByLabelText('Every'), {
      target: { value: '2' },
    })

    fireEvent.submit(
      screen.getByLabelText('Title').closest('form')!,
    )

    await waitFor(() => {
      expect(
        screen.getByRole('alert'),
      ).toHaveTextContent(
        'A weekly recurrence requires one or more weekdays.',
      )
    })
    // Dialog still open, recurrence fields preserved, no Meeting created.
    expect(screen.getByRole('dialog')).toBeVisible()
    expect(screen.getByLabelText('Every')).toHaveValue('2')
    expect(meetingsApi.createMeeting).not.toHaveBeenCalled()
    expect(
      meetingsApi.createMeetingFromSeries,
    ).not.toHaveBeenCalled()
  })

  it('never calls createMeetingRecurrence for an ordinary one-time creation', async () => {
    renderPage()
    await openCreateDialog()

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'One-time meeting' },
    })
    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: '2026-09-24' },
    })
    fireEvent.change(screen.getByLabelText('Time'), {
      target: { value: '10:30' },
    })

    fireEvent.submit(
      screen.getByLabelText('Title').closest('form')!,
    )

    await waitFor(() => {
      expect(meetingsApi.createMeeting).toHaveBeenCalledTimes(1)
    })
    expect(
      meetingsApi.createMeetingRecurrence,
    ).not.toHaveBeenCalled()
    // One-time success path unchanged: dialog closes, no series banner.
    expect(
      screen.queryByRole('dialog'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('status'),
    ).not.toBeInTheDocument()
  })
})
