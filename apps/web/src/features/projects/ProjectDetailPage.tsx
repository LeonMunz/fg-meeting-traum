import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
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
import type { WorkItemFormInput } from './WorkItemDrawer'
import {
  WorkItemActionMenuTrigger,
  WorkItemDeleteDialog,
} from './workItemDelete'
import { ApiError } from '../../api/client'
import {
  addProjectMembership,
  archiveProject,
  deleteProject,
  getProject,
  getProjectWorkItemConfiguration,
  listProjectMemberships,
  listResearchGroupMembers,
  removeProjectMembership,
  restoreProject,
  updateProject,
  updateProjectMembership,
} from '../../api/projects'
import {
  buildCreateWorkItemInput,
  resolveStatusDefinitionIdByCategory,
  resolveWorkItemDisplay,
} from './workItemMapping'

import type {
  ApiProjectMembership,
  ApiProjectWorkItemConfiguration,
  ApiResearchGroupMember,
  ApiUpdateWorkItemInput,
  ApiWorkItem,
} from '../../api/types'
import {
  createWorkItem,
  deleteWorkItem,
  listProjectWorkItems,
  reorderWorkItem,
  updateWorkItem,
} from '../../api/work-items'
import { useSession } from '../../api/useSession'

// Lazy: WorkItemDrawer pulls in RichMarkdownEditor -> Tiptap/ProseMirror,
// by far the heaviest dependency graph in this feature. Nothing here
// needs it until a Work Item is actually opened or created, so it's kept
// out of the initial Project page bundle and fetched on first use.
const WorkItemDrawer = lazy(() =>
  import('./WorkItemDrawer').then((module) => ({
    default: module.WorkItemDrawer,
  })),
)

// Quiet placeholder shown only for the brief window while the
// WorkItemDrawer chunk loads on first open. Mirrors just enough of the
// real shell (footprint + the `data-work-item-inspector-boundary`
// marker used by the outside-click-close effect below) that:
//  - edit mode doesn't cause a layout jump in the right-side inspector
//    rail, and
//  - a click landing on the fallback isn't misread as an "outside"
//    click and doesn't immediately close the inspector once the real
//    drawer mounts.
// No spinner, no skeleton content — it only ever exists for one chunk
// fetch, typically imperceptible on a warm cache.
function WorkItemDrawerFallback({
  mode,
}: {
  mode: 'create' | 'edit'
}) {
  if (mode === 'edit') {
    return (
      <div
        data-work-item-inspector-boundary="true"
        className="fixed inset-y-0 right-0 z-40 w-full border-l border-outline-variant bg-surface-container-lowest shadow-2xl sm:w-[520px]"
      />
    )
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/30">
      <div className="ml-auto h-full w-full max-w-[660px] border-l border-outline-variant bg-surface-container-lowest shadow-2xl" />
    </div>
  )
}

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
  | 'members'
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
  typeLabel: string
  assignees: DemoWorkItemAssignee[]
  dueInDays: number | null
  dueLabel: string | null
  blockedReason: string | null
  parentId: string | null
  // Manual Board position (canonical, from the server). null = unsorted.
  boardPosition: number | null
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

const roleClass: Record<ProjectRole, string> = {
  owner: 'bg-role-owner-bg text-role-owner-text',
  member: 'bg-surface-muted text-text-muted',
  viewer: 'bg-surface-muted text-text-muted',
}

