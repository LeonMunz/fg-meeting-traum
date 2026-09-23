/**
 * Client-side effective "Upcoming" meeting model.
 *
 * `Upcoming` contains concrete effective meeting occurrences, NOT Series
 * records: one-time Meetings and recurring occurrences (virtual or
 * materialized) appear together in one chronological timeline. This module
 * defines the canonical frontend view model for a single Upcoming row, a
 * pure, testable normalization that merges the concrete Meeting list and the
 * personal recurring-occurrence feed into one deduplicated chronological
 * list, and the deterministic initial request-window helper.
 *
 * This is the contract the redesigned Upcoming UI will consume. The
 * materialized-vs-virtual distinction is INTERNAL: a virtual occurrence is a
 * normal Upcoming item (its `meetingId` is simply null) and is never labelled
 * "virtual" / "generated".
 */

import type {
  ApiMeeting,
  ApiMeetingRecurrenceOccurrence,
  ApiMeetingStatus,
} from '../../api/types'

/**
 * The initial Upcoming request window span, in days: today through today +
 * 42 (the initial 6-week window; no infinite scrolling yet).
 */
export const UPCOMING_WINDOW_DAYS = 42

/**
 * Deterministic initial Upcoming request window.
 *
 * Boundary semantics (pinned): `from` is the local midnight of `now`'s
 * calendar date (the first instant of "today") and `to` is the local midnight
 * of the calendar date `UPCOMING_WINDOW_DAYS` days later — a span of EXACTLY
 * `UPCOMING_WINDOW_DAYS` local calendar days, anchored at local midnight and
 * serialized as timezone-aware ISO-8601 (UTC) instants for the backend's
 * inclusive `[from, to]` window contract.
 *
 * Anchored on LOCAL calendar dates via local-midnight arithmetic (matching
 * the repository's date convention — see `localScheduledAtIso`), so the
 * window reads "today through +42 days" in the user's local calendar and is
 * DST-safe by construction.
 */
export function upcomingRequestWindow(
  now: Date = new Date(),
): { from: string; to: string } {
  const fromLocal = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  )
  const toLocal = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + UPCOMING_WINDOW_DAYS,
  )
  return {
    from: fromLocal.toISOString(),
    to: toLocal.toISOString(),
  }
}

/**
 * One effective Upcoming row — the canonical frontend representation the
 * redesigned Upcoming UI consumes. It covers BOTH a one-time concrete Meeting
 * and a recurring occurrence behind a single shape, without exposing backend
 * materialization mechanics.
 */
export interface UpcomingMeeting {
  /**
   * Stable row identity: `meeting:<id>` when backed by a concrete Meeting
   * (one-time or materialized), `occurrence:<occurrenceId>` for a virtual
   * occurrence. A total-order key — safe as a React key and a sort
   * tie-breaker.
   */
  id: string
  title: string
  /**
   * Effective scheduled start (timezone-aware ISO-8601) — the time this
   * occurrence actually takes place. A rescheduled occurrence appears ONLY
   * here; the original slot is not additionally emitted.
   */
  scheduledAt: string
  /**
   * Concrete Meeting id when this row opens a Meeting (one-time or
   * materialized); null for a virtual occurrence (never fabricated).
   */
  meetingId: number | null
  /**
   * Concrete Meeting lifecycle status when this row is backed by a
   * concrete Meeting (one-time or materialized); null for a virtual
   * occurrence (the feed carries no Meeting state). Presentation uses
   * it only for the `live` → "In progress" badge.
   */
  status: ApiMeetingStatus | null
  /**
   * Owning recurrence id when this row is a recurring occurrence; null for a
   * one-time concrete Meeting.
   */
  recurrenceId: number | null
  /** True when this row is a recurring occurrence (i.e. has a recurrenceId). */
  recurring: boolean
  /** Stable occurrence identity from the feed when recurring; null one-time. */
  occurrenceId: string | null
  /**
   * Immutable original scheduled start (timezone-aware ISO-8601) when known
   * and recurring — future exception metadata ("Originally Sep 29 · 10:00");
   * null for one-time rows.
   */
  originalScheduledAt: string | null
  /**
   * True when a reschedule is known (`scheduledAt` differs from
   * `originalScheduledAt`); always false for one-time rows.
   */
  rescheduled: boolean
  /** Owning Research Group id (context). */
  researchGroupId: number
  /** Owning Project id (context; null for group scope). */
  projectId: number | null
  /**
   * Participant ids available from the current contracts. Populated from the
   * concrete Meeting when it is the source; empty for virtual occurrences
   * (the feed carries no participant data) — never fabricated.
   */
  participantIds: number[]
}

