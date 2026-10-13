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
import * as workItemsApi from '../../api/work-items'
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
    createMeetingNote: vi.fn(),
    deleteMeetingNote: vi.fn(),
  deleteMeetingItem: vi.fn(),
    getMeeting: vi.fn(),
    listMeetingParticipants: vi.fn(),
    listMeetingItems: vi.fn(),
    listMeetingSections: vi.fn(),
    updateMeetingNote: vi.fn(),
    markMeetingItemDone: vi.fn(),
    reopenMeetingItem: vi.fn(),
  }
})

vi.mock('../../api/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof projectsApi>()
  return {
    ...actual,
    getProject: vi.fn(),
  }
})

vi.mock('../../api/work-items', async (importOriginal) => {
  const actual = await importOriginal<typeof workItemsApi>()
  return {
    ...actual,
    getWorkItem: vi.fn(),
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
    actionPermissions: { canEdit: true, canDelete: true, canCancel: false },
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

/* ── Direct inline editing of persisted Meeting Notes ────────── */

const NOTE_TRIGGER_NAME =
  'Edit note on Journal submission deadline: Quotation B is significantly cheaper.'
const NOTE_EDITOR_NAME = 'Edit note on Journal submission deadline'

function renderLiveWithNote(
  noteOverrides: Partial<ApiMeetingNote> = {},
  notes?: ApiMeetingNote[],
) {
  return renderPage(
    makeMeeting(),
    [
      makeItem({
        notes:
          notes ?? [makeNote(noteOverrides)],
      }),
    ],
  )
}

async function openNoteEditor(
  content = 'Quotation B is significantly cheaper.',
) {
  const trigger = await screen.findByRole('button', {
    name: `Edit note on Journal submission deadline: ${content}`,
  })
  fireEvent.click(trigger)

  const editor = await screen.findByRole('textbox', {
    name: NOTE_EDITOR_NAME,
  })
  return { trigger, editor }
}

describe('Live Meeting focus pane (direct MeetingNote editing)', () => {
  it('opens the existing inline editor immediately when note content is clicked', async () => {
    renderLiveWithNote()

    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: NOTE_TRIGGER_NAME,
        }),
      ).toBeVisible()
    })

    fireEvent.click(
      screen.getByRole('button', {
        name: NOTE_TRIGGER_NAME,
      }),
    )

    const editor = await screen.findByRole(
      'textbox',
      { name: NOTE_EDITOR_NAME },
    )
    // The current persisted content populates the editor…
    expect(editor).toHaveValue(
      'Quotation B is significantly cheaper.',
    )
    // …and receives keyboard focus immediately.
    expect(editor).toHaveFocus()
    // The autosave model offers no Save / Cancel controls:
    // focus-leave persists, Escape discards.
    expect(
      screen.queryByRole('button', { name: 'Save' }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Cancel' }),
    ).toBeNull()
  })

  it('retains the approved resting typography on the edit trigger', async () => {
    renderLiveWithNote()

    const trigger = await screen.findByRole(
      'button',
      { name: NOTE_TRIGGER_NAME },
    )
    // The approved resting typography (font size, line
    // height, color, wrapping, and the menu clearance
    // padding) must survive the conversion to an interactive
    // trigger.
    expect(trigger).toHaveClass(
      'whitespace-pre-wrap',
      'pr-16',
      'text-sm',
      'leading-6',
      'text-text',
    )
    // Discoverability is quiet: a text cursor and a keyboard
    // focus ring — no border or button chrome classes.
    expect(trigger).toHaveClass('cursor-text')
    expect(trigger).toHaveClass(
      'focus-visible:ring-2',
      'focus-visible:ring-focus',
    )
    expect(trigger.className).not.toContain(
      'border-',
    )
  })

  it('opens the editor on keyboard activation (Enter and Space)', async () => {
    renderLiveWithNote()

    const trigger = await screen.findByRole(
      'button',
      { name: NOTE_TRIGGER_NAME },
    )
    trigger.focus()

    // Enter opens the editor.
    fireEvent.keyDown(trigger, { key: 'Enter' })
    const editor = await screen.findByRole(
      'textbox',
      { name: NOTE_EDITOR_NAME },
    )
    expect(editor).toHaveFocus()

    // Escape returns to display mode…
    fireEvent.keyDown(editor, { key: 'Escape' })
    await waitFor(() => {
      expect(
        screen.queryByRole('textbox', {
          name: NOTE_EDITOR_NAME,
        }),
      ).toBeNull()
    })
    // The display trigger re-mounts for the new render; re-query
    // the fresh node before the next activation.
    const freshTrigger = screen.getByRole('button', {
      name: NOTE_TRIGGER_NAME,
    })
    expect(freshTrigger).toBeTruthy()

    // …and Space opens it again.
    fireEvent.keyDown(freshTrigger, { key: ' ' })
    expect(
      await screen.findByRole('textbox', {
        name: NOTE_EDITOR_NAME,
      }),
    ).toHaveFocus()
  })

  it('discards the unsaved edit on Escape and restores the saved display', async () => {
    renderLiveWithNote()
    const { editor } = await openNoteEditor()

    fireEvent.change(editor, {
      target: { value: 'Unsaved change.' },
    })
    fireEvent.keyDown(editor, { key: 'Escape' })

    await waitFor(() => {
      expect(
        screen.queryByRole('textbox', {
          name: NOTE_EDITOR_NAME,
        }),
      ).toBeNull()
    })
    expect(
      screen.getByRole('button', {
        name: NOTE_TRIGGER_NAME,
      }),
    ).toBeTruthy()
    expect(
      meetingsApi.updateMeetingNote,
    ).not.toHaveBeenCalled()
  })

  it('sends no request when leaving the editor unchanged', async () => {
    renderLiveWithNote()
    const { editor } = await openNoteEditor()

    // Leaving the editor with the persisted content untouched
    // returns to display mode without any API request.
    fireEvent.blur(editor)

    await waitFor(() => {
      expect(
        screen.queryByRole('textbox', {
          name: NOTE_EDITOR_NAME,
        }),
      ).toBeNull()
    })
    expect(
      screen.getByRole('button', {
        name: NOTE_TRIGGER_NAME,
      }),
    ).toBeTruthy()
    expect(
      meetingsApi.updateMeetingNote,
    ).not.toHaveBeenCalled()
  })

  it('saves through the existing API and returns to display mode', async () => {
    const updatedNote = makeNote({
      content: 'Trimmed save.',
      updatedAt: HOUR_AGO,
    })
    vi.mocked(
      meetingsApi.updateMeetingNote,
    ).mockResolvedValue(updatedNote)

    renderLiveWithNote()
    const { editor } = await openNoteEditor()

    // Surrounding whitespace is trimmed on save (existing
    // saveNoteEdit contract); focus-leave triggers it.
    fireEvent.change(editor, {
      target: { value: '  Trimmed save.  ' },
    })
    fireEvent.blur(editor)

    await waitFor(() => {
      expect(
        meetingsApi.updateMeetingNote,
      ).toHaveBeenCalledWith(71, {
        content: 'Trimmed save.',
      })
    })
    await waitFor(() => {
      expect(
        screen.queryByRole('textbox', {
          name: NOTE_EDITOR_NAME,
        }),
      ).toBeNull()
    })
    expect(
      screen.getByRole('button', {
        name: 'Edit note on Journal submission deadline: Trimmed save.',
      }),
    ).toBeTruthy()
  })

  it('keeps the draft and offers a retry after a failed autosave', async () => {
    vi.mocked(
      meetingsApi.updateMeetingNote,
    ).mockRejectedValue(
      new Error('Simulated save failure.'),
    )

    renderLiveWithNote()
    const { editor } = await openNoteEditor()

    fireEvent.change(editor, {
      target: { value: 'Broken save.' },
    })
    fireEvent.blur(editor)

    // The quiet inline error (role=alert) reports the failure…
    const alertText = await screen.findByText(
      'Simulated save failure.',
    )
    expect(alertText.closest('[role="alert"]')).not.toBeNull()
    // …and the draft stays editable (not lost).
    expect(
      screen.getByRole('textbox', {
        name: NOTE_EDITOR_NAME,
      }),
    ).toHaveValue('Broken save.')

    // The next focus-leave retries the same draft…
    vi.mocked(
      meetingsApi.updateMeetingNote,
    ).mockResolvedValue(
      makeNote({
        content: 'Broken save.',
        updatedAt: HOUR_AGO,
      }),
    )
    fireEvent.blur(editor)

    await waitFor(() => {
      expect(
        meetingsApi.updateMeetingNote,
      ).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(
        screen.queryByRole('textbox', {
          name: NOTE_EDITOR_NAME,
        }),
      ).toBeNull()
    })
    expect(
      screen.getByRole('button', {
        name: 'Edit note on Journal submission deadline: Broken save.',
      }),
    ).toBeTruthy()
  })

  it('does not let a second note open while a draft is unsaved', async () => {
    renderLiveWithNote({}, [
      makeNote({ id: 71, content: 'First note.' }),
      makeNote({ id: 72, content: 'Second note.' }),
    ])

    await screen.findByRole('button', {
      name: 'Edit note on Journal submission deadline: First note.',
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Edit note on Journal submission deadline: First note.',
      }),
    )
    const editor = await screen.findByRole(
      'textbox',
      { name: NOTE_EDITOR_NAME },
    )
    fireEvent.change(editor, {
      target: { value: 'First note, drafted.' },
    })

    // Clicking the OTHER note's content must not silently
    // replace the open draft.
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Edit note on Journal submission deadline: Second note.',
      }),
    )
    expect(
      screen.getByRole('textbox', {
        name: NOTE_EDITOR_NAME,
      }),
    ).toHaveValue('First note, drafted.')
    expect(
      screen.getByRole('button', {
        name: 'Edit note on Journal submission deadline: Second note.',
      }),
    ).toBeTruthy()

    // Resolving the open editor (Escape discards the draft)
    // restores the saved display.
    fireEvent.keyDown(editor, { key: 'Escape' })
    await waitFor(() => {
      expect(
        screen.queryByRole('textbox', {
          name: NOTE_EDITOR_NAME,
        }),
      ).toBeNull()
    })
    expect(
      screen.getByRole('button', {
        name: 'Edit note on Journal submission deadline: First note.',
      }),
    ).toBeTruthy()
  })

  it('replaces the note action menu with compact hover icons and keeps delete working', async () => {
    vi.mocked(
      meetingsApi.deleteMeetingNote,
    ).mockResolvedValue(undefined)

    renderLiveWithNote()
    const trigger = await screen.findByRole(
      'button',
      { name: NOTE_TRIGGER_NAME },
    )

    // No three-dot menu for the note anymore…
    expect(
      screen.queryByRole('button', {
        name: /Note actions for/,
      }),
    ).toBeNull()
    // …and no menu of any kind on the note row: clicking the
    // content is the only edit path.
    const row = trigger.closest('li')
    expect(row).not.toBeNull()
    expect(
      row?.querySelector('[aria-haspopup="menu"]'),
    ).toBeNull()

    // The row reveals a compact delete icon hidden at rest…
    const deleteButton = screen.getByRole(
      'button',
      {
        name: 'Delete note: Quotation B is significantly cheaper.',
      },
    )
    const actions = deleteButton.parentElement
    expect(actions).not.toBeNull()
    expect(actions).toHaveClass(
      'opacity-0',
      'group-hover/note:opacity-100',
      'focus-within:opacity-100',
    )
    // …small and quiet: 28px quiet icon button with 16px outline
    // artwork, pinned by the local .fg-live-note-action-icon rule
    // (the external 24px Material Symbols default is unlayered and
    // would otherwise win over the utilities layer).
    expect(deleteButton).toHaveClass(
      'flex',
      'h-7',
      'w-7',
      'items-center',
      'justify-center',
      'rounded',
      'text-text-muted',
      'hover:bg-surface-hover',
    )
    expect(
      deleteButton.querySelector(
        '.material-symbols-outlined',
      ),
    ).toHaveClass(
      'text-[16px]',
      'fg-live-note-action-icon',
    )

    // Deleting still goes through the confirmation…
    fireEvent.click(deleteButton)
    const dialog = await screen.findByRole(
      'dialog',
      { name: 'Delete note?' },
    )
    expect(
      within(dialog).getByRole('button', {
        name: 'Delete note',
      }),
    ).toBeVisible()
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'Delete note',
      }),
    )

    await waitFor(() => {
      expect(
        meetingsApi.deleteMeetingNote,
      ).toHaveBeenCalledWith(71)
    })
    await waitFor(() => {
      expect(
        screen.queryByRole('button', {
          name: NOTE_TRIGGER_NAME,
        }),
      ).toBeNull()
    })
  })

  it('keeps a refined, small Work Item icon aligned with the delete icon', async () => {
    renderLiveWithNote()
    await screen.findByRole('button', {
      name: NOTE_TRIGGER_NAME,
    })

    const workItemButton = screen.getByRole(
      'button',
      {
        name: 'Create work item from note: Quotation B is significantly cheaper.',
      },
    )
    const deleteButton = screen.getByRole(
      'button',
      {
        name: 'Delete note: Quotation B is significantly cheaper.',
      },
    )

    // Both icons share the same compact treatment…
    for (const button of [workItemButton, deleteButton]) {
      expect(button).toHaveClass(
        'flex',
        'h-7',
        'w-7',
        'items-center',
        'justify-center',
        'rounded',
        'text-text-muted',
        'hover:bg-surface-hover',
      )
      expect(
        button.querySelector(
          '.material-symbols-outlined',
        ),
      ).toHaveClass(
        'text-[16px]',
        'fg-live-note-action-icon',
      )
    }
    // …in one horizontally aligned group that sits at the row's
    // top-right, centered on the Note's first text line, revealed
    // only on hover / keyboard focus.
    const actions = workItemButton.parentElement
    expect(actions).toHaveClass(
      'absolute',
      'right-2',
      'top-0.5',
      'flex',
      'items-center',
      'gap-0.5',
      'opacity-0',
      'group-hover/note:opacity-100',
      'focus-within:opacity-100',
    )

    // The action still opens the Work Item flow.
    fireEvent.click(workItemButton)
    const dialog = await screen.findByRole(
      'dialog',
    )
    expect(
      within(dialog).getByRole('heading', {
        name: 'Create work item',
      }),
    ).toBeTruthy()
  })

  it('does not open note editing when a linked Work Item card is clicked', async () => {
    vi.mocked(
      workItemsApi.getWorkItem,
    ).mockRejectedValue(
      new Error('Offline inspector.'),
    )

    renderLiveWithNote({
      linkedWorkItem: {
        id: 501,
        title: 'Ship the quote comparison',
        projectId: 9,
        projectName: 'Collab Project',
        statusName: 'Todo',
        assigneeNames: [],
      },
    })

    const card = await screen.findByRole('button', {
      name: 'Open linked work item: Ship the quote comparison',
    })
    fireEvent.click(card)

    // The click opened the Work Item flow, not the Note
    // editor; the Note trigger stays in display mode.
    expect(
      screen.queryByRole('textbox', {
        name: NOTE_EDITOR_NAME,
      }),
    ).toBeNull()
    expect(
      screen.getByRole('button', {
        name: NOTE_TRIGGER_NAME,
      }),
    ).toBeTruthy()
  })

  it('offers no interactive edit trigger for a completed Meeting', async () => {
    renderPage(
      makeMeeting({
        status: 'completed',
        endedAt: '2026-09-01T10:00:00Z',
      }),
      [makeItem({ notes: [makeNote()] })],
    )

    // The persisted Note survives as read-only protocol…
    await waitFor(() => {
      expect(
        screen.getByText(
          'Quotation B is significantly cheaper.',
        ),
      ).toBeTruthy()
    })
    // …with neither the direct edit trigger, the note action
    // menu (already removed), nor the delete icon offered.
    expect(
      screen.queryByRole('button', {
        name: /Edit note on/,
      }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', {
        name: /Note actions for/,
      }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', {
        name: /Delete note:/,
      }),
    ).toBeNull()
  })
})

