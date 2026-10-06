import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  NavLink,
  useLocation,
  useNavigate,
} from 'react-router'

import { getProject } from '../../api/projects'
import {
  fetchGlobalProjectQuickAccess,
  recordProjectOpen,
} from '../../api/project-quick-access'
import {
  fetchWorkspaceNavigationPreferences,
  updateWorkspaceNavigationPreferences,
} from '../../api/workspace-navigation-preferences'
import type {
  ApiProjectQuickAccessItem,
  ApiResearchGroup,
  ApiWorkspaceNavigationPreferences,
} from '../../api/types'
import {
  CreateResearchGroupDialog,
} from '../../features/research-group/CreateResearchGroupDialog'
import { useResearchGroup } from '../../features/research-group/useResearchGroup'
import {
  composeProjectShortcuts,
  projectIdFromPath,
  type CurrentProjectShortcut,
} from './projectQuickAccess'

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

// Debounce window for persisting a changed workspace-navigation
// snapshot (the repository's established 300 ms user-preference
// debounce). Rapid chevron toggles coalesce into a single PATCH
// carrying the LATEST complete snapshot.
const WORKSPACE_NAV_DEBOUNCE_MS = 300

// Structural equality for two complete workspace-navigation
// snapshots — the dirty check that decides whether a debounced save
// is owed. Element-wise comparison is exact: the server returns the
// ID lists unchanged and the client never reorders them.
// `expandedProjectSections` is compared and round-tripped for the
// complete-snapshot API contract although the Sidebar no longer
// consumes it for presentation (frozen contract §7.3.5 / D-4).
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

/**
 * The Quick Access project row: a quiet dot marker + the project
 * name (frozen contract D-2 — no per-row Research Group label).
 * Active emphasis is text-only (QA-14); the row is never a
 * disclosure and never nested below a Research Group (QA-16).
 */
function projectShortcutClasses(isActive: boolean) {
  return [
    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
    isActive
      ? 'bg-surface-muted font-semibold text-text'
      : 'text-text-muted hover:bg-surface-hover hover:text-text',
  ].join(' ')
}

/**
 * Restrained uppercase section label (frozen contract §2 / §3.4:
 * labels for `Quick Access` and `Research Groups`, none for
 * Personal). Minimal slice-2 treatment on the existing tokens;
 * exact Stitch typography is slice 3.
 */
function sectionLabel(text: string) {
  return (
    <div className="px-3 pt-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
      {text}
    </div>
  )
}

