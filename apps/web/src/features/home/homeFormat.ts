import type {
  ApiActivityEvent,
  ApiHomeAttentionReason,
  ApiHomeDomain,
  ApiHomeTimelineCandidate,
} from '../../api/types'

/*
 * Pure presentation helpers for the Home surface. These perform
 * display-only transformations on the already-authorized Home /
 * Activity payloads; they never re-derive domain eligibility, never
 * re-sort backend ordering, and never read localStorage or the API.
 */

const SHORT_DATE = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
})

const CLOCK = new Intl.DateTimeFormat('en', {
  hour: '2-digit',
  minute: '2-digit',
})

export function parseDate(
  value: string | null,
): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatShortDate(
  value: string | null,
): string {
  const date = parseDate(value)
  if (!date) return value ?? ''
  return SHORT_DATE.format(date)
}

/** Time-of-day for a Meeting `scheduledAt` (e.g. "10:30"). */
export function formatClockTime(
  value: string | null,
): string {
  const date = parseDate(value)
  if (!date) return ''
  return CLOCK.format(date)
}

function startOfDay(date: Date): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  )
}

/**
 * Compact relative time for "Continue working" recency.
 * `latestPersonalActivityAt` is the latest attributable persisted
 * personal mutation — this is a display label only and never implies
 * "last opened" / "last viewed".
 */
export function formatRelativeTime(
  value: string,
  now: Date = new Date(),
): string {
  const then = parseDate(value)
  if (!then) return ''

  const diffMs = now.getTime() - then.getTime()
  const minutes = Math.round(diffMs / 60_000)

  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} min`

  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h`

  const dayDiff = Math.round(
    (startOfDay(now).getTime() - startOfDay(then).getTime()) /
    86_400_000,
  )

  if (dayDiff <= 1) return 'Yesterday'
  if (dayDiff < 7) return `${dayDiff} d`

  return SHORT_DATE.format(then)
}

/** Concise user-facing label for a backend attention reason code. */
export const attentionReasonLabels: Record<
  ApiHomeAttentionReason,
  string
> = {
  overdue: 'Overdue',
  blocked: 'Blocked',
}

/** Domain icon + label to distinguish Work Item vs Meeting rows. */
export function domainIcon(domain: ApiHomeDomain): string {
  return domain === 'meeting' ? 'event' : 'task_alt'
}

export function domainLabel(domain: ApiHomeDomain): string {
  return domain === 'meeting' ? 'Meeting' : 'Work item'
}

/* ── Today & next date grouping (presentation only) ───────────── */

function localDateStr(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const WEEKDAY_MONTH_DAY = new Intl.DateTimeFormat('en', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
})

/**
 * Compact right-side date label for a `Today & next` candidate:
 * "Today", "Tomorrow", or the short calendar date.
 */
export function timelineDateLabel(
  calendarDate: string,
  now: Date = new Date(),
): string {
  if (calendarDate === localDateStr(now)) return 'Today'
  if (
    calendarDate ===
    localDateStr(new Date(now.getTime() + 86_400_000))
  ) {
    return 'Tomorrow'
  }
  return formatShortDate(calendarDate)
}

/**
 * Date-group label for a `Today & next` group: "Today", "Tomorrow",
 * or the short explicit calendar date (e.g. "Fri, Sep 18" — rendered
 * uppercase as "FRI, SEP 18"). Derived from the group's actual
 * calendar date; later dates are never collapsed into one permanent
 * "Today" / "Later" heading.
 */
export function timelineGroupLabel(
  calendarDate: string,
  now: Date = new Date(),
): string {
  if (calendarDate === localDateStr(now)) return 'Today'
  if (
    calendarDate ===
    localDateStr(new Date(now.getTime() + 86_400_000))
  ) {
    return 'Tomorrow'
  }

  const date = parseDate(calendarDate)
  if (!date) return calendarDate
  return WEEKDAY_MONTH_DAY.format(date)
}

