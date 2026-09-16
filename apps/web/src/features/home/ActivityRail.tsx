import { useEffect, useRef, useState } from 'react'

import { ACTIVITY_DOMAINS } from '../../api/activity'
import type {
  ActivityDomain,
  ApiActivityEvent,
  ApiActivityUserRef,
} from '../../api/types'

import { formatRelativeTime } from './homeFormat'

/*
 * The Home Activity rail: a compact, visually secondary context
 * column over `GET /api/activity/` (fetched independently of Home).
 *
 * Desktop: a 320px sticky rail, separated from the primary column
 * by a subtle left divider (no card/panel surface), whose event
 * history scrolls inside the rail. Below the stacking breakpoint it
 * becomes a full-width stacked section with a top divider.
 *
 * Every event reads as a human sentence:
 *
 *     {Actor} {verb} {Object}
 *     {Context} · {relative time}
 *
 * It renders structured event semantics only — never the raw
 * `changes` payload — and never implies notification semantics.
 */

export interface ActivityRowTarget {
  kind: 'work_item_project' | 'meeting' | 'project'
  id: number
}

export interface ActivityRowDescription {
  actorName: string
  verb: string
  objectTitle: string | null
  context: string | null
  /** The user the operation acted upon (project / Research Group
   * membership events only); null for every other event kind. */
  subjectName: string | null
  target: ActivityRowTarget | null
}

/** User-facing category names for the domain filter. The backend
 * identifiers (`work_item`, ...) never surface in the UI. */
const ACTIVITY_DOMAIN_FILTER_LABELS: Record<
  'work_item' | 'meeting' | 'project' | 'research_group',
  string
> = {
  work_item: 'Work Items',
  meeting: 'Meetings',
  project: 'Projects',
  research_group: 'Research Groups',
}

// Stable machine event code -> concise user-facing verb. Unlisted
// codes fall back to a neutral verb (the feed is structured, never
// a rendered backend sentence).
const ACTIVITY_EVENT_VERBS: Record<string, string> = {
  'work_item.created': 'created',
  'work_item.updated': 'updated',
  'meeting.created': 'created',
  'meeting.rescheduled': 'rescheduled',
  'meeting.completed': 'completed',
  'meeting.agenda_item_added': 'added an agenda item to',
  'meeting.follow_up_scheduled': 'scheduled a follow-up for',
  'project.member_assignments_resolved': 'changed membership on',
  'project.ownership_resolved_for_offboarding':
    'transferred ownership of',
  'project.archived': 'archived',
  'project.restored': 'restored',
  'research_group.member_offboarded':
    'offboarded a member from',
}

function userDisplayName(user: ApiActivityUserRef): string {
  const name = [user.firstName, user.lastName]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ')

  return name || user.username
}

/**
 * Project one structured Activity event into a compact row
 * description. Uses the existing object target semantics: Work Item
 * events target the Work Item's Project read surface, Meeting events
 * target the Meeting, Project events target the Project.
 */
export function describeActivityEvent(
  event: ApiActivityEvent,
): ActivityRowDescription {
  const verb =
    ACTIVITY_EVENT_VERBS[event.eventType] ?? 'updated'

  const actorName = event.actor
    ? userDisplayName(event.actor)
    : 'Someone'

  const subjectName = event.subjectUser
    ? userDisplayName(event.subjectUser)
    : null

  if (
    event.workItemId != null &&
    event.workItemTitle
  ) {
    return {
      actorName,
      verb,
      objectTitle: event.workItemTitle,
      context: event.projectName,
      subjectName,
      target:
        event.projectId != null
          ? { kind: 'work_item_project', id: event.projectId }
          : null,
    }
  }

  if (event.meetingId != null && event.meetingTitle) {
    return {
      actorName,
      verb,
      objectTitle: event.meetingTitle,
      context: event.researchGroupName,
      subjectName,
      target: { kind: 'meeting', id: event.meetingId },
    }
  }

  if (event.projectId != null && event.projectName) {
    return {
      actorName,
      verb,
      objectTitle: event.projectName,
      context: event.researchGroupName,
      subjectName,
      target: { kind: 'project', id: event.projectId },
    }
  }

  if (event.researchGroupName) {
    return {
      actorName,
      verb,
      objectTitle: event.researchGroupName,
      context: null,
      subjectName,
      target: null,
    }
  }

  return {
    actorName,
    verb,
    objectTitle: null,
    context: null,
    subjectName,
    target: null,
  }
}

/** Compact neutral initials for the 24px actor mark. The Activity
 * contract carries no image URLs, so the mark is initials-only (no
 * avatar infrastructure). Unavailable actors fall back to "S". */
function actorInitials(displayName: string): string {
  const parts = displayName.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'S'

  const first = parts[0].charAt(0)
  const last =
    parts.length > 1 ? parts[parts.length - 1].charAt(0) : ''

  return (first + last).toUpperCase()
}

