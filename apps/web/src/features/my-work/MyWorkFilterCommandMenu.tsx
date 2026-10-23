import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

import type { ApiWorkItemTypeKind } from '../../api/types'
import type { ResearchGroupFilterOption } from './myWorkGroupFilter'
import type { ProjectFilterOption } from './myWorkProjectFilter'
import {
  WORK_ITEM_TYPE_FILTER_OPTIONS,
} from './myWorkTypeFilter'

export type MyWorkFilterCategory =
  | 'research-group'
  | 'project'
  | 'work-item-type'

export interface MyWorkFilterCommandMenuHandle {
  openCategory: (category: MyWorkFilterCategory) => void
}

export interface MyWorkFilterCommandMenuProps {
  researchGroupOptions: readonly ResearchGroupFilterOption[]
  selectedResearchGroupIds: readonly number[]
  onResearchGroupToggle: (id: number, selected: boolean) => void
  onClearResearchGroups: () => void
  projectOptions: readonly ProjectFilterOption[]
  selectedProjectIds: readonly number[]
  onProjectToggle: (id: number, selected: boolean) => void
  onClearProjects: () => void
  selectedWorkItemTypes: readonly ApiWorkItemTypeKind[]
  onWorkItemTypeToggle: (
    kind: ApiWorkItemTypeKind,
    selected: boolean,
  ) => void
  onClearWorkItemTypes: () => void
  onClearAll: () => void
}

type CommandView = 'root' | MyWorkFilterCategory

interface CategoryDefinition {
  id: MyWorkFilterCategory
  label: string
  icon: string
  selectedCount: number
}

interface ValueOption<TValue extends number | ApiWorkItemTypeKind> {
  value: TValue
  label: string
  icon?: string
  iconClassName?: string
}

const SEARCH_THRESHOLD = 8

const TYPE_PRESENTATION: Record<
  ApiWorkItemTypeKind,
  { icon: string; className: string }
> = {
  task: { icon: 'assignment', className: 'text-work-type-task' },
  epic: { icon: 'account_tree', className: 'text-work-type-epic' },
  milestone: { icon: 'flag', className: 'text-work-type-milestone' },
  deliverable: {
    icon: 'deployed_code',
    className: 'text-work-type-deliverable',
  },
}

function nextIndex(current: number, length: number, direction: 1 | -1) {
  if (length === 0) {
    return -1
  }

  return (Math.max(current, 0) + direction + length) % length
}

export const MyWorkFilterCommandMenu = forwardRef<
  MyWorkFilterCommandMenuHandle,
  MyWorkFilterCommandMenuProps
