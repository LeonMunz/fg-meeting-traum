import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'

import { useSession } from '../../api/useSession'
import { InviteToWorkspaceDialog } from '../../features/account-invitations/InviteToWorkspaceDialog'

const MENU_ITEM_CLASSES =
  'flex h-8 w-full items-center gap-2 rounded bg-transparent px-2 text-left text-[13px] font-medium leading-[18px] transition'

function UserMenuItem({
  icon,
  label,
  danger,
  onClick,
}: {
  icon: string
  label: string
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={[
        MENU_ITEM_CLASSES,
        danger
          ? 'text-danger hover:bg-danger-subtle focus-visible:bg-danger-subtle'
          : 'text-text-muted hover:bg-surface-muted hover:text-text focus-visible:bg-surface-muted focus-visible:text-text',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className="material-symbols-outlined text-[16px]"
      >
        {icon}
      </span>

      <span className="truncate">{label}</span>
    </button>
  )
}

/**
 * Global authenticated topbar user menu.
 *
 * Owns the menu open/closed state, the global InviteToWorkspaceDialog
 * open state, and the menu actions (profile, invite, settings, sign
 * out). The invite dialog stays fully independent: this component only
 * controls `open` and passes the session `logout` through; no
 * invitation API logic lives here. The dropdown and the dialog never
 * remain open simultaneously: every action closes the dropdown first.
 */
export function UserMenu() {
  const { user, logout } = useSession()
  const navigate = useNavigate()

  const [open, setOpen] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target

      if (
        target instanceof Node &&
        !containerRef.current?.contains(target)
      ) {
        setOpen(false)
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  if (!user) {
    return null
  }

  const name = user.firstName || user.username

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label={name}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={[
          'flex h-8 items-center gap-1.5 rounded border border-transparent bg-transparent px-2 py-1 transition',
          'hover:bg-surface',
          open ? 'bg-surface-hover' : '',
          'focus-visible:outline-2 focus-visible:outline focus-visible:outline-focus focus-visible:outline-offset-1',
        ].join(' ')}
      >
        <span
          aria-hidden="true"
          className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-[11px] font-medium leading-4 text-text-inverse"
        >
          {(user.firstName?.[0] ??
            user.username[0] ??
            '?').toUpperCase()}
        </span>

        <span className="text-[13px] font-medium leading-[18px] text-text">
          {name}
        </span>

        <span
          aria-hidden="true"
          className="material-symbols-outlined text-[12px] text-text-tertiary"
        >
          {open ? 'expand_less' : 'expand_more'}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+6px)] z-50 w-52 overflow-hidden rounded-md border border-border-subtle bg-surface p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.32)]"
        >
          <UserMenuItem
            icon="person"
            label="Profile"
            onClick={() => {
              setOpen(false)
              navigate('/profile')
            }}
          />

          <UserMenuItem
            icon="person_add"
            label="Invite to FG Workspace"
            onClick={() => {
              setOpen(false)
              setInviteOpen(true)
            }}
          />

          <UserMenuItem
            icon="settings"
            label="Settings"
            onClick={() => {
              setOpen(false)
              navigate('/settings/appearance')
            }}
          />

          <div className="mx-0.5 my-1 h-px bg-border-subtle" />

          <UserMenuItem
            icon="logout"
            label="Sign out"
            danger
            onClick={() => {
              setOpen(false)
              void logout()
            }}
          />
        </div>
      )}

      <InviteToWorkspaceDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
      />
    </div>
  )
}
