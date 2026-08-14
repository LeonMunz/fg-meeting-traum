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
import {
  WorkItemConfigurationSettings,
} from './WorkItemConfigurationSettings'
import {
  defaultWorkItemLabels,
  defaultWorkItemStatuses,
  defaultWorkItemTypes,
  type WorkItemLabelDefinition,
  type WorkItemStatusDefinition,
  type WorkItemTypeDefinition,
} from './workItemConfiguration'

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

type CustomWorkItemStatus = string
type CustomWorkItemType = string

type WorkItemsView = 'board' | 'list'
type WorkItemsTypeFilter = string

type WorkItemsPreferences = {
  view: WorkItemsView
  query: string
  type: WorkItemsTypeFilter
  assignee: string
  blockedOnly: boolean
}

type DemoWorkItem = {
  id: string
  title: string
  type: DemoWorkItemType
  status: DemoWorkItemStatus
  assignee: string
  dueInDays: number
  dueLabel: string
  blocked: boolean
}

type ProjectMember = {
  id: string
  name: string
  email: string
  initials: string
  role: ProjectRole
}

type ProjectDetail = {
  id: string
  name: string
  description: string
  status: ProjectStatus
  role: ProjectRole
  updatedLabel: string
  members: ProjectMember[]
}

type RoutedProject = {
  id: string
  name: string
  description: string
  status: ProjectStatus
  role: ProjectRole
  updatedLabel: string
}

const demoDirectoryUsers: DirectoryUser[] = [
  {
    id: 'alex',
    name: 'Alex Dev',
    email: 'alex@example.com',
    initials: 'AD',
  },
  {
    id: 'chris',
    name: 'Chris Dev',
    email: 'chris@example.com',
    initials: 'CD',
  },
  {
    id: 'maria',
    name: 'Maria Dev',
    email: 'maria@example.com',
    initials: 'MD',
  },
  {
    id: 'laura',
    name: 'Laura Dev',
    email: 'laura@example.com',
    initials: 'LD',
  },
  {
    id: 'nora',
    name: 'Nora Weber',
    email: 'nora@example.com',
    initials: 'NW',
  },
  {
    id: 'jonas',
    name: 'Jonas Beck',
    email: 'jonas@example.com',
    initials: 'JB',
  },
  {
    id: 'tobias',
    name: 'Tobias Roth',
    email: 'tobias@example.com',
    initials: 'TR',
  },
]

