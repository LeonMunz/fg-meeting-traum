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

// Stable, machine-readable semantic kind of a WorkItemTypeDefinition,
// carried by the backend (project Work Item configuration as `kind`,
// personal My Work as `typeKind`). A custom / unclassified project
// type has no canonical kind (null). Type-specific presentation
// (icons, colors) must key off this field — never off the `typeName`
// display string.
export type ApiWorkItemTypeKind =
  | 'task'
  | 'epic'
  | 'milestone'
  | 'deliverable'

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

export interface ApiWorkItemStatusTarget {
  statusCategory: ApiWorkItemStatus
  statusDefinitionId: number
  statusName: string
}

export interface ApiPersonalWorkItem extends ApiWorkItem {
  projectName: string
  researchGroupId: number
  researchGroupName: string
  // Concrete project-local Work Item type (its Project
  // WorkItemTypeDefinition display name) — display metadata for the
  // canonical typeDefinitionId, carried by GET /api/me/work-items/ so
  // the personal list can show the configured type name without any
  // per-Project configuration request. It is a display name, NOT a
  // semantic type discriminator: no Task/Epic/Milestone/Deliverable
  // kind is inferred from it.
  typeName: string
  // Stable semantic kind of the concrete project-local type
  // definition (task | epic | milestone | deliverable) — null for
  // custom / unclassified types. Machine-readable presentation
  // discriminator for the canonical typeDefinitionId: type-specific
  // rendering must depend on typeKind, never on the typeName display
  // name.
  typeKind: ApiWorkItemTypeKind | null
  // Concrete project-local status (its Project StatusDefinition display
  // name) plus that definition's fixed semantic category — carried by
  // GET /api/me/work-items/ so the personal list renders both without
  // any per-Project configuration request. The canonical
  // statusDefinitionId stays authoritative.
  statusName: string
  statusCategory: ApiWorkItemStatus
  // Read-only global-Kanban status targets (see ApiWorkItemStatusTarget):
  // the concrete project-local StatusDefinition resolved per fixed
  // semantic category. Carried by GET /api/me/work-items/ so the
  // global My Work Kanban can resolve a cross-category drag to the
  // concrete project-local statusDefinitionId without any Project
  // configuration request. The My Work Kanban uses these targets
  // ONLY as drop-zone enablement and mutation targets — never for
  // ordering, never by status name, and never for same-category
  // moves.
  statusTargets: ApiWorkItemStatusTarget[]
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

// Project-configured type/status definition summary as stored in
// AuditEvent.data["changes"] (see apps/api/work_items/services.py and
// tests_history.py). `name` is the canonical display name; the UI must
// never infer names from hard-coded slugs.
export interface ApiWorkItemHistoryDefinitionRef {
  id: number
  name: string
}

export interface ApiWorkItemHistoryChanges {
  title?: ApiWorkItemHistoryFromTo<string>
  description?: { changed: true }
  // Current backend contract (project-configured definitions).
  typeDefinition?: ApiWorkItemHistoryFromTo<
    ApiWorkItemHistoryDefinitionRef | null
  >
  statusDefinition?: ApiWorkItemHistoryFromTo<
    ApiWorkItemHistoryDefinitionRef | null
  >
  // Legacy fixed-slug contract, kept optional for backward
  // compatibility with older persisted events.
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
  currentMeetingItemId: number | null
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
  participantIds?: number[]
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

export type ApiMeetingParticipantCandidate =
  ApiMeetingParticipantUser

export interface ApiMeetingParticipant {
  id: number
  user: ApiMeetingParticipantUser
  addedAt: string
}

export interface ApiAddMeetingParticipantInput {
  userId: number
}

export type ApiMeetingItemOutcome =
  | 'not_discussed'
  | 'done'
  | 'follow_up'

export type ApiMeetingItemFollowUpStatus =
  | 'scheduled'
  | 'needs_reschedule'
  | 'cancelled'

export interface ApiMeetingItemFollowUpSchedule {
  id: number
  status: ApiMeetingItemFollowUpStatus
  sourceMeetingItemId: number
  sourceOutcome: ApiMeetingItemOutcome
  targetMeetingId: number
  targetMeetingTitle: string
  targetMeetingScheduledAt: string
  targetMeetingSectionId: number
  targetMeetingSectionName: string
  targetMeetingItemId: number
  createdAt: string
  updatedAt: string
}

export interface ApiMeetingItemFollowUpTargetSection {
  id: number
  name: string
  position: number
  sourceSeriesSectionId: number | null
}

export interface ApiMeetingItemFollowUpTarget {
  id: number
  title: string
  scheduledAt: string
  seriesId: number | null
  recommendedSectionId: number | null
  sections: ApiMeetingItemFollowUpTargetSection[]
}

export interface ApiMeetingItemFollowUpTargets {
  recommendedMeetingId: number | null
  meetings: ApiMeetingItemFollowUpTarget[]
}

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
  outcome: ApiMeetingItemOutcome
  followUpSchedule: ApiMeetingItemFollowUpSchedule | null
  workItemIds: number[]
  notes: ApiMeetingNote[]
  createdById: number
  createdAt: string
  updatedAt: string
}

export interface ApiScheduleMeetingItemFollowUpInput {
  targetMeetingId: number
  targetMeetingSectionId: number
}

export type ApiMeetingItemFollowUpTargetDisposition =
  | 'removed'
  | 'preserved'

export interface ApiCancelMeetingItemFollowUpResult {
  id: number
  status: ApiMeetingItemFollowUpStatus
  sourceMeetingItemId: number
  sourceOutcome: ApiMeetingItemOutcome
  targetMeetingItemId: number | null
  targetItemDisposition: ApiMeetingItemFollowUpTargetDisposition
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
  participantIds?: number[]
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

export interface ApiCreateResearchGroupInput {
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

/* ── Home (personal re-entry surface) ─────────────────────────── */

export type ApiHomeAttentionReason = 'overdue' | 'blocked'

export type ApiHomeDomain = 'work_item' | 'meeting'

/** The canonical Work Item type identity of a Home Work Item
 * candidate (the Project-configured Work Item type definition). */
export interface ApiHomeWorkItemType {
  id: number
  name: string
}

/** One Work Item candidate in Home "Needs attention". */
export interface ApiHomeNeedsAttentionItem {
  workItemId: number
  title: string
  projectId: number
  projectName: string
  workItemType: ApiHomeWorkItemType
  dueDate: string | null
  statusCategory: ApiWorkItemStatus
  blockedReason: string | null
  attentionReasons: ApiHomeAttentionReason[]
}

/** Today & next — Work Item detail block. */
export interface ApiHomeTimelineWorkItem {
  workItemId: number
  projectId: number
  projectName: string
  dueDate: string | null
  statusCategory: ApiWorkItemStatus
  blockedReason: string | null
}

/** Today & next — Meeting detail block. */
export interface ApiHomeTimelineMeeting {
  meetingId: number
  scheduledAt: string
  status: ApiMeetingStatus
  scope: ApiMeetingScope
  researchGroupId: number | null
  projectId: number | null
}

/** One flat "Today & next" timeline candidate. Exactly one of
 * `workItem` / `meeting` is non-null (matching `domain`). */
export interface ApiHomeTimelineCandidate {
  domain: ApiHomeDomain
  objectId: number
  title: string
  calendarDate: string
  sortAt: string
  workItem: ApiHomeTimelineWorkItem | null
  meeting: ApiHomeTimelineMeeting | null
}

/** One "My work" Work Item candidate. */
export interface ApiHomeMyWorkItem {
  workItemId: number
  title: string
  projectId: number
  projectName: string
  typeDefinitionId: number
  typeName: string
  statusCategory: ApiWorkItemStatus
  dueDate: string | null
  blockedReason: string | null
}

/** Continue working — Work Item detail block. */
export interface ApiHomeContinueWorkingWorkItem {
  workItemId: number
  projectId: number
  projectName: string
  statusCategory: ApiWorkItemStatus
  dueDate: string | null
}

/** Continue working — Meeting detail block. */
export interface ApiHomeContinueWorkingMeeting {
  meetingId: number
  status: ApiMeetingStatus
  scheduledAt: string
}

/** Current access scope/context of a Continue working candidate:
 * Work Item → owning Project; Meeting → owning Research Group. */
export type ApiHomeContextKind = 'research_group' | 'project'

export interface ApiHomeContext {
  kind: ApiHomeContextKind
  id: number
  name: string
}

/** One flat "Continue working" recency candidate. Exactly one of
 * `workItem` / `meeting` is non-null (matching `domain`). */
export interface ApiHomeContinueWorkingCandidate {
  domain: ApiHomeDomain
  objectId: number
  title: string
  latestPersonalActivityAt: string
  context: ApiHomeContext
  workItem: ApiHomeContinueWorkingWorkItem | null
  meeting: ApiHomeContinueWorkingMeeting | null
}

/** The stable top-level `GET /api/home/` response. All four section
 * keys are always present; an empty section is `[]`. */
export interface ApiHome {
  needsAttention: ApiHomeNeedsAttentionItem[]
  todayAndNext: ApiHomeTimelineCandidate[]
  myWork: ApiHomeMyWorkItem[]
  continueWorking: ApiHomeContinueWorkingCandidate[]
}

/* ── Activity feed ────────────────────────────────────────────── */

export interface ApiActivityUserRef {
  id: number
  username: string
  firstName: string
  lastName: string
}

/** The four canonical Activity domains accepted by the
 * `GET /api/activity/` `?domains=` filter (OR semantics; an event's
 * domain is its `event_type` prefix). */
export type ActivityDomain =
  | 'work_item'
  | 'meeting'
  | 'project'
  | 'research_group'

/** One structured entry from `GET /api/activity/`. The non-matching
 * object identity pair is null; context is scope-only (no raw payload). */
export interface ApiActivityEvent {
  id: number
  eventType: string
  actor: ApiActivityUserRef | null
  subjectUser: ApiActivityUserRef | null
  workItemId: number | null
  workItemTitle: string | null
  meetingId: number | null
  meetingTitle: string | null
  projectId: number | null
  projectName: string | null
  researchGroupId: number | null
  researchGroupName: string | null
  changes: Record<string, unknown>
  createdAt: string
}