function ActivityRowContent({
  description,
  createdAt,
}: {
  description: ActivityRowDescription
  createdAt: string
}) {
  const metaParts = [
    description.context ?? '',
    description.subjectName
      ? `for ${description.subjectName}`
      : '',
    formatRelativeTime(createdAt),
  ].filter(Boolean)

  return (
    <div className="min-w-0">
      {/* Primary line: the human action sentence. Actor and object
       * carry emphasis; the verb stays quiet so the sentence reads
       * as one coherent statement. */}
      <p className="min-w-0 break-words text-[13px] leading-5 text-text">
        <span className="font-semibold">
          {description.actorName}
        </span>
        <span className="text-text-muted">
          {' '}
          {description.verb}
        </span>
        {description.objectTitle ? (
          <span className="font-semibold">
            {' '}
            {description.objectTitle}
          </span>
        ) : null}
      </p>

      {/* Secondary line: where + when, in reading order. */}
      {metaParts.length > 0 ? (
        <p className="mt-0.5 truncate text-[11px] leading-4 text-text-tertiary">
          {metaParts.join(' · ')}
        </p>
      ) : null}
    </div>
  )
}

const ROW_CLASSES =
  'grid w-full min-h-[52px] grid-cols-[24px_minmax(0,1fr)] items-start gap-x-3 rounded-md px-1.5 py-2 text-left'

function ActorMark({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-muted text-[10px] font-semibold leading-none text-text-muted"
    >
      {actorInitials(name)}
    </span>
  )
}

interface ActivityRailProps {
  events: ApiActivityEvent[]
  loading: boolean
  error: string | null
  onRetry: () => void
  onOpenWorkItemProject: (projectId: number) => void
  onOpenMeeting: (meetingId: number) => void
  /** Currently selected Activity domains (canonical order, 1..4). */
  domains: ActivityDomain[]
  onDomainsChange: (next: ActivityDomain[]) => void
}

