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
}

export const ResearchGroupContext =
  createContext<ResearchGroupContextValue | null>(null)
