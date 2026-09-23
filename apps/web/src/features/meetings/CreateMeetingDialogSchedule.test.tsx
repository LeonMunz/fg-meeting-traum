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
  type CreateMeetingInput,
} from './CreateMeetingDialog'

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

/** Focus the field and read its canonical (editing) value. */
function canonicalValue(label: 'Date' | 'Time'): string {
  const input = screen.getByLabelText(label) as HTMLInputElement
  fireEvent.focus(input)
  return input.value
}

/** The Time suggestions listbox (scoped away from native <select> options). */
function timeListbox() {
  return screen.getByRole('listbox', { name: 'Time options' })
}

function timeOptions() {
  return within(timeListbox()).getAllByRole('option')
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
  vi.mocked(meetingsApi.listMeetingSeries).mockResolvedValue([])
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

describe('CreateMeetingDialog schedule controls', () => {
  it('renders separate Date and Time controls in the Schedule section', () => {
    renderDialog()

    const date = screen.getByLabelText('Date')
    const time = screen.getByLabelText('Time')
    expect(date).toBeVisible()
    expect(time).toBeVisible()
    expect(screen.queryByLabelText('Date and time')).not.toBeInTheDocument()

    const schedule = screen
      .getByRole('heading', { name: 'Schedule' })
      .parentElement!
    expect(schedule).toContainElement(date)
    expect(schedule).toContainElement(time)
  })

  it('removes the old combined datetime-local control', () => {
    renderDialog()

    expect(
      document.querySelector('input[type="datetime-local"]'),
    ).not.toBeInTheDocument()
  })
})

describe('CreateMeetingDialog schedule defaults', () => {
  it('defaults a fresh dialog to today and the next 30-minute boundary', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 22, 20, 22))

    renderDialog()

    expect(canonicalValue('Date')).toBe('2026-09-22')
    expect(canonicalValue('Time')).toBe('20:30')
  })

  it('rounds the default to the following boundary when exactly on one', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 22, 21, 0, 0))

    renderDialog()

    expect(canonicalValue('Date')).toBe('2026-09-22')
    expect(canonicalValue('Time')).toBe('21:30')
  })

  it('advances the default date when the boundary crosses midnight', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 30, 23, 51))

    renderDialog()

    expect(canonicalValue('Date')).toBe('2026-10-01')
    expect(canonicalValue('Time')).toBe('00:00')
  })

  it('does not override existing form values during rerenders', () => {
    const { onCreate, rerender } = renderDialog()

    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: '2030-01-02' },
    })
    fireEvent.change(screen.getByLabelText('Time'), {
      target: { value: '13:47' },
    })

    rerender(
      <CreateMeetingDialog
        open
        submitting={false}
        submitError={null}
        onClose={() => undefined}
        onCreate={onCreate}
      />,
    )

    expect(canonicalValue('Date')).toBe('2030-01-02')
    expect(canonicalValue('Time')).toBe('13:47')
  })
})

describe('CreateMeetingDialog schedule submission', () => {
  it('submits manually entered Date + Time as the legacy scheduledAt instant', () => {
    const { onCreate } = renderDialog()

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Manual entry' },
    })
    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: '2030-01-02' },
    })
    fireEvent.change(screen.getByLabelText('Time'), {
      target: { value: '10:30' },
    })
    fireEvent.submit(screen.getByLabelText('Title').closest('form')!)

    // The old flow built new Date('2030-01-02T10:30').toISOString().
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledAt: new Date(2030, 0, 2, 10, 30, 0, 0).toISOString(),
      }),
    )
  })

  it('accepts a manually entered non-30-minute time (13:47)', () => {
    const { onCreate } = renderDialog()

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Odd minutes' },
    })
    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: '2030-01-02' },
    })
    fireEvent.change(screen.getByLabelText('Time'), {
      target: { value: '13:47' },
    })
    fireEvent.submit(screen.getByLabelText('Title').closest('form')!)

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledAt: new Date(2030, 0, 2, 13, 47, 0, 0).toISOString(),
      }),
    )
  })

  it('normalizes 12-hour locale time entry to the canonical form', () => {
    renderDialog()

    fireEvent.change(screen.getByLabelText('Time'), {
      target: { value: '9:30 PM' },
    })
    fireEvent.blur(screen.getByLabelText('Time'))

    expect(canonicalValue('Time')).toBe('21:30')
  })

  it('submits template-based creation with the split Date + Time', async () => {
    vi.mocked(meetingsApi.listMeetingSeries).mockResolvedValue([
      {
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
      },
    ])

    const { onCreate } = renderDialog()
    await screen.findByRole('option', { name: 'Weekly template' })

    fireEvent.change(screen.getByLabelText('Meeting template'), {
      target: { value: '7' },
    })
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Template planning' },
    })
    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: '2030-01-02' },
    })
    fireEvent.change(screen.getByLabelText('Time'), {
      target: { value: '10:30' },
    })
    fireEvent.submit(screen.getByLabelText('Title').closest('form')!)

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        seriesId: 7,
        scheduledAt: new Date(2030, 0, 2, 10, 30, 0, 0).toISOString(),
      }),
    )
  })
})

