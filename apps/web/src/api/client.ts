/**
 * Minimal API client with session cookies and CSRF handling.
 *
 * - Sends cookies with every request (credentials: 'same-origin').
 * - For unsafe methods, obtains a CSRF token before sending.
 */

export async function apiGet<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) {
    throw new ApiError(res.status, await res.json().catch(() => null))
  }
  return res.json()
}

export async function apiPost<T>(url: string, body: unknown): Promise<T> {
  const csrfToken = await getCsrftoken()
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-CSRFToken': csrfToken ?? '',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new ApiError(res.status, await res.json().catch(() => null))
  }
  return res.json()
}

/** Retrieve the Django CSRF token cookie value. */
async function getCsrftoken(): Promise<string | null> {
  const cookie = document.cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('csrftoken='))
  if (cookie) return cookie.split('=')[1]

  // No cookie yet — obtain one from the CSRF endpoint
  try {
    await fetch('/api/auth/csrf/', { credentials: 'same-origin' })
    const newCookie = document.cookie
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('csrftoken='))
    return newCookie?.split('=')[1] ?? null
  } catch {
    return null
  }
}

export class ApiError extends Error {
  public readonly status: number
  public readonly detail: unknown

  constructor(status: number, detail: unknown) {
    super(`API error ${status}`)
    this.status = status
    this.detail = detail
  }
}