>(function MyWorkFilterCommandMenu(
  {
    researchGroupOptions,
    selectedResearchGroupIds,
    onResearchGroupToggle,
    onClearResearchGroups,
    projectOptions,
    selectedProjectIds,
    onProjectToggle,
    onClearProjects,
    selectedWorkItemTypes,
    onWorkItemTypeToggle,
    onClearWorkItemTypes,
    onClearAll,
  },
  forwardedRef,
) {
  const [open, setOpen] = useState(false)
  // Viewport anchor for the portaled dialog: 6px below the trigger's
  // bottom edge, with a right inset that keeps the dialog's right edge
  // aligned with the trigger's right edge. Recomputed on open and on
  // scroll/resize so the dialog keeps following the trigger.
  const [anchor, setAnchor] = useState<{
    top: number
    right: number
  } | null>(null)
  const [view, setView] = useState<CommandView>('root')
  const [search, setSearch] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const portalRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const rootRowRefs = useRef<Array<HTMLButtonElement | null>>([])
  const optionRefs = useRef<Array<HTMLDivElement | null>>([])
  const searchRef = useRef<HTMLInputElement | null>(null)
  const optionFocusActiveRef = useRef(false)

  const categories = useMemo<readonly CategoryDefinition[]>(
    () => [
      {
        id: 'research-group',
        label: 'Research group',
        icon: 'groups',
        selectedCount: selectedResearchGroupIds.length,
      },
      {
        id: 'project',
        label: 'Project',
        icon: 'folder',
        selectedCount: selectedProjectIds.length,
      },
      {
        id: 'work-item-type',
        label: 'Work item type',
        icon: 'category',
        selectedCount: selectedWorkItemTypes.length,
      },
    ],
    [
      selectedProjectIds.length,
      selectedResearchGroupIds.length,
      selectedWorkItemTypes.length,
    ],
  )

  const activeCategoryCount = categories.filter(
    (category) => category.selectedCount > 0,
  ).length

  const showSearch =
    view === 'project' ||
    (view === 'research-group' &&
      researchGroupOptions.length > SEARCH_THRESHOLD)

  const currentOptions = useMemo<
    readonly ValueOption<number | ApiWorkItemTypeKind>[]
  >(() => {
    const query = search.trim().toLocaleLowerCase()

    if (view === 'research-group') {
      return researchGroupOptions
        .filter(
          (option) =>
            query === '' ||
            option.name.toLocaleLowerCase().includes(query),
        )
        .map((option) => ({ value: option.id, label: option.name }))
    }

    if (view === 'project') {
      return projectOptions
        .filter(
          (option) =>
            query === '' ||
            option.name.toLocaleLowerCase().includes(query),
        )
        .map((option) => ({ value: option.id, label: option.name }))
    }

    if (view === 'work-item-type') {
      return WORK_ITEM_TYPE_FILTER_OPTIONS.map((option) => ({
        value: option.kind,
        label: option.label,
        icon: TYPE_PRESENTATION[option.kind].icon,
        iconClassName: TYPE_PRESENTATION[option.kind].className,
      }))
    }

    return []
  }, [projectOptions, researchGroupOptions, search, view])

  const resetClosedState = useCallback(() => {
    setView('root')
    setSearch('')
    setActiveIndex(0)
    optionFocusActiveRef.current = false
  }, [])

  const close = useCallback(
    (restoreTriggerFocus: boolean) => {
      setOpen(false)
      resetClosedState()
      if (restoreTriggerFocus) {
        triggerRef.current?.focus()
      }
    },
    [resetClosedState],
  )

  const updateAnchor = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) {
      return
    }
    const rect = trigger.getBoundingClientRect()
    setAnchor({
      top: rect.bottom + 6,
      right: window.innerWidth - rect.right,
    })
  }, [])

  const openRoot = useCallback(() => {
    updateAnchor()
    setView('root')
    setSearch('')
    setActiveIndex(0)
    setOpen(true)
  }, [updateAnchor])

  const openCategory = useCallback((category: MyWorkFilterCategory) => {
    updateAnchor()
    setView(category)
    setSearch('')
    setActiveIndex(0)
    setOpen(true)
  }, [updateAnchor])

  useImperativeHandle(
    forwardedRef,
    () => ({ openCategory }),
    [openCategory],
  )

  useEffect(() => {
    if (!open) {
      return
    }

    const handleMouseDown = (event: MouseEvent) => {
      if (
        event.target instanceof Node &&
        !containerRef.current?.contains(event.target)
        // The portaled dialog lives outside containerRef (on
        // document.body) but is still "inside" the menu: a click
        // there must never close it.
        && !portalRef.current?.contains(event.target)
      ) {
        close(false)
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close(true)
      }
    }

    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [close, open])

  // The portaled dialog is viewport-fixed: keep it pinned to the
  // trigger while the page or an inner scroller moves (the same
  // follow-the-trigger behavior the in-flow absolute dialog had for
  // free).
  useEffect(() => {
    if (!open) {
      return
    }

    const reposition = () => updateAnchor()
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)

    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open, updateAnchor])

  useEffect(() => {
    if (!open) {
      return
    }

    if (view === 'root') {
      rootRowRefs.current[0]?.focus()
    } else if (showSearch) {
      searchRef.current?.focus()
    } else {
      optionRefs.current[0]?.focus()
      optionFocusActiveRef.current = currentOptions.length > 0
    }
  }, [currentOptions.length, open, showSearch, view])

  useEffect(() => {
    if (currentOptions.length === 0) {
      setActiveIndex(-1)
      return
    }

    const next = Math.min(Math.max(activeIndex, 0), currentOptions.length - 1)
    if (activeIndex !== next) {
      setActiveIndex(next)
    }

    const activeOptionNodes = optionRefs.current.slice(
      0,
      currentOptions.length,
    )
    if (
      optionFocusActiveRef.current &&
      !activeOptionNodes.includes(
        document.activeElement as HTMLDivElement,
      )
    ) {
      optionRefs.current[next]?.focus()
    }
  }, [activeIndex, currentOptions])

  const backToRoot = useCallback(() => {
    setView('root')
    setSearch('')
    setActiveIndex(0)
  }, [])

  const moveRootFocus = (direction: 1 | -1) => {
    const next = nextIndex(activeIndex, categories.length, direction)
    setActiveIndex(next)
    rootRowRefs.current[next]?.focus()
  }

  const moveOptionFocus = (direction: 1 | -1) => {
    const next = nextIndex(activeIndex, currentOptions.length, direction)
    if (next < 0) {
      return
    }
    setActiveIndex(next)
    optionFocusActiveRef.current = true
    optionRefs.current[next]?.focus()
  }

  const isSelected = (value: number | ApiWorkItemTypeKind) => {
    if (view === 'research-group') {
      return selectedResearchGroupIds.includes(value as number)
    }
    if (view === 'project') {
      return selectedProjectIds.includes(value as number)
    }
    return selectedWorkItemTypes.includes(value as ApiWorkItemTypeKind)
  }

  const toggleValue = (value: number | ApiWorkItemTypeKind) => {
    const nextSelected = !isSelected(value)
    if (view === 'research-group') {
      onResearchGroupToggle(value as number, nextSelected)
    } else if (view === 'project') {
      onProjectToggle(value as number, nextSelected)
    } else if (view === 'work-item-type') {
      onWorkItemTypeToggle(value as ApiWorkItemTypeKind, nextSelected)
    }
  }

  const currentCategory = categories.find((category) => category.id === view)
  const emptyMessage =
    search.trim() !== ''
      ? `No matching ${view === 'research-group' ? 'research groups' : 'projects'}.`
      : view === 'research-group'
        ? 'No research groups.'
        : view === 'project'
          ? 'No projects.'
          : 'No work item types.'

  const clearCurrent = () => {
    if (view === 'research-group') {
      onClearResearchGroups()
    } else if (view === 'project') {
      onClearProjects()
    } else if (view === 'work-item-type') {
      onClearWorkItemTypes()
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Filter, ${activeCategoryCount} active ${activeCategoryCount === 1 ? 'category' : 'categories'}`}
        onClick={() => {
          if (open) {
            close(false)
          } else {
            openRoot()
          }
        }}
        onKeyDown={(event) => {
          if ((event.key === 'Enter' || event.key === ' ') && !open) {
            event.preventDefault()
            openRoot()
          }
        }}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-subtle bg-transparent px-2.5 text-[12px] font-medium leading-[18px] text-text-muted transition hover:border-border-default hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
      >
        <span
          aria-hidden="true"
          className="material-symbols-outlined icon-stable text-[14px]"
        >
          filter_list
        </span>
        <span>Filter</span>
        {activeCategoryCount > 0 && (
          <span
            aria-hidden="true"
            className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-surface-muted px-1 text-[10px] font-semibold leading-[14px] text-text"
          >
            {activeCategoryCount}
          </span>
        )}
      </button>

      {/* LAYER CONTRACT: the command menu is an application overlay
          surface, not route content, so it portals to document.body
          (the application overlay root; the same pattern the Work Item
          inspector and the modal dialogs use) instead of rendering in
          the mounting route. `.fg-route-content` (the AppShell <main>,
          the ONE named View Transition surface) carries
          `view-transition-name`, which per CSS View Transitions S2.1.1
          makes it form a stacking context at ALL times; rendered inside
          that <main>, the z-50 menu would only compete WITHIN the
          route-content context (effective z=0 at the root level), so at
          narrow widths the fixed Sidebar (z-30, a sibling of <main> in
          the root stacking context) paints over the menu's left part
          and its subtree intercepts pointer input aimed at the menu.
          From document.body the z-50 competes in the ROOT stacking
          context. The fix is layer ownership, not a z-index escalation:
          geometry (6px below the trigger, right edge aligned with the
          trigger's right edge), focus, and interactions are unchanged. */}
      {open && anchor !== null &&
        createPortal(
          <div
            ref={portalRef}
            role="dialog"
            aria-label="Filter by"
            onKeyDown={(event) => {
              if (event.altKey && event.key === 'ArrowLeft' && view !== 'root') {
                event.preventDefault()
                backToRoot()
              }
            }}
            style={{
              top: anchor.top,
              right: anchor.right,
            }}
            className="fixed z-50 flex max-h-[360px] w-[300px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-md border border-border-subtle bg-surface shadow-[0_12px_32px_rgba(0,0,0,0.32)]"
          >
          {view === 'root' ? (
            <>
              <div className="flex items-center justify-between px-3 pb-1.5 pt-3">
                <h2 className="text-[12px] font-semibold leading-[18px] text-text">
                  Filter by
                </h2>
                {activeCategoryCount > 0 && (
                  <button
                    type="button"
                    onClick={onClearAll}
                    className="rounded text-[11px] font-medium leading-4 text-text-muted transition hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    Clear all
                  </button>
                )}
              </div>
              <div className="px-1.5 pb-2">
                {categories.map((category, index) => (
                  <button
                    key={category.id}
                    ref={(node) => {
                      rootRowRefs.current[index] = node
                    }}
                    type="button"
                    tabIndex={index === activeIndex ? 0 : -1}
                    onFocus={() => setActiveIndex(index)}
                    onClick={() => openCategory(category.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        event.preventDefault()
                        moveRootFocus(event.key === 'ArrowDown' ? 1 : -1)
                      } else if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        openCategory(category.id)
                      }
                    }}
                    className="flex h-9 w-full items-center gap-2 rounded px-2.5 text-left text-[12px] leading-[18px] text-text transition hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
                  >
                    <span
                      aria-hidden="true"
                      className="material-symbols-outlined icon-stable text-[14px] text-text-muted"
                    >
                      {category.icon}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{category.label}</span>
                    {category.selectedCount > 0 && (
                      <span className="text-[11px] text-text-muted">
                        {category.selectedCount}
                      </span>
                    )}
                    <span
                      aria-hidden="true"
                      className="material-symbols-outlined icon-stable text-[14px] text-text-tertiary"
                    >
                      chevron_right
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-1 px-2 pb-1.5 pt-2">
                <button
                  type="button"
                  aria-label="Back to filter categories"
                  onClick={backToRoot}
                  className="inline-flex h-7 w-7 items-center justify-center rounded text-text-muted transition hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <span
                    aria-hidden="true"
                    className="material-symbols-outlined icon-stable text-[14px]"
                  >
                    arrow_back
                  </span>
                </button>
                <h2 className="min-w-0 flex-1 truncate text-[12px] font-semibold leading-[18px] text-text">
                  {currentCategory?.label}
                </h2>
                {(currentCategory?.selectedCount ?? 0) > 0 && (
                  <button
                    type="button"
                    onClick={clearCurrent}
                    className="rounded px-1 text-[11px] font-medium leading-4 text-text-muted transition hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    Clear
                  </button>
                )}
              </div>

              {showSearch && (
                <div className="px-3 pb-2">
                  <div className="relative">
                    <span
                      aria-hidden="true"
                      className="material-symbols-outlined icon-stable pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[14px] text-text-tertiary"
                    >
                      search
                    </span>
                    <input
                      ref={searchRef}
                      type="search"
                      value={search}
                      aria-label={`Search ${view === 'research-group' ? 'research groups' : 'projects'}`}
                      placeholder={`Search ${view === 'research-group' ? 'research groups' : 'projects'}`}
                      onChange={(event) => {
                        setSearch(event.target.value)
                        setActiveIndex(0)
                        optionFocusActiveRef.current = false
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                          event.preventDefault()
                          const next = event.key === 'ArrowDown' ? 0 : currentOptions.length - 1
                          if (next >= 0) {
                            setActiveIndex(next)
                            optionFocusActiveRef.current = true
                            optionRefs.current[next]?.focus()
                          }
                        }
                      }}
                      className="h-8 w-full rounded border border-border-subtle bg-surface-quiet pl-8 pr-2.5 text-[12px] leading-4 text-text placeholder:text-text-tertiary focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus/20"
                    />
                  </div>
                </div>
              )}

              <div
                role="listbox"
                aria-label={`${currentCategory?.label} options`}
                aria-multiselectable="true"
                className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2"
              >
                {currentOptions.length === 0 ? (
                  <p className="px-2.5 py-3 text-[12px] leading-4 text-text-tertiary">
                    {emptyMessage}
                  </p>
                ) : (
                  currentOptions.map((option, index) => {
                    const selected = isSelected(option.value)
                    return (
                      <div
                        key={option.value}
                        ref={(node) => {
                          optionRefs.current[index] = node
                        }}
                        role="option"
                        aria-selected={selected}
                        tabIndex={index === activeIndex ? 0 : -1}
                        onFocus={() => {
                          setActiveIndex(index)
                          optionFocusActiveRef.current = true
                        }}
                        onBlur={(event) => {
                          if (
                            event.relatedTarget != null &&
                            !event.currentTarget.parentElement?.contains(
                              event.relatedTarget,
                            )
                          ) {
                            optionFocusActiveRef.current = false
                          }
                        }}
                        onClick={() => toggleValue(option.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                            event.preventDefault()
                            moveOptionFocus(event.key === 'ArrowDown' ? 1 : -1)
                          } else if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            toggleValue(option.value)
                          }
                        }}
                        className={[
                          'flex h-[34px] cursor-pointer items-center gap-2 rounded px-2.5 text-[12px] leading-[18px] text-text transition hover:bg-surface-hover',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus',
                          selected ? 'bg-surface-muted' : '',
                        ].join(' ')}
                      >
                        {option.icon && (
                          <span
                            aria-hidden="true"
                            className={`material-symbols-outlined icon-stable text-[14px] ${option.iconClassName ?? 'text-text-muted'}`}
                          >
                            {option.icon}
                          </span>
                        )}
                        <span className="min-w-0 flex-1 truncate">{option.label}</span>
                        {selected && (
                          <span
                            aria-hidden="true"
                            className="material-symbols-outlined icon-stable text-[14px] text-accent-text"
                          >
                            check
                          </span>
                        )}
                      </div>
                    )
                  })
                )}
              </div>
            </>
          )}
          </div>,
          document.body,
        )}
    </div>
  )
})
