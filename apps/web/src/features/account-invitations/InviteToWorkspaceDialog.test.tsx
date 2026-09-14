// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import { ApiError } from '../../api/client'
import { createAccountInvitation } from '../../api/account-invitations'

import { InviteToWorkspaceDialog } from './InviteToWorkspaceDialog'

vi.mock('../../api/account-invitations', () => ({
  createAccountInvitation: vi.fn(),
}))

const TOKEN = 'raw-token-123'

function makeCreated(
  overrides: Record<string, unknown> = {},
) {
  return {
    id: 'inv-1',
    invitedEmail: 'colleague@example.com',
    invitedBy: '7',
    status: 'pending',
    createdAt: '2026-09-01T12:00:00Z',
    expiresAt: '2026-09-08T12:00:00Z',
    acceptedAt: null,
    revokedAt: null,
    token: TOKEN,
    ...overrides,
  }
}

const REGISTRATION_URL = `${window.location.origin}/register?token=${encodeURIComponent(TOKEN)}`

function mockClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined)

  const fakeNavigator = Object.create(
    Object.getPrototypeOf(navigator),
  )
  Object.defineProperty(fakeNavigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  })

  vi.stubGlobal('navigator', fakeNavigator)

  return writeText
}

function renderOpen(props: {
  onClose?: () => void
  onCreated?: () => void
} = {}) {
  const onClose = props.onClose ?? vi.fn()
  const onCreated = props.onCreated ?? vi.fn()

  const utils = render(
    <InviteToWorkspaceDialog
      open
      onClose={onClose}
      onCreated={onCreated}
    />,
  )

  return { onClose, onCreated, ...utils }
}

function submitCreate(email: string) {
  fireEvent.change(screen.getByLabelText('Email'), {
    target: { value: email },
  })
  fireEvent.click(
    screen.getByRole('button', { name: 'Create invitation' }),
  )
}

function storedTokens(): string[] {
  const values: string[] = []

  for (const store of [window.localStorage, window.sessionStorage]) {
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i)

      if (key !== null) {
        values.push(key)
        values.push(store.getItem(key) ?? '')
      }
    }
  }

  return values
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(createAccountInvitation as ReturnType<typeof vi.fn>).mockReset()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.localStorage.clear()
  window.sessionStorage.clear()
})

