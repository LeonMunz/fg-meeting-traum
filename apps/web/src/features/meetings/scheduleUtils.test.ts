import { describe, expect, it } from 'vitest'

import {
  browserLocale,
  firstDayOfWeek,
  formatDatePartLocale,
  formatCalendarDayLabel,
  formatCalendarMonthLabel,
  formatTimePartLocale,
  isValidDatePart,
  isValidTimePart,
  localDatePart,
  localScheduledAtIso,
  nextHalfHourBoundary,
  parseManualTime,
  timeSuggestions,
  weekdayHeaderLabels,
} from './scheduleUtils'

describe('localDatePart', () => {
  it('formats a local date as canonical YYYY-MM-DD', () => {
    expect(localDatePart(new Date(2026, 8, 22))).toBe('2026-09-22')
    expect(localDatePart(new Date(2030, 0, 2))).toBe('2030-01-02')
  })
})

describe('isValidDatePart', () => {
  it('accepts canonical dates that name a real calendar date', () => {
    expect(isValidDatePart('2026-09-22')).toBe(true)
    expect(isValidDatePart('2030-01-02')).toBe(true)
    expect(isValidDatePart('2024-02-29')).toBe(true)
  })

  it('rejects malformed and impossible dates without silent substitution', () => {
    expect(isValidDatePart('2026-02-31')).toBe(false)
    expect(isValidDatePart('2026-13-01')).toBe(false)
    expect(isValidDatePart('2026-00-10')).toBe(false)
    expect(isValidDatePart('2026-9-22')).toBe(false)
    expect(isValidDatePart('2026-09-2')).toBe(false)
    expect(isValidDatePart('22.09.2026')).toBe(false)
    expect(isValidDatePart('')).toBe(false)
    expect(isValidDatePart('2026-09-22T10:00')).toBe(false)
  })
})

describe('isValidTimePart', () => {
  it('accepts canonical 24-hour zero-padded times', () => {
    expect(isValidTimePart('00:00')).toBe(true)
    expect(isValidTimePart('08:15')).toBe(true)
    expect(isValidTimePart('13:47')).toBe(true)
    expect(isValidTimePart('23:59')).toBe(true)
  })

  it('rejects out-of-range or non-canonical times', () => {
    expect(isValidTimePart('24:00')).toBe(false)
    expect(isValidTimePart('13:60')).toBe(false)
    expect(isValidTimePart('9:30')).toBe(false)
    expect(isValidTimePart('13.47')).toBe(false)
    expect(isValidTimePart('')).toBe(false)
  })
})

describe('nextHalfHourBoundary', () => {
  it('rounds up to the next 30-minute boundary on the same day', () => {
    expect(nextHalfHourBoundary(new Date(2026, 8, 22, 20, 22))).toEqual({
      datePart: '2026-09-22',
      timePart: '20:30',
    })
    expect(nextHalfHourBoundary(new Date(2026, 8, 22, 20, 41))).toEqual({
      datePart: '2026-09-22',
      timePart: '21:00',
    })
    expect(nextHalfHourBoundary(new Date(2026, 8, 22, 0, 1))).toEqual({
      datePart: '2026-09-22',
      timePart: '00:30',
    })
  })

  it('advances to the following boundary when exactly on one', () => {
    expect(nextHalfHourBoundary(new Date(2026, 8, 22, 20, 30, 0))).toEqual({
      datePart: '2026-09-22',
      timePart: '21:00',
    })
    expect(nextHalfHourBoundary(new Date(2026, 8, 22, 0, 0, 0))).toEqual({
      datePart: '2026-09-22',
      timePart: '00:30',
    })
  })

  it('rolls over midnight (and month/year boundaries) correctly', () => {
    expect(nextHalfHourBoundary(new Date(2026, 8, 22, 23, 51))).toEqual({
      datePart: '2026-09-23',
      timePart: '00:00',
    })
    expect(nextHalfHourBoundary(new Date(2026, 8, 22, 23, 30, 0))).toEqual({
      datePart: '2026-09-23',
      timePart: '00:00',
    })
    expect(nextHalfHourBoundary(new Date(2026, 8, 30, 23, 59))).toEqual({
      datePart: '2026-10-01',
      timePart: '00:00',
    })
    expect(nextHalfHourBoundary(new Date(2025, 11, 31, 23, 51))).toEqual({
      datePart: '2026-01-01',
      timePart: '00:00',
    })
  })

  it('crosses Monday/Sunday boundaries without shifting the weekday', () => {
    // 2026-09-27 is a Sunday; 2026-09-28 is a Monday.
    const result = nextHalfHourBoundary(new Date(2026, 8, 27, 23, 55))
    expect(result).toEqual({ datePart: '2026-09-28', timePart: '00:00' })
    expect(new Date(2026, 8, 28).getDay()).toBe(1)
  })
})

