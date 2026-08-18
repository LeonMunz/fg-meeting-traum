import {
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  useLocation,
  useNavigate,
} from 'react-router'

import type { ApiResearchGroup } from '../../api/types'
import { useResearchGroup } from './useResearchGroup'

function getInitials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
}

export function ResearchGroupSelector() {
  const navigate = useNavigate()
  const location = useLocation()

  const {
    groups,
    activeResearchGroupId,
    activeResearchGroup,
    loading,
    error,
    setActiveResearchGroupId,
  } = useResearchGroup()

  const [open, setOpen] = useState(false)
  const containerRef =
    useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    const handlePointerDown = (
      event: MouseEvent,
    ) => {
      const target = event.target

      if (
        target instanceof Node &&
        !containerRef.current?.contains(target)
      ) {
        setOpen(false)
      }
    }

    const handleKeyDown = (
      event: KeyboardEvent,
    ) => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    document.addEventListener(
      'mousedown',
      handlePointerDown,
    )
    document.addEventListener(
      'keydown',
      handleKeyDown,
    )

    return () => {
      document.removeEventListener(
        'mousedown',
        handlePointerDown,
      )
      document.removeEventListener(
        'keydown',
        handleKeyDown,
      )
    }
  }, [open])

  const switchResearchGroup = (
    group: ApiResearchGroup,
  ) => {
    setActiveResearchGroupId(group.id)
    setOpen(false)

    const groupListPaths = new Set([
      '/projects',
      '/goals',
      '/meetings',
      '/kvp',
      '/knowledge',
      '/calendar',
      '/people',
    ])

    if (
      groupListPaths.has(
        location.pathname,
      )
    ) {
      navigate(
        `${location.pathname}?group=${group.id}`,
      )
      return
    }

    /*
     * Entity detail pages belong to their entity's Research Group.
     * Switching the group therefore exits the old entity and opens
     * the equivalent list in the newly selected group.
     */
    if (
      location.pathname.startsWith(
        '/projects/',
      )
    ) {
      navigate(
        `/projects?group=${group.id}`,
      )
      return
    }

    if (
      location.pathname.startsWith(
        '/meetings/',
      )
    ) {
      navigate(
        `/meetings?group=${group.id}`,
      )
    }
  }

  if (loading) {
    return (
      <div className="flex h-11 items-center gap-2 px-2 text-sm text-on-surface-variant">
        <span className="material-symbols-outlined animate-spin text-[18px]">
          refresh
        </span>
        Loading…
      </div>
    )
  }

  if (error) {
    return (
      <div className="px-2 py-2 text-xs leading-5 text-error">
        Research groups unavailable
      </div>
    )
  }

  if (
    groups.length === 0 ||
    !activeResearchGroup
  ) {
    return null
  }

  return (
    <div
      ref={containerRef}
      className="relative"
    >
      <button
        type="button"
        onClick={() =>
          setOpen((current) => !current)
        }
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition hover:bg-surface-container-high"
      >
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-container-high text-[10px] font-semibold text-on-surface">
          {getInitials(
            activeResearchGroup.name,
          )}
        </div>

        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-on-surface">
          {activeResearchGroup.name}
        </span>

        <span className="material-symbols-outlined text-[18px] text-on-surface-variant">
          {open
            ? 'keyboard_arrow_up'
            : 'keyboard_arrow_down'}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-[calc(100%+6px)] z-50 w-[280px] overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest p-1.5 shadow-lg"
        >
          {groups.map((group) => {
            const selected =
              group.id ===
              activeResearchGroupId

            return (
              <button
                key={group.id}
                type="button"
                role="menuitem"
                onClick={() =>
                  switchResearchGroup(group)
                }
                className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition hover:bg-surface-container-low"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-container-high text-[10px] font-semibold text-on-surface">
                  {getInitials(group.name)}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-on-surface">
                    {group.name}
                  </div>

                  <div className="mt-0.5 text-xs capitalize text-on-surface-variant">
                    {group.role}
                  </div>
                </div>

                {selected && (
                  <span className="material-symbols-outlined text-[18px] text-primary">
                    check
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
