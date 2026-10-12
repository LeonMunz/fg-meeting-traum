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
  useLocation,
  useNavigate,
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
    excludeMeetingRecurrenceOccurrence: vi.fn(),
    createMeeting: vi.fn(),
    createMeetingFromSeries: vi.fn(),
    createMeetingRecurrence: vi.fn(),
    listMeetingSeries: vi.fn(),
    getMeetingSeries: vi.fn(),
    listMeetingParticipants: vi.fn(),
    updateMeeting: vi.fn(),
    deleteMeeting: vi.fn(),
    deleteMeetingSeries: vi.fn(),
    cancelMeetingRecurrenceOccurrence: vi.fn(),
    terminateMeetingRecurrence: vi.fn(),
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
    actionPermissions: { canEdit: true, canDelete: true, canCancel: false },
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
    // Fail-closed default: the fixture grant is explicit.
    canExclude: false,
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
    // Fail-closed default: the termination grant is explicit per
    // fixture (the server's canTerminate report is authoritative).
    canTerminate: false,
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
  actionPermissions: { canEdit: true, canDelete: true, canCancel: false },
  createdById: 1,
  createdAt: '2026-09-10T08:00:00Z',
  updatedAt: '2026-09-10T08:00:00Z',
}

function DetailMarker() {
  const { meetingId } = useParams<{ meetingId: string }>()
  const location = useLocation()
  return (
    <div>
      <span>Meeting detail: {meetingId}</span>
      <span data-testid="detail-search">{location.search}</span>
    </div>
  )
}

/**
 * Renders the current router location (pathname + search) in a
 * sibling probe so URL-contract tests can assert the
 * authoritative address — and drive browser history — without
 * touching window.history.
 */
function UrlProbe() {
  const location = useLocation()

  return (
    <div data-testid="url-probe">
      {location.pathname}
      {location.search}
    </div>
  )
}

function HistoryProbe() {
  const navigate = useNavigate()

  return (
    <div>
      <button
        type="button"
        data-testid="history-back"
        onClick={() => navigate(-1)}
      >
        probe-back
      </button>
      <button
        type="button"
        data-testid="history-forward"
        onClick={() => navigate(1)}
      >
        probe-forward
      </button>
    </div>
  )
}

function probeUrl(): URL {
  const probe = document.querySelector(
    '[data-testid="url-probe"]',
  )

  return new URL(
    probe?.textContent ?? '',
    'http://localhost',
  )
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
 * The same harness as `renderPage` at an explicit initial entry,
 * with the location / history probes for URL-contract tests.
 */
function renderPageAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <UrlProbe />
      <HistoryProbe />
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
  vi.mocked(
    meetingsApi.excludeMeetingRecurrenceOccurrence,
  ).mockResolvedValue(undefined)
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
  vi.mocked(meetingsApi.deleteMeeting).mockResolvedValue(
    undefined,
  )
  vi.mocked(
    meetingsApi.cancelMeetingRecurrenceOccurrence,
  ).mockResolvedValue(createdMeeting)
  vi.mocked(
    meetingsApi.terminateMeetingRecurrence,
  ).mockResolvedValue(undefined)
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

  it('renders the complete page inside one shared constrained workspace frame', async () => {
    const { container } = renderPage()

    const frames = container.querySelectorAll(
      '[data-fg-workspace-content="constrained"]',
    )
    expect(frames).toHaveLength(1)

    const frame = frames[0] as HTMLElement

    // Heading, tabs and the Upcoming content (here the empty
    // state) all share the same frame.
    const heading = await screen.findByRole(
      'heading',
      { name: 'Meetings' },
    )
    expect(frame.contains(heading)).toBe(true)
    expect(
      frame.contains(
        screen.getByRole('tablist', {
          name: 'Meetings',
        }),
      ),
    ).toBe(true)
    expect(
      frame.contains(
        await screen.findByText('No upcoming meetings'),
      ),
    ).toBe(true)
  })

  it('keeps the meeting rows inside the same constrained frame', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue(
      richFixtures().meetings,
    )
    const { container } = renderPage()

    const frame = container.querySelector(
      '[data-fg-workspace-content="constrained"]',
    ) as HTMLElement
    expect(frame).not.toBeNull()

    const row = await screen.findByRole('button', {
      name: /^Open Team Sync /,
    })
    expect(frame.contains(row)).toBe(true)
  })
})

describe('MeetingListPage — Past tab', () => {
  /**
   * Unambiguous Past group label expectation: weekday + short
   * month + day + explicit year, computed from the same LOCAL
   * date parts as the fixtures (so the assertion holds in every
   * time zone, like the rest of this suite).
   */
  function expectedPastLabel(
    year: number,
    month: number,
    day: number,
  ): string {
    return new Intl.DateTimeFormat(
      'en',
      {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      },
    ).format(new Date(year, month - 1, day))
  }

  function openPastTab() {
    fireEvent.click(
      screen.getByRole('tab', { name: 'Past' }),
    )
  }

  it('lists completed one-time and materialized recurring Meetings exactly once, most recent first', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 1,
        title: 'Old completed sync',
        scheduledAt: localIso(2025, 11, 14, 10, 0),
        status: 'completed',
      }),
      makeMeeting({
        id: 2,
        title: 'Morning completed sync',
        scheduledAt: localIso(2026, 9, 20, 9, 0),
        status: 'completed',
        participantIds: [1, 2],
      }),
      // Completed MATERIALIZED recurring occurrence: it appears
      // in the feed too — Past must ignore the feed and render
      // the concrete Meeting exactly once.
      makeMeeting({
        id: 3,
        title: 'Afternoon completed sync',
        scheduledAt: localIso(2026, 9, 20, 16, 0),
        status: 'completed',
      }),
      makeMeeting({
        id: 4,
        title: 'Still upcoming',
        scheduledAt: localIso(2026, 9, 25, 10, 0),
      }),
    ])
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue([
      makeOccurrence({
        occurrenceId: 'occ-p1',
        title: 'Afternoon completed sync',
        originalScheduledAt: localIso(2026, 9, 20, 16, 0),
        scheduledAt: localIso(2026, 9, 20, 16, 0),
        materialized: true,
        meetingId: 3,
      }),
    ])

    renderPage()
    openPastTab()

    const section = await screen.findByRole(
      'region',
      { name: 'Completed meetings' },
    )

    // Each completed Meeting appears exactly once (the
    // materialized recurring one never duplicates through the
    // feed), and the non-completed one is absent.
    expect(
      screen.getAllByText('Afternoon completed sync'),
    ).toHaveLength(1)
    expect(
      screen.getAllByText('Morning completed sync'),
    ).toHaveLength(1)
    expect(
      screen.getAllByText('Old completed sync'),
    ).toHaveLength(1)
    expect(
      screen.queryByText('Still upcoming'),
    ).not.toBeInTheDocument()

    // Groups: local calendar date descending, labels carry the
    // explicit year (Past spans arbitrary history).
    expect(
      within(section)
        .getAllByRole('heading')
        .map((heading) => heading.textContent),
    ).toEqual([
      expectedPastLabel(2026, 9, 20),
      expectedPastLabel(2025, 11, 14),
    ])

    // Rows: scheduledAt descending, the participant count
    // rendered where available.
    const rows = within(section).getAllByRole('button')
    expect(rows).toHaveLength(3)
    expect(rows[0].getAttribute('aria-label')).toBe(
      `Open Afternoon completed sync on ${expectedPastLabel(2026, 9, 20)} at 16:00`,
    )
    expect(rows[1].getAttribute('aria-label')).toBe(
      `Open Morning completed sync on ${expectedPastLabel(2026, 9, 20)} at 09:00`,
    )
    expect(rows[2].getAttribute('aria-label')).toBe(
      `Open Old completed sync on ${expectedPastLabel(2025, 11, 14)} at 10:00`,
    )
    // The people count appears in exactly the two responsive
    // copies (secondary metadata + the desktop People track) —
    // the same convention as the Upcoming rows — and is never
    // fabricated on rows without participants.
    expect(
      within(rows[1]).getAllByText('2 people'),
    ).toHaveLength(2)
    expect(
      within(rows[0]).queryAllByText(/person/),
    ).toHaveLength(0)
  })

  it('renders a single participant as "1 person" (never "1 people")', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 1,
        title: 'Solo completed sync',
        scheduledAt: localIso(2026, 9, 20, 11, 0),
        status: 'completed',
        participantIds: [1],
      }),
    ])

    renderPage()
    openPastTab()

    const section = await screen.findByRole(
      'region',
      { name: 'Completed meetings' },
    )
    const row = within(section).getByRole('button', {
      name: `Open Solo completed sync on ${expectedPastLabel(2026, 9, 20)} at 11:00`,
    })
    // Both responsive copies (the secondary metadata line and
    // the desktop People track) use the shared `peopleLabel`
    // grammar — singular for one participant, exactly like the
    // Upcoming rows.
    expect(
      within(row).getAllByText('1 person'),
    ).toHaveLength(2)
    expect(
      within(row).queryByText('1 people'),
    ).not.toBeInTheDocument()
  })

  it('deterministically tie-breaks identical scheduled times by Meeting id', async () => {
    const instant = localIso(2026, 9, 18, 10, 0)
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 9,
        title: 'Tie higher id',
        scheduledAt: instant,
        status: 'completed',
      }),
      makeMeeting({
        id: 4,
        title: 'Tie lower id',
        scheduledAt: instant,
        status: 'completed',
      }),
    ])

    renderPage()
    openPastTab()

    const section = await screen.findByRole(
      'region',
      { name: 'Completed meetings' },
    )
    const rows = within(section).getAllByRole('button')
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
      expect.stringContaining('Tie lower id'),
      expect.stringContaining('Tie higher id'),
    ])
  })

  it('excludes upcoming, live, and cancelled Meetings even when their scheduled date has passed', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 1,
        title: 'Yesterday upcoming',
        scheduledAt: localIso(2026, 9, 22, 10, 0),
        status: 'upcoming',
      }),
      makeMeeting({
        id: 2,
        title: 'Yesterday live',
        scheduledAt: localIso(2026, 9, 22, 9, 0),
        status: 'live',
      }),
      makeMeeting({
        id: 3,
        title: 'Yesterday cancelled',
        scheduledAt: localIso(2026, 9, 22, 8, 0),
        status: 'cancelled',
      }),
      makeMeeting({
        id: 4,
        title: 'Yesterday completed',
        scheduledAt: localIso(2026, 9, 22, 7, 0),
        status: 'completed',
      }),
    ])

    renderPage()
    openPastTab()

    await screen.findByText('Yesterday completed')
    expect(
      screen.queryByText('Yesterday upcoming'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Yesterday live'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Yesterday cancelled'),
    ).not.toBeInTheDocument()
  })

  it('keeps completed Meetings outside the 42-day Upcoming window visible', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 1,
        title: 'Archive keeper',
        scheduledAt: localIso(2025, 1, 10, 9, 0),
        status: 'completed',
      }),
    ])

    renderPage()
    openPastTab()

    const section = await screen.findByRole(
      'region',
      { name: 'Completed meetings' },
    )
    expect(screen.getByText('Archive keeper')).toBeVisible()
    expect(
      within(section).getByRole('heading').textContent,
    ).toBe(expectedPastLabel(2025, 1, 10))
  })

  it('opens the existing Meeting detail by canonical id on pointer activation, without any write', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 42,
        title: 'Openable completed',
        scheduledAt: localIso(2026, 9, 19, 11, 0),
        status: 'completed',
      }),
    ])

    renderPage()
    openPastTab()

    const row = await screen.findByRole('button', {
      name: /^Open Openable completed /,
    })
    fireEvent.click(row)

    await screen.findByText('Meeting detail: 42')

    // Opening a Past row is a pure navigation: no mutation of
    // any kind, no materialization of anything.
    expect(meetingsApi.deleteMeeting).not.toHaveBeenCalled()
    expect(meetingsApi.updateMeeting).not.toHaveBeenCalled()
    expect(
      meetingsApi.cancelMeetingRecurrenceOccurrence,
    ).not.toHaveBeenCalled()
    expect(
      meetingsApi.materializeMeetingRecurrenceOccurrence,
    ).not.toHaveBeenCalled()
    expect(
      meetingsApi.excludeMeetingRecurrenceOccurrence,
    ).not.toHaveBeenCalled()
  })

  it('activates a Past row with Enter and Space', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 7,
        title: 'Keyboard completed',
        scheduledAt: localIso(2026, 9, 19, 12, 0),
        status: 'completed',
      }),
    ])

    renderPage()
    openPastTab()
    const enterRow = await screen.findByRole('button', {
      name: /^Open Keyboard completed /,
    })
    enterRow.focus()
    fireEvent.keyDown(enterRow, { key: 'Enter' })

    await screen.findByText('Meeting detail: 7')

    // Space on a fresh render of the same row.
    cleanup()
    renderPage()
    openPastTab()
    const spaceRow = await screen.findByRole('button', {
      name: /^Open Keyboard completed /,
    })
    spaceRow.focus()
    fireEvent.keyDown(spaceRow, { key: ' ' })

    await screen.findByText('Meeting detail: 7')
  })

  it('never exposes Upcoming row actions on Past rows', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 1,
        title: 'Fully actionable completed',
        scheduledAt: localIso(2026, 9, 19, 13, 0),
        status: 'completed',
        actionPermissions: {
          canEdit: true,
          canDelete: true,
          canCancel: true,
        },
      }),
    ])

    renderPage()
    openPastTab()

    const section = await screen.findByRole(
      'region',
      { name: 'Completed meetings' },
    )
    // The row itself is the only button in the archive: every
    // interactive element is an open affordance — no Edit /
    // Delete / Cancel actions, no menus.
    const buttons = within(section).getAllByRole('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].getAttribute('aria-label')).toMatch(
      /^Open Fully actionable completed /,
    )
  })

  it('introduces no additional requests when Past is activated', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 1,
        title: 'Completed for counts',
        scheduledAt: localIso(2026, 9, 19, 14, 0),
        status: 'completed',
      }),
      makeMeeting({
        id: 2,
        title: 'Upcoming for counts',
        scheduledAt: localIso(2026, 9, 25, 10, 0),
      }),
    ])

    renderPage()
    // Wait until the page's canonical load (Meetings list +
    // occurrence feed) has settled on the Upcoming tab.
    await waitFor(() => {
      expect(headerNewMeetingButton()).toBeEnabled()
    })

    openPastTab()
    await screen.findByText('Completed for counts')

    // Exactly the page's existing load behavior — no Past fetch,
    // no recurrence/overview request of any kind.
    expect(meetingsApi.listMeetings).toHaveBeenCalledTimes(1)
    expect(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).toHaveBeenCalledTimes(1)
    expect(meetingsApi.listMeetingRecurrences).not.toHaveBeenCalled()
    expect(meetingsApi.listMeetingSeries).not.toHaveBeenCalled()
    expect(meetingsApi.getMeetingSeries).not.toHaveBeenCalled()
  })

  it('shows the honest empty state when no Meeting is completed', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 1,
        title: 'Only upcoming here',
        scheduledAt: localIso(2026, 9, 25, 10, 0),
      }),
    ])

    renderPage()
    openPastTab()

    const empty = await screen.findByRole(
      'heading',
      { name: 'No completed meetings yet' },
    )
    expect(empty).toBeVisible()

    // The empty archive must not claim a load failure.
    expect(
      screen.queryByText(/couldn't be loaded/i),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('alert'),
    ).not.toBeInTheDocument()
  })

  it('shows row skeletons while the canonical Meetings list is still loading', async () => {
    let resolveMeetings!: (value: ApiMeeting[]) => void
    vi.mocked(meetingsApi.listMeetings).mockReturnValue(
      new Promise((resolve) => {
        resolveMeetings = resolve
      }),
    )

    renderPage()
    openPastTab()

    expect(
      screen.getByRole('region', {
        name: 'Loading completed meetings',
      }),
    ).toBeVisible()

    resolveMeetings([
      makeMeeting({
        id: 1,
        title: 'Settled completed',
        scheduledAt: localIso(2026, 9, 19, 15, 0),
        status: 'completed',
      }),
    ])

    await screen.findByText('Settled completed')
  })

  it('shows an actionable error with Retry that repeats only the Meetings request', async () => {
    vi.mocked(meetingsApi.listMeetings)
      .mockRejectedValueOnce(
        new ApiError(500, { error: 'past list down' }),
      )
      .mockResolvedValueOnce([
        makeMeeting({
          id: 1,
          title: 'Recovered completed',
          scheduledAt: localIso(2026, 9, 19, 16, 0),
          status: 'completed',
        }),
      ])

    renderPage()
    openPastTab()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('past list down')
    expect(
      within(alert).queryByText('No completed meetings yet'),
    ).not.toBeInTheDocument()

    fireEvent.click(
      within(alert).getByRole('button', {
        name: /Try again/,
      }),
    )

    await screen.findByText('Recovered completed')
    expect(meetingsApi.listMeetings).toHaveBeenCalledTimes(2)
    // The Retry never drags in the recurrence feed or the Series
    // overview.
    expect(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).toHaveBeenCalledTimes(1)
    expect(
      meetingsApi.listMeetingRecurrences,
    ).not.toHaveBeenCalled()
  })

  it("shows only the active Research Group's completed Meetings", async () => {
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
        id: 1,
        title: 'Group two completed',
        researchGroupId: 2,
        scheduledAt: localIso(2026, 9, 19, 17, 0),
        status: 'completed',
      }),
    ])

    renderPage()
    openPastTab()

    await screen.findByText('Group two completed')
    expect(
      meetingsApi.listMeetings,
    ).toHaveBeenCalledWith(2)
  })
})

