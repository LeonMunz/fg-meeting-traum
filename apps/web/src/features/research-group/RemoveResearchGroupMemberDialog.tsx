import {
  useEffect,
  useMemo,
  useState,
} from 'react'

import { ApiError } from '../../api/client'
import {
  getResearchGroupMemberOffboardingPreview,
  offboardResearchGroupMember,
} from '../../api/research-groups'
import type {
  ApiResearchGroupMemberOffboardingInput,
  ApiResearchGroupMemberOffboardingPreview,
  ApiResearchGroupMembership,
  ApiResearchGroupOffboardingCandidate,
} from '../../api/types'

type AssignmentMode =
  | ''
  | 'transfer'
  | 'unassign'

type OwnershipMode =
  | ''
  | 'transfer'
  | 'archive'

type ProjectResolutionDraft = {
  assignmentMode: AssignmentMode
  assignmentReplacementUserId: string
  ownershipMode: OwnershipMode
  ownershipReplacementUserId: string
}

type ResolutionDrafts =
  Record<number, ProjectResolutionDraft>

type RemoveResearchGroupMemberDialogProps = {
  open: boolean
  researchGroupId: number
  membership: ApiResearchGroupMembership | null
  onClose: () => void
  onRemoved: () => Promise<void>
}

function getErrorMessage(
  error: unknown,
  fallback: string,
) {
  if (
    error instanceof ApiError &&
    error.detail &&
    typeof error.detail === 'object' &&
    'error' in error.detail
  ) {
    const detail = error.detail as {
      error?: unknown
    }

    if (
      typeof detail.error === 'string'
    ) {
      return detail.error
    }
  }

  if (
    error instanceof Error &&
    error.message
  ) {
    return error.message
  }

  return fallback
}

function getPersonName(
  person: {
    username: string
    firstName: string
    lastName: string
  },
) {
  const fullName = [
    person.firstName,
    person.lastName,
  ]
    .filter(Boolean)
    .join(' ')
    .trim()

  return fullName || person.username
}

function getCandidateLabel(
  candidate:
    ApiResearchGroupOffboardingCandidate,
) {
  const name = getPersonName(candidate)

  return `${name} (@${candidate.username})`
}

function createInitialDrafts(
  preview:
    ApiResearchGroupMemberOffboardingPreview,
): ResolutionDrafts {
  return Object.fromEntries(
    preview.projects.map(
      (project) => [
        project.projectId,
        {
          assignmentMode: '',
          assignmentReplacementUserId: '',
          ownershipMode: '',
          ownershipReplacementUserId: '',
        },
      ],
    ),
  )
}

export function RemoveResearchGroupMemberDialog({
  open,
  researchGroupId,
  membership,
  onClose,
  onRemoved,
}: RemoveResearchGroupMemberDialogProps) {
  const [
    preview,
    setPreview,
  ] = useState<
    ApiResearchGroupMemberOffboardingPreview | null
  >(null)

  const [
    drafts,
    setDrafts,
  ] = useState<ResolutionDrafts>({})

  const [
    loading,
    setLoading,
  ] = useState(false)

  const [
    submitting,
    setSubmitting,
  ] = useState(false)

  const [
    error,
    setError,
  ] = useState<string | null>(null)

  useEffect(() => {
    if (
      !open ||
      membership == null
    ) {
      return
    }

    let cancelled = false

    setPreview(null)
    setDrafts({})
    setError(null)
    setLoading(true)
    setSubmitting(false)

    const load = async () => {
      try {
        const nextPreview =
          await getResearchGroupMemberOffboardingPreview(
            researchGroupId,
            membership.id,
          )

        if (cancelled) {
          return
        }

        setPreview(nextPreview)
        setDrafts(
          createInitialDrafts(
            nextPreview,
          ),
        )
      } catch (loadError) {
        if (!cancelled) {
          setError(
            getErrorMessage(
              loadError,
              'Member responsibilities could not be loaded.',
            ),
          )
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [
    membership,
    open,
    researchGroupId,
  ])

  useEffect(() => {
    if (!open) {
      return
    }

    const handleKeyDown = (
      event: KeyboardEvent,
    ) => {
      if (
        event.key === 'Escape' &&
        !submitting
      ) {
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
  }, [
    onClose,
    open,
    submitting,
  ])

  const projectsNeedingAttention =
    useMemo(
      () =>
        preview?.projects.filter(
          (project) =>
            project.assignmentCount > 0 ||
            project.requiresOwnershipResolution,
        ) ?? [],
      [preview],
    )

  const canSubmit = useMemo(() => {
    if (
      preview == null ||
      preview.finalResearchGroupAdmin ||
      loading ||
      submitting
    ) {
      return false
    }

    return preview.projects.every(
      (project) => {
        const draft =
          drafts[project.projectId]

        if (!draft) {
          return false
        }

        if (
          project.assignmentCount > 0
        ) {
          if (
            draft.assignmentMode ===
            ''
          ) {
            return false
          }

          if (
            draft.assignmentMode ===
              'transfer' &&
            !draft
              .assignmentReplacementUserId
          ) {
            return false
          }
        }

        if (
          project
            .requiresOwnershipResolution
        ) {
          if (
            draft.ownershipMode ===
            ''
          ) {
            return false
          }

          if (
            draft.ownershipMode ===
              'transfer' &&
            !draft
              .ownershipReplacementUserId
          ) {
            return false
          }
        }

        return true
      },
    )
  }, [
    drafts,
    loading,
    preview,
    submitting,
  ])

  if (
    !open ||
    membership == null
  ) {
    return null
  }

  const memberName =
    getPersonName(membership.user)

  const updateDraft = (
    projectId: number,
    update:
      Partial<ProjectResolutionDraft>,
  ) => {
    setDrafts((current) => ({
      ...current,
      [projectId]: {
        ...current[projectId],
        ...update,
      },
    }))
  }

  const handleSubmit = async () => {
    if (
      !preview ||
      !canSubmit
    ) {
      return
    }

    const input:
      ApiResearchGroupMemberOffboardingInput =
      {
        projects:
          preview.projects.map(
            (project) => {
              const draft =
                drafts[
                  project.projectId
                ]

              const resolution:
                ApiResearchGroupMemberOffboardingInput['projects'][number] =
                {
                  projectId:
                    project.projectId,
                }

              if (
                project.assignmentCount >
                0
              ) {
                if (
                  draft.assignmentMode ===
                  'transfer'
                ) {
                  resolution.assignmentResolution =
                    {
                      mode: 'transfer',
                      replacementUserId:
                        Number(
                          draft
                            .assignmentReplacementUserId,
                        ),
                    }
                } else {
                  resolution.assignmentResolution =
                    {
                      mode: 'unassign',
                    }
                }
              }

              if (
                project
                  .requiresOwnershipResolution
              ) {
                if (
                  draft.ownershipMode ===
                  'transfer'
                ) {
                  resolution.ownershipResolution =
                    {
                      mode: 'transfer',
                      replacementUserId:
                        Number(
                          draft
                            .ownershipReplacementUserId,
                        ),
                    }
                } else {
                  resolution.ownershipResolution =
                    {
                      mode: 'archive',
                    }
                }
              }

              return resolution
            },
          ),
      }

    setSubmitting(true)
    setError(null)

    try {
      await offboardResearchGroupMember(
        researchGroupId,
        membership.id,
        input,
      )

      await onRemoved()
      onClose()
    } catch (submitError) {
      setError(
        getErrorMessage(
          submitError,
          'Member could not be removed.',
        ),
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-on-surface/25 px-4 py-8 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (
          event.target ===
            event.currentTarget &&
          !submitting
        ) {
          onClose()
        }
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="remove-research-group-member-title"
        aria-describedby="remove-research-group-member-description"
        className="flex max-h-[calc(100vh-4rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-lowest shadow-xl"
      >
        <header className="flex items-start justify-between border-b border-outline-variant px-6 py-5">
          <div>
            <h2
              id="remove-research-group-member-title"
              className="text-lg font-semibold tracking-tight text-on-surface"
            >
              Remove member
            </h2>

            <p
              id="remove-research-group-member-description"
              className="mt-1 text-sm text-on-surface-variant"
            >
              Remove {memberName} from this
              research group.
            </p>
          </div>

          <button
            type="button"
            aria-label="Close dialog"
            disabled={submitting}
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface disabled:opacity-45"
          >
            <span className="material-symbols-outlined text-[20px]">
              close
            </span>
          </button>
        </header>

        <div className="overflow-y-auto px-6 py-6">
          {loading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-on-surface-variant">
              <span className="material-symbols-outlined animate-spin text-[19px]">
                refresh
              </span>
              Checking current responsibilities…
            </div>
          ) : preview ? (
            <div className="space-y-5">
              {preview.finalResearchGroupAdmin ? (
                <div
                  role="alert"
                  className="rounded-xl border border-error/25 bg-error/5 px-4 py-4"
                >
                  <div className="text-sm font-semibold text-on-surface">
                    Another admin is required
                  </div>

                  <p className="mt-1 text-sm text-on-surface-variant">
                    {memberName} is the final
                    research group admin. Make
                    another member an admin before
                    removing them.
                  </p>
                </div>
              ) : (
                <>
                  <div className="rounded-xl border border-outline-variant bg-surface-container-low px-4 py-4">
                    <div className="text-sm font-medium text-on-surface">
                      {preview.projects.length ===
                      0
                        ? 'No project responsibilities'
                        : `Access to ${preview.projects.length} ${
                            preview.projects
                              .length === 1
                              ? 'project'
                              : 'projects'
                          } will be removed.`}
                    </div>

                    <p className="mt-1 text-sm text-on-surface-variant">
                      Historical authorship and
                      activity are preserved.
                    </p>
                  </div>

                  {projectsNeedingAttention.length >
                    0 && (
                    <div>
                      <h3 className="text-sm font-semibold text-on-surface">
                        Resolve current
                        responsibilities
                      </h3>

                      <p className="mt-1 text-sm text-on-surface-variant">
                        Only projects that need a
                        decision are shown below.
                      </p>
                    </div>
                  )}

                  {projectsNeedingAttention.map(
                    (project) => {
                      const draft =
                        drafts[
                          project.projectId
                        ]

                      if (!draft) {
                        return null
                      }

                      return (
                        <section
                          key={
                            project.projectId
                          }
                          className="rounded-xl border border-outline-variant px-4 py-4"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <h4 className="text-sm font-semibold text-on-surface">
                              {project.name}
                            </h4>

                            {project.archivedAt && (
                              <span className="rounded-full bg-surface-container-high px-2 py-0.5 text-[11px] font-medium text-on-surface-variant">
                                Archived
                              </span>
                            )}
                          </div>

                          {project.assignmentCount >
                            0 && (
                            <fieldset className="mt-4">
                              <legend className="text-sm font-medium text-on-surface">
                                Assigned work
                              </legend>

                              <p className="mt-1 text-xs text-on-surface-variant">
                                {
                                  project.assignmentCount
                                }{' '}
                                {project.assignmentCount ===
                                1
                                  ? 'work item is'
                                  : 'work items are'}{' '}
                                currently assigned to{' '}
                                {memberName}.
                              </p>

                              <div className="mt-3 space-y-3">
                                {project
                                  .assignmentCandidates
                                  .length >
                                  0 && (
                                  <label className="flex items-start gap-3">
                                    <input
                                      type="radio"
                                      name={`assignment-${project.projectId}`}
                                      checked={
                                        draft.assignmentMode ===
                                        'transfer'
                                      }
                                      onChange={() =>
                                        updateDraft(
                                          project.projectId,
                                          {
                                            assignmentMode:
                                              'transfer',
                                          },
                                        )
                                      }
                                      className="mt-0.5"
                                    />

                                    <span className="min-w-0 flex-1">
                                      <span className="block text-sm font-medium text-on-surface">
                                        Transfer
                                        assignments
                                      </span>

                                      {draft.assignmentMode ===
                                        'transfer' && (
                                        <select
                                          aria-label={`Transfer assignments in ${project.name} to`}
                                          value={
                                            draft.assignmentReplacementUserId
                                          }
                                          onChange={(
                                            event,
                                          ) =>
                                            updateDraft(
                                              project.projectId,
                                              {
                                                assignmentReplacementUserId:
                                                  event
                                                    .target
                                                    .value,
                                              },
                                            )
                                          }
                                          className="mt-2 h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus:border-primary"
                                        >
                                          <option value="">
                                            Select
                                            person…
                                          </option>

                                          {project.assignmentCandidates.map(
                                            (
                                              candidate,
                                            ) => (
                                              <option
                                                key={
                                                  candidate.id
                                                }
                                                value={
                                                  candidate.id
                                                }
                                              >
                                                {getCandidateLabel(
                                                  candidate,
                                                )}
                                              </option>
                                            ),
                                          )}
                                        </select>
                                      )}
                                    </span>
                                  </label>
                                )}

                                <label className="flex items-start gap-3">
                                  <input
                                    type="radio"
                                    name={`assignment-${project.projectId}`}
                                    checked={
                                      draft.assignmentMode ===
                                      'unassign'
                                    }
                                    onChange={() =>
                                      updateDraft(
                                        project.projectId,
                                        {
                                          assignmentMode:
                                            'unassign',
                                          assignmentReplacementUserId:
                                            '',
                                        },
                                      )
                                    }
                                    className="mt-0.5"
                                  />

                                  <span>
                                    <span className="block text-sm font-medium text-on-surface">
                                      Leave work
                                      unassigned
                                    </span>
                                    <span className="mt-0.5 block text-xs text-on-surface-variant">
                                      Other
                                      assignees stay
                                      unchanged.
                                    </span>
                                  </span>
                                </label>
                              </div>
                            </fieldset>
                          )}

                          {project
                            .requiresOwnershipResolution && (
                            <fieldset
                              className={
                                project.assignmentCount >
                                0
                                  ? 'mt-5 border-t border-outline-variant pt-5'
                                  : 'mt-4'
                              }
                            >
                              <legend className="text-sm font-medium text-on-surface">
                                Project
                                ownership
                              </legend>

                              <p className="mt-1 text-xs text-on-surface-variant">
                                {memberName} is
                                the only owner of
                                this active
                                project.
                              </p>

                              <div className="mt-3 space-y-3">
                                {project
                                  .ownershipCandidates
                                  .length >
                                  0 && (
                                  <label className="flex items-start gap-3">
                                    <input
                                      type="radio"
                                      name={`ownership-${project.projectId}`}
                                      checked={
                                        draft.ownershipMode ===
                                        'transfer'
                                      }
                                      onChange={() =>
                                        updateDraft(
                                          project.projectId,
                                          {
                                            ownershipMode:
                                              'transfer',
                                          },
                                        )
                                      }
                                      className="mt-0.5"
                                    />

                                    <span className="min-w-0 flex-1">
                                      <span className="block text-sm font-medium text-on-surface">
                                        Transfer
                                        ownership
                                      </span>

                                      {draft.ownershipMode ===
                                        'transfer' && (
                                        <select
                                          aria-label={`Transfer ownership of ${project.name} to`}
                                          value={
                                            draft.ownershipReplacementUserId
                                          }
                                          onChange={(
                                            event,
                                          ) =>
                                            updateDraft(
                                              project.projectId,
                                              {
                                                ownershipReplacementUserId:
                                                  event
                                                    .target
                                                    .value,
                                              },
                                            )
                                          }
                                          className="mt-2 h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus:border-primary"
                                        >
                                          <option value="">
                                            Select
                                            person…
                                          </option>

                                          {project.ownershipCandidates.map(
                                            (
                                              candidate,
                                            ) => (
                                              <option
                                                key={
                                                  candidate.id
                                                }
                                                value={
                                                  candidate.id
                                                }
                                              >
                                                {getCandidateLabel(
                                                  candidate,
                                                )}
                                              </option>
                                            ),
                                          )}
                                        </select>
                                      )}
                                    </span>
                                  </label>
                                )}

                                <label className="flex items-start gap-3">
                                  <input
                                    type="radio"
                                    name={`ownership-${project.projectId}`}
                                    checked={
                                      draft.ownershipMode ===
                                      'archive'
                                    }
                                    onChange={() =>
                                      updateDraft(
                                        project.projectId,
                                        {
                                          ownershipMode:
                                            'archive',
                                          ownershipReplacementUserId:
                                            '',
                                        },
                                      )
                                    }
                                    className="mt-0.5"
                                  />

                                  <span>
                                    <span className="block text-sm font-medium text-on-surface">
                                      Archive project
                                    </span>
                                    <span className="mt-0.5 block text-xs text-on-surface-variant">
                                      Preserve its
                                      work and
                                      history.
                                    </span>
                                  </span>
                                </label>
                              </div>
                            </fieldset>
                          )}
                        </section>
                      )
                    },
                  )}
                </>
              )}

              {error && (
                <div
                  role="alert"
                  className="rounded-lg border border-error/20 bg-error/5 px-4 py-3 text-sm text-error"
                >
                  {error}
                </div>
              )}
            </div>
          ) : error ? (
            <div
              role="alert"
              className="rounded-lg border border-error/20 bg-error/5 px-4 py-3 text-sm text-error"
            >
              {error}
            </div>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-3 border-t border-outline-variant px-6 py-4">
          <button
            type="button"
            disabled={submitting}
            onClick={onClose}
            className="inline-flex h-9 items-center justify-center rounded-lg border border-outline-variant px-4 text-sm font-semibold text-on-surface transition hover:bg-surface-container-low disabled:opacity-45"
          >
            Cancel
          </button>

          <button
            type="button"
            disabled={!canSubmit}
            onClick={() =>
              void handleSubmit()
            }
            className="inline-flex h-9 items-center justify-center rounded-lg bg-error px-4 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting
              ? 'Removing…'
              : 'Remove member'}
          </button>
        </footer>
      </div>
    </div>
  )
}
