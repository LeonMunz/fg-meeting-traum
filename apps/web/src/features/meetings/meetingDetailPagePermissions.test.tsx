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

const groupRoleMock = vi.hoisted(() => ({
  role: 'member' as 'admin' | 'member',
}))

vi.mock('../research-group/useResearchGroup', () => ({
  useResearchGroup: () => ({
    groups: [
      {
        id: 3,
        name: 'FG Group',
        role: groupRoleMock.role,
      },
    ],
    activeResearchGroupId: 3,
    activeResearchGroup: {
      id: 3,
      name: 'FG Group',
      role: groupRoleMock.role,
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

const emptyItem: ApiMeetingItem[] = []

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
    participantIds: [1],
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
    currentUserRole: 'viewer',
    createdAt: '2026-09-01T09:00:00Z',
    updatedAt: '2026-09-01T09:00:00Z',
    ...overrides,
  }
}

function renderPage(
  meeting: ApiMeeting,
  project: ApiProject | null,
  sections: ApiMeetingSection[] = [section],
) {
  vi.mocked(meetingsApi.getMeeting).mockResolvedValue(meeting)
  vi.mocked(meetingsApi.listMeetingParticipants).mockResolvedValue(
    meeting.participantIds.includes(sessionMock.user.id)
      ? [participant]
      : [],
  )
  vi.mocked(meetingsApi.listMeetingItems).mockResolvedValue(emptyItem)
  vi.mocked(meetingsApi.listMeetingSections).mockResolvedValue(
    sections,
  )
  vi.mocked(projectsApi.getProject).mockResolvedValue(
    project as ApiProject,
  )

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

describe('MeetingDetailPage collaboration controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionMock.user = { id: 2, username: 'chris' }
    groupRoleMock.role = 'member'
  })

  afterEach(() => {
    cleanup()
  })

  it('shows Start, inline section creation, and participant management to a normal group member', async () => {
    // A plain Research Group MEMBER (role: member, not admin) of a
    // group-scoped Meeting.
    renderPage(makeMeeting({ participantIds: [1, 2] }), null)

    await screen.findByText('Collab Weekly')
    expect(
      await screen.findByRole('button', { name: 'Start meeting' }),
    ).toBeDefined()
    expect(
      screen.getByRole('button', { name: '+ Add section' }),
    ).toBeDefined()
    expect(
      screen.getByRole('button', { name: 'Add user' }),
    ).toBeDefined()
    // The moderator / admin status is not a gate: the controls come
    // from current group membership alone.
    expect(groupRoleMock.role).toBe('member')

    // Full group-Meeting management surface: the destructive
    // administration (Delete meeting) is part of it.
    fireEvent.click(
      screen.getByRole('button', { name: 'Meeting actions' }),
    )
    expect(
      await screen.findByRole('menuitem', { name: 'Delete meeting' }),
    ).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }))
    expect(
      await screen.findByRole('button', {
        name: 'Remove Chris Example',
      }),
    ).toBeDefined()
  })

  it('shows Start and inline section creation to a project participant with the viewer role', async () => {
    // An explicit participant of a Project Meeting whose only Project
    // role is viewer: the Meeting controls do not require an owner or
    // member Project role.
    const meeting = makeMeeting({
      scope: 'project',
      projectId: 9,
      participantIds: [1, 2],
    })
    renderPage(meeting, makeProject({ currentUserRole: 'viewer' }))

    await screen.findByText('Collab Weekly')
    expect(
      await screen.findByRole('button', { name: 'Start meeting' }),
    ).toBeDefined()
    expect(
      screen.getByRole('button', { name: '+ Add section' }),
    ).toBeDefined()
    expect(
      screen.getByRole('button', { name: 'Add user' }),
    ).toBeDefined()

    // Destructive administration is NOT collaboration: no Delete
    // control for a viewer-participant.
    expect(
      screen.queryByRole('button', { name: 'Meeting actions' }),
    ).not.toBeInTheDocument()

    // Participant management stays collaborative (adding works),
    // but no participant-removal controls are rendered.
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }))
    expect(
      await screen.findByRole('textbox', {
        name: 'Search people to add',
      }),
    ).toBeDefined()
    expect(
      screen.queryByRole('button', { name: /Remove / }),
    ).not.toBeInTheDocument()
  })

  it('shows the destructive administration surface to a project owner/member participant', async () => {
    // The pre-existing scoped Project write rule (owner/member,
    // non-archived) still carries the destructive Meeting
    // administration: Delete meeting + participant removal.
    const meeting = makeMeeting({
      scope: 'project',
      projectId: 9,
      participantIds: [1, 2],
    })
    renderPage(meeting, makeProject({ currentUserRole: 'member' }))

    await screen.findByText('Collab Weekly')
    expect(
      await screen.findByRole('button', { name: 'Meeting actions' }),
    ).toBeDefined()
    fireEvent.click(
      screen.getByRole('button', { name: 'Meeting actions' }),
    )
    expect(
      await screen.findByRole('menuitem', { name: 'Delete meeting' }),
    ).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }))
    expect(
      await screen.findByRole('button', {
        name: 'Remove Chris Example',
      }),
    ).toBeDefined()
  })

  it('shows no Meeting controls to a non-participant project member', async () => {
    // The user holds Project access (member) but is neither the
    // creator nor an explicit participant: the page must not render
    // the collaboration controls even if the Meeting row is present.
    const meeting = makeMeeting({
      scope: 'project',
      projectId: 9,
      participantIds: [1],
    })
    renderPage(meeting, makeProject({ currentUserRole: 'member' }))

    await screen.findByText('Collab Weekly')
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Start meeting' }),
      ).not.toBeInTheDocument()
    })
    expect(
      screen.queryByRole('button', { name: '+ Add section' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Add user' }),
    ).not.toBeInTheDocument()
  })

  it('shows Start for upcoming, End for live, and Reopen for completed group meetings', async () => {
    renderPage(makeMeeting({ status: 'upcoming' }), null)
    await screen.findByText('Collab Weekly')
    expect(
      await screen.findByRole('button', { name: 'Start meeting' }),
    ).toBeDefined()
    expect(
      screen.queryByRole('button', { name: 'End meeting' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Reopen meeting' }),
    ).not.toBeInTheDocument()
    cleanup()

    renderPage(
      makeMeeting({
        status: 'live',
        startedAt: '2026-09-28T09:00:00Z',
      }),
      null,
    )
    await screen.findByText('Collab Weekly')
    expect(
      await screen.findByRole('button', { name: 'End meeting' }),
    ).toBeDefined()
    expect(
      screen.queryByRole('button', { name: 'Start meeting' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Reopen meeting' }),
    ).not.toBeInTheDocument()
    cleanup()

    renderPage(
      makeMeeting({
        status: 'completed',
        startedAt: '2026-09-28T09:00:00Z',
        endedAt: '2026-09-28T10:00:00Z',
      }),
      null,
    )
    await screen.findByText('Collab Weekly')
    expect(
      await screen.findByRole('button', { name: 'Reopen meeting' }),
    ).toBeDefined()
    expect(
      screen.queryByRole('button', { name: 'Start meeting' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'End meeting' }),
    ).not.toBeInTheDocument()
  })

  it('hides the Meeting controls when the project is archived', async () => {
    // Archived Projects are read-only: even an explicit participant
    // loses the collaboration controls.
    const meeting = makeMeeting({
      scope: 'project',
      projectId: 9,
      participantIds: [1, 2],
    })
    renderPage(
      meeting,
      makeProject({
        currentUserRole: 'member',
        archivedAt: '2026-09-20T09:00:00Z',
      }),
    )

    await screen.findByText('Collab Weekly')
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Start meeting' }),
      ).not.toBeInTheDocument()
    })
    expect(
      screen.queryByRole('button', { name: '+ Add section' }),
    ).not.toBeInTheDocument()
  })
})

