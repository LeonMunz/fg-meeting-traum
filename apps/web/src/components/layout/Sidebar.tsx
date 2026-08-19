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
    label: 'Goals',
    path: '/goals',
    icon: 'ads_click',
  },
  {
    label: 'Meetings',
    path: '/meetings',
    icon: 'groups',
  },
  {
    label: 'KVP',
    path: '/kvp',
    icon: 'database',
  },
  {
    label: 'Knowledge',
    path: '/knowledge',
    icon: 'library_books',
  },
  {
    label: 'Data',
    path: '/data',
    icon: 'storage',
  },
  {
    label: 'Calendar',
    path: '/calendar',
    icon: 'calendar_today',
  },
  {
    label: 'People',
    path: '/people',
    icon: 'group',
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
    isActive
      ? 'bg-secondary-container font-semibold text-on-surface'
      : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface',
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
    <aside className="fixed inset-y-0 left-0 z-30 flex w-[240px] flex-col border-r border-outline-variant bg-surface-container-low px-4 py-8">
      <div className="mb-8 flex items-center gap-3 px-2">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary font-bold text-white">
          FG
        </div>

        <div>
          <div className="font-semibold text-on-surface">
            FG Workspace
          </div>

          <div className="text-xs text-on-surface-variant">
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
        <div className="mt-5 border-t border-outline-variant pt-5">
          <ResearchGroupSelector />

          {activeResearchGroupId != null && (
            <nav className="mt-2 flex flex-col gap-1 pl-3">
              {groupNavigation.map((item) => (
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
              ))}
            </nav>
          )}
        </div>
      )}

      <nav className="mt-auto flex flex-col gap-1 border-t border-outline-variant pt-4">
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
