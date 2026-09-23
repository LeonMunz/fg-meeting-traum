import { describe, expect, it } from 'vitest'

import {
  buildUpcomingList,
  upcomingRequestWindow,
  UPCOMING_WINDOW_DAYS,
} from './upcomingModel'

import type { UpcomingMeeting } from './upcomingModel'

import type {
  ApiMeeting,
  ApiMeetingRecurrenceOccurrence,
} from '../../api/types'

const DAY_MS = 86_400_000

function makeMeeting(
  overrides: Partial<ApiMeeting> & { id: number },
): ApiMeeting {
  return {
    researchGroupId: 1,
    scope: 'group',
    projectId: null,
    seriesId: null,
    title: `Meeting ${overrides.id}`,
    scheduledAt: '2026-09-23T09:00:00Z',
    startedAt: null,
    endedAt: null,
    status: 'upcoming',
    currentMeetingItemId: null,
    participantIds: [],
    createdById: 1,
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-01T08:00:00Z',
    ...overrides,
  }
}

function makeOccurrence(
  overrides: Partial<ApiMeetingRecurrenceOccurrence> & {
    occurrenceId: string
  },
): ApiMeetingRecurrenceOccurrence {
  return {
    recurrenceId: 10,
    title: `Occurrence ${overrides.occurrenceId}`,
    originalScheduledAt: '2026-09-23T09:00:00Z',
    scheduledAt: '2026-09-23T09:00:00Z',
    materialized: false,
    meetingId: null,
    meetingSeriesId: null,
    researchGroupId: 1,
    projectId: null,
    ...overrides,
  }
}

function idSequence(rows: readonly UpcomingMeeting[]): string[] {
  return rows.map((row) => row.id)
}

