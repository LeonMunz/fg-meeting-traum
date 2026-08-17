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
import { RemoveProjectMemberDialog } from './RemoveProjectMemberDialog'
import { CreateWorkItemDialog } from './CreateWorkItemDialog'
import { ApiError } from '../../api/client'
import {
  addProjectMembership,
  getProject,
  listProjectMemberships,
  listResearchGroupMembers,
  removeProjectMembership,
  updateProjectMembership,
} from '../../api/projects'
import type {
  ApiProjectMembership,
  ApiResearchGroupMember,
  ApiWorkItem,
} from '../../api/types'
import {
  createWorkItem,
  listProjectWorkItems,
} from '../../api/work-items'
import { useSession } from '../../api/useSession'

type ProjectStatus = 'active' | 'paused' | 'completed'
type ProjectRole = 'owner' | 'member' | 'viewer'
type ProjectTab = 'overview' | 'work-items' | 'members' | 'settings'

type DemoWorkItemStatus = 'todo' | 'in_progress' | 'review' | 'done'
type DemoWorkItemType = 'epic' | 'milestone' | 'deliverable' | 'task'

type WorkItemFocus =
  | 'due-3-days'
  | 'due-week'
  | 'overdue'
  | 'blocked'
  | 'mine'
  | 'recently-completed'
  | 'all-open'
  | 'custom'

type CustomWorkItemStatus = 'all' | DemoWorkItemStatus
type CustomWorkItemType = 'all' | DemoWorkItemType

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
  role: ProjectRole
  updatedLabel: string
}


const demoActivities: Record<
  string,
  Array<{
    id: string
    title: string
    meta: string
    icon: string
  }>
> = {
  'quantum-materials': [
    {
      id: 'activity-1',
      title: 'Project details updated',
      meta: 'Today · Alex Dev',
      icon: 'edit_note',
    },
    {
      id: 'activity-2',
      title: 'Laura joined as viewer',
      meta: 'Yesterday · Alex Dev',
      icon: 'person_add',
    },
    {
      id: 'activity-3',
      title: 'Project activated',
      meta: 'Aug 12 · Alex Dev',
      icon: 'flag',
    },
  ],
  'ai-engineering': [
    {
      id: 'activity-1',
      title: 'Project details updated',
      meta: 'Yesterday · Chris Dev',
      icon: 'edit_note',
    },
    {
      id: 'activity-2',
      title: 'Maria joined the project',
      meta: 'Aug 11 · Chris Dev',
      icon: 'person_add',
    },
  ],
  'grant-proposal': [
    {
      id: 'activity-1',
      title: 'Project paused',
      meta: 'Aug 8 · Maria Dev',
      icon: 'pause_circle',
    },
  ],
  'cluster-upgrade': [
    {
      id: 'activity-1',
      title: 'Project completed',
      meta: 'Jul 29 · Laura Dev',
      icon: 'check_circle',
    },
  ],
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

type WorkItemFilterPreferences = {
  focus: WorkItemFocus
  customDueDays: number
  customStatus: CustomWorkItemStatus
  customType: CustomWorkItemType
  customAssignee: 'all' | 'me'
}

const defaultWorkItemFilterPreferences: WorkItemFilterPreferences = {
  focus: 'due-3-days',
  customDueDays: 3,
  customStatus: 'all',
  customType: 'all',
  customAssignee: 'all',
}

function isWorkItemFocus(value: unknown): value is WorkItemFocus {
  return (
    typeof value === 'string' &&
    [
      'due-3-days',
      'due-week',
      'overdue',
      'blocked',
      'mine',
      'recently-completed',
      'all-open',
      'custom',
    ].includes(value)
  )
}

function isCustomWorkItemStatus(
  value: unknown,
): value is CustomWorkItemStatus {
  return (
    value === 'all' ||
    value === 'todo' ||
    value === 'in_progress' ||
    value === 'review' ||
    value === 'done'
  )
}

function isCustomWorkItemType(
  value: unknown,
): value is CustomWorkItemType {
  return (
    value === 'all' ||
    value === 'epic' ||
    value === 'milestone' ||
    value === 'deliverable' ||
    value === 'task'
  )
}

function loadWorkItemFilterPreferences(
  storageKey: string,
): WorkItemFilterPreferences {
  try {
    const raw = window.localStorage.getItem(storageKey)

    if (!raw) {
      return { ...defaultWorkItemFilterPreferences }
    }

    const parsed = JSON.parse(raw) as Partial<WorkItemFilterPreferences>

    return {
      focus: isWorkItemFocus(parsed.focus)
        ? parsed.focus
        : defaultWorkItemFilterPreferences.focus,

      customDueDays:
        typeof parsed.customDueDays === 'number' &&
        Number.isFinite(parsed.customDueDays)
          ? Math.min(90, Math.max(1, parsed.customDueDays))
          : defaultWorkItemFilterPreferences.customDueDays,

      customStatus: isCustomWorkItemStatus(parsed.customStatus)
        ? parsed.customStatus
        : defaultWorkItemFilterPreferences.customStatus,

      customType: isCustomWorkItemType(parsed.customType)
        ? parsed.customType
        : defaultWorkItemFilterPreferences.customType,

      customAssignee:
        parsed.customAssignee === 'me' ? 'me' : 'all',
    }
  } catch {
    return { ...defaultWorkItemFilterPreferences }
  }
}

function saveWorkItemFilterPreferences(
  storageKey: string,
  preferences: WorkItemFilterPreferences,
) {
  try {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify(preferences),
    )
  } catch {
    // A blocked or unavailable localStorage must not break the page.
  }
}

