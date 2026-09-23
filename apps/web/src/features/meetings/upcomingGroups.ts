/**
 * Presentation helpers for the Upcoming view: grouping an already-
 * normalized, already-ordered `UpcomingMeeting` list by LOCAL calendar
 * date, and the compact formatters for row cells.
 *
 * Pure and UI-agnostic: no API access, no React. The grouping preserves
 * the deterministic ordering produced by `buildUpcomingList` (effective
 * `scheduledAt` ascending, stable row-id tie-break) — groups come out
 * ascending by date and items stay ascending inside their group.
 */

import type { UpcomingMeeting } from './upcomingModel'

/** One date group of the Upcoming view. */
export interface UpcomingDateGroup {
  /** Local calendar date (`YYYY-MM-DD`) identifying the group. */
  date: string
  /** Group label: 'Today' / 'Tomorrow' / 'Thu, Sep 24' (the UI renders it uppercase). */
  label: string
  /** Items of the group, ascending by effective start. */
  items: UpcomingMeeting[]
}

/** Local calendar date key (`YYYY-MM-DD`) for a Date. */
export function localDateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Local date key of `n` calendar days after `date`'s local date —
 * DST-safe local-midnight arithmetic (never a fixed 24 h offset).
 */
function localDateKeyAfterDays(date: Date, days: number): string {
  return localDateKey(
    new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate() + days,
    ),
  )
}

const LATER_GROUP_LABEL = new Intl.DateTimeFormat('en', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
})

/**
 * Group heading for a local calendar date: 'Today', 'Tomorrow', or the
 * short explicit date (e.g. 'Thu, Sep 24'). The UI renders the label
 * uppercase ('TODAY', 'THU, SEP 24').
 */
export function upcomingGroupLabel(
  calendarDate: string,
  now: Date = new Date(),
): string {
  if (calendarDate === localDateKey(now)) return 'Today'
  if (
    calendarDate ===
    localDateKeyAfterDays(now, 1)
  ) {
    return 'Tomorrow'
  }

  const [year, month, day] = calendarDate.split('-').map(
    Number,
  )
  const date = new Date(year, month - 1, day)
  if (
    Number.isNaN(date.getTime()) ||
    date.getMonth() !== month - 1
  ) {
    return calendarDate
  }

  return LATER_GROUP_LABEL.format(date)
}

/**
 * Group an already-ordered Upcoming list by the LOCAL calendar date of
 * each item's effective `scheduledAt`.
 *
 * Groups are ascending by date; items inside a group keep their input
 * order (ascending by effective start, per `buildUpcomingList`). A
 * rescheduled occurrence is grouped by its EFFECTIVE time only — the
 * original slot never produces an additional group or entry.
 */
export function groupUpcomingByDate(
  items: readonly UpcomingMeeting[],
  now: Date = new Date(),
): UpcomingDateGroup[] {
  const orderedKeys: string[] = []
  const itemsByKey = new Map<string, UpcomingMeeting[]>()

  for (const item of items) {
    const key = localDateKey(new Date(item.scheduledAt))
    const bucket = itemsByKey.get(key)
    if (bucket) {
      bucket.push(item)
    } else {
      itemsByKey.set(key, [item])
      orderedKeys.push(key)
    }
  }

  // Input is ascending by instant; keys therefore appear ascending by
  // calendar date already — but sort explicitly to stay correct for any
  // input order (local dates are zero-padded and sort lexicographically).
  orderedKeys.sort()

  return orderedKeys.map((key) => ({
    date: key,
    label: upcomingGroupLabel(key, now),
    items: itemsByKey.get(key) ?? [],
  }))
}

const CLOCK_TIME = new Intl.DateTimeFormat('en', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const ORIGINAL_DATE = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
})

/** Compact local clock time for the Time cell (e.g. '10:00'). */
export function formatUpcomingTime(
  scheduledAt: string,
): string {
  const date = new Date(scheduledAt)

  if (Number.isNaN(date.getTime())) {
    return scheduledAt
  }

  return CLOCK_TIME.format(date)
}

/**
 * Reschedule metadata line: 'Originally Sep 29 · 10:00' (the original
 * slot's local date + clock time).
 */
export function formatOriginallyLabel(
  originalScheduledAt: string,
): string {
  const date = new Date(originalScheduledAt)

  if (Number.isNaN(date.getTime())) {
    return 'Originally —'
  }

  return `Originally ${ORIGINAL_DATE.format(date)} · ${CLOCK_TIME.format(date)}`
}

/** People-cell count copy: '1 person' / 'N people'. */
export function peopleLabel(count: number): string {
  return count === 1
    ? '1 person'
    : `${count} people`
}