const demoProjects: Record<string, ProjectDetail> = {
  'quantum-materials': {
    id: 'quantum-materials',
    name: 'Quantum Materials Study',
    description:
      'Experimental and computational research on topological quantum materials.',
    status: 'active',
    role: 'owner',
    updatedLabel: 'Updated today',
    members: [
      {
        id: 'alex',
        name: 'Alex Dev',
        email: 'alex@example.com',
        initials: 'AD',
        role: 'owner',
      },
      {
        id: 'chris',
        name: 'Chris Dev',
        email: 'chris@example.com',
        initials: 'CD',
        role: 'member',
      },
      {
        id: 'maria',
        name: 'Maria Dev',
        email: 'maria@example.com',
        initials: 'MD',
        role: 'member',
      },
      {
        id: 'laura',
        name: 'Laura Dev',
        email: 'laura@example.com',
        initials: 'LD',
        role: 'viewer',
      },
    ],
  },
  'ai-engineering': {
    id: 'ai-engineering',
    name: 'AI Engineering Lab',
    description:
      'Applied research on reliable AI systems, evaluation and research tooling.',
    status: 'active',
    role: 'member',
    updatedLabel: 'Updated yesterday',
    members: [
      {
        id: 'chris',
        name: 'Chris Dev',
        email: 'chris@example.com',
        initials: 'CD',
        role: 'owner',
      },
      {
        id: 'alex',
        name: 'Alex Dev',
        email: 'alex@example.com',
        initials: 'AD',
        role: 'member',
      },
      {
        id: 'maria',
        name: 'Maria Dev',
        email: 'maria@example.com',
        initials: 'MD',
        role: 'member',
      },
    ],
  },
  'grant-proposal': {
    id: 'grant-proposal',
    name: 'Collaborative Grant Proposal',
    description:
      'Preparation of the next interdisciplinary funding proposal and work plan.',
    status: 'paused',
    role: 'viewer',
    updatedLabel: 'Updated Aug 8',
    members: [
      {
        id: 'maria',
        name: 'Maria Dev',
        email: 'maria@example.com',
        initials: 'MD',
        role: 'owner',
      },
      {
        id: 'chris',
        name: 'Chris Dev',
        email: 'chris@example.com',
        initials: 'CD',
        role: 'member',
      },
      {
        id: 'alex',
        name: 'Alex Dev',
        email: 'alex@example.com',
        initials: 'AD',
        role: 'viewer',
      },
    ],
  },
  'cluster-upgrade': {
    id: 'cluster-upgrade',
    name: 'Research Cluster Upgrade',
    description:
      'Planning and documentation for the laboratory compute infrastructure refresh.',
    status: 'completed',
    role: 'member',
    updatedLabel: 'Updated Jul 29',
    members: [
      {
        id: 'laura',
        name: 'Laura Dev',
        email: 'laura@example.com',
        initials: 'LD',
        role: 'owner',
      },
      {
        id: 'alex',
        name: 'Alex Dev',
        email: 'alex@example.com',
        initials: 'AD',
        role: 'member',
      },
      {
        id: 'chris',
        name: 'Chris Dev',
        email: 'chris@example.com',
        initials: 'CD',
        role: 'member',
      },
    ],
  },
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

const demoWorkItems: Record<string, DemoWorkItem[]> = {
  'quantum-materials': [
    {
      id: 'wi-1',
      title: 'Calibrate cryostat for low-temperature measurements',
      type: 'task',
      status: 'in_progress',
      assignee: 'Alex Dev',
      dueInDays: 1,
      dueLabel: 'Tomorrow',
      blocked: false,
    },
    {
      id: 'wi-2',
      title: 'Review measurement protocol',
      type: 'deliverable',
      status: 'todo',
      assignee: 'Chris Dev',
      dueInDays: 3,
      dueLabel: 'Aug 17',
      blocked: false,
    },
    {
      id: 'wi-3',
      title: 'Resolve sample holder issue',
      type: 'task',
      status: 'todo',
      assignee: 'Maria Dev',
      dueInDays: 2,
      dueLabel: 'Aug 16',
      blocked: true,
    },
    {
      id: 'wi-4',
      title: 'Prepare milestone review',
      type: 'milestone',
      status: 'todo',
      assignee: 'Chris Dev',
      dueInDays: 6,
      dueLabel: 'Aug 20',
      blocked: false,
    },
    {
      id: 'wi-5',
      title: 'Update literature matrix',
      type: 'task',
      status: 'review',
      assignee: 'Alex Dev',
      dueInDays: -2,
      dueLabel: 'Aug 12',
      blocked: false,
    },
    {
      id: 'wi-6',
      title: 'Archive initial dataset',
      type: 'task',
      status: 'done',
      assignee: 'Chris Dev',
      dueInDays: -1,
      dueLabel: 'Completed yesterday',
      blocked: false,
    },
  ],
  'ai-engineering': [],
  'grant-proposal': [],
  'cluster-upgrade': [],
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
  return typeof value === 'string' && value.length > 0
}

function isCustomWorkItemType(
  value: unknown,
): value is CustomWorkItemType {
  return typeof value === 'string' && value.length > 0
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

export function ProjectDetailPage() {
  const { projectId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { user } = useSession()
  const [activeTab, setActiveTab] = useState<ProjectTab>('overview')

  const [projectName, setProjectName] = useState('')
  const [projectDescription, setProjectDescription] = useState('')
  const [projectStatus, setProjectStatus] =
    useState<ProjectStatus>('active')

  const [settingsName, setSettingsName] = useState('')
  const [settingsDescription, setSettingsDescription] = useState('')
  const [settingsStatus, setSettingsStatus] =
    useState<ProjectStatus>('active')

  const [workItemStatuses, setWorkItemStatuses] = useState<
    WorkItemStatusDefinition[]
  >(() => defaultWorkItemStatuses.map((status) => ({ ...status })))

  const [workItemTypes, setWorkItemTypes] = useState<
    WorkItemTypeDefinition[]
  >(() => defaultWorkItemTypes.map((type) => ({ ...type })))

  const [workItemLabels, setWorkItemLabels] = useState<
    WorkItemLabelDefinition[]
  >(() => defaultWorkItemLabels.map((label) => ({ ...label })))
  const [members, setMembers] = useState<ProjectMember[]>([])
  const [addMemberDialogOpen, setAddMemberDialogOpen] = useState(false)
  const [memberToRemove, setMemberToRemove] =
    useState<ProjectMember | null>(null)
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
    if (
      customStatus !== 'all' &&
      !workItemStatuses.some(
        (status) => status.id === customStatus,
      )
    ) {
      setCustomStatus('all')
    }

    if (
      customType !== 'all' &&
      !workItemTypes.some(
        (type) => type.id === customType,
      )
    ) {
      setCustomType('all')
    }
  }, [
    customStatus,
    customType,
    workItemStatuses,
    workItemTypes,
  ])

  const routedProject = (
    location.state as { project?: RoutedProject } | null
  )?.project

  const project = useMemo<ProjectDetail | null>(() => {
    if (!projectId) return null

    const existingProject = demoProjects[projectId]
    if (existingProject) return existingProject

    if (routedProject?.id === projectId) {
      return {
        ...routedProject,
        members: [
          {
            id: 'alex',
            name: 'Alex Dev',
            email: 'alex@example.com',
            initials: 'AD',
            role: 'owner',
          },
        ],
      }
    }

    return null
  }, [projectId, routedProject])

  useEffect(() => {
    setMembers(project?.members ?? [])
    setAddMemberDialogOpen(false)
    setMemberToRemove(null)

    if (project) {
      setProjectName(project.name)
      setProjectDescription(project.description)
      setProjectStatus(project.status)

      setSettingsName(project.name)
      setSettingsDescription(project.description)
      setSettingsStatus(project.status)

      setWorkItemStatuses(
        defaultWorkItemStatuses.map((status) => ({ ...status })),
      )
      setWorkItemTypes(
        defaultWorkItemTypes.map((type) => ({ ...type })),
      )
      setWorkItemLabels(
        defaultWorkItemLabels.map((label) => ({ ...label })),
      )
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

  if (isPreviewLoading) {
    return <ProjectDetailSkeleton />
  }

  if (isPreviewError) {
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

  const currentMemberRole =
    members.find((member) => member.id === user?.username)?.role ??
    project.role

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

  const handleAddMember = (
    user: DirectoryUser,
    role: AddableProjectRole,
  ) => {
    if (!canManageMembers) return

    setMembers((currentMembers) => {
      if (currentMembers.some((member) => member.id === user.id)) {
        return currentMembers
      }

      return [
        ...currentMembers,
        {
          ...user,
          role,
        },
      ]
    })
  }

  const handleMemberRoleChange = (
    memberId: string,
    role: AddableProjectRole,
  ) => {
    if (!canManageMembers) return

    setMembers((currentMembers) => {
      const targetMember = currentMembers.find(
        (member) => member.id === memberId,
      )

      if (!targetMember) {
        return currentMembers
      }

      const currentOwnerCount = currentMembers.filter(
        (member) => member.role === 'owner',
      ).length

      const wouldRemoveLastOwner =
        targetMember.role === 'owner' &&
        role !== 'owner' &&
        currentOwnerCount <= 1

      if (wouldRemoveLastOwner) {
        return currentMembers
      }

      return currentMembers.map((member) =>
        member.id === memberId
          ? {
              ...member,
              role,
            }
          : member,
      )
    })
  }

  const handleConfirmRemoveMember = () => {
    if (!canManageMembers || !memberToRemove) {
      setMemberToRemove(null)
      return
    }

    setMembers((currentMembers) => {
      const currentOwnerCount = currentMembers.filter(
        (member) => member.role === 'owner',
      ).length

      const wouldRemoveLastOwner =
        memberToRemove.role === 'owner' &&
        currentOwnerCount <= 1

      if (wouldRemoveLastOwner) {
        return currentMembers
      }

      return currentMembers.filter(
        (member) => member.id !== memberToRemove.id,
      )
    })

    setMemberToRemove(null)
  }

  const projectActivities = forceEmptyActivity
    ? []
    : demoActivities[project.id] ?? []

  const projectWorkItems = forceEmptyWorkItems
    ? []
    : demoWorkItems[project.id] ?? []

  const configurationWorkItems = demoWorkItems[project.id] ?? []

  const workItemStatusUsage: Record<string, number> =
    Object.fromEntries(
      workItemStatuses.map((status) => [
        status.id,
        configurationWorkItems.filter(
          (item) => item.status === status.id,
        ).length,
      ]),
    )

  const workItemTypeUsage: Record<string, number> =
    Object.fromEntries(
      workItemTypes.map((type) => [
        type.id,
        configurationWorkItems.filter(
          (item) => item.type === type.id,
        ).length,
      ]),
    )

  const focusedWorkItems = projectWorkItems.filter((item) => {
    switch (workItemFocus) {
      case 'due-3-days':
        return (
          item.status !== 'done' &&
          item.dueInDays >= 0 &&
          item.dueInDays <= 3
        )

      case 'due-week':
        return (
          item.status !== 'done' &&
          item.dueInDays >= 0 &&
          item.dueInDays <= 7
        )

      case 'overdue':
        return item.status !== 'done' && item.dueInDays < 0

      case 'blocked':
        return item.status !== 'done' && item.blocked

      case 'mine':
        return item.status !== 'done' && item.assignee === 'Alex Dev'

      case 'recently-completed':
        return item.status === 'done'

      case 'all-open':
        return item.status !== 'done'

      case 'custom': {
        const dueMatches =
          item.dueInDays >= 0 && item.dueInDays <= customDueDays

        const statusMatches =
          customStatus === 'all' || item.status === customStatus

        const typeMatches =
          customType === 'all' || item.type === customType

        const assigneeMatches =
          customAssignee === 'all' || item.assignee === 'Alex Dev'

        return dueMatches && statusMatches && typeMatches && assigneeMatches
      }
    }
  })

  return (
    <div className="mx-auto w-full max-w-[1440px] px-6 py-8 lg:px-10 lg:py-10">
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
        <div className="mt-6 space-y-6">
          <div className="grid gap-6 lg:grid-cols-12">
            <section className="overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest shadow-sm lg:col-span-8">
              <div className="border-b border-outline-variant px-6 py-4">
                <h2 className="font-semibold text-on-surface">
                  Project overview
                </h2>

                <p className="mt-0.5 text-xs text-on-surface-variant">
                  Project description and context
                </p>
              </div>

              <div className="px-6 py-6">
                <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-on-surface-variant">
                  Description
                </div>

                {projectDescription.trim().length > 0 &&
                !forceEmptyDescription ? (
                  <p className="mt-2 max-w-3xl text-sm leading-6 text-on-surface">
                    {projectDescription}
                  </p>
                ) : (
                  <div className="mt-3 flex items-center justify-between gap-6 rounded-lg border border-dashed border-outline-variant bg-surface-container-low/45 px-4 py-4">
                    <div className="flex items-start gap-3">
                      <span className="material-symbols-outlined mt-0.5 text-[19px] text-on-surface-variant">
                        notes
                      </span>

                      <div>
                        <p className="text-sm font-medium text-on-surface">
                          No description yet
                        </p>

                        <p className="mt-0.5 text-xs leading-5 text-on-surface-variant">
                          Add context so project members can quickly understand
                          the purpose of this project.
                        </p>
                      </div>
                    </div>

                    {canEditProjectSettings && (
                      <button
                        type="button"
                        onClick={() => setActiveTab('settings')}
                        className="shrink-0 text-sm font-semibold text-primary transition hover:opacity-75"
                      >
                        Add description
                      </button>
                    )}
                  </div>
                )}
              </div>
            </section>

            <section className="overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest shadow-sm lg:col-span-4">
              <div className="border-b border-outline-variant px-5 py-4">
                <h2 className="font-semibold text-on-surface">
                  Latest activity
                </h2>

                <p className="mt-0.5 text-xs text-on-surface-variant">
                  Recent changes in this project
                </p>
              </div>

              {projectActivities.length > 0 ? (
                <div className="divide-y divide-outline-variant">
                  {projectActivities.map((activity) => (
                    <div
                      key={activity.id}
                      className="flex gap-3 px-5 py-4"
                    >
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant">
                        <span className="material-symbols-outlined text-[17px]">
                          {activity.icon}
                        </span>
                      </div>

                      <div className="min-w-0">
                        <div className="text-sm font-medium text-on-surface">
                          {activity.title}
                        </div>

                        <div className="mt-1 text-xs text-on-surface-variant">
                          {activity.meta}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex min-h-40 flex-col items-center justify-center px-5 py-8 text-center">
                  <span className="material-symbols-outlined text-[22px] text-on-surface-variant">
                    history
                  </span>

                  <p className="mt-2 text-sm font-medium text-on-surface">
                    No activity yet
                  </p>

                  <p className="mt-1 max-w-xs text-xs leading-5 text-on-surface-variant">
                    Recent project changes will appear here.
                  </p>
                </div>
              )}
            </section>
          </div>

          <section className="overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest shadow-sm">
            <div className="flex flex-col gap-4 border-b border-outline-variant px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h2 className="font-semibold text-on-surface">
                  Work Items
                </h2>

                <p className="mt-0.5 text-xs text-on-surface-variant">
                  Focus on the project work that currently needs attention.
                </p>
              </div>

              <button
                type="button"
                onClick={() => setActiveTab('work-items')}
                className="inline-flex items-center gap-1 text-sm font-medium text-primary transition hover:opacity-75"
              >
                View all

                <span className="material-symbols-outlined text-[17px]">
                  arrow_forward
                </span>
              </button>
            </div>

            <div className="border-b border-outline-variant bg-surface-container-low/45 px-6 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2">
                  <span className="text-xs font-medium text-on-surface-variant">
                    Focus
                  </span>

                  <select
                    value={workItemFocus}
                    onChange={(event) =>
                      setWorkItemFocus(event.target.value as WorkItemFocus)
                    }
                    className="h-9 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm font-medium text-on-surface outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
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
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface"
                  >
                    <span className="material-symbols-outlined text-[17px]">
                      tune
                    </span>
                    Customize
                  </button>
                )}

                <span className="ml-auto text-xs text-on-surface-variant">
                  {focusedWorkItems.length}{' '}
                  {focusedWorkItems.length === 1 ? 'item' : 'items'}
                </span>
              </div>

              {workItemFocus === 'custom' && (
                <div className="mt-3 grid gap-3 border-t border-outline-variant pt-3 sm:grid-cols-2 xl:grid-cols-4">
                  <label>
                    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.1em] text-on-surface-variant">
                      Due within
                    </span>

                    <div className="flex h-9 items-center rounded-lg border border-outline-variant bg-surface-container-lowest">
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
                        className="min-w-0 flex-1 bg-transparent px-3 text-sm outline-none"
                      />

                      <span className="pr-3 text-xs text-on-surface-variant">
                        days
                      </span>
                    </div>
                  </label>

                  <label>
                    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.1em] text-on-surface-variant">
                      Status
                    </span>

                    <select
                      value={customStatus}
                      onChange={(event) =>
                        setCustomStatus(
                          event.target.value as CustomWorkItemStatus,
                        )
                      }
                      className="h-9 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm outline-none focus:border-primary"
                    >
                      <option value="all">Any status</option>

                      {workItemStatuses.map((status) => (
                        <option key={status.id} value={status.id}>
                          {status.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label>
                    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.1em] text-on-surface-variant">
                      Type
                    </span>

                    <select
                      value={customType}
                      onChange={(event) =>
                        setCustomType(
                          event.target.value as CustomWorkItemType,
                        )
                      }
                      className="h-9 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm outline-none focus:border-primary"
                    >
                      <option value="all">Any type</option>

                      {workItemTypes.map((type) => (
                        <option key={type.id} value={type.id}>
                          {type.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label>
                    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.1em] text-on-surface-variant">
                      Assignee
                    </span>

                    <select
                      value={customAssignee}
                      onChange={(event) =>
                        setCustomAssignee(
                          event.target.value as 'all' | 'me',
                        )
                      }
                      className="h-9 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm outline-none focus:border-primary"
                    >
                      <option value="all">Anyone</option>
                      <option value="me">Me</option>
                    </select>
                  </label>
                </div>
              )}
            </div>

            {projectWorkItems.length === 0 ? (
              <div className="flex min-h-48 flex-col items-center justify-center px-6 py-10 text-center">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant">
                  <span className="material-symbols-outlined text-[22px]">
                    checklist
                  </span>
                </div>

                <p className="mt-3 text-sm font-semibold text-on-surface">
                  No work items yet
                </p>

                <p className="mt-1 max-w-md text-xs leading-5 text-on-surface-variant">
                  Work created for this project will appear here. The full Work
                  Items workflow is the next UI slice.
                </p>
              </div>
            ) : focusedWorkItems.length > 0 ? (
              <div className="divide-y divide-outline-variant">
                {focusedWorkItems.slice(0, 5).map((item) => (
                  <div
                    key={item.id}
                    className="grid gap-3 px-6 py-4 sm:grid-cols-[minmax(0,1fr)_130px_150px_110px] sm:items-center"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-[18px] text-on-surface-variant">
                          {item.type === 'milestone'
                            ? 'flag'
                            : item.type === 'deliverable'
                              ? 'inventory_2'
                              : item.type === 'epic'
                                ? 'account_tree'
                                : 'check_box_outline_blank'}
                        </span>

                        <span className="truncate text-sm font-medium text-on-surface">
                          {item.title}
                        </span>
                      </div>

                      <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-on-surface-variant sm:hidden">
                        {workItemTypeLabels[item.type]}
                      </div>
                    </div>

                    <div>
                      <span className="text-xs font-medium text-on-surface-variant">
                        {workItemTypeLabels[item.type]}
                      </span>
                    </div>

                    <div>
                      <span
                        className={[
                          'inline-flex rounded-full px-2.5 py-1 text-xs font-medium',
                          item.blocked
                            ? 'bg-error-container text-error'
                            : 'bg-surface-container-high text-on-surface',
                        ].join(' ')}
                      >
                        {item.blocked
                          ? 'Blocked'
                          : workItemStatusLabels[item.status]}
                      </span>
                    </div>

                    <div className="flex items-center justify-between gap-3 sm:justify-end">
                      <span
                        className={[
                          'text-xs',
                          item.dueInDays < 0 && item.status !== 'done'
                            ? 'font-semibold text-error'
                            : 'text-on-surface-variant',
                        ].join(' ')}
                      >
                        {item.dueLabel}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex min-h-36 flex-col items-center justify-center px-6 py-8 text-center">
                <span className="material-symbols-outlined text-[22px] text-on-surface-variant">
                  filter_alt_off
                </span>

                <p className="mt-2 text-sm font-medium text-on-surface">
                  No Work Items match this focus
                </p>

                <p className="mt-1 text-xs text-on-surface-variant">
                  Choose another preset or customize the filter.
                </p>
              </div>
            )}
          </section>
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
                        {member.email}
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

      {activeTab === 'work-items' && (
        <ProjectWorkItemsPanel
          items={projectWorkItems}
          statusDefinitions={workItemStatuses}
          typeDefinitions={workItemTypes}
          assigneeNames={sortedMembers
            .filter((member) => member.role !== 'viewer')
            .map((member) => member.name)}
          readOnly={isReadOnly}
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

            <WorkItemConfigurationSettings
              statuses={workItemStatuses}
              types={workItemTypes}
              labels={workItemLabels}
              statusUsage={workItemStatusUsage}
              typeUsage={workItemTypeUsage}
              readOnly={!canEditProjectSettings}
              onStatusesChange={setWorkItemStatuses}
              onTypesChange={setWorkItemTypes}
              onLabelsChange={setWorkItemLabels}
            />
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
        users={demoDirectoryUsers}
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
    </div>
  )
}

function ProjectWorkItemsPanel({
  items,
  statusDefinitions,
  typeDefinitions,
  assigneeNames,
  readOnly,
  preferencesKey,
}: {
  items: DemoWorkItem[]
  statusDefinitions: WorkItemStatusDefinition[]
  typeDefinitions: WorkItemTypeDefinition[]
  assigneeNames: string[]
  readOnly: boolean
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
        typeof parsed.type === 'string'
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
      typeFilter !== 'all' &&
      !typeDefinitions.some(
        (type) => type.id === typeFilter,
      )
    ) {
      setTypeFilter('all')
    }
  }, [typeDefinitions, typeFilter])

  useEffect(() => {
    if (
      assigneeFilter !== 'all' &&
      !assigneeNames.includes(assigneeFilter)
    ) {
      setAssigneeFilter('all')
    }
  }, [assigneeFilter, assigneeNames])

  const sortedAssigneeNames = useMemo(
    () => [...assigneeNames].sort((a, b) => a.localeCompare(b)),
    [assigneeNames],
  )

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()

    return items.filter((item) => {
      const matchesQuery =
        normalizedQuery.length === 0 ||
        item.title.toLowerCase().includes(normalizedQuery) ||
        item.assignee.toLowerCase().includes(normalizedQuery) ||
        workItemTypeLabels[item.type]
          .toLowerCase()
          .includes(normalizedQuery)

      const matchesType =
        typeFilter === 'all' || item.type === typeFilter

      const matchesAssignee =
        assigneeFilter === 'all' ||
        item.assignee === assigneeFilter

      const matchesBlocked = !blockedOnly || item.blocked

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

  const statusColumns = statusDefinitions.map((status) => ({
    status: status.id,
    label: status.name,
    icon: status.icon,
  }))

  const typeFilters: Array<{
    value: WorkItemsTypeFilter
    label: string
  }> = [
    { value: 'all', label: 'All' },
    ...typeDefinitions.map((type) => ({
      value: type.id,
      label: type.name,
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

              {sortedAssigneeNames.map((name) => (
                <option key={name} value={name}>
                  {name}
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
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-[18px] text-on-surface-variant">
                      {column.icon}
                    </span>

                    <span className="text-sm font-semibold text-on-surface">
                      {column.label}
                    </span>
                  </div>

                  <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-surface-container-high px-2 py-0.5 text-[11px] font-semibold text-on-surface-variant">
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

function WorkItemBoardCard({
  item,
}: {
  item: DemoWorkItem
}) {
  const typeIcon =
    item.type === 'epic'
      ? 'account_tree'
      : item.type === 'milestone'
        ? 'flag'
        : item.type === 'deliverable'
          ? 'inventory_2'
          : 'check_box_outline_blank'

  const overdue =
    item.status !== 'done' && item.dueInDays < 0

  const initials = item.assignee
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  return (
    <article className="rounded-lg border border-outline-variant bg-surface-container-lowest p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-on-surface-variant">
          <span className="material-symbols-outlined text-[16px]">
            {typeIcon}
          </span>
          {workItemTypeLabels[item.type]}
        </span>

        {item.blocked && (
          <span className="inline-flex items-center gap-1 rounded-full bg-error-container px-2 py-0.5 text-[10px] font-semibold text-error">
            <span className="material-symbols-outlined text-[13px]">
              block
            </span>
            Blocked
          </span>
        )}
      </div>

      <h3 className="mt-3 text-sm font-semibold leading-5 text-on-surface">
        {item.title}
      </h3>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-outline-variant pt-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-[9px] font-semibold text-on-surface">
            {initials}
          </div>

          <span className="truncate text-xs text-on-surface-variant">
            {item.assignee}
          </span>
        </div>

        <span
          className={[
            'inline-flex shrink-0 items-center gap-1 text-[11px] font-medium',
            overdue
              ? 'text-error'
              : 'text-on-surface-variant',
          ].join(' ')}
        >
          <span className="material-symbols-outlined text-[15px]">
            schedule
          </span>
          {item.dueLabel}
        </span>
      </div>
    </article>
  )
}

function WorkItemsList({
  items,
}: {
  items: DemoWorkItem[]
}) {
  return (
    <div>
      <div className="grid grid-cols-[minmax(0,1fr)_150px_150px_180px_130px] border-b border-outline-variant bg-surface-container-low/55 px-6 py-2.5">
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-on-surface-variant">
          Work item
        </div>

        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-on-surface-variant">
          Type
        </div>

        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-on-surface-variant">
          Status
        </div>

        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-on-surface-variant">
          Assignee
        </div>

        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-on-surface-variant">
          Due
        </div>
      </div>

      <div className="divide-y divide-outline-variant">
        {items.map((item) => {
          const typeIcon =
            item.type === 'epic'
              ? 'account_tree'
              : item.type === 'milestone'
                ? 'flag'
                : item.type === 'deliverable'
                  ? 'inventory_2'
                  : 'check_box_outline_blank'

          const statusIcon =
            item.status === 'todo'
              ? 'radio_button_unchecked'
              : item.status === 'in_progress'
                ? 'pending'
                : item.status === 'review'
                  ? 'rate_review'
                  : 'check_circle'

          const overdue =
            item.status !== 'done' && item.dueInDays < 0

          const initials = item.assignee
            .split(/\s+/)
            .map((part) => part[0])
            .join('')
            .slice(0, 2)
            .toUpperCase()

          return (
            <div
              key={item.id}
              className="grid grid-cols-[minmax(0,1fr)_150px_150px_180px_130px] items-center px-6 py-4 transition hover:bg-surface-container-low/45"
            >
              <div className="min-w-0 pr-6">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-on-surface">
                    {item.title}
                  </span>

                  {item.blocked && (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-error-container px-2 py-0.5 text-[10px] font-semibold text-error">
                      <span className="material-symbols-outlined text-[13px]">
                        block
                      </span>
                      Blocked
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1.5 text-xs font-medium text-on-surface-variant">
                <span className="material-symbols-outlined text-[17px]">
                  {typeIcon}
                </span>
                {workItemTypeLabels[item.type]}
              </div>

              <div>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-container-high px-2.5 py-1 text-xs font-medium text-on-surface">
                  <span className="material-symbols-outlined text-[15px] text-on-surface-variant">
                    {statusIcon}
                  </span>
                  {workItemStatusLabels[item.status]}
                </span>
              </div>

              <div className="flex min-w-0 items-center gap-2">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-[9px] font-semibold text-on-surface">
                  {initials}
                </div>

                <span className="truncate text-xs text-on-surface-variant">
                  {item.assignee}
                </span>
              </div>

              <div
                className={[
                  'flex items-center gap-1 text-xs font-medium',
                  overdue
                    ? 'text-error'
                    : 'text-on-surface-variant',
                ].join(' ')}
              >
                <span className="material-symbols-outlined text-[16px]">
                  schedule
                </span>
                {item.dueLabel}
              </div>
            </div>
          )
        })}
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

