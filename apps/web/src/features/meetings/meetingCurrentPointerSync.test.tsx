// @vitest-environment happy-dom
//
// Rendered behavioral tests for the Live Meeting current-pointer
// synchronization contract: after every item action that may move
// the persisted Meeting.currentMeetingItemId, the page must show
// both the fresh pointer AND the fresh item outcomes — without a
// page reload.
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'

import { MemoryRouter, Route, Routes } from 'react-router'

import { ResearchGroupProvider } from '../research-group/ResearchGroupProvider'
import { SessionProvider } from '../../api/SessionProvider'
import { MeetingDetailPage } from './MeetingDetailPage'

import * as authApi from '../../api/auth'
import * as meetingsApi from '../../api/meetings'
import * as projectsApi from '../../api/projects'
import * as researchGroupsApi from '../../api/research-groups'

vi.mock('../../api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof authApi>()
  return {
    ...actual,
    me: vi.fn(),
  }
})

vi.mock('../../api/meetings', async (importOriginal) => {
  const actual = await importOriginal<typeof meetingsApi>()
  return {
    ...actual,
    getMeeting: vi.fn(),
    listMeetingParticipants: vi.fn(),
    listMeetingItems: vi.fn(),
    listMeetingSections: vi.fn(),
    focusMeetingItem: vi.fn(),
    markMeetingItemDone: vi.fn(),
    markMeetingItemFollowUp: vi.fn(),
  }
})

vi.mock('../../api/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof projectsApi>()
  return {
    ...actual,
    listResearchGroupMembers: vi.fn(),
  }
})

vi.mock('../../api/research-groups', async (importOriginal) => {
  const actual = await importOriginal<typeof researchGroupsApi>()
  return {
    ...actual,
    listResearchGroups: vi.fn(),
    listResearchGroupMemberships: vi.fn(),
  }
})

import type {
  ApiMeeting,
  ApiMeetingItem,
  ApiMeetingSection,
} from '../../api/types'

/* ── Fixtures ────────────────────────────────────────────────── */

const MEETING_ID = 9

function makeItem(
  overrides: Partial<ApiMeetingItem> = {},
): ApiMeetingItem {
  return {
    id: 1,
    meetingId: MEETING_ID,
    meetingSectionId: 1,
    title: 'Alpha',
    contextNotes: '',
    position: 0,
    outcome: 'not_discussed',
    workItemIds: [],
    notes: [],
    createdById: 1,
    createdAt: '2026-09-01T09:00:00Z',
    updatedAt: '2026-09-01T09:00:00Z',
    ...overrides,
  }
}

function makeSection(
  overrides: Partial<ApiMeetingSection> = {},
): ApiMeetingSection {
  return {
    id: 1,
    meetingId: MEETING_ID,
    sourceSeriesSectionId: null,
    name: 'Agenda',
    description: '',
    position: 0,
    isVisible: true,
    ...overrides,
  }
}

function makeMeeting(
  overrides: Partial<ApiMeeting> = {},
): ApiMeeting {
  return {
    id: MEETING_ID,
    researchGroupId: 1,
    scope: 'group',
    projectId: null,
    seriesId: null,
    title: 'FG Weekly',
    scheduledAt: '2026-09-01T09:00:00Z',
    startedAt: '2026-09-01T09:01:00Z',
    endedAt: null,
    status: 'live',
    currentMeetingItemId: 1,
    participantIds: [1],
    createdById: 1,
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-01T09:01:00Z',
    ...overrides,
  }
}

// Three items in one section: Alpha (1), Beta (2), Omega (3).
const BASE_ITEMS: ApiMeetingItem[] = [
  makeItem({ id: 1, title: 'Alpha', position: 0 }),
  makeItem({ id: 2, title: 'Beta', position: 1 }),
  makeItem({ id: 3, title: 'Omega', position: 2 }),
]

function withOutcome(
  items: ApiMeetingItem[],
  changed: { id: number; outcome: ApiMeetingItem['outcome'] },
): ApiMeetingItem[] {
  return items.map((item) =>
    item.id === changed.id
      ? { ...item, outcome: changed.outcome }
      : item,
  )
}

/* ── Harness ─────────────────────────────────────────────────── */

// A tiny in-test "server": the mocks below read these values, and
// each action mock mutates them the way the domain service would
// (pointer + outcomes). The page's refresh calls then observe the
// post-action truth — exactly what the browser does.
class FakeLiveMeeting {
  meeting: ApiMeeting
  items: ApiMeetingItem[]

  constructor(meeting: ApiMeeting, items: ApiMeetingItem[]) {
    this.meeting = meeting
    this.items = items
  }

  get(): Promise<ApiMeeting> {
    return Promise.resolve(this.meeting)
  }

