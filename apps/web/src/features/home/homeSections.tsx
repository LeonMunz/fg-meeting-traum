import type { ReactNode } from 'react'

import type {
  ApiHomeAttentionReason,
  ApiHomeContinueWorkingCandidate,
  ApiHomeNeedsAttentionItem,
  ApiHomeTimelineCandidate,
} from '../../api/types'

import {
  attentionReasonLabels,
  domainIcon,
  formatClockTime,
  formatRelativeTime,
  formatShortDate,
  groupTimelineByDay,
  timelineDateLabel,
} from './homeFormat'

/*
 * Presentational Home primary-column sections.
 *
 * Home is a compact personal re-entry surface: the three primary
 * modules (Needs attention, Today & next, Continue working) render
 * directly on the page canvas — no section cards — separated by
 * subtle dividers. Rows are single keyboard-reachable buttons
 * (the canonical navigation target); no nested interactive elements.
 * Order, content, and eligibility come entirely from the Home API
 * payloads; the presentation only caps visible row counts.
 */

/* ── Presentation limits (frontend only; the API returns complete
 *    candidate sets in backend order, which is preserved) ────────── */

const ATTENTION_VISIBLE_LIMIT = 3
const TIMELINE_VISIBLE_LIMIT = 5
const CONTINUE_VISIBLE_LIMIT = 4

/* ── Shared section shell ─────────────────────────────────────── */

interface HomeSectionProps {
  id: string
  title: string
  /** Optional candidate count shown beside the heading (tertiary). */
  count?: number
  children: ReactNode
}

export function HomeSection({
  id,
  title,
  count,
  children,
}: HomeSectionProps) {
  const headingId = `${id}-heading`

  return (
    <section
      aria-labelledby={headingId}
      className="min-w-0 border-t border-border-subtle pt-7 first:border-t-0 first:pt-0"
    >
      <div className="flex items-baseline gap-2">
        <h2
          id={headingId}
          className="text-[15px] font-semibold leading-5 text-text"
        >
          {title}
        </h2>

        {typeof count === 'number' && count > 0 && (
          <span className="text-xs leading-4 text-text-tertiary">
            {count}
          </span>
        )}
      </div>

      <div className="mt-3">{children}</div>
    </section>
  )
}

export function SectionLoading() {
  return (
    <div
      role="status"
      className="flex items-center gap-2 py-2"
    >
      <span className="material-symbols-outlined animate-spin text-[16px] text-text-tertiary">
        refresh
      </span>

      <span className="text-[13px] leading-5 text-text-tertiary">
        Loading…
      </span>
    </div>
  )
}

function SectionEmptyLine({
  children,
}: {
  children: ReactNode
}) {
  return (
    <p className="py-2 text-[13px] leading-5 text-text-tertiary">
      {children}
    </p>
  )
}

/* ── Shared row pieces ────────────────────────────────────────── */

