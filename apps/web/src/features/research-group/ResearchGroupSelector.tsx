import { useResearchGroup } from './useResearchGroup'

export function ResearchGroupSelector() {
  const {
    groups,
    activeResearchGroupId,
    loading,
    error,
    setActiveResearchGroupId,
  } = useResearchGroup()

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-on-surface-variant">
        <span className="material-symbols-outlined animate-spin text-[18px]">
          refresh
        </span>
        Loading…
      </div>
    )
  }

  if (error) {
    return (
      <div className="text-sm text-error">
        Research groups unavailable
      </div>
    )
  }

  if (groups.length === 0) {
    return (
      <div className="text-sm text-on-surface-variant">
        No research group
      </div>
    )
  }

  return (
    <div className="flex flex-wrap gap-2">
      {groups.map((group) => {
        const isSelected =
          group.id === activeResearchGroupId

        return (
          <button
            key={group.id}
            type="button"
            onClick={() =>
              setActiveResearchGroupId(group.id)
            }
            className={[
              'flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition',
              isSelected
                ? 'border-primary bg-primary-container text-on-primary-container'
                : 'border-outline-variant bg-surface-container-lowest text-on-surface hover:border-primary/40',
            ].join(' ')}
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
