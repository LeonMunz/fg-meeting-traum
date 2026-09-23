import {
  useEffect,
  useRef,
  useMemo,
  useState,
} from 'react'
import type {
  FormEvent,
  MouseEvent as ReactMouseEvent,
} from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

import {
  listProjects,
} from '../../api/projects'
import {
  listMeetingSeries,
  searchMeetingSeriesParticipantCandidates,
  searchStandaloneMeetingParticipantCandidates,
} from '../../api/meetings'
import { useResearchGroup } from '../research-group/useResearchGroup'
import { getPersonName } from './shared'
import { CreateMeetingCalendar } from './CreateMeetingCalendar'
import {
  currentIanaTimezone,
  ISO_WEEKDAYS,
  frequencyUnit,
  formatRecurrenceSummary,
  isoWeekdayOfLocalDate,
  parsePositiveIntegerText,
  type RecurrenceEndMode,
  type RecurrenceFrequency,
} from './recurrenceUtils'
import {
  browserLocale,
  formatDatePartLocale,
  formatTimePartLocale,
  isValidDatePart,
  isValidTimePart,
  localScheduledAtIso,
  nextHalfHourBoundary,
  parseManualTime,
  timeSuggestions,
} from './scheduleUtils'

import type {
  ApiCreateMeetingRecurrenceInput,
  ApiMeetingScope,
  ApiMeetingParticipantCandidate,
  ApiMeetingSeries,
  ApiProject,
} from '../../api/types'

export type CreateMeetingInput = {
  title: string
  scheduledAt: string
  researchGroupId: number
  scope: ApiMeetingScope
  projectId: number | null
  seriesId: number | null
  participantIds: number[]
}

type CreateMeetingDialogProps = {
  open: boolean
  submitting: boolean
  submitError: string | null
  onClose: () => void
  onCreate: (input: CreateMeetingInput) => void
  /**
   * Recurring-series submit. Called only when Repeat is ON and a Meeting
   * Template is selected; the one-time `onCreate` is never invoked for a
   * recurring submission. When omitted, the recurring submit stays
   * disabled (no silent fallback to one-time creation).
   */
  onCreateSeries?: (input: ApiCreateMeetingRecurrenceInput) => void
}

function getPersonInitials(person: ApiMeetingParticipantCandidate) {
  const first =
    person.firstName.trim()[0] ??
    person.username.trim()[0] ??
    '?'
  const last = person.lastName.trim()[0] ?? ''

  return `${first}${last}`.toUpperCase()
}

