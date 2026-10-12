// @vitest-environment happy-dom

import {
  cleanup,
  fireEvent,
  render,
  screen,
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
} from './CreateMeetingDialog'

import type {
  ApiMeeting,
  ApiMeetingSeries,
  ApiProject,
  ApiUpdateMeetingInput,
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

/*
 * Fixed clock: Wednesday, September 23, 2026, 09:00 local. All
 * fixtures are built from LOCAL date parts, so the expected local
 * calendar dates hold in every time zone.
 */
const NOW = new Date(2026, 8, 23, 9, 0)

function localIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string {
  return new Date(
    year,
    month - 1,
    day,
    hour,
    minute,
  ).toISOString()
}

const template: ApiMeetingSeries = {
  id: 7,
  researchGroupId: 1,
  scope: 'project',
  projectId: 3,
  title: 'Weekly template',
  description: '',
  isArchived: false,
  createdById: 1,
  createdAt: '2026-09-10T08:00:00Z',
  updatedAt: '2026-09-10T08:00:00Z',
}

const project: ApiProject = {
  id: 3,
  researchGroupId: 1,
  name: 'Atlas',
  description: '',
  status: 'active',
  archivedAt: null,
  currentUserRole: 'owner',
  createdAt: '2026-09-01T08:00:00Z',
  updatedAt: '2026-09-01T08:00:00Z',
}

function makeMeeting(
  overrides: Partial<ApiMeeting> & { id: number },
): ApiMeeting {
  return {
    researchGroupId: 1,
    scope: 'project',
    projectId: 3,
    seriesId: 7,
    title: `Meeting ${overrides.id}`,
    scheduledAt: localIso(2026, 9, 25, 15, 30),
    startedAt: null,
    endedAt: null,
    status: 'upcoming',
    currentMeetingItemId: null,
    participantIds: [1, 2],
    actionPermissions: {
      canEdit: true,
      canDelete: false,
      canCancel: false,
    },
    createdById: 1,
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-01T08:00:00Z',
    ...overrides,
  }
}

/** Focus the field and read its canonical (editing) value. */
function canonicalValue(label: 'Date' | 'Time'): string {
  const input = screen.getByLabelText(label) as HTMLInputElement
  fireEvent.focus(input)
  return input.value
}

function renderEditDialog(
  meeting: ApiMeeting,
  options: {
    onUpdate?: (
      meetingId: number,
      input: ApiUpdateMeetingInput,
    ) => void
    onClose?: () => void
    submitError?: string | null
    submitting?: boolean
  } = {},
): {
  onUpdate: (
    meetingId: number,
    input: ApiUpdateMeetingInput,
  ) => void
  onClose: () => void
  container: HTMLElement
} {
  const onUpdate =
    options.onUpdate ??
    vi.fn<(meetingId: number, input: ApiUpdateMeetingInput) => void>()
  const onClose = options.onClose ?? vi.fn<() => void>()

  return {
    onUpdate,
    onClose,
    ...render(
      <CreateMeetingDialog
        open
        submitting={options.submitting ?? false}
        submitError={options.submitError ?? null}
        onClose={onClose}
        onCreate={vi.fn()}
        meeting={meeting}
        onUpdate={onUpdate}
      />,
    ),
  }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)

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
  vi.mocked(projectsApi.listProjects).mockResolvedValue([project])
  vi.mocked(meetingsApi.listMeetingSeries).mockResolvedValue([
    template,
  ])
  vi.mocked(
    meetingsApi.searchStandaloneMeetingParticipantCandidates,
  ).mockResolvedValue([])
  vi.mocked(
    meetingsApi.searchMeetingSeriesParticipantCandidates,
  ).mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('CreateMeetingDialog — edit mode', () => {
  it('opens with the Meeting existing values and the edit heading', async () => {
    const meeting = makeMeeting({ id: 101 })
    renderEditDialog(meeting)

    // The heading announces Edit mode; the subtitle scopes what is
    // editable.
    expect(
      screen.getByRole('heading', {
        name: 'Edit meeting',
      }),
    ).toBeVisible()
    expect(
      screen.getByText(
        'Only the title and the scheduled time can be changed here.',
      ),
    ).toBeVisible()

    // Title prepopulated with the Meeting title.
    expect(
      (screen.getByLabelText('Title') as HTMLInputElement).value,
    ).toBe('Meeting 101')

    // Date + Time prepopulated with the LOCAL wall-clock parts of
    // the server instant (Fri, Sep 25, 15:30 local).
    expect(canonicalValue('Date')).toBe('2026-09-25')
    expect(canonicalValue('Time')).toBe('15:30')

    // The established submit label is replaced by Save changes.
    expect(
      screen.getByRole('button', {
        name: 'Save changes',
      }),
    ).toBeVisible()
    expect(screen.getByRole('button', {
      name: 'Cancel',
    })).toBeVisible()
  })

  it('hides every creation-only control and shows the context read-only', async () => {
    const meeting = makeMeeting({ id: 102 })
    renderEditDialog(meeting)

    // No creation-only controls exist in the dialog.
    expect(screen.queryByLabelText('Context')).toBeNull()
    expect(
      screen.queryByLabelText('Meeting template'),
    ).toBeNull()
    expect(screen.queryByLabelText('Repeat')).toBeNull()
    expect(screen.queryByLabelText('Participants')).toBeNull()
    expect(
      screen.queryByRole('button', {
        name: 'Save changes',
      }),
    ).not.toBeNull()

    // The read-only context presents the owning group, the Project
    // name (from the loaded Project list), and the Template name —
    // both arrive through the dialog's ordinary list fetches.
    const context = screen.getByRole('heading', {
      name: 'Context',
    }).parentElement!
    expect(within(context).getByText('Research group')).toBeVisible()
    expect(within(context).getByText('FG')).toBeVisible()
    expect(within(context).getByText('Project')).toBeVisible()
    expect(
      await within(context).findByText('Atlas'),
    ).toBeVisible()
    expect(
      await within(context).findByText('Template'),
    ).toBeVisible()
    expect(
      await within(context).findByText('Weekly template'),
    ).toBeVisible()
  })

  it('shows no Project or Template context row for a group-scoped Meeting without Template', async () => {
    const meeting = makeMeeting({
      id: 103,
      scope: 'group',
      projectId: null,
      seriesId: null,
    })
    renderEditDialog(meeting)

    const context = screen.getByRole('heading', {
      name: 'Context',
    }).parentElement!
    expect(within(context).getByText('Research group')).toBeVisible()
    expect(within(context).queryByText('Project')).toBeNull()
    expect(within(context).queryByText('Template')).toBeNull()
  })

  it('submits ONLY the changed title (no schedule, no relationships)', async () => {
    const meeting = makeMeeting({ id: 104 })
    const onUpdate = vi.fn()
    renderEditDialog(meeting, { onUpdate })

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Renamed sync' },
    })
    fireEvent.submit(
      screen.getByLabelText('Title').closest('form')!,
    )

    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate).toHaveBeenCalledWith(104, {
      title: 'Renamed sync',
    })
  })

  it('submits the new scheduled instant when the schedule changes (no title)', async () => {
    const meeting = makeMeeting({ id: 105 })
    const onUpdate = vi.fn()
    renderEditDialog(meeting, { onUpdate })

    // Move the time 30 minutes later (same date).
    const timeInput = screen.getByLabelText('Time')
    fireEvent.focus(timeInput)
    fireEvent.change(timeInput, {
      target: { value: '16:00' },
    })
    fireEvent.submit(
      screen.getByLabelText('Title').closest('form')!,
    )

    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate).toHaveBeenCalledWith(105, {
      scheduledAt: localIso(2026, 9, 25, 16, 0),
    })
  })

  it('submits an empty object when nothing changed — the original instant is never re-serialized', async () => {
    const meeting = makeMeeting({ id: 106 })
    const onUpdate = vi.fn()
    renderEditDialog(meeting, { onUpdate })

    fireEvent.submit(
      screen.getByLabelText('Title').closest('form')!,
    )

    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate).toHaveBeenCalledWith(106, {})
  })

  it('submits both fields when both changed', async () => {
    const meeting = makeMeeting({ id: 107 })
    const onUpdate = vi.fn()
    renderEditDialog(meeting, { onUpdate })

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Both changed' },
    })
    const dateInput = screen.getByLabelText('Date')
    fireEvent.focus(dateInput)
    fireEvent.change(dateInput, {
      target: { value: '2026-09-28' },
    })
    fireEvent.submit(
      screen.getByLabelText('Title').closest('form')!,
    )

    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate).toHaveBeenCalledWith(107, {
      title: 'Both changed',
      scheduledAt: localIso(2026, 9, 28, 15, 30),
    })
  })

  it('shows the error and keeps the draft intact when saving failed', async () => {
    const meeting = makeMeeting({ id: 108 })
    const { container } = renderEditDialog(meeting, {
      submitError: 'Meeting could not be updated.',
    })

    expect(
      within(container).getByRole('alert'),
    ).toHaveTextContent('Meeting could not be updated.')

    // The user-entered values survived the failed save.
    expect(
      (screen.getByLabelText('Title') as HTMLInputElement).value,
    ).toBe('Meeting 108')
    expect(canonicalValue('Time')).toBe('15:30')

    // The dialog is not stuck in a pending state.
    expect(
      screen.getByRole('button', {
        name: 'Save changes',
      }),
    ).toBeEnabled()
  })

  it('shows the pending state and blocks double submission while saving', async () => {
    renderEditDialog(makeMeeting({ id: 109 }), {
      submitting: true,
    })

    expect(
      screen.getByRole('button', {
        name: 'Saving…',
      }),
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Cancel' }),
    ).toBeDisabled()
  })

  it('closes without mutation on Cancel', async () => {
    const meeting = makeMeeting({ id: 110 })
    const onUpdate = vi.fn()
    const onClose = vi.fn()
    renderEditDialog(meeting, { onUpdate, onClose })

    fireEvent.click(screen.getByRole('button', {
      name: 'Cancel',
    }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('closes without mutation on backdrop press', async () => {
    const meeting = makeMeeting({ id: 111 })
    const onUpdate = vi.fn()
    const onClose = vi.fn()
    const { container } = renderEditDialog(meeting, {
      onUpdate,
      onClose,
    })

    fireEvent.mouseDown(container.firstElementChild!)

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onUpdate).not.toHaveBeenCalled()
  })
})

describe('CreateMeetingDialog — edit/create state reset', () => {
  it('re-initializes the form when switching to a different Meeting', async () => {
    const meetingA = makeMeeting({
      id: 301,
      title: 'Morning standup',
      scheduledAt: localIso(2026, 9, 24, 10, 0),
    })
    const meetingB = makeMeeting({
      id: 302,
      title: 'Retro',
      scheduledAt: localIso(2026, 9, 26, 13, 15),
    })

    function DialogHarness({
      phase,
      meetingA,
      meetingB,
    }: {
      phase: 'a' | 'b' | 'closed'
      meetingA: ApiMeeting
      meetingB: ApiMeeting
    }) {
      if (phase === 'closed') {
        return (
          <CreateMeetingDialog
            open={false}
            submitting={false}
            submitError={null}
            onClose={() => {}}
            onCreate={vi.fn()}
          />
        )
      }

      const meeting = phase === 'a' ? meetingA : meetingB

      return (
        <CreateMeetingDialog
          open
          submitting={false}
          submitError={null}
          onClose={() => {}}
          onCreate={vi.fn()}
          meeting={meeting}
          onUpdate={vi.fn()}
        />
      )
    }

    const { rerender } = render(
      <DialogHarness
        phase='a'
        meetingA={meetingA}
        meetingB={meetingB}
      />,
    )

    // Meeting A's values.
    expect(
      (screen.getByLabelText('Title') as HTMLInputElement).value,
    ).toBe('Morning standup')
    expect(canonicalValue('Time')).toBe('10:00')

    // Close (reset), then reopen for Meeting B.
    const Closed = () => (
      <DialogHarness
        phase='closed'
        meetingA={meetingA}
        meetingB={meetingB}
      />
    )
    rerender(<Closed />)
    expect(screen.queryByLabelText('Title')).toBeNull()

    const OpenB = () => (
      <DialogHarness
        phase='b'
        meetingA={meetingA}
        meetingB={meetingB}
      />
    )
    rerender(<OpenB />)

    expect(
      (screen.getByLabelText('Title') as HTMLInputElement).value,
    ).toBe('Retro')
    expect(canonicalValue('Date')).toBe('2026-09-26')
    expect(canonicalValue('Time')).toBe('13:15')
  })

  it('resets to the create defaults when returning from edit to create mode', async () => {
    const meeting = makeMeeting({
      id: 303,
      title: 'Edited meeting',
      scheduledAt: localIso(2026, 9, 30, 8, 45),
    })

    const { rerender } = render(
      <CreateMeetingDialog
        open
        submitting={false}
        submitError={null}
        onClose={() => {}}
        onCreate={vi.fn()}
        meeting={meeting}
        onUpdate={vi.fn()}
      />,
    )

    expect(
      (screen.getByLabelText('Title') as HTMLInputElement).value,
    ).toBe('Edited meeting')

    // Close, then open in CREATE mode (no meeting).
    const Closed = () => (
      <CreateMeetingDialog
        open={false}
        submitting={false}
        submitError={null}
        onClose={() => {}}
        onCreate={vi.fn()}
      />
    )
    rerender(<Closed />)

    const Create = () => (
      <CreateMeetingDialog
        open
        submitting={false}
        submitError={null}
        onClose={() => {}}
        onCreate={vi.fn()}
      />
    )
    rerender(<Create />)

    // Create defaults: empty title, next 30-minute boundary after
    // the fixed clock (09:00 local → 09:30 today).
    expect(
      (screen.getByLabelText('Title') as HTMLInputElement).value,
    ).toBe('')
    expect(canonicalValue('Date')).toBe('2026-09-23')
    expect(canonicalValue('Time')).toBe('09:30')
    expect(
      screen.getByRole('heading', {
        name: 'New meeting',
      }),
    ).toBeVisible()
  })
})