describe('buildUpcomingList — merging concrete Meetings and the recurrence feed', () => {
  it('shows a one-time concrete Meeting as a non-recurring row', () => {
    const meeting = makeMeeting({
      id: 7,
      title: 'One-off sync',
      scheduledAt: '2026-09-24T10:00:00Z',
      participantIds: [2, 3],
    })

    const rows = buildUpcomingList([meeting], [])

    expect(rows).toEqual([
      expect.objectContaining({
        id: 'meeting:7',
        title: 'One-off sync',
        scheduledAt: '2026-09-24T10:00:00Z',
        meetingId: 7,
        recurring: false,
        recurrenceId: null,
        occurrenceId: null,
        originalScheduledAt: null,
        rescheduled: false,
        participantIds: [2, 3],
      }),
    ])
  })

  it('shows a virtual recurring occurrence as a normal row', () => {
    const occ = makeOccurrence({
      occurrenceId: 'v1',
      recurrenceId: 10,
      title: 'Weekly Sync',
      scheduledAt: '2026-09-29T10:00:00Z',
      originalScheduledAt: '2026-09-29T10:00:00Z',
      materialized: false,
      meetingId: null,
    })

    const rows = buildUpcomingList([], [occ])

    expect(rows).toEqual([
      expect.objectContaining({
        id: 'occurrence:v1',
        title: 'Weekly Sync',
        scheduledAt: '2026-09-29T10:00:00Z',
        recurring: true,
        recurrenceId: 10,
        occurrenceId: 'v1',
      }),
    ])
  })

  it('merges one-time and recurring entries chronologically', () => {
    const laterMeeting = makeMeeting({
      id: 1,
      scheduledAt: '2026-10-05T09:00:00Z',
    })
    const earlierOcc = makeOccurrence({
      occurrenceId: 'e1',
      scheduledAt: '2026-09-25T09:00:00Z',
      originalScheduledAt: '2026-09-25T09:00:00Z',
    })
    const middleMeeting = makeMeeting({
      id: 2,
      scheduledAt: '2026-09-30T09:00:00Z',
    })
    const middleOcc = makeOccurrence({
      occurrenceId: 'm1',
      scheduledAt: '2026-09-28T09:00:00Z',
      originalScheduledAt: '2026-09-28T09:00:00Z',
    })

    const rows = buildUpcomingList(
      [laterMeeting, middleMeeting],
      [middleOcc, earlierOcc],
    )

    expect(idSequence(rows)).toEqual([
      'occurrence:e1',
      'occurrence:m1',
      'meeting:2',
      'meeting:1',
    ])
  })

  it('shows a materialized recurring occurrence exactly once, not twice', () => {
    const meeting = makeMeeting({
      id: 5,
      title: 'Weekly Sync',
      scheduledAt: '2026-09-29T10:00:00Z',
    })
    const occ = makeOccurrence({
      occurrenceId: 'mat1',
      recurrenceId: 10,
      title: 'Weekly Sync',
      scheduledAt: '2026-09-29T10:00:00Z',
      originalScheduledAt: '2026-09-29T10:00:00Z',
      materialized: true,
      meetingId: 5,
    })

    const rows = buildUpcomingList([meeting], [occ])

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      meetingId: 5,
      recurring: true,
      recurrenceId: 10,
      occurrenceId: 'mat1',
    })
  })

  it('deduplicates by canonical Meeting identity, not title or date', () => {
    // Two concrete Meetings share the same title AND time but differ by id.
    const standupA = makeMeeting({
      id: 1,
      title: 'Standup',
      scheduledAt: '2026-09-23T09:00:00Z',
    })
    const standupB = makeMeeting({
      id: 2,
      title: 'Standup',
      scheduledAt: '2026-09-23T09:00:00Z',
    })
    // Only meeting 1 is the materialization of this occurrence.
    const occ = makeOccurrence({
      occurrenceId: 'dedup1',
      recurrenceId: 10,
      title: 'Standup',
      scheduledAt: '2026-09-23T09:00:00Z',
      originalScheduledAt: '2026-09-23T09:00:00Z',
      materialized: true,
      meetingId: 1,
    })

    const rows = buildUpcomingList([standupA, standupB], [occ])

    // Exactly two rows: the occurrence collapses into meeting 1 (recurring),
    // and meeting 2 stays a distinct one-time row despite the identical
    // title/time — proving identity, not a title/date heuristic, drives it.
    expect(rows).toHaveLength(2)
    const rowFor1 = rows.find((row) => row.meetingId === 1)
    const rowFor2 = rows.find((row) => row.meetingId === 2)
    expect(rowFor1).toMatchObject({ recurring: true, recurrenceId: 10 })
    expect(rowFor2).toMatchObject({ recurring: false, recurrenceId: null })
  })

  it('retains recurring metadata on the deduplicated row', () => {
    const meeting = makeMeeting({
      id: 5,
      title: 'Renamed after materialization',
      scheduledAt: '2026-09-29T10:00:00Z',
      participantIds: [9],
    })
    const occ = makeOccurrence({
      occurrenceId: 'keep1',
      recurrenceId: 10,
      title: 'Weekly Sync',
      scheduledAt: '2026-09-29T10:00:00Z',
      originalScheduledAt: '2026-09-29T10:00:00Z',
      materialized: true,
      meetingId: 5,
    })

    const rows = buildUpcomingList([meeting], [occ])

    // The richer concrete representation wins (title/participants) while the
    // recurrence metadata required by the UI survives.
    expect(rows[0]).toMatchObject({
      meetingId: 5,
      title: 'Renamed after materialization',
      participantIds: [9],
      recurring: true,
      recurrenceId: 10,
      occurrenceId: 'keep1',
      originalScheduledAt: '2026-09-29T10:00:00Z',
    })
  })

  it('never fabricates a Meeting id for a virtual occurrence', () => {
    const occ = makeOccurrence({
      occurrenceId: 'virt-only',
      scheduledAt: '2026-09-29T10:00:00Z',
      originalScheduledAt: '2026-09-29T10:00:00Z',
      materialized: false,
      meetingId: null,
    })

    const rows = buildUpcomingList([], [occ])

    expect(rows).toHaveLength(1)
    expect(rows[0].meetingId).toBeNull()
    expect(rows[0].id).toBe('occurrence:virt-only')
    expect(rows[0].participantIds).toEqual([])
  })

  it('shows a rescheduled occurrence only at its effective time', () => {
    const meeting = makeMeeting({
      id: 5,
      scheduledAt: '2026-09-30T14:00:00Z',
    })
    const occ = makeOccurrence({
      occurrenceId: 'resched1',
      scheduledAt: '2026-09-30T14:00:00Z',
      originalScheduledAt: '2026-09-29T10:00:00Z',
      materialized: true,
      meetingId: 5,
    })

    const rows = buildUpcomingList([meeting], [occ])

    expect(rows).toHaveLength(1)
    expect(rows[0].scheduledAt).toBe('2026-09-30T14:00:00Z')
    // The original slot is NOT additionally emitted.
    expect(rows[0].scheduledAt).not.toBe('2026-09-29T10:00:00Z')
  })

  it('retains the original scheduled time as metadata for a reschedule', () => {
    const meeting = makeMeeting({
      id: 5,
      scheduledAt: '2026-09-30T14:00:00Z',
    })
    const occ = makeOccurrence({
      occurrenceId: 'resched2',
      scheduledAt: '2026-09-30T14:00:00Z',
      originalScheduledAt: '2026-09-29T10:00:00Z',
      materialized: true,
      meetingId: 5,
    })

    const rows = buildUpcomingList([meeting], [occ])

    expect(rows[0].originalScheduledAt).toBe('2026-09-29T10:00:00Z')
    expect(rows[0].rescheduled).toBe(true)
  })

  it('does not surface a cancelled/excluded occurrence the feed omits', () => {
    // The backend feed already omits the excluded occurrence; the merge must
    // not invent it back. Only the surviving sibling is in the input.
    const surviving = makeOccurrence({
      occurrenceId: 'survives',
      scheduledAt: '2026-09-29T10:00:00Z',
      originalScheduledAt: '2026-09-29T10:00:00Z',
    })

    const rows = buildUpcomingList([], [surviving])

    expect(rows.map((row) => row.occurrenceId)).toEqual(['survives'])
    expect(
      rows.some((row) => row.occurrenceId === 'excluded-cancels'),
    ).toBe(false)
  })

  it('drops a cancelled concrete Meeting from Upcoming', () => {
    const cancelled = makeMeeting({
      id: 8,
      title: 'Cancelled occurrence',
      status: 'cancelled',
      scheduledAt: '2026-09-29T10:00:00Z',
    })
    const upcoming = makeMeeting({
      id: 9,
      status: 'upcoming',
      scheduledAt: '2026-09-30T10:00:00Z',
    })

    const rows = buildUpcomingList([cancelled, upcoming], [])

    expect(rows.map((row) => row.meetingId)).toEqual([9])
    expect(rows.some((row) => row.meetingId === 8)).toBe(false)
  })
})

