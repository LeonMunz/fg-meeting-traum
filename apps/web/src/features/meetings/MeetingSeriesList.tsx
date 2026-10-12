/**
 * Series overview of the Meetings page: one compact, READ-ONLY row
 * per personally relevant recurring Series, rendered in the backend's
 * ordering from the window-free personal Series overview
 * (`GET /api/meeting-recurrences/`, see `listMeetingRecurrences`).
 * The personal overview is cross-group; the page's data layer scopes
 * the list to the active Research Group before it arrives here (the
 * component renders exactly the rows it is given, in order).
 *
 * The component is presentation-only: it receives an already-fetched
 * list (the data layer lives in `MeetingListPage`) and renders rows,
 * the row-shaped loading state, the Series-local error with Retry,
 * and the empty state.
 *
 * The row stays NON-NAVIGATIONAL — no row activation, no
 * row-actions menu, no link (the Series detail is future scope) —
 * and its ONLY interaction is the far-right whole-series
 * termination action: a compact trash button, visually identical to
 * the Upcoming row's destructive action (16px `delete` glyph,
 * ~32×32px hit area, neutral at rest, destructive emphasis on hover
 * and keyboard focus, revealed on hover/focus for pointer devices,
 * always visible on touch), rendered for a row ONLY when the
 * server's per-row `canTerminate` permission report is exactly
 * `true`. A missing or false grant never renders the button — the
 * permission is never inferred client-side.
 *
 * Row information hierarchy: the Series title is primary; the
 * human-readable recurrence schedule (from the structured rule
 * fields, via `formatRecurrenceSummary`) is quiet secondary
 * metadata; the next effective meeting, the authoritative
 * `peopleCount`, and the derived Active / Ended state are scannable
 * row cells. The visual language matches the Upcoming list: one
 * shared rounded list container, subtle row dividers, the same row
 * padding / min-height / responsive breakpoint contract (plus the
 * far-right Actions track, which stays empty — the geometry never
 * jumps — when the server grants no termination).
 */

import { useMemo } from 'react'

import type { ApiMeetingRecurrenceOverview } from '../../api/types'
import { formatRecurrenceSummary } from './recurrenceUtils'
import { browserLocale } from './scheduleUtils'
import { formatUpcomingTime, peopleLabel } from './upcomingGroups'

/* ── Row cell formatters ────────────────────────────────────────── */

const NEXT_DATE_CURRENT_YEAR = new Intl.DateTimeFormat('en', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
})

