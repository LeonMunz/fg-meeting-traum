import {
  useCallback,
  useEffect,
  useState,
} from 'react'

import { ApiError } from '../../api/client'
import {
  listAccountInvitations,
  revokeAccountInvitation,
} from '../../api/account-invitations'
import type {
  AccountInvitationStatus,
  ApiAccountInvitation,
} from '../../api/account-invitations'

import { InviteToWorkspaceDialog } from './InviteToWorkspaceDialog'

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

export function InvitationsSettingsPage() {
  const [invitations, setInvitations] = useState<
    ApiAccountInvitation[]
  >([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)

  const [inviteOpen, setInviteOpen] = useState(false)

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

      <button
        type="button"
        onClick={() => setInviteOpen(true)}
        className={[
          'mt-5 inline-flex h-[38px] items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-text-inverse shadow-sm transition',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
        ].join(' ')}
      >
        <span
          aria-hidden="true"
          className="material-symbols-outlined text-[18px]"
        >
          person_add
        </span>
        Invite person
      </button>

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

      <InviteToWorkspaceDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onCreated={() => {
          void refresh()
        }}
      />
    </section>
  )
}
