import {
  useCallback,
  useEffect,
  useState,
} from 'react'
import type { FormEvent } from 'react'
import { createPortal } from 'react-dom'

import { ApiError } from '../../api/client'
import { createResearchGroup } from '../../api/research-groups'
import type { ApiResearchGroup } from '../../api/types'

export type CreateResearchGroupDialogProps = {
  open: boolean
  onClose: () => void
  /**
   * Called exactly once after a successful creation with the exact
   * server-serialized Research Group (including the creator's role).
   * The caller is responsible for canonical state and navigation;
   * the dialog itself synthesizes no membership.
   */
  onCreated: (group: ApiResearchGroup) => void
}

/**
 * Map authoritative backend create errors to user-facing dialog copy.
 * The backend remains the sole source of truth for validation; no
 * naming rules are reimplemented client-side.
 */
function mapCreateError(error: unknown): string {
  if (error instanceof ApiError) {
    const detail =
      error.detail !== null && typeof error.detail === 'object'
        ? (error.detail as { error?: unknown })
        : null

    if (
      detail !== null &&
      typeof detail.error === 'string' &&
      detail.error.trim() !== ''
    ) {
      return detail.error
    }
  }

  return 'The research group could not be created. Try again.'
}

const PRIMARY_BUTTON_CLASSES = [
  'inline-flex h-8 items-center justify-center gap-2 rounded bg-accent px-3 text-[13px] font-medium leading-[18px] text-text-inverse transition',
  'hover:bg-accent-hover',
  'focus-visible:outline-2 focus-visible:outline focus-visible:outline-focus focus-visible:outline-offset-1',
  'disabled:cursor-not-allowed disabled:bg-action-disabled-bg disabled:text-text-tertiary',
].join(' ')

const SECONDARY_BUTTON_CLASSES = [
  'inline-flex h-8 items-center justify-center gap-1.5 rounded bg-transparent px-2.5 text-[13px] font-medium leading-[18px] text-text-muted transition hover:bg-surface-hover hover:text-text',
  'focus-visible:outline-2 focus-visible:outline focus-visible:outline-focus focus-visible:outline-offset-1',
  'disabled:cursor-not-allowed disabled:opacity-50',
].join(' ')

/**
 * Compact "Create research group" dialog. Owns the name form, the
 * canonical create request, error presentation, and close/reset
 * behavior. Every authenticated user may create a Research Group;
 * the server makes the creator its first Owner. The overlay is
 * portaled to document.body so the modal is always viewport-bound
 * and centered regardless of the caller's mount location.
 */
export function CreateResearchGroupDialog({
  open,
  onClose,
  onCreated,
}: CreateResearchGroupDialogProps) {
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // Closing is blocked while a create request is in flight.
  const requestClose = useCallback(() => {
    if (!submitting) {
      onClose()
    }
  }, [submitting, onClose])

  // Every open starts a fresh creation interaction: no stale name
  // or error.
  useEffect(() => {
    if (!open) return

    setName('')
    setSubmitting(false)
    setCreateError(null)
  }, [open])

  useEffect(() => {
    if (!open) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        requestClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () =>
      window.removeEventListener('keydown', handleKeyDown)
  }, [open, requestClose])

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (submitting) return

    const targetName = name.trim()
    if (!targetName) {
      setCreateError('Enter a research group name.')
      return
    }

    setSubmitting(true)
    setCreateError(null)

    try {
      const created = await createResearchGroup({
        name: targetName,
      })

      onCreated(created)
      onClose()
    } catch (error) {
      setCreateError(mapCreateError(error))
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) {
    return null
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay-scrim px-4 py-8 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          requestClose()
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-research-group-title"
        className="relative w-[440px] max-w-[calc(100vw-48px)] rounded-lg border border-border-subtle bg-surface p-6 shadow-[0_20px_56px_rgba(0,0,0,0.42)]"
      >
        <h2
          id="create-research-group-title"
          className="text-lg font-semibold leading-6 text-text"
        >
          Create research group
        </h2>

        <p className="mt-1 text-[13px] leading-5 text-text-muted">
          Create a new research group.
          <span className="block">
            You will be its owner.
          </span>
        </p>

        <form
          onSubmit={(event) => void handleSubmit(event)}
          noValidate
          className="mt-5"
        >
          <button
            type="button"
            aria-label="Close dialog"
            onClick={requestClose}
            disabled={submitting}
            className="absolute right-6 top-6 flex h-8 w-8 items-center justify-center rounded-lg text-text-muted outline-none transition hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
          >
            <span
              aria-hidden="true"
              className="material-symbols-outlined text-[20px]"
            >
              close
            </span>
          </button>

          <label
            htmlFor="create-research-group-name"
            className="mb-1 block text-xs font-medium leading-[18px] text-text-muted"
          >
            Research group name
          </label>

          <input
            id="create-research-group-name"
            type="text"
            autoComplete="off"
            required
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-invalid={createError ? true : undefined}
            aria-describedby={
              createError
                ? 'create-research-group-name-error'
                : undefined
            }
            className="h-10 w-full rounded border border-border-default bg-surface-quiet px-3 text-sm text-text outline-none transition focus:border-accent focus:ring-2 focus:ring-focus/25"
          />

          {createError && (
            <p
              id="create-research-group-name-error"
              role="alert"
              className="mt-2 text-sm text-danger"
            >
              {createError}
            </p>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              disabled={submitting}
              onClick={requestClose}
              className={SECONDARY_BUTTON_CLASSES}
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={submitting}
              className={PRIMARY_BUTTON_CLASSES}
            >
              {submitting && (
                <span
                  aria-hidden="true"
                  className="material-symbols-outlined animate-spin text-[16px]"
                >
                  refresh
                </span>
              )}
              {submitting ? 'Creating…' : 'Create research group'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}