/**
 * Concrete Meetings that belong in the Upcoming view: the ones that
 * have not yet taken place — status `upcoming`, plus `live` (still in
 * progress). `completed` Meetings are over and terminal `cancelled`
 * Meetings no longer take place, so neither appears in Upcoming.
 *
 * The visible date window is NOT applied here — it is applied once,
 * post-merge, by `selectUpcomingWindowRows` over the EFFECTIVE
 * displayed time of every row kind (one-time concrete, materialized
 * recurring, virtual, rescheduled), using the same window value and
 * boundary semantics as the bounded recurrence feed request
 * (`upcomingRequestWindow()`). `live` gets no unbounded exception.
 */
export function selectUpcomingConcreteMeetings(
  meetings: readonly ApiMeeting[],
): ApiMeeting[] {
  return meetings.filter(
    (meeting) =>
      meeting.status === 'upcoming' ||
      meeting.status === 'live',
  )
}

/**
 * The canonical initial Upcoming window, as produced by
 * `upcomingRequestWindow()`: `from` = local midnight of today,
 * `to` = local midnight of +42 local calendar days.
 */
export interface UpcomingWindow {
  from: string
  to: string
}

/**
 * Whether an effective scheduled start lies inside the initial
 * Upcoming window.
 *
 * Boundary semantics are the established `[from, to]` contract of
 * the bounded occurrence read: BOTH boundaries are INCLUSIVE.
 * Membership is judged on the effective displayed time only — a
 * rescheduled occurrence is judged by its moved `scheduledAt`, never
 * by `originalScheduledAt`.
 */
export function isWithinUpcomingWindow(
  scheduledAt: string,
  window: UpcomingWindow,
): boolean {
  const time = Date.parse(scheduledAt)
  const from = Date.parse(window.from)
  const to = Date.parse(window.to)

  if (
    Number.isNaN(time) ||
    Number.isNaN(from) ||
    Number.isNaN(to)
  ) {
    return false
  }

  return time >= from && time <= to
}

/**
 * The visible-window half of Upcoming selection: keep only rows whose
 * EFFECTIVE displayed `scheduledAt` lies inside the initial window
 * (local today → +42 days, inclusive boundaries).
 *
 * Applied AFTER `buildUpcomingList`, so ONE rule covers every row
 * kind: one-time concrete Meetings, materialized recurring Meetings
 * (merged rows — a far-future concrete Meeting cannot bypass the
 * window merely because it exists in the concrete Meeting endpoint,
 * and a feed occurrence cannot resurrect it), virtual occurrences,
 * and rescheduled occurrences:
 *
 *   original inside → rescheduled outside  =>  absent
 *   effective time inside the window       =>  present
 *
 * `live` rows receive no separate unbounded exception. The filter
 * preserves the deterministic input ordering.
 */
export function selectUpcomingWindowRows(
  rows: readonly UpcomingMeeting[],
  window: UpcomingWindow,
): UpcomingMeeting[] {
  return rows.filter((row) =>
    isWithinUpcomingWindow(row.scheduledAt, window),
  )
}

function parseInstant(iso: string): number {
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed
}

function isRescheduled(
  scheduledAt: string,
  originalScheduledAt: string | null,
): boolean {
  if (originalScheduledAt == null) {
    return false
  }
  const effective = Date.parse(scheduledAt)
  const original = Date.parse(originalScheduledAt)
  if (Number.isNaN(effective) || Number.isNaN(original)) {
    return false
  }
  return effective !== original
}

/**
 * Merge the concrete Meeting list and the personal recurring-occurrence feed
 * into ONE effective, deduplicated, chronological Upcoming list.
 *
 * Pure: independent of the response ordering from either endpoint and free of
 * side effects (the read path never materializes an occurrence).
 *
 * Deduplication is driven by the CANONICAL identity — a materialized feed
 * occurrence's `meetingId` joins the concrete Meeting's primary key `id`,
 * never a title/date heuristic. When a concrete Meeting backs a materialized
 * occurrence, the richer concrete representation wins and the feed's
 * recurrence metadata is retained on that single row.
 *
 * Cancellation: the feed already omits excluded/cancelled effective
 * occurrences. A concrete Meeting in the terminal `cancelled` state (which
 * no longer takes place) is dropped from the result.
 *
 * Ordering: effective `scheduledAt` ascending, with the stable row `id` as a
 * deterministic tie-breaker for identical timestamps.
 */
