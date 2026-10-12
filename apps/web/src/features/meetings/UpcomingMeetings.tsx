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

import type { UpcomingMeeting } from './upcomingModel'
import {
  formatOriginallyLabel,
  formatUpcomingDate,
  formatUpcomingTime,
  peopleLabel,
} from './upcomingGroups'

import type { UpcomingDateGroup } from './upcomingGroups'
import './UpcomingMeetings.css'

/* ── Row actions ───────────────────────────────────────────────── */

/**
 * Direct Edit affordance for a concrete Meeting row the server
 * says the user may edit (`actionPermissions.canEdit` — never
 * inferred client-side). A small, restrained icon action: 16px
 * outline pencil, ~32×32px hit area, neutral muted default, subtle
 * hover background and focus-visible ring. It is revealed with the
 * row on pointer devices (group-hover / group-focus-within) and is
 * always visible on direct-manipulation (touch) devices via the
 * `(hover: none)` rule in `UpcomingMeetings.css`.
 *
 * Activation (click OR keyboard) never activates the parent row:
 * the owning action group stops pointer events at its border, and
 * this button stops Enter/Space keydown so the row's own open
 * handler never fires.
 */
function RowEditAction({
  item,
  onEditMeeting,
}: {
  item: UpcomingMeeting
  onEditMeeting: (item: UpcomingMeeting) => void
}) {
  return (
    <button
      type="button"
      aria-label={`Edit ${item.title}`}
      onClick={() => onEditMeeting(item)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.stopPropagation()
        }
      }}
      className={[
        'fg-upcoming-row-action flex h-8 w-8 items-center justify-center rounded-lg text-text-muted opacity-0 outline-none transition',
        'hover:bg-surface-hover hover:text-text',
        'focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-focus',
        'group-hover:opacity-100 group-focus-within:opacity-100',
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className="fg-upcoming-row-icon material-symbols-outlined"
      >
        edit
      </span>
    </button>
  )
}

/**
 * Direct destructive affordance for a concrete Meeting row the
 * server marks deletable (`actionPermissions.canDelete` — a
 * standalone Meeting, permanent delete) or cancellable
 * (`actionPermissions.canCancel` — a materialized recurring
 * occurrence, dedicated cancellation of THIS occurrence only).
 * Same compact shape as the Edit action; the red destructive
 * emphasis is reserved for the hover / focus treatment — the
 * resting state stays neutral. The accessible label names the
 * operation the server actually allows: `Delete …` for a
 * standalone Meeting, `Cancel …` for a materialized recurring
 * occurrence. It is never rendered for virtual occurrences and
 * never inferred from any other row data.
 */
function RowDestructiveAction({
  item,
  onDestructiveAction,
}: {
  item: UpcomingMeeting
  onDestructiveAction: (item: UpcomingMeeting) => void
}) {
  const cancellable =
    item.actionPermissions?.canCancel === true

  return (
    <button
      type="button"
      aria-label={
        cancellable
          ? `Cancel ${item.title}`
          : `Delete ${item.title}`
      }
      onClick={() => onDestructiveAction(item)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.stopPropagation()
        }
      }}
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
  )
}

/**
 * Direct single-occurrence exclusion affordance for a VIRTUAL
 * recurring occurrence the server's feed marks excludable
 * (`canExclude` — the canonical scoped write rule of the
 * recurrence's scope; never inferred from creator identity, feed
 * visibility, or the concrete Meeting permission set).
 *
 * Exactly the same compact shape as the concrete destructive
 * action: 16px `delete` glyph, ~32×32px hit area, neutral at rest,
 * red destructive emphasis on hover / focus, revealed with the row
 * on pointer devices and always visible on touch devices. The
 * accessible label names the operation and identifies the
 * individual occurrence (title + its local date).
 *
 * Activation (click OR keyboard) never activates the parent row,
 * so it can NEVER trigger Open / materialization: the owning
 * wrapper stops pointer events at its border, and the button stops
 * Enter/Space keydown. It renders for a virtual occurrence ONLY
 * when `canExclude` is exactly `true`; a missing or false value
 * never enables the destructive action.
 */
