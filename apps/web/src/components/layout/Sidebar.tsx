import { useEffect, useMemo, useRef, useState } from 'react'
import {
  NavLink,
  useLocation,
  useNavigate,
} from 'react-router'

import {
  fetchWorkspaceNavigationPreferences,
  updateWorkspaceNavigationPreferences,
} from '../../api/workspace-navigation-preferences'
import type {
  ApiResearchGroup,
  ApiWorkspaceNavigationPreferences,
} from '../../api/types'
import {
  CreateResearchGroupDialog,
} from '../../features/research-group/CreateResearchGroupDialog'
import { useResearchGroup } from '../../features/research-group/useResearchGroup'

const personalNavigation = [
  {
    label: 'Home',
    path: '/',
    icon: 'home',
  },
  {
    label: 'My Work',
    path: '/my-work',
    icon: 'assignment',
  },
  {
    label: 'Notes',
    path: '/notes',
    icon: 'sticky_note_2',
  },
]

/*
 * Group-scoped list paths the existing routing model keeps when a
 * Research Group is selected: switching groups on one of these list
 * pages stays on the same list under the newly selected group (the
 * same contextual navigation the former Research Group selector
 * applied).
 */
const GROUP_LIST_PATHS = new Set([
  '/projects',
  '/goals',
  '/meetings',
  '/kvp',
  '/knowledge',
  '/data',
  '/calendar',
  '/people',
])

// Debounce window for persisting a changed workspace-navigation
// snapshot (the repository's established 300 ms user-preference
// debounce). Rapid chevron toggles coalesce into a single PATCH
// carrying the LATEST complete snapshot.
const WORKSPACE_NAV_DEBOUNCE_MS = 300

// Structural equality for two complete workspace-navigation
// snapshots — the dirty check that decides whether a debounced save
// is owed. Element-wise comparison is exact: the server returns the
// ID lists unchanged and the client never reorders them.
function sameWorkspaceNavPreferences(
  a: ApiWorkspaceNavigationPreferences,
  b: ApiWorkspaceNavigationPreferences,
): boolean {
  const sameIdList = (x: number[], y: number[]) =>
    x.length === y.length &&
    x.every((id, index) => id === y[index])

  return (
    sameIdList(a.researchGroupOrder, b.researchGroupOrder) &&
    sameIdList(a.expandedResearchGroups, b.expandedResearchGroups) &&
    sameIdList(a.expandedProjectSections, b.expandedProjectSections)
  )
}

/*
 * Bottom workspace zone. Personal account destinations (Settings,
 * Profile) live exclusively in the topbar user menu, not here.
 */
const secondaryNavigation = [
  {
    label: 'Notifications',
    path: '/notifications',
    icon: 'notifications',
  },
]

function navClasses(isActive: boolean) {
  return [
    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-subtle',
    isActive
      ? 'bg-surface-muted font-semibold text-text'
      : 'text-text-muted hover:bg-surface-muted hover:text-text',
  ].join(' ')
}

function childNavClasses(isActive: boolean) {
  return [
    'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
    isActive
      ? 'bg-surface-muted font-semibold text-text'
      : 'text-text-muted hover:bg-surface-hover hover:text-text',
  ].join(' ')
}

/*
 * Compact per-group overflow menu. This slice introduces it with the
 * one destination that already exists as a route (the Research Group
 * settings page, admin-only — the same entry the former selector
 * dropdown offered). The "Members" destination of the planned menu
 * contract does not exist as an existing route (group members are a
 * non-deep-linkable tab inside the settings page) and is deliberately
 * not invented here.
 */
