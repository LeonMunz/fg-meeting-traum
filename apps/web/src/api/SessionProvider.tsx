import { createContext, useCallback, useContext, useEffect, useState } from 'react'

import { login as apiLogin, logout as apiLogout, me as apiMe } from '../api/auth'
import { ApiError } from '../api/client'
import type { ApiUser } from '../api/types'

interface SessionState {
  user: ApiUser | null
  loading: boolean
  error: string | null
}

interface SessionContextValue extends SessionState {
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

const SessionContext = createContext<SessionContextValue | null>(null)

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SessionState>({
    user: null,
    loading: true,
    error: null,
  })

  const login = useCallback(async (username: string, password: string) => {
    setState((prev) => ({ ...prev, loading: true, error: null }))
    try {
      const user = await apiLogin(username, password)
      setState({ user, loading: false, error: null })
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.detail && typeof err.detail === 'object' && 'error' in err.detail
            ? (err.detail as { error: string }).error
            : `Login failed (${err.status})`
          : 'Login failed'
      setState({ user: null, loading: false, error: message })
      throw err
    }
  }, [])

  const logout = useCallback(async () => {
    try {
      await apiLogout()
    } catch {
      // Ignore logout errors
    }
    setState({ user: null, loading: false, error: null })
  }, [])

  // On mount, try to recover session from /api/auth/me/
  useEffect(() => {
    let cancelled = false
    apiMe()
      .then((user) => {
        if (!cancelled) setState({ user, loading: false, error: null })
      })
      .catch(() => {
        if (!cancelled) setState({ user: null, loading: false, error: null })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <SessionContext.Provider value={{ ...state, login, logout }}>
      {children}
    </SessionContext.Provider>
  )
}

export function useSession() {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used inside SessionProvider')
  return ctx
}