describe('CreateMeetingDialog date calendar', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 22, 20, 22))
  })

  it('opens from the date affordance with an expanded state', () => {
    renderDialog()
    const trigger = screen.getByRole('button', { name: 'Choose date' })

    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)

    expect(screen.getByRole('grid')).toBeVisible()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('selects a date from the calendar and updates the Date control', () => {
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Choose date' }))
    fireEvent.click(within(screen.getByRole('grid')).getByText('15'))

    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
    expect(canonicalValue('Date')).toBe('2026-09-15')
    // Focus returns to the Date input.
    expect(screen.getByLabelText('Date')).toHaveFocus()
  })

  it('navigates months and selects a date in the visible month', () => {
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Choose date' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
    fireEvent.click(within(screen.getByRole('grid')).getByText('15'))

    expect(canonicalValue('Date')).toBe('2026-10-15')

    fireEvent.click(screen.getByRole('button', { name: 'Choose date' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    fireEvent.click(within(screen.getByRole('grid')).getByText('15'))

    expect(canonicalValue('Date')).toBe('2026-09-15')
  })

  it('marks the selected date in the calendar (distinct from today)', () => {
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Choose date' }))
    fireEvent.click(within(screen.getByRole('grid')).getByText('15'))

    // Reopen: the selection persists and today keeps its own marker.
    fireEvent.click(screen.getByRole('button', { name: 'Choose date' }))
    const grid = screen.getByRole('grid')

    const selectedCell = within(grid)
      .getAllByRole('gridcell')
      .find(
        (cell) => cell.getAttribute('aria-selected') === 'true',
      )
    expect(within(selectedCell!).getByText('15')).toBeVisible()

    const todayButton = within(grid)
      .getAllByRole('button')
      .find((button) => button.getAttribute('aria-current') === 'date')
    expect(todayButton?.textContent).toBe('22')

    const todayCell = within(grid)
      .getAllByRole('gridcell')
      .find(
        (cell) => within(cell).queryByText('22', { exact: true }) !== null,
      )
    expect(
      todayCell?.getAttribute('aria-selected'),
    ).not.toBe('true')
  })

  it('closes the calendar on Escape without closing the Meeting dialog', () => {
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Choose date' }))
    expect(screen.getByRole('grid')).toBeVisible()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'New meeting', level: 2 }),
    ).toBeVisible()
    expect(screen.getByLabelText('Date')).toHaveFocus()
  })

  it('closes the calendar on an outside click', () => {
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Choose date' }))
    expect(screen.getByRole('grid')).toBeVisible()

    fireEvent.mouseDown(document.body)

    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
  })
})

