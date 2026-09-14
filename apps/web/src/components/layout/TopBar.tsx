import { useSession } from '../../api/useSession'

import { UserMenu } from './UserMenu'

export function TopBar() {
  const { user } = useSession()

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center justify-end border-b border-border-subtle bg-surface-chrome/95 px-6 backdrop-blur">
      {user && <UserMenu />}
    </header>
  )
}
