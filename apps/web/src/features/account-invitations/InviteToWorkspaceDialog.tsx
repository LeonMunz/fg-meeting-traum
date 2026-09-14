import {
  useCallback,
  useEffect,
  useState,
} from 'react'
import type { FormEvent } from 'react'
import { createPortal } from 'react-dom'

import { ApiError } from '../../api/client'
import { createAccountInvitation } from '../../api/account-invitations'

export type InviteToWorkspaceDialogProps = {
  open: boolean
  onClose: () => void
  /**
   * Called once after a successful creation so the caller can refresh
   * its invitation list. The dialog stays open on the result.
   */
  onCreated?: () => void
}

/** The one-time creation result. Holds only the constructed URL; the
 *  raw token is never stored outside component memory. */
interface OneTimeResult {
  invitationId: string
  invitedEmail: string
  registrationUrl: string
}

/**
 * Map authoritative backend create errors to user-facing dialog copy.
 * The backend remains the sole source of truth; no account or
 * pending-invitation checks are reimplemented client-side.
 */
function mapCreateError(error: unknown): string {
  if (error instanceof ApiError) {
    const detail =
      error.detail !== null && typeof error.detail === 'object'
        ? (error.detail as { code?: unknown })
        : null

    switch (detail?.code) {
      case 'invalid_email':
        return 'Enter a valid email address.'
      case 'account_exists':
        return 'This person already has an FG Workspace account.'
      case 'pending_invitation_exists':
        return 'An invitation for this email address is already pending.'
    }
  }

  return 'The invitation could not be created. Try again.'
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
 * Reusable "Invite to FG Workspace" dialog. Owns the email form, the
 * create request, error presentation, the one-time registration link
 * result with copy, and close/reset behavior. Callers only control
 * `open`, close the dialog, and get notified after a successful
 * creation; the dialog is deliberately independent of any route,
 * Settings layout, or user menu. The overlay is rendered into
 * document.body so the modal always fills and is centered in the
 * viewport regardless of the caller's mount location.
 */
export function InviteToWorkspaceDialog({
  open,
  onClose,
  onCreated,
}: InviteToWorkspaceDialogProps) {
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [result, setResult] = useState<OneTimeResult | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)

  // Closing is blocked while a create request is in flight.
  const requestClose = useCallback(() => {
    if (!submitting) {
      onClose()
    }
  }, [submitting, onClose])

  // Every open starts a fresh invitation interaction: no stale email,
  // error, or one-time result.
  useEffect(() => {
    if (!open) return

    setEmail('')
    setSubmitting(false)
    setCreateError(null)
    setResult(null)
    setCopied(false)
    setCopyError(null)
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

    const targetEmail = email.trim()
    if (!targetEmail) {
      setCreateError('Enter a valid email address.')
      return
    }

    setSubmitting(true)
    setCreateError(null)
    setCopied(false)
    setCopyError(null)

    try {
      const created = await createAccountInvitation(targetEmail)

      // The raw token arrives exactly once, only in this response.
      // It stays in component memory for the one-time result only and
      // is never written to browser storage or global state.
      setResult({
        invitationId: created.id,
        invitedEmail: created.invitedEmail,
        registrationUrl: `${window.location.origin}/register?token=${encodeURIComponent(created.token)}`,
      })
      onCreated?.()
    } catch (error) {
      setCreateError(mapCreateError(error))
    } finally {
      setSubmitting(false)
    }
  }

  const handleCopy = async () => {
    if (!result) return

    setCopyError(null)

    try {
      await navigator.clipboard.writeText(
        result.registrationUrl,
      )
      setCopied(true)
    } catch {
      setCopyError(
        'Could not copy the link automatically. Select and copy it manually.',
      )
    }
  }

  if (!open) {
    return null
  }

  // The modal boundary is location-independent: the overlay is portaled
  // to document.body so it is always positioned against the viewport,
  // no matter where the caller mounts this dialog. (An ancestor with a
  // non-none `filter`/`backdrop-filter`/`transform` would otherwise
  // become the containing block for the `fixed` overlay and clip the
  // dialog to that ancestor's box.)
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
        aria-labelledby="invite-to-workspace-title"
        className="relative w-[440px] max-w-[calc(100vw-48px)] rounded-lg border border-border-subtle bg-surface p-6 shadow-[0_20px_56px_rgba(0,0,0,0.42)]"
      >
        <h2
          id="invite-to-workspace-title"
          className="text-lg font-semibold leading-6 text-text"
        >
          Invite to FG Workspace
        </h2>

        <p className="mt-1 text-[13px] leading-5 text-text-muted">
          Invite someone to create an FG Workspace account.
          <span className="block">
            This does not grant access to research groups or projects.
          </span>
        </p>

        {result === null ? (
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
              htmlFor="invite-to-workspace-email"
              className="mb-1 block text-xs font-medium leading-[18px] text-text-muted"
            >
              Email
            </label>

            <input
              id="invite-to-workspace-email"
              type="email"
              autoComplete="email"
              required
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={createError ? true : undefined}
              aria-describedby={
                createError ? 'invite-to-workspace-email-error' : undefined
              }
              className="h-10 w-full rounded border border-border-default bg-surface-quiet px-3 text-sm text-text outline-none transition focus:border-accent focus:ring-2 focus:ring-focus/25"
            />

            {createError && (
              <p
                id="invite-to-workspace-email-error"
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
                {submitting ? 'Sending…' : 'Send invitation'}
              </button>
            </div>
          </form>
        ) : (
          <div role="status" className="mt-5">
            <p className="text-sm font-medium text-text">
              Invitation created
            </p>

            <p className="mt-0.5 text-sm text-text-muted">
              {result.invitedEmail}
            </p>

            <p className="mt-4 text-xs font-medium text-text-muted">
              Registration link
            </p>

            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded border border-border-subtle bg-surface-subtle px-2 py-1.5 text-xs text-text">
                {result.registrationUrl}
              </code>

              <button
                type="button"
                onClick={() => void handleCopy()}
                className={`${SECONDARY_BUTTON_CLASSES} shrink-0`}
              >
                <span
                  aria-hidden="true"
                  className="material-symbols-outlined text-[18px]"
                >
                  content_copy
                </span>
                Copy
              </button>
            </div>

            {copied && (
              <p
                role="status"
                className="mt-2 text-sm text-success-text"
              >
                Link copied to clipboard.
              </p>
            )}

            {copyError && (
              <p
                role="alert"
                className="mt-2 text-sm text-danger"
              >
                {copyError}
              </p>
            )}

            <p className="mt-3 text-xs text-text-muted">
              This link is shown only once. Share it with the invited
              person.
            </p>

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className={SECONDARY_BUTTON_CLASSES}
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
