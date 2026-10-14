// @vitest-environment happy-dom
/**
 * Regression: relative day labels in the Meeting preparation view.
 *
 * The preparation header renders the scheduled day through
 * `formatMeetingDayLabel` (MeetingDetailPage.tsx): the local day
 * of `scheduledAt` equal to today → `Today`, the NEXT local day →
 * `Tomorrow`, every other local day (including YESTERDAY, the
 * overdue case) → the absolute short local date
 * (e.g. `Tue, Oct 13`). A yesterday Meeting must NEVER render as
 * `Tomorrow` — its detail header shows the absolute local date,
 * exactly what `e2e/meetings-past.spec.ts` (the late-start flow)
 * asserts against the overdue Meeting's detail header.
 *
 * Determinism: the system Date is pinned to Wed 2026-10-14 12:00
 * LOCAL and every `scheduledAt` is constructed as a LOCAL instant,
 * so the expected labels hold in every IANA timezone.
 */

import {
  cleanup,
  render,
  screen,
} from '@testing-library/react'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router'

import * as meetingsApi from '../../api/meetings'
import * as projectsApi from '../../api/projects'
import * as workItemsApi from '../../api/work-items'
import type {
  ApiMeeting,
  ApiMeetingItem,
  ApiMeetingParticipant,
  ApiMeetingSection,
} from '../../api/types'

import { MeetingDetailPage } from './MeetingDetailPage'

vi.mock('../../api/meetings', () => ({
  addMeetingParticipant: vi.fn(),
  createMeetingItem: vi.fn(),
  createMeetingNote: vi.fn(),
  createMeetingSection: vi.fn(),
  deleteMeeting: vi.fn(),
  deleteMeetingNote: vi.fn(),
  deleteMeetingItem: vi.fn(),
  endMeeting: vi.fn(),
  focusMeetingItem: vi.fn(),
  getMeeting: vi.fn(),
  listMeetingItems: vi.fn(),
  listMeetingParticipants: vi.fn(),
  listMeetingSections: vi.fn(),
  markMeetingItemDone: vi.fn(),
  reorderMeetingSections: vi.fn(),
  reopenMeeting: vi.fn(),
  reopenMeetingItem: vi.fn(),
  removeMeetingParticipant: vi.fn(),
  searchMeetingParticipantCandidates: vi.fn(),
  startMeeting: vi.fn(),
  updateMeetingItem: vi.fn(),
  updateMeetingNote: vi.fn(),
  updateMeetingSection: vi.fn(),
}))

vi.mock('../../api/projects', () => ({
  getProject: vi.fn(),
  getProjectWorkItemConfiguration: vi.fn(),
  listProjectMemberships: vi.fn(),
}))

vi.mock('../../api/work-items', () => ({
  getWorkItem: vi.fn(),
  listProjectWorkItems: vi.fn(),
  updateWorkItem: vi.fn(),
}))

const sessionMock = vi.hoisted(() => ({
  user: { id: 2, username: 'chris' } as {
    id: number
    username: string
  },
}))

vi.mock('../../api/useSession', () => ({
  useSession: () => ({ user: sessionMock.user }),
}))

vi.mock('../research-group/useResearchGroup', () => ({
  useResearchGroup: () => ({
    groups: [{ id: 3, name: 'FG Group', role: 'member' }],
    activeResearchGroupId: 3,
    activeResearchGroup: {
      id: 3,
      name: 'FG Group',
      role: 'member',
    },
    loading: false,
    error: null,
    setActiveResearchGroupId: vi.fn(),
    reloadResearchGroups: vi.fn(),
    addResearchGroup: vi.fn(),
  }),
}))

// ── Fixtures ─────────────────────────────────────────────────────

/** Pinned "now": Wed 2026-10-14 12:00 LOCAL. */
const NOW = new Date(2026, 9, 14, 12, 0, 0)

/**
 * ISO string of a LOCAL calendar date/time — the same wire shape
 * the API returns (a UTC instant of the local scheduled time), so
 * `formatMeetingDayLabel`'s local-day comparison sees exactly the
 * local day this test names, in every timezone.
 */