const NEXT_DATE_OTHER_YEAR = new Intl.DateTimeFormat('en', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

/**
 * Label for a Series row's next effective meeting: the local date in
 * the Meetings surface's short-date style (weekday + short month +
 * day; the year appears only when it differs from the current year —
 * the window-free overview can reach into future years, where the
 * Upcoming 42-day labels never do) plus the local clock time of the
 * same instant (the existing Upcoming Time-cell formatter).
 */
function formatSeriesNextLabel(scheduledAt: string): string {
  const date = new Date(scheduledAt)

  if (Number.isNaN(date.getTime())) {
    return scheduledAt
  }

  const sameYear = date.getFullYear() === new Date().getFullYear()
  const dateLabel = (
    sameYear ? NEXT_DATE_CURRENT_YEAR : NEXT_DATE_OTHER_YEAR
  ).format(date)

  return `${dateLabel} · ${formatUpcomingTime(scheduledAt)}`
}

/* ── One read-only Series row ───────────────────────────────────── */

function SeriesOverviewRow({
  series,
  locale,
  onTerminateSeries,
}: {
  series: ApiMeetingRecurrenceOverview
  locale: string
  onTerminateSeries: (series: ApiMeetingRecurrenceOverview) => void
}) {
  // The human-readable rule summary over the STRUCTURED recurrence
  // fields — no display-name inference and no recurrence
  // re-calculation (the helper is pure presentation).
  const scheduleSummary = useMemo(
    () =>
      formatRecurrenceSummary({
        frequency: series.frequency,
        interval: series.interval,
        weekdays: series.weekdays,
        startDate: series.startDate,
        time: series.localTime,
        locale,
        endMode:
          series.endDate != null
            ? 'date'
            : series.count != null
              ? 'count'
              : 'never',
        endDate: series.endDate,
        count: series.count,
      }),
    [series, locale],
  )

  // The next effective meeting is authoritative from the overview:
  // an active Series carries it, an ended Series never does — no
  // fabricated next date.
  const nextLabel =
    series.status === 'active' &&
    series.nextOccurrenceScheduledAt != null
      ? formatSeriesNextLabel(series.nextOccurrenceScheduledAt)
      : null

  // `peopleCount` is authoritative from the payload — no
  // participant-list fetch.
  const people = peopleLabel(series.peopleCount)

  return (
    // Deliberately a plain div: no role, no tabIndex, no click /
    // keyboard handler — the row itself is NOT openable (no Series
    // detail destination exists). `group` drives the hover/focus
    // reveal of the row's termination action on pointer devices.
    <div
      className={[
        'group grid min-h-[68px] grid-cols-1 items-center gap-x-4 gap-y-1.5 px-4 py-3',
        // Same mutually-exclusive breakpoint contract as the
        // Upcoming row: tablet 768–1099px is two tracks (Meeting +
        // People; the next label folds into the secondary
        // metadata), desktop ≥1100px adds the dedicated next track,
        // and the far-right 40px Actions track holds the single
        // server-authorized termination action (empty — the
        // geometry never jumps — when the server grants none).
        'md:max-[1100px]:grid-cols-[minmax(0,1fr)_96px_40px]',
        'min-[1100px]:grid-cols-[minmax(0,1fr)_190px_96px_40px]',
      ].join(' ')}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm font-semibold text-text">
            {series.title}
          </span>

          {/* Derived read-model state, rendered restrained: the same
              11px pill shape as the Upcoming row badges, but in a
              neutral muted tone for BOTH states — Active is the
              normal state, not an exception. */}
          <span className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-text-muted">
            {series.status === 'active' ? 'Active' : 'Ended'}
          </span>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted min-[1100px]:flex-nowrap min-[1100px]:overflow-hidden">
          <span className="min-w-0 truncate">
            {scheduleSummary}
          </span>

          {/* Mobile + tablet only: the desktop ≥1100px layout shows
              the next meeting in its dedicated track. Deliberately
              NOT shrink-0: at tablet width and up the label always
              fits one line (and ≥1100px hides it), but in the
              app's narrowest column (a phone viewport, where the
              fixed 240px sidebar leaves a ~100px content column)
              the label must wrap to a second line instead of
              overflowing the row and being clipped by the list
              container. */}
          {nextLabel && (
            <span className="tabular-nums min-[1100px]:hidden">
              {nextLabel}
            </span>
          )}

          {/* Mobile only: tablet + desktop show the people count in
              its dedicated track (same responsive convention as
              the Upcoming People cell). */}
          <span className="shrink-0 tabular-nums md:hidden">
            {people}
          </span>
        </div>
      </div>

      <div className="hidden min-[1100px]:block">
        {nextLabel && (
          <div className="whitespace-nowrap text-sm tabular-nums text-text">
            {nextLabel}
          </div>
        )}
      </div>

      <div className="hidden whitespace-nowrap text-left text-sm tabular-nums text-text-muted md:block">
        {people}
      </div>

      {/* Far-right Actions track: the single whole-series
          termination action, rendered ONLY when the server's
          per-row permission report grants it (`canTerminate` —
          never inferred from creator identity or any other row
          data). The empty track preserves the row geometry when
          the server grants none. Same compact shape as the
          Upcoming row's destructive action. */}
      <div className="flex justify-end md:justify-self-end">
        {series.canTerminate === true && (
          <button
            type="button"
            aria-label={`Delete series ${series.title}`}
            onClick={() => onTerminateSeries(series)}
            className={[
              'fg-upcoming-row-action flex h-8 w-8 items-center justify-center rounded-lg text-text-muted opacity-0 outline-none transition',
              'hover:bg-danger-bg hover:text-danger',
              'focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-danger',
              'group-hover:opacity-100 group-focus-within:opacity-100',
            ].join(' ')}
          >
            <span
              aria-hidden="true"
              className="fg-upcoming-row-icon material-symbols-outlined"
            >
              delete
            </span>
          </button>
        )}
      </div>
    </div>
  )
}

/* ── Loading / empty states ─────────────────────────────────────── */

const SKELETON_ROWS = 3

/**
 * Lightweight row-shaped loading state: the same list container and
 * row geometry as the real rows, no page spinner.
 */
function SeriesSkeleton() {
  return (
    <section
      aria-busy="true"
      aria-label="Loading meeting series"
      className="overflow-hidden rounded-[10px] border border-border-subtle bg-surface-quiet"
    >
      {Array.from({ length: SKELETON_ROWS }).map(
        (_, index) => (
          <div
            key={index}
            className={[
              'grid min-h-[68px] grid-cols-1 items-center gap-x-4 gap-y-1.5 px-4 py-3',
              // Same mutually-exclusive breakpoint contract as the
              // real row (see SeriesOverviewRow) — including the
              // far-right 40px Actions track, which the skeleton
              // leaves empty (same as the Upcoming skeleton).
              'md:max-[1100px]:grid-cols-[minmax(0,1fr)_96px_40px]',
              'min-[1100px]:grid-cols-[minmax(0,1fr)_190px_96px_40px]',
            ].join(' ')}
          >
            <div className="min-w-0 space-y-2">
              <div className="h-4 w-1/2 max-w-56 animate-pulse rounded bg-surface-muted" />

              <div className="h-3 w-2/3 max-w-72 animate-pulse rounded bg-surface-muted" />
            </div>

            <div className="hidden h-4 w-36 animate-pulse rounded bg-surface-muted min-[1100px]:block" />

            <div className="hidden h-3 w-16 animate-pulse rounded bg-surface-muted md:block" />
          </div>
        ),
      )}
    </section>
  )
}

function SeriesEmptyState({
  onNewMeeting,
}: {
  onNewMeeting: () => void
}) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-[10px] border border-dashed border-border-default bg-surface-quiet px-6 py-12 text-center">
      <span className="material-symbols-outlined text-[30px] text-text-muted">
        repeat
      </span>

      <h2 className="mt-3 text-base font-semibold text-text">
        No meeting series
      </h2>

      <p className="mt-1 text-sm text-text-muted">
        Recurring series you create will appear here.
      </p>

      <button
        type="button"
        onClick={onNewMeeting}
        className="mt-5 inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-text-inverse transition hover:bg-accent-hover"
      >
        <span
          aria-hidden="true"
          className="material-symbols-outlined text-[18px]"
        >
          add
        </span>
        New meeting
      </button>
    </div>
  )
}

