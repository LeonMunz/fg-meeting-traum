// @vitest-environment happy-dom
//
// Rendered behavioral tests for the Live Meeting focus pane:
// the approved Stitch-style container renders the SELECTED
// topic's canonical Markdown document in full (no redundant
// derived title, no truncation, no internal scroll), the topic
// context (Section · x of y, contributor with relative creation
// time), and keeps the existing Notes area below the document.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  MemoryRouter,
  Route,
  Routes,
} from 'react-router'

import * as meetingsApi from '../../api/meetings'
import * as projectsApi from '../../api/projects'
import type {
  ApiMeeting,
  ApiMeetingItem,
  ApiMeetingNote,
  ApiMeetingParticipant,
  ApiMeetingSection,
  ApiProject,
} from '../../api/types'

import { MeetingDetailPage } from './MeetingDetailPage'

vi.mock('../../api/meetings', async (importOriginal) => {
  const actual = await importOriginal<typeof meetingsApi>()
  return {
    ...actual,
    getMeeting: vi.fn(),
    listMeetingParticipants: vi.fn(),
    listMeetingItems: vi.fn(),
    listMeetingSections: vi.fn(),
  }
})

vi.mock('../../api/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof projectsApi>()
  return {
    ...actual,
    getProject: vi.fn(),
  }
})

const sessionMock = vi.hoisted(() => ({
  user: {
    id: 2,
    username: 'chris',
    firstName: 'Chris',
    lastName: 'Example',
  } as {
    id: number
    username: string
    firstName: string
    lastName: string
  },
}))

vi.mock('../../api/useSession', () => ({
  useSession: () => ({ user: sessionMock.user }),
}))

