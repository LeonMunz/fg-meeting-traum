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
  archivedAt: string | null
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

export interface ApiDeleteProjectResponse {
  detail: string
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

export type ApiAssignmentResolution =
  | 'unassign'
  | 'transfer'

export interface ApiUpdateProjectMembershipInput {
  role: ApiProjectRole
  assignmentResolution?: ApiAssignmentResolution
  replacementUserId?: number
}

export interface ApiRemoveProjectMembershipInput {
  assignmentResolution?: ApiAssignmentResolution
  replacementUserId?: number
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

/* ── Work Item History ────────────────────────────────────────── */

export type ApiWorkItemHistoryEventType =
  | 'work_item.created'
  | 'work_item.updated'

export interface ApiWorkItemHistoryActor {
  id: number
  username: string
  firstName: string
  lastName: string
}

export interface ApiWorkItemHistoryFromTo<T> {
  from: T
  to: T
}

export interface ApiWorkItemHistoryParentRef {
  id: number
  title: string | null
}

export interface ApiWorkItemHistoryChanges {
  title?: ApiWorkItemHistoryFromTo<string>
  description?: { changed: true }
  type?: ApiWorkItemHistoryFromTo<ApiWorkItemType>
  status?: ApiWorkItemHistoryFromTo<ApiWorkItemStatus>
  dueDate?: ApiWorkItemHistoryFromTo<string | null>
  blockedReason?: ApiWorkItemHistoryFromTo<string | null>
  parent?: ApiWorkItemHistoryFromTo<
    ApiWorkItemHistoryParentRef | null
  >
  assignees?: {
    added: ApiWorkItemHistoryActor[]
    removed: ApiWorkItemHistoryActor[]
  }
}

export interface ApiWorkItemHistoryEvent {
  id: number
  eventType: ApiWorkItemHistoryEventType
  actor: ApiWorkItemHistoryActor | null
  changes: ApiWorkItemHistoryChanges
  createdAt: string
}

/* ── Work Item Comment ────────────────────────────────────────── */

export interface ApiWorkItemComment {
  id: number
  workItemId: number
  author: ApiWorkItemHistoryActor
  body: string
  createdAt: string
  updatedAt: string
}

export interface ApiCreateWorkItemCommentInput {
  body: string
}

export interface ApiUpdateWorkItemCommentInput {
  body: string
}

/* ── Meeting ───────────────────────────────────────────────────── */

export type ApiMeetingStatus =
  | 'upcoming'
  | 'live'
  | 'completed'

export type ApiMeetingScope =
  | 'group'
  | 'project'

export interface ApiMeeting {
  id: number
  researchGroupId: number
  scope: ApiMeetingScope
  projectId: number | null
  seriesId: number | null
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
  scope?: ApiMeetingScope
  projectId?: number | null
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


/* ── Meeting Series ────────────────────────────────────────────── */

export interface ApiMeetingSeries {
  id: number
  researchGroupId: number
  scope: ApiMeetingScope
  projectId: number | null
  title: string
  description: string
  isArchived: boolean
  createdById: number
  createdAt: string
  updatedAt: string
}

export interface ApiCreateMeetingSeriesInput {
  scope: ApiMeetingScope
  projectId?: number | null
  title: string
  description?: string
}

export interface ApiUpdateMeetingSeriesInput {
  title?: string
  description?: string
  isArchived?: boolean
}

export interface ApiMeetingSeriesSection {
  id: number
  meetingSeriesId: number
  name: string
  description: string
  position: number
  isActive: boolean
}

export interface ApiCreateMeetingSeriesSectionInput {
  name: string
  description?: string
}

export interface ApiUpdateMeetingSeriesSectionInput {
  name?: string
  description?: string
  isActive?: boolean
}

export interface ApiReorderMeetingSeriesSectionsInput {
  sectionIds: number[]
}

export interface ApiMeetingSection {
  id: number
  meetingId: number
  sourceSeriesSectionId: number | null
  name: string
  description: string
  position: number
  isVisible: boolean
}

export interface ApiCreateMeetingFromSeriesInput {
  title?: string
  scheduledAt?: string
  status?: ApiMeetingStatus
}


export interface ApiResearchGroupMembership {
  id: number
  role: 'admin' | 'member'
  joinedAt: string | null
  user: {
    id: number
    username: string
    firstName: string
    lastName: string
  }
}

export interface ApiUpdateResearchGroupInput {
  name: string
}

export interface ApiUpdateResearchGroupMembershipInput {
  role: 'admin' | 'member'
}

export interface ApiResearchGroupMemberCandidate {
  id: number
  username: string
  firstName: string
  lastName: string
}

export interface ApiAddResearchGroupMembershipInput {
  userId: number
  role: 'admin' | 'member'
}


/* ── Research Group Offboarding ───────────────────────────────── */

export interface ApiResearchGroupOffboardingCandidate {
  id: number
  username: string
  firstName: string
  lastName: string
  projectRole: ApiProjectRole
}

export interface ApiResearchGroupProjectOffboardingPreview {
  projectId: number
  name: string
  status: ApiProjectStatus
  archivedAt: string | null
  membershipRole: ApiProjectRole
  assignmentCount: number
  finalOwner: boolean
  requiresOwnershipResolution: boolean
  ownershipCandidates: ApiResearchGroupOffboardingCandidate[]
  assignmentCandidates: ApiResearchGroupOffboardingCandidate[]
}

export interface ApiResearchGroupMemberOffboardingPreview {
  membershipId: number
  user: {
    id: number
    username: string
    firstName: string
    lastName: string
  }
  researchGroupRole: ApiResearchGroupRole
  finalResearchGroupAdmin: boolean
  projects: ApiResearchGroupProjectOffboardingPreview[]
}

export type ApiResearchGroupAssignmentResolutionInput =
  | {
      mode: 'unassign'
    }
  | {
      mode: 'transfer'
      replacementUserId: number
    }

export type ApiResearchGroupOwnershipResolutionInput =
  | {
      mode: 'archive'
    }
  | {
      mode: 'transfer'
      replacementUserId: number
    }

export interface ApiResearchGroupProjectOffboardingInput {
  projectId: number
  assignmentResolution?:
    ApiResearchGroupAssignmentResolutionInput
  ownershipResolution?:
    ApiResearchGroupOwnershipResolutionInput
}

export interface ApiResearchGroupMemberOffboardingInput {
  projects: ApiResearchGroupProjectOffboardingInput[]
}

export interface ApiResearchGroupOffboardingSummary {
  removedProjectMembershipCount: number
  affectedWorkItemCount: number
  transferredAssignmentCount: number
  unassignedAssignmentCount: number
  ownershipTransferCount: number
  archivedProjectCount: number
}

export interface ApiResearchGroupMemberOffboardingResponse {
  detail: string
  summary: ApiResearchGroupOffboardingSummary
}