const statusLabel: Record<ProjectStatus, string> = {
  active: 'Active project',
  paused: 'Paused project',
  completed: 'Completed project',
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

const tabs: Array<{ id: ProjectTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'work-items', label: 'Work Items' },
  { id: 'members', label: 'Members' },
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

export function ProjectDetailPage() {
  const { projectId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { user } = useSession()
  const [activeTab, setActiveTab] = useState<ProjectTab>('overview')

  const [project, setProject] = useState<ProjectDetail | null>(null)
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

  const [members, setMembers] = useState<ProjectMember[]>([])
  const [directoryUsers, setDirectoryUsers] =
    useState<DirectoryUser[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [membersError, setMembersError] =
    useState<string | null>(null)
  const [addMemberDialogOpen, setAddMemberDialogOpen] = useState(false)
  const [memberToRemove, setMemberToRemove] =
    useState<ProjectMember | null>(null)
  const [apiWorkItems, setApiWorkItems] =
    useState<ApiWorkItem[]>([])
  const [workItemsLoading, setWorkItemsLoading] =
    useState(false)
  const [workItemsError, setWorkItemsError] =
    useState<string | null>(null)
  const [createWorkItemDialogOpen, setCreateWorkItemDialogOpen] =
    useState(false)
  const [workItemFocus, setWorkItemFocus] =
    useState<WorkItemFocus>('due-3-days')
  const [customDueDays, setCustomDueDays] = useState(3)
  const [customStatus, setCustomStatus] =
    useState<CustomWorkItemStatus>('all')
  const [customType, setCustomType] =
    useState<CustomWorkItemType>('all')
  const [customAssignee, setCustomAssignee] =
    useState<'all' | 'me'>('all')

  const [loadedFilterPreferencesKey, setLoadedFilterPreferencesKey] =
    useState<string | null>(null)

  const filterPreferencesKey =
    user && projectId
      ? `fg-workspace:project-overview-work-items:v1:${user.id}:${projectId}`
      : null

  useEffect(() => {
    if (!filterPreferencesKey) {
      setLoadedFilterPreferencesKey(null)
      return
    }

    const preferences =
      loadWorkItemFilterPreferences(filterPreferencesKey)

    setWorkItemFocus(preferences.focus)
    setCustomDueDays(preferences.customDueDays)
    setCustomStatus(preferences.customStatus)
    setCustomType(preferences.customType)
    setCustomAssignee(preferences.customAssignee)

    setLoadedFilterPreferencesKey(filterPreferencesKey)
  }, [filterPreferencesKey])

  useEffect(() => {
    if (
      !filterPreferencesKey ||
      loadedFilterPreferencesKey !== filterPreferencesKey
    ) {
      return
    }

    saveWorkItemFilterPreferences(filterPreferencesKey, {
      focus: workItemFocus,
      customDueDays,
      customStatus,
      customType,
      customAssignee,
    })
  }, [
    filterPreferencesKey,
    loadedFilterPreferencesKey,
    workItemFocus,
    customDueDays,
    customStatus,
    customType,
    customAssignee,
  ])


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
    setCreateWorkItemDialogOpen(false)

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
  const forceEmptyActivity = previewState === 'empty-activity'
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

  const isReadOnly = currentMemberRole === 'viewer'
  const canManageMembers = currentMemberRole === 'owner'
  const canEditProjectSettings = currentMemberRole === 'owner'

  const settingsDirty =
    settingsName.trim() !== projectName ||
    settingsDescription.trim() !== projectDescription ||
    settingsStatus !== projectStatus

  const settingsValid = settingsName.trim().length > 0

  const handleResetProjectSettings = () => {
    setSettingsName(projectName)
    setSettingsDescription(projectDescription)
    setSettingsStatus(projectStatus)
  }

  const handleSaveProjectSettings = () => {
    if (!canEditProjectSettings || !settingsValid) {
      return
    }

    setProjectName(settingsName.trim())
    setProjectDescription(settingsDescription.trim())
    setProjectStatus(settingsStatus)

    setSettingsName(settingsName.trim())
    setSettingsDescription(settingsDescription.trim())
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

  const handleCreateWorkItem = async (input: {
    title: string
    type: DemoWorkItemType
    status: DemoWorkItemStatus
    assigneeIds: string[]
    parentId: string | null
    dueDate: string | null
    blockedReason: string | null
  }) => {
    if (isReadOnly) {
      throw new Error(
        'A viewer cannot create Work Items.',
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

  const projectActivities = forceEmptyActivity
    ? []
    : demoActivities[project.id] ?? []

  const projectWorkItems = forceEmptyWorkItems
    ? []
    : workItems

  const currentUserMemberId =
    user ? String(user.id) : null


  const focusedWorkItems = projectWorkItems.filter((item) => {
    switch (workItemFocus) {
      case 'due-3-days':
        return (
          item.status !== 'done' &&
          item.dueInDays != null &&
          item.dueInDays >= 0 &&
          item.dueInDays <= 3
        )

      case 'due-week':
        return (
          item.status !== 'done' &&
          item.dueInDays != null &&
          item.dueInDays >= 0 &&
          item.dueInDays <= 7
        )

      case 'overdue':
        return (
          item.status !== 'done' &&
          item.dueInDays != null &&
          item.dueInDays < 0
        )

      case 'blocked':
        return item.status !== 'done' && Boolean(item.blockedReason)

      case 'mine':
        return (
          item.status !== 'done' &&
          currentUserMemberId != null &&
          item.assignees.some(
            (assignee) => assignee.id === currentUserMemberId,
          )
        )

      case 'recently-completed':
        return item.status === 'done'

      case 'all-open':
        return item.status !== 'done'

      case 'custom': {
        const dueMatches =
          item.dueInDays != null &&
          item.dueInDays >= 0 &&
          item.dueInDays <= customDueDays

        const statusMatches =
          customStatus === 'all' || item.status === customStatus

        const typeMatches =
          customType === 'all' || item.type === customType

        const assigneeMatches =
          customAssignee === 'all' ||
          (currentUserMemberId != null &&
            item.assignees.some(
              (assignee) => assignee.id === currentUserMemberId,
            ))

        return dueMatches && statusMatches && typeMatches && assigneeMatches
      }
    }
  })

  return (
    <div className="w-full px-6 py-8 lg:px-8 lg:py-10 xl:px-10">
      <Link
        to="/projects"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-on-surface-variant transition hover:text-primary"
      >
        <span className="material-symbols-outlined text-[18px]">
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

        {isReadOnly && (
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

        <nav className="mt-8 flex gap-7 overflow-x-auto border-b border-outline-variant">
          {tabs.map((tab) => {
            const selected = activeTab === tab.id

            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={[
                  'relative shrink-0 pb-3 text-sm font-medium transition',
                  selected
                    ? 'text-primary'
                    : 'text-on-surface-variant hover:text-on-surface',
                ].join(' ')}
              >
                {tab.label}

                {selected && (
                  <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary" />
                )}
              </button>
            )
          })}
        </nav>
      </header>

      {activeTab === 'overview' && (
        <div className="mt-7 grid gap-10 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 space-y-10">
            <section>
              <div className="flex min-h-8 items-center justify-between border-b border-outline-variant/50 pb-3">
                <h2 className="text-sm font-semibold text-on-surface">
                  Description
                </h2>

                {canEditProjectSettings &&
                  projectDescription.trim().length > 0 &&
                  !forceEmptyDescription && (
                    <button
                      type="button"
                      onClick={() => setActiveTab('settings')}
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
                  <div className="flex items-start gap-3">
                    <span className="material-symbols-outlined mt-0.5 text-[17px] text-on-surface-variant">
                      notes
                    </span>

                    <div>
                      <p className="text-sm font-medium text-on-surface">
                        No description yet
                      </p>

                      <p className="mt-1 max-w-lg text-xs leading-5 text-on-surface-variant">
                        Add context so project members can quickly understand
                        the purpose of this project.
                      </p>
                    </div>
                  </div>

                  {canEditProjectSettings && (
                    <button
                      type="button"
                      onClick={() => setActiveTab('settings')}
                      className="shrink-0 text-xs font-medium text-primary transition hover:opacity-75"
                    >
                      Add description
                    </button>
                  )}
                </div>
              )}
            </section>

            <section>
              <div className="flex flex-col gap-3 border-b border-outline-variant/50 pb-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-on-surface">
                    Work items
                  </h2>

                  <p className="mt-1 text-xs text-on-surface-variant">
                    Project work that currently needs attention.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setActiveTab('work-items')}
                  className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-on-surface-variant transition hover:text-primary"
                >
                  View all

                  <span className="material-symbols-outlined text-[15px]">
                    arrow_forward
                  </span>
                </button>
              </div>

              <div className="py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2">
                    <span className="text-xs font-normal text-on-surface-variant">
                      Focus
                    </span>

                    <select
                      value={workItemFocus}
                      onChange={(event) =>
                        setWorkItemFocus(event.target.value as WorkItemFocus)
                      }
                      className="h-8 rounded-lg border border-outline-variant bg-surface-container-lowest px-2.5 text-xs font-normal text-on-surface outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
                    >
                      <option value="due-3-days">Due next 3 days</option>
                      <option value="due-week">Due this week</option>
                      <option value="overdue">Overdue</option>
                      <option value="blocked">Blocked</option>
                      <option value="mine">My open work</option>
                      <option value="recently-completed">
                        Recently completed
                      </option>
                      <option value="all-open">All open</option>
                      <option value="custom">Custom filter…</option>
                    </select>
                  </label>

                  {workItemFocus !== 'custom' && (
                    <button
                      type="button"
                      onClick={() => setWorkItemFocus('custom')}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-normal text-on-surface-variant transition hover:bg-surface-container-low hover:text-on-surface"
                    >
                      <span className="material-symbols-outlined text-[15px]">
                        tune
                      </span>
                      Customize
                    </button>
                  )}

                  <span className="ml-auto text-xs font-normal text-on-surface-variant">
                    {focusedWorkItems.length}{' '}
                    {focusedWorkItems.length === 1 ? 'item' : 'items'}
                  </span>
                </div>

                {workItemFocus === 'custom' && (
                  <div className="mt-3 grid gap-3 border-t border-outline-variant/35 pt-3 sm:grid-cols-2 xl:grid-cols-4">
                    <label>
                      <span className="mb-1 block text-xs font-normal text-on-surface-variant">
                        Due within
                      </span>

                      <div className="flex h-8 items-center rounded-lg border border-outline-variant bg-surface-container-lowest">
                        <input
                          type="number"
                          min={1}
                          max={90}
                          value={customDueDays}
                          onChange={(event) =>
                            setCustomDueDays(
                              Math.max(1, Number(event.target.value) || 1),
                            )
                          }
                          className="min-w-0 flex-1 bg-transparent px-2.5 text-xs outline-none"
                        />

                        <span className="pr-2.5 text-xs text-on-surface-variant">
                          days
                        </span>
                      </div>
                    </label>

                    <label>
                      <span className="mb-1 block text-xs font-normal text-on-surface-variant">
                        Status
                      </span>

                      <select
                        value={customStatus}
                        onChange={(event) =>
                          setCustomStatus(
                            event.target.value as CustomWorkItemStatus,
                          )
                        }
                        className="h-8 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-2.5 text-xs outline-none focus:border-primary"
                      >
                        <option value="all">Any status</option>

                        {workItemStatusOptions.map((status) => (
                          <option
                            key={status.value}
                            value={status.value}
                          >
                            {status.label}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label>
                      <span className="mb-1 block text-xs font-normal text-on-surface-variant">
                        Type
                      </span>

                      <select
                        value={customType}
                        onChange={(event) =>
                          setCustomType(
                            event.target.value as CustomWorkItemType,
                          )
                        }
                        className="h-8 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-2.5 text-xs outline-none focus:border-primary"
                      >
                        <option value="all">Any type</option>

                        {workItemTypeOptions.map((type) => (
                          <option
                            key={type.value}
                            value={type.value}
                          >
                            {type.label}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label>
                      <span className="mb-1 block text-xs font-normal text-on-surface-variant">
                        Assignee
                      </span>

                      <select
                        value={customAssignee}
                        onChange={(event) =>
                          setCustomAssignee(
                            event.target.value as 'all' | 'me',
                          )
                        }
                        className="h-8 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-2.5 text-xs outline-none focus:border-primary"
                      >
                        <option value="all">Anyone</option>
                        <option value="me">Me</option>
                      </select>
                    </label>
                  </div>
                )}
              </div>

              {projectWorkItems.length === 0 ? (
                <div className="flex min-h-36 items-center justify-center border-t border-outline-variant/35 py-8">
                  <div className="flex items-start gap-3">
                    <span className="material-symbols-outlined mt-0.5 text-[18px] text-on-surface-variant">
                      checklist
                    </span>

                    <div>
                      <p className="text-sm font-medium text-on-surface">
                        No work items yet
                      </p>

                      <p className="mt-1 max-w-md text-xs leading-5 text-on-surface-variant">
                        Work created for this project will appear here.
                      </p>
                    </div>
                  </div>
                </div>
              ) : focusedWorkItems.length > 0 ? (
                <div className="border-t border-outline-variant/35">
                  <WorkItemsList items={focusedWorkItems.slice(0, 5)} />
                </div>
              ) : (
                <div className="flex min-h-28 items-center justify-center border-t border-outline-variant/35 py-7">
                  <div className="flex items-start gap-3">
                    <span className="material-symbols-outlined mt-0.5 text-[18px] text-on-surface-variant">
                      filter_alt_off
                    </span>

                    <div>
                      <p className="text-sm font-medium text-on-surface">
                        No work items match this focus
                      </p>

                      <p className="mt-1 text-xs text-on-surface-variant">
                        Choose another preset or customize the filter.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </section>
          </div>

          <aside className="min-w-0">
            <div className="flex min-h-8 items-center border-b border-outline-variant/50 pb-3">
              <h2 className="text-sm font-semibold text-on-surface">
                Latest activity
              </h2>
            </div>

            {projectActivities.length > 0 ? (
              <div>
                {projectActivities.map((activity, index) => (
                  <div
                    key={activity.id}
                    className={[
                      'flex min-h-[48px] items-center gap-2.5 py-2.5',
                      index > 0
                        ? 'border-t border-outline-variant/25'
                        : '',
                    ].join(' ')}
                  >
                    <span className="material-symbols-outlined w-5 shrink-0 text-[15px] text-on-surface-variant">
                      {activity.icon}
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-on-surface">
                        {activity.title}
                      </div>

                      <div className="mt-0.5 truncate text-[11px] font-normal text-on-surface-variant">
                        {activity.meta}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex min-h-28 items-start gap-2.5 py-5">
                <span className="material-symbols-outlined mt-0.5 text-[16px] text-on-surface-variant">
                  history
                </span>

                <div>
                  <p className="text-xs font-medium text-on-surface">
                    No activity yet
                  </p>

                  <p className="mt-1 text-[11px] leading-5 text-on-surface-variant">
                    Recent project changes will appear here.
                  </p>
                </div>
              </div>
            )}
          </aside>
        </div>
      )}

      {activeTab === 'members' && (
        <section className="mt-6 overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest shadow-sm">
          <div className="flex flex-col gap-4 border-b border-outline-variant px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-semibold text-on-surface">
                  Project members
                </h2>

                <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-surface-container-high px-2 py-0.5 text-[11px] font-semibold text-on-surface-variant">
                  {members.length}
                </span>
              </div>

              <p className="mt-0.5 text-xs text-on-surface-variant">
                People with access to this project and their current role.
              </p>
            </div>

            {canManageMembers ? (
              <button
                type="button"
                onClick={() => setAddMemberDialogOpen(true)}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-primary px-3.5 text-sm font-semibold text-white shadow-sm transition hover:bg-primary/90"
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
              className="border-b border-error/20 bg-error-container/35 px-6 py-3 text-sm text-error"
            >
              {membersError}
            </div>
          )}

          {membersLoading && (
            <div className="flex items-center gap-2 border-b border-outline-variant px-6 py-3 text-sm text-on-surface-variant">
              <span className="material-symbols-outlined animate-spin text-[18px]">
                refresh
              </span>
              Loading project members…
            </div>
          )}

          <div className="hidden border-b border-outline-variant bg-surface-container-low px-6 py-2.5 sm:grid sm:grid-cols-[minmax(0,1fr)_190px_52px]">
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
              const isOwner = member.role === 'owner'
              const isLastOwner = isOwner && ownerCount <= 1

              return (
                <div
                  key={member.id}
                  className="grid gap-4 px-6 py-4 sm:grid-cols-[minmax(0,1fr)_190px_52px] sm:items-center"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-[11px] font-semibold text-on-surface">
                      {member.initials}
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-on-surface">
                          {member.name}
                        </span>

                      </div>

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

                    {isLastOwner && canManageMembers && (
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
                        onClick={() => setMemberToRemove(member)}
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
            <div className="flex items-start gap-3 border-t border-outline-variant bg-surface-container-low/55 px-6 py-4">
              <span className="material-symbols-outlined mt-0.5 text-[18px] text-on-surface-variant">
                info
              </span>

              <p className="text-xs leading-5 text-on-surface-variant">
                Only the project owner can add or remove members and change
                project roles.
              </p>
            </div>
          )}
        </section>
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
              setCreateWorkItemDialogOpen(true)
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
                  Only project owners can change project settings.
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

          </div>

          {canEditProjectSettings && (
            <div className="flex flex-col gap-3 border-t border-outline-variant bg-surface-container-low/45 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-xs text-on-surface-variant">
                {settingsDirty
                  ? 'You have unsaved changes.'
                  : 'All changes are saved in the current UI session.'}
              </div>

              <div className="flex items-center justify-end gap-3">
                <button
                  type="button"
                  disabled={!settingsDirty}
                  onClick={handleResetProjectSettings}
                  className="h-9 rounded-lg px-4 text-sm font-medium text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Cancel
                </button>

                <button
                  type="button"
                  disabled={!settingsDirty || !settingsValid}
                  onClick={handleSaveProjectSettings}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <span className="material-symbols-outlined text-[18px]">
                    save
                  </span>
                  Save changes
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

      <RemoveProjectMemberDialog
        open={memberToRemove != null}
        memberName={memberToRemove?.name ?? ''}
        onClose={() => setMemberToRemove(null)}
        onConfirm={handleConfirmRemoveMember}
      />

      <CreateWorkItemDialog
        open={createWorkItemDialogOpen}
        assignees={sortedMembers
          .filter((member) => member.role !== 'viewer')
          .map((member) => ({
            id: member.id,
            name: member.name,
            initials: member.initials,
          }))}
        parentItems={projectWorkItems.map((item) => ({
          id: item.id,
          title: item.title,
          type: item.type,
        }))}
        onClose={() => setCreateWorkItemDialogOpen(false)}
        onCreate={handleCreateWorkItem}
      />
    </div>
  )
}

function ProjectWorkItemsPanel({
  items,
  eligibleAssignees,
  readOnly,
  onCreate,
  preferencesKey,
}: {
  items: DemoWorkItem[]
  eligibleAssignees: ProjectMember[]
  readOnly: boolean
  onCreate: () => void
  preferencesKey: string | null
}) {
  const [view, setView] = useState<WorkItemsView>('board')
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
              <span className="material-symbols-outlined text-[17px]">
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
              <span className="material-symbols-outlined text-[17px]">
                view_list
              </span>
              List
            </button>
          </div>
        </div>
      </div>

      <div className="border-b border-outline-variant bg-surface-container-low/35 px-6 py-4">
        <div className="flex items-center gap-4">
          <label className="relative block w-72 shrink-0">
            <span className="sr-only">Search work items</span>

            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-on-surface-variant">
              search
            </span>

            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search work items..."
              className="h-9 w-full rounded-lg border border-outline-variant bg-surface-container-lowest pl-10 pr-3 text-sm text-on-surface outline-none transition placeholder:text-on-surface-variant/60 focus:border-primary focus:ring-2 focus:ring-primary/15"
            />
          </label>

          <label className="flex items-center gap-2">
            <span className="text-xs font-medium text-on-surface-variant">
              Assignee
            </span>

            <select
              value={assigneeFilter}
              onChange={(event) =>
                setAssigneeFilter(event.target.value)
              }
              className="h-9 min-w-40 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm font-medium text-on-surface outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
            >
              <option value="all">Anyone</option>

              {sortedEligibleAssignees.map((assignee) => (
                <option key={assignee.id} value={assignee.id}>
                  {assignee.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex h-9 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface">
            <input
              type="checkbox"
              checked={blockedOnly}
              onChange={(event) =>
                setBlockedOnly(event.target.checked)
              }
              className="h-4 w-4 rounded border-outline accent-primary"
            />
            Blocked only
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

        <div className="mt-3 flex items-center gap-1">
          <span className="mr-2 text-xs font-medium text-on-surface-variant">
            Type
          </span>

          {typeFilters.map((filter) => {
            const selected = typeFilter === filter.value

            return (
              <button
                key={filter.value}
                type="button"
                onClick={() => setTypeFilter(filter.value)}
                className={[
                  'rounded-lg px-3 py-1.5 text-xs font-semibold transition',
                  selected
                    ? 'bg-secondary-container text-on-surface'
                    : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface',
                ].join(' ')}
              >
                {filter.label}
              </button>
            )
          })}
        </div>
      </div>

      {items.length === 0 ? (
        <div className="flex min-h-72 flex-col items-center justify-center px-6 py-12 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant">
            <span className="material-symbols-outlined text-[23px]">
              checklist
            </span>
          </div>

          <h3 className="mt-4 text-base font-semibold text-on-surface">
            No work items yet
          </h3>

          <p className="mt-1 max-w-md text-sm leading-6 text-on-surface-variant">
            This project does not contain any work items yet.
          </p>

          {!readOnly && (
            <button
              type="button"
              onClick={onCreate}
              className="mt-5 inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-primary/90"
            >
              <span className="material-symbols-outlined text-[18px]">
                add
              </span>
              Create first work item
            </button>
          )}
        </div>
      ) : filteredItems.length === 0 ? (
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
        <div className="overflow-x-auto bg-surface-container-low/20">
          <div
            className="grid min-w-max gap-4 p-5"
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

            return (
              <div
                key={column.status}
                className="min-w-0 rounded-xl border border-outline-variant bg-surface-container-low/55"
              >
                <div className="flex items-center justify-between border-b border-outline-variant px-4 py-3">
                  <span className="text-sm font-semibold text-on-surface">
                    {column.label}
                  </span>

                  <span className="text-xs font-medium text-on-surface-variant">
                    {columnItems.length}
                  </span>
                </div>

                <div className="space-y-3 p-3">
                  {columnItems.length > 0 ? (
                    columnItems.map((item) => (
                      <WorkItemBoardCard
                        key={item.id}
                        item={item}
                      />
                    ))
                  ) : (
                    <div className="flex min-h-28 items-center justify-center rounded-lg border border-dashed border-outline-variant px-3 text-center">
                      <span className="text-xs text-on-surface-variant">
                        No items
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
          </div>
        </div>
      ) : (
        <WorkItemsList items={filteredItems} />
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
}: {
  item: DemoWorkItem
}) {
  const due = getWorkItemDueDisplay(item)

  return (
    <article className="rounded-lg border border-outline-variant/60 bg-surface-container-lowest px-3.5 py-3 transition hover:bg-surface-container-low/45">
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

            {item.blockedReason && (
              <span
                title={item.blockedReason}
                className="mt-0.5 shrink-0 text-[11px] font-medium text-error"
              >
                · Blocked
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-3.5 flex items-center justify-between gap-3 pl-[23px]">
        <WorkItemAssignees assignees={item.assignees} />

        <span
          className={[
            'shrink-0 text-[11px]',
            due.attention
              ? 'font-medium text-error'
              : 'font-normal text-on-surface-variant',
          ].join(' ')}
        >
          {due.label}
        </span>
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
}: {
  items: DemoWorkItem[]
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
                className={[
                  'grid h-[54px] items-center px-6 transition-colors hover:bg-surface-container-low/45',
                  gridColumns,
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