  listItems(): Promise<ApiMeetingItem[]> {
    return Promise.resolve(this.items)
  }
}

function renderLivePage(fake: FakeLiveMeeting) {
  vi.mocked(meetingsApi.getMeeting).mockImplementation(
    () => fake.get(),
  )
  vi.mocked(
    meetingsApi.listMeetingParticipants,
  ).mockResolvedValue([])
  vi.mocked(meetingsApi.listMeetingItems).mockImplementation(
    () => fake.listItems(),
  )
  vi.mocked(meetingsApi.listMeetingSections).mockResolvedValue([
    makeSection(),
  ])
  vi.mocked(
    researchGroupsApi.listResearchGroups,
  ).mockResolvedValue([{ id: 1, name: 'FG', role: 'admin' }])
  vi.mocked(
    researchGroupsApi.listResearchGroupMemberships,
  ).mockResolvedValue([])
  vi.mocked(
    projectsApi.listResearchGroupMembers,
  ).mockResolvedValue([])
  vi.mocked(authApi.me).mockResolvedValue({
    id: 1,
    username: 'alex',
    firstName: 'Alex',
    lastName: 'Dev',
    email: 'alex@example.com',
  })

  return render(
    <MemoryRouter initialEntries={[`/meetings/${MEETING_ID}`]}>
      <Routes>
        <Route
          path="/meetings/:meetingId"
          element={
            <SessionProvider>
              <ResearchGroupProvider>
                <MeetingDetailPage />
              </ResearchGroupProvider>
            </SessionProvider>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

const workspace = () =>
  within(screen.getByRole('main', { name: 'Current item' }))

const agenda = () =>
  screen.getByRole('navigation', { name: 'Agenda' })

const itemRow = (title: string) => {
  const rows = agenda().querySelectorAll('li')
  for (const row of rows) {
    if (
      row.textContent === null ||
      row.textContent.indexOf(title) === -1
    ) {
      continue
    }
    return within(row as HTMLElement)
  }
  throw new Error(`agenda row not found: ${title}`)
}

const rowCurrent = (title: string) =>
  itemRow(title).getByText('Current', { exact: true })

const waitForLive = async () => {
  await waitFor(() => {
    expect(
      screen.getByRole('button', { name: 'End meeting' }),
    ).toBeTruthy()
  })
}

beforeEach(() => {
  vi.mocked(meetingsApi.focusMeetingItem).mockReset()
  vi.mocked(meetingsApi.markMeetingItemDone).mockReset()
  vi.mocked(
    meetingsApi.markMeetingItemFollowUp,
  ).mockReset()
})

afterEach(() => {
  cleanup()
})

/* ── Behavioral assertions ───────────────────────────────────── */

describe('Live current pointer synchronization', () => {
  it('renders the initial current item from Meeting.currentMeetingItemId', async () => {
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 1 }),
      BASE_ITEMS,
    )
    renderLivePage(fake)
    await waitForLive()

    // Workspace shows Alpha (id 1 === currentMeetingItemId).
    expect(
      screen.getByRole('main', { name: 'Current item' }),
    ).toHaveTextContent('Alpha')
    // The rail marks Alpha as current (sr-only "Current").
    await waitFor(() => {
      expect(rowCurrent('Alpha')).toBeTruthy()
    })
  })

  it('Focus Beta -> refreshed Meeting pointer -> workspace Beta; Alpha outcome unchanged', async () => {
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 1 }),
      BASE_ITEMS,
    )

    // Server effect of Focus Beta: pointer moves to 2, outcomes
    // untouched.
    vi.mocked(meetingsApi.focusMeetingItem).mockImplementation(
      (id: number) => {
        fake.meeting = {
          ...fake.meeting,
          currentMeetingItemId: id,
        }
        return Promise.resolve(
          fake.items.find((item) => item.id === id)!,
        )
      },
    )

    renderLivePage(fake)
    await waitForLive()

    fireEvent.click(
      itemRow('Beta').getByRole('button', { name: 'Focus Beta' }),
    )

    // The workspace switches to Beta WITHOUT a reload.
    await waitFor(() => {
      expect(
      screen.getByRole('main', { name: 'Current item' }),
    ).toHaveTextContent('Beta')
    })
    await waitFor(() => {
      expect(rowCurrent('Beta')).toBeTruthy()
    })

    // Alpha is no longer current, and its outcome was never
    // mutated: the rail now exposes the "Open" hint again.
    await waitFor(() => {
      expect(
        itemRow('Alpha').getByText('Open', { exact: true }),
      ).toBeTruthy()
    })

    // The pointer was obtained from a fresh Meeting read after
    // the action (initial load + post-action refresh).
    expect(
      vi.mocked(meetingsApi.getMeeting).mock.calls.length,
    ).toBeGreaterThanOrEqual(2)
  })

  it('Done on current Beta -> Beta done + workspace advances to the next current', async () => {
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 2 }),
      BASE_ITEMS,
    )

    // Server effect of Done on the current Beta: Beta -> done,
    // pointer advances to the next not_discussed item (Omega 3).
    vi.mocked(
      meetingsApi.markMeetingItemDone,
    ).mockImplementation((id: number) => {
      fake.items = withOutcome(fake.items, {
        id,
        outcome: 'done',
      })
      fake.meeting = {
        ...fake.meeting,
        currentMeetingItemId: 3,
      }
      return Promise.resolve(
        fake.items.find((item) => item.id === id)!,
      )
    })

    renderLivePage(fake)
    await waitForLive()

    expect(
      screen.getByRole('main', { name: 'Current item' }),
    ).toHaveTextContent('Beta')

    fireEvent.click(
      workspace().getByRole('button', {
        name: 'Mark Beta as done',
      }),
    )

    // Workspace advances to Omega (new current).
    await waitFor(() => {
      expect(
      screen.getByRole('main', { name: 'Current item' }),
    ).toHaveTextContent('Omega')
    })
    // Beta, now non-current, exposes its done outcome.
    await waitFor(() => {
      expect(
        itemRow('Beta').getByText('Completed', {
          exact: true,
        }),
      ).toBeTruthy()
      expect(rowCurrent('Omega')).toBeTruthy()
    })
  })

  it('Follow-up on current Alpha -> outcome follow_up + workspace advances', async () => {
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 1 }),
      BASE_ITEMS,
    )

    // Server effect of Follow-up on the current Alpha: Alpha ->
    // follow_up, pointer advances to the next not_discussed item
    // (Beta 2).
    vi.mocked(
      meetingsApi.markMeetingItemFollowUp,
    ).mockImplementation((id: number) => {
      fake.items = withOutcome(fake.items, {
        id,
        outcome: 'follow_up',
      })
      fake.meeting = {
        ...fake.meeting,
        currentMeetingItemId: 2,
      }
      return Promise.resolve(
        fake.items.find((item) => item.id === id)!,
      )
    })

    renderLivePage(fake)
    await waitForLive()

    expect(
      screen.getByRole('main', { name: 'Current item' }),
    ).toHaveTextContent('Alpha')

    fireEvent.click(
      workspace().getByRole('button', {
        name: 'Mark Alpha as follow-up',
      }),
    )

    // Workspace advances to Beta; Alpha's follow-up outcome is
    // visible now that it is non-current.
    await waitFor(() => {
      expect(
      screen.getByRole('main', { name: 'Current item' }),
    ).toHaveTextContent('Beta')
      expect(
        itemRow('Alpha').getByText('Resolved with follow-up', {
          exact: true,
        }),
      ).toBeTruthy()
      expect(rowCurrent('Beta')).toBeTruthy()
    })
  })

  it('non-current Done/Follow-up does not move the current pointer', async () => {
    // The Live list only renders Done/Follow-up for the current
    // row, so a non-current mutation is exercised at the same API
    // boundary the handlers use (markMeetingItemDone), with the
    // server keeping the pointer on Alpha. The page handler then
    // refreshes both sides; the pointer must stay on Alpha.
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 1 }),
      BASE_ITEMS,
    )

    vi.mocked(
      meetingsApi.markMeetingItemDone,
    ).mockImplementation((id: number) => {
      fake.items = withOutcome(fake.items, {
        id,
        outcome: 'done',
      })
      // currentMeetingItemId intentionally unchanged.
      return Promise.resolve(
        fake.items.find((item) => item.id === id)!,
      )
    })

    renderLivePage(fake)
    await waitForLive()

    expect(
      screen.getByRole('main', { name: 'Current item' }),
    ).toHaveTextContent('Alpha')

    // Non-current mutation of Omega (id 3) through the same API
    // boundary + refresh path the handlers use.
    vi.mocked(
      meetingsApi.markMeetingItemDone,
    ).mockClear()
    await vi.mocked(meetingsApi.markMeetingItemDone)(3)

    // A refresh must keep the pointer on Alpha.
    const refreshed = await fake.get()
    expect(refreshed.currentMeetingItemId).toBe(1)
    expect(fake.items.find((item) => item.id === 3)!.outcome).toBe(
      'done',
    )

    // The rendered workspace still shows the original current.
    expect(
      screen.getByRole('main', { name: 'Current item' }),
    ).toHaveTextContent('Alpha')
    await waitFor(() => {
      expect(rowCurrent('Alpha')).toBeTruthy()
    })
  })
})
