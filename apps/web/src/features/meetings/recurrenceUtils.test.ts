import { describe, expect, it } from 'vitest'

import {
  currentIanaTimezone,
  frequencyUnit,
  formatRecurrenceSummary,
  isoWeekdayOfLocalDate,
  parsePositiveIntegerText,
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

describe('parsePositiveIntegerText', () => {
  it('parses whole numbers at and above the minimum', () => {
    expect(parsePositiveIntegerText('1')).toBe(1)
    expect(parsePositiveIntegerText('12')).toBe(12)
    expect(parsePositiveIntegerText('  7  ')).toBe(7)
    expect(parsePositiveIntegerText('1', 5)).toBeNull()
    expect(parsePositiveIntegerText('5', 5)).toBe(5)
  })

  it('rejects empty, fractional, signed, and non-numeric text without clamping', () => {
    expect(parsePositiveIntegerText('')).toBeNull()
    expect(parsePositiveIntegerText('   ')).toBeNull()
    expect(parsePositiveIntegerText('0')).toBeNull()
    expect(parsePositiveIntegerText('-2')).toBeNull()
    expect(parsePositiveIntegerText('1.5')).toBeNull()
    expect(parsePositiveIntegerText('abc')).toBeNull()
    expect(parsePositiveIntegerText('1e3')).toBeNull()
    expect(parsePositiveIntegerText('Infinity')).toBeNull()
  })
})

describe('frequencyUnit', () => {
  it('maps each V1 frequency to its singular unit word', () => {
    expect(frequencyUnit('daily')).toBe('day')
    expect(frequencyUnit('weekly')).toBe('week')
    expect(frequencyUnit('monthly')).toBe('month')
  })
})

describe('formatRecurrenceSummary', () => {
  const base = {
    startDate: '2026-09-22',
    time: '10:30',
    locale: 'en-US',
  }

  it('renders a daily rule with a no-end suffix', () => {
    expect(
      formatRecurrenceSummary({
        ...base,
        frequency: 'daily',
        interval: 1,
        weekdays: [],
        endMode: 'never',
      }),
    ).toBe('Every day at 10:30 AM · no end')
  })

  it('pluralizes the unit for interval > 1 and lists two weekdays with "and"', () => {
    expect(
      formatRecurrenceSummary({
        ...base,
        frequency: 'weekly',
        interval: 2,
        weekdays: [1, 3],
        endMode: 'never',
      }),
    ).toBe('Every 2 weeks on Tuesday and Thursday at 10:30 AM · no end')
  })

  it('lists three weekdays in ISO order with a serial comma', () => {
    expect(
      formatRecurrenceSummary({
        ...base,
        frequency: 'weekly',
        interval: 1,
        weekdays: [6, 0, 2],
        endMode: 'never',
      }),
    ).toBe(
      'Every week on Monday, Wednesday, and Sunday at 10:30 AM · no end',
    )
  })

  it('derives the monthly day-of-month from the start date', () => {
    expect(
      formatRecurrenceSummary({
        ...base,
        frequency: 'monthly',
        interval: 1,
        weekdays: [],
        endMode: 'never',
      }),
    ).toBe('Every month on day 22 at 10:30 AM · no end')
  })

  it('maps the end modes to their exact phrases', () => {
    expect(
      formatRecurrenceSummary({
        ...base,
        frequency: 'daily',
        interval: 1,
        weekdays: [],
        endMode: 'date',
        endDate: '2026-11-30',
      }),
    ).toBe('Every day at 10:30 AM · until Nov 30, 2026')

    expect(
      formatRecurrenceSummary({
        ...base,
        frequency: 'daily',
        interval: 1,
        weekdays: [],
        endMode: 'count',
        count: 12,
      }),
    ).toBe('Every day at 10:30 AM · 12 occurrences')

    expect(
      formatRecurrenceSummary({
        ...base,
        frequency: 'daily',
        interval: 1,
        weekdays: [],
        endMode: 'count',
        count: 1,
      }),
    ).toBe('Every day at 10:30 AM · 1 occurrence')
  })
})