describe('buildUpcomingList — ordering and determinism', () => {
  it('sorts identical timestamps deterministically by stable id', () => {
    const meetingB = makeMeeting({
      id: 2,
      scheduledAt: '2026-09-23T09:00:00Z',
    })
    const meetingA = makeMeeting({
      id: 1,
      scheduledAt: '2026-09-23T09:00:00Z',
    })
    const occAtSameTime = makeOccurrence({
      occurrenceId: 'zzz',
      scheduledAt: '2026-09-23T09:00:00Z',
      originalScheduledAt: '2026-09-23T09:00:00Z',
    })

    const rows = buildUpcomingList([meetingB, meetingA], [occAtSameTime])

    // All three share a timestamp: order is by the stable row id.
    // 'meeting:1' < 'meeting:2' < 'occurrence:zzz' lexicographically.
    expect(idSequence(rows)).toEqual([
      'meeting:1',
      'meeting:2',
      'occurrence:zzz',
    ])
  })

  it('is independent of the response ordering from either endpoint', () => {
    const meetings = [
      makeMeeting({ id: 1, scheduledAt: '2026-09-24T09:00:00Z' }),
      makeMeeting({ id: 2, scheduledAt: '2026-09-26T09:00:00Z' }),
      makeMeeting({ id: 3, scheduledAt: '2026-09-25T09:00:00Z' }),
    ]
    const occurrences = [
      makeOccurrence({
        occurrenceId: 'o1',
        scheduledAt: '2026-09-27T09:00:00Z',
        originalScheduledAt: '2026-09-27T09:00:00Z',
      }),
      makeOccurrence({
        occurrenceId: 'o2',
        scheduledAt: '2026-09-23T09:00:00Z',
        originalScheduledAt: '2026-09-23T09:00:00Z',
      }),
    ]

    const forward = buildUpcomingList(meetings, occurrences)
    const reversed = buildUpcomingList(
      [...meetings].reverse(),
      [...occurrences].reverse(),
    )
    const shuffledMeetings = [meetings[2], meetings[0], meetings[1]]
    const shuffledOccs = [occurrences[1], occurrences[0]]
    const shuffled = buildUpcomingList(shuffledMeetings, shuffledOccs)

    expect(idSequence(reversed)).toEqual(idSequence(forward))
    expect(idSequence(shuffled)).toEqual(idSequence(forward))
    expect(forward).toEqual(reversed)
  })

  it('works with an empty concrete Meeting list', () => {
    const occA = makeOccurrence({
      occurrenceId: 'a',
      scheduledAt: '2026-09-26T09:00:00Z',
      originalScheduledAt: '2026-09-26T09:00:00Z',
    })
    const occB = makeOccurrence({
      occurrenceId: 'b',
      scheduledAt: '2026-09-24T09:00:00Z',
      originalScheduledAt: '2026-09-24T09:00:00Z',
    })

    const rows = buildUpcomingList([], [occA, occB])

    expect(idSequence(rows)).toEqual(['occurrence:b', 'occurrence:a'])
  })

  it('works with an empty recurrence feed', () => {
    const m2 = makeMeeting({ id: 2, scheduledAt: '2026-09-26T09:00:00Z' })
    const m1 = makeMeeting({ id: 1, scheduledAt: '2026-09-24T09:00:00Z' })

    const rows = buildUpcomingList([m2, m1], [])

    expect(idSequence(rows)).toEqual(['meeting:1', 'meeting:2'])
  })

  it('returns an empty list when both inputs are empty', () => {
    expect(buildUpcomingList([], [])).toEqual([])
  })

  it('keeps a materialized occurrence whose Meeting is outside the concrete list', () => {
    // A materialized occurrence whose concrete Meeting is not in this list
    // (e.g. a different scope) still appears — it is materialized, so it is
    // not cancelled — using its own meetingId for openability.
    const occ = makeOccurrence({
      occurrenceId: 'outside',
      title: 'Materialized elsewhere',
      scheduledAt: '2026-09-29T10:00:00Z',
      originalScheduledAt: '2026-09-29T10:00:00Z',
      materialized: true,
      meetingId: 77,
    })

    const rows = buildUpcomingList([], [occ])

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'meeting:77',
      meetingId: 77,
      recurring: true,
      recurrenceId: 10,
      occurrenceId: 'outside',
      participantIds: [],
    })
  })
})

