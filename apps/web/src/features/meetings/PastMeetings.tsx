/**
 * Past view of the Meetings page: the read-only archive of the
 * concrete Meetings whose lifecycle explicitly reached `completed`
 * (one-time, Template-created, and materialized recurring alike).
 *
 * The component is presentation-only: it receives an already
 * selected, already-ordered, already-grouped list (see
 * `pastModel.ts`) plus the page-owned load/error state, and renders
 * rows, skeletons, the error panel with Retry, and the empty state.
 *
 * Every row is a plain OPEN affordance — pointer or keyboard
 * activation navigates to the existing Meeting detail through the
 * page's `onOpenMeeting` (direct navigation by canonical id; no
 * write, no materialization). The list carries NO Upcoming row
 * actions (no edit / cancel / exclude / delete) and no badges: the
 * Past tab already communicates the completed state.
 *
 * Visual language: the same shared rounded list container,
 * restrained dividers, compact 32px date-group header band,
 * semantic typography roles, and the ~68px minimum row geometry as
 * the Upcoming / Series lists. Date-group headers are unambiguous
 * local calendar dates INCLUDING the year (Past spans arbitrary
 * history); groups descend by date, rows descend by scheduled time.
 */

import type {
  PastDateGroup,
  PastMeeting,
} from './pastModel'
import {
  formatUpcomingTime,
  peopleLabel,
} from './upcomingGroups'

/* ── One Past row ──────────────────────────────────────────────── */

function PastMeetingRow({
  item,
  dateLabel,
  onOpenMeeting,
}: {
  item: PastMeeting
  /** The owning group's unambiguous date label (with year). */
  dateLabel: string
  onOpenMeeting: (meetingId: number) => void
}) {
  const timeLabel = formatUpcomingTime(item.scheduledAt)
  // Accessible identity: title + the scheduled date (unambiguous,
  // from the owning group) + local time — the same naming rule as
  // the Upcoming rows, minus the Upcoming-only metadata.
  const open = () => onOpenMeeting(item.id)
  // Participant data is available from the concrete Meeting only —
  // an empty list renders no count, never a fabricated one.
  // The shared `peopleLabel` keeps the singular/plural grammar
  // consistent with the Upcoming and Series rows ("1 person").
  const people =
    item.participantCount > 0
      ? peopleLabel(item.participantCount)
      : null

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${item.title} on ${dateLabel} at ${timeLabel}`}
      onClick={open}
      onKeyDown={(event) => {
        if (
          event.key === 'Enter' ||
          event.key === ' '
        ) {
          event.preventDefault()
          open()
        }
      }}
      className={[
        'group grid min-h-[68px] grid-cols-1 cursor-pointer items-center gap-x-4 gap-y-1.5 px-4 py-3 text-left outline-none transition select-none',
        'hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-focus',
        // Tablet 768–1099px: Time + Meeting (People folds into the
        // secondary metadata); desktop ≥1100px: People in its own
        // track. Same mutually-exclusive media-range contract as
        // the Upcoming / Series rows. Past has NO actions track:
        // the row is the only affordance.
        'md:max-[1100px]:grid-cols-[88px_minmax(0,1fr)]',
        'min-[1100px]:grid-cols-[104px_minmax(0,1fr)_96px]',
      ].join(' ')}
    >
      <div className="fg-type-record-title tabular-nums text-text">
        {timeLabel}
      </div>

      <div className="min-w-0">
        <div className="truncate fg-type-record-title text-text">
          {item.title}
        </div>

        {/* Mobile + tablet only: the desktop ≥1100px layout shows
            People in its dedicated track (same responsive
            convention as the Upcoming People cell). */}
        {people && (
          <div className="mt-1 fg-type-meta text-text-muted min-[1100px]:hidden">
            {people}
          </div>
        )}
      </div>

      <div className="hidden whitespace-nowrap text-left fg-type-meta tabular-nums text-text-muted min-[1100px]:block">
        {people ?? ''}
      </div>
    </div>
  )
}

/* ── Loading / error / empty states ────────────────────────────── */

const SKELETON_ROWS = 5

/**
 * Row-shaped loading state: the same list container and row
 * geometry as the real rows, no page spinner.
 */
function PastSkeleton() {
  return (
    <section
      aria-busy="true"
      aria-label="Loading completed meetings"
      className="overflow-hidden rounded-[10px] border border-border-subtle bg-surface-quiet"
    >
      {Array.from({ length: SKELETON_ROWS }).map(
        (_, index) => (
          <div
            key={index}
            className={[
              'grid min-h-[68px] grid-cols-1 items-center gap-x-4 gap-y-1.5 px-4 py-3',
              // Same mutually-exclusive breakpoint contract as
              // the real row (see PastMeetingRow).
              'md:max-[1100px]:grid-cols-[88px_minmax(0,1fr)]',
              'min-[1100px]:grid-cols-[104px_minmax(0,1fr)_96px]',
            ].join(' ')}
          >
            <div className="h-4 w-12 animate-pulse rounded bg-surface-muted" />

            <div className="min-w-0 space-y-2">
              <div className="h-4 w-2/3 max-w-64 animate-pulse rounded bg-surface-muted" />
            </div>

            <div className="hidden h-3 w-14 animate-pulse rounded bg-surface-muted min-[1100px]:block" />
          </div>
        ),
      )}
    </section>
  )
}

/**
 * The actionable error state for the canonical Meetings list
 * (Past renders from it directly — no separate Past request).
 * Same presentation as the Upcoming tab's page error; the page
 * wires Retry to repeat only the Meetings request.
 */
function PastErrorState({
  error,
  onRetry,
}: {
  error: string
  onRetry: () => void
}) {
  return (
    <div
      role="alert"
      className="flex min-h-64 flex-col items-center justify-center rounded-[10px] border border-border-subtle bg-surface-quiet px-6 py-10 text-center"
    >
      <span className="material-symbols-outlined text-[24px] text-danger">
        cloud_off
      </span>

      <h2 className="mt-3 fg-type-section-heading text-text">
        Meetings couldn't be loaded
      </h2>

      <p className="mt-1 max-w-md fg-type-primary-content text-text-muted">
        {error}
      </p>

      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg border border-border-subtle px-4 fg-type-control text-text transition hover:bg-surface-hover"
      >
        <span className="material-symbols-outlined text-[18px]">
          refresh
        </span>
        Try again
      </button>
    </div>
  )
}

/**
 * The honest empty state: the Meetings list loaded successfully but
 * no Meeting has reached the completed lifecycle state yet. It
 * must never read like a load failure.
 */
function PastEmptyState() {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-[10px] border border-dashed border-border-default bg-surface-quiet px-6 py-12 text-center">
      <span className="material-symbols-outlined text-[24px] text-text-muted">
        history
      </span>

      <h2 className="mt-3 fg-type-section-heading text-text">
        No completed meetings yet
      </h2>

      <p className="mt-1 max-w-md fg-type-primary-content text-text-muted">
        Completed meetings will appear here so you can review what
        happened.
      </p>
    </div>
  )
}

/* ── List shell ────────────────────────────────────────────────── */

/**
 * The Past list. `error` (the page-owned Meetings load error)
 * renders the actionable error panel; `loading` (the canonical
 * Meetings list still loading) renders the row skeletons; `groups`
 * (already selected, ordered, and grouped — see `pastModel.ts`)
 * renders the read-only archive. `onOpenMeeting` receives the
 * canonical concrete Meeting id for an EXPLICIT open intent (row
 * activation, pointer or keyboard); the page navigates to the
 * existing Meeting detail — rendering the list never invokes it.
 */
export function PastMeetingsList({
  groups,
  loading,
  error,
  onRetry,
  onOpenMeeting,
}: {
  groups: PastDateGroup[]
  loading: boolean
  error: string | null
  onRetry: () => void
  onOpenMeeting: (meetingId: number) => void
}) {
  if (error != null) {
    return (
      <PastErrorState
        error={error}
        onRetry={onRetry}
      />
    )
  }

  if (loading) {
    return <PastSkeleton />
  }

  if (groups.length === 0) {
    return <PastEmptyState />
  }

  return (
    <section
      aria-label="Completed meetings"
      className="overflow-hidden rounded-[10px] border border-border-subtle bg-surface-quiet"
    >
      {groups.map((group, index) => (
        // ONE shared list container for every group (same
        // convention as the Upcoming list): the date-group
        // hierarchy comes from spacing + the header band +
        // typography — an ~8px gap before every group AFTER the
        // first, no per-day cards, no strong borders.
        <div key={group.date} className={index > 0 ? 'mt-2' : ''}>
          <h3 className="flex h-8 items-center border-b border-border-subtle bg-surface-header px-4 text-xs font-semibold text-text-muted">
            {group.label}
          </h3>

          <div className="divide-y divide-border-subtle">
            {group.items.map((item) => (
              <PastMeetingRow
                key={item.id}
                item={item}
                dateLabel={group.label}
                onOpenMeeting={onOpenMeeting}
              />
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}
