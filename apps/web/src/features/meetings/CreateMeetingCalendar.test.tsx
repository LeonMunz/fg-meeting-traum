// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps, RefObject } from 'react'

import { isoWeekdayOfLocalDate } from './recurrenceUtils'
import {
  formatCalendarDayLabel,
  localDatePart,
  weekdayHeaderLabels,
} from './scheduleUtils'
import { CreateMeetingCalendar } from './CreateMeetingCalendar'

// The component is tested with an explicit locale ('en-US', Sunday-first)
// so the assertions are deterministic; the dialog-level tests cover the
// browser-locale path and stay locale-agnostic via canonical values.

type CalendarProps = ComponentProps<typeof CreateMeetingCalendar>

function renderCalendar(
  overrides: Partial<CalendarProps> = {},
): {
  onSelect: ReturnType<typeof vi.fn>
  onOpenChange: ReturnType<typeof vi.fn>
  trigger: HTMLInputElement
} {
  const onSelect = vi.fn()
  const onOpenChange = vi.fn()
  const live = { anchor: null as HTMLElement | null, trigger: null as HTMLInputElement | null }
  const anchorRef = {
    get current() {
      return live.anchor
    },
  } as RefObject<HTMLDivElement | null>
  const triggerRef = {
    get current() {
      return live.trigger
    },
  } as RefObject<HTMLInputElement | null>

  render(
    <div
      ref={(element) => {
        live.anchor = element
      }}
    >
      <input
        aria-label="date trigger"
        ref={(element) => {
          live.trigger = element
        }}
      />
      <CreateMeetingCalendar
        open
        locale="en-US"
        selectedDatePart={null}
        anchorRef={anchorRef}
        triggerRef={triggerRef}
        onSelect={onSelect}
        onOpenChange={onOpenChange}
        {...overrides}
      />
    </div>,
  )
  expect(live.trigger).not.toBeNull()

  return { onSelect, onOpenChange, trigger: live.trigger! }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('CreateMeetingCalendar presentation', () => {
  it('shows the current month with a locale-formatted header', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 22, 20, 22))

    renderCalendar()

    expect(screen.getByText('September 2026')).toBeVisible()
    // Full 6x7 grid including adjacent-month days.
    expect(screen.getAllByRole('gridcell')).toHaveLength(42)
    // Weekday header follows the en-US week (Sunday first).
    expect(screen.getByRole('grid').textContent).toContain('Sun')
  })

  it('navigates to the previous and next month', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 22, 20, 22))

    renderCalendar()

    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
    expect(screen.getByText('October 2026')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
    expect(screen.getByText('November 2026')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    expect(screen.getByText('October 2026')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    expect(screen.getByText('September 2026')).toBeVisible()
  })

  it('distinguishes today from other days via aria-current', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 22, 20, 22))

    renderCalendar()

    const todayButton = screen
      .getAllByRole('button')
      .find((button) => button.getAttribute('aria-current') === 'date')
    expect(todayButton).toBeDefined()
    expect(todayButton!.textContent).toBe('22')
  })

  it('marks the selected date on its gridcell', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 22, 20, 22))

    renderCalendar({ selectedDatePart: '2026-09-15' })

    const cells = screen.getAllByRole('gridcell')
    const selected = cells.find(
      (cell) => cell.getAttribute('aria-selected') === 'true',
    )
    expect(selected).toBeDefined()
    expect(within(selected!).getByText('15')).toBeVisible()
  })
})

describe('CreateMeetingCalendar selection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 22, 20, 22))
  })

  it('selects a day from the visible month on click', () => {
    const { onSelect } = renderCalendar()

    fireEvent.click(within(screen.getByRole('grid')).getByText('15'))

    expect(onSelect).toHaveBeenCalledWith('2026-09-15')
  })

  it('selects adjacent-month days with their own date', () => {
    const { onSelect } = renderCalendar()

    // September 2026 view: October 1 is an adjacent-month day.
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Thursday, October 1, 2026',
      }),
    )

    expect(onSelect).toHaveBeenCalledWith('2026-10-01')
  })

  it('opens on the selected month with the selection focused', () => {
    renderCalendar({ selectedDatePart: '2026-10-15' })

    expect(screen.getByText('October 2026')).toBeVisible()
    const focused = document.activeElement as HTMLButtonElement | null
    expect(focused?.getAttribute('aria-label')).toBe(
      'Thursday, October 15, 2026',
    )
  })
})