export function Sidebar() {
  const {
    groups,
    activeResearchGroupId,
    loading,
    error,
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
   * ── Global personal Quick Access snapshot (QA-1..QA-9) ──
   *
   * Exactly ONE global request per cold load (QA-8): the Sidebar
   * never fetches a per-Research-Group Quick Access endpoint. The
   * server order of the first successful fetch is the STABLE
   * SESSION SNAPSHOT (QA-2); the monotonic sequence guard drops
   * superseded in-flight responses, so a stale answer can never
   * overwrite a newer state (QA-9).
   */
  const [
    quickAccess,
    setQuickAccess,
  ] = useState<ApiProjectQuickAccessItem[] | null>(null)
  const [
    quickAccessError,
    setQuickAccessError,
  ] = useState<string | null>(null)
  const quickAccessSeqRef = useRef(0)
  const quickAccessColdLoadRef = useRef(false)

  const loadGlobalQuickAccess = useCallback(() => {
    const seq = ++quickAccessSeqRef.current
    setQuickAccessError(null)
    // The section resets for the authoritative refetch: no stale
    // row (e.g. an archived or access-lost Project) is presented
    // while the new snapshot is in flight (QA-9).
    setQuickAccess(null)

    void fetchGlobalProjectQuickAccess()
      .then((items) => {
        if (seq !== quickAccessSeqRef.current) {
          return
        }

        setQuickAccess(items)
      })
      .catch(() => {
        if (seq !== quickAccessSeqRef.current) {
          return
        }

        setQuickAccessError(
          'Quick access could not be loaded.',
        )
      })
  }, [])

  useEffect(() => {
    // The ref guard also covers the StrictMode effect replay in
    // development: the cold load still happens exactly once.
    if (quickAccessColdLoadRef.current) {
      return
    }

    quickAccessColdLoadRef.current = true
    loadGlobalQuickAccess()
  }, [loadGlobalQuickAccess])

  /*
   * ── Current concrete Project (route-derived) ──
   *
   * The concrete Project id the current route points inside of,
   * plus its resolved metadata (name + owning Research Group via
   * one bounded, race-guarded `getProject` per route entry — never
   * inferred from the URL). Drives the contextual Quick Access
   * row (QA-4/QA-5), the contextual Research Group reveal, and the
   * central Project-open recording (QA-17).
   */
  const currentProjectId = projectIdFromPath(location.pathname)

  const [
    currentProjectMeta,
    setCurrentProjectMeta,
  ] = useState<CurrentProjectShortcut | null>(null)
  const currentProjectSeqRef = useRef(0)

  useEffect(() => {
    if (currentProjectId === null) {
      currentProjectSeqRef.current += 1
      setCurrentProjectMeta(null)
      return
    }

    const seq = ++currentProjectSeqRef.current
    setCurrentProjectMeta(null)

    void getProject(currentProjectId)
      .then((project) => {
        if (seq !== currentProjectSeqRef.current) {
          return
        }

        setCurrentProjectMeta({
          id: project.id,
          name: project.name,
          researchGroupId: project.researchGroupId,
        })
      })
      .catch(() => {
        if (seq !== currentProjectSeqRef.current) {
          return
        }

        setCurrentProjectMeta(null)

        /*
         * Lifecycle evidence (QA-9): the authoritative `getProject`
         * says the current Project is no longer readable (deleted
         * / access loss), so the candidate set itself may be
         * stale. Reconcile: drop any in-flight snapshot response
         * and refetch the authoritative list. The next cold load
         * is the authoritative backstop. (Documented gap: archive
         * / restore performed OUTSIDE the concrete Project route
         * has no clean frontend signal and reconciles at the next
         * cold load.)
         */
        loadGlobalQuickAccess()
      })
  }, [currentProjectId, loadGlobalQuickAccess])

  /*
   * ── Central Project-open recording (QA-17) ──
   *
   * One route-level integration keyed by the entered concrete
   * Project (list → Project, shortcut → Project, any other
   * navigation → Project, and deep links): exactly ONE
   * non-blocking write per logical Project entry. Tab changes
   * inside the same Project do not re-record; leaving the Project
   * ends the span, and re-entering records a new open. The ref
   * guard also makes the StrictMode effect replay a no-op. A
   * write failure never blocks navigation or rendering.
   */
  const openSpanProjectIdRef = useRef<number | null>(null)

  useEffect(() => {
    const projectId = projectIdFromPath(
      location.pathname,
    )

    if (projectId === null) {
      openSpanProjectIdRef.current = null
      return
    }

    if (openSpanProjectIdRef.current === projectId) {
      return
    }

    openSpanProjectIdRef.current = projectId
    void recordProjectOpen(projectId).catch(() => {
      /* Non-blocking by contract (QA-17). */
    })
  }, [location.pathname])

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
   * explicit ?group= scope, the Research Group Overview or its
   * settings route, or the current Project's owning group from
   * resolved metadata — never inferred from the URL). The
   * contextual reveal it drives keeps the user's current location
   * understandable without ever mutating the persisted manual
   * expansion state (presentation only, never persisted).
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
      /^\/groups\/(\d+)(?:\/settings)?$/
        .exec(location.pathname)

    if (match) {
      const id = Number(match[1])

      if (accessible.has(id)) {
        return id
      }
    }

    if (
      currentProjectMeta !== null &&
      accessible.has(
        currentProjectMeta.researchGroupId,
      )
    ) {
      return currentProjectMeta.researchGroupId
    }

    return null
  }, [groups, location, currentProjectMeta])

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
  // group navigation (QA-10).
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
   * The Research Group name is a PURE navigation control to the
   * group's Overview (QA-11): no select-in-place, no contextual
   * group-switch routing, no active-group side effect. The
   * Overview page syncs the provider's route-derived group
   * context itself.
   */
  const openGroupOverview = (group: ApiResearchGroup) => {
    navigate(`/groups/${group.id}`)
  }

  const handleCreatedResearchGroup = (
    group: ApiResearchGroup,
  ) => {
    /*
     * The exact server-serialized group enters the canonical state
     * and becomes the active Research Group. No membership is
     * synthesized client-side. The new group's landing point is
     * its Overview — the canonical group entry of the approved IA.
     */
    addResearchGroup(group)
    setCreateDialogOpen(false)
    navigate(`/groups/${group.id}`)
  }

  /*
   * The Research Group name row is emphasized while the current
   * route is the group's Overview or one of its subroutes
   * (settings) — active presentation follows the ROUTE, and
   * expansion stays a separate state (QA-14/QA-15).
   */
  const groupRouteActive = (groupId: number) => {
    const prefix = `/groups/${groupId}`

    return (
      location.pathname === prefix ||
      location.pathname.startsWith(
        `${prefix}/`,
      )
    )
  }

  const groupScopeParam = new URLSearchParams(
    location.search,
  ).get('group')

  /*
   * The scoped Projects / Meetings child rows are active for their
   * own group's scope: an explicit ?group= scope matching this
   * group, or the provider's active group while the list page
   * still carries no explicit scope.
   */
  const scopedChildActive = (
    groupId: number,
    listPath: '/projects' | '/meetings',
  ) => {
    if (location.pathname !== listPath) {
      return false
    }

    if (groupScopeParam != null) {
      return Number(groupScopeParam) === groupId
    }

    return activeResearchGroupId === groupId
  }

  const treeLoading =
    loading || navPreferencesLoadState === 'pending'

  const quickAccessRows = useMemo(
    () =>
      composeProjectShortcuts(
        quickAccess ?? [],
        currentProjectMeta,
      ),
    [quickAccess, currentProjectMeta],
  )

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

      {/*
       * Global personal Quick Access: ONE flat section, never
       * nested below a Research Group, never collapsible (QA-1,
       * QA-16). The section stays present in every state
       * (loading / error / empty).
       */}
      <div className="mt-5">
        {sectionLabel('Quick Access')}

        <nav
          aria-label="Quick access"
          className="mt-1 flex flex-col gap-0.5 px-1"
        >
          {quickAccessError !== null ? (
            <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text-muted">
              <span className="min-w-0 flex-1 truncate">
                {quickAccessError}
              </span>

              <button
                type="button"
                onClick={() =>
                  loadGlobalQuickAccess()
                }
                className="shrink-0 rounded font-medium text-text transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                Retry
              </button>
            </div>
          ) : quickAccess === null ? (
            <div
              role="status"
              aria-label="Loading quick access"
              className="flex h-8 items-center gap-2 px-2 text-sm text-text-muted"
            >
              <span
                aria-hidden="true"
                className="material-symbols-outlined animate-spin text-[18px]"
              >
                refresh
              </span>

              <span className="sr-only">
                Loading quick access…
              </span>
            </div>
          ) : quickAccessRows.length === 0 ? (
            <div className="px-2 py-1.5 text-sm text-text-muted">
              No quick access projects.
            </div>
          ) : (
            quickAccessRows.map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() =>
                  navigate(
                    `/projects/${row.id}/work-items`,
                  )
                }
                aria-current={
                  row.id === currentProjectId
                    ? 'true'
                    : undefined
                }
                className={projectShortcutClasses(
                  row.id === currentProjectId,
                )}
              >
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-text-muted"
                />

                <span className="min-w-0 flex-1 truncate text-left">
                  {row.name}
                </span>
              </button>
            ))
          )}
        </nav>
      </div>

      {showResearchGroupSection && (
        <div className="mt-5 border-t border-border-subtle pt-4">
          {sectionLabel('Research Groups')}

          <div className="mt-1">
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
                    const groupActive =
                      groupRouteActive(group.id)
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
                              openGroupOverview(group)
                            }
                            aria-current={
                              groupActive
                                ? 'true'
                                : undefined
                            }
                            className={`min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${groupActive ? 'font-semibold text-text' : 'text-text-muted hover:bg-surface-hover hover:text-text'}`}
                          >
                            {group.name}
                          </button>

                          {/*
                           * QA-12: no overflow / three-dot menu
                           * on any Research Group row. The admin
                           * Settings destination is reachable via
                           * the group's Overview page.
                           */}
                        </div>

                        <div
                          id={childrenId}
                          inert={!visible}
                          aria-hidden={!visible}
                          className={`grid transition-[grid-template-rows] duration-200 motion-reduce:transition-none ${visible ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
                        >
                          <div className="overflow-hidden">
                            <div className="flex flex-col gap-0.5 pb-1 pl-8 pr-1 pt-0.5">
                              {/*
                               * EXACTLY two child rows, nothing
                               * else — plain navigation, no
                               * disclosure, no Project children
                               * (QA-13, QA-16).
                               */}
                              <NavLink
                                to={`/projects?group=${group.id}`}
                                className={childNavClasses(
                                  scopedChildActive(
                                    group.id,
                                    '/projects',
                                  ),
                                )}
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
                                className={childNavClasses(
                                  scopedChildActive(
                                    group.id,
                                    '/meetings',
                                  ),
                                )}
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
          </div>

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