export interface TimelineDayGroup {
  /** Calendar date (`YYYY-MM-DD`) identifying the group. */
  date: string
  /** Display label for the group heading. */
  label: string
  items: ApiHomeTimelineCandidate[]
}

/**
 * Group an already-ordered, already-truncated Today & next candidate
 * list into per-calendar-date groups. Pure presentation: it preserves
 * backend ordering within each group and emits groups in first-seen
 * (backend) order, so no candidate is ever reordered. Empty groups are
 * omitted.
 */
export function groupTimelineByDay(
  candidates: ApiHomeTimelineCandidate[],
  now: Date = new Date(),
): TimelineDayGroup[] {
  const byDate = new Map<
    string,
    ApiHomeTimelineCandidate[]
  >()

  for (const candidate of candidates) {
    const date = candidate.calendarDate
    const bucket = byDate.get(date)
    if (bucket) {
      bucket.push(candidate)
    } else {
      byDate.set(date, [candidate])
    }
  }

  const groups: TimelineDayGroup[] = []
  for (const [date, items] of byDate) {
    groups.push({
      date,
      label: timelineGroupLabel(date, now),
      items,
    })
  }
  return groups
}

/* ── Activity feed date grouping (presentation only) ─────────── */

const ACTIVITY_MONTH_DAY = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
})

const ACTIVITY_MONTH_DAY_YEAR = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

/** A local calendar day key back to a local Date (never a UTC
 * parse of `YYYY-MM-DD`, which would drift in negative
 * offsets). */
function dayKeyToLocalDate(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!match) return null
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  )
}

/**
 * Date-group label for the Activity rail: "Today", "Yesterday",
 * or the short explicit calendar date (e.g. "Sep 14" — rendered
 * uppercase as "SEP 14"). A date from a different year includes
 * the year ("Sep 14, 2025").
 */
export function activityDayLabel(
  day: Date,
  now: Date = new Date(),
): string {
  if (localDateStr(day) === localDateStr(now)) {
    return 'Today'
  }

  const yesterday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - 1,
  )
  if (localDateStr(day) === localDateStr(yesterday)) {
    return 'Yesterday'
  }

  return day.getFullYear() === now.getFullYear()
    ? ACTIVITY_MONTH_DAY.format(day)
    : ACTIVITY_MONTH_DAY_YEAR.format(day)
}

export interface ActivityDayGroup {
  /** Local calendar day (`YYYY-MM-DD`) identifying the group; a
   * defensive non-date key for an unparseable timestamp. */
  date: string
  /** Display label for the group heading. */
  label: string
  /** True only for the group holding the current local day. */
  isToday: boolean
  items: ApiActivityEvent[]
}

/**
 * Group an already-ordered Activity feed (API order: newest first)
 * into per-local-calendar-day groups. Pure presentation: no event
 * is ever reordered or resorted, and groups are emitted in the
 * API's first-seen (newest-day-first) order. Events with an
 * unparseable timestamp keep their API position in their own
   * single-event group instead of crashing the rail.
 */
export function groupActivityByDay(
  events: ApiActivityEvent[],
  now: Date = new Date(),
): ActivityDayGroup[] {
  const byDay = new Map<string, ApiActivityEvent[]>()

  for (const event of events) {
    const date = parseDate(event.createdAt)
    const key = date ? localDateStr(date) : `unknown-${event.id}`
    const bucket = byDay.get(key)
    if (bucket) {
      bucket.push(event)
    } else {
      byDay.set(key, [event])
    }
  }

  const groups: ActivityDayGroup[] = []
  for (const [key, items] of byDay) {
    const day = dayKeyToLocalDate(key)
    groups.push({
      date: key,
      label: day ? activityDayLabel(day, now) : key,
      isToday:
        day != null &&
        localDateStr(day) === localDateStr(now),
      items,
    })
  }
  return groups
}
