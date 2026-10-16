import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

import { ApiError } from '../../api/client'
import {
  getProjectWorkItemConfiguration,
  listProjectMemberships,
  listProjects,
} from '../../api/projects'
import type {
  ApiProject,
  ApiProjectMembership,
  ApiProjectWorkItemConfiguration,
  ApiWorkItem,
} from '../../api/types'
import { useSession } from '../../api/useSession'
import { createWorkItem, listProjectWorkItems } from '../../api/work-items'
import type { WorkItemFormInput } from '../../features/projects/WorkItemDrawer'
import {
  buildCreateWorkItemInput,
} from '../../features/projects/workItemMapping'
import { useResearchGroup } from '../../features/research-group/useResearchGroup'
import { notifyWorkItemCreated } from './workItemInvalidation'
import { SidebarIcon } from './Sidebar'

const WorkItemDrawer = lazy(() =>
  import('../../features/projects/WorkItemDrawer').then((module) => ({
    default: module.WorkItemDrawer,
  })),
)

type EligibleProject = ApiProject & { researchGroupName: string }

type DrawerContext = {
  projectId: number
  configuration: ApiProjectWorkItemConfiguration
  assignees: Array<{ id: string; name: string; initials: string }>
  parentItems: Array<{ id: string; title: string }>
}

type ProjectLoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | {
      status: 'ready'
      researchGroupId: number
      projects: EligibleProject[]
    }
  | { status: 'error'; message: string }

const MENU_ITEM_CLASSES =
  'fg-type-nav-primary font-medium flex h-8 w-full items-center gap-2 rounded bg-transparent px-2 text-left text-text-muted transition hover:bg-surface-muted hover:text-text focus-visible:bg-surface-muted focus-visible:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus'

function getErrorMessage(error: unknown, fallback: string) {
  if (
    error instanceof ApiError &&
    error.detail &&
    typeof error.detail === 'object' &&
    'error' in error.detail
  ) {
    const detail = error.detail as { error?: unknown }
    if (typeof detail.error === 'string') return detail.error
  }

  return error instanceof Error && error.message ? error.message : fallback
}

function personName(membership: ApiProjectMembership) {
  const { firstName, lastName, username } = membership.user
  return `${firstName} ${lastName}`.trim() || username
}

function personInitials(membership: ApiProjectMembership) {
  const { firstName, lastName, username } = membership.user
  const initials = `${firstName[0] ?? ''}${lastName[0] ?? ''}`
    .trim()
    .toUpperCase()
  return initials || username.slice(0, 2).toUpperCase()
}

function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    target.closest(
      'input, textarea, select, [contenteditable="true"], [role="textbox"]',
    ) !== null
  )
}

function hasConflictingModal() {
  return document.querySelector('[aria-modal="true"]') !== null
}

function isMacPlatform() {
  return /Mac|iPhone|iPad|iPod/i.test(
    navigator.platform || navigator.userAgent,
  )
}

function isQuickCreateKey(event: KeyboardEvent) {
  // Physical key first: macOS Option-key transformations report
  // `key: '˜'` (US layout) for Option+K, while `code` stays `KeyK`.
  // The key-character check is the compatibility fallback for
  // environments without `event.code`.
  return event.code === 'KeyK' || event.key.toLowerCase() === 'k'
}

function isQuickCreateShortcut(event: KeyboardEvent) {
  if (!isQuickCreateKey(event) || !event.altKey) return false
  return isMacPlatform()
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey
}