/* ── Seamless (borderless) Note editing presentation ─────────── */

describe('Live Meeting focus pane (seamless Note editor)', () => {
  it('presents the editor as a borderless inline surface matching the resting typography', async () => {
    renderLiveWithNote()
    const { editor } = await openNoteEditor()

    // Same typography as the resting Note (size, leading, color,
    // wrapping) with no padding shift…
    expect(editor).toHaveClass(
      'text-sm',
      'leading-6',
      'text-text',
      'whitespace-pre-wrap',
      'bg-transparent',
      'p-0',
      'outline-none',
    )
    // …and no input box, card, panel, or resize handle.
    expect(editor).not.toHaveClass(
      'border',
      'border-2',
      'rounded-lg',
      'border-default',
      'bg-surface',
      'px-2',
      'py-1.5',
      'resize-y',
    )
    expect(editor.className).not.toContain('ring')
    // Single-line Notes open at one line; the field height is
    // managed programmatically (auto-grow) rather than by rows.
    expect(editor).toHaveClass(
      'resize-none',
      'overflow-hidden',
    )
    expect(editor).toHaveAttribute('rows', '1')
    expect(editor.style.height).toMatch(/\d+px$/)
    // The editor sits directly in the Note row — the same
    // position the resting content occupies (the Notes list is
    // the ul.space-y-5, never the topic document's bullet lists).
    expect(editor.closest('li')).not.toBeNull()
    expect(
      pane().querySelectorAll('ul.space-y-5 li'),
    ).toHaveLength(1)
  })

  it('keeps a quiet, perceptible focus indication without an input border', async () => {
    renderLiveWithNote()
    const { editor } = await openNoteEditor()

    // The keyboard-focus indication is a 1px accent underline:
    // the full-width transparent bottom border reserves the
    // space (nothing shifts), and it turns accent on focus —
    // never a box outline, ring, or prominent border.
    expect(editor).toHaveClass(
      'border-b',
      'border-transparent',
      'focus:border-accent',
    )
    expect(editor.className).not.toContain(
      'ring',
    )
    // The editor receives keyboard focus immediately on open.
    expect(editor).toHaveFocus()
  })

  it('removes the gray row surface from an actively edited Note', async () => {
    renderLiveWithNote()

    // Resting: the subtle row hover stays discoverable…
    await screen.findByRole('button', {
      name: NOTE_TRIGGER_NAME,
    })
    expect(
      pane().querySelector('ul.space-y-5 li'),
    ).toHaveClass('hover:bg-surface-hover')

    // …but while editing, the Note sits directly on the Focus
    // Pane surface: no hover or panel background on the row.
    fireEvent.click(
      screen.getByRole('button', {
        name: NOTE_TRIGGER_NAME,
      }),
    )
    const editor = await screen.findByRole(
      'textbox',
      { name: NOTE_EDITOR_NAME },
    )
    const row = editor.closest('li')
    expect(row).not.toBeNull()
    expect(row?.className).not.toContain(
      'bg-',
    )
    expect(row).not.toHaveClass(
      'hover:bg-surface-hover',
      'bg-surface-hover',
      'bg-surface',
    )
  })

  it('shows no Save or Cancel controls in the ordinary editing experience', async () => {
    renderLiveWithNote()
    const { editor } = await openNoteEditor()

    // The autosave model (focus-leave persists, Escape discards)
    // replaces the explicit Save / Cancel pair: no form controls,
    // no persistent toolbar around the writing surface.
    expect(editor).toBeTruthy()
    expect(
      screen.queryByRole('button', { name: 'Save' }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Cancel' }),
    ).toBeNull()
    // No status or error line while the editor idles.
    expect(
      pane().querySelector('[role="status"]'),
    ).toBeNull()
    expect(
      pane().querySelector('[role="alert"]'),
    ).toBeNull()
  })

  it('keeps multiline Notes fully editable with a growing field', async () => {
    const multiline =
      'First line.\nSecond line.\nThird line.'
    renderLiveWithNote({ content: multiline })

    const trigger = await screen.findByRole(
      'button',
      {
        name: /Edit note on Journal submission deadline: First line\./,
      },
    )
    fireEvent.click(trigger)
    const editor = await screen.findByRole(
      'textbox',
      { name: NOTE_EDITOR_NAME },
    )

    // The complete multiline content is present in the field…
    expect(editor).toHaveValue(multiline)
    // …with the field height managed programmatically (the
    // auto-grow effect) and no internal scroll or clamp.
    expect(editor).toHaveClass(
      'resize-none',
      'overflow-hidden',
    )
    expect(editor.style.height).toMatch(/\d+px$/)

    // Adding another line keeps the draft in the SAME field.
    const extended = `${multiline}\nFourth line.`
    fireEvent.change(editor, {
      target: { value: extended },
    })
    expect(editor).toHaveValue(extended)
    expect(editor.style.height).toMatch(/\d+px$/)
  })
})

/* ── Autosaving MeetingNotes (focus-leave persistence) ───────── */

describe('Live Meeting focus pane (autosaving MeetingNotes)', () => {
  it('Add note opens the same borderless editor as existing-Note editing', async () => {
    renderLiveWithNote()
    await screen.findByRole('button', {
      name: NOTE_TRIGGER_NAME,
    })

    fireEvent.click(
      screen.getByRole('button', { name: 'Add note' }),
    )

    const editor = await screen.findByRole(
      'textbox',
      { name: 'Add note to Journal submission deadline' },
    )
    // The SAME seamless presentation as existing-Note editing:
    // approved typography, transparent, borderless, auto-
    // growing…
    expect(editor).toHaveClass(
      'text-sm',
      'leading-6',
      'text-text',
      'whitespace-pre-wrap',
      'bg-transparent',
      'p-0',
      'outline-none',
      'border-transparent',
      'resize-none',
      'overflow-hidden',
    )
    expect(editor.className).not.toContain('ring')
    expect(editor).toHaveAttribute('rows', '1')
    // …immediately focused, with the placeholder writing
    // surface…
    expect(editor).toHaveFocus()
    expect(editor).toHaveAttribute(
      'placeholder',
      'Add what came up during the discussion…',
    )
    // …and the quiet Work Item affordance below the surface.
    expect(
      screen.getByRole('button', {
        name: 'Create work item',
      }),
    ).toBeVisible()
    // No Save / Cancel form controls.
    expect(
      screen.queryByRole('button', { name: 'Save' }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Cancel' }),
    ).toBeNull()
  })

  it('saves a new note automatically when focus leaves the composer', async () => {
    vi.mocked(
      meetingsApi.createMeetingNote,
    ).mockResolvedValue(
      makeNote({
        id: 72,
        content: 'Clarify the cover letter.',
      }),
    )

    renderLiveWithNote()
    await screen.findByRole('button', {
      name: NOTE_TRIGGER_NAME,
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Add note' }),
    )
    const editor = await screen.findByRole(
      'textbox',
      { name: 'Add note to Journal submission deadline' },
    )

    // Surrounding whitespace is trimmed on create (the same
    // contract as edits).
    fireEvent.change(editor, {
      target: {
        value: '  Clarify the cover letter.  ',
      },
    })
    fireEvent.blur(editor)

    await waitFor(() => {
      expect(
        meetingsApi.createMeetingNote,
      ).toHaveBeenCalledWith(41, {
        content: 'Clarify the cover letter.',
      })
    })
    // The persisted Note displays in place…
    await waitFor(() => {
      expect(
        within(pane()).getByText(
          'Clarify the cover letter.',
        ),
      ).toBeTruthy()
    })
    // …and the writing surface closes.
    expect(
      screen.queryByRole('textbox', {
        name: 'Add note to Journal submission deadline',
      }),
    ).toBeNull()
  })

  it('does not create a record for a whitespace-only new draft', async () => {
    renderLiveWithNote()
    await screen.findByRole('button', {
      name: NOTE_TRIGGER_NAME,
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Add note' }),
    )
    const editor = await screen.findByRole(
      'textbox',
      { name: 'Add note to Journal submission deadline' },
    )

    fireEvent.change(editor, {
      target: { value: '   ' },
    })
    fireEvent.blur(editor)

    await waitFor(() => {
      expect(
        screen.queryByRole('textbox', {
          name: 'Add note to Journal submission deadline',
        }),
      ).toBeNull()
    })
    expect(
      meetingsApi.createMeetingNote,
    ).not.toHaveBeenCalled()
  })

  it('does not duplicate the create request across repeated blur events', async () => {
    let resolveCreate: (
      note: ApiMeetingNote,
    ) => void = () => {}
    vi.mocked(
      meetingsApi.createMeetingNote,
    ).mockImplementation(() =>
      new Promise((resolve) => {
        resolveCreate = resolve
      }),
    )

    renderLiveWithNote()
    await screen.findByRole('button', {
      name: NOTE_TRIGGER_NAME,
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Add note' }),
    )
    const editor = await screen.findByRole(
      'textbox',
      { name: 'Add note to Journal submission deadline' },
    )

    fireEvent.change(editor, {
      target: { value: 'Duplicate check.' },
    })
    fireEvent.blur(editor)
    fireEvent.blur(editor)

    // The synchronous in-flight guard issues ONE create for
    // the same draft, even with repeated focus-leave.
    expect(
      meetingsApi.createMeetingNote,
    ).toHaveBeenCalledTimes(1)

    resolveCreate(
      makeNote({
        id: 72,
        content: 'Duplicate check.',
      }),
    )
    await waitFor(() => {
      expect(
        within(pane()).getByText(
          'Duplicate check.',
        ),
      ).toBeTruthy()
    })
  })

  it('Escape cancels the new draft without creating a record', async () => {
    renderLiveWithNote()
    await screen.findByRole('button', {
      name: NOTE_TRIGGER_NAME,
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Add note' }),
    )
    const editor = await screen.findByRole(
      'textbox',
      { name: 'Add note to Journal submission deadline' },
    )

    fireEvent.change(editor, {
      target: { value: 'Abandoned thought.' },
    })
    fireEvent.keyDown(editor, { key: 'Escape' })

    await waitFor(() => {
      expect(
        screen.queryByRole('textbox', {
          name: 'Add note to Journal submission deadline',
        }),
      ).toBeNull()
    })
    expect(
      meetingsApi.createMeetingNote,
    ).not.toHaveBeenCalled()
  })

  it('keeps the draft and offers a retry after a failed create', async () => {
    vi.mocked(
      meetingsApi.createMeetingNote,
    ).mockRejectedValue(
      new Error('Simulated create failure.'),
    )

    renderLiveWithNote()
    await screen.findByRole('button', {
      name: NOTE_TRIGGER_NAME,
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Add note' }),
    )
    const editor = await screen.findByRole(
      'textbox',
      { name: 'Add note to Journal submission deadline' },
    )

    fireEvent.change(editor, {
      target: { value: 'Retry draft.' },
    })
    fireEvent.blur(editor)

    const alertText = await screen.findByText(
      'Simulated create failure.',
    )
    expect(alertText.closest('[role="alert"]')).not.toBeNull()
    expect(
      screen.getByRole('textbox', {
        name: 'Add note to Journal submission deadline',
      }),
    ).toHaveValue('Retry draft.')

    // The next focus-leave retries the same draft…
    vi.mocked(
      meetingsApi.createMeetingNote,
    ).mockResolvedValue(
      makeNote({
        id: 72,
        content: 'Retry draft.',
      }),
    )
    fireEvent.blur(editor)

    await waitFor(() => {
      expect(
        meetingsApi.createMeetingNote,
      ).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(
        within(pane()).getByText('Retry draft.'),
      ).toBeTruthy()
    })
  })

  it('never turns a whitespace-only edit into a delete', async () => {
    renderLiveWithNote()
    const { editor } = await openNoteEditor()

    fireEvent.change(editor, {
      target: { value: '   ' },
    })
    fireEvent.blur(editor)

    // The editor stays open with a quiet error…
    const alertText = await screen.findByText(
      'Note content must not be empty.',
    )
    expect(alertText.closest('[role="alert"]')).not.toBeNull()
    expect(
      screen.getByRole('textbox', {
        name: NOTE_EDITOR_NAME,
      }),
    ).toHaveValue('   ')
    // …and nothing is mutated (no PATCH, no DELETE).
    expect(
      meetingsApi.updateMeetingNote,
    ).not.toHaveBeenCalled()
    expect(
      meetingsApi.deleteMeetingNote,
    ).not.toHaveBeenCalled()

    // Escaping restores the saved content.
    fireEvent.keyDown(
      screen.getByRole('textbox', {
        name: NOTE_EDITOR_NAME,
      }),
      { key: 'Escape' },
    )
    await waitFor(() => {
      expect(
        screen.queryByRole('textbox', {
          name: NOTE_EDITOR_NAME,
        }),
      ).toBeNull()
    })
    expect(
      screen.getByRole('button', {
        name: NOTE_TRIGGER_NAME,
      }),
    ).toBeTruthy()
  })

  it('persists the Note exactly once before opening the Work Item dialog', async () => {
    let resolveCreate: (
      note: ApiMeetingNote,
    ) => void = () => {}
    vi.mocked(
      meetingsApi.createMeetingNote,
    ).mockImplementation(() =>
      new Promise((resolve) => {
        resolveCreate = resolve
      }),
    )

    renderLiveWithNote()
    await screen.findByRole('button', {
      name: NOTE_TRIGGER_NAME,
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Add note' }),
    )
    const editor = await screen.findByRole(
      'textbox',
      { name: 'Add note to Journal submission deadline' },
    )

    fireEvent.change(editor, {
      target: {
        value: 'Note that becomes work.',
      },
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Create work item',
      }),
    )

    // The Note is persisted FIRST (the Work Item needs the
    // persisted Note as its source)…
    await waitFor(() => {
      expect(
        meetingsApi.createMeetingNote,
      ).toHaveBeenCalledWith(41, {
        content: 'Note that becomes work.',
      })
    })
    expect(
      meetingsApi.createMeetingNote,
    ).toHaveBeenCalledTimes(1)

    // …then the existing Work Item dialog opens…
    resolveCreate(
      makeNote({
        id: 72,
        content: 'Note that becomes work.',
      }),
    )
    const dialog = await screen.findByRole(
      'dialog',
    )
    expect(
      within(dialog).getByRole('heading', {
        name: 'Create work item',
      }),
    ).toBeTruthy()
    // …while the Note displays in place — created exactly
    // once.
    await waitFor(() => {
      expect(
        within(pane()).getByText(
          'Note that becomes work.',
        ),
      ).toBeTruthy()
    })
    expect(
      meetingsApi.createMeetingNote,
    ).toHaveBeenCalledTimes(1)
  })

  it('switching agenda topics does not discard the open composer draft', async () => {
    vi.mocked(
      meetingsApi.createMeetingNote,
    ).mockResolvedValue(
      makeNote({
        id: 72,
        content: 'Kept across topics.',
      }),
    )

    const items = [
      makeItem({
        notes: [makeNote()],
      }),
      makeItem({
        id: 42,
        title: 'Second topic',
        content: '## Second topic',
        position: 1,
      }),
    ]
    renderPage(makeMeeting(), items)

    // Open the composer on the first topic and start a
    // draft…
    const openTrigger = await screen.findByRole(
      'button',
      { name: 'Add note' },
    )
    fireEvent.click(openTrigger)
    const editor = await screen.findByRole(
      'textbox',
      { name: 'Add note to Journal submission deadline' },
    )
    fireEvent.change(editor, {
      target: { value: 'Kept across topics.' },
    })

    // …browse to the other topic: the draft must survive
    // (no early autosave, no silent discard)…
    fireEvent.click(
      screen.getByRole('button', {
        name: 'View item Second topic',
      }),
    )
    await waitFor(() => {
      expect(
        within(pane()).getByText('Second topic', {
          exact: true,
        }),
      ).toBeTruthy()
    })
    expect(
      meetingsApi.createMeetingNote,
    ).not.toHaveBeenCalled()
    expect(
      screen.queryByRole('textbox', {
        name: 'Add note to Journal submission deadline',
      }),
    ).toBeNull()

    // …and the draft is still on the first topic…
    fireEvent.click(
      screen.getByRole('button', {
        name: 'View current item Journal submission deadline',
      }),
    )
    const reopened = await screen.findByRole(
      'textbox',
      { name: 'Add note to Journal submission deadline' },
    )
    expect(reopened).toHaveValue('Kept across topics.')

    // …and still autosaves to the ORIGINAL item.
    fireEvent.blur(reopened)
    await waitFor(() => {
      expect(
        meetingsApi.createMeetingNote,
      ).toHaveBeenCalledWith(41, {
        content: 'Kept across topics.',
      })
    })
  })

  it('a stale save result never discards a newer draft', async () => {
    let resolveUpdate: (
      note: ApiMeetingNote,
    ) => void = () => {}
    vi.mocked(
      meetingsApi.updateMeetingNote,
    ).mockImplementation(() =>
      new Promise((resolve) => {
        resolveUpdate = resolve
      }),
    )

    renderLiveWithNote()
    const { editor } = await openNoteEditor()

    fireEvent.change(editor, {
      target: { value: 'First edit.' },
    })
    fireEvent.blur(editor)
    await waitFor(() => {
      expect(
        meetingsApi.updateMeetingNote,
      ).toHaveBeenCalledTimes(1)
    })

    // Typing more while the save is in flight…
    fireEvent.change(editor, {
      target: { value: 'First edit. More.' },
    })
    // …the stale result must not close the editor or
    // discard the newer draft.
    resolveUpdate(
      makeNote({ content: 'First edit.' }),
    )
    await waitFor(() => {
      expect(
        screen.getByRole('textbox', {
          name: NOTE_EDITOR_NAME,
        }),
      ).toHaveValue('First edit. More.')
    })
    // The save cycle has fully completed (no pending status).
    await waitFor(() => {
      expect(
        pane().querySelector('[role="status"]'),
      ).toBeNull()
    })

    // Leaving again saves the NEWER draft…
    fireEvent.blur(editor)
    await waitFor(() => {
      expect(
        meetingsApi.updateMeetingNote,
      ).toHaveBeenLastCalledWith(71, {
        content: 'First edit. More.',
      })
    })
    resolveUpdate(
      makeNote({ content: 'First edit. More.' }),
    )
    await waitFor(() => {
      expect(
        screen.queryByRole('textbox', {
          name: NOTE_EDITOR_NAME,
        }),
      ).toBeNull()
    })
    expect(
      screen.getByRole('button', {
        name: 'Edit note on Journal submission deadline: First edit. More.',
      }),
    ).toBeTruthy()
  })
})

/* ── MeetingNote deletion confirmation dialog ────────────────── */

const NOTE_DELETE_TRIGGER_NAME =
  'Delete note: Quotation B is significantly cheaper.'

async function openNoteDeleteDialog() {
  renderLiveWithNote()
  const trigger = await screen.findByRole(
    'button',
    { name: NOTE_DELETE_TRIGGER_NAME },
  )
  fireEvent.click(trigger)
  const dialog = await screen.findByRole(
    'dialog',
    { name: 'Delete note?' },
  )
  return { trigger, dialog }
}

describe('Live Meeting focus pane (MeetingNote deletion confirmation)', () => {
  it('renders the confirmation on theme-aware tokens (no static legacy treatment)', async () => {
    const { dialog } = await openNoteDeleteDialog()

    // The scrim and the card consume the semantic overlay /
    // surface roles — the legacy Material tokens (static white
    // in Dark) must be gone from this dialog.
    expect(dialog.parentElement).toHaveClass(
      'bg-overlay-scrim',
    )
    expect(dialog).toHaveClass(
      'bg-surface',
      'border-border-structural',
      'rounded-2xl',
      'shadow-xl',
    )
    expect(dialog.className).not.toMatch(
      /surface-container|on-surface|outline-variant|error-container/,
    )

    // Title / description use the themed text roles, and the
    // dialog is programmatically described.
    expect(
      within(dialog).getByRole('heading', {
        name: 'Delete note?',
      }),
    ).toHaveClass('text-text')
    const describedBy =
      dialog.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    const description =
      document.getElementById(describedBy!)
    expect(description).not.toBeNull()
    expect(description).toHaveClass('text-text-muted')

    // The destructive action is the solid, accessible danger
    // treatment (clear in both themes, not the pale washed-out
    // legacy error-container fill)…
    const deleteButton = within(dialog).getByRole(
      'button',
      { name: 'Delete note' },
    )
    expect(deleteButton).toHaveClass(
      'bg-danger',
      'text-text-inverse',
      'hover:bg-danger/80',
      'focus-visible:ring-danger',
    )
    // …and Cancel stays a quiet neutral action.
    expect(
      within(dialog).getByRole('button', {
        name: 'Cancel',
      }),
    ).toHaveClass(
      'text-text-muted',
      'hover:bg-surface-hover',
    )
  })

  it('focuses the Delete confirmation when the dialog opens', async () => {
    const { dialog } = await openNoteDeleteDialog()

    // Initial focus is on the destructive confirmation: the
    // user invoked a deliberate delete, so Enter confirms.
    expect(
      within(dialog).getByRole('button', {
        name: 'Delete note',
      }),
    ).toHaveFocus()
  })

  it('confirms deletion through native activation of the focused confirmation (Enter / Space)', async () => {
    vi.mocked(
      meetingsApi.deleteMeetingNote,
    ).mockResolvedValue(undefined)
    const { dialog } = await openNoteDeleteDialog()
    const deleteButton = within(dialog).getByRole(
      'button',
      { name: 'Delete note' },
    )

    // Enter (and Space) activate the focused button natively;
    // the confirmation is focused and enabled, so the activation
    // fires the existing confirm handler.
    expect(deleteButton).toHaveFocus()
    expect(deleteButton).toBeEnabled()
    fireEvent.click(deleteButton)

    await waitFor(() => {
      expect(
        meetingsApi.deleteMeetingNote,
      ).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', {
          name: 'Delete note?',
        }),
      ).toBeNull()
    })
  })

  it('cancels with Escape without deleting and restores focus to the trigger', async () => {
    vi.mocked(
      meetingsApi.deleteMeetingNote,
    ).mockResolvedValue(undefined)
    const { trigger } =
      await openNoteDeleteDialog()

    // The user's focus came from the trigger…
    trigger.focus()
    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', {
          name: 'Delete note?',
        }),
      ).toBeNull()
    })
    expect(
      meetingsApi.deleteMeetingNote,
    ).not.toHaveBeenCalled()
    // …and focus returns to it (queued microtask).
    await waitFor(() => {
      expect(trigger).toHaveFocus()
    })
  })

  it('activates Cancel (not Delete) when Cancel is focused', async () => {
    vi.mocked(
      meetingsApi.deleteMeetingNote,
    ).mockResolvedValue(undefined)
    const { dialog } = await openNoteDeleteDialog()

    // Enter activates the FOCUSED button: on Cancel it closes
    // the dialog without deleting (no global Enter-to-confirm).
    const cancelButton = within(dialog).getByRole(
      'button',
      { name: 'Cancel' },
    )
    fireEvent.focus(cancelButton)
    fireEvent.click(cancelButton)

    expect(
      screen.queryByRole('dialog', {
        name: 'Delete note?',
      }),
    ).toBeNull()
    expect(
      meetingsApi.deleteMeetingNote,
    ).not.toHaveBeenCalled()
  })

  it('does not fire duplicate deletes for repeated confirmations before the first settles', async () => {
    let resolveDelete: () => void = () => {}
    vi.mocked(meetingsApi.deleteMeetingNote).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve
        }),
    )
    const { dialog } = await openNoteDeleteDialog()
    const deleteButton = within(dialog).getByRole(
      'button',
      { name: 'Delete note' },
    )

    // Repeated Enter presses (native activations) while the
    // first request is still in flight: only the first may
    // start a DELETE.
    fireEvent.click(deleteButton)
    fireEvent.click(deleteButton)
    fireEvent.click(deleteButton)

    expect(
      meetingsApi.deleteMeetingNote,
    ).toHaveBeenCalledTimes(1)

    resolveDelete()
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', {
          name: 'Delete note?',
        }),
      ).toBeNull()
    })
    expect(
      meetingsApi.deleteMeetingNote,
    ).toHaveBeenCalledTimes(1)
  })

  it('contains Tab and Shift+Tab within the dialog', async () => {
    const { dialog } = await openNoteDeleteDialog()
    const cancelButton = within(dialog).getByRole(
      'button',
      { name: 'Cancel' },
    )
    const deleteButton = within(dialog).getByRole(
      'button',
      { name: 'Delete note' },
    )

    // Initial focus is the Delete confirmation (last
    // focusable): Tab wraps forward to Cancel…
    expect(deleteButton).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(cancelButton).toHaveFocus()
    // …and Shift+Tab wraps back to Delete.
    fireEvent.keyDown(dialog, {
      key: 'Tab',
      shiftKey: true,
    })
    expect(deleteButton).toHaveFocus()
  })
})


