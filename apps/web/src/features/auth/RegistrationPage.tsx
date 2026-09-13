import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'

import { ApiError } from '../../api/client'
import { acceptAccountInvitation } from '../../api/account-invitations'
import {
  checkRegistrationPasswordPolicy,
  previewRegistrationInvitation,
  register,
} from '../../api/auth'
import type { ApiRegistrationPasswordRequirement } from '../../api/auth'
import { useSession } from '../../api/useSession'
import {
  AUTH_FIELD_ERROR_CLASSES,
  AUTH_FIELD_ERROR_TEXT_CLASSES,
  AUTH_FIELD_LABEL_CLASSES,
  AUTH_INPUT_BASE_CLASSES,
  AUTH_INPUT_BORDER_DANGER,
  AUTH_INPUT_BORDER_DEFAULT,
  AUTH_PASSWORD_INPUT_TRAILING_CLASSES,
  AUTH_PASSWORD_TOGGLE_CLASSES,
} from './authFormStyles'

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

/**
 * Last authoritative backend policy verdict, tagged with the exact
 * (username, password) candidate it was computed for. Only a verdict
 * matching the current candidate may drive validation state.
 */
interface PolicyState {
  username: string
  password: string
  valid: boolean
  requirements: ApiRegistrationPasswordRequirement[]
}

/** Fixed debounce window for the live policy evaluation. */
const POLICY_DEBOUNCE_MS = 300

const INPUT_CLASS =
  'w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 text-sm text-on-surface outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15'

const PRIMARY_BUTTON_CLASS =
  'w-full rounded-lg bg-primary px-4 py-2.5 text-center text-sm font-medium text-white shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50'

/**
 * Concise, user-facing guidance copy for the canonical Django password
 * validators. `code` selects presentation copy only — every
 * satisfied/not-satisfied verdict comes from the backend, and none of
 * the validator logic is reproduced here. An unknown future code
 * intentionally misses this map and falls back to the backend-provided
 * label, so an unknown enforced requirement is never silently hidden.
 */
const CONCISE_REQUIREMENT_COPY: Record<string, string> = {
  password_too_short: 'At least 8 characters',
  password_too_common: 'Not a commonly used password',
  password_entirely_numeric: 'Not entirely numeric',
  password_too_similar: 'Password is too similar to your personal information.',
}

/**
 * A satisfied similarity rule is intentionally not part of the
 * user-facing checklist: when it passes it renders no row at all
 * (no visible row, no accessible row).
 */
function isOmittedSimilarityRequirement(
  requirement: ApiRegistrationPasswordRequirement,
): boolean {
  return requirement.code === 'password_too_similar' && requirement.satisfied
}

function requirementText(
  requirement: ApiRegistrationPasswordRequirement,
): string {
  return CONCISE_REQUIREMENT_COPY[requirement.code] ?? requirement.label
}

/**
 * One compact guidance row: 11px/16px text, 6px row gap, 14px icon.
 * The state is carried by the icon plus visually-hidden state text —
 * never by appending "Satisfied." / "Not satisfied." to the visible
 * copy.
 *
 * - satisfied: canonical success icon, secondary text
 * - failed regular rule: non-success/non-failure glyph, restrained
 *   tertiary treatment, secondary text
 * - failed similarity: concise error row, canonical danger treatment
 *   (an actionable failure)
 */
