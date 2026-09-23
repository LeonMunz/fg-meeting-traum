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
import {
  browserLocale,
  formatDatePartLocale,
  formatTimePartLocale,
} from './scheduleUtils'

import type {
  ApiCreateMeetingRecurrenceInput,
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

const dana: ApiMeetingParticipantCandidate = {
  id: 5,
  username: 'dana',
  firstName: 'Dana',
  lastName: 'Example',
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

// 2026-09-21 = Monday (ISO 0), 2026-09-22 = Tuesday (ISO 1),
// 2026-09-27 = Sunday (ISO 6).
const MONDAY = '2026-09-21'
const TUESDAY = '2026-09-22'
const SUNDAY = '2026-09-27'

const locale = browserLocale()
const TIME_1030 = formatTimePartLocale('10:30', locale)
const END_DATE_LABEL = formatDatePartLocale('2026-11-30', locale)

type RepeatMode = 'none' | 'daily' | 'weekly' | 'monthly'

type RenderOptions = {
  onCreateSeries?: (input: ApiCreateMeetingRecurrenceInput) => void
  submitting?: boolean
  submitError?: string | null
  open?: boolean
}

function renderDialog(options: RenderOptions = {}) {
  const onCreate =
    vi.fn<(input: CreateMeetingInput) => void>()
  const onCreateSeries =
    options.onCreateSeries ??
    vi.fn<(input: ApiCreateMeetingRecurrenceInput) => void>()
  const onClose = vi.fn<() => void>()

  const utils = render(
    <CreateMeetingDialog
      open={options.open ?? true}
      submitting={options.submitting ?? false}
      submitError={options.submitError ?? null}
      onClose={onClose}
      onCreate={onCreate}
      onCreateSeries={onCreateSeries}
    />,
  )

  return { onCreate, onCreateSeries, onClose, ...utils }
}

async function selectTemplate() {
  await screen.findByRole('option', { name: 'Weekly template' })
  fireEvent.change(screen.getByLabelText('Meeting template'), {
    target: { value: '7' },
  })
}

function selectRepeat(mode: RepeatMode) {
  fireEvent.change(screen.getByLabelText('Repeat'), {
    target: { value: mode },
  })
}

function setBaseForm(
  date: string = TUESDAY,
  time: string = '10:30',
  title: string = 'Weekly Sync',
) {
  fireEvent.change(screen.getByLabelText('Title'), {
    target: { value: title },
  })
  fireEvent.change(screen.getByLabelText('Date'), {
    target: { value: date },
  })
  fireEvent.change(screen.getByLabelText('Time'), {
    target: { value: time },
  })
}

function submitForm() {
  fireEvent.submit(screen.getByLabelText('Title').closest('form')!)
}

function weekdayButton(name: string) {
  return screen.getByRole('button', { name })
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
  vi.mocked(meetingsApi.listMeetingSeries).mockResolvedValue([
    template,
  ])
  vi.mocked(
    meetingsApi.searchStandaloneMeetingParticipantCandidates,
  ).mockResolvedValue([chris])
  vi.mocked(
    meetingsApi.searchMeetingSeriesParticipantCandidates,
  ).mockResolvedValue([chris])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('CreateMeetingDialog recurrence disclosure', () => {
  it('shows the disabled Does not repeat field with its helper and no recurrence editor without a Template', async () => {
    vi.mocked(meetingsApi.listMeetingSeries).mockResolvedValue([])

    renderDialog()
    await screen.findByRole('option', { name: 'No template' })

    const repeat = screen.getByLabelText('Repeat') as HTMLSelectElement
    expect(repeat).toBeVisible()
    expect(repeat).toBeDisabled()
    expect(repeat).toHaveValue('none')
    expect(
      screen.getByText(
        'Choose a meeting template to enable recurrence.',
      ),
    ).toBeVisible()
    // No recurrence-detail controls and no summary in the gated state.
    expect(screen.queryByLabelText('Every')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('group', { name: 'On' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Never')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Create series' }),
    ).not.toBeInTheDocument()
  })

  it('enables the Repeat field once a Template is selected, defaulting to Does not repeat', async () => {
    renderDialog()
    await selectTemplate()

    const repeat = screen.getByLabelText('Repeat') as HTMLSelectElement
    expect(repeat).toBeEnabled()
    expect(repeat).toHaveValue('none')
    expect(
      within(repeat)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Does not repeat', 'Daily', 'Weekly', 'Monthly'])
    // Default: no recurrence-detail controls and the one-time action.
    expect(screen.queryByLabelText('Every')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Create meeting' }),
    ).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Create series' }),
    ).not.toBeInTheDocument()
  })

  it('reveals the recurrence editor when Weekly is selected and renames the primary action', async () => {
    renderDialog()
    await selectTemplate()
    selectRepeat('weekly')

    expect(screen.getByLabelText('Every')).toBeVisible()
    expect(
      screen.getByRole('group', { name: 'On' }),
    ).toBeVisible()
    expect(screen.getByLabelText('Never')).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Create series' }),
    ).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Create meeting' }),
    ).not.toBeInTheDocument()
  })

  it('shows no recurrence error immediately after selecting Weekly (auto-selected weekday)', async () => {
    renderDialog()
    await selectTemplate()
    setBaseForm(TUESDAY)
    selectRepeat('weekly')

    // The Schedule weekday is auto-selected: valid on activation.
    expect(weekdayButton('Tuesday')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Create series' }),
    ).toBeEnabled()
  })

  it('keeps the ordinary Meeting flow authoritative while Repeat is Does not repeat', async () => {
    const { onCreate, onCreateSeries } = renderDialog()
    await selectTemplate()
    setBaseForm()

    submitForm()

    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Weekly Sync',
        seriesId: 7,
        participantIds: [],
      }),
    )
    expect(onCreateSeries).not.toHaveBeenCalled()
  })

  it('restores the ordinary submission when the user returns to Does not repeat', async () => {
    const { onCreate, onCreateSeries } = renderDialog()
    await selectTemplate()
    setBaseForm()
    selectRepeat('weekly')

    fireEvent.change(screen.getByLabelText('Every'), {
      target: { value: '3' },
    })
    selectRepeat('none')

    // The recurrence editor is hidden; the one-time action is back.
    expect(screen.queryByLabelText('Every')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Create meeting' }),
    ).toBeVisible()

    submitForm()

    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        seriesId: 7,
        participantIds: [],
      }),
    )
    expect(onCreateSeries).not.toHaveBeenCalled()
  })

  it('re-disables the Repeat field and presents Does not repeat when the Template is removed', async () => {
    const { onCreate, onCreateSeries } = renderDialog()
    await selectTemplate()
    setBaseForm()
    selectRepeat('weekly')

    fireEvent.change(screen.getByLabelText('Meeting template'), {
      target: { value: '' },
    })

    const repeat = screen.getByLabelText('Repeat') as HTMLSelectElement
    expect(repeat).toBeDisabled()
    expect(repeat).toHaveValue('none')
    expect(
      screen.getByText(
        'Choose a meeting template to enable recurrence.',
      ),
    ).toBeVisible()
    expect(screen.queryByLabelText('Every')).not.toBeInTheDocument()

    submitForm()

    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ seriesId: null }),
    )
    expect(onCreateSeries).not.toHaveBeenCalled()
  })

  it('resets the canonical recurrence state when the Template is removed — re-selection starts at Does not repeat', async () => {
    renderDialog()
    await selectTemplate()
    setBaseForm(TUESDAY, '10:30', 'Team Rituals')
    selectRepeat('weekly')

    // Configure recurrence-only state that must NOT survive removal.
    fireEvent.change(screen.getByLabelText('Every'), {
      target: { value: '2' },
    })
    fireEvent.click(weekdayButton('Thursday'))
    fireEvent.click(screen.getByLabelText('On date'))
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: '2026-11-30' },
    })

    const dateBefore = (
      screen.getByLabelText('Date') as HTMLInputElement
    ).value
    const timeBefore = (
      screen.getByLabelText('Time') as HTMLInputElement
    ).value

    // Remove the Template.
    fireEvent.change(screen.getByLabelText('Meeting template'), {
      target: { value: '' },
    })

    const repeat = screen.getByLabelText('Repeat') as HTMLSelectElement
    expect(repeat).toBeDisabled()
    expect(repeat).toHaveValue('none')
    // No recurrence-detail control or summary survives the removal.
    expect(screen.queryByLabelText('Every')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('group', { name: 'On' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Never')).not.toBeInTheDocument()
    expect(
      screen.queryByLabelText('End date'),
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/· no end/)).not.toBeInTheDocument()

    // Title / Date / Time are preserved by the removal.
    expect(screen.getByLabelText('Title')).toHaveValue('Team Rituals')
    expect(screen.getByLabelText('Date')).toHaveValue(dateBefore)
    expect(screen.getByLabelText('Time')).toHaveValue(timeBefore)

    // Re-selecting a Template starts at Does not repeat (enabled).
    await selectTemplate()
    expect(repeat).toBeEnabled()
    expect(repeat).toHaveValue('none')

    // Re-activating Weekly shows no leftovers of the removed
    // configuration: interval back to 1, Never end, and the weekday
    // auto-derived from the (unchanged) Schedule date.
    selectRepeat('weekly')
    expect(screen.getByLabelText('Every')).toHaveValue('1')
    expect(screen.getByLabelText('Never')).toBeChecked()
    expect(
      screen.queryByLabelText('End date'),
    ).not.toBeInTheDocument()
    expect(weekdayButton('Tuesday')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(weekdayButton('Thursday')).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })
})

