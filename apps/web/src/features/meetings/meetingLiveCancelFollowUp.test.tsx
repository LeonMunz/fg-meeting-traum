// @vitest-environment happy-dom
//
// Rendered behavioral tests for the Live Meeting Cancel
// follow-up contract: a selected source item with an active
// concrete followUpSchedule can be cancelled from the detail
// pane (regardless of whether it is Current). Cancellation is a
// REVERSAL: it refreshes canonical Meeting + item state, keeps
// the source Selected, leaves the persisted Current exactly as
// the server says, and runs no resolve/advance or Make-current
// logic. A preserved (edited) target produces explicit
// user-facing feedback; a failed cancellation mutates nothing.
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
  return { ...actual, me: vi.fn() }
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
    reopenMeetingItem: vi.fn(),
    cancelMeetingItemFollowUp: vi.fn(),
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
  ApiMeetingItemFollowUpSchedule,
  ApiMeetingSection,
} from '../../api/types'

/* ── Fixtures ────────────────────────────────────────────────── */

const MEETING_ID = 11

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
    followUpSchedule: null,
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
    currentMeetingItemId: 2,
    participantIds: [1],
    createdById: 1,
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-01T09:01:00Z',
    ...overrides,
  }
}

const FOLLOW_UP_SCHEDULE: ApiMeetingItemFollowUpSchedule = {
  id: 41,
  status: 'scheduled',
  sourceMeetingItemId: 1,
  sourceOutcome: 'follow_up',
  targetMeetingId: 23,
  targetMeetingTitle: 'FG Weekly',
  targetMeetingScheduledAt: '2026-09-16T09:00:00Z',
  targetMeetingSectionId: 29,
  targetMeetingSectionName: 'For your Info',
  targetMeetingItemId: 31,
  createdAt: '2026-09-09T10:00:00Z',
  updatedAt: '2026-09-09T10:00:00Z',
}

// A = Alpha (scheduled follow-up, already resolved)
// B = Beta  (the Current item, open)
// C = Gamma (open, non-current)
const CANCEL_ITEMS: ApiMeetingItem[] = [
  makeItem({
    id: 1,
    title: 'Alpha',
    position: 0,
    outcome: 'follow_up',
    followUpSchedule: FOLLOW_UP_SCHEDULE,
  }),
  makeItem({ id: 2, title: 'Beta', position: 1 }),
  makeItem({ id: 3, title: 'Gamma', position: 2 }),
]

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

