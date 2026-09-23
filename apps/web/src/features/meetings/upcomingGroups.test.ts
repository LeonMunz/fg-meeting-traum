import { describe, expect, it } from 'vitest'

import {
  formatOriginallyLabel,
  formatUpcomingTime,
  groupUpcomingByDate,
  localDateKey,
  peopleLabel,
  upcomingGroupKind,
  upcomingGroupLabel,
} from './upcomingGroups'

import type { UpcomingMeeting } from './upcomingModel'

// Fixed reference point: Wednesday, September 23, 2026, 09:00 local.
const NOW = new Date(2026, 8, 23, 9, 0)

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

function makeItem(
  overrides: Partial<UpcomingMeeting> & {
    id: string
    scheduledAt: string
  },
): UpcomingMeeting {
  return {
    title: `Item ${overrides.id}`,
    meetingId: null,
    status: null,
    recurrenceId: null,
    recurring: false,
    occurrenceId: null,
    originalScheduledAt: null,
    rescheduled: false,
    researchGroupId: 1,
    projectId: null,
    participantIds: [],
    ...overrides,
  }
}

describe('localDateKey / upcomingGroupLabel', () => {
  it('labels Today with the relative word plus the absolute date', () => {
    expect(
      upcomingGroupLabel(
        localDateKey(NOW),
        NOW,
      ),
    ).toBe('Today · Wed, Sep 23')
  })

  it('labels Tomorrow with the relative word plus the absolute date', () => {
    expect(
      upcomingGroupLabel(
        localDateKey(
          new Date(2026, 8, 24, 23, 59),
        ),
        NOW,
      ),
    ).toBe('Tomorrow · Thu, Sep 24')
  })

  it('labels later dates with the absolute date only', () => {
    expect(
      upcomingGroupLabel('2026-09-25', NOW),
    ).toBe('Fri, Sep 25')
    expect(
      upcomingGroupLabel('2026-10-01', NOW),
    ).toBe('Thu, Oct 1')
    // No relative word leaks into later groups.
    expect(
      upcomingGroupLabel('2026-09-25', NOW),
    ).not.toMatch(/Today|Tomorrow/i)
  })

  it('labels later dates as short weekday + month + day', () => {
    expect(
      upcomingGroupLabel('2026-09-24', NOW),
    ).toBe('Tomorrow · Thu, Sep 24')
    expect(
      upcomingGroupLabel('2026-09-25', NOW),
    ).toBe('Fri, Sep 25')
    expect(
      upcomingGroupLabel('2026-10-01', NOW),
    ).toBe('Thu, Oct 1')
  })

  it('is DST-safe: tomorrow is a calendar day, not +24 h', () => {
    // A reference now at 23:30 local: +24 h lands two calendar
    // days away in some zones; the helper must still say
    // "Tomorrow" for the next local date.
    const late = new Date(2026, 8, 23, 23, 30)
    expect(
      upcomingGroupLabel(
        localDateKey(new Date(2026, 8, 24, 6, 0)),
        late,
      ),
    ).toBe('Tomorrow · Thu, Sep 24')
  })
})

describe('upcomingGroupKind', () => {
  it('classifies today / tomorrow / later local dates', () => {
    expect(
      upcomingGroupKind(localDateKey(NOW), NOW),
    ).toBe('today')
    expect(
      upcomingGroupKind('2026-09-24', NOW),
    ).toBe('tomorrow')
    expect(
      upcomingGroupKind('2026-09-25', NOW),
    ).toBe('date')
  })
})