function ActivityDomainFilter({
  domains,
  onDomainsChange,
}: {
  domains: ActivityDomain[]
  onDomainsChange: (next: ActivityDomain[]) => void
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  // A strict subset (1..3 of 4) is the "filter active" state.
  const isSubset = domains.length < ACTIVITY_DOMAINS.length

  useEffect(() => {
    if (!open) {
      return
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (
        event.target instanceof Node &&
        !containerRef.current?.contains(event.target)
      ) {
        setOpen(false)
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const toggleDomain = (
    domain: ActivityDomain,
    checked: boolean,
  ) => {
    const next = new Set(domains)

    if (checked) {
      next.add(domain)
    } else if (next.size > 1) {
      // At least one domain must remain selected: the final
      // selected domain can never be deselected (no empty-filter
      // state is ever represented or requested).
      next.delete(domain)
    }

    onDomainsChange(
      ACTIVITY_DOMAINS.filter((candidate) => next.has(candidate)),
    )
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Filter activity"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-pressed={isSubset}
        onClick={() => setOpen((current) => !current)}
        className={[
          'relative flex h-7 w-7 items-center justify-center rounded-md transition',
          'hover:bg-surface-hover',
          open
            ? 'bg-surface-hover text-text'
            : isSubset
              ? 'text-text'
              : 'text-text-tertiary',
          'focus-visible:outline-2 focus-visible:outline focus-visible:outline-focus focus-visible:outline-offset-1',
        ].join(' ')}
      >
        <span
          aria-hidden="true"
          className="material-symbols-outlined text-[15px]"
        >
          tune
        </span>

        {/* Restrained active-filter mark: only for a strict subset,
         * never for the default all-domains state. */}
        {isSubset && (
          <span
            aria-hidden="true"
            className="absolute right-0.5 top-0.5 h-1 w-1 rounded-full bg-accent"
          />
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Filter activity"
          className="absolute right-0 top-[calc(100%+6px)] z-50 w-56 rounded-md border border-border-subtle bg-surface p-3 shadow-[0_12px_32px_rgba(0,0,0,0.32)]"
        >
          <p className="text-[13px] font-semibold leading-5 text-text">
            Filter activity
          </p>

          <fieldset className="mt-1.5">
            <legend className="mb-1 text-[11px] font-semibold leading-4 text-text-tertiary">
              Show
            </legend>

            {ACTIVITY_DOMAINS.map((domain) => (
              <label
                key={domain}
                className={[
                  'flex h-8 items-center gap-2 rounded-md px-2 text-[13px] font-medium leading-4 transition',
                  domains.includes(domain) && domains.length === 1
                    ? 'cursor-not-allowed text-text-tertiary'
                    : 'cursor-pointer text-text hover:bg-surface-muted',
                ].join(' ')}
              >
                <input
                  type="checkbox"
                  checked={domains.includes(domain)}
                  disabled={
                    domains.includes(domain) &&
                    domains.length === 1
                  }
                  onChange={(event) =>
                    toggleDomain(domain, event.target.checked)
                  }
                  className="h-4 w-4 shrink-0 rounded border-border-field accent-control-accent"
                />

                <span>
                  {ACTIVITY_DOMAIN_FILTER_LABELS[domain]}
                </span>
              </label>
            ))}
          </fieldset>

          {isSubset && (
            <button
              type="button"
              onClick={() =>
                onDomainsChange([...ACTIVITY_DOMAINS])
              }
              className="mt-1.5 inline-flex h-7 items-center rounded-md border border-border-subtle px-2.5 text-[11px] font-semibold text-text transition hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline focus-visible:outline-focus"
            >
              Reset
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function ActivityRail({
  events,
  loading,
  error,
  onRetry,
  onOpenWorkItemProject,
  onOpenMeeting,
  domains,
  onDomainsChange,
}: ActivityRailProps) {
  const headingId = 'home-activity-heading'

  return (
    <section
      aria-labelledby={headingId}
      className="border-t border-border-subtle pt-7 xl:border-l xl:border-t-0 xl:pl-6 xl:pt-0"
    >
      {/* Sticky at desktop width only: the rail follows the primary
       * column while Home scrolls, and the event history below the
       * header scrolls inside the rail. */}
      <div className="xl:sticky xl:top-20">
        <div className="mb-4">
          {/* Header row: the heading stays the anchor; the compact
           * filter control is visually secondary and never widens
           * the 320px rail. */}
          <div className="flex items-center justify-between gap-2">
            <h2
              id={headingId}
              className="text-[15px] font-semibold leading-5 text-text"
            >
              Activity
            </h2>

            <ActivityDomainFilter
              domains={domains}
              onDomainsChange={onDomainsChange}
            />
          </div>

          <p className="mt-0.5 text-[11px] leading-4 text-text-tertiary">
            Latest changes across your work.
          </p>
        </div>

        <div className="xl:max-h-[calc(100dvh-112px)] xl:overflow-y-auto">
          {loading ? (
            <div role="status" aria-label="Loading activity">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="grid grid-cols-[24px_minmax(0,1fr)] items-start gap-x-3 border-b border-border-subtle px-1.5 py-2"
                >
                  <span className="h-6 w-6 animate-pulse rounded-full bg-surface-muted" />

                  <span className="flex w-full flex-col gap-1.5 pt-0.5">
                    <span className="h-3 w-4/5 animate-pulse rounded bg-surface-muted" />

                    <span className="h-2.5 w-3/5 animate-pulse rounded bg-surface-muted" />
                  </span>
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="px-1.5 py-2" role="alert">
              <p className="text-[13px] font-medium text-text">
                Activity couldn't be loaded.
              </p>

              <p className="mt-0.5 break-words text-[11px] text-text-tertiary">
                {error}
              </p>

              <button
                type="button"
                onClick={onRetry}
                className="mt-2.5 inline-flex h-7 items-center gap-1.5 rounded-md border border-border-subtle px-2.5 text-[11px] font-semibold text-text transition hover:bg-surface-hover"
              >
                <span
                  aria-hidden="true"
                  className="material-symbols-outlined text-[14px]"
                >
                  refresh
                </span>
                Try again
              </button>
            </div>
          ) : events.length === 0 ? (
            <p className="px-1.5 py-3 text-[13px] leading-5 text-text-tertiary">
              No recent activity.
            </p>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {events.map((event) => {
                const description =
                  describeActivityEvent(event)
                const target = description.target

                return (
                  <li key={event.id}>
                    {target?.kind === 'meeting' ? (
                      <button
                        type="button"
                        onClick={() =>
                          onOpenMeeting(target.id)
                        }
                        className={`${ROW_CLASSES} transition hover:bg-surface-hover`}
                      >
                        <ActorMark name={description.actorName} />

                        <ActivityRowContent
                          description={description}
                          createdAt={event.createdAt}
                        />
                      </button>
                    ) : target?.kind === 'work_item_project' ||
                      target?.kind === 'project' ? (
                      <button
                        type="button"
                        onClick={() =>
                          onOpenWorkItemProject(target.id)
                        }
                        className={`${ROW_CLASSES} transition hover:bg-surface-hover`}
                      >
                        <ActorMark name={description.actorName} />

                        <ActivityRowContent
                          description={description}
                          createdAt={event.createdAt}
                        />
                      </button>
                    ) : (
                      <div className={ROW_CLASSES}>
                        <ActorMark name={description.actorName} />

                        <ActivityRowContent
                          description={description}
                          createdAt={event.createdAt}
                        />
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  )
}
