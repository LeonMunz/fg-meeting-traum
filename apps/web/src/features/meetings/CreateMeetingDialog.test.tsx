// @vitest-environment happy-dom

import {
  act,
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

import * as meetingsApi from '../../api/meetings'
import * as projectsApi from '../../api/projects'
import { useResearchGroup } from '../research-group/useResearchGroup'
import {
  CreateMeetingDialog,
  type CreateMeetingInput,
} from './CreateMeetingDialog'

import type {
  ApiMeetingParticipantCandidate,
  ApiMeetingSeries,
} from '../../api/types'

vi.mock('../../api/meetings', async (importOriginal) => {
  const actual = await importOriginal<typeof meetingsApi>()
  return {
    ...actual,
    listMeetingSeries: vi.fn(),
    searchMeetingSeriesParticipantCandidates: vi.fn(),
    searchStandaloneMeetingParticipantCandidates: vi.fn(),
  }
})

vi.mock('../../api/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof projectsApi>()
  return { ...actual, listProjects: vi.fn() }
})

vi.mock('../research-group/useResearchGroup', () => ({
  useResearchGroup: vi.fn(),
}))

const chris: ApiMeetingParticipantCandidate = {
  id: 4,
  username: 'chris',
  firstName: 'Chris',
  lastName: 'Example',
}

const externalUser: ApiMeetingParticipantCandidate = {
  id: 8,
  username: 'external.user',
  firstName: '',
  lastName: '',
}

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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

function renderDialog(
  onCreate = vi.fn<(input: CreateMeetingInput) => void>(),
  submitError: string | null = null,
) {
  return {
    onCreate,
    ...render(
      <CreateMeetingDialog
        open
        submitting={false}
        submitError={submitError}
        onClose={() => undefined}
        onCreate={onCreate}
      />,
    ),
  }
}

