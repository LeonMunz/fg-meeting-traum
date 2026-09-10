// @vitest-environment happy-dom
//
// Rendered behavioral tests for the Live Meeting selection contract:
// the agenda rail's *Selected* item (local UI navigation) is
// decoupled from the Meeting's persisted *Current* item. Selecting
// any agenda item (regardless of outcome) only changes what the
// detail pane shows; it never moves the current pointer, never
// mutates an outcome, and never triggers a domain API call.
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
    markMeetingItemFollowUp: vi.fn(),
    getMeetingItemFollowUpTargets: vi.fn(),
    scheduleMeetingItemFollowUp: vi.fn(),
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
  ApiMeetingItemFollowUpTargets,
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

// Three items in distinct states:
//   Alpha (1) done        – resolved
//   Beta  (2) not_discussed – the CURRENT item (open)
//   Omega (3) not_discussed – upcoming/open, non-current
const BASE_ITEMS: ApiMeetingItem[] = [
  makeItem({ id: 1, title: 'Alpha', position: 0, outcome: 'done' }),
  makeItem({ id: 2, title: 'Beta', position: 1 }),
  makeItem({ id: 3, title: 'Omega', position: 2 }),
]

// One item in each outcome, with the OPEN item current:
// lets each resolution-control state be observed directly on
// the current item without any mutation.
const OUTCOME_ITEMS: ApiMeetingItem[] = [
  makeItem({ id: 1, title: 'Alpha', position: 0, outcome: 'done' }),
  makeItem({ id: 2, title: 'Beta', position: 1, outcome: 'not_discussed' }),
  makeItem({ id: 3, title: 'Omega', position: 2, outcome: 'follow_up' }),
]

