/** API response types. */

export interface ApiError {
  error: string
}

/** Current user as returned by the server. */
export interface ApiUser {
  id: number
  username: string
  firstName: string
  lastName: string
  email: string
}

/** Research group as returned by the server. */
export interface ApiResearchGroup {
  id: number
  name: string
  role: 'admin' | 'member'
}
