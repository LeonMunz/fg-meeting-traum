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
} from 'vitest'

import { ApiError } from '../../api/client'
import {
  createAccountInvitation,
  listAccountInvitations,
  revokeAccountInvitation,
} from '../../api/account-invitations'
import type { ApiAccountInvitation } from '../../api/account-invitations'

import { InvitationsSettingsPage } from './InvitationsSettingsPage'

vi.mock('../../api/account-invitations', () => ({
  listAccountInvitations: vi.fn(),
  createAccountInvitation: vi.fn(),
  revokeAccountInvitation: vi.fn(),
}))

const TOKEN = 'raw-token-123'

function makeInvitation(
  overrides: Partial<ApiAccountInvitation> = {},
): ApiAccountInvitation {
  return {
    id: 'inv-1',
    invitedEmail: 'colleague@example.com',
    invitedBy: '7',
    status: 'pending',
    createdAt: '2026-09-01T12:00:00Z',
    expiresAt: '2026-09-08T12:00:00Z',
    acceptedAt: null,
    revokedAt: null,
    ...overrides,
  }
}

function makeCreated(
  overrides: Partial<ApiAccountInvitation> = {},
) {
  return {
    ...makeInvitation(overrides),
    token: TOKEN,
  }
}

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

beforeEach(() => {
  vi.clearAllMocks()
  ;(listAccountInvitations as ReturnType<typeof vi.fn>).mockResolvedValue({
    invitations: [],
  })
  ;(createAccountInvitation as ReturnType<typeof vi.fn>).mockReset()
  ;(revokeAccountInvitation as ReturnType<typeof vi.fn>).mockReset()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.localStorage.clear()
  window.sessionStorage.clear()
})

function submitCreate(email: string) {
  fireEvent.change(screen.getByLabelText('Email address'), {
    target: { value: email },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }))
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

