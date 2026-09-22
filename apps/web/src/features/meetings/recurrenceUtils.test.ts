import { describe, expect, it } from 'vitest'

import {
  currentIanaTimezone,
  isoWeekdayOfLocalDate,
} from './recurrenceUtils'

describe('isoWeekdayOfLocalDate', () => {
  it('uses the backend ISO convention (0 = Monday .. 6 = Sunday)', () => {
    // 2030-01-07 is a Monday.
    expect(isoWeekdayOfLocalDate('2030-01-07')).toBe(0)
    // 2030-01-13 is a Sunday.
    expect(isoWeekdayOfLocalDate('2030-01-13')).toBe(6)
    // 2030-01-02 is a Wednesday.
    expect(isoWeekdayOfLocalDate('2030-01-02')).toBe(2)
  })
})

describe('currentIanaTimezone', () => {
  it('returns a valid IANA timezone from the browser', () => {
    const tz = currentIanaTimezone()

    expect(typeof tz).toBe('string')
    expect(tz.length).toBeGreaterThan(0)
    // IANA zone ids contain a slash (Area/Location).
    expect(tz).toMatch(/^[A-Za-z_]+\//)
  })
})