describe('CreateMeetingCalendar keyboard behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 22, 20, 22))
  })

  function focusedDay() {
    const focused = document.activeElement as HTMLButtonElement | null
    expect(focused).not.toBeNull()
    return focused!
  }

  it('moves day by day with Arrow Left/Right', () => {
    renderCalendar()
    expect(focusedDay().textContent).toBe('22')

    fireEvent.keyDown(focusedDay(), { key: 'ArrowRight' })
    expect(focusedDay().textContent).toBe('23')

    fireEvent.keyDown(focusedDay(), { key: 'ArrowLeft' })
    fireEvent.keyDown(focusedDay(), { key: 'ArrowLeft' })
    expect(focusedDay().textContent).toBe('21')
  })

  it('moves week by week with Arrow Up/Down', () => {
    renderCalendar()

    fireEvent.keyDown(focusedDay(), { key: 'ArrowDown' })
    expect(focusedDay().textContent).toBe('29')

    fireEvent.keyDown(focusedDay(), { key: 'ArrowUp' })
    expect(focusedDay().textContent).toBe('22')
  })

  it('changes the visible month with PageUp/PageDown', () => {
    renderCalendar()

    fireEvent.keyDown(focusedDay(), { key: 'PageDown' })
    expect(screen.getByText('October 2026')).toBeVisible()
    expect(focusedDay().getAttribute('aria-label')).toBe(
      'Thursday, October 22, 2026',
    )

    fireEvent.keyDown(focusedDay(), { key: 'PageUp' })
    expect(screen.getByText('September 2026')).toBeVisible()
  })

  it('clamps the day when the target month is shorter', () => {
    renderCalendar({ selectedDatePart: '2026-01-31' })
    expect(screen.getByText('January 2026')).toBeVisible()

    fireEvent.keyDown(focusedDay(), { key: 'PageDown' })

    expect(screen.getByText('February 2026')).toBeVisible()
    // 2026 is not a leap year: January 31 clamps to February 28.
    expect(focusedDay().getAttribute('aria-label')).toBe(
      'Saturday, February 28, 2026',
    )
  })

  it('jumps within the week row with Home/End', () => {
    renderCalendar()
    expect(focusedDay().textContent).toBe('22')

    fireEvent.keyDown(focusedDay(), { key: 'End' })
    // The visible row runs Sunday Sep 20 .. Saturday Sep 26.
    expect(focusedDay().textContent).toBe('26')

    fireEvent.keyDown(focusedDay(), { key: 'Home' })
    expect(focusedDay().textContent).toBe('20')
  })

  it('closes on Escape and returns focus to the Date input', () => {
    const { onOpenChange, trigger } = renderCalendar()

    fireEvent.keyDown(focusedDay(), { key: 'Escape' })

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(trigger).toHaveFocus()
  })

  it('closes on outside mousedown without returning focus', () => {
    const { onOpenChange, trigger } = renderCalendar()

    fireEvent.mouseDown(document.body)

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(trigger).not.toHaveFocus()
  })
})

