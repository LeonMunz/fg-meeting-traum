import type {
  ApiHomeAttentionReason,
  ApiHomeDomain,
  ApiHomeTimelineCandidate,
  ApiMeetingStatus,
  ApiWorkItemStatus,
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
  if (minutes < 60) return `${minutes} min ago`

  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`

  const dayDiff = Math.round(
    (startOfDay(now).getTime() - startOfDay(then).getTime()) /
    86_400_000,
  )

  if (dayDiff <= 1) return 'Yesterday'
  if (dayDiff < 7) return `${dayDiff} days ago`

  return SHORT_DATE.format(then)
}

export const statusCategoryLabels: Record<
  ApiWorkItemStatus,
  string
> = {
  todo: 'To do',
  in_progress: 'In progress',
  review: 'Review',
  done: 'Done',
}

export const meetingStatusLabels: Record<
  ApiMeetingStatus,
  string
> = {
  upcoming: 'Upcoming',
  live: 'Live',
  completed: 'Completed',
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

export type TimelineGroup =
  | 'Today'
  | 'Tomorrow'
  | 'Later'

export interface TimelineDayGroup {
  group: TimelineGroup
  items: ApiHomeTimelineCandidate[]
}

/**
 * Group an already-ordered, already-truncated Today & next candidate
 * list into Today / Tomorrow / Later. Pure presentation: it preserves
 * backend ordering within each group and never reorders across groups.
 * Empty groups are omitted.
 */
export function groupTimelineByDay(
  candidates: ApiHomeTimelineCandidate[],
  now: Date = new Date(),
): TimelineDayGroup[] {
  const today = localDateStr(now)
  const tomorrow = localDateStr(
    new Date(now.getTime() + 86_400_000),
  )

  const buckets: Record<TimelineGroup, ApiHomeTimelineCandidate[]> = {
    Today: [],
    Tomorrow: [],
    Later: [],
  }

  for (const candidate of candidates) {
    if (candidate.calendarDate === today) {
      buckets.Today.push(candidate)
    } else if (candidate.calendarDate === tomorrow) {
      buckets.Tomorrow.push(candidate)
    } else {
      buckets.Later.push(candidate)
    }
  }

  const groups: TimelineDayGroup[] = []
  if (buckets.Today.length > 0) groups.push({ group: 'Today', items: buckets.Today })
  if (buckets.Tomorrow.length > 0) groups.push({ group: 'Tomorrow', items: buckets.Tomorrow })
  if (buckets.Later.length > 0) groups.push({ group: 'Later', items: buckets.Later })
  return groups
}