function searchFor(query: string) {
  fireEvent.change(screen.getByLabelText('Participants'), {
    target: { value: query },
  })
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
  })
  vi.mocked(projectsApi.listProjects).mockResolvedValue([])
  vi.mocked(meetingsApi.listMeetingSeries).mockResolvedValue([template])
  vi.mocked(
    meetingsApi.searchStandaloneMeetingParticipantCandidates,
  ).mockResolvedValue([chris, externalUser])
  vi.mocked(
    meetingsApi.searchMeetingSeriesParticipantCandidates,
  ).mockResolvedValue([chris, externalUser])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('CreateMeetingDialog participant picker', () => {
  it('submits an empty participant selection without blocking creation', () => {
    const { onCreate } = renderDialog()

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'No invitees yet' },
    })
    fireEvent.change(screen.getByLabelText('Date and time'), {
      target: { value: '2030-01-02T10:30' },
    })
    fireEvent.submit(screen.getByLabelText('Title').closest('form')!)

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ participantIds: [] }),
    )
  })

  it('searches on demand, supports multiple selection/removal, and retains selection after an error', async () => {
    const { onCreate, rerender } = renderDialog()

    expect(screen.getByLabelText('Participants')).toBeVisible()

    await searchFor('c')
    await act(() => new Promise((resolve) => window.setTimeout(resolve, 300)))
    expect(
      meetingsApi.searchStandaloneMeetingParticipantCandidates,
    ).not.toHaveBeenCalled()

    await searchFor('ch')
    await waitFor(() => {
      expect(
        meetingsApi.searchStandaloneMeetingParticipantCandidates,
      ).toHaveBeenCalledWith(1, {
        query: 'ch',
        scope: 'group',
        projectId: null,
      })
    })

    await screen.findByRole('button', { name: /Chris Example.*@chris.*Add/ })
    fireEvent.click(
      screen.getByRole('button', { name: /Chris Example.*@chris.*Add/ }),
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: /external\.user.*@external\.user.*Add/,
      }),
    )

    const selection = screen.getByRole('list', {
      name: 'Selected participants',
    })
    expect(within(selection).getByText('Chris Example')).toBeVisible()
    expect(within(selection).getByText('external.user')).toBeVisible()
    expect(
      screen.queryByRole('button', { name: /Chris Example.*@chris.*Add/ }),
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Remove external.user' }))
    expect(within(selection).queryByText('external.user')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: /external\.user.*@external\.user.*Add/,
      }),
    ).toBeVisible()

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Participant planning' },
    })
    fireEvent.change(screen.getByLabelText('Date and time'), {
      target: { value: '2030-01-02T10:30' },
    })
    fireEvent.submit(screen.getByLabelText('Title').closest('form')!)

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        seriesId: null,
        participantIds: [4],
      }),
    )

    rerender(
      <CreateMeetingDialog
        open
        submitting={false}
        submitError="Meeting could not be created."
        onClose={() => undefined}
        onCreate={onCreate}
      />,
    )
    expect(screen.getByText('Chris Example')).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Meeting could not be created.',
    )
  })

  it('uses the selected Template context, preserves selections, and ignores stale responses', async () => {
    const oldRequest = deferred<ApiMeetingParticipantCandidate[]>()
    const newRequest = deferred<ApiMeetingParticipantCandidate[]>()
    const staleUser = {
      id: 10,
      username: 'stale',
      firstName: 'Stale',
      lastName: 'Person',
    }
    const currentUser = {
      id: 11,
      username: 'current',
      firstName: 'Current',
      lastName: 'Person',
    }

    vi.mocked(
      meetingsApi.searchStandaloneMeetingParticipantCandidates,
    )
      .mockResolvedValueOnce([chris])
      .mockReturnValueOnce(oldRequest.promise)
    vi.mocked(
      meetingsApi.searchMeetingSeriesParticipantCandidates,
    ).mockReturnValue(newRequest.promise)

    const { onCreate } = renderDialog()
    await screen.findByRole('option', { name: 'Weekly template' })

    await searchFor('chris')
    await screen.findByRole('button', { name: /Chris Example.*@chris.*Add/ })
    fireEvent.click(
      screen.getByRole('button', { name: /Chris Example.*@chris.*Add/ }),
    )

    await searchFor('person')
    await waitFor(() => {
      expect(
        meetingsApi.searchStandaloneMeetingParticipantCandidates,
      ).toHaveBeenCalledTimes(2)
    })

    fireEvent.change(screen.getByLabelText('Meeting template'), {
      target: { value: '7' },
    })
    expect(screen.getByText('Chris Example')).toBeVisible()

    await waitFor(() => {
      expect(
        meetingsApi.searchMeetingSeriesParticipantCandidates,
      ).toHaveBeenCalledWith(7, 'person')
    })

    await act(async () => {
      oldRequest.resolve([staleUser])
      await oldRequest.promise
    })
    expect(screen.queryByText('Stale Person')).not.toBeInTheDocument()

    await act(async () => {
      newRequest.resolve([currentUser])
      await newRequest.promise
    })
    expect(await screen.findByText('Current Person')).toBeVisible()

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Template planning' },
    })
    fireEvent.change(screen.getByLabelText('Date and time'), {
      target: { value: '2030-01-02T10:30' },
    })
    fireEvent.submit(screen.getByLabelText('Title').closest('form')!)

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        seriesId: 7,
        participantIds: [4],
      }),
    )
  })

  it('searches standalone Project Meeting candidates with the selected Project context', async () => {
    vi.mocked(projectsApi.listProjects).mockResolvedValue([
      {
        id: 9,
        researchGroupId: 1,
        name: 'External collaboration',
        description: '',
        status: 'active',
        archivedAt: null,
        currentUserRole: 'owner',
        createdAt: '2026-09-10T08:00:00Z',
        updatedAt: '2026-09-10T08:00:00Z',
      },
    ])

    renderDialog()
    await screen.findByRole('option', { name: 'External collaboration' })

    fireEvent.change(screen.getByLabelText('Project'), {
      target: { value: '9' },
    })
    searchFor('external')

    await waitFor(() => {
      expect(
        meetingsApi.searchStandaloneMeetingParticipantCandidates,
      ).toHaveBeenCalledWith(1, {
        query: 'external',
        scope: 'project',
        projectId: 9,
      })
    })
  })
})