function RowExcludeAction({
  item,
  dateLabel,
  onExcludeOccurrence,
}: {
  item: UpcomingMeeting
  dateLabel: string
  onExcludeOccurrence: (item: UpcomingMeeting) => void
}) {
  return (
    <button
      type="button"
      aria-label={`Skip ${item.title} on ${dateLabel}`}
      onClick={() => onExcludeOccurrence(item)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.stopPropagation()
        }
      }}
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
  )
}

/**
 * The compact horizontal action group for a concrete Meeting row:
 * the Edit pencil (server `canEdit`) and the destructive trash
 * (server `canDelete` or `canCancel` — at most one of which the
 * server can grant). The GROUP — not an individual button — stops
 * pointer events at its border, so activating an action never
 * triggers the row's open intent.
 *
 * Concrete rows carry this group INSTEAD of the three-dot
 * overflow menu: the row itself remains openable, and the
 * server's permission set decides exactly which direct actions
 * appear. A concrete row with no granted action renders nothing
 * here (its Actions region stays present but empty).
 */
function RowActionGroup({
  item,
  onEditMeeting,
  onDestructiveAction,
}: {
  item: UpcomingMeeting
  onEditMeeting: (item: UpcomingMeeting) => void
  onDestructiveAction: (item: UpcomingMeeting) => void
}) {
  const permissions = item.actionPermissions
  const editable = permissions?.canEdit === true
  const destructive =
    permissions?.canDelete === true ||
    permissions?.canCancel === true

  if (!editable && !destructive) {
    return null
  }

  return (
    <div
      className="flex items-center gap-1"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {editable && (
        <RowEditAction
          item={item}
          onEditMeeting={onEditMeeting}
        />
      )}

      {destructive && (
        <RowDestructiveAction
          item={item}
          onDestructiveAction={onDestructiveAction}
        />
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
        'inline-flex items-center rounded-full bg-status-active-bg px-2 py-0.5 fg-type-micro text-status-active-text',
    }
  }

  if (item.rescheduled) {
    return {
      label: 'Rescheduled',
      className:
        'inline-flex items-center rounded-full bg-warning-bg px-2 py-0.5 fg-type-micro text-warning',
    }
  }

  return null
}

function UpcomingMeetingRow({
  item,
  onOpenRow,
  onEditMeeting,
  onDestructiveAction,
  pending,
}: {
  item: UpcomingMeeting
  onOpenRow: (item: UpcomingMeeting) => void
  onEditMeeting: (item: UpcomingMeeting) => void
  onDestructiveAction: (item: UpcomingMeeting) => void
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
  // The direct row actions (Edit pencil / destructive trash) appear
  // ONLY on concrete rows, driven exclusively by the server-derived
  // `actionPermissions` — never on a virtual occurrence (which
  // keeps its Open affordance) and never inferred from any other
  // row data, creator / participant ids, Project roles, or
  // recurrence provenance.
  const permissions = item.actionPermissions
  const hasDirectActions =
    concrete &&
    (permissions?.canEdit === true ||
      permissions?.canDelete === true ||
      permissions?.canCancel === true)
  // The virtual single-occurrence exclusion action appears ONLY on
  // virtual rows, driven exclusively by the server's feed report
  // (`canExclude` — the canonical scoped write rule of the
  // recurrence's scope). It is never inferred from creator /
  // participant ids, Project roles, the concrete Meeting permission
  // set, or any other row data — a missing or false value never
  // enables the destructive action.
  const hasVirtualExclusion =
    !concrete && item.recurring && item.canExclude === true
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
        // `group` drives the row-hover reveal of the Edit action on
        // pointer devices.
        'group grid min-h-[68px] grid-cols-1 items-center gap-x-4 gap-y-1.5 px-4 py-3 text-left outline-none',
        openable
          ? 'cursor-pointer transition select-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-focus'
          : '',
        // Tablet 768–1099px: Time + Meeting + Actions (People
        // folds into the secondary metadata); desktop ≥1100px:
        // four semantic columns. The Actions track (72px) holds the
        // compact direct action group — up to two 32px icon
        // actions with a 4px gap — or the single 32px exclusion
        // action of a virtual occurrence row the server marks
        // excludable.
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
        'md:max-[1100px]:grid-cols-[88px_minmax(0,1fr)_72px]',
        'min-[1100px]:grid-cols-[104px_minmax(0,1fr)_96px_72px]',
      ].join(' ')}
    >
      <div className="fg-type-record-title tabular-nums text-text">
        {timeLabel}
      </div>

      <div className="min-w-0">
        <div className="truncate fg-type-record-title text-text">
          {item.title}
        </div>

        {hasSecondary && (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 fg-type-meta text-text-muted min-[1100px]:flex-nowrap min-[1100px]:overflow-hidden">
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

      <div className="hidden whitespace-nowrap text-left fg-type-meta tabular-nums text-text-muted min-[1100px]:block">
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
        ) : concrete ? (
          // Concrete row: the compact direct action group (Edit /
          // destructive) — NO three-dot menu. A concrete row with no
          // server-granted action keeps its four-region geometry
          // with an empty Actions region and stays openable as a
          // whole.
          hasDirectActions && (
            <RowActionGroup
              item={item}
              onEditMeeting={onEditMeeting}
              onDestructiveAction={onDestructiveAction}
            />
          )
        ) : openable ? (
          // Virtual occurrence: NO three-dot menu. The only row
          // action is the direct single-occurrence exclusion, and
          // ONLY when the server's feed report grants it
          // (`canExclude` — never invented). The row itself stays
          // fully openable (Open is the explicit intent that
          // resolves the occurrence), and a virtual occurrence
          // without the granted exclusion keeps an empty Actions
          // region.
          hasVirtualExclusion && (
            <div
              onClick={(event) =>
                event.stopPropagation()
              }
              onPointerDown={(event) =>
                event.stopPropagation()
              }
            >
              <RowExcludeAction
                item={item}
                dateLabel={dateLabel}
                onExcludeOccurrence={
                  onDestructiveAction
                }
              />
            </div>
          )
        ) : null}
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
            'md:max-[1100px]:grid-cols-[88px_minmax(0,1fr)_72px]',
            'min-[1100px]:grid-cols-[104px_minmax(0,1fr)_96px_72px]',
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
      <span className="material-symbols-outlined text-[24px] text-text-muted">
        event
      </span>

      <h2 className="mt-3 fg-type-section-heading text-text">
        No upcoming meetings
      </h2>

      <p className="mt-1 fg-type-primary-content text-text-muted">
        Schedule a meeting or create a recurring series.
      </p>

      <button
        type="button"
        onClick={onNewMeeting}
        className="mt-5 inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-4 fg-type-control text-text-inverse transition hover:bg-accent-hover"
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
 * intent (row activation, pointer or keyboard); the parent decides
 * whether that is a direct navigation (concrete Meeting) or the
 * resolution of a virtual occurrence. Rendering the list never
 * invokes it. `onEditMeeting` receives the row model for an
 * EXPLICIT edit intent (the row's direct Edit action, which renders
 * only on concrete rows with server-derived
 * `actionPermissions.canEdit`); it never fires for virtual
 * occurrences and never materializes one. `onDestructiveAction`
 * receives the row model for an EXPLICIT destructive intent — the
 * concrete row's trash action (server-derived
 * `actionPermissions.canDelete` / `canCancel`) or the virtual row's
 * single-occurrence exclusion (server feed-derived `canExclude`);
 * the parent owns the confirmation dialog and the request — the
 * list never mutates. `openingRowIds` marks the rows whose open
 * intent is still in flight (subtle per-row pending state).
 */
export function UpcomingMeetingsList({
  groups,
  loading,
  recurrenceLoading,
  onNewMeeting,
  onOpenRow,
  onEditMeeting,
  onDestructiveAction,
  openingRowIds,
}: {
  groups: UpcomingDateGroup[]
  loading: boolean
  recurrenceLoading: boolean
  onNewMeeting: () => void
  onOpenRow: (item: UpcomingMeeting) => void
  onEditMeeting: (item: UpcomingMeeting) => void
  onDestructiveAction: (item: UpcomingMeeting) => void
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
                onEditMeeting={onEditMeeting}
                onDestructiveAction={onDestructiveAction}
                pending={openingRowIds.has(item.id)}
              />
            ))}
          </div>
        </div>
      ))}

      {recurrenceLoading && (
        <div className="flex items-center gap-2 border-t border-border-subtle px-4 py-3.5 fg-type-meta text-text-muted">
          <span className="material-symbols-outlined animate-spin text-[16px]">
            refresh
          </span>
          Loading recurring meetings…
        </div>
      )}
    </section>
  )
}
