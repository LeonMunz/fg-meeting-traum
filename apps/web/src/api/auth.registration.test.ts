// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  checkRegistrationPasswordPolicy,
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

describe('registration password-policy client', () => {
  const RESPONSE = {
    valid: false,
    requirements: [
      {
        code: 'password_too_short',
        label: 'Password must contain at least 8 characters.',
        satisfied: false,
      },
      {
        code: 'password_too_common',
        label: 'Password cannot be a commonly used password.',
        satisfied: true,
      },
    ],
    accountExists: false,
  }

  it('sends exactly {token, username, password} to the policy endpoint through the shared CSRF request path', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, RESPONSE))
    vi.stubGlobal('fetch', fetchMock)
    document.cookie = 'csrftoken=csrf-policy-token'

    const data = await checkRegistrationPasswordPolicy(
      'tok',
      'newbie',
      'short',
    )

    expect(data).toEqual(RESPONSE)
    const call = fetchMock.mock.calls.find(
      (c) => c[0] === '/api/auth/registration-password-policy/',
    )
    expect(call).toBeTruthy()
    const init = call![1] as RequestInit
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({ token: 'tok', username: 'newbie', password: 'short' })
    expect('email' in body).toBe(false)
    // Real shared CSRF infrastructure: the X-CSRFToken header carries the
    // csrftoken cookie value.
    const headers = init.headers as Record<string, string>
    expect(headers['X-CSRFToken']).toBe('csrf-policy-token')
    expect(headers['Content-Type']).toBe('application/json')
    expect(init.credentials).toBe('same-origin')
    // No fallback CSRF fetch is needed when the cookie already exists.
    expect(
      fetchMock.mock.calls.some((c) => c[0] === '/api/auth/csrf/'),
    ).toBe(false)

    localStorage.clear()
    sessionStorage.clear()
  })

  it('fetches the CSRF token from /api/auth/csrf/ when the cookie is missing', async () => {
    // Ensure a stale cookie from an earlier test cannot mask the fallback.
    document.cookie = 'csrftoken=; expires=Thu, 01 Jan 1970 00:00:00 GMT'
    const fetchMock = vi
      .fn()
      .mockImplementation(async (url: string) => {
        if (url === '/api/auth/csrf/') {
          return {
            ok: true,
            status: 200,
            json: async () => ({}),
          }
        }
        return jsonResponse(200, RESPONSE)
      })
    vi.stubGlobal('fetch', fetchMock)

    await checkRegistrationPasswordPolicy('tok', 'newbie', 'short')

    expect(
      fetchMock.mock.calls.some((c) => c[0] === '/api/auth/csrf/'),
    ).toBe(true)
  })

  it('parses valid, requirements and accountExists from the response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, RESPONSE)),
    )

    const data = await checkRegistrationPasswordPolicy('tok', 'newbie', 'short')

    expect(data.valid).toBe(false)
    expect(data.accountExists).toBe(false)
    expect(data.requirements).toHaveLength(2)
    expect(data.requirements[0]).toEqual({
      code: 'password_too_short',
      label: 'Password must contain at least 8 characters.',
      satisfied: false,
    })
  })

  it('does not persist the candidate password or the token', async () => {
    localStorage.clear()
    sessionStorage.clear()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, RESPONSE)),
    )

    await checkRegistrationPasswordPolicy('secret-tok', 'newbie', 'Secret123!')

    const stored = [
      ...Object.values(localStorage),
      ...Object.values(sessionStorage),
    ].join('|')
    expect(stored).not.toContain('secret-tok')
    expect(stored).not.toContain('Secret123!')
  })
})
