/**
 * Pure scheduling utilities for the Meeting create Schedule UX.
 *
 * Canonical form state (locale-independent):
 *   - datePart: local calendar date as 'YYYY-MM-DD'
 *   - timePart: local wall-clock time as 'HH:MM' (24-hour, zero-padded)
 *
 * Presentation helpers format those canonical values with an explicit
 * locale (the browser locale is resolved by the caller via `browserLocale()`
 * and the IANA timezone via the canonical `currentIanaTimezone()`). Manual
 * input parsing is deliberately locale-INDEPENDENT (canonical formats only),
 * so submission semantics never depend on display formatting.
 */

const DATE_PART_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_PART_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** The local calendar date of a Date as canonical 'YYYY-MM-DD'. */
export function localDatePart(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * True for a canonical 'YYYY-MM-DD' that names a real calendar date
 * ('2026-02-31' is rejected). Parsed explicitly from parts — never through
 * ambiguous Date.parse.
 */
export function isValidDatePart(value: string): boolean {
  const match = DATE_PART_PATTERN.exec(value)
  if (!match) {
    return false
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const candidate = new Date(year, month - 1, day)
  return (
    candidate.getFullYear() === year &&
    candidate.getMonth() === month - 1 &&
    candidate.getDate() === day
  )
}

/** True for a canonical 24-hour 'HH:MM' (00:00 .. 23:59, zero-padded). */
export function isValidTimePart(value: string): boolean {
  return TIME_PART_PATTERN.test(value)
}

/**
 * The strictly NEXT 30-minute boundary after `now` (local wall clock).
 * 20:22 -> 20:30, 20:41 -> 21:00, 23:51 -> 00:00 (next day). A time exactly
 * on a boundary rounds to the FOLLOWING boundary, so a fresh dialog never
 * proposes the current instant. Midnight rollover is handled with local
 * Date minute arithmetic (DST-safe by construction).
 */
export function nextHalfHourBoundary(
  now: Date,
): { datePart: string; timePart: string } {
  const minutes = now.getHours() * 60 + now.getMinutes()
  let rounded = Math.ceil(minutes / 30) * 30
  if (rounded === minutes) {
    rounded += 30
  }
  const local = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  local.setMinutes(rounded)
  return {
    datePart: localDatePart(local),
    timePart: `${pad2(local.getHours())}:${pad2(local.getMinutes())}`,
  }
}

/**
 * The timezone-aware ISO-8601 (UTC) instant for local wall-clock date/time
 * parts. This is EXACTLY the semantic instant the previous combined
 * datetime-local control submitted (`new Date('YYYY-MM-DDTHH:MM')` is parsed
 * as local time, then serialized with toISOString) — built here from
 * explicit local parts instead of ambiguous free-form parsing.
 *
 * Returns null when either part is not canonical/valid.
 */
export function localScheduledAtIso(
  datePart: string,
  timePart: string,
): string | null {
  if (!isValidDatePart(datePart) || !isValidTimePart(timePart)) {
    return null
  }
  const [year, month, day] = datePart.split('-').map(Number)
  const [hour, minute] = timePart.split(':').map(Number)
  return new Date(year, month - 1, day, hour, minute, 0, 0).toISOString()
}

/**
 * Parse a manually entered time into canonical 'HH:MM'. Locale-independent:
 * accepts 24-hour 'HH:MM' / 'H:MM' and 12-hour 'h:mm AM/PM' (the AM/PM form
 * requires a 1-12 hour; '21:30 PM' is rejected as contradictory). Returns
 * null for empty or unparseable text — callers keep the raw text and show
 * validation, never substitute a value.
 */
export function parseManualTime(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed === '') {
    return null
  }

  const twelveHour = /^(\d{1,2}):([0-5]\d)\s*(a\.m\.|p\.m\.|am|pm)$/i.exec(
    trimmed,
  )
  if (twelveHour) {
    const hour = Number(twelveHour[1])
    if (hour < 1 || hour > 12) {
      return null
    }
    const isPm = /p/i.test(twelveHour[3])
    let hours = hour
    if (isPm && hours !== 12) {
      hours += 12
    }
    if (!isPm && hours === 12) {
      hours = 0
    }
    return `${pad2(hours)}:${twelveHour[2]}`
  }

  const twentyFour = /^(\d{1,2}):([0-5]\d)$/.exec(trimmed)
  if (!twentyFour) {
    return null
  }
  const hour = Number(twentyFour[1])
  if (hour > 23) {
    return null
  }
  return `${pad2(hour)}:${twentyFour[2]}`
}

/**
 * Quick-selection times in 30-minute increments. The list is anchored at or
 * after the current value (an off-boundary anchor starts at the next
 * boundary; an empty/invalid anchor falls back to `now`). Convenience only:
 * selecting a suggestion never mutates the Date, and manually entered
 * non-30-minute times remain valid.
 */
export function timeSuggestions(
  anchorTimePart: string | null,
  now: Date,
  count = 4,
): string[] {
  let minutes: number
  if (anchorTimePart != null && isValidTimePart(anchorTimePart)) {
    const [hour, minute] = anchorTimePart.split(':').map(Number)
    minutes = hour * 60 + minute
  } else {
    minutes = now.getHours() * 60 + now.getMinutes()
  }
  const start = Math.ceil(minutes / 30) * 30
  const suggestions: string[] = []
  for (let i = 0; i < count; i += 1) {
    const time = (start + i * 30) % (24 * 60)
    suggestions.push(`${pad2(Math.floor(time / 60))}:${pad2(time % 60)}`)
  }
  return suggestions
}

/** The browser's locale identifier (e.g. 'en-US', 'de-DE'), with a fallback. */
export function browserLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en'
  } catch {
    return 'en'
  }
}

/**
 * Locale-formatted display of a canonical date part (e.g. 'Sep 22, 2026'
 * for en-US, '22.09.2026' for de-DE). Falls back to the raw value for an
 * invalid part.
 */
export function formatDatePartLocale(
  datePart: string,
  locale: string,
): string {
  if (!isValidDatePart(datePart)) {
    return datePart
  }
  const [year, month, day] = datePart.split('-').map(Number)
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
    new Date(year, month - 1, day),
  )
}

/**
 * Locale-formatted display of a canonical time part (e.g. '9:30 PM' for
 * en-US, '21:30' for de-DE) using the locale's own 12/24-hour convention.
 */
export function formatTimePartLocale(
  timePart: string,
  locale: string,
): string {
  if (!isValidTimePart(timePart)) {
    return timePart
  }
  const [hour, minute] = timePart.split(':').map(Number)
  return new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(2026, 0, 1, hour, minute))
}

/**
 * Full-date label for a calendar cell (e.g. 'Tuesday, September 22, 2026'),
 * unambiguous for screen readers regardless of the visible day number.
 */
export function formatCalendarDayLabel(
  datePart: string,
  locale: string,
): string {
  if (!isValidDatePart(datePart)) {
    return datePart
  }
  const [year, month, day] = datePart.split('-').map(Number)
  return new Intl.DateTimeFormat(locale, { dateStyle: 'full' }).format(
    new Date(year, month - 1, day),
  )
}

/** Locale-formatted month + year for the calendar header (e.g. 'September 2026'). */
export function formatCalendarMonthLabel(
  year: number,
  monthIndex: number,
  locale: string,
): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
  }).format(new Date(year, monthIndex, 1))
}

/**
 * The locale's first day of week as a JS day index (0 = Sunday .. 6 =
 * Saturday), converted from the ISO convention (1 = Monday .. 7 = Sunday),
 * defaulting to Sunday when the runtime cannot resolve it.
 */
export function firstDayOfWeek(locale: string): number {
  try {
    const localeObject = new Intl.Locale(
      locale,
    ) as { getWeekInfo?: () => { firstDay?: number } }
    const firstDay = localeObject.getWeekInfo?.()?.firstDay
    if (typeof firstDay === 'number' && firstDay >= 1 && firstDay <= 7) {
      return firstDay % 7
    }
  } catch {
    // Unknown locale or missing week info: fall through to the default.
  }
  return 0
}

/**
 * Short weekday labels for the calendar header (unambiguous within a week),
 * ordered from the locale's first day of week.
 */
export function weekdayHeaderLabels(locale: string): string[] {
  const firstDay = firstDayOfWeek(locale)
  const labels: string[] = []
  for (let i = 0; i < 7; i += 1) {
    const dayIndex = (firstDay + i) % 7
    // Reference week: 2026-01-04 is a Sunday, so 2026-01-(4+dayIndex) is
    // always the day of week `dayIndex`.
    labels.push(
      new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(
        new Date(2026, 0, 4 + dayIndex),
      ),
    )
  }
  return labels
}