vi.mock('../research-group/useResearchGroup', () => ({
  useResearchGroup: () => ({
    groups: [
      { id: 3, name: 'FG Group', role: 'member' },
    ],
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

/* ── Fixtures ────────────────────────────────────────────────── */

const MEETING_ID = 11
const SECTION_ID = 21

const SECTION: ApiMeetingSection = {
  id: SECTION_ID,
  meetingId: MEETING_ID,
  sourceSeriesSectionId: null,
  name: 'Agenda',
  description: '',
  position: 0,
  isVisible: true,
}

// One hour before "now": the relative label is the stable
// '1h ago' for the duration of a test run.
const HOUR_AGO = new Date(
  Date.now() - 3_600_000,
).toISOString()

const PARTICIPANT: ApiMeetingParticipant = {
  id: 301,
  user: {
    id: 2,
    username: 'chris',
    firstName: 'Chris',
    lastName: 'Example',
  },
  addedAt: '2026-09-01T09:00:00Z',
}

// The canonical topic document: heading, paragraph with inline
// bold, bullets, a link, an ordered list, and a closing
// paragraph with inline code that must stay fully visible.
const FOCUS_TOPIC_CONTENT = [
  '## Journal submission deadline',
  '',
  'Clarify the **deadline** and the requirements.',
  '',
  '- Review the target journal',
  '- Compare [the submission requirements](https://example.com/reqs)',
  '',
  '1. Confirm dates',
  '2. Assign authors',
  '',
  'Closing paragraph with `inline code` that must stay visible.',
].join('\n')

function makeItem(
  overrides: Partial<ApiMeetingItem> = {},
): ApiMeetingItem {
  return {
    id: 41,
    meetingId: MEETING_ID,
    meetingSectionId: SECTION_ID,
    // The derived compatibility title of FOCUS_TOPIC_CONTENT.
    title: 'Journal submission deadline',
    contextNotes: '',
    content: FOCUS_TOPIC_CONTENT,
    position: 0,
    outcome: 'not_discussed',
    followUpSchedule: null,
    workItemIds: [],
    notes: [],
    createdById: 2,
    createdAt: HOUR_AGO,
    updatedAt: HOUR_AGO,
    ...overrides,
  }
}

function makeNote(
  overrides: Partial<ApiMeetingNote> = {},
): ApiMeetingNote {
  return {
    id: 71,
    meetingItemId: 41,
    author: {
      id: 2,
      username: 'chris',
      firstName: 'Chris',
      lastName: 'Example',
    },
    content: 'Quotation B is significantly cheaper.',
    createdAt: HOUR_AGO,
    updatedAt: HOUR_AGO,
    linkedWorkItem: null,
    ...overrides,
  }
}

function makeMeeting(
  overrides: Partial<ApiMeeting> = {},
): ApiMeeting {
  return {
    id: MEETING_ID,
    researchGroupId: 3,
    scope: 'group',
    projectId: null,
    seriesId: null,
    title: 'FG Weekly',
    scheduledAt: '2026-09-01T09:00:00Z',
    startedAt: '2026-09-01T09:01:00Z',
    endedAt: null,
    status: 'live',
    currentMeetingItemId: 41,
    participantIds: [1, 2],
    createdById: 1,
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-01T09:01:00Z',
    ...overrides,
  }
}

function makeProject(
  overrides: Partial<ApiProject> = {},
): ApiProject {
  return {
    id: 9,
    researchGroupId: 3,
    name: 'Collab Project',
    description: '',
    status: 'active',
    archivedAt: null,
    currentUserRole: 'member',
    createdAt: '2026-09-01T09:00:00Z',
    updatedAt: '2026-09-01T09:00:00Z',
    ...overrides,
  }
}

function renderPage(
  meeting: ApiMeeting,
  items: ApiMeetingItem[] = [makeItem()],
  participants: ApiMeetingParticipant[] = [PARTICIPANT],
  project: ApiProject | null = null,
) {
  vi.mocked(meetingsApi.getMeeting).mockResolvedValue(
    meeting,
  )
  vi.mocked(
    meetingsApi.listMeetingParticipants,
  ).mockResolvedValue(participants)
  vi.mocked(meetingsApi.listMeetingItems).mockResolvedValue(
    items,
  )
  vi.mocked(
    meetingsApi.listMeetingSections,
  ).mockResolvedValue([SECTION])
  vi.mocked(projectsApi.getProject).mockResolvedValue(
    project as ApiProject,
  )

  return render(
    <MemoryRouter initialEntries={[`/meetings/${MEETING_ID}`]}>
      <Routes>
        <Route
          path="/meetings/:meetingId"
          element={<MeetingDetailPage />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

// The approved focus-pane container (the right column).
function pane(): HTMLElement {
  const el = document.querySelector(
    '[data-live-focus-pane]',
  )
  expect(el).not.toBeNull()
  return el as HTMLElement
}

const workspace = () =>
  within(screen.getByRole('main', { name: 'Agenda item' }))

// A rendered Markdown block identified by its EXACT text
// content (inline formatting splits the node's children, so
// match on textContent).
function findBlock(
  scope: HTMLElement,
  text: string,
) {
  return within(scope).getByText(
    (_content, element) =>
      element?.textContent === text,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionMock.user = {
    id: 2,
    username: 'chris',
    firstName: 'Chris',
    lastName: 'Example',
  }
})

afterEach(() => {
  cleanup()
})

/* ── Behavioral assertions ───────────────────────────────────── */

describe('Live Meeting focus pane (approved Stitch container)', () => {

  it('renders the quiet container contract (surface, border, radius, padding, min height)', async () => {
    renderPage(makeMeeting())
    await waitFor(() => {
      expect(pane().textContent).toContain(
        'Journal submission deadline',
      )
    })

    const section = pane()
    expect(section).toHaveClass(
      'bg-surface-subtle',
      'rounded-[8px]',
      'border-border-subtle',
      'p-6',
      'min-h-[460px]',
      'flex',
      'flex-col',
    )
    // No shadow, no internal scroll region: the pane grows
    // with the document.
    expect(section.className).not.toMatch(/shadow/)
    expect(section.className).not.toContain('overflow-')
    expect(section.className).not.toContain('max-h-')
  })

  it('renders the complete canonical Markdown document (headings, lists, links, inline formatting)', async () => {
    renderPage(makeMeeting())
    await waitFor(() => {
      expect(
        screen.getByRole('heading', {
          name: 'Journal submission deadline',
        }),
      ).toBeVisible()
    })

    const doc = within(pane())
    expect(
      findBlock(
        pane(),
        'Clarify the deadline and the requirements.',
      ),
    ).toBeTruthy()
    expect(doc.getByText('Review the target journal')).toBeTruthy()
    expect(
      doc.getByRole('link', {
        name: 'the submission requirements',
      }),
    ).toBeVisible()
    expect(
      doc.getByRole('link', {
        name: 'the submission requirements',
      }),
    ).toHaveAttribute('href', 'https://example.com/reqs')
    expect(doc.getByText('Confirm dates')).toBeTruthy()
    expect(doc.getByText('Assign authors')).toBeTruthy()
    // The LAST block of the document is in the pane: nothing
    // is truncated or clamped.
    expect(
      findBlock(
        pane(),
        'Closing paragraph with inline code that must stay visible.',
      ),
    ).toBeTruthy()
  })

  it('keeps a long Markdown document (well over 255 chars) completely visible', async () => {
    const longContent = [
      '## Long topic',
      '',
      ...Array.from(
        { length: 40 },
        (_, i) => `Paragraph ${i + 1} body text.`,
      ),
    ].join('\n')
    renderPage(makeMeeting(), [
      makeItem({
        title: 'Long topic',
        content: longContent,
      }),
    ])

    // FIRST and LAST paragraph are both present.
    await waitFor(() => {
      expect(
        screen.getByRole('heading', {
          name: 'Long topic',
        }),
      ).toBeVisible()
    })
    expect(
      pane().textContent,
    ).toContain('Paragraph 1 body text.')
    expect(
      pane().textContent,
    ).toContain('Paragraph 40 body text.')

    // The pane still carries the growth contract: a minimum
    // height, no max height, no internal scrolling.
    const section = pane()
    expect(section).toHaveClass('min-h-[460px]')
    expect(section.className).not.toContain('max-h-')
    expect(section.className).not.toContain('overflow-')
  })

  it('does not repeat the derived title above its own Markdown document', async () => {
    renderPage(makeMeeting())
    await waitFor(() => {
      expect(
        screen.getByRole('heading', {
          name: 'Journal submission deadline',
        }),
      ).toBeVisible()
    })

    // Exactly ONE heading with the derived title text: the
    // document's own heading — never a second heading above
    // the same content.
    const headings = screen.getAllByRole('heading', {
      name: 'Journal submission deadline',
    })
    expect(headings).toHaveLength(1)
    // ...and it sits inside the document block.
    expect(
      headings[0].closest('div.mt-4'),
    ).not.toBeNull()
  })

  it('renders legacy migrated topics (plain backfilled content) without a duplicated opening line', async () => {
    // A backfilled legacy item: content is the plain title
    // line (no Markdown syntax of its own).
    renderPage(makeMeeting(), [
      makeItem({
        title: 'Budget review',
        content: 'Budget review',
      }),
    ])

    await waitFor(() => {
      expect(
        within(pane()).getByText('Budget review', {
          exact: true,
        }),
      ).toBeTruthy()
    })

    // The opening line appears exactly ONCE in the pane.
    expect(
      within(pane()).getAllByText('Budget review', {
        exact: true,
      }),
    ).toHaveLength(1)
  })

  it('shows the Section name and section-local topic position', async () => {
    const items = [
      makeItem({ id: 41, title: 'One', content: 'One', position: 0 }),
      makeItem({ id: 42, title: 'Two', content: 'Two', position: 1 }),
      makeItem({ id: 43, title: 'Three', content: 'Three', position: 2 }),
      makeItem({ id: 44, title: 'Four', content: 'Four', position: 3 }),
    ]
    renderPage(
      makeMeeting({ currentMeetingItemId: 42 }),
      items,
    )

    await waitFor(() => {
      expect(
        within(pane()).getByText('Agenda · 2 of 4'),
      ).toBeTruthy()
    })
    // The SELECTED (viewed) item is the current one here.
    expect(
      within(pane()).getByText('Two', { exact: true }),
    ).toBeTruthy()
  })

  it('shows the contributor avatar, name, and relative creation time', async () => {
    // The item's creator (createdById 2) is a visible
    // participant (Chris Example): resolved contributor line
    // with initials avatar.
    renderPage(makeMeeting())
    await waitFor(() => {
      expect(
        within(pane()).getByText('Chris Example · 1h ago'),
      ).toBeTruthy()
    })

    const avatar = pane().querySelector('span.rounded-full')
    expect(avatar).not.toBeNull()
    expect(avatar?.textContent).toBe('CE')
  })

  it('degrades the contributor line to the relative time alone when the creator is not a visible participant', async () => {
    renderPage(
      makeMeeting(),
      [makeItem({ createdById: 99 })],
      [PARTICIPANT],
    )

    await waitFor(() => {
      expect(pane().textContent).toContain('1h ago')
    })
    expect(pane().textContent).not.toContain(
      'Chris Example',
    )
    expect(
      pane().querySelector('span.rounded-full'),
    ).toBeNull()
  })

  it('keeps the Notes area below the topic document, scoped to the selected item', async () => {
    renderPage(makeMeeting(), [
      makeItem({ notes: [makeNote()] }),
    ])

    await waitFor(() => {
      expect(
        within(pane()).getByText(
          'Quotation B is significantly cheaper.',
        ),
      ).toBeTruthy()
    })

    // DOM order inside the pane: the Markdown document block
    // precedes the Notes list.
    const documentBlock = pane().querySelector(
      'div.mt-4',
    ) as HTMLElement
    const notesList = pane().querySelector('ul')
    expect(documentBlock).not.toBeNull()
    expect(notesList).not.toBeNull()
    expect(
      documentBlock.compareDocumentPosition(
        notesList as Node,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    // Note attribution survives the move.
    expect(pane().textContent).toContain('Chris Example')
  })

  it('keeps a calm no-current state inside the pane', async () => {
    renderPage(
      makeMeeting({ currentMeetingItemId: null }),
      [
        makeItem({
          id: 41,
          title: 'One',
          content: 'One',
          outcome: 'done',
        }),
        makeItem({
          id: 42,
          title: 'Two',
          content: 'Two',
          position: 1,
        }),
      ],
    )

    await waitFor(() => {
      expect(pane().textContent).toContain('No current item')
    })
    expect(
      pane().textContent,
    ).toContain('Select an open agenda item to start')
  })

  it('keeps Make current / Return to current reachable for a non-current selection', async () => {
    const items = [
      makeItem({
        id: 41,
        title: 'One',
        content: 'One',
        outcome: 'done',
      }),
      makeItem({
        id: 42,
        title: 'Two',
        content: 'Two',
        position: 1,
      }),
    ]
    renderPage(
      makeMeeting({ currentMeetingItemId: 42 }),
      items,
    )

    // Browse the non-current item through the agenda rail.
    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: 'View item One',
        }),
      ).toBeTruthy()
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: 'View item One',
      }),
    )

    await waitFor(() => {
      expect(
        within(pane()).getByText('One', { exact: true }),
      ).toBeTruthy()
    })
    expect(
      workspace().getByRole('button', {
        name: 'Return to current',
      }),
    ).toBeVisible()
    expect(
      workspace().getByRole('button', {
        name: 'Make One current',
      }),
    ).toBeVisible()
  })

  it('gives a read-only project viewer the document and Notes, but no lifecycle actions', async () => {
    // Project Meeting: the user has Project access (member) but
    // is neither creator nor participant — no collaboration
    // (lifecycle) controls.
    renderPage(
      makeMeeting({
        scope: 'project',
        projectId: 9,
        participantIds: [1],
      }),
      [makeItem({ notes: [makeNote()] })],
      [],
      makeProject({ currentUserRole: 'member' }),
    )

    // The full document still renders for readers…
    await waitFor(() => {
      expect(
        screen.getByRole('heading', {
          name: 'Journal submission deadline',
        }),
      ).toBeVisible()
    })
    expect(
      within(pane()).getByText(
        'Quotation B is significantly cheaper.',
      ),
    ).toBeTruthy()

    // …but no lifecycle / resolution actions are offered.
    expect(
      screen.queryByRole('button', {
        name: 'Mark Journal submission deadline as done',
      }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', {
        name: /Schedule follow-up/ ,
      }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'End meeting' }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', {
        name: /Add (?:first )?item/,
      }),
    ).toBeNull()
  })
})