describe('InviteToWorkspaceDialog', () => {
  it('renders the required explanation and a fresh email form', () => {
    renderOpen()

    const dialog = screen.getByRole('dialog', {
      name: 'Invite to FG Workspace',
    })
    expect(dialog).toBeVisible()
    expect(
      screen.getByText('Invite someone to create an FG Workspace account.'),
    ).toBeVisible()
    expect(
      screen.getByText(
        'This does not grant access to research groups or projects.',
      ),
    ).toBeVisible()

    const emailInput = screen.getByLabelText('Email')
    expect(emailInput).toHaveAttribute('type', 'email')
    expect(emailInput).toHaveAttribute('autocomplete', 'email')
    expect(emailInput).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Create invitation' })).toBeEnabled()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('Invitation created')).toBeNull()
  })

  it('submits the trimmed email through the existing API', async () => {
    ;(createAccountInvitation as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeCreated(),
    )

    renderOpen()
    submitCreate('  Alice@Example.COM  ')

    await waitFor(() => {
      expect(createAccountInvitation).toHaveBeenCalledWith(
        'Alice@Example.COM',
      )
    })
  })

  it('shows the invited email and one-time registration link on success without auto-closing', async () => {
    const onClose = vi.fn()
    ;(createAccountInvitation as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeCreated({ invitedEmail: 'newcol@example.com' }),
    )

    renderOpen({ onClose })
    submitCreate('newcol@example.com')

    expect(
      await screen.findByText('Invitation created'),
    ).toBeVisible()
    expect(
      screen.getByText('newcol@example.com', { exact: true }),
    ).toBeVisible()

    const dialog = screen.getByRole('dialog', {
      name: 'Invite to FG Workspace',
    })
    expect(within(dialog).getByText('Registration link')).toBeVisible()
    expect(within(dialog).getByText(REGISTRATION_URL)).toBeVisible()

    // The dialog remains open showing the result; the caller decides
    // when to close it.
    expect(dialog).toBeVisible()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('tells the caller to refresh its invitation list after a successful creation', async () => {
    const onCreated = vi.fn()
    ;(createAccountInvitation as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeCreated(),
    )

    renderOpen({ onCreated })
    submitCreate('colleague@example.com')

    await screen.findByText('Invitation created')

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledTimes(1)
    })
  })

  it('copies the registration URL with accessible feedback', async () => {
    const writeText = mockClipboard()
    ;(createAccountInvitation as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeCreated(),
    )

    renderOpen()
    submitCreate('colleague@example.com')
    await screen.findByText('Invitation created')

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(REGISTRATION_URL)
    })
    expect(screen.getByText('Link copied to clipboard.')).toBeVisible()
  })

  it('closing after success removes the transient token/result and reopening is clean', async () => {
    const { rerender } = render(
      <InviteToWorkspaceDialog
        open
        onClose={() => undefined}
      />,
    )

    ;(createAccountInvitation as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeCreated(),
    )
    submitCreate('colleague@example.com')
    await screen.findByText('Invitation created')

    expect(document.querySelector('code')?.textContent).toContain(TOKEN)

    // The caller closes the dialog.
    rerender(<InviteToWorkspaceDialog open={false} onClose={() => undefined} />)
    expect(screen.queryByRole('dialog')).toBeNull()

    // Reopening starts a fresh invitation interaction.
    rerender(<InviteToWorkspaceDialog open onClose={() => undefined} />)

    const dialog = screen.getByRole('dialog', {
      name: 'Invite to FG Workspace',
    })
    expect(dialog).toBeVisible()
    expect(screen.getByLabelText('Email')).toHaveValue('')
    expect(screen.queryByText('Invitation created')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.querySelector('code')?.textContent ?? '').not.toContain(TOKEN)
    expect(
      screen.getByRole('button', { name: 'Create invitation' }),
    ).toBeVisible()
  })

  it('maps an invalid email failure to the user-facing message and retains the entered email', async () => {
    ;(createAccountInvitation as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiError(400, {
        error: 'A valid e-mail address is required.',
        code: 'invalid_email',
      }),
    )

    renderOpen()
    submitCreate('not-an-email')

    expect(
      await screen.findByText('Enter a valid email address.'),
    ).toBeVisible()

    // The dialog stays open and the entered email is retained.
    expect(
      screen.getByRole('dialog', {
        name: 'Invite to FG Workspace',
      }),
    ).toBeVisible()
    expect(screen.getByLabelText('Email')).toHaveValue('not-an-email')
  })

  it('maps account_exists to the user-facing message', async () => {
    ;(createAccountInvitation as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiError(409, {
        error: 'An account with this e-mail address already exists.',
        code: 'account_exists',
      }),
    )

    renderOpen()
    submitCreate('existing@example.com')

    expect(
      await screen.findByText(
        'This person already has an FG Workspace account.',
      ),
    ).toBeVisible()
    expect(screen.getByLabelText('Email')).toHaveValue(
      'existing@example.com',
    )
  })

  it('maps pending_invitation_exists to the user-facing message', async () => {
    ;(createAccountInvitation as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiError(409, {
        error: 'An invitation for this email address is already pending.',
        code: 'pending_invitation_exists',
      }),
    )

    renderOpen()
    submitCreate('pending@example.com')

    expect(
      await screen.findByText(
        'An invitation for this email address is already pending.',
      ),
    ).toBeVisible()
    expect(screen.getByLabelText('Email')).toHaveValue(
      'pending@example.com',
    )
  })

  it('maps a generic or unexpected failure to the fallback message', async () => {
    ;(createAccountInvitation as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('boom'),
    )

    renderOpen()
    submitCreate('colleague@example.com')

    expect(
      await screen.findByText(
        'The invitation could not be created. Try again.',
      ),
    ).toBeVisible()
    expect(screen.getByLabelText('Email')).toHaveValue(
      'colleague@example.com',
    )
  })

  it('prevents duplicate create submissions', async () => {
    ;(createAccountInvitation as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(() => {}),
    )

    renderOpen()
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'colleague@example.com' },
    })

    const form = screen
      .getByRole('button', { name: /Create invitation/ })
      .closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    fireEvent.submit(form)

    expect(createAccountInvitation).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole('button', { name: 'Creating…' }),
    ).toBeDisabled()
  })

  it('closes with the Escape key', () => {
    const onClose = vi.fn()

    renderOpen({ onClose })
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('never persists the raw token in browser storage', async () => {
    mockClipboard()
    ;(createAccountInvitation as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeCreated(),
    )

    renderOpen()
    submitCreate('colleague@example.com')
    await screen.findByText('Invitation created')

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await screen.findByText('Link copied to clipboard.')

    for (const value of storedTokens()) {
      expect(value).not.toContain(TOKEN)
    }
  })
})
