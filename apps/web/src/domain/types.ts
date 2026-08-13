// FG Workspace — MVP Domain Types
// Source of truth: docs/domain_model_v0.1.md

// ── User ──────────────────────────────────────────────────────────

/** A person using or participating in the workspace. */
export type User = {
  id: string
  displayName: string
  initials?: string
}

// ── Project ───────────────────────────────────────────────────────

export type ProjectStatus = 'active' | 'paused' | 'completed'

/** A project context for work. */
export type Project = {
  id: string
  name: string
  status: ProjectStatus
}

// ── Task ──────────────────────────────────────────────────────────

export type TaskStatus =
  | 'todo'
  | 'in_progress'
  | 'review'
  | 'blocked'
  | 'done'

/** Actionable work item. */
export type Task = {
  id: string
  title: string
  description?: string
  status: TaskStatus

  projectId?: string

  assigneeIds: string[]
  accountableId?: string
  watcherIds?: string[]

  dueDate?: string
  labels?: string[]

  sourceMeetingItemId?: string
}

// ── MeetingSeries ─────────────────────────────────────────────────

/** Reusable definition of a recurring meeting (e.g. "FG Weekly"). */
export type MeetingSeries = {
  id: string
  title: string
  type: string
}

// ── Meeting ───────────────────────────────────────────────────────

export type MeetingStatus = 'upcoming' | 'live' | 'completed'

/** One concrete meeting occurrence. */
export type Meeting = {
  id: string
  seriesId?: string

  title: string
  type: string
  date: string
  status: MeetingStatus

  moderatorId?: string
  participantIds: string[]
}

// ── Topic ─────────────────────────────────────────────────────────

export type TopicStatus = 'open' | 'resolved'

/** A durable discussion point that can exist across multiple meetings. */
export type Topic = {
  id: string
  title: string
  description?: string
  status: TopicStatus

  projectId?: string
  ownerId?: string
  labels?: string[]
}

// ── MeetingItem ───────────────────────────────────────────────────

export type MeetingItemStatus =
  | 'not_discussed'
  | 'discussing'
  | 'done'
  | 'follow_up'

export type MeetingItemKind = 'agenda' | 'spontaneous'

/** The appearance/discussion of a Topic or standalone point in one Meeting. */
export type MeetingItem = {
  id: string
  meetingId: string
  topicId?: string

  title: string
  notes?: string

  kind: MeetingItemKind
  status: MeetingItemStatus
  order: number

  linkedTaskIds: string[]
}