describe('CreateMeetingDialog recurrence editor', () => {
  it('selecting Weekly auto-selects the Schedule weekday (ISO weekday mapping)', async () => {
    renderDialog()
    await selectTemplate()
    selectRepeat('weekly')

    setBaseForm(MONDAY)
    expect(weekdayButton('Monday')).toHaveAttribute('aria-pressed', 'true')
    expect(weekdayButton('Tuesday')).toHaveAttribute('aria-pressed', 'false')

    setBaseForm(SUNDAY)
    expect(weekdayButton('Sunday')).toHaveAttribute('aria-pressed', 'true')
    expect(weekdayButton('Monday')).toHaveAttribute('aria-pressed', 'false')
  })

  it('defaults Weekly to interval 1 with the singular unit and the schedule summary', async () => {
    renderDialog()
    await selectTemplate()
    setBaseForm(TUESDAY)
    selectRepeat('weekly')

    expect(screen.getByLabelText('Every')).toHaveValue('1')
    expect(screen.getByText('week')).toBeVisible()
    expect(
      screen.getByText(`Every week on Tuesday at ${TIME_1030} · no end`),
    ).toBeVisible()
  })

  it('lets the user select multiple weekdays and requires at least one', async () => {
    renderDialog()
    await selectTemplate()
    setBaseForm(TUESDAY)
    selectRepeat('weekly')

    fireEvent.click(weekdayButton('Thursday'))
    expect(weekdayButton('Tuesday')).toHaveAttribute('aria-pressed', 'true')
    expect(weekdayButton('Thursday')).toHaveAttribute('aria-pressed', 'true')

    // Deselecting everything after manual interaction is invalid.
    fireEvent.click(weekdayButton('Tuesday'))
    fireEvent.click(weekdayButton('Thursday'))
    expect(
      screen.getByRole('alert').textContent,
    ).toBe('Select at least one weekday.')
    expect(
      screen.getByRole('button', { name: 'Create series' }),
    ).toBeDisabled()
  })

  it('requires the start date weekday to stay selected and never repairs it silently', async () => {
    renderDialog()
    await selectTemplate()
    setBaseForm(TUESDAY)
    selectRepeat('weekly')

    // Manually configure: keep Thursday only.
    fireEvent.click(weekdayButton('Tuesday'))
    fireEvent.click(weekdayButton('Thursday'))

    expect(
      screen.getByRole('alert').textContent,
    ).toBe("The start date's weekday must be selected.")
    expect(
      screen.getByRole('button', { name: 'Create series' }),
    ).toBeDisabled()

    // Moving the start date to the selected weekday makes the rule valid.
    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: '2026-09-24' }, // Thursday
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Create series' }),
    ).toBeEnabled()
  })

  it('preserves a manually configured weekday set when the start date changes', async () => {
    renderDialog()
    await selectTemplate()
    setBaseForm(TUESDAY)
    selectRepeat('weekly')

    fireEvent.click(weekdayButton('Thursday'))
    expect(weekdayButton('Tuesday')).toHaveAttribute('aria-pressed', 'true')
    expect(weekdayButton('Thursday')).toHaveAttribute('aria-pressed', 'true')

    // The date changes; the manual selection must survive as-is.
    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: SUNDAY },
    })
    expect(weekdayButton('Tuesday')).toHaveAttribute('aria-pressed', 'true')
    expect(weekdayButton('Thursday')).toHaveAttribute('aria-pressed', 'true')
    expect(weekdayButton('Sunday')).toHaveAttribute('aria-pressed', 'false')
  })

  it('shows interval + Ends without weekdays for Daily', async () => {
    renderDialog()
    await selectTemplate()
    setBaseForm()
    selectRepeat('daily')

    // Interval 2: the unit label must pluralize per frequency.
    fireEvent.change(screen.getByLabelText('Every'), {
      target: { value: '2' },
    })

    expect(screen.getByLabelText('Every')).toBeVisible()
    expect(screen.getByLabelText('Never')).toBeVisible()
    expect(
      screen.queryByRole('group', { name: 'On' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Tuesday' }),
    ).not.toBeInTheDocument()
    expect(screen.getByText('days')).toBeVisible()
  })

  it('shows interval + Ends without weekdays for Monthly and keeps the same-day rule', async () => {
    renderDialog()
    await selectTemplate()
    setBaseForm(TUESDAY)
    selectRepeat('monthly')

    expect(screen.getByLabelText('Every')).toBeVisible()
    expect(screen.getByLabelText('Never')).toBeVisible()
    expect(
      screen.queryByRole('group', { name: 'On' }),
    ).not.toBeInTheDocument()
    expect(screen.getByText('month')).toBeVisible()
    // The same-day-of-month rule is derived from the start date (22) and
    // surfaces in the summary — no separate editable day control.
    expect(screen.queryByText('On day 22')).not.toBeInTheDocument()
    expect(
      screen.getByText(`Every month on day 22 at ${TIME_1030} · no end`),
    ).toBeVisible()
  })

  it('Does not repeat renders zero recurrence-detail fields and no summary', async () => {
    renderDialog()
    await selectTemplate()
    setBaseForm()

    expect(screen.queryByLabelText('Every')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('group', { name: 'On' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Never')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('On date')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('After')).not.toBeInTheDocument()
    expect(screen.queryByText(/· no end/)).not.toBeInTheDocument()
  })

  it('does not silently clamp invalid interval text while editing and requires >= 1', async () => {
    renderDialog()
    await selectTemplate()
    setBaseForm()
    selectRepeat('weekly')

    const interval = screen.getByLabelText('Every')
    fireEvent.change(interval, { target: { value: '0' } })
    // Not clamped while editing…
    expect(interval).toHaveValue('0')
    // …but the recurring submit is blocked.
    expect(
      screen.getByRole('button', { name: 'Create series' }),
    ).toBeDisabled()

    // After blur, a concise validation error is shown.
    fireEvent.blur(interval)
    expect(
      screen.getByRole('alert').textContent,
    ).toBe('Enter a whole number of 1 or more.')

    fireEvent.change(interval, { target: { value: '2' } })
    fireEvent.blur(interval)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('weeks')).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Create series' }),
    ).toBeEnabled()
  })

  it('maps the end modes to their canonical values (never / on date / after)', async () => {
    const { onCreateSeries } = renderDialog()
    await selectTemplate()
    setBaseForm()
    selectRepeat('weekly')

    // Never (default): both fields null.
    submitForm()
    expect(onCreateSeries).toHaveBeenLastCalledWith(
      expect.objectContaining({
        endDate: null,
        count: null,
      }),
    )

    // On date: only endDate is set (inclusive — same day is allowed).
    fireEvent.click(screen.getByLabelText('On date'))
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: TUESDAY },
    })
    expect(
      screen.getByRole('button', { name: 'Create series' }),
    ).toBeEnabled()
    submitForm()
    expect(onCreateSeries).toHaveBeenLastCalledWith(
      expect.objectContaining({
        endDate: TUESDAY,
        count: null,
      }),
    )

    // After: only count is set.
    fireEvent.click(screen.getByLabelText('After'))
    fireEvent.change(
      screen.getByLabelText('Number of meetings'),
      { target: { value: '12' } },
    )
    submitForm()
    expect(onCreateSeries).toHaveBeenLastCalledWith(
      expect.objectContaining({
        endDate: null,
        count: 12,
      }),
    )
  })

  it('uses meetings copy for the count end mode', async () => {
    renderDialog()
    await selectTemplate()
    setBaseForm()
    selectRepeat('weekly')

    fireEvent.click(screen.getByLabelText('After'))
    fireEvent.change(
      screen.getByLabelText('Number of meetings'),
      { target: { value: '3' } },
    )

    expect(screen.getByText('meetings')).toBeVisible()
    expect(
      screen.queryByText('occurrences'),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(`Every week on Tuesday at ${TIME_1030} · 3 meetings`),
    ).toBeVisible()
  })

  it('requires a count of at least 1 and a valid end date', async () => {
    renderDialog()
    await selectTemplate()
    setBaseForm()
    selectRepeat('weekly')

    fireEvent.click(screen.getByLabelText('After'))
    const count = screen.getByLabelText('Number of meetings')
    fireEvent.change(count, { target: { value: '0' } })
    fireEvent.blur(count)
    expect(
      screen.getByRole('alert').textContent,
    ).toBe('Enter a whole number of 1 or more.')
    expect(
      screen.getByRole('button', { name: 'Create series' }),
    ).toBeDisabled()

    fireEvent.click(screen.getByLabelText('On date'))
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: '2026/11/30' },
    })
    fireEvent.blur(screen.getByLabelText('End date'))
    expect(
      screen.getByRole('alert').textContent,
    ).toBe('Enter a valid date.')
    expect(
      screen.getByRole('button', { name: 'Create series' }),
    ).toBeDisabled()
  })

  it('reacts the summary to frequency, interval, weekday, time, and end edits', async () => {
    renderDialog()
    await selectTemplate()
    setBaseForm(TUESDAY)
    selectRepeat('weekly')

    expect(
      screen.getByText(`Every week on Tuesday at ${TIME_1030} · no end`),
    ).toBeVisible()

    fireEvent.change(screen.getByLabelText('Every'), {
      target: { value: '2' },
    })
    fireEvent.click(weekdayButton('Thursday'))
    expect(
      screen.getByText(
        `Every 2 weeks on Tuesday and Thursday at ${TIME_1030} · no end`,
      ),
    ).toBeVisible()

    selectRepeat('daily')
    expect(
      screen.getByText(`Every 2 days at ${TIME_1030} · no end`),
    ).toBeVisible()

    fireEvent.change(screen.getByLabelText('Time'), {
      target: { value: '09:15' },
    })
    expect(
      screen.getByText(
        `Every 2 days at ${formatTimePartLocale('09:15', locale)} · no end`,
      ),
    ).toBeVisible()

    fireEvent.click(screen.getByLabelText('After'))
    fireEvent.change(
      screen.getByLabelText('Number of meetings'),
      { target: { value: '5' } },
    )
    expect(
      screen.getByText(
        `Every 2 days at ${formatTimePartLocale('09:15', locale)} · 5 meetings`,
      ),
    ).toBeVisible()

    fireEvent.click(screen.getByLabelText('On date'))
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: '2026-11-30' },
    })
    expect(
      screen.getByText(
        `Every 2 days at ${formatTimePartLocale('09:15', locale)} · until ${END_DATE_LABEL}`,
      ),
    ).toBeVisible()
  })

  it('shows no summary while the recurrence is invalid', async () => {
    renderDialog()
    await selectTemplate()
    setBaseForm(TUESDAY)
    selectRepeat('weekly')
    expect(
      screen.getByText(`Every week on Tuesday at ${TIME_1030} · no end`),
    ).toBeVisible()

    // Deselecting every weekday invalidates the rule: the field error
    // is the presentation, not an instructional summary box.
    fireEvent.click(weekdayButton('Tuesday'))
    expect(
      screen.getByRole('alert').textContent,
    ).toBe('Select at least one weekday.')
    expect(screen.queryByText(/· no end/)).not.toBeInTheDocument()
    expect(
      screen.queryByText(
        'Complete the recurrence details to see the schedule summary.',
      ),
    ).not.toBeInTheDocument()
  })

  it('uses the existing Schedule controls as the recurrence date/time source', async () => {
    const { onCreateSeries } = renderDialog()
    await selectTemplate()
    setBaseForm('2026-09-22', '14:05')
    selectRepeat('weekly')

    submitForm()

    expect(onCreateSeries).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: '2026-09-22',
        localTime: '14:05',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    )
  })
})

