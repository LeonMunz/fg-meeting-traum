/**
 * Small, generic recurrence utilities for the Meeting recurrence client
 * foundation. These are pure helpers independent of any specific
 * recurrence UI: the browser's canonical IANA time zone and the backend's
 * ISO-weekday convention for a local calendar date.
 */

import {
  formatDatePartLocale,
  formatTimePartLocale,
} from './scheduleUtils'

/**
 * ISO weekday of a local `YYYY-MM-DD` date in the backend's canonical
 * convention: 0 = Monday .. 6 = Sunday.
 *
 * The date parts are parsed directly (no UTC/DST shift) and the value is
 * converted from `Date.getDay()` (0 = Sunday .. 6 = Saturday).
 */
export function isoWeekdayOfLocalDate(datePart: string): number {
  const [year, month, day] = datePart.split('-').map(Number)
  const localDate = new Date(year, month - 1, day)
  return (localDate.getDay() + 6) % 7
}

/** The browser's canonical IANA time zone. */
export function currentIanaTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/**
 * Recurrence editor helpers (V1 language): the canonical ISO weekday
 * labels, positive-integer text parsing without silent clamping, and the
 * human-readable rule summary. All helpers are pure and UI-agnostic.
 */

/** Canonical backend ISO weekday convention: 0 = Monday .. 6 = Sunday. */
export type RecurrenceWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

export const ISO_WEEKDAYS: ReadonlyArray<{
  value: RecurrenceWeekday
  /** Compact button label (Mon Tue Wed Thu Fri Sat Sun). */
  short: string
  /** Full weekday name (accessible name + summary copy). */
  name: string
}> = [
  { value: 0, short: 'Mon', name: 'Monday' },
  { value: 1, short: 'Tue', name: 'Tuesday' },
  { value: 2, short: 'Wed', name: 'Wednesday' },
  { value: 3, short: 'Thu', name: 'Thursday' },
  { value: 4, short: 'Fri', name: 'Friday' },
  { value: 5, short: 'Sat', name: 'Saturday' },
  { value: 6, short: 'Sun', name: 'Sunday' },
]

export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly'

export type RecurrenceEndMode = 'never' | 'date' | 'count'

/**
 * Parse user-typed text as a positive whole number >= `minimum`.
 * Returns null for anything else (empty text, fractions, signs, junk) —
 * the value is NEVER clamped or coerced while the user is editing.
 */
export function parsePositiveIntegerText(
  text: string,
  minimum = 1,
): number | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) {
    return null
  }
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value) || value < minimum) {
    return null
  }
  return value
}

/** The unit word for a frequency (singular; pluralize with `s`). */
export function frequencyUnit(frequency: RecurrenceFrequency): string {
  switch (frequency) {
    case 'daily':
      return 'day'
    case 'weekly':
      return 'week'
    default:
      return 'month'
  }
}

/** Join full weekday names in canonical ISO order ("A and B" / "A, B, and C"). */
function joinWeekdayNames(weekdays: readonly number[]): string {
  const names = [...weekdays]
    .sort((a, b) => a - b)
    .map((weekday) => ISO_WEEKDAYS[weekday].name)

  if (names.length === 1) {
    return names[0]
  }
  if (names.length === 2) {
    return `${names[0]} and ${names[1]}`
  }
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
}

export interface RecurrenceSummaryInput {
  frequency: RecurrenceFrequency
  /** Resolved (valid) interval, >= 1. */
  interval: number
  /** Selected weekdays (ISO 0 = Monday .. 6 = Sunday); weekly only. */
  weekdays: readonly number[]
  /** Local calendar date of the first occurrence (YYYY-MM-DD). */
  startDate: string
  /** Local wall-clock time (HH:MM) — rendered locale-aware, never converted. */
  time: string
  locale: string
  endMode: RecurrenceEndMode
  /** Inclusive final calendar date; end mode `date` only. */
  endDate?: string | null
  /** Total occurrences including the first; end mode `count` only. */
  count?: number | null
}

/**
 * Human-readable V1 rule summary, e.g.
 * "Every 2 weeks on Tuesday and Thursday at 10:30 · no end".
 *
 * Pure presentation over the already-resolved rule values — it duplicates
 * no recurrence-domain calculation. Date/time parts use the existing
 * locale-aware scheduling formatters.
 */
export function formatRecurrenceSummary(
  input: RecurrenceSummaryInput,
): string {
  const unit = frequencyUnit(input.frequency)
  const frequencyPhrase =
    input.interval === 1
      ? `Every ${unit}`
      : `Every ${input.interval} ${unit}s`

  let detailPhrase = ''
  if (input.frequency === 'weekly') {
    detailPhrase = `on ${joinWeekdayNames(input.weekdays)}`
  } else if (input.frequency === 'monthly') {
    const dayOfMonth = Number(input.startDate.split('-')[2])
    detailPhrase = `on day ${dayOfMonth}`
  }

  const timePhrase = `at ${formatTimePartLocale(input.time, input.locale)}`

  let endPhrase: string
  if (input.endMode === 'date' && input.endDate) {
    endPhrase = `until ${formatDatePartLocale(input.endDate, input.locale)}`
  } else if (input.endMode === 'count' && input.count != null) {
    endPhrase = `${input.count} meeting${
      input.count === 1 ? '' : 's'
    }`
  } else {
    endPhrase = 'no end'
  }

  return [frequencyPhrase, detailPhrase, timePhrase]
    .filter((part) => part !== '')
    .join(' ') + ` · ${endPhrase}`
}
