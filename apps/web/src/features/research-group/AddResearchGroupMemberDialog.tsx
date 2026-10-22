import {
  useEffect,
  useRef,
  useState,
} from 'react'

import {
  addResearchGroupMembership,
  searchResearchGroupMemberCandidates,
} from '../../api/research-groups'
import type {
  ApiResearchGroupMemberCandidate,
} from '../../api/types'

type ResearchGroupRole =
  | 'member'
  | 'admin'

type AddResearchGroupMemberDialogProps = {
  open: boolean
  researchGroupId: number
  onClose: () => void
  onAdded: () => Promise<void>
}

function getCandidateName(
  candidate: ApiResearchGroupMemberCandidate,
) {
  const fullName = [
    candidate.firstName,
    candidate.lastName,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    fullName ||
    candidate.username
  )
}

function getInitials(
  candidate: ApiResearchGroupMemberCandidate,
) {
  const parts = [
    candidate.firstName,
    candidate.lastName,
  ].filter(Boolean)

  if (parts.length > 0) {
    return parts
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase()
  }

  return candidate.username
    .slice(0, 2)
    .toUpperCase()
}

export function AddResearchGroupMemberDialog({
  open,
  researchGroupId,
  onClose,
  onAdded,
}: AddResearchGroupMemberDialogProps) {
  const [query, setQuery] =
    useState('')

  const [
    candidates,
    setCandidates,
  ] = useState<
    ApiResearchGroupMemberCandidate[]
  >([])

  const [
    selectedCandidateId,
    setSelectedCandidateId,
  ] = useState<number | null>(
    null,
  )

  const [role, setRole] =
    useState<ResearchGroupRole>(
      'member',
    )

  const [searching, setSearching] =
    useState(false)

  const [submitting, setSubmitting] =
    useState(false)

  const [error, setError] =
    useState<string | null>(null)

  const searchVersion =
    useRef(0)

  useEffect(() => {
    if (!open) {
      return
    }

    setQuery('')
    setCandidates([])
    setSelectedCandidateId(
      null,
    )
    setRole('member')
    setSearching(false)
    setSubmitting(false)
    setError(null)
    searchVersion.current += 1

    const handleKeyDown = (
      event: KeyboardEvent,
    ) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener(
      'keydown',
      handleKeyDown,
    )

    return () => {
      window.removeEventListener(
        'keydown',
        handleKeyDown,
      )
    }
  }, [open, onClose])

  useEffect(() => {
    if (!open) {
      return
    }

    const normalizedQuery =
      query.trim()

    if (
      normalizedQuery.length < 2
    ) {
      searchVersion.current += 1
      setCandidates([])
      setSelectedCandidateId(
        null,
      )
      setSearching(false)
      setError(null)
      return
    }

    const version =
      ++searchVersion.current

    const timeout =
      window.setTimeout(
        () => {
          setSearching(true)
          setError(null)

          void searchResearchGroupMemberCandidates(
            researchGroupId,
            normalizedQuery,
          )
            .then((results) => {
              if (
                searchVersion.current !==
                version
              ) {
                return
              }

              setCandidates(
                results,
              )

              setSelectedCandidateId(
                (current) =>
                  results.some(
                    (candidate) =>
                      candidate.id ===
                      current,
                  )
                    ? current
                    : null,
              )
            })
            .catch(() => {
              if (
                searchVersion.current !==
                version
              ) {
                return
              }

              setCandidates([])
              setError(
                'People could not be searched.',
              )
            })
            .finally(() => {
              if (
                searchVersion.current ===
                version
              ) {
                setSearching(
                  false,
                )
              }
            })
        },
        250,
      )

    return () => {
      window.clearTimeout(
        timeout,
      )
    }
  }, [
    open,
    query,
    researchGroupId,
  ])

  if (!open) {
    return null
  }

  const selectedCandidate =
    candidates.find(
      (candidate) =>
        candidate.id ===
        selectedCandidateId,
    ) ?? null

  const handleSubmit =
    async () => {
      if (
        !selectedCandidate ||
        submitting
      ) {
        return
      }

      setSubmitting(true)
      setError(null)

      try {
        await addResearchGroupMembership(
          researchGroupId,
          {
            userId:
              selectedCandidate.id,
            role,
          },
        )

        await onAdded()
        onClose()
      } catch {
        setError(
          'Member could not be added.',
        )
      } finally {
        setSubmitting(false)
      }
    }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay-scrim px-4 py-8 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (
          event.target ===
          event.currentTarget
        ) {
          onClose()
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-research-group-member-title"
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-border-structural bg-surface shadow-xl"
      >
        <header className="flex items-start justify-between border-b border-border-structural px-6 py-5">
          <div>
            <h2
              id="add-research-group-member-title"
              className="text-lg font-semibold tracking-tight text-text"
            >
              Add member
            </h2>

            <p className="mt-1 text-sm text-text-muted">
              Add an existing user to this research group.
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition hover:bg-surface-hover hover:text-text"
          >
            <span className="material-symbols-outlined text-[20px]">
              close
            </span>
          </button>
        </header>

        <div className="space-y-6 px-6 py-6">
          <div>
            <label
              htmlFor="research-group-member-search"
              className="block text-sm font-medium text-text"
            >
              Search person
            </label>

            <div className="relative mt-2">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-text-muted">
                search
              </span>

              <input
                id="research-group-member-search"
                type="search"
                autoFocus
                value={query}
                onChange={(event) =>
                  setQuery(
                    event.target.value,
                  )
                }
                placeholder="Name or username"
                className="h-10 w-full rounded-lg border border-border-field bg-surface pl-10 pr-3 text-sm text-text outline-none transition placeholder:text-text-muted/60 focus:border-focus focus:ring-2 focus:ring-focus/15"
              />
            </div>

            <div className="mt-2 min-h-20 overflow-hidden rounded-xl border border-border-subtle">
              {query.trim().length < 2 ? (
                <div className="px-4 py-5 text-sm text-text-muted">
                  Enter at least 2 characters.
                </div>
              ) : searching ? (
                <div className="flex items-center gap-2 px-4 py-5 text-sm text-text-muted">
                  <span className="material-symbols-outlined animate-spin text-[18px]">
                    refresh
                  </span>
                  Searching…
                </div>
              ) : candidates.length > 0 ? (
                <div className="divide-y divide-border-subtle">
                  {candidates.map(
                    (candidate) => {
                      const selected =
                        candidate.id ===
                        selectedCandidateId

                      return (
                        <button
                          key={
                            candidate.id
                          }
                          type="button"
                          onClick={() =>
                            setSelectedCandidateId(
                              candidate.id,
                            )
                          }
                          className={[
                            'flex w-full items-center gap-3 px-4 py-3 text-left transition',
                            selected
                              ? 'bg-option-selected-bg'
                              : 'hover:bg-surface-hover',
                          ].join(' ')}
                        >
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-muted text-[11px] font-semibold text-text">
                            {getInitials(
                              candidate,
                            )}
                          </div>

                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-text">
                              {getCandidateName(
                                candidate,
                              )}
                            </div>

                            <div className="truncate text-xs text-text-muted">
                              @
                              {
                                candidate.username
                              }
                            </div>
                          </div>

                          {selected && (
                            <span className="material-symbols-outlined text-[19px] text-action">
                              check_circle
                            </span>
                          )}
                        </button>
                      )
                    },
                  )}
                </div>
              ) : (
                <div className="px-4 py-5 text-sm text-text-muted">
                  No matching people found.
                </div>
              )}
            </div>
          </div>

          <fieldset>
            <legend className="text-sm font-medium text-text">
              Role
            </legend>

            <div className="mt-2 grid grid-cols-2 gap-3">
              {(
                [
                  [
                    'member',
                    'Member',
                  ],
                  [
                    'admin',
                    'Admin',
                  ],
                ] as const
              ).map(
                ([
                  value,
                  label,
                ]) => (
                  <label
                    key={value}
                    className={[
                      'flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition',
                      role === value
                        ? 'border-border-field bg-option-selected-bg'
                        : 'border-border-field hover:bg-surface-hover',
                    ].join(' ')}
                  >
                    <input
                      type="radio"
                      name="research-group-role"
                      value={value}
                      checked={
                        role === value
                      }
                      onChange={() =>
                        setRole(value)
                      }
                      className="accent-control-accent"
                    />

                    <span className="text-sm font-medium text-text">
                      {label}
                    </span>
                  </label>
                ),
              )}
            </div>
          </fieldset>

          {error && (
            <div
              role="alert"
              className="rounded-lg border border-danger/20 bg-danger/5 px-4 py-3 text-sm text-overview-error"
            >
              {error}
            </div>
          )}
        </div>

        <footer className="flex justify-end gap-3 border-t border-border-structural bg-surface-footer px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-lg px-4 text-sm font-medium text-text-muted transition hover:bg-surface-hover hover:text-text"
          >
            Cancel
          </button>

          <button
            type="button"
            disabled={
              !selectedCandidate ||
              submitting
            }
            onClick={() =>
              void handleSubmit()
            }
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-action px-4 text-sm font-semibold text-text-inverse transition hover:bg-action-hover disabled:cursor-not-allowed disabled:opacity-45"
          >
            <span
              aria-hidden="true"
              className="material-symbols-outlined text-[18px]"
            >
              person_add
            </span>

            {submitting
              ? 'Adding…'
              : 'Add member'}
          </button>
        </footer>
      </div>
    </div>
  )
}
