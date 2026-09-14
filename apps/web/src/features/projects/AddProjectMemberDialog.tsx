import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react'

export type AddableProjectRole = 'owner' | 'member' | 'viewer'

export type DirectoryUser = {
  id: string
  name: string
  username: string
  initials: string
}

type AddProjectMemberDialogProps = {
  open: boolean
  users: DirectoryUser[]
  excludedUserIds: string[]
  onClose: () => void
  onAdd: (
    user: DirectoryUser,
    role: AddableProjectRole,
  ) => Promise<void>
}

// The canonical Project membership roles supported by the backend
// (ProjectMembership.Role: owner / member / viewer). Only these are
// rendered; the default is Member — never Owner.
const PROJECT_ROLES: Array<{
  value: AddableProjectRole
  label: string
  description: string
}> = [
  {
    value: 'owner',
    label: 'Owner',
    description:
      'Can manage the project, members and their roles.',
  },
  {
    value: 'member',
    label: 'Member',
    description:
      'Can participate in and modify project work.',
  },
  {
    value: 'viewer',
    label: 'Viewer',
    description:
      'Can inspect the project but cannot make changes.',
  },
]

export function AddProjectMemberDialog({
  open,
  users,
  excludedUserIds,
  onClose,
  onAdd,
}: AddProjectMemberDialogProps) {
  const [query, setQuery] = useState('')
  const [selectedUserId, setSelectedUserId] = useState<
    string | null
  >(null)
  const [role, setRole] = useState<AddableProjectRole>(
    'member',
  )
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] =
    useState<string | null>(null)

  // The parent recreates `onClose` on every render. Keep the latest
  // handler in a ref so the effects below can depend on `open` alone;
  // otherwise any parent re-render while the dialog is open would
  // re-run the reset and wipe an in-flight query or selection.
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  // Fresh state on every open.
  useEffect(() => {
    if (!open) return

    setQuery('')
    setSelectedUserId(null)
    setRole('member')
    setSubmitting(false)
    setSubmitError(null)
  }, [open])

  useEffect(() => {
    if (!open) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCloseRef.current()
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  // Eligible pool: Research Group members minus current
  // Project members. This — not the filtered result — decides
  // the "nobody left to add" state.
  const eligibleUsers = useMemo(
    () =>
      users.filter(
        (user) => !excludedUserIds.includes(user.id),
      ),
    [excludedUserIds, users],
  )

  // Case-insensitive, trimmed name/username filter over the
  // eligible pool. Empty query shows the whole pool.
  const availableUsers = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()

    if (!normalizedQuery) {
      return eligibleUsers
    }

    return eligibleUsers.filter(
      (user) =>
        user.name
          .toLowerCase()
          .includes(normalizedQuery) ||
        user.username
          .toLowerCase()
          .includes(normalizedQuery),
    )
  }, [eligibleUsers, query])

  const selectedUser =
    users.find((user) => user.id === selectedUserId) ??
    null

  if (!open) {
    return null
  }

  const hasEligibleUsers = eligibleUsers.length > 0
  const hasQuery = query.trim().length > 0
  const noMatchingPeople =
    hasEligibleUsers && hasQuery && availableUsers.length === 0

  const handleSubmit = async () => {
    if (!selectedUser || !role || submitting) return

    setSubmitting(true)
    setSubmitError(null)

    try {
      await onAdd(selectedUser, role)
      onClose()
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : 'Project member could not be added.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  const handleOverlayMouseDown = (
    event: MouseEvent<HTMLDivElement>,
  ) => {
    if (event.target === event.currentTarget) {
      onClose()
    }
  }

  // Shared header for both dialog variants: 18px/24px/600 title,
  // 12px/18px description, 28x28 close control with a 16px icon.
  const dialogHeader = (
    <div className="flex items-start justify-between gap-4 px-4 pb-3.5 pt-[18px]">
      <div>
        <h2
          id="add-project-member-title"
          className="text-lg font-semibold leading-6 tracking-tight text-text"
        >
          Add project member
        </h2>

        <p className="mt-[3px] text-xs leading-[18px] text-text-muted">
          Give a research-group member access to this
          project.
        </p>
      </div>

      <button
        type="button"
        onClick={onClose}
        aria-label="Close dialog"
        className="-mr-1.5 -mt-1.5 flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-muted outline-none transition hover:bg-surface-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
      >
        <span
          aria-hidden="true"
          className="material-symbols-outlined text-[16px]"
        >
          close
        </span>
      </button>
    </div>
  )

  // Zero eligible candidates: compact, search-free state.
  // Nothing can be added, so no Select person, Search,
  // role, or Add member control is rendered at all.
  if (!hasEligibleUsers) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-overlay-scrim px-4 py-6 backdrop-blur-[2px]"
        onMouseDown={handleOverlayMouseDown}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-project-member-title"
          className="w-[440px] max-w-[calc(100vw-48px)] overflow-hidden rounded-lg border border-border-subtle bg-surface shadow-xl"
        >
          {dialogHeader}

          <div className="px-4 py-4">
            <div className="rounded border border-border-subtle bg-surface-quiet px-4 py-5 text-center">
              <p className="text-[13px] font-semibold leading-[18px] text-text">
                Everyone already has project access
              </p>

              <p className="mt-1 text-xs leading-[18px] text-text-muted">
                All research-group members are already
                members of this project.
              </p>
            </div>
          </div>

          <div className="flex items-center justify-end border-t border-border-subtle px-4 pb-4 pt-3">
            <button
              type="button"
              onClick={onClose}
              className="h-8 rounded bg-transparent px-2.5 text-[13px] font-medium leading-[18px] text-text-muted outline-none transition hover:bg-surface-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay-scrim px-4 py-6 backdrop-blur-[2px]"
      onMouseDown={handleOverlayMouseDown}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-project-member-title"
        className="w-[460px] max-h-[calc(100dvh-48px)] max-w-[calc(100vw-48px)] overflow-hidden rounded-lg border border-border-subtle bg-surface shadow-xl"
      >
        {dialogHeader}

        <div className="p-4">
          <div>
            <label
              htmlFor="member-search"
              className="mb-1.5 block text-sm font-medium text-text"
            >
              Select person
            </label>

            {selectedUser ? (
              <div className="mt-2 flex h-12 items-center gap-2.5 rounded border border-border-control bg-surface-quiet px-2.5 py-1.5">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-muted text-[10px] font-semibold text-text">
                  {selectedUser.initials}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium leading-[18px] text-text">
                    {selectedUser.name}
                  </div>

                  <div className="truncate text-[11px] leading-4 text-text-muted">
                    @{selectedUser.username}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setSelectedUserId(null)}
                  aria-label="Remove selected person"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-muted outline-none transition hover:bg-surface-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <span
                    aria-hidden="true"
                    className="material-symbols-outlined text-[14px]"
                  >
                    close
                  </span>
                </button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <span
                    aria-hidden="true"
                    className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[16px] text-text-muted"
                  >
                    search
                  </span>

                  <input
                    id="member-search"
                    type="search"
                    autoFocus
                    value={query}
                    onChange={(event) =>
                      setQuery(event.target.value)
                    }
                    placeholder="Search by name or username"
                    className="h-10 w-full rounded border border-border-control bg-surface-quiet pl-9 pr-3 text-sm leading-5 text-text outline-none transition placeholder:text-text-muted/60 focus:border-accent focus:ring-2 focus:ring-accent/20"
                  />
                </div>

                <div className="mt-2 max-h-48 overflow-y-auto rounded border border-border-subtle bg-surface-quiet">
                  {noMatchingPeople ? (
                    <div className="px-4 py-8 text-center">
                      <p className="text-sm font-medium text-text">
                        No matching people
                      </p>

                      <p className="mt-1 text-xs leading-5 text-text-muted">
                        Try a different name or username.
                      </p>
                    </div>
                  ) : (
                    <div className="divide-y divide-border-subtle">
                      {availableUsers.map((user) => (
                        <button
                          key={user.id}
                          type="button"
                          onClick={() =>
                            setSelectedUserId(user.id)
                          }
                          className="flex h-11 w-full items-center gap-2.5 px-2.5 py-1.5 text-left outline-none transition hover:bg-surface-hover focus-visible:bg-surface-hover"
                        >
                          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-muted text-[10px] font-semibold text-text">
                            {user.initials}
                          </div>

                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[13px] font-medium leading-[18px] text-text">
                              {user.name}
                            </div>

                            <div className="truncate text-[11px] leading-4 text-text-muted">
                              @{user.username}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {selectedUser && (
            <fieldset className="mt-5">
              <legend className="mb-2 text-xs font-medium leading-[18px] text-text">
                Project role
              </legend>

              <div className="space-y-1.5">
                {PROJECT_ROLES.map((option) => {
                  const selected =
                    role === option.value

                  return (
                    <label
                      key={option.value}
                      className={[
                        'grid h-12 cursor-pointer grid-cols-[16px_minmax(0,1fr)] items-center gap-x-2.5 rounded border px-2.5 py-[7px] transition',
                        selected
                          ? 'border-accent bg-accent-subtle'
                          : 'border-border-subtle hover:bg-surface-hover',
                        'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus has-[:focus-visible]:ring-inset',
                      ].join(' ')}
                    >
                      <input
                        type="radio"
                        name="new-member-role"
                        value={option.value}
                        checked={selected}
                        onChange={() =>
                          setRole(option.value)
                        }
                        className="sr-only"
                      />

                      <span
                        aria-hidden="true"
                        className={[
                          'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                          selected
                            ? 'border-accent'
                            : 'border-border-control',
                        ].join(' ')}
                      >
                        {selected && (
                          <span className="h-2 w-2 rounded-full bg-role-radio-accent" />
                        )}
                      </span>

                      <span className="min-w-0">
                        <span className="block text-[13px] font-semibold leading-[18px] text-text">
                          {option.label}
                        </span>

                        <span className="mt-px block text-[11px] leading-4 text-text-muted">
                          {option.description}
                        </span>
                      </span>
                    </label>
                  )
                })}
              </div>
            </fieldset>
          )}

          {submitError && (
            <div
              role="alert"
              className="mt-4 rounded bg-danger-bg px-4 py-3 text-sm text-danger"
            >
              {submitError}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-4 pb-3.5 pt-3">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded bg-transparent px-2.5 text-[13px] font-medium leading-[18px] text-text-muted outline-none transition hover:bg-surface-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
          >
            Cancel
          </button>

          <button
            type="button"
            disabled={
              !selectedUser || !role || submitting
            }
            onClick={() => void handleSubmit()}
            className="h-8 rounded bg-accent px-3 text-[13px] font-medium leading-[18px] text-white transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
          >
            {submitting ? 'Adding…' : 'Add member'}
          </button>
        </div>
      </div>
    </div>
  )
}