describe('CreateMeetingCalendar weekday alignment (transposed-grid regression)', () => {
  // Monday-first locale (en-GB): the September 2026 fixture in the bug
  // report. 2026-09-22 = Tuesday, 2026-09-24 = Thursday,
  // 2026-10-01 = Thursday.
  const LOCALE = 'en-GB'
  const SEP_22 = '2026-09-22'

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 22, 20, 22))
  })

  /**
   * The rendered calendar's rows as canonical date parts, resolved via the
   * full-date aria-labels (happy-dom performs no real CSS layout, so
   * structural assertions verify the layout contract the browser applies).
   */
  function renderedRows(): (string | undefined)[][] {
    const start = new Date(2026, 7, 31) // Monday, August 31, 2026
    const labelToDate = new Map<string, string>()
    for (let i = 0; i < 42; i += 1) {
      const cell = new Date(
        start.getFullYear(),
        start.getMonth(),
        start.getDate() + i,
      )
      const datePart = localDatePart(cell)
      labelToDate.set(formatCalendarDayLabel(datePart, LOCALE), datePart)
    }

    return screen.getAllByRole('row').map((row) =>
      Array.from(row.children).map((child) => {
        const label = child.querySelector('button')?.getAttribute('aria-label')
        return label ? labelToDate.get(label) : undefined
      }),
    )
  }

  it('stacks six week rows; each row is its own 7-column grid (not the container)', () => {
    renderCalendar({ locale: LOCALE, selectedDatePart: SEP_22 })

    const rows = screen.getAllByRole('row')
    expect(rows).toHaveLength(6)

    const weeksContainer = rows[0]!.parentElement
    // The container's children are exactly the six week rows.
    expect(weeksContainer!.children).toHaveLength(6)

    for (const row of rows) {
      expect(row.parentElement).toBe(weeksContainer)
      // The ROW is the seven-column grid: one gridcell per weekday column.
      expect(row.className).toContain('grid')
      expect(row.className).toContain('grid-cols-7')
      const cells = Array.from(row.children).filter(
        (child) => child.getAttribute('role') === 'gridcell',
      )
      expect(cells).toHaveLength(7)
    }

    // The weeks container must only STACK the rows. Laying the six rows
    // out as seven-column grid items is exactly the transposed calendar
    // that misaligned every date under the wrong weekday.
    expect(weeksContainer!.className).not.toContain('grid-cols-7')
  })

  it('renders September 2026 (Monday-first) with each date under its weekday', () => {
    renderCalendar({ locale: LOCALE, selectedDatePart: SEP_22 })

    // The weekday header columns order Monday first, matching the rows.
    const weeksContainer = screen.getAllByRole('row')[0]!.parentElement!
    const header = weeksContainer.previousElementSibling as HTMLElement
    expect(
      Array.from(header.children).map((cell) => cell.textContent),
    ).toEqual(weekdayHeaderLabels(LOCALE))

    const rows = renderedRows()
    expect(rows).toEqual([
      ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06'],
      ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13'],
      ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20'],
      ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'],
      ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'],
      ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'],
    ])

    // The exact bug report: Sep 22 renders in the Tuesday column (2nd
    // cell), Sep 24 in the Thursday column (4th cell) of their row.
    expect(rows[3]![1]).toBe('2026-09-22')
    expect(rows[3]![3]).toBe('2026-09-24')
    // ISO weekdays (0 = Monday): Tuesday = 1, Thursday = 3.
    expect(isoWeekdayOfLocalDate('2026-09-22')).toBe(1)
    expect(isoWeekdayOfLocalDate('2026-09-24')).toBe(3)
  })

  it('gives October 1, 2026 the Thursday full-date label and selects 2026-10-01', () => {
    const { onSelect } = renderCalendar({
      locale: LOCALE,
      selectedDatePart: SEP_22,
    })

    const october1 = screen.getByRole('button', {
      name: 'Thursday, 1 October 2026',
    })
    // Thursday column: the 4th cell of the week row starting Mon Sep 28.
    const row = october1.closest('[role="row"]') as HTMLElement
    const cell = october1.closest('[role="gridcell"]') as HTMLElement
    expect(Array.from(row.children).indexOf(cell)).toBe(3)
    expect(isoWeekdayOfLocalDate('2026-10-01')).toBe(3)

    fireEvent.click(october1)
    expect(onSelect).toHaveBeenCalledWith('2026-10-01')
  })
})