describe('MeetingListPage — URL-addressable tabs', () => {
  function settled() {
    return waitFor(() => {
      expect(headerNewMeetingButton()).toBeEnabled()
    })
  }

  it('selects Past from a direct /meetings?tab=past link and renders completed Meetings', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 1,
        title: 'Done in the past',
        scheduledAt: localIso(2026, 9, 19, 10, 0),
        status: 'completed',
      }),
      makeMeeting({
        id: 2,
        title: 'Still upcoming',
        scheduledAt: localIso(2026, 9, 25, 10, 0),
      }),
    ])

    renderPageAt('/meetings?tab=past')

    // The Past tab is selected from the URL on first paint —
    // the archive renders without an Upcoming flash and the
    // Upcoming-only Meeting is absent.
    const section = await screen.findByRole(
      'region',
      { name: 'Completed meetings' },
    )
    expect(within(section).getByText('Done in the past')).toBeVisible()
    expect(
      screen.queryByText('Still upcoming'),
    ).not.toBeInTheDocument()

    expect(
      screen.getByRole('tab', { name: 'Past' }),
    ).toHaveAttribute('aria-selected', 'true')
    expect(
      screen.getByRole('tab', { name: 'Upcoming' }),
    ).toHaveAttribute('aria-selected', 'false')

    // The URL still carries the tab — the page never rewrites
    // a valid direct link.
    expect(probeUrl().searchParams.get('tab')).toBe('past')
    // Past is a pure projection: no Series / feed request.
    expect(
      meetingsApi.listMeetingRecurrences,
    ).not.toHaveBeenCalled()
  })

  it('selects Series from a direct /meetings?tab=series link and triggers the existing Series load', async () => {
    vi.mocked(meetingsApi.listMeetingRecurrences).mockResolvedValue([
      makeSeriesOverview({
        id: 311,
        title: 'Direct link series',
      }),
    ])

    renderPageAt('/meetings?tab=series')

    expect(
      screen.getByRole('tab', { name: 'Series' }),
    ).toHaveAttribute('aria-selected', 'true')
    await screen.findByText('Direct link series')

    // The direct link triggers exactly the existing lazy
    // window-free Series load — one request.
    expect(
      meetingsApi.listMeetingRecurrences,
    ).toHaveBeenCalledTimes(1)
    expect(probeUrl().searchParams.get('tab')).toBe('series')
  })

  it('selects Upcoming for a missing tab parameter', async () => {
    renderPageAt('/meetings')
    await settled()

    expect(
      screen.getByRole('tab', { name: 'Upcoming' }),
    ).toHaveAttribute('aria-selected', 'true')
    expect(probeUrl().searchParams.get('tab')).toBeNull()
  })

  it('selects Upcoming for an explicit /meetings?tab=upcoming link', async () => {
    renderPageAt('/meetings?tab=upcoming')
    await settled()

    expect(
      screen.getByRole('tab', { name: 'Upcoming' }),
    ).toHaveAttribute('aria-selected', 'true')
    // The explicit valid link is preserved (no rewrite).
    expect(probeUrl().searchParams.get('tab')).toBe('upcoming')
  })

  it('falls back to Upcoming for an unknown tab value without rewriting the URL', async () => {
    renderPageAt('/meetings?tab=unknown')
    await settled()

    expect(
      screen.getByRole('tab', { name: 'Upcoming' }),
    ).toHaveAttribute('aria-selected', 'true')

    // The invalid value renders the Upcoming fallback but is
    // NOT automatically redirected away from.
    const url = probeUrl()
    expect(url.pathname).toBe('/meetings')
    expect(url.searchParams.get('tab')).toBe('unknown')
  })

  it('updates the URL on pointer tab selection', async () => {
    renderPageAt('/meetings')
    await settled()

    fireEvent.click(screen.getByRole('tab', { name: 'Past' }))
    await waitFor(() => {
      expect(probeUrl().searchParams.get('tab')).toBe('past')
    })

    fireEvent.click(screen.getByRole('tab', { name: 'Series' }))
    await waitFor(() => {
      expect(probeUrl().searchParams.get('tab')).toBe('series')
    })

    // Selecting Upcoming drops the query (bare /meetings).
    fireEvent.click(screen.getByRole('tab', { name: 'Upcoming' }))
    await waitFor(() => {
      expect(probeUrl().searchParams.get('tab')).toBeNull()
    })
    expect(probeUrl().pathname).toBe('/meetings')
  })

  it('updates the URL on ArrowRight / ArrowLeft tab changes and keeps focus on the selected tab', async () => {
    renderPageAt('/meetings')
    await settled()

    const upcomingTab = screen.getByRole('tab', {
      name: 'Upcoming',
    }) as HTMLElement
    upcomingTab.focus()
    fireEvent.keyDown(upcomingTab, { key: 'ArrowRight' })

    await waitFor(() => {
      expect(probeUrl().searchParams.get('tab')).toBe('series')
    })
    expect(
      screen.getByRole('tab', { name: 'Series' }),
    ).toHaveFocus()

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Series' }), {
      key: 'ArrowRight',
    })
    await waitFor(() => {
      expect(probeUrl().searchParams.get('tab')).toBe('past')
    })
    expect(
      screen.getByRole('tab', { name: 'Past' }),
    ).toHaveFocus()

    // ArrowLeft wraps from the first tab to the last.
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Upcoming' }), {
      key: 'ArrowLeft',
    })
    await waitFor(() => {
      expect(probeUrl().searchParams.get('tab')).toBe('past')
    })
    expect(
      screen.getByRole('tab', { name: 'Past' }),
    ).toHaveFocus()
  })

  it('restores the previously selected tabs through Browser Back/Forward', async () => {
    renderPageAt('/meetings')
    await settled()

    fireEvent.click(screen.getByRole('tab', { name: 'Past' }))
    await waitFor(() => {
      expect(probeUrl().searchParams.get('tab')).toBe('past')
    })
    expect(
      screen.getByRole('tab', { name: 'Past' }),
    ).toHaveAttribute('aria-selected', 'true')

    fireEvent.click(screen.getByRole('tab', { name: 'Series' }))
    await waitFor(() => {
      expect(probeUrl().searchParams.get('tab')).toBe('series')
    })

    // Back: the Past history entry restores the Past tab.
    fireEvent.click(screen.getByTestId('history-back'))
    await waitFor(() => {
      expect(probeUrl().searchParams.get('tab')).toBe('past')
    })
    expect(
      screen.getByRole('tab', { name: 'Past' }),
    ).toHaveAttribute('aria-selected', 'true')

    // Back again: the bare /meetings entry restores Upcoming.
    fireEvent.click(screen.getByTestId('history-back'))
    await waitFor(() => {
      expect(probeUrl().searchParams.get('tab')).toBeNull()
    })
    expect(
      screen.getByRole('tab', { name: 'Upcoming' }),
    ).toHaveAttribute('aria-selected', 'true')

    // Forward restores the Past entry…
    fireEvent.click(screen.getByTestId('history-forward'))
    await waitFor(() => {
      expect(probeUrl().searchParams.get('tab')).toBe('past')
    })
    expect(
      screen.getByRole('tab', { name: 'Past' }),
    ).toHaveAttribute('aria-selected', 'true')

    // …and a second forward the Series entry.
    fireEvent.click(screen.getByTestId('history-forward'))
    await waitFor(() => {
      expect(probeUrl().searchParams.get('tab')).toBe('series')
    })
    expect(
      screen.getByRole('tab', { name: 'Series' }),
    ).toHaveAttribute('aria-selected', 'true')
  })

  it('does not push a history entry when re-selecting the active tab', async () => {
    renderPageAt('/meetings?tab=past')
    await settled()

    // Re-selecting the already-active Past tab must not rewrite
    // the URL (a new history entry would be an unnecessary
    // navigation for a no-op selection).
    const before = probeUrl().toString()
    fireEvent.click(screen.getByRole('tab', { name: 'Past' }))
    await waitFor(() => {
      expect(probeUrl().toString()).toBe(before)
    })
    expect(
      screen.getByRole('tab', { name: 'Past' }),
    ).toHaveAttribute('aria-selected', 'true')
  })

  it('carries the validated from=past origin when opening a completed Meeting from Past', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 42,
        title: 'Origin completed',
        scheduledAt: localIso(2026, 9, 19, 11, 0),
        status: 'completed',
      }),
    ])

    renderPageAt('/meetings?tab=past')

    const row = await screen.findByRole('button', {
      name: /^Open Origin completed /,
    })
    fireEvent.click(row)

    await screen.findByText('Meeting detail: 42')
    expect(
      document.querySelector('[data-testid="detail-search"]'),
    ).toHaveTextContent('?from=past')

    // Still a pure navigation: no mutation, no materialization.
    expect(meetingsApi.deleteMeeting).not.toHaveBeenCalled()
    expect(meetingsApi.updateMeeting).not.toHaveBeenCalled()
    expect(
      meetingsApi.materializeMeetingRecurrenceOccurrence,
    ).not.toHaveBeenCalled()
  })

  it('keeps the canonical bare detail URL when opening an Upcoming row', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 7,
        title: 'Upcoming row',
        scheduledAt: localIso(2026, 9, 23, 15, 0),
      }),
    ])

    renderPageAt('/meetings')
    const row = await screen.findByRole('button', {
      name: /^Open Upcoming row /,
    })
    fireEvent.click(row)

    await screen.findByText('Meeting detail: 7')
    expect(
      document.querySelector('[data-testid="detail-search"]'),
    ).toHaveTextContent('')
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
          selector: 'div.truncate.fg-type-record-title',
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
    // Actions cell: the per-row action affordance (the direct Edit
    // action for a row the server marks editable), which lives in
    // the far-right Actions region — never inside the Meeting block.
    const editAction = screen.getByRole('button', {
      name: 'Edit Team Sync',
    })
    expect(editAction).toBeVisible()

    // The desktop row exposes four distinct regions: Time, Meeting,
    // People, Actions — and the row action is inside the Actions
    // region.
    const row = screen.getByRole('button', {
      name: 'Open Team Sync on Wed, Sep 23 at 10:00',
    })
    expect(row.children).toHaveLength(4)
    const meetingBlock = row.children[1] as HTMLElement
    expect(
      within(meetingBlock).queryByRole('button'),
    ).toBeNull()
    const actionsRegion = row.children[3] as HTMLElement
    expect(actionsRegion).toContainElement(editAction)
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
      'md:max-[1100px]:grid-cols-[88px_minmax(0,1fr)_72px]',
    )
    // Desktop (≥1100): the four semantic columns — compact 104px
    // Time, flexible Meeting (minmax(0,1fr) so the track can
    // shrink and truncate instead of pushing the fixed columns
    // out), 96px nowrap People, and a 72px Actions track that
    // holds the compact direct action group (two 32px icon
    // actions + 4px gap).
    expect(row.className).toContain(
      'min-[1100px]:grid-cols-[104px_minmax(0,1fr)_96px_72px]',
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
          name: `Edit ${longTitle}`,
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

  it('renders no three-dot menu for a virtual occurrence — the row itself stays the Open affordance', async () => {
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
    // …and the Actions region carries NO overflow menu — the
    // three-dot affordance is gone from every row.
    expect(
      screen.queryByRole('button', {
        name:
          'Meeting actions for Weekly Research Sync',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('menu'),
    ).not.toBeInTheDocument()

    // The row itself remains the open affordance (an explicit row
    // activation resolves the occurrence — pinned in the
    // "opening Upcoming rows" suite).
    expect(
      screen.getByRole('button', {
        name:
          'Open Weekly Research Sync on Thu, Sep 24 at 11:00',
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
    // The fixture's server permissions grant Edit + Delete, so
    // both direct actions render in the Actions region.
    const actionButtons =
      within(actionsRegion).getAllByRole('button')
    expect(actionButtons).toHaveLength(2)
    for (const button of actionButtons) {
      expect(button).toBeVisible()
    }
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

    // The Upcoming tab keeps the canonical bare detail URL —
    // no origin query for the default tab.
    expect(
      document.querySelector(
        '[data-testid="detail-search"]',
      ),
    ).toHaveTextContent('')

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

  it('keeps Series rows non-navigational: the only interaction is the server-authorized termination button', async () => {
    vi.mocked(meetingsApi.listMeetingRecurrences).mockResolvedValue([
      makeSeriesOverview({
        id: 921,
        title: 'Zebra sync',
        canTerminate: true,
      }),
      makeSeriesOverview({
        id: 922,
        title: 'Read-only sync',
      }),
    ])

    renderPage()

    fireEvent.click(screen.getByRole('tab', { name: 'Series' }))
    await screen.findByText('Zebra sync')

    const section = screen.getByRole('region', {
      name: 'Meeting series',
    })

    // No links, no menus — the rows remain non-navigational
    // (no Series detail destination is fabricated)…
    expect(within(section).queryAllByRole('link')).toHaveLength(0)
    expect(within(section).queryAllByRole('menu')).toHaveLength(0)

    // …and the ONLY interactive descendants are the trash
    // buttons of the server-authorized rows: exactly one for the
    // granted row (accessible name naming the series), none for
    // the row the server did not grant — no three-dot menu, no
    // edit action, nothing else.
    const buttons =
      within(section).getAllByRole('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toHaveAttribute(
      'aria-label',
      'Delete series Zebra sync',
    )
    expect(
      screen.queryByRole('button', {
        name: 'Delete series Read-only sync',
      }),
    ).not.toBeInTheDocument()

    // Row activation does nothing: no navigation, no mutation.
    fireEvent.click(screen.getByText('Zebra sync'))
    expect(
      screen.queryByText(/Meeting detail:/),
    ).not.toBeInTheDocument()
    expect(screen.getByText('Zebra sync')).toBeVisible()
    expect(
      meetingsApi.terminateMeetingRecurrence,
    ).not.toHaveBeenCalled()
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

describe('MeetingListPage — terminate a Series', () => {
  /**
   * Two server-authorized Series of the active Research Group in
   * the backend's ordering (the middle one is the termination
   * target), plus — where noted — a cross-group row the page
   * filter must keep out.
   */
  function authorizedFixtures() {
    const target = makeSeriesOverview({
      id: 777,
      title: 'Termination target',
      canTerminate: true,
    })
    const first = makeSeriesOverview({
      id: 776,
      title: 'Kept series alpha',
      canTerminate: true,
    })
    const last = makeSeriesOverview({
      id: 778,
      title: 'Kept series beta',
      canTerminate: false,
    })
    const otherGroup = makeSeriesOverview({
      id: 779,
      title: 'Other group series',
      researchGroupId: 2,
      canTerminate: true,
    })

    return {
      target,
      first,
      last,
      otherGroup,
      activeGroupRows: [first, target, last],
    }
  }

  async function openSeriesTab() {
    renderPage()
    fireEvent.click(screen.getByRole('tab', {
      name: 'Series',
    }))
    await screen.findByText('Termination target')
  }

  /**
   * Mocks the Series overview so the FIRST response is the
   * pre-termination state and the post-termination refetch is
   * gated on an explicit resolve — authoritative-refetch
   * assertions stay deterministic (no assertion can settle
   * against the stale pre-termination render).
   */
  function gateRefetch(
    before: ApiMeetingRecurrenceOverview[],
  ): (rows: ApiMeetingRecurrenceOverview[]) => void {
    let resolveRefetch: (
      (rows: ApiMeetingRecurrenceOverview[]) => void
    ) | null = null
    vi.mocked(meetingsApi.listMeetingRecurrences)
      .mockResolvedValueOnce(before)
      .mockImplementation(() =>
        new Promise<ApiMeetingRecurrenceOverview[]>(
          (resolve) => {
            resolveRefetch = resolve
          },
        ),
      )
    // The deferred refetch is issued only on the POST-
    // termination call, so delegate through the captured
    // resolver at resolve time (never return it eagerly).
    return (rows) => {
      resolveRefetch!(rows)
    }
  }

  /**
   * The authoritative overview has settled: exactly the given
   * titles are rendered (visible) and the terminated series'
   * title is absent.
   */
  async function expectOverviewSettled(
    visibleTitles: string[],
  ) {
    await waitFor(() => {
      for (const title of visibleTitles) {
        expect(
          screen.getByText(title),
        ).toBeVisible()
      }
    })
    expect(
      screen.queryByText('Termination target'),
    ).not.toBeInTheDocument()
  }

  it('renders exactly one trash action per server-authorized Series row', async () => {
    const { activeGroupRows } =
      authorizedFixtures()
    vi.mocked(
      meetingsApi.listMeetingRecurrences,
    ).mockResolvedValue(activeGroupRows)

    await openSeriesTab()

    const section = screen.getByRole('region', {
      name: 'Meeting series',
    })

    // Exactly one trash action per granted row, each naming the
    // series — and nothing else interactive in the overview
    // (no three-dot menu, no edit action).
    expect(
      screen.getByRole('button', {
        name: 'Delete series Termination target',
      }),
    ).toBeVisible()
    expect(
      screen.getByRole('button', {
        name: 'Delete series Kept series alpha',
      }),
    ).toBeVisible()
    expect(
      within(section).getAllByRole('button'),
    ).toHaveLength(2)
    expect(
      within(section).queryAllByRole('menu'),
    ).toHaveLength(0)
    expect(
      within(section).queryAllByRole('link'),
    ).toHaveLength(0)
  })

  it('offers no destructive action when canTerminate is false or missing (never inferred)', async () => {
    const denied = makeSeriesOverview({
      id: 941,
      title: 'Denied series',
      canTerminate: false,
    })
    const missing = makeSeriesOverview({
      id: 942,
      title: 'Missing grant series',
    })
    delete (
      missing as unknown as
        Record<string, unknown>
    ).canTerminate
    vi.mocked(
      meetingsApi.listMeetingRecurrences,
    ).mockResolvedValue([denied, missing])

    renderPage()
    fireEvent.click(screen.getByRole('tab', {
      name: 'Series',
    }))
    await screen.findByText('Denied series')

    // A false or missing server grant never renders the
    // destructive action (and never enables a hidden one).
    const section = screen.getByRole('region', {
      name: 'Meeting series',
    })
    expect(
      within(section).queryAllByRole('button'),
    ).toHaveLength(0)
    expect(
      screen.queryByRole('button', {
        name: /Delete series/,
      }),
    ).not.toBeInTheDocument()
    // Both rows still render their content.
    expect(
      screen.getByText('Denied series'),
    ).toBeVisible()
    expect(
      screen.getByText('Missing grant series'),
    ).toBeVisible()
  })

  it('keeps the active and ended Series rendering intact alongside the action', async () => {
    vi.mocked(
      meetingsApi.listMeetingRecurrences,
    ).mockResolvedValue([
      makeSeriesOverview({
        id: 951,
        title: 'Running series',
        canTerminate: true,
      }),
      makeSeriesOverview({
        id: 952,
        title: 'Naturally ended series',
        status: 'ended',
        nextOccurrenceScheduledAt: null,
        count: 3,
        canTerminate: true,
      }),
    ])

    renderPage()
    fireEvent.click(screen.getByRole('tab', {
      name: 'Series',
    }))
    await screen.findByText('Running series')

    // Active row: state pill + next label + one trash action.
    expect(screen.getByText('Active')).toBeVisible()
    expect(
      screen.getByRole('button', {
        name: 'Delete series Running series',
      }),
    ).toBeVisible()
    // Ended row: derived Ended state, no fabricated next
    // meeting, and the action is still offered (a naturally
    // ended schedule can still be terminated explicitly).
    expect(screen.getByText('Ended')).toBeVisible()
    const endedRow = screen
      .getByText('Naturally ended series')
      .parentElement!.parentElement!
    expect(
      within(endedRow).queryAllByText(
        / · \d{2}:\d{2}$/,
      ),
    ).toHaveLength(0)
    expect(
      screen.getByRole('button', {
        name: 'Delete series Naturally ended series',
      }),
    ).toBeVisible()
  })

  it('opens the confirmation on trash click without any network request', async () => {
    vi.mocked(
      meetingsApi.listMeetingRecurrences,
    ).mockResolvedValue(
      authorizedFixtures().activeGroupRows,
    )

    await openSeriesTab()
    fireEvent.click(screen.getByRole('button', {
      name: 'Delete series Termination target',
    }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(
      screen.getByRole('heading', {
        name: 'Delete meeting series?',
      }),
    ).toBeVisible()
    // The selected series is identified by title…
    expect(
      screen.getByText(
        'Stop the recurring series "Termination target"?',
      ),
    ).toBeVisible()
    // …and the consequences are explained, including the
    // Template and the no-undo warning.
    expect(
      screen.getByText(
        'Future scheduled occurrences will stop.',
      ),
    ).toBeVisible()
    expect(
      screen.getByText(
        'Already-created upcoming meetings in the future will be cancelled.',
      ),
    ).toBeVisible()
    expect(
      screen.getByText(
        'Past and in-progress meetings and their notes remain available.',
      ),
    ).toBeVisible()
    expect(
      screen.getByText(
        'The meeting template is not deleted.',
      ),
    ).toBeVisible()
    expect(
      screen.getByText("This can't be undone."),
    ).toBeVisible()

    // No request until explicit confirmation — the row is
    // untouched and no related API is touched either.
    expect(
      meetingsApi.terminateMeetingRecurrence,
    ).not.toHaveBeenCalled()
    expect(
      screen.getByText('Termination target'),
    ).toBeVisible()
    expect(
      meetingsApi.listMeetingRecurrences,
    ).toHaveBeenCalledTimes(1)
  })

  it('closes without mutation on Keep series, Escape, and the backdrop', async () => {
    vi.mocked(
      meetingsApi.listMeetingRecurrences,
    ).mockResolvedValue(
      authorizedFixtures().activeGroupRows,
    )

    await openSeriesTab()

    // Keep series (the safe default-focus action).
    fireEvent.click(screen.getByRole('button', {
      name: 'Delete series Termination target',
    }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', {
      name: 'Keep series',
    }))
    expect(
      screen.queryByRole('dialog'),
    ).not.toBeInTheDocument()

    // Escape.
    fireEvent.click(screen.getByRole('button', {
      name: 'Delete series Termination target',
    }))
    await screen.findByRole('dialog')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(
      screen.queryByRole('dialog'),
    ).not.toBeInTheDocument()

    // Backdrop (the scrim itself, not the dialog surface).
    fireEvent.click(screen.getByRole('button', {
      name: 'Delete series Termination target',
    }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.mouseDown(dialog.parentElement!)
    expect(
      screen.queryByRole('dialog'),
    ).not.toBeInTheDocument()

    // Nothing was mutated: no termination request, no Series
    // refetch, the row and its action are intact.
    expect(
      meetingsApi.terminateMeetingRecurrence,
    ).not.toHaveBeenCalled()
    expect(
      meetingsApi.listMeetingRecurrences,
    ).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole('button', {
        name: 'Delete series Termination target',
      }),
    ).toBeVisible()
  })

  it('terminates with exactly one POST for the selected Recurrence id', async () => {
    vi.mocked(
      meetingsApi.listMeetingRecurrences,
    )
      .mockResolvedValueOnce(
        authorizedFixtures().activeGroupRows,
      )
      .mockResolvedValueOnce([
        authorizedFixtures().first,
        authorizedFixtures().last,
      ])

    await openSeriesTab()
    fireEvent.click(screen.getByRole('button', {
      name: 'Delete series Termination target',
    }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', {
      name: 'Delete series',
    }))

    await waitFor(() => {
      expect(
        meetingsApi.terminateMeetingRecurrence,
      ).toHaveBeenCalledTimes(1)
    })
    expect(
      meetingsApi.terminateMeetingRecurrence,
    ).toHaveBeenCalledWith(777)
    // The whole-series termination is its own operation: no
    // generic Meeting delete, no Meeting Template delete, no
    // single-occurrence cancellation / exclusion.
    expect(
      meetingsApi.deleteMeeting,
    ).not.toHaveBeenCalled()
    expect(
      meetingsApi.deleteMeetingSeries,
    ).not.toHaveBeenCalled()
    expect(
      meetingsApi.cancelMeetingRecurrenceOccurrence,
    ).not.toHaveBeenCalled()
    expect(
      meetingsApi.excludeMeetingRecurrenceOccurrence,
    ).not.toHaveBeenCalled()
  })

  it('blocks repeated destructive submissions while the request is in flight and does not allow dismissal', async () => {
    vi.mocked(
      meetingsApi.listMeetingRecurrences,
    ).mockResolvedValue(
      authorizedFixtures().activeGroupRows,
    )

    let resolveTerminate!: () => void
    vi.mocked(
      meetingsApi.terminateMeetingRecurrence,
    ).mockReturnValue(
      new Promise<void>((resolve) => {
        resolveTerminate = resolve
      }),
    )

    await openSeriesTab()
    fireEvent.click(screen.getByRole('button', {
      name: 'Delete series Termination target',
    }))
    await screen.findByRole('dialog')

    fireEvent.click(screen.getByRole('button', {
      name: 'Delete series',
    }))
    await waitFor(() => {
      expect(
        meetingsApi.terminateMeetingRecurrence,
      ).toHaveBeenCalledTimes(1)
    })

    // While in flight: the destructive button shows its pending
    // state and both actions are disabled…
    const confirmButton = screen.getByRole('button', {
      name: 'Deleting…',
    })
    expect(confirmButton).toBeDisabled()
    expect(
      screen.getByRole('button', {
        name: 'Keep series',
      }),
    ).toBeDisabled()
    // …so a second click cannot issue a second request…
    fireEvent.click(confirmButton)
    expect(
      meetingsApi.terminateMeetingRecurrence,
    ).toHaveBeenCalledTimes(1)
    // …and the dialog cannot be dismissed mid-write (Escape,
    // backdrop, or the safe action are all inert).
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(
      screen.getByRole('dialog'),
    ).toBeVisible()
    fireEvent.mouseDown(
      screen.getByRole('dialog').parentElement!,
    )
    expect(
      screen.getByRole('dialog'),
    ).toBeVisible()

    resolveTerminate()
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog'),
      ).not.toBeInTheDocument()
    })
    expect(
      meetingsApi.terminateMeetingRecurrence,
    ).toHaveBeenCalledTimes(1)
  })

  it('removes the series only through the authoritative refetch (no optimistic removal)', async () => {
    const {
      target,
      first,
      last,
    } = authorizedFixtures()
    const resolveRefetch = gateRefetch([
      first,
      target,
      last,
    ])

    let resolveTerminate!: () => void
    vi.mocked(
      meetingsApi.terminateMeetingRecurrence,
    ).mockReturnValue(
      new Promise<void>((resolve) => {
        resolveTerminate = resolve
      }),
    )

    await openSeriesTab()
    fireEvent.click(screen.getByRole('button', {
      name: 'Delete series Termination target',
    }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', {
      name: 'Delete series',
    }))

    // While the request is in flight the row is PRESERVED —
    // no optimistic client-side removal.
    await waitFor(() => {
      expect(
        meetingsApi.terminateMeetingRecurrence,
      ).toHaveBeenCalledTimes(1)
    })
    expect(
      screen.getByText('Termination target'),
    ).toBeVisible()

    resolveTerminate()

    // The authoritative refetch is issued only AFTER the
    // server confirmed; gate it, then settle it with the
    // post-termination server state (the terminated series is
    // gone from the overview entirely).
    await waitFor(() => {
      expect(
        meetingsApi.listMeetingRecurrences,
      ).toHaveBeenCalledTimes(2)
    })
    resolveRefetch([first, last])
    await expectOverviewSettled([
      'Kept series alpha',
      'Kept series beta',
    ])
    expect(
      screen.queryByRole('dialog'),
    ).not.toBeInTheDocument()
  })

  it('refreshes the Upcoming occurrence feed and the concrete Meetings on success', async () => {
    const {
      target,
      first,
      last,
    } = authorizedFixtures()
    const resolveRefetch = gateRefetch([
      first,
      target,
      last,
    ])

    await openSeriesTab()
    // The initial Upcoming loads already happened on mount.
    expect(
      meetingsApi.listMeetings,
    ).toHaveBeenCalledTimes(1)
    expect(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', {
      name: 'Delete series Termination target',
    }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', {
      name: 'Delete series',
    }))

    // The server cancelled the series' future unstarted
    // concrete Meetings: both the feed and the concrete list
    // are refetched (alongside the Series overview) so nothing
    // stale can remain in Upcoming.
    await waitFor(() => {
      expect(
        meetingsApi.terminateMeetingRecurrence,
      ).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(
        meetingsApi.listPersonalMeetingRecurrenceOccurrences,
      ).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(
        meetingsApi.listMeetings,
      ).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(
        meetingsApi.listMeetingRecurrences,
      ).toHaveBeenCalledTimes(2)
    })
    resolveRefetch([first, last])
    await expectOverviewSettled([
      'Kept series alpha',
      'Kept series beta',
    ])
  })

  it('keeps the dialog open with a retryable error on failure and succeeds on retry', async () => {
    const {
      target,
      first,
      last,
    } = authorizedFixtures()
    const resolveRefetch = gateRefetch(
      [first, target, last],
    )

    vi.mocked(
      meetingsApi.terminateMeetingRecurrence,
    )
      .mockRejectedValueOnce(
        new ApiError(403, {
          error: 'You do not have permission.',
        }),
      )
      .mockResolvedValueOnce(undefined)

    await openSeriesTab()
    fireEvent.click(screen.getByRole('button', {
      name: 'Delete series Termination target',
    }))
    await screen.findByRole('dialog')

    // First attempt fails: the row stays, the dialog stays
    // open with the server's actionable message, and no
    // success is reported (and no refetch is issued — a
    // failure changes nothing authoritatively).
    fireEvent.click(screen.getByRole('button', {
      name: 'Delete series',
    }))
    const alert = await screen.findByRole('alert')
    expect(
      within(alert).getByText(
        'You do not have permission.',
      ),
    ).toBeVisible()
    expect(
      screen.getByRole('dialog'),
    ).toBeVisible()
    expect(
      screen.getByText('Termination target'),
    ).toBeVisible()
    expect(
      meetingsApi.terminateMeetingRecurrence,
    ).toHaveBeenCalledTimes(1)
    expect(
      meetingsApi.listMeetingRecurrences,
    ).toHaveBeenCalledTimes(1)

    // Retry: one further request, then success removes the
    // row through the authoritative refetch.
    fireEvent.click(screen.getByRole('button', {
      name: 'Delete series',
    }))
    await waitFor(() => {
      expect(
        meetingsApi.terminateMeetingRecurrence,
      ).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(
        meetingsApi.listMeetingRecurrences,
      ).toHaveBeenCalledTimes(2)
    })
    resolveRefetch([first, last])
    await expectOverviewSettled([
      'Kept series alpha',
      'Kept series beta',
    ])
    expect(
      screen.queryByRole('dialog'),
    ).not.toBeInTheDocument()
  })

  it('keeps the unrelated Series in their server-defined order', async () => {
    const {
      target,
      first,
      last,
    } = authorizedFixtures()
    const resolveRefetch = gateRefetch([
      first,
      target,
      last,
    ])

    await openSeriesTab()
    fireEvent.click(screen.getByRole('button', {
      name: 'Delete series Termination target',
    }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', {
      name: 'Delete series',
    }))

    // After the authoritative refetch the remaining rows
    // keep the backend's relative order (never re-sorted
    // client-side).
    await waitFor(() => {
      expect(
        meetingsApi.listMeetingRecurrences,
      ).toHaveBeenCalledTimes(2)
    })
    resolveRefetch([first, last])
    await expectOverviewSettled([
      'Kept series alpha',
      'Kept series beta',
    ])
    const titles = screen.getAllByText(
      /^(Kept series alpha|Kept series beta)$/,
    )
    expect(
      titles.map((el) => el.textContent),
    ).toEqual([
      'Kept series alpha',
      'Kept series beta',
    ])
  })

  it('preserves the Research Group scoping across the termination', async () => {
    const {
      target,
      first,
      last,
      otherGroup,
    } = authorizedFixtures()
    const resolveRefetch = gateRefetch([
      first,
      target,
      last,
      otherGroup,
    ])

    await openSeriesTab()

    // The cross-group row is filtered out BEFORE the user
    // acts (and its grant never renders an action)…
    expect(
      screen.queryByText('Other group series'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', {
        name: 'Delete series Other group series',
      }),
    ).not.toBeInTheDocument()

    // …and stays filtered out after the termination refetch,
    // while the active group's rows converge to the
    // authoritative state.
    fireEvent.click(screen.getByRole('button', {
      name: 'Delete series Termination target',
    }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', {
      name: 'Delete series',
    }))

    await waitFor(() => {
      expect(
        meetingsApi.listMeetingRecurrences,
      ).toHaveBeenCalledTimes(2)
    })
    // The server keeps reporting the cross-group row (the
    // personal overview is cross-group by contract); the page
    // filter must drop it again after the refetch.
    resolveRefetch([first, last, otherGroup])
    await expectOverviewSettled([
      'Kept series alpha',
      'Kept series beta',
    ])
    expect(
      screen.queryByText('Other group series'),
    ).not.toBeInTheDocument()
    // The page kept requesting the same canonical window-free
    // overview (no group parameter, no per-Series requests).
    expect(
      meetingsApi.listMeetingRecurrences,
    ).toHaveBeenCalledTimes(2)
    expect(
      meetingsApi.listMeetingRecurrences,
    ).toHaveBeenCalledWith()
  })

  it('holds the keyboard and accessibility contracts', async () => {
    vi.mocked(
      meetingsApi.listMeetingRecurrences,
    ).mockResolvedValue(
      authorizedFixtures().activeGroupRows,
    )

    await openSeriesTab()
    const trashButton = screen.getByRole('button', {
      name: 'Delete series Termination target',
    })

    // The trash action is a real button on the tab order…
    trashButton.focus()
    expect(trashButton).toHaveFocus()
    // …and Enter never activates the row (no navigation, no
    // fabricated detail destination)…
    fireEvent.keyDown(trashButton, { key: 'Enter' })
    expect(
      screen.queryByText(/Meeting detail:/),
    ).not.toBeInTheDocument()
    // …while activation (keyboard or pointer — native button
    // behavior) opens the confirmation.
    fireEvent.click(trashButton)
    const dialog = await screen.findByRole('dialog')

    // Initial focus lands on the SAFE action…
    const safeButton = screen.getByRole('button', {
      name: 'Keep series',
    })
    expect(safeButton).toHaveFocus()
    // …the dialog is labelled by its title…
    expect(dialog).toHaveAttribute(
      'aria-labelledby',
      'meeting-series-terminate-confirm-title',
    )
    expect(
      screen.getByRole('heading', {
        name: 'Delete meeting series?',
      }),
    ).toBeVisible()

    // Tab is trapped inside the dialog (the only two
    // focusable actions): from the destructive action, Tab
    // wraps to the safe action…
    const destructiveButton = screen.getByRole(
      'button',
      { name: 'Delete series' },
    )
    destructiveButton.focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(
      safeButton,
    ).toHaveFocus()
    // …and from the safe action, Shift+Tab wraps back.
    fireEvent.keyDown(dialog, {
      key: 'Tab',
      shiftKey: true,
    })
    expect(destructiveButton).toHaveFocus()

    // …and closing returns focus to the originating trigger.
    fireEvent.click(safeButton)
    expect(
      screen.queryByRole('dialog'),
    ).not.toBeInTheDocument()
    expect(trashButton).toHaveFocus()
    expect(
      meetingsApi.terminateMeetingRecurrence,
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

describe('MeetingListPage — edit an existing Meeting from Upcoming', () => {
  /** Focus a schedule field and read its canonical (editing) value. */
  function canonicalValue(label: 'Date' | 'Time'): string {
    const input = screen.getByLabelText(label) as HTMLInputElement
    fireEvent.focus(input)
    return input.value
  }

  async function openEditDialogFor(title: string) {
    // The Upcoming list settles asynchronously; wait for the row's
    // Edit action before activating it.
    const editButton = await screen.findByRole('button', {
      name: `Edit ${title}`,
    })
    fireEvent.click(editButton)
    await screen.findByRole('heading', { name: 'Edit meeting' })
  }

  it('renders a direct Edit action on a concrete row the server marks editable, and no overflow menu', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 101,
        title: 'Team Sync',
        scheduledAt: localIso(2026, 9, 23, 10, 0),
      }),
    ])

    renderPage()
    await screen.findByRole('button', {
      name: 'Edit Team Sync',
    })

    // The direct Edit action is present…
    expect(
      screen.getByRole('button', { name: 'Edit Team Sync' }),
    ).toBeVisible()
    // …and the three-dot overflow menu is gone for this row.
    expect(
      screen.queryByRole('button', {
        name: 'Meeting actions for Team Sync',
      }),
    ).not.toBeInTheDocument()
  })

  it('renders no Edit action for a concrete row the server does NOT mark editable', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 102,
        title: 'Locked Sync',
        scheduledAt: localIso(2026, 9, 23, 10, 0),
        actionPermissions: {
          canEdit: false,
          canDelete: false,
          canCancel: false,
        },
      }),
    ])

    renderPage()
    await screen.findByRole('heading', { name: 'Today · Wed, Sep 23' })

    expect(
      screen.queryByRole('button', { name: 'Edit Locked Sync' }),
    ).not.toBeInTheDocument()
    // The server grants NO destructive action, so no trash action…
    expect(
      screen.queryByRole('button', { name: 'Delete Locked Sync' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Cancel Locked Sync' }),
    ).not.toBeInTheDocument()
    // …and the three-dot overflow menu is ABSENT on every
    // Upcoming row (concrete and virtual).
    expect(
      screen.queryByRole('button', {
        name: 'Meeting actions for Locked Sync',
      }),
    ).not.toBeInTheDocument()
    // The row itself remains openable.
    expect(
      screen.getByRole('button', {
        name: 'Open Locked Sync on Wed, Sep 23 at 10:00',
      }),
    ).toBeVisible()
  })

  it('renders no Edit action for a virtual occurrence (keeps its row-open behavior)', async () => {
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

    expect(
      screen.queryByRole('button', {
        name: 'Edit Weekly Research Sync',
      }),
    ).not.toBeInTheDocument()
    // No three-dot menu either…
    expect(
      screen.queryByRole('button', {
        name: 'Meeting actions for Weekly Research Sync',
      }),
    ).not.toBeInTheDocument()
    // …and no destructive action — the fixture occurrence carries
    // no server exclusion grant.
    expect(
      screen.queryByRole('button', {
        name: /Skip Weekly Research Sync/,
      }),
    ).not.toBeInTheDocument()
    // The row itself remains the open affordance.
    expect(
      screen.getByRole('button', {
        name:
          'Open Weekly Research Sync on Thu, Sep 24 at 11:00',
      }),
    ).toBeVisible()
  })

  it('opens the reused dialog prefilled with the Meeting values and the edit heading', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 103,
        title: 'Design Review',
        scheduledAt: localIso(2026, 9, 24, 14, 30),
      }),
    ])

    renderPage()
    await openEditDialogFor('Design Review')

    expect(
      screen.getByRole('heading', { name: 'Edit meeting' }),
    ).toBeVisible()
    expect(
      screen.getByText(
        'Only the title and the scheduled time can be changed here.',
      ),
    ).toBeVisible()
    expect(
      (screen.getByLabelText('Title') as HTMLInputElement).value,
    ).toBe('Design Review')
    expect(canonicalValue('Date')).toBe('2026-09-24')
    expect(canonicalValue('Time')).toBe('14:30')
    expect(
      screen.getByRole('button', { name: 'Save changes' }),
    ).toBeVisible()
  })

  it('saves a changed title by PATCHing only the title and reconciles the row', async () => {
    const updated = makeMeeting({
      id: 104,
      title: 'Renamed Review',
      scheduledAt: localIso(2026, 9, 24, 14, 30),
    })
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 104,
        title: 'Design Review',
        scheduledAt: localIso(2026, 9, 24, 14, 30),
      }),
    ])
    vi.mocked(meetingsApi.updateMeeting).mockResolvedValue(updated)

    renderPage()
    await openEditDialogFor('Design Review')

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Renamed Review' },
    })
    fireEvent.submit(
      screen.getByLabelText('Title').closest('form')!,
    )

    await waitFor(() => {
      expect(meetingsApi.updateMeeting).toHaveBeenCalledTimes(1)
    })
    // Only the changed field is sent (schedule untouched).
    expect(meetingsApi.updateMeeting).toHaveBeenCalledWith(
      104,
      { title: 'Renamed Review' },
    )
    // Dialog closed, no second Meeting created…
    expect(
      screen.queryByRole('heading', { name: 'Edit meeting' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(/Meeting detail:/),
    ).not.toBeInTheDocument()
    // …and the row reconciled to the returned title in place.
    expect(
      await screen.findByText('Renamed Review'),
    ).toBeVisible()
    expect(
      screen.queryByText('Design Review'),
    ).not.toBeInTheDocument()
  })

  it('saves a changed schedule by PATCHing the new instant and re-groups the row', async () => {
    const movedTo = localIso(2026, 9, 25, 9, 0)
    const updated = makeMeeting({
      id: 105,
      title: 'Board Review',
      scheduledAt: movedTo,
    })
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 105,
        title: 'Board Review',
        scheduledAt: localIso(2026, 9, 23, 16, 0),
      }),
    ])
    vi.mocked(meetingsApi.updateMeeting).mockResolvedValue(updated)

    renderPage()
    // The row starts in Today.
    await screen.findByRole('heading', {
      name: 'Today · Wed, Sep 23',
    })
    await openEditDialogFor('Board Review')

    // Move it to the next day at 09:00 (canonical local entry).
    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: '2026-09-25' },
    })
    fireEvent.change(screen.getByLabelText('Time'), {
      target: { value: '09:00' },
    })
    fireEvent.submit(
      screen.getByLabelText('Title').closest('form')!,
    )

    await waitFor(() => {
      expect(meetingsApi.updateMeeting).toHaveBeenCalledTimes(1)
    })
    // The title is unchanged, so ONLY scheduledAt is PATCHed.
    expect(meetingsApi.updateMeeting).toHaveBeenCalledWith(105, {
      scheduledAt: movedTo,
    })

    // The row now groups under the new date and shows the new time.
    const fri = await screen.findByRole('heading', {
      name: 'Fri, Sep 25',
    })
    expect(fri).toBeVisible()
    expect(
      screen.queryByRole('heading', { name: 'Today · Wed, Sep 23' }),
    ).not.toBeInTheDocument()
  })

  it('keeps the dialog open with the draft intact and a message when saving fails', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 106,
        title: 'Failing Sync',
        scheduledAt: localIso(2026, 9, 23, 10, 0),
      }),
    ])
    vi.mocked(meetingsApi.updateMeeting).mockRejectedValue(
      new ApiError(409, {
        error: 'The meeting was changed by someone else.',
      }),
    )

    renderPage()
    await openEditDialogFor('Failing Sync')

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Draft title' },
    })
    fireEvent.submit(
      screen.getByLabelText('Title').closest('form')!,
    )

    await screen.findByRole('alert')
    expect(
      within(screen.getByRole('alert')).getByText(
        'The meeting was changed by someone else.',
      ),
    ).toBeVisible()
    // The dialog stays open…
    expect(
      screen.getByRole('heading', { name: 'Edit meeting' }),
    ).toBeVisible()
    // …with the user's draft preserved.
    expect(
      (screen.getByLabelText('Title') as HTMLInputElement).value,
    ).toBe('Draft title')
  })
})

