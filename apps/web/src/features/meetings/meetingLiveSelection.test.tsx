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
  vi.mocked(
    meetingsApi.markMeetingItemFollowUp,
  ).mockReset()
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
        name: 'Mark Alpha as follow-up',
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

    // The selection remains on Alpha and the normal Current
    // lifecycle controls are exposed again.
    expect(
      selectRow('Alpha').getAttribute('aria-pressed'),
    ).toBe('true')
    expect(
      screen.getByRole('button', { name: 'Mark Alpha as done' }),
    ).toBeTruthy()
    expect(
      screen.getByRole('button', {
        name: 'Mark Alpha as follow-up',
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

    // The selected (non-current) item exposes a distinct
    // "Selected" signal, separate from the "Current" signal.
    expect(
      itemRow('Alpha').getByText('Selected', { exact: true }),
    ).toBeTruthy()

    // While viewing a non-current item, the lifecycle controls
    // (Done / Follow up) do not operate on it: they are not shown.
    expect(
      screen.queryByRole('button', {
        name: 'Mark Alpha as done',
      }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', {
        name: 'Mark Alpha as follow-up',
      }),
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

    // Omega is selected, not current.
    expect(
      itemRow('Omega').getByText('Selected', { exact: true }),
    ).toBeTruthy()
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

  it('when current advances via Done, a user following current follows the new current', async () => {
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 2 }),
      BASE_ITEMS,
    )

    // Server effect of Done on the current Beta: Beta -> done,
    // pointer advances to the next not_discussed item (Omega 3).
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

    // The user is following the current item (Beta). Resolving it
    // advances current to Omega; the selection follows.
    fireEvent.click(
      workspace().getByRole('button', {
        name: 'Mark Beta as done',
      }),
    )

    await waitFor(() => {
      expect(
        screen.getByRole('main', { name: 'Agenda item' }),
      ).toHaveTextContent('Omega')
    })
    expect(rowCurrent('Omega')).toBeTruthy()
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

  it('an explicit selection is preserved when the current pointer moves elsewhere', async () => {
    const fake = new FakeLiveMeeting(
      makeMeeting({ currentMeetingItemId: 2 }),
      BASE_ITEMS,
    )

    renderLivePage(fake)
    await waitForLive()

    // Explicitly navigate to the completed Alpha (NOT the current
    // item). The user is no longer "following" current.
    fireEvent.click(selectRow('Alpha'))
    await waitFor(() => {
      expect(
        screen.getByRole('main', { name: 'Agenda item' }),
      ).toHaveTextContent('Alpha')
    })

    // Now move the current pointer through a lifecycle action on
    // the CURRENT item (Follow-up on Beta): the pointer advances
    // to the next not_discussed item (Omega). The user was NOT
    // following the old current (Beta) — they had explicitly
    // navigated to Alpha — so the explicit selection (Alpha) is
    // preserved and does not jump to the new current.
    vi.mocked(
      meetingsApi.markMeetingItemFollowUp,
    ).mockImplementation((id: number) => {
      fake.items = fake.items.map((item) =>
        item.id === id
          ? { ...item, outcome: 'follow_up' as const }
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

    // Capture the user's explicit selection (Alpha) before the
    // pointer moves.
    expect(
      itemRow('Alpha').getByRole('button', {
        name: 'View item Alpha',
      }).getAttribute('aria-pressed'),
    ).toBe('true')

    // Return to current first (resolution controls only act on
    // the viewed current item), then resolve Beta: the pointer
    // advances to Omega.
    fireEvent.click(
      screen.getByRole('button', { name: 'Return to current' }),
    )
    await waitFor(() => {
      expect(
        screen.getByRole('main', { name: 'Agenda item' }),
      ).toHaveTextContent('Beta')
    })

    fireEvent.click(
      workspace().getByRole('button', {
        name: 'Mark Beta as follow-up',
      }),
    )

    // Current moved to Omega; Beta's explicit outcome is visible
    // now that it is non-current.
    await waitFor(() => {
      expect(rowCurrent('Omega')).toBeTruthy()
    })
    expect(
      itemRow('Beta').getByText('Resolved with follow-up', {
        exact: true,
      }),
    ).toBeTruthy()

    // Browse back to Alpha: selection is purely local navigation.
    // While browsing Alpha (non-current), the actual current stays
    // Omega, the "Selected" signal stays on Alpha, "Return to
    // current" remains available, and no domain call happens from
    // the browsing itself.
    fireEvent.click(selectRow('Alpha'))
    await waitFor(() => {
      expect(
        screen.getByRole('main', { name: 'Agenda item' }),
      ).toHaveTextContent('Alpha')
    })
    expect(
      itemRow('Alpha').getByRole('button', {
        name: 'View item Alpha',
      }).getAttribute('aria-pressed'),
    ).toBe('true')
    expect(
      itemRow('Alpha').getByText('Selected', { exact: true }),
    ).toBeTruthy()
    expect(rowCurrent('Omega')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Return to current' }),
    ).toBeTruthy()
    // Exactly one domain mutation happened (the Follow-up on
    // Beta); browsing triggered none.
    expect(
      vi.mocked(meetingsApi.focusMeetingItem),
    ).not.toHaveBeenCalled()
    expect(
      vi.mocked(meetingsApi.markMeetingItemDone),
    ).not.toHaveBeenCalled()
    expect(
      vi.mocked(
        meetingsApi.markMeetingItemFollowUp,
      ),
    ).toHaveBeenCalledTimes(1)
  })

  it('a following selection that resolves the LAST open item enters the no-current state', async () => {
    // Edge: one open item is Current, the user is following it,
    // Done resolves it, no not_discussed item remains, so Current
    // becomes null. The following selection must follow Current
    // into null (Selected -> null) and the detail pane renders the
    // calm no-current state — it must NOT resurrect the resolved
    // item, and "Return to current" must not be offered (there is
    // no current item to return to).
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

    // Current advanced to null; the following selection followed
    // it into null: the detail pane shows the no-current state.
    await waitFor(() => {
      expect(
        screen.getByRole('main', { name: 'Agenda item' }),
      ).toHaveTextContent('No current item')
    })
    // The resolved item is NOT resurrected as the viewed item.
    expect(
      screen.queryByRole('heading', {
        name: 'Only',
      }),
    ).toBeNull()
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
})
