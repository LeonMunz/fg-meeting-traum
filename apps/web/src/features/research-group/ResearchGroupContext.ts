import { createContext } from 'react'

import type { ApiResearchGroup } from '../../api/types'

export type ResearchGroupContextValue = {
  groups: ApiResearchGroup[]
  activeResearchGroupId: number | null
  activeResearchGroup: ApiResearchGroup | null
  loading: boolean
  error: string | null
  setActiveResearchGroupId: (groupId: number) => void
  reloadResearchGroups: () => Promise<void>
  /**
   * Register a Research Group that the server just created for the
   * current user. Adds the exact server-serialized object to the
   * canonical list (if not already present) and makes it the active
   * Research Group.
   */
  addResearchGroup: (group: ApiResearchGroup) => void
}

export const ResearchGroupContext =
  createContext<ResearchGroupContextValue | null>(null)
