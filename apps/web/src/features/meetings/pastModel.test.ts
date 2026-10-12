import { describe, expect, it } from 'vitest'

import {
  groupPastByDate,
  pastGroupLabel,
  selectPastMeetings,
} from './pastModel'

import type { ApiMeeting } from '../../api/types'

function localIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string {
  return new Date(
    year,
    month - 1,
    day,
    hour,
    minute,
  ).toISOString()
}

function makeMeeting(
  overrides: Partial<ApiMeeting> & { id: number },
): ApiMeeting {
  return {
    researchGroupId: 1,
    scope: 'group',
    projectId: null,
    seriesId: null,
    title: `Meeting ${overrides.id}`,
    scheduledAt: localIso(2026, 9, 23, 10, 0),
    startedAt: null,
    endedAt: null,
    status: 'upcoming',
    currentMeetingItemId: null,
    participantIds: [],
    actionPermissions: {
      canEdit: true,
      canDelete: true,
      canCancel: false,
    },
    createdById: 1,
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-01T08:00:00Z',
    ...overrides,
  }
}

describe('selectPastMeetings', () => {
  it('selects exactly the Meetings whose status is completed', () => {
    const rows = selectPastMeetings([
      makeMeeting({
        id: 1,
        title: 'Completed one-time',
        status: 'completed',
      }),
      makeMeeting({
        id: 2,
        title: 'Still upcoming',
        status: 'upcoming',
      }),
      makeMeeting({
        id: 3,
        title: 'In progress',
        status: 'live',
      }),
      makeMeeting({
        id: 4,
        title: 'Cancelled',
        status: 'cancelled',
      }),
    ])

    expect(
      rows.map((row) => row.id),
    ).toEqual([1])
  })

  it('includes completed one-time, Template-created, and materialized recurring Meetings alike', () => {
    const rows = selectPastMeetings([
      makeMeeting({
        id: 1,
        title: 'One-time',
        status: 'completed',
      }),
      makeMeeting({
        id: 2,
        title: 'From template',
        seriesId: 7,
        status: 'completed',
      }),
      makeMeeting({
        id: 3,
        title: 'Materialized recurring',
        seriesId: 7,
        status: 'completed',
      }),
    ])

    // Every concrete completed Meeting is Past exactly once — the
    // selector never generates or deduplicates against anything.
    expect(rows).toHaveLength(3)
    expect(
      rows.map((row) => row.title),
    ).toEqual([
      'One-time',
      'From template',
      'Materialized recurring',
    ])
  })

  it('never qualifies a Meeting by elapsed scheduled time alone', () => {
    const rows = selectPastMeetings([
      // Scheduled YESTERDAY but never started: still `upcoming` —
      // elapsed time is not completion.
      makeMeeting({
        id: 1,
        title: 'Overdue but upcoming',
        scheduledAt: localIso(2026, 9, 22, 10, 0),
        status: 'upcoming',
      }),
      makeMeeting({
        id: 2,
        title: 'Overdue but live',
        scheduledAt: localIso(2026, 9, 22, 9, 0),
        status: 'live',
      }),
      makeMeeting({
        id: 3,
        title: 'Overdue but cancelled',
        scheduledAt: localIso(2026, 9, 22, 8, 0),
        status: 'cancelled',
      }),
    ])

    expect(rows).toEqual([])
  })

  it('applies no history cutoff: far-past completed Meetings stay visible', () => {
    const rows = selectPastMeetings([
      makeMeeting({
        id: 1,
        title: 'Inside the 42-day window',
        scheduledAt: localIso(2026, 9, 20, 10, 0),
        status: 'completed',
      }),
      makeMeeting({
        id: 2,
        title: 'Years ago',
        scheduledAt: localIso(2023, 3, 7, 10, 0),
        status: 'completed',
      }),
    ])

    expect(
      rows.map((row) => row.title),
    ).toEqual(['Inside the 42-day window', 'Years ago'])
  })

  it('orders by scheduledAt descending with a deterministic id tie-breaker', () => {
    const rows = selectPastMeetings([
      makeMeeting({
        id: 9,
        title: 'Old',
        scheduledAt: localIso(2025, 11, 14, 10, 0),
        status: 'completed',
      }),
      makeMeeting({
        id: 1,
        title: 'Same instant, lower id',
        scheduledAt: localIso(2026, 9, 20, 15, 0),
        status: 'completed',
      }),
      makeMeeting({
        id: 2,
        title: 'Newest',
        scheduledAt: localIso(2026, 9, 21, 9, 0),
        status: 'completed',
      }),
      makeMeeting({
        id: 5,
        title: 'Same instant, higher id',
        scheduledAt: localIso(2026, 9, 20, 15, 0),
        status: 'completed',
      }),
    ])

    expect(
      rows.map((row) => row.title),
    ).toEqual([
      'Newest',
      'Same instant, lower id',
      'Same instant, higher id',
      'Old',
    ])
  })

  it('is independent of the response ordering', () => {
    const first = [
      makeMeeting({
        id: 1,
        scheduledAt: localIso(2025, 1, 5, 9, 0),
        status: 'completed',
      }),
      makeMeeting({
        id: 2,
        scheduledAt: localIso(2026, 2, 5, 9, 0),
        status: 'completed',
      }),
      makeMeeting({
        id: 3,
        scheduledAt: localIso(2026, 8, 5, 9, 0),
        status: 'completed',
      }),
    ]

    const a = selectPastMeetings(first).map(
      (row) => row.id,
    )
    const b = selectPastMeetings([...first].reverse()).map(
      (row) => row.id,
    )

    expect(a).toEqual([3, 2, 1])
    expect(b).toEqual(a)
  })

  it('carries the participant count from the concrete Meeting', () => {
    const rows = selectPastMeetings([
      makeMeeting({
        id: 1,
        participantIds: [1, 2],
        status: 'completed',
      }),
      makeMeeting({
        id: 2,
        status: 'completed',
      }),
    ])

    expect(
      rows.map((row) => row.participantCount),
    ).toEqual([2, 0])
  })
})