export function QuickCreate({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { user } = useSession()
  const {
    groups,
    loading: groupsLoading,
    error: groupsError,
    reloadResearchGroups,
  } = useResearchGroup()

  const containerRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const actionRef = useRef<HTMLButtonElement | null>(null)
  const projectRequestSeq = useRef(0)
  const contextRequestSeq = useRef(0)
  const selectedResearchGroupIdRef = useRef<number | null>(null)
  // Availability transition tracker for the selected Research
  // Group: distinguishes "group disappeared and came back"
  // (requires re-loading its Projects) from a harmless list
  // refresh without any availability change (must NOT re-request).
  const selectedGroupWasUnavailableRef = useRef(false)
  const selectedProjectIdRef = useRef<number | null>(null)

  const [projectState, setProjectState] =
    useState<ProjectLoadState>({ status: 'idle' })
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [selectedResearchGroupId, setSelectedResearchGroupId] =
    useState<number | null>(null)
  const [selectedResearchGroupName, setSelectedResearchGroupName] =
    useState<string | null>(null)
  const [selectedProjectId, setSelectedProjectId] =
    useState<number | null>(null)
  const [contextLoadingProjectId, setContextLoadingProjectId] =
    useState<number | null>(null)
  const [contextError, setContextError] = useState<string | null>(null)
  const [drawerContext, setDrawerContext] =
    useState<DrawerContext | null>(null)
  const [confirmation, setConfirmation] = useState<string | null>(null)

  // Loads only the eligible Projects of ONE explicitly selected
  // Research Group (never the whole membership). Sequence +
  // current-Research-Group guards make a delayed response from an
  // earlier selection a strict no-op.
  const loadProjectsForGroup = useCallback(
    async (researchGroupId: number) => {
      const group = groups.find(
        (candidate) => candidate.id === researchGroupId,
      )
      if (!group) return

      const seq = ++projectRequestSeq.current
      setProjectState({ status: 'loading' })

      try {
        const projects = await listProjects(group.id)
        if (
          seq !== projectRequestSeq.current ||
          selectedResearchGroupIdRef.current !== group.id
        ) {
          return
        }

        setProjectState({
          status: 'ready',
          researchGroupId: group.id,
          projects: projects
            .filter(
              (project) =>
                project.archivedAt === null &&
                (project.currentUserRole === 'owner' ||
                  project.currentUserRole === 'member'),
            )
            .map((project) => ({
              ...project,
              researchGroupName: group.name,
            })),
        })
      } catch (error) {
        if (
          seq !== projectRequestSeq.current ||
          selectedResearchGroupIdRef.current !== group.id
        ) {
          return
        }
        setProjectState({
          status: 'error',
          message: getErrorMessage(error, 'Projects could not be loaded.'),
        })
      }
    },
    [groups],
  )

  const readyProjects = useMemo(
    () =>
      projectState.status === 'ready'
        ? projectState.projects
        : [],
    [projectState],
  )
  const selectedProject =
    readyProjects.find((project) => project.id === selectedProjectId) ?? null

  const loadProjectContext = useCallback(
    async (project: EligibleProject) => {
      const seq = ++contextRequestSeq.current
      setContextLoadingProjectId(project.id)
      setContextError(null)
      setDrawerContext(null)

      try {
        const [configuration, memberships, workItems] = await Promise.all([
          getProjectWorkItemConfiguration(project.id),
          listProjectMemberships(project.id),
          listProjectWorkItems(project.id),
        ])
        if (
          seq !== contextRequestSeq.current ||
          selectedProjectIdRef.current !== project.id
        ) {
          return
        }

        setDrawerContext({
          projectId: project.id,
          configuration,
          assignees: memberships
            .filter((membership) => membership.role !== 'viewer')
            .map((membership) => ({
              id: String(membership.user.id),
              name: personName(membership),
              initials: personInitials(membership),
            })),
          parentItems: workItems.map((item: ApiWorkItem) => ({
            id: String(item.id),
            title: item.title,
          })),
        })
        setContextLoadingProjectId(null)
      } catch (error) {
        if (seq !== contextRequestSeq.current) return
        setContextLoadingProjectId(null)
        setContextError(
          getErrorMessage(
            error,
            'The Work Item form could not be loaded.',
          ),
        )
        if (selectedResearchGroupIdRef.current !== null) {
          void loadProjectsForGroup(selectedResearchGroupIdRef.current)
        }
      }
    },
    [loadProjectsForGroup],
  )

  const selectProject = useCallback(
    (projectId: number) => {
      const project = readyProjects.find(
        (candidate) => candidate.id === projectId,
      )
      if (!project) return

      selectedProjectIdRef.current = project.id
      setSelectedProjectId(project.id)
      void loadProjectContext(project)
    },
    [loadProjectContext, readyProjects],
  )

  const selectResearchGroup = useCallback(
    (researchGroupId: number) => {
      const group = groups.find(
        (candidate) => candidate.id === researchGroupId,
      )
      if (!group) return

      // A fresh selection is by definition available; clear any
      // stale unavailability flag left over from a previous
      // selection.
      selectedGroupWasUnavailableRef.current = false

      // The previous Research Group context is explicitly
      // invalidated: no in-flight Project listing or Work Item
      // context response from it may apply, and the previous
      // Project selection is discarded — never carried over into
      // another Research Group.
      ++projectRequestSeq.current
      ++contextRequestSeq.current
      selectedProjectIdRef.current = null
      setSelectedProjectId(null)
      setDrawerContext(null)
      setContextLoadingProjectId(null)
      setContextError(null)

      selectedResearchGroupIdRef.current = group.id
      setSelectedResearchGroupId(group.id)
      setSelectedResearchGroupName(group.name)
      void loadProjectsForGroup(group.id)
    },
    [groups, loadProjectsForGroup],
  )

  const openWorkItemDrawer = useCallback(() => {
    // Global creation always starts WITHOUT an implicitly
    // selected Research Group or Project — regardless of the
    // current route.
    ++projectRequestSeq.current
    ++contextRequestSeq.current
    selectedResearchGroupIdRef.current = null
    selectedGroupWasUnavailableRef.current = false
    selectedProjectIdRef.current = null
    setSelectedResearchGroupId(null)
    setSelectedResearchGroupName(null)
    setSelectedProjectId(null)
    setDrawerContext(null)
    setContextError(null)
    setContextLoadingProjectId(null)
    setProjectState({ status: 'idle' })
    setDrawerOpen(true)
    onOpenChange(false)
  }, [onOpenChange])

  useEffect(() => {
    void import('../../features/projects/WorkItemDrawer')
  }, [])

  useEffect(() => {
    if (!open) return
    requestAnimationFrame(() => actionRef.current?.focus())
  }, [open])

  // A selected Project must remain eligible in the loaded listing
  // of its Research Group; if it no longer is (access changed),
  // the Project-specific context is dropped.
  useEffect(() => {
    if (!drawerOpen || projectState.status !== 'ready') return

    if (
      selectedProjectIdRef.current !== null &&
      !projectState.projects.some(
        (project) => project.id === selectedProjectIdRef.current,
      )
    ) {
      ++contextRequestSeq.current
      selectedProjectIdRef.current = null
      setSelectedProjectId(null)
      setDrawerContext(null)
      setContextLoadingProjectId(null)
      setContextError(null)
    }
  }, [drawerOpen, projectState])

  // The selected Research Group is part of the authenticated
  // membership. If it stops being, keep the (stale) selection
  // visible — never substitute another group — but invalidate the
  // Project-specific context so creation is impossible. If it
  // becomes accessible again after being unavailable, reload ONLY
  // that group's eligible Projects — the Project stays unselected
  // and must be chosen explicitly. A list refresh without an
  // availability transition is a strict no-op (no repeated
  // Project requests).
  useEffect(() => {
    const selectedId = selectedResearchGroupIdRef.current

    if (selectedId === null) {
      selectedGroupWasUnavailableRef.current = false
      return
    }

    const available = groups.some(
      (group) => group.id === selectedId,
    )

    if (available) {
      if (selectedGroupWasUnavailableRef.current) {
        selectedGroupWasUnavailableRef.current = false
        void loadProjectsForGroup(selectedId)
      }
      return
    }

    if (selectedGroupWasUnavailableRef.current) return

    selectedGroupWasUnavailableRef.current = true
    ++projectRequestSeq.current
    ++contextRequestSeq.current
    selectedProjectIdRef.current = null
    setSelectedProjectId(null)
    setDrawerContext(null)
    setContextLoadingProjectId(null)
    setContextError(null)
    setProjectState({ status: 'idle' })
  }, [groups, loadProjectsForGroup])

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        isEditableTarget(event.target) ||
        hasConflictingModal() ||
        !isQuickCreateShortcut(event)
      ) {
        return
      }

      // The global shortcut opens the canonical Work Item drawer
      // directly — no intermediate Quick Create menu.
      event.preventDefault()
      openWorkItemDrawer()
    }

    document.addEventListener('keydown', handleShortcut)
    return () => document.removeEventListener('keydown', handleShortcut)
  }, [openWorkItemDrawer])

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: MouseEvent) => {
      if (
        event.target instanceof Node &&
        !containerRef.current?.contains(event.target)
      ) {
        onOpenChange(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing) return

      if (event.key === 'Escape') {
        event.preventDefault()
        onOpenChange(false)
        requestAnimationFrame(() => triggerRef.current?.focus())
      } else if (
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'w'
      ) {
        event.preventDefault()
        openWorkItemDrawer()
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onOpenChange, open, openWorkItemDrawer])

  useEffect(() => {
    if (!confirmation) return
    const timeout = window.setTimeout(() => setConfirmation(null), 4500)
    return () => window.clearTimeout(timeout)
  }, [confirmation])

  const shortcutLabel = useMemo(
    () => (isMacPlatform() ? '⌘⌥K' : 'Ctrl+Alt+K'),
    [],
  )
  const contextReady =
    selectedProject !== null &&
    drawerContext?.projectId === selectedProject.id

  const handleCreate = async (input: WorkItemFormInput) => {
    if (!selectedProject || !contextReady) {
      throw new Error('Select a Project before creating a Work Item.')
    }

    try {
      const created = await createWorkItem(
        selectedProject.id,
        buildCreateWorkItemInput(input),
      )
      notifyWorkItemCreated(created)
      setConfirmation(`Work item created in ${selectedProject.name}.`)
    } catch (error) {
      throw new Error(
        getErrorMessage(error, 'Work item could not be created.'),
      )
    }
  }

  const closeDrawer = () => {
    ++projectRequestSeq.current
    ++contextRequestSeq.current
    selectedResearchGroupIdRef.current = null
    selectedGroupWasUnavailableRef.current = false
    selectedProjectIdRef.current = null
    setDrawerOpen(false)
    setSelectedResearchGroupId(null)
    setSelectedResearchGroupName(null)
    setSelectedProjectId(null)
    setDrawerContext(null)
    setContextLoadingProjectId(null)
    setContextError(null)
    setProjectState({ status: 'idle' })
  }

  return (
    <>
      <div ref={containerRef} className="relative">
        <button
          ref={triggerRef}
          type="button"
          aria-label="Quick create"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
          className={[
            'flex h-8 w-8 items-center justify-center rounded border border-transparent bg-transparent text-text-muted transition',
            'hover:bg-surface hover:text-text',
            open ? 'bg-surface-hover text-text' : '',
            'focus-visible:outline-2 focus-visible:outline focus-visible:outline-focus focus-visible:outline-offset-1',
          ].join(' ')}
        >
          <span
            aria-hidden="true"
            className="material-symbols-outlined text-[18px]"
          >
            add
          </span>
        </button>

        {open && (
          <div
            role="menu"
            aria-label="Quick create"
            className="absolute right-0 top-[calc(100%+6px)] z-50 w-max overflow-hidden rounded-md border border-border-subtle bg-surface p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.32)]"
          >
            <button
              ref={actionRef}
              type="button"
              role="menuitem"
              onClick={openWorkItemDrawer}
              className={MENU_ITEM_CLASSES}
            >
              <SidebarIcon name="my-work" className="h-3.5 w-3.5" />
              <span className="flex-1 whitespace-nowrap">
                New work item
              </span>
              <kbd className="fg-type-micro shrink-0 text-text-tertiary">
                {shortcutLabel}
              </kbd>
            </button>
          </div>
        )}
      </div>

      {drawerOpen && (
        <Suspense fallback={null}>
          <WorkItemDrawer
            open={true}
            mode="create"
            projectName={selectedProject?.name ?? ''}
            item={null}
            readOnly={false}
            currentUserId={user?.id ?? null}
            workItemConfiguration={
              contextReady ? drawerContext.configuration : null
            }
            assignees={contextReady ? drawerContext.assignees : []}
            parentItems={contextReady ? drawerContext.parentItems : []}
            projectPicker={{
              researchGroups: groups.map((group) => ({
                id: group.id,
                name: group.name,
              })),
              selectedResearchGroupId,
              selectedResearchGroupName,
              researchGroupsLoading: groupsLoading,
              researchGroupsError: groupsError,
              onResearchGroupSelect: selectResearchGroup,
              onResearchGroupsRetry: () => {
                void reloadResearchGroups()
              },
              projects: readyProjects.map((project) => ({
                id: project.id,
                name: project.name,
                researchGroupId: project.researchGroupId,
                researchGroupName: project.researchGroupName,
              })),
              selectedProjectId,
              loading: projectState.status === 'loading',
              error:
                projectState.status === 'error'
                  ? projectState.message
                  : contextError,
              onSelect: selectProject,
              onRetry: () => {
                if (contextError && selectedProject) {
                  void loadProjectContext(selectedProject)
                } else {
                  if (selectedResearchGroupId !== null) {
                    void loadProjectsForGroup(selectedResearchGroupId)
                  }
                }
              },
            }}
            createReady={contextReady && contextLoadingProjectId === null}
            onClose={closeDrawer}
            onCreate={handleCreate}
            onPatch={async () => {}}
          />
        </Suspense>
      )}

      {confirmation &&
        createPortal(
          <div
            role="status"
            className="fixed bottom-6 right-6 z-[60] max-w-sm rounded-lg border border-border-subtle bg-surface px-4 py-3 text-[13px] font-medium leading-[18px] text-text shadow-xl shadow-color"
          >
            {confirmation}
          </div>,
          document.body,
        )}
    </>
  )
}
