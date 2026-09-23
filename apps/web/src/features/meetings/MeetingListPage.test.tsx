// @vitest-environment happy-dom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import { ApiError } from '../../api/client'
import * as meetingsApi from '../../api/meetings'
import * as projectsApi from '../../api/projects'
import { useResearchGroupListScope } from '../research-group/useResearchGroupListScope'
import { useResearchGroup } from '../research-group/useResearchGroup'
import { MeetingListPage } from './MeetingListPage'

import type {
  ApiMeeting,
  ApiMeetingRecurrence,
  ApiMeetingSeries,
} from '../../api/types'

vi.mock('../../api/meetings', async (importOriginal) => {
  const actual = await importOriginal<typeof meetingsApi>()
  return {
    ...actual,
    listMeetings: vi.fn(),
    createMeeting: vi.fn(),
    createMeetingFromSeries: vi.fn(),
    createMeetingRecurrence: vi.fn(),
    listMeetingSeries: vi.fn(),
    searchMeetingSeriesParticipantCandidates: vi.fn(),
    searchStandaloneMeetingParticipantCandidates: vi.fn(),
  }
})

vi.mock('../../api/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof projectsApi>()
  return { ...actual, listProjects: vi.fn() }
})

vi.mock('../research-group/useResearchGroupListScope', () => ({
  useResearchGroupListScope: vi.fn(),
}))

vi.mock('../research-group/useResearchGroup', () => ({
  useResearchGroup: vi.fn(),
}))

const template: ApiMeetingSeries = {
  id: 7,
  researchGroupId: 1,
  scope: 'group',
  projectId: null,
  title: 'Weekly template',
  description: '',
  isArchived: false,
  createdById: 1,
  createdAt: '2026-09-10T08:00:00Z',
  updatedAt: '2026-09-10T08:00:00Z',
}

const createdMeeting: ApiMeeting = {
  id: 11,
  researchGroupId: 1,
  scope: 'group',
  projectId: null,
  seriesId: null,
  title: 'One-time meeting',
  scheduledAt: '2026-09-22T08:30:00Z',
  startedAt: null,
  endedAt: null,
  status: 'upcoming',
  currentMeetingItemId: null,
  participantIds: [1],
  createdById: 1,
  createdAt: '2026-09-10T08:00:00Z',
  updatedAt: '2026-09-10T08:00:00Z',
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/meetings']}>
      <MeetingListPage />
    </MemoryRouter>,
  )
}

async function openCreateDialog() {
  // The header action stays disabled while the meetings list loads;
  // the empty state proves the initial load has settled.
  await screen.findByRole('button', { name: 'Create meeting' })
  fireEvent.click(
    screen.getByRole('button', { name: 'New meeting' }),
  )
}

function selectTemplate() {
  return screen.findByRole('option', { name: 'Weekly template' }).then(
    () => {
      fireEvent.change(screen.getByLabelText('Meeting template'), {
        target: { value: '7' },
      })
    },
  )
}

