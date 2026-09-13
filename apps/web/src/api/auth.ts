import { apiGet, apiPost } from './client'
import type { ApiUser } from './types'

/** Login with username/password. Creates a server session. */
export async function login(username: string, password: string): Promise<ApiUser> {
  return apiPost<ApiUser>('/api/auth/login/', { username, password })
}

/** Logout. Destroys the server session. */
export async function logout(): Promise<void> {
  await apiPost<Record<string, never>>('/api/auth/logout/', {})
}

/** Get the current authenticated user. Returns 401 if not authenticated. */
export async function me(): Promise<ApiUser> {
  return apiGet<ApiUser>('/api/auth/me/')
}

/* ── Invite-only registration ─────────────────────────────────── */

/**
 * Non-consuming preview result of an account-invitation token.
 * For an effective-pending token the invited email, expiry and
 * `accountExists` are reported; terminal tokens only carry `status`.
 */
export interface ApiRegistrationInvitationPreview {
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  usable: boolean
  invitedEmail?: string
  expiresAt?: string
  accountExists?: boolean
}

/**
 * Preview an account-invitation token without consuming it.
 *
 * The token is a bootstrap credential: it is only ever sent in this
 * request body and the registration body, never stored in the browser.
 */
export async function previewRegistrationInvitation(
  token: string,
): Promise<ApiRegistrationInvitationPreview> {
  return apiPost<ApiRegistrationInvitationPreview>(
    '/api/auth/registration-invitation/',
    { token },
  )
}

/**
 * Register a new account from one valid pending invitation.
 *
 * The invited email is authoritative on the server and is never sent by
 * the client. On success the server authenticates a normal browser
 * session and returns the new user.
 */
export async function register(
  token: string,
  username: string,
  password: string,
): Promise<ApiUser> {
  return apiPost<ApiUser>(
    '/api/auth/register/',
    { token, username, password },
  )
}
