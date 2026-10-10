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

import { ApiError } from '../../api/client'
import * as meetingsApi from '../../api/meetings'
import * as projectsApi from '../../api/projects'
import type {
  ApiMeeting,
  ApiMeetingItem,
  ApiMeetingParticipant,
  ApiMeetingSection,
  ApiProject,
} from '../../api/types'

import { MeetingDetailPage } from './MeetingDetailPage'

vi.mock('../../api/meetings', () => ({
  addMeetingParticipant: vi.fn(),
  createMeetingItem: vi.fn(),
  createMeetingNote: vi.fn(),
  createMeetingSection: vi.fn(),
  deleteMeeting: vi.fn(),
  deleteMeetingNote: vi.fn(),
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
    groups: [
      {
        id: 3,
        name: 'FG Group',
        role: 'member',
      },
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

// A full-length topic exercising the supported Markdown subset:
// heading, bullets, ordered list, link, inline code, and a closing
// paragraph that must ALWAYS stay visible.
const TOPIC_CONTENT = [
  '## Discussion',
  '',
  '- Review **literature**',
  '- Compare [methods](https://example.com/methods)',
  '',
  '1. First step',
  '2. Second step',
  '',
  '`inline code` and a closing paragraph that must stay fully visible.',
].join('\n')

const SECTION: ApiMeetingSection = {
  id: 21,
  meetingId: 11,
  sourceSeriesSectionId: null,
  name: 'Agenda',
  description: '',
  position: 0,
  isVisible: true,
}

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
    participantIds: [1, 2],
    createdById: 1,
    createdAt: '2026-09-01T09:00:00Z',
    updatedAt: '2026-09-01T09:00:00Z',
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

function makeItem(
  overrides: Partial<ApiMeetingItem> = {},
): ApiMeetingItem {
  return {
    id: 41,
    meetingId: 11,
    meetingSectionId: SECTION.id,
    // The derived compatibility title of TOPIC_CONTENT.
    title: 'Discussion',
    contextNotes: '',
    content: TOPIC_CONTENT,
    position: 0,
    outcome: 'not_discussed',
    followUpSchedule: null,
    workItemIds: [],
    notes: [],
    createdById: 2,
    createdAt: '2026-09-01T09:00:00Z',
    updatedAt: '2026-09-01T09:00:00Z',
    ...overrides,
  }
}

function renderPage(
  meeting: ApiMeeting,
  project: ApiProject | null = null,
  items: ApiMeetingItem[] = [makeItem()],
) {
  vi.mocked(meetingsApi.getMeeting).mockResolvedValue(meeting)
  vi.mocked(
    meetingsApi.listMeetingParticipants,
  ).mockResolvedValue(
    meeting.participantIds.includes(
      sessionMock.user.id,
    )
      ? [PARTICIPANT]
      : [],
  )
  vi.mocked(meetingsApi.listMeetingItems).mockResolvedValue(items)
  vi.mocked(meetingsApi.listMeetingSections).mockResolvedValue([SECTION])
  vi.mocked(projectsApi.getProject).mockResolvedValue(project as ApiProject)

  return render(
    <MemoryRouter initialEntries={['/meetings/11']}>
      <Routes>
        <Route
          path="/meetings/:meetingId"
          element={<MeetingDetailPage />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

// The rendered closing paragraph: Tiptap splits the inline code
// into its own element, so match on the whole paragraph's text.
function findClosingParagraph() {
  return screen.getByText((
    _content,
    element,
  ) =>
    element?.textContent ===
    'inline code and a closing paragraph that must stay fully visible.',
  )
}

/** Clicks the rendered topic content itself — the editing entry
 * point — and returns the opened composer's textarea. */
async function openEditComposer() {
  fireEvent.click(
    await screen.findByRole('heading', {
      name: 'Discussion',
    }),
  )

  const input = await screen.findByLabelText(
    'Edit topic Discussion',
  )

  return input as HTMLTextAreaElement
}

describe('MeetingDetailPage unified topic Markdown', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionMock.user = { id: 2, username: 'chris' }
  })

  afterEach(() => {
    cleanup()
  })

  it('renders the entire saved topic in the preparation view (headings, lists, links, code)', async () => {
    renderPage(makeMeeting())

    // The heading, both bullet items, both ordered items, the
    // link, and the closing paragraph all render — the whole
    // document, no truncation.
    expect(
      await screen.findByRole('heading', {
        name: 'Discussion',
      }),
    ).toBeTruthy()
    expect(
      screen.getByText('literature'),
    ).toBeTruthy()
    expect(
      screen.getByRole('link', {
        name: 'methods',
      }),
    ).toHaveAttribute(
      'href',
      'https://example.com/methods',
    )
    expect(screen.getByText('First step')).toBeTruthy()
    expect(screen.getByText('Second step')).toBeTruthy()
    expect(findClosingParagraph()).toBeTruthy()
  })

  it('keeps long multi-paragraph topics completely visible', async () => {
    const longContent = [
      '## Long topic',
      '',
      ...Array.from(
        { length: 40 },
        (_, i) => `Paragraph ${i + 1} body text.\n`,
      ),
    ].join('\n')
    renderPage(makeMeeting(), null, [
      makeItem({
        title: 'Long topic',
        content: longContent,
      }),
    ])

    // The FIRST and the LAST block are both in the document:
    // nothing is clamped or collapsed.
    expect(
      await screen.findByRole('heading', {
        name: 'Long topic',
      }),
    ).toBeTruthy()
    expect(
      screen.getByText('Paragraph 40 body text.'),
    ).toBeTruthy()
  })

  it('opens the inline composer from the rendered content, verbatim, and saves the canonical content PATCH', async () => {
    renderPage(makeMeeting())
    vi.mocked(meetingsApi.updateMeetingItem).mockResolvedValue(
      makeItem(),
    )

    const input = await openEditComposer()

    // Multiline surface holding the COMPLETE canonical source
    // (verbatim — no title/notes reconstruction).
    expect(input.tagName).toBe('TEXTAREA')
    expect(input.value).toBe(TOPIC_CONTENT)
    expect(document.activeElement).toBe(input)

    const edited = `${TOPIC_CONTENT}\n\nAdded by the editor.`
    fireEvent.change(input, {
      target: { value: edited },
    })

    // Cmd/Ctrl+Enter saves (plain Enter would be a newline).
    fireEvent.keyDown(input, {
      key: 'Enter',
      metaKey: true,
    })

    await waitFor(() => {
      expect(
        vi.mocked(meetingsApi.updateMeetingItem),
      ).toHaveBeenCalledTimes(1)
    })

    // Canonical content write: content ONLY — never title or
    // notes.
    expect(
      vi.mocked(meetingsApi.updateMeetingItem),
    ).toHaveBeenCalledWith(41, { content: edited })
    expect(
      vi.mocked(meetingsApi.updateMeetingItem).mock
      .calls[0][1],
    ).not.toHaveProperty('title')
    expect(
      vi.mocked(meetingsApi.updateMeetingItem).mock
      .calls[0][1],
    ).not.toHaveProperty('notes')

    // The authoritative response drives the area: it returns to
    // the fully rendered Markdown (no composer left) with the
    // saved content.
    await waitFor(() => {
      expect(
        screen.queryByRole('textbox', {
          name: 'Edit topic Discussion',
        }),
      ).toBeNull()
    })
    expect(findClosingParagraph()).toBeTruthy()
  })

  it('saves through the Save button and uses the authoritative response', async () => {
    renderPage(makeMeeting())
    const response = makeItem({
      id: 41,
      title: 'Edited discussion',
      content: '## Edited discussion\n\nNew body.',
    })
    vi.mocked(meetingsApi.updateMeetingItem).mockResolvedValue(response)

    const input = await openEditComposer()
    fireEvent.change(input, {
      target: {
        value: '## Edited discussion\n\nNew body.',
      },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(
        vi.mocked(meetingsApi.updateMeetingItem),
      ).toHaveBeenCalledWith(41, {
        content:
          '## Edited discussion\n\nNew body.',
      })
    })

    await waitFor(() => {
      expect(
        screen.queryByRole('textbox', {
          name: 'Edit topic Discussion',
        }),
      ).toBeNull()
    })

    // The AUTHORITATIVE response drives the display (its derived
    // title and content), not the local draft echo.
    expect(
      await screen.findByRole('heading', {
        name: 'Edited discussion',
      }),
    ).toBeTruthy()
    expect(screen.getByText('New body.')).toBeTruthy()
  })

  it('Escape cancels editing and discards uncommitted edits', async () => {
    renderPage(makeMeeting())
    const input = await openEditComposer()
    fireEvent.change(input, {
      target: {
        value: `${TOPIC_CONTENT}\n\nDraft only.`,
      },
    })

    fireEvent.keyDown(input, { key: 'Escape' })

    await waitFor(() => {
      expect(
        screen.queryByRole('textbox', {
          name: 'Edit topic Discussion',
        }),
      ).toBeNull()
    })

    expect(
      vi.mocked(meetingsApi.updateMeetingItem),
    ).not.toHaveBeenCalled()

    // The rendered document is exactly the persisted content.
    expect(findClosingParagraph()).toBeTruthy()
    expect(
      screen.queryByText('Draft only.'),
    ).toBeNull()
  })

  it('the Cancel button discards edits without a write', async () => {
    renderPage(makeMeeting())
    const input = await openEditComposer()
    fireEvent.change(input, {
      target: {
        value: `${TOPIC_CONTENT}\n\nDraft only.`,
      },
    })

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Cancel',
      }),
    )

    await waitFor(() => {
      expect(
        screen.queryByRole('textbox', {
          name: 'Edit topic Discussion',
        }),
      ).toBeNull()
    })
    expect(
      vi.mocked(meetingsApi.updateMeetingItem),
    ).not.toHaveBeenCalled()
    expect(
      screen.queryByText('Draft only.'),
    ).toBeNull()
  })

  it('a failed save keeps the draft and shows the error unobtrusively', async () => {
    renderPage(makeMeeting())
    vi.mocked(meetingsApi.updateMeetingItem).mockRejectedValue(
      new ApiError(400, {
        error: 'content must not be empty.',
      }),
    )

    const input = await openEditComposer()
    const edited = `${TOPIC_CONTENT}\n\nStill here.`
    fireEvent.change(input, {
      target: { value: edited },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    // The server message is shown inline.
    expect(
      await screen.findByRole('alert'),
    ).toHaveTextContent('content must not be empty.')

    // The draft is preserved (composer still open, value intact).
    const stillOpen = screen.getByLabelText('Edit topic Discussion')
    expect(stillOpen).toBe(input)
    expect((input as HTMLTextAreaElement).value).toBe(edited)

    // A subsequent save retries with the preserved draft.
    vi.mocked(meetingsApi.updateMeetingItem).mockResolvedValue(
      makeItem({ content: edited }),
    )
    fireEvent.click(
      within(
        (input as HTMLTextAreaElement).closest('form')!,
      ).getByRole('button', { name: 'Save' }),
    )
    await waitFor(() => {
      expect(
        vi.mocked(meetingsApi.updateMeetingItem),
      ).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(
        screen.queryByRole('textbox', {
          name: 'Edit topic Discussion',
        }),
      ).toBeNull()
    })
  })

  it('creation: "+ Add topic" opens one multiline composer that sends content only', async () => {
    renderPage(makeMeeting())
    const created = makeItem({
      id: 90,
      position: 1,
      title: 'New topic',
      content: '## New topic\n\n- one\n- two',
    })
    vi.mocked(meetingsApi.createMeetingItem).mockResolvedValue(created)

    fireEvent.click(
      await screen.findByRole('button', {
        name: '+ Add topic',
      }),
    )

    const input = (await screen.findByLabelText(
      'Add a topic to Agenda',
    )) as HTMLTextAreaElement

    // One multiline Markdown field (no separate title or notes
    // field), focused immediately.
    expect(input.tagName).toBe('TEXTAREA')
    expect(document.activeElement).toBe(input)
    expect(
      screen.queryByLabelText(/title/i),
    ).toBeNull()
    expect(
      screen.queryByLabelText(/notes/i),
    ).toBeNull()

    const content = '## New topic\n\n- one\n- two'
    fireEvent.change(input, { target: { value: content } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(
        vi.mocked(meetingsApi.createMeetingItem),
      ).toHaveBeenCalledTimes(1)
    })
    expect(
      vi.mocked(meetingsApi.createMeetingItem),
    ).toHaveBeenCalledWith(11, {
      meetingSectionId: SECTION.id,
      content,
    })
    expect(
      vi.mocked(meetingsApi.createMeetingItem).mock
      .calls[0][1],
    ).not.toHaveProperty('title')
    expect(
      vi.mocked(meetingsApi.createMeetingItem).mock
      .calls[0][1],
    ).not.toHaveProperty('notes')

    // The created item is rendered from its canonical content.
    expect(
      await screen.findByRole('heading', {
        name: 'New topic',
      }),
    ).toBeTruthy()
  })

  it('blocks whitespace-only submissions on creation', async () => {
    renderPage(makeMeeting())
    fireEvent.click(
      await screen.findByRole('button', {
        name: '+ Add topic',
      }),
    )

    const input = (await screen.findByLabelText(
      'Add a topic to Agenda',
    )) as HTMLTextAreaElement
    fireEvent.change(input, {
      target: { value: '   \n  ' },
    })

    // The Save control is disabled for whitespace-only content…
    expect(
      screen.getByRole('button', {
        name: 'Save',
      }),
    ).toBeDisabled()

    // …and submitting the form directly still sends nothing.
    fireEvent.submit(input.closest('form')!)
    expect(
      vi.mocked(meetingsApi.createMeetingItem),
    ).not.toHaveBeenCalled()
  })

  it('a failed creation keeps the draft open', async () => {
    renderPage(makeMeeting())
    vi.mocked(meetingsApi.createMeetingItem).mockRejectedValue(
      new ApiError(400, {
        error: 'The section does not belong to this meeting.',
      }),
    )

    fireEvent.click(
      await screen.findByRole('button', {
        name: '+ Add topic',
      }),
    )

    const input = (await screen.findByLabelText(
      'Add a topic to Agenda',
    )) as HTMLTextAreaElement
    fireEvent.change(input, {
      target: { value: 'Draft topic' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(
      await screen.findByRole('alert'),
    ).toHaveTextContent(
      'The section does not belong to this meeting.',
    )

    // Draft preserved, composer still open.
    expect((input as HTMLTextAreaElement).value).toBe(
      'Draft topic',
    )
    expect(
      screen.queryByLabelText('Add a topic to Agenda'),
    ).not.toBeNull()
  })

  it('plain Enter inserts a newline without saving', async () => {
    renderPage(makeMeeting())
    const input = await openEditComposer()
    fireEvent.change(input, {
      target: { value: 'Line one\nLine two' },
    })

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(
      vi.mocked(meetingsApi.updateMeetingItem),
    ).not.toHaveBeenCalled()
    expect((input as HTMLTextAreaElement).value).toBe(
      'Line one\nLine two',
    )
  })

  it('removes the redundant Edit menu action but keeps the other topic actions', async () => {
    renderPage(makeMeeting())
    await screen.findByRole('heading', {
      name: 'Discussion',
    })

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Actions for agenda item Discussion',
      }),
    )

    expect(
      screen.queryByRole('menuitem', { name: 'Edit' }),
    ).toBeNull()
    expect(
      screen.getByRole('menuitem', {
        name: 'Create work item',
      }),
    ).toBeTruthy()
    expect(
      screen.getByRole('menuitem', { name: 'Delete' }),
    ).toBeTruthy()
  })

  it('clicking a rendered link does not activate editing', async () => {
    renderPage(makeMeeting())
    await screen.findByRole('heading', {
      name: 'Discussion',
    })

    fireEvent.click(
      screen.getByRole('link', {
        name: 'methods',
      }),
    )

    expect(
      screen.queryByRole('textbox', {
        name: 'Edit topic Discussion',
      }),
    ).toBeNull()
  })

  it('keeps editing out of reach for users without preparation permission', async () => {
    // A Project Meeting where the user has Project access (member)
    // but is neither creator nor participant: no preparation
    // controls, no editing entry point on the content.
    renderPage(
      makeMeeting({
        scope: 'project',
        projectId: 9,
        participantIds: [1],
      }),
      makeProject({ currentUserRole: 'member' }),
    )

    await screen.findByRole('heading', {
      name: 'Discussion',
    })

    // The full content still renders for readers…
    expect(findClosingParagraph()).toBeTruthy()

    // …but there is no composer trigger, no action menu, and the
    // content itself is not an editing control.
    expect(
      screen.queryByRole('button', {
        name: '+ Add topic',
      }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', {
        name: 'Actions for agenda item Discussion',
      }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', {
        name: 'Edit topic Discussion',
      }),
    ).toBeNull()
  })

  it('the top Quick Add bar creates through the canonical content payload', async () => {
    const created = makeItem({
      id: 91,
      position: 1,
      title: 'Quick topic',
      content: 'Quick topic',
    })
    vi.mocked(meetingsApi.createMeetingItem).mockResolvedValue(created)

    renderPage(makeMeeting())
    await screen.findByRole('heading', {
      name: 'Discussion',
    })

    const input = screen.getByLabelText('Add a topic')
    fireEvent.change(input, {
      target: { value: 'Quick topic' },
    })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(
        vi.mocked(meetingsApi.createMeetingItem),
      ).toHaveBeenCalledTimes(1)
    })
    expect(
      vi.mocked(meetingsApi.createMeetingItem),
    ).toHaveBeenCalledWith(11, {
      meetingSectionId: SECTION.id,
      content: 'Quick topic',
    })
    expect(
      vi.mocked(meetingsApi.createMeetingItem).mock
      .calls[0][1],
    ).not.toHaveProperty('title')
  })
})
