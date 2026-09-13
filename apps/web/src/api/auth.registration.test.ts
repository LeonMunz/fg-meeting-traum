// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  previewRegistrationInvitation,
  register,
} from './auth'

function jsonResponse(status: number, data: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  }
}

describe('invite-only registration client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends exactly {token, username, password} to /api/auth/register/', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(201, {
          id: 42,
          username: 'newbie',
          firstName: '',
          lastName: '',
          email: 'new.user@example.com',
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const user = await register('tok', 'newbie', 'Passw0rd!x')

    expect(user.username).toBe('newbie')
    const call = fetchMock.mock.calls.find(
      (c) => c[0] === '/api/auth/register/',
    )
    expect(call).toBeTruthy()
    const body = JSON.parse((call![1] as RequestInit).body as string)
    expect(body).toEqual({
      token: 'tok',
      username: 'newbie',
      password: 'Passw0rd!x',
    })
    expect('email' in body).toBe(false)
  })

  it('sends exactly {token} to the invitation preview endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, {
          status: 'pending',
          usable: true,
          invitedEmail: 'new.user@example.com',
          expiresAt: '2026-09-20T00:00:00Z',
          accountExists: false,
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const data = await previewRegistrationInvitation('tok')

    expect(data.invitedEmail).toBe('new.user@example.com')
    const call = fetchMock.mock.calls.find(
      (c) => c[0] === '/api/auth/registration-invitation/',
    )
    expect(call).toBeTruthy()
    const body = JSON.parse((call![1] as RequestInit).body as string)
    expect(body).toEqual({ token: 'tok' })
  })
})