beforeEach(() => {
  vi.mocked(useResearchGroup).mockReturnValue({
    groups: [{ id: 1, name: 'FG', role: 'admin' }],
    activeResearchGroupId: 1,
    activeResearchGroup: { id: 1, name: 'FG', role: 'admin' },
    loading: false,
    error: null,
    setActiveResearchGroupId: vi.fn(),
    reloadResearchGroups: vi.fn(),
    addResearchGroup: vi.fn(),
  })
  vi.mocked(useResearchGroupListScope).mockReturnValue({
    activeResearchGroupId: 1,
    activeResearchGroup: { id: 1, name: 'FG', role: 'admin' },
    loading: false,
    error: null,
  })
  vi.mocked(projectsApi.listProjects).mockResolvedValue([])
  vi.mocked(meetingsApi.listMeetings).mockResolvedValue([])
  vi.mocked(meetingsApi.listMeetingSeries).mockResolvedValue([
    template,
  ])
  vi.mocked(
    meetingsApi.searchStandaloneMeetingParticipantCandidates,
  ).mockResolvedValue([])
  vi.mocked(
    meetingsApi.searchMeetingSeriesParticipantCandidates,
  ).mockResolvedValue([])
  vi.mocked(meetingsApi.createMeeting).mockResolvedValue(createdMeeting)
  vi.mocked(meetingsApi.createMeetingFromSeries).mockResolvedValue(
    createdMeeting,
  )
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('MeetingListPage recurring submit routing', () => {
  it('routes a recurring submission to createMeetingRecurrence — never to Meeting creation', async () => {
    const recurrence: ApiMeetingRecurrence = {
      id: 42,
      title: 'Weekly Sync',
      meetingSeriesId: 7,
      researchGroupId: 1,
      scope: 'group',
      projectId: null,
      frequency: 'weekly',
      interval: 1,
      weekdays: [1],
      startDate: '2026-09-22',
      localTime: '10:30',
      timezone: 'Europe/Berlin',
      endDate: null,
      count: null,
    }
    vi.mocked(
      meetingsApi.createMeetingRecurrence,
    ).mockResolvedValue(recurrence)

    renderPage()
    await openCreateDialog()

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Weekly Sync' },
    })
    await selectTemplate()
    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: '2026-09-22' },
    })
    fireEvent.change(screen.getByLabelText('Time'), {
      target: { value: '10:30' },
    })
    fireEvent.click(
      screen.getByRole('switch', { name: 'Repeat meeting' }),
    )

    fireEvent.submit(screen.getByLabelText('Title').closest('form')!)

    await waitFor(() => {
      expect(
        meetingsApi.createMeetingRecurrence,
      ).toHaveBeenCalledTimes(1)
    })
    expect(
      meetingsApi.createMeetingRecurrence,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingSeriesId: 7,
        title: 'Weekly Sync',
        frequency: 'weekly',
        interval: 1,
        weekdays: [1],
        startDate: '2026-09-22',
        localTime: '10:30',
        endDate: null,
        count: null,
      }),
    )
    expect(meetingsApi.createMeeting).not.toHaveBeenCalled()
    expect(meetingsApi.createMeetingFromSeries).not.toHaveBeenCalled()

    // The dialog closes and the user gets a clear SERIES success signal —
    // no concrete Meeting row is fabricated in the list.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Recurring series “Weekly Sync” created.',
    )
    expect(
      screen.queryByRole('button', { name: /Weekly Sync/ }),
    ).not.toBeInTheDocument()
  })

  it('keeps the dialog open with the error visible when recurrence creation fails', async () => {
    vi.mocked(
      meetingsApi.createMeetingRecurrence,
    ).mockRejectedValue(
      new ApiError(400, {
        error: 'A weekly recurrence requires one or more weekdays.',
      }),
    )

    renderPage()
    await openCreateDialog()

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Weekly Sync' },
    })
    await selectTemplate()
    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: '2026-09-22' },
    })
    fireEvent.change(screen.getByLabelText('Time'), {
      target: { value: '10:30' },
    })
    fireEvent.click(
      screen.getByRole('switch', { name: 'Repeat meeting' }),
    )
    // Configure a value the failure must preserve.
    fireEvent.change(screen.getByLabelText('Every'), {
      target: { value: '2' },
    })

    fireEvent.submit(screen.getByLabelText('Title').closest('form')!)

    await waitFor(() => {
      expect(
        screen.getByRole('alert'),
      ).toHaveTextContent(
        'A weekly recurrence requires one or more weekdays.',
      )
    })
    // Dialog still open, recurrence fields preserved, no Meeting created.
    expect(screen.getByRole('dialog')).toBeVisible()
    expect(screen.getByLabelText('Every')).toHaveValue('2')
    expect(meetingsApi.createMeeting).not.toHaveBeenCalled()
    expect(
      meetingsApi.createMeetingFromSeries,
    ).not.toHaveBeenCalled()
  })

  it('never calls createMeetingRecurrence for an ordinary one-time creation', async () => {
    renderPage()
    await openCreateDialog()

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'One-time meeting' },
    })
    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: '2026-09-22' },
    })
    fireEvent.change(screen.getByLabelText('Time'), {
      target: { value: '10:30' },
    })

    fireEvent.submit(screen.getByLabelText('Title').closest('form')!)

    await waitFor(() => {
      expect(meetingsApi.createMeeting).toHaveBeenCalledTimes(1)
    })
    expect(
      meetingsApi.createMeetingRecurrence,
    ).not.toHaveBeenCalled()
    // One-time success path unchanged: dialog closes, no series banner.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
