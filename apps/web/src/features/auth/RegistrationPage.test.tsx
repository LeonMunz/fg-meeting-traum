// @vitest-environment happy-dom

import { StrictMode } from 'react'

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
}))

vi.mock('../../api/account-invitations', () => ({
  acceptAccountInvitation: vi.fn(),
}))

import * as authApi from '../../api/auth'
import * as invitationApi from '../../api/account-invitations'

const me = authApi.me as Mock
const preview = authApi.previewRegistrationInvitation as Mock
const register = authApi.register as Mock
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

function fillRegistrationForm(
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
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
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

    fillRegistrationForm()

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

    fillRegistrationForm()

    expect(await screen.findByTestId('authenticated-app')).toBeInTheDocument()
    expect(await screen.findByText('signed-in:newbie')).toBeInTheDocument()
  })

  it('shows a client-side error when the passwords do not match', async () => {
    register.mockResolvedValue(NEW_USER)
    renderPage()
    await screen.findByLabelText('Username')

    fillRegistrationForm('newbie', 'Passw0rd!x', 'different')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Passwords do not match.',
    )
    expect(register).not.toHaveBeenCalled()
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

    fillRegistrationForm()

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

    fillRegistrationForm()

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

    fillRegistrationForm()
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
