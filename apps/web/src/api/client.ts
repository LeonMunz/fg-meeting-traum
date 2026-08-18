/**
 * Minimal API client with session cookies and CSRF handling.
 *
 * - Sends cookies with every request.
 * - Obtains a CSRF token before unsafe requests.
 * - Converts non-2xx responses into ApiError.
 */

export async function apiGet<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })

  return parseResponse<T>(res)
}

export async function apiPost<T>(
  url: string,
  body: unknown,
): Promise<T> {
  return apiUnsafeRequest<T>('POST', url, body)
}

export async function apiPatch<T>(
  url: string,
  body: unknown,
): Promise<T> {
  return apiUnsafeRequest<T>('PATCH', url, body)
}

export async function apiDelete<T>(
  url: string,
  body?: unknown,
): Promise<T> {
  return apiUnsafeRequest<T>('DELETE', url, body)
}

async function apiUnsafeRequest<T>(
  method: 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<T> {
  const csrfToken = await getCsrftoken()

  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-CSRFToken': csrfToken ?? '',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  return parseResponse<T>(res)
}

async function parseResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    throw new ApiError(
      res.status,
      await res.json().catch(() => null),
    )
  }

  if (res.status === 204) {
    return undefined as T
  }

  return res.json() as Promise<T>
}

/** Retrieve the Django CSRF token cookie value. */
async function getCsrftoken(): Promise<string | null> {
  const cookie = document.cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('csrftoken='))

  if (cookie) {
    return cookie.split('=')[1]
  }

  try {
    await fetch('/api/auth/csrf/', {
      credentials: 'same-origin',
    })

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