describe('CreateMeetingDialog recurring submit contract', () => {
  it('submits the canonical recurrence request: title, template, rule, and nulls', async () => {
    const { onCreate, onCreateSeries } = renderDialog()
    await selectTemplate()
    setBaseForm(TUESDAY, '10:30', 'Team Rituals')
    selectRepeat('weekly')
    fireEvent.change(screen.getByLabelText('Every'), {
      target: { value: '2' },
    })
    fireEvent.click(weekdayButton('Thursday'))

    submitForm()

    expect(onCreateSeries).toHaveBeenCalledTimes(1)
    expect(onCreateSeries).toHaveBeenCalledWith({
      meetingSeriesId: 7,
      title: 'Team Rituals',
      frequency: 'weekly',
      interval: 2,
      weekdays: [1, 3],
      startDate: TUESDAY,
      localTime: '10:30',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      endDate: null,
      count: null,
      participantIds: [],
    })
    // No one-time Meeting creation, no fabricated Meeting.
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('sends no weekdays for non-weekly schedules', async () => {
    const { onCreateSeries } = renderDialog()
    await selectTemplate()
    setBaseForm('2026-09-28')
    selectRepeat('monthly')

    submitForm()

    expect(onCreateSeries).toHaveBeenCalledWith(
      expect.objectContaining({
        frequency: 'monthly',
        weekdays: [],
        startDate: '2026-09-28',
      }),
    )
  })

  it('preserves all recurrence fields when the creation fails', async () => {
    const { rerender, onCreate } = renderDialog()
    await selectTemplate()
    setBaseForm(TUESDAY)
    selectRepeat('weekly')
    fireEvent.change(screen.getByLabelText('Every'), {
      target: { value: '2' },
    })
    fireEvent.click(weekdayButton('Thursday'))
    fireEvent.click(screen.getByLabelText('After'))
    fireEvent.change(
      screen.getByLabelText('Number of meetings'),
      { target: { value: '5' } },
    )

    // The parent keeps the dialog open and reports the error.
    rerender(
      <CreateMeetingDialog
        open
        submitting={false}
        submitError="Recurring series could not be created."
        onClose={() => undefined}
        onCreate={onCreate}
      />,
    )

    expect(
      screen.getByRole('alert').textContent,
    ).toBe('Recurring series could not be created.')
    expect(screen.getByLabelText('Every')).toHaveValue('2')
    expect(weekdayButton('Tuesday')).toHaveAttribute('aria-pressed', 'true')
    expect(weekdayButton('Thursday')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('Number of meetings')).toHaveValue('5')
    expect(screen.getByLabelText('Repeat')).toHaveValue('weekly')
  })

  it('prevents duplicate submission while the recurring creation is pending', async () => {
    const { rerender } = renderDialog()
    await selectTemplate()
    setBaseForm()
    selectRepeat('weekly')

    rerender(
      <CreateMeetingDialog
        open
        submitting
        submitError={null}
        onClose={() => undefined}
        onCreate={() => undefined}
        onCreateSeries={() => undefined}
      />,
    )

    expect(
      screen.getByRole('button', { name: 'Creating…' }),
    ).toBeDisabled()
    expect(
      screen.queryByRole('button', { name: 'Create series' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })

  it('resets the recurrence defaults when the dialog is closed and reopened', async () => {
    const { rerender } = renderDialog()
    await selectTemplate()
    selectRepeat('weekly')
    fireEvent.change(screen.getByLabelText('Every'), {
      target: { value: '4' },
    })
    fireEvent.click(weekdayButton('Thursday'))

    rerender(
      <CreateMeetingDialog
        open={false}
        submitting={false}
        submitError={null}
        onClose={() => undefined}
        onCreate={() => undefined}
        onCreateSeries={() => undefined}
      />,
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    rerender(
      <CreateMeetingDialog
        open
        submitting={false}
        submitError={null}
        onClose={() => undefined}
        onCreate={() => undefined}
        onCreateSeries={() => undefined}
      />,
    )
    await selectTemplate()

    expect(screen.getByLabelText('Repeat')).toHaveValue('none')
    expect(
      screen.queryByLabelText('Every'),
    ).not.toBeInTheDocument()
  })

  it('does not close the modal from recurrence interactions, and still closes from the backdrop', async () => {
    const { onClose } = renderDialog()
    await selectTemplate()
    setBaseForm()
    selectRepeat('daily')

    // Recurrence controls behave as inside-modal interaction.
    fireEvent.change(screen.getByLabelText('Every'), {
      target: { value: '2' },
    })
    selectRepeat('weekly')
    fireEvent.click(screen.getByLabelText('After'))
    expect(onClose).not.toHaveBeenCalled()

    // Calendar interaction (start date) does not close the modal.
    fireEvent.click(screen.getByRole('button', { name: 'Choose date' }))
    fireEvent.click(
      screen.getAllByRole('button', { name: /September 15, 2026/ })[0],
    )
    expect(onClose).not.toHaveBeenCalled()

    // Backdrop press still closes the dialog.
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('CreateMeetingDialog recurring participants', () => {
  it('creates the recurring series with an empty participantIds when no participant is selected', async () => {
    const { onCreate, onCreateSeries } = renderDialog()
    await selectTemplate()
    setBaseForm()
    selectRepeat('weekly')

    // A candidate is searched but never selected.
    fireEvent.change(screen.getByLabelText('Participants'), {
      target: { value: 'ch' },
    })
    await screen.findByRole('button', {
      name: /Chris Example.*@chris.*Add/,
    })

    submitForm()

    expect(onCreateSeries).toHaveBeenCalledTimes(1)
    expect(onCreateSeries).toHaveBeenCalledWith(
      expect.objectContaining({ participantIds: [] }),
    )
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('sends the selected participant id in participantIds without blocking submission', async () => {
    const { onCreate, onCreateSeries } = renderDialog()
    await selectTemplate()
    setBaseForm()
    selectRepeat('weekly')

    fireEvent.change(screen.getByLabelText('Participants'), {
      target: { value: 'ch' },
    })
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Chris Example.*@chris.*Add/,
      }),
    )

    // Recurring submission is enabled with participants selected:
    // no blocker is rendered.
    expect(
      screen.queryByText(
        /Recurring series can't be created with participants yet/,
      ),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Create series' }),
    ).toBeEnabled()

    submitForm()

    expect(onCreateSeries).toHaveBeenCalledTimes(1)
    expect(onCreateSeries).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingSeriesId: 7,
        title: 'Weekly Sync',
        participantIds: [4],
      }),
    )
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('sends the complete participantIds array for multiple selected participants', async () => {
    vi.mocked(
      meetingsApi.searchMeetingSeriesParticipantCandidates,
    ).mockResolvedValue([chris, dana])

    const { onCreate, onCreateSeries } = renderDialog()
    await selectTemplate()
    setBaseForm()
    selectRepeat('weekly')

    fireEvent.change(screen.getByLabelText('Participants'), {
      target: { value: 'ex' },
    })
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Chris Example.*@chris.*Add/,
      }),
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Dana Example.*@dana.*Add/,
      }),
    )

    submitForm()

    expect(onCreateSeries).toHaveBeenCalledTimes(1)
    expect(onCreateSeries).toHaveBeenCalledWith(
      expect.objectContaining({ participantIds: [4, 5] }),
    )
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('still submits the one-time flow WITH participants while Repeat is Does not repeat', async () => {
    const { onCreate, onCreateSeries } = renderDialog()
    await selectTemplate()
    setBaseForm()

    fireEvent.change(screen.getByLabelText('Participants'), {
      target: { value: 'ch' },
    })
    const addButton = await screen.findByRole('button', {
      name: /Chris Example.*@chris.*Add/,
    })
    fireEvent.click(addButton)

    // Repeat stays Does not repeat: participants are part of the
    // one-time contract.
    submitForm()

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        seriesId: 7,
        participantIds: [4],
      }),
    )
    expect(onCreateSeries).not.toHaveBeenCalled()
  })
})