export function CreateMeetingDialog({
  open,
  submitting,
  submitError,
  onClose,
  onCreate,
  onCreateSeries,
}: CreateMeetingDialogProps) {
  const { activeResearchGroup } = useResearchGroup()

  // The dialog is opened from the active Research Group's Meetings area, so
  // the Research Group is context (header), not an editable form value.
  const researchGroupId = activeResearchGroup
    ? String(activeResearchGroup.id)
    : ''

  const [title, setTitle] = useState('')
  // Separate canonical scheduling form state (locale-independent):
  //   - dateText: 'YYYY-MM-DD'
  //   - timeText: 'HH:MM' (24-hour, zero-padded)
  // Both default to today + the strictly-next 30-minute boundary (when the
  // boundary crosses midnight, the date advances with it).
  const [dateText, setDateText] = useState(() =>
    nextHalfHourBoundary(new Date()).datePart,
  )
  const [timeText, setTimeText] = useState(() =>
    nextHalfHourBoundary(new Date()).timePart,
  )
  const [dateFocused, setDateFocused] = useState(false)
  const [timeFocused, setTimeFocused] = useState(false)
  const [dateTouched, setDateTouched] = useState(false)
  const [timeTouched, setTimeTouched] = useState(false)
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [timeListOpen, setTimeListOpen] = useState(false)
  const [activeTimeIndex, setActiveTimeIndex] = useState(0)
  const dateFieldRef = useRef<HTMLDivElement | null>(null)
  const dateInputRef = useRef<HTMLInputElement | null>(null)
  const timeListRef = useRef<HTMLDivElement | null>(null)
  const [projects, setProjects] = useState<ApiProject[]>([])
  const [projectId, setProjectId] = useState('')
  const [series, setSeries] = useState<ApiMeetingSeries[]>([])
  const [seriesId, setSeriesId] = useState('')
  const [participantQuery, setParticipantQuery] = useState('')
  const [participantCandidates, setParticipantCandidates] = useState<
    ApiMeetingParticipantCandidate[]
  >([])
  const [selectedParticipants, setSelectedParticipants] = useState<
    ApiMeetingParticipantCandidate[]
  >([])
  const [searchingParticipants, setSearchingParticipants] = useState(false)
  const [participantSearchError, setParticipantSearchError] = useState<
    string | null
  >(null)
  const participantSearchVersion = useRef(0)

  // Recurrence (V1) editor state. Canonical defaults: Repeat OFF, Weekly,
  // interval 1, end Never. The weekday set starts as the start date's ISO
  // weekday and follows date changes until the user configures it manually
  // (weekdaysTouched); hidden values never affect the one-time submit.
  const [repeatOn, setRepeatOn] = useState(false)
  const [recurrenceFrequency, setRecurrenceFrequency] = useState<
    RecurrenceFrequency
  >('weekly')
  const [intervalText, setIntervalText] = useState('1')
  const [intervalTouched, setIntervalTouched] = useState(false)
  const [weekdays, setWeekdays] = useState<number[]>(() => [
    isoWeekdayOfLocalDate(nextHalfHourBoundary(new Date()).datePart),
  ])
  const [weekdaysTouched, setWeekdaysTouched] = useState(false)
  const [endMode, setEndMode] = useState<RecurrenceEndMode>('never')
  const [endDateText, setEndDateText] = useState('')
  const [endDateTouched, setEndDateTouched] = useState(false)
  const [countText, setCountText] = useState('')
  const [countTouched, setCountTouched] = useState(false)
  const [endDateCalendarOpen, setEndDateCalendarOpen] = useState(false)
  const endDateFieldRef = useRef<HTMLDivElement | null>(null)
  const endDateInputRef = useRef<HTMLInputElement | null>(null)

  // The browser locale drives PRESENTATION only (field display, calendar
  // labels); canonical values and parsing never depend on it.
  const locale = useMemo(() => browserLocale(), [])

  const scope: ApiMeetingScope =
    projectId === '' ? 'group' : 'project'

  const selectedProjectId =
    projectId === '' ? null : Number(projectId)

  useEffect(() => {
    if (!open) {
      setTitle('')
      const boundary = nextHalfHourBoundary(new Date())
      setDateText(boundary.datePart)
      setTimeText(boundary.timePart)
      setDateFocused(false)
      setTimeFocused(false)
      setDateTouched(false)
      setTimeTouched(false)
      setCalendarOpen(false)
      setTimeListOpen(false)
      setActiveTimeIndex(0)
      setProjects([])
      setProjectId('')
      setSeries([])
      setSeriesId('')
      setParticipantQuery('')
      setParticipantCandidates([])
      setSelectedParticipants([])
      setSearchingParticipants(false)
      setParticipantSearchError(null)
      participantSearchVersion.current += 1
      setRepeatOn(false)
      setRecurrenceFrequency('weekly')
      setIntervalText('1')
      setIntervalTouched(false)
      setWeekdays([isoWeekdayOfLocalDate(boundary.datePart)])
      setWeekdaysTouched(false)
      setEndMode('never')
      setEndDateText('')
      setEndDateTouched(false)
      setCountText('')
      setCountTouched(false)
      setEndDateCalendarOpen(false)
      return
    }
  }, [open])

  // Outside mousedown closes the Time suggestions list (established
  // repository popover contract; the calendar handles its own outside
  // clicks through CreateMeetingCalendar).
  useEffect(() => {
    if (!timeListOpen) {
      return
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (
        event.target instanceof Node &&
        !timeListRef.current?.contains(event.target)
      ) {
        setTimeListOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
    }
  }, [timeListOpen])

  const dateValid = isValidDatePart(dateText)
  const timeValid = isValidTimePart(timeText)
  const dateError = dateText !== '' && !dateValid && dateTouched
  const timeError = timeText !== '' && !timeValid && timeTouched

  // Locale-aware display: a valid value is rendered in the browser locale
  // while the field is NOT focused; focused fields always show/edit the
  // canonical form (so manual entry stays unambiguous and locale-
  // independent).
  const dateDisplay =
    dateValid && !dateFocused ? formatDatePartLocale(dateText, locale) : dateText
  const timeDisplay =
    timeValid && !timeFocused
      ? formatTimePartLocale(timeText, locale)
      : timeText

  // Quick-selection times in 30-minute increments (convenience only).
  const timeOptions = timeSuggestions(
    timeValid ? timeText : null,
    new Date(),
  )

  const openTimeList = () => {
    setCalendarOpen(false)
    setActiveTimeIndex(Math.max(0, timeOptions.indexOf(timeText)))
    setTimeListOpen(true)
  }

  const toggleTimeList = () => {
    if (timeListOpen) {
      setTimeListOpen(false)
    } else {
      openTimeList()
    }
  }

  const toggleCalendar = () => {
    setTimeListOpen(false)
    setCalendarOpen((current) => !current)
  }

  const selectTimeOption = (timePart: string) => {
    setTimeText(timePart)
    setTimeTouched(false)
    setTimeListOpen(false)
  }

  const handleTimeKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
  ) => {
    if (timeListOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveTimeIndex(
          (index) => (index + 1) % timeOptions.length,
        )
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveTimeIndex(
          (index) => (index - 1 + timeOptions.length) % timeOptions.length,
        )
      } else if (event.key === 'Enter') {
        event.preventDefault()
        selectTimeOption(timeOptions[activeTimeIndex])
      } else if (event.key === 'Escape') {
        // Close the suggestions first; a subsequent Escape keeps the
        // dialog's existing (no-op) behavior.
        event.stopPropagation()
        setTimeListOpen(false)
      } else if (event.key === 'Tab') {
        setTimeListOpen(false)
      }
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      openTimeList()
    }
  }

  const handleCalendarSelect = (selectedDatePart: string) => {
    applyDateText(selectedDatePart)
    setDateTouched(false)
    setCalendarOpen(false)
    dateInputRef.current?.focus()
  }

  // Central Date change path (manual entry + Calendar selection): keeps the
  // DEFAULT (unconfigured) weekly weekday set in sync with the start date.
  // A manually configured weekday set is preserved exactly as the user set
  // it — the start-date weekday rule is validated, never repaired.
  const applyDateText = (value: string) => {
    setDateText(value)
    if (isValidDatePart(value) && !weekdaysTouched) {
      setWeekdays([isoWeekdayOfLocalDate(value)])
    }
  }

  const applyFrequency = (next: RecurrenceFrequency) => {
    setRecurrenceFrequency(next)
    // Re-activating Weekly without a manual configuration re-derives the
    // default weekday set from the current start date.
    if (next === 'weekly' && !weekdaysTouched && dateValid) {
      setWeekdays([isoWeekdayOfLocalDate(dateText)])
    }
  }

  const toggleWeekday = (value: number) => {
    setWeekdaysTouched(true)
    setWeekdays((current) =>
      current.includes(value)
        ? current.filter((weekday) => weekday !== value)
        : [...current, value].sort((a, b) => a - b),
    )
  }

  const handleEndDateCalendarSelect = (selectedDatePart: string) => {
    setEndDateText(selectedDatePart)
    setEndDateTouched(false)
    setEndDateCalendarOpen(false)
    endDateInputRef.current?.focus()
  }

  // Load the projects available for the selected research group so the
  // Project dropdown can offer them. Only write-role projects allow
  // Meeting creation; the server remains authoritative.
  useEffect(() => {
    const gid = Number(researchGroupId)
    if (!open || !Number.isInteger(gid) || gid <= 0) {
      setProjects([])
      setProjectId('')
      return
    }

    let cancelled = false
    listProjects(gid)
      .then((nextProjects) => {
        if (cancelled) {
          return
        }

        const writable = nextProjects.filter(
          (project) =>
            project.currentUserRole === 'owner' ||
            project.currentUserRole === 'member',
        )

        setProjects(writable)

        // Reset a Project selection that no longer applies.
        setProjectId((current) =>
          writable.some((p) => p.id === Number(current))
            ? current
            : '',
        )
      })
      .catch(() => {
        if (!cancelled) {
          setProjects([])
          setProjectId('')
        }
      })

    return () => {
      cancelled = true
    }
  }, [open, researchGroupId])

  // Load meeting templates (series) scoped to the selected Research Group.
  // The dropdown filters to templates matching the current scope/project.
  useEffect(() => {
    const gid = Number(researchGroupId)
    if (!open || !Number.isInteger(gid) || gid <= 0) {
      setSeries([])
      setSeriesId('')
      return
    }

    let cancelled = false
    listMeetingSeries(gid)
      .then((nextSeries) => {
        if (cancelled) {
          return
        }
        setSeries(nextSeries)
        setSeriesId((current) => {
          if (current === '') {
            return ''
          }
          const match = nextSeries.find(
            (candidate) => candidate.id === Number(current),
          )
          if (!match) {
            return ''
          }
          const wantedProject =
            projectId === '' ? null : Number(projectId)
          const ok =
            match.scope === 'group'
              ? match.projectId === null
              : match.projectId === wantedProject
          return ok ? current : ''
        })
      })
      .catch(() => {
        if (!cancelled) {
          setSeries([])
          setSeriesId('')
        }
      })

    return () => {
      cancelled = true
    }
  }, [open, researchGroupId, projectId])

  useEffect(() => {
    if (!open) {
      return
    }

    const query = participantQuery.trim()
    const groupId = Number(researchGroupId)
    const selectedSeriesId = Number(seriesId)

    participantSearchVersion.current += 1
    const version = participantSearchVersion.current
    setParticipantCandidates([])
    setSearchingParticipants(false)
    setParticipantSearchError(null)

    if (
      query.length < 2 ||
      (!seriesId &&
        (!Number.isInteger(groupId) || groupId <= 0)) ||
      (seriesId &&
        (!Number.isInteger(selectedSeriesId) || selectedSeriesId <= 0))
    ) {
      return
    }

    const timeout = window.setTimeout(() => {
      setSearchingParticipants(true)

      const request = seriesId
        ? searchMeetingSeriesParticipantCandidates(
            selectedSeriesId,
            query,
          )
        : searchStandaloneMeetingParticipantCandidates(groupId, {
            query,
            scope,
            projectId: selectedProjectId,
          })

      void request
        .then((results) => {
          if (participantSearchVersion.current !== version) {
            return
          }
          setParticipantCandidates(results)
        })
        .catch(() => {
          if (participantSearchVersion.current !== version) {
            return
          }
          setParticipantSearchError('People could not be searched.')
        })
        .finally(() => {
          if (participantSearchVersion.current === version) {
            setSearchingParticipants(false)
          }
        })
    }, 250)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [
    open,
    participantQuery,
    projectId,
    researchGroupId,
    scope,
    selectedProjectId,
    seriesId,
  ])

  if (!open) {
    return null
  }

  const availableSeries = series.filter((candidate) => {
    if (candidate.isArchived) {
      return false
    }
    if (scope === 'group') {
      return candidate.scope === 'group'
    }
    return (
      candidate.scope === 'project' &&
      candidate.projectId === selectedProjectId
    )
  })

  // ── Recurrence (V1) derived state ────────────────────────────────
  // Recurrence controls only exist with a selected Template, so the
  // recurring submit is only possible with one; turning Repeat OFF (or
  // going back to "No template") makes the one-time flow authoritative
  // again, with the hidden recurrence values having no effect.
  const templateSelected = seriesId !== ''
  const recurrenceActive = repeatOn && templateSelected

  const intervalValue = parsePositiveIntegerText(intervalText, 1)
  const intervalError =
    intervalText !== '' && intervalValue === null && intervalTouched
  const intervalUnit = `${frequencyUnit(recurrenceFrequency)}${
    intervalValue === 1 ? '' : 's'
  }`

  const endDateValid = endDateText !== '' && isValidDatePart(endDateText)
  // Errors only surface for the ACTIVE end mode: the inactive mode's input
  // is not rendered, so it cannot own a visible error.
  const endDateError =
    endMode === 'date' &&
    endDateText !== '' &&
    !isValidDatePart(endDateText) &&
    endDateTouched

  const countValue =
    countText === '' ? null : parsePositiveIntegerText(countText, 1)
  const countError =
    endMode === 'count' &&
    countText !== '' &&
    countValue === null &&
    countTouched

  const startWeekday = dateValid ? isoWeekdayOfLocalDate(dateText) : null
  const weeklyWeekdaysValid =
    recurrenceFrequency !== 'weekly' ||
    (weekdays.length > 0 &&
      (startWeekday === null || weekdays.includes(startWeekday)))

  const weekdayError =
    recurrenceActive && recurrenceFrequency === 'weekly'
      ? weekdays.length === 0
        ? 'Select at least one weekday.'
        : startWeekday !== null && !weekdays.includes(startWeekday)
          ? 'The start date\'s weekday must be selected.'
          : null
      : null

  // Hard rule: selected Participants must never be silently discarded by a
  // recurring submit. The recurrence contract has no participant
  // persistence semantics yet, so recurring creation is gated (with an
  // explicit explanation) while any participant is selected.
  const participantsBlockRecurrence =
    recurrenceActive && selectedParticipants.length > 0

  const recurrenceValid =
    title.trim() !== '' &&
    researchGroupId !== '' &&
    dateValid &&
    timeValid &&
    intervalValue !== null &&
    weeklyWeekdaysValid &&
    (endMode !== 'date' || endDateValid) &&
    (endMode !== 'count' || countValue !== null) &&
    !participantsBlockRecurrence &&
    onCreateSeries != null

  const recurrenceSummaryValid =
    dateValid &&
    timeValid &&
    intervalValue !== null &&
    weeklyWeekdaysValid &&
    (endMode !== 'date' || endDateValid) &&
    (endMode !== 'count' || countValue !== null)

  // The summary previews the resolved rule whenever every recurrence input
  // is currently valid; it duplicates no recurrence-domain calculation.
  const recurrenceSummary =
    recurrenceSummaryValid
      ? formatRecurrenceSummary({
          frequency: recurrenceFrequency,
          interval: intervalValue as number,
          weekdays,
          startDate: dateText,
          time: timeText,
          locale,
          endMode,
          endDate: endMode === 'date' ? endDateText : null,
          count: endMode === 'count' ? countValue : null,
        })
      : 'Complete the recurrence details to see the schedule summary.'

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()

    const trimmedTitle = title.trim()

    if (!trimmedTitle || !researchGroupId) {
      return
    }

    // Recurring submission: the canonical POST /api/meeting-recurrences/
    // request is built from the local wall-clock parts directly (no UTC
    // conversion of localTime). It never calls the one-time Meeting
    // creation and no concrete Meeting is fabricated client-side.
    if (recurrenceActive) {
      if (!recurrenceValid) {
        return
      }

      onCreateSeries?.({
        meetingSeriesId: Number(seriesId),
        title: trimmedTitle,
        frequency: recurrenceFrequency,
        interval: intervalValue as number,
        weekdays:
          recurrenceFrequency === 'weekly'
            ? [...weekdays].sort((a, b) => a - b)
            : [],
        startDate: dateText,
        localTime: timeText,
        timezone: currentIanaTimezone(),
        endDate: endMode === 'date' ? endDateText : null,
        count: endMode === 'count' ? (countValue as number) : null,
      })

      return
    }

    // Combine the canonical Date + Time parts into the SAME semantic
    // instant the previous combined datetime-local control submitted
    // (local wall-clock intent, browser timezone, ISO-8601 UTC).
    const scheduledAt = localScheduledAtIso(dateText, timeText)

    if (!scheduledAt) {
      return
    }

    const resolvedProjectId =
      projectId === '' ? null : Number(projectId)

    onCreate({
      title: trimmedTitle,
      scheduledAt,
      researchGroupId: Number(researchGroupId),
      scope,
      projectId: resolvedProjectId,
      seriesId: seriesId === '' ? null : Number(seriesId),
      participantIds: selectedParticipants.map(
        (participant) => participant.id,
      ),
    })
  }

  const selectedParticipantIds = new Set(
    selectedParticipants.map((participant) => participant.id),
  )

  const availableParticipantCandidates = participantCandidates.filter(
    (candidate) => !selectedParticipantIds.has(candidate.id),
  )

  const selectParticipant = (
    candidate: ApiMeetingParticipantCandidate,
  ) => {
    setSelectedParticipants((current) =>
      current.some((participant) => participant.id === candidate.id)
        ? current
        : [...current, candidate],
    )
  }

  // Backdrop-target close: only a pointer press that lands on the
  // backdrop itself — never on a descendant of the modal (inputs,
  // selects, buttons, or the Calendar/Time popovers) — closes the
  // dialog through the existing onClose action. This is the local
  // outside-click contract of the repository popovers, implemented on
  // the backdrop element itself (no document-global handler).
  const handleBackdropMouseDown = (
    event: ReactMouseEvent<HTMLDivElement>,
  ) => {
    if (event.target === event.currentTarget) {
      onClose()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4 py-4"
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-meeting-title"
        className="flex max-h-[calc(100dvh-3rem)] w-full max-w-[min(32.5rem,calc(100vw-3rem))] flex-col overflow-hidden rounded-xl border border-border-subtle bg-surface shadow-xl"
      >
        <form
          onSubmit={handleSubmit}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="shrink-0 border-b border-border-subtle px-6 py-5">
            <h2
              id="create-meeting-title"
              className="text-lg font-semibold text-text"
            >
              New meeting
            </h2>

            <p className="mt-1 text-sm text-text-muted">
              {activeResearchGroup
                ? `Create a meeting in ${activeResearchGroup.name}.`
                : 'Create a meeting.'}
            </p>
          </div>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-text">
                Title
              </span>

              <input
                autoFocus
                type="text"
                value={title}
                onChange={(event) =>
                  setTitle(event.target.value)
                }
                placeholder="Weekly Sync"
                className="h-10 w-full rounded-lg border border-border-control bg-surface px-3 text-sm text-text outline-none transition placeholder:text-text-muted/60 focus:border-focus focus:ring-2 focus:ring-focus/15"
              />
            </label>

            <div>
              <label
                htmlFor="create-meeting-project"
                className="mb-1.5 block text-sm font-medium text-text"
              >
                Project
              </label>

              <select
                id="create-meeting-project"
                value={projectId}
                onChange={(event) => {
                  setProjectId(event.target.value)
                  setSeriesId('')
                }}
                className="h-10 w-full rounded-lg border border-border-control bg-surface px-3 text-sm text-text outline-none focus:border-focus focus:ring-2 focus:ring-focus/15"
              >
                <option value="">Research group meeting</option>

                {projects.map((project) => (
                  <option
                    key={project.id}
                    value={project.id}
                  >
                    {project.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="create-meeting-template"
                className="mb-1.5 block text-sm font-medium text-text"
              >
                Meeting template
              </label>

              <select
                id="create-meeting-template"
                aria-describedby="create-meeting-template-help"
                value={seriesId}
                onChange={(event) =>
                  setSeriesId(event.target.value)
                }
                className="h-10 w-full rounded-lg border border-border-control bg-surface px-3 text-sm text-text outline-none focus:border-focus focus:ring-2 focus:ring-focus/15"
              >
                <option value="">No template</option>

                {availableSeries.map((candidate) => (
                  <option
                    key={candidate.id}
                    value={candidate.id}
                  >
                    {candidate.title}
                  </option>
                ))}
              </select>

              <p
                id="create-meeting-template-help"
                className="mt-1.5 text-xs text-text-muted"
              >
                {seriesId === ''
                  ? 'Choose a template to enable recurring meetings.'
                  : 'Uses the template sections as the starting structure.'}
              </p>
            </div>

            {templateSelected && (
              <div>
                <div className="flex items-center justify-between gap-3">
                  <span
                    id="create-meeting-repeat-label"
                    className="text-sm font-medium text-text"
                  >
                    Repeat meeting
                  </span>

                  <button
                    type="button"
                    role="switch"
                    aria-checked={repeatOn}
                    aria-labelledby="create-meeting-repeat-label"
                    onClick={() => {
                      setRepeatOn((current) => !current)
                      setEndDateCalendarOpen(false)
                    }}
                    className={[
                      'relative h-6 w-11 shrink-0 rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
                      repeatOn ? 'bg-accent' : 'bg-surface-muted',
                    ].join(' ')}
                  >
                    <span
                      aria-hidden="true"
                      className={[
                        'absolute top-0.5 h-5 w-5 rounded-full bg-surface shadow transition-all',
                        repeatOn ? 'left-[22px]' : 'left-0.5',
                      ].join(' ')}
                    />
                  </button>
                </div>

                {repeatOn && (
                  <div className="ml-1 mt-3 space-y-4 border-l-2 border-border-subtle pl-4">
                    <div>
                      <span
                        id="create-meeting-recurrence-frequency-label"
                        className="mb-1.5 block text-sm font-medium text-text"
                      >
                        Frequency
                      </span>

                      <div
                        role="group"
                        aria-labelledby="create-meeting-recurrence-frequency-label"
                        className="grid w-full grid-cols-3 overflow-hidden rounded-lg border border-border-control bg-surface"
                      >
                        {(
                          [
                            ['daily', 'Daily'],
                            ['weekly', 'Weekly'],
                            ['monthly', 'Monthly'],
                          ] as const
                        ).map(([value, label], index) => (
                          <button
                            key={value}
                            type="button"
                            aria-pressed={recurrenceFrequency === value}
                            onClick={() => applyFrequency(value)}
                            className={[
                              'h-9 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus',
                              index > 0
                                ? 'border-l border-border-control'
                                : '',
                              recurrenceFrequency === value
                                ? 'bg-surface-hover font-semibold text-text'
                                : 'text-text-muted hover:bg-surface-hover',
                            ].join(' ')}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label
                        htmlFor="create-meeting-recurrence-interval"
                        className="mb-1.5 block text-sm font-medium text-text"
                      >
                        Every
                      </label>

                      <div className="flex items-center gap-2">
                        <input
                          id="create-meeting-recurrence-interval"
                          type="text"
                          inputMode="numeric"
                          value={intervalText}
                          onChange={(event) =>
                            setIntervalText(event.target.value)
                          }
                          onBlur={() => setIntervalTouched(true)}
                          aria-invalid={intervalError || undefined}
                          aria-describedby={
                            intervalError
                              ? 'create-meeting-recurrence-interval-error'
                              : undefined
                          }
                          className="h-10 w-20 rounded-lg border border-border-control bg-surface px-3 text-sm text-text outline-none transition focus:border-focus focus:ring-2 focus:ring-focus/15"
                        />

                        <span className="text-sm text-text-muted">
                          {intervalUnit}
                        </span>
                      </div>

                      {intervalError && (
                        <p
                          id="create-meeting-recurrence-interval-error"
                          role="alert"
                          className="mt-1.5 text-xs text-danger"
                        >
                          Enter a whole number of 1 or more.
                        </p>
                      )}
                    </div>

                    {recurrenceFrequency === 'weekly' && (
                      <div>
                        <span
                          id="create-meeting-recurrence-weekdays-label"
                          className="mb-1.5 block text-sm font-medium text-text"
                        >
                          On
                        </span>

                        <div
                          role="group"
                          aria-labelledby="create-meeting-recurrence-weekdays-label"
                          aria-describedby={
                            weekdayError
                              ? 'create-meeting-recurrence-weekdays-error'
                              : undefined
                          }
                          className="flex gap-1.5"
                        >
                          {ISO_WEEKDAYS.map((day) => {
                            const selected = weekdays.includes(day.value)

                            return (
                              <button
                                key={day.value}
                                type="button"
                                aria-pressed={selected}
                                aria-label={day.name}
                                onClick={() => toggleWeekday(day.value)}
                                className={[
                                  'flex h-9 w-9 items-center justify-center gap-0.5 rounded-lg border text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                                  selected
                                    ? 'border-accent bg-accent text-text-inverse'
                                    : 'border-border-control bg-surface text-text-muted hover:bg-surface-hover',
                                ].join(' ')}
                              >
                                {day.short}
                                {selected && (
                                  <span
                                    aria-hidden="true"
                                    className="material-symbols-outlined text-[14px]"
                                  >
                                    check
                                  </span>
                                )}
                              </button>
                            )
                          })}
                        </div>

                        {weekdayError && (
                          <p
                            id="create-meeting-recurrence-weekdays-error"
                            role="alert"
                            className="mt-1.5 text-xs text-danger"
                          >
                            {weekdayError}
                          </p>
                        )}
                      </div>
                    )}

                    {recurrenceFrequency === 'monthly' && (
                      <p className="text-sm text-text-muted">
                        {dateValid
                          ? `On day ${Number(dateText.split('-')[2])}`
                          : 'On day —'}
                      </p>
                    )}

                    <div>
                      <span className="mb-1.5 block text-sm font-medium text-text">
                        Ends
                      </span>

                      <div className="space-y-2">
                        <label className="flex cursor-pointer items-center gap-2 text-sm text-text">
                          <input
                            type="radio"
                            name="create-meeting-recurrence-end-mode"
                            value="never"
                            checked={endMode === 'never'}
                            onChange={() => setEndMode('never')}
                            className="h-4 w-4"
                          />
                          Never
                        </label>

                        <div className="flex items-center gap-2">
                          <input
                            id="create-meeting-recurrence-end-mode-date"
                            type="radio"
                            name="create-meeting-recurrence-end-mode"
                            value="date"
                            checked={endMode === 'date'}
                            onChange={() => setEndMode('date')}
                            className="h-4 w-4"
                          />
                          <label
                            htmlFor="create-meeting-recurrence-end-mode-date"
                            className="cursor-pointer text-sm text-text"
                          >
                            On date
                          </label>

                          {endMode === 'date' && (
                            <div
                              ref={endDateFieldRef}
                              className="relative min-w-0 flex-1"
                            >
                              <input
                                ref={endDateInputRef}
                                type="text"
                                aria-label="End date"
                                value={
                                  endDateValid && !endDateCalendarOpen
                                    ? formatDatePartLocale(
                                        endDateText,
                                        locale,
                                      )
                                    : endDateText
                                }
                                onChange={(event) =>
                                  setEndDateText(event.target.value)
                                }
                                onBlur={() => setEndDateTouched(true)}
                                placeholder="YYYY-MM-DD"
                                aria-invalid={endDateError || undefined}
                                aria-describedby={
                                  endDateError
                                    ? 'create-meeting-recurrence-end-date-error'
                                    : undefined
                                }
                                className="h-9 w-full max-w-[180px] rounded-lg border border-border-control bg-surface pl-3 pr-10 text-sm text-text outline-none transition placeholder:text-text-muted/60 focus:border-focus focus:ring-2 focus:ring-focus/15"
                              />

                              <button
                                type="button"
                                aria-label="Choose end date"
                                aria-haspopup="grid"
                                aria-expanded={endDateCalendarOpen}
                                onClick={() =>
                                  setEndDateCalendarOpen(
                                    (current) => !current,
                                  )
                                }
                                className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-text-muted transition hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                              >
                                <span
                                  aria-hidden="true"
                                  className="material-symbols-outlined text-[18px]"
                                >
                                  calendar_month
                                </span>
                              </button>

                              <CreateMeetingCalendar
                                open={endDateCalendarOpen}
                                locale={locale}
                                selectedDatePart={
                                  endDateValid ? endDateText : null
                                }
                                anchorRef={endDateFieldRef}
                                triggerRef={endDateInputRef}
                                onSelect={handleEndDateCalendarSelect}
                                onOpenChange={setEndDateCalendarOpen}
                              />
                            </div>
                          )}
                        </div>

                        {endDateError && (
                          <p
                            id="create-meeting-recurrence-end-date-error"
                            role="alert"
                            className="ml-6 text-xs text-danger"
                          >
                            Enter a valid date.
                          </p>
                        )}

                        <div className="flex items-center gap-2">
                          <input
                            id="create-meeting-recurrence-end-mode-count"
                            type="radio"
                            name="create-meeting-recurrence-end-mode"
                            value="count"
                            checked={endMode === 'count'}
                            onChange={() => setEndMode('count')}
                            className="h-4 w-4"
                          />
                          <label
                            htmlFor="create-meeting-recurrence-end-mode-count"
                            className="cursor-pointer text-sm text-text"
                          >
                            After
                          </label>

                          {endMode === 'count' && (
                            <>
                              <input
                                type="text"
                                inputMode="numeric"
                                aria-label="Number of occurrences"
                                value={countText}
                                onChange={(event) =>
                                  setCountText(event.target.value)
                                }
                                onBlur={() => setCountTouched(true)}
                                placeholder="10"
                                aria-invalid={countError || undefined}
                                aria-describedby={
                                  countError
                                    ? 'create-meeting-recurrence-count-error'
                                    : undefined
                                }
                                className="h-9 w-16 rounded-lg border border-border-control bg-surface px-3 text-sm text-text outline-none transition placeholder:text-text-muted/60 focus:border-focus focus:ring-2 focus:ring-focus/15"
                              />

                              <span className="text-sm text-text-muted">
                                occurrences
                              </span>
                            </>
                          )}
                        </div>

                        {countError && (
                          <p
                            id="create-meeting-recurrence-count-error"
                            role="alert"
                            className="ml-6 text-xs text-danger"
                          >
                            Enter a whole number of 1 or more.
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex items-start gap-2 rounded-lg bg-surface-muted/50 px-3 py-2">
                      <span
                        aria-hidden="true"
                        className="material-symbols-outlined mt-0.5 text-[16px] text-text-muted"
                      >
                        repeat
                      </span>

                      <p className="min-h-4 text-xs leading-4 text-text-muted">
                        {recurrenceSummary}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div>
              <label
                htmlFor="create-meeting-participants"
                className="mb-1.5 block text-sm font-medium text-text"
              >
                Participants
              </label>

              <div className="relative">
                <span
                  aria-hidden="true"
                  className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-text-muted"
                >
                  search
                </span>
                <input
                  id="create-meeting-participants"
                  type="search"
                  value={participantQuery}
                  onChange={(event) =>
                    setParticipantQuery(event.target.value)
                  }
                  placeholder="Search participants..."
                  aria-describedby={
                    participantQuery.trim().length === 1
                      ? 'create-meeting-participants-help'
                      : undefined
                  }
                  className="h-10 w-full rounded-lg border border-border-control bg-surface pl-10 pr-3 text-sm text-text outline-none transition placeholder:text-text-muted/60 focus:border-focus focus:ring-2 focus:ring-focus/15"
                />
              </div>

              {participantQuery.trim().length === 1 && (
                <p
                  id="create-meeting-participants-help"
                  className="mt-1.5 text-xs text-text-muted"
                >
                  Type at least 2 characters.
                </p>
              )}

              {participantQuery.trim().length >= 2 && (
                <div
                  aria-live="polite"
                  className="mt-2 max-h-44 overflow-y-auto rounded-xl border border-border-default bg-surface shadow-lg"
                >
                  {searchingParticipants ? (
                    <div className="flex items-center gap-2 px-4 py-3 text-sm text-text-muted">
                      <span
                        aria-hidden="true"
                        className="material-symbols-outlined animate-spin text-[18px]"
                      >
                        refresh
                      </span>
                      Searching…
                    </div>
                  ) : participantSearchError ? (
                    <div role="alert" className="px-4 py-3 text-sm text-danger">
                      {participantSearchError}
                    </div>
                  ) : availableParticipantCandidates.length > 0 ? (
                    <div className="divide-y divide-border-subtle">
                      {availableParticipantCandidates.map((candidate) => (
                        <button
                          key={candidate.id}
                          type="button"
                          onClick={() => selectParticipant(candidate)}
                          className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
                        >
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-muted text-[11px] font-semibold text-text">
                            {getPersonInitials(candidate)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-text">
                              {getPersonName(candidate)}
                            </span>
                            <span className="block truncate text-xs text-text-muted">
                              @{candidate.username}
                            </span>
                          </span>
                          <span className="text-xs font-semibold text-accent-text">
                            Add
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="px-4 py-3 text-sm text-text-muted">
                      {participantCandidates.length > 0
                        ? 'All matching people are selected.'
                        : 'No matching people found.'}
                    </div>
                  )}
                </div>
              )}

              {selectedParticipants.length > 0 && (
                <div
                  role="list"
                  aria-label="Selected participants"
                  className="mt-3 flex flex-wrap gap-2"
                >
                  {selectedParticipants.map((participant) => (
                    <span
                      key={participant.id}
                      role="listitem"
                      className="inline-flex min-w-0 items-center gap-1 rounded-full bg-surface-muted px-2.5 py-1 text-xs text-text"
                    >
                      <span className="max-w-40 truncate">
                        {getPersonName(participant)}
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove ${getPersonName(participant)}`}
                        onClick={() =>
                          setSelectedParticipants((current) =>
                            current.filter(
                              (candidate) => candidate.id !== participant.id,
                            ),
                          )
                        }
                        className="-mr-0.5 flex h-5 w-5 items-center justify-center rounded-full text-text-muted transition hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                      >
                        <span
                          aria-hidden="true"
                          className="material-symbols-outlined text-[16px]"
                        >
                          close
                        </span>
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {participantsBlockRecurrence && (
                <p
                  id="create-meeting-participants-recurrence-note"
                  className="mt-2 text-xs text-danger"
                >
                  Recurring series can't be created with participants yet.
                  Remove participants, or turn off repeat to create a single
                  meeting.
                </p>
              )}
            </div>

            <div className="border-t border-border-subtle pt-5">
              <h3 className="mb-3 text-sm font-semibold text-text">
                Schedule
              </h3>

              <div className="flex flex-col gap-3 min-[480px]:flex-row min-[480px]:items-start">
                <div className="min-w-0 flex-1">
                  <label
                    htmlFor="create-meeting-date"
                    className="mb-1.5 block text-sm font-medium text-text"
                  >
                    Date
                  </label>

                  <div
                    ref={dateFieldRef}
                    className="relative"
                  >
                      <input
                        id="create-meeting-date"
                        ref={dateInputRef}
                        type="text"
                        value={dateDisplay}
                        onChange={(event) =>
                          applyDateText(event.target.value)
                        }
                        onFocus={() => setDateFocused(true)}
                        onBlur={() => {
                          setDateFocused(false)
                          setDateTouched(true)
                        }}
                      placeholder="YYYY-MM-DD"
                      aria-invalid={dateError || undefined}
                      aria-describedby={
                        dateError
                          ? 'create-meeting-date-error'
                          : undefined
                      }
                      className="h-10 w-full rounded-lg border border-border-control bg-surface pl-3 pr-10 text-sm text-text outline-none transition placeholder:text-text-muted/60 focus:border-focus focus:ring-2 focus:ring-focus/15"
                    />

                    <button
                      type="button"
                      aria-label="Choose date"
                      aria-haspopup="grid"
                      aria-expanded={calendarOpen}
                      onClick={toggleCalendar}
                      className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-text-muted transition hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      <span
                        aria-hidden="true"
                        className="material-symbols-outlined text-[18px]"
                      >
                        calendar_month
                      </span>
                    </button>

                    <CreateMeetingCalendar
                      open={calendarOpen}
                      locale={locale}
                      selectedDatePart={dateValid ? dateText : null}
                      anchorRef={dateFieldRef}
                      triggerRef={dateInputRef}
                      onSelect={handleCalendarSelect}
                      onOpenChange={setCalendarOpen}
                    />
                  </div>

                  {dateError && (
                    <p
                      id="create-meeting-date-error"
                      role="alert"
                      className="mt-1.5 text-xs text-danger"
                    >
                      Enter a valid date.
                    </p>
                  )}
                </div>

                <div className="w-full min-[480px]:w-[148px] min-[480px]:shrink-0">
                  <label
                    htmlFor="create-meeting-time"
                    className="mb-1.5 block text-sm font-medium text-text"
                  >
                    Time
                  </label>

                  <div
                    ref={timeListRef}
                    className="relative"
                  >
                    <input
                      id="create-meeting-time"
                      type="text"
                      role="combobox"
                      aria-expanded={timeListOpen}
                      aria-haspopup="listbox"
                      aria-autocomplete="list"
                      aria-controls={
                        timeListOpen
                          ? 'create-meeting-time-listbox'
                          : undefined
                      }
                      aria-activedescendant={
                        timeListOpen
                          ? `create-meeting-time-option-${activeTimeIndex}`
                          : undefined
                      }
                      value={timeDisplay}
                      onChange={(event) => {
                        const value = event.target.value
                        setTimeText(value)
                        setActiveTimeIndex(
                          Math.max(0, timeOptions.indexOf(value)),
                        )
                      }}
                      onKeyDown={handleTimeKeyDown}
                      onFocus={() => setTimeFocused(true)}
                      onBlur={() => {
                        setTimeFocused(false)
                        setTimeTouched(true)
                        setTimeListOpen(false)
                        // Normalize manually entered times to the
                        // canonical form (locale-independent parsing;
                        // malformed text is kept as-is for validation).
                        setTimeText(
                          (current) => parseManualTime(current) ?? current,
                        )
                      }}
                      placeholder="HH:MM"
                      aria-invalid={timeError || undefined}
                      aria-describedby={
                        timeError
                          ? 'create-meeting-time-error'
                          : undefined
                      }
                      className="h-10 w-full rounded-lg border border-border-control bg-surface pl-3 pr-9 text-sm text-text outline-none transition placeholder:text-text-muted/60 focus:border-focus focus:ring-2 focus:ring-focus/15"
                    />

                    <button
                      type="button"
                      aria-label="Show time options"
                      aria-haspopup="listbox"
                      aria-expanded={timeListOpen}
                      onClick={toggleTimeList}
                      className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-text-muted transition hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      <span
                        aria-hidden="true"
                        className="material-symbols-outlined text-[18px]"
                      >
                        expand_more
                      </span>
                    </button>

                    {timeListOpen && (
                      <div
                        id="create-meeting-time-listbox"
                        role="listbox"
                        aria-label="Time options"
                        className="absolute bottom-[calc(100%+6px)] right-0 z-50 w-full min-w-[148px] overflow-hidden rounded-lg border border-border-subtle bg-surface py-1 shadow-[0_12px_32px_rgba(0,0,0,0.32)]"
                      >
                        {timeOptions.map((option, index) => (
                          <div
                            key={option}
                            id={`create-meeting-time-option-${index}`}
                            role="option"
                            aria-selected={option === timeText}
                            onMouseDown={(event) =>
                              event.preventDefault()
                            }
                            onClick={() =>
                              selectTimeOption(option)
                            }
                            onMouseEnter={() =>
                              setActiveTimeIndex(index)
                            }
                            className={[
                              'cursor-pointer px-3 py-2 text-sm text-text',
                              index === activeTimeIndex
                                ? 'bg-surface-hover'
                                : '',
                            ].join(' ')}
                          >
                            {formatTimePartLocale(option, locale)}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {timeError && (
                    <p
                      id="create-meeting-time-error"
                      role="alert"
                      className="mt-1.5 text-xs text-danger"
                    >
                      Enter a valid time.
                    </p>
                  )}
                </div>
              </div>

              <p className="mt-2.5 text-xs text-text-muted">
                Local time · {currentIanaTimezone()}
              </p>
            </div>
          </div>

          {submitError && (
            <div
              role="alert"
              className="shrink-0 border-t border-danger-subtle bg-danger-bg px-6 py-3 text-sm text-danger"
            >
              {submitError}
            </div>
          )}

          <div className="flex shrink-0 items-center justify-end gap-3 border-t border-border-subtle bg-surface-hover/30 px-6 py-4">
            <button
              type="button"
              disabled={submitting}
              onClick={onClose}
              className="h-9 rounded-lg px-4 text-sm font-medium text-text-muted transition hover:bg-surface-hover hover:text-text disabled:opacity-45"
            >
              Cancel
            </button>

              <button
                type="submit"
                disabled={
                  submitting ||
                  !title.trim() ||
                  !dateValid ||
                  !timeValid ||
                  !researchGroupId ||
                  (recurrenceActive && !recurrenceValid)
                }
                aria-describedby={
                  participantsBlockRecurrence
                    ? 'create-meeting-participants-recurrence-note'
                    : undefined
                }
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-text-inverse shadow-sm transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
              >
                <span
                  aria-hidden="true"
                  className="material-symbols-outlined text-[18px]"
                >
                  {recurrenceActive ? 'repeat' : 'add'}
                </span>

                {submitting
                  ? 'Creating…'
                  : recurrenceActive
                    ? 'Create series'
                    : 'Create meeting'}
              </button>
          </div>
        </form>
      </div>
    </div>
  )
}
