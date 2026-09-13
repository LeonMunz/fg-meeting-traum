// @vitest-environment happy-dom

import { StrictMode, act } from 'react'

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'

import { SessionProvider } from '../../api/SessionProvider'
import { ApiError } from '../../api/client'
import { useSession } from '../../api/useSession'
import type { ApiUser } from '../../api/types'

import { RegistrationPage } from './RegistrationPage'

vi.mock('../../api/auth', () => ({
  login: vi.fn(),
  logout: vi.fn(),
  me: vi.fn(),
  register: vi.fn(),
  previewRegistrationInvitation: vi.fn(),
  checkRegistrationPasswordPolicy: vi.fn(),
}))

vi.mock('../../api/account-invitations', () => ({
  acceptAccountInvitation: vi.fn(),
}))

import * as authApi from '../../api/auth'
import * as invitationApi from '../../api/account-invitations'

const me = authApi.me as Mock
const preview = authApi.previewRegistrationInvitation as Mock
const register = authApi.register as Mock
const policy = authApi.checkRegistrationPasswordPolicy as Mock
const apiLogin = authApi.login as Mock
const accept = invitationApi.acceptAccountInvitation as Mock

const TOKEN = 'invite-token-123'
const INVITED_EMAIL = 'existing.user@example.com'

const NEW_USER: ApiUser = {
  id: 42,
  username: 'newbie',
  firstName: '',
  lastName: '',
  email: INVITED_EMAIL,
}

const EXISTING_USER: ApiUser = {
  id: 2,
  username: 'chris',
  firstName: 'Chris',
  lastName: 'Dev',
  email: INVITED_EMAIL,
}

const OTHER_USER: ApiUser = {
  id: 3,
  username: 'maria',
  firstName: 'Maria',
  lastName: 'Dev',
  email: 'maria@example.com',
}

const ACCEPTED_INVITATION = {
  id: 'inv-1',
  invitedEmail: INVITED_EMAIL,
  invitedBy: 'alex',
  status: 'accepted',
  createdAt: '2026-09-13T00:00:00Z',
  expiresAt: '2026-09-20T00:00:00Z',
  acceptedAt: '2026-09-13T00:00:00Z',
  revokedAt: null,
  acceptedUserId: 2,
}

function pendingPreview(overrides: Record<string, unknown> = {}) {
  return {
    status: 'pending',
    usable: true,
    invitedEmail: INVITED_EMAIL,
    expiresAt: '2026-09-20T00:00:00Z',
    accountExists: false,
    ...overrides,
  }
}

const REQUIREMENT_CODES = [
  'password_too_similar',
  'password_too_short',
  'password_too_common',
  'password_entirely_numeric',
] as const

const REQUIREMENT_LABELS: Record<(typeof REQUIREMENT_CODES)[number], string> = {
  password_too_similar: 'Password cannot be the same as your username.',
  password_too_short: 'Password must contain at least 8 characters.',
  password_too_common: 'Password cannot be a commonly used password.',
  password_entirely_numeric: 'Password cannot be entirely numeric.',
}

/** Mock policy responses mirror the backend schema; labels are test data. */
function policyResponse(
  failingCodes: (typeof REQUIREMENT_CODES)[number][] = [],
) {
  return {
    valid: failingCodes.length === 0,
    requirements: REQUIREMENT_CODES.map((code) => ({
      code,
      label: REQUIREMENT_LABELS[code],
      satisfied: !failingCodes.includes(code),
    })),
    accountExists: false,
  }
}

function requirementsList(): HTMLElement {
  return screen
    .getByText('At least 8 characters')
    .closest('ul') as HTMLElement
}

function indicatorCount(list: HTMLElement, glyph: string) {
  return Array.from(list.querySelectorAll('span')).filter(
    (el) => el.textContent === glyph,
  ).length
}

/**
 * All guidance rows rendered on the page. The registration form has no
 * other lists, so every <li> is a requirement row.
 */
function requirementRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll('li'))
}

/** Count of the visually-hidden accessible state strings. */
function stateCount(state: string) {
  return screen.queryAllByText(state, { exact: true }).length
}

function AuthenticatedSentinel() {
  const { user } = useSession()
  return (
    <div data-testid="authenticated-app">
      {user ? `signed-in:${user.username}` : 'anonymous'}
    </div>
  )
}

function SessionProbe() {
  const { user } = useSession()
  return (
    <div data-testid="session-probe">{user ? user.username : 'anonymous'}</div>
  )
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location-search">{location.search}</div>
}

function renderPage(initialEntry = `/register?token=${TOKEN}`) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <SessionProvider>
        <SessionProbe />
        <LocationProbe />
        <Routes>
          <Route path="/register" element={<RegistrationPage />} />
          <Route path="/login" element={<div>login-page-sentinel</div>} />
          <Route path="/" element={<AuthenticatedSentinel />} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  )
}

async function fillRegistrationForm(
  username = 'newbie',
  password = 'Passw0rd!x',
  confirm = 'Passw0rd!x',
) {
  fireEvent.change(screen.getByLabelText('Username'), {
    target: { value: username },
  })
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: password },
  })
  fireEvent.change(screen.getByLabelText('Confirm password'), {
    target: { value: confirm },
  })
  // The button is only enabled once the authoritative policy verdict
  // for exactly this candidate has arrived.
  const button = screen.getByRole('button', { name: 'Create account' })
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)
}

function fillSignInForm(
  username = 'chris',
  password = 'Passw0rd!x',
) {
  fireEvent.change(screen.getByLabelText('Username'), {
    target: { value: username },
  })
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: password },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
}

