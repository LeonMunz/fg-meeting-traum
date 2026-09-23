/**
 * Upcoming view of the Meetings page: one chronological list of
 * effective Upcoming items (one-time Meetings and recurring
 * occurrences together), grouped by local calendar date.
 *
 * The component is presentation-only: it receives an already
 * normalized, already-ordered list (see `upcomingModel.ts` /
 * `upcomingGroups.ts`) and renders rows, skeletons, and the empty
 * state. Recurring occurrences look like normal Meetings — every
 * row is openable. The internal materialized/virtual distinction
 * never surfaces as copy: a virtual occurrence simply has no
 * concrete Meeting id yet, and an explicit Open intent resolves it
 * through the parent's open handler (the write itself stays in the
 * page's data layer).
 */

import {
  useEffect,
  useRef,
  useState,
} from 'react'

import type { UpcomingMeeting } from './upcomingModel'
import {
  formatOriginallyLabel,
  formatUpcomingDate,
  formatUpcomingTime,
  peopleLabel,
} from './upcomingGroups'

import type { UpcomingDateGroup } from './upcomingGroups'

/* ── Row actions (V1: open the concrete Meeting) ───────────────── */

/**
 * Per-row overflow affordance. V1 offers a single action — open the
 * Meeting — leaving the slot for future row actions without changing
 * the row geometry. Concrete Meetings and virtual recurring
 * occurrences render the SAME affordance: opening a virtual
 * occurrence is the explicit intent that resolves it into the
 * concrete Meeting workspace.
 */
