// FG Workspace — Domain Types
// Source of truth: docs/domain/foundation.md + API contract

// ── Foundation: Identity & Research Group ─────────────────────────

/** Authenticated user (from API). */
export type User = {
  id: number
  username: string
  firstName: string
  lastName: string
  email: string
}

/** Research group membership role. */
export type ResearchGroupRole = 'admin' | 'member'

/** Research group (from API). */
export type ResearchGroup = {
  id: number
  name: string
  role: ResearchGroupRole
}

// ── Project (future: Foundation 2) ────────────────────────────────

export type ProjectStatus = 'active' | 'paused' | 'completed'

/** A project context for work. */
export type Project = {
  id: string
  name: string
  status: ProjectStatus
}

// ── Work Item (future: Foundation 3) ──────────────────────────────

export type WorkItemStatus =
  | 'todo'
  | 'in_progress'
  | 'review'
  | 'done'

export type WorkItemType =
  | 'epic'
  | 'milestone'
  | 'deliverable'
  | 'task'

/** Actionable work item. */
export type WorkItem = {
  id: string
  title: string
  description?: string
  type: WorkItemType
  status: WorkItemStatus

  projectId: string

  assigneeIds: string[]

  parentId?: string

  dueDate?: string
  blockedReason?: string
  completedAt?: string

  sourceMeetingItemId?: string
}

// ── Meeting (future) ──────────────────────────────────────────────

export type MeetingStatus = 'upcoming' | 'live' | 'completed'

/** One concrete meeting occurrence. */
export type Meeting = {
  id: string
  title: string
  date: string
  status: MeetingStatus
}
