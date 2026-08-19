import { useEffect } from 'react'

import { useResearchGroup } from './useResearchGroup'

export function useSyncResearchGroupContext(
  researchGroupId: number | null | undefined,
) {
  const {
    groups,
    activeResearchGroupId,
    loading,
    setActiveResearchGroupId,
  } = useResearchGroup()

  useEffect(() => {
    if (
      loading ||
      researchGroupId == null ||
      researchGroupId === activeResearchGroupId
    ) {
      return
    }

    const isAccessible = groups.some(
      (group) =>
        group.id === researchGroupId,
    )

    if (isAccessible) {
      setActiveResearchGroupId(
        researchGroupId,
      )
    }
  }, [
    activeResearchGroupId,
    groups,
    loading,
    researchGroupId,
    setActiveResearchGroupId,
  ])
}
