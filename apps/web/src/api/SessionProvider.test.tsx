// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { SessionProvider } from './SessionProvider'
import { useSession } from './useSession'
import type { ApiUser } from './types'

vi.mock('./auth', () => ({
  login: vi.fn(),
  logout: vi.fn(),
  me: vi.fn(),
}))

import * as authApi from './auth'

const apiLogout = authApi.logout as Mock
const apiMe = authApi.me as Mock

const USER: ApiUser = {
  id: 1,
  username: 'alice',
  firstName: 'Alice',
  lastName: 'Lindqvist',
  email: 'alice@example.com',
}

let probe: ReturnType<typeof useSession> | null = null

function Probe() {
  const session = useSession()
  probe = session
  return (
    <div data-testid="session-probe">
      {session.user ? `signed-in:${session.user.username}` : 'anonymous'}
    </div>
  )
}

function renderProvider() {
  return render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  probe = null
})

beforeEach(() => {
  vi.mocked(apiMe).mockReset()
  vi.mocked(apiLogout).mockReset()
})

describe('SessionProvider — authentication loss', () => {
  it('clears the local session state without a logout request to the invalid session', async () => {
    apiMe.mockResolvedValue(USER)
    renderProvider()

    expect(await screen.findByTestId('session-probe')).toHaveTextContent(
      'signed-in:alice',
    )
    expect(probe).not.toBeNull()

    probe!.handleAuthenticationLost()

    await waitFor(() => {
      expect(screen.getByTestId('session-probe')).toHaveTextContent('anonymous')
    })
    // No logout POST is sent to the already-invalid server session.
    expect(apiLogout).not.toHaveBeenCalled()
    expect(probe!.user).toBeNull()
    expect(probe!.loading).toBe(false)
  })

  it('is a local no-op without side effects when already unauthenticated', async () => {
    apiMe.mockRejectedValue(new Error('401'))
    renderProvider()

    expect(await screen.findByTestId('session-probe')).toHaveTextContent(
      'anonymous',
    )
    expect(() => probe!.handleAuthenticationLost()).not.toThrow()

    expect(screen.getByTestId('session-probe')).toHaveTextContent('anonymous')
    expect(apiLogout).not.toHaveBeenCalled()
  })
})