const tabs: Array<{
  id: ProjectTab
  label: string
}> = [
  { id: 'work-items', label: 'Work Items' },
  { id: 'overview', label: 'Overview' },
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
  config: ApiProjectWorkItemConfiguration | null,
): DemoWorkItem {
  const due = getWorkItemDueFields(item.dueDate)
  const display = resolveWorkItemDisplay(item, config)

  return {
    id: String(item.id),
    title: item.title,
    type: display.type,
    status: display.status,
    typeLabel: display.typeLabel,
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
    boardPosition: item.boardPosition ?? null,
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
      segment === 'members' ||
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
  const [workItemConfig, setWorkItemConfig] =
    useState<ApiProjectWorkItemConfiguration | null>(null)
  // Bumped by the cross-flow "work-item-created" event so that an
  // already-mounted Project page re-fetches its canonical WorkItem
  // list without requiring a hard reload.
  const [workItemsRefreshKey, setWorkItemsRefreshKey] =
    useState(0)
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

  // Single, page-level Work Item deletion confirmation. The selected item
  // may originate from the drawer, a Board card, or a List row, but all
  // three converge on this one dialog + `handleDeleteWorkItem` operation.
  const [
    workItemDeleteTarget,
    setWorkItemDeleteTarget,
  ] = useState<number | null>(null)
  const [
    isDeletingWorkItem,
    setIsDeletingWorkItem,
  ] = useState(false)
  const [
    deleteWorkItemError,
    setDeleteWorkItemError,
  ] = useState<string | null>(null)
  const [boardStatusDropError, setBoardStatusDropError] =
    useState<string | null>(null)

  // Contextual-selection close: while the (non-modal) edit inspector
  // is open, any click landing outside both the inspector itself and
  // every canonical Work Item target (Board card / List row /
  // Overview row — all marked with `data-work-item-id`) closes it.
  //
  // One explicit exception: the Board/List view switch is marked
  // `data-work-item-inspector-keep-open`. Switching views re-renders
  // the SAME selected Work Item in the other view (its selected-state
  // styling carries over) rather than navigating away from it, so —
  // unlike every other toolbar/filter control — it must not close the
  // inspector. This marker is intentionally narrow: only the two view
  // toggle buttons carry it, not the surrounding toolbar.
  //
  // This is a single page-level boundary check, not a blind
  // "close on any outside click": it inspects where the click
  // actually landed via `closest()` before deciding.
  //
  // Registered on the CAPTURE phase, deliberately. A bubble-phase
  // document listener runs after the clicked element's own React
  // handler — but some Work Item targets (e.g. the inspector's own
  // title, which turns from a button into an input on click) mutate
  // the DOM synchronously in that handler, detaching the very node
  // `event.target` points to before the bubble ever reaches
  // `document`. `closest()` on a detached node can no longer find its
  // old ancestors, which would misread a perfectly normal inspector
  // interaction as "outside". Capture fires top-down BEFORE the
  // target's own handler runs, while the DOM still matches what was
  // actually clicked, so the boundary check is always accurate — and
  // it still never blindly closes: closing only ever happens for a
  // target that is genuinely neither marker, and this handler itself
  // never calls stopPropagation/preventDefault, so every Work Item's
  // own click handler (switching, opening, menus, drag handles, …)
  // still runs completely normally afterward.
  //
  // Native HTML5 drag-and-drop (Board cards) never dispatches a
  // "click" event for the drag gesture itself, so dragging a card
  // between columns never reaches this handler at all.
  //
  // Declared unconditionally (before any early `return`) to satisfy
  // rules-of-hooks — it no-ops internally whenever the drawer isn't
  // in edit mode.
  useEffect(() => {
    if (workItemDrawerState?.mode !== 'edit') {
      return
    }

    function handleDocumentClickCapture(
      event: MouseEvent,
    ) {
      const target = event.target

      if (!(target instanceof Element)) {
        return
      }

      if (
        target.closest(
          '[data-work-item-inspector-boundary]',
        )
      ) {
        return
      }

      if (target.closest('[data-work-item-id]')) {
        return
      }

      if (
        target.closest(
          '[data-work-item-inspector-keep-open]',
        )
      ) {
        return
      }

      // Functional update: guards against a same-tick race with a
      // click that also opens/switches the drawer (e.g. a toolbar
      // control that both closes this inspector AND opens Create
      // mode). Only clear if the drawer is STILL in edit mode by the
      // time this update actually applies — never clobber a state
      // change queued by the click's own handler.
      setWorkItemDrawerState((current) =>
        current?.mode === 'edit' ? null : current,
      )
    }

    document.addEventListener(
      'click',
      handleDocumentClickCapture,
      true,
    )

    return () => {
      document.removeEventListener(
        'click',
        handleDocumentClickCapture,
        true,
      )
    }
  }, [workItemDrawerState?.mode])

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
  }, [project, workItemsRefreshKey])

  const requestWorkItemsRefresh = useCallback(() => {
    setWorkItemsRefreshKey((current) => current + 1)
  }, [])

  useEffect(() => {
    function handleWorkItemCreated(
      event: Event,
    ) {
      // The event payload carries the newly created ApiWorkItem,
      // which includes the canonical projectId.
      const detail = (event as CustomEvent<{
        projectId?: number
      }>).detail
      const numericProjectId = Number(project?.id)

      if (
        detail &&
        typeof detail.projectId === 'number' &&
        detail.projectId !== numericProjectId
      ) {
        return
      }

      requestWorkItemsRefresh()
    }

    window.addEventListener(
      'fg-workspace:work-item-created',
      handleWorkItemCreated,
    )

    return () => {
      window.removeEventListener(
        'fg-workspace:work-item-created',
        handleWorkItemCreated,
      )
    }
  }, [project?.id, requestWorkItemsRefresh])

  // The backend WorkItems carry configurable type/status *definition IDs*,
  // not fixed strings. To render them (labels, icons, board columns,
  // "done" detection) we must join each item against the Project's own
  // Work Item configuration. Load it alongside the WorkItems.
  useEffect(() => {
    if (!project) {
      setWorkItemConfig(null)
      return
    }

    const numericProjectId = Number(project.id)
    let cancelled = false

    setWorkItemConfig(null)

    getProjectWorkItemConfiguration(numericProjectId)
      .then((config) => {
        if (!cancelled) {
          setWorkItemConfig(config)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWorkItemConfig(null)
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
          className="inline-flex items-center gap-1.5 text-sm font-medium text-text-muted transition hover:text-link-hover"
        >
          <span className="material-symbols-outlined text-[18px]">
            arrow_back
          </span>
          Projects
        </Link>

        <div
          role="alert"
          className="mt-8 flex min-h-80 flex-col items-center justify-center rounded-xl border border-border-structural bg-surface-quiet px-6 py-12 text-center"
        >
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-danger-bg text-danger">
            <span className="material-symbols-outlined text-[23px]">
              cloud_off
            </span>
          </div>

          <h1 className="mt-4 text-base font-semibold text-text">
            Project couldn't be loaded
          </h1>

          <p className="mt-1 max-w-md text-sm leading-6 text-text-muted">
            Something went wrong while loading this project. Try again or
            return to your projects.
          </p>

          <div className="mt-5 flex items-center gap-3">
            <Link
              to="/projects"
              className="inline-flex h-9 items-center justify-center rounded-lg px-4 text-sm font-medium text-text-muted transition hover:bg-surface-hover hover:text-text"
            >
              Back to projects
            </Link>

            <button
              type="button"
              onClick={clearPreviewState}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-action px-4 text-sm font-semibold text-text-inverse shadow-sm transition hover:bg-action-hover"
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
          className="inline-flex items-center gap-1.5 text-sm font-medium text-text-muted transition hover:text-link-hover"
        >
          <span className="material-symbols-outlined text-[18px]">
            arrow_back
          </span>
          Projects
        </Link>

        <div className="mt-8 flex min-h-80 flex-col items-center justify-center rounded-xl border border-dashed border-border-standalone bg-surface-quiet px-6 py-12 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-muted text-text-muted">
            <span className="material-symbols-outlined text-[23px]">
              folder_off
            </span>
          </div>

          <h1 className="mt-4 text-base font-semibold text-text">
            Project not found
          </h1>

          <p className="mt-1 max-w-md text-sm leading-6 text-text-muted">
            This project may no longer exist or may not be available to your
            account.
          </p>

          <Link
            to="/projects"
            className="mt-5 inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-action px-4 text-sm font-semibold text-text-inverse shadow-sm transition hover:bg-action-hover"
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
    (item) => mapApiWorkItem(item, members, workItemConfig),
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

    if (!Number.isInteger(numericProjectId)) {
      throw new Error('Invalid Project ID.')
    }

    const createInput = buildCreateWorkItemInput(input)

    setWorkItemsError(null)

    try {
      const created = await createWorkItem(
        numericProjectId,
        createInput,
      )

      // New Work Items are appended to the end of their status column
      // by the server (see WorkItem.board_position), so mirror that by
      // appending here to keep the local list in canonical order.
      setApiWorkItems((current) => [
        ...current.filter((item) => item.id !== created.id),
        created,
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

  const handleDeleteWorkItem = async (
    workItemId: number,
  ) => {
    if (isReadOnly) {
      throw new Error(
        isArchived
          ? 'Archived Projects are read-only. Restore the Project first.'
          : 'A viewer cannot delete Work Items.',
      )
    }

    if (!Number.isInteger(workItemId)) {
      throw new Error('Invalid Work Item ID.')
    }

    setIsDeletingWorkItem(true)
    setDeleteWorkItemError(null)

    try {
      await deleteWorkItem(workItemId)
    } catch (error) {
      // Failure: keep the item visible and surface the error. The drawer
      // (if it originated this delete) keeps itself open on a thrown
      // error; Board/List keep the row/card visible because the
      // collection is not mutated.
      const message = getWorkItemErrorMessage(
        error,
        'Work item could not be deleted.',
      )
      setWorkItemsError(message)
      setDeleteWorkItemError(message)
      throw new Error(message)
    }

    // Success: drop the deleted item from the canonical collection.
    // Removing it also closes the inspector if it was open: the open edit
    // state no longer resolves to any Work Item, so the drawer unmounts.
    setApiWorkItems((current) =>
      current.filter((item) => item.id !== workItemId),
    )
    setWorkItemDeleteTarget(null)
  }

  const requestWorkItemDelete = (workItemId: number) => {
    setDeleteWorkItemError(null)
    setWorkItemDeleteTarget(workItemId)
  }

  const cancelWorkItemDelete = () => {
    if (isDeletingWorkItem) {
      return
    }
    setWorkItemDeleteTarget(null)
  }

  const confirmWorkItemDelete = async () => {
    if (isDeletingWorkItem || workItemDeleteTarget == null) {
      return
    }

    const targetId = workItemDeleteTarget

    try {
      await handleDeleteWorkItem(targetId)
    } catch {
      // Already surfaced via setDeleteWorkItemError / setWorkItemsError.
    } finally {
      setIsDeletingWorkItem(false)
    }
  }

  const handleWorkItemStatusDrop = async (
    workItemId: number,
    newStatus: DemoWorkItemStatus,
    beforeWorkItemId: number | null,
  ) => {
    if (isReadOnly) {
      return
    }

    const previous = apiWorkItems.find(
      (item) => item.id === workItemId,
    )

    if (!previous) {
      return
    }

    const statusDefinitionId =
      resolveStatusDefinitionIdByCategory(
        newStatus,
        workItemConfig,
      )

    if (statusDefinitionId == null) {
      setBoardStatusDropError(
        'No matching status is configured for this Project.',
      )
      return
    }

    // Same status + no explicit target = no-op (drop on own column with
    // no meaningful gap).
    if (previous.status === newStatus && beforeWorkItemId == null) {
      return
    }

    setBoardStatusDropError(null)

    try {
      await reorderWorkItem(workItemId, {
        statusDefinitionId,
        beforeWorkItemId,
      })

      // The server renumbers the whole target column, so refresh the
      // list to render every card in its canonical position.
      requestWorkItemsRefresh()
    } catch (error) {
      setBoardStatusDropError(
        getWorkItemErrorMessage(
          error,
          'Work item could not be moved.',
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

  return (
    <div className="w-full px-6 py-8 lg:px-8 lg:py-10 xl:px-10">
      <Link
        to={`/projects?group=${project.researchGroupId}`}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-text-muted transition hover:text-link-hover"
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

              <span className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
                {statusLabel[projectStatus]}
              </span>
            </div>

            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-text lg:text-[34px]">
              {projectName}
            </h1>

          </div>

          <div className="flex shrink-0 flex-wrap items-center">
            <div className="flex -space-x-2">
              {sortedMembers.slice(0, 4).map((member) => (
                <div
                  key={member.id}
                  title={member.name}
                  className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-canvas bg-surface-muted text-[10px] font-semibold text-text"
                >
                  {member.initials}
                </div>
              ))}

              {members.length > 4 && (
                <div className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-canvas bg-surface-muted text-[10px] font-semibold text-text-muted">
                  +{members.length - 4}
                </div>
              )}
            </div>

            {canManageMembers && (
              <button
                type="button"
                onClick={() =>
                  setAddMemberDialogOpen(true)
                }
                aria-label="Add project member"
                title="Add project member"
                className="ml-2 flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border-default bg-transparent text-text-muted outline-none transition hover:bg-surface-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
              >
                <span
                  aria-hidden="true"
                  className="material-symbols-outlined text-[14px]"
                >
                  person_add
                </span>
              </button>
            )}

            <div className="ml-3 h-6 w-px bg-border-structural" />

            <span
              className={[
                'ml-3 inline-flex rounded-full px-3 py-1.5 text-xs font-semibold',
                roleClass[currentMemberRole],
              ].join(' ')}
            >
              {roleLabel[currentMemberRole]}
            </span>
          </div>
        </div>

        <nav
          className="mt-8 flex h-[38px] items-stretch gap-7 overflow-x-auto border-b border-border-subtle"
        >
          {tabs.map((tab) => {
            const selected = activeTab === tab.id

            return (
              <Link
                key={tab.id}
                to={`/projects/${project.id}/${tab.id}`}
                aria-current={selected ? 'page' : undefined}
                className={[
                  'relative flex shrink-0 items-center text-[13px] font-medium leading-5 outline-none transition focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-focus',
                  selected
                    ? 'text-text'
                    : 'text-text-muted hover:text-text',
                ].join(' ')}
              >
                {tab.label}

                {selected && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 bottom-0 h-0.5 bg-text"
                  />
                )}
              </Link>
            )
          })}
        </nav>
      </header>

      {isArchived && (
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-border-structural bg-surface-quiet px-4 py-3.5">
          <span className="material-symbols-outlined mt-0.5 text-[19px] text-text-muted">
            archive
          </span>

          <div>
            <div className="text-sm font-medium text-text">
              Archived project
            </div>

            <p className="mt-0.5 text-xs leading-5 text-text-muted">
              This project is kept for reference and is read-only.
              {canManageProjectLifecycle
                ? ' Restore it from Settings to continue working.'
                : ''}
            </p>
          </div>
        </div>
      )}

      {isViewer && !isArchived && (
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-border-structural bg-surface-quiet px-4 py-3.5">
          <span className="material-symbols-outlined mt-0.5 text-[19px] text-text-muted">
            visibility
          </span>

          <div>
            <div className="text-sm font-medium text-text">
              Viewer access
            </div>
            <p className="mt-0.5 text-xs leading-5 text-text-muted">
              You can inspect this project, but editing actions are read-only.
            </p>
          </div>
        </div>
      )}


      {activeTab === 'overview' && (
        <div className="mt-7 w-full max-w-[960px]">
          <section>
            <div className="flex items-center justify-between">
              <h2 className="text-[13px] font-semibold leading-[18px] text-text">
                About
              </h2>

              {canEditProjectSettings &&
                projectDescription.trim().length > 0 &&
                !forceEmptyDescription && (
                  <button
                    type="button"
                    onClick={() => navigateToTab('settings')}
                    className="rounded px-1 text-xs font-medium leading-[18px] text-text-muted transition outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    Edit
                  </button>
                )}
            </div>

            <div className="mt-3">
              <div className="text-[11px] font-medium leading-4 text-text-tertiary">
                Description
              </div>

              {projectDescription.trim().length > 0 &&
              !forceEmptyDescription ? (
                <p className="mt-1.5 text-[13px] leading-5 text-text">
                  {projectDescription}
                </p>
              ) : (
                <div className="mt-1.5">
                  <p className="text-[13px] font-medium leading-[18px] text-text-tertiary">
                    No description yet.
                  </p>

                  <p className="mt-1 max-w-lg text-xs leading-4 text-text-tertiary">
                    Add context so project members can quickly understand
                    the purpose of this project.
                  </p>

                  {canEditProjectSettings && (
                    <button
                      type="button"
                      onClick={() => navigateToTab('settings')}
                      className="mt-2 rounded px-1 text-xs font-medium leading-[18px] text-accent-text transition outline-none hover:opacity-75 focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      Add description
                    </button>
                  )}
                </div>
              )}
            </div>
          </section>

          <div
            aria-hidden="true"
            className="mt-7 mb-6 border-t border-border-subtle"
          />

          <section
            aria-labelledby="overview-milestones-heading"
          >
            <h2
              id="overview-milestones-heading"
              className="text-[13px] font-semibold leading-[18px] text-text"
            >
              Milestones
            </h2>

            {workItemsLoading ? (
              <p className="mt-3 text-[13px] leading-5 text-text-muted">
                Loading milestones…
              </p>
            ) : workItemsError ? (
              <p className="mt-3 text-[13px] leading-5 text-text-muted">
                Project work could not be loaded.
              </p>
            ) : milestoneWorkItems.length > 0 ? (
              <div className="mt-3 divide-y divide-border-subtle">
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
              <p className="mt-2.5 text-xs leading-[18px] text-text-tertiary">
                No milestones yet.
              </p>
            )}
          </section>

          <div
            aria-hidden="true"
            className="mt-7 mb-6 border-t border-border-subtle"
          />

          <section
            aria-labelledby="overview-attention-heading"
          >
            <h2
              id="overview-attention-heading"
              className="text-[13px] font-semibold leading-[18px] text-text"
            >
              Needs Attention
            </h2>

            {workItemsLoading ? (
              <p className="mt-3 text-[13px] leading-5 text-text-muted">
                Checking project work…
              </p>
            ) : workItemsError ? (
              <p className="mt-3 text-[13px] leading-5 text-text-muted">
                Project work could not be loaded.
              </p>
            ) : attentionWorkItems.length > 0 ? (
              <div className="mt-3 divide-y divide-border-subtle">
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
              <p className="mt-2.5 text-xs leading-[18px] text-text-tertiary">
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
            onRequestDelete={requestWorkItemDelete}
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
            inspectorOpen={
              workItemDrawerState?.mode === 'edit'
            }
          />
        )}

      {activeTab === 'members' && (
        <div className="mt-7 w-full max-w-[1120px]">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold leading-6 text-text">
                  Members
                </h2>

                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-[10px] bg-selected-neutral-bg px-1.5 text-[11px] font-medium leading-4 text-text-muted">
                  {members.length}
                </span>
              </div>

              <p className="mt-1 text-[13px] leading-5 text-text-muted">
                People with access to this project and their current role.
              </p>
            </div>

            {canManageMembers && (
              <button
                type="button"
                onClick={() =>
                  setAddMemberDialogOpen(true)
                }
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded bg-accent px-2.5 text-[13px] font-medium leading-[18px] text-white transition hover:bg-accent-hover"
              >
                <span
                  aria-hidden="true"
                  className="material-symbols-outlined text-[15px]"
                >
                  person_add
                </span>
                Add member
              </button>
            )}
          </div>

          {membersError && (
            <div
              role="alert"
              className="mt-4 rounded bg-danger-bg px-4 py-3 text-sm text-danger"
            >
              {membersError}
            </div>
          )}

          {membersLoading ? (
            <div className="mt-6 flex min-h-32 items-center justify-center rounded-md border border-border-subtle bg-surface-quiet px-4 text-sm text-text-muted">
              <span className="material-symbols-outlined mr-2 animate-spin text-[18px]">
                refresh
              </span>
              Loading project members…
            </div>
          ) : (
            <div className="mt-6 w-full overflow-hidden rounded-md border border-border-subtle bg-surface-quiet">
              <div className="grid h-8 grid-cols-[minmax(320px,1fr)_180px_100px] items-center gap-3 border-b border-border-subtle bg-surface-muted px-3">
                <div className="text-[11px] font-medium leading-4 text-text-tertiary">
                  Member
                </div>

                <div className="text-[11px] font-medium leading-4 text-text-tertiary">
                  Role
                </div>

                <div className="text-right text-[11px] font-medium leading-4 text-text-tertiary">
                  Actions
                </div>
              </div>

              <div>
                {sortedMembers.map((member) => {
                  const isMemberOwner =
                    member.role === 'owner'
                  const isLastOwner =
                    isMemberOwner &&
                    ownerCount <= 1

                  return (
                    <div
                      key={member.id}
                      className="grid min-h-14 grid-cols-[minmax(320px,1fr)_180px_100px] items-center gap-3 border-b border-border-subtle px-3 py-2 transition last:border-b-0 hover:bg-surface-hover"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-muted text-[10px] font-semibold text-text">
                          {member.initials}
                        </div>

                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium leading-[18px] text-text">
                            {member.name}
                          </div>

                          <div className="mt-px truncate text-[11px] leading-4 text-text-tertiary">
                            @{member.username}
                          </div>
                        </div>
                      </div>

                      <div>
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
                            className="h-8 min-w-28 rounded border border-border-control bg-surface-quiet pl-2.5 pr-[30px] text-[13px] text-text outline-none transition focus-visible:ring-2 focus-visible:ring-focus"
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
                          <span className="text-[13px] leading-5 text-text-muted">
                            {roleLabel[member.role]}
                          </span>
                        )}

                        {isLastOwner &&
                          canManageMembers && (
                            <p className="mt-0.5 text-[10px] leading-[14px] text-text-tertiary">
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
                            className="h-7 rounded px-1.5 text-xs font-medium text-danger transition hover:bg-danger-subtle disabled:cursor-not-allowed disabled:text-text-tertiary disabled:hover:bg-transparent"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}


      {activeTab === 'settings' && (
        <div className="mt-7 w-full max-w-[640px]">
          <h2 className="text-[18px] font-semibold leading-6 text-text">
            Project settings
          </h2>

          <p className="mt-1 text-[13px] leading-5 text-text-muted">
            Manage the project identity and lifecycle.
          </p>

          {!canEditProjectSettings && (
            <div className="mt-6 flex items-start gap-2.5 rounded-md border border-border-subtle bg-surface-quiet px-3.5 py-3">
              <span className="material-symbols-outlined mt-0.5 text-[15px] text-text-muted">
                lock
              </span>

              <div>
                <div className="text-[13px] font-medium leading-5 text-text">
                  Read-only settings
                </div>

                <p className="mt-0.5 text-[11px] leading-4 text-text-tertiary">
                  {isArchived
                    ? 'Restore this project before changing its settings.'
                    : 'Only project owners can change project settings.'}
                </p>
              </div>
            </div>
          )}

          <div className="mt-6">
            <label
              htmlFor="settings-project-name"
              className="block text-xs font-medium leading-[18px] text-text-muted"
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
              className="mt-1.5 h-10 w-full rounded border border-border-standalone bg-surface-quiet px-3 text-sm text-text outline-none transition placeholder:text-text-tertiary focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:text-control-disabled-foreground"
            />

            <p className="mt-[5px] text-[11px] leading-4 text-text-tertiary">
              Used throughout the workspace to identify this project.
            </p>
          </div>

          <div className="mt-5">
            <div className="flex items-baseline justify-between">
              <label
                htmlFor="settings-project-description"
                className="text-xs font-medium leading-[18px] text-text-muted"
              >
                Description
              </label>

              <span className="text-[11px] leading-4 text-text-tertiary">
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
              rows={5}
              placeholder="Describe the purpose and context of this project..."
              className="mt-1.5 h-28 w-full resize-y rounded border border-border-standalone bg-surface-quiet px-3 py-2.5 text-sm leading-[22px] text-text outline-none transition placeholder:text-text-tertiary focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:text-control-disabled-foreground"
            />
          </div>

          <fieldset className="mt-7">
            <legend className="text-xs font-medium leading-[18px] text-text-muted">
              Project status
            </legend>

            <p className="mt-[3px] text-[11px] leading-4 text-text-tertiary">
              Control whether the project is actively worked on, temporarily
              paused or finished.
            </p>

            <div className="mt-3 inline-flex items-center rounded-[5px] border border-border-standalone bg-surface-quiet p-0.5">
              {(
                [
                  {
                    value: 'active',
                    label: 'Active',
                    icon: 'play_arrow',
                  },
                  {
                    value: 'paused',
                    label: 'Paused',
                    icon: 'pause',
                  },
                  {
                    value: 'completed',
                    label: 'Completed',
                    icon: 'task_alt',
                  },
                ] as const
              ).map((option) => (
                <label
                  key={option.value}
                  className={[
                    'flex h-8 items-center gap-1.5 rounded-[3px] px-3 text-[13px] font-medium leading-5 outline-none transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus',
                    settingsStatus === option.value
                      ? 'bg-selected-neutral-bg text-text'
                      : canEditProjectSettings
                        ? 'text-text-muted hover:bg-surface-hover hover:text-text'
                        : 'cursor-not-allowed text-text-muted',
                  ].join(' ')}
                >
                  <input
                    type="radio"
                    name="settings-project-status"
                    value={option.value}
                    checked={settingsStatus === option.value}
                    disabled={!canEditProjectSettings}
                    onChange={() =>
                      setSettingsStatus(option.value)
                    }
                    className="sr-only"
                  />

                  <span
                    aria-hidden="true"
                    className="material-symbols-outlined text-[15px]"
                  >
                    {option.icon}
                  </span>

                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>

          {canEditProjectSettings && (
            <div className="mt-8 flex items-center justify-end gap-4">
              <span className="text-[11px] leading-4 text-text-tertiary">
                {settingsSaving
                  ? 'Saving changes…'
                  : settingsDirty
                    ? 'You have unsaved changes.'
                    : 'All changes are saved.'}
              </span>

              <button
                type="button"
                disabled={!settingsDirty || settingsSaving}
                onClick={handleResetProjectSettings}
                className="h-8 rounded px-3 text-[13px] font-medium leading-5 text-text-muted outline-none transition hover:bg-surface-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:text-control-disabled-foreground disabled:hover:bg-transparent"
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
                className={[
                  'h-8 rounded px-3 text-[13px] font-medium leading-5 outline-none transition focus-visible:ring-2 focus-visible:ring-focus',
                  settingsDirty &&
                  settingsValid &&
                  !settingsSaving
                    ? 'bg-accent text-text-inverse hover:bg-accent-hover'
                    : 'cursor-not-allowed bg-action-disabled-bg text-action-disabled-text',
                ].join(' ')}
              >
                Save changes
              </button>
            </div>
          )}

          {settingsError && (
            <div
              role="alert"
              className="mt-3 text-xs font-medium text-danger"
            >
              {settingsError}
            </div>
          )}

          {canManageProjectLifecycle && (
            <>
              <div className="mt-9 border-t border-border-subtle" />

              <div className="mt-7 flex items-start justify-between gap-6">
                <div>
                  <h3 className="text-[13px] font-semibold leading-5 text-text">
                    {isArchived
                      ? 'Restore project'
                      : 'Archive project'}
                  </h3>

                  <p className="mt-[3px] text-[11px] leading-4 text-text-tertiary">
                    {isArchived
                      ? 'Return this project to the current workspace and enable editing again.'
                      : 'Remove this project from the current workspace without losing its work, members or history.'}
                  </p>
                </div>

                <button
                  type="button"
                  disabled={lifecycleSaving}
                  onClick={
                    isArchived
                      ? () =>
                          void handleRestoreProject()
                      : () => {
                          setLifecycleError(null)
                          setLifecycleAction(
                            'archive',
                          )
                        }
                  }
                  className="h-8 shrink-0 rounded border border-border-standalone px-2.5 text-[13px] leading-5 text-text outline-none transition hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:text-control-disabled-foreground disabled:hover:bg-transparent"
                >
                  {isArchived
                    ? 'Restore'
                    : 'Archive'}
                </button>
              </div>

              <div className="mt-7 border-t border-border-subtle" />

              <div className="mt-6 flex items-start justify-between gap-6">
                <div>
                  <h3 className="text-[13px] font-semibold leading-5 text-danger">
                    Delete project
                  </h3>

                  <p className="mt-[3px] text-[11px] leading-4 text-text-muted">
                    Only an empty project can be permanently deleted.
                    Projects containing work must be archived instead.
                  </p>

                  {!workItemsLoading &&
                    projectHasWork && (
                      <p className="mt-1.5 text-[11px] leading-4 text-text-tertiary">
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
                    setLifecycleAction(
                      'delete',
                    )
                  }}
                  className={[
                    'h-8 shrink-0 rounded border px-2.5 text-[13px] leading-5 outline-none transition focus-visible:ring-2 focus-visible:ring-focus',
                    canDeleteProject &&
                    !lifecycleSaving
                      ? 'border-danger/35 text-danger hover:bg-danger-subtle'
                      : 'cursor-not-allowed border-border-subtle text-control-disabled-foreground',
                  ].join(' ')}
                >
                  Delete
                </button>
              </div>

              {lifecycleError && (
                <div
                  role="alert"
                  className="mt-4 rounded-md bg-danger-bg px-3 py-2 text-xs font-medium text-danger"
                >
                  {lifecycleError}
                </div>
              )}
            </>
          )}
        </div>
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

      {workItemDrawerState != null && (
        // Rendering the lazy WorkItemDrawer only while a drawer state
        // actually exists (rather than always rendering it with
        // `open={false}`) is what keeps its chunk — and the whole
        // RichMarkdownEditor/Tiptap graph behind it — from being
        // fetched on initial page load. React.lazy triggers its
        // import() as soon as the component is mounted, regardless of
        // any `open` prop, so the gate has to live here.
        <Suspense
          fallback={
            <WorkItemDrawerFallback
              mode={workItemDrawerState.mode}
            />
          }
        >
          <WorkItemDrawer
            open={true}
            mode={workItemDrawerState.mode}
            projectName={project.name}
            item={selectedDrawerWorkItem}
            readOnly={isReadOnly}
            currentUserId={user ? user.id : null}
            workItemConfiguration={workItemConfig}
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
            onDelete={handleDeleteWorkItem}
            onRequestDelete={requestWorkItemDelete}
          />
        </Suspense>
      )}

      {workItemDeleteTarget !== null && (
        <WorkItemDeleteDialog
          open={true}
          deleting={isDeletingWorkItem}
          error={deleteWorkItemError}
          onCancel={cancelWorkItemDelete}
          onConfirm={() =>
            void confirmWorkItemDelete()
          }
        />
      )}
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
        'grid min-h-10 gap-3 py-2 transition-colors focus-visible:ring-2 focus-visible:ring-focus sm:grid-cols-[minmax(0,1fr)_130px_180px_110px] sm:items-center',
        selected
          ? 'outline outline-1 -outline-offset-1 outline-card-selected-ring bg-card-selected-bg'
          : 'hover:bg-surface-hover',
      ].join(' ')}
    >
      <div className="min-w-0">
        {attentionKind && (
          <div
            className={[
              'mb-1 text-[10px] font-semibold uppercase tracking-[0.1em]',
              attentionKind === 'unassigned'
                ? 'text-text-tertiary'
                : 'text-error',
            ].join(' ')}
          >
            {attentionLabel[attentionKind]}
          </div>
        )}

        <div className="flex min-w-0 items-center gap-2">
          <span
            title={item.typeLabel}
            aria-label={item.typeLabel}
            className="material-symbols-outlined shrink-0 text-[16px] text-text-tertiary"
          >
            {workItemTypeIcon(item.type)}
          </span>

          <span className="truncate text-[13px] font-medium leading-[18px] text-text">
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

        <span className="text-text-muted">
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
            : 'text-text-tertiary',
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
  onRequestDelete,
  selectedWorkItemId,
  onStatusDrop,
  statusDropError,
  onDismissStatusDropError,
  preferencesKey,
  inspectorOpen,
}: {
  items: DemoWorkItem[]
  eligibleAssignees: ProjectMember[]
  readOnly: boolean
  onCreate: () => void
  onOpen: (item: DemoWorkItem) => void
  onRequestDelete: (workItemId: number) => void
  selectedWorkItemId: string | null
  onStatusDrop: (
    workItemId: number,
    newStatus: DemoWorkItemStatus,
    beforeWorkItemId: number | null,
  ) => void
  statusDropError: string | null
  onDismissStatusDropError: () => void
  preferencesKey: string | null
  // True while the non-modal Work Item inspector is open in edit mode.
  // The inspector is a fixed 520px right-edge rail (see WorkItemDrawer);
  // while it is open the panel must reserve that rail so no workspace
  // target (Board column, List row, toolbar control) ever renders
  // underneath the opaque drawer and loses its pointer events.
  inspectorOpen: boolean
}) {
  const [view, setView] = useState<WorkItemsView>('board')
  const [draggedItemId, setDraggedItemId] =
    useState<string | null>(null)
  // Insertion indicator: the status column being hovered plus the index
  // of the card the dragged card would be inserted *before* (items.length
  // means "after the last card"). null indicator = no hover yet.
  const [dragIndicator, setDragIndicator] = useState<{
    status: DemoWorkItemStatus
    index: number
  } | null>(null)
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

  // Stable Board order: manual position first (NULLs last, in creation
  // order), mirroring the server list ordering. This keeps the Board in
  // canonical order even after an optimistic reorder update, and stays
  // stable when filters hide items.
  const orderedItems = useMemo(() => {
    const numericId = (item: DemoWorkItem) => Number(item.id)

    return [...items].sort((left, right) => {
      const leftPosition = left.boardPosition
      const rightPosition = right.boardPosition

      const leftHas = leftPosition != null
      const rightHas = rightPosition != null

      if (leftHas && rightHas) {
        if (leftPosition !== rightPosition) {
          return leftPosition - rightPosition
        }
      } else if (leftHas !== rightHas) {
        // Positioned items render before unpositioned ones.
        return leftHas ? -1 : 1
      }

      // Unpositioned (or equal-position) items fall back to creation
      // order (server id), matching the list endpoint.
      return numericId(left) - numericId(right)
    })
  }, [items])

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()

    return orderedItems.filter((item) => {
      const matchesQuery =
        normalizedQuery.length === 0 ||
        item.title.toLowerCase().includes(normalizedQuery) ||
        item.assignees.some((assignee) =>
          assignee.name.toLowerCase().includes(normalizedQuery),
        ) ||
        item.typeLabel
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
    orderedItems,
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
      <section className="mt-6 rounded-xl border border-border-structural bg-surface-quiet shadow-sm">
        <div className="px-6 py-8">
          <h2 className="text-lg font-semibold tracking-tight text-work-content-text">
            Work Items
          </h2>

          <div className="mt-8 max-w-md">
            <p className="text-sm font-medium text-work-content-text">
              No work items yet.
            </p>

            <p className="mt-1 text-sm leading-6 text-work-content-muted">
              Create the first piece of project work.
            </p>

            {!readOnly && (
              <button
                type="button"
                onClick={onCreate}
                className="mt-5 inline-flex h-9 items-center gap-2 rounded-lg bg-action px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-action-hover-solid"
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
    <section
      className={[
        'mt-6 overflow-hidden rounded-xl border border-border-structural bg-surface-quiet shadow-sm',
        // Below xl the workspace is too narrow to sit beside the
        // 520px rail, so the drawer keeps its existing overlay
        // behavior there; from xl up the panel reserves the rail.
        inspectorOpen ? 'xl:mr-[520px]' : '',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-start justify-between gap-8 border-b border-border-structural bg-work-items-header px-6 py-5">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold tracking-tight text-work-content-text">
              Work Items
            </h2>

            <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-work-surface-support px-2 py-0.5 text-[11px] font-semibold text-work-content-muted">
              {items.length}
            </span>
          </div>

          <p className="mt-1 text-sm text-work-content-muted">
            Plan and track the work that belongs to this project.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {!readOnly && (
            <button
              type="button"
              onClick={onCreate}
              className="inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg bg-action px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-action-hover-solid"
            >
              <span className="material-symbols-outlined text-[18px]">
                add
              </span>
              New work item
            </button>
          )}

          {readOnly && (
            <span className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-work-surface-support px-3 text-xs font-semibold text-work-content-muted">
              <span className="material-symbols-outlined text-[17px]">
                visibility
              </span>
              Read-only
            </span>
          )}

          <div className="inline-flex rounded-lg border border-border-structural bg-segmented-bg p-1">
            <button
              type="button"
              onClick={() => setView('board')}
              // Board/List switching is the one toolbar interaction
              // that intentionally keeps the open Work Item inspector
              // open — see the outside-click boundary effect above.
              data-work-item-inspector-keep-open="true"
              className={[
                'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition',
                view === 'board'
                  ? 'bg-segmented-selected text-segmented-selected-text shadow-sm'
                  : 'text-work-content-muted hover:text-work-content-text',
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
              data-work-item-inspector-keep-open="true"
              className={[
                'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition',
                view === 'list'
                  ? 'bg-segmented-selected text-segmented-selected-text shadow-sm'
                  : 'text-work-content-muted hover:text-work-content-text',
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

      <div className="border-b border-border-structural bg-work-surface-toolbar px-6 py-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <label className="relative block w-56 shrink-0">
            <span className="sr-only">Search work items</span>

            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-work-content-muted">
              search
            </span>

            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search..."
              className="h-9 w-full rounded-lg border border-border-field bg-surface pl-10 pr-3 text-sm text-work-content-text outline-none transition placeholder:text-text-work-placeholder focus:border-focus-ring-primary focus:ring-2 focus:ring-focus-ring-primary/15"
            />
          </label>

          <select
            aria-label="Filter by assignee"
            value={assigneeFilter}
            onChange={(event) =>
              setAssigneeFilter(event.target.value)
            }
            className="h-9 min-w-32 rounded-lg border border-border-field bg-surface px-2.5 text-sm font-medium text-work-content-text outline-none transition focus:border-focus-ring-primary focus:ring-2 focus:ring-focus-ring-primary/15"
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
            className="h-9 min-w-28 rounded-lg border border-border-field bg-surface px-2.5 text-sm font-medium text-work-content-text outline-none transition focus:border-focus-ring-primary focus:ring-2 focus:ring-focus-ring-primary/15"
          >
            {typeFilters.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>

          <label className="flex h-9 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-work-content-muted transition hover:bg-work-surface-hover hover:text-work-content-text">
            <input
              type="checkbox"
              checked={blockedOnly}
              onChange={(event) =>
                setBlockedOnly(event.target.checked)
              }
              className="h-4 w-4 rounded border-border-field accent-control-accent"
            />
            Blocked
          </label>

          <div className="ml-auto flex items-center gap-3">
            <span className="text-xs text-work-content-muted">
              {filteredItems.length}{' '}
              {filteredItems.length === 1 ? 'item' : 'items'}
            </span>

            {hasActiveFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-link-hover transition hover:bg-action-hover-subtle"
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
          className="flex items-start gap-2.5 border-b border-work-item-error-border bg-work-item-error-bg px-6 py-3 text-sm text-work-item-error"
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
            className="shrink-0 text-xs font-semibold text-work-item-error underline-offset-2 hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {filteredItems.length === 0 ? (
        <div className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-work-surface-support text-work-content-muted">
            <span className="material-symbols-outlined text-[22px]">
              search_off
            </span>
          </div>

          <h3 className="mt-4 text-sm font-semibold text-work-content-text">
            No matching work items
          </h3>

          <p className="mt-1 max-w-sm text-sm leading-6 text-work-content-muted">
            No work items match the current search and filters.
          </p>

          <button
            type="button"
            onClick={clearFilters}
            className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg px-3 text-sm font-semibold text-link-hover transition hover:bg-action-hover-subtle"
          >
            <span className="material-symbols-outlined text-[18px]">
              filter_alt_off
            </span>
            Clear filters
          </button>
        </div>
      ) : view === 'board' ? (
        <div className="overflow-x-auto bg-workspace">
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
              dragIndicator?.status === column.status

            const indicatorIndex =
              isDragOver &&
              dragIndicator !== null &&
              dragIndicator.index <= columnItems.length
                ? dragIndicator.index
                : null

            const handleColumnDragOver = (event: React.DragEvent) => {
              if (readOnly || draggedItemId === null) {
                return
              }

              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'

              const y = event.clientY
              let index = columnItems.length

              for (let i = 0; i < columnItems.length; i += 1) {
                const card = document.querySelector(
                  `[data-board-card="${columnItems[i].id}"]`,
                ) as HTMLElement | null

                if (!card) {
                  continue
                }

                const rect = card.getBoundingClientRect()

                if (y < rect.top + rect.height / 2) {
                  index = i
                  break
                }
              }

              setDragIndicator({
                status: column.status,
                index,
              })
            }

            const handleColumnDragLeave = (event: React.DragEvent) => {
              if (
                event.currentTarget.contains(
                  event.relatedTarget as Node | null,
                )
              ) {
                return
              }

              setDragIndicator((current) =>
                current?.status === column.status ? null : current,
              )
            }

            const handleColumnDrop = (event: React.DragEvent) => {
              event.preventDefault()

              const droppedId = event.dataTransfer.getData(
                'text/plain',
              )

              const currentIndicator = dragIndicator
              setDragIndicator(null)
              setDraggedItemId(null)

              if (readOnly || !droppedId) {
                return
              }

              const numericId = Number(droppedId)

              if (!Number.isInteger(numericId)) {
                return
              }

              const beforeItem =
                currentIndicator?.status === column.status
                  ? columnItems[currentIndicator.index]
                  : undefined

              const beforeId = beforeItem
                ? Number(beforeItem.id)
                : null

              onStatusDrop(numericId, column.status, beforeId)
            }

            const renderIndicator = (index: number) =>
              indicatorIndex === index ? (
                <div
                  data-board-insertion-indicator
                  aria-hidden="true"
                  className="h-0.5 shrink-0 rounded-full bg-interaction-primary"
                />
              ) : null

            return (
              <div
                key={column.status}
                data-board-column={column.status}
                onDragOver={handleColumnDragOver}
                onDragLeave={handleColumnDragLeave}
                onDrop={handleColumnDrop}
                className={[
                  'flex min-h-[26rem] min-w-0 flex-col rounded-lg transition-colors',
                  isDragOver
                    ? 'bg-drag-target-bg ring-1 ring-inset ring-drag-target-ring'
                    : 'bg-board-column',
                ].join(' ')}
              >
                <div className="flex items-center gap-1.5 px-3 py-2.5">
                  <span className="text-[13px] font-semibold text-work-content-text">
                    {column.label}
                  </span>

                  <span className="text-xs text-text-work-faded-70">
                    {columnItems.length}
                  </span>
                </div>

                <div className="flex flex-1 flex-col gap-2 px-2 pb-3">
                  {columnItems.length === 0 ? (
                    renderIndicator(0)
                  ) : (
                    columnItems.map((item) => {
                      const itemIndex = columnItems.findIndex(
                        (candidate) => candidate.id === item.id,
                      )

                      return (
                        <div
                          key={item.id}
                          data-board-card={item.id}
                          className="flex flex-col gap-2"
                        >
                          {renderIndicator(itemIndex)}
                          <WorkItemBoardCard
                            item={item}
                            selected={
                              selectedWorkItemId === item.id
                            }
                            dragging={
                              draggedItemId === item.id
                            }
                            readOnly={readOnly}
                            onOpen={onOpen}
                            onRequestDelete={onRequestDelete}
                            onDragHandleStart={(itemId) =>
                              setDraggedItemId(itemId)
                            }
                            onDragHandleEnd={() => {
                              setDraggedItemId(null)
                              setDragIndicator(null)
                            }}
                          />
                        </div>
                      )
                    })
                  )}

                  {columnItems.length > 0 &&
                  indicatorIndex === columnItems.length ? (
                    renderIndicator(columnItems.length)
                  ) : null}
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
          onRequestDelete={onRequestDelete}
          readOnly={readOnly}
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

// Defensive lookup: a type key that is not one of the built-in
// DemoWorkItemType values (e.g. a project-configured type definition whose
// canonical key we cannot resolve) must never crash the icon lookup.
function workItemTypeIcon(
  type: string | null | undefined,
): string {
  if (type && type in workItemTypeIcons) {
    return workItemTypeIcons[type as DemoWorkItemType]
  }
  return 'assignment'
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
    className: 'text-text-muted',
  },
  in_progress: {
    glyph: '◐',
    className: 'text-interaction-primary',
  },
  review: {
    glyph: '●',
    className: 'text-text',
  },
  done: {
    glyph: '✓',
    className: 'text-success-text',
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
  onRequestDelete,
  onDragHandleStart,
  onDragHandleEnd,
}: {
  item: DemoWorkItem
  selected: boolean
  dragging: boolean
  readOnly: boolean
  onOpen: (item: DemoWorkItem) => void
  onRequestDelete: (workItemId: number) => void
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
      data-work-item-id={item.id}
      data-selected={
        selected
          ? 'true'
          : undefined
      }
      className={[
        'relative rounded-lg border bg-surface px-3 py-2.5 transition hover:bg-work-surface-hover',
        needsEmphasis
          ? 'border-work-item-error-border'
          : 'border-border-structural/50',
        selected
          ? 'outline outline-2 -outline-offset-2 outline-card-selected-ring bg-card-selected-bg shadow-sm'
          : '',
        dragging ? 'opacity-40' : '',
        readOnly ? '' : 'cursor-grab active:cursor-grabbing',
      ].join(' ')}
    >
      <div className="flex items-start gap-2">
        <span
          title={item.typeLabel}
          aria-label={item.typeLabel}
          className="material-symbols-outlined mt-0.5 shrink-0 text-[15px] text-work-content-muted"
        >
          {workItemTypeIcon(item.type)}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start gap-2">
            <h3 className="min-w-0 flex-1 text-sm font-semibold leading-5 text-work-content-text">
              {item.title}
            </h3>

            {isBlocked && (
              <span
                title={item.blockedReason ?? undefined}
                className="mt-0.5 shrink-0 text-[11px] font-semibold text-work-item-error"
              >
                · Blocked
              </span>
            )}

            {!readOnly && (
              // The trigger stops propagation (and pointer-down) so it
              // never opens the card drawer and never starts a Board drag.
              <div
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onDragStart={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
                className="shrink-0"
              >
                <WorkItemActionMenuTrigger
                  label="Work item actions"
                  size="sm"
                  onAction={(action) => {
                    if (action === 'delete') {
                      onRequestDelete(Number(item.id))
                    }
                  }}
                />
              </div>
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
                ? 'font-semibold text-work-item-error'
                : 'font-normal text-work-content-muted',
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
      <span className="text-xs font-normal text-work-content-muted">
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
            className="flex h-[22px] w-[22px] items-center justify-center rounded-full border border-surface bg-work-surface-support text-[8px] font-semibold text-work-content-text"
          >
            {assignee.initials}
          </div>
        ))}
      </div>

      <span className="truncate text-xs font-normal text-work-content-muted">
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
  onRequestDelete,
  readOnly,
}: {
  items: DemoWorkItem[]
  selectedWorkItemId: string | null
  onOpen: (item: DemoWorkItem) => void
  onRequestDelete: (workItemId: number) => void
  readOnly: boolean
}) {
  const gridColumns =
    'grid-cols-[minmax(360px,560px)_130px_180px_110px_40px]'

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[900px]">
        <div
          className={[
            'grid h-9 items-center px-6',
            gridColumns,
          ].join(' ')}
        >
          <div className="text-[11px] font-normal text-text-work-faded-75">
            Work item
          </div>

          <div className="text-[11px] font-normal text-text-work-faded-75">
            Status
          </div>

          <div className="text-[11px] font-normal text-text-work-faded-75">
            Assignee
          </div>

          <div className="text-[11px] font-normal text-text-work-faded-75">
            Due
          </div>

          <div aria-hidden="true" />
        </div>

        <div className="border-t border-border-structural/40">
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
                data-work-item-id={item.id}
                className={[
                  'grid h-[54px] items-center px-6 transition-colors hover:bg-work-surface-hover',
                  gridColumns,
                  selectedWorkItemId ===
                  item.id
                    ? 'outline outline-1 -outline-offset-1 outline-card-selected-ring bg-card-selected-bg'
                    : '',
                  index > 0
                    ? 'border-t border-border-structural/25'
                    : '',
                ].join(' ')}
              >
                <div className="flex min-w-0 items-center gap-2 pr-5">
                  <span
                    title={item.typeLabel}
                    aria-label={item.typeLabel}
                    className="material-symbols-outlined shrink-0 text-[15px] text-text-work-faded-80"
                  >
                    {workItemTypeIcon(item.type)}
                  </span>

                  <span className="truncate text-sm font-semibold text-work-content-text">
                    {item.title}
                  </span>

                  {item.blockedReason && (
                    <span
                      title={item.blockedReason}
                      className="shrink-0 text-[11px] font-medium text-work-item-error"
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

                  <span className="text-work-content-muted">
                    {workItemStatusLabels[item.status]}
                  </span>
                </div>

                <WorkItemAssignees assignees={item.assignees} />

                <div
                  className={[
                    'text-xs',
                    due.attention
                      ? 'font-medium text-work-item-error'
                      : 'font-normal text-work-content-muted',
                  ].join(' ')}
                >
                  {due.label}
                </div>

                <div className="flex justify-end pr-2">
                  {!readOnly && (
                    // Isolated from the row click so opening the menu
                    // never opens the Work Item drawer.
                    <div
                      onClick={(event) =>
                        event.stopPropagation()
                      }
                      onPointerDown={(event) =>
                        event.stopPropagation()
                      }
                    >
                      <WorkItemActionMenuTrigger
                        label="Work item actions"
                        size="sm"
                        onAction={(action) => {
                          if (action === 'delete') {
                            onRequestDelete(
                              Number(item.id),
                            )
                          }
                        }}
                      />
                    </div>
                  )}
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
      <div className="h-4 w-20 animate-pulse rounded bg-surface-hover" />

      <div className="mt-7 flex items-start justify-between">
        <div>
          <div className="h-3 w-28 animate-pulse rounded bg-surface-hover" />
          <div className="mt-3 h-9 w-96 animate-pulse rounded bg-surface-hover" />
        </div>

        <div className="flex items-center gap-4">
          <div className="flex -space-x-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <div
                key={index}
                className="h-9 w-9 animate-pulse rounded-full border-2 border-canvas bg-surface-hover"
              />
            ))}
          </div>

          <div className="h-6 w-px bg-border-structural" />

          <div className="h-7 w-20 animate-pulse rounded-full bg-surface-hover" />
        </div>
      </div>

      <div className="mt-9 flex gap-7 border-b border-border-structural pb-3">
        <div className="h-4 w-16 animate-pulse rounded bg-surface-hover" />
        <div className="h-4 w-20 animate-pulse rounded bg-surface-hover" />
        <div className="h-4 w-16 animate-pulse rounded bg-surface-hover" />
        <div className="h-4 w-16 animate-pulse rounded bg-surface-hover" />
      </div>

      <div className="mt-6 grid grid-cols-12 gap-6">
        <div className="col-span-8 overflow-hidden rounded-xl border border-border-structural bg-surface-quiet">
          <div className="border-b border-border-structural px-6 py-4">
            <div className="h-4 w-32 animate-pulse rounded bg-surface-hover" />
            <div className="mt-2 h-3 w-44 animate-pulse rounded bg-surface-hover" />
          </div>

          <div className="px-6 py-6">
            <div className="h-3 w-20 animate-pulse rounded bg-surface-hover" />
            <div className="mt-4 h-3 w-full max-w-2xl animate-pulse rounded bg-surface-hover" />
            <div className="mt-2 h-3 w-4/5 max-w-xl animate-pulse rounded bg-surface-hover" />
          </div>
        </div>

        <div className="col-span-4 overflow-hidden rounded-xl border border-border-structural bg-surface-quiet">
          <div className="border-b border-border-structural px-5 py-4">
            <div className="h-4 w-28 animate-pulse rounded bg-surface-hover" />
            <div className="mt-2 h-3 w-36 animate-pulse rounded bg-surface-hover" />
          </div>

          <div className="space-y-4 px-5 py-5">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="flex gap-3">
                <div className="h-8 w-8 animate-pulse rounded-full bg-surface-hover" />
                <div className="flex-1">
                  <div className="h-3 w-36 animate-pulse rounded bg-surface-hover" />
                  <div className="mt-2 h-3 w-24 animate-pulse rounded bg-surface-hover" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-xl border border-border-structural bg-surface-quiet">
        <div className="border-b border-border-structural px-6 py-4">
          <div className="h-4 w-24 animate-pulse rounded bg-surface-hover" />
          <div className="mt-2 h-3 w-72 animate-pulse rounded bg-surface-hover" />
        </div>

        <div className="border-b border-border-structural px-6 py-3">
          <div className="h-9 w-52 animate-pulse rounded-lg bg-surface-hover" />
        </div>

        {Array.from({ length: 3 }).map((_, index) => (
          <div
            key={index}
            className="grid grid-cols-[minmax(0,1fr)_130px_150px_110px] items-center gap-3 border-b border-border-structural px-6 py-4 last:border-b-0"
          >
            <div className="h-4 w-3/4 animate-pulse rounded bg-surface-hover" />
            <div className="h-4 w-16 animate-pulse rounded bg-surface-hover" />
            <div className="h-4 w-20 animate-pulse rounded bg-surface-hover" />
            <div className="h-4 w-16 animate-pulse rounded bg-surface-hover" />
          </div>
        ))}
      </div>
    </div>
  )
}
