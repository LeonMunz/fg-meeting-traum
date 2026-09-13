import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router'

import { useSession } from '../../api/useSession'

/**
 * Canonical, user-facing copy for a backend authentication failure.
 * The backend's own error detail is intentionally never rendered.
 */
const AUTH_FAILURE_TEXT = 'The username or password is incorrect.'

interface FieldErrors {
  username: string | null
  password: string | null
}

const INPUT_BASE_CLASSES = [
  'h-10 w-full rounded border bg-surface-quiet px-3 text-sm leading-5 text-text',
  'transition-colors',
  'hover:border-border-control',
  'focus:border-accent focus:outline-none focus:ring-2 focus:ring-focus focus:ring-offset-1 focus:ring-offset-canvas',
].join(' ')

export function LoginPage() {
  const { login, loading, error } = useSession()
  const navigate = useNavigate()

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({
    username: null,
    password: null,
  })
  const [submitting, setSubmitting] = useState(false)

  const passwordInputRef = useRef<HTMLInputElement>(null)

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (submitting) return

    const errors: FieldErrors = {
      username: username.trim() ? null : 'Enter your username.',
      password: password ? null : 'Enter your password.',
    }
    setFieldErrors(errors)
    if (errors.username || errors.password) return

    setSubmitting(true)
    try {
      await login(username, password)
      navigate('/')
    } catch {
      // The failure message is stored in the session context and
      // rendered as the canonical compact auth error below.
      passwordInputRef.current?.focus()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="min-h-dvh bg-canvas text-text">
      <div className="flex min-h-dvh justify-center px-6">
        <div className="m-auto w-full max-w-[360px] pb-12 pt-20 max-[479px]:mt-0 min-[480px]:-translate-y-6">
          {/* Typographic branding only — no tile, illustration, or card. */}
          <p className="text-[22px] font-semibold leading-7 tracking-[-0.01em] text-text">
            FG Workspace
          </p>
          <p className="mt-0.5 text-xs font-normal leading-[18px] text-text-tertiary">
            Research OS
          </p>

          <h1 className="mt-8 text-xl font-semibold leading-7 text-text">
            Sign in
          </h1>

          <form onSubmit={handleSubmit} className="mt-7">
            <div>
              <label
                htmlFor="login-username"
                className="mb-1.5 block text-xs font-medium leading-[18px] text-text-muted"
              >
                Username
              </label>
              <input
                id="login-username"
                name="username"
                type="text"
                autoComplete="username"
                spellCheck={false}
                value={username}
                onChange={(event) => {
                  setUsername(event.target.value)
                  if (fieldErrors.username) {
                    setFieldErrors((prev) => ({
                      ...prev,
                      username: null,
                    }))
                  }
                }}
                aria-invalid={
                  fieldErrors.username ? true : undefined
                }
                aria-describedby={
                  fieldErrors.username
                    ? 'login-username-error'
                    : undefined
                }
                className={[
                  INPUT_BASE_CLASSES,
                  fieldErrors.username
                    ? 'border-danger'
                    : 'border-border-default',
                ].join(' ')}
              />
              {fieldErrors.username && (
                <p
                  id="login-username-error"
                  className="mt-[5px] text-xs leading-4 text-danger"
                >
                  {fieldErrors.username}
                </p>
              )}
            </div>

            <div className="mt-[18px]">
              <label
                htmlFor="login-password"
                className="mb-1.5 block text-xs font-medium leading-[18px] text-text-muted"
              >
                Password
              </label>
              <div className="relative">
                <input
                  id="login-password"
                  ref={passwordInputRef}
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value)
                    if (fieldErrors.password) {
                      setFieldErrors((prev) => ({
                        ...prev,
                        password: null,
                      }))
                    }
                  }}
                  aria-invalid={
                    fieldErrors.password ? true : undefined
                  }
                  aria-describedby={
                    fieldErrors.password
                      ? 'login-password-error'
                      : undefined
                  }
                  className={[
                    INPUT_BASE_CLASSES,
                    'pr-10',
                    fieldErrors.password
                      ? 'border-danger'
                      : 'border-border-default',
                  ].join(' ')}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((visible) => !visible)}
                  aria-label={
                    showPassword ? 'Hide password' : 'Show password'
                  }
                  aria-pressed={showPassword}
                  className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-1 focus-visible:ring-offset-surface-quiet"
                >
                  <span className="material-symbols-outlined text-[18px]">
                    {showPassword ? 'visibility_off' : 'visibility'}
                  </span>
                </button>
              </div>
              {fieldErrors.password && (
                <p
                  id="login-password-error"
                  className="mt-[5px] text-xs leading-4 text-danger"
                >
                  {fieldErrors.password}
                </p>
              )}
            </div>

            {error && (
              <p
                role="alert"
                className="mt-6 text-xs leading-[18px] text-danger"
              >
                {AUTH_FAILURE_TEXT}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting || loading}
              className={[
                'inline-flex h-10 w-full items-center justify-center rounded bg-accent',
                'text-sm font-semibold leading-5 text-text-inverse transition-colors',
                'hover:bg-accent-hover active:brightness-95',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
                'disabled:cursor-not-allowed disabled:bg-action-disabled-bg disabled:text-action-disabled-text',
                error ? 'mt-2' : 'mt-6',
              ].join(' ')}
            >
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </main>
  )
}
