import type { ReactNode } from 'react'

import type {
  ApiHomeAttentionReason,
  ApiHomeContinueWorkingCandidate,
  ApiHomeMyWorkItem,
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
  meetingStatusLabels,
  statusCategoryLabels,
} from './homeFormat'

/*
 * Presentational Home sections. All rows are single keyboard-reachable
 * buttons (the canonical navigation target); no nested interactive
 * elements. Order, content, and eligibility come entirely from the
 * Home API payloads.
 */

/* ── Shared section shell ─────────────────────────────────────── */

interface HomeSectionProps {
  id: string
  title: string
  description: string
  children: ReactNode
}

export function HomeSection({
  id,
  title,
  description,
  children,
}: HomeSectionProps) {
  const headingId = `${id}-heading`

  return (
    <section
      aria-labelledby={headingId}
      className="overflow-hidden rounded-xl border border-border-subtle bg-surface-quiet"
    >
      <div className="border-b border-border-subtle px-5 py-3.5 sm:px-6">
        <h2
          id={headingId}
          className="text-sm font-semibold text-text"
        >
          {title}
        </h2>

        <p className="mt-0.5 text-xs text-text-muted">
          {description}
        </p>
      </div>

      <div>{children}</div>
    </section>
  )
}

export function SectionEmpty({
  children,
}: {
  children: ReactNode
}) {
  return (
    <p className="px-5 py-7 text-center text-sm text-text-muted sm:px-6">
      {children}
    </p>
  )
}

export function SectionLoading() {
  return (
    <div
      role="status"
      className="flex items-center gap-2 px-5 py-6 sm:px-6"
    >
      <span className="material-symbols-outlined animate-spin text-[16px] text-text-muted">
        refresh
      </span>

      <span className="text-sm text-text-muted">
        Loading…
      </span>
    </div>
  )
}

/* ── Shared row pieces ────────────────────────────────────────── */

function RowButton({
  onClick,
  children,
}: {
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-start gap-3 px-5 py-3.5 text-left transition hover:bg-surface-hover sm:px-6"
    >
      {children}
    </button>
  )
}

function MutedMeta({
  children,
}: {
  children: ReactNode
}) {
  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-text-muted">
      {children}
    </span>
  )
}

function MetaDot() {
  return <span aria-hidden="true">·</span>
}

function BlockedIndicator({ label = 'Blocked' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 font-medium text-danger">
      <span className="material-symbols-outlined text-[13px]">
        block
      </span>
      {label}
    </span>
  )
}

/* ── Needs attention ──────────────────────────────────────────── */

function AttentionReasonChip({
  reason,
}: {
  reason: ApiHomeAttentionReason
}) {
  const overdue = reason === 'overdue'

  return (
    <span
      className={
        overdue
          ? 'inline-flex items-center gap-1 rounded-full bg-danger-subtle px-2 py-0.5 text-[11px] font-medium text-danger'
          : 'inline-flex items-center gap-1 rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-text'
      }
    >
      <span className="material-symbols-outlined text-[12px]">
        {overdue ? 'schedule' : 'block'}
      </span>
      {attentionReasonLabels[reason]}
    </span>
  )
}

export function NeedsAttentionSection({
  items,
  onOpenWorkItemProject,
}: {
  items: ApiHomeNeedsAttentionItem[]
  onOpenWorkItemProject: (projectId: number) => void
}) {
  return (
    <HomeSection
      id="home-needs-attention"
      title="Needs attention"
      description="Assigned work that is overdue or blocked."
    >
      {items.length === 0 ? (
        <SectionEmpty>
          Nothing currently requires your attention.
        </SectionEmpty>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {items.map((item) => (
            <li key={item.workItemId}>
              <RowButton
                onClick={() =>
                  onOpenWorkItemProject(item.projectId)
                }
              >
                <span className="material-symbols-outlined mt-0.5 shrink-0 text-[18px] text-danger">
                  warning
                </span>

                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-text">
                    {item.title}
                  </span>

                  <MutedMeta>
                    <span className="truncate">
                      {item.projectName}
                    </span>

                    {item.dueDate && (
                      <>
                        <MetaDot />
                        <span>
                          Due {formatShortDate(item.dueDate)}
                        </span>
                      </>
                    )}
                  </MutedMeta>

                  {item.blockedReason && (
                    <span className="mt-1 flex items-center gap-1 text-xs text-danger">
                      <span className="material-symbols-outlined text-[13px]">
                        block
                      </span>
                      <span className="truncate">
                        {item.blockedReason}
                      </span>
                    </span>
                  )}
                </span>

                <span className="flex shrink-0 flex-wrap justify-end gap-1">
                  {item.attentionReasons.map((reason) => (
                    <AttentionReasonChip
                      key={reason}
                      reason={reason}
                    />
                  ))}
                </span>
              </RowButton>
            </li>
          ))}
        </ul>
      )}
    </HomeSection>
  )
}

/* ── Today & next ─────────────────────────────────────────────── */

