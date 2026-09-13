// @vitest-environment happy-dom

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
import { MemoryRouter, Route, Routes } from 'react-router'

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

import * as authApi from '../../api/auth'

const me = authApi.me as Mock
const preview = authApi.previewRegistrationInvitation as Mock
const register = authApi.register as Mock

const TOKEN = 'invite-token-123'
const INVITED_EMAIL = 'new.user@example.com'

const NEW_USER: ApiUser = {
  id: 42,
  username: 'newbie',
  firstName: '',
  lastName: '',
  email: INVITED_EMAIL,
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

function renderPage(initialEntry = `/register?token=${TOKEN}`) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <SessionProvider>
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

describe('RegistrationPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    me.mockRejectedValue(new ApiError(401, { error: 'Not authenticated' }))
    preview.mockResolvedValue(pendingPreview())
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

  it('shows the Login path instead of the form when an account exists', async () => {
    preview.mockResolvedValue(pendingPreview({ accountExists: true }))
    renderPage()

    expect(
      await screen.findByText(/An account already exists for this email/),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Create account' }),
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('link', { name: 'Sign in' }))
    expect(await screen.findByText('login-page-sentinel')).toBeInTheDocument()
    expect(register).not.toHaveBeenCalled()
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
    'renders a terminal state without a form when the invite is %s',
    async (status, message) => {
      preview.mockResolvedValue({ status, usable: false })
      renderPage()

      expect(await screen.findByRole('alert')).toHaveTextContent(message)
      expect(screen.queryByLabelText('Username')).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Create account' }),
      ).not.toBeInTheDocument()
    },
  )

  it('renders an invalid state when the preview returns 404', async () => {
    preview.mockRejectedValue(
      new ApiError(404, { error: 'This invitation token is invalid.' }),
    )
    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /invalid or was not recognized/i,
    )
    expect(
      screen.queryByRole('button', { name: 'Create account' }),
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
})
