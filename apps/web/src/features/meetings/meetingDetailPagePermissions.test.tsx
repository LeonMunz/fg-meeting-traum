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

function renderPage(meeting: ApiMeeting, project: ApiProject | null) {
  vi.mocked(meetingsApi.getMeeting).mockResolvedValue(meeting)
  vi.mocked(meetingsApi.listMeetingParticipants).mockResolvedValue(
    meeting.participantIds.includes(sessionMock.user.id)
      ? [participant]
      : [],
  )
  vi.mocked(meetingsApi.listMeetingItems).mockResolvedValue(emptyItem)
  vi.mocked(meetingsApi.listMeetingSections).mockResolvedValue([section])
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

  it('shows Start, structure editing, and participant management to a normal group member', async () => {
    // A plain Research Group MEMBER (role: member, not admin) of a
    // group-scoped Meeting.
    renderPage(makeMeeting({ participantIds: [1, 2] }), null)

    await screen.findByText('Collab Weekly')
    expect(
      await screen.findByRole('button', { name: 'Start meeting' }),
    ).toBeDefined()
    expect(
      screen.getByRole('button', { name: 'Edit structure' }),
    ).toBeDefined()
    expect(
      screen.getByRole('button', { name: 'Manage' }),
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
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
    expect(
      await screen.findByRole('button', {
        name: 'Remove Chris Example',
      }),
    ).toBeDefined()
  })

  it('shows Start and structure editing to a project participant with the viewer role', async () => {
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
      screen.getByRole('button', { name: 'Edit structure' }),
    ).toBeDefined()
    expect(
      screen.getByRole('button', { name: 'Manage' }),
    ).toBeDefined()

    // Destructive administration is NOT collaboration: no Delete
    // control for a viewer-participant.
    expect(
      screen.queryByRole('button', { name: 'Meeting actions' }),
    ).not.toBeInTheDocument()

    // Participant management stays collaborative (adding works),
    // but no participant-removal controls are rendered.
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
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
      screen.queryByRole('button', { name: 'Edit structure' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Manage' }),
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
      screen.queryByRole('button', { name: 'Edit structure' }),
    ).not.toBeInTheDocument()
  })
})
