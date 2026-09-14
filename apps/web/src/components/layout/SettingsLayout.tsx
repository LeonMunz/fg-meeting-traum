import { NavLink, Outlet } from 'react-router'

const settingsSections = [
  {
    label: 'Appearance',
    path: '/settings/appearance',
  },
  {
    label: 'Invitations',
    path: '/settings/invitations',
  },
]

function settingsSectionClasses({
  isActive,
}: {
  isActive: boolean
}): string {
  return [
    '-mb-px border-b-2 px-1 pb-2 text-sm font-medium transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
    isActive
      ? 'border-accent text-text'
      : 'border-transparent text-text-muted hover:text-text',
  ].join(' ')
}

/**
 * Shared Settings shell: page heading plus a compact horizontal
 * secondary navigation. The active section is derived from the route;
 * NavLink exposes it via aria-current="page".
 */
export function SettingsLayout() {
  return (
    <div className="mx-auto max-w-[960px] px-8 py-10">
      <h1 className="text-3xl font-semibold tracking-tight text-text">
        Settings
      </h1>

      <nav
        aria-label="Settings"
        className="mt-6 flex gap-6 border-b border-border-subtle"
      >
        {settingsSections.map((section) => (
          <NavLink
            key={section.path}
            to={section.path}
            className={settingsSectionClasses}
          >
            {section.label}
          </NavLink>
        ))}
      </nav>

      <div className="mt-8">
        <Outlet />
      </div>
    </div>
  )
}