function renderLivePage(
  fake: FakeLiveMeeting,
  sections: ApiMeetingSection[] = [makeSection()],
) {
  vi.mocked(meetingsApi.getMeeting).mockImplementation(
    () => fake.get(),
  )
  vi.mocked(
    meetingsApi.listMeetingParticipants,
  ).mockResolvedValue([])
  vi.mocked(meetingsApi.listMeetingItems).mockImplementation(
    () => fake.listItems(),
  )
  vi.mocked(meetingsApi.listMeetingSections).mockResolvedValue(sections)
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
  screen.getByRole('main', { name: 'Agenda item' })

const workspaceIn = () =>
  within(screen.getByRole('main', { name: 'Agenda item' }))

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

const selectRow = (title: string) => {
  const row = itemRow(title)
  const buttons = row
    .getAllByRole('button')
    .filter((b) => {
      const label = b.getAttribute('aria-label') ?? ''
      return label.startsWith('View')
    })
  if (buttons.length === 0) {
    throw new Error(`no selection button for ${title}`)
  }
  return buttons[0]
}

const waitForLive = async () => {
  await waitFor(() => {
    expect(
      screen.getByRole('button', { name: 'End meeting' }),
    ).toBeTruthy()
  })
}

const cancelTrigger = () =>
  screen.getByRole('button', {
    name: 'Cancel follow-up for Alpha',
  })

const cancelDialog = () =>
  screen.getByRole('dialog', { name: 'Cancel follow-up?' })

// Server-side effect of a successful cancellation: the source
// reopens to not_discussed, its active schedule disappears, and
// the Meeting row (including the current pointer) is unchanged.
const applyCancelledServerState = (fake: FakeLiveMeeting) => {
  fake.items = fake.items.map((item) =>
    item.id === 1
      ? {
          ...item,
          outcome: 'not_discussed' as const,
          followUpSchedule: null,
        }
      : item,
  )
  return Promise.resolve({
    id: FOLLOW_UP_SCHEDULE.id,
    status: 'cancelled' as const,
    sourceMeetingItemId: 1,
    sourceOutcome: 'not_discussed' as const,
    targetMeetingItemId: null,
    targetItemDisposition: 'removed' as const,
  })
}

beforeEach(() => {
  vi.mocked(meetingsApi.cancelMeetingItemFollowUp).mockReset()
})

afterEach(() => {
  cleanup()
})

/* ── Behavioral assertions ───────────────────────────────────── */

describe('Live Meeting Cancel follow-up (reversal, not resolution)', () => {
  it('exposes Cancel follow-up for a selected scheduled source that is NOT Current', async () => {
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 2 }),
      CANCEL_ITEMS,
    )
    renderLivePage(fake)
    await waitForLive()

    // Beta is Current; the default selection is on Beta, which
    // has no schedule: no Cancel action there.
    expect(
      screen.queryByRole('button', {
        name: /Cancel follow-up for Beta/ ,
      }),
    ).toBeNull()

    // Selecting the scheduled, non-current Alpha reveals the
    // destination AND the neutral Cancel action — without any
    // Make-current requirement.
    fireEvent.click(selectRow('Alpha'))
    await waitFor(() => {
      expect(workspace()).toHaveTextContent(
        'Scheduled for FG Weekly',
      )
    })
    expect(
      workspaceIn().getByText('For your Info'),
    ).toBeTruthy()
    expect(cancelTrigger()).toBeTruthy()
    // Alpha is Selected, not Current.
    expect(rowCurrent('Beta')).toBeTruthy()
    expect(itemRow('Alpha').queryByText('Current', { exact: true })).toBeNull()

    // Opening the dialog must not mutate anything.
    fireEvent.click(cancelTrigger())
    await waitFor(() => {
      expect(cancelDialog()).toBeTruthy()
    })
    expect(
      vi.mocked(meetingsApi.cancelMeetingItemFollowUp),
    ).not.toHaveBeenCalled()
    expect(fake.items[0].outcome).toBe('follow_up')
    expect(fake.items[0].followUpSchedule).toBe(FOLLOW_UP_SCHEDULE)
    expect(fake.meeting.currentMeetingItemId).toBe(2)
  })

  it('requires confirmation: dismiss (neutral + Escape) changes nothing', async () => {
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 2 }),
      CANCEL_ITEMS,
    )
    renderLivePage(fake)
    await waitForLive()

    fireEvent.click(selectRow('Alpha'))
    await waitFor(() => {
      expect(workspace()).toHaveTextContent(
        'Scheduled for FG Weekly',
      )
    })

    // Neutral "Keep follow-up" dismissal.
    fireEvent.click(cancelTrigger())
    await waitFor(() => expect(cancelDialog()).toBeTruthy())
    fireEvent.click(
      within(cancelDialog()).getByRole('button', {
        name: 'Keep follow-up',
      }),
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(
      vi.mocked(meetingsApi.cancelMeetingItemFollowUp),
    ).not.toHaveBeenCalled()
    expect(fake.items[0].outcome).toBe('follow_up')
    expect(fake.items[0].followUpSchedule).toBe(FOLLOW_UP_SCHEDULE)
    // Alpha remains Selected; Current unchanged.
    expect(
      selectRow('Alpha').getAttribute('aria-pressed'),
    ).toBe('true')
    expect(rowCurrent('Beta')).toBeTruthy()

    // Escape dismissal.
    fireEvent.click(cancelTrigger())
    await waitFor(() => expect(cancelDialog()).toBeTruthy())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(
      vi.mocked(meetingsApi.cancelMeetingItemFollowUp),
    ).not.toHaveBeenCalled()
    expect(fake.items[0].followUpSchedule).toBe(FOLLOW_UP_SCHEDULE)
    expect(fake.meeting.currentMeetingItemId).toBe(2)
  })

  it('removed target: source reopens, stays Selected, Current stays on another item, no navigation', async () => {
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 2 }),
      CANCEL_ITEMS,
    )
    vi.mocked(
      meetingsApi.cancelMeetingItemFollowUp,
    ).mockImplementation(
      () => applyCancelledServerState(fake),
    )
    renderLivePage(fake)
    await waitForLive()

    fireEvent.click(selectRow('Alpha'))
    await waitFor(() => {
      expect(workspace()).toHaveTextContent(
        'Scheduled for FG Weekly',
      )
    })
    fireEvent.click(cancelTrigger())
    await waitFor(() => expect(cancelDialog()).toBeTruthy())
    fireEvent.click(
      within(cancelDialog()).getByRole('button', {
        name: 'Cancel follow-up',
      }),
    )

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    expect(
      vi.mocked(meetingsApi.cancelMeetingItemFollowUp),
    ).toHaveBeenCalledWith(41)

    // Dialog closed; no preserved-target feedback for removed.
    expect(
      screen.queryByText(/was kept because/),
    ).toBeNull()

    // Source reopens and the scheduled destination disappears.
    expect(workspace()).toHaveTextContent('Alpha')
    expect(
      workspaceIn().queryByText(/Scheduled for/),
    ).toBeNull()
    expect(
      itemRow('Alpha').getByText('Open', { exact: true }),
    ).toBeTruthy()
    expect(
      screen.queryByRole('button', {
        name: 'Cancel follow-up for Alpha',
      }),
    ).toBeNull()

    // Reversal, not resolution: Alpha remains Selected and the
    // detail pane stays on Alpha; Current stays on Beta (no
    // advance, no Make current, no Return-to-current jump).
    expect(
      selectRow('Alpha').getAttribute('aria-pressed'),
    ).toBe('true')
    expect(rowCurrent('Beta')).toBeTruthy()
    expect(
      itemRow('Alpha').queryByText('Current', { exact: true }),
    ).toBeNull()
    expect(fake.meeting.currentMeetingItemId).toBe(2)

    // No resolve/advance or Focus API was invoked.
    expect(
      vi.mocked(meetingsApi.focusMeetingItem),
    ).not.toHaveBeenCalled()
    expect(
      vi.mocked(meetingsApi.markMeetingItemDone),
    ).not.toHaveBeenCalled()
  })

  it('null Current stays null after a successful cancel and the source remains Selected', async () => {
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: null }),
      CANCEL_ITEMS,
    )
    vi.mocked(
      meetingsApi.cancelMeetingItemFollowUp,
    ).mockImplementation(
      () => applyCancelledServerState(fake),
    )
    renderLivePage(fake)
    await waitForLive()

    // With no Current, the fresh Live selection is null: the calm
    // "No current item" state shows. Select Alpha explicitly.
    expect(screen.queryAllByText('Current', { exact: true })).toHaveLength(0)
    fireEvent.click(selectRow('Alpha'))
    await waitFor(() => {
      expect(workspace()).toHaveTextContent(
        'Scheduled for FG Weekly',
      )
    })
    fireEvent.click(cancelTrigger())
    await waitFor(() => expect(cancelDialog()).toBeTruthy())
    fireEvent.click(
      within(cancelDialog()).getByRole('button', {
        name: 'Cancel follow-up',
      }),
    )

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    // Source reopens and stays Selected; Current remains null.
    expect(
      selectRow('Alpha').getAttribute('aria-pressed'),
    ).toBe('true')
    expect(workspace()).toHaveTextContent('Alpha')
    expect(
      workspaceIn().queryByText(/Scheduled for/),
    ).toBeNull()
    expect(screen.queryAllByText('Current', { exact: true })).toHaveLength(0)
    expect(fake.meeting.currentMeetingItemId).toBeNull()
  })

  it('preserved target: same reversal behavior plus explicit kept-target feedback', async () => {
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 2 }),
      CANCEL_ITEMS,
    )
    vi.mocked(
      meetingsApi.cancelMeetingItemFollowUp,
    ).mockImplementation(async (followUpId: number) => {
      applyCancelledServerState(fake)
      return {
        id: followUpId,
        status: 'cancelled' as const,
        sourceMeetingItemId: 1,
        sourceOutcome: 'not_discussed' as const,
        targetMeetingItemId: 31,
        targetItemDisposition: 'preserved' as const,
      }
    })
    renderLivePage(fake)
    await waitForLive()

    fireEvent.click(selectRow('Alpha'))
    await waitFor(() => {
      expect(workspace()).toHaveTextContent(
        'Scheduled for FG Weekly',
      )
    })
    fireEvent.click(cancelTrigger())
    await waitFor(() => expect(cancelDialog()).toBeTruthy())
    fireEvent.click(
      within(cancelDialog()).getByRole('button', {
        name: 'Cancel follow-up',
      }),
    )

    await waitFor(() => {
      expect(
        workspaceIn().getByRole('status'),
      ).toHaveTextContent(
        'Follow-up cancelled. The agenda item in FG Weekly was kept because it had already been changed.',
      )
    })
    expect(screen.queryByRole('dialog')).toBeNull()

    // The notice is informational and dismissible.
    fireEvent.click(
      screen.getByRole('button', { name: 'Dismiss' }),
    )
    await waitFor(() => {
      expect(
        screen.queryByText(/was kept because/),
      ).toBeNull()
    })

    // Reversal invariants still hold with a preserved target.
    expect(
      selectRow('Alpha').getAttribute('aria-pressed'),
    ).toBe('true')
    expect(
      workspaceIn().queryByText(/Scheduled for/),
    ).toBeNull()
    expect(rowCurrent('Beta')).toBeTruthy()
    expect(fake.meeting.currentMeetingItemId).toBe(2)
  })

  it('failed cancellation keeps the dialog open, shows the error, and mutates nothing', async () => {
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 2 }),
      CANCEL_ITEMS,
    )
    const domainError = new Error(
      'The target meeting is no longer upcoming.',
    )
    vi.mocked(
      meetingsApi.cancelMeetingItemFollowUp,
    ).mockRejectedValue(domainError)
    renderLivePage(fake)
    await waitForLive()

    fireEvent.click(selectRow('Alpha'))
    await waitFor(() => {
      expect(workspace()).toHaveTextContent(
        'Scheduled for FG Weekly',
      )
    })
    fireEvent.click(cancelTrigger())
    await waitFor(() => expect(cancelDialog()).toBeTruthy())
    fireEvent.click(
      within(cancelDialog()).getByRole('button', {
        name: 'Cancel follow-up',
      }),
    )

    // Dialog stays open with the standard error treatment.
    await waitFor(() => {
      expect(
        within(cancelDialog()).getByRole('alert'),
      ).toHaveTextContent(
        'The target meeting is no longer upcoming.',
      )
    })
    expect(cancelDialog()).toBeTruthy()
    // Nothing mutated: still scheduled, selection and Current intact.
    expect(fake.items[0].outcome).toBe('follow_up')
    expect(fake.items[0].followUpSchedule).toBe(FOLLOW_UP_SCHEDULE)
    expect(
      selectRow('Alpha').getAttribute('aria-pressed'),
    ).toBe('true')
    expect(rowCurrent('Beta')).toBeTruthy()
    expect(fake.meeting.currentMeetingItemId).toBe(2)

    // Recoverable: neutral dismissal works while the API has
    // recovered.
    fireEvent.click(
      within(cancelDialog()).getByRole('button', {
        name: 'Keep follow-up',
      }),
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(
      workspaceIn().queryByText(/Scheduled for/),
    ).toBeTruthy()
  })

  it('does not offer Cancel follow-up for ordinary open, Done, or unscheduled legacy follow-up items', async () => {
    const legacyFollowUp = makeItem({
      id: 4,
      title: 'Legacy',
      position: 3,
      outcome: 'follow_up',
      followUpSchedule: null,
    })
    const doneItem = makeItem({
      id: 5,
      title: 'Zeta',
      position: 4,
      outcome: 'done',
    })
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 2 }),
      [
        ...CANCEL_ITEMS,
        legacyFollowUp,
        doneItem,
      ],
    )
    renderLivePage(fake)
    await waitForLive()

    // Ordinary open item: no Cancel action.
    fireEvent.click(selectRow('Gamma'))
    await waitFor(() => {
      expect(workspace()).toHaveTextContent('Gamma')
    })
    expect(screen.queryByRole('button', { name: /Cancel follow-up/ })).toBeNull()

    // Legacy follow_up outcome WITHOUT a concrete active
    // schedule: still no Cancel action.
    fireEvent.click(selectRow('Legacy'))
    await waitFor(() => {
      expect(workspace()).toHaveTextContent('Legacy')
    })
    expect(screen.queryByRole('button', { name: /Cancel follow-up/ })).toBeNull()
    expect(
      workspaceIn().queryByText(/Scheduled for/),
    ).toBeNull()

    // Done item: no Cancel action (and no schedule shown).
    fireEvent.click(selectRow('Zeta'))
    await waitFor(() => {
      expect(workspace()).toHaveTextContent('Zeta')
    })
    expect(screen.queryByRole('button', { name: /Cancel follow-up/ })).toBeNull()

    // The scheduled source still offers its action.
    fireEvent.click(selectRow('Alpha'))
    await waitFor(() => {
      expect(workspace()).toHaveTextContent(
        'Scheduled for FG Weekly',
      )
    })
    expect(cancelTrigger()).toBeTruthy()
  })
})
