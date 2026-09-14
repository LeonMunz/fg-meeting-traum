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
  window.localStorage.clear()
  window.sessionStorage.clear()
})

function openInviteDialog() {
  fireEvent.click(
    screen.getByRole('button', { name: 'Invite person' }),
  )
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
      await screen.findByText(/No invitations yet/),
    ).toBeVisible()
  })

  it('renders the Invite person action and no permanent creation form', async () => {
    render(<InvitationsSettingsPage />)

    expect(
      await screen.findByRole('button', {
        name: 'Invite person',
      }),
    ).toBeVisible()

    // The invitation creation form no longer lives on the page.
    expect(screen.queryByRole('form')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Send invitation' }),
    ).toBeNull()
    expect(screen.queryByLabelText('Email', { exact: true })).toBeNull()
  })

  it('opens the reusable invite dialog from the Invite person action', async () => {
    render(<InvitationsSettingsPage />)

    await screen.findByRole('button', { name: 'Invite person' })
    openInviteDialog()

    const dialog = await screen.findByRole('dialog', {
      name: 'Invite to FG Workspace',
    })
    expect(dialog).toBeVisible()
    expect(screen.getByLabelText('Email', { exact: true })).toBeVisible()
    expect(
      within(dialog).getByRole('button', { name: 'Send invitation' }),
    ).toBeVisible()
  })

  it('creates an invitation through the dialog, keeps the dialog open with the one-time link, and refreshes the list', async () => {
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

    await screen.findByRole('button', { name: 'Invite person' })
    openInviteDialog()
    fireEvent.change(
      await screen.findByLabelText('Email', { exact: true }),
      { target: { value: 'newcol@example.com' } },
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Send invitation' }),
    )

    const dialog = screen.getByRole('dialog', {
      name: 'Invite to FG Workspace',
    })

    // Success state appears inside the still-open dialog.
    expect(
      await within(dialog).findByText('Invitation created'),
    ).toBeVisible()
    expect(dialog).toBeVisible()

    // The dialog is the only <code> on the page at this point.
    const code = document.querySelector('code')
    expect(code?.textContent).toBe(
      `${window.location.origin}/register?token=${encodeURIComponent(TOKEN)}`,
    )

    // The caller refreshed its list; the created invitation is now
    // visible underneath.
    await waitFor(() => {
      expect(listAccountInvitations).toHaveBeenCalledTimes(2)
    })
    // The email is shown in the dialog result and in the refreshed
    // list row underneath.
    await waitFor(() => {
      expect(
        screen.getAllByText('newcol@example.com'),
      ).toHaveLength(2)
    })
  })

  it('closes the dialog after success; reopening starts a fresh invitation', async () => {
    ;(createAccountInvitation as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeCreated({ invitedEmail: 'newcol@example.com' }),
    )
    ;(listAccountInvitations as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ invitations: [] })
      .mockResolvedValueOnce({
        invitations: [makeInvitation({ id: 'inv-new', invitedEmail: 'newcol@example.com' })],
      })

    render(<InvitationsSettingsPage />)

    await screen.findByRole('button', { name: 'Invite person' })
    openInviteDialog()
    fireEvent.change(
      await screen.findByLabelText('Email', { exact: true }),
      { target: { value: 'newcol@example.com' } },
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Send invitation' }),
    )
    await screen.findByText('Invitation created')

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.querySelector('code')?.textContent ?? '').not.toContain(TOKEN)

    // Reopen: fresh email input, no stale result.
    openInviteDialog()
    const dialog = await screen.findByRole('dialog', {
      name: 'Invite to FG Workspace',
    })
    expect(within(dialog).getByLabelText('Email', { exact: true })).toHaveValue('')
    expect(screen.queryByText('Invitation created')).toBeNull()
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

    const dialog = await screen.findByRole('dialog', {
      name: 'Revoke invitation?',
    })
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

  it('keeps the existing list state when a post-creation refresh fails', async () => {
    ;(listAccountInvitations as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        invitations: [makeInvitation()],
      })
      .mockRejectedValue(new Error('boom'))
    ;(createAccountInvitation as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeCreated({
        id: 'inv-new',
        invitedEmail: 'newcol@example.com',
      }),
    )

    render(<InvitationsSettingsPage />)
    await screen.findByText('colleague@example.com')

    openInviteDialog()
    fireEvent.change(
      await screen.findByLabelText('Email', { exact: true }),
      { target: { value: 'newcol@example.com' } },
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Send invitation' }),
    )
    await screen.findByText('Invitation created')

    // The failed refresh surfaces an error but the existing row
    // survives.
    expect(
      await screen.findByText('Could not load your invitations.'),
    ).toBeVisible()
    expect(screen.getByText('colleague@example.com')).toBeVisible()
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

    await screen.findByRole('dialog', { name: 'Revoke invitation?' })
    const confirm = screen.getByRole('button', {
      name: 'Revoke invitation',
    })
    fireEvent.click(confirm)
    fireEvent.click(confirm)

    expect(revokeAccountInvitation).toHaveBeenCalledTimes(1)
  })
})