function RowButton({
  onClick,
  minHeight,
  children,
}: {
  onClick: () => void
  minHeight: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-md px-2 py-1 text-left transition hover:bg-surface-hover ${minHeight}`}
    >
      {children}
    </button>
  )
}

function RowIcon({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="material-symbols-outlined shrink-0 text-[20px] leading-none text-text-tertiary"
    >
      {name}
    </span>
  )
}

function RowTitle({ children }: { children: ReactNode }) {
  return (
    <span className="block truncate text-[13px] font-semibold leading-[18px] text-text">
      {children}
    </span>
  )
}

function RowMeta({ children }: { children: ReactNode }) {
  return (
    <span className="mt-0.5 block truncate text-[11px] leading-4 text-text-tertiary">
      {children}
    </span>
  )
}

function RowSide({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={`shrink-0 whitespace-nowrap text-[11px] leading-4 ${className}`}
    >
      {children}
    </span>
  )
}

/* ── Needs attention ──────────────────────────────────────────── */

function AttentionReasons({
  reasons,
}: {
  reasons: ApiHomeAttentionReason[]
}) {
  const overdue = reasons.includes('overdue')
  const blocked = reasons.includes('blocked')

  // Only the exception state carries semantic color: overdue reads
  // as danger, blocked-only as warning. Overdue dominates the tone
  // when both apply (it also sorts first in backend order).
  const danger = overdue
  const label =
    overdue && blocked
      ? `${attentionReasonLabels.overdue} · ${attentionReasonLabels.blocked}`
      : attentionReasonLabels[overdue ? 'overdue' : 'blocked']

  return (
    <RowSide
      className={
        danger
          ? 'font-medium text-danger'
          : 'font-medium text-warning'
      }
    >
      <span className="inline-flex items-center gap-1">
        <span className="material-symbols-outlined text-[14px]">
          {overdue ? 'event_busy' : 'block'}
        </span>
        {label}
      </span>
    </RowSide>
  )
}

export function NeedsAttentionSection({
  items,
  onOpenWorkItemProject,
}: {
  items: ApiHomeNeedsAttentionItem[]
  onOpenWorkItemProject: (projectId: number) => void
}) {
  // Presentation-only row cap, applied in backend order.
  const visible = items.slice(0, ATTENTION_VISIBLE_LIMIT)

  if (visible.length === 0) {
    // Zero candidates: the section does not render at all.
    return null
  }

  return (
    <HomeSection
      id="home-needs-attention"
      title="Needs attention"
      count={items.length}
    >
      <ul className="divide-y divide-border-subtle">
        {visible.map((item) => (
          <li key={item.workItemId}>
            <RowButton
              minHeight="min-h-12"
              onClick={() =>
                onOpenWorkItemProject(item.projectId)
              }
            >
              <RowIcon name="task_alt" />

              <span className="min-w-0 flex-1">
                <RowTitle>{item.title}</RowTitle>

                <RowMeta>
                  {item.projectName}
                  {item.dueDate && (
                    <>
                      {' · '}
                      Due {formatShortDate(item.dueDate)}
                    </>
                  )}
                </RowMeta>
              </span>

              <AttentionReasons
                reasons={item.attentionReasons}
              />
            </RowButton>
          </li>
        ))}
      </ul>
    </HomeSection>
  )
}

/* ── Today & next ─────────────────────────────────────────────── */

function meetingScopeLabel(scope: string): string {
  return scope === 'project'
    ? 'Project Meeting'
    : 'Research Group Meeting'
}

function TimelineRow({
  candidate,
  onOpenWorkItemProject,
  onOpenMeeting,
}: {
  candidate: ApiHomeTimelineCandidate
  onOpenWorkItemProject: (projectId: number) => void
  onOpenMeeting: (meetingId: number) => void
}) {
  const isMeeting = candidate.domain === 'meeting'

  function handleClick() {
    if (isMeeting && candidate.meeting) {
      onOpenMeeting(candidate.meeting.meetingId)
      return
    }

    if (!isMeeting && candidate.workItem) {
      onOpenWorkItemProject(candidate.workItem.projectId)
    }
  }

  return (
    <li>
      <RowButton
        minHeight="min-h-12"
        onClick={handleClick}
      >
        <RowIcon name={domainIcon(candidate.domain)} />

        <span className="min-w-0 flex-1">
          <RowTitle>{candidate.title}</RowTitle>

          <RowMeta>
            {isMeeting && candidate.meeting
              ? meetingScopeLabel(candidate.meeting.scope)
              : candidate.workItem
                ? candidate.workItem.projectName
                : null}
          </RowMeta>
        </span>

        <RowSide className="font-medium text-text-muted">
          {isMeeting && candidate.meeting
            ? formatClockTime(candidate.meeting.scheduledAt)
            : timelineDateLabel(candidate.calendarDate)}
        </RowSide>
      </RowButton>
    </li>
  )
}

export function TimelineSection({
  candidates,
  onOpenWorkItemProject,
  onOpenMeeting,
}: {
  candidates: ApiHomeTimelineCandidate[]
  onOpenWorkItemProject: (projectId: number) => void
  onOpenMeeting: (meetingId: number) => void
}) {
  // Presentation-only row cap, applied in backend order.
  const visible = candidates.slice(0, TIMELINE_VISIBLE_LIMIT)
  const groups = groupTimelineByDay(visible)

  return (
    <HomeSection
      id="home-today-next"
      title="Today & next"
      count={visible.length}
    >
      {visible.length === 0 ? (
        <SectionEmptyLine>
          Nothing upcoming in the current window.
        </SectionEmptyLine>
      ) : (
        <div>
          {groups.map(({ group, items }) => (
            <div key={group}>
              <div className="px-2 pb-1.5 pt-3 text-[10px] font-semibold uppercase leading-[14px] tracking-[0.12em] text-text-tertiary first:pt-0">
                {group}
              </div>

              <ul className="divide-y divide-border-subtle">
                {items.map((candidate) => (
                  <TimelineRow
                    key={`${candidate.domain}-${candidate.objectId}`}
                    candidate={candidate}
                    onOpenWorkItemProject={
                      onOpenWorkItemProject
                    }
                    onOpenMeeting={onOpenMeeting}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </HomeSection>
  )
}

/* ── Continue working ─────────────────────────────────────────── */

function ContinueWorkingRow({
  candidate,
  onOpenWorkItemProject,
  onOpenMeeting,
}: {
  candidate: ApiHomeContinueWorkingCandidate
  onOpenWorkItemProject: (projectId: number) => void
  onOpenMeeting: (meetingId: number) => void
}) {
  const isMeeting = candidate.domain === 'meeting'

  function handleClick() {
    if (isMeeting && candidate.meeting) {
      onOpenMeeting(candidate.meeting.meetingId)
      return
    }

    if (!isMeeting && candidate.workItem) {
      onOpenWorkItemProject(candidate.workItem.projectId)
    }
  }

  return (
    <li>
      <RowButton
        minHeight="min-h-[52px]"
        onClick={handleClick}
      >
        <RowIcon name={domainIcon(candidate.domain)} />

        <span className="min-w-0 flex-1">
          <RowTitle>{candidate.title}</RowTitle>

          <RowMeta>
            {isMeeting ? (
              'Meeting'
            ) : candidate.workItem ? (
              <>
                {candidate.workItem.projectName}
                {' · '}Work item
              </>
            ) : null}
          </RowMeta>
        </span>

        {/* Personal attributable recency — never "last opened". */}
        <RowSide className="text-text-muted">
          {formatRelativeTime(
            candidate.latestPersonalActivityAt,
          )}
        </RowSide>
      </RowButton>
    </li>
  )
}

export function ContinueWorkingSection({
  candidates,
  onOpenWorkItemProject,
  onOpenMeeting,
}: {
  candidates: ApiHomeContinueWorkingCandidate[]
  onOpenWorkItemProject: (projectId: number) => void
  onOpenMeeting: (meetingId: number) => void
}) {
  // Presentation-only row cap, applied in backend order.
  const visible = candidates.slice(0, CONTINUE_VISIBLE_LIMIT)

  return (
    <HomeSection
      id="home-continue-working"
      title="Continue working"
      count={visible.length}
    >
      {visible.length === 0 ? (
        <SectionEmptyLine>
          Recent work will appear here.
        </SectionEmptyLine>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {visible.map((candidate) => (
            <ContinueWorkingRow
              key={`${candidate.domain}-${candidate.objectId}`}
              candidate={candidate}
              onOpenWorkItemProject={
                onOpenWorkItemProject
              }
              onOpenMeeting={onOpenMeeting}
            />
          ))}
        </ul>
      )}
    </HomeSection>
  )
}
