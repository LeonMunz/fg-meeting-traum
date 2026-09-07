import { useSession } from '../../api/useSession'

export function TopBar() {
  const { user, logout } = useSession()

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center justify-end border-b border-border-subtle bg-surface/95 px-6 backdrop-blur">
      {user && (
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-xs font-medium text-text-inverse">
            {(user.firstName?.[0] ??
              user.username[0] ??
              '?'
            ).toUpperCase()}
          </div>

          <span className="text-sm font-medium text-text">
            {user.firstName ||
              user.username}
          </span>

          <button
            type="button"
            onClick={() => logout()}
            className="ml-1 rounded-lg px-2 py-1 text-xs font-medium text-text-muted transition hover:bg-surface-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            Sign out
          </button>
        </div>
      )}
    </header>
  )
}
