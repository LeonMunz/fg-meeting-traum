/**
 * The Meeting create dialog's date calendar: a POPOVER (not a nested
 * modal/dialog) anchored above the Date control inside the modal's existing
 * scroll container.
 *
 * Presentation is locale-aware (month header, weekday labels, and full-date
 * cell labels via Intl); the form value stays the canonical 'YYYY-MM-DD'.
 *
 * ARIA: a role="grid" of rows/gridcells, each cell holding one button with a
 * full-date aria-label and roving tabindex. Keyboard: Arrow Left/Right move
 * one day, Arrow Up/Down one week, PageUp/PageDown one month, Home/End jump
 * to the row start/end, Enter/Space select (native button activation), and
 * Escape closes the calendar first and returns focus to the Date input.
 * Today carries aria-current="date"; the selected day's gridcell carries
 * aria-selected. Outside mousedown closes without moving focus (the
 * established repository popover contract).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
} from 'react'

import {
  firstDayOfWeek,
  formatCalendarDayLabel,
  formatCalendarMonthLabel,
  localDatePart,
  weekdayHeaderLabels,
} from './scheduleUtils'

type CreateMeetingCalendarProps = {
  open: boolean
  locale: string
  /** The selected date (canonical) or null. */
  selectedDatePart: string | null
  /** The wrapper (field + trigger + popover) used for outside clicks. */
  anchorRef: RefObject<HTMLDivElement | null>
  /** The Date input that opened the calendar (focus-return target). */
  triggerRef: RefObject<HTMLInputElement | null>
  onSelect: (datePart: string) => void
  onOpenChange: (open: boolean) => void
}

const WEEKS = 6
const DAYS_PER_WEEK = 7

/** Canonical date part shifted by whole days (local; day math only). */
function shiftDays(datePart: string, days: number): string {
  const [year, month, day] = datePart.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  date.setDate(date.getDate() + days)
  return localDatePart(date)
}

/**
 * Canonical date part shifted by whole months, clamping the day to the
 * target month's length (Jan 31 -> Feb 28).
 */
function shiftMonth(datePart: string, months: number): string {
  const [year, month, day] = datePart.split('-').map(Number)
  const targetMonth = month - 1 + months
  const targetYear = year + Math.floor(targetMonth / 12)
  const targetMonthIndex = ((targetMonth % 12) + 12) % 12
  const lastDay = new Date(targetYear, targetMonthIndex + 1, 0).getDate()
  return localDatePart(
    new Date(targetYear, targetMonthIndex, Math.min(day, lastDay)),
  )
}

const NAV_BUTTON_CLASS =
  'flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus'