describe('MeetingListPage — delete / cancel a concrete Upcoming Meeting', () => {
  /** Standalone concrete Meeting the server marks editable + deletable. */
  function standaloneFixture() {
    return makeMeeting({
      id: 201,
      title: 'Standalone Sync',
      scheduledAt: localIso(2026, 9, 23, 10, 0),
      actionPermissions: {
        canEdit: true,
        canDelete: true,
        canCancel: false,
      },
    })
  }

  /**
   * Materialized recurring occurrence: the concrete Meeting the
   * server marks cancellable (never hard-deletable), its
   * materialized feed occurrence, and one untouched virtual sibling
   * of the same series.
   */
  function recurringFixture() {
    const meeting = makeMeeting({
      id: 202,
      title: 'Weekly Research Sync',
      scheduledAt: localIso(2026, 9, 24, 14, 0),
      actionPermissions: {
        canEdit: true,
        canDelete: false,
        canCancel: true,
      },
    })
    const targetOccurrence = makeOccurrence({
      occurrenceId: 'occ-target',
      title: 'Weekly Research Sync',
      originalScheduledAt: localIso(2026, 9, 24, 14, 0),
      scheduledAt: localIso(2026, 9, 24, 14, 0),
      materialized: true,
      meetingId: 202,
    })
    const siblingOccurrence = makeOccurrence({
      occurrenceId: 'occ-sibling',
      title: 'Weekly Research Sync',
      originalScheduledAt: localIso(2026, 9, 30, 14, 0),
      scheduledAt: localIso(2026, 9, 30, 14, 0),
    })

    return {
      meeting,
      targetOccurrence,
      siblingOccurrence,
    }
  }

  it('shows the trash action on a standalone row the server marks deletable, alongside the Edit action', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      standaloneFixture(),
    ])

    renderPage()
    await screen.findByRole('button', {
      name: 'Delete Standalone Sync',
    })

    expect(
      screen.getByRole('button', {
        name: 'Delete Standalone Sync',
      }),
    ).toBeVisible()
    // The Edit action keeps working side by side…
    expect(
      screen.getByRole('button', {
        name: 'Edit Standalone Sync',
      }),
    ).toBeVisible()
    // …and the three-dot menu is absent on concrete rows.
    expect(
      screen.queryByRole('button', {
        name: 'Meeting actions for Standalone Sync',
      }),
    ).not.toBeInTheDocument()
  })

  it('shows the same trash action on a materialized recurring row the server marks cancellable', async () => {
    const {
      meeting,
      targetOccurrence,
      siblingOccurrence,
    } = recurringFixture()
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      meeting,
    ])
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue([
      targetOccurrence,
      siblingOccurrence,
    ])

    renderPage()
    await screen.findByRole('button', {
      name: 'Cancel Weekly Research Sync',
    })

    expect(
      screen.getByRole('button', {
        name: 'Cancel Weekly Research Sync',
      }),
    ).toBeVisible()
    // The Edit action stays alongside…
    expect(
      screen.getByRole('button', {
        name: 'Edit Weekly Research Sync',
      }),
    ).toBeVisible()
    // …and no hard-delete label leaks for a recurring occurrence.
    expect(
      screen.queryByRole('button', {
        name: 'Delete Weekly Research Sync',
      }),
    ).not.toBeInTheDocument()
  })

  it('shows no destructive action on a concrete row the server does not authorize', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      makeMeeting({
        id: 203,
        title: 'Read-only Sync',
        scheduledAt: localIso(2026, 9, 23, 11, 0),
        actionPermissions: {
          canEdit: false,
          canDelete: false,
          canCancel: false,
        },
      }),
    ])

    renderPage()
    await screen.findByRole('heading', {
      name: 'Today · Wed, Sep 23',
    })

    expect(
      screen.queryByRole('button', {
        name: 'Delete Read-only Sync',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', {
        name: 'Cancel Read-only Sync',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', {
        name: 'Meeting actions for Read-only Sync',
      }),
    ).not.toBeInTheDocument()
  })

  it('shows no destructive action for a materialized occurrence whose Meeting is outside the concrete list (permissions are never inferred)', async () => {
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue([
      makeOccurrence({
        occurrenceId: 'occ-orphan',
        title: 'Orphan Occurrence',
        materialized: true,
        meetingId: 999,
      }),
    ])

    renderPage()
    await screen.findByText('Orphan Occurrence')

    // No concrete Meeting representation ⇒ no server permission
    // result ⇒ no destructive action (and no three-dot menu on
    // this concrete row).
    expect(
      screen.queryByRole('button', {
        name: 'Delete Orphan Occurrence',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', {
        name: 'Cancel Orphan Occurrence',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', {
        name: 'Meeting actions for Orphan Occurrence',
      }),
    ).not.toBeInTheDocument()
  })

  it('does not open the Meeting when the trash action is clicked', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      standaloneFixture(),
    ])

    renderPage()
    await screen.findByRole('button', {
      name: 'Delete Standalone Sync',
    })

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Delete Standalone Sync',
      }),
    )

    // The confirmation opened…
    await screen.findByRole('dialog')
    // …and the row's open intent did NOT fire.
    expect(
      screen.queryByText(/Meeting detail:/),
    ).not.toBeInTheDocument()
  })

  it('keeps the trash action keyboard-accessible without triggering the row', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      standaloneFixture(),
    ])

    renderPage()
    const deleteButton = await screen.findByRole('button', {
      name: 'Delete Standalone Sync',
    })

    // The action is a real button on the tab order…
    deleteButton.focus()
    expect(deleteButton).toHaveFocus()
    // …and Enter on it never fires the row's open intent…
    fireEvent.keyDown(deleteButton, { key: 'Enter' })
    expect(
      screen.queryByText(/Meeting detail:/),
    ).not.toBeInTheDocument()
    // …while activation still opens the confirmation.
    fireEvent.click(deleteButton)
    await screen.findByRole('dialog')
  })

  it('performs no mutation while the confirmation is open', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      standaloneFixture(),
    ])

    renderPage()
    await screen.findByRole('button', {
      name: 'Delete Standalone Sync',
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Delete Standalone Sync',
      }),
    )

    await screen.findByRole('dialog')
    expect(meetingsApi.deleteMeeting).not.toHaveBeenCalled()
    expect(
      meetingsApi.cancelMeetingRecurrenceOccurrence,
    ).not.toHaveBeenCalled()
    // The row is still there.
    expect(screen.getByText('Standalone Sync')).toBeVisible()
  })

  it('closes without mutation on Cancel and on Escape', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      standaloneFixture(),
    ])

    renderPage()
    await screen.findByRole('button', {
      name: 'Delete Standalone Sync',
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Delete Standalone Sync',
      }),
    )

    // Safe button (the Cancel action in delete mode).
    await screen.findByRole('dialog')
    fireEvent.click(
      screen.getByRole('button', { name: 'Cancel' }),
    )
    expect(
      screen.queryByRole('dialog'),
    ).not.toBeInTheDocument()
    expect(meetingsApi.deleteMeeting).not.toHaveBeenCalled()
    expect(screen.getByText('Standalone Sync')).toBeVisible()

    // Re-open and cancel with Escape.
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Delete Standalone Sync',
      }),
    )
    await screen.findByRole('dialog')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(
      screen.queryByRole('dialog'),
    ).not.toBeInTheDocument()
    expect(meetingsApi.deleteMeeting).not.toHaveBeenCalled()
    expect(screen.getByText('Standalone Sync')).toBeVisible()
  })

  it('confirms a standalone deletion with exactly one DELETE for the right Meeting', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      standaloneFixture(),
      makeMeeting({
        id: 204,
        title: 'Kept Review',
        scheduledAt: localIso(2026, 9, 23, 12, 0),
      }),
    ])

    renderPage()
    await screen.findByRole('button', {
      name: 'Delete Standalone Sync',
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Delete Standalone Sync',
      }),
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Delete',
      }),
    )

    await waitFor(() => {
      expect(meetingsApi.deleteMeeting).toHaveBeenCalledTimes(1)
    })
    expect(meetingsApi.deleteMeeting).toHaveBeenCalledWith(201)
    expect(
      meetingsApi.cancelMeetingRecurrenceOccurrence,
    ).not.toHaveBeenCalled()
  })

  it('removes only the deleted Meeting from Upcoming after success', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      standaloneFixture(),
      makeMeeting({
        id: 204,
        title: 'Kept Review',
        scheduledAt: localIso(2026, 9, 23, 12, 0),
      }),
    ])

    renderPage()
    await screen.findByRole('button', {
      name: 'Delete Standalone Sync',
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Delete Standalone Sync',
      }),
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Delete',
      }),
    )

    // The deleted row is gone, the unrelated Meeting stays, and the
    // dialog closed.
    expect(await screen.findByText('Kept Review')).toBeVisible()
    expect(
      screen.queryByText('Standalone Sync'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('dialog'),
    ).not.toBeInTheDocument()
    // A standalone deletion issues NO occurrence refetch and
    // materializes nothing.
    expect(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).toHaveBeenCalledTimes(1)
    expect(
      meetingsApi.materializeMeetingRecurrenceOccurrence,
    ).not.toHaveBeenCalled()
  })

  it('confirms a recurring occurrence through the dedicated Cancel action — never the generic DELETE', async () => {
    const {
      meeting,
      targetOccurrence,
      siblingOccurrence,
    } = recurringFixture()
    const cancelled = {
      ...meeting,
      status: 'cancelled' as const,
    }
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      meeting,
    ])
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    )
      .mockResolvedValueOnce([
        targetOccurrence,
        siblingOccurrence,
      ])
      .mockResolvedValueOnce([siblingOccurrence])
    vi.mocked(
      meetingsApi.cancelMeetingRecurrenceOccurrence,
    ).mockResolvedValue(cancelled)

    renderPage()
    await screen.findByRole('button', {
      name: 'Cancel Weekly Research Sync',
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Cancel Weekly Research Sync',
      }),
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Cancel occurrence',
      }),
    )

    await waitFor(() => {
      expect(
        meetingsApi.cancelMeetingRecurrenceOccurrence,
      ).toHaveBeenCalledTimes(1)
    })
    expect(
      meetingsApi.cancelMeetingRecurrenceOccurrence,
    ).toHaveBeenCalledWith(202)
    expect(meetingsApi.deleteMeeting).not.toHaveBeenCalled()
  })

  it('removes only the cancelled occurrence from Upcoming while preserving the sibling', async () => {
    const {
      meeting,
      targetOccurrence,
      siblingOccurrence,
    } = recurringFixture()
    const cancelled = {
      ...meeting,
      status: 'cancelled' as const,
    }
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      meeting,
    ])
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    )
      .mockResolvedValueOnce([
        targetOccurrence,
        siblingOccurrence,
      ])
      .mockResolvedValueOnce([siblingOccurrence])
    vi.mocked(
      meetingsApi.cancelMeetingRecurrenceOccurrence,
    ).mockResolvedValue(cancelled)

    renderPage()
    // Before: the materialized target row + the virtual sibling.
    await screen.findByRole('button', {
      name: 'Cancel Weekly Research Sync',
    })
    expect(
      screen.getAllByText('Weekly Research Sync'),
    ).toHaveLength(2)

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Cancel Weekly Research Sync',
      }),
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Cancel occurrence',
      }),
    )

    // After: exactly ONE row of the series remains — the sibling.
    await waitFor(() => {
      expect(
        screen.getAllByText('Weekly Research Sync'),
      ).toHaveLength(1)
    })
    // The occurrence feed was refreshed (initial load + one
    // refetch), the target's trash action is gone, and the dialog
    // closed.
    expect(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).toHaveBeenCalledTimes(2)
    expect(
      screen.queryByRole('button', {
        name: 'Cancel Weekly Research Sync',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('dialog'),
    ).not.toBeInTheDocument()
  })

  it('keeps the row and the dialog available on failure, and allows a retry', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      standaloneFixture(),
    ])
    vi.mocked(meetingsApi.deleteMeeting)
      .mockRejectedValueOnce(
        new ApiError(409, {
          error:
            'The meeting was changed by someone else.',
        }),
      )
      .mockResolvedValueOnce(undefined)

    renderPage()
    await screen.findByRole('button', {
      name: 'Delete Standalone Sync',
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Delete Standalone Sync',
      }),
    )

    // First attempt fails: the row stays, the dialog stays open
    // with the server's message.
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Delete',
      }),
    )
    await screen.findByRole('alert')
    expect(
      within(screen.getByRole('alert')).getByText(
        'The meeting was changed by someone else.',
      ),
    ).toBeVisible()
    expect(screen.getByRole('dialog')).toBeVisible()
    expect(screen.getByText('Standalone Sync')).toBeVisible()
    expect(meetingsApi.deleteMeeting).toHaveBeenCalledTimes(1)

    // Retry: one further request, then success removes the row.
    fireEvent.click(
      screen.getByRole('button', { name: 'Delete' }),
    )
    await waitFor(() => {
      expect(meetingsApi.deleteMeeting).toHaveBeenCalledTimes(2)
    })
    expect(
      screen.queryByRole('dialog'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Standalone Sync'),
    ).not.toBeInTheDocument()
  })

  it('keeps the target row and siblings intact when a cancellation fails', async () => {
    const {
      meeting,
      targetOccurrence,
      siblingOccurrence,
    } = recurringFixture()
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      meeting,
    ])
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue([
      targetOccurrence,
      siblingOccurrence,
    ])
    vi.mocked(
      meetingsApi.cancelMeetingRecurrenceOccurrence,
    ).mockRejectedValue(
      new ApiError(403, {
        error:
          'You do not have permission to cancel this meeting.',
      }),
    )

    renderPage()
    await screen.findByRole('button', {
      name: 'Cancel Weekly Research Sync',
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Cancel Weekly Research Sync',
      }),
    )

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Cancel occurrence',
      }),
    )
    await screen.findByRole('alert')
    expect(
      within(screen.getByRole('alert')).getByText(
        'You do not have permission to cancel this meeting.',
      ),
    ).toBeVisible()

    // No optimistic removal: the row stays, the siblings stay, the
    // feed was NOT refetched (nothing changed server-side), and no
    // hard delete happened.
    expect(screen.getByRole('dialog')).toBeVisible()
    expect(
      screen.getAllByText('Weekly Research Sync'),
    ).toHaveLength(2)
    expect(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).toHaveBeenCalledTimes(1)
    expect(meetingsApi.deleteMeeting).not.toHaveBeenCalled()
  })

  it('issues at most one request when the confirm button is double-activated', async () => {
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      standaloneFixture(),
    ])

    let settleDelete: (value: void) => void = () => {}
    vi.mocked(meetingsApi.deleteMeeting).mockReturnValue(
      new Promise<void>((resolve) => {
        settleDelete = resolve
      }),
    )

    renderPage()
    await screen.findByRole('button', {
      name: 'Delete Standalone Sync',
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Delete Standalone Sync',
      }),
    )

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Delete',
      }),
    )
    // Pending state: the confirm button is disabled…
    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: 'Deleting…',
        }),
      ).toBeDisabled()
    })
    // …so a second activation issues no further request.
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Deleting…',
      }),
    )
    expect(meetingsApi.deleteMeeting).toHaveBeenCalledTimes(1)

    settleDelete()
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog'),
      ).not.toBeInTheDocument()
    })
  })
})