describe('groupUpcomingByDate', () => {
  it('groups by local effective date, ascending, preserving in-group order', () => {
    const items = [
      makeItem({
        id: 'a',
        title: 'Today early',
        scheduledAt: localIso(2026, 9, 23, 10, 0),
      }),
      makeItem({
        id: 'b',
        title: 'Today late',
        scheduledAt: localIso(2026, 9, 23, 11, 30),
      }),
      makeItem({
        id: 'c',
        title: 'Tomorrow',
        scheduledAt: localIso(2026, 9, 24, 9, 0),
      }),
      makeItem({
        id: 'd',
        title: 'Thursday',
        scheduledAt: localIso(2026, 9, 24, 16, 0),
      }),
      makeItem({
        id: 'e',
        title: 'Friday',
        scheduledAt: localIso(2026, 9, 25, 8, 15),
      }),
    ]

    const groups =
      groupUpcomingByDate(items, NOW)

    expect(groups.map((g) => g.date)).toEqual([
      '2026-09-23',
      '2026-09-24',
      '2026-09-25',
    ])
    // Today / Tomorrow carry relative + absolute; later groups
    // carry the absolute date only.
    expect(groups.map((g) => g.label)).toEqual([
      'Today · Wed, Sep 23',
      'Tomorrow · Thu, Sep 24',
      'Fri, Sep 25',
    ])
    expect(groups.map((g) => g.kind)).toEqual([
      'today',
      'tomorrow',
      'date',
    ])

    // Items keep their input (ascending) order inside the group.
    expect(
      groups[0]
        .items.map((item) => item.title),
    ).toEqual(['Today early', 'Today late'])
    expect(
      groups[1]
        .items.map((item) => item.title),
    ).toEqual(['Tomorrow', 'Thursday'])
  })

  it('is independent of input order for group sorting', () => {
    const friday = makeItem({
      id: 'f',
      scheduledAt: localIso(2026, 9, 25, 9, 0),
    })
    const today = makeItem({
      id: 't',
      scheduledAt: localIso(2026, 9, 23, 9, 0),
    })

    const groups =
      groupUpcomingByDate([friday, today], NOW)

    expect(groups.map((g) => g.date)).toEqual([
      '2026-09-23',
      '2026-09-25',
    ])
  })

  it('groups a rescheduled occurrence by its EFFECTIVE time only', () => {
    const rescheduled = makeItem({
      id: 'r',
      title: 'Rescheduled sync',
      scheduledAt: localIso(2026, 9, 25, 9, 30),
      recurring: true,
      recurrenceId: 10,
      occurrenceId: 'occ-r',
      originalScheduledAt: localIso(2026, 9, 29, 10, 0),
      rescheduled: true,
    })

    const groups =
      groupUpcomingByDate([rescheduled], NOW)

    // The original Sep 29 slot must not produce a group.
    expect(groups.map((g) => g.date)).toEqual([
      '2026-09-25',
    ])
  })

  it('returns no groups for an empty list', () => {
    expect(groupUpcomingByDate([], NOW)).toEqual([])
  })

  it('uses the local calendar date, not the UTC date', () => {
    // 01:30 UTC on Sep 24 is still Sep 23 in UTC-minus zones;
    // the group key must follow the LOCAL date of the fixed NOW.
    const item = makeItem({
      id: 'x',
      scheduledAt:
        '2026-09-24T01:30:00Z',
    })

    const groups =
      groupUpcomingByDate([item], NOW)

    // In every UTC-offset zone, the local date of this instant is
    // Sep 23 (offset ≤ +1 day) or Sep 24 (offset ≥ 0); either way it
    // must equal the helper's own local date of the instant.
    expect(groups).toHaveLength(1)
    expect(groups[0].date).toBe(
      localDateKey(new Date('2026-09-24T01:30:00Z')),
    )
  })
})

describe('row cell formatters', () => {
  it('formats the Time cell as a compact 24 h clock time', () => {
    expect(
      formatUpcomingTime(localIso(2026, 9, 23, 10, 0)),
    ).toBe('10:00')
    expect(
      formatUpcomingTime(localIso(2026, 9, 23, 9, 5)),
    ).toBe('09:05')
  })

  it('falls back to the raw value for an unparseable instant', () => {
    expect(
      formatUpcomingTime('not-a-date'),
    ).toBe('not-a-date')
  })

  it('formats the reschedule metadata line', () => {
    expect(
      formatOriginallyLabel(
        localIso(2026, 9, 29, 10, 0),
      ),
    ).toBe('Originally Sep 29 · 10:00')
  })

  it('formats people counts', () => {
    expect(peopleLabel(1)).toBe('1 person')
    expect(peopleLabel(6)).toBe('6 people')
  })
})
