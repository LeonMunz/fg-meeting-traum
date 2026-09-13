import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'

import { ApiError } from '../../api/client'
import { acceptAccountInvitation } from '../../api/account-invitations'
import {
  previewRegistrationInvitation,
  register,
} from '../../api/auth'
import { useSession } from '../../api/useSession'

type PagePhase = 'loading' | 'form' | 'accountExists' | 'accepted' | 'terminal'

type TerminalReason =
  | 'missing'
  | 'invalid'
  | 'expired'
  | 'revoked'
  | 'used'
  | 'error'

const TERMINAL_MESSAGES: Record<TerminalReason, string> = {
  missing: 'This registration link is missing its invitation.',
  invalid: 'This invitation link is invalid or was not recognized.',
  expired: 'This invitation has expired.',
  revoked: 'This invitation is no longer valid.',
  used: 'This invitation has already been used.',
  error: 'We could not verify this invitation right now.',
}

interface FieldErrors {
  username?: string
  password?: string
  passwordConfirm?: string
}

const INPUT_CLASS =
  'w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 text-sm text-on-surface outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15'

const PRIMARY_BUTTON_CLASS =
  'w-full rounded-lg bg-primary px-4 py-2.5 text-center text-sm font-medium text-white shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50'

function RegistrationHeader({ subtitle }: { subtitle: string }) {
  return (
    <div className="mb-8 text-center">
      <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-xl font-bold text-white">
        FG
      </div>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight text-on-surface">
        Create your account
      </h1>
      <p className="mt-1 text-sm text-on-surface-variant">{subtitle}</p>
    </div>
  )
}