describe('localScheduledAtIso', () => {
  it('produces the SAME semantic instant as the legacy combined control', () => {
    // The old flow built `new Date('YYYY-MM-DDTHH:MM')` (local parse) and
    // serialized it. Both constructions must agree exactly.
    expect(localScheduledAtIso('2030-01-02', '10:30')).toBe(
      new Date('2030-01-02T10:30').toISOString(),
    )
    expect(localScheduledAtIso('2030-04-01', '13:47')).toBe(
      new Date('2030-04-01T13:47').toISOString(),
    )
    expect(localScheduledAtIso('2031-01-20', '00:00')).toBe(
      new Date('2031-01-20T00:00').toISOString(),
    )
  })

  it('interprets the parts as local wall-clock time', () => {
    const iso = localScheduledAtIso('2030-01-02', '10:30')
    expect(iso).not.toBeNull()
    const instant = new Date(iso!)
    expect(instant.getFullYear()).toBe(2030)
    expect(instant.getMonth()).toBe(0)
    expect(instant.getDate()).toBe(2)
    expect(instant.getHours()).toBe(10)
    expect(instant.getMinutes()).toBe(30)
  })

  it('returns null for malformed parts instead of guessing', () => {
    expect(localScheduledAtIso('2026-02-31', '10:30')).toBeNull()
    expect(localScheduledAtIso('2030-01-02', '25:00')).toBeNull()
    expect(localScheduledAtIso('', '10:30')).toBeNull()
    expect(localScheduledAtIso('2030-01-02', '')).toBeNull()
  })
})

describe('parseManualTime', () => {
  it('accepts 24-hour entry (including non-30-minute times)', () => {
    expect(parseManualTime('13:47')).toBe('13:47')
    expect(parseManualTime('08:15')).toBe('08:15')
    expect(parseManualTime('9:30')).toBe('09:30')
    expect(parseManualTime('21:30')).toBe('21:30')
    expect(parseManualTime('0:05')).toBe('00:05')
  })

  it('accepts 12-hour AM/PM entry and normalizes to canonical form', () => {
    expect(parseManualTime('9:30 PM')).toBe('21:30')
    expect(parseManualTime('9:30 pm')).toBe('21:30')
    expect(parseManualTime('1:47 AM')).toBe('01:47')
    expect(parseManualTime('12:00 AM')).toBe('00:00')
    expect(parseManualTime('12:30 PM')).toBe('12:30')
  })

  it('rejects contradictory, out-of-range, or unparseable text', () => {
    expect(parseManualTime('21:30 PM')).toBeNull()
    expect(parseManualTime('0:30 PM')).toBeNull()
    expect(parseManualTime('13:30 PM')).toBeNull()
    expect(parseManualTime('24:00')).toBeNull()
    expect(parseManualTime('13:60')).toBeNull()
    expect(parseManualTime('13.47')).toBeNull()
    expect(parseManualTime('tomorrow')).toBeNull()
    expect(parseManualTime('')).toBeNull()
  })
})

 // Regression anchor for the canonical same-day local time boundary:
 // 00:00 <= local time <= 23:59. `24:00` is not a same-day local time
 // value, so it (and anything later) must be rejected at every layer:
 // canonical validation, manual-entry normalization, and scheduledAt
 // construction.
 describe('same-day local time boundary (regression)', () => {
   const datePart = '2030-01-02'

   it('accepts 00:00, 13:47, and 23:59 as canonical times', () => {
     expect(isValidTimePart('00:00')).toBe(true)
     expect(isValidTimePart('13:47')).toBe(true)
     expect(isValidTimePart('23:59')).toBe(true)
   })

   it('normalizes valid 24-hour entry to the canonical form', () => {
     expect(parseManualTime('00:00')).toBe('00:00')
     expect(parseManualTime('13:47')).toBe('13:47')
     expect(parseManualTime('23:59')).toBe('23:59')
     expect(parseManualTime('0:00')).toBe('00:00')
   })

   it('builds the same-day instant for the valid boundary values', () => {
     expect(localScheduledAtIso(datePart, '00:00')).toBe(
       new Date(2030, 0, 2, 0, 0, 0, 0).toISOString(),
     )
     expect(localScheduledAtIso(datePart, '13:47')).toBe(
       new Date(2030, 0, 2, 13, 47, 0, 0).toISOString(),
     )
     expect(localScheduledAtIso(datePart, '23:59')).toBe(
       new Date(2030, 0, 2, 23, 59, 0, 0).toISOString(),
     )
   })

   it('rejects 24:00, 24:01, and 25:00 as canonical times', () => {
     expect(isValidTimePart('24:00')).toBe(false)
     expect(isValidTimePart('24:01')).toBe(false)
     expect(isValidTimePart('25:00')).toBe(false)
   })

   it('does not normalize 24:00, 24:01, or 25:00 from 24-hour entry', () => {
     expect(parseManualTime('24:00')).toBeNull()
     expect(parseManualTime('24:01')).toBeNull()
     expect(parseManualTime('25:00')).toBeNull()
   })

   it('rejects 24:00-style 12-hour entry while keeping valid 12-hour normalization', () => {
     expect(parseManualTime('24:00 PM')).toBeNull()
     expect(parseManualTime('24:00 AM')).toBeNull()
     // Preserved valid 12-hour normalization behavior.
     expect(parseManualTime('12:00 AM')).toBe('00:00')
     expect(parseManualTime('12:59 AM')).toBe('00:59')
     expect(parseManualTime('11:59 PM')).toBe('23:59')
   })

   it('produces no scheduledAt instant for 24:00, 24:01, or 25:00', () => {
     expect(localScheduledAtIso(datePart, '24:00')).toBeNull()
     expect(localScheduledAtIso(datePart, '24:01')).toBeNull()
     expect(localScheduledAtIso(datePart, '25:00')).toBeNull()
   })
 })

