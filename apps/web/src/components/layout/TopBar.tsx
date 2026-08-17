import { useSession } from '../../api/useSession'
import { ResearchGroupSelector } from '../../features/research-group/ResearchGroupSelector'

export function TopBar() {
  const { user, logout } = useSession()

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-outline-variant bg-surface/95 px-6 backdrop-blur">
      <div className="relative w-full max-w-sm">
        <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[19px] text-on-surface-variant">
          search
        </span>

        <input
          type="search"
          placeholder="Search FG Workspace..."
          className="w-full rounded-lg border border-outline-variant bg-surface-container-lowest py-2 pl-10 pr-4 text-sm text-on-surface outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
        />
      </div>

      <div className="ml-6 flex items-center gap-4">
        {user && (
          <div className="flex items-center gap-3">
            <ResearchGroupSelector />

            <div className="h-5 w-px bg-outline-variant" />

            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-medium text-white">
                {(user.firstName?.[0] ??
                  user.username[0] ??
                  '?'
                ).toUpperCase()}
              </div>

              <span className="text-sm font-medium text-on-surface">
                {user.firstName || user.username}
              </span>

              <button
                type="button"
                onClick={() => logout()}
                className="ml-1 rounded-lg px-2 py-1 text-xs font-medium text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface"
              >
                Sign out
              </button>
            </div>
          </div>
        )}
      </div>
    </header>
  )
}