function RowActionsMenu({
  meetingTitle,
  onOpen,
}: {
  meetingTitle: string
  onOpen: () => void
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({
    top: 0,
    left: 0,
  })
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    const onOutside = (event: MouseEvent) => {
      if (
        ref.current &&
        !ref.current.contains(event.target as Node)
      ) {
        setOpen(false)
      }
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    const onScroll = () => setOpen(false)

    document.addEventListener('mousedown', onOutside, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)

    return () => {
      document.removeEventListener(
        'mousedown',
        onOutside,
        true,
      )
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  const toggle = () => {
    if (!open && ref.current) {
      const rect =
        ref.current.getBoundingClientRect()

      setPosition({
        top: rect.bottom + 6,
        left: Math.max(8, rect.right - 160),
      })
    }

    setOpen((current) => !current)
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={`Meeting actions for ${meetingTitle}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        className={[
          'flex h-9 w-9 items-center justify-center rounded-lg text-text-muted outline-none transition hover:bg-surface-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus',
          open ? 'bg-surface-hover text-text' : '',
        ].join(' ')}
      >
        <span
          aria-hidden="true"
          className="material-symbols-outlined text-[18px]"
        >
          more_horiz
        </span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label={`Meeting actions for ${meetingTitle}`}
          style={{
            position: 'fixed',
            top: position.top,
            left: position.left,
          }}
          className="z-50 w-40 rounded-lg border border-border-subtle bg-surface p-1 shadow-md"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onOpen()
            }}
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm text-text outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
          >
            <span
              aria-hidden="true"
              className="material-symbols-outlined text-[17px] text-text-muted"
            >
              event
            </span>

            <span className="truncate">
              Open meeting
            </span>
          </button>
        </div>
      )}
    </div>
  )
}

/* ── One Upcoming row ──────────────────────────────────────────── */

/**
 * Exactly one prominent status badge per row. Precedence: the
 * lifecycle exception (`live` → In progress) over the schedule
 * exception (`rescheduled` → Rescheduled). The "Originally …" line
 * is secondary metadata, not a badge.
 */
function rowStatusBadge(item: UpcomingMeeting): {
  label: string
  className: string
} | null {
  if (item.status === 'live') {
    return {
      label: 'In progress',
      className:
        'inline-flex items-center rounded-full bg-status-active-bg px-2 py-0.5 text-[11px] font-medium text-status-active-text',
    }
  }

  if (item.rescheduled) {
    return {
      label: 'Rescheduled',
      className:
        'inline-flex items-center rounded-full bg-warning-bg px-2 py-0.5 text-[11px] font-medium text-warning',
    }
  }

  return null
}

function UpcomingMeetingRow({
  item,
  onOpenRow,
  pending,
}: {
  item: UpcomingMeeting
  onOpenRow: (item: UpcomingMeeting) => void
  /**
   * True while this row's explicit open intent is in flight (a
   * virtual occurrence being resolved into its concrete Meeting).
   * The row stays visible and its content intact — only the action
   * affordance is replaced by a subtle pending indicator, and
   * further activation is ignored until the request settles.
   */
  pending: boolean
}) {
  const concrete = item.meetingId != null
  // Every Upcoming row is openable: a row backed by a concrete
  // Meeting opens it directly; a virtual recurring occurrence opens
  // by resolving exactly that occurrence on explicit intent.
  const openable = concrete || item.recurring
  const timeLabel = formatUpcomingTime(item.scheduledAt)
  // Accessible identity of the concrete occurrence: title + EFFECTIVE
  // local date + local time, the same naming rule for concrete and
  // virtual rows. A rescheduled occurrence is identified by the slot
  // it actually occupies. No internal (virtual/materialized/occurrence
  // id) terminology is exposed.
  const dateLabel = formatUpcomingDate(item.scheduledAt)
  const badge = rowStatusBadge(item)
  const originallyLabel =
    item.rescheduled && item.originalScheduledAt != null
      ? formatOriginallyLabel(item.originalScheduledAt)
      : null
  // Participant data is available from the concrete Meeting only;
  // virtual occurrences carry no participant data and never render
  // a fabricated count.
  const people =
    concrete && item.participantIds.length > 0
      ? peopleLabel(item.participantIds.length)
      : null

  const hasSecondary =
    item.recurring ||
    badge != null ||
    originallyLabel != null ||
    people != null

  const open = () => {
    if (!pending) {
      onOpenRow(item)
    }
  }

  return (
    <div
      role={openable ? 'button' : undefined}
      tabIndex={openable ? 0 : undefined}
      aria-label={
        openable
          ? `Open ${item.title} on ${dateLabel} at ${timeLabel}`
          : undefined
      }
      aria-busy={pending || undefined}
      onClick={openable ? open : undefined}
      onKeyDown={
        openable
          ? (event) => {
              if (
                event.key === 'Enter' ||
                event.key === ' '
              ) {
                event.preventDefault()
                open()
              }
            }
          : undefined
      }
      className={[
        'grid min-h-[68px] grid-cols-1 items-center gap-x-4 gap-y-1.5 px-4 py-3 text-left outline-none',
        openable
          ? 'cursor-pointer transition select-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-focus'
          : '',
        // Tablet 768–1099px: Time + Meeting + Actions (People
        // folds into the secondary metadata); desktop ≥1100px:
        // four semantic columns.
        //
        // The two templates MUST use MUTUALLY EXCLUSIVE media
        // ranges (md:max-[1100px] vs min-[1100px]). Tailwind v4
        // emits the px-based arbitrary min-[1100px] block BEFORE
        // the rem-based md: block in the compiled CSS, so two
        // overlapping min-width rules for grid-template-columns
        // on the same element let the later md: rule win at
        // desktop widths: the row silently becomes the 3-column
        // tablet grid while the People cell is already
        // display:block — four visible children in three tracks
        // (Actions auto-places to a second row, People clips in
        // the 40px Actions track).
        'md:max-[1100px]:grid-cols-[88px_minmax(0,1fr)_40px]',
        'min-[1100px]:grid-cols-[104px_minmax(0,1fr)_96px_48px]',
      ].join(' ')}
    >
      <div className="text-sm font-semibold tabular-nums text-text">
        {timeLabel}
      </div>

      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-text">
          {item.title}
        </div>

        {hasSecondary && (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted min-[1100px]:flex-nowrap min-[1100px]:overflow-hidden">
            {item.recurring && (
              <span className="inline-flex shrink-0 items-center gap-1">
                <span
                  aria-hidden="true"
                  className="material-symbols-outlined text-[16px]"
                >
                  repeat
                </span>
                Recurring
              </span>
            )}

            {badge && (
              <span className={`shrink-0 ${badge.className}`}>
                {badge.label}
              </span>
            )}

            {originallyLabel && (
              <span className="min-w-0 truncate">
                {originallyLabel}
              </span>
            )}

            {people && (
              // Mobile + tablet only: the desktop ≥1100px layout
              // shows People in its own column.
              <span className="min-[1100px]:hidden">
                {people}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="hidden whitespace-nowrap text-left text-sm tabular-nums text-text-muted min-[1100px]:block">
        {people ?? ''}
      </div>

      <div className="flex justify-end md:justify-self-end">
        {pending ? (
          // Subtle per-row pending indicator: the action affordance
          // is replaced by a small spinner while the open intent is
          // in flight. The row content (time, title, metadata) is
          // untouched and the rest of the list stays fully
          // interactive.
          <span
            aria-hidden="true"
            className="material-symbols-outlined animate-spin text-[18px] text-text-muted"
          >
            refresh
          </span>
        ) : (
          openable && (
          <div
            onClick={(event) =>
              event.stopPropagation()
            }
            onPointerDown={(event) =>
              event.stopPropagation()
            }
          >
            <RowActionsMenu
              meetingTitle={item.title}
              onOpen={() => {
                if (!pending) {
                  onOpenRow(item)
                }
              }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

/* ── List shell: groups, skeleton, empty state ─────────────────── */

const SKELETON_ROWS = 5

function UpcomingSkeleton() {
  return (
    <section
      aria-busy="true"
      aria-label="Loading upcoming meetings"
      className="overflow-hidden rounded-[10px] border border-border-subtle bg-surface-quiet"
    >
      {Array.from({ length: SKELETON_ROWS }).map(
        (_, index) => (
          <div
            key={index}
            className={[
              'grid min-h-[68px] grid-cols-1 items-center gap-x-4 gap-y-1.5 px-4 py-3',
              // Same mutually-exclusive breakpoint contract as the
              // real row (see UpcomingMeetingRow).
              'md:max-[1100px]:grid-cols-[88px_minmax(0,1fr)_40px]',
              'min-[1100px]:grid-cols-[104px_minmax(0,1fr)_96px_48px]',
            ].join(' ')}
          >
            <div className="h-4 w-12 animate-pulse rounded bg-surface-muted" />

            <div className="min-w-0 space-y-2">
              <div className="h-4 w-2/3 max-w-64 animate-pulse rounded bg-surface-muted" />

              <div className="h-3 w-1/3 max-w-40 animate-pulse rounded bg-surface-muted" />
            </div>

            <div className="hidden h-3 w-10 animate-pulse rounded bg-surface-muted min-[1100px]:block" />
          </div>
        ),
      )}
    </section>
  )
}

function UpcomingEmptyState({
  onNewMeeting,
}: {
  onNewMeeting: () => void
}) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-[10px] border border-dashed border-border-default bg-surface-quiet px-6 py-12 text-center">
      <span className="material-symbols-outlined text-[30px] text-text-muted">
        event
      </span>

      <h2 className="mt-3 text-base font-semibold text-text">
        No upcoming meetings
      </h2>

      <p className="mt-1 text-sm text-text-muted">
        Schedule a meeting or create a recurring series.
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

/**
 * The Upcoming list. `loading` (concrete Meetings still loading)
 * renders the row skeletons; `recurrenceLoading` (concrete Meetings
 * settled, the personal recurring-occurrence feed still pending)
 * renders the settled groups plus one honest trailing indicator —
 * the page never pretends the recurrence feed succeeded.
 *
 * `onOpenRow` receives the whole row model for an EXPLICIT open
 * intent (row activation or the row's "Open meeting" action); the
 * parent decides whether that is a direct navigation (concrete
 * Meeting) or the resolution of a virtual occurrence. Rendering the
 * list never invokes it. `openingRowIds` marks the rows whose open
 * intent is still in flight (subtle per-row pending state).
 */
export function UpcomingMeetingsList({
  groups,
  loading,
  recurrenceLoading,
  onNewMeeting,
  onOpenRow,
  openingRowIds,
}: {
  groups: UpcomingDateGroup[]
  loading: boolean
  recurrenceLoading: boolean
  onNewMeeting: () => void
  onOpenRow: (item: UpcomingMeeting) => void
  openingRowIds: ReadonlySet<string>
}) {
  if (loading) {
    return <UpcomingSkeleton />
  }

  const hasItems = groups.length > 0

  if (!hasItems && !recurrenceLoading) {
    return <UpcomingEmptyState onNewMeeting={onNewMeeting} />
  }

  return (
    <section
      aria-label="Upcoming meetings"
      className="overflow-hidden rounded-[10px] border border-border-subtle bg-surface-quiet"
    >
      {groups.map((group, index) => (
        // ONE shared list container for every group: the date-group
        // hierarchy comes from spacing + the header surface +
        // typography — an ~8px gap before every group AFTER the
        // first, no per-day cards, no strong borders, and no
        // artificial leading gap before the first group.
        <div key={group.date} className={index > 0 ? 'mt-2' : ''}>
          <h3
            className={[
              'flex h-8 items-center border-b border-border-subtle bg-surface-header px-4 text-xs font-semibold',
              // The Today group gets slightly stronger text
              // emphasis (no badge, no accent bar); the other
              // groups stay secondary.
              group.kind === 'today'
                ? 'text-text'
                : 'text-text-muted',
            ].join(' ')}
          >
            {group.label}
          </h3>

          <div className="divide-y divide-border-subtle">
            {group.items.map((item) => (
              <UpcomingMeetingRow
                key={item.id}
                item={item}
                onOpenRow={onOpenRow}
                pending={openingRowIds.has(item.id)}
              />
            ))}
          </div>
        </div>
      ))}

      {recurrenceLoading && (
        <div className="flex items-center gap-2 border-t border-border-subtle px-4 py-3.5 text-xs text-text-muted">
          <span className="material-symbols-outlined animate-spin text-[16px]">
            refresh
          </span>
          Loading recurring meetings…
        </div>
      )}
    </section>
  )
}
