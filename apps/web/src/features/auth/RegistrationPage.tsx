import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'

import { ApiError } from '../../api/client'
import {
  previewRegistrationInvitation,
  register,
} from '../../api/auth'
import { useSession } from '../../api/useSession'

type PagePhase = 'loading' | 'form' | 'accountExists' | 'terminal'

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

function RegistrationHeader({ subtitle }: { subtitle: string }) {
  return (
    <div className="mb-8 text-center">
      <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-xl font-bold text-white">
        FG
      </div>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight text-on-surface">
        Create your account
      </h1>
      <p className="mt-1 text-sm text-on-surface-variant">
        {subtitle}
      </p>
    </div>
  )
}

export function RegistrationPage() {
  const { setAuthenticatedUser } = useSession()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  // The invitation token is a bootstrap credential. It is captured once
  // into this component's memory and only ever sent in the preview and
  // registration request bodies. It is never stored, logged, or rendered.
  const [invitationToken] = useState(() => searchParams.get('token'))

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

  useEffect(() => {
    if (!invitationToken) {
      setTerminalReason('missing')
      setPhase('terminal')
      return
    }

    let cancelled = false
    previewRegistrationInvitation(invitationToken)
      .then((data) => {
        if (cancelled) return
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

  if (phase === 'accountExists') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-container-lowest px-4">
        <div className="w-full max-w-sm">
          <RegistrationHeader subtitle="Sign in to continue" />
          <div className={cardClass} role="alert">
            <p className="text-sm text-on-surface">
              An account already exists for this email. Sign in to continue.
            </p>
            {invitedEmail && (
              <p className="mt-3 text-sm text-on-surface-variant">
                Invited email: {invitedEmail}
              </p>
            )}
            <Link
              to="/login"
              className="mt-4 block w-full rounded-lg bg-primary px-4 py-2.5 text-center text-sm font-medium text-white shadow-sm transition hover:bg-primary/90"
            >
              Sign in
            </Link>
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

        <form
          onSubmit={handleSubmit}
          noValidate
          className={cardClass}
        >
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
              aria-invalid={
                fieldErrors.passwordConfirm ? true : undefined
              }
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
            className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Creating account…' : 'Create account'}
          </button>
        </form>
      </div>
    </div>
  )
}
