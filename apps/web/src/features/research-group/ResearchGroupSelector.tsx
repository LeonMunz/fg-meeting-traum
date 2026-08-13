import { useEffect, useState } from 'react'

import { listResearchGroups } from '../../api/research-groups'
import type { ApiResearchGroup } from '../../api/types'

interface ResearchGroupSelectorProps {
  onSelect: (groupId: number) => void
  selectedGroupId?: number
}

export function ResearchGroupSelector({
  onSelect,
  selectedGroupId,
}: ResearchGroupSelectorProps) {
  const [groups, setGroups] = useState<ApiResearchGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listResearchGroups()
      .then(setGroups)
      .catch((err) => setError(err.message ?? 'Failed to load groups'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-on-surface-variant">
        <span className="material-symbols-outlined text-[18px] animate-spin">
          refresh
        </span>
        Loading…
      </div>
    )
  }

  if (error) {
    return (
      <div className="text-sm text-error">
        {error}
      </div>
    )
  }

  if (groups.length === 0) {
    return (
      <div className="text-sm text-on-surface-variant">
        Not a member of any research group yet.
      </div>
    )
  }

  return (
    <div className="flex flex-wrap gap-2">
      {groups.map((group) => {
        const isSelected = group.id === selectedGroupId
        return (
          <button
            key={group.id}
            type="button"
            onClick={() => onSelect(group.id)}
            className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
              isSelected
                ? 'border-primary bg-primary-container text-on-primary-container'
                : 'border-outline-variant bg-surface-container-lowest text-on-surface hover:border-primary/40'
            }`}
          >
            {group.name}
            <span className="text-[10px] font-normal uppercase tracking-wide opacity-60">
              {group.role}
            </span>
          </button>
        )
      })}
    </div>
  )
}
