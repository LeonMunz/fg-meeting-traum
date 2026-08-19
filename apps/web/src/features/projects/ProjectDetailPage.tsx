import { useEffect, useMemo, useState } from 'react'
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router'

import {
  AddProjectMemberDialog,
  type AddableProjectRole,
  type DirectoryUser,
} from './AddProjectMemberDialog'
import {
  ProjectAssignmentResolutionDialog,
  type AssignmentResolutionMode,
} from './ProjectAssignmentResolutionDialog'
import { RemoveProjectMemberDialog } from './RemoveProjectMemberDialog'
import {
  ProjectLifecycleDialog,
  type ProjectLifecycleAction,
} from './ProjectLifecycleDialog'
import {
  WorkItemDrawer,
  type WorkItemFormInput,
} from './WorkItemDrawer'
import { ApiError } from '../../api/client'
import {
  addProjectMembership,
  archiveProject,
  deleteProject,
  getProject,
  listProjectMemberships,
  listResearchGroupMembers,
  removeProjectMembership,
  restoreProject,
  updateProject,
  updateProjectMembership,
} from '../../api/projects'
import type {
  ApiProjectMembership,
  ApiResearchGroupMember,
  ApiUpdateWorkItemInput,
  ApiWorkItem,
} from '../../api/types'
import {
  createWorkItem,
  listProjectWorkItems,
  updateWorkItem,
} from '../../api/work-items'
import { useSession } from '../../api/useSession'

type ProjectStatus = 'active' | 'paused' | 'completed'
type ProjectRole = 'owner' | 'member' | 'viewer'
type WorkItemDrawerState =
  | {
      mode: 'create'
    }
  | {
      mode: 'edit'
      workItemId: number
    }

type ProjectTab =
  | 'work-items'
  | 'overview'
  | 'settings'

type DemoWorkItemStatus = 'todo' | 'in_progress' | 'review' | 'done'
type DemoWorkItemType = 'epic' | 'milestone' | 'deliverable' | 'task'

type AttentionKind =
  | 'blocked'
  | 'overdue'
  | 'unassigned'

type WorkItemsView = 'board' | 'list'
type WorkItemsTypeFilter = 'all' | DemoWorkItemType

type WorkItemsPreferences = {
  view: WorkItemsView
  query: string
  type: WorkItemsTypeFilter
  assignee: string
  blockedOnly: boolean
}

type DemoWorkItemAssignee = {
  id: string
  name: string
  initials: string
}

type DemoWorkItem = {
  id: string
  title: string
  type: DemoWorkItemType
  status: DemoWorkItemStatus
  assignees: DemoWorkItemAssignee[]
  dueInDays: number | null
  dueLabel: string | null
  blockedReason: string | null
  parentId: string | null
}

type OverviewAttentionItem = {
  item: DemoWorkItem
  kind: AttentionKind
}

type ProjectMember = {
  id: string
  membershipId: number
  username: string
  name: string
  initials: string
  role: ProjectRole
}

type ProjectDetail = {
  id: string
  researchGroupId: number
  name: string
  description: string
  status: ProjectStatus
  archivedAt: string | null
  role: ProjectRole
  updatedLabel: string
}


const workItemStatusLabels: Record<DemoWorkItemStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  review: 'Review',
  done: 'Done',
}

const workItemTypeLabels: Record<DemoWorkItemType, string> = {
  epic: 'Epic',
  milestone: 'Milestone',
  deliverable: 'Deliverable',
  task: 'Task',
}

const workItemStatusOptions: Array<{
  value: DemoWorkItemStatus
  label: string
  icon: string
}> = [
  {
    value: 'todo',
    label: 'To do',
    icon: 'radio_button_unchecked',
  },
  {
    value: 'in_progress',
    label: 'In progress',
    icon: 'pending',
  },
  {
    value: 'review',
    label: 'Review',
    icon: 'rate_review',
  },
  {
    value: 'done',
    label: 'Done',
    icon: 'check_circle',
  },
]

const workItemTypeOptions: Array<{
  value: DemoWorkItemType
  label: string
  icon: string
}> = [
  { value: 'epic', label: 'Epic', icon: 'account_tree' },
  { value: 'milestone', label: 'Milestone', icon: 'flag' },
  {
    value: 'deliverable',
    label: 'Deliverable',
    icon: 'inventory_2',
  },
  {
    value: 'task',
    label: 'Task',
    icon: 'check_box_outline_blank',
  },
]

const statusLabel: Record<ProjectStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
}

const statusDotClass: Record<ProjectStatus, string> = {
  active: 'bg-emerald-500',
  paused: 'bg-amber-500',
  completed: 'bg-outline',
}

const roleLabel: Record<ProjectRole, string> = {
  owner: 'Owner',
  member: 'Member',
  viewer: 'Viewer',
}

const roleIcon: Record<ProjectRole, string> = {
  owner: 'shield_person',
  member: 'person',
  viewer: 'visibility',
}

const roleClass: Record<ProjectRole, string> = {
  owner: 'bg-primary-fixed text-primary',
  member: 'bg-secondary-container text-on-surface',
  viewer: 'bg-surface-container-high text-on-surface-variant',
}

const tabs: Array<{
  id: ProjectTab
  label: string
}> = [
  { id: 'work-items', label: 'Work Items' },
  { id: 'overview', label: 'Overview' },
  { id: 'settings', label: 'Settings' },
]

function getPersonName(
  firstName: string,
  lastName: string,
  username: string,
) {
  const fullName = `${firstName} ${lastName}`.trim()
  return fullName || username
}

function getPersonInitials(
  firstName: string,
  lastName: string,
  username: string,
) {
  const initials = [firstName, lastName]
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value[0]?.toUpperCase())
    .join('')

  return initials || username.slice(0, 2).toUpperCase()
}

function mapProjectMembership(
  membership: ApiProjectMembership,
): ProjectMember {
  return {
    id: String(membership.user.id),
    membershipId: membership.id,
    username: membership.user.username,
    name: getPersonName(
      membership.user.firstName,
      membership.user.lastName,
      membership.user.username,
    ),
    initials: getPersonInitials(
      membership.user.firstName,
      membership.user.lastName,
      membership.user.username,
    ),
    role: membership.role,
  }
}

function mapResearchGroupMember(
  member: ApiResearchGroupMember,
): DirectoryUser {
  return {
    id: String(member.id),
    name: getPersonName(
      member.firstName,
      member.lastName,
      member.username,
    ),
    username: member.username,
    initials: getPersonInitials(
      member.firstName,
      member.lastName,
      member.username,
    ),
  }
}

function getWorkItemDueFields(
  dueDate: string | null,
) {
  if (!dueDate) {
    return {
      dueInDays: null,
      dueLabel: null,
    }
  }

  const [year, month, day] = dueDate
    .split('-')
    .map(Number)

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return {
      dueInDays: null,
      dueLabel: null,
    }
  }

  const targetDate = new Date(
    year,
    month - 1,
    day,
  )

  const now = new Date()

  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  )

  const dueInDays = Math.round(
    (targetDate.getTime() - today.getTime()) /
      86_400_000,
  )

  const dueLabel =
    dueInDays === 0
      ? 'Today'
      : dueInDays === 1
        ? 'Tomorrow'
        : new Intl.DateTimeFormat('en', {
            month: 'short',
            day: 'numeric',
          }).format(targetDate)

  return {
    dueInDays,
    dueLabel,
  }
}

function compareWorkItemIds(
  left: DemoWorkItem,
  right: DemoWorkItem,
) {
  const leftId = Number(left.id)
  const rightId = Number(right.id)

  if (
    Number.isFinite(leftId) &&
    Number.isFinite(rightId) &&
    leftId !== rightId
  ) {
    return leftId - rightId
  }

  return left.id.localeCompare(right.id)
}

function compareMilestoneWorkItems(
  left: DemoWorkItem,
  right: DemoWorkItem,
) {
  const leftDone = left.status === 'done'
  const rightDone = right.status === 'done'

  if (leftDone !== rightDone) {
    return leftDone ? 1 : -1
  }

  if (
    left.dueInDays == null &&
    right.dueInDays != null
  ) {
    return 1
  }

  if (
    left.dueInDays != null &&
    right.dueInDays == null
  ) {
    return -1
  }

  if (
    left.dueInDays != null &&
    right.dueInDays != null &&
    left.dueInDays !== right.dueInDays
  ) {
    return left.dueInDays - right.dueInDays
  }

  return compareWorkItemIds(left, right)
}

function getAttentionKind(
  item: DemoWorkItem,
): AttentionKind | null {
  if (item.status === 'done') {
    return null
  }

  if (item.blockedReason !== null) {
    return 'blocked'
  }

  if (
    item.dueInDays != null &&
    item.dueInDays < 0
  ) {
    return 'overdue'
  }

  if (item.assignees.length === 0) {
    return 'unassigned'
  }

  return null
}

const attentionPriority: Record<
  AttentionKind,
  number
> = {
  blocked: 0,
  overdue: 1,
  unassigned: 2,
}

const attentionLabel: Record<
  AttentionKind,
  string
> = {
  blocked: 'Blocked',
  overdue: 'Overdue',
  unassigned: 'Unassigned',
}

function compareAttentionItems(
  left: OverviewAttentionItem,
  right: OverviewAttentionItem,
) {
  const priorityDifference =
    attentionPriority[left.kind] -
    attentionPriority[right.kind]

  if (priorityDifference !== 0) {
    return priorityDifference
  }

  return compareWorkItemIds(
    left.item,
    right.item,
  )
}

function mapApiWorkItem(
  item: ApiWorkItem,
  members: ProjectMember[],
): DemoWorkItem {
  const due = getWorkItemDueFields(item.dueDate)

  return {
    id: String(item.id),
    title: item.title,
    type: item.type,
    status: item.status,
    assignees: item.assigneeIds.map(
      (assigneeId) => {
        const member = members.find(
          (candidate) =>
            candidate.id === String(assigneeId),
        )

        return {
          id: String(assigneeId),
          name:
            member?.name ??
            `User ${assigneeId}`,
          initials:
            member?.initials ?? '?',
        }
      },
    ),
    dueInDays: due.dueInDays,
    dueLabel: due.dueLabel,
    blockedReason: item.blockedReason,
    parentId:
      item.parentId == null
        ? null
        : String(item.parentId),
  }
}

function getWorkItemErrorMessage(
  error: unknown,
  fallback: string,
) {
  if (
    error instanceof ApiError &&
    error.detail &&
    typeof error.detail === 'object' &&
    'error' in error.detail
  ) {
    const detail =
      error.detail as { error?: unknown }

    if (typeof detail.error === 'string') {
      return detail.error
    }
  }

  return fallback
}

function getMembershipErrorMessage(
  error: unknown,
  fallback: string,
) {
  if (
    error instanceof ApiError &&
    error.detail &&
    typeof error.detail === 'object' &&
    'error' in error.detail
  ) {
    const detail = error.detail as { error?: unknown }

    if (typeof detail.error === 'string') {
      return detail.error
    }
  }

  return fallback
}
import { useSyncResearchGroupContext } from '../research-group/useSyncResearchGroupContext'