export function RegistrationPage() {
  const {
    user: sessionUser,
    loading: sessionLoading,
    error: sessionError,
    login,
    logout,
    setAuthenticatedUser,
  } = useSession()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  // The invitation token is a bootstrap credential. It is captured once
  // into this component's memory and only ever sent in the preview and
  // registration/acceptance request bodies. It is never stored, logged,
  // or rendered, and it is discarded once the invitation is consumed.
  const [invitationToken, setInvitationToken] = useState(() =>
    searchParams.get('token'),
  )

  // Remove the token from the visible URL after initial capture.
  useEffect(() => {
    if (invitationToken) {
      setSearchParams({}, { replace: true })
    }
  }, [invitationToken, setSearchParams])

  const [phase, setPhase] = useState<PagePhase>('loading')
  const [terminalReason, setTerminalReason] = useState<TerminalReason>('error')
  const [invitedEmail, setInvitedEmail] = useState<string | null>(null)

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})

  // Existing-account sign-in (reuses the SessionProvider login path,
  // exactly like LoginPage) and the explicit acceptance action.
  const [signInUsername, setSignInUsername] = useState('')
  const [signInPassword, setSignInPassword] = useState('')
  const [signingIn, setSigningIn] = useState(false)
  const [accepting, setAccepting] = useState(false)
  const [acceptError, setAcceptError] = useState<string | null>(null)

  // The invitation preview settles exactly once: the guard latches when
  // the preview settles, not when it starts, so a re-run (e.g. React
  // StrictMode's mount/cleanup/mount in dev servers) may still complete
  // the preview, while a later re-entry — such as discarding the token
  // after acceptance — never re-previews or falls through to the
  // terminal "missing" state.
  const previewSettled = useRef(false)

  useEffect(() => {
    if (previewSettled.current) return

    if (!invitationToken) {
      setTerminalReason('missing')
      setPhase('terminal')
      previewSettled.current = true
      return
    }

    let cancelled = false
    previewRegistrationInvitation(invitationToken)
      .then((data) => {
        if (cancelled) return
        previewSettled.current = true
        if (data.usable && data.status === 'pending') {
          setInvitedEmail(data.invitedEmail ?? null)
          setPhase(data.accountExists ? 'accountExists' : 'form')
          return
        }
        if (data.status === 'accepted') setTerminalReason('used')
        else if (data.status === 'revoked') setTerminalReason('revoked')
        else if (data.status === 'expired') setTerminalReason('expired')
        else setTerminalReason('invalid')
        setPhase('terminal')
      })
      .catch((err) => {
        if (cancelled) return
        previewSettled.current = true
        setTerminalReason(
          err instanceof ApiError && err.status === 404 ? 'invalid' : 'error',
        )
        setPhase('terminal')
      })

    return () => {
      cancelled = true
    }
  }, [invitationToken])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!invitationToken || submitting) return

    const nextFieldErrors: FieldErrors = {}
    if (!username.trim()) {
      nextFieldErrors.username = 'Enter a username.'
    }
    if (password.length < 8) {
      nextFieldErrors.password = 'Use at least 8 characters.'
    }
    if (passwordConfirm !== password) {
      nextFieldErrors.passwordConfirm = 'Passwords do not match.'
    }
    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors)
      return
    }

    setSubmitting(true)
    setFormError(null)
    setFieldErrors({})
    try {
      // Exactly the backend-required payload. The invited email is
      // authoritative on the server and is never sent.
      const user = await register(invitationToken, username, password)
      setAuthenticatedUser(user)
      navigate('/')
    } catch (err) {
      if (err instanceof ApiError) {
        const detail = (
          err.detail && typeof err.detail === 'object'
            ? err.detail
            : null
        ) as { error?: string; code?: string } | null
        const code = detail?.code

        if (code === 'username') {
          setFieldErrors({
            username: detail?.error ?? 'This username could not be used.',
          })
          return
        }
        if (code === 'password') {
          setFieldErrors({
            password: detail?.error ?? 'This password could not be used.',
          })
          return
        }
        if (code === 'account_exists') {
          setPhase('accountExists')
          return
        }
        if (
          code === 'expired' ||
          code === 'revoked' ||
          code === 'already_used' ||
          code === 'invalid_token'
        ) {
          setTerminalReason(
            code === 'expired'
              ? 'expired'
              : code === 'revoked'
                ? 'revoked'
                : code === 'already_used'
                  ? 'used'
                  : 'invalid',
          )
          setPhase('terminal')
          return
        }
        setFormError(detail?.error ?? `Registration failed (${err.status}).`)
      } else {
        setFormError('Registration failed. Please try again.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  // Sign-in inside the invitation flow: the exact same SessionProvider
  // login path as LoginPage. On success the page stays in the
  // invitation flow — the session state drives the next step and
  // acceptance always remains an explicit action.
  const handleSignIn = async (e: FormEvent) => {
    e.preventDefault()
    if (!signInUsername || !signInPassword || signingIn) return
    setSigningIn(true)
    try {
      await login(signInUsername, signInPassword)
    } catch {
      // The standard authentication error is stored in the session
      // context and announced in the form.
    } finally {
      setSigningIn(false)
    }
  }

  // Explicit acceptance with the in-memory raw token. The server is
  // authoritative: the authenticated account must match the invited
  // email (normalized) and the invitation must be effectively pending.
  const handleAccept = async () => {
    if (!invitationToken || accepting) return
    setAccepting(true)
    setAcceptError(null)
    try {
      await acceptAccountInvitation(invitationToken)
      // The invitation is consumed: discard the one-time token from
      // component state and move to the terminal success state.
      setInvitationToken(null)
      setPhase('accepted')
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 404 || err.status === 410) {
          // Unknown, or terminal (accepted/revoked): non-leaking.
          setInvitationToken(null)
          setTerminalReason(err.status === 404 ? 'revoked' : 'expired')
          setPhase('terminal')
          return
        }
        const detail = (
          err.detail && typeof err.detail === 'object' ? err.detail : null
        ) as { error?: string } | null
        setAcceptError(detail?.error ?? `Acceptance failed (${err.status}).`)
      } else {
        setAcceptError('Acceptance failed. Please try again.')
      }
    } finally {
      setAccepting(false)
    }
  }

  // Client-side email comparison only improves the messaging. The
  // server remains authoritative for account matching.
  const invitedEmailMatched =
    sessionUser !== null &&
    invitedEmail !== null &&
    sessionUser.email.trim().toLowerCase() ===
      invitedEmail.trim().toLowerCase()

  const cardClass =
    'rounded-xl border border-outline-variant bg-surface-container-lowest p-6 shadow-sm'

  if (phase === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-container-lowest px-4">
        <div className="w-full max-w-sm">
          <RegistrationHeader subtitle="Checking your invitation" />
          <div className={cardClass}>
            <span className="material-symbols-outlined inline-block animate-spin text-[24px] text-on-surface-variant">
              refresh
            </span>
            <p className="mt-3 text-sm text-on-surface-variant">
              Checking your invitation…
            </p>
          </div>
        </div>
      </div>
    )
  }

  if (phase === 'terminal') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-container-lowest px-4">
        <div className="w-full max-w-sm">
          <RegistrationHeader subtitle="Your invitation is not usable" />
          <div className={cardClass} role="alert">
            <p className="text-sm text-on-surface">
              {TERMINAL_MESSAGES[terminalReason]}
            </p>
            <p className="mt-3 text-sm text-on-surface-variant">
              If you believe this is a mistake, ask the person who invited
              you for a new invitation.
            </p>
          </div>
        </div>
      </div>
    )
  }

  if (phase === 'accepted') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-container-lowest px-4">
        <div className="w-full max-w-sm">
          <RegistrationHeader subtitle="Invitation accepted" />
          <div className={cardClass} role="status">
            <p className="text-sm text-on-surface">
              Your invitation has been accepted.
            </p>
            {invitedEmail && (
              <p className="mt-3 text-sm text-on-surface-variant">
                Accepted for {invitedEmail}. No project access was added.
              </p>
            )}
            <button
              type="button"
              onClick={() => navigate('/')}
              className={`mt-4 ${PRIMARY_BUTTON_CLASS}`}
            >
              Continue to workspace
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (phase === 'accountExists') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-container-lowest px-4">
        <div className="w-full max-w-sm">
          <RegistrationHeader subtitle="Sign in to continue" />
          <div className={cardClass}>
            <p className="text-sm text-on-surface">
              An account already exists for this email.
            </p>
            <div className="mt-3">
              <span className="mb-1 block text-sm font-medium text-on-surface">
                Invited email
              </span>
              <p className="rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2 text-sm text-on-surface-variant">
                {invitedEmail ?? ''}
              </p>
            </div>

            {sessionLoading && !signingIn ? (
              <div className="mt-4">
                <span className="material-symbols-outlined inline-block animate-spin text-[20px] text-on-surface-variant">
                  refresh
                </span>
                <p className="mt-2 text-sm text-on-surface-variant">
                  Checking your session…
                </p>
              </div>
            ) : sessionUser === null ? (
              <form onSubmit={handleSignIn} noValidate className="mt-4">
                <div className="mb-4">
                  <label
                    htmlFor="register-signin-username"
                    className="mb-1 block text-sm font-medium text-on-surface"
                  >
                    Username
                  </label>
                  <input
                    id="register-signin-username"
                    type="text"
                    autoComplete="username"
                    required
                    value={signInUsername}
                    onChange={(e) => setSignInUsername(e.target.value)}
                    className={INPUT_CLASS}
                    placeholder="e.g. alex"
                  />
                </div>

                <div className="mb-4">
                  <label
                    htmlFor="register-signin-password"
                    className="mb-1 block text-sm font-medium text-on-surface"
                  >
                    Password
                  </label>
                  <input
                    id="register-signin-password"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={signInPassword}
                    onChange={(e) => setSignInPassword(e.target.value)}
                    className={INPUT_CLASS}
                    placeholder="••••••••"
                  />
                </div>

                {sessionError && (
                  <div
                    role="alert"
                    className="mb-4 rounded-lg bg-error-container px-3 py-2 text-sm text-on-error-container"
                  >
                    {sessionError}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={signingIn}
                  className={PRIMARY_BUTTON_CLASS}
                >
                  {signingIn ? 'Signing in…' : 'Sign in'}
                </button>
              </form>
            ) : invitedEmailMatched ? (
              <div className="mt-4">
                <p className="text-sm text-on-surface">
                  You are signed in as{' '}
                  <span className="font-medium">
                    {sessionUser.username}
                  </span>{' '}
                  ({sessionUser.email}).
                </p>
                {acceptError && (
                  <div
                    role="alert"
                    className="mt-3 rounded-lg bg-error-container px-3 py-2 text-sm text-on-error-container"
                  >
                    {acceptError}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => void handleAccept()}
                  disabled={accepting}
                  className={`mt-4 ${PRIMARY_BUTTON_CLASS}`}
                >
                  {accepting ? 'Accepting…' : 'Accept invitation'}
                </button>
              </div>
            ) : (
              <div className="mt-4">
                <div
                  role="alert"
                  className="rounded-lg bg-error-container px-3 py-2 text-sm text-on-error-container"
                >
                  This invitation belongs to a different account. You are
                  signed in as {sessionUser.email}, but the invitation is
                  for {invitedEmail ?? 'another e-mail address'}.
                </div>
                <button
                  type="button"
                  onClick={() => void logout()}
                  className={`mt-4 ${PRIMARY_BUTTON_CLASS}`}
                >
                  Sign out and use another account
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // phase === 'form'
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-container-lowest px-4">
      <div className="w-full max-w-sm">
        <RegistrationHeader subtitle="You have been invited to FG Workspace" />

        <form onSubmit={handleSubmit} noValidate className={cardClass}>
          <div className="mb-4">
            <span className="mb-1 block text-sm font-medium text-on-surface">
              Invited email
            </span>
            <p className="rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2 text-sm text-on-surface-variant">
              {invitedEmail ?? ''}
            </p>
          </div>

          <div className="mb-4">
            <label
              htmlFor="register-username"
              className="mb-1 block text-sm font-medium text-on-surface"
            >
              Username
            </label>
            <input
              id="register-username"
              type="text"
              autoComplete="username"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              aria-invalid={fieldErrors.username ? true : undefined}
              aria-describedby={
                fieldErrors.username ? 'register-username-error' : undefined
              }
              className={INPUT_CLASS}
              placeholder="e.g. alex"
            />
            {fieldErrors.username && (
              <p
                id="register-username-error"
                role="alert"
                className="mt-1 text-sm text-error"
              >
                {fieldErrors.username}
              </p>
            )}
          </div>

          <div className="mb-4">
            <label
              htmlFor="register-password"
              className="mb-1 block text-sm font-medium text-on-surface"
            >
              Password
            </label>
            <input
              id="register-password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={fieldErrors.password ? true : undefined}
              aria-describedby={
                fieldErrors.password ? 'register-password-error' : undefined
              }
              className={INPUT_CLASS}
              placeholder="••••••••"
            />
            {fieldErrors.password && (
              <p
                id="register-password-error"
                role="alert"
                className="mt-1 text-sm text-error"
              >
                {fieldErrors.password}
              </p>
            )}
          </div>

          <div className="mb-4">
            <label
              htmlFor="register-password-confirm"
              className="mb-1 block text-sm font-medium text-on-surface"
            >
              Confirm password
            </label>
            <input
              id="register-password-confirm"
              type="password"
              autoComplete="new-password"
              required
              value={passwordConfirm}
              onChange={(e) => setPasswordConfirm(e.target.value)}
              aria-invalid={fieldErrors.passwordConfirm ? true : undefined}
              aria-describedby={
                fieldErrors.passwordConfirm
                  ? 'register-password-confirm-error'
                  : undefined
              }
              className={INPUT_CLASS}
              placeholder="••••••••"
            />
            {fieldErrors.passwordConfirm && (
              <p
                id="register-password-confirm-error"
                role="alert"
                className="mt-1 text-sm text-error"
              >
                {fieldErrors.passwordConfirm}
              </p>
            )}
          </div>

          {formError && (
            <div
              role="alert"
              className="mb-4 rounded-lg bg-error-container px-3 py-2 text-sm text-on-error-container"
            >
              {formError}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className={PRIMARY_BUTTON_CLASS}
          >
            {submitting ? 'Creating account…' : 'Create account'}
          </button>
        </form>
      </div>
    </div>
  )
}
