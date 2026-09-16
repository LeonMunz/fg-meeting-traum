import type {
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
}

export function ActivityRail({
  events,
  loading,
  error,
  onRetry,
  onOpenWorkItemProject,
  onOpenMeeting,
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
          <h2
            id={headingId}
            className="text-[15px] font-semibold leading-5 text-text"
          >
            Activity
          </h2>

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
                <span className="material-symbols-outlined text-[14px]">
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