// Settled V1 Home presentation rule: at most 7 visible Today & next
// rows (frontend only; the API returns the complete candidate set).
const TIMELINE_VISIBLE_LIMIT = 7

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
      <RowButton onClick={handleClick}>
        <span className="material-symbols-outlined mt-0.5 shrink-0 text-[18px] text-text-muted">
          {domainIcon(candidate.domain)}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-text">
            {candidate.title}
          </span>

          <MutedMeta>
            {isMeeting && candidate.meeting ? (
              <span>
                {meetingScopeLabel(candidate.meeting.scope)}
              </span>
            ) : candidate.workItem ? (
              <span className="truncate">
                {candidate.workItem.projectName}
              </span>
            ) : null}
          </MutedMeta>
        </span>

        <span className="shrink-0 pt-0.5 text-xs font-medium text-text-muted">
          {isMeeting && candidate.meeting
            ? formatClockTime(candidate.meeting.scheduledAt)
            : formatShortDate(candidate.calendarDate)}
        </span>
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
      description="Work and meetings scheduled for the coming days."
    >
      {visible.length === 0 ? (
        <SectionEmpty>
          Nothing upcoming in the current window.
        </SectionEmpty>
      ) : (
        <div>
          {groups.map(({ group, items }) => (
            <div key={group}>
              <div className="px-5 pt-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted sm:px-6">
                {group}
              </div>

              <ul className="mt-1 divide-y divide-border-subtle">
                {items.map((candidate) => (
                  <TimelineRow
                    key={`${candidate.domain}-${candidate.objectId}`}
                    candidate={candidate}
                    onOpenWorkItemProject={onOpenWorkItemProject}
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

/* ── My work ──────────────────────────────────────────────────── */

const workItemTypeIcons: Record<string, string> = {
  epic: 'account_tree',
  milestone: 'flag',
  deliverable: 'inventory_2',
  task: 'check_box_outline_blank',
}

function workItemTypeIcon(typeName: string): string {
  return workItemTypeIcons[typeName.toLowerCase()] ?? 'task_alt'
}

export function MyWorkSection({
  items,
  onOpenWorkItemProject,
}: {
  items: ApiHomeMyWorkItem[]
  onOpenWorkItemProject: (projectId: number) => void
}) {
  return (
    <HomeSection
      id="home-my-work"
      title="My work"
      description="Your active assigned work items."
    >
      {items.length === 0 ? (
        <SectionEmpty>
          No active assigned work items.
        </SectionEmpty>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {items.map((item) => (
            <li key={item.workItemId}>
              <RowButton
                onClick={() =>
                  onOpenWorkItemProject(item.projectId)
                }
              >
                <span className="material-symbols-outlined mt-0.5 shrink-0 text-[18px] text-text-muted">
                  {workItemTypeIcon(item.typeName)}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-text">
                    {item.title}
                  </span>

                  <MutedMeta>
                    <span className="truncate">
                      {item.projectName}
                    </span>

                    <MetaDot />

                    <span>{item.typeName}</span>

                    {item.dueDate && (
                      <>
                        <MetaDot />
                        <span>
                          Due {formatShortDate(item.dueDate)}
                        </span>
                      </>
                    )}

                    {item.blockedReason && (
                      <BlockedIndicator />
                    )}
                  </MutedMeta>
                </span>

                <span className="shrink-0">
                  <span className="inline-flex rounded-full bg-surface-muted px-2.5 py-1 text-xs font-medium text-text">
                    {statusCategoryLabels[item.statusCategory] ??
                      item.statusCategory}
                  </span>
                </span>
              </RowButton>
            </li>
          ))}
        </ul>
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
      <RowButton onClick={handleClick}>
        <span className="material-symbols-outlined mt-0.5 shrink-0 text-[18px] text-text-muted">
          {domainIcon(candidate.domain)}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-text">
            {candidate.title}
          </span>

          <MutedMeta>
            {isMeeting && candidate.meeting ? (
              <span>
                {meetingStatusLabels[candidate.meeting.status] ??
                  candidate.meeting.status}
              </span>
            ) : candidate.workItem ? (
              <span className="truncate">
                {candidate.workItem.projectName}
              </span>
            ) : null}

            {isMeeting && candidate.meeting && (
              <>
                <MetaDot />
                <span>
                  {formatShortDate(
                    candidate.meeting.scheduledAt,
                  )}
                </span>
              </>
            )}
          </MutedMeta>
        </span>

        <span className="shrink-0 pt-0.5 text-xs text-text-muted">
          {formatRelativeTime(
            candidate.latestPersonalActivityAt,
          )}
        </span>
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
  return (
    <HomeSection
      id="home-continue-working"
      title="Continue working"
      description="Where you last made changes, based on your recent edits."
    >
      {candidates.length === 0 ? (
        <SectionEmpty>
          No recent attributable work.
        </SectionEmpty>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {candidates.map((candidate) => (
            <ContinueWorkingRow
              key={`${candidate.domain}-${candidate.objectId}`}
              candidate={candidate}
              onOpenWorkItemProject={onOpenWorkItemProject}
              onOpenMeeting={onOpenMeeting}
            />
          ))}
        </ul>
      )}
    </HomeSection>
  )
}
