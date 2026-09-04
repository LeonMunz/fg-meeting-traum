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
  title: string
  description: string
  // Canonical, project-configurable identifiers. The backend Work Item list
  // returns these (not fixed strings); UI maps them against the Project's
  // Work Item configuration (see getProjectWorkItemConfiguration).
  typeDefinitionId: number
  statusDefinitionId: number
  // Manual Board position within the Project/status column (see
  // WorkItem.board_position). null = unsorted (appended in creation order).
  boardPosition: number | null
  labelDefinitionIds: number[]
  // Legacy fixed-string fields, kept optional for backward compatibility with
  // older payloads. Prefer the definition IDs above.
  type?: ApiWorkItemType
  status?: ApiWorkItemStatus
  assigneeIds: number[]
  parentId: number | null
  dueDate: string | null
  blockedReason: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
  createdById: number
  // Persisted Meeting source (Meeting -> MeetingItem -> MeetingNote)
  // when this WorkItem was created from a Meeting Note. Only present
  // (and non-null) when the requesting user can read that Meeting.
  meetingOrigin: ApiWorkItemMeetingOrigin | null
}

export interface ApiWorkItemMeetingOrigin {
  meetingId: number
  meetingTitle: string
  scheduledAt: string
  meetingItemId: number
  meetingItemTitle: string
  noteId: number
  noteContent: string
}

export interface ApiPersonalWorkItem extends ApiWorkItem {
  projectName: string
  researchGroupId: number
  researchGroupName: string
}

export interface ApiCreateWorkItemInput {
  typeDefinitionId: number
  title: string
  description?: string
  statusDefinitionId?: number | null
  labelDefinitionIds?: number[]
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
  statusDefinitionId?: number | null
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
  startedAt: string | null
  endedAt: string | null
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
  | 'not_discussed'
  | 'discussing'
  | 'done'
  | 'follow_up'

export interface ApiMeetingNoteAuthor {
  id: number
  username: string
  firstName: string
  lastName: string
}

export interface ApiMeetingNote {
  id: number
  meetingItemId: number
  author: ApiMeetingNoteAuthor
  content: string
  createdAt: string
  updatedAt: string
  // Primary WorkItem of this exact Note, when one exists and the
  // current user can read its Project. null otherwise.
  linkedWorkItem: ApiLinkedWorkItem | null
}

export interface ApiLinkedWorkItem {
  id: number
  title: string
  projectId: number
  projectName: string
  statusName: string
  assigneeNames: string[]
}

export interface ApiMeetingItem {
  id: number
  meetingId: number
  meetingSectionId: number
  title: string
  contextNotes: string
  position: number
  status: ApiMeetingItemStatus
  workItemIds: number[]
  notes: ApiMeetingNote[]
  createdById: number
  createdAt: string
  updatedAt: string
}

export interface ApiCreateMeetingItemInput {
  meetingSectionId: number
  title: string
  notes?: string
}

export interface ApiUpdateMeetingItemInput {
  title?: string
  notes?: string
}

export interface ApiWorkItemTypeDefinition {
  id: number
  name: string
  order: number
  active: boolean
}

export interface ApiWorkItemStatusDefinition {
  id: number
  name: string
  category: string
  order: number
  active: boolean
  isDefault: boolean
}

export interface ApiProjectWorkItemConfiguration {
  types: ApiWorkItemTypeDefinition[]
  statuses: ApiWorkItemStatusDefinition[]
  labels: Array<{
    id: number
    name: string
    order: number
    active: boolean
  }>
}

export interface ApiCreateMeetingWorkItemInput {
  projectId: number
  typeDefinitionId: number
  title: string
  description?: string
  statusDefinitionId?: number | null
  assigneeIds?: number[]
  parentId?: number | null
  dueDate?: string | null
  blockedReason?: string | null
  labelDefinitionIds?: number[]
  // Exact persisted MeetingNote this WorkItem becomes primary for
  // (one primary WorkItem per Note). Omitted for the plain
  // MeetingItem -> WorkItem flow.
  meetingNoteId?: number | null
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

export interface ApiCreateMeetingSectionInput {
  name: string
  description?: string
}

export interface ApiUpdateMeetingSectionInput {
  name?: string
  description?: string
  isVisible?: boolean
}

export interface ApiReorderMeetingSectionsInput {
  sectionIds: number[]
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
