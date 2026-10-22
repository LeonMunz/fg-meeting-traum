import {
  Link,
  Outlet,
  useLocation,
} from 'react-router'

import {
  WorkspaceContent,
} from '../../components/layout/WorkspaceContent'
import {
  useResearchGroupListScope,
} from './useResearchGroupListScope'

type WorkspaceTabId =
  | 'overview'
  | 'projects'
  | 'meetings'
  | 'settings'

const BASE_TABS: ReadonlyArray<{
  id: WorkspaceTabId
  label: string
}> = [
  { id: 'overview', label: 'Overview' },
  { id: 'projects', label: 'Projects' },
  { id: 'meetings', label: 'Meetings' },
]

/**
 * Shared Research Group workspace layout.
 *
 * ONE parent route renders the whole workspace surface — the
 * group header (name + description), the persistent horizontal
 * section tab bar, and the routed area content through the
 * `<Outlet />`. Because the layout is the PARENT of the four
 * workspace child routes (overview index / projects / meetings /
 * settings), it stays mounted across tab switches: only the
 * `<Outlet />` content swaps, the header and the tab bar never
 * remount, and the active tab is derived from the matched route
 * (the URL is the single source of truth — no local tab state).
 *
 * Group identity and authorization come from the EXISTING scope
 * mechanism (`useResearchGroupListScope` over the provider's
 * currently accessible group list) — no new global group-state
 * architecture is introduced:
 *
 * - the `:groupId` path parameter is authoritative (a
 *   `?group=` query parameter can never override it);
 * - while the group list is INITIAL-loading (before the
 *   first completed load, the scope cannot resolve yet),
 *   a loading state renders — no tabs, no content of any
 *   group. A background refresh of already-available data
 *   never unmounts the workspace surface (header, tab bar,
 *   Outlet content), so routed pages keep their local UI
 *   state across the refresh;
 * - an invalid (unparseable), unknown, or not currently
 *   accessible group id resolves to NO scope: a not-found view
 *   renders instead of the workspace, no other Research Group is
 *   substituted, and no tabs or group data of another group are
 *   shown (no silent fallback);
 * - the `Settings` tab is offered to Research Group admins only.
 *
 * The tab bar reuses the Project Detail section-tab treatment
 * (38px bar on a subtle bottom border, 28px gaps, 13px medium
 * labels, 2px underline on the active tab, horizontally
 * scrollable, real links with `aria-current="page"` — no ARIA
 * tablist, no artificial tab panels).
 */
export function ResearchGroupWorkspaceLayout() {
  const {
    activeResearchGroupId,
    activeResearchGroup,
    loading,
    error,
  } = useResearchGroupListScope()

  const { pathname } = useLocation()

  /*
   * Full-surface loading is INITIAL loading only: before
   * the first completed group-list load the list is empty,
   * the scope cannot resolve, and no tabs or content of
   * any group may render. Once the scope has resolved, a
   * background refresh of already-available data must NOT
   * unmount the workspace surface — the header, the tab
   * bar, and the Outlet content (and with it the routed
   * page's local UI state, e.g. the Settings internal tab)
   * stay mounted across the refresh.
   */
  if (loading && !activeResearchGroup) {
    return (
      <div className="w-full px-6 py-8 lg:px-8 lg:py-10 xl:px-10">
        <div className="flex min-h-[360px] items-center justify-center">
          <span className="material-symbols-outlined animate-spin text-[22px] text-text-muted">
            refresh
          </span>
        </div>
      </div>
    )
  }

  /*
   * Invalid / unknown / not accessible group: the workspace is
   * not rendered at all — no header, no tabs, no Outlet content.
   */
  if (!activeResearchGroup || activeResearchGroupId == null) {
    return (
      <div className="w-full px-6 py-8 lg:px-8 lg:py-10 xl:px-10">
        <div className="mx-auto max-w-[1100px]">
          <h1 className="text-3xl font-semibold tracking-tight text-text">
            Research group
          </h1>

          <p className="mt-2 text-sm text-overview-error">
            {error ??
              'Research group is not available.'}
          </p>
        </div>
      </div>
    )
  }

  const tabs = [
    ...BASE_TABS,
    ...(activeResearchGroup.role === 'admin'
      ? [
          {
            id: 'settings' as const,
            label: 'Settings',
          },
        ]
      : []),
  ]

  const base = `/groups/${activeResearchGroupId}`

  const activeTab:
    | WorkspaceTabId
    | null =
    pathname === base
      ? 'overview'
      : pathname === `${base}/projects`
        ? 'projects'
        : pathname === `${base}/meetings`
          ? 'meetings'
          : pathname === `${base}/settings` &&
            activeResearchGroup.role === 'admin'
            ? 'settings'
            : null

  return (
    <div className="w-full px-6 py-8 lg:px-8 lg:py-10 xl:px-10">
      <WorkspaceContent>
        <header>
          <h1 className="text-3xl font-semibold tracking-tight text-text">
            {activeResearchGroup.name}
          </h1>

          <p className="mt-1.5 text-sm text-text-muted">
            Research group workspace
          </p>

          <nav
            aria-label="Research group sections"
            className="mt-8 flex h-[38px] items-stretch gap-7 overflow-x-auto border-b border-border-subtle"
          >
            {tabs.map((tab) => {
              const selected =
                tab.id === activeTab

              return (
                <Link
                  key={tab.id}
                  to={
                    tab.id === 'overview'
                      ? base
                      : `${base}/${tab.id}`
                  }
                  aria-current={
                    selected
                      ? 'page'
                      : undefined
                  }
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

        <div className="mt-8">
          <Outlet />
        </div>
      </WorkspaceContent>
    </div>
  )
}