/* ── One-click Done with an active MeetingNote draft ─────────── */

const DONE_BUTTON_NAME =
  'Mark Journal submission deadline as done'

// The exact browser pointer sequence for a Done activation:
// pointerdown (the intent is captured BEFORE the focus-out
// autosave can run) → focus moves to the button (the editor
// blurs) → pointerup (on the button) → click.
function browserClickDone(
  doneButton: HTMLElement,
) {
  fireEvent.pointerDown(doneButton)
  doneButton.focus()
  fireEvent.pointerUp(doneButton)
  // A mouse click carries detail >= 1 (a keyboard-synthesized
  // click has detail 0): the button distinguishes the two.
  fireEvent.click(doneButton, { detail: 1 })
}

// The release lands OFF the Done button (the action row moved
// between mousedown and mouseup, or the pointer was dragged
// away): the browser's click will not reach the button, so the
// captured intent must resolve from the pointer release.
function releaseOffDone(
  doneButton: HTMLElement,
  releaseTarget: HTMLElement,
) {
  fireEvent.pointerDown(doneButton)
  doneButton.focus()
  fireEvent.pointerUp(releaseTarget)
}

describe('Live Meeting focus pane (one-click Done with an active Note draft)', () => {
  it('editing an existing Note: one click saves it and completes the topic', async () => {
    const updatedNote = makeNote({
      content: 'Edited note.',
      updatedAt: HOUR_AGO,
    })
    let resolveSave: (
      note: ApiMeetingNote,
    ) => void = () => {}
    vi.mocked(
      meetingsApi.updateMeetingNote,
    ).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve
        }),
    )
    vi.mocked(
      meetingsApi.markMeetingItemDone,
    ).mockResolvedValue(
      makeItem({ outcome: 'done' }),
    )
    renderLiveWithNote()
    const { editor } = await openNoteEditor()
    // The initial load above already settled. The authoritative
    // refresh after the Done transition reports the persisted
    // content (server truth, not the pre-Done list).
    vi.mocked(
      meetingsApi.listMeetingItems,
    ).mockResolvedValue([
      makeItem({ notes: [updatedNote] }),
    ])
    fireEvent.change(editor, {
      target: { value: '  Edited note.  ' },
    })

    const doneButton = screen.getByRole(
      'button',
      { name: DONE_BUTTON_NAME },
    ) as HTMLElement

    // ── the exact browser sequence ────────────────
    fireEvent.pointerDown(doneButton)
    doneButton.focus()
    // No state update may run in the mousedown task: the
    // autosave's status line must NOT have landed in the flow
    // above the action row (it would shift the button out
    // from under the cursor and swallow the click).
    expect(
      screen.queryByText('Saving\u2026'),
    ).toBeNull()
    fireEvent.pointerUp(doneButton)
    fireEvent.click(doneButton)

    // The Note is persisted through the existing PATCH API
    // (surrounding whitespace trimmed, single commit path)\u2026
    await waitFor(() => {
      expect(
        meetingsApi.updateMeetingNote,
      ).toHaveBeenCalledWith(71, {
        content: 'Edited note.',
      })
    })
    // \u2026and the topic is NOT marked Done before the save
    // has settled.
    expect(
      meetingsApi.markMeetingItemDone,
    ).not.toHaveBeenCalled()
    // The save feedback is visible (after the click, while in
    // flight).
    expect(
      screen.getByText('Saving\u2026'),
    ).toBeTruthy()

    resolveSave(updatedNote)

    // \u2026the Done transition runs exactly once, after the
    // successful save.
    await waitFor(() => {
      expect(
        meetingsApi.markMeetingItemDone,
      ).toHaveBeenCalledTimes(1)
    })
    expect(
      meetingsApi.markMeetingItemDone,
    ).toHaveBeenCalledWith(41)
    await waitFor(() => {
      expect(
        screen.queryByRole('textbox', {
          name: NOTE_EDITOR_NAME,
        }),
      ).toBeNull()
    })
    expect(
      screen.getByRole('button', {
        name: 'Edit note on Journal submission deadline: Edited note.',
      }),
    ).toBeTruthy()
  })

  it('creating a new Note: one click persists it and completes the topic', async () => {
    const createdNote = makeNote({
      id: 72,
      content: 'New note.',
    })
    let resolveCreate: (
      note: ApiMeetingNote,
    ) => void = () => {}
    vi.mocked(
      meetingsApi.createMeetingNote,
    ).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve
        }),
    )
    vi.mocked(
      meetingsApi.markMeetingItemDone,
    ).mockResolvedValue(
      makeItem({ outcome: 'done' }),
    )
    renderPage(makeMeeting(), [
      makeItem(),
    ])
    const openTrigger = await screen.findByRole(
      'button',
      { name: 'Add note\u2026' },
    )
    fireEvent.click(openTrigger)
    const composer = await screen.findByRole(
      'textbox',
      {
        name: 'Add note to Journal submission deadline',
      },
    )
    // The initial load above already settled. The authoritative
    // refresh after the Done transition reports the created
    // Note (server truth, not the pre-create list).
    vi.mocked(
      meetingsApi.listMeetingItems,
    ).mockResolvedValue([
      makeItem({
        notes: [createdNote],
      }),
    ])
    fireEvent.change(composer, {
      target: { value: 'New note.' },
    })

    const doneButton = screen.getByRole(
      'button',
      { name: DONE_BUTTON_NAME },
    ) as HTMLElement

    fireEvent.pointerDown(doneButton)
    doneButton.focus()
    // No status line may land above the action row in the
    // mousedown task.
    expect(
      screen.queryByText('Adding\u2026'),
    ).toBeNull()
    fireEvent.pointerUp(doneButton)
    fireEvent.click(doneButton)

    await waitFor(() => {
      expect(
        meetingsApi.createMeetingNote,
      ).toHaveBeenCalledWith(41, {
        content: 'New note.',
      })
    })
    expect(
      meetingsApi.markMeetingItemDone,
    ).not.toHaveBeenCalled()

    resolveCreate(createdNote)

    await waitFor(() => {
      expect(
        meetingsApi.markMeetingItemDone,
      ).toHaveBeenCalledTimes(1)
    })
    expect(
      meetingsApi.markMeetingItemDone,
    ).toHaveBeenCalledWith(41)
    await waitFor(() => {
      expect(
        screen.queryByRole('textbox', {
          name: 'Add note to Journal submission deadline',
        }),
      ).toBeNull()
    })
    expect(
      screen.getByRole('button', {
        name: 'Edit note on Journal submission deadline: New note.',
      }),
    ).toBeTruthy()
  })

  it('does not create a record for a whitespace-only new draft and still completes the topic', async () => {
    vi.mocked(
      meetingsApi.markMeetingItemDone,
    ).mockResolvedValue(
      makeItem({ outcome: 'done' }),
    )

    renderPage(makeMeeting(), [makeItem()])
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Add note\u2026',
      }),
    )
    const composer = await screen.findByRole(
      'textbox',
      {
        name: 'Add note to Journal submission deadline',
      },
    )
    fireEvent.change(composer, {
      target: { value: '   ' },
    })

    browserClickDone(
      screen.getByRole('button', {
        name: DONE_BUTTON_NAME,
      }) as HTMLElement,
    )

    await waitFor(() => {
      expect(
        meetingsApi.markMeetingItemDone,
      ).toHaveBeenCalledTimes(1)
    })
    expect(
      meetingsApi.createMeetingNote,
    ).not.toHaveBeenCalled()
    // The composer closed without creating.
    expect(
      screen.getByRole('button', {
        name: 'Add note\u2026',
      }),
    ).toBeTruthy()
  })

  it('sends no PATCH for an unchanged Note and still completes the topic', async () => {
    vi.mocked(
      meetingsApi.markMeetingItemDone,
    ).mockResolvedValue(
      makeItem({ outcome: 'done' }),
    )

    renderLiveWithNote()
    await openNoteEditor()

    browserClickDone(
      screen.getByRole('button', {
        name: DONE_BUTTON_NAME,
      }) as HTMLElement,
    )

    await waitFor(() => {
      expect(
        meetingsApi.markMeetingItemDone,
      ).toHaveBeenCalledTimes(1)
    })
    expect(
      meetingsApi.updateMeetingNote,
    ).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(
        screen.queryByRole('textbox', {
          name: NOTE_EDITOR_NAME,
        }),
      ).toBeNull()
    })
  })

  it('does not complete the topic while a failed save keeps the draft', async () => {
    let saveCalls = 0
    vi.mocked(
      meetingsApi.updateMeetingNote,
    ).mockImplementation(async () => {
      saveCalls += 1
      if (saveCalls === 1) {
        throw new Error('Simulated save failure.')
      }
      return makeNote({
        content: 'Broken save.',
        updatedAt: HOUR_AGO,
      })
    })
    vi.mocked(
      meetingsApi.markMeetingItemDone,
    ).mockResolvedValue(
      makeItem({ outcome: 'done' }),
    )

    renderLiveWithNote()
    const { editor } = await openNoteEditor()
    fireEvent.change(editor, {
      target: { value: 'Broken save.' },
    })

    const doneButton = screen.getByRole(
      'button',
      { name: DONE_BUTTON_NAME },
    ) as HTMLElement
    browserClickDone(doneButton)

    // The existing inline error feedback is shown\u2026
    const alertText = await screen.findByText(
      'Simulated save failure.',
    )
    expect(
      alertText.closest('[role="alert"]'),
    ).not.toBeNull()
    // \u2026the draft is preserved (not lost)\u2026
    expect(
      screen.getByRole('textbox', {
        name: NOTE_EDITOR_NAME,
      }),
    ).toHaveValue('Broken save.')
    // \u2026and the topic is NOT marked Done while the pending
    // Note change is unsaved.
    expect(
      meetingsApi.markMeetingItemDone,
    ).not.toHaveBeenCalled()

    // The retry path: the next activation resaves the same
    // draft and then completes the topic.
    browserClickDone(doneButton)

    await waitFor(() => {
      expect(
        meetingsApi.markMeetingItemDone,
      ).toHaveBeenCalledTimes(1)
    })
    expect(
      meetingsApi.updateMeetingNote,
    ).toHaveBeenCalledTimes(2)
    await waitFor(() => {
      expect(
        screen.queryByRole('textbox', {
          name: NOTE_EDITOR_NAME,
        }),
      ).toBeNull()
    })
  })

  it('does not complete the topic while a failed create keeps the draft', async () => {
    let createCalls = 0
    vi.mocked(
      meetingsApi.createMeetingNote,
    ).mockImplementation(async () => {
      createCalls += 1
      if (createCalls === 1) {
        throw new Error('Simulated create failure.')
      }
      return makeNote({
        id: 72,
        content: 'Kept draft.',
      })
    })
    vi.mocked(
      meetingsApi.markMeetingItemDone,
    ).mockResolvedValue(
      makeItem({ outcome: 'done' }),
    )

    renderPage(makeMeeting(), [makeItem()])
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Add note\u2026',
      }),
    )
    const composer = await screen.findByRole(
      'textbox',
      {
        name: 'Add note to Journal submission deadline',
      },
    )
    fireEvent.change(composer, {
      target: { value: 'Kept draft.' },
    })

    const doneButton = screen.getByRole(
      'button',
      { name: DONE_BUTTON_NAME },
    ) as HTMLElement
    browserClickDone(doneButton)

    const alertText = await screen.findByText(
      'Simulated create failure.',
    )
    expect(
      alertText.closest('[role="alert"]'),
    ).not.toBeNull()
    expect(
      screen.getByRole('textbox', {
        name: 'Add note to Journal submission deadline',
      }),
    ).toHaveValue('Kept draft.')
    expect(
      meetingsApi.markMeetingItemDone,
    ).not.toHaveBeenCalled()

    // Retry: the same draft is created once more, then the
    // topic completes.
    browserClickDone(doneButton)

    await waitFor(() => {
      expect(
        meetingsApi.markMeetingItemDone,
      ).toHaveBeenCalledTimes(1)
    })
    expect(
      meetingsApi.createMeetingNote,
    ).toHaveBeenCalledTimes(2)
  })

  it('awaits an in-flight autosave (blur first) instead of duplicating it', async () => {
    let resolveSave: (
      note: ApiMeetingNote,
    ) => void = () => {}
    vi.mocked(
      meetingsApi.updateMeetingNote,
    ).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve
        }),
    )
    vi.mocked(
      meetingsApi.markMeetingItemDone,
    ).mockResolvedValue(
      makeItem({ outcome: 'done' }),
    )

    renderLiveWithNote()
    const { editor } = await openNoteEditor()
    fireEvent.change(editor, {
      target: { value: 'Autosaved first.' },
    })

    // A plain focus-leave (NOT a Done activation) starts the
    // autosave\u2026
    fireEvent.blur(editor)
    await waitFor(() => {
      expect(
        meetingsApi.updateMeetingNote,
      ).toHaveBeenCalledTimes(1)
    })

    // \u2026then the user activates Done (keyboard style: a
    // click without a fresh blur)\u2014the flow awaits the
    // in-flight save instead of starting a second one.
    fireEvent.click(
      screen.getByRole('button', {
        name: DONE_BUTTON_NAME,
      }),
    )

    expect(
      meetingsApi.markMeetingItemDone,
    ).not.toHaveBeenCalled()
    resolveSave(
      makeNote({
        content: 'Autosaved first.',
        updatedAt: HOUR_AGO,
      }),
    )

    await waitFor(() => {
      expect(
        meetingsApi.markMeetingItemDone,
      ).toHaveBeenCalledTimes(1)
    })
    expect(
      meetingsApi.updateMeetingNote,
    ).toHaveBeenCalledTimes(1)
  })

  it('resolves the captured intent when the pointer release lands off the button', async () => {
    const updatedNote = makeNote({
      content: 'Edited note.',
      updatedAt: HOUR_AGO,
    })
    vi.mocked(
      meetingsApi.updateMeetingNote,
    ).mockResolvedValue(updatedNote)
    vi.mocked(
      meetingsApi.markMeetingItemDone,
    ).mockResolvedValue(
      makeItem({ outcome: 'done' }),
    )

    renderLiveWithNote()
    const { editor } = await openNoteEditor()
    fireEvent.change(editor, {
      target: { value: 'Edited note.' },
    })

    // The initial load above already settled. The authoritative
    // refresh after the Done transition reports the post-Done
    // server truth: the single item is done and the current
    // pointer is cleared (no successor).
    vi.mocked(
      meetingsApi.listMeetingItems,
    ).mockResolvedValue([
      makeItem({
        outcome: 'done',
        notes: [updatedNote],
      }),
    ])
    vi.mocked(
      meetingsApi.getMeeting,
    ).mockResolvedValue(
      makeMeeting({
        currentMeetingItemId: null,
      }),
    )

    const doneButton = screen.getByRole(
      'button',
      { name: DONE_BUTTON_NAME },
    ) as HTMLElement
    const actionRow =
      doneButton.parentElement as HTMLElement

    // The release lands on the action row (the button moved
    // out from under the cursor): the click will not reach
    // the button\u2014the captured intent must still resolve.
    releaseOffDone(doneButton, actionRow)

    await waitFor(() => {
      expect(
        meetingsApi.updateMeetingNote,
      ).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(
        meetingsApi.markMeetingItemDone,
      ).toHaveBeenCalledTimes(1)
    })
    expect(
      meetingsApi.markMeetingItemDone,
    ).toHaveBeenCalledWith(41)

    // A click that still arrives must not re-run the
    // transition (exactly-once).
    // A mouse click that still arrives on the old button must
    // not re-run the transition (exactly-once) — and must not
    // hit a control re-rendered into the old node's place (the
    // Done button's node is unmounted when the row swaps to
    // Reopen).
    fireEvent.click(doneButton, { detail: 1 })
    await new Promise((r) =>
      setTimeout(r, 0),
    )
    expect(
      meetingsApi.markMeetingItemDone,
    ).toHaveBeenCalledTimes(1)
    expect(
      meetingsApi.updateMeetingNote,
    ).toHaveBeenCalledTimes(1)
    expect(
      meetingsApi.reopenMeetingItem,
    ).not.toHaveBeenCalled()
  })

  it('re-commits a newer draft typed while a save was in flight (stale save never wins)', async () => {
    const firstSaved = makeNote({
      content: 'First draft.',
      updatedAt: HOUR_AGO,
    })
    const secondSaved = makeNote({
      content: 'Second draft, newer.',
      updatedAt: HOUR_AGO,
    })
    let resolveFirst: (
      note: ApiMeetingNote,
    ) => void = () => {}
    let saveCalls = 0
    vi.mocked(
      meetingsApi.updateMeetingNote,
    ).mockImplementation(
      (_id, _payload) => {
        saveCalls += 1
        if (saveCalls === 1) {
          return new Promise((resolve) => {
            resolveFirst = resolve
          })
        }
        return Promise.resolve(
          saveCalls === 2
            ? secondSaved
            : firstSaved,
        )
      },
    )
    vi.mocked(
      meetingsApi.markMeetingItemDone,
    ).mockResolvedValue(
      makeItem({ outcome: 'done' }),
    )
    renderLiveWithNote()
    const { editor } = await openNoteEditor()
    // The initial load above already settled. The authoritative
    // refresh after the Done transition reports the re-committed
    // (newer) Note content.
    vi.mocked(
      meetingsApi.listMeetingItems,
    ).mockResolvedValue([
      makeItem({
        notes: [secondSaved],
      }),
    ])
    fireEvent.change(editor, {
      target: { value: 'First draft.' },
    })

    // Focus-leave (not a Done activation) starts the autosave
    // for the FIRST draft\u2026
    fireEvent.blur(editor)
    await waitFor(() => {
      expect(
        meetingsApi.updateMeetingNote,
      ).toHaveBeenCalledTimes(1)
    })
    expect(
      meetingsApi.updateMeetingNote,
    ).toHaveBeenCalledWith(71, {
      content: 'First draft.',
    })

    // \u2026while it is in flight, a NEWER draft is typed.
    editor.focus()
    fireEvent.change(editor, {
      target: {
        value: 'Second draft, newer.',
      },
    })

    // The Done activation awaits the stale save, then
    // re-commits the NEWER draft before completing the topic.
    fireEvent.click(
      screen.getByRole('button', {
        name: DONE_BUTTON_NAME,
      }),
    )

    expect(
      meetingsApi.markMeetingItemDone,
    ).not.toHaveBeenCalled()
    resolveFirst(firstSaved)

    await waitFor(() => {
      expect(
        meetingsApi.updateMeetingNote,
      ).toHaveBeenCalledTimes(2)
    })
    expect(
      meetingsApi.updateMeetingNote,
    ).toHaveBeenLastCalledWith(71, {
      content: 'Second draft, newer.',
    })

    await waitFor(() => {
      expect(
        meetingsApi.markMeetingItemDone,
      ).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(
        screen.queryByRole('textbox', {
          name: NOTE_EDITOR_NAME,
        }),
      ).toBeNull()
    })
    expect(
      screen.getByRole('button', {
        name: 'Edit note on Journal submission deadline: Second draft, newer.',
      }),
    ).toBeTruthy()
  })

  it('keeps the Done button geometry stable until after the click (no status line in the mousedown task)', async () => {
    vi.mocked(
      meetingsApi.updateMeetingNote,
    ).mockImplementation(
      () =>
        new Promise(() => {}),
    )
    vi.mocked(
      meetingsApi.markMeetingItemDone,
    ).mockResolvedValue(
      makeItem({ outcome: 'done' }),
    )

    renderLiveWithNote()
    const { editor } = await openNoteEditor()
    fireEvent.change(editor, {
      target: { value: 'Geometry check.' },
    })

    const doneButton = screen.getByRole(
      'button',
      { name: DONE_BUTTON_NAME },
    ) as HTMLElement
    const before = doneButton.getBoundingClientRect()

    // pointerdown + the focus move that blurs the editor: the
    // whole mousedown task runs WITHOUT the autosave's status
    // line, so nothing above the action row changes height.
    fireEvent.pointerDown(doneButton)
    doneButton.focus()
    expect(
      screen.queryByText('Saving\u2026'),
    ).toBeNull()
    expect(
      doneButton.getBoundingClientRect(),
    ).toEqual(before)
    expect(doneButton.isConnected).toBe(true)

    // The activation still resolves from the click\u2026
    fireEvent.pointerUp(doneButton)
    fireEvent.click(doneButton)
    await waitFor(() => {
      expect(
        meetingsApi.updateMeetingNote,
      ).toHaveBeenCalledTimes(1)
    })
    // \u2026and only NOW (after the click) does the save
    // feedback appear.
    expect(
      screen.getByText('Saving\u2026'),
    ).toBeTruthy()
    // The save is deliberately never resolved: the Done
    // transition must follow its settle, and a stuck save must
    // not complete the topic.
    await new Promise((r) => {
      setTimeout(r, 10)
    })
    expect(
      meetingsApi.markMeetingItemDone,
    ).not.toHaveBeenCalled()
  })
})