describe('CreateMeetingDialog time suggestions', () => {
  it('offers 30-minute convenience values anchored at the current value', () => {
    renderDialog()

    fireEvent.change(screen.getByLabelText('Time'), {
      target: { value: '21:30' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Show time options' }),
    )

    const options = timeOptions()
    expect(options).toHaveLength(4)
    // The current (on-boundary) value anchors the list and is marked.
    expect(options[0]).toHaveAttribute('aria-selected', 'true')

    fireEvent.click(options[1])

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(canonicalValue('Time')).toBe('22:00')
  })

  it('anchors an off-boundary value at the next boundary', () => {
    renderDialog()

    fireEvent.change(screen.getByLabelText('Time'), {
      target: { value: '21:18' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Show time options' }),
    )

    const options = timeOptions()
    // No option matches the off-boundary current value.
    expect(
      options.some((option) =>
        option.getAttribute('aria-selected') === 'true',
      ),
    ).toBe(false)

    fireEvent.click(options[0])

    expect(canonicalValue('Time')).toBe('21:30')
  })

  it('supports keyboard selection of a suggestion', () => {
    renderDialog()

    fireEvent.change(screen.getByLabelText('Time'), {
      target: { value: '21:30' },
    })
    const time = screen.getByLabelText('Time')
    fireEvent.keyDown(time, { key: 'ArrowDown' })

    expect(timeOptions()).toHaveLength(4)
    expect(time).toHaveAttribute('aria-expanded', 'true')

    fireEvent.keyDown(time, { key: 'ArrowDown' })
    fireEvent.keyDown(time, { key: 'Enter' })

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(canonicalValue('Time')).toBe('22:00')
  })

  it('closes the suggestions on Escape and keeps the dialog', () => {
    renderDialog()

    fireEvent.change(screen.getByLabelText('Time'), {
      target: { value: '21:30' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Show time options' }),
    )
    expect(screen.getByRole('listbox')).toBeVisible()

    fireEvent.keyDown(screen.getByLabelText('Time'), { key: 'Escape' })

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'New meeting', level: 2 }),
    ).toBeVisible()
  })
})

describe('CreateMeetingDialog timezone display', () => {
  it('shows the IANA timezone of the user, not a hardcoded value', () => {
    renderDialog()

    const timezone =
      Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(
      screen.getByText(`Local time · ${timezone}`),
    ).toBeVisible()
  })
})

describe('CreateMeetingDialog schedule validation', () => {
  it('blocks submission with an invalid date (impossible calendar date)', () => {
    const { onCreate } = renderDialog()

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Broken date' },
    })
    const date = screen.getByLabelText('Date')
    fireEvent.change(date, { target: { value: '2026-02-31' } })
    fireEvent.blur(date)

    expect(screen.getByText('Enter a valid date.')).toBeVisible()
    expect(
      screen.getByRole('button', { name: /Create meeting/i }),
    ).toBeDisabled()

    fireEvent.submit(screen.getByLabelText('Title').closest('form')!)
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('blocks submission with an invalid time (out-of-range)', () => {
    const { onCreate } = renderDialog()

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Broken time' },
    })
    const time = screen.getByLabelText('Time')
    fireEvent.change(time, { target: { value: '25:00' } })
    fireEvent.blur(time)

    expect(screen.getByText('Enter a valid time.')).toBeVisible()
    expect(
      screen.getByRole('button', { name: /Create meeting/i }),
    ).toBeDisabled()

    fireEvent.submit(screen.getByLabelText('Title').closest('form')!)
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('blocks submission when the Time is exactly 24:00 (boundary regression)', () => {
    const { onCreate } = renderDialog()

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Midnight boundary' },
    })
    const time = screen.getByLabelText('Time')
    fireEvent.change(time, { target: { value: '24:00' } })
    fireEvent.blur(time)

    expect(screen.getByText('Enter a valid time.')).toBeVisible()
    expect(
      screen.getByRole('button', { name: /Create meeting/i }),
    ).toBeDisabled()

    fireEvent.submit(screen.getByLabelText('Title').closest('form')!)
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('does not show field errors while the user is still typing', () => {
    renderDialog()

    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: '2026-02-31' },
    })
    fireEvent.change(screen.getByLabelText('Time'), {
      target: { value: '25:00' },
    })

    expect(
      screen.queryByText('Enter a valid date.'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Enter a valid time.'),
    ).not.toBeInTheDocument()
  })

  it('recovers once the invalid input is corrected', () => {
    renderDialog()

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Recovered' },
    })
    const date = screen.getByLabelText('Date')
    fireEvent.change(date, { target: { value: '2026-02-31' } })
    fireEvent.blur(date)
    expect(screen.getByText('Enter a valid date.')).toBeVisible()

    fireEvent.change(date, { target: { value: '2026-09-22' } })
    expect(
      screen.queryByText('Enter a valid date.'),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Create meeting/i }),
    ).toBeEnabled()
  })

  it('introduces no recurrence controls and keeps the footer contract', () => {
    renderDialog()

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'No recurrence here' },
    })
    expect(screen.queryByText(/repeat meeting/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/frequency/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/interval/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/end date/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
    expect(
      screen.getByRole('button', { name: /Create meeting/i }),
    ).toBeEnabled()
  })
})