/* ── List shell ─────────────────────────────────────────────────── */

/**
 * The Series overview list. `series` is `null` while the overview is
 * loading (row-shaped skeleton), an array otherwise (rendered in the
 * backend's ordering — never re-sorted client-side). `error` shows
 * the compact Series-local error with Retry (the page wires it to
 * repeat only the Series request). `onTerminateSeries` receives the
 * exact overview row behind a row's trash action — the row is
 * rendered ONLY when that row's server `canTerminate` report is
 * exactly `true`; the page opens the explicit confirmation and owns
 * the mutation. All states keep the Meetings header + tabs, which
 * the page renders around this component.
 */
export function MeetingSeriesList({
  series,
  error,
  onRetry,
  onNewMeeting,
  onTerminateSeries,
}: {
  series: ApiMeetingRecurrenceOverview[] | null
  error: string | null
  onRetry: () => void
  onNewMeeting: () => void
  onTerminateSeries: (series: ApiMeetingRecurrenceOverview) => void
}) {
  const locale = useMemo(() => browserLocale(), [])

  if (error != null) {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[10px] border border-border-subtle bg-warning-bg px-4 py-3"
      >
        <span className="flex min-w-0 items-center gap-2 text-sm text-text">
          <span
            aria-hidden="true"
            className="material-symbols-outlined shrink-0 text-[18px] text-warning"
          >
            error_outline
          </span>
          <span className="min-w-0">
            <span className="font-medium">
              Meeting series
              couldn't be loaded.
            </span>{' '}
            <span className="text-text-muted">
              {error}
            </span>
          </span>
        </span>

        <button
          type="button"
          onClick={onRetry}
          className="ml-auto inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border-subtle bg-surface px-3 text-xs font-semibold text-text transition hover:bg-surface-hover"
        >
          <span
            aria-hidden="true"
            className="material-symbols-outlined text-[16px]"
          >
            refresh
          </span>
          Retry
        </button>
      </div>
    )
  }

  if (series == null) {
    return <SeriesSkeleton />
  }

  if (series.length === 0) {
    return <SeriesEmptyState onNewMeeting={onNewMeeting} />
  }

  return (
    <section
      aria-label="Meeting series"
      className="overflow-hidden rounded-[10px] border border-border-subtle bg-surface-quiet"
    >
      <div className="divide-y divide-border-subtle">
        {series.map((item) => (
          <SeriesOverviewRow
            key={item.id}
            series={item}
            locale={locale}
            onTerminateSeries={onTerminateSeries}
          />
        ))}
      </div>
    </section>
  )
}
