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
    addResearchGroup: vi.fn(),
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

describe('CreateMeetingDialog modal foundation', () => {
  it('renders the redesigned header with the Research Group as context, without a group field', () => {
    renderDialog()

    expect(
      screen.getByRole('heading', { name: 'New meeting', level: 2 }),
    ).toBeVisible()
    expect(screen.getByText('Create a meeting in FG.')).toBeVisible()
    expect(
      screen.queryByLabelText('Research group'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(
        'Create a Research Group Meeting or a Project Meeting.',
      ),
    ).not.toBeInTheDocument()
  })

  it('orders the fields Title, Project, Meeting template, Participants, then the Schedule section', () => {
    renderDialog()

    const title = screen.getByLabelText('Title')
    const project = screen.getByLabelText('Project')
    const template = screen.getByLabelText('Meeting template')
    const participants = screen.getByLabelText('Participants')
    const schedule = screen.getByRole('heading', { name: 'Schedule' })
    const dateTime = screen.getByLabelText('Date and time')

    expect(
      title.compareDocumentPosition(project) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      project.compareDocumentPosition(template) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      template.compareDocumentPosition(participants) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      participants.compareDocumentPosition(schedule) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    // The Schedule section wraps the unchanged Date and time control.
    expect(schedule.parentElement).toContainElement(dateTime)
  })

  it('offers the Research group meeting option without null-oriented wording', () => {
    renderDialog()

    expect(
      screen.getByRole('option', { name: 'Research group meeting' }),
    ).toBeVisible()
    expect(
      screen.queryByRole('option', { name: /No project/ }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/No project/i)).not.toBeInTheDocument()
  })

  it('keeps the default no-project path working: submits a group-scoped meeting', () => {
    const { onCreate } = renderDialog()

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Group standup' },
    })
    fireEvent.submit(screen.getByLabelText('Title').closest('form')!)

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        researchGroupId: 1,
        scope: 'group',
        projectId: null,
      }),
    )
  })

  it('shows the no-template helper and switches it once a Template is selected', async () => {
    renderDialog()
    await screen.findByRole('option', { name: 'Weekly template' })

    expect(
      screen.getByText(
        'Choose a template to enable recurring meetings.',
      ),
    ).toBeVisible()

    fireEvent.change(screen.getByLabelText('Meeting template'), {
      target: { value: '7' },
    })

    expect(
      screen.queryByText(
        'Choose a template to enable recurring meetings.',
      ),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(
        'Uses the template sections as the starting structure.',
      ),
    ).toBeVisible()
  })

  it('keeps the participant helper quiet: no permanent text, one-character hint, search from two characters', async () => {
    renderDialog()

    expect(
      screen.getByPlaceholderText('Search participants...'),
    ).toBeVisible()
    expect(
      screen.queryByText(
        'Search by name or username. Enter at least 2 characters.',
      ),
    ).not.toBeInTheDocument()

    await searchFor('c')
    expect(
      screen.getByText('Type at least 2 characters.'),
    ).toBeVisible()
    expect(
      meetingsApi.searchStandaloneMeetingParticipantCandidates,
    ).not.toHaveBeenCalled()

    await searchFor('ch')
    expect(
      screen.queryByText('Type at least 2 characters.'),
    ).not.toBeInTheDocument()
    await waitFor(() => {
      expect(
        meetingsApi.searchStandaloneMeetingParticipantCandidates,
      ).toHaveBeenCalled()
    })
  })

  it('exposes no Repeat/recurrence controls and keeps the Cancel + Create meeting footer', () => {
    renderDialog()

    expect(
      screen.queryByText(/repeat meeting/i),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /create series/i }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Cancel' }),
    ).toBeEnabled()
    expect(
      screen.getByRole('button', { name: /create meeting/i }),
    ).toBeDisabled()
  })

  it('prevents duplicate submission while a creation is pending', () => {
    const onCreate =
      vi.fn<(input: CreateMeetingInput) => void>()

    render(
      <CreateMeetingDialog
        open
        submitting
        submitError={null}
        onClose={() => undefined}
        onCreate={onCreate}
      />,
    )

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Pending meeting' },
    })

    expect(
      screen.getByRole('button', { name: /creating…/i }),
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Cancel' }),
    ).toBeDisabled()
    expect(
      screen.queryByRole('button', { name: /create meeting/i }),
    ).not.toBeInTheDocument()
  })
})
})