export function ProjectDetailPage() {
  const { projectId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { user } = useSession()
  const activeTab = useMemo<ProjectTab>(() => {
    const segment =
      location.pathname
        .split('/')
        .filter(Boolean)
        .at(-1)

    if (
      segment === 'overview' ||
      segment === 'settings'
    ) {
      return segment
    }

    return 'work-items'
  }, [location.pathname])

  const navigateToTab = (tab: ProjectTab) => {
    if (!projectId) {
      return
    }

    navigate(`/projects/${projectId}/${tab}`)
  }

  const [project, setProject] = useState<ProjectDetail | null>(null)

  useSyncResearchGroupContext(
    project?.researchGroupId,
  )

  const [projectLoading, setProjectLoading] = useState(true)
  const [projectLoadError, setProjectLoadError] =
    useState<'not-found' | 'error' | null>(null)

  const [projectName, setProjectName] = useState('')
  const [projectDescription, setProjectDescription] = useState('')
  const [projectStatus, setProjectStatus] =
    useState<ProjectStatus>('active')

  const [settingsName, setSettingsName] = useState('')
  const [settingsDescription, setSettingsDescription] = useState('')
  const [settingsStatus, setSettingsStatus] =
    useState<ProjectStatus>('active')
  const [settingsSaving, setSettingsSaving] =
    useState(false)
  const [settingsError, setSettingsError] =
    useState<string | null>(null)
  const [lifecycleAction, setLifecycleAction] =
    useState<ProjectLifecycleAction | null>(null)
  const [lifecycleSaving, setLifecycleSaving] =
    useState(false)
  const [lifecycleError, setLifecycleError] =
    useState<string | null>(null)

  const [members, setMembers] = useState<ProjectMember[]>([])
  const [directoryUsers, setDirectoryUsers] =
    useState<DirectoryUser[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [membersError, setMembersError] =
    useState<string | null>(null)
  const [addMemberDialogOpen, setAddMemberDialogOpen] = useState(false)
  const [memberToRemove, setMemberToRemove] =
    useState<ProjectMember | null>(null)
  const [
    assignmentResolutionAction,
    setAssignmentResolutionAction,
  ] = useState<{
    member: ProjectMember
    action: 'viewer' | 'remove'
  } | null>(null)
  const [apiWorkItems, setApiWorkItems] =
    useState<ApiWorkItem[]>([])
  const [workItemsLoading, setWorkItemsLoading] =
    useState(false)
  const [workItemsError, setWorkItemsError] =
    useState<string | null>(null)
  const [
    workItemDrawerState,
    setWorkItemDrawerState,
  ] = useState<WorkItemDrawerState | null>(
    null,
  )
  const [boardStatusDropError, setBoardStatusDropError] =
    useState<string | null>(null)
  useEffect(() => {
    if (!projectId) {
      setProject(null)
      setProjectLoadError('not-found')
      setProjectLoading(false)
      return
    }

    const parsedProjectId = Number(projectId)

    if (
      !Number.isInteger(parsedProjectId) ||
      parsedProjectId <= 0
    ) {
      setProject(null)
      setProjectLoadError('not-found')
      setProjectLoading(false)
      return
    }

    let cancelled = false

    setProject(null)
    setProjectLoadError(null)
    setProjectLoading(true)

    getProject(parsedProjectId)
      .then((apiProject) => {
        if (cancelled) return

        const updatedAt = new Date(apiProject.updatedAt)

        const updatedLabel = Number.isNaN(updatedAt.getTime())
          ? 'Updated recently'
          : `Updated ${new Intl.DateTimeFormat('en', {
              month: 'short',
              day: 'numeric',
            }).format(updatedAt)}`

        setProject({
          id: String(apiProject.id),
          researchGroupId: apiProject.researchGroupId,
          name: apiProject.name,
          description: apiProject.description,
          status: apiProject.status,
          archivedAt: apiProject.archivedAt,
          role: apiProject.currentUserRole,
          updatedLabel,
        })
      })
      .catch((error) => {
        if (cancelled) return

        setProject(null)

        if (error instanceof ApiError && error.status === 404) {
          setProjectLoadError('not-found')
          return
        }

        setProjectLoadError('error')
      })
      .finally(() => {
        if (!cancelled) {
          setProjectLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [projectId])

  useEffect(() => {
    if (!project) {
      setMembers([])
      setDirectoryUsers([])
      setMembersLoading(false)
      setMembersError(null)
      return
    }

    const numericProjectId = Number(project.id)
    let cancelled = false

    setMembers([])
    setDirectoryUsers([])
    setMembersLoading(true)
    setMembersError(null)

    Promise.all([
      listProjectMemberships(numericProjectId),
      listResearchGroupMembers(project.researchGroupId),
    ])
      .then(([projectMemberships, researchGroupMembers]) => {
        if (cancelled) return

        setMembers(
          projectMemberships.map(mapProjectMembership),
        )

        setDirectoryUsers(
          researchGroupMembers.map(mapResearchGroupMember),
        )
      })
      .catch((error) => {
        if (cancelled) return

        setMembers([])
        setDirectoryUsers([])
        setMembersError(
          getMembershipErrorMessage(
            error,
            'Project members could not be loaded.',
          ),
        )
      })
      .finally(() => {
        if (!cancelled) {
          setMembersLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [project])

  useEffect(() => {
    if (!project) {
      setApiWorkItems([])
      setWorkItemsLoading(false)
      setWorkItemsError(null)
      return
    }

    const numericProjectId = Number(project.id)
    let cancelled = false

    setApiWorkItems([])
    setWorkItemsLoading(true)
    setWorkItemsError(null)

    listProjectWorkItems(numericProjectId)
      .then((items) => {
        if (!cancelled) {
          setApiWorkItems(items)
        }
      })
      .catch((error) => {
        if (cancelled) return

        setApiWorkItems([])
        setWorkItemsError(
          getWorkItemErrorMessage(
            error,
            'Work items could not be loaded.',
          ),
        )
      })
      .finally(() => {
        if (!cancelled) {
          setWorkItemsLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [project])

  useEffect(() => {
    setAddMemberDialogOpen(false)
    setMemberToRemove(null)
    setAssignmentResolutionAction(null)
    setWorkItemDrawerState(null)
    setLifecycleAction(null)
    setLifecycleError(null)

    if (project) {
      setProjectName(project.name)
      setProjectDescription(project.description)
      setProjectStatus(project.status)

      setSettingsName(project.name)
      setSettingsDescription(project.description)
      setSettingsStatus(project.status)

    }
  }, [project])

  const previewState =
    new URLSearchParams(location.search).get('preview')

  const isPreviewLoading = previewState === 'loading'
  const isPreviewError = previewState === 'error'
  const forceEmptyDescription = previewState === 'empty-description'
  const forceEmptyWorkItems = previewState === 'empty-work-items'

  const clearPreviewState = () => {
    const params = new URLSearchParams(location.search)
    params.delete('preview')

    const search = params.toString()

    navigate(
      {
        pathname: location.pathname,
        search: search ? `?${search}` : '',
      },
      { replace: true },
    )
  }

  if (isPreviewLoading || projectLoading) {
    return <ProjectDetailSkeleton />
  }

  if (isPreviewError || projectLoadError === 'error') {
    return (
      <div className="mx-auto w-full max-w-[1440px] px-6 py-10 lg:px-10">
        <Link
          to="/projects"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-on-surface-variant transition hover:text-primary"
        >
          <span className="material-symbols-outlined text-[18px]">
            arrow_back
          </span>
          Projects
        </Link>

        <div
          role="alert"
          className="mt-8 flex min-h-80 flex-col items-center justify-center rounded-xl border border-outline-variant bg-surface-container-lowest px-6 py-12 text-center shadow-sm"
        >
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-error-container text-error">
            <span className="material-symbols-outlined text-[23px]">
              cloud_off
            </span>
          </div>

          <h1 className="mt-4 text-base font-semibold text-on-surface">
            Project couldn't be loaded
          </h1>

          <p className="mt-1 max-w-md text-sm leading-6 text-on-surface-variant">
            Something went wrong while loading this project. Try again or
            return to your projects.
          </p>

          <div className="mt-5 flex items-center gap-3">
            <Link
              to="/projects"
              className="inline-flex h-9 items-center justify-center rounded-lg px-4 text-sm font-medium text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface"
            >
              Back to projects
            </Link>

            <button
              type="button"
              onClick={clearPreviewState}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-primary/90"
            >
              <span className="material-symbols-outlined text-[18px]">
                refresh
              </span>
              Try again
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!project) {
    return (
      <div className="mx-auto w-full max-w-[1440px] px-6 py-10 lg:px-10">
        <Link
          to="/projects"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-on-surface-variant transition hover:text-primary"
        >
          <span className="material-symbols-outlined text-[18px]">
            arrow_back
          </span>
          Projects
        </Link>

        <div className="mt-8 flex min-h-80 flex-col items-center justify-center rounded-xl border border-dashed border-outline-variant bg-surface-container-lowest px-6 py-12 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant">
            <span className="material-symbols-outlined text-[23px]">
              folder_off
            </span>
          </div>

          <h1 className="mt-4 text-base font-semibold text-on-surface">
            Project not found
          </h1>

          <p className="mt-1 max-w-md text-sm leading-6 text-on-surface-variant">
            This project may no longer exist or may not be available to your
            account.
          </p>

          <Link
            to="/projects"
            className="mt-5 inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-primary/90"
          >
            <span className="material-symbols-outlined text-[18px]">
              arrow_back
            </span>
            Back to projects
          </Link>
        </div>
      </div>
    )
  }

  const currentUserId =
    user ? String(user.id) : null

  const currentMemberRole =
    members.find(
      (member) => member.id === currentUserId,
    )?.role ?? project.role

  const ownerCount = members.filter(
    (member) => member.role === 'owner',
  ).length

  const sortedMembers = [...members].sort((a, b) => {
    const aIsOwner = a.role === 'owner'
    const bIsOwner = b.role === 'owner'

    if (aIsOwner !== bIsOwner) {
      return aIsOwner ? -1 : 1
    }

    return a.name.localeCompare(b.name)
  })

  const workItems = apiWorkItems.map(
    (item) => mapApiWorkItem(item, members),
  )

  const isArchived = project.archivedAt !== null
  const isViewer = currentMemberRole === 'viewer'
  const isOwner = currentMemberRole === 'owner'

  const isReadOnly =
    isViewer || isArchived

  const canManageMembers =
    isOwner && !isArchived

  const canEditProjectSettings =
    isOwner && !isArchived

  const canManageProjectLifecycle =
    isOwner

  const projectHasWork =
    apiWorkItems.length > 0

  const canDeleteProject =
    canManageProjectLifecycle &&
    !workItemsLoading &&
    !workItemsError &&
    !projectHasWork

  const getAssignmentCountForMember = (
    memberId: string,
  ) => {
    const numericMemberId = Number(memberId)

    if (
      !Number.isInteger(numericMemberId) ||
      numericMemberId <= 0
    ) {
      return 0
    }

    return apiWorkItems.filter(
      (item) =>
        item.assigneeIds.includes(
          numericMemberId,
        ),
    ).length
  }

  const assignmentResolutionCount =
    assignmentResolutionAction
      ? getAssignmentCountForMember(
          assignmentResolutionAction.member.id,
        )
      : 0

  const assignmentResolutionCandidates =
    assignmentResolutionAction
      ? sortedMembers
          .filter(
            (member) =>
              member.id !==
                assignmentResolutionAction.member.id &&
              member.role !== 'viewer',
          )
          .map((member) => ({
            id: member.id,
            name: member.name,
            username: member.username,
            initials: member.initials,
          }))
      : []

  const applyAssignmentResolutionToWorkItems = (
    targetUserId: number,
    resolution: AssignmentResolutionMode,
    replacementUserId: number | null,
  ) => {
    setApiWorkItems((currentItems) =>
      currentItems.map((item) => {
        if (
          !item.assigneeIds.includes(
            targetUserId,
          )
        ) {
          return item
        }

        const remainingAssigneeIds =
          item.assigneeIds.filter(
            (assigneeId) =>
              assigneeId !== targetUserId,
          )

        if (
          resolution === 'transfer' &&
          replacementUserId !== null &&
          !remainingAssigneeIds.includes(
            replacementUserId,
          )
        ) {
          remainingAssigneeIds.push(
            replacementUserId,
          )
        }

        return {
          ...item,
          assigneeIds: remainingAssigneeIds,
        }
      }),
    )
  }

  const applyLifecycleProject = (
    archivedAt: string | null,
  ) => {
    setProject((currentProject) =>
      currentProject
        ? {
            ...currentProject,
            archivedAt,
          }
        : currentProject,
    )
  }

  const handleRestoreProject = async () => {
    if (
      !canManageProjectLifecycle ||
      lifecycleSaving
    ) {
      return
    }

    const numericProjectId = Number(project.id)

    if (
      !Number.isInteger(numericProjectId) ||
      numericProjectId <= 0
    ) {
      setLifecycleError('Invalid Project ID.')
      return
    }

    setLifecycleSaving(true)
    setLifecycleError(null)

    try {
      const restored = await restoreProject(
        numericProjectId,
      )

      applyLifecycleProject(
        restored.archivedAt,
      )
    } catch (error) {
      setLifecycleError(
        getMembershipErrorMessage(
          error,
          'Project could not be restored.',
        ),
      )
    } finally {
      setLifecycleSaving(false)
    }
  }

  const handleConfirmLifecycle = async () => {
    if (
      !lifecycleAction ||
      !canManageProjectLifecycle ||
      lifecycleSaving
    ) {
      return
    }

    const numericProjectId = Number(project.id)

    if (
      !Number.isInteger(numericProjectId) ||
      numericProjectId <= 0
    ) {
      setLifecycleError('Invalid Project ID.')
      return
    }

    setLifecycleSaving(true)
    setLifecycleError(null)

    try {
      if (lifecycleAction === 'archive') {
        const archived = await archiveProject(
          numericProjectId,
        )

        applyLifecycleProject(
          archived.archivedAt,
        )

        setLifecycleAction(null)
        return
      }

      await deleteProject(
        numericProjectId,
      )

      navigate(
        `/projects?group=${project.researchGroupId}`,
        { replace: true },
      )
    } catch (error) {
      setLifecycleError(
        getMembershipErrorMessage(
          error,
          lifecycleAction === 'archive'
            ? 'Project could not be archived.'
            : 'Project could not be deleted.',
        ),
      )

      setLifecycleAction(null)
    } finally {
      setLifecycleSaving(false)
    }
  }

  const settingsDirty =
    settingsName.trim() !== projectName ||
    settingsDescription.trim() !== projectDescription ||
    settingsStatus !== projectStatus

  const settingsValid = settingsName.trim().length > 0

  const handleResetProjectSettings = () => {
    setSettingsName(projectName)
    setSettingsDescription(projectDescription)
    setSettingsStatus(projectStatus)
    setSettingsError(null)
  }

  const handleSaveProjectSettings = async () => {
    if (
      !canEditProjectSettings ||
      !settingsValid ||
      settingsSaving
    ) {
      return
    }

    const numericProjectId = Number(project.id)

    if (
      !Number.isInteger(numericProjectId) ||
      numericProjectId <= 0
    ) {
      setSettingsError('Invalid Project ID.')
      return
    }

    setSettingsSaving(true)
    setSettingsError(null)

    try {
      const updated = await updateProject(
        numericProjectId,
        {
          name: settingsName.trim(),
          description: settingsDescription.trim(),
          status: settingsStatus,
        },
      )

      setProjectName(updated.name)
      setProjectDescription(updated.description)
      setProjectStatus(updated.status)

      setSettingsName(updated.name)
      setSettingsDescription(updated.description)
      setSettingsStatus(updated.status)
    } catch (error) {
      setSettingsError(
        getMembershipErrorMessage(
          error,
          'Project settings could not be saved.',
        ),
      )
    } finally {
      setSettingsSaving(false)
    }
  }

  const handleAddMember = async (
    directoryUser: DirectoryUser,
    role: AddableProjectRole,
  ) => {
    if (!canManageMembers) {
      throw new Error(
        'Only a Project owner can manage memberships.',
      )
    }

    const numericProjectId = Number(project.id)
    const numericUserId = Number(directoryUser.id)

    if (
      !Number.isInteger(numericProjectId) ||
      !Number.isInteger(numericUserId)
    ) {
      throw new Error('Invalid project or user ID.')
    }

    setMembersError(null)

    try {
      const membership = await addProjectMembership(
        numericProjectId,
        {
          userId: numericUserId,
          role,
        },
      )

      const mappedMembership =
        mapProjectMembership(membership)

      setMembers((currentMembers) => [
        ...currentMembers.filter(
          (member) =>
            member.id !== mappedMembership.id,
        ),
        mappedMembership,
      ])
    } catch (error) {
      const message = getMembershipErrorMessage(
        error,
        'Project member could not be added.',
      )

      setMembersError(message)
      throw new Error(message)
    }
  }

  const handleMemberRoleChange = async (
    memberId: string,
    role: AddableProjectRole,
  ) => {
    if (!canManageMembers) return

    const targetMember = members.find(
      (member) => member.id === memberId,
    )

    if (!targetMember) return

    setMembersError(null)

    if (role === 'viewer') {
      if (workItemsLoading) {
        setMembersError(
          'Work items are still loading. Try again in a moment.',
        )
        return
      }

      if (workItemsError) {
        setMembersError(
          'Work items could not be verified. Reload them before changing this member to viewer.',
        )
        return
      }

      if (
        getAssignmentCountForMember(
          targetMember.id,
        ) > 0
      ) {
        setAssignmentResolutionAction({
          member: targetMember,
          action: 'viewer',
        })
        return
      }
    }

    try {
      const membership =
        await updateProjectMembership(
          Number(project.id),
          targetMember.membershipId,
          { role },
        )

      const mappedMembership =
        mapProjectMembership(membership)

      setMembers((currentMembers) =>
        currentMembers.map((member) =>
          member.id === mappedMembership.id
            ? mappedMembership
            : member,
        ),
      )
    } catch (error) {
      setMembersError(
        getMembershipErrorMessage(
          error,
          'Project role could not be changed.',
        ),
      )
    }
  }

  const handleRequestRemoveMember = (
    member: ProjectMember,
  ) => {
    if (!canManageMembers) return

    setMembersError(null)

    if (workItemsLoading) {
      setMembersError(
        'Work items are still loading. Try again in a moment.',
      )
      return
    }

    if (workItemsError) {
      setMembersError(
        'Work items could not be verified. Reload them before removing this member.',
      )
      return
    }

    if (
      getAssignmentCountForMember(member.id) > 0
    ) {
      setAssignmentResolutionAction({
        member,
        action: 'remove',
      })
      return
    }

    setMemberToRemove(member)
  }

  const handleConfirmAssignmentResolution = async (
    input: {
      resolution: AssignmentResolutionMode
      replacementUserId: string | null
    },
  ) => {
    if (
      !canManageMembers ||
      !assignmentResolutionAction
    ) {
      throw new Error(
        'Project membership can no longer be changed.',
      )
    }

    const numericProjectId = Number(project.id)
    const targetUserId = Number(
      assignmentResolutionAction.member.id,
    )

    if (
      !Number.isInteger(numericProjectId) ||
      numericProjectId <= 0 ||
      !Number.isInteger(targetUserId) ||
      targetUserId <= 0
    ) {
      throw new Error(
        'Invalid project or member ID.',
      )
    }

    let replacementUserId: number | null =
      null

    if (input.resolution === 'transfer') {
      replacementUserId = Number(
        input.replacementUserId,
      )

      if (
        !Number.isInteger(replacementUserId) ||
        replacementUserId <= 0
      ) {
        throw new Error(
          'Select a project member to receive the work.',
        )
      }
    }

    const action =
      assignmentResolutionAction
    const targetMember = action.member

    try {
      if (action.action === 'viewer') {
        const membership =
          await updateProjectMembership(
            numericProjectId,
            targetMember.membershipId,
            {
              role: 'viewer',
              assignmentResolution:
                input.resolution,
              ...(replacementUserId !== null
                ? { replacementUserId }
                : {}),
            },
          )

        const mappedMembership =
          mapProjectMembership(membership)

        setMembers((currentMembers) =>
          currentMembers.map((member) =>
            member.id === mappedMembership.id
              ? mappedMembership
              : member,
          ),
        )
      } else {
        await removeProjectMembership(
          numericProjectId,
          targetMember.membershipId,
          {
            assignmentResolution:
              input.resolution,
            ...(replacementUserId !== null
              ? { replacementUserId }
              : {}),
          },
        )

        setMembers((currentMembers) =>
          currentMembers.filter(
            (member) =>
              member.id !== targetMember.id,
          ),
        )
      }

      applyAssignmentResolutionToWorkItems(
        targetUserId,
        input.resolution,
        replacementUserId,
      )

      setAssignmentResolutionAction(null)

      if (
        action.action === 'remove' &&
        targetMember.id === currentUserId
      ) {
        navigate('/projects')
      }
    } catch (error) {
      throw new Error(
        getMembershipErrorMessage(
          error,
          action.action === 'remove'
            ? 'Project member could not be removed.'
            : 'Project role could not be changed.',
        ),
      )
    }
  }

  const handleConfirmRemoveMember = async () => {
    if (!canManageMembers || !memberToRemove) {
      return
    }

    setMembersError(null)

    try {
      await removeProjectMembership(
        Number(project.id),
        memberToRemove.membershipId,
      )

      const removedUserId = memberToRemove.id

      setMembers((currentMembers) =>
        currentMembers.filter(
          (member) => member.id !== removedUserId,
        ),
      )

      setMemberToRemove(null)

      if (removedUserId === currentUserId) {
        navigate('/projects')
      }
    } catch (error) {
      setMembersError(
        getMembershipErrorMessage(
          error,
          'Project member could not be removed.',
        ),
      )
    }
  }

  const handleCreateWorkItem = async (
    input: WorkItemFormInput,
  ) => {
    if (isReadOnly) {
      throw new Error(
        isArchived
          ? 'Archived Projects are read-only. Restore the Project first.'
          : 'A viewer cannot create Work Items.',
      )
    }

    const numericProjectId = Number(project.id)

    const assigneeIds = input.assigneeIds.map(
      (id) => Number(id),
    )

    if (
      !Number.isInteger(numericProjectId) ||
      assigneeIds.some(
        (id) => !Number.isInteger(id),
      )
    ) {
      throw new Error(
        'Invalid Project or assignee ID.',
      )
    }

    let parentId: number | null = null

    if (input.parentId != null) {
      parentId = Number(input.parentId)

      if (!Number.isInteger(parentId)) {
        throw new Error(
          'Invalid parent Work Item ID.',
        )
      }
    }

    setWorkItemsError(null)

    try {
      const created = await createWorkItem(
        numericProjectId,
        {
          title: input.title.trim(),
          description:
            input.description.trim(),
          type: input.type,
          status: input.status,
          assigneeIds,
          parentId,
          dueDate: input.dueDate,
          blockedReason: input.blockedReason,
        },
      )

      setApiWorkItems((current) => [
        created,
        ...current.filter(
          (item) => item.id !== created.id,
        ),
      ])
    } catch (error) {
      const message = getWorkItemErrorMessage(
        error,
        'Work item could not be created.',
      )

      setWorkItemsError(message)
      throw new Error(message)
    }
  }

  const handlePatchWorkItem = async (
    workItemId: number,
    patch: ApiUpdateWorkItemInput,
  ) => {
    if (isReadOnly) {
      throw new Error(
        isArchived
          ? 'Archived Projects are read-only. Restore the Project first.'
          : 'A viewer cannot edit Work Items.',
      )
    }

    if (
      !Number.isInteger(
        workItemId,
      ) ||
      patch.assigneeIds?.some(
        (id) =>
          !Number.isInteger(id),
      )
    ) {
      throw new Error(
        'Invalid Work Item or assignee ID.',
      )
    }

    if (
      patch.parentId != null &&
      !Number.isInteger(
        patch.parentId,
      )
    ) {
      throw new Error(
        'Invalid parent Work Item ID.',
      )
    }

    setWorkItemsError(null)

    try {
      const updated =
        await updateWorkItem(
          workItemId,
          patch,
        )

      setApiWorkItems(
        (current) =>
          current.map(
            (item) =>
              item.id ===
              updated.id
                ? updated
                : item,
          ),
      )
    } catch (error) {
      const message =
        getWorkItemErrorMessage(
          error,
          'Work item could not be updated.',
        )

      setWorkItemsError(message)

      throw new Error(message)
    }
  }

  const handleWorkItemStatusDrop = async (
    workItemId: number,
    newStatus: DemoWorkItemStatus,
  ) => {
    if (isReadOnly) {
      return
    }

    const previous = apiWorkItems.find(
      (item) => item.id === workItemId,
    )

    if (!previous || previous.status === newStatus) {
      return
    }

    setBoardStatusDropError(null)

    setApiWorkItems((current) =>
      current.map((item) =>
        item.id === workItemId
          ? { ...item, status: newStatus }
          : item,
      ),
    )

    try {
      const updated = await updateWorkItem(
        workItemId,
        { status: newStatus },
      )

      setApiWorkItems((current) =>
        current.map((item) =>
          item.id === updated.id ? updated : item,
        ),
      )
    } catch (error) {
      setApiWorkItems((current) =>
        current.map((item) =>
          item.id === workItemId ? previous : item,
        ),
      )

      setBoardStatusDropError(
        getWorkItemErrorMessage(
          error,
          'Work item status could not be updated.',
        ),
      )
    }
  }

  const projectWorkItems = forceEmptyWorkItems
    ? []
    : workItems

  const milestoneWorkItems =
    projectWorkItems
      .filter(
        (item) => item.type === 'milestone',
      )
      .slice()
      .sort(compareMilestoneWorkItems)

  const attentionWorkItems =
    projectWorkItems
      .flatMap((item) => {
        const kind = getAttentionKind(item)

        return kind
          ? [{ item, kind }]
          : []
      })
      .sort(compareAttentionItems)

  const handleOpenWorkItem = (
    item: DemoWorkItem,
  ) => {
    const workItemId =
      Number(item.id)

    if (
      !Number.isInteger(workItemId) ||
      workItemId <= 0
    ) {
      return
    }

    // The Work Item inspector has partial autosave (a serialized PATCH
    // queue, per-field commit-on-blur) so it is safe to redirect it at
    // a different Work Item without losing in-flight edits: the field
    // that was being edited already commits on blur — which fires
    // synchronously before this click handler runs — so its patch is
    // queued before we swap `workItemId` below. Clicking the Work Item
    // that is already open is a no-op; clicking any other Work Item
    // switches the same non-modal inspector to it in place.
    if (
      workItemDrawerState?.mode === 'edit' &&
      workItemDrawerState.workItemId === workItemId
    ) {
      return
    }

    setWorkItemDrawerState({
      mode: 'edit',
      workItemId,
    })
  }

  const selectedDrawerWorkItem =
    workItemDrawerState?.mode === 'edit'
      ? apiWorkItems.find(
          (item) =>
            item.id ===
            workItemDrawerState.workItemId,
        ) ?? null
      : null

  const selectedWorkItemId =
    workItemDrawerState?.mode === 'edit'
      ? String(
          workItemDrawerState.workItemId,
        )
      : null

  const workItemInspectorOpen =
    workItemDrawerState?.mode === 'edit'

  return (
    <div
      className={[
        'w-full px-6 py-8 lg:px-8 lg:py-10 xl:px-10',
        workItemInspectorOpen
          ? 'xl:pr-[552px]'
          : '',
      ].join(' ')}
    >
      <Link
        to={`/projects?group=${project.researchGroupId}`}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-on-surface-variant transition hover:text-primary"
      >
        <span
          aria-hidden="true"
          className="material-symbols-outlined text-[18px]"
        >
          arrow_back
        </span>
        Projects
      </Link>

      <header className="mt-6">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className={[
                  'h-2 w-2 rounded-full',
                  statusDotClass[projectStatus],
                ].join(' ')}
              />

              <span className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-on-surface-variant">
                {statusLabel[projectStatus]}
              </span>
            </div>

            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-on-surface lg:text-[34px]">
              {projectName}
            </h1>

          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-4">
            <div className="flex -space-x-2">
              {sortedMembers.slice(0, 4).map((member) => (
                <div
                  key={member.id}
                  title={member.name}
                  className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-background bg-surface-container-high text-[10px] font-semibold text-on-surface"
                >
                  {member.initials}
                </div>
              ))}

              {members.length > 4 && (
                <div className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-background bg-secondary-container text-[10px] font-semibold text-on-surface">
                  +{members.length - 4}
                </div>
              )}
            </div>

            <div className="h-6 w-px bg-outline-variant" />

            <span
              className={[
                'inline-flex rounded-full px-3 py-1.5 text-xs font-semibold',
                roleClass[currentMemberRole],
              ].join(' ')}
            >
              {roleLabel[currentMemberRole]}
            </span>
          </div>
        </div>

        <nav className="mt-8 flex gap-7 overflow-x-auto border-b border-outline-variant">
          {tabs.map((tab) => {
            const selected = activeTab === tab.id

            return (
              <Link
                key={tab.id}
                to={`/projects/${project.id}/${tab.id}`}
                aria-current={selected ? 'page' : undefined}
                className={[
                  'relative shrink-0 pb-3 text-sm font-medium transition',
                  selected
                    ? 'text-primary'
                    : 'text-on-surface-variant hover:text-on-surface',
                ].join(' ')}
              >
                {tab.label}

                {selected && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 bottom-0 h-0.5 bg-primary"
                  />
                )}
              </Link>
            )
          })}
        </nav>
      </header>

      {isArchived && (
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-outline-variant bg-surface-container-low px-4 py-3.5">
          <span className="material-symbols-outlined mt-0.5 text-[19px] text-on-surface-variant">
            archive
          </span>

          <div>
            <div className="text-sm font-medium text-on-surface">
              Archived project
            </div>

            <p className="mt-0.5 text-xs leading-5 text-on-surface-variant">
              This project is kept for reference and is read-only.
              {canManageProjectLifecycle
                ? ' Restore it from Settings to continue working.'
                : ''}
            </p>
          </div>
        </div>
      )}

      {isViewer && !isArchived && (
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-outline-variant bg-surface-container-low px-4 py-3.5">
          <span className="material-symbols-outlined mt-0.5 text-[19px] text-on-surface-variant">
            visibility
          </span>

          <div>
            <div className="text-sm font-medium text-on-surface">
              Viewer access
            </div>
            <p className="mt-0.5 text-xs leading-5 text-on-surface-variant">
              You can inspect this project, but editing actions are read-only.
            </p>
          </div>
        </div>
      )}


      {activeTab === 'overview' && (
        <div className="mt-7 max-w-4xl space-y-10">
          <section>
            <div className="flex min-h-8 items-center justify-between border-b border-outline-variant/50 pb-3">
              <h2 className="text-sm font-semibold text-on-surface">
                About
              </h2>

              {canEditProjectSettings &&
                projectDescription.trim().length > 0 &&
                !forceEmptyDescription && (
                  <button
                    type="button"
                    onClick={() => navigateToTab('settings')}
                    className="text-xs font-medium text-on-surface-variant transition hover:text-primary"
                  >
                    Edit
                  </button>
                )}
            </div>

            {projectDescription.trim().length > 0 &&
            !forceEmptyDescription ? (
              <p className="max-w-3xl pt-4 text-sm leading-6 text-on-surface">
                {projectDescription}
              </p>
            ) : (
              <div className="flex min-h-28 items-center justify-between gap-6 py-5">
                <div>
                  <p className="text-sm font-medium text-on-surface">
                    No description yet.
                  </p>

                  <p className="mt-1 max-w-lg text-xs leading-5 text-on-surface-variant">
                    Add context so project members can quickly understand
                    the purpose of this project.
                  </p>
                </div>

                {canEditProjectSettings && (
                  <button
                    type="button"
                    onClick={() => navigateToTab('settings')}
                    className="shrink-0 text-xs font-medium text-primary transition hover:opacity-75"
                  >
                    Add description
                  </button>
                )}
              </div>
            )}
          </section>

          <section
            aria-labelledby="overview-milestones-heading"
          >
            <div className="border-b border-outline-variant/50 pb-3">
              <h2
                id="overview-milestones-heading"
                className="text-sm font-semibold text-on-surface"
              >
                Milestones
              </h2>
            </div>

            {workItemsLoading ? (
              <p className="py-5 text-sm text-on-surface-variant">
                Loading milestones…
              </p>
            ) : workItemsError ? (
              <p className="py-5 text-sm text-on-surface-variant">
                Project work could not be loaded.
              </p>
            ) : milestoneWorkItems.length > 0 ? (
              <div className="divide-y divide-outline-variant/30">
                {milestoneWorkItems.map((item) => (
                  <OverviewWorkItemRow
                    key={item.id}
                    item={item}
                    selected={
                      selectedWorkItemId ===
                      item.id
                    }
                    onOpen={handleOpenWorkItem}
                  />
                ))}
              </div>
            ) : (
              <p className="py-5 text-sm text-on-surface-variant">
                No milestones yet.
              </p>
            )}
          </section>

          <section
            aria-labelledby="overview-attention-heading"
          >
            <div className="border-b border-outline-variant/50 pb-3">
              <h2
                id="overview-attention-heading"
                className="text-sm font-semibold text-on-surface"
              >
                Needs Attention
              </h2>
            </div>

            {workItemsLoading ? (
              <p className="py-5 text-sm text-on-surface-variant">
                Checking project work…
              </p>
            ) : workItemsError ? (
              <p className="py-5 text-sm text-on-surface-variant">
                Project work could not be loaded.
              </p>
            ) : attentionWorkItems.length > 0 ? (
              <div className="divide-y divide-outline-variant/30">
                {attentionWorkItems.map(
                  ({ item, kind }) => (
                    <OverviewWorkItemRow
                      key={item.id}
                      item={item}
                      attentionKind={kind}
                      selected={
                        selectedWorkItemId ===
                        item.id
                      }
                      onOpen={handleOpenWorkItem}
                    />
                  ),
                )}
              </div>
            ) : (
              <p className="py-5 text-sm text-on-surface-variant">
                Nothing needs attention right now.
              </p>
            )}
          </section>
        </div>
      )}

      {activeTab === 'work-items' &&
        workItemsError && (
          <div
            role="alert"
            className="mt-6 rounded-xl border border-error/20 bg-error-container/35 px-5 py-4 text-sm text-error"
          >
            {workItemsError}
          </div>
        )}

      {activeTab === 'work-items' &&
        workItemsLoading && (
          <div className="mt-6 flex min-h-40 items-center justify-center rounded-xl border border-outline-variant bg-surface-container-lowest text-sm text-on-surface-variant">
            <span className="material-symbols-outlined mr-2 animate-spin text-[18px]">
              refresh
            </span>
            Loading work items…
          </div>
        )}

      {activeTab === 'work-items' &&
        !workItemsLoading && (
          <ProjectWorkItemsPanel
            items={projectWorkItems}
            eligibleAssignees={sortedMembers.filter(
              (member) => member.role !== 'viewer',
            )}
            readOnly={isReadOnly}
            onCreate={() =>
              setWorkItemDrawerState({
                mode: 'create',
              })
            }
            onOpen={handleOpenWorkItem}
            selectedWorkItemId={
              selectedWorkItemId
            }
            onStatusDrop={handleWorkItemStatusDrop}
            statusDropError={boardStatusDropError}
            onDismissStatusDropError={() =>
              setBoardStatusDropError(null)
            }
            preferencesKey={
              user
                ? `fg-workspace:project-work-items:v1:${user.id}:${project.id}`
                : null
            }
          />
        )}

      {activeTab === 'settings' && (
        <section className="mt-6 overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest shadow-sm">
          <div className="border-b border-outline-variant px-6 py-5">
            <h2 className="font-semibold text-on-surface">
              Project settings
            </h2>

            <p className="mt-0.5 text-xs text-on-surface-variant">
              Manage the project identity and lifecycle.
            </p>
          </div>

          {!canEditProjectSettings && (
            <div className="flex items-start gap-3 border-b border-outline-variant bg-surface-container-low px-6 py-4">
              <span className="material-symbols-outlined mt-0.5 text-[18px] text-on-surface-variant">
                lock
              </span>

              <div>
                <div className="text-sm font-medium text-on-surface">
                  Read-only settings
                </div>

                <p className="mt-0.5 text-xs leading-5 text-on-surface-variant">
                  {isArchived
                    ? 'Restore this project before changing its settings.'
                    : 'Only project owners can change project settings.'}
                </p>
              </div>
            </div>
          )}

          <div className="space-y-7 px-6 py-6">
            <div className="max-w-2xl">
              <label
                htmlFor="settings-project-name"
                className="mb-1.5 block text-sm font-medium text-on-surface"
              >
                Project name
              </label>

              <input
                id="settings-project-name"
                type="text"
                value={settingsName}
                disabled={!canEditProjectSettings}
                onChange={(event) =>
                  setSettingsName(event.target.value)
                }
                className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:cursor-not-allowed disabled:bg-surface-container-low disabled:text-on-surface-variant"
              />

              <p className="mt-1.5 text-xs text-on-surface-variant">
                Used throughout the workspace to identify this project.
              </p>
            </div>

            <div className="max-w-2xl">
              <div className="mb-1.5 flex items-center justify-between">
                <label
                  htmlFor="settings-project-description"
                  className="block text-sm font-medium text-on-surface"
                >
                  Description
                </label>

                <span className="text-xs text-on-surface-variant">
                  Optional
                </span>
              </div>

              <textarea
                id="settings-project-description"
                value={settingsDescription}
                disabled={!canEditProjectSettings}
                onChange={(event) =>
                  setSettingsDescription(event.target.value)
                }
                rows={4}
                placeholder="Describe the purpose and context of this project..."
                className="w-full resize-none rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2.5 text-sm leading-6 text-on-surface outline-none transition placeholder:text-on-surface-variant/60 focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:cursor-not-allowed disabled:bg-surface-container-low disabled:text-on-surface-variant"
              />
            </div>

            <fieldset>
              <legend className="text-sm font-medium text-on-surface">
                Project status
              </legend>

              <p className="mt-1 text-xs text-on-surface-variant">
                Control whether the project is actively worked on, temporarily
                paused or finished.
              </p>

              <div className="mt-3 grid max-w-4xl gap-3 md:grid-cols-3">
                <label
                  className={[
                    'flex items-start gap-3 rounded-xl border p-4 transition',
                    canEditProjectSettings
                      ? 'cursor-pointer'
                      : 'cursor-not-allowed',
                    settingsStatus === 'active'
                      ? 'border-emerald-600 bg-emerald-50 ring-1 ring-emerald-600/20'
                      : 'border-outline-variant bg-surface-container-lowest',
                  ].join(' ')}
                >
                  <input
                    type="radio"
                    name="settings-project-status"
                    value="active"
                    checked={settingsStatus === 'active'}
                    disabled={!canEditProjectSettings}
                    onChange={() => setSettingsStatus('active')}
                    className="sr-only"
                  />

                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                    <span className="material-symbols-outlined text-[19px]">
                      play_arrow
                    </span>
                  </div>

                  <div>
                    <div className="text-sm font-semibold text-on-surface">
                      Active
                    </div>

                    <p className="mt-1 text-xs leading-5 text-on-surface-variant">
                      Project work is currently active.
                    </p>
                  </div>
                </label>

                <label
                  className={[
                    'flex items-start gap-3 rounded-xl border p-4 transition',
                    canEditProjectSettings
                      ? 'cursor-pointer'
                      : 'cursor-not-allowed',
                    settingsStatus === 'paused'
                      ? 'border-amber-500 bg-amber-50 ring-1 ring-amber-500/20'
                      : 'border-outline-variant bg-surface-container-lowest',
                  ].join(' ')}
                >
                  <input
                    type="radio"
                    name="settings-project-status"
                    value="paused"
                    checked={settingsStatus === 'paused'}
                    disabled={!canEditProjectSettings}
                    onChange={() => setSettingsStatus('paused')}
                    className="sr-only"
                  />

                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700">
                    <span className="material-symbols-outlined text-[19px]">
                      pause
                    </span>
                  </div>

                  <div>
                    <div className="text-sm font-semibold text-on-surface">
                      Paused
                    </div>

                    <p className="mt-1 text-xs leading-5 text-on-surface-variant">
                      Keep the project, but pause active work.
                    </p>
                  </div>
                </label>

                <label
                  className={[
                    'flex items-start gap-3 rounded-xl border p-4 transition',
                    canEditProjectSettings
                      ? 'cursor-pointer'
                      : 'cursor-not-allowed',
                    settingsStatus === 'completed'
                      ? 'border-primary bg-primary-fixed/35 ring-1 ring-primary/15'
                      : 'border-outline-variant bg-surface-container-lowest',
                  ].join(' ')}
                >
                  <input
                    type="radio"
                    name="settings-project-status"
                    value="completed"
                    checked={settingsStatus === 'completed'}
                    disabled={!canEditProjectSettings}
                    onChange={() => setSettingsStatus('completed')}
                    className="sr-only"
                  />

                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-fixed text-primary">
                    <span className="material-symbols-outlined text-[19px]">
                      task_alt
                    </span>
                  </div>

                  <div>
                    <div className="text-sm font-semibold text-on-surface">
                      Completed
                    </div>

                    <p className="mt-1 text-xs leading-5 text-on-surface-variant">
                      Mark the project as finished.
                    </p>
                  </div>
                </label>
              </div>
            </fieldset>

            <div className="border-t border-outline-variant pt-6">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-medium text-on-surface">
                      Access
                    </h3>

                    <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-surface-container-high px-2 py-0.5 text-[11px] font-semibold text-on-surface-variant">
                      {members.length}
                    </span>
                  </div>

                  <p className="mt-1 text-xs leading-5 text-on-surface-variant">
                    People with access to this project and their current role.
                  </p>
                </div>

                {canManageMembers ? (
                  <button
                    type="button"
                    onClick={() =>
                      setAddMemberDialogOpen(true)
                    }
                    className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-3.5 text-sm font-semibold text-white shadow-sm transition hover:bg-primary/90"
                  >
                    <span className="material-symbols-outlined text-[18px]">
                      person_add
                    </span>
                    Add member
                  </button>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-on-surface-variant">
                    <span className="material-symbols-outlined text-[17px]">
                      lock
                    </span>
                    Membership management unavailable
                  </span>
                )}
              </div>

              {membersError && (
                <div
                  role="alert"
                  className="mt-4 rounded-lg border border-error/20 bg-error-container/35 px-4 py-3 text-sm text-error"
                >
                  {membersError}
                </div>
              )}

              {membersLoading && (
                <div className="mt-4 flex items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-low px-4 py-3 text-sm text-on-surface-variant">
                  <span className="material-symbols-outlined animate-spin text-[18px]">
                    refresh
                  </span>
                  Loading project members…
                </div>
              )}

              {!membersLoading && (
                <div className="mt-4 overflow-hidden rounded-lg border border-outline-variant">
                  <div className="hidden border-b border-outline-variant bg-surface-container-low px-4 py-2.5 sm:grid sm:grid-cols-[minmax(0,1fr)_190px_52px]">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-on-surface-variant">
                      Member
                    </div>

                    <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-on-surface-variant">
                      Role
                    </div>

                    <div className="text-right text-[10px] font-semibold uppercase tracking-[0.12em] text-on-surface-variant">
                      Actions
                    </div>
                  </div>

                  <div className="divide-y divide-outline-variant">
                    {sortedMembers.map((member) => {
                      const isMemberOwner =
                        member.role === 'owner'
                      const isLastOwner =
                        isMemberOwner &&
                        ownerCount <= 1

                      return (
                        <div
                          key={member.id}
                          className="grid gap-4 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_190px_52px] sm:items-center"
                        >
                          <div className="flex min-w-0 items-center gap-3">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-[11px] font-semibold text-on-surface">
                              {member.initials}
                            </div>

                            <div className="min-w-0">
                              <span className="block truncate text-sm font-medium text-on-surface">
                                {member.name}
                              </span>

                              <div className="truncate text-xs text-on-surface-variant">
                                @{member.username}
                              </div>
                            </div>
                          </div>

                          <div>
                            <div className="flex items-center gap-2">
                              <span
                                title={roleLabel[member.role]}
                                className={[
                                  'material-symbols-outlined shrink-0 text-[19px]',
                                  member.role === 'owner'
                                    ? 'text-primary'
                                    : member.role === 'member'
                                      ? 'text-emerald-600'
                                      : 'text-on-surface-variant',
                                ].join(' ')}
                              >
                                {roleIcon[member.role]}
                              </span>

                              {canManageMembers ? (
                                <select
                                  value={member.role}
                                  onChange={(event) =>
                                    handleMemberRoleChange(
                                      member.id,
                                      event.target.value as AddableProjectRole,
                                    )
                                  }
                                  aria-label={`Role for ${member.name}`}
                                  title={
                                    isLastOwner
                                      ? 'Add another owner before changing the last owner.'
                                      : undefined
                                  }
                                  className="h-9 min-w-32 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm font-medium text-on-surface outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
                                >
                                  <option value="owner">
                                    Owner
                                  </option>

                                  <option
                                    value="member"
                                    disabled={isLastOwner}
                                  >
                                    Member
                                  </option>

                                  <option
                                    value="viewer"
                                    disabled={isLastOwner}
                                  >
                                    Viewer
                                  </option>
                                </select>
                              ) : (
                                <span
                                  className={[
                                    'inline-flex rounded-full px-2.5 py-1 text-xs font-medium',
                                    roleClass[member.role],
                                  ].join(' ')}
                                >
                                  {roleLabel[member.role]}
                                </span>
                              )}
                            </div>

                            {isLastOwner &&
                              canManageMembers && (
                                <p className="mt-1 text-[10px] text-on-surface-variant">
                                  Last owner
                                </p>
                              )}
                          </div>

                          <div className="flex justify-end">
                            {canManageMembers && (
                              <button
                                type="button"
                                disabled={isLastOwner}
                                onClick={() =>
                                  handleRequestRemoveMember(
                                    member,
                                  )
                                }
                                title={
                                  isLastOwner
                                    ? 'Add another owner before removing the last owner.'
                                    : `Remove ${member.name} from this project`
                                }
                                className="h-8 rounded-lg px-2.5 text-xs font-medium text-on-surface-variant transition hover:bg-error-container hover:text-error disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-on-surface-variant"
                              >
                                Remove
                              </button>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  {!canManageMembers && (
                    <div className="flex items-start gap-3 border-t border-outline-variant bg-surface-container-low/55 px-4 py-4">
                      <span className="material-symbols-outlined mt-0.5 text-[18px] text-on-surface-variant">
                        info
                      </span>

                      <p className="text-xs leading-5 text-on-surface-variant">
                        {isArchived
                          ? 'Archived projects are read-only. Restore this project before changing members or roles.'
                          : 'Only the project owner can add or remove members and change project roles.'}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {canManageProjectLifecycle && (
              <div className="border-t border-outline-variant pt-6">
                <div className="flex max-w-3xl items-start justify-between gap-6">
                  <div>
                    <h3 className="text-sm font-medium text-on-surface">
                      {isArchived
                        ? 'Restore project'
                        : 'Archive project'}
                    </h3>

                    <p className="mt-1 max-w-xl text-xs leading-5 text-on-surface-variant">
                      {isArchived
                        ? 'Return this project to the current workspace and enable editing again.'
                        : 'Remove this project from the current workspace without losing its work, members or history.'}
                    </p>
                  </div>

                  {isArchived ? (
                    <button
                      type="button"
                      disabled={lifecycleSaving}
                      onClick={() =>
                        void handleRestoreProject()
                      }
                      className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-outline-variant bg-surface-container-lowest px-3.5 text-sm font-semibold text-on-surface transition hover:border-primary/40 hover:bg-surface-container-low disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      <span
                        aria-hidden="true"
                        className="material-symbols-outlined text-[18px]"
                      >
                        unarchive
                      </span>
                      Restore
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={lifecycleSaving}
                      onClick={() => {
                        setLifecycleError(null)
                        setLifecycleAction('archive')
                      }}
                      className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-outline-variant bg-surface-container-lowest px-3.5 text-sm font-semibold text-on-surface transition hover:border-primary/40 hover:bg-surface-container-low disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      <span
                        aria-hidden="true"
                        className="material-symbols-outlined text-[18px]"
                      >
                        archive
                      </span>
                      Archive
                    </button>
                  )}
                </div>
              </div>
            )}

            {canManageProjectLifecycle && (
              <div className="border-t border-error/20 pt-6">
                <div className="flex max-w-3xl items-start justify-between gap-6">
                  <div>
                    <h3 className="text-sm font-medium text-error">
                      Delete project
                    </h3>

                    <p className="mt-1 max-w-xl text-xs leading-5 text-on-surface-variant">
                      Only an empty project can be permanently deleted.
                      Projects containing work must be archived instead.
                    </p>

                    {!workItemsLoading &&
                      projectHasWork && (
                        <p className="mt-1.5 text-xs font-medium text-on-surface-variant">
                          This project contains{' '}
                          {apiWorkItems.length}{' '}
                          {apiWorkItems.length === 1
                            ? 'work item'
                            : 'work items'}
                          , so permanent deletion is unavailable.
                        </p>
                      )}
                  </div>

                  <button
                    type="button"
                    disabled={
                      !canDeleteProject ||
                      lifecycleSaving
                    }
                    onClick={() => {
                      setLifecycleError(null)
                      setLifecycleAction('delete')
                    }}
                    className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-error/35 px-3.5 text-sm font-semibold text-error transition hover:bg-error-container/35 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <span
                      aria-hidden="true"
                      className="material-symbols-outlined text-[18px]"
                    >
                      delete
                    </span>
                    Delete
                  </button>
                </div>
              </div>
            )}

          </div>

          {lifecycleError && (
            <div
              role="alert"
              className="border-t border-error/20 bg-error-container/35 px-6 py-3 text-sm text-error"
            >
              {lifecycleError}
            </div>
          )}

          {settingsError && (
            <div
              role="alert"
              className="border-t border-error/20 bg-error-container/35 px-6 py-3 text-sm text-error"
            >
              {settingsError}
            </div>
          )}

          {canEditProjectSettings && (
            <div className="flex flex-col gap-3 border-t border-outline-variant bg-surface-container-low/45 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-xs text-on-surface-variant">
                {settingsSaving
                  ? 'Saving changes…'
                  : settingsDirty
                    ? 'You have unsaved changes.'
                    : 'All changes are saved.'}
              </div>

              <div className="flex items-center justify-end gap-3">
                <button
                  type="button"
                  disabled={!settingsDirty || settingsSaving}
                  onClick={handleResetProjectSettings}
                  className="h-9 rounded-lg px-4 text-sm font-medium text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Cancel
                </button>

                <button
                  type="button"
                  disabled={
                    !settingsDirty ||
                    !settingsValid ||
                    settingsSaving
                  }
                  onClick={() =>
                    void handleSaveProjectSettings()
                  }
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <span className="material-symbols-outlined text-[18px]">
                    save
                  </span>
                  {settingsSaving
                    ? 'Saving…'
                    : 'Save changes'}
                </button>
              </div>
            </div>
          )}
        </section>
      )}


      <AddProjectMemberDialog
        open={addMemberDialogOpen}
        users={directoryUsers}
        excludedUserIds={members.map((member) => member.id)}
        onClose={() => setAddMemberDialogOpen(false)}
        onAdd={handleAddMember}
      />

      <ProjectLifecycleDialog
        open={lifecycleAction !== null}
        action={lifecycleAction ?? 'archive'}
        projectName={projectName}
        busy={lifecycleSaving}
        onClose={() => {
          if (!lifecycleSaving) {
            setLifecycleAction(null)
          }
        }}
        onConfirm={() =>
          void handleConfirmLifecycle()
        }
      />

      <ProjectAssignmentResolutionDialog
        open={assignmentResolutionAction != null}
        action={
          assignmentResolutionAction?.action ??
          'viewer'
        }
        memberName={
          assignmentResolutionAction?.member.name ??
          ''
        }
        affectedCount={
          assignmentResolutionCount
        }
        candidates={
          assignmentResolutionCandidates
        }
        onClose={() =>
          setAssignmentResolutionAction(null)
        }
        onConfirm={
          handleConfirmAssignmentResolution
        }
      />

      <RemoveProjectMemberDialog
        open={memberToRemove != null}
        memberName={memberToRemove?.name ?? ''}
        onClose={() => setMemberToRemove(null)}
        onConfirm={handleConfirmRemoveMember}
      />

      <WorkItemDrawer
        open={workItemDrawerState != null}
        mode={
          workItemDrawerState?.mode ??
          'create'
        }
        projectName={project.name}
        item={selectedDrawerWorkItem}
        readOnly={isReadOnly}
        assignees={sortedMembers
          .filter(
            (member) =>
              member.role !== 'viewer',
          )
          .map((member) => ({
            id: member.id,
            name: member.name,
            initials: member.initials,
          }))}
        parentItems={projectWorkItems.map(
          (item) => ({
            id: item.id,
            title: item.title,
            type: item.type,
          }),
        )}
        onClose={() =>
          setWorkItemDrawerState(null)
        }
        onCreate={handleCreateWorkItem}
        onPatch={handlePatchWorkItem}
      />
    </div>
  )
}

function OverviewWorkItemRow({
  item,
  attentionKind = null,
  selected,
  onOpen,
}: {
  item: DemoWorkItem
  attentionKind?: AttentionKind | null
  selected: boolean
  onOpen: (item: DemoWorkItem) => void
}) {
  const status =
    workItemStatusDisplay[item.status]

  const due =
    getWorkItemDueDisplay(item)

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${item.title}`}
      onClick={() => onOpen(item)}
      onKeyDown={(event) => {
        if (
          event.key === 'Enter' ||
          event.key === ' '
        ) {
          event.preventDefault()
          onOpen(item)
        }
      }}
      data-work-item-id={item.id}
      data-attention-kind={
        attentionKind ?? undefined
      }
      data-selected={
        selected
          ? 'true'
          : undefined
      }
      className={[
        'grid gap-3 py-3.5 sm:grid-cols-[minmax(0,1fr)_130px_180px_110px] sm:items-center',
        selected
          ? 'outline outline-1 -outline-offset-1 outline-primary/55 bg-primary/5'
          : '',
      ].join(' ')}
    >
      <div className="min-w-0">
        {attentionKind && (
          <div
            className={[
              'mb-1 text-[10px] font-semibold uppercase tracking-[0.1em]',
              attentionKind === 'unassigned'
                ? 'text-on-surface-variant'
                : 'text-error',
            ].join(' ')}
          >
            {attentionLabel[attentionKind]}
          </div>
        )}

        <div className="flex min-w-0 items-center gap-2">
          <span
            title={workItemTypeLabels[item.type]}
            aria-label={workItemTypeLabels[item.type]}
            className="material-symbols-outlined shrink-0 text-[15px] text-on-surface-variant/80"
          >
            {workItemTypeIcons[item.type]}
          </span>

          <span className="truncate text-sm font-semibold text-on-surface">
            {item.title}
          </span>
        </div>
      </div>

      <div
        className={[
          'flex items-center gap-2 text-xs font-normal',
          status.className,
        ].join(' ')}
      >
        <span
          aria-hidden="true"
          className="inline-flex w-4 shrink-0 justify-center text-[15px] leading-none"
        >
          {status.glyph}
        </span>

        <span className="text-on-surface-variant">
          {workItemStatusLabels[item.status]}
        </span>
      </div>

      <WorkItemAssignees
        assignees={item.assignees}
      />

      <span
        className={[
          'text-xs',
          due.attention
            ? 'font-medium text-error'
            : 'text-on-surface-variant',
        ].join(' ')}
      >
        {due.label}
      </span>
    </div>
  )
}

function ProjectWorkItemsPanel({
  items,
  eligibleAssignees,
  readOnly,
  onCreate,
  onOpen,
  selectedWorkItemId,
  onStatusDrop,
  statusDropError,
  onDismissStatusDropError,
  preferencesKey,
}: {
  items: DemoWorkItem[]
  eligibleAssignees: ProjectMember[]
  readOnly: boolean
  onCreate: () => void
  onOpen: (item: DemoWorkItem) => void
  selectedWorkItemId: string | null
  onStatusDrop: (
    workItemId: number,
    newStatus: DemoWorkItemStatus,
  ) => void
  statusDropError: string | null
  onDismissStatusDropError: () => void
  preferencesKey: string | null
}) {
  const [view, setView] = useState<WorkItemsView>('board')
  const [draggedItemId, setDraggedItemId] =
    useState<string | null>(null)
  const [dragOverStatus, setDragOverStatus] =
    useState<DemoWorkItemStatus | null>(null)
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] =
    useState<WorkItemsTypeFilter>('all')
  const [assigneeFilter, setAssigneeFilter] = useState('all')
  const [blockedOnly, setBlockedOnly] = useState(false)
  const [loadedPreferencesKey, setLoadedPreferencesKey] =
    useState<string | null>(null)

  useEffect(() => {
    if (!preferencesKey) {
      setLoadedPreferencesKey(null)
      return
    }

    try {
      const raw = window.localStorage.getItem(preferencesKey)

      if (!raw) {
        setView('board')
        setQuery('')
        setTypeFilter('all')
        setAssigneeFilter('all')
        setBlockedOnly(false)
        setLoadedPreferencesKey(preferencesKey)
        return
      }

      const parsed = JSON.parse(raw) as Partial<WorkItemsPreferences>

      setView(
        parsed.view === 'list' || parsed.view === 'board'
          ? parsed.view
          : 'board',
      )

      setQuery(typeof parsed.query === 'string' ? parsed.query : '')

      setTypeFilter(
        parsed.type === 'epic' ||
          parsed.type === 'milestone' ||
          parsed.type === 'deliverable' ||
          parsed.type === 'task'
          ? parsed.type
          : 'all',
      )

      setAssigneeFilter(
        typeof parsed.assignee === 'string'
          ? parsed.assignee
          : 'all',
      )

      setBlockedOnly(parsed.blockedOnly === true)
    } catch {
      setView('board')
      setQuery('')
      setTypeFilter('all')
      setAssigneeFilter('all')
      setBlockedOnly(false)
    }

    setLoadedPreferencesKey(preferencesKey)
  }, [preferencesKey])

  useEffect(() => {
    if (
      !preferencesKey ||
      loadedPreferencesKey !== preferencesKey
    ) {
      return
    }

    const preferences: WorkItemsPreferences = {
      view,
      query,
      type: typeFilter,
      assignee: assigneeFilter,
      blockedOnly,
    }

    try {
      window.localStorage.setItem(
        preferencesKey,
        JSON.stringify(preferences),
      )
    } catch {
      // UI preferences must never break the workspace.
    }
  }, [
    preferencesKey,
    loadedPreferencesKey,
    view,
    query,
    typeFilter,
    assigneeFilter,
    blockedOnly,
  ])


  useEffect(() => {
    if (
      assigneeFilter !== 'all' &&
      !eligibleAssignees.some(
        (assignee) => assignee.id === assigneeFilter,
      )
    ) {
      setAssigneeFilter('all')
    }
  }, [assigneeFilter, eligibleAssignees])

  const sortedEligibleAssignees = useMemo(
    () =>
      [...eligibleAssignees].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    [eligibleAssignees],
  )

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()

    return items.filter((item) => {
      const matchesQuery =
        normalizedQuery.length === 0 ||
        item.title.toLowerCase().includes(normalizedQuery) ||
        item.assignees.some((assignee) =>
          assignee.name.toLowerCase().includes(normalizedQuery),
        ) ||
        workItemTypeLabels[item.type]
          .toLowerCase()
          .includes(normalizedQuery)

      const matchesType =
        typeFilter === 'all' || item.type === typeFilter

      const matchesAssignee =
        assigneeFilter === 'all' ||
        item.assignees.some(
          (assignee) => assignee.id === assigneeFilter,
        )

      const matchesBlocked = !blockedOnly || Boolean(item.blockedReason)

      return (
        matchesQuery &&
        matchesType &&
        matchesAssignee &&
        matchesBlocked
      )
    })
  }, [
    assigneeFilter,
    blockedOnly,
    items,
    query,
    typeFilter,
  ])

  const hasActiveFilters =
    query.trim().length > 0 ||
    typeFilter !== 'all' ||
    assigneeFilter !== 'all' ||
    blockedOnly

  const clearFilters = () => {
    setQuery('')
    setTypeFilter('all')
    setAssigneeFilter('all')
    setBlockedOnly(false)
  }

  const statusColumns = workItemStatusOptions.map((status) => ({
    status: status.value,
    label: status.label,
  }))

  const typeFilters: Array<{
    value: WorkItemsTypeFilter
    label: string
  }> = [
    { value: 'all', label: 'All' },
    ...workItemTypeOptions.map((type) => ({
      value: type.value,
      label: type.label,
    })),
  ]

  if (items.length === 0) {
    return (
      <section className="mt-6 rounded-xl border border-outline-variant bg-surface-container-lowest shadow-sm">
        <div className="px-6 py-8">
          <h2 className="text-lg font-semibold tracking-tight text-on-surface">
            Work Items
          </h2>

          <div className="mt-8 max-w-md">
            <p className="text-sm font-medium text-on-surface">
              No work items yet.
            </p>

            <p className="mt-1 text-sm leading-6 text-on-surface-variant">
              Create the first piece of project work.
            </p>

            {!readOnly && (
              <button
                type="button"
                onClick={onCreate}
                className="mt-5 inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-primary/90"
              >
                <span
                  aria-hidden="true"
                  className="material-symbols-outlined text-[18px]"
                >
                  add
                </span>
                New work item
              </button>
            )}
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="mt-6 overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest shadow-sm">
      <div className="flex items-start justify-between gap-8 border-b border-outline-variant px-6 py-5">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold tracking-tight text-on-surface">
              Work Items
            </h2>

            <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-surface-container-high px-2 py-0.5 text-[11px] font-semibold text-on-surface-variant">
              {items.length}
            </span>
          </div>

          <p className="mt-1 text-sm text-on-surface-variant">
            Plan and track the work that belongs to this project.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {!readOnly && (
            <button
              type="button"
              onClick={onCreate}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-primary/90"
            >
              <span className="material-symbols-outlined text-[18px]">
                add
              </span>
              New work item
            </button>
          )}

          {readOnly && (
            <span className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-surface-container-high px-3 text-xs font-semibold text-on-surface-variant">
              <span className="material-symbols-outlined text-[17px]">
                visibility
              </span>
              Read-only
            </span>
          )}

          <div className="inline-flex rounded-lg border border-outline-variant bg-surface-container-low p-1">
            <button
              type="button"
              onClick={() => setView('board')}
              className={[
                'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition',
                view === 'board'
                  ? 'bg-surface-container-lowest text-on-surface shadow-sm'
                  : 'text-on-surface-variant hover:text-on-surface',
              ].join(' ')}
            >
              <span
                aria-hidden="true"
                className="material-symbols-outlined text-[17px]"
              >
                view_kanban
              </span>
              Board
            </button>

            <button
              type="button"
              onClick={() => setView('list')}
              className={[
                'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition',
                view === 'list'
                  ? 'bg-surface-container-lowest text-on-surface shadow-sm'
                  : 'text-on-surface-variant hover:text-on-surface',
              ].join(' ')}
            >
              <span
                aria-hidden="true"
                className="material-symbols-outlined text-[17px]"
              >
                view_list
              </span>
              List
            </button>
          </div>
        </div>
      </div>

      <div className="border-b border-outline-variant bg-surface-container-low/35 px-6 py-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <label className="relative block w-56 shrink-0">
            <span className="sr-only">Search work items</span>

            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-on-surface-variant">
              search
            </span>

            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search..."
              className="h-9 w-full rounded-lg border border-outline-variant bg-surface-container-lowest pl-10 pr-3 text-sm text-on-surface outline-none transition placeholder:text-on-surface-variant/60 focus:border-primary focus:ring-2 focus:ring-primary/15"
            />
          </label>

          <select
            aria-label="Filter by assignee"
            value={assigneeFilter}
            onChange={(event) =>
              setAssigneeFilter(event.target.value)
            }
            className="h-9 min-w-32 rounded-lg border border-outline-variant bg-surface-container-lowest px-2.5 text-sm font-medium text-on-surface outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
          >
            <option value="all">Anyone</option>

            {sortedEligibleAssignees.map((assignee) => (
              <option key={assignee.id} value={assignee.id}>
                {assignee.name}
              </option>
            ))}
          </select>

          <select
            aria-label="Filter by type"
            value={typeFilter}
            onChange={(event) =>
              setTypeFilter(
                event.target.value as WorkItemsTypeFilter,
              )
            }
            className="h-9 min-w-28 rounded-lg border border-outline-variant bg-surface-container-lowest px-2.5 text-sm font-medium text-on-surface outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
          >
            {typeFilters.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>

          <label className="flex h-9 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface">
            <input
              type="checkbox"
              checked={blockedOnly}
              onChange={(event) =>
                setBlockedOnly(event.target.checked)
              }
              className="h-4 w-4 rounded border-outline accent-primary"
            />
            Blocked
          </label>

          <div className="ml-auto flex items-center gap-3">
            <span className="text-xs text-on-surface-variant">
              {filteredItems.length}{' '}
              {filteredItems.length === 1 ? 'item' : 'items'}
            </span>

            {hasActiveFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-primary transition hover:bg-primary-fixed"
              >
                <span className="material-symbols-outlined text-[17px]">
                  filter_alt_off
                </span>
                Clear
              </button>
            )}
          </div>
        </div>
      </div>

      {view === 'board' && statusDropError && (
        <div
          role="alert"
          className="flex items-start gap-2.5 border-b border-error/20 bg-error-container/35 px-6 py-3 text-sm text-error"
        >
          <span
            aria-hidden="true"
            className="material-symbols-outlined mt-0.5 text-[18px]"
          >
            error
          </span>

          <p className="flex-1">{statusDropError}</p>

          <button
            type="button"
            onClick={onDismissStatusDropError}
            className="shrink-0 text-xs font-semibold text-error underline-offset-2 hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {filteredItems.length === 0 ? (
        <div className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant">
            <span className="material-symbols-outlined text-[22px]">
              search_off
            </span>
          </div>

          <h3 className="mt-4 text-sm font-semibold text-on-surface">
            No matching work items
          </h3>

          <p className="mt-1 max-w-sm text-sm leading-6 text-on-surface-variant">
            No work items match the current search and filters.
          </p>

          <button
            type="button"
            onClick={clearFilters}
            className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg px-3 text-sm font-semibold text-primary transition hover:bg-primary-fixed"
          >
            <span className="material-symbols-outlined text-[18px]">
              filter_alt_off
            </span>
            Clear filters
          </button>
        </div>
      ) : view === 'board' ? (
        <div className="overflow-x-auto">
          <div
            className="grid min-w-max gap-3 p-4"
            style={{
              gridTemplateColumns: `repeat(${Math.max(
                statusColumns.length,
                1,
              )}, minmax(260px, 1fr))`,
            }}
          >
          {statusColumns.map((column) => {
            const columnItems = filteredItems.filter(
              (item) => item.status === column.status,
            )

            const isDragOver =
              !readOnly &&
              draggedItemId !== null &&
              dragOverStatus === column.status

            return (
              <div
                key={column.status}
                data-board-column={column.status}
                onDragOver={(event) => {
                  if (readOnly || draggedItemId === null) {
                    return
                  }

                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'

                  if (dragOverStatus !== column.status) {
                    setDragOverStatus(column.status)
                  }
                }}
                onDragLeave={(event) => {
                  if (
                    event.currentTarget.contains(
                      event.relatedTarget as Node | null,
                    )
                  ) {
                    return
                  }

                  setDragOverStatus((current) =>
                    current === column.status ? null : current,
                  )
                }}
                onDrop={(event) => {
                  event.preventDefault()

                  const droppedId = event.dataTransfer.getData(
                    'text/plain',
                  )

                  setDragOverStatus(null)
                  setDraggedItemId(null)

                  if (readOnly || !droppedId) {
                    return
                  }

                  const numericId = Number(droppedId)

                  if (Number.isInteger(numericId)) {
                    onStatusDrop(numericId, column.status)
                  }
                }}
                className={[
                  'flex min-h-[26rem] min-w-0 flex-col rounded-lg transition-colors',
                  isDragOver
                    ? 'bg-primary/[0.06] ring-1 ring-inset ring-primary/40'
                    : 'bg-surface-container-low/40',
                ].join(' ')}
              >
                <div className="flex items-center gap-1.5 px-3 py-2.5">
                  <span className="text-[13px] font-semibold text-on-surface">
                    {column.label}
                  </span>

                  <span className="text-xs text-on-surface-variant/70">
                    {columnItems.length}
                  </span>
                </div>

                <div className="flex-1 space-y-2 px-2 pb-3">
                  {columnItems.map((item) => (
                    <WorkItemBoardCard
                      key={item.id}
                      item={item}
                      selected={
                        selectedWorkItemId === item.id
                      }
                      dragging={draggedItemId === item.id}
                      readOnly={readOnly}
                      onOpen={onOpen}
                      onDragHandleStart={(itemId) =>
                        setDraggedItemId(itemId)
                      }
                      onDragHandleEnd={() => {
                        setDraggedItemId(null)
                        setDragOverStatus(null)
                      }}
                    />
                  ))}
                </div>
              </div>
            )
          })}
          </div>
        </div>
      ) : (
        <WorkItemsList
          items={filteredItems}
          selectedWorkItemId={
            selectedWorkItemId
          }
          onOpen={onOpen}
        />
      )}
    </section>
  )
}

const workItemTypeIcons: Record<DemoWorkItemType, string> = {
  epic: 'account_tree',
  milestone: 'flag',
  deliverable: 'inventory_2',
  task: 'assignment',
}

const workItemStatusDisplay: Record<
  DemoWorkItemStatus,
  {
    glyph: string
    className: string
  }
> = {
  todo: {
    glyph: '○',
    className: 'text-on-surface-variant',
  },
  in_progress: {
    glyph: '◐',
    className: 'text-primary',
  },
  review: {
    glyph: '●',
    className: 'text-on-surface',
  },
  done: {
    glyph: '✓',
    className: 'text-emerald-700',
  },
}

function getWorkItemDueDisplay(item: DemoWorkItem) {
  if (item.status === 'done') {
    return {
      label: '—',
      attention: false,
    }
  }

  if (item.dueInDays != null && item.dueInDays < 0) {
    const overdueDays = Math.abs(item.dueInDays)

    return {
      label: `${overdueDays}d overdue`,
      attention: true,
    }
  }

  return {
    label: item.dueLabel ?? '—',
    attention: false,
  }
}

function WorkItemBoardCard({
  item,
  selected,
  dragging,
  readOnly,
  onOpen,
  onDragHandleStart,
  onDragHandleEnd,
}: {
  item: DemoWorkItem
  selected: boolean
  dragging: boolean
  readOnly: boolean
  onOpen: (item: DemoWorkItem) => void
  onDragHandleStart: (itemId: string) => void
  onDragHandleEnd: () => void
}) {
  const isOverdue =
    item.status !== 'done' &&
    item.dueInDays != null &&
    item.dueInDays < 0

  const dueText = isOverdue
    ? `${Math.abs(item.dueInDays as number)}d overdue`
    : item.status !== 'done'
      ? item.dueLabel
      : null

  const isBlocked = item.blockedReason !== null
  const needsEmphasis = isBlocked || isOverdue

  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={`Open ${item.title}`}
      draggable={!readOnly}
      onClick={() => onOpen(item)}
      onKeyDown={(event) => {
        if (
          event.key === 'Enter' ||
          event.key === ' '
        ) {
          event.preventDefault()
          onOpen(item)
        }
      }}
      onDragStart={(event) => {
        if (readOnly) {
          return
        }

        event.dataTransfer.setData('text/plain', item.id)
        event.dataTransfer.effectAllowed = 'move'
        onDragHandleStart(item.id)
      }}
      onDragEnd={() => onDragHandleEnd()}
      data-selected={
        selected
          ? 'true'
          : undefined
      }
      className={[
        'relative rounded-lg border bg-surface-container-lowest px-3 py-2.5 transition hover:bg-surface-container-low/45',
        needsEmphasis
          ? 'border-error/35'
          : 'border-outline-variant/50',
        selected
          ? 'outline outline-2 -outline-offset-2 outline-primary/55 bg-primary/5 shadow-sm'
          : '',
        dragging ? 'opacity-40' : '',
        readOnly ? '' : 'cursor-grab active:cursor-grabbing',
      ].join(' ')}
    >
      <div className="flex items-start gap-2">
        <span
          title={workItemTypeLabels[item.type]}
          aria-label={workItemTypeLabels[item.type]}
          className="material-symbols-outlined mt-0.5 shrink-0 text-[15px] text-on-surface-variant"
        >
          {workItemTypeIcons[item.type]}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start gap-2">
            <h3 className="min-w-0 flex-1 text-sm font-semibold leading-5 text-on-surface">
              {item.title}
            </h3>

            {isBlocked && (
              <span
                title={item.blockedReason ?? undefined}
                className="mt-0.5 shrink-0 text-[11px] font-semibold text-error"
              >
                · Blocked
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-2.5 flex min-h-[22px] items-center justify-between gap-3 pl-[23px]">
        <WorkItemAssignees assignees={item.assignees} />

        {dueText && (
          <span
            className={[
              'shrink-0 text-[11px]',
              isOverdue
                ? 'font-semibold text-error'
                : 'font-normal text-on-surface-variant',
            ].join(' ')}
          >
            {dueText}
          </span>
        )}
      </div>
    </article>
  )
}

function WorkItemAssignees({
  assignees,
}: {
  assignees: DemoWorkItemAssignee[]
}) {
  if (assignees.length === 0) {
    return (
      <span className="text-xs font-normal text-on-surface-variant">
        Unassigned
      </span>
    )
  }

  const visibleAssignees = assignees.slice(0, 2)
  const additionalCount = assignees.length - 1

  return (
    <div
      className="flex min-w-0 items-center gap-2"
      title={assignees.map((assignee) => assignee.name).join(', ')}
    >
      <div className="flex shrink-0 -space-x-1.5">
        {visibleAssignees.map((assignee) => (
          <div
            key={assignee.id}
            className="flex h-[22px] w-[22px] items-center justify-center rounded-full border border-surface-container-lowest bg-surface-container-high text-[8px] font-semibold text-on-surface"
          >
            {assignee.initials}
          </div>
        ))}
      </div>

      <span className="truncate text-xs font-normal text-on-surface-variant">
        {assignees[0].name}
        {additionalCount > 0 ? ` +${additionalCount}` : ''}
      </span>
    </div>
  )
}

function WorkItemsList({
  items,
  selectedWorkItemId,
  onOpen,
}: {
  items: DemoWorkItem[]
  selectedWorkItemId: string | null
  onOpen: (item: DemoWorkItem) => void
}) {
  const gridColumns =
    'grid-cols-[minmax(360px,560px)_130px_180px_110px]'

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[900px]">
        <div
          className={[
            'grid h-9 items-center px-6',
            gridColumns,
          ].join(' ')}
        >
          <div className="text-[11px] font-normal text-on-surface-variant/75">
            Work item
          </div>

          <div className="text-[11px] font-normal text-on-surface-variant/75">
            Status
          </div>

          <div className="text-[11px] font-normal text-on-surface-variant/75">
            Assignee
          </div>

          <div className="text-[11px] font-normal text-on-surface-variant/75">
            Due
          </div>
        </div>

        <div className="border-t border-outline-variant/40">
          {items.map((item, index) => {
            const status = workItemStatusDisplay[item.status]
            const due = getWorkItemDueDisplay(item)

            return (
              <div
                key={item.id}
                role="button"
                tabIndex={0}
                aria-label={`Open ${item.title}`}
                onClick={() => onOpen(item)}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' ||
                    event.key === ' '
                  ) {
                    event.preventDefault()
                    onOpen(item)
                  }
                }}
                className={[
                  'grid h-[54px] items-center px-6 transition-colors hover:bg-surface-container-low/45',
                  gridColumns,
                  selectedWorkItemId ===
                  item.id
                    ? 'outline outline-1 -outline-offset-1 outline-primary/55 bg-primary/5'
                    : '',
                  index > 0
                    ? 'border-t border-outline-variant/25'
                    : '',
                ].join(' ')}
              >
                <div className="flex min-w-0 items-center gap-2 pr-5">
                  <span
                    title={workItemTypeLabels[item.type]}
                    aria-label={workItemTypeLabels[item.type]}
                    className="material-symbols-outlined shrink-0 text-[15px] text-on-surface-variant/80"
                  >
                    {workItemTypeIcons[item.type]}
                  </span>

                  <span className="truncate text-sm font-semibold text-on-surface">
                    {item.title}
                  </span>

                  {item.blockedReason && (
                    <span
                      title={item.blockedReason}
                      className="shrink-0 text-[11px] font-medium text-error"
                    >
                      · Blocked
                    </span>
                  )}
                </div>

                <div
                  className={[
                    'flex items-center gap-2 text-xs font-normal',
                    status.className,
                  ].join(' ')}
                >
                  <span
                    aria-hidden="true"
                    className="inline-flex w-4 shrink-0 justify-center text-[15px] leading-none"
                  >
                    {status.glyph}
                  </span>

                  <span className="text-on-surface-variant">
                    {workItemStatusLabels[item.status]}
                  </span>
                </div>

                <WorkItemAssignees assignees={item.assignees} />

                <div
                  className={[
                    'text-xs',
                    due.attention
                      ? 'font-medium text-error'
                      : 'font-normal text-on-surface-variant',
                  ].join(' ')}
                >
                  {due.label}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}


function ProjectDetailSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading project"
      className="mx-auto w-full max-w-[1440px] px-6 py-8 lg:px-10 lg:py-10"
    >
      <div className="h-4 w-20 animate-pulse rounded bg-surface-container-high" />

      <div className="mt-7 flex items-start justify-between">
        <div>
          <div className="h-3 w-28 animate-pulse rounded bg-surface-container-high" />
          <div className="mt-3 h-9 w-96 animate-pulse rounded bg-surface-container-high" />
        </div>

        <div className="flex items-center gap-4">
          <div className="flex -space-x-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <div
                key={index}
                className="h-9 w-9 animate-pulse rounded-full border-2 border-background bg-surface-container-high"
              />
            ))}
          </div>

          <div className="h-6 w-px bg-outline-variant" />

          <div className="h-7 w-20 animate-pulse rounded-full bg-surface-container-high" />
        </div>
      </div>

      <div className="mt-9 flex gap-7 border-b border-outline-variant pb-3">
        <div className="h-4 w-16 animate-pulse rounded bg-surface-container-high" />
        <div className="h-4 w-20 animate-pulse rounded bg-surface-container-high" />
        <div className="h-4 w-16 animate-pulse rounded bg-surface-container-high" />
        <div className="h-4 w-16 animate-pulse rounded bg-surface-container-high" />
      </div>

      <div className="mt-6 grid grid-cols-12 gap-6">
        <div className="col-span-8 overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest">
          <div className="border-b border-outline-variant px-6 py-4">
            <div className="h-4 w-32 animate-pulse rounded bg-surface-container-high" />
            <div className="mt-2 h-3 w-44 animate-pulse rounded bg-surface-container-low" />
          </div>

          <div className="px-6 py-6">
            <div className="h-3 w-20 animate-pulse rounded bg-surface-container-high" />
            <div className="mt-4 h-3 w-full max-w-2xl animate-pulse rounded bg-surface-container-low" />
            <div className="mt-2 h-3 w-4/5 max-w-xl animate-pulse rounded bg-surface-container-low" />
          </div>
        </div>

        <div className="col-span-4 overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest">
          <div className="border-b border-outline-variant px-5 py-4">
            <div className="h-4 w-28 animate-pulse rounded bg-surface-container-high" />
            <div className="mt-2 h-3 w-36 animate-pulse rounded bg-surface-container-low" />
          </div>

          <div className="space-y-4 px-5 py-5">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="flex gap-3">
                <div className="h-8 w-8 animate-pulse rounded-full bg-surface-container-high" />
                <div className="flex-1">
                  <div className="h-3 w-36 animate-pulse rounded bg-surface-container-high" />
                  <div className="mt-2 h-3 w-24 animate-pulse rounded bg-surface-container-low" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest">
        <div className="border-b border-outline-variant px-6 py-4">
          <div className="h-4 w-24 animate-pulse rounded bg-surface-container-high" />
          <div className="mt-2 h-3 w-72 animate-pulse rounded bg-surface-container-low" />
        </div>

        <div className="border-b border-outline-variant px-6 py-3">
          <div className="h-9 w-52 animate-pulse rounded-lg bg-surface-container-high" />
        </div>

        {Array.from({ length: 3 }).map((_, index) => (
          <div
            key={index}
            className="grid grid-cols-[minmax(0,1fr)_130px_150px_110px] items-center gap-3 border-b border-outline-variant px-6 py-4 last:border-b-0"
          >
            <div className="h-4 w-3/4 animate-pulse rounded bg-surface-container-high" />
            <div className="h-4 w-16 animate-pulse rounded bg-surface-container-low" />
            <div className="h-4 w-20 animate-pulse rounded bg-surface-container-low" />
            <div className="h-4 w-16 animate-pulse rounded bg-surface-container-low" />
          </div>
        ))}
      </div>
    </div>
  )
}