const FOLLOW_UP_SCHEDULE: ApiMeetingItemFollowUpSchedule = {
  id: 41,
  status: 'scheduled',
  sourceMeetingItemId: 2,
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

const FOLLOW_UP_TARGETS: ApiMeetingItemFollowUpTargets = {
  recommendedMeetingId: 23,
  meetings: [
    {
      id: 23,
      title: 'FG Weekly',
      scheduledAt: '2026-09-16T09:00:00Z',
      seriesId: 5,
      recommendedSectionId: 29,
      sections: [
        {
          id: 29,
          name: 'For your Info',
          position: 0,
          sourceSeriesSectionId: 7,
        },
        {
          id: 30,
          name: 'Discussion',
          position: 1,
          sourceSeriesSectionId: 8,
        },
      ],
    },
    {
      id: 24,
      title: 'Project Sync',
      scheduledAt: '2026-09-18T11:00:00Z',
      seriesId: null,
      recommendedSectionId: null,
      sections: [
        {
          id: 32,
          name: 'Topics',
          position: 0,
          sourceSeriesSectionId: null,
        },
      ],
    },
  ],
}

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
  // The selection control is the row's button labelled
  // "View item …" / "View current item …".
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

beforeEach(() => {
  vi.mocked(meetingsApi.focusMeetingItem).mockReset()
  vi.mocked(meetingsApi.markMeetingItemDone).mockReset()
  vi.mocked(meetingsApi.reopenMeetingItem).mockReset()
  vi.mocked(
    meetingsApi.markMeetingItemFollowUp,
  ).mockReset()
  vi.mocked(
    meetingsApi.getMeetingItemFollowUpTargets,
  ).mockReset()
  vi.mocked(
    meetingsApi.scheduleMeetingItemFollowUp,
  ).mockReset()
  vi.mocked(
    meetingsApi.getMeetingItemFollowUpTargets,
  ).mockResolvedValue(FOLLOW_UP_TARGETS)
  // Selection must never trigger a domain mutation.
  vi.mocked(meetingsApi.focusMeetingItem).mockResolvedValue(
    makeItem(),
  )
})

afterEach(() => {
  cleanup()
})

/* ── Behavioral assertions ───────────────────────────────────── */

describe('Live Meeting selection (decoupled from current)', () => {

  it('offers no per-row Focus / make-current control on any Live agenda row', async () => {
    // The explicit "Make current" affordance lives in the
    // selected-item detail context — never on an agenda row.
    // Rows are selection-only, even while browsing a non-current
    // item (where the detail-pane "Make current" action exists).
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 2 }),
      BASE_ITEMS,
    )
    renderLivePage(fake)
    await waitForLive()

    // No Focus control anywhere in the agenda rail.
    expect(
      within(agenda()).queryByRole('button', { name: /Focus / }),
    ).toBeNull()
    expect(
      within(agenda()).queryByRole('button', {
        name: 'Make Alpha current',
      }),
    ).toBeNull()

    // Browsing to a non-current item: the detail pane now offers
    // the explicit "Make current" action, but the RAIL itself
    // still carries no make-current control.
    fireEvent.click(selectRow('Alpha'))
    await waitFor(() => {
      expect(
        screen.getByRole('main', { name: 'Agenda item' }),
      ).toHaveTextContent('Alpha')
    })
    expect(
      screen.getByRole('button', {
        name: 'Make Alpha current',
      }),
    ).toBeTruthy()
    expect(
      within(agenda()).queryByRole('button', {
        name: 'Make Alpha current',
      }),
    ).toBeNull()

    // Browsing itself never triggered the Focus API.
    expect(
      vi.mocked(meetingsApi.focusMeetingItem),
    ).not.toHaveBeenCalled()
  })

  it('shows Make current only while a non-current item is selected, and hides it for the current item', async () => {
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 2 }),
      BASE_ITEMS,
    )
    renderLivePage(fake)
    await waitForLive()

    // Selected === current (Beta): no "Make current", no
    // "Return to current"; the normal Current lifecycle
    // controls are visible.
    expect(
      screen.queryByRole('button', {
        name: 'Make Beta current',
      }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', {
        name: 'Return to current',
      }),
    ).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Mark Beta as done' }),
    ).toBeTruthy()

    // Select a non-current item: both the navigation-only
    // "Return to current" and the domain-mutating "Make current"
    // become visible, and the current-item lifecycle controls
    // (Done / Follow up) do NOT operate on the viewed item.
    fireEvent.click(selectRow('Alpha'))
    await waitFor(() => {
      expect(
        screen.getByRole('main', { name: 'Agenda item' }),
      ).toHaveTextContent('Alpha')
    })
    expect(
      screen.getByRole('button', { name: 'Return to current' }),
    ).toBeTruthy()
    expect(
      screen.getByRole('button', {
        name: 'Make Alpha current',
      }),
    ).toBeTruthy()
    expect(
      screen.queryByRole('button', { name: 'Mark Alpha as done' }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', {
        name: 'Schedule follow-up for Alpha',
      }),
    ).toBeNull()

    // The Make-current availability mirrors the existing Focus
    // contract, which accepts an item of ANY outcome: it is
    // offered for the completed item Alpha as well.
    fireEvent.click(selectRow('Omega'))
    await waitFor(() => {
      expect(
        screen.getByRole('main', { name: 'Agenda item' }),
      ).toHaveTextContent('Omega')
    })
    expect(
      screen.getByRole('button', {
        name: 'Make Omega current',
      }),
    ).toBeTruthy()

    // Browsing alone never mutated anything.
    expect(
      vi.mocked(meetingsApi.focusMeetingItem),
    ).not.toHaveBeenCalled()
  })

  it('renders divergence actions as compact controls below the metadata', async () => {
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 2 }),
      BASE_ITEMS,
    )
    renderLivePage(fake)
    await waitForLive()

    fireEvent.click(selectRow('Alpha'))
    await waitFor(() => {
      expect(
        workspace().getByRole('heading', { name: 'Alpha' }),
      ).toBeVisible()
    })

    const returnToCurrent = workspace().getByRole('button', {
      name: 'Return to current',
    })
    const makeCurrent = workspace().getByRole('button', {
      name: 'Make Alpha current',
    })
    const actionRow = returnToCurrent.parentElement
    const title = workspace().getByRole('heading', {
      name: 'Alpha',
    })

    expect(returnToCurrent).toHaveClass(
      'h-8',
      'gap-1.5',
      'rounded-[10px]',
      'border-default',
      'bg-surface',
      'px-3',
      'text-[13px]!',
      'font-medium!',
      'text-text-muted',
      'hover:bg-surface-hover',
      'focus-visible:ring-2',
      'focus-visible:ring-focus',
    )
    expect(makeCurrent).toHaveClass(
      'h-8',
      'gap-1.5',
      'rounded-[10px]',
      'border-accent',
      'bg-accent-subtle',
      'px-3',
      'text-[13px]!',
      'font-medium!',
      'text-accent-text',
      'hover:border-accent-hover',
      'hover:text-accent',
      'focus-visible:ring-2',
      'focus-visible:ring-focus',
    )
    expect(returnToCurrent).not.toHaveClass('bg-accent')
    expect(makeCurrent).not.toHaveClass(
      'bg-accent',
      'font-semibold',
      'text-white',
    )
    expect(
      returnToCurrent.querySelector(
        '.material-symbols-outlined',
      ),
    ).toHaveClass('text-[14px]!')
    expect(
      makeCurrent.querySelector('.material-symbols-outlined'),
    ).toHaveClass('text-[14px]!')
    expect(actionRow).toHaveClass('mt-3', 'gap-2')
    expect(title).toHaveClass('mt-3', 'text-2xl')
    expect(
      screen.getByRole('button', { name: 'End meeting' }),
    ).toHaveClass('h-9', 'text-sm')
  })

  it('Make current on a non-current item invokes the canonical Focus action once and converges selection and current', async () => {
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 2 }),
      BASE_ITEMS,
    )

    // Server effect of Focus on Alpha: the persisted current
    // pointer moves to Alpha; Focus never mutates any outcome,
    // so Alpha stays done and Beta stays not_discussed.
    vi.mocked(
      meetingsApi.focusMeetingItem,
    ).mockImplementation((id: number) => {
      fake.meeting = {
        ...fake.meeting,
        currentMeetingItemId: id,
      }
      return Promise.resolve(
        fake.items.find((item) => item.id === id)!,
      )
    })

    renderLivePage(fake)
    await waitForLive()

    // Browse to the completed non-current item Alpha.
    fireEvent.click(selectRow('Alpha'))
    await waitFor(() => {
      expect(
        screen.getByRole('main', { name: 'Agenda item' }),
      ).toHaveTextContent('Alpha')
    })

    // Click "Make current" — the domain mutation acts on the
    // SELECTED item (not the current one).
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Make Alpha current',
      }),
    )

    // The canonical Focus action is invoked exactly once, for
    // the selected item only.
    await waitFor(() => {
      expect(
        vi.mocked(meetingsApi.focusMeetingItem),
      ).toHaveBeenCalledTimes(1)
      expect(
        vi.mocked(meetingsApi.focusMeetingItem),
      ).toHaveBeenCalledWith(1)
    })

    // Current moved to Alpha: the rail's "Current" indicator
    // follows, the Selected-vs-Current divergence is gone, and
    // both the "Return to current" and "Make current" actions
    // disappear once selected === current.
    await waitFor(() => {
      expect(rowCurrent('Alpha')).toBeTruthy()
    })
    expect(
      itemRow('Alpha').queryByText('Selected', { exact: true }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', {
        name: 'Return to current',
      }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', {
        name: 'Make Alpha current',
      }),
    ).toBeNull()

    // The selection remains on Alpha and the Current
    // lifecycle controls are exposed again. Alpha is already
    // resolved (done), so the outcome is presented as STATE
    // ("Done") and scheduling remains available — not another
    // Done button.
    expect(
      selectRow('Alpha').getAttribute('aria-pressed'),
    ).toBe('true')
    expect(
      screen.queryByRole('button', { name: 'Mark Alpha as done' }),
    ).toBeNull()
    expect(
      screen.getByText('Done', { exact: true }),
    ).toBeTruthy()
    expect(
      screen.getByRole('button', {
        name: 'Schedule follow-up for Alpha',
      }),
    ).toBeTruthy()

    // Focus never mutated an outcome: Alpha stays resolved
    // (done), Beta stays open.
    expect(
      itemRow('Alpha').getByText('Completed', { exact: true }),
    ).toBeTruthy()
    expect(
      itemRow('Beta').getByText('Open', { exact: true }),
    ).toBeTruthy()
  })

  it('Make current on an open non-current item follows the same contract', async () => {
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 2 }),
      BASE_ITEMS,
    )

    vi.mocked(
      meetingsApi.focusMeetingItem,
    ).mockImplementation((id: number) => {
      fake.meeting = {
        ...fake.meeting,
        currentMeetingItemId: id,
      }
      return Promise.resolve(
        fake.items.find((item) => item.id === id)!,
      )
    })

    renderLivePage(fake)
    await waitForLive()

    // Browse to the open non-current item Omega (id 3).
    fireEvent.click(selectRow('Omega'))
    await waitFor(() => {
      expect(
        screen.getByRole('main', { name: 'Agenda item' }),
      ).toHaveTextContent('Omega')
    })

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Make Omega current',
      }),
    )

    // Focus acts on the selected item (Omega), exactly once.
    await waitFor(() => {
      expect(
        vi.mocked(meetingsApi.focusMeetingItem),
      ).toHaveBeenCalledWith(3)
    })
    expect(
      vi.mocked(meetingsApi.focusMeetingItem),
    ).toHaveBeenCalledTimes(1)

    // Selected and Current converge on Omega.
    await waitFor(() => {
      expect(rowCurrent('Omega')).toBeTruthy()
    })
    expect(
      screen.queryByRole('button', {
        name: 'Return to current',
      }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', {
        name: 'Make Omega current',
      }),
    ).toBeNull()
    // Focus never changed Omega's outcome: it remains open.
    expect(
      itemRow('Omega').getByText('Open', { exact: true }),
    ).toBeTruthy()
  })

  it('a rejected Make current keeps selection and current and surfaces the existing action error', async () => {
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 2 }),
      BASE_ITEMS,
    )

    // Simulate a domain rejection (e.g., an invariant the
    // Focus contract enforces): the call fails, the server
    // state is untouched.
    vi.mocked(
      meetingsApi.focusMeetingItem,
    ).mockRejectedValue(
      new Error('The meeting is no longer live.'),
    )

    renderLivePage(fake)
    await waitForLive()

    // Browse to a non-current item, then attempt Make current.
    fireEvent.click(selectRow('Alpha'))
    await waitFor(() => {
      expect(
        screen.getByRole('main', { name: 'Agenda item' }),
      ).toHaveTextContent('Alpha')
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Make Alpha current',
      }),
    )

    // The failure is surfaced through the existing Live
    // Meeting action-error treatment.
    await waitFor(() => {
      expect(
        screen.getByRole('alert').textContent,
      ).toContain('The meeting is no longer live.')
    })

    // Selection and Current are both preserved: the user is
    // still viewing Alpha, the actual current is still Beta,
    // and the divergence controls remain available.
    expect(
      selectRow('Alpha').getAttribute('aria-pressed'),
    ).toBe('true')
    expect(rowCurrent('Beta')).toBeTruthy()
    expect(
      screen.getByRole('button', {
        name: 'Return to current',
      }),
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Make Alpha current' }),
    ).toBeTruthy()
  })

  it('Make current is not double-submitted while the first attempt is pending', async () => {
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 2 }),
      BASE_ITEMS,
    )

    let resolveFocus: (
      item: ApiMeetingItem,
    ) => void = () => {
      return undefined
    }
    vi.mocked(
      meetingsApi.focusMeetingItem,
    ).mockImplementation(
      (id: number) =>
        new Promise<ApiMeetingItem>((resolve) => {
          resolveFocus = () =>
            resolve(
              fake.items.find((item) => item.id === id)!,
            )
        }),
    )

    renderLivePage(fake)
    await waitForLive()

    fireEvent.click(selectRow('Alpha'))
    await waitFor(() => {
      expect(
        screen.getByRole('main', { name: 'Agenda item' }),
      ).toHaveTextContent('Alpha')
    })

    // First click starts the Focus call; the button is now
    // pending and disabled.
    const makeCurrent = screen.getByRole('button', {
      name: 'Make Alpha current',
    })
    fireEvent.click(makeCurrent)

    expect(
      vi.mocked(meetingsApi.focusMeetingItem),
    ).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole('button', {
        name: 'Make Alpha current',
      }),
    ).toBeDisabled()

    // A second click while pending does not resubmit.
    fireEvent.click(
      screen.getByRole('button', { name: 'Make Alpha current' }),
    )
    expect(
      vi.mocked(meetingsApi.focusMeetingItem),
    ).toHaveBeenCalledTimes(1)

    // Completing the pending call moves the persisted current
    // pointer (server state) and converges selection and
    // current on Alpha.
    fake.meeting = { ...fake.meeting, currentMeetingItemId: 1 }
    resolveFocus(makeItem({ id: 1 }))

    await waitFor(() => {
      expect(rowCurrent('Alpha')).toBeTruthy()
    })
    expect(
      screen.queryByRole('button', {
        name: 'Make Alpha current',
      }),
    ).toBeNull()
  })

  it('initializes the selection to the actual current item', async () => {
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 2 }),
      BASE_ITEMS,
    )
    renderLivePage(fake)
    await waitForLive()

    // The workspace shows the current item (Beta) on entry.
    expect(
      screen.getByRole('main', { name: 'Agenda item' }),
    ).toHaveTextContent('Beta')
    // The rail marks Beta as current.
    expect(rowCurrent('Beta')).toBeTruthy()
    // The selection control for Beta is pressed (it is selected).
    expect(
      selectRow('Beta').getAttribute('aria-pressed'),
    ).toBe('true')
    // "Return to current" is absent while selected === current.
    expect(
      screen.queryByRole('button', {
        name: 'Return to current',
      }),
    ).toBeNull()
  })

  it('selecting a completed non-current item shows it without touching current or outcomes', async () => {
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 2 }),
      BASE_ITEMS,
    )
    renderLivePage(fake)
    await waitForLive()

    // Select the completed item Alpha (id 1, outcome done).
    fireEvent.click(selectRow('Alpha'))

    // The detail pane now shows Alpha's content.
    await waitFor(() => {
      expect(
        screen.getByRole('main', { name: 'Agenda item' }),
      ).toHaveTextContent('Alpha')
    })

    // The ACTUAL current item is still Beta: the rail's
    // "Current" indicator stays on Beta, and the Focus/Done
    // lifecycle target is unchanged.
    expect(rowCurrent('Beta')).toBeTruthy()
    expect(
      itemRow('Alpha').queryByText('Current', { exact: true }),
    ).toBeNull()

    // Selecting did NOT trigger any domain mutation.
    expect(
      vi.mocked(meetingsApi.focusMeetingItem),
    ).not.toHaveBeenCalled()
    expect(
      vi.mocked(meetingsApi.markMeetingItemDone),
    ).not.toHaveBeenCalled()
    expect(
      vi.mocked(meetingsApi.reopenMeetingItem),
    ).not.toHaveBeenCalled()
    expect(
      vi.mocked(
        meetingsApi.markMeetingItemFollowUp,
      ),
    ).not.toHaveBeenCalled()

    // Outcomes are unchanged (Alpha still resolved, Beta open).
    await waitFor(() => {
      expect(
        itemRow('Alpha').getByText('Completed', {
          exact: true,
        }),
      ).toBeTruthy()
      expect(
        itemRow('Beta').getByText('Open', { exact: true }),
      ).toBeTruthy()
    })

    // The selected (non-current) item keeps its accessible state
    // without adding a redundant visible label.
    expect(
      itemRow('Alpha').queryByText('Selected', { exact: true }),
    ).toBeNull()
    expect(
      selectRow('Alpha').getAttribute('aria-pressed'),
    ).toBe('true')

    // While viewing a non-current item, the lifecycle
    // controls do not operate on it: none are shown (neither
    // the open-outcome Done/Follow up pair nor the
    // resolved-state alternative transitions).
    expect(
      screen.queryByRole('button', {
        name: 'Mark Alpha as done',
      }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', {
        name: 'Schedule follow-up for Alpha',
      }),
    ).toBeNull()
    expect(
      workspace().getByRole('button', {
        name: 'Reopen Alpha',
      }),
    ).toBeTruthy()
  })

  it('reopens a selected Done item while preserving another Current and the local selection', async () => {
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 2 }),
      BASE_ITEMS,
    )
    vi.mocked(meetingsApi.reopenMeetingItem).mockImplementation(
      (id: number) => {
        fake.items = fake.items.map((item) =>
          item.id === id
            ? { ...item, outcome: 'not_discussed' as const }
            : item,
        )
        return Promise.resolve(
          fake.items.find((item) => item.id === id)!,
        )
      },
    )
    renderLivePage(fake)
    await waitForLive()

    fireEvent.click(selectRow('Alpha'))
    fireEvent.click(
      workspace().getByRole('button', { name: 'Reopen Alpha' }),
    )

    await waitFor(() => {
      expect(
        itemRow('Alpha').getByText('Open', { exact: true }),
      ).toBeTruthy()
    })
    expect(fake.meeting.currentMeetingItemId).toBe(2)
    expect(rowCurrent('Beta')).toBeTruthy()
    expect(selectRow('Alpha').getAttribute('aria-pressed')).toBe('true')
    expect(
      screen.getByRole('main', { name: 'Agenda item' }),
    ).toHaveTextContent('Alpha')
    expect(
      screen.getByRole('button', { name: 'Return to current' }),
    ).toBeTruthy()
    expect(
      vi.mocked(meetingsApi.reopenMeetingItem),
    ).toHaveBeenCalledWith(1)

    fireEvent.click(
      screen.getByRole('button', { name: 'Return to current' }),
    )
    await waitFor(() => {
      expect(
        screen.getByRole('main', { name: 'Agenda item' }),
      ).toHaveTextContent('Beta')
    })
    expect(rowCurrent('Beta')).toBeTruthy()
  })

  it('reopens a selected Done item while preserving null Current', async () => {
    const only = makeItem({ id: 1, title: 'Only', outcome: 'done' })
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: null }),
      [only],
    )
    vi.mocked(meetingsApi.reopenMeetingItem).mockImplementation(
      (id: number) => {
        fake.items = fake.items.map((item) =>
          item.id === id
            ? { ...item, outcome: 'not_discussed' as const }
            : item,
        )
        return Promise.resolve(fake.items[0])
      },
    )
    renderLivePage(fake)
    await waitForLive()

    fireEvent.click(selectRow('Only'))
    fireEvent.click(
      workspace().getByRole('button', { name: 'Reopen Only' }),
    )

    await waitFor(() => {
      expect(
        itemRow('Only').getByText('Open', { exact: true }),
      ).toBeTruthy()
    })
    expect(fake.meeting.currentMeetingItemId).toBeNull()
    expect(selectRow('Only').getAttribute('aria-pressed')).toBe('true')
    expect(
      screen.getByRole('main', { name: 'Agenda item' }),
    ).toHaveTextContent('Only')
    expect(
      screen.queryAllByText('Current', { exact: true }),
    ).toHaveLength(0)
    expect(
      screen.queryByRole('button', { name: 'Return to current' }),
    ).toBeNull()
  })

  it('selecting an open non-current item behaves the same way', async () => {
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 2 }),
      BASE_ITEMS,
    )
    renderLivePage(fake)
    await waitForLive()

    // Select the upcoming/open item Omega (id 3).
    fireEvent.click(selectRow('Omega'))

    await waitFor(() => {
      expect(
        screen.getByRole('main', { name: 'Agenda item' }),
      ).toHaveTextContent('Omega')
    })

    // Current is still Beta; nothing was mutated.
    expect(rowCurrent('Beta')).toBeTruthy()
    expect(
      vi.mocked(meetingsApi.focusMeetingItem),
    ).not.toHaveBeenCalled()

    // Omega is selected, not current. Selection remains exposed
    // through the row control rather than visible status text.
    expect(
      itemRow('Omega').queryByText('Selected', { exact: true }),
    ).toBeNull()
    expect(
      selectRow('Omega').getAttribute('aria-pressed'),
    ).toBe('true')
    expect(
      itemRow('Omega').queryByText('Current', {
        exact: true,
      }),
    ).toBeNull()
  })

  it('Return to current restores the selection without any domain mutation', async () => {
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 2 }),
      BASE_ITEMS,
    )
    renderLivePage(fake)
    await waitForLive()

    // Navigate away from current.
    fireEvent.click(selectRow('Omega'))
    await waitFor(() => {
      expect(
        screen.getByRole('main', { name: 'Agenda item' }),
      ).toHaveTextContent('Omega')
    })

    // The return action is now available.
    const returnButton = screen.getByRole('button', {
      name: 'Return to current',
    })
    fireEvent.click(returnButton)

    // Selection returns to the actual current item (Beta).
    await waitFor(() => {
      expect(
        screen.getByRole('main', { name: 'Agenda item' }),
      ).toHaveTextContent('Beta')
    })
    expect(rowCurrent('Beta')).toBeTruthy()
    expect(
      selectRow('Beta').getAttribute('aria-pressed'),
    ).toBe('true')

    // No domain mutation occurred from returning.
    expect(
      vi.mocked(meetingsApi.focusMeetingItem),
    ).not.toHaveBeenCalled()
    expect(
      vi.mocked(meetingsApi.markMeetingItemDone),
    ).not.toHaveBeenCalled()

    // The return action disappears again once selected === current.
    expect(
      screen.queryByRole('button', {
        name: 'Return to current',
      }),
    ).toBeNull()
  })

  it('follows the server Current across Sections after Done without calculating a successor', async () => {
    const items = [
      makeItem({ id: 1, title: 'Alpha', position: 0, outcome: 'done' }),
      makeItem({ id: 2, title: 'Beta', position: 1 }),
      makeItem({
        id: 3,
        title: 'Skipped follow-up',
        position: 2,
        outcome: 'follow_up',
      }),
      makeItem({
        id: 4,
        meetingSectionId: 2,
        title: 'Cross-section next',
        position: 0,
      }),
    ]
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 2 }),
      items,
    )

    // Server effect of Done on the current Beta: Beta -> done,
    // pointer advances across the Section boundary to item 4. The
    // client follows this pointer and never computes agenda order.
    vi.mocked(
      meetingsApi.markMeetingItemDone,
    ).mockImplementation((id: number) => {
      fake.items = fake.items.map((item) =>
        item.id === id
          ? { ...item, outcome: 'done' as const }
          : item,
      )
      fake.meeting = {
        ...fake.meeting,
        currentMeetingItemId: 4,
      }
      return Promise.resolve(
        fake.items.find((item) => item.id === id)!,
      )
    })

    renderLivePage(fake, [
      makeSection(),
      makeSection({ id: 2, name: 'Decisions', position: 1 }),
    ])
    await waitForLive()

    // The user is following the current item (Beta). Resolving it
    // advances current to the server-selected item; selection follows.
    fireEvent.click(
      workspace().getByRole('button', {
        name: 'Mark Beta as done',
      }),
    )

    await waitFor(() => {
      expect(
        screen.getByRole('main', { name: 'Agenda item' }),
      ).toHaveTextContent('Cross-section next')
    })
    expect(rowCurrent('Cross-section next')).toBeTruthy()
    expect(
      selectRow('Cross-section next').getAttribute('aria-pressed'),
    ).toBe('true')
  })

  it('a following selection moves with the current pointer when it advances via Done', async () => {
    // Complements the explicit-selection-preserved case: when the
    // user IS following the current item, an action that advances
    // the pointer re-points the selection at the new current item.
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 2 }),
      BASE_ITEMS,
    )

    vi.mocked(
      meetingsApi.markMeetingItemDone,
    ).mockImplementation((id: number) => {
      fake.items = fake.items.map((item) =>
        item.id === id
          ? { ...item, outcome: 'done' as const }
          : item,
      )
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

    // Following the current item (Beta).
    expect(
      selectRow('Beta').getAttribute('aria-pressed'),
    ).toBe('true')

    fireEvent.click(
      workspace().getByRole('button', {
        name: 'Mark Beta as done',
      }),
    )

    // Current advanced to Omega and the selection followed it.
    await waitFor(() => {
      expect(rowCurrent('Omega')).toBeTruthy()
    })
    expect(
      selectRow('Omega').getAttribute('aria-pressed'),
    ).toBe('true')
    expect(
      screen.getByRole('main', { name: 'Agenda item' }),
    ).toHaveTextContent('Omega')
    expect(
      screen.queryByRole('button', {
        name: 'Return to current',
      }),
    ).toBeNull()
  })

  it('follows the refreshed server Current after successful scheduling', async () => {
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 2 }),
      BASE_ITEMS,
    )
    vi.mocked(
      meetingsApi.scheduleMeetingItemFollowUp,
    ).mockImplementation(async (id, input) => {
      fake.items = fake.items.map((item) =>
        item.id === id
          ? {
              ...item,
              outcome: 'follow_up' as const,
              followUpSchedule: FOLLOW_UP_SCHEDULE,
            }
          : item,
      )
      fake.meeting = {
        ...fake.meeting,
        currentMeetingItemId: 3,
      }
      expect(input).toEqual({
        targetMeetingId: 23,
        targetMeetingSectionId: 29,
      })
      return FOLLOW_UP_SCHEDULE
    })

    renderLivePage(fake)
    await waitForLive()

    fireEvent.click(
      workspace().getByRole('button', {
        name: 'Schedule follow-up for Beta',
      }),
    )
    await waitFor(() => {
      expect(screen.getByLabelText('Meeting')).toHaveValue('23')
      expect(screen.getByLabelText('Section')).toHaveValue('29')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }))

    await waitFor(() => {
      expect(
        screen.getByRole('main', { name: 'Agenda item' }),
      ).toHaveTextContent('Omega')
    })
    expect(rowCurrent('Omega')).toBeTruthy()
    expect(selectRow('Omega').getAttribute('aria-pressed')).toBe('true')
    expect(fake.meeting.currentMeetingItemId).toBe(3)
    expect(fake.items[1].outcome).toBe('follow_up')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(
      screen.queryByRole('button', {
        name: 'Schedule follow-up for Beta',
      }),
    ).toBeNull()
    expect(
      vi.mocked(
        meetingsApi.markMeetingItemFollowUp,
      ),
    ).not.toHaveBeenCalled()

    fireEvent.click(selectRow('Beta'))
    await waitFor(() => {
      expect(
        screen.getByRole('main', { name: 'Agenda item' }),
      ).toHaveTextContent('Scheduled for FG Weekly')
    })
  })

  it('keeps the resolved item selected when Done clears Current', async () => {
    // Edge: one open item is Current, the user is following it,
    // Done resolves it, no not_discussed item remains, so Current
    // becomes null. The resolved item remains selected so its detail
    // context stays visible, while no item is marked Current.
    const single = makeItem({
      id: 1,
      title: 'Only',
      position: 0,
    })
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 1 }),
      [single],
    )

    // Server effect of Done on the current (and only) item:
    // outcome done, pointer null (no not_discussed items remain).
    vi.mocked(
      meetingsApi.markMeetingItemDone,
    ).mockImplementation((id: number) => {
      fake.items = fake.items.map((item) =>
        item.id === id
          ? { ...item, outcome: 'done' as const }
          : item,
      )
      fake.meeting = {
        ...fake.meeting,
        currentMeetingItemId: null,
      }
      return Promise.resolve(
        fake.items.find((item) => item.id === id)!,
      )
    })

    renderLivePage(fake)
    await waitForLive()

    // The user is following the current item.
    expect(
      selectRow('Only').getAttribute('aria-pressed'),
    ).toBe('true')

    fireEvent.click(
      workspace().getByRole('button', {
        name: 'Mark Only as done',
      }),
    )

    // Current cleared, but local Selected remains on the source.
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Only' }),
      ).toBeVisible()
    })
    expect(
      selectRow('Only').getAttribute('aria-pressed'),
    ).toBe('true')
    // No current to return to: the navigation affordance is gone.
    expect(
      screen.queryByRole('button', {
        name: 'Return to current',
      }),
    ).toBeNull()
    // The rail shows the resolved outcome on the only row.
    expect(itemRow('Only').getByText('Completed', { exact: true })).toBeTruthy()
    // No row is marked current anymore.
    expect(
      screen.queryAllByText('Current', { exact: true }),
    ).toHaveLength(0)
  })

  it('keeps selection on the source when Done fails', async () => {
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 2 }),
      BASE_ITEMS,
    )
    vi.mocked(meetingsApi.markMeetingItemDone).mockRejectedValue(
      new Error('Done failed.'),
    )
    renderLivePage(fake)
    await waitForLive()

    fireEvent.click(
      workspace().getByRole('button', {
        name: 'Mark Beta as done',
      }),
    )

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Done failed.')
    })
    expect(rowCurrent('Beta')).toBeTruthy()
    expect(selectRow('Beta').getAttribute('aria-pressed')).toBe('true')
    expect(
      screen.getByRole('main', { name: 'Agenda item' }),
    ).toHaveTextContent('Beta')
  })

  it('Make current is still offered while viewing an item with no current item', async () => {
    // Edge: Current is null (e.g. after End cleared the pointer… or
    // after the last open item was resolved) while the user has
    // explicitly navigated to an item. The "Make current" escape
    // hatch must remain available for that viewed item (the Focus
    // contract accepts any outcome and needs no existing current),
    // while "Return to current" is absent: a navigation action
    // with no target must not be presented as actionable.
    const items = [
      makeItem({ id: 1, title: 'Alpha', position: 0, outcome: 'done' }),
      makeItem({ id: 2, title: 'Beta', position: 1, outcome: 'done' }),
    ]
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: null }),
      items,
    )

    renderLivePage(fake)
    await waitForLive()

    // Fresh load with no current: the detail pane is the calm
    // no-current state.
    expect(
      screen.getByRole('main', { name: 'Agenda item' }),
    ).toHaveTextContent('No current item')

    // Explicitly browse the resolved Beta.
    fireEvent.click(selectRow('Beta'))
    await waitFor(() => {
      expect(
        screen.getByRole('heading', {
          name: 'Beta',
        }),
      ).toBeVisible()
    })

    // Divergence from (nonexistent) current: Make current is the
    // deliberate escape hatch and stays offered for the viewed
    // item.
    const makeCurrent = screen.getByRole('button', {
      name: 'Make Beta current',
    })
    expect(makeCurrent).toBeVisible()

    // But there is no current to return to.
    expect(
      screen.queryByRole('button', {
        name: 'Return to current',
      }),
    ).toBeNull()

    // Clicking Make current calls the canonical Focus action once
    // (no outcome mutation) and the pointer converges on Beta.
    vi.mocked(
      meetingsApi.focusMeetingItem,
    ).mockImplementation(async (id: number) => {
      fake.meeting = {
        ...fake.meeting,
        currentMeetingItemId: id,
      }
      return fake.items.find((item) => item.id === id)!
    })
    fireEvent.click(makeCurrent)

    await waitFor(() => {
      expect(
        vi.mocked(meetingsApi.focusMeetingItem),
      ).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(rowCurrent('Beta')).toBeTruthy()
    })
    // Selection and current converged: the divergence hint is gone.
    expect(
      screen.queryByRole('button', {
        name: 'Return to current',
      }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', {
        name: 'Make Beta current',
      }),
    ).toBeNull()
  })