function expectTokenNotInStorage() {
  expect(Object.values(localStorage).join('|')).not.toContain(TOKEN)
  expect(Object.values(sessionStorage).join('|')).not.toContain(TOKEN)
}

describe('RegistrationPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    me.mockRejectedValue(new ApiError(401, { error: 'Not authenticated' }))
    preview.mockResolvedValue(pendingPreview())
    accept.mockResolvedValue(ACCEPTED_INVITATION)
    policy.mockResolvedValue(policyResponse())
  })

  afterEach(() => {
    cleanup()
  })

  it('shows a stable loading state while the invitation is validated', async () => {
    preview.mockReturnValue(new Promise(() => {}))
    renderPage()
    expect(
      await screen.findByText('Checking your invitation…'),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument()
  })

  it('does not show the registration form when the token is missing', async () => {
    renderPage('/register')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /missing its invitation/i,
    )
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Create account' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Accept invitation' }),
    ).not.toBeInTheDocument()
    expect(preview).not.toHaveBeenCalled()
  })

  it('shows the invited email read-only for a valid pending invitation', async () => {
    const { container } = renderPage()
    await screen.findByLabelText('Username')

    expect(screen.getByText(INVITED_EMAIL)).toBeInTheDocument()
    expect(screen.getByText('Invited email')).toBeInTheDocument()

    // The email is displayed information, not an editable field: no form
    // input carries it, and there is no field labelled with it.
    expect(screen.queryByLabelText('Invited email')).not.toBeInTheDocument()
    const inputs = container.querySelectorAll('input')
    expect(inputs).toHaveLength(3)
    for (const input of Array.from(inputs)) {
      expect(input.value).not.toBe(INVITED_EMAIL)
    }
  })

  it('does not call the preview endpoint with the token rendered in the UI', async () => {
    renderPage()
    await screen.findByLabelText('Username')
    expect(screen.queryByText(TOKEN)).not.toBeInTheDocument()
    expect(preview).toHaveBeenCalledWith(TOKEN)
  })

  it('calls the registration API with token, username and password only', async () => {
    register.mockResolvedValue(NEW_USER)
    renderPage()
    await screen.findByLabelText('Username')

    await fillRegistrationForm()

    await waitFor(() => expect(register).toHaveBeenCalledTimes(1))
    const args = register.mock.calls[0]
    expect(args).toHaveLength(3)
    expect(args[0]).toBe(TOKEN)
    expect(args[1]).toBe('newbie')
    expect(args[2]).toBe('Passw0rd!x')
  })

  it('enters the authenticated app flow after a successful registration', async () => {
    register.mockResolvedValue(NEW_USER)
    renderPage()
    await screen.findByLabelText('Username')

    await fillRegistrationForm()

    expect(await screen.findByTestId('authenticated-app')).toBeInTheDocument()
    expect(await screen.findByText('signed-in:newbie')).toBeInTheDocument()
  })

  it('shows the mismatch live before submit and never submits a mismatched form', async () => {
    register.mockResolvedValue(NEW_USER)
    renderPage()
    await screen.findByLabelText('Username')

    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'newbie' },
    })
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'Passw0rd!x' },
    })
    // No submit: the mismatch must already be visible live.
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'different' },
    })

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Passwords do not match.',
    )
    expect(
      screen.getByRole('button', { name: 'Create account' }),
    ).toBeDisabled()
    expect(register).not.toHaveBeenCalled()

    // Correcting the value clears the message immediately.
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'Passw0rd!x' },
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(register).not.toHaveBeenCalled()
  })

  it('clears the mismatch error and danger border as soon as the values match', async () => {
    renderPage()
    await screen.findByLabelText('Username')

    const confirm = screen.getByLabelText('Confirm password')
    fireEvent.change(confirm, { target: { value: 'something' } })
    expect(confirm).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Passwords do not match.',
    )

    fireEvent.change(confirm, { target: { value: '' } })
    expect(confirm).not.toHaveAttribute('aria-invalid')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('maps a backend username error to the username field', async () => {
    register.mockRejectedValue(
      new ApiError(400, {
        error: 'A user with that username already exists.',
        code: 'username',
      }),
    )
    renderPage()
    await screen.findByLabelText('Username')

    await fillRegistrationForm()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A user with that username already exists.',
    )
    const input = screen.getByLabelText('Username')
    const describedBy = input.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)).toHaveTextContent(
      'A user with that username already exists.',
    )
  })

  it('maps a backend password error to the password field', async () => {
    register.mockRejectedValue(
      new ApiError(400, {
        error: 'This password is too common.',
        code: 'password',
      }),
    )
    renderPage()
    await screen.findByLabelText('Username')

    await fillRegistrationForm()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This password is too common.',
    )
    const input = screen.getByLabelText('Password')
    const describedBy = input.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)).toHaveTextContent(
      'This password is too common.',
    )
  })

  it.each([
    ['expired', 'This invitation has expired.'],
    ['revoked', 'This invitation is no longer valid.'],
    ['accepted', 'This invitation has already been used.'],
  ])(
    'never exposes login, registration, or accept controls when the invite is %s',
    async (status, message) => {
      preview.mockResolvedValue({ status, usable: false })
      renderPage()

      expect(await screen.findByRole('alert')).toHaveTextContent(message)
      expect(screen.queryByLabelText('Username')).not.toBeInTheDocument()
      expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Create account' }),
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Sign in' }),
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Accept invitation' }),
      ).not.toBeInTheDocument()
    },
  )

  it('renders an invalid state without any form or accept control when the preview returns 404', async () => {
    preview.mockRejectedValue(
      new ApiError(404, { error: 'This invitation token is invalid.' }),
    )
    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /invalid or was not recognized/i,
    )
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Create account' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Accept invitation' }),
    ).not.toBeInTheDocument()
  })

  it('prevents duplicate submission while registration is pending', async () => {
    register.mockReturnValue(new Promise<ApiUser>(() => {}))
    renderPage()
    await screen.findByLabelText('Username')

    await fillRegistrationForm()
    // A second submit attempt while the first is in flight must be ignored.
    fireEvent.click(screen.getByRole('button', { name: /Creating account/ }))

    await waitFor(() => expect(register).toHaveBeenCalledTimes(1))
    expect(register).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: /Creating account/ })).toBeDisabled()
  })

  describe('existing account redemption', () => {
    beforeEach(() => {
      preview.mockResolvedValue(pendingPreview({ accountExists: true }))
    })

    it('does not show registration fields when an account exists, and shows the invited email', async () => {
      renderPage()

      expect(
        await screen.findByText('An account already exists for this email.'),
      ).toBeInTheDocument()
      expect(screen.getByText(INVITED_EMAIL)).toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Create account' }),
      ).not.toBeInTheDocument()
      expect(
        screen.queryByLabelText('Confirm password'),
      ).not.toBeInTheDocument()
      expect(register).not.toHaveBeenCalled()
      expectTokenNotInStorage()
    })

    it('shows the sign-in form within the invitation flow for unauthenticated users', async () => {
      renderPage()
      await screen.findByText('An account already exists for this email.')

      expect(screen.getByLabelText('Username')).toBeInTheDocument()
      expect(screen.getByLabelText('Password')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
      expect(
        screen.queryByRole('button', { name: 'Accept invitation' }),
      ).not.toBeInTheDocument()
    })

    it('sends the normal username/password payload through the SessionProvider login', async () => {
      apiLogin.mockResolvedValue(EXISTING_USER)
      renderPage()
      await screen.findByText('An account already exists for this email.')

      fillSignInForm()

      await waitFor(() => expect(apiLogin).toHaveBeenCalledTimes(1))
      expect(apiLogin).toHaveBeenCalledWith('chris', 'Passw0rd!x')
    })

    it('prevents duplicate sign-in submissions while login is pending', async () => {
      apiLogin.mockReturnValue(new Promise<ApiUser>(() => {}))
      renderPage()
      await screen.findByText('An account already exists for this email.')

      fillSignInForm()
      fireEvent.click(screen.getByRole('button', { name: /Signing in/ }))

      await waitFor(() => expect(apiLogin).toHaveBeenCalledTimes(1))
      expect(apiLogin).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('button', { name: /Signing in/ })).toBeDisabled()
    })

    it('updates the normal SessionProvider auth state and stays in the invitation flow after login', async () => {
      apiLogin.mockResolvedValue(EXISTING_USER)
      renderPage()
      await screen.findByText('An account already exists for this email.')

      fillSignInForm()

      await screen.findByRole('button', { name: 'Accept invitation' })
      expect(screen.getByTestId('session-probe')).toHaveTextContent('chris')
      // Still inside the invitation flow: the accept action is offered
      // and the URL never gains the token.
      expect(screen.getByTestId('location-search').textContent).toBe('')
      expect(screen.queryByText(TOKEN)).not.toBeInTheDocument()
    })

    it('does not automatically accept the invitation after a successful login', async () => {
      apiLogin.mockResolvedValue(EXISTING_USER)
      renderPage()
      await screen.findByText('An account already exists for this email.')

      fillSignInForm()

      await screen.findByRole('button', { name: 'Accept invitation' })
      expect(accept).not.toHaveBeenCalled()
    })

    it('accepts only through the explicit action and uses the original in-memory token', async () => {
      apiLogin.mockResolvedValue(EXISTING_USER)
      renderPage()
      await screen.findByText('An account already exists for this email.')

      fillSignInForm()
      await screen.findByRole('button', { name: 'Accept invitation' })

      fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }))

      await waitFor(() => expect(accept).toHaveBeenCalledTimes(1))
      expect(accept).toHaveBeenCalledWith(TOKEN)
    })

    it('shows the terminal success state and continues into the app after acceptance', async () => {
      apiLogin.mockResolvedValue(EXISTING_USER)
      renderPage()
      await screen.findByText('An account already exists for this email.')

      fillSignInForm()
      await screen.findByRole('button', { name: 'Accept invitation' })
      fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }))

      expect(await screen.findByRole('status')).toHaveTextContent(
        'Your invitation has been accepted.',
      )
      expect(screen.queryByRole('button', { name: 'Accept invitation' })).not.toBeInTheDocument()

      fireEvent.click(
        screen.getByRole('button', { name: 'Continue to workspace' }),
      )
      expect(await screen.findByTestId('authenticated-app')).toBeInTheDocument()
      expect(await screen.findByText('signed-in:chris')).toBeInTheDocument()
    })

    it('discards the raw token after successful acceptance', async () => {
      apiLogin.mockResolvedValue(EXISTING_USER)
      renderPage()
      await screen.findByText('An account already exists for this email.')

      fillSignInForm()
      await screen.findByRole('button', { name: 'Accept invitation' })
      fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }))

      await screen.findByRole('status')
      // The preview must not re-run with the discarded token, the token
      // is not rendered, and the URL never carries it.
      expect(preview).toHaveBeenCalledTimes(1)
      expect(screen.queryByText(TOKEN)).not.toBeInTheDocument()
      expect(screen.getByTestId('location-search').textContent).toBe('')
      expectTokenNotInStorage()
    })

    it('never writes the token to localStorage or sessionStorage across the whole flow', async () => {
      apiLogin.mockResolvedValue(EXISTING_USER)
      renderPage()
      await screen.findByText('An account already exists for this email.')
      expectTokenNotInStorage()

      fillSignInForm()
      await screen.findByRole('button', { name: 'Accept invitation' })
      expectTokenNotInStorage()

      fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }))
      await screen.findByRole('status')
      expectTokenNotInStorage()
    })

    it('lets an already-authenticated matching account accept without another login', async () => {
      me.mockResolvedValue(EXISTING_USER)
      renderPage()

      await screen.findByRole('button', { name: 'Accept invitation' })
      expect(apiLogin).not.toHaveBeenCalled()
      expect(screen.getByText(/You are signed in as/)).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }))
      await waitFor(() => expect(accept).toHaveBeenCalledTimes(1))
      expect(accept).toHaveBeenCalledWith(TOKEN)
      expect(
        await screen.findByText('Your invitation has been accepted.'),
      ).toBeInTheDocument()
    })

    it('blocks an already-authenticated wrong account from accepting', async () => {
      me.mockResolvedValue(OTHER_USER)
      renderPage()

      expect(await screen.findByRole('alert')).toHaveTextContent(
        /different account/i,
      )
      expect(screen.getByRole('alert')).toHaveTextContent(
        'maria@example.com',
      )
      expect(
        screen.queryByRole('button', { name: 'Accept invitation' }),
      ).not.toBeInTheDocument()
      expect(screen.queryByLabelText('Username')).not.toBeInTheDocument()
      expect(accept).not.toHaveBeenCalled()
    })

    it('lets a wrong account sign out and return to the sign-in step without losing the in-memory token', async () => {
      me.mockResolvedValue(OTHER_USER)
      apiLogin.mockResolvedValue(EXISTING_USER)
      renderPage()

      expect(await screen.findByRole('alert')).toHaveTextContent(
        /different account/i,
      )
      fireEvent.click(
        screen.getByRole('button', { name: 'Sign out and use another account' }),
      )

      // Same invitation flow, no navigation, and the sign-in step is
      // back — the token still lives only in component memory.
      await screen.findByLabelText('Username')
      expect(
        screen.getByText('An account already exists for this email.'),
      ).toBeInTheDocument()
      expect(screen.getByTestId('location-search').textContent).toBe('')

      fillSignInForm()
      await screen.findByRole('button', { name: 'Accept invitation' })
      fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }))
      await waitFor(() => expect(accept).toHaveBeenCalledTimes(1))
      expect(accept).toHaveBeenCalledWith(TOKEN)
      expect(await screen.findByRole('status')).toHaveTextContent(
        'Your invitation has been accepted.',
      )
    })
  })

  describe('live password policy', () => {
    it('renders the Login-style branding, heading and invitation subtitle', async () => {
      renderPage()

      expect(await screen.findByText('FG Workspace')).toBeInTheDocument()
      expect(screen.getByText('Research OS')).toBeInTheDocument()
      expect(
        screen.getByRole('heading', { name: 'Create your account' }),
      ).toBeInTheDocument()
      expect(
        screen.getByText('You’ve been invited to FG Workspace'),
      ).toBeInTheDocument()
    })

    it('does not render the decorative FG tile in the new-account form', async () => {
      renderPage()
      await screen.findByLabelText('Username')

      expect(
        screen.queryByText('FG', { exact: true }),
      ).not.toBeInTheDocument()
    })

    it('starts with empty, placeholder-free fields and the required autocomplete values', async () => {
      renderPage()
      const usernameInput = await screen.findByLabelText('Username')
      const passwordInput = screen.getByLabelText('Password')
      const confirmInput = screen.getByLabelText('Confirm password')

      expect(usernameInput).toHaveValue('')
      expect(passwordInput).toHaveValue('')
      expect(confirmInput).toHaveValue('')
      for (const input of [usernameInput, passwordInput, confirmInput]) {
        expect(input).not.toHaveAttribute('placeholder')
      }
      expect(usernameInput).toHaveAttribute('autocomplete', 'username')
      expect(passwordInput).toHaveAttribute('autocomplete', 'new-password')
      expect(confirmInput).toHaveAttribute('autocomplete', 'new-password')
    })

    it('renders no requirement guidance at all while the password is empty', async () => {
      renderPage()
      await screen.findByLabelText('Username')
      // The initial (empty-candidate) policy check settles…
      await waitFor(() => expect(policy).toHaveBeenCalledTimes(1))
      await act(async () => {})
      // …but with an empty password nothing is presented: no rows, no
      // checking line, no accessible state text.
      expect(requirementRows()).toHaveLength(0)
      expect(
        screen.queryByText('Checking password requirements…'),
      ).not.toBeInTheDocument()
      expect(screen.queryByText('At least 8 characters')).not.toBeInTheDocument()
      expect(
        screen.queryByText('Not a commonly used password'),
      ).not.toBeInTheDocument()
      expect(screen.queryByText('Not entirely numeric')).not.toBeInTheDocument()
      expect(
        screen.queryByText('Password is too similar to your personal information.'),
      ).not.toBeInTheDocument()
      expect(stateCount('Satisfied.')).toBe(0)
      expect(stateCount('Not satisfied.')).toBe(0)
      expect(
        screen.getByLabelText('Password'),
      ).not.toHaveAttribute('aria-invalid')
    })

    it('shows the three normal guidance rules with concise copy once the password has a value', async () => {
      renderPage()
      await screen.findByLabelText('Username')
      expect(requirementRows()).toHaveLength(0)

      fireEvent.change(screen.getByLabelText('Password'), {
        target: { value: 'Testpassword' },
      })
      await waitFor(() => expect(requirementRows()).toHaveLength(3))

      expect(screen.getByText('At least 8 characters')).toBeInTheDocument()
      expect(
        screen.getByText('Not a commonly used password'),
      ).toBeInTheDocument()
      expect(screen.getByText('Not entirely numeric')).toBeInTheDocument()
      // The satisfied similarity rule is omitted — no positive row.
      expect(
        screen.queryByText('Password is too similar to your personal information.'),
      ).not.toBeInTheDocument()
      // No raw Django help text for the known validators.
      for (const raw of Object.values(REQUIREMENT_LABELS)) {
        expect(screen.queryByText(raw)).not.toBeInTheDocument()
      }
      expect(stateCount('Satisfied.')).toBe(3)
      expect(stateCount('Not satisfied.')).toBe(0)
    })

    it('debounces the live policy validation and only checks the latest candidate', async () => {
      const candidates: Array<[string, string]> = []
      policy.mockImplementation((_token: string, u: string, p: string) => {
        candidates.push([u, p])
        return Promise.resolve(policyResponse())
      })
      renderPage()
      await screen.findByLabelText('Username')
      await waitFor(() => expect(candidates).toHaveLength(1))

      vi.useFakeTimers()
      try {
        act(() => {
          fireEvent.change(screen.getByLabelText('Password'), {
            target: { value: 'A' },
          })
          fireEvent.change(screen.getByLabelText('Password'), {
            target: { value: 'AB' },
          })
          fireEvent.change(screen.getByLabelText('Password'), {
            target: { value: 'ABC' },
          })
        })
        // No new request yet: the debounce window has not elapsed.
        expect(candidates).toHaveLength(1)

        await act(async () => {
          vi.advanceTimersByTime(300)
        })
        expect(candidates).toHaveLength(2)
        expect(candidates[1]).toEqual(['', 'ABC'])

        // A new keystroke restarts the window.
        act(() => {
          fireEvent.change(screen.getByLabelText('Password'), {
            target: { value: 'ABCD' },
          })
        })
        await act(async () => {
          vi.advanceTimersByTime(100)
        })
        expect(candidates).toHaveLength(2)
        await act(async () => {
          vi.advanceTimersByTime(200)
        })
        expect(candidates).toHaveLength(3)
        expect(candidates[2]).toEqual(['', 'ABCD'])
      } finally {
        vi.useRealTimers()
      }
    })

    it('revalidates the password policy when the username changes', async () => {
      const candidates: Array<[string, string]> = []
      policy.mockImplementation((_token: string, u: string, p: string) => {
        candidates.push([u, p])
        return Promise.resolve(policyResponse())
      })
      renderPage()
      await screen.findByLabelText('Username')
      await waitFor(() => expect(candidates).toHaveLength(1))

      fireEvent.change(screen.getByLabelText('Password'), {
        target: { value: 'Passw0rd!x' },
      })
      await waitFor(() => expect(candidates).toHaveLength(2))
      expect(candidates[1]).toEqual(['', 'Passw0rd!x'])

      fireEvent.change(screen.getByLabelText('Username'), {
        target: { value: 'newbie' },
      })
      await waitFor(() => expect(candidates).toHaveLength(3))
      expect(candidates[2]).toEqual(['newbie', 'Passw0rd!x'])
    })

    it('renders a checking state while the current candidate is validated, without stale success', async () => {
      renderPage()
      await screen.findByLabelText('Username')
      await waitFor(() => expect(policy).toHaveBeenCalledTimes(1))
      await act(async () => {})

      let resolveCurrent: (value: unknown) => void = () => {}
      policy.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveCurrent = resolve
        }),
      )
      fireEvent.change(screen.getByLabelText('Password'), {
        target: { value: 'Passw0rd!x' },
      })

      // The current candidate has no authoritative verdict yet: a single
      // checking line, and no stale rows from the earlier candidate.
      await waitFor(() =>
        expect(
          screen.queryByText('Checking password requirements…'),
        ).toBeInTheDocument(),
      )
      expect(requirementRows()).toHaveLength(0)
      expect(
        screen.getByRole('button', { name: 'Create account' }),
      ).toBeDisabled()
      expect(stateCount('Satisfied.')).toBe(0)
      expect(stateCount('Not satisfied.')).toBe(0)

      await act(async () => {
        resolveCurrent(policyResponse())
      })
      // The verdict for the current candidate renders the concise rows.
      await waitFor(() => expect(requirementRows()).toHaveLength(3))
      expect(indicatorCount(requirementsList(), 'check')).toBe(3)
      expect(stateCount('Satisfied.')).toBe(3)
      expect(stateCount('Not satisfied.')).toBe(0)
      expect(
        screen.queryByText('Checking password requirements…'),
      ).not.toBeInTheDocument()
    })

    it('never lets a stale policy response overwrite a newer candidate', async () => {
      let call = 0
      let resolveFirst: (value: unknown) => void = () => {}
      let resolveSecond: (value: unknown) => void = () => {}
      policy.mockImplementation(() => {
        call += 1
        if (call === 2) {
          return new Promise((resolve) => {
            resolveFirst = resolve
          })
        }
        if (call === 3) {
          return new Promise((resolve) => {
            resolveSecond = resolve
          })
        }
        return Promise.resolve(policyResponse())
      })
      renderPage()
      await screen.findByLabelText('Username')
      await waitFor(() => expect(policy).toHaveBeenCalledTimes(1))

      fireEvent.change(screen.getByLabelText('Password'), {
        target: { value: 'FirstPass1!' },
      })
      await waitFor(() => expect(policy).toHaveBeenCalledTimes(2))
      fireEvent.change(screen.getByLabelText('Password'), {
        target: { value: 'SecondPass1!' },
      })
      await waitFor(() => expect(policy).toHaveBeenCalledTimes(3))

      // The OLDER response resolves first and claims its candidate valid.
      await act(async () => {
        resolveFirst(policyResponse())
      })
      await act(async () => {})

      const button = screen.getByRole('button', { name: 'Create account' })
      expect(button).toBeDisabled()
      // No stale success may be displayed while the newer candidate is
      // still pending: only the checking line, no rows at all…
      expect(requirementRows()).toHaveLength(0)
      expect(
        screen.getByText('Checking password requirements…'),
      ).toBeInTheDocument()
      // … and not semantically either.
      expect(stateCount('Satisfied.')).toBe(0)
      expect(stateCount('Not satisfied.')).toBe(0)

      // The NEWER response settles with a failure: its verdict is shown.
      await act(async () => {
        resolveSecond(policyResponse(['password_too_short']))
      })
      await waitFor(() => expect(requirementRows()).toHaveLength(3))
      expect(
        indicatorCount(requirementsList(), 'radio_button_unchecked'),
      ).toBe(1)
      expect(indicatorCount(requirementsList(), 'check')).toBe(2)
      expect(button).toBeDisabled()
      // The newer verdict is exposed row by row.
      expect(stateCount('Not satisfied.')).toBe(1)
      expect(stateCount('Satisfied.')).toBe(2)
      const failingRow = screen
        .getByText('At least 8 characters')
        .closest('li')
      expect(failingRow).toHaveTextContent('Not satisfied.')
      expect(failingRow).not.toHaveTextContent('Satisfied.')
    })

    it('marks the password field invalid while the current policy fails and clears it when the current policy passes', async () => {
      renderPage()
      await screen.findByLabelText('Username')
      const passwordInput = screen.getByLabelText('Password')
      expect(passwordInput).not.toHaveAttribute('aria-invalid')

      policy.mockResolvedValue(
        policyResponse(['password_too_short', 'password_too_common']),
      )
      fireEvent.change(passwordInput, { target: { value: 'short' } })
      await waitFor(() =>
        expect(passwordInput).toHaveAttribute('aria-invalid', 'true'),
      )
      await waitFor(() => expect(requirementRows()).toHaveLength(3))
      expect(
        indicatorCount(requirementsList(), 'radio_button_unchecked'),
      ).toBe(2)
      expect(indicatorCount(requirementsList(), 'check')).toBe(1)
      // The two failing rules expose "Not satisfied" on their own rows.
      expect(stateCount('Not satisfied.')).toBe(2)
      expect(stateCount('Satisfied.')).toBe(1)
      const failingRow = screen
        .getByText('At least 8 characters')
        .closest('li')
      expect(failingRow).toHaveTextContent('Not satisfied.')

      policy.mockResolvedValue(policyResponse())
      fireEvent.change(passwordInput, { target: { value: 'Passw0rd!x' } })
      // Wait for the NEW candidate's authoritative verdict; only it may
      // clear the invalid state.
      await waitFor(() =>
        expect(indicatorCount(requirementsList(), 'check')).toBe(3),
      )
      expect(passwordInput).not.toHaveAttribute('aria-invalid')
      expect(stateCount('Satisfied.')).toBe(3)
      expect(stateCount('Not satisfied.')).toBe(0)
    })

    it('keeps Create account disabled and shows a verification error when the live check fails', async () => {
      renderPage()
      await screen.findByLabelText('Username')
      await waitFor(() => expect(policy).toHaveBeenCalledTimes(1))
      await act(async () => {})

      policy.mockRejectedValue(new ApiError(500, null))
      fireEvent.change(screen.getByLabelText('Password'), {
        target: { value: 'Passw0rd!x' },
      })

      expect(
        await screen.findByRole('alert'),
      ).toHaveTextContent(/could not verify the password requirements/i)
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Create account' }),
        ).toBeDisabled(),
      )
      // No stale rows from the previous candidate are presented…
      expect(requirementRows()).toHaveLength(0)
      // …and a recovered check brings the guidance back.
      policy.mockResolvedValue(policyResponse())
      fireEvent.change(screen.getByLabelText('Password'), {
        target: { value: 'Passw0rd!xy' },
      })
      await waitFor(() => expect(requirementRows()).toHaveLength(3))
      expect(stateCount('Satisfied.')).toBe(3)
    })

    it('disables Create account while an authoritative validation is pending', async () => {
      renderPage()
      await screen.findByLabelText('Username')
      await waitFor(() =>
        expect(
          screen.queryByText('Checking password requirements…'),
        ).not.toBeInTheDocument(),
      )

      await waitFor(() => expect(policy).toHaveBeenCalledTimes(1))

      let resolveCurrent: (value: unknown) => void = () => {}
      policy.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveCurrent = resolve
        }),
      )
      fireEvent.change(screen.getByLabelText('Username'), {
        target: { value: 'newbie' },
      })
      // The username-only candidate is now pending.
      await waitFor(() => expect(policy).toHaveBeenCalledTimes(2))
      expect(
        screen.getByRole('button', { name: 'Create account' }),
      ).toBeDisabled()

      await act(async () => {
        resolveCurrent(policyResponse())
      })
      // Still disabled: the password is still empty.
      expect(
        screen.getByRole('button', { name: 'Create account' }),
      ).toBeDisabled()
    })

    it('disables Create account with a failed current policy and enables it for a fully valid candidate', async () => {
      renderPage()
      await screen.findByLabelText('Username')
      const button = screen.getByRole('button', { name: 'Create account' })
      // Empty username: disabled.
      expect(button).toBeDisabled()

      await waitFor(() => expect(policy).toHaveBeenCalledTimes(1))
      fireEvent.change(screen.getByLabelText('Username'), {
        target: { value: 'newbie' },
      })
      await waitFor(() => expect(policy).toHaveBeenCalledTimes(2))
      // Password still empty: disabled.
      expect(button).toBeDisabled()

      // Failed current policy: disabled.
      policy.mockResolvedValue(policyResponse(['password_too_common']))
      fireEvent.change(screen.getByLabelText('Password'), {
        target: { value: 'Passw0rd!' },
      })
      await waitFor(() =>
        expect(
          screen.getByLabelText('Password'),
        ).toHaveAttribute('aria-invalid', 'true'),
      )
      expect(button).toBeDisabled()

      // Valid current policy but empty confirmation: disabled.
      policy.mockResolvedValue(policyResponse())
      fireEvent.change(screen.getByLabelText('Password'), {
        target: { value: 'Passw0rd!x' },
      })
      await waitFor(() =>
        expect(
          screen.getByLabelText('Password'),
        ).not.toHaveAttribute('aria-invalid'),
      )
      expect(button).toBeDisabled()

      // Matching confirmation: enabled.
      fireEvent.change(screen.getByLabelText('Confirm password'), {
        target: { value: 'Passw0rd!x' },
      })
      await waitFor(() => expect(button).toBeEnabled())
    })

    it('reconciles the displayed requirements with the final registration password rejection', async () => {
      register.mockRejectedValue(
        new ApiError(400, {
          error: 'The password does not meet the requirements.',
          code: 'password',
          requirements: policyResponse(['password_too_common']).requirements,
        }),
      )
      renderPage()
      await screen.findByLabelText('Username')

      await fillRegistrationForm()

      expect(
        await screen.findByRole('alert'),
      ).toHaveTextContent('The password does not meet the requirements.')
      await waitFor(() => expect(requirementRows()).toHaveLength(3))
      expect(
        indicatorCount(requirementsList(), 'radio_button_unchecked'),
      ).toBe(1)
      expect(indicatorCount(requirementsList(), 'check')).toBe(2)
      // The rejected requirement is presented with the concise copy…
      const failingRow = screen
        .getByText('Not a commonly used password')
        .closest('li')
      expect(failingRow).toHaveTextContent('Not satisfied.')
      // …never with the raw Django help text.
      expect(
        screen.queryByText('Password cannot be a commonly used password.'),
      ).not.toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'Create account' }),
      ).toBeDisabled()
    })
  })

  describe('Create Account presentation', () => {
    it('renders the form inside a fixed 380px column whose gutters stay outside the content box', async () => {
      const { container } = renderPage()
      await screen.findByLabelText('Username')

      const form = container.querySelector('form') as HTMLFormElement
      const column = form.parentElement as HTMLElement
      const gutter = column.parentElement as HTMLElement

      // Fixed 380px content width, capped by the available width so a
      // narrow screen shrinks it instead of overflowing.
      expect(column.className).toContain('w-[380px]')
      expect(column.className).toContain('max-w-full')
      // Nothing inside the 380px box carries horizontal padding — the
      // 24px page gutters live on the outer wrapper.
      const horizontalPadding = column.className
        .split(/\s+/)
        .filter((cls) => /^(px|pl|pr|p)-/.test(cls) || cls === 'p')
      expect(horizontalPadding).toEqual([])
      expect(gutter.className).toContain('px-6')
      // The editable controls fill the fixed column: on a wide desktop
      // they measure 380px because their containing box is 380px.
      expect(screen.getByLabelText('Username').className).toContain('w-full')
      expect(screen.getByLabelText('Password').className).toContain('w-full')
      expect(
        screen.getByLabelText('Confirm password'),
      ).toHaveClass('w-full')
      expect(
        screen.getByRole('button', { name: 'Create account' }),
      ).toHaveClass('w-full')
    })

    it('renders the exact branding and page-heading typography contract', async () => {
      renderPage()
      await screen.findByLabelText('Username')

      const brand = screen.getByText('FG Workspace')
      expect(brand.className).toContain('text-[22px]')
      expect(brand.className).toContain('leading-[28px]')
      expect(brand.className).toContain('font-semibold')

      const brandSub = screen.getByText('Research OS')
      expect(brandSub.className).toContain('text-[12px]')
      expect(brandSub.className).toContain('leading-[18px]')
      expect(brandSub.className).toContain('font-normal')

      const heading = screen.getByRole('heading', {
        name: 'Create your account',
      })
      expect(heading.className).toContain('text-[20px]')
      expect(heading.className).toContain('leading-[28px]')
      expect(heading.className).toContain('font-semibold')

      const subtitle = screen.getByText('You’ve been invited to FG Workspace')
      expect(subtitle.className).toContain('text-[13px]')
      expect(subtitle.className).toContain('leading-[20px]')
      expect(subtitle.className).toContain('font-normal')
    })

    it('keeps the password reveal controls collision-free with browser credential controls', async () => {
      renderPage()
      const passwordInput = await screen.findByLabelText('Password')
      const confirmInput = screen.getByLabelText('Confirm password')

      // Both password inputs reserve the 72px trailing band…
      for (const input of [passwordInput, confirmInput]) {
        expect(input.className).toContain('pr-[72px]')
        // …while keeping password-manager semantics intact.
        expect(input).toHaveAttribute('autocomplete', 'new-password')
      }

      // Own reveal targets: 32x32, 4px radius, 18px icon, in the offset
      // slot that leaves the far-right band free for the browser's
      // native credential/reveal control.
      const toggles = screen.getAllByRole('button', {
        name: 'Show password',
      })
      expect(toggles).toHaveLength(2)
      for (const toggle of toggles) {
        expect(toggle.className).toContain('h-8')
        expect(toggle.className).toContain('w-8')
        expect(toggle.className).toContain('rounded')
        expect(toggle.className).toContain('right-[32px]')
        const icon = toggle.querySelector('span') as HTMLElement
        expect(icon.className).toContain('text-[18px]')
      }
    })

    it('omits a satisfied similarity requirement from the checklist', async () => {
      renderPage()
      await screen.findByLabelText('Username')

      fireEvent.change(screen.getByLabelText('Password'), {
        target: { value: 'Testpassword' },
      })
      await waitFor(() => expect(requirementRows()).toHaveLength(3))
      // No visible row for the passing similarity rule…
      expect(
        screen.queryByText('Password is too similar to your personal information.'),
      ).not.toBeInTheDocument()
      // …and no accessible row for it either.
      expect(stateCount('Satisfied.')).toBe(3)
      expect(stateCount('Not satisfied.')).toBe(0)
    })

    it('renders a failed similarity requirement as a concise danger error row', async () => {
      renderPage()
      await screen.findByLabelText('Username')

      policy.mockResolvedValue(policyResponse(['password_too_similar']))
      fireEvent.change(screen.getByLabelText('Password'), {
        target: { value: 'maria-dev' },
      })
      await waitFor(() =>
        expect(
          screen.queryByText('Password is too similar to your personal information.'),
        ).toBeInTheDocument(),
      )

      const row = screen
        .getByText('Password is too similar to your personal information.')
        .closest('li') as HTMLElement
      expect(row.className).toContain('text-danger')
      expect(row).toHaveTextContent('Not satisfied.')
      // The other rules keep their concise satisfied copy…
      expect(screen.getByText('At least 8 characters')).toBeInTheDocument()
      expect(
        screen.getByText('Not a commonly used password'),
      ).toBeInTheDocument()
      expect(screen.getByText('Not entirely numeric')).toBeInTheDocument()
      // …and the raw Django help text is never shown.
      expect(
        screen.queryByText(REQUIREMENT_LABELS.password_too_similar),
      ).not.toBeInTheDocument()
    })

    it('falls back to the backend label for an unknown requirement code', async () => {
      renderPage()
      await screen.findByLabelText('Username')

      policy.mockImplementation(() =>
        Promise.resolve({
          valid: false,
          requirements: [
            ...policyResponse().requirements,
            {
              code: 'password_must_contain_symbol',
              label: 'Password must contain a symbol.',
              satisfied: false,
            },
          ],
          accountExists: false,
        }),
      )
      fireEvent.change(screen.getByLabelText('Password'), {
        target: { value: 'Testpassword' },
      })

      // The unknown enforced requirement is never silently hidden.
      const row = (
        await screen.findByText('Password must contain a symbol.')
      ).closest('li') as HTMLElement
      expect(row).not.toBeNull()
      expect(row).toHaveTextContent('Not satisfied.')
      // 3 known rows + 1 unknown row (satisfied similarity omitted).
      expect(requirementRows()).toHaveLength(4)
    })

    it('never appends visible Satisfied / Not satisfied / Checking state words to rendered rows', async () => {
      renderPage()
      await screen.findByLabelText('Username')

      policy.mockResolvedValue(policyResponse(['password_too_short']))
      fireEvent.change(screen.getByLabelText('Password'), {
        target: { value: 'short' },
      })
      await waitFor(() => expect(requirementRows()).toHaveLength(3))

      for (const row of requirementRows()) {
        const visible = row.cloneNode(true) as HTMLElement
        visible.querySelectorAll('.sr-only').forEach((el) => el.remove())
        expect(visible.textContent).not.toMatch(
          /Satisfied\.|Not satisfied\.|Checking\./,
        )
      }
      // The accessible state text remains for screen readers.
      expect(stateCount('Satisfied.')).toBe(2)
      expect(stateCount('Not satisfied.')).toBe(1)
    })
  })
})