export function buildUpcomingList(
  concreteMeetings: readonly ApiMeeting[],
  occurrences: readonly ApiMeetingRecurrenceOccurrence[],
): UpcomingMeeting[] {
  const meetingsById = new Map<number, ApiMeeting>()
  for (const meeting of concreteMeetings) {
    meetingsById.set(meeting.id, meeting)
  }

  const rows: UpcomingMeeting[] = []
  const consumedMeetingIds = new Set<number>()

  // 1) Every feed occurrence becomes exactly one row.
  for (const occurrence of occurrences) {
    if (occurrence.materialized && occurrence.meetingId != null) {
      const meeting = meetingsById.get(occurrence.meetingId)
      if (meeting != null) {
        // A cancelled concrete Meeting no longer takes place. A cancelled
        // occurrence is absent from the effective feed by construction, so
        // this is defensive — but a cancelled Meeting is never emitted.
        if (meeting.status === 'cancelled') {
          continue
        }
        // Prefer the richer concrete Meeting; retain recurrence metadata.
        consumedMeetingIds.add(meeting.id)
        rows.push(
          recurringRowFromMeeting(meeting, {
            recurrenceId: occurrence.recurrenceId,
            occurrenceId: occurrence.occurrenceId,
            originalScheduledAt: occurrence.originalScheduledAt,
          }),
        )
        continue
      }
    }
    // A virtual occurrence (or a materialized occurrence whose concrete
    // Meeting is not in this list): a normal Upcoming item built from the
    // feed. A virtual occurrence carries no concrete Meeting id — it is never
    // fabricated.
    rows.push(rowFromOccurrence(occurrence))
  }

  // 2) Every concrete Meeting NOT consumed by a materialized occurrence is a
  //    one-time row — unless cancelled (no longer takes place).
  for (const meeting of concreteMeetings) {
    if (consumedMeetingIds.has(meeting.id)) {
      continue
    }
    if (meeting.status === 'cancelled') {
      continue
    }
    rows.push(rowFromMeeting(meeting))
  }

  return [...rows].sort((a, b) => {
    const timeA = parseInstant(a.scheduledAt)
    const timeB = parseInstant(b.scheduledAt)
    if (timeA !== timeB) {
      return timeA - timeB
    }
    // Deterministic tie-breaker, independent of input ordering.
    if (a.id < b.id) {
      return -1
    }
    if (a.id > b.id) {
      return 1
    }
    return 0
  })
}

function recurringRowFromMeeting(
  meeting: ApiMeeting,
  recurrence: {
    recurrenceId: number
    occurrenceId: string
    originalScheduledAt: string
  },
): UpcomingMeeting {
  return {
    id: `meeting:${meeting.id}`,
    title: meeting.title,
    scheduledAt: meeting.scheduledAt,
    meetingId: meeting.id,
    status: meeting.status,
    recurrenceId: recurrence.recurrenceId,
    recurring: true,
    occurrenceId: recurrence.occurrenceId,
    originalScheduledAt: recurrence.originalScheduledAt,
    rescheduled: isRescheduled(
      meeting.scheduledAt,
      recurrence.originalScheduledAt,
    ),
    researchGroupId: meeting.researchGroupId,
    projectId: meeting.projectId,
    participantIds: [...meeting.participantIds],
  }
}

function rowFromMeeting(meeting: ApiMeeting): UpcomingMeeting {
  return {
    id: `meeting:${meeting.id}`,
    title: meeting.title,
    scheduledAt: meeting.scheduledAt,
    meetingId: meeting.id,
    status: meeting.status,
    recurrenceId: null,
    recurring: false,
    occurrenceId: null,
    originalScheduledAt: null,
    rescheduled: false,
    researchGroupId: meeting.researchGroupId,
    projectId: meeting.projectId,
    participantIds: [...meeting.participantIds],
  }
}

function rowFromOccurrence(
  occurrence: ApiMeetingRecurrenceOccurrence,
): UpcomingMeeting {
  const hasMeeting =
    occurrence.materialized && occurrence.meetingId != null
  return {
    id: hasMeeting
      ? `meeting:${occurrence.meetingId}`
      : `occurrence:${occurrence.occurrenceId}`,
    title: occurrence.title,
    scheduledAt: occurrence.scheduledAt,
    meetingId: occurrence.meetingId,
    status: null,
    recurrenceId: occurrence.recurrenceId,
    recurring: true,
    occurrenceId: occurrence.occurrenceId,
    originalScheduledAt: occurrence.originalScheduledAt,
    rescheduled: isRescheduled(
      occurrence.scheduledAt,
      occurrence.originalScheduledAt,
    ),
    researchGroupId: occurrence.researchGroupId,
    projectId: occurrence.projectId,
    participantIds: [],
  }
}