describe('Live Meeting resolution controls follow the current outcome', () => {
  function expectOutcomeIcon(
    control: HTMLElement,
    iconName: 'check' | 'refresh' | 'event_repeat',
  ) {
    const icon = control.querySelector<HTMLElement>(
      '.material-symbols-outlined[aria-hidden="true"]',
    )
    expect(icon).not.toBeNull()
    expect(icon).toHaveClass('text-[16px]')
    expect(icon).toHaveTextContent(iconName)
    expect(icon).not.toHaveTextContent(/^(followup|follow_up)$/i)
  }

  it('open current item offers Done and Schedule follow-up as actions', async () => {
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 2 }),
      OUTCOME_ITEMS,
    )
    renderLivePage(fake)
    await waitForLive()

    // Current Beta is open (not_discussed): both resolution
    // actions are offered, no state presentation.
    const doneAction = screen.getByRole('button', {
      name: 'Mark Beta as done',
    })
    const followUpAction = screen.getByRole('button', {
      name: 'Schedule follow-up for Beta',
    })
    expect(doneAction).toBeTruthy()
    expect(followUpAction).toBeTruthy()
    expectOutcomeIcon(doneAction, 'check')
    expectOutcomeIcon(followUpAction, 'event_repeat')
    expect(
      screen.queryByRole('button', {
        name: 'Change Beta to follow-up',
      }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Change Beta to done' }),
    ).toBeNull()
  })

  it('done current item reports Done as state and offers scheduling', async () => {
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 1 }),
      OUTCOME_ITEMS,
    )
    renderLivePage(fake)
    await waitForLive()

    // Current Alpha is already done: the outcome reads as state,
    // the Done action is NOT offered again, and only the
    // alternative transition is actionable.
    const doneState = screen.getByText('Done', { exact: true })
    expect(doneState).toBeTruthy()
    expectOutcomeIcon(doneState, 'check')
    const reopenAction = screen.getByRole('button', {
      name: 'Reopen Alpha',
    })
    expect(reopenAction).toHaveClass('border-default', 'bg-surface')
    expect(reopenAction).not.toHaveClass('bg-success')
    expect(
      screen.queryByRole('button', { name: 'Mark Alpha as done' }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', {
        name: 'Mark Alpha as follow-up',
      }),
    ).toBeNull()
    const scheduleFollowUp = screen.getByRole('button', {
      name: 'Schedule follow-up for Alpha',
    })
    expect(scheduleFollowUp).toBeTruthy()
    // A resolved item may remain Current: the rail still marks
    // it Current with its outcome hint.
    expect(rowCurrent('Alpha')).toBeTruthy()
    expect(
      itemRow('Alpha').getByText('Completed', { exact: true }),
    ).toBeTruthy()
  })

  it('follow-up current item reports Follow-up as state and offers only Change to Done', async () => {
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 3 }),
      OUTCOME_ITEMS,
    )
    renderLivePage(fake)
    await waitForLive()

    // Current Omega is already resolved with follow-up: the
    // outcome reads as state, the Follow up action is NOT
    // offered again, and only the alternative transition is
    // actionable.
    const followUpState = screen.getByText('Follow-up', {
      exact: true,
    })
    expect(followUpState).toBeTruthy()
    expectOutcomeIcon(followUpState, 'refresh')
    expect(
      screen.queryByRole('button', {
        name: 'Mark Omega as follow-up',
      }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Mark Omega as done' }),
    ).toBeNull()
    const changeToDone = screen.getByRole('button', {
      name: 'Change Omega to done',
    })
    expect(changeToDone).toBeTruthy()
    expectOutcomeIcon(changeToDone, 'check')
    expect(
      screen.getByRole('button', {
        name: 'Schedule follow-up for Omega',
      }),
    ).toBeTruthy()
    // No internal outcome identifier may leak into visible text.
    expect(
      screen.getByRole('main', { name: 'Agenda item' }),
    ).not.toHaveTextContent('FOLLOW_UP')
    // Current + Follow-up is a valid combination: the rail still
    // marks it Current with its follow-up hint.
    expect(rowCurrent('Omega')).toBeTruthy()
    expect(
      itemRow('Omega').getByText('Resolved with follow-up', {
        exact: true,
      }),
    ).toBeTruthy()
  })

  describe('Live follow-up scheduling', () => {
    it('opens and cancels without mutating the source item', async () => {
      const fake = new FakeLiveMeeting(
        makeMeeting({ currentMeetingItemId: 2 }),
        BASE_ITEMS,
      )
      renderLivePage(fake)
      await waitForLive()

      const trigger = screen.getByRole('button', {
        name: 'Schedule follow-up for Beta',
      })
      fireEvent.click(trigger)

      expect(
        screen.getByRole('dialog', { name: 'Schedule follow-up' }),
      ).toBeTruthy()
      expect(
        meetingsApi.getMeetingItemFollowUpTargets,
      ).toHaveBeenCalledWith(2)
      expect(meetingsApi.scheduleMeetingItemFollowUp).not.toHaveBeenCalled()
      expect(meetingsApi.markMeetingItemFollowUp).not.toHaveBeenCalled()
      expect(fake.items[1].outcome).toBe('not_discussed')
      expect(fake.meeting.currentMeetingItemId).toBe(2)
      expect(selectRow('Beta').getAttribute('aria-pressed')).toBe('true')

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(meetingsApi.scheduleMeetingItemFollowUp).not.toHaveBeenCalled()
      expect(fake.items[1].outcome).toBe('not_discussed')
      await waitFor(() => expect(trigger).toHaveFocus())

      fireEvent.click(trigger)
      await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(screen.queryByRole('dialog')).toBeNull()
      await waitFor(() => expect(trigger).toHaveFocus())
    })

    it('uses only server recommendations and resets Section with Meeting', async () => {
      const fake = new FakeLiveMeeting(
        makeMeeting({ currentMeetingItemId: 2 }),
        BASE_ITEMS,
      )
      renderLivePage(fake)
      await waitForLive()
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Schedule follow-up for Beta',
        }),
      )

      await waitFor(() => {
        expect(screen.getByLabelText('Meeting')).toHaveValue('23')
        expect(screen.getByLabelText('Section')).toHaveValue('29')
      })

      fireEvent.change(screen.getByLabelText('Meeting'), {
        target: { value: '24' },
      })
      expect(screen.getByLabelText('Section')).toHaveValue('')
      expect(screen.getByRole('button', { name: 'Schedule' })).toBeDisabled()

      fireEvent.change(screen.getByLabelText('Section'), {
        target: { value: '32' },
      })
      expect(screen.getByRole('button', { name: 'Schedule' })).toBeEnabled()

      fireEvent.change(screen.getByLabelText('Meeting'), {
        target: { value: '23' },
      })
      expect(screen.getByLabelText('Section')).toHaveValue('29')
    })

    it('leaves both fields empty when the server recommends no Meeting', async () => {
      vi.mocked(
        meetingsApi.getMeetingItemFollowUpTargets,
      ).mockResolvedValue({
        ...FOLLOW_UP_TARGETS,
        recommendedMeetingId: null,
      })
      const fake = new FakeLiveMeeting(
        makeMeeting({ currentMeetingItemId: 2 }),
        BASE_ITEMS,
      )
      renderLivePage(fake)
      await waitForLive()
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Schedule follow-up for Beta',
        }),
      )

      await waitFor(() => expect(screen.getByLabelText('Meeting')).toHaveValue(''))
      expect(screen.getByLabelText('Section')).toHaveValue('')
      expect(screen.getByLabelText('Section')).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Schedule' })).toBeDisabled()
    })

    it('shows the no-candidates state and disables Schedule', async () => {
      vi.mocked(
        meetingsApi.getMeetingItemFollowUpTargets,
      ).mockResolvedValue({
        recommendedMeetingId: null,
        meetings: [],
      })
      const fake = new FakeLiveMeeting(
        makeMeeting({ currentMeetingItemId: 2 }),
        BASE_ITEMS,
      )
      renderLivePage(fake)
      await waitForLive()
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Schedule follow-up for Beta',
        }),
      )

      await waitFor(() => {
        expect(screen.getByText('No planned meetings available.')).toBeTruthy()
      })
      expect(
        screen.getByText('Create or schedule a future meeting first.'),
      ).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Schedule' })).toBeDisabled()
    })

    it('keeps the dialog and selections after a scheduling error', async () => {
      vi.mocked(
        meetingsApi.scheduleMeetingItemFollowUp,
      ).mockRejectedValue(new Error('That item is already scheduled.'))
      const fake = new FakeLiveMeeting(
        makeMeeting({ currentMeetingItemId: 2 }),
        BASE_ITEMS,
      )
      renderLivePage(fake)
      await waitForLive()
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Schedule follow-up for Beta',
        }),
      )
      await waitFor(() => expect(screen.getByLabelText('Meeting')).toHaveValue('23'))
      fireEvent.click(screen.getByRole('button', { name: 'Schedule' }))

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(
          'That item is already scheduled.',
        )
      })
      expect(screen.getByLabelText('Meeting')).toHaveValue('23')
      expect(screen.getByLabelText('Section')).toHaveValue('29')
      expect(fake.items[1].outcome).toBe('not_discussed')
      expect(rowCurrent('Beta')).toBeTruthy()
      expect(selectRow('Beta').getAttribute('aria-pressed')).toBe('true')
      expect(
        screen.getByRole('main', { name: 'Agenda item' }),
      ).toHaveTextContent('Beta')
    })

    it('shows discovery errors without enabling a mutation', async () => {
      vi.mocked(
        meetingsApi.getMeetingItemFollowUpTargets,
      ).mockRejectedValue(new Error('Destinations unavailable.'))
      const fake = new FakeLiveMeeting(
        makeMeeting({ currentMeetingItemId: 2 }),
        BASE_ITEMS,
      )
      renderLivePage(fake)
      await waitForLive()
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Schedule follow-up for Beta',
        }),
      )

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Destinations unavailable.',
        )
      })
      expect(screen.getByRole('dialog')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Schedule' })).toBeDisabled()
      expect(meetingsApi.scheduleMeetingItemFollowUp).not.toHaveBeenCalled()
    })

    it('renders a persisted concrete destination and suppresses retry actions', async () => {
      const scheduledItem = makeItem({
        id: 2,
        title: 'Beta',
        position: 1,
        outcome: 'follow_up',
        followUpSchedule: FOLLOW_UP_SCHEDULE,
      })
      const fake = new FakeLiveMeeting(
        makeMeeting({ currentMeetingItemId: 2 }),
        [BASE_ITEMS[0], scheduledItem, BASE_ITEMS[2]],
      )
      renderLivePage(fake)
      await waitForLive()

      const workspaceElement = screen.getByRole('main', {
        name: 'Agenda item',
      })
      expect(workspaceElement).toHaveTextContent('Scheduled for FG Weekly')
      expect(workspaceElement).toHaveTextContent('For your Info')
      expect(
        screen.queryByRole('button', {
          name: 'Schedule follow-up for Beta',
        }),
      ).toBeNull()
      expect(
        screen.queryByRole('button', { name: 'Change Beta to done' }),
      ).toBeNull()
      expect(meetingsApi.getMeetingItemFollowUpTargets).not.toHaveBeenCalled()
    })
  })
})

})
