import { apiGet, apiPost } from './client'

/** Effective lifecycle state of a global account invitation. */
export type AccountInvitationStatus =
  | 'pending'
  | 'accepted'
  | 'revoked'
  | 'expired'

/**
 * Non-secret API representation of an account invitation.
 * The list endpoint never returns the raw token (it is not stored)
 * or the token digest, and never other inviters' invitations.
 */
export interface ApiAccountInvitation {
  id: string
  invitedEmail: string
  invitedBy: string
  status: AccountInvitationStatus
  createdAt: string
  expiresAt: string
  acceptedAt: string | null
  revokedAt: string | null
}

/**
 * Creation response: the invitation metadata plus the raw token,
 * returned exactly once. The raw token is a bootstrap credential —
 * it may only remain in component memory for the current one-time
 * result and is never persisted in browser storage or global state.
 */
export interface ApiAccountInvitationCreated
  extends ApiAccountInvitation {
  token: string
}

/** List the account invitations created by the current user (newest first). */
export async function listAccountInvitations(): Promise<{
  invitations: ApiAccountInvitation[]
}> {
  return apiGet('/api/account-invitations/')
}

/**
 * Create (or replace) the pending account invitation for an email.
 * Replacing invalidates the previous effective pending invitation
 * server-side; the response carries the fresh one-time raw token.
 */
export async function createAccountInvitation(
  targetEmail: string,
): Promise<ApiAccountInvitationCreated> {
  return apiPost<ApiAccountInvitationCreated>(
    '/api/account-invitations/',
    { targetEmail },
  )
}

/**
 * Revoke one of the current user's effectively-pending invitations.
 * The token becomes unusable immediately; unknown ids, foreign ids,
 * and ids that are no longer pending all answer the same 404.
 */
export async function revokeAccountInvitation(
  publicId: string,
): Promise<{ detail: string }> {
  return apiPost<{ detail: string }>(
    `/api/account-invitations/${publicId}/revoke/`,
    {},
  )
}