describe('pastGroupLabel', () => {
  it('labels a local calendar date unambiguously, including the year', () => {
    // 2026-09-20 is a Sunday; the label must carry weekday,
    // short month, day, and the explicit year.
    expect(pastGroupLabel('2026-09-20')).toBe(
      'Sun, Sep 20, 2026',
    )
    expect(pastGroupLabel('2025-11-14')).toBe(
      'Fri, Nov 14, 2025',
    )
  })

  it('never invents a label for malformed dates', () => {
    expect(pastGroupLabel('2026-13-40')).toBe('2026-13-40')
  })
})

describe('groupPastByDate', () => {
  it('groups by LOCAL calendar date, descending', () => {
    const groups = groupPastByDate(
      selectPastMeetings([
        makeMeeting({
          id: 1,
          scheduledAt: localIso(2025, 11, 14, 10, 0),
          status: 'completed',
        }),
        makeMeeting({
          id: 2,
          // Late in the local day: still the 20th locally.
          scheduledAt: localIso(2026, 9, 20, 23, 30),
          status: 'completed',
        }),
        makeMeeting({
          id: 3,
          scheduledAt: localIso(2026, 9, 20, 9, 0),
          status: 'completed',
        }),
        makeMeeting({
          id: 4,
          scheduledAt: localIso(2026, 9, 21, 8, 0),
          status: 'completed',
        }),
      ]),
    )

    expect(
      groups.map((group) => group.date),
    ).toEqual([
      '2026-09-21',
      '2026-09-20',
      '2025-11-14',
    ])
    expect(
      groups.map((group) => group.label),
    ).toEqual([
      'Mon, Sep 21, 2026',
      'Sun, Sep 20, 2026',
      'Fri, Nov 14, 2025',
    ])
    expect(
      groups[1].items.map((item) => item.id),
    ).toEqual([2, 3])
    expect(groups[0].items).toHaveLength(1)
  })

  it('produces one group per date across years, most recent first', () => {
    const groups = groupPastByDate(
      selectPastMeetings([
        makeMeeting({
          id: 1,
          scheduledAt: localIso(2024, 1, 1, 10, 0),
          status: 'completed',
        }),
        makeMeeting({
          id: 2,
          scheduledAt: localIso(2026, 1, 1, 10, 0),
          status: 'completed',
        }),
        makeMeeting({
          id: 3,
          scheduledAt: localIso(2025, 12, 31, 23, 0),
          status: 'completed',
        }),
      ]),
    )

    expect(
      groups.map((group) => group.date),
    ).toEqual([
      '2026-01-01',
      '2025-12-31',
      '2024-01-01',
    ])
    expect(
      groups.map((group) => group.label),
    ).toEqual([
      'Thu, Jan 1, 2026',
      'Wed, Dec 31, 2025',
      'Mon, Jan 1, 2024',
    ])
  })

  it('returns no groups for an empty selection', () => {
    expect(groupPastByDate([])).toEqual([])
  })
})