export function CreateMeetingCalendar({
  open,
  locale,
  selectedDatePart,
  anchorRef,
  triggerRef,
  onSelect,
  onOpenChange,
}: CreateMeetingCalendarProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const cellRefs = useRef(new Map<string, HTMLButtonElement>())
  // The anchor cell: the visible month is derived from it and it carries
  // the roving focus, so all navigation is one state update.
  const [anchorDatePart, setAnchorDatePart] = useState(() =>
    selectedDatePart ?? localDatePart(new Date()),
  )

  // (Re)initialize the visible month + focus target whenever the calendar
  // opens (and when the selection changes while open).
  useEffect(() => {
    if (open) {
      setAnchorDatePart(selectedDatePart ?? localDatePart(new Date()))
    }
  }, [open, selectedDatePart])

  const todayPart = localDatePart(new Date())
  const anchorYear = Number(anchorDatePart.slice(0, 4))
  const anchorMonthIndex = Number(anchorDatePart.slice(5, 7)) - 1
  const firstDay = firstDayOfWeek(locale)

  // The 6x7 grid, starting on the locale's first day of week on or before
  // the 1st of the visible month.
  const days = useMemo(() => {
    const first = new Date(anchorYear, anchorMonthIndex, 1)
    const offset = (first.getDay() - firstDay + 7) % 7
    const start = new Date(anchorYear, anchorMonthIndex, 1)
    start.setDate(start.getDate() - offset)
    const parts: string[] = []
    for (let i = 0; i < WEEKS * DAYS_PER_WEEK; i += 1) {
      const cell = new Date(start.getFullYear(), start.getMonth(), start.getDate())
      cell.setDate(cell.getDate() + i)
      parts.push(localDatePart(cell))
    }
    return parts
  }, [anchorYear, anchorMonthIndex, firstDay])

  const headerWeekdays = useMemo(
    () => weekdayHeaderLabels(locale),
    [locale],
  )

  // Roving focus follows the anchor cell while the calendar is open.
  useEffect(() => {
    if (!open) {
      return
    }
    cellRefs.current.get(anchorDatePart)?.focus()
  }, [open, anchorDatePart])

  // Escape closes the calendar FIRST (before any modal-level handling) and
  // returns focus to the Date input; outside mousedown closes without a
  // focus change (established repository popover contract).
  useEffect(() => {
    if (!open) {
      return
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (
        event.target instanceof Node &&
        !anchorRef.current?.contains(event.target)
      ) {
        onOpenChange(false)
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onOpenChange(false)
        triggerRef.current?.focus()
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, onOpenChange, anchorRef, triggerRef])

  const move = (event: ReactKeyboardEvent, nextDatePart: string) => {
    event.preventDefault()
    setAnchorDatePart(nextDatePart)
  }

  const handleCellKeyDown = (
    event: ReactKeyboardEvent,
    datePart: string,
  ) => {
    switch (event.key) {
      case 'ArrowLeft':
        move(event, shiftDays(datePart, -1))
        break
      case 'ArrowRight':
        move(event, shiftDays(datePart, 1))
        break
      case 'ArrowUp':
        move(event, shiftDays(datePart, -7))
        break
      case 'ArrowDown':
        move(event, shiftDays(datePart, 7))
        break
      case 'PageUp':
        move(event, shiftMonth(datePart, -1))
        break
      case 'PageDown':
        move(event, shiftMonth(datePart, 1))
        break
      case 'Home': {
        const [year, month, day] = datePart.split('-').map(Number)
        const offset = (new Date(year, month - 1, day).getDay() - firstDay + 7) % 7
        move(event, shiftDays(datePart, -offset))
        break
      }
      case 'End': {
        const [year, month, day] = datePart.split('-').map(Number)
        const offset = (new Date(year, month - 1, day).getDay() - firstDay + 7) % 7
        move(event, shiftDays(datePart, DAYS_PER_WEEK - 1 - offset))
        break
      }
      // Enter/Space select via the native button activation; Escape is
      // handled by the document listener (closes the calendar first).
      default:
        break
    }
  }

  if (!open) {
    return null
  }

  return (
    <div
      ref={popoverRef}
      role="grid"
      aria-label="Calendar"
      className="absolute bottom-[calc(100%+6px)] left-0 z-50 w-[300px] max-w-full rounded-lg border border-border-subtle bg-surface p-3 shadow-[0_12px_32px_rgba(0,0,0,0.32)]"
    >
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() =>
            setAnchorDatePart((current) => shiftMonth(current, -1))
          }
          className={NAV_BUTTON_CLASS}
        >
          <span
            aria-hidden="true"
            className="material-symbols-outlined text-[18px]"
          >
            chevron_left
          </span>
        </button>

        <span
          aria-live="polite"
          className="text-sm font-semibold text-text"
        >
          {formatCalendarMonthLabel(
            anchorYear,
            anchorMonthIndex,
            locale,
          )}
        </span>

        <button
          type="button"
          aria-label="Next month"
          onClick={() =>
            setAnchorDatePart((current) => shiftMonth(current, 1))
          }
          className={NAV_BUTTON_CLASS}
        >
          <span
            aria-hidden="true"
            className="material-symbols-outlined text-[18px]"
          >
            chevron_right
          </span>
        </button>
      </div>

      <div className="mb-1 grid grid-cols-7">
        {headerWeekdays.map((label, index) => (
          <span
            key={`${label}-${index}`}
            className="py-1 text-center text-[11px] font-medium text-text-muted"
          >
            {label}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-y-0.5">
        {Array.from({ length: WEEKS }, (_, week) => (
          <div key={week} role="row">
            {days
              .slice(week * DAYS_PER_WEEK, (week + 1) * DAYS_PER_WEEK)
              .map((datePart) => {
                const inMonth =
                  datePart.slice(0, 7) === anchorDatePart.slice(0, 7)
                const isToday = datePart === todayPart
                const isSelected = datePart === selectedDatePart
                return (
                  <div
                    key={datePart}
                    role="gridcell"
                    aria-selected={isSelected || undefined}
                  >
                    <button
                      type="button"
                      ref={(element) => {
                        if (element) {
                          cellRefs.current.set(datePart, element)
                        } else {
                          cellRefs.current.delete(datePart)
                        }
                      }}
                      aria-label={formatCalendarDayLabel(datePart, locale)}
                      aria-current={isToday ? 'date' : undefined}
                      tabIndex={datePart === anchorDatePart ? 0 : -1}
                      onClick={() => onSelect(datePart)}
                      onKeyDown={(event) => handleCellKeyDown(event, datePart)}
                      className={[
                        'mx-auto flex h-9 w-9 items-center justify-center rounded-md text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                        inMonth ? 'text-text' : 'text-text-muted/60',
                        isSelected
                          ? 'bg-accent font-semibold text-text-inverse hover:bg-accent-hover'
                          : 'hover:bg-surface-hover',
                        isToday && !isSelected
                          ? 'bg-surface-muted font-semibold ring-1 ring-inset ring-border-default'
                          : '',
                      ].join(' ')}
                    >
                      {Number(datePart.slice(8, 10))}
                    </button>
                  </div>
                )
              })}
          </div>
        ))}
      </div>
    </div>
  )
}