describe('MeetingListPage — skip a virtual recurring occurrence', () => {
  /**
   * A virtual occurrence the server's feed marks excludable, one
   * untouched sibling of the SAME series, and one sibling of a
   * DIFFERENT series.
   */
  function skippableFixture() {
    const target = makeOccurrence({
      occurrenceId: 'occ-skip',
      recurrenceId: 40,
      title: 'Weekly Research Sync',
      originalScheduledAt: localIso(2026, 9, 24, 11, 0),
      scheduledAt: localIso(2026, 9, 24, 11, 0),
      canExclude: true,
    })
    const sameSeriesSibling = makeOccurrence({
      occurrenceId: 'occ-same-series',
      recurrenceId: 40,
      title: 'Weekly Research Sync',
      originalScheduledAt: localIso(2026, 9, 30, 11, 0),
      scheduledAt: localIso(2026, 9, 30, 11, 0),
      canExclude: true,
    })
    const otherSeriesSibling = makeOccurrence({
      occurrenceId: 'occ-other-series',
      recurrenceId: 41,
      title: 'Monday Board',
      originalScheduledAt: localIso(2026, 9, 25, 9, 0),
      scheduledAt: localIso(2026, 9, 25, 9, 0),
      canExclude: true,
    })

    return {
      target,
      sameSeriesSibling,
      otherSeriesSibling,
    }
  }

  it('shows the direct trash action for an authorized virtual occurrence — no pencil, no overflow menu', async () => {
    const { target } = skippableFixture()
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue([target])

    renderPage()
    const skipButton = await screen.findByRole('button', {
      name: 'Skip Weekly Research Sync on Thu, Sep 24',
    })

    expect(skipButton).toBeVisible()
    // No Edit pencil for a virtual occurrence…
    expect(
      screen.queryByRole('button', {
        name: 'Edit Weekly Research Sync',
      }),
    ).not.toBeInTheDocument()
    // …and the three-dot menu is gone from the row.
    expect(
      screen.queryByRole('button', {
        name: 'Meeting actions for Weekly Research Sync',
      }),
    ).not.toBeInTheDocument()
  })

  it('shows no destructive action and no menu for an unauthorized virtual occurrence', async () => {
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue([
      makeOccurrence({
        occurrenceId: 'occ-readonly',
        title: 'Weekly Research Sync',
        canExclude: false,
      }),
    ])

    renderPage()
    await screen.findByText('Weekly Research Sync')

    expect(
      screen.queryByRole('button', {
        name: /Skip Weekly Research Sync/,
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', {
        name: 'Meeting actions for Weekly Research Sync',
      }),
    ).not.toBeInTheDocument()
  })

  it('never interprets concrete Meeting permissions as virtual exclusion authority', async () => {
    // A materialized occurrence whose concrete Meeting the server
    // marks deletable: the merged row is CONCRETE, so it must never
    // gain the virtual-exclusion affordance (the feed's canExclude
    // is not carried onto concrete rows).
    const meeting = makeMeeting({
      id: 301,
      title: 'Weekly Research Sync',
      scheduledAt: localIso(2026, 9, 24, 11, 0),
      actionPermissions: {
        canEdit: true,
        canDelete: true,
        canCancel: false,
      },
    })
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue([
      meeting,
    ])
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue([
      makeOccurrence({
        occurrenceId: 'occ-mat',
        recurrenceId: 40,
        title: 'Weekly Research Sync',
        originalScheduledAt: localIso(2026, 9, 24, 11, 0),
        scheduledAt: localIso(2026, 9, 24, 11, 0),
        materialized: true,
        meetingId: 301,
        canExclude: true,
      }),
    ])

    renderPage()
    await screen.findByRole('button', {
      name: 'Delete Weekly Research Sync',
    })

    // The concrete destructive action (server canDelete) renders…
    expect(
      screen.getByRole('button', {
        name: 'Delete Weekly Research Sync',
      }),
    ).toBeVisible()
    // …and no virtual-exclusion affordance leaks onto the row.
    expect(
      screen.queryByRole('button', {
        name: /Skip Weekly Research Sync/,
      }),
    ).not.toBeInTheDocument()
  })

  it('no Upcoming row displays a three-dot menu', async () => {
    const { meetings, occurrences } = richFixtures()
    vi.mocked(meetingsApi.listMeetings).mockResolvedValue(
      meetings,
    )
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue(occurrences)

    renderPage()
    await screen.findByText('Team Sync')
    await screen.findByText('Weekly Research Sync')

    // One-time, virtual, and materialized rows are all rendered —
    // NONE carries the overflow affordance.
    expect(
      screen.queryAllByRole('button', {
        name: /Meeting actions for /,
      }),
    ).toHaveLength(0)
    expect(
      screen.queryByRole('menu'),
    ).not.toBeInTheDocument()
  })

  it('opens the skip confirmation — not the Meeting — when the trash is clicked', async () => {
    const { target, sameSeriesSibling } = skippableFixture()
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue([
      target,
      sameSeriesSibling,
    ])

    renderPage()
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Skip Weekly Research Sync on Thu, Sep 24',
      }),
    )

    // The confirmation opens with the skip copy…
    await screen.findByRole('dialog')
    expect(
      screen.getByRole('heading', {
        name: 'Skip this occurrence?',
      }),
    ).toBeVisible()
    expect(
      screen.getByText(
        'Skip "Weekly Research Sync" on Thu, Sep 24 at 11:00?',
      ),
    ).toBeVisible()
    expect(
      screen.getByRole('button', {
        name: 'Keep occurrence',
      }),
    ).toBeVisible()
    expect(
      screen.getByRole('button', {
        name: 'Skip occurrence',
      }),
    ).toBeVisible()
    // …and the row's open intent did NOT fire: no materialization,
    // no navigation.
    expect(
      meetingsApi.materializeMeetingRecurrenceOccurrence,
    ).not.toHaveBeenCalled()
    expect(
      screen.queryByText(/Meeting detail:/),
    ).not.toBeInTheDocument()
  })

  it('keeps the trash action keyboard-accessible without materializing the occurrence', async () => {
    const { target } = skippableFixture()
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue([target])

    renderPage()
    const skipButton = await screen.findByRole('button', {
      name: 'Skip Weekly Research Sync on Thu, Sep 24',
    })

    // The action is a real button on the tab order…
    skipButton.focus()
    expect(skipButton).toHaveFocus()
    // …and Enter on it never materializes the occurrence…
    fireEvent.keyDown(skipButton, { key: 'Enter' })
    expect(
      meetingsApi.materializeMeetingRecurrenceOccurrence,
    ).not.toHaveBeenCalled()
    expect(
      screen.queryByText(/Meeting detail:/),
    ).not.toBeInTheDocument()
    // …while activation still opens the confirmation.
    fireEvent.click(skipButton)
    await screen.findByRole('dialog')
  })

  it('performs no mutation while the confirmation is open', async () => {
    const { target } = skippableFixture()
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue([target])

    renderPage()
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Skip Weekly Research Sync on Thu, Sep 24',
      }),
    )

    await screen.findByRole('dialog')
    expect(
      meetingsApi.excludeMeetingRecurrenceOccurrence,
    ).not.toHaveBeenCalled()
    expect(
      meetingsApi.materializeMeetingRecurrenceOccurrence,
    ).not.toHaveBeenCalled()
    expect(meetingsApi.deleteMeeting).not.toHaveBeenCalled()
    expect(
      meetingsApi.cancelMeetingRecurrenceOccurrence,
    ).not.toHaveBeenCalled()
    // The row is still there.
    expect(screen.getByText('Weekly Research Sync')).toBeVisible()
  })

  it('closes without mutation on the safe action and on Escape', async () => {
    const { target } = skippableFixture()
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue([target])

    renderPage()
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Skip Weekly Research Sync on Thu, Sep 24',
      }),
    )

    // Safe button (the "Keep occurrence" action).
    await screen.findByRole('dialog')
    fireEvent.click(
      screen.getByRole('button', { name: 'Keep occurrence' }),
    )
    expect(
      screen.queryByRole('dialog'),
    ).not.toBeInTheDocument()
    expect(
      meetingsApi.excludeMeetingRecurrenceOccurrence,
    ).not.toHaveBeenCalled()
    expect(screen.getByText('Weekly Research Sync')).toBeVisible()

    // Re-open and cancel with Escape.
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Skip Weekly Research Sync on Thu, Sep 24',
      }),
    )
    await screen.findByRole('dialog')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(
      screen.queryByRole('dialog'),
    ).not.toBeInTheDocument()
    expect(
      meetingsApi.excludeMeetingRecurrenceOccurrence,
    ).not.toHaveBeenCalled()
    expect(screen.getByText('Weekly Research Sync')).toBeVisible()
  })

  it('confirms with exactly one exclusion POST carrying the original identity pair', async () => {
    const { target, sameSeriesSibling } = skippableFixture()
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    )
      .mockResolvedValueOnce([
        target,
        sameSeriesSibling,
      ])
      .mockResolvedValueOnce([sameSeriesSibling])

    renderPage()
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Skip Weekly Research Sync on Thu, Sep 24',
      }),
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Skip occurrence',
      }),
    )

    await waitFor(() => {
      expect(
        meetingsApi.excludeMeetingRecurrenceOccurrence,
      ).toHaveBeenCalledTimes(1)
    })
    // EXACTLY the server-reported identity pair — no title, no
    // Meeting id, no invented fields.
    expect(
      meetingsApi.excludeMeetingRecurrenceOccurrence,
    ).toHaveBeenCalledWith(40, {
      occurrenceId: 'occ-skip',
      originalScheduledAt: localIso(2026, 9, 24, 11, 0),
    })
    // And never the materialization / deletion / cancellation
    // endpoints.
    expect(
      meetingsApi.materializeMeetingRecurrenceOccurrence,
    ).not.toHaveBeenCalled()
    expect(meetingsApi.deleteMeeting).not.toHaveBeenCalled()
    expect(
      meetingsApi.cancelMeetingRecurrenceOccurrence,
    ).not.toHaveBeenCalled()
  })

  it('removes only the selected occurrence on success, preserving every sibling', async () => {
    const {
      target,
      sameSeriesSibling,
      otherSeriesSibling,
    } = skippableFixture()
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    )
      .mockResolvedValueOnce([
        target,
        sameSeriesSibling,
        otherSeriesSibling,
      ])
      .mockResolvedValueOnce([
        sameSeriesSibling,
        otherSeriesSibling,
      ])

    renderPage()
    // Before: the target + both siblings.
    await screen.findByRole('button', {
      name: 'Skip Weekly Research Sync on Thu, Sep 24',
    })
    expect(
      screen.getByRole('button', {
        name: 'Open Weekly Research Sync on Wed, Sep 30 at 11:00',
      }),
    ).toBeVisible()
    expect(
      screen.getByRole('button', {
        name: 'Open Monday Board on Fri, Sep 25 at 09:00',
      }),
    ).toBeVisible()

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Skip Weekly Research Sync on Thu, Sep 24',
      }),
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Skip occurrence',
      }),
    )

    // After: the selected occurrence is GONE…
    await waitFor(() => {
      expect(
        screen.queryByRole('button', {
          name:
            'Open Weekly Research Sync on Thu, Sep 24 at 11:00',
        }),
      ).not.toBeInTheDocument()
    })
    // …while BOTH siblings stay — including the occurrence of the
    // SAME recurrence.
    expect(
      screen.getByRole('button', {
        name: 'Open Weekly Research Sync on Wed, Sep 30 at 11:00',
      }),
    ).toBeVisible()
    expect(
      screen.getByRole('button', {
        name: 'Open Monday Board on Fri, Sep 25 at 09:00',
      }),
    ).toBeVisible()
    // The effective feed was refreshed (initial load + one
    // refetch), the dialog closed, and no concrete Meeting was
    // touched.
    expect(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).toHaveBeenCalledTimes(2)
    expect(
      screen.queryByRole('dialog'),
    ).not.toBeInTheDocument()
    expect(meetingsApi.deleteMeeting).not.toHaveBeenCalled()
  })

  it('keeps the excluded occurrence absent after the server refetch', async () => {
    const { target, sameSeriesSibling } = skippableFixture()
    // The refetch is the server's word: the effective set omits
    // the excluded occurrence; the client must never resurrect it
    // from stale local state.
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    )
      .mockResolvedValueOnce([
        target,
        sameSeriesSibling,
      ])
      .mockResolvedValueOnce([sameSeriesSibling])

    renderPage()
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Skip Weekly Research Sync on Thu, Sep 24',
      }),
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Skip occurrence',
      }),
    )

    await waitFor(() => {
      expect(
        meetingsApi.listPersonalMeetingRecurrenceOccurrences,
      ).toHaveBeenCalledTimes(2)
    })
    expect(
      screen.queryByRole('button', {
        name:
          'Open Weekly Research Sync on Thu, Sep 24 at 11:00',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: 'Open Weekly Research Sync on Wed, Sep 30 at 11:00',
      }),
    ).toBeVisible()
  })

  it('preserves the occurrence and allows a retry on failure', async () => {
    const { target, sameSeriesSibling } = skippableFixture()
    vi.mocked(
      meetingsApi.excludeMeetingRecurrenceOccurrence,
    )
      .mockRejectedValueOnce(
        new ApiError(409, {
          error: 'The occurrence could not be skipped.',
        }),
      )
      .mockResolvedValueOnce(undefined)
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    )
      .mockResolvedValueOnce([
        target,
        sameSeriesSibling,
      ])
      .mockResolvedValueOnce([
        target,
        sameSeriesSibling,
      ])
      .mockResolvedValueOnce([sameSeriesSibling])

    renderPage()
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Skip Weekly Research Sync on Thu, Sep 24',
      }),
    )

    // First attempt fails: the row stays, the dialog stays open
    // with the server's message.
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Skip occurrence',
      }),
    )
    await screen.findByRole('alert')
    expect(
      within(screen.getByRole('alert')).getByText(
        'The occurrence could not be skipped.',
      ),
    ).toBeVisible()
    expect(screen.getByRole('dialog')).toBeVisible()
    // The row is still there once the read-only server-truth
    // refresh settles (the server changed nothing).
    await screen.findByRole('button', {
      name:
        'Open Weekly Research Sync on Thu, Sep 24 at 11:00',
    })
    expect(
      meetingsApi.excludeMeetingRecurrenceOccurrence,
    ).toHaveBeenCalledTimes(1)

    // Retry: one further request, then success removes the row.
    fireEvent.click(
      screen.getByRole('button', { name: 'Skip occurrence' }),
    )
    await waitFor(() => {
      expect(
        meetingsApi.excludeMeetingRecurrenceOccurrence,
      ).toHaveBeenCalledTimes(2)
    })
    expect(
      screen.queryByRole('dialog'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', {
        name:
          'Open Weekly Research Sync on Thu, Sep 24 at 11:00',
      }),
    ).not.toBeInTheDocument()
  })

  it('handles a concurrent-materialization rejection without changing another Meeting', async () => {
    const { target, sameSeriesSibling } = skippableFixture()
    // While the confirmation was open, another client opened THIS
    // occurrence: it is now a concrete Meeting (id 302) with its
    // own canonical permissions (cancellable, not deletable).
    const concreteNow = makeMeeting({
      id: 302,
      title: 'Weekly Research Sync',
      scheduledAt: localIso(2026, 9, 24, 11, 0),
      actionPermissions: {
        canEdit: true,
        canDelete: false,
        canCancel: true,
      },
    })
    vi.mocked(meetingsApi.listMeetings)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([concreteNow])
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    )
      .mockResolvedValueOnce([
        target,
        sameSeriesSibling,
      ])
      .mockResolvedValueOnce([
        {
          ...target,
          materialized: true,
          meetingId: 302,
        },
        sameSeriesSibling,
      ])
    vi.mocked(
      meetingsApi.excludeMeetingRecurrenceOccurrence,
    ).mockRejectedValueOnce(
      new ApiError(400, {
        error:
          'This occurrence already has a concrete Meeting: excluding an already-materialized occurrence is not supported. Cancellation or deletion of the concrete Meeting is a separate operation.',
      }),
    )

    renderPage()
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Skip Weekly Research Sync on Thu, Sep 24',
      }),
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Skip occurrence',
      }),
    )

    // The server's message is shown…
    await screen.findByRole('alert')
    expect(
      within(screen.getByRole('alert')).getByText(
        /This occurrence already has a concrete Meeting/,
      ),
    ).toBeVisible()
    // …the dialog stays open for the user's decision…
    expect(screen.getByRole('dialog')).toBeVisible()
    // …and the UI converged to the server's truth: the row is now
    // the concrete Meeting (its canonical cancellation action —
    // NOT a virtual exclusion) and the sibling stays.
    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: 'Cancel Weekly Research Sync',
        }),
      ).toBeVisible()
    })
    expect(
      screen.queryByRole('button', {
        name:
          'Skip Weekly Research Sync on Thu, Sep 24',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: 'Open Weekly Research Sync on Wed, Sep 30 at 11:00',
      }),
    ).toBeVisible()
    // Exactly ONE exclusion attempt — and never a fallback to
    // generic deletion or cancellation of any Meeting.
    expect(
      meetingsApi.excludeMeetingRecurrenceOccurrence,
    ).toHaveBeenCalledTimes(1)
    expect(meetingsApi.deleteMeeting).not.toHaveBeenCalled()
    expect(
      meetingsApi.cancelMeetingRecurrenceOccurrence,
    ).not.toHaveBeenCalled()
    expect(
      meetingsApi.materializeMeetingRecurrenceOccurrence,
    ).not.toHaveBeenCalled()
  })

  it('issues at most one request when the confirm button is double-activated', async () => {
    const { target } = skippableFixture()
    vi.mocked(
      meetingsApi.listPersonalMeetingRecurrenceOccurrences,
    ).mockResolvedValue([target])

    let settleExclude: (value: void) => void = () => {}
    vi.mocked(
      meetingsApi.excludeMeetingRecurrenceOccurrence,
    ).mockReturnValue(
      new Promise<void>((resolve) => {
        settleExclude = resolve
      }),
    )

    renderPage()
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Skip Weekly Research Sync on Thu, Sep 24',
      }),
    )

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Skip occurrence',
      }),
    )
    // Pending state: the confirm button is disabled…
    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: 'Skipping…',
        }),
      ).toBeDisabled()
    })
    // …so a second activation issues no further request.
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Skipping…',
      }),
    )
    expect(
      meetingsApi.excludeMeetingRecurrenceOccurrence,
    ).toHaveBeenCalledTimes(1)

    settleExclude()
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog'),
      ).not.toBeInTheDocument()
    })
  })
})
