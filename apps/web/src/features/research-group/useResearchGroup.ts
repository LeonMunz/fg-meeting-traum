import { useContext } from 'react'

import { ResearchGroupContext } from './ResearchGroupContext'

export function useResearchGroup() {
  const context = useContext(ResearchGroupContext)

  if (!context) {
    throw new Error(
      'useResearchGroup must be used inside ResearchGroupProvider',
    )
  }

  return context
}