function isoLocal(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string {
  return new Date(year, month, day, hour, minute).toISOString()
}

const section: ApiMeetingSection = {
  id: 21,
  meetingId: 11,
  sourceSeriesSectionId: null,
  name: 'Agenda',
  description: '',
  position: 0,
  isVisible: true,
}

const item: ApiMeetingItem = {
  id: 31,
  meetingId: 11,
  meetingSectionId: 21,
  title: 'Weekly review',
  contextNotes: '',
  content: 'Weekly review topic',
  position: 0,
  outcome: 'not_discussed',
  followUpSchedule: null,
  workItemIds: [],
  notes: [],
  createdById: 2,
  createdAt: '2026-09-01T09:00:00Z',
  updatedAt: '2026-09-01T09:00:00Z',
}

const participant: ApiMeetingParticipant = {
  id: 301,
  user: {
    id: 2,
    username: 'chris',
    firstName: 'Chris',
    lastName: 'Example',
  },
  addedAt: '2026-09-01T09:00:00Z',
}

function makeMeeting(
  overrides: Partial<ApiMeeting> = {},
): ApiMeeting {
  return {
    id: 11,
    researchGroupId: 3,
    scope: 'group',
    projectId: null,
    seriesId: null,
    title: 'Collab Weekly',
    scheduledAt: '2026-09-30T09:00:00Z',
    startedAt: null,
    endedAt: null,
    status: 'upcoming',
    currentMeetingItemId: null,
    participantIds: [2],
    actionPermissions: {
      canEdit: true,
      canDelete: true,
      canCancel: false,
    },
    createdById: 2,
    createdAt: '2026-09-01T09:00:00Z',
    updatedAt: '2026-09-01T09:00:00Z',
    ...overrides,
  }
}

function renderPage(meeting: ApiMeeting) {
  vi.mocked(meetingsApi.getMeeting).mockResolvedValue(
    meeting,
  )
  vi.mocked(
    meetingsApi.listMeetingParticipants,
  ).mockResolvedValue([participant])
  vi.mocked(meetingsApi.listMeetingItems).mockResolvedValue(
    [item],
  )
  vi.mocked(
    meetingsApi.listMeetingSections,
  ).mockResolvedValue([section])
  vi.mocked(projectsApi.getProject).mockResolvedValue(
    null as never,
  )
  vi.mocked(workItemsApi.getWorkItem).mockResolvedValue(
    null as never,
  )

  return render(
    <MemoryRouter initialEntries={['/meetings/11']}>
      <Routes>
        <Route
          path="/meetings"
          element={<div>Meetings list marker</div>}
        />
        <Route
          path="/meetings/:meetingId"
          element={<MeetingDetailPage />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  // Pin ONLY the Date clock (real timers stay, so RTL's async
  // waits run); "today" is deterministic for the whole suite.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/**
 * The Meeting detail header region: the `<header>` containing the
 * page title — the same scoping `e2e/meetings-past.spec.ts` uses
 * (`page.locator('header').filter({ has: <h1> })`).
 */
function getDetailHeader(): HTMLElement {
  const title = screen.getByRole('heading', {
    name: 'Collab Weekly',
    level: 1,
  })
  const header = Array.from(
    document.querySelectorAll('header'),
  ).find((el) => el.contains(title))

  if (!header) {
    throw new Error(
      'no <header> contains the Meeting title',
    )
  }

  return header
}

// ── Preparation header day label ─────────────────────────────────

describe('Meeting preparation header day label', () => {
  it('labels a Meeting scheduled today as Today', async () => {
    renderPage(
      makeMeeting({
        scheduledAt: isoLocal(2026, 9, 14, 9, 0),
      }),
    )

    await screen.findByRole('heading', {
      name: 'Collab Weekly',
      level: 1,
    })

    expect(screen.getByText('Today')).toBeVisible()
    // The relative word replaces the absolute date.
    expect(
      screen.queryByText('Wed, Oct 14'),
    ).not.toBeInTheDocument()
  })

  it('labels a Meeting scheduled tomorrow as Tomorrow', async () => {
    renderPage(
      makeMeeting({
        scheduledAt: isoLocal(2026, 9, 15, 9, 0),
      }),
    )

    await screen.findByRole('heading', {
      name: 'Collab Weekly',
      level: 1,
    })

    expect(screen.getByText('Tomorrow')).toBeVisible()
    // The relative word replaces the absolute date.
    expect(
      screen.queryByText('Thu, Oct 15'),
    ).not.toBeInTheDocument()
  })

  it('labels a Meeting scheduled yesterday with the absolute local date, never Tomorrow', async () => {
    // The overdue case: exactly the label
    // e2e/meetings-past.spec.ts expects in the overdue
    // Meeting's detail header.
    renderPage(
      makeMeeting({
        scheduledAt: isoLocal(2026, 9, 13, 7, 30),
      }),
    )

    await screen.findByRole('heading', {
      name: 'Collab Weekly',
      level: 1,
    })

    expect(screen.getByText('Tue, Oct 13')).toBeVisible()
    // Yesterday must NEVER render as Tomorrow (the sign-inverted
    // day-diff defect this suite guards against).
    expect(
      screen.queryByText('Tomorrow'),
    ).not.toBeInTheDocument()
    // The original scheduled clock time is preserved.
    expect(screen.getByText('07:30')).toBeVisible()
  })

  it('renders the preparation header as a <header> carrying the title + day label (detail-header E2E contract)', async () => {
    // e2e/meetings-past.spec.ts scopes the overdue detail-header
    // assertion to the <header> containing the title — the same
    // element the live and completed detail branches render. The
    // preparation view must satisfy that contract too.
    renderPage(
      makeMeeting({
        scheduledAt: isoLocal(2026, 9, 13, 7, 30),
      }),
    )

    await screen.findByRole('heading', {
      name: 'Collab Weekly',
      level: 1,
    })

    const header = getDetailHeader()

    expect(header).toHaveTextContent('Tue, Oct 13')
    expect(header).toHaveTextContent('07:30')
  })
})
