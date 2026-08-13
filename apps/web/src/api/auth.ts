import { apiGet, apiPost } from './client'
import type { ApiUser } from './types'

/** Login with username/password. Creates a server session. */
export async function login(username: string, password: string): Promise<ApiUser> {
  return apiPost<ApiUser>('/api/auth/login/', { username, password })
}

/** Logout. Destroys the server session. */
export async function logout(): Promise<void> {
  await apiPost<Record<string, never>>('/api/auth/logout/', {})
}

/** Get the current authenticated user. Returns 401 if not authenticated. */
export async function me(): Promise<ApiUser> {
  return apiGet<ApiUser>('/api/auth/me/')
}