describe('upcomingRequestWindow — the initial 42-day request window', () => {
  it('spans exactly 42 days from the start of today', () => {
    const now = new Date(2026, 8, 23, 15, 30, 0) // local 2026-09-23 15:30
    const window = upcomingRequestWindow(now)

    expect(UPCOMING_WINDOW_DAYS).toBe(42)

    const from = new Date(window.from)
    const to = new Date(window.to)

    // Both boundaries are local midnights.
    for (const boundary of [from, to]) {
      expect(boundary.getHours()).toBe(0)
      expect(boundary.getMinutes()).toBe(0)
      expect(boundary.getSeconds()).toBe(0)
      expect(boundary.getMilliseconds()).toBe(0)
    }

    // `from` anchors the start of `now`'s local calendar day (not `now`).
    expect(
      new Date(
        from.getFullYear(),
        from.getMonth(),
        from.getDate(),
      ).toISOString(),
    ).toBe(new Date(2026, 8, 23).toISOString())

    // The span is EXACTLY 42 local calendar days (DST-safe via rounding).
    const fromLocalMs = new Date(
      from.getFullYear(),
      from.getMonth(),
      from.getDate(),
    ).getTime()
    const toLocalMs = new Date(
      to.getFullYear(),
      to.getMonth(),
      to.getDate(),
    ).getTime()
    expect(Math.round((toLocalMs - fromLocalMs) / DAY_MS)).toBe(42)
  })

  it('pins the timezone boundary: local-midnight-anchored calendar days', () => {
    const now = new Date(2026, 8, 23, 23, 59, 59) // local 2026-09-23 23:59:59
    const window = upcomingRequestWindow(now)

    // `from` is local midnight of 2026-09-23; `to` is local midnight of
    // 2026-09-23 + 42 days = 2026-11-04. Constructed locally, so the
    // assertion is independent of the runner's timezone.
    expect(window.from).toBe(new Date(2026, 8, 23).toISOString())
    expect(window.to).toBe(new Date(2026, 8, 65).toISOString())
    expect(new Date(window.to).getDate()).toBe(4)
    expect(new Date(window.to).getMonth()).toBe(10) // November
    expect(new Date(window.to).getFullYear()).toBe(2026)
  })

  it('anchors at month and year rollover', () => {
    const now = new Date(2026, 11, 30, 12, 0, 0) // local 2026-12-30
    const window = upcomingRequestWindow(now)

    expect(window.from).toBe(new Date(2026, 11, 30).toISOString())
    // 2026-12-30 + 42 days = 2027-02-10.
    expect(window.to).toBe(new Date(2026, 11, 72).toISOString())
    expect(new Date(window.to).getFullYear()).toBe(2027)
  })
})
