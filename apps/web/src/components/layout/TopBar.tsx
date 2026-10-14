import { useCallback, useState } from 'react'

import { useSession } from '../../api/useSession'

import { QuickCreate } from './QuickCreate'
import { UserMenu } from './UserMenu'

export function TopBar() {
  const { user } = useSession()
  const [openMenu, setOpenMenu] = useState<
    'quick-create' | 'user' | null
  >(null)
  const handleQuickCreateOpenChange = useCallback(
    (open: boolean) =>
      setOpenMenu(open ? 'quick-create' : null),
    [],
  )
  const handleUserMenuOpenChange = useCallback(
    (open: boolean) => setOpenMenu(open ? 'user' : null),
    [],
  )

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center justify-end border-b border-border-subtle bg-surface-chrome/95 px-6 backdrop-blur">
      {user && (
        <div className="flex items-center gap-1">
          <QuickCreate
            open={openMenu === 'quick-create'}
            onOpenChange={handleQuickCreateOpenChange}
          />

          <UserMenu
            open={openMenu === 'user'}
            onOpenChange={handleUserMenuOpenChange}
          />
        </div>
      )}
    </header>
  )
}
