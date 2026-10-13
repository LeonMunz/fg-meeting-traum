// @vitest-environment happy-dom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
  deleteMeetingItem: vi.fn(),
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

vi.mock('../../api/useSession', () => ({
  useSession: () => ({
    user: { id: 2, username: 'chris' },
  }),
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

const section: ApiMeetingSection = {
  id: 21,
  meetingId: 11,
  sourceSeriesSectionId: null,
  name: 'Agenda',
  description: '',
  position: 0,
  isVisible: true,
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

function makeMeeting(): ApiMeeting {
  return {
    id: 11,
    researchGroupId: 3,
    scope: 'group',
    projectId: null,
    seriesId: null,
    title: 'Delete Weekly',
    scheduledAt: '2026-09-30T09:00:00Z',
    startedAt: null,
    endedAt: null,
    status: 'upcoming',
    currentMeetingItemId: null,
    participantIds: [1, 2],
    actionPermissions: {
      canEdit: true,
      canDelete: true,
      canCancel: false,
    },
    createdById: 1,
    createdAt: '2026-09-01T09:00:00Z',
    updatedAt: '2026-09-01T09:00:00Z',
  }
}

function makeItem(
  id: number,
  title: string,
  overrides: Partial<ApiMeetingItem> = {},
): ApiMeetingItem {
  return {
    id,
    meetingId: 11,
    meetingSectionId: 21,
    title,
    contextNotes: '',
    content: title,
    position: id,
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

function renderPage(items: ApiMeetingItem[]) {
  vi.mocked(meetingsApi.getMeeting).mockResolvedValue(makeMeeting())
  vi.mocked(meetingsApi.listMeetingParticipants).mockResolvedValue([
    participant,
  ])
  vi.mocked(meetingsApi.listMeetingItems).mockResolvedValue(items)
  vi.mocked(meetingsApi.listMeetingSections).mockResolvedValue([section])
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

const firstItem = () => makeItem(101, 'First topic')
const secondItem = () => makeItem(102, 'Second topic')

/**
 * Opens the per-item actions menu and activates the Delete
 * entry ONCE. The page's real `window.confirm` (stubbed in
 * beforeEach) decides the outcome; activating the entry closes
 * the menu, so callers never click it again.
 */
async function activateDeleteFor(
  title: string,
) {
  const actions = await screen.findByRole('button', {
    name: `Actions for agenda item ${title}`,
  })
  fireEvent.click(actions)
  const deleteEntry = await screen.findByRole(
    'menuitem',
    { name: 'Delete' },
  )
  fireEvent.click(deleteEntry)
}

describe('MeetingDetailPage agenda item deletion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('removes the row only after a successful (204) deletion', async () => {
    let resolveDelete: (value: void) => void = () => {}
    vi.mocked(meetingsApi.deleteMeetingItem).mockReturnValue(
      new Promise<void>((resolve) => {
        resolveDelete = resolve
      }),
    )

    renderPage([firstItem(), secondItem()])
    await screen.findByText('First topic', { exact: true })

    await activateDeleteFor('First topic')

    await waitFor(() => {
      expect(meetingsApi.deleteMeetingItem).toHaveBeenCalledWith(
        101,
      )
    })

    // While the server request is still pending the row MUST
    // stay: a resolved promise alone is not proof of deletion.
    expect(
      screen.getByText('First topic', { exact: true }),
    ).toBeInTheDocument()

    // The 204 arrives: only now is the row removed.
    resolveDelete(undefined)
    await waitFor(() => {
      expect(
        screen.queryByText('First topic', { exact: true }),
      ).not.toBeInTheDocument()
    })
    expect(
      screen.getByText('Second topic', { exact: true }),
    ).toBeInTheDocument()
  })

  it('issues no request when the confirmation is canceled', async () => {
    vi.mocked(meetingsApi.deleteMeetingItem).mockResolvedValue(
      undefined,
    )
    vi.mocked(window.confirm).mockReturnValue(false)

    renderPage([firstItem(), secondItem()])

    await activateDeleteFor('First topic')

    await waitFor(() => {
      expect(window.confirm).toHaveBeenCalledWith(
        'Delete agenda item "First topic"?',
      )
    })
    expect(meetingsApi.deleteMeetingItem).not.toHaveBeenCalled()
    expect(
      screen.getByText('First topic', { exact: true }),
    ).toBeInTheDocument()
  })

  it.each([
    [
      403,
      'You do not have permission to modify ' +
        'this Project Meeting resource.',
    ],
    [404, 'Meeting item not found'],
    [
      409,
      'This agenda item has persistent ' +
        'Meeting Notes and cannot be deleted.',
    ],
    [500, 'Server error.'],
  ])(
    'keeps the item visible with a meaningful error on %i',
    async (httpStatus, serverMessage) => {
      vi.mocked(meetingsApi.deleteMeetingItem).mockRejectedValue(
        new ApiError(httpStatus, { error: serverMessage }),
      )

      renderPage([firstItem(), secondItem()])

      await activateDeleteFor('First topic')

      // The server message stays visible and useful.
      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(serverMessage)

      // The rejected deletion never removes the item.
      expect(
        screen.getByText('First topic', { exact: true }),
      ).toBeInTheDocument()
      expect(
        screen.getByText('Second topic', { exact: true }),
      ).toBeInTheDocument()
    },
  )

  it('shows a fallback error when the server message is absent', async () => {
    // A rejection without a readable message (no ApiError
    // detail, no Error text) must still surface the fallback.
    vi.mocked(meetingsApi.deleteMeetingItem).mockRejectedValue(
      'network down',
    )

    renderPage([firstItem(), secondItem()])

    await activateDeleteFor('First topic')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'Agenda item could not be deleted.',
    )
    expect(
      screen.getByText('First topic', { exact: true }),
    ).toBeInTheDocument()
  })

  it('does not start a duplicate deletion on rapid repeated activation', async () => {
    let resolveDelete: (value: void) => void = () => {}
    vi.mocked(meetingsApi.deleteMeetingItem).mockReturnValue(
      new Promise<void>((resolve) => {
        resolveDelete = resolve
      }),
    )

    renderPage([firstItem(), secondItem()])

    await activateDeleteFor('First topic')

    await waitFor(() => {
      expect(meetingsApi.deleteMeetingItem).toHaveBeenCalledTimes(1)
    })

    // Re-open the item menu and activate Delete again while the
    // first request is still pending: the synchronous in-flight
    // guard must swallow the duplicate.
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Actions for agenda item First topic',
      }),
    )
    await screen
      .getByRole('menuitem', { name: 'Delete' })
      .click()

    expect(
      meetingsApi.deleteMeetingItem,
    ).toHaveBeenCalledTimes(1)

    resolveDelete(undefined)
    await waitFor(() => {
      expect(
        screen.queryByText('First topic', { exact: true }),
      ).not.toBeInTheDocument()
    })
    expect(
      meetingsApi.deleteMeetingItem,
    ).toHaveBeenCalledTimes(1)
  })

  it('leaves sibling items and unrelated local state untouched', async () => {
    vi.mocked(meetingsApi.deleteMeetingItem).mockResolvedValue(
      undefined,
    )

    const items = [firstItem(), secondItem()]
    renderPage(items)
    await screen.findByText('First topic', { exact: true })

    await activateDeleteFor('First topic')

    await waitFor(() => {
      expect(
        screen.queryByText('First topic', { exact: true }),
      ).not.toBeInTheDocument()
    })

    // The sibling row is intact with its own content.
    expect(
      screen.getByText('Second topic', { exact: true }),
    ).toBeInTheDocument()
    // No side-effect writes: nothing was edited, no refetch of
    // the Meeting or the item list happened beyond the initial
    // load.
    expect(meetingsApi.updateMeetingItem).not.toHaveBeenCalled()
    expect(meetingsApi.getMeeting).toHaveBeenCalledTimes(1)
    expect(meetingsApi.listMeetingItems).toHaveBeenCalledTimes(1)
    expect(meetingsApi.listMeetingItems).toHaveBeenLastCalledWith(11)
  })

  it('closes the topic composer of the deleted item but keeps the composer of a different item', async () => {
    vi.mocked(meetingsApi.deleteMeetingItem).mockResolvedValue(
      undefined,
    )

    renderPage([firstItem(), secondItem()])
    await screen.findByText('First topic', { exact: true })

    // Open editing for the SECOND item (rendered topic is the
    // editing entry point).
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Edit topic Second topic',
      }),
    )
    const composer = await screen.findByRole('textbox', {
      name: 'Edit topic Second topic',
    })
    fireEvent.change(composer, { target: { value: 'draft text' } })

    // Delete the FIRST item: the second item's composer draft
    // must survive.
    await activateDeleteFor('First topic')

    await waitFor(() => {
      expect(
        screen.queryByText('First topic', { exact: true }),
      ).not.toBeInTheDocument()
    })
    const survivingComposer = await screen.findByRole(
      'textbox',
      { name: 'Edit topic Second topic' },
    )
    expect(survivingComposer).toHaveValue('draft text')
  })

  it('leaves no orphaned editor after canceling the edit and deleting the item', async () => {
    // The composer (Save / Cancel only) has no delete affordance:
    // the real flow is cancel the edit first, then delete the
    // item from its row menu. Afterwards no editor or draft of
    // the deleted item may remain.
    vi.mocked(meetingsApi.deleteMeetingItem).mockResolvedValue(
      undefined,
    )

    renderPage([firstItem(), secondItem()])
    await screen.findByText('First topic', { exact: true })

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Edit topic First topic',
      }),
    )
    const composer = await screen.findByRole('textbox', {
      name: 'Edit topic First topic',
    })
    expect(composer).toBeInTheDocument()

    // Cancel the edit: the row returns to its saved content.
    fireEvent.click(
      screen.getByRole('button', { name: 'Cancel' }),
    )
    await waitFor(() => {
      expect(
        screen.queryByRole('textbox', {
          name: 'Edit topic First topic',
        }),
      ).not.toBeInTheDocument()
    })

    await activateDeleteFor('First topic')

    await waitFor(() => {
      expect(
        screen.queryByText('First topic', { exact: true }),
      ).not.toBeInTheDocument()
    })
    expect(
      screen.queryByRole('textbox', {
        name: 'Edit topic First topic',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText('Second topic', { exact: true }),
    ).toBeInTheDocument()
  })
})
