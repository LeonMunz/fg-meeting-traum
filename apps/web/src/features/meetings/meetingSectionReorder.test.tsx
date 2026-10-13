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
import type {
  ApiMeeting,
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
    groups: [{ id: 3, name: 'FG Group', role: 'member' }],
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

const meeting: ApiMeeting = {
  id: 11,
  researchGroupId: 3,
  scope: 'group',
  projectId: null,
  seriesId: null,
  title: 'Section Reorder Meeting',
  scheduledAt: '2026-09-30T09:00:00Z',
  startedAt: null,
  endedAt: null,
  status: 'upcoming',
  currentMeetingItemId: null,
  participantIds: [2],
  actionPermissions: {
    canEdit: true,
    canDelete: true,
    canCancel: false,
  },
  createdById: 2,
  createdAt: '2026-09-01T09:00:00Z',
  updatedAt: '2026-09-01T09:00:00Z',
}

function makeSection(
  id: number,
  name: string,
  position: number,
  isVisible = true,
): ApiMeetingSection {
  return {
    id,
    meetingId: meeting.id,
    sourceSeriesSectionId: null,
    name,
    description: `${name} description`,
    position,
    isVisible,
  }
}

const sections = [
  makeSection(21, 'A', 0),
  makeSection(22, 'B', 1),
  makeSection(23, 'C', 2),
]

function renderPage(
  initialSections: ApiMeetingSection[] = sections,
) {
  vi.mocked(meetingsApi.getMeeting).mockResolvedValue(meeting)
  vi.mocked(meetingsApi.listMeetingParticipants).mockResolvedValue([])
  vi.mocked(meetingsApi.listMeetingItems).mockResolvedValue([])
  vi.mocked(meetingsApi.listMeetingSections).mockResolvedValue(
    initialSections,
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

function renderedSectionOrder() {
  return screen
    .getAllByRole('region')
    .map((region) => region.getAttribute('aria-label'))
    .filter((name): name is string =>
      ['A', 'B', 'C'].includes(name ?? ''),
    )
}

async function openSectionActions(name: string) {
  fireEvent.click(
    await screen.findByRole('button', {
      name: `Actions for section ${name}`,
    }),
  )

  return {
    moveUp: screen.getByRole('menuitem', {
      name: 'Move up',
    }),
    moveDown: screen.getByRole('menuitem', {
      name: 'Move down',
    }),
  }
}

describe('MeetingDetailPage section reordering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('enables only moves that stay within the canonical ordered list', async () => {
    renderPage()
    await screen.findByText('Section Reorder Meeting')

    let actions = await openSectionActions('A')
    expect(actions.moveUp).toBeDisabled()
    expect(actions.moveDown).toBeEnabled()
    fireEvent.click(actions.moveUp)
    expect(meetingsApi.reorderMeetingSections).not.toHaveBeenCalled()

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Actions for section A',
      }),
    )
    actions = await openSectionActions('B')
    expect(actions.moveUp).toBeEnabled()
    expect(actions.moveDown).toBeEnabled()

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Actions for section B',
      }),
    )
    actions = await openSectionActions('C')
    expect(actions.moveUp).toBeEnabled()
    expect(actions.moveDown).toBeDisabled()
    fireEvent.click(actions.moveDown)
    expect(meetingsApi.reorderMeetingSections).not.toHaveBeenCalled()
  })

  it('moves a middle section up using the authoritative response without refetching', async () => {
    const response = [
      makeSection(22, 'B', 0),
      makeSection(21, 'A', 1),
      makeSection(23, 'C', 2),
    ]
    vi.mocked(
      meetingsApi.reorderMeetingSections,
    ).mockResolvedValue(response)

    renderPage()
    expect(await screen.findByText('B description')).toBeVisible()

    const { moveUp } = await openSectionActions('B')
    fireEvent.click(moveUp)

    await waitFor(() => {
      expect(
        meetingsApi.reorderMeetingSections,
      ).toHaveBeenCalledTimes(1)
      expect(
        meetingsApi.reorderMeetingSections,
      ).toHaveBeenCalledWith(11, {
        sectionIds: [22, 21, 23],
      })
      expect(renderedSectionOrder()).toEqual(['B', 'A', 'C'])
    })

    expect(meetingsApi.listMeetingSections).toHaveBeenCalledTimes(1)
  })

  it('moves a middle section down symmetrically', async () => {
    vi.mocked(
      meetingsApi.reorderMeetingSections,
    ).mockResolvedValue([
      makeSection(21, 'A', 0),
      makeSection(23, 'C', 1),
      makeSection(22, 'B', 2),
    ])

    renderPage()
    await screen.findByText('Section Reorder Meeting')

    const { moveDown } = await openSectionActions('B')
    fireEvent.click(moveDown)

    await waitFor(() => {
      expect(
        meetingsApi.reorderMeetingSections,
      ).toHaveBeenCalledWith(11, {
        sectionIds: [21, 23, 22],
      })
      expect(renderedSectionOrder()).toEqual(['A', 'C', 'B'])
    })
  })

  it('keeps the visual order and shows actionable feedback when reorder fails', async () => {
    vi.mocked(
      meetingsApi.reorderMeetingSections,
    ).mockRejectedValue(new Error('Reorder service unavailable.'))

    renderPage()
    await screen.findByText('Section Reorder Meeting')

    const { moveUp } = await openSectionActions('B')
    fireEvent.click(moveUp)

    expect(
      await screen.findByText('Reorder service unavailable.'),
    ).toBeVisible()
    expect(renderedSectionOrder()).toEqual(['A', 'B', 'C'])
  })

  it('disables duplicate reorder actions while a request is pending', async () => {
    let resolveReorder: (
      value: ApiMeetingSection[],
    ) => void = () => {}
    vi.mocked(
      meetingsApi.reorderMeetingSections,
    ).mockReturnValue(
      new Promise<ApiMeetingSection[]>((resolve) => {
        resolveReorder = resolve
      }),
    )

    renderPage()
    await screen.findByText('Section Reorder Meeting')

    const { moveUp } = await openSectionActions('B')
    fireEvent.click(moveUp)

    const pendingActions = await openSectionActions('B')
    expect(pendingActions.moveUp).toBeDisabled()
    expect(pendingActions.moveDown).toBeDisabled()
    fireEvent.click(pendingActions.moveDown)
    expect(
      meetingsApi.reorderMeetingSections,
    ).toHaveBeenCalledTimes(1)

    resolveReorder([
      makeSection(22, 'B', 0),
      makeSection(21, 'A', 1),
      makeSection(23, 'C', 2),
    ])
    await waitFor(() => {
      expect(renderedSectionOrder()).toEqual(['B', 'A', 'C'])
    })
  })

  it('disables both actions for one section', async () => {
    renderPage([makeSection(21, 'A', 0)])
    await screen.findByText('Section Reorder Meeting')

    const actions = await openSectionActions('A')
    expect(actions.moveUp).toBeDisabled()
    expect(actions.moveDown).toBeDisabled()
  })

  it('includes hidden sections exactly once in the complete ordered ID list', async () => {
    const hiddenSections = [
      makeSection(21, 'A', 0),
      makeSection(22, 'B', 1, false),
      makeSection(23, 'C', 2),
    ]
    vi.mocked(
      meetingsApi.reorderMeetingSections,
    ).mockResolvedValue([
      makeSection(21, 'A', 0),
      makeSection(23, 'C', 1),
      makeSection(22, 'B', 2, false),
    ])

    renderPage(hiddenSections)
    await screen.findByText('hidden')

    const { moveUp } = await openSectionActions('C')
    fireEvent.click(moveUp)

    await waitFor(() => {
      expect(
        meetingsApi.reorderMeetingSections,
      ).toHaveBeenCalledWith(11, {
        sectionIds: [21, 23, 22],
      })
    })
  })
})
