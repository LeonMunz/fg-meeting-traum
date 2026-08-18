/** API request and response types. */

export interface ApiError {
  error: string
}

/* ── Identity ──────────────────────────────────────────────────── */

export interface ApiUser {
  id: number
  username: string
  firstName: string
  lastName: string
  email: string
}

/* ── Research Group ────────────────────────────────────────────── */

export type ApiResearchGroupRole = 'admin' | 'member'

export interface ApiResearchGroup {
  id: number
  name: string
  role: ApiResearchGroupRole
}

export interface ApiResearchGroupMember {
  id: number
  username: string
  firstName: string
  lastName: string
  researchGroupRole: ApiResearchGroupRole
}

/* ── Project ───────────────────────────────────────────────────── */

export type ApiProjectStatus =
  | 'active'
  | 'paused'
  | 'completed'

export type ApiProjectRole =
  | 'owner'
  | 'member'
  | 'viewer'

export interface ApiProject {
  id: number
  researchGroupId: number
  name: string
  description: string
  status: ApiProjectStatus
  currentUserRole: ApiProjectRole
  createdAt: string
  updatedAt: string
}

export interface ApiCreateProjectInput {
  name: string
  description?: string
  status?: ApiProjectStatus
}

export interface ApiUpdateProjectInput {
  name?: string
  description?: string
  status?: ApiProjectStatus
}

/* ── Project Membership ────────────────────────────────────────── */

export interface ApiProjectMembershipUser {
  id: number
  username: string
  firstName: string
  lastName: string
}

export interface ApiProjectMembership {
  id: number
  role: ApiProjectRole
  addedAt: string | null
  user: ApiProjectMembershipUser
}

export interface ApiAddProjectMembershipInput {
  userId: number
  role?: ApiProjectRole
}

export interface ApiUpdateProjectMembershipInput {
  role: ApiProjectRole
}

export interface ApiDeleteProjectMembershipResponse {
  detail: string
}

/* ── Work Item ─────────────────────────────────────────────────── */

export type ApiWorkItemType =
  | 'epic'
  | 'milestone'
  | 'deliverable'
  | 'task'

export type ApiWorkItemStatus =
  | 'todo'
  | 'in_progress'
  | 'review'
  | 'done'

export interface ApiWorkItem {
  id: number
  projectId: number
  type: ApiWorkItemType
  title: string
  description: string
  status: ApiWorkItemStatus
  assigneeIds: number[]
  parentId: number | null
  dueDate: string | null
  blockedReason: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
  createdById: number
}

export interface ApiPersonalWorkItem extends ApiWorkItem {
  projectName: string
  researchGroupId: number
  researchGroupName: string
}

export interface ApiCreateWorkItemInput {
  type: ApiWorkItemType
  title: string
  description?: string
  status?: ApiWorkItemStatus
  assigneeIds?: number[]
  parentId?: number | null
  dueDate?: string | null
  blockedReason?: string | null
}

export interface ApiUpdateWorkItemInput {
  type?: ApiWorkItemType
  title?: string
  description?: string
  status?: ApiWorkItemStatus
  assigneeIds?: number[]
  parentId?: number | null
  dueDate?: string | null
  blockedReason?: string | null
}

/* ── Meeting ───────────────────────────────────────────────────── */

export type ApiMeetingStatus =
  | 'upcoming'
  | 'live'
  | 'completed'

export interface ApiMeeting {
  id: number
  researchGroupId: number
  title: string
  scheduledAt: string
  status: ApiMeetingStatus
  participantIds: number[]
  createdById: number
  createdAt: string
  updatedAt: string
}

export interface ApiCreateMeetingInput {
  title: string
  scheduledAt: string
  status?: ApiMeetingStatus
}

export interface ApiUpdateMeetingInput {
  title?: string
  scheduledAt?: string
  status?: ApiMeetingStatus
}

export interface ApiMeetingParticipantUser {
  id: number
  username: string
  firstName: string
  lastName: string
}

export interface ApiMeetingParticipant {
  id: number
  user: ApiMeetingParticipantUser
  addedAt: string
}

export interface ApiAddMeetingParticipantInput {
  userId: number
}

export type ApiMeetingItemStatus =
  | 'open'
  | 'discussed'

export interface ApiMeetingItem {
  id: number
  meetingId: number
  title: string
  notes: string
  position: number
  status: ApiMeetingItemStatus
  workItemIds: number[]
  createdById: number
  createdAt: string
  updatedAt: string
}

export interface ApiCreateMeetingItemInput {
  title: string
  notes?: string
}

export interface ApiUpdateMeetingItemInput {
  title?: string
  notes?: string
  status?: ApiMeetingItemStatus
}

export interface ApiCreateMeetingWorkItemInput
  extends ApiCreateWorkItemInput {
  projectId: number
}