describe('StrictMode double mount (real dev-server behavior)', () => {
  // The production app renders under <StrictMode> (main.tsx) and the
  // E2E dev server therefore runs mount effects as setup/cleanup/setup.
  // The invitation preview must still resolve to its state in that
  // sequence: the first (cancelled) preview attempt must not block the
  // effect from completing the preview on the second run.
  beforeEach(() => {
    vi.clearAllMocks()
    me.mockRejectedValue(new ApiError(401, { error: 'Not authenticated' }))
    preview.mockResolvedValue(pendingPreview())
    policy.mockResolvedValue(policyResponse())
  })

  afterEach(() => {
    cleanup()
  })

  function renderStrict() {
    return render(
      <StrictMode>
        <MemoryRouter initialEntries={[`/register?token=${TOKEN}`]}>
          <SessionProvider>
            <Routes>
              <Route path="/register" element={<RegistrationPage />} />
              <Route path="/" element={<AuthenticatedSentinel />} />
            </Routes>
          </SessionProvider>
        </MemoryRouter>
      </StrictMode>,
    )
  }

  it('new-account preview still resolves to the registration form under StrictMode', async () => {
    renderStrict()

    // preview answers 200; the page must leave the "Checking your
    // invitation…" loading state instead of sticking in it.
    await screen.findByLabelText('Username')
    expect(screen.getByText(INVITED_EMAIL)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Create account' }),
    ).toBeVisible()
  })

  it('existing-account preview still resolves to the in-flow sign-in under StrictMode', async () => {
    preview.mockResolvedValue(pendingPreview({ accountExists: true }))
    renderStrict()

    await screen.findByText('An account already exists for this email.')
    expect(screen.getByText(INVITED_EMAIL)).toBeInTheDocument()
    expect(screen.getByLabelText('Username')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeVisible()
  })
})
