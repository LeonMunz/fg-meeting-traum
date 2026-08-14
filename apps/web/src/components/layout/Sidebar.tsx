import { NavLink } from 'react-router'

const mainNavigation = [
  { label: 'Home', path: '/', icon: 'home' },
  { label: 'My Work', path: '/my-work', icon: 'assignment' },
  { label: 'Projects', path: '/projects', icon: 'folder_open' },
  { label: 'Goals', path: '/goals', icon: 'ads_click' },
  { label: 'Meetings', path: '/meetings', icon: 'groups' },
  { label: 'KVP', path: '/kvp', icon: 'database' },
  { label: 'Knowledge', path: '/knowledge', icon: 'library_books' },
  { label: 'Calendar', path: '/calendar', icon: 'calendar_today' },
  { label: 'People', path: '/people', icon: 'group' },
]

const secondaryNavigation = [
  { label: 'Notifications', path: '/notifications', icon: 'notifications' },
  { label: 'Settings', path: '/settings', icon: 'settings' },
  { label: 'Profile', path: '/profile', icon: 'account_circle' },
]

export function Sidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 flex w-[240px] flex-col border-r border-outline-variant bg-surface-container-low px-4 py-8">
      <div className="mb-8 flex items-center gap-3 px-2">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary font-bold text-white">
          FG
        </div>

        <div>
          <div className="font-semibold text-on-surface">FG Workspace</div>
          <div className="text-xs text-on-surface-variant">Research OS</div>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-1">
        {mainNavigation.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === '/'}
            className={({ isActive }) =>
              [
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                isActive
                  ? 'bg-secondary-container font-semibold text-on-surface'
                  : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface',
              ].join(' ')
            }
          >
            <span className="material-symbols-outlined text-[20px]">
              {item.icon}
            </span>

            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <nav className="mt-4 flex flex-col gap-1 border-t border-outline-variant pt-4">
        {secondaryNavigation.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
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