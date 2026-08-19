import { useEffect, useState } from 'react'

export type AssignmentResolutionMode =
  | 'transfer'
  | 'unassign'

export type AssignmentResolutionCandidate = {
  id: string
  name: string
  username: string
  initials: string
}

type AssignmentResolutionAction =
  | 'viewer'
  | 'remove'

type ProjectAssignmentResolutionDialogProps = {
  open: boolean
  action: AssignmentResolutionAction
  memberName: string
  affectedCount: number
  candidates: AssignmentResolutionCandidate[]
  onClose: () => void
  onConfirm: (input: {
    resolution: AssignmentResolutionMode
    replacementUserId: string | null
  }) => Promise<void>
}

export function ProjectAssignmentResolutionDialog({
  open,
  action,
  memberName,
  affectedCount,
  candidates,
  onClose,
  onConfirm,
}: ProjectAssignmentResolutionDialogProps) {
  const [resolution, setResolution] =
    useState<AssignmentResolutionMode>('transfer')
  const [replacementUserId, setReplacementUserId] =
    useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] =
    useState<string | null>(null)

  const hasTransferCandidates =
    candidates.length > 0

  useEffect(() => {
    if (!open) return

    setResolution(
      candidates.length > 0
        ? 'transfer'
        : 'unassign',
    )
    setReplacementUserId(null)
    setSubmitting(false)
    setSubmitError(null)
  }, [open, candidates.length])

  useEffect(() => {
    if (!open) return

    const handleKeyDown = (event: KeyboardEvent) => {
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
  }, [open, onClose, submitting])

  if (!open) {
    return null
  }

  const itemLabel =
    affectedCount === 1
      ? 'work item'
      : 'work items'

  const canSubmit =
    !submitting &&
    (
      resolution === 'unassign' ||
      replacementUserId !== null
    )

  const handleSubmit = async () => {
    if (!canSubmit) return

    setSubmitting(true)
    setSubmitError(null)

    try {
      await onConfirm({
        resolution,
        replacementUserId:
          resolution === 'transfer'
            ? replacementUserId
            : null,
      })
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : 'Assignments could not be resolved.',
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
          event.target === event.currentTarget &&
          !submitting
        ) {
          onClose()
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-assignment-resolution-title"
        aria-describedby="project-assignment-resolution-description"
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-lowest shadow-xl"
      >
        <div className="border-b border-outline-variant px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2
                id="project-assignment-resolution-title"
                className="text-lg font-semibold tracking-tight text-on-surface"
              >
                Resolve assigned work
              </h2>

              <p
                id="project-assignment-resolution-description"
                className="mt-1 text-sm leading-6 text-on-surface-variant"
              >
                <span className="font-medium text-on-surface">
                  {memberName}
                </span>{' '}
                is assigned to {affectedCount}{' '}
                {itemLabel}. Choose what should happen
                before{' '}
                {action === 'remove'
                  ? 'removing this member'
                  : 'changing this member to viewer'}.
              </p>
            </div>

            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              aria-label="Close dialog"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span
                aria-hidden="true"
                className="material-symbols-outlined text-[20px]"
              >
                close
              </span>
            </button>
          </div>
        </div>

        <div className="space-y-3 px-6 py-6">
          <div
            className={[
              'block rounded-xl border px-4 py-4 transition',
              hasTransferCandidates
                ? 'cursor-pointer'
                : 'cursor-not-allowed opacity-55',
              resolution === 'transfer' &&
              hasTransferCandidates
                ? 'border-primary bg-primary-fixed/35 ring-1 ring-primary/15'
                : 'border-outline-variant',
            ].join(' ')}
          >
            <label
              htmlFor="assignment-resolution-transfer"
              className="flex cursor-pointer items-start gap-3"
            >
              <input
                id="assignment-resolution-transfer"
                type="radio"
                name="assignment-resolution"
                value="transfer"
                checked={
                  resolution === 'transfer'
                }
                disabled={
                  !hasTransferCandidates ||
                  submitting
                }
                onChange={() =>
                  setResolution('transfer')
                }
                className="mt-1"
              />

              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-on-surface">
                  Transfer work
                </div>

                <p className="mt-1 text-xs leading-5 text-on-surface-variant">
                  Move{' '}
                  {affectedCount === 1
                    ? 'this assignment'
                    : 'these assignments'}{' '}
                  to another project member.
                </p>

                {!hasTransferCandidates && (
                  <p className="mt-2 text-xs font-medium text-on-surface-variant">
                    No other owner or member is
                    available.
                  </p>
                )}
              </div>
            </label>

            {resolution === 'transfer' &&
              hasTransferCandidates && (
                <div className="mt-4 pl-7">
                  <label
                    htmlFor="assignment-replacement-user"
                    className="mb-1.5 block text-xs font-medium text-on-surface"
                  >
                    Transfer to
                  </label>

                  <select
                    id="assignment-replacement-user"
                    value={
                      replacementUserId ?? ''
                    }
                    disabled={submitting}
                    onChange={(event) =>
                      setReplacementUserId(
                        event.target.value || null,
                      )
                    }
                    className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <option value="">
                      Select a project member
                    </option>

                    {candidates.map(
                      (candidate) => (
                        <option
                          key={candidate.id}
                          value={candidate.id}
                        >
                          {candidate.name} (@
                          {candidate.username})
                        </option>
                      ),
                    )}
                  </select>
                </div>
              )}
          </div>

          <label
            className={[
              'block cursor-pointer rounded-xl border px-4 py-4 transition',
              resolution === 'unassign'
                ? 'border-primary bg-primary-fixed/35 ring-1 ring-primary/15'
                : 'border-outline-variant hover:bg-surface-container-low',
            ].join(' ')}
          >
            <div className="flex items-start gap-3">
              <input
                type="radio"
                name="assignment-resolution"
                value="unassign"
                checked={
                  resolution === 'unassign'
                }
                disabled={submitting}
                onChange={() =>
                  setResolution('unassign')
                }
                className="mt-1"
              />

              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-on-surface">
                  Leave work unassigned
                </div>

                <p className="mt-1 text-xs leading-5 text-on-surface-variant">
                  Remove {memberName} from{' '}
                  {affectedCount === 1
                    ? 'this assignment'
                    : 'these assignments'}.
                  The work stays in the project
                  without a replacement.
                </p>
              </div>
            </div>
          </label>

          {submitError && (
            <div
              role="alert"
              className="rounded-lg bg-error-container px-4 py-3 text-sm text-error"
            >
              {submitError}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-outline-variant bg-surface-container-low/45 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="h-9 rounded-lg px-4 text-sm font-medium text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>

          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className={[
              'inline-flex h-9 items-center justify-center rounded-lg px-4 text-sm font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-45',
              action === 'remove'
                ? 'bg-error hover:opacity-90'
                : 'bg-primary hover:bg-primary/90',
            ].join(' ')}
          >
            {submitting
              ? 'Saving…'
              : action === 'remove'
                ? 'Remove member'
                : 'Make viewer'}
          </button>
        </div>
      </div>
    </div>
  )
}
