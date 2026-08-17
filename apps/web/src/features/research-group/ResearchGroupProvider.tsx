import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import type { ReactNode } from 'react'

import { listResearchGroups } from '../../api/research-groups'
import type { ApiResearchGroup } from '../../api/types'
import {
  ResearchGroupContext,
  type ResearchGroupContextValue,
} from './ResearchGroupContext'

const ACTIVE_GROUP_STORAGE_KEY =
  'fg-workspace.active-research-group-id'

type ResearchGroupProviderProps = {
  children: ReactNode
}

function readStoredGroupId(): number | null {
  try {
    const raw = window.localStorage.getItem(
      ACTIVE_GROUP_STORAGE_KEY,
    )

    if (!raw) {
      return null
    }

    const parsed = Number(raw)

    return Number.isInteger(parsed) && parsed > 0
      ? parsed
      : null
  } catch {
    return null
  }
}

function storeGroupId(groupId: number | null) {
  try {
    if (groupId == null) {
      window.localStorage.removeItem(
        ACTIVE_GROUP_STORAGE_KEY,
      )
      return
    }

    window.localStorage.setItem(
      ACTIVE_GROUP_STORAGE_KEY,
      String(groupId),
    )
  } catch {
    // Local UI preference only. Storage failure must not break the app.
  }
}

export function ResearchGroupProvider({
  children,
}: ResearchGroupProviderProps) {
  const [groups, setGroups] = useState<ApiResearchGroup[]>([])
  const [
    activeResearchGroupId,
    setActiveResearchGroupIdState,
  ] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reloadResearchGroups = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const nextGroups = await listResearchGroups()

      setGroups(nextGroups)

      const storedGroupId = readStoredGroupId()
      const storedGroupStillAccessible =
        storedGroupId != null &&
        nextGroups.some(
          (group) => group.id === storedGroupId,
        )

      const nextActiveGroupId =
        storedGroupStillAccessible
          ? storedGroupId
          : (nextGroups[0]?.id ?? null)

      setActiveResearchGroupIdState(nextActiveGroupId)
      storeGroupId(nextActiveGroupId)
    } catch (err) {
      setGroups([])
      setActiveResearchGroupIdState(null)
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to load research groups.',
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reloadResearchGroups()
  }, [reloadResearchGroups])

  const setActiveResearchGroupId = useCallback(
    (groupId: number) => {
      const isAccessible = groups.some(
        (group) => group.id === groupId,
      )

      if (!isAccessible) {
        return
      }

      setActiveResearchGroupIdState(groupId)
      storeGroupId(groupId)
    },
    [groups],
  )

  const activeResearchGroup = useMemo(
    () =>
      groups.find(
        (group) => group.id === activeResearchGroupId,
      ) ?? null,
    [activeResearchGroupId, groups],
  )

  const value = useMemo<ResearchGroupContextValue>(
    () => ({
      groups,
      activeResearchGroupId,
      activeResearchGroup,
      loading,
      error,
      setActiveResearchGroupId,
      reloadResearchGroups,
    }),
    [
      activeResearchGroup,
      activeResearchGroupId,
      error,
      groups,
      loading,
      reloadResearchGroups,
      setActiveResearchGroupId,
    ],
  )

  return (
    <ResearchGroupContext.Provider value={value}>
      {children}
    </ResearchGroupContext.Provider>
  )
}