describe('MeetingDetailPage inline section creation', () => {
  const createdSection: ApiMeetingSection = {
    id: 22,
    meetingId: 11,
    sourceSeriesSectionId: null,
    name: 'TOPs',
    description: '',
    position: 1,
    isVisible: true,
  }

  const hiddenSection: ApiMeetingSection = {
    id: 23,
    meetingId: 11,
    sourceSeriesSectionId: null,
    name: 'Archive',
    description: '',
    position: 1,
    isVisible: false,
  }

  function openComposer() {
    fireEvent.click(
      screen.getByRole('button', { name: '+ Add section' }),
    )
    return screen.getByLabelText('New section name')
  }

  beforeEach(() => {
    vi.clearAllMocks()
    sessionMock.user = { id: 2, username: 'chris' }
    groupRoleMock.role = 'member'
  })

  afterEach(() => {
    cleanup()
  })

  it('creates a section inline and appends it after the last section', async () => {
    vi.mocked(
      meetingsApi.createMeetingSection,
    ).mockResolvedValue(createdSection)
    renderPage(makeMeeting({ participantIds: [1, 2] }), null)

    await screen.findByText('Collab Weekly')

    // Clicking the quiet trigger opens the compact name
    // input in place and focuses it automatically.
    const input = openComposer()
    expect(document.activeElement).toBe(input)

    fireEvent.change(input, { target: { value: 'TOPs' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(
        meetingsApi.createMeetingSection,
      ).toHaveBeenCalledTimes(1)
      expect(
        meetingsApi.createMeetingSection,
      ).toHaveBeenCalledWith(11, { name: 'TOPs' })
    })

    // The new section is appended after the existing one
    // and the composer returns to the normal view.
    await screen.findByRole('heading', {
      name: 'TOPs',
    })
    expect(
      screen.queryByLabelText('New section name'),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '+ Add section' }),
    ).toBeVisible()

    const sectionNames = screen
      .getAllByRole('heading')
      .map((heading) => heading.textContent)
    expect(
      sectionNames.indexOf('Agenda'),
    ).toBeLessThan(sectionNames.indexOf('TOPs'))
  })

  it('exposes the same action on a meeting without sections', async () => {
    const first: ApiMeetingSection = {
      ...createdSection,
      id: 24,
      name: 'First',
      position: 0,
    }
    vi.mocked(meetingsApi.createMeetingSection)
      .mockResolvedValue(first)
    renderPage(
      makeMeeting({ participantIds: [1, 2] }),
      null,
      [],
    )

    await screen.findByText('No agenda items yet.')

    const input = openComposer()
    fireEvent.change(input, { target: { value: 'First' } })
    fireEvent.submit(input.closest('form')!)

    await screen.findByRole('heading', {
      name: 'First',
    })
    expect(
      meetingsApi.createMeetingSection,
    ).toHaveBeenCalledWith(11, { name: 'First' })
  })

  it('does not request creation for an empty or whitespace-only name', async () => {
    renderPage(makeMeeting({ participantIds: [1, 2] }), null)
    await screen.findByText('Collab Weekly')

    const input = openComposer()
    fireEvent.change(input, { target: { value: '   ' } })

    // The Add action is disabled, and even a direct
    // submit makes no API request and keeps the composer
    // open for the user to fix the name.
    expect(
      screen.getByRole('button', { name: 'Add' }),
    ).toBeDisabled()
    fireEvent.submit(input.closest('form')!)

    expect(
      meetingsApi.createMeetingSection,
    ).not.toHaveBeenCalled()
    expect(
      screen.getByLabelText('New section name'),
    ).toBeVisible()
  })

  it('cancels with Escape without a request', async () => {
    renderPage(makeMeeting({ participantIds: [1, 2] }), null)
    await screen.findByText('Collab Weekly')

    const input = openComposer()
    fireEvent.change(input, { target: { value: 'Draft' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(
      screen.queryByLabelText('New section name'),
    ).not.toBeInTheDocument()
    expect(
      meetingsApi.createMeetingSection,
    ).not.toHaveBeenCalled()
    expect(
      screen.getByRole('button', { name: '+ Add section' }),
    ).toBeVisible()
  })

  it('cancels with the unobtrusive Cancel button', async () => {
    renderPage(makeMeeting({ participantIds: [1, 2] }), null)
    await screen.findByText('Collab Weekly')

    const input = openComposer()
    fireEvent.change(input, { target: { value: 'Draft' } })
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Cancel',
      }),
    )

    expect(
      screen.queryByLabelText('New section name'),
    ).not.toBeInTheDocument()
    expect(
      meetingsApi.createMeetingSection,
    ).not.toHaveBeenCalled()
  })

  it('keeps the draft and shows an actionable error when creation fails', async () => {
    vi.mocked(meetingsApi.createMeetingSection)
      .mockRejectedValueOnce(
        new ApiError(400, {
          error: 'Section name is already taken.',
        }),
      )
      .mockResolvedValueOnce(createdSection)
    renderPage(makeMeeting({ participantIds: [1, 2] }), null)
    await screen.findByText('Collab Weekly')

    const input = openComposer()
    fireEvent.change(input, { target: { value: 'TOPs' } })
    fireEvent.submit(input.closest('form')!)

    // The server message is surfaced and the user's input
    // stays in the open composer.
    await screen.findByText(
      'Section name is already taken.',
    )
    expect(input).toHaveValue('TOPs')
    expect(
      screen.getByLabelText('New section name'),
    ).toBeVisible()

    // Retrying succeeds and closes the composer.
    fireEvent.submit(input.closest('form')!)
    await screen.findByRole('heading', {
      name: 'TOPs',
    })
    expect(
      meetingsApi.createMeetingSection,
    ).toHaveBeenCalledTimes(2)
  })

  it('does not start a second creation while one is in flight', async () => {
    let resolveCreate: (
      value: ApiMeetingSection,
    ) => void = () => {}
    vi.mocked(meetingsApi.createMeetingSection)
      .mockImplementation(() => new Promise((resolve) => {
        resolveCreate = resolve
      }))
    renderPage(makeMeeting({ participantIds: [1, 2] }), null)
    await screen.findByText('Collab Weekly')

    const input = openComposer()
    fireEvent.change(input, { target: { value: 'TOPs' } })
    fireEvent.submit(input.closest('form')!)
    // The user presses submit again while the first
    // request is still in flight.
    fireEvent.submit(input.closest('form')!)

    expect(
      meetingsApi.createMeetingSection,
    ).toHaveBeenCalledTimes(1)

    resolveCreate(createdSection)
    await screen.findByRole('heading', {
      name: 'TOPs',
    })
    expect(
      meetingsApi.createMeetingSection,
    ).toHaveBeenCalledTimes(1)
  })

  it('lists hidden sections for a preparer so they stay reachable', async () => {
    renderPage(
      makeMeeting({ participantIds: [1, 2] }),
      null,
      [section, hiddenSection],
    )
    await screen.findByText('Collab Weekly')

    // The hidden Section is listed (marked) in the
    // preparation view, and its menu still offers the
    // visibility action.
    await screen.findByRole('heading', {
      name: 'Archive',
    })
    expect(screen.getByText('hidden', { exact: true }))
      .toBeVisible()
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Actions for section Archive',
      }),
    )
    expect(
      await screen.findByRole('menuitem', {
        name: 'Show section',
      }),
    ).toBeVisible()
  })

  it('keeps hidden sections out of the list for users who cannot prepare', async () => {
    const meeting = makeMeeting({
      scope: 'project',
      projectId: 9,
      participantIds: [1],
    })
    renderPage(
      meeting,
      makeProject({ currentUserRole: 'member' }),
      [section, hiddenSection],
    )
    await screen.findByText('Collab Weekly')

    expect(
      screen.getByRole('heading', {
        name: 'Agenda',
      }),
    ).toBeVisible()
    expect(
      screen.queryByRole('heading', {
        name: 'Archive',
      }),
    ).not.toBeInTheDocument()
  })

  it('does not offer section creation for a live meeting', async () => {
    renderPage(
      makeMeeting({
        status: 'live',
        startedAt: '2026-09-28T09:00:00Z',
        participantIds: [1, 2],
      }),
      null,
    )
    await screen.findByText('Collab Weekly')

    expect(
      screen.queryByRole('button', { name: '+ Add section' }),
    ).not.toBeInTheDocument()
  })
})