describe('InvitationsSettingsPage', () => {
  it('loads the current user\'s invitation list with state and dates', async () => {
    ;(listAccountInvitations as ReturnType<typeof vi.fn>).mockResolvedValue({
      invitations: [makeInvitation()],
    })

    render(<InvitationsSettingsPage />)

    expect(listAccountInvitations).toHaveBeenCalledTimes(1)
    expect(
      await screen.findByText('colleague@example.com'),
    ).toBeVisible()
    expect(screen.getByText('Pending', { exact: true })).toBeVisible()
    expect(
      screen.getByText(/Created Sep 1, 2026/),
    ).toBeVisible()
    expect(
      screen.getByText(/Expires Sep 8, 2026/),
    ).toBeVisible()
  })

  it('shows a clear empty state when there are no invitations', async () => {
    render(<InvitationsSettingsPage />)

    expect(
      await screen.findByText(
        /No invitations yet/,
      ),
    ).toBeVisible()
  })

  it('submits the trimmed email payload on create', async () => {
    ;(createAccountInvitation as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeCreated(),
    )

    render(<InvitationsSettingsPage />)

    await screen.findByRole('button', {
      name: 'Create invitation',
    })

    submitCreate('  Alice@Example.COM  ')

    expect(
      createAccountInvitation,
    ).toHaveBeenCalledWith('Alice@Example.COM')
  })

  it('shows the returned invitation and a one-time registration URL containing the raw token after a successful create', async () => {
    const created = makeCreated({
      id: 'inv-new',
      invitedEmail: 'newcol@example.com',
    })
    ;(createAccountInvitation as ReturnType<typeof vi.fn>).mockResolvedValue(
      created,
    )
    ;(listAccountInvitations as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ invitations: [] })
      .mockResolvedValueOnce({ invitations: [makeInvitation(created)] })

    render(<InvitationsSettingsPage />)

    submitCreate('newcol@example.com')

    const creationLine = await screen.findByText(
      'Invitation created for newcol@example.com.',
    )
    const panel = creationLine.closest('[role="status"]')
    expect(panel).not.toBeNull()
    await waitFor(() => {
      expect(panel?.textContent).toContain('Expires Sep 8, 2026')
    })

    const code = document.querySelector('code')
    expect(code?.textContent).toBe(
      `${window.location.origin}/register?token=${encodeURIComponent(TOKEN)}`,
    )
  })

  it('copies the registration URL to the clipboard', async () => {
    const writeText = mockClipboard()
    ;(createAccountInvitation as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeCreated(),
    )

    render(<InvitationsSettingsPage />)

    submitCreate('colleague@example.com')
    await screen.findByText('Invitation created for colleague@example.com.')

    fireEvent.click(
      screen.getByRole('button', { name: 'Copy invitation link' }),
    )

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}/register?token=${encodeURIComponent(TOKEN)}`,
      )
    })
    expect(
      await screen.findByText('Link copied to clipboard.'),
    ).toBeVisible()
  })

  it('never persists the raw token in browser storage', async () => {
    mockClipboard()
    ;(createAccountInvitation as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeCreated(),
    )

    render(<InvitationsSettingsPage />)

    submitCreate('colleague@example.com')
    await screen.findByText('Invitation created for colleague@example.com.')

    fireEvent.click(
      screen.getByRole('button', { name: 'Copy invitation link' }),
    )
    await screen.findByText('Link copied to clipboard.')

    for (const value of storedTokens()) {
      expect(value).not.toContain(TOKEN)
    }
  })

  it('refreshes the list after a successful create', async () => {
    const created = makeCreated({
      id: 'inv-new',
      invitedEmail: 'newcol@example.com',
    })
    ;(createAccountInvitation as ReturnType<typeof vi.fn>).mockResolvedValue(
      created,
    )
    ;(listAccountInvitations as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ invitations: [] })
      .mockResolvedValueOnce({ invitations: [makeInvitation(created)] })

    render(<InvitationsSettingsPage />)

    submitCreate('newcol@example.com')
    await screen.findByText(
      'Invitation created for newcol@example.com.',
    )

    await waitFor(() => {
      expect(listAccountInvitations).toHaveBeenCalledTimes(2)
    })
    // The refreshed list shows the returned invitation.
    await screen.findByText('newcol@example.com')
  })

  it('exposes a revoke action for pending invitations', async () => {
    ;(listAccountInvitations as ReturnType<typeof vi.fn>).mockResolvedValue({
      invitations: [makeInvitation()],
    })

    render(<InvitationsSettingsPage />)

    await screen.findByText('colleague@example.com')
    expect(
      screen.getByRole('button', {
        name: 'Revoke invitation to colleague@example.com',
      }),
    ).toBeVisible()
  })

  it('does not expose revoke for terminal invitations', async () => {
    ;(listAccountInvitations as ReturnType<typeof vi.fn>).mockResolvedValue({
      invitations: [
        makeInvitation({
          id: 'inv-a',
          invitedEmail: 'accepted@example.com',
          status: 'accepted',
        }),
        makeInvitation({
          id: 'inv-r',
          invitedEmail: 'revoked@example.com',
          status: 'revoked',
        }),
        makeInvitation({
          id: 'inv-e',
          invitedEmail: 'expired@example.com',
          status: 'expired',
        }),
      ],
    })

    render(<InvitationsSettingsPage />)

    await screen.findByText('accepted@example.com')
    expect(screen.getByText('Accepted', { exact: true })).toBeVisible()
    expect(screen.getByText('Revoked', { exact: true })).toBeVisible()
    expect(screen.getByText('Expired', { exact: true })).toBeVisible()
    expect(
      screen.queryByRole('button', {
        name: /Revoke invitation to /,
      }),
    ).toBeNull()
  })

  it('revokes through the confirmation dialog using the invitation public ID and refreshes the list', async () => {
    ;(listAccountInvitations as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        invitations: [makeInvitation({ id: 'inv-42' })],
      })
      .mockResolvedValueOnce({
        invitations: [
          makeInvitation({
            id: 'inv-42',
            status: 'revoked',
            revokedAt: '2026-09-02T00:00:00Z',
          }),
        ],
      })
    ;(revokeAccountInvitation as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ detail: 'Invitation revoked' })

    render(<InvitationsSettingsPage />)

    await screen.findByText('colleague@example.com')
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Revoke invitation to colleague@example.com',
      }),
    )

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeVisible()

    fireEvent.click(
      screen.getByRole('button', { name: 'Revoke invitation' }),
    )

    await waitFor(() => {
      expect(revokeAccountInvitation).toHaveBeenCalledWith('inv-42')
    })
    await screen.findByText('Revoked', { exact: true })

    await waitFor(() => {
      expect(listAccountInvitations).toHaveBeenCalledTimes(2)
    })
    expect(
      screen.queryByRole('button', {
        name: /Revoke invitation to /,
      }),
    ).toBeNull()
  })

  it('renders API errors without losing the existing list state', async () => {
    ;(listAccountInvitations as ReturnType<typeof vi.fn>).mockResolvedValue({
      invitations: [makeInvitation()],
    })
    ;(createAccountInvitation as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiError(400, {
        error: 'A valid e-mail address is required.',
      }),
    )

    render(<InvitationsSettingsPage />)

    await screen.findByText('colleague@example.com')

    submitCreate('not-an-email')

    expect(
      await screen.findByText('A valid e-mail address is required.'),
    ).toBeVisible()
    // The existing row survives the failed create.
    expect(screen.getByText('colleague@example.com')).toBeVisible()
    expect(
      screen.queryByText(/Invitation created for /),
    ).toBeNull()
  })

  it('prevents duplicate create submissions', async () => {
    ;(createAccountInvitation as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(() => {}),
    )

    render(<InvitationsSettingsPage />)

    await screen.findByRole('button', {
      name: 'Create invitation',
    })

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'colleague@example.com' },
    })

    const form = screen.getByRole('button', { name: /Create invitation/ }).closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    fireEvent.submit(form)

    expect(createAccountInvitation).toHaveBeenCalledTimes(1)
  })

  it('prevents duplicate revoke confirmations', async () => {
    ;(listAccountInvitations as ReturnType<typeof vi.fn>).mockResolvedValue({
      invitations: [makeInvitation({ id: 'inv-42' })],
    })
    ;(revokeAccountInvitation as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(() => {}),
    )

    render(<InvitationsSettingsPage />)

    await screen.findByText('colleague@example.com')
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Revoke invitation to colleague@example.com',
      }),
    )

    await screen.findByRole('dialog')
    const confirm = screen.getByRole('button', {
      name: 'Revoke invitation',
    })
    fireEvent.click(confirm)
    fireEvent.click(confirm)

    expect(revokeAccountInvitation).toHaveBeenCalledTimes(1)
  })
})