function RequirementRow({
  requirement,
}: {
  requirement: ApiRegistrationPasswordRequirement
}) {
  const satisfied = requirement.satisfied
  const similarityFailure =
    requirement.code === 'password_too_similar' && !satisfied

  const icon = satisfied
    ? 'check'
    : similarityFailure
      ? 'close'
      : 'radio_button_unchecked'
  const iconClass = satisfied
    ? 'text-success-text'
    : similarityFailure
      ? 'text-danger'
      : 'text-text-tertiary'
  const textClass = similarityFailure ? 'text-danger' : 'text-text-muted'

  return (
    <li
      className={`flex items-center gap-1.5 text-[11px] leading-4 ${textClass}`}
    >
      <span
        aria-hidden="true"
        className={`material-symbols-outlined shrink-0 text-[14px] leading-none ${iconClass}`}
      >
        {icon}
      </span>
      <span className="min-w-0 break-words">
        {requirementText(requirement)}
      </span>
      <span className="sr-only">
        {satisfied ? 'Satisfied.' : 'Not satisfied.'}
      </span>
    </li>
  )
}

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
  // into this component's memory and only ever sent in the preview,
  // policy and registration/acceptance request bodies. It is never
  // stored, logged, or rendered, and it is discarded once the
  // invitation is consumed.
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
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})

  // Live, backend-authoritative password policy for the current
  // candidate. The frontend owns no password rules: every requirement
  // label and verdict below comes from
  // POST /api/auth/registration-password-policy/.
  const [policy, setPolicy] = useState<PolicyState | null>(null)
  const [policyPending, setPolicyPending] = useState(false)
  const [policyError, setPolicyError] = useState(false)
  // Monotonic guard: a response may only apply to the candidate that
  // owns the latest request generation.
  const policySeq = useRef(0)

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

  // Debounced live policy evaluation. Runs only in the new-account form
  // phase; the initial empty candidate is checked on mount so the
  // requirements list is always backed by the backend. The monotonic
  // generation guard discards any response that no longer belongs to
  // the latest (username, password) candidate.
  useEffect(() => {
    if (phase !== 'form' || !invitationToken) return

    policySeq.current += 1
    const seq = policySeq.current
    // The candidate already changed: treat validation as pending from
    // the moment the new request is scheduled, not only once it leaves
    // the browser.
    setPolicyPending(true)

    const timer = setTimeout(() => {
      checkRegistrationPasswordPolicy(invitationToken, username, password)
        .then((data) => {
          if (seq !== policySeq.current) return
          setPolicy({
            username,
            password,
            valid: data.valid,
            requirements: data.requirements,
          })
          setPolicyError(false)
        })
        .catch(() => {
          if (seq !== policySeq.current) return
          // A failed live check never invalidates the previous
          // trustworthy verdict; it only means the current candidate
          // has no authoritative result yet.
          setPolicyError(true)
        })
        .finally(() => {
          if (seq !== policySeq.current) return
          setPolicyPending(false)
        })
    }, POLICY_DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
    }
  }, [phase, invitationToken, username, password])

  const policyForCurrentCandidate =
    policy !== null &&
    policy.username === username &&
    policy.password === password
      ? policy
      : null

  const passwordUntouched = password === ''
  // Guidance visibility: the compact block exists only once Password has
  // a value. While the current candidate has no authoritative verdict the
  // block shows a single status line instead of stale rows — a stale
  // verdict must never be presented as current.
  const passwordHasValue = password !== ''
  const currentCandidateCheckFailed =
    passwordHasValue &&
    policyForCurrentCandidate === null &&
    !policyPending &&
    policyError
  const passwordHasFailure =
    !passwordUntouched &&
    policyForCurrentCandidate !== null &&
    policyForCurrentCandidate.valid === false

  const confirmMismatch =
    passwordConfirm !== '' && passwordConfirm !== password

  const canCreateAccount =
    username.trim() !== '' &&
    password !== '' &&
    policyForCurrentCandidate !== null &&
    policyForCurrentCandidate.valid === true &&
    !policyPending &&
    passwordConfirm !== '' &&
    passwordConfirm === password &&
    !submitting

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    // The submit button is the affordance; this guard only protects the
    // noValidate form from Enter-key submits in invalid states.
    if (!invitationToken || submitting || !canCreateAccount) return

    setSubmitting(true)
    setFormError(null)
    setFieldErrors({})
    try {
      // Exactly the backend-required payload. The invited email is
      // authoritative on the server and is never sent. Final
      // registration remains authoritative even after live validation.
      const user = await register(invitationToken, username, password)
      setAuthenticatedUser(user)
      navigate('/')
    } catch (err) {
      if (err instanceof ApiError) {
        const detail = (
          err.detail && typeof err.detail === 'object'
            ? err.detail
            : null
        ) as {
          error?: string
          code?: string
          requirements?: ApiRegistrationPasswordRequirement[]
        } | null
        const code = detail?.code

        if (code === 'username') {
          setFieldErrors({
            username: detail?.error ?? 'This username could not be used.',
          })
          return
        }
        if (code === 'password') {
          if (Array.isArray(detail?.requirements)) {
            // The final authoritative verdict replaces the live one:
            // reconcile the displayed requirement states with it
            // instead of collapsing to the generic message.
            setPolicy({
              username,
              password,
              valid: false,
              requirements: detail.requirements,
            })
            setPolicyError(false)
          }
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

  // phase === 'form' — same visual language as Login: dark canvas, no
  // card, no shadow, typographic branding only.
  return (
    <main className="min-h-dvh bg-canvas text-text">
      <div className="flex min-h-dvh justify-center px-6">
        {/* Fixed 380px content column. The 24px page gutters live on the
            outer wrapper only — nothing inside this box carries
            horizontal padding — so on a wide desktop the measured
            content/control width is exactly 380px, and on narrow screens
            the column shrinks inside the gutters instead of overflowing. */}
        <div className="m-auto w-[380px] max-w-full pb-12 pt-16 max-[479px]:mt-0 min-[480px]:-translate-y-4">
          {/* Typographic branding only — no tile, illustration, or card.
              Branding (22px/600) sits subtly above the page heading
              (20px/600). */}
          <p className="text-[22px] font-semibold leading-[28px] tracking-[-0.01em] text-text">
            FG Workspace
          </p>
          <p className="mt-0.5 text-[12px] font-normal leading-[18px] text-text-tertiary">
            Research OS
          </p>

          <h1 className="mt-8 text-[20px] font-semibold leading-[28px] text-text">
            Create your account
          </h1>
          <p className="mt-1 text-[13px] font-normal leading-[20px] text-text-muted">
            You’ve been invited to FG Workspace
          </p>

          <form onSubmit={handleSubmit} noValidate className="mt-7">
            {/* The invited email is display-only: it is never an input
                and never sent by the client. */}
            <div>
              <span className="mb-1 block text-[12px] font-medium leading-[18px] text-text-muted">
                Invited email
              </span>
              <p className="break-all text-[14px] font-medium leading-[20px] text-text">
                {invitedEmail ?? ''}
              </p>
            </div>

            <div className="mt-6">
              <label
                htmlFor="register-username"
                className={AUTH_FIELD_LABEL_CLASSES}
              >
                Username
              </label>
              <input
                id="register-username"
                name="username"
                type="text"
                autoComplete="username"
                spellCheck={false}
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value)
                  if (fieldErrors.username) {
                    setFieldErrors((prev) => ({
                      ...prev,
                      username: undefined,
                    }))
                  }
                }}
                aria-invalid={fieldErrors.username ? true : undefined}
                aria-describedby={
                  fieldErrors.username
                    ? 'register-username-error'
                    : undefined
                }
                className={[
                  AUTH_INPUT_BASE_CLASSES,
                  fieldErrors.username
                    ? AUTH_INPUT_BORDER_DANGER
                    : AUTH_INPUT_BORDER_DEFAULT,
                ].join(' ')}
              />
              {fieldErrors.username && (
                <p
                  id="register-username-error"
                  role="alert"
                  className={AUTH_FIELD_ERROR_CLASSES}
                >
                  {fieldErrors.username}
                </p>
              )}
            </div>

            <div className="mt-[18px]">
              <label
                htmlFor="register-password"
                className={AUTH_FIELD_LABEL_CLASSES}
              >
                Password
              </label>
              <div className="relative">
                <input
                  id="register-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value)
                    if (fieldErrors.password) {
                      setFieldErrors((prev) => ({
                        ...prev,
                        password: undefined,
                      }))
                    }
                  }}
                  aria-invalid={
                    passwordHasFailure ? true : undefined
                  }
                  aria-describedby={
                    fieldErrors.password
                      ? 'register-password-error'
                      : undefined
                  }
                  className={[
                    AUTH_INPUT_BASE_CLASSES,
                    AUTH_PASSWORD_INPUT_TRAILING_CLASSES,
                    passwordHasFailure
                      ? AUTH_INPUT_BORDER_DANGER
                      : AUTH_INPUT_BORDER_DEFAULT,
                  ].join(' ')}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((visible) => !visible)}
                  aria-label={
                    showPassword ? 'Hide password' : 'Show password'
                  }
                  aria-pressed={showPassword}
                  className={AUTH_PASSWORD_TOGGLE_CLASSES}
                >
                  <span className="material-symbols-outlined text-[18px]">
                    {showPassword ? 'visibility_off' : 'visibility'}
                  </span>
                </button>
              </div>

              {/* Compact, backend-owned password guidance. Hidden while
                  Password is empty; appears as soon as a candidate
                  exists. Only the authoritative verdict for the CURRENT
                  candidate is ever presented; while it is outstanding
                  (or the check failed) a single status line replaces the
                  rows instead of keeping a stale verdict visible. */}
              {passwordHasValue &&
                (policyForCurrentCandidate !== null ? (
                  <ul aria-live="polite" className="mt-2 space-y-1.5">
                    {policyForCurrentCandidate.requirements
                      .filter(
                        (requirement) =>
                          !isOmittedSimilarityRequirement(requirement),
                      )
                      .map((requirement) => (
                        <RequirementRow
                          key={requirement.code}
                          requirement={requirement}
                        />
                      ))}
                  </ul>
                ) : (
                  <p
                    role={currentCandidateCheckFailed ? 'alert' : undefined}
                    aria-live="polite"
                    className={`mt-2 text-[11px] leading-4 ${
                      currentCandidateCheckFailed
                        ? 'text-danger'
                        : 'text-text-tertiary'
                    }`}
                  >
                    {currentCandidateCheckFailed
                      ? 'We could not verify the password requirements right now.'
                      : 'Checking password requirements…'}
                  </p>
                ))}
              {fieldErrors.password && (
                <p
                  id="register-password-error"
                  role="alert"
                  className={`mt-2 ${AUTH_FIELD_ERROR_TEXT_CLASSES}`}
                >
                  {fieldErrors.password}
                </p>
              )}
            </div>

            <div className="mt-5">
              <label
                htmlFor="register-password-confirm"
                className={AUTH_FIELD_LABEL_CLASSES}
              >
                Confirm password
              </label>
              <div className="relative">
                <input
                  id="register-password-confirm"
                  type={showConfirmPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={passwordConfirm}
                  onChange={(e) => setPasswordConfirm(e.target.value)}
                  aria-invalid={confirmMismatch ? true : undefined}
                  className={[
                    AUTH_INPUT_BASE_CLASSES,
                    AUTH_PASSWORD_INPUT_TRAILING_CLASSES,
                    confirmMismatch
                      ? AUTH_INPUT_BORDER_DANGER
                      : AUTH_INPUT_BORDER_DEFAULT,
                  ].join(' ')}
                />
                <button
                  type="button"
                  onClick={() =>
                    setShowConfirmPassword((visible) => !visible)
                  }
                  aria-label={
                    showConfirmPassword
                      ? 'Hide password'
                      : 'Show password'
                  }
                  aria-pressed={showConfirmPassword}
                  className={AUTH_PASSWORD_TOGGLE_CLASSES}
                >
                  <span className="material-symbols-outlined text-[18px]">
                    {showConfirmPassword
                      ? 'visibility_off'
                      : 'visibility'}
                  </span>
                </button>
              </div>
              {confirmMismatch && (
                <p
                  role="alert"
                  className={AUTH_FIELD_ERROR_CLASSES}
                >
                  Passwords do not match.
                </p>
              )}
            </div>

            {formError && (
              <p
                role="alert"
                className="mt-6 text-xs leading-[18px] text-danger"
              >
                {formError}
              </p>
            )}

            <button
              type="submit"
              disabled={!canCreateAccount}
              className={[
                'inline-flex h-10 w-full items-center justify-center rounded bg-accent',
                'text-sm font-semibold leading-5 text-text-inverse transition-colors',
                'hover:bg-accent-hover active:brightness-95',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
                'disabled:cursor-not-allowed disabled:bg-action-disabled-bg disabled:text-action-disabled-text',
                formError ? 'mt-2' : 'mt-5',
              ].join(' ')}
            >
              {submitting ? 'Creating account…' : 'Create account'}
            </button>
          </form>
        </div>
      </div>
    </main>
  )
}
