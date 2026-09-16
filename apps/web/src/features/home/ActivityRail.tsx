import type {
  ApiActivityEvent,
  ApiActivityUserRef,
} from '../../api/types'

import { formatRelativeTime } from './homeFormat'

/*
 * The Home Activity rail: a compact, secondary awareness/history
 * feed over `GET /api/activity/` (fetched independently of Home).
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

function ActivityRowContent({
  description,
  createdAt,
}: {
  description: ActivityRowDescription
  createdAt: string
}) {
  return (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-xs font-semibold text-text">
          {description.objectTitle ?? 'Activity'}
        </span>

        <span className="shrink-0 text-[11px] text-text-muted">
          {formatRelativeTime(createdAt)}
        </span>
      </div>

      <div className="mt-0.5 truncate text-[11px] text-text-muted">
        {description.actorName} {description.verb}
        {description.context
          ? ` · ${description.context}`
          : ''}
        {description.subjectName
          ? ` · for ${description.subjectName}`
          : ''}
      </div>
    </>
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
      className="overflow-hidden rounded-xl border border-border-subtle bg-surface-quiet"
    >
      <div className="border-b border-border-subtle px-4 py-3.5">
        <h2
          id={headingId}
          className="text-sm font-semibold text-text"
        >
          Activity
        </h2>

        <p className="mt-0.5 text-xs text-text-muted">
          Recent activity you can see.
        </p>
      </div>

      {loading ? (
        <div
          role="status"
          className="flex items-center gap-2 px-4 py-6"
        >
          <span className="material-symbols-outlined animate-spin text-[16px] text-text-muted">
            refresh
          </span>

          <span className="text-sm text-text-muted">
            Loading…
          </span>
        </div>
      ) : error ? (
        <div className="px-4 py-6" role="alert">
          <p className="text-sm font-medium text-text">
            Activity couldn't be loaded.
          </p>

          <p className="mt-1 text-xs text-text-muted">
            {error}
          </p>

          <button
            type="button"
            onClick={onRetry}
            className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg border border-border-subtle px-3 text-xs font-semibold text-text transition hover:bg-surface-hover"
          >
            <span className="material-symbols-outlined text-[15px]">
              refresh
            </span>
            Try again
          </button>
        </div>
      ) : events.length === 0 ? (
        <p className="px-4 py-7 text-center text-sm text-text-muted">
          No visible recent activity.
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
                    className="w-full px-4 py-2.5 text-left transition hover:bg-surface-hover"
                  >
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
                      onOpenWorkItemProject(
                        target.id,
                      )
                    }
                    className="w-full px-4 py-2.5 text-left transition hover:bg-surface-hover"
                  >
                    <ActivityRowContent
                      description={description}
                      createdAt={event.createdAt}
                    />
                  </button>
                ) : (
                  <div className="px-4 py-2.5">
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
    </section>
  )
}
