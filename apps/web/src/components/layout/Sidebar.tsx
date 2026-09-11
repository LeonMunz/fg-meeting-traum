import { NavLink } from 'react-router'

import { ResearchGroupSelector } from '../../features/research-group/ResearchGroupSelector'
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
]

const groupNavigation = [
  {
    label: 'Projects',
    path: '/projects',
    icon: 'folder_open',
  },
  {
    label: 'Meetings',
    path: '/meetings',
    icon: 'groups',
  },
  {
    label: 'Calendar',
    icon: 'calendar_today',
    disabled: true,
  },
  {
    label: 'KVP',
    icon: 'database',
    disabled: true,
  },
  {
    label: 'Knowledge',
    icon: 'library_books',
    disabled: true,
  },
  {
    label: 'Data',
    icon: 'storage',
    badge: 'AI',
    disabled: true,
  },
  {
    label: 'People',
    icon: 'group',
    disabled: true,
  },
]

const secondaryNavigation = [
  {
    label: 'Notifications',
    path: '/notifications',
    icon: 'notifications',
  },
  {
    label: 'Settings',
    path: '/settings',
    icon: 'settings',
  },
  {
    label: 'Profile',
    path: '/profile',
    icon: 'account_circle',
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

export function Sidebar() {
  const {
    groups,
    activeResearchGroupId,
    loading,
  } = useResearchGroup()

  const showResearchGroupSection =
    loading || groups.length > 0

  return (
    <aside className="fixed inset-y-0 left-0 z-30 flex w-[240px] flex-col border-r border-border-subtle bg-surface-subtle px-4 py-8">
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
          <ResearchGroupSelector />

          {activeResearchGroupId != null && (
            <nav
              aria-label="Research group navigation"
              className="mt-2 flex flex-col gap-1 pl-3"
            >
              {groupNavigation.map((item) => {
                if ('path' in item) {
                  return (
                    <NavLink
                      key={item.path}
                      to={`${item.path}?group=${activeResearchGroupId}`}
                      className={({ isActive }) =>
                        navClasses(isActive)
                      }
                    >
                      <span className="material-symbols-outlined text-[19px]">
                        {item.icon}
                      </span>

                      <span>{item.label}</span>
                    </NavLink>
                  )
                }

                return (
                  <span
                    key={item.label}
                    aria-disabled="true"
                    className="flex cursor-default items-center gap-3 rounded-lg px-3 py-2 text-sm text-text-muted"
                  >
                    <span className="material-symbols-outlined text-[19px] opacity-70">
                      {item.icon}
                    </span>

                    <span className="line-through decoration-border-control">
                      {item.label}
                    </span>

                    {'badge' in item && (
                      <span className="rounded border border-border-default px-1 py-0.5 text-[10px] font-medium leading-none tracking-wide text-text-muted">
                        {item.badge}
                      </span>
                    )}
                  </span>
                )
              })}
            </nav>
          )}
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
