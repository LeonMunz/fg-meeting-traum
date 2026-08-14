import { useEffect, useMemo, useState } from 'react'

export type AddableProjectRole = 'owner' | 'member' | 'viewer'

export type DirectoryUser = {
  id: string
  name: string
  email: string
  initials: string
}

type AddProjectMemberDialogProps = {
  open: boolean
  users: DirectoryUser[]
  excludedUserIds: string[]
  onClose: () => void
  onAdd: (user: DirectoryUser, role: AddableProjectRole) => void
}

export function AddProjectMemberDialog({
  open,
  users,
  excludedUserIds,
  onClose,
  onAdd,
}: AddProjectMemberDialogProps) {
  const [query, setQuery] = useState('')
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
  const [role, setRole] = useState<AddableProjectRole>('member')

  useEffect(() => {
    if (!open) return

    setQuery('')
    setSelectedUserId(null)
    setRole('member')

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, onClose])

  const availableUsers = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()

    return users.filter((user) => {
      if (excludedUserIds.includes(user.id)) {
        return false
      }

      if (!normalizedQuery) {
        return true
      }

      return (
        user.name.toLowerCase().includes(normalizedQuery) ||
        user.email.toLowerCase().includes(normalizedQuery)
      )
    })
  }, [excludedUserIds, query, users])

  const selectedUser =
    users.find((user) => user.id === selectedUserId) ?? null

  const hasEligibleUsers = users.some(
    (user) => !excludedUserIds.includes(user.id),
  )

  if (!open) {
    return null
  }

  const handleSubmit = () => {
    if (!selectedUser) return

    onAdd(selectedUser, role)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-on-surface/25 px-4 py-8 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-project-member-title"
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-lowest shadow-xl"
      >
        <div className="flex items-start justify-between border-b border-outline-variant px-6 py-5">
          <div>
            <h2
              id="add-project-member-title"
              className="text-lg font-semibold tracking-tight text-on-surface"
            >
              Add project member
            </h2>

            <p className="mt-1 text-sm text-on-surface-variant">
              Give another research-group member access to this project.
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface"
          >
            <span className="material-symbols-outlined text-[20px]">
              close
            </span>
          </button>
        </div>

        <div className="space-y-6 px-6 py-6">
          <div>
            <label
              htmlFor="member-search"
              className="mb-1.5 block text-sm font-medium text-on-surface"
            >
              Select person
            </label>

            <div className="relative">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-on-surface-variant">
                search
              </span>

              <input
                id="member-search"
                type="search"
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by name or email..."
                className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest pl-10 pr-3 text-sm text-on-surface outline-none transition placeholder:text-on-surface-variant/60 focus:border-primary focus:ring-2 focus:ring-primary/15"
              />
            </div>

            <div className="mt-2 max-h-52 overflow-y-auto rounded-xl border border-outline-variant">
              {availableUsers.length > 0 ? (
                <div className="divide-y divide-outline-variant">
                  {availableUsers.map((user) => {
                    const selected = user.id === selectedUserId

                    return (
                      <button
                        key={user.id}
                        type="button"
                        onClick={() => setSelectedUserId(user.id)}
                        className={[
                          'flex w-full items-center gap-3 px-4 py-3 text-left transition',
                          selected
                            ? 'bg-primary-fixed/55'
                            : 'hover:bg-surface-container-low',
                        ].join(' ')}
                      >
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-[11px] font-semibold text-on-surface">
                          {user.initials}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-on-surface">
                            {user.name}
                          </div>

                          <div className="truncate text-xs text-on-surface-variant">
                            {user.email}
                          </div>
                        </div>

                        {selected && (
                          <span className="material-symbols-outlined text-[20px] text-primary">
                            check_circle
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              ) : (
                <div className="px-4 py-8 text-center">
                  <span className="material-symbols-outlined text-[22px] text-on-surface-variant">
                    person_search
                  </span>

                  <p className="mt-2 text-sm font-medium text-on-surface">
                    {hasEligibleUsers
                      ? 'No users found'
                      : 'Everyone is already a member'}
                  </p>

                  <p className="mt-1 text-xs leading-5 text-on-surface-variant">
                    {hasEligibleUsers
                      ? 'Try another name or email address.'
                      : 'There are no additional research-group members available to add.'}
                  </p>
                </div>
              )}
            </div>
          </div>

          <fieldset>
            <legend className="mb-2 text-sm font-medium text-on-surface">
              Project role
            </legend>

            <div className="space-y-2.5">
              <label
                className={[
                  'flex cursor-pointer items-center gap-4 rounded-xl border px-4 py-3.5 transition',
                  role === 'owner'
                    ? 'border-primary bg-primary-fixed/45 ring-1 ring-primary/20'
                    : 'border-outline-variant hover:bg-surface-container-low',
                ].join(' ')}
              >
                <input
                  type="radio"
                  name="new-member-role"
                  value="owner"
                  checked={role === 'owner'}
                  onChange={() => setRole('owner')}
                  className="sr-only"
                />

                <div
                  className={[
                    'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
                    role === 'owner'
                      ? 'bg-primary-fixed text-primary'
                      : 'bg-surface-container-high text-primary',
                  ].join(' ')}
                >
                  <span className="material-symbols-outlined text-[21px]">
                    shield_person
                  </span>
                </div>

                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-on-surface">
                    Owner
                  </div>

                  <p className="mt-0.5 text-xs leading-5 text-on-surface-variant">
                    Can manage the project, members and their roles.
                  </p>
                </div>

                <span
                  className={[
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                    role === 'owner'
                      ? 'border-primary bg-primary text-white'
                      : 'border-outline',
                  ].join(' ')}
                >
                  {role === 'owner' && (
                    <span className="material-symbols-outlined text-[14px]">
                      check
                    </span>
                  )}
                </span>
              </label>

              <label
                className={[
                  'flex cursor-pointer items-center gap-4 rounded-xl border px-4 py-3.5 transition',
                  role === 'member'
                    ? 'border-emerald-600 bg-emerald-50 ring-1 ring-emerald-600/20'
                    : 'border-outline-variant hover:bg-surface-container-low',
                ].join(' ')}
              >
                <input
                  type="radio"
                  name="new-member-role"
                  value="member"
                  checked={role === 'member'}
                  onChange={() => setRole('member')}
                  className="sr-only"
                />

                <div
                  className={[
                    'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
                    role === 'member'
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-surface-container-high text-emerald-600',
                  ].join(' ')}
                >
                  <span className="material-symbols-outlined text-[21px]">
                    person
                  </span>
                </div>

                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-on-surface">
                    Member
                  </div>

                  <p className="mt-0.5 text-xs leading-5 text-on-surface-variant">
                    Can participate in and modify project work.
                  </p>
                </div>

                <span
                  className={[
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                    role === 'member'
                      ? 'border-emerald-600 bg-emerald-600 text-white'
                      : 'border-outline',
                  ].join(' ')}
                >
                  {role === 'member' && (
                    <span className="material-symbols-outlined text-[14px]">
                      check
                    </span>
                  )}
                </span>
              </label>

              <label
                className={[
                  'flex cursor-pointer items-center gap-4 rounded-xl border px-4 py-3.5 transition',
                  role === 'viewer'
                    ? 'border-primary bg-primary-fixed/30 ring-1 ring-primary/15'
                    : 'border-outline-variant hover:bg-surface-container-low',
                ].join(' ')}
              >
                <input
                  type="radio"
                  name="new-member-role"
                  value="viewer"
                  checked={role === 'viewer'}
                  onChange={() => setRole('viewer')}
                  className="sr-only"
                />

                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant">
                  <span className="material-symbols-outlined text-[21px]">
                    visibility
                  </span>
                </div>

                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-on-surface">
                    Viewer
                  </div>

                  <p className="mt-0.5 text-xs leading-5 text-on-surface-variant">
                    Can inspect the project but cannot make changes.
                  </p>
                </div>

                <span
                  className={[
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                    role === 'viewer'
                      ? 'border-primary bg-primary text-white'
                      : 'border-outline',
                  ].join(' ')}
                >
                  {role === 'viewer' && (
                    <span className="material-symbols-outlined text-[14px]">
                      check
                    </span>
                  )}
                </span>
              </label>
            </div>
          </fieldset>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-outline-variant bg-surface-container-low/45 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-lg px-4 text-sm font-medium text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface"
          >
            Cancel
          </button>

          <button
            type="button"
            disabled={!selectedUser}
            onClick={handleSubmit}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <span className="material-symbols-outlined text-[18px]">
              person_add
            </span>
            Add member
          </button>
        </div>
      </div>
    </div>
  )
}
