/**
 * Small, generic recurrence utilities for the Meeting recurrence client
 * foundation. These are pure helpers independent of any specific
 * recurrence UI: the browser's canonical IANA time zone and the backend's
 * ISO-weekday convention for a local calendar date.
 */

/**
 * ISO weekday of a local `YYYY-MM-DD` date in the backend's canonical
 * convention: 0 = Monday .. 6 = Sunday.
 *
 * The date parts are parsed directly (no UTC/DST shift) and the value is
 * converted from `Date.getDay()` (0 = Sunday .. 6 = Saturday).
 */
export function isoWeekdayOfLocalDate(datePart: string): number {
  const [year, month, day] = datePart.split('-').map(Number)
  const localDate = new Date(year, month - 1, day)
  return (localDate.getDay() + 6) % 7
}

/** The browser's canonical IANA time zone. */
export function currentIanaTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}
