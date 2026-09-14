import {
  useCallback,
  useEffect,
  useState,
} from 'react'
import type { FormEvent } from 'react'

import { ApiError } from '../../api/client'
import {
  createAccountInvitation,
  listAccountInvitations,
  revokeAccountInvitation,
} from '../../api/account-invitations'
import type {
  AccountInvitationStatus,
  ApiAccountInvitation,
} from '../../api/account-invitations'

const STATUS_LABELS: Record<AccountInvitationStatus, string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  revoked: 'Revoked',
  expired: 'Expired',
}

function formatDate(value: string): string {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
  }).format(date)
}

function apiErrorMessage(error: ApiError): string {
  const detail =
    error.detail && typeof error.detail === 'object'
      ? (error.detail as { error?: string }).error
      : undefined

  return detail ?? `Request failed (${error.status}).`
}

/** The one-time creation result. Holds only the constructed URL; the
 *  raw token is never stored outside component memory. */
interface OneTimeResult {
  invitationId: string
  invitedEmail: string
  expiresAt: string
  registrationUrl: string
}

export function InvitationsSettingsPage() {
  const [invitations, setInvitations] = useState<
    ApiAccountInvitation[]
  >([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)

  const [email, setEmail] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [oneTime, setOneTime] = useState<OneTimeResult | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)

  const [revokeTarget, setRevokeTarget] = useState<
    ApiAccountInvitation | null
  >(null)
  const [revoking, setRevoking] = useState(false)
  const [revokeError, setRevokeError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const data = await listAccountInvitations()
      setInvitations(data.invitations)
      setListError(null)
    } catch {
      setListError('Could not load your invitations.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault()
    if (creating) return

    const targetEmail = email.trim()
    if (!targetEmail) {
      setCreateError('Enter an email address.')
      return
    }

    setCreating(true)
    setCreateError(null)
    setCopied(false)
    setCopyError(null)

    try {
      const created = await createAccountInvitation(targetEmail)

      // The raw token arrives exactly once, only in this response.
      // It stays in component memory for the one-time result only and
      // is never written to browser storage or global state.
      setOneTime({
        invitationId: created.id,
        invitedEmail: created.invitedEmail,
        expiresAt: created.expiresAt,
        registrationUrl: `${window.location.origin}/register?token=${encodeURIComponent(created.token)}`,
      })
      setEmail('')
      await refresh()
    } catch (error) {
      setCreateError(
        error instanceof ApiError
          ? apiErrorMessage(error)
          : 'Could not create the invitation. Please try again.',
      )
    } finally {
      setCreating(false)
    }
  }

  const handleCopy = async () => {
    if (!oneTime) return

    setCopyError(null)

    try {
      await navigator.clipboard.writeText(
        oneTime.registrationUrl,
      )
      setCopied(true)
    } catch {
      setCopyError(
        'Could not copy the link automatically. Select and copy it manually.',
      )
    }
  }

  const openRevoke = (invitation: ApiAccountInvitation) => {
    setRevokeTarget(invitation)
    setRevokeError(null)
    setRevoking(false)
  }

  const closeRevoke = () => {
    if (!revoking) {
      setRevokeTarget(null)
    }
  }

  const handleRevokeConfirm = async () => {
    if (!revokeTarget || revoking) return

    setRevoking(true)
    setRevokeError(null)

    try {
      await revokeAccountInvitation(revokeTarget.id)
      setRevokeTarget(null)
      // The revoked invitation's link is unusable; do not leave a
      // stale "copy link" action for it.
      setOneTime((current) =>
        current && current.invitationId === revokeTarget.id
          ? null
          : current,
      )
      setCopied(false)
      setCopyError(null)
      await refresh()
    } catch (error) {
      setRevokeError(
        error instanceof ApiError
          ? apiErrorMessage(error)
          : 'Could not revoke the invitation. Please try again.',
      )
    } finally {
      setRevoking(false)
    }
  }

  return (
    <section
      aria-labelledby="invitations-heading"
    >
      <div>
        <h2
          id="invitations-heading"
          className="text-lg font-semibold text-text"
        >
          Invitations
        </h2>

        <p className="mt-1 text-sm text-text-muted">
          Manage invitations you have created for FG Workspace.
          Invitations create accounts only and do not grant
          research group or project access.
        </p>
      </div>

      <form
        onSubmit={handleCreate}
        noValidate
        className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end"
      >
        <div className="grow">
          <label
            htmlFor="invite-email"
            className="mb-1 block text-sm font-medium text-text"
          >
            Email address
          </label>

          <input
            id="invite-email"
            type="email"
            autoComplete="off"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={createError ? true : undefined}
            aria-describedby={
              createError ? 'invite-email-error' : undefined
            }
            placeholder="name@example.com"
            className="w-full rounded-lg border border-border-default bg-surface-subtle px-3 py-2 text-sm text-text outline-none transition focus:border-accent focus:ring-2 focus:ring-focus/25"
          />
        </div>

        <button
          type="submit"
          disabled={creating || !email.trim()}
          className={[
            'inline-flex h-[38px] items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-text-inverse shadow-sm transition',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'sm:shrink-0',
          ].join(' ')}
        >
          {creating && (
            <span
              aria-hidden="true"
              className="material-symbols-outlined animate-spin text-[18px]"
            >
              refresh
            </span>
          )}
          {creating ? 'Creating…' : 'Create invitation'}
        </button>
      </form>

      {createError && (
        <p
          id="invite-email-error"
          role="alert"
          className="mt-2 text-sm text-danger"
        >
          {createError}
        </p>
      )}

      {oneTime && (
        <div
          role="status"
          className="mt-4 rounded-lg border border-border-subtle bg-surface-subtle p-4"
        >
          <p className="text-sm font-medium text-text">
            Invitation created for {oneTime.invitedEmail}.
          </p>

          <p className="mt-1 text-sm text-text-muted">
            Expires {formatDate(oneTime.expiresAt)}.
          </p>

          <p className="mt-3 text-xs text-text-muted">
            Copy this link now — it is shown only once and cannot be
            recovered after this page is closed or reloaded.
          </p>

          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 truncate rounded border border-border-subtle bg-surface px-2 py-1.5 text-xs text-text">
              {oneTime.registrationUrl}
            </code>

            <button
              type="button"
              onClick={() => void handleCopy()}
              className={[
                'inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border-default bg-surface px-3.5 text-sm font-medium text-text transition hover:bg-surface-hover',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-subtle',
              ].join(' ')}
            >
              <span
                aria-hidden="true"
                className="material-symbols-outlined text-[18px]"
              >
                content_copy
              </span>
              Copy invitation link
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
        </div>
      )}

      <div className="mt-6">
        <h3 className="text-sm font-medium text-text-muted">
          Your invitations
        </h3>

        {loading ? (
          <p
            role="status"
            className="mt-3 text-sm text-text-muted"
          >
            Loading invitations…
          </p>
        ) : invitations.length === 0 ? (
          listError ? (
            <p
              role="alert"
              className="mt-3 text-sm text-danger"
            >
              {listError}
            </p>
          ) : (
            <p className="mt-3 text-sm text-text-muted">
              No invitations yet. Invite a colleague above.
            </p>
          )
        ) : (
          <>
            <ul className="mt-2 divide-y divide-border-subtle rounded-lg border border-border-subtle">
              {invitations.map((invitation) => (
                <li
                  key={invitation.id}
                  className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text">
                      {invitation.invitedEmail}
                    </p>

                    <p className="mt-0.5 text-xs text-text-muted">
                      <span>{STATUS_LABELS[invitation.status]}</span>
                      {' · Created '}
                      {formatDate(invitation.createdAt)}
                      {(invitation.status === 'pending' ||
                        invitation.status === 'expired') && (
                        <>
                          {' · Expires '}
                          {formatDate(invitation.expiresAt)}
                        </>
                      )}
                    </p>
                  </div>

                  {invitation.status === 'pending' && (
                    <button
                      type="button"
                      aria-label={`Revoke invitation to ${invitation.invitedEmail}`}
                      onClick={() => openRevoke(invitation)}
                      className={[
                        'inline-flex h-8 shrink-0 items-center justify-center rounded-lg px-3 text-sm font-medium text-danger transition hover:bg-danger-subtle',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
                      ].join(' ')}
                    >
                      Revoke
                    </button>
                  )}
                </li>
              ))}
            </ul>

            {listError && (
              <p
                role="alert"
                className="mt-2 text-sm text-danger"
              >
                {listError}
              </p>
            )}
          </>
        )}
      </div>

      {revokeTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-overlay-scrim px-4 py-8 backdrop-blur-[2px]"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeRevoke()
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="revoke-invitation-title"
            className="w-full max-w-md overflow-hidden rounded-2xl border border-border-subtle bg-surface shadow-xl"
          >
            <div className="px-6 py-5">
              <h3
                id="revoke-invitation-title"
                className="text-lg font-semibold tracking-tight text-text"
              >
                Revoke invitation?
              </h3>

              <p className="mt-2 text-sm text-text-muted">
                This revokes the pending invitation for{' '}
                <span className="font-medium text-text">
                  {revokeTarget.invitedEmail}
                </span>
                . Its registration link stops working immediately.
              </p>

              {revokeError && (
                <p
                  role="alert"
                  className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger"
                >
                  {revokeError}
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-border-subtle px-6 py-4">
              <button
                type="button"
                disabled={revoking}
                onClick={closeRevoke}
                className="inline-flex h-9 items-center rounded-lg px-3.5 text-sm font-medium text-text-muted outline-none transition hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60"
              >
                Cancel
              </button>

              <button
                type="button"
                disabled={revoking}
                onClick={() => void handleRevokeConfirm()}
                className={[
                  'inline-flex h-9 items-center gap-1.5 rounded-lg bg-danger px-3.5 text-sm font-semibold text-white outline-none transition hover:bg-danger/80',
                  'focus-visible:ring-2 focus-visible:ring-danger focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
                  'disabled:opacity-60',
                ].join(' ')}
              >
                {revoking && (
                  <span
                    aria-hidden="true"
                    className="material-symbols-outlined animate-spin text-[18px]"
                  >
                    refresh
                  </span>
                )}
                {revoking ? 'Revoking…' : 'Revoke invitation'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
