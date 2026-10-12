/**
 * Client-side "Past" meeting model.
 *
 * `Past` is the read-only archive of the Meetings page: the concrete
 * Meetings whose lifecycle has explicitly reached `completed` —
 * one-time Meetings, Template-created Meetings, and materialized
 * recurring occurrences alike. Selection is a pure, deterministic
 * projection over the page's canonical concrete Meeting list
 * (`listMeetings`, already permission-filtered and Research
 * Group-scoped by the server) — no recurrence feed, no window, no
 * request of its own.
 *
 * The lifecycle is authoritative: a Meeting is in Past IFF its
 * status is exactly `completed`. Elapsed scheduled time NEVER
 * qualifies a Meeting by itself (an `upcoming` Meeting whose date
 * has passed stays out of Past until the explicit `live →
 * completed` transition), and `upcoming` / `live` / terminal
 * `cancelled` Meetings are excluded. No historical Meeting is
 * generated from a recurrence rule and no occurrence is
 * materialized to populate Past. There is no 42-day window or any
 * other arbitrary history cutoff: completed Meetings stay visible
 * no matter how far in the past their scheduled time lies.
 */

import type { ApiMeeting } from '../../api/types'
import { localDateKey } from './upcomingGroups'

/** One Past row — a concrete completed Meeting. */
export interface PastMeeting {
  /**
   * Canonical concrete Meeting id: the stable row identity and the
   * navigation target (`/meetings/{id}`).
   */
  id: number
  title: string
  /**
   * The concrete Meeting's scheduled start (timezone-aware
   * ISO-8601) — stored as-is, never rewritten or inferred.
   */
  scheduledAt: string
  /**
   * Participant count from the concrete Meeting's `participantIds`
   * (0 = none available — the row never renders a fabricated count).
   */
  participantCount: number
}

/**
 * The canonical Past selection over the concrete Meeting list:
 * exactly the Meetings whose status is `completed`, most recently
 * scheduled first.
 *
 * Ordering: the concrete `scheduledAt` DESCENDING, with the Meeting
 * id as a deterministic ascending tie-breaker for identical
 * timestamps (independent of the response ordering). Invalid
 * timestamps sort last and tie-break on id.
 */
export function selectPastMeetings(
  meetings: readonly ApiMeeting[],
): PastMeeting[] {
  return meetings
    .filter((meeting) => meeting.status === 'completed')
    .map((meeting) => ({
      id: meeting.id,
      title: meeting.title,
      scheduledAt: meeting.scheduledAt,
      participantCount: meeting.participantIds.length,
    }))
    .sort((a, b) => {
      const timeA = Date.parse(a.scheduledAt)
      const timeB = Date.parse(b.scheduledAt)
      const validA = !Number.isNaN(timeA)
      const validB = !Number.isNaN(timeB)

      if (validA && validB && timeA !== timeB) {
        return timeB - timeA
      }

      // Identical (or invalid) timestamps: deterministic id
      // tie-breaker, never input ordering.
      if (a.id !== b.id) {
        return a.id - b.id
      }
      return 0
    })
}

/** One local-calendar-date group of the Past view. */
export interface PastDateGroup {
  /** Local calendar date (`YYYY-MM-DD`) identifying the group. */
  date: string
  /**
   * Unambiguous group label including the year (e.g.
   * 'Fri, Sep 12, 2025') — Past spans arbitrary history, so the
   * year is always shown.
   */
  label: string
  /** Items of the group, most recently scheduled first. */
  items: PastMeeting[]
}

const PAST_GROUP_LABEL = new Intl.DateTimeFormat('en', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

/**
 * Unambiguous Past group heading for a local calendar date:
 * 'Fri, Sep 12, 2025' (weekday + short month + day + explicit
 * year, local time). Falls back to the raw date key for malformed
 * input.
 */
export function pastGroupLabel(calendarDate: string): string {
  const [year, month, day] = calendarDate.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  if (
    Number.isNaN(date.getTime()) ||
    date.getMonth() !== month - 1
  ) {
    return calendarDate
  }

  return PAST_GROUP_LABEL.format(date)
}

/**
 * Group an already-ordered Past list by the LOCAL calendar date of
 * each Meeting's `scheduledAt`.
 *
 * Groups come out DESCENDING by calendar date (most recent first);
 * items keep the input order (most recently scheduled first, per
 * `selectPastMeetings`). Local dates are zero-padded, so reverse
 * lexicographic key order is exact. A Meeting is grouped by its
 * scheduled time only — the actual start/end instants never affect
 * grouping.
 */
export function groupPastByDate(
  items: readonly PastMeeting[],
): PastDateGroup[] {
  const itemsByKey = new Map<string, PastMeeting[]>()

  for (const item of items) {
    const key = localDateKey(new Date(item.scheduledAt))
    const bucket = itemsByKey.get(key)
    if (bucket) {
      bucket.push(item)
    } else {
      itemsByKey.set(key, [item])
    }
  }

  return [...itemsByKey.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, groupItems]) => ({
      date,
      label: pastGroupLabel(date),
      items: groupItems,
    }))
}
