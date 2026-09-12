// @vitest-environment happy-dom
import {
  afterEach,
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

import * as authApi from '../../api/auth'

// SessionProvider recovers the session from /api/auth/me/ on mount.
vi.mock('../../api/auth', async (importOriginal) => {
  const actual =
    await importOriginal<typeof authApi>()

  return {
    ...actual,
    me: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
  }
})

import {
  CompletedMeetingRecap,
} from './CompletedMeetingRecap'
import { MeetingDetailPage } from './MeetingDetailPage'

import * as meetingsApi from '../../api/meetings'
import * as projectsApi from '../../api/projects'
import * as researchGroupsApi from '../../api/research-groups'
import * as workItemsApi from '../../api/work-items'

vi.mock('../../api/work-items', async (importOriginal) => {
  const actual =
    await importOriginal<typeof workItemsApi>()

  return {
    ...actual,
    getWorkItem: vi.fn(),
    updateWorkItem: vi.fn(),
    listProjectWorkItems: vi.fn(),
  }
})

// The Meeting page loads its data through the API client; the
// single-header assertions render the real page against a fixed,
// permission-consistent fixture (no network).
vi.mock('../../api/meetings', async (importOriginal) => {
  const actual =
    await importOriginal<typeof meetingsApi>()

  return {
    ...actual,
    getMeeting: vi.fn(),
    listMeetingParticipants: vi.fn(),
    listMeetingItems: vi.fn(),
    listMeetingSections: vi.fn(),
    startMeeting: vi.fn(),
    endMeeting: vi.fn(),
    reopenMeeting: vi.fn(),
    deleteMeeting: vi.fn(),
    focusMeetingItem: vi.fn(),
    markMeetingItemDone: vi.fn(),
    markMeetingItemFollowUp: vi.fn(),
    createMeetingItem: vi.fn(),
    updateMeetingItem: vi.fn(),
    createMeetingSection: vi.fn(),
    updateMeetingSection: vi.fn(),
    reorderMeetingSections: vi.fn(),
    addMeetingParticipant: vi.fn(),
    removeMeetingParticipant: vi.fn(),
    createMeetingNote: vi.fn(),
    updateMeetingNote: vi.fn(),
    deleteMeetingNote: vi.fn(),
  }
})

vi.mock('../../api/projects', async (importOriginal) => {
  const actual =
    await importOriginal<typeof projectsApi>()

  return {
    ...actual,
    getProject: vi.fn(),
    listProjectMemberships: vi.fn(),
    getProjectWorkItemConfiguration: vi.fn(),
    listResearchGroupMembers: vi.fn(),
  }
})

vi.mock('../../api/research-groups', async (importOriginal) => {
  const actual =
    await importOriginal<typeof researchGroupsApi>()

  return {
    ...actual,
    listResearchGroups: vi.fn(),
    listResearchGroupMemberships: vi.fn(),
  }
})

import type {
  ApiLinkedWorkItem,
  ApiMeeting,
  ApiMeetingItem,
  ApiMeetingNote,
  ApiMeetingParticipant,
  ApiMeetingSection,
  ApiProject,
  ApiProjectMembership,
  ApiProjectWorkItemConfiguration,
  ApiWorkItem,
  ApiWorkItemStatusDefinition,
} from '../../api/types'

afterEach(() => {
  cleanup()
  vi.mocked(
    workItemsApi.getWorkItem,
  ).mockReset()
})

/* ── Fixtures ────────────────────────────────────────────────── */

function makeNote(
  overrides: Partial<ApiMeetingNote> = {},
): ApiMeetingNote {
  return {
    id: 1,
    meetingItemId: 3,
    author: {
      id: 1,
      username: 'alex',
      firstName: 'Alex',
      lastName: 'Dev',
    },
    content: 'Quotation B was agreed.',
    createdAt: '2026-08-27T10:15:00Z',
    updatedAt: '2026-08-27T10:15:00Z',
    linkedWorkItem: null,
    ...overrides,
  }
}

function makeLinked(
  overrides: Partial<ApiLinkedWorkItem> = {},
): ApiLinkedWorkItem {
  return {
    id: 7,
    title: 'Prepare purchase request',
    projectId: 2,
    projectName: 'Paper XYZ',
    statusName: 'In progress',
    assigneeNames: ['Chris Dev'],
    ...overrides,
  }
}

function makeItem(
  overrides: Partial<ApiMeetingItem> = {},
): ApiMeetingItem {
  return {
    id: 3,
    meetingId: 9,
    meetingSectionId: 1,
    title: 'GPU procurement',
    contextNotes: '',
    position: 10,
    outcome: 'not_discussed',
    followUpSchedule: null,
    workItemIds: [],
    notes: [],
    createdById: 1,
    createdAt: '2026-08-27T10:00:00Z',
    updatedAt: '2026-08-27T10:00:00Z',
    ...overrides,
  }
}

function makeSection(
  overrides: Partial<ApiMeetingSection> = {},
): ApiMeetingSection {
  return {
    id: 1,
    meetingId: 9,
    sourceSeriesSectionId: null,
    name: 'TOPs',
    description: '',
    position: 10,
    isVisible: true,
    ...overrides,
  }
}

const meeting: ApiMeeting = {
  id: 9,
  researchGroupId: 1,
  scope: 'group',
  projectId: null,
  seriesId: null,
  title: 'FG Weekly',
  scheduledAt: '2026-08-27T09:30:00Z',
  startedAt: '2026-08-27T09:31:00Z',
  endedAt: '2026-08-27T10:20:00Z',
  status: 'completed',
  currentMeetingItemId: null,
  participantIds: [1, 2],
  createdById: 1,
  createdAt: '2026-08-20T09:00:00Z',
  updatedAt: '2026-08-27T10:20:00Z',
}

function makeWorkItem(
  overrides: Partial<ApiWorkItem> = {},
): ApiWorkItem {
  return {
    id: 21,
    projectId: 42,
    title: 'Direct item work',
    description: '',
    typeDefinitionId: 1,
    statusDefinitionId: 11,
    boardPosition: null,
    labelDefinitionIds: [],
    // Legacy fixed string, intentionally different from the
    // canonical definition name: the recap must never display it.
    status: 'in_progress',
    assigneeIds: [2],
    parentId: null,
    dueDate: null,
    blockedReason: null,
    completedAt: null,
    createdAt: '2026-08-27T10:00:00Z',
    updatedAt: '2026-08-27T10:00:00Z',
    createdById: 1,
    meetingOrigin: null,
    ...overrides,
  }
}

function makeProject(
  overrides: Partial<ApiProject> = {},
): ApiProject {
  return {
    id: 42,
    researchGroupId: 1,
    name: 'Paper XYZ',
    description: '',
    status: 'active',
    archivedAt: null,
    currentUserRole: 'member',
    createdAt: '2026-08-01T09:00:00Z',
    updatedAt: '2026-08-01T09:00:00Z',
    ...overrides,
  }
}

function makeMembership(
  overrides: Partial<ApiProjectMembership> = {},
): ApiProjectMembership {
  return {
    id: 1,
    role: 'member',
    addedAt: '2026-08-01T09:00:00Z',
    user: {
      id: 2,
      username: 'chris',
      firstName: 'Chris',
      lastName: 'Dev',
    },
    ...overrides,
  }
}

function makeWorkItemConfiguration(
  overrides: Partial<ApiProjectWorkItemConfiguration> = {},
  statuses: ApiWorkItemStatusDefinition[] = [
    {
      id: 11,
      name: 'In review (canonical)',
      category: 'review',
      order: 1,
      active: true,
      isDefault: true,
    },
  ],
): ApiProjectWorkItemConfiguration {
  return {
    types: [],
    statuses,
    labels: [],
    ...overrides,
  }
}

// Project-level data for the hydration flow (deduplicated per
// Project by the page).
const RECAP_PROJECT = makeProject()
const RECAP_MEMBERSHIPS: ApiProjectMembership[] = [
  makeMembership(),
]
const RECAP_CONFIGURATION = makeWorkItemConfiguration()

function mockDirectWorkHydration(
  workItem: ApiWorkItem = makeWorkItem(),
) {
  // Set the Work Item mock BEFORE renderCompletedPage is called.
  // renderCompletedPage's default mock will override this, but
  // we re-set it immediately after renderCompletedPage returns
  // (before the effect runs, since React 19 effects are
  // scheduled asynchronously).
  vi.mocked(projectsApi.getProject).mockResolvedValue(
    RECAP_PROJECT,
  )
  vi.mocked(projectsApi.listProjectMemberships).mockResolvedValue(
    RECAP_MEMBERSHIPS,
  )
  vi.mocked(projectsApi.getProjectWorkItemConfiguration).mockResolvedValue(
    RECAP_CONFIGURATION,
  )
  vi.mocked(workItemsApi.listProjectWorkItems).mockResolvedValue(
    [],
  )
  // Return the work item so the test can re-set the mock after
  // renderCompletedPage.
  return workItem
}

function itemsBySectionFor(
  items: ApiMeetingItem[],
): Map<number, ApiMeetingItem[]> {
  const map = new Map<number, ApiMeetingItem[]>()

  for (const item of items) {
    const existing =
      map.get(item.meetingSectionId) ?? []
    existing.push(item)
    map.set(item.meetingSectionId, existing)
  }

  return map
}

function renderRecap(
  props: Partial<Parameters<
    typeof CompletedMeetingRecap
  >[0]> = {},
) {
  const items = props.sortedItems ?? []
  const defaultProps = {
    sortedSections: [makeSection()],
    sortedItems: items,
    itemsBySection: itemsBySectionFor(items),
    workById: new Map<number, ApiLinkedWorkItem>(),
    onOpenLinkedWork: vi.fn(),
    ...props,
  }

  return render(
    <CompletedMeetingRecap
      {...(defaultProps as Parameters<
        typeof CompletedMeetingRecap
      >[0])}
    />,
  )
}

/* ── 1-4. Structure ──────────────────────────────────────────── */

describe('Completed recap content', () => {
  it('renders the Outcomes and Protocol regions, with Outcomes before Protocol', () => {
    const item = makeItem({
      outcome: 'follow_up',
      title: 'Sample holder issue',
    })
    renderRecap({ sortedItems: [item] })

    const outcomes = screen.getByRole('heading', {
      name: 'Outcomes',
    })
    const protocol = screen.getByRole('heading', {
      name: 'Protocol',
    })
    expect(outcomes).toBeVisible()
    expect(protocol).toBeVisible()
    expect(
      outcomes.compareDocumentPosition(protocol) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('shares one identical document width between Outcomes and Protocol', () => {
    const item = makeItem({
      outcome: 'follow_up',
      title: 'Sample holder issue',
    })
    renderRecap({ sortedItems: [item] })

    const outcomes = screen
      .getByRole('heading', { name: 'Outcomes' })
      .closest('section')!
    const protocol = screen
      .getByRole('heading', { name: 'Protocol' })
      .closest('section')!

    // Both document regions terminate at the same 840px width
    // contract, owned by the same element, so Outcomes, the
    // divider, and the Protocol share one right edge.
    const widthOf = (element: Element) =>
      element.closest(
        '[class*="max-w-[840px]"]',
      )
    const outcomesWidth = widthOf(outcomes)
    const protocolWidth = widthOf(protocol)
    expect(outcomesWidth).not.toBeNull()
    expect(protocolWidth).toBe(outcomesWidth)
  })

  it('does not render a second Meeting identity inside the recap', () => {
    renderRecap()

    // The page header owns the Meeting title / Completed state /
    // metadata; the recap is content only.
    expect(
      screen.queryByRole('heading', {
        name: 'FG Weekly',
        level: 1,
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Completed', { exact: true }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(/participants?/),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Research Group Meeting'),
    ).not.toBeInTheDocument()
  })

  it('does not render the Live shell or Live controls', () => {
    renderRecap()

    expect(
      screen.queryByRole('navigation', {
        name: 'Agenda',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('main', {
        name: 'Agenda item',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', {
        name: /End meeting/i,
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', {
        name: /Add item/i,
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', {
        name: /Add note/i,
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', {
        name: /Focus /i,
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', {
        name: /Create work item/i,
      }),
    ).not.toBeInTheDocument()
  })
})

/* ── Single Meeting header (page level) ──────────────────────── */

const PARTICIPANTS: ApiMeetingParticipant[] = [
  {
    id: 1,
    user: {
      id: 1,
      username: 'alex',
      firstName: 'Alex',
      lastName: 'Dev',
    },
    addedAt: '2026-08-20T09:00:00Z',
  },
  {
    id: 2,
    user: {
      id: 2,
      username: 'chris',
      firstName: 'Chris',
      lastName: 'Dev',
    },
    addedAt: '2026-08-20T09:00:00Z',
  },
]

function renderCompletedPage(
  items: ApiMeetingItem[] = [],
) {
  const user = {
    click: (element: Element) =>
      fireEvent.click(element),
  }
  vi.mocked(meetingsApi.getMeeting).mockResolvedValue(
    meeting,
  )
  vi.mocked(
    meetingsApi.listMeetingParticipants,
  ).mockResolvedValue(PARTICIPANTS)
  vi.mocked(meetingsApi.listMeetingItems).mockResolvedValue(
    items,
  )
  vi.mocked(meetingsApi.listMeetingSections).mockResolvedValue(
    [makeSection()],
  )
  vi.mocked(
    researchGroupsApi.listResearchGroups,
  ).mockResolvedValue([
    {
      id: 1,
      name: 'FG',
      role: 'admin',
    },
  ])
  vi.mocked(
    researchGroupsApi.listResearchGroupMemberships,
  ).mockResolvedValue([])
  vi.mocked(
    projectsApi.listResearchGroupMembers,
  ).mockResolvedValue([])
  // Default: getWorkItem rejects. Tests that exercise direct
  // Work Item hydration call mockDirectWorkHydration() which
  // overrides this with a resolving implementation.
  vi.mocked(workItemsApi.getWorkItem).mockImplementation(
    () =>
      Promise.reject(
        new Error('work item not mocked'),
      ),
  )
  vi.mocked(authApi.me).mockResolvedValue({
    id: 1,
    username: 'alex',
    firstName: 'Alex',
    lastName: 'Dev',
    email: 'alex@example.com',
  })

  const rendered = render(
    <MemoryRouter initialEntries={['/meetings/9']}>
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

  return {
    ...rendered,
    user,
  }
}

describe('Completed Meeting single header (page level)', () => {
  it('renders the Meeting title exactly once', async () => {
    renderCompletedPage()

    const titles = await screen.findAllByRole('heading', {
      name: 'FG Weekly',
      level: 1,
    })
    expect(titles).toHaveLength(1)
  })

  it('renders the Completed indicator exactly once', async () => {
    renderCompletedPage()

    await screen.findByRole('heading', {
      name: 'FG Weekly',
      level: 1,
    })
    expect(
      screen.getAllByText('Completed', {
        exact: true,
      }),
    ).toHaveLength(1)
  })

  it('renders a quiet Completed state with a plain-unicode check', async () => {
    renderCompletedPage()

    await screen.findByRole('heading', {
      name: 'FG Weekly',
      level: 1,
    })
    const completed = screen.getByText('Completed', {
      exact: true,
    })
    // The small check glyph accompanies the label ...
    expect(completed).toHaveTextContent(
      '✓',
    )
    // The Completed row is deliberately separated from the
    // metadata row below it (three-row header grouping).
    expect(completed).toHaveClass('mt-1')
    // ...and is plain unicode, not an icon-font ligature.
    expect(
      completed.querySelector(
        '.material-symbols-outlined',
      ),
    ).toBeNull()
    // Quiet secondary treatment, no status badge.
    expect(completed).toHaveClass(
      'text-text-muted',
    )
  })

  it('renders the participant count exactly once', async () => {
    renderCompletedPage()

    await screen.findByRole('heading', {
      name: 'FG Weekly',
      level: 1,
    })
    expect(
      screen.getAllByText(/2 participants/),
    ).toHaveLength(1)
  })

  it('renders compact Meeting metadata once, not duplicated', async () => {
    renderCompletedPage()

    await screen.findByRole('heading', {
      name: 'FG Weekly',
      level: 1,
    })
    // Type and the compact reliable duration each appear once.
    expect(
      screen.getAllByText('Research Group Meeting'),
    ).toHaveLength(1)
    expect(screen.getAllByText('49m')).toHaveLength(1)
    // Compact date ("Thu, Aug 27 · HH:MM"): both the weekday
    // and the clock time depend on the environment timezone, so
    // assert on the timezone-stable "Aug 27" fragment, and the
    // whole compact line appears exactly once.
    expect(
      screen.getAllByText(/[A-Z][a-z]{2}, Aug 27 · \d{2}:\d{2}/),
    ).toHaveLength(1)
  })

  it('renders exactly one Protocol heading', async () => {
    renderCompletedPage()

    await screen.findByRole('heading', {
      name: 'FG Weekly',
      level: 1,
    })
    expect(
      screen.getAllByRole('heading', {
        name: 'Protocol',
      }),
    ).toHaveLength(1)
  })

  it('does not render the classic "Meeting record" content heading', async () => {
    renderCompletedPage()

    await screen.findByRole('heading', {
      name: 'FG Weekly',
      level: 1,
    })
    expect(
      screen.queryByText(
        'Meeting record, grouped by section.',
      ),
    ).not.toBeInTheDocument()
  })

  it('renders Outcomes before Protocol', async () => {
    const item = makeItem({
      outcome: 'follow_up',
      title: 'Sample holder issue',
    })
    renderCompletedPage([item])

    const outcomes = await screen.findByRole('heading', {
      name: 'Outcomes',
    })
    const protocol = screen.getByRole('heading', {
      name: 'Protocol',
    })
    expect(
      outcomes.compareDocumentPosition(protocol) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('keeps a quiet Reopen meeting action in the page header', async () => {
    vi.mocked(meetingsApi.reopenMeeting).mockResolvedValue({
      ...meeting,
      status: 'live',
    })

    const { user } = renderCompletedPage()

    await screen.findByRole('heading', {
      name: 'FG Weekly',
      level: 1,
    })
    const reopen = screen.getByRole('button', {
      name: 'Reopen meeting',
    })
    expect(reopen).toBeVisible()
    // Quiet secondary (ghost) treatment, not a bordered or
    // filled primary action.
    expect(reopen.className).toContain('text-text-muted')
    expect(reopen.className).not.toContain('border')
    expect(reopen.className).not.toContain('bg-primary')
    expect(reopen.className).not.toContain('bg-accent')

    user.click(reopen)
    await waitFor(() =>
      expect(meetingsApi.reopenMeeting).toHaveBeenCalledWith(
        9,
      ),
    )
  })

  it('keeps the header (incl. Reopen) inside the Completed document width', async () => {
    const { container } = renderCompletedPage()

    await screen.findByRole('heading', {
      name: 'FG Weekly',
      level: 1,
    })
    // The Completed document wrapper carries the exact 840px
    // width contract ...
    const widthRoot = container.querySelector(
      '[class*="max-w-[840px]"]',
    )
    expect(widthRoot).not.toBeNull()
    // ...and the header (title + Reopen) sits inside it, so
    // the action belongs to the record, not the outer canvas.
    expect(
      widthRoot!.querySelector('header'),
    ).not.toBeNull()
    const reopen = screen.getByRole('button', {
      name: 'Reopen meeting',
    })
    expect(widthRoot!.contains(reopen)).toBe(true)
    // ...and the recap content shares the same wrapper.
    expect(
      widthRoot!.querySelector('[data-completed-recap]'),
    ).not.toBeNull()
    // Reopen stays neutral/secondary.
    expect(reopen.className).toContain('text-text-muted')
    expect(reopen.className).not.toContain(
      'bg-accent',
    )
  })

  it('shows non-zero outcome counts once in the header', async () => {
    const linked = makeLinked()
    const workItem = makeItem({
      outcome: 'not_discussed',
      notes: [
        makeNote({ linkedWorkItem: linked }),
      ],
    })
    const followUpItem = makeItem({
      id: 4,
      title: 'Sample holder issue',
      outcome: 'follow_up',
    })
    renderCompletedPage([workItem, followUpItem])

    await screen.findByRole('heading', {
      name: 'FG Weekly',
      level: 1,
    })
    // The count line is one <p> joining the non-zero categories.
    expect(
      screen.getByText(
        '1 resulting work item · 1 follow-up',
      ),
    ).toBeVisible()
    // It appears exactly once (in the page header).
    expect(
      screen.getAllByText(
        '1 resulting work item · 1 follow-up',
      ),
    ).toHaveLength(1)
  })

  it('pluralizes the outcome count line for multiple items', async () => {
    const linkedA = makeLinked({
      id: 7,
      title: 'Work A',
    })
    const linkedB = makeLinked({
      id: 8,
      title: 'Work B',
    })
    const w1 = makeItem({
      id: 3,
      outcome: 'done',
      notes: [
        makeNote({
          id: 1,
          meetingItemId: 3,
          linkedWorkItem: linkedA,
        }),
      ],
    })
    const w2 = makeItem({
      id: 6,
      outcome: 'done',
      position: 30,
      notes: [
        makeNote({
          id: 2,
          meetingItemId: 6,
          linkedWorkItem: linkedB,
        }),
      ],
    })
    const f1 = makeItem({
      id: 4,
      title: 'Follow A',
      outcome: 'follow_up',
    })
    const f2 = makeItem({
      id: 5,
      title: 'Follow B',
      outcome: 'follow_up',
      position: 20,
    })
    renderCompletedPage([w1, w2, f1, f2])

    await screen.findByRole('heading', {
      name: 'FG Weekly',
      level: 1,
    })
    expect(
      screen.getByText(
        '2 resulting work items · 2 follow-ups',
      ),
    ).toBeVisible()
  })

  it('keeps the recap content (protocol items, notes, linked work) unchanged', async () => {
    const linked = makeLinked()
    const item = makeItem({
      title: 'GPU procurement',
      outcome: 'not_discussed',
      notes: [
        makeNote({
          linkedWorkItem: linked,
          content: 'Quotation B was agreed.',
        }),
      ],
    })
    renderCompletedPage([item])

    await screen.findByRole('heading', {
      name: 'FG Weekly',
      level: 1,
    })

    // Protocol item, full Note content, and the Note-linked Work
    // row all remain in place.
    expect(
      screen.getByRole('heading', {
        name: 'GPU procurement',
      }),
    ).toBeVisible()
    expect(
      screen.getByText('Quotation B was agreed.', {
        exact: true,
      }),
    ).toBeVisible()
    expect(
      screen.getAllByRole('button', {
        name: 'Open linked work item: Prepare purchase request',
      }),
    ).toHaveLength(2)
  })
  it('resolves the canonical Project status name for direct MeetingItem-linked Work', async () => {

    // The legacy fixed status string is 'in_progress'; the
    // Project configuration (statusDefinitionId 11) names it
    // differently. The recap row must show the definition name.
    const hydratedItem = makeWorkItem()
    const item = makeItem({
      outcome: 'not_discussed',
      workItemIds: [21],
    })
    mockDirectWorkHydration(hydratedItem)
    renderCompletedPage([item])
    // Re-set the Work Item mock after renderCompletedPage
    // (its default mock overrides the one set by
    // mockDirectWorkHydration). The effect hasn't run yet
    // (React 19 schedules effects asynchronously), so this
    // takes effect before the hydration fetch.
    vi.mocked(workItemsApi.getWorkItem).mockImplementation(
      () => Promise.resolve(hydratedItem),
    )

    await screen.findByRole('heading', {
      name: 'FG Weekly',
      level: 1,
    })
    const rows = await screen.findAllByRole('button', {
      name: 'Open linked work item: Direct item work',
    })
    // The row appears in Outcomes and in the Protocol (item
    // level) — both must show the canonical status.
    expect(rows.length).toBeGreaterThanOrEqual(1)
    for (const row of rows) {
      expect(row).toBeVisible()
      expect(row).toHaveTextContent(
        'In review (canonical)',
      )
    }
    // The legacy fixed string is never the displayed source.
    expect(screen.queryByText('in_progress')).not.toBeInTheDocument()
    // One config request per Project (deduplicated), and the
    // assignee resolved from Project memberships.
    expect(
      projectsApi.getProjectWorkItemConfiguration,
    ).toHaveBeenCalledTimes(1)
    expect(rows[0]).toHaveTextContent('Chris Dev')
  })
})

/* ── Page heading semantics (all Meeting states) ─────────────── */

function renderMeetingPage(
  status: 'upcoming' | 'live' | 'completed',
  items: ApiMeetingItem[] = [],
) {
  const meetingOverride: ApiMeeting = {
    ...meeting,
    status,
    // Upcoming: no start/end yet.
    startedAt: status === 'upcoming' ? null : meeting.startedAt,
    endedAt: status === 'upcoming' ? null : meeting.endedAt,
  }

  vi.mocked(meetingsApi.getMeeting).mockResolvedValue(
    meetingOverride,
  )
  vi.mocked(
    meetingsApi.listMeetingParticipants,
  ).mockResolvedValue(PARTICIPANTS)
  vi.mocked(meetingsApi.listMeetingItems).mockResolvedValue(
    items,
  )
  vi.mocked(meetingsApi.listMeetingSections).mockResolvedValue(
    [makeSection()],
  )
  vi.mocked(
    researchGroupsApi.listResearchGroups,
  ).mockResolvedValue([
    {
      id: 1,
      name: 'FG',
      role: 'admin',
    },
  ])
  vi.mocked(
    researchGroupsApi.listResearchGroupMemberships,
  ).mockResolvedValue([])
  vi.mocked(
    projectsApi.listResearchGroupMembers,
  ).mockResolvedValue([])
  vi.mocked(workItemsApi.getWorkItem).mockImplementation(
    () =>
      Promise.reject(
        new Error('work item not mocked'),
      ),
  )
  vi.mocked(authApi.me).mockResolvedValue({
    id: 1,
    username: 'alex',
    firstName: 'Alex',
    lastName: 'Dev',
    email: 'alex@example.com',
  })

  return render(
    <MemoryRouter initialEntries={['/meetings/9']}>
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

describe('Meeting page heading semantics', () => {
  it('Upcoming has exactly one level-1 heading with the Meeting title', async () => {
    renderMeetingPage('upcoming')

    const headings = await screen.findAllByRole(
      'heading',
      { level: 1, name: 'FG Weekly' },
    )
    expect(headings).toHaveLength(1)
    // No duplicate h1 with the same or different text.
    const allH1 = screen.getAllByRole(
      'heading',
      { level: 1 },
    )
    expect(allH1).toHaveLength(1)
  })

  it('Live has exactly one level-1 heading with the Meeting title', async () => {
    renderMeetingPage('live')

    const headings = await screen.findAllByRole(
      'heading',
      { level: 1, name: 'FG Weekly' },
    )
    expect(headings).toHaveLength(1)
    const allH1 = screen.getAllByRole(
      'heading',
      { level: 1 },
    )
    expect(allH1).toHaveLength(1)
  })

  it('Completed has exactly one level-1 heading with the Meeting title', async () => {
    renderMeetingPage('completed')

    const headings = await screen.findAllByRole(
      'heading',
      { level: 1, name: 'FG Weekly' },
    )
    expect(headings).toHaveLength(1)
    const allH1 = screen.getAllByRole(
      'heading',
      { level: 1 },
    )
    expect(allH1).toHaveLength(1)
  })

  it('Completed still has no duplicate title', async () => {
    renderMeetingPage('completed')

    await screen.findByRole('heading', {
      name: 'FG Weekly',
      level: 1,
    })
    // The title appears exactly once as text on the page.
    const titleOccurrences = screen.getAllByText(
      'FG Weekly',
      { exact: true },
    )
    expect(titleOccurrences).toHaveLength(1)
  })

  it('Completed still renders Outcomes before Protocol', async () => {
    const item = makeItem({
      outcome: 'follow_up',
      title: 'Sample holder issue',
    })
    renderMeetingPage('completed', [item])

    const outcomes = await screen.findByRole(
      'heading',
      { name: 'Outcomes' },
    )
    const protocol = screen.getByRole('heading', {
      name: 'Protocol',
    })
    expect(
      outcomes.compareDocumentPosition(protocol) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })
})

/* ── 5-9. Outcomes ───────────────────────────────────────────── */

describe('Outcomes', () => {
  it('renders no Outcomes region when there is no outcome content', () => {
    const item = makeItem({ outcome: 'done' })
    renderRecap({ sortedItems: [item] })

    expect(
      screen.queryByRole('heading', {
        name: 'Outcomes',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Resulting work'),
    ).not.toBeInTheDocument()
  })

  it('aggregates Note-linked Work into Resulting work with its current status', () => {
    const linked = makeLinked()
    const item = makeItem({
      outcome: 'not_discussed',
      notes: [
        makeNote({ linkedWorkItem: linked }),
      ],
    })
    renderRecap({
      sortedItems: [item],
      workById: new Map([[linked.id, linked]]),
    })

    const outcomes = screen.getByRole('heading', {
      name: 'Outcomes',
    })
    const section = outcomes.closest('section')!
    const row = within(section).getByRole('button', {
      name: 'Open linked work item: Prepare purchase request',
    })
    expect(row).toBeVisible()
    // Relation meta order: Project · Assignee · Status.
    expect(section).toHaveTextContent(
      'Paper XYZ · Chris Dev · In progress',
    )
  })

  it('aggregates direct MeetingItem-linked Work using hydrated data', () => {
    const linked = makeLinked({
      id: 21,
      title: 'Direct item work',
      statusName: 'Todo',
      assigneeNames: [],
    })
    const item = makeItem({
      outcome: 'not_discussed',
      workItemIds: [21],
    })
    renderRecap({
      sortedItems: [item],
      workById: new Map([[21, linked]]),
    })

    const section = screen
      .getByRole('heading', { name: 'Outcomes' })
      .closest('section')!
    expect(
      within(section).getByRole('button', {
        name: 'Open linked work item: Direct item work',
      }),
    ).toBeVisible()
    // Relation meta order: Project · Assignee · Status.
    expect(section).toHaveTextContent(
      'Paper XYZ · Unassigned · Todo',
    )
  })

  it('deduplicates the same Work Item reachable through Note and direct item links', () => {
    const linked = makeLinked()
    const item = makeItem({
      outcome: 'not_discussed',
      workItemIds: [linked.id],
      notes: [
        makeNote({ linkedWorkItem: linked }),
      ],
    })
    renderRecap({
      sortedItems: [item],
      workById: new Map([[linked.id, linked]]),
    })

    const section = screen
      .getByRole('heading', { name: 'Outcomes' })
      .closest('section')!
    expect(
      within(section).getAllByRole('button', {
        name: 'Open linked work item: Prepare purchase request',
      }),
    ).toHaveLength(1)
  })

  it('does not fabricate rows for direct links without hydrated display data', () => {
    const item = makeItem({
      outcome: 'not_discussed',
      workItemIds: [99],
    })
    renderRecap({ sortedItems: [item] })

    expect(
      screen.queryByRole('heading', {
        name: 'Outcomes',
      }),
    ).not.toBeInTheDocument()
  })

  it('opens the existing Inspector when a Resulting work row is clicked', async () => {
    const linked = makeLinked()
    const onOpenLinkedWork = vi.fn()
    const item = makeItem({
      outcome: 'not_discussed',
      notes: [
        makeNote({ linkedWorkItem: linked }),
      ],
    })
    render(
      <CompletedMeetingRecap
        sortedSections={[makeSection()]}
        sortedItems={[item]}
        itemsBySection={itemsBySectionFor([
          item,
        ])}
        workById={new Map([[linked.id, linked]])}
        onOpenLinkedWork={onOpenLinkedWork}
      />,
    )

    const outcomesSection = screen
      .getByRole('heading', { name: 'Outcomes' })
      .closest('section')!

    fireEvent.click(
      within(outcomesSection).getByRole('button', {
        name: 'Open linked work item: Prepare purchase request',
      }),
    )

    expect(onOpenLinkedWork).toHaveBeenCalledTimes(1)
    expect(onOpenLinkedWork).toHaveBeenCalledWith(
      linked,
    )
  })

  it('aggregates follow_up items into the Follow-ups subsection', () => {
    const item = makeItem({
      id: 4,
      title: 'Sample holder issue',
      outcome: 'follow_up',
    })
    renderRecap({ sortedItems: [item] })

    const section = screen
      .getByRole('heading', { name: 'Outcomes' })
      .closest('section')!
    expect(
      within(section).getByText('Sample holder issue'),
    ).toBeVisible()
    expect(
      within(section).getByText('Follow-ups'),
    ).toBeVisible()
  })

  it('renders Resulting work metadata as Project · Assignee · Status', () => {
    const linked = makeLinked()
    const item = makeItem({
      outcome: 'not_discussed',
      notes: [
        makeNote({ linkedWorkItem: linked }),
      ],
    })
    renderRecap({
      sortedItems: [item],
      workById: new Map([[linked.id, linked]]),
    })

    const section = screen
      .getByRole('heading', { name: 'Outcomes' })
      .closest('section')!
    expect(
      within(section).getByText(
        'Paper XYZ · Chris Dev · In progress',
        { exact: true },
      ),
    ).toBeVisible()
  })

  it('renders follow-ups with the stable plain-unicode ↻ marker (never a raw ligature/enum)', () => {
    const item = makeItem({
      id: 4,
      title: 'Sample holder issue',
      outcome: 'follow_up',
    })
    renderRecap({ sortedItems: [item] })

    const section = screen
      .getByRole('heading', { name: 'Outcomes' })
      .closest('section')!
    expect(
      within(section).getByText('↻', {
        exact: true,
      }),
    ).toBeVisible()

    const text = section.textContent ?? ''
    expect(text).not.toContain('FOLLOW_UP')
    expect(text).not.toContain('followup')
    expect(text).not.toContain('follow_up')
    // No icon-font ligature anywhere in the Outcomes summary.
    expect(
      section.querySelectorAll(
        '.material-symbols-outlined',
      ),
    ).toHaveLength(0)
  })

  it('renders the scheduled follow-up destination from canonical schedule data', () => {
    const item = makeItem({
      id: 4,
      title: 'Sample holder issue',
      outcome: 'follow_up',
      followUpSchedule: {
        id: 50,
        status: 'scheduled',
        sourceMeetingItemId: 4,
        sourceOutcome: 'follow_up',
        targetMeetingId: 12,
        targetMeetingTitle: 'FG Weekly',
        targetMeetingScheduledAt:
          '2026-09-17T09:30:00Z',
        targetMeetingSectionId: 7,
        targetMeetingSectionName: 'Check-In',
        targetMeetingItemId: 81,
        createdAt: '2026-08-27T10:05:00Z',
        updatedAt: '2026-08-27T10:05:00Z',
      },
    })
    renderRecap({ sortedItems: [item] })

    const section = screen
      .getByRole('heading', { name: 'Outcomes' })
      .closest('section')!
    // Compact destination metadata "<Meeting> · <Date> ·
    // <Section>" — no "Scheduled for" prefix, because the
    // Follow-ups anchor already carries the semantics. The
    // date fragment depends on the environment timezone, so
    // assert the stable surrounding wording.
    expect(
      within(section).getByText(
        /FG Weekly · [A-Z][a-z]{2} \d{1,2} · Check-In/,
      ),
    ).toBeVisible()
    expect(section.textContent ?? '').not.toContain(
      'Scheduled for',
    )
  })

  it('renders the truthful fallback for an unscheduled follow-up', () => {
    const item = makeItem({
      id: 4,
      title: 'Sample holder issue',
      outcome: 'follow_up',
      followUpSchedule: null,
    })
    renderRecap({ sortedItems: [item] })

    const section = screen
      .getByRole('heading', { name: 'Outcomes' })
      .closest('section')!
    expect(
      within(section).getByText('Sample holder issue'),
    ).toBeVisible()
    // outcome=follow_up without an active schedule is a valid
    // user-visible state; its secondary line says exactly
    // that, with no fabricated destination metadata.
    expect(
      within(section).getByText('Follow-up not scheduled', {
        exact: true,
      }),
    ).toBeVisible()
    expect(section.textContent ?? '').not.toContain(
      'Scheduled for',
    )
  })

  it('does not present an active destination for a needs_reschedule follow-up', () => {
    const item = makeItem({
      id: 4,
      title: 'Sample holder issue',
      outcome: 'follow_up',
      followUpSchedule: {
        id: 50,
        status: 'needs_reschedule',
        sourceMeetingItemId: 4,
        sourceOutcome: 'follow_up',
        targetMeetingId: 12,
        targetMeetingTitle: 'FG Weekly',
        targetMeetingScheduledAt:
          '2026-09-17T09:30:00Z',
        targetMeetingSectionId: 7,
        targetMeetingSectionName: 'Check-In',
        targetMeetingItemId: 81,
        createdAt: '2026-08-27T10:05:00Z',
        updatedAt: '2026-08-27T10:05:00Z',
      },
    })
    renderRecap({ sortedItems: [item] })

    const section = screen
      .getByRole('heading', { name: 'Outcomes' })
      .closest('section')!
    expect(
      within(section).getByText('Sample holder issue'),
    ).toBeVisible()
    // The original references are history only: no active
    // destination claim and no unscheduled fallback.
    const text = section.textContent ?? ''
    expect(text).not.toContain('FG Weekly')
    expect(text).not.toContain('Check-In')
    expect(text).not.toContain('Follow-up not scheduled')
  })

  it('keeps the Resulting work anchors natural-cased and subordinate', () => {
    const linked = makeLinked()
    const item = makeItem({
      outcome: 'not_discussed',
      notes: [
        makeNote({ linkedWorkItem: linked }),
      ],
    })
    renderRecap({
      sortedItems: [item],
      workById: new Map([[linked.id, linked]]),
    })

    // The Outcomes anchor and the Note-local Protocol
    // anchor are both quiet content labels.
    const anchors = screen.getAllByText(
      'Resulting work',
      { exact: true },
    )
    expect(anchors.length).toBeGreaterThanOrEqual(1)
    for (const anchor of anchors) {
      expect(anchor).toHaveClass('font-semibold')
      expect(anchor).toHaveClass('leading-4')
      expect(anchor.className).not.toContain(
        'uppercase',
      )
      expect(anchor.className).not.toMatch(
        /tracking-/,
      )
    }
  })

  it('keeps outcome counts out of the recap content (header owns them)', () => {
    const linked = makeLinked()
    const workItem = makeItem({
      outcome: 'not_discussed',
      notes: [
        makeNote({ linkedWorkItem: linked }),
      ],
    })
    const followUpItem = makeItem({
      id: 4,
      title: 'Sample holder issue',
      outcome: 'follow_up',
    })
    const { container } = renderRecap({
      sortedItems: [workItem, followUpItem],
      workById: new Map([[linked.id, linked]]),
    })

    // The compact count line belongs to the page header, not the
    // recap content; zero counts never render anywhere.
    expect(container.textContent).not.toContain(
      'resulting work item',
    )
    expect(container.textContent).not.toContain(
      'Decisions',
    )
  })

  it('never renders a Decisions subsection (no canonical source exists)', () => {
    const linked = makeLinked()
    const item = makeItem({
      outcome: 'follow_up',
      notes: [
        makeNote({
          linkedWorkItem: linked,
          content:
            'Decision: use quotation B.',
        }),
      ],
    })
    renderRecap({
      sortedItems: [item],
      workById: new Map([[linked.id, linked]]),
    })

    expect(
      screen.queryByText('Decisions'),
    ).not.toBeInTheDocument()
  })
})

/* ── 10-17. Protocol ─────────────────────────────────────────── */

describe('Protocol', () => {
  it('renders no outcome/status label on ordinary done items', () => {
    const item = makeItem({ outcome: 'done' })
    const { container } = renderRecap({ sortedItems: [item] })

    // The item title is still the record heading...
    expect(
      screen.getByRole('heading', {
        name: 'GPU procurement',
      }),
    ).toBeVisible()
    // ...and the Protocol is a document: an ordinary Done item
    // carries no status label, no symbol, and no success tint.
    expect(
      screen.queryByText('Done', { exact: true }),
    ).not.toBeInTheDocument()
    expect(container.textContent ?? '').not.toContain(
      '✓',
    )
    expect(container.innerHTML).not.toContain(
      'text-success',
    )
    expect(container.innerHTML).not.toContain(
      'bg-success',
    )
  })

  it('keeps Follow-up neutral (no Amber / warning treatment)', () => {
    const item = makeItem({
      id: 4,
      title: 'Sample holder issue',
      outcome: 'follow_up',
    })
    const { container } = renderRecap({ sortedItems: [item] })

    const followUp = screen.getByText('Follow-up', { exact: true })
    expect(followUp).toHaveClass('text-text-muted')
    const text = container.textContent ?? ''
    // No amber/warning class anywhere in the recap.
    expect(container.innerHTML).not.toMatch(/amber|warning/)
    expect(text).not.toContain('FOLLOW_UP')
    expect(text).not.toContain('follow_up')
  })

  it('renders the follow-up marker as plain unicode (never raw FOLLOW_UP)', () => {
    const item = makeItem({
      id: 4,
      title: 'Sample holder issue',
      outcome: 'follow_up',
    })
    renderRecap({ sortedItems: [item] })

    // The Protocol marker is a plain-unicode symbol from the
    // shared Live Agenda mapping — independent of any
    // icon font, so no raw ligature/enum name can leak.
    const protocol = screen.getByRole('heading', {
      name: 'Protocol',
    }).closest('section')!
    expect(
      within(protocol).getByText('↻', {
        exact: true,
      }),
    ).toBeVisible()
    expect(screen.getByText('Follow-up', { exact: true })).toBeVisible()

    const protocolText = protocol.textContent ?? ''
    expect(protocolText).not.toContain('FOLLOW_UP')
    expect(protocolText).not.toContain('followup')
    expect(protocolText).not.toContain('follow_up')
    // No icon-font element anywhere in the Protocol record.
    expect(
      protocol.querySelector('.material-symbols-outlined'),
    ).toBeNull()
  })

  it('keeps the exception state beside the item title, not in a far-right column', () => {
    const item = makeItem({
      id: 4,
      title: 'Sample holder issue',
      outcome: 'follow_up',
    })
    renderRecap({ sortedItems: [item] })

    const heading = screen.getByRole('heading', {
      name: 'Sample holder issue',
    })
    const row = heading.parentElement!
    // The marker shares the item heading row (right after the
    // title), not a dedicated status column.
    expect(
      within(row).getByText('Follow-up', { exact: true }),
    ).toBeVisible()
    expect(row).not.toHaveClass('ml-auto')
    const protocol = screen.getByRole('heading', {
      name: 'Protocol',
    }).closest('section')!
    expect(
      protocol.querySelector('[class*="ml-auto"]'),
    ).toBeNull()
  })

  it('constrains the Protocol content to a document reading width', () => {
    const item = makeItem({ outcome: 'done' })
    renderRecap({ sortedItems: [item] })

    const protocol = screen.getByRole('heading', {
      name: 'Protocol',
    }).closest('section')!
    // Document-like max width of the shared Completed document
    // (840px), owned by the recap's single width wrapper.
    expect(
      protocol.closest(
        '[class*="max-w-[840px]"]',
      ),
    ).not.toBeNull()
  })

  it('uses only the subtle semantic border for Protocol separators', () => {
    const item = makeItem({
      notes: [makeNote()],
    })
    const { container } = renderRecap({ sortedItems: [item] })

    // Bare `border-subtle` is a dead utility in this repository;
    // every separator must resolve through `border-border-subtle`.
    expect(container.innerHTML).not.toMatch(
      /(^|[^-])border-subtle(?![-\w])/,
    )
    expect(container.innerHTML).toContain(
      'border-border-subtle',
    )
  })

  it('shows Not discussed for not_discussed items', () => {
    const item = makeItem({
      id: 5,
      title: 'Tech News',
      outcome: 'not_discussed',
    })
    renderRecap({ sortedItems: [item] })

    expect(
      screen.getByText('Not discussed', {
        exact: true,
      }),
    ).toBeVisible()
    // Plain-unicode open marker, not an icon-font ligature.
    expect(
      screen.getByText('○', { exact: true }),
    ).toBeVisible()
  })

  it('shows a Follow-up marker for follow_up items in the Protocol', () => {
    const item = makeItem({
      id: 4,
      title: 'Sample holder issue',
      outcome: 'follow_up',
    })
    renderRecap({ sortedItems: [item] })

    // The item-level marker in the Protocol.
    const protocol = screen.getByRole('heading', {
      name: 'Protocol',
    }).closest('section')!
    expect(
      within(protocol).getByText('Follow-up', {
        exact: true,
      }),
    ).toBeVisible()
  })

  it('renders full Note content for multiple Notes in deterministic order', () => {
    const item = makeItem({
      notes: [
        makeNote({
          id: 11,
          content:
            'First note: cluster maintenance on Thursday.',
        }),
        makeNote({
          id: 12,
          content:
            'Second note: release stays Friday.',
        }),
      ],
    })
    renderRecap({ sortedItems: [item] })

    const first = screen.getByText(
      'First note: cluster maintenance on Thursday.',
      { exact: true },
    )
    const second = screen.getByText(
      'Second note: release stays Friday.',
      { exact: true },
    )
    expect(first).toBeVisible()
    expect(second).toBeVisible()

    // Document order must match the API (server) order of
    // item.notes.
    expect(
      first.compareDocumentPosition(second) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('renders Note attribution with author and a formatted time', () => {
    const item = makeItem({
      notes: [
        makeNote({
          content: 'Quotation B was agreed.',
          createdAt: '2026-08-27T10:15:00Z',
        }),
      ],
    })
    renderRecap({ sortedItems: [item] })

    // The exact clock time depends on the environment timezone;
    // the contract is author + a formatted HH:MM time.
    expect(
      screen.getByText(/Alex Dev \u00b7 \d{2}:\d{2}/),
    ).toBeVisible()
    // Attribution is readable secondary text, not an
    // overly-faint tertiary, without opacity stacking.
    expect(
      screen.getByText(/Alex Dev \u00b7 \d{2}:\d{2}/),
    ).toHaveClass('text-text-muted')
    expect(
      screen.getByText(/Alex Dev \u00b7 \d{2}:\d{2}/)
        .className,
    ).not.toMatch(/opacity/)
  })

  it('renders the Notes anchor in natural casing as a quiet content label', () => {
    const item = makeItem({
      notes: [makeNote()],
    })
    renderRecap({ sortedItems: [item] })

    const notes = screen.getByText('Notes', {
      exact: true,
    })
    // Small, semibold, tertiary — an informational
    // content anchor, not a table/system heading.
    expect(notes).toHaveClass('font-semibold')
    expect(notes).toHaveClass('leading-4')
    expect(notes).toHaveClass('text-text-tertiary')
    expect(notes.className).not.toContain(
      'uppercase',
    )
    expect(notes.className).not.toMatch(
      /tracking-/,
    )
    expect(
      screen.queryByText('NOTES'),
    ).not.toBeInTheDocument()
  })

  it('keeps long Protocol rhythm slightly dense (sections, items, notes)', () => {
    const firstSection = makeSection()
    const secondSection = makeSection({
      id: 2,
      name: 'KVP',
      position: 20,
    })
    const itemA = makeItem({
      id: 3,
      position: 10,
      notes: [
        makeNote({
          id: 11,
          content: 'First note.',
        }),
        makeNote({
          id: 12,
          content: 'Second note.',
        }),
      ],
    })
    const itemB = makeItem({
      id: 6,
      position: 20,
    })
    const itemC = makeItem({
      id: 7,
      meetingSectionId: 2,
      position: 10,
    })
    renderRecap({
      sortedSections: [firstSection, secondSection],
      sortedItems: [itemA, itemB, itemC],
    })

    const protocol = screen
      .getByRole('heading', { name: 'Protocol' })
      .closest('section')!
    // Final editorial rhythm:
    // Section -> Section 40px (space-y-10),
    // item -> item 28px (space-y-7),
    // note -> note 16px (space-y-4).
    expect(
      protocol.querySelector('.space-y-10'),
    ).not.toBeNull()
    expect(
      protocol.querySelector('.space-y-7'),
    ).not.toBeNull()
    expect(
      protocol.querySelector('.space-y-4'),
    ).not.toBeNull()
    // Section heading -> divider 8px (pb-2); divider ->
    // first agenda item 18px (mt-[18px]).
    expect(
      screen.getByRole('heading', { name: 'TOPs' }),
    ).toHaveClass('pb-2')
    expect(
      protocol.querySelector('ul[class*="mt-[18px]"]'),
    ).not.toBeNull()
    // Note text -> attribution 4px (mt-1).
    const attributions = screen.getAllByText(
      /Alex Dev \u00b7 \d{2}:\d{2}/,
    )
    expect(attributions.length).toBe(2)
    for (const attribution of attributions) {
      expect(attribution).toHaveClass('mt-1')
    }
  })

  it('aligns agenda-item content on one axis after the number column', () => {
    const item = makeItem({
      notes: [
        makeNote({ content: 'First note.' }),
      ],
    })
    renderRecap({ sortedItems: [item] })

    const protocol = screen
      .getByRole('heading', { name: 'Protocol' })
      .closest('section')!
    const itemBlock = within(protocol)
      .getByRole('heading', {
        name: 'GPU procurement',
      })
      .closest('li')!
    // Stable two-column mini-layout: a narrow number column
    // (2rem), then one content column.
    expect(itemBlock.className).toContain(
      'grid-cols-[20px_minmax(0,1fr)]',
    )
    const number = itemBlock.querySelector('span')!
    expect(number.textContent).toBe('1')
    const content =
      number.nextElementSibling as HTMLElement
    expect(content).not.toBeNull()
    // Notes anchor, note body, and attribution all start on
    // the same content axis.
    const notes = screen.getByText('Notes', {
      exact: true,
    })
    const noteBody = screen.getByText('First note.', {
      exact: true,
    })
    const attribution = screen.getAllByText(
      /Alex Dev \u00b7 \d{2}:\d{2}/,
    )[0]
    expect(content.contains(notes)).toBe(true)
    expect(content.contains(noteBody)).toBe(true)
    expect(content.contains(attribution)).toBe(true)
  })

  it('places item-level Resulting work after the Notes block', () => {
    const direct = makeLinked({
      id: 31,
      title: 'Direct work from item',
      statusName: 'In review',
      assigneeNames: ['Alex Dev'],
    })
    const item = makeItem({
      workItemIds: [direct.id],
      notes: [
        makeNote({
          content: 'Quotation B was agreed.',
        }),
      ],
    })
    renderRecap({
      sortedItems: [item],
      workById: new Map([[direct.id, direct]]),
    })

    const protocol = screen
      .getByRole('heading', { name: 'Protocol' })
      .closest('section')!
    const itemBlock = within(protocol)
      .getByRole('heading', {
        name: 'GPU procurement',
      })
      .closest('li')!
    const notes = within(itemBlock).getByText(
      'Notes',
      { exact: true },
    )
    const work = within(itemBlock).getByText(
      'Resulting work',
      { exact: true },
    )
    expect(
      notes.compareDocumentPosition(work) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('separates block, section, and micro-label hierarchy', () => {
    const item = makeItem({
      notes: [makeNote()],
    })
    renderRecap({ sortedItems: [item] })

    // Block headings (Outcomes / Protocol): 20/28/600,
    // primary text — stronger than section headings ...
    const block = screen.getByRole('heading', {
      name: 'Protocol',
    })
    expect(block).toHaveClass('text-[20px]')
    expect(block).toHaveClass('leading-7')
    expect(block).toHaveClass('font-semibold')
    expect(block).toHaveClass('text-text')

    // ... which are stronger than section headings ...
    const section = screen.getByRole('heading', {
      name: 'TOPs',
    })
    expect(section).toHaveClass('text-base')
    expect(section).toHaveClass('leading-6')
    expect(section).toHaveClass('font-semibold')
    expect(section).toHaveClass('text-text')
    expect(section).toHaveClass(
      'border-border-subtle',
    )

    // ... which are stronger than the quiet micro labels.
    const micro = screen.getByText('Notes', {
      exact: true,
    })
    expect(micro).toHaveClass('text-[11px]')
    expect(micro).toHaveClass('font-semibold')
    expect(micro).toHaveClass('text-text-tertiary')
  })

  it('keeps the Outcomes block on the final compact contract', () => {
    const linked = makeLinked()
    const item = makeItem({
      outcome: 'not_discussed',
      notes: [
        makeNote({ linkedWorkItem: linked }),
      ],
    })
    renderRecap({
      sortedItems: [item],
      workById: new Map([[linked.id, linked]]),
    })

    // Block heading 20/28/600.
    const heading = screen.getByRole('heading', {
      name: 'Outcomes',
    })
    expect(heading).toHaveClass('text-[20px]')
    expect(heading).toHaveClass('leading-7')
    expect(heading).toHaveClass('font-semibold')

    // Subsection label 11/16/600, natural casing.
    const outcomes =
      heading.closest('section')!
    const label = within(outcomes).getByText(
      'Resulting work',
      { exact: true },
    )
    expect(label).toHaveClass('text-[11px]')
    expect(label).toHaveClass('leading-4')
    expect(label).toHaveClass('font-semibold')
    expect(label.className).not.toContain(
      'uppercase',
    )

    // Work rows: 38px min height, cardless, 13px semibold
    // title, 11px secondary metadata.
    const row = within(outcomes).getByRole('button', {
      name: 'Open linked work item: Prepare purchase request',
    })
    expect(row).toHaveClass('min-h-[38px]')
    expect(row.className).not.toContain(
      'border',
    )
    expect(
      within(outcomes).getByText(
        'Paper XYZ · Chris Dev · In progress',
        { exact: true },
      ),
    ).toHaveClass('text-[11px]')
  })

  it('renders Note-linked Work under the exact owning Note', () => {
    const linked = makeLinked()
    const item = makeItem({
      notes: [
        makeNote({
          id: 11,
          content: 'Quotation B was agreed.',
          linkedWorkItem: linked,
        }),
        makeNote({
          id: 12,
          content: 'Unrelated note.',
        }),
      ],
    })
    renderRecap({
      sortedItems: [item],
      workById: new Map([[linked.id, linked]]),
    })

    const noteRow = screen
      .getByText('Quotation B was agreed.', {
        exact: true,
      })
      .closest('li')!
    expect(
      within(noteRow).getByRole('button', {
        name: 'Open linked work item: Prepare purchase request',
      }),
    ).toBeVisible()
    // The relation meta line is Project · Assignee · Status.
    expect(
      within(noteRow).getByText(
        'Paper XYZ · Chris Dev · In progress',
        { exact: true },
      ),
    ).toBeVisible()
    // The other Note has no linked work.
    const otherRow = screen
      .getByText('Unrelated note.', { exact: true })
      .closest('li')!
    expect(
      within(otherRow).queryByRole('button', {
        name: /Open linked work item/i,
      }),
    ).not.toBeInTheDocument()
  })

  it('renders direct item-linked Work under the owning item, not duplicated at the Note', () => {
    const direct = makeLinked({
      id: 31,
      title: 'Direct work from item',
      statusName: 'In review',
      assigneeNames: ['Alex Dev'],
    })
    const linked = makeLinked({
      id: 32,
      title: 'Note work from item',
      statusName: 'Todo',
      assigneeNames: [],
    })
    const item = makeItem({
      workItemIds: [direct.id, linked.id],
      notes: [
        makeNote({ linkedWorkItem: linked }),
      ],
    })
    renderRecap({
      sortedItems: [item],
      workById: new Map([
        [direct.id, direct],
        [linked.id, linked],
      ]),
    })

    const protocol = screen.getByRole('heading', {
      name: 'Protocol',
    }).closest('section')!
    const itemBlock = within(protocol)
      .getByRole('heading', {
        name: 'GPU procurement',
      })
      .closest('li')!

    // The direct link renders at item level.
    expect(
      within(itemBlock).getByRole('button', {
        name: 'Open linked work item: Direct work from item',
      }),
    ).toBeVisible()

    // The Note-linked Work renders under its Note, exactly once.
    expect(
      within(itemBlock).getAllByRole('button', {
        name: 'Open linked work item: Note work from item',
      }),
    ).toHaveLength(1)

    // The direct Work appears once in Outcomes and once in the
    // Protocol (item level) — never more.
    expect(
      screen.getAllByRole('button', {
        name: 'Open linked work item: Direct work from item',
      }),
    ).toHaveLength(2)
  })

  it('keeps empty Sections visible but compact', () => {
    const empty = makeSection({
      id: 2,
      name: 'KVP',
      position: 20,
    })
    const filled = makeItem({ outcome: 'done' })
    render(
      <CompletedMeetingRecap
        sortedSections={[makeSection(), empty]}
        sortedItems={[filled]}
        itemsBySection={itemsBySectionFor([
          filled,
        ])}
        workById={new Map()}
        onOpenLinkedWork={vi.fn()}
      />,
    )

    expect(
      screen.getByRole('heading', { name: 'KVP' }),
    ).toBeVisible()
    expect(
      screen.getByText('No items', { exact: true }),
    ).toBeVisible()
  })

  it('numbers agenda items within their Section', () => {
    const first = makeItem({ id: 3, title: 'First topic' })
    const second = makeItem({
      id: 4,
      title: 'Second topic',
      position: 20,
    })
    renderRecap({
      sortedItems: [first, second],
    })

    const protocol = screen.getByRole('heading', {
      name: 'Protocol',
    }).closest('section')!
    expect(within(protocol).getByText('1', { exact: true })).toBeVisible()
    expect(within(protocol).getByText('2', { exact: true })).toBeVisible()
  })

  it('does not render raw internal status enum values', () => {
    const item = makeItem({
      id: 4,
      title: 'Sample holder issue',
      outcome: 'follow_up',
    })
    const notDiscussed = makeItem({
      id: 5,
      title: 'Tech News',
      outcome: 'not_discussed',
      position: 20,
    })
    const { container } = renderRecap({
      sortedItems: [item, notDiscussed],
    })

    const text = container.textContent ?? ''
    expect(text).not.toContain('not_discussed')
    expect(text).not.toContain('follow_up')
    expect(text).not.toContain('discussing')
  })

  it('uses calm document-style labels, not uppercase UI labels', () => {
    const linked = makeLinked()
    const workItem = makeItem({
      outcome: 'not_discussed',
      notes: [makeNote({ linkedWorkItem: linked })],
    })
    const followUpItem = makeItem({
      id: 4,
      title: 'Sample holder issue',
      outcome: 'follow_up',
    })
    const { container } = renderRecap({
      sortedItems: [workItem, followUpItem],
      workById: new Map([[linked.id, linked]]),
    })

    // Sentence case, and the small-caps micro-label treatment is
    // gone.
    expect(
      screen.getAllByText('Follow-ups', { exact: true }),
    ).toHaveLength(1)
    expect(
      screen.getAllByText('Notes', { exact: true }),
    ).toHaveLength(1)
    const text = container.textContent ?? ''
    expect(text).not.toContain('FOLLOW-UPS')
    expect(text).not.toContain('NOTES')
  })

  it('renders the canonical Project status definition name for direct Work Items', () => {
    // The canonical source is the Project Work Item configuration
    // (statusDefinitionId -> definition name), never the legacy
    // fixed status string. statusName is what the recap rows
    // consume, so this asserts the resolved display contract.
    const direct = makeLinked({
      id: 21,
      title: 'Direct item work',
      statusName: 'In review (canonical)',
      assigneeNames: [],
    })
    const item = makeItem({
      outcome: 'not_discussed',
      workItemIds: [21],
    })
    renderRecap({
      sortedItems: [item],
      workById: new Map([[21, direct]]),
    })

    const section = screen
      .getByRole('heading', { name: 'Outcomes' })
      .closest('section')!
    expect(section).toHaveTextContent('In review (canonical)')
    // The legacy fixed status string is never the displayed source.
    expect(section).not.toHaveTextContent('in_progress')
  })
})
