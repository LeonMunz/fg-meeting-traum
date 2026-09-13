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

import { LoginPage } from './LoginPage'

vi.mock('../../api/auth', () => ({
  login: vi.fn(),
  logout: vi.fn(),
  me: vi.fn(),
  register: vi.fn(),
  previewRegistrationInvitation: vi.fn(),
}))

import * as authApi from '../../api/auth'

const me = authApi.me as Mock
const apiLogin = authApi.login as Mock

const USER: ApiUser = {
  id: 2,
  username: 'alex',
  firstName: 'Alex',
  lastName: 'Dev',
  email: 'alex@example.com',
}

function SignedInSentinel() {
  const { user } = useSession()
  return (
    <div data-testid="signed-in-sentinel">
      {user ? `signed-in:${user.username}` : 'anonymous'}
    </div>
  )
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <SessionProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<SignedInSentinel />} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  )
}

/** Wait until the initial /me recovery finished so submit is enabled. */
async function ready() {
  await waitFor(() => {
    expect(
      screen.getByRole('button', { name: 'Sign in' }),
    ).toBeEnabled()
  })
}

function fillCredentials(username: string, password: string) {
  fireEvent.change(screen.getByLabelText('Username'), {
    target: { value: username },
  })
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: password },
  })
}

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    me.mockRejectedValue(
      new ApiError(401, { error: 'Not authenticated' }),
    )
  })

  afterEach(() => {
    cleanup()
  })

  it('renders the typographic branding without the FG tile', async () => {
    renderPage()

    expect(await screen.findByText('FG Workspace')).toBeInTheDocument()
    expect(screen.getByText('Research OS')).toBeInTheDocument()

    // The old decorative square FG tile must be gone.
    expect(
      screen.queryByText('FG', { exact: true }),
    ).not.toBeInTheDocument()
  })

  it('renders the Sign in heading without a subtitle', async () => {
    renderPage()

    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('Sign in to continue'),
    ).not.toBeInTheDocument()
  })

  it('does not render development credentials or example values', async () => {
    const { container } = renderPage()
    await screen.findByText('FG Workspace')

    const text = container.textContent ?? ''
    expect(text).not.toContain('Development credentials')
    expect(text).not.toContain('DevPass1!')
    expect(text).not.toContain('e.g. alex')
  })

  it('associates real labels with both fields', async () => {
    renderPage()

    const username = await screen.findByLabelText('Username')
    const password = screen.getByLabelText('Password')

    expect(username.tagName).toBe('INPUT')
    expect(username).toHaveAttribute('type', 'text')
    expect(password.tagName).toBe('INPUT')
    expect(password).toHaveAttribute('type', 'password')
  })

  it('has no placeholder values on either field', async () => {
    renderPage()

    const username = await screen.findByLabelText('Username')
    const password = screen.getByLabelText('Password')

    expect(username).not.toHaveAttribute('placeholder')
    expect(password).not.toHaveAttribute('placeholder')
  })

  it('uses the canonical autocomplete hints', async () => {
    renderPage()

    const username = await screen.findByLabelText('Username')
    const password = screen.getByLabelText('Password')

    expect(username).toHaveAttribute('autocomplete', 'username')
    expect(password).toHaveAttribute(
      'autocomplete',
      'current-password',
    )
  })

  it('does not show validation or auth errors on initial render', async () => {
    renderPage()

    await screen.findByText('FG Workspace')

    expect(
      screen.queryByText('Enter your username.'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Enter your password.'),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows field errors for empty fields on submit and clears them while typing', async () => {
    renderPage()
    await ready()

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(
      await screen.findByText('Enter your username.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Enter your password.'),
    ).toBeInTheDocument()
    expect(apiLogin).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'alex' },
    })
    expect(
      screen.queryByText('Enter your username.'),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText('Enter your password.'),
    ).toBeInTheDocument()
  })

  it('submits through the existing login/session flow and enters the workspace', async () => {
    apiLogin.mockResolvedValue(USER)
    renderPage()
    await ready()

    fillCredentials('alex', 'DevPass1!')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(apiLogin).toHaveBeenCalledTimes(1)
    expect(apiLogin).toHaveBeenCalledWith('alex', 'DevPass1!')

    expect(
      await screen.findByText('signed-in:alex'),
    ).toBeInTheDocument()
  })

  it('prevents duplicate submits while a request is in flight', async () => {
    let settle: (value: ApiUser) => void = () => {}
    apiLogin.mockReturnValue(
      new Promise<ApiUser>((resolve) => {
        settle = resolve
      }),
    )
    renderPage()
    await ready()

    fillCredentials('alex', 'DevPass1!')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    const submit = screen.getByRole('button', {
      name: 'Signing in…',
    })
    const form = submit.closest('form')
    expect(form).not.toBeNull()
    fireEvent.submit(form as HTMLFormElement)

    expect(apiLogin).toHaveBeenCalledTimes(1)

    settle(USER)
    expect(
      await screen.findByText('signed-in:alex'),
    ).toBeInTheDocument()
  })

  it('shows the loading label and disables the button while in flight', async () => {
    apiLogin.mockReturnValue(new Promise<ApiUser>(() => {}))
    renderPage()
    await ready()

    fillCredentials('alex', 'DevPass1!')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    const loadingButton = await screen.findByRole('button', {
      name: 'Signing in…',
    })
    expect(loadingButton).toBeDisabled()
  })

  it('renders the canonical compact error on backend auth failure', async () => {
    apiLogin.mockRejectedValue(
      new ApiError(401, { error: 'Invalid username or password' }),
    )
    renderPage()
    await ready()

    fillCredentials('alex', 'wrong-password')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'The username or password is incorrect.',
    )

    // Backend-internal details must not leak into the UI.
    expect(
      screen.queryByText('Invalid username or password'),
    ).not.toBeInTheDocument()

    // The username remains; the submit button recovers.
    expect(screen.getByLabelText('Username')).toHaveValue('alex')
    expect(
      await screen.findByRole('button', { name: 'Sign in' }),
    ).toBeEnabled()
  })

  it('toggles password visibility with an accessible control', async () => {
    renderPage()
    await ready()

    const password = screen.getByLabelText('Password')
    const showToggle = screen.getByRole('button', {
      name: 'Show password',
    })

    expect(password).toHaveAttribute('type', 'password')

    fireEvent.click(showToggle)
    expect(password).toHaveAttribute('type', 'text')
    const hideToggle = screen.getByRole('button', {
      name: 'Hide password',
    })
    expect(hideToggle).toBeInTheDocument()

    fireEvent.click(hideToggle)
    expect(password).toHaveAttribute('type', 'password')
  })
})
