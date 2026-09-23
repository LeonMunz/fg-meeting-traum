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
  ApiMeetingSeries,
} from '../../api/types'

vi.mock('../../api/meetings', async (importOriginal) => {
  const actual = await importOriginal<typeof meetingsApi>()
  return {
    ...actual,
    listMeetings: vi.fn(),
    listPersonalMeetingRecurrenceOccurrences: vi.fn(),
    createMeeting: vi.fn(),
    createMeetingFromSeries: vi.fn(),
    createMeetingRecurrence: vi.fn(),
    listMeetingSeries: vi.fn(),
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

  it('renders clearly intentional placeholders for the unimplemented Series and Past tabs without fetching their data', async () => {
    renderPage()

    fireEvent.click(
      screen.getByRole('tab', { name: 'Series' }),
    )
    expect(
      screen.getByText('Series overview is coming soon'),
    ).toBeVisible()

    fireEvent.click(screen.getByRole('tab', { name: 'Past' }))
    expect(
      screen.getByText('Past view is coming soon'),
    ).toBeVisible()

    // No Series/Past data implementation leaked in.
    expect(
      meetingsApi.listMeetingSeries,
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

    await screen.findByRole('heading', { name: 'Today' })

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
    await screen.findByRole('heading', { name: 'Today' })

    const text = container.textContent ?? ''

    expect(text).not.toMatch(/virtual/i)
    expect(text).not.toMatch(/materialized/i)
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
    await screen.findByRole('heading', { name: 'Today' })

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
    await screen.findByRole('heading', { name: 'Today' })

    const headings = [
      ...container.querySelectorAll('h3'),
    ].map((h) => h.textContent)

    expect(headings).toEqual([
      'Today',
      'Tomorrow',
      'Fri, Sep 25',
    ])
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
    await screen.findByRole('heading', { name: 'Today' })

    const tomorrowGroup = within(
      screen
        .getByRole('heading', { name: 'Tomorrow' })
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
    await screen.findByRole('heading', { name: 'Today' })

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
    await screen.findByRole('heading', { name: 'Today' })

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
    await screen.findByRole('heading', { name: 'Today' })

    const todayGroup = within(
      screen
        .getByRole('heading', { name: 'Today' })
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
    await screen.findByRole('heading', { name: 'Today' })

    const row = screen
      .getByRole('button', {
        name: 'Plain upcoming · 10:00',
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
    await screen.findByRole('heading', { name: 'Today' })

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
    await screen.findByRole('heading', { name: 'Today' })

    const todayGroup = within(
      screen
        .getByRole('heading', { name: 'Today' })
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
    await screen.findByRole('heading', { name: 'Today' })

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
      name: 'Team Sync · 10:00',
    })
    expect(row.children).toHaveLength(4)
    const meetingBlock = row.children[1] as HTMLElement
    expect(
      within(meetingBlock).queryByRole('button'),
    ).toBeNull()
    const actionsRegion = row.children[3] as HTMLElement
    expect(actionsRegion).toContainElement(kebab)
  })

  it('shows participant data only when truthfully available (never for virtual occurrences)', async () => {
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
    await screen.findByRole('heading', { name: 'Today' })

    // The concrete row carries its people count in exactly the two
    // responsive slots; the virtual row carries none.
    expect(
      screen.getAllByText('2 people'),
    ).toHaveLength(2)

    // The virtual row has no actions affordance and no people count.
    const virtualRow = screen
      .getByText('Occurrence row check')
      .parentElement! // Meeting content block
      .parentElement! // the row grid

    // The virtual row keeps the four-region track (empty Actions
    // region included)…
    expect(virtualRow.children).toHaveLength(4)
    expect(
      within(virtualRow).queryByRole('button'),
    ).not.toBeInTheDocument()
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
    await screen.findByRole('heading', { name: 'Today' })

    const row = screen
      .getByRole('button', {
        name: 'Team Sync · 10:00',
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
      name: 'Today',
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
      name: 'Today',
    })

    const row = screen.getByRole('button', {
      name: 'Team Sync · 10:00',
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
      name: 'Today',
    })

    const row = screen.getByRole('button', {
      name: `${longTitle} · 17:30`,
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

  it('preserves the Actions track for a virtual occurrence without creating an unsupported action', async () => {
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue([
      makeOccurrence({
        occurrenceId: 'occ-track',
        title: 'Track check',
      }),
    ])

    renderPage()
    await screen.findByText('Track check')

    const row = screen
      .getByText('Track check')
      .parentElement! // Meeting content block
      .parentElement! // the row grid

    // The row keeps its four-region track (the Meeting column is
    // NOT pulled into the Actions region)…
    expect(row.children).toHaveLength(4)
    // …and the Actions region exists but stays EMPTY: no
    // unsupported action is offered for a virtual occurrence.
    const actionsRegion =
      row.children[3] as HTMLElement
    expect(actionsRegion.children).toHaveLength(0)
    expect(
      within(actionsRegion).queryByRole('button'),
    ).not.toBeInTheDocument()
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
    await screen.findByRole('heading', { name: 'Today' })

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
    await screen.findByRole('heading', { name: 'Today' })

    const row = screen.getByRole('button', {
      name: 'Plain upcoming · 10:00',
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
      name: 'Team Sync · 10:00',
    })

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Team Sync · 10:00',
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

  it('does not navigate or trigger any write for a virtual occurrence row', async () => {
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

    // Visually normal, but not an interactive control.
    expect(row).not.toHaveAttribute('role')

    fireEvent.click(row)

    // No navigation…
    expect(
      screen.queryByText(/Meeting detail:/),
    ).not.toBeInTheDocument()
    // …and no accidental materialization or Meeting creation.
    expect(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).toHaveBeenCalledTimes(1)
    expect(meetingsApi.createMeeting).not.toHaveBeenCalled()
    expect(
      meetingsApi.createMeetingFromSeries,
    ).not.toHaveBeenCalled()
    expect(
      meetingsApi.createMeetingRecurrence,
    ).not.toHaveBeenCalled()
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
    await screen.findByRole('heading', { name: 'Today' })

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

    // The dialog closes and the SERIES success signal shows — with
    // the feed refetched so the series' occurrences join Upcoming.
    expect(
      screen.queryByRole('dialog'),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Recurring series “Weekly Sync” created.',
    )
    expect(
      screen.getByRole('status'),
    ).toHaveTextContent(
      'Its occurrences now appear in Upcoming.',
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
