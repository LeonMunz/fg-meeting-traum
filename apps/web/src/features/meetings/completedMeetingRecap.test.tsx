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
    status: 'done',
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
      status: 'follow_up',
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
        name: 'Current item',
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
      status: 'follow_up',
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
    expect(reopen.className).toContain('text-on-surface-variant')
    expect(reopen.className).not.toContain('border')
    expect(reopen.className).not.toContain('bg-primary')

    user.click(reopen)
    await waitFor(() =>
      expect(meetingsApi.reopenMeeting).toHaveBeenCalledWith(
        9,
      ),
    )
  })

  it('shows non-zero outcome counts once in the header', async () => {
    const linked = makeLinked()
    const workItem = makeItem({
      status: 'done',
      notes: [
        makeNote({ linkedWorkItem: linked }),
      ],
    })
    const followUpItem = makeItem({
      id: 4,
      title: 'Sample holder issue',
      status: 'follow_up',
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

  it('keeps the recap content (protocol items, notes, linked work) unchanged', async () => {
    const linked = makeLinked()
    const item = makeItem({
      title: 'GPU procurement',
      status: 'done',
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
      status: 'done',
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
      status: 'follow_up',
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
    const item = makeItem({ status: 'done' })
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
      status: 'done',
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
    expect(section).toHaveTextContent(
      'Chris Dev · Paper XYZ · In progress',
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
      status: 'done',
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
    expect(section).toHaveTextContent(
      'Unassigned · Paper XYZ · Todo',
    )
  })

  it('deduplicates the same Work Item reachable through Note and direct item links', () => {
    const linked = makeLinked()
    const item = makeItem({
      status: 'done',
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
      status: 'done',
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
      status: 'done',
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
      status: 'follow_up',
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

  it('keeps outcome counts out of the recap content (header owns them)', () => {
    const linked = makeLinked()
    const workItem = makeItem({
      status: 'done',
      notes: [
        makeNote({ linkedWorkItem: linked }),
      ],
    })
    const followUpItem = makeItem({
      id: 4,
      title: 'Sample holder issue',
      status: 'follow_up',
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
      status: 'follow_up',
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
  it('does not show a redundant Done badge on ordinary completed items', () => {
    const item = makeItem({ status: 'done' })
    renderRecap({ sortedItems: [item] })

    expect(
      screen.getByRole('heading', {
        name: 'GPU procurement',
      }),
    ).toBeVisible()
    expect(
      screen.queryByText('Done', { exact: true }),
    ).not.toBeInTheDocument()
  })

  it('shows Not discussed for not_discussed items', () => {
    const item = makeItem({
      id: 5,
      title: 'Tech News',
      status: 'not_discussed',
    })
    renderRecap({ sortedItems: [item] })

    expect(
      screen.getByText('Not discussed', {
        exact: true,
      }),
    ).toBeVisible()
  })

  it('shows a Follow-up marker for follow_up items in the Protocol', () => {
    const item = makeItem({
      id: 4,
      title: 'Sample holder issue',
      status: 'follow_up',
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
    const filled = makeItem({ status: 'done' })
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
      status: 'follow_up',
    })
    const notDiscussed = makeItem({
      id: 5,
      title: 'Tech News',
      status: 'not_discussed',
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
      status: 'done',
      notes: [makeNote({ linkedWorkItem: linked })],
    })
    const followUpItem = makeItem({
      id: 4,
      title: 'Sample holder issue',
      status: 'follow_up',
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
      status: 'done',
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
