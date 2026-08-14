import { useContext } from 'react'

import { SessionContext } from './SessionProvider'

/** Access the current session state and actions.

Must be used inside a SessionProvider.
*/
export function useSession() {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used inside SessionProvider')
  return ctx
}