function GroupOverflowMenu({ group }: { group: ApiResearchGroup }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const containerRef =
    useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    const handlePointerDown = (
      event: MouseEvent,
    ) => {
      const target = event.target

      if (
        target instanceof Node &&
        !containerRef.current?.contains(target)
      ) {
        setOpen(false)
      }
    }

    const handleKeyDown = (
      event: KeyboardEvent,
    ) => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div
      ref={containerRef}
      className="relative shrink-0"
    >
      <button
        type="button"
        onClick={() =>
          setOpen((current) => !current)
        }
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More options for ${group.name}`}
        className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <span
          aria-hidden="true"
          className="material-symbols-outlined text-[18px]"
        >
          more_vert
        </span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label={`${group.name} options`}
          className="absolute right-0 top-[calc(100%+4px)] z-50 w-40 overflow-hidden rounded-xl border border-border-subtle bg-surface p-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              navigate(`/groups/${group.id}/settings`)
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-text transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <span
              aria-hidden="true"
              className="material-symbols-outlined text-[18px] text-text-muted"
            >
              settings
            </span>

            Settings
          </button>
        </div>
      )}
    </div>
  )
}

export function Sidebar() {
  const {
    groups,
    activeResearchGroupId,
    loading,
    error,
    setActiveResearchGroupId,
    addResearchGroup,
  } = useResearchGroup()

  const location = useLocation()
  const navigate = useNavigate()

  /*
   * Workspace navigation preferences (server-backed personal view
   * state; the same hydration + debounced complete-snapshot save
   * pattern as the My Work preferences). `navPreferences` is the
   * latest local complete snapshot — `null` until the initial GET
   * resolves (or after a failed load), when the tree falls back to
   * the provider group order with nothing expanded. `savedNavPreferences`
   * is the last snapshot known to be persisted server-side (always
   * the normalized server snapshot); `null` means no baseline, and
   * without a baseline no save is ever scheduled — a failed initial
   * load must never overwrite the user's stored preferences.
   */
  const [
    navPreferences,
    setNavPreferences,
  ] = useState<
    ApiWorkspaceNavigationPreferences | null
  >(null)
  const [
    savedNavPreferences,
    setSavedNavPreferences,
  ] = useState<
    ApiWorkspaceNavigationPreferences | null
  >(null)
  const [navPreferencesLoadState, setNavPreferencesLoadState] =
    useState<'pending' | 'loaded' | 'failed'>('pending')
  const [createDialogOpen, setCreateDialogOpen] =
    useState(false)
  const navPreferencesSaveSeqRef = useRef(0)

  useEffect(() => {
    let cancelled = false

    fetchWorkspaceNavigationPreferences()
      .then((snapshot) => {
        if (cancelled) {
          return
        }

        setNavPreferences(snapshot)
        setSavedNavPreferences(snapshot)
        setNavPreferencesLoadState('loaded')
      })
      .catch(() => {
        if (cancelled) {
          return
        }

        setNavPreferences(null)
        setSavedNavPreferences(null)
        setNavPreferencesLoadState('failed')
      })

    return () => {
      cancelled = true
    }
  }, [])

  /*
   * Keep the Research Group area mounted while groups load (the
   * zone renders its own spinner), for users with at least one
   * group, and once loading resolved successfully with zero groups
   * (the zone then renders the first-group creation entry). A failed
   * group load must not present a false zero-group state.
   */
  const showResearchGroupSection =
    loading ||
    groups.length > 0 ||
    (!loading && !error)

  /*
   * The rendered group order: the persisted preference order for
   * known groups, with accessible groups missing from it appended in
   * provider order (the server applies the same append rule on every
   * read — a group just created client-side is the only group that
   * can be missing). Without a resolved preference snapshot the
   * provider order stands in as the failure fallback.
   */
  const orderedGroups = useMemo(() => {
    const byId = new Map(
      groups.map((group) => [group.id, group]),
    )
    const ordered: ApiResearchGroup[] = []
    const seen = new Set<number>()

    if (navPreferences) {
      for (const id of navPreferences.researchGroupOrder) {
        const group = byId.get(id)

        if (group && !seen.has(id)) {
          ordered.push(group)
          seen.add(id)
        }
      }
    }

    for (const group of groups) {
      if (!seen.has(group.id)) {
        ordered.push(group)
      }
    }

    return ordered
  }, [groups, navPreferences])

  /*
   * The Research Group the current route points inside of (an
   * explicit ?group= scope or the group settings page). The
   * contextual reveal it drives keeps the user's current location
   * understandable without ever mutating the persisted manual
   * expansion state.
   */
  const contextGroupId = useMemo(() => {
    const accessible = new Set(
      groups.map((group) => group.id),
    )

    const param = new URLSearchParams(
      location.search,
    ).get('group')

    if (param != null) {
      const id = Number(param)

      if (
        Number.isInteger(id) &&
        id > 0 &&
        accessible.has(id)
      ) {
        return id
      }
    }

    const match =
      /^\/groups\/(\d+)\/settings$/.exec(
        location.pathname,
      )

    if (match) {
      const id = Number(match[1])

      if (accessible.has(id)) {
        return id
      }
    }

    return null
  }, [groups, location])

  /*
   * Debounced persistence of the preference snapshot. Fires only
   * when the local snapshot differs from the last known-persisted
   * one (so the initial load is never "saved back"), coalescing
   * rapid toggles into a single PATCH carrying the LATEST complete
   * snapshot. The monotonic sequence guard keeps a superseded
   * in-flight save from clobbering a newer local selection.
   */
  useEffect(() => {
    if (
      navPreferences == null ||
      savedNavPreferences == null
    ) {
      return
    }

    if (
      sameWorkspaceNavPreferences(
        savedNavPreferences,
        navPreferences,
      )
    ) {
      return
    }

    const seq = ++navPreferencesSaveSeqRef.current
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const normalized =
            await updateWorkspaceNavigationPreferences(
              navPreferences,
            )

          // The returned normalized snapshot is authoritative for
          // what is now persisted — the baseline either way.
          setSavedNavPreferences(normalized)

          if (seq !== navPreferencesSaveSeqRef.current) {
            // A newer local change superseded this save: the UI
            // keeps the newer selection.
            return
          }

          setNavPreferences(normalized)
        } catch {
          if (seq !== navPreferencesSaveSeqRef.current) {
            return
          }

          // Keep the local selection; the Sidebar has no
          // non-disruptive error surface for preference saves.
        }
      })()
    }, WORKSPACE_NAV_DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [navPreferences, savedNavPreferences])

  // Chevron activation: toggles ONLY this group's manual expanded
  // state (persisted via the effect above). It never navigates and
  // is a sibling control of the label, so it cannot trigger the
  // group selection.
  const toggleGroupExpansion = (groupId: number) => {
    setNavPreferences((current) => {
      const base =
        current ??
        ({
          researchGroupOrder: orderedGroups.map(
            (group) => group.id,
          ),
          expandedResearchGroups: [],
          expandedProjectSections: [],
        } satisfies ApiWorkspaceNavigationPreferences)

      const expanded =
        base.expandedResearchGroups.includes(groupId)
          ? base.expandedResearchGroups.filter(
              (id) => id !== groupId,
            )
          : [
              ...base.expandedResearchGroups,
              groupId,
            ]

      return {
        ...base,
        expandedResearchGroups: expanded,
      }
    })
  }

  /*
   * The existing canonical Research Group selection/navigation
   * behavior (carried over from the former selector): selecting a
   * group makes it active and, depending on the current route,
   * follows the contextual routing model. There is no Research
   * Group landing page, so personal pages select in place.
   */
  const navigateOnGroupSelect = (
    group: ApiResearchGroup,
  ) => {
    if (
      /^\/groups\/\d+\/settings$/.test(
        location.pathname,
      )
    ) {
      navigate(
        group.role === 'admin'
          ? `/groups/${group.id}/settings`
          : `/projects?group=${group.id}`,
      )
      return
    }

    if (GROUP_LIST_PATHS.has(location.pathname)) {
      navigate(`${location.pathname}?group=${group.id}`)
      return
    }

    /*
     * Entity detail pages belong to their entity's Research Group.
     * Switching the group therefore exits the old entity and opens
     * the equivalent list in the newly selected group.
     */
    if (location.pathname.startsWith('/projects/')) {
      navigate(`/projects?group=${group.id}`)
      return
    }

    if (location.pathname.startsWith('/meetings/')) {
      navigate(`/meetings?group=${group.id}`)
    }
  }

  const handleGroupSelect = (group: ApiResearchGroup) => {
    setActiveResearchGroupId(group.id)
    navigateOnGroupSelect(group)
  }

  const handleCreatedResearchGroup = (
    group: ApiResearchGroup,
  ) => {
    /*
     * The exact server-serialized group enters the canonical state
     * and becomes the active Research Group. No membership is
     * synthesized client-side.
     */
    addResearchGroup(group)
    setCreateDialogOpen(false)
    navigateOnGroupSelect(group)
  }

  const treeLoading =
    loading || navPreferencesLoadState === 'pending'

  return (
    <aside className="fixed inset-y-0 left-0 z-30 flex w-[240px] flex-col border-r border-border-subtle bg-surface-subtle px-4 pb-4 pt-8">
      <div className="mb-8 flex items-center gap-3 px-2">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent font-bold text-text-inverse">
          FG
        </div>

        <div>
          <div className="font-semibold text-text">
            FG Workspace
          </div>

          <div className="text-xs text-text-muted">
            Research OS
          </div>
        </div>
      </div>

      <nav className="flex flex-col gap-1">
        {personalNavigation.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === '/'}
            className={({ isActive }) =>
              navClasses(isActive)
            }
          >
            <span className="material-symbols-outlined text-[20px]">
              {item.icon}
            </span>

            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      {showResearchGroupSection && (
        <div className="mt-5 border-t border-border-subtle pt-5">
          {treeLoading ? (
            <div className="flex h-11 items-center gap-2 px-2 text-sm text-text-muted">
              <span className="material-symbols-outlined animate-spin text-[18px]">
                refresh
              </span>

              Loading…
            </div>
          ) : groups.length === 0 ? (
            <>
              <button
                type="button"
                onClick={() => setCreateDialogOpen(true)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-subtle"
              >
                <span
                  aria-hidden="true"
                  className="material-symbols-outlined text-[18px] text-text-muted"
                >
                  add
                </span>

                <span className="min-w-0 flex-1 truncate text-sm text-text">
                  New research group
                </span>
              </button>
            </>
          ) : (
            <>
              <nav
                aria-label="Research groups"
                className="flex flex-col gap-0.5"
              >
                {orderedGroups.map((group) => {
                  const manualExpanded =
                    navPreferences?.expandedResearchGroups.includes(
                      group.id,
                    ) ?? false
                  const visible =
                    manualExpanded ||
                    contextGroupId === group.id
                  const isActive =
                    group.id === activeResearchGroupId
                  const childrenId = `research-group-children-${group.id}`

                  return (
                    <div
                      key={group.id}
                      role="group"
                      aria-label={group.name}
                    >
                      <div className="flex items-center gap-1 rounded-lg px-1">
                        <button
                          type="button"
                          onClick={() =>
                            toggleGroupExpansion(group.id)
                          }
                          aria-expanded={visible}
                          aria-controls={childrenId}
                          aria-label={`${manualExpanded ? 'Collapse' : 'Expand'} ${group.name}`}
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                        >
                          <span
                            aria-hidden="true"
                            className={`material-symbols-outlined text-[18px] transition-transform duration-200 motion-reduce:transition-none ${visible ? 'rotate-90' : ''}`}
                          >
                            chevron_right
                          </span>
                        </button>

                        <button
                          type="button"
                          onClick={() =>
                            handleGroupSelect(group)
                          }
                          aria-current={
                            isActive ? 'true' : undefined
                          }
                          className={`min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${isActive ? 'font-semibold text-text' : 'text-text-muted hover:bg-surface-hover hover:text-text'}`}
                        >
                          {group.name}
                        </button>

                        {group.role === 'admin' && (
                          <GroupOverflowMenu
                            group={group}
                          />
                        )}
                      </div>

                      <div
                        id={childrenId}
                        inert={!visible}
                        aria-hidden={!visible}
                        className={`grid transition-[grid-template-rows] duration-200 motion-reduce:transition-none ${visible ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
                      >
                        <div className="overflow-hidden">
                          <div className="flex flex-col gap-0.5 pb-1 pl-8 pr-1 pt-0.5">
                            <NavLink
                              to={`/projects?group=${group.id}`}
                              className={({ isActive }) =>
                                childNavClasses(isActive)
                              }
                            >
                              <span
                                aria-hidden="true"
                                className="material-symbols-outlined text-[18px]"
                              >
                                folder_open
                              </span>

                              Projects
                            </NavLink>

                            <NavLink
                              to={`/meetings?group=${group.id}`}
                              className={({ isActive }) =>
                                childNavClasses(isActive)
                              }
                            >
                              <span
                                aria-hidden="true"
                                className="material-symbols-outlined text-[18px]"
                              >
                                groups
                              </span>

                              Meetings
                            </NavLink>
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </nav>

              <div className="mt-2">
                <button
                  type="button"
                  onClick={() => setCreateDialogOpen(true)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-text-muted transition-colors hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-subtle"
                >
                  <span
                    aria-hidden="true"
                    className="material-symbols-outlined text-[18px]"
                  >
                    add
                  </span>

                  Create research group
                </button>
              </div>
            </>
          )}

          <CreateResearchGroupDialog
            open={createDialogOpen}
            onClose={() => setCreateDialogOpen(false)}
            onCreated={handleCreatedResearchGroup}
          />
        </div>
      )}

      <nav className="mt-auto flex flex-col gap-1 border-t border-border-subtle pt-4">
        {secondaryNavigation.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) =>
              navClasses(isActive)
            }
          >
            <span className="material-symbols-outlined text-[20px]">
              {item.icon}
            </span>

            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </aside>
  )
}
