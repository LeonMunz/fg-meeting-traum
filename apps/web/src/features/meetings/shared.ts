/* Small presentation helpers shared by the Meeting Detail
   layouts (classic + Completed recap). These are formatting
   only: no domain logic, no API access. */

import type {
  ApiLinkedWorkItem,
  ApiMeetingItem,
} from '../../api/types'

export function formatMeetingDate(value: string) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat('en', {
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(date)
}

// Compact "Sat, Sep 5 · 02:36" form used by the Completed recap
// header. The Upcoming / Live headers keep the full dateStyle.
export function formatMeetingDateCompact(value: string) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  const dayPart = new Intl.DateTimeFormat('en', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date)

  const timePart = new Intl.DateTimeFormat('en', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)

  return `${dayPart} · ${timePart}`
}

export function formatNoteTime(value: string) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat('en', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

export function getPersonName(person: {
  firstName: string
  lastName: string
  username: string
}) {
  const fullName = [
    person.firstName,
    person.lastName,
  ]
    .filter(Boolean)
    .join(' ')
    .trim()

  return fullName || person.username
}

/* ── Completed Meeting: duration + outcome helpers ───────────── */

export function meetingDurationMinutes(
  startedAt: string | null,
  endedAt: string | null,
): number | null {
  if (startedAt == null || endedAt == null) {
    return null
  }

  const start = new Date(startedAt).getTime()
  const end = new Date(endedAt).getTime()

  if (
    Number.isNaN(start) ||
    Number.isNaN(end) ||
    end < start
  ) {
    return null
  }

  const minutes = Math.round((end - start) / 60_000)

  // A zero or negative computed duration is not reliable.
  return minutes > 0 ? minutes : null
}

export function formatMeetingDuration(
  minutes: number | null,
): string | null {
  if (minutes == null) {
    return null
  }

  if (minutes < 60) {
    return `${minutes} min`
  }

  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60

  return rest > 0
    ? `${hours} h ${rest} min`
    : `${hours} h`
}

// Compact "9h 52m" / "49m" form for the Completed recap header.
export function formatMeetingDurationCompact(
  minutes: number | null,
): string | null {
  if (minutes == null) {
    return null
  }

  if (minutes < 60) {
    return `${minutes}m`
  }

  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60

  return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`
}

export interface MeetingOutcomeCounts {
  workItems: number
  followUps: number
}

// Non-zero outcome categories only, in canonical order. Empty
// when there is nothing to report (the caller renders nothing).
export function completedOutcomeCountParts(
  counts: MeetingOutcomeCounts,
): string[] {
  const parts: string[] = []

  if (counts.workItems > 0) {
    parts.push(
      `${counts.workItems} ${
        counts.workItems === 1
          ? 'resulting work item'
          : 'resulting work items'
      }`,
    )
  }

  if (counts.followUps > 0) {
    parts.push(
      `${counts.followUps} ${
        counts.followUps === 1 ? 'follow-up' : 'follow-ups'
      }`,
    )
  }

  return parts
}

// Union of one agenda item's direct MeetingItem -> Work Item
// links and the primary Work Items of its Notes, deduplicated by
// canonical Work Item id. Only Work Items with hydrated display
// data are included.
export function itemResultingWork(
  item: ApiMeetingItem,
  workById: Map<number, ApiLinkedWorkItem>,
): ApiLinkedWorkItem[] {
  const ordered = new Map<number, ApiLinkedWorkItem>()

  for (const workItemId of item.workItemIds) {
    const linked = workById.get(workItemId)
    if (linked != null && !ordered.has(workItemId)) {
      ordered.set(workItemId, linked)
    }
  }

  for (const note of item.notes ?? []) {
    const linked = note.linkedWorkItem
    if (linked != null && !ordered.has(linked.id)) {
      ordered.set(linked.id, linked)
    }
  }

  return [...ordered.values()]
}