describe('timeSuggestions', () => {
  it('lists 30-minute convenience values anchored at the current value', () => {
    expect(timeSuggestions('20:30', new Date(2026, 8, 22, 20, 22))).toEqual([
      '20:30',
      '21:00',
      '21:30',
      '22:00',
    ])
  })

  it('anchors an off-boundary value at the next boundary', () => {
    expect(timeSuggestions('21:18', new Date(2026, 8, 22, 21, 18))).toEqual([
      '21:30',
      '22:00',
      '22:30',
      '23:00',
    ])
  })

  it('wraps midnight within the day', () => {
    expect(timeSuggestions('23:30', new Date(2026, 8, 22, 23, 30))).toEqual([
      '23:30',
      '00:00',
      '00:30',
      '01:00',
    ])
  })

  it('falls back to the current wall-clock time for an empty/invalid anchor', () => {
    expect(timeSuggestions(null, new Date(2026, 8, 22, 20, 22))).toEqual([
      '20:30',
      '21:00',
      '21:30',
      '22:00',
    ])
    expect(timeSuggestions('banana', new Date(2026, 8, 22, 20, 22))).toEqual([
      '20:30',
      '21:00',
      '21:30',
      '22:00',
    ])
  })
})

describe('locale presentation', () => {
  it('resolves a browser locale', () => {
    expect(browserLocale()).toMatch(/^[A-Za-z]{2,3}/)
  })

  it('formats dates with the locale (no globally hardcoded format)', () => {
    expect(formatDatePartLocale('2026-09-22', 'en-US')).toBe('Sep 22, 2026')
    expect(formatDatePartLocale('2026-09-22', 'de-DE')).toBe('22.09.2026')
    // Invalid parts pass through untouched.
    expect(formatDatePartLocale('nope', 'en-US')).toBe('nope')
  })

  it('formats times with the locale hour convention', () => {
    expect(formatTimePartLocale('21:30', 'en-US')).toBe('9:30 PM')
    expect(formatTimePartLocale('21:30', 'de-DE')).toBe('21:30')
    expect(formatTimePartLocale('09:30', 'en-US')).toBe('9:30 AM')
  })

  it('builds locale calendar labels independent of the canonical value', () => {
    expect(formatCalendarDayLabel('2026-09-22', 'en-US')).toBe(
      'Tuesday, September 22, 2026',
    )
    expect(formatCalendarMonthLabel(2026, 8, 'en-US')).toBe('September 2026')
    expect(formatCalendarMonthLabel(2026, 9, 'de-DE')).toBe('Oktober 2026')
  })

  it('orders weekday labels from the locale first day of week', () => {
    const enUs = weekdayHeaderLabels('en-US')
    expect(enUs).toHaveLength(7)
    expect(new Set(enUs).size).toBe(7)
    expect(enUs[0]).toBe('Sun')
    const deDe = weekdayHeaderLabels('de-DE')
    expect(deDe).toHaveLength(7)
    expect(new Set(deDe).size).toBe(7)
    // de-DE weeks start on Monday.
    expect(deDe[0]).toBe('Mo')
    expect(firstDayOfWeek('en-US')).toBe(0)
    expect(firstDayOfWeek('de-DE')).toBe(1)
  })
})
