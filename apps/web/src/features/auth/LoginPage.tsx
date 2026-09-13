import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router'

import { useSession } from '../../api/useSession'

import {
  AUTH_FIELD_ERROR_CLASSES,
  AUTH_FIELD_LABEL_CLASSES,
  AUTH_INPUT_BASE_CLASSES,
  AUTH_INPUT_BORDER_DANGER,
  AUTH_INPUT_BORDER_DEFAULT,
  AUTH_PASSWORD_INPUT_TRAILING_CLASSES,
  AUTH_PASSWORD_TOGGLE_CLASSES,
} from './authFormStyles'

/**
 * Canonical, user-facing copy for a backend authentication failure.
 * The backend's own error detail is intentionally never rendered.
 */
const AUTH_FAILURE_TEXT = 'The username or password is incorrect.'

interface FieldErrors {
  username: string | null
  password: string | null
}


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
                className={AUTH_FIELD_LABEL_CLASSES}
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
                  AUTH_INPUT_BASE_CLASSES,
                  fieldErrors.username
                    ? AUTH_INPUT_BORDER_DANGER
                    : AUTH_INPUT_BORDER_DEFAULT,
                ].join(' ')}
              />
              {fieldErrors.username && (
                <p
                  id="login-username-error"
                  className={AUTH_FIELD_ERROR_CLASSES}
                >
                  {fieldErrors.username}
                </p>
              )}
            </div>

            <div className="mt-[18px]">
              <label
                htmlFor="login-password"
                className={AUTH_FIELD_LABEL_CLASSES}
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
                    AUTH_INPUT_BASE_CLASSES,
                    AUTH_PASSWORD_INPUT_TRAILING_CLASSES,
                    fieldErrors.password
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
              {fieldErrors.password && (
                <p
                  id="login-password-error"
                  className={AUTH_FIELD_ERROR_CLASSES}
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
