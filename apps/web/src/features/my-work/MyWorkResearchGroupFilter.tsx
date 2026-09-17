/**
 * The My Work "Research groups" toolbar filter: a neutral toolbar
 * toggle that opens a multi-select popover of the user's accessible
 * Research Groups.
 *
 * This component is a controlled PRESENTATION component: it renders
 * whatever `selectedIds` (the persisted `preferences.researchGroupIds`)
 * say and reports user intent through `onToggle` / `onClear`. It owns
 * only transient UI concerns — the open/closed popover state is
 * supplied by the parent (so the applied-row "+N" summary can open
 * and focus this control) and the search query, which is local and
 * never persisted.
 *
 * The toggle + popover reuse the repository's established popover
 * contract (see the Home Activity domain filter): a relative container,
 * an `aria-haspopup` / `aria-expanded` trigger, outside-click and
 * Escape to close (Escape returns focus to the trigger), and native
 * checkboxes for keyboard-operable, accessible selection.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

export interface ResearchGroupFilterOption {
  id: number
  name: string
}

interface MyWorkResearchGroupFilterProps {
  /**
   * The user's accessible Research Groups (the canonical option set —
   * never derived from Work Items). A group may be selectable even if
   * it currently holds zero assigned My Work items.
   */
  options: readonly ResearchGroupFilterOption[]
  /** The persisted selection (`preferences.researchGroupIds`). */
  selectedIds: readonly number[]
  /** Controlled popover open state. */
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Toggle one Research Group's membership in the selection. */
  onToggle: (groupId: number, checked: boolean) => void
  /** Clear the whole Research Group selection (only `researchGroupIds`). */
  onClear: () => void
}

// The search field appears only above this number of available groups
// (the approved "more than 8" threshold).
const SEARCH_THRESHOLD = 8

export const MyWorkResearchGroupFilter =
  forwardRef<
    HTMLButtonElement,
    MyWorkResearchGroupFilterProps
  >(function MyWorkResearchGroupFilter(
    {
      options,
      selectedIds,
      open,
      onOpenChange,
      onToggle,
      onClear,
    },
    triggerRef,
  ) {
    const containerRef = useRef<
      HTMLDivElement | null
    >(null)
    const internalTriggerRef = useRef<
      HTMLButtonElement | null
    >(null)
    const [search, setSearch] = useState('')

    // Bridge the forwarded ref (the parent uses it to focus the
    // toggle) with the internal ref (Escape focus-return).
    const setTriggerRef = useCallback(
      (node: HTMLButtonElement | null) => {
        internalTriggerRef.current = node

        if (typeof triggerRef === 'function') {
          triggerRef(node)
        } else if (triggerRef != null) {
          triggerRef.current = node
        }
      },
      [triggerRef],
    )

    const selectedCount = selectedIds.length
    const hasSelection = selectedCount > 0
    // The search box is rendered only for a large option set.
    const showSearch = options.length > SEARCH_THRESHOLD

    // Outside click + Escape close the popover. Escape returns focus
    // to the toggle (the established repository popover behavior).
    useEffect(() => {
      if (!open) {
        return
      }

      const handlePointerDown = (
        event: MouseEvent,
      ) => {
        if (
          event.target instanceof Node &&
          !containerRef.current?.contains(
            event.target,
          )
        ) {
          onOpenChange(false)
        }
      }

      const handleKeyDown = (
        event: KeyboardEvent,
      ) => {
        if (event.key === 'Escape') {
          onOpenChange(false)
          internalTriggerRef.current?.focus()
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
    }, [open, onOpenChange])

    // The search query is transient UI state: it resets whenever the
    // popover closes and is never part of the persisted preference.
    useEffect(() => {
      if (!open) {
        setSearch('')
      }
    }, [open])

    const visibleOptions = useMemo(() => {
      const query = search.trim().toLowerCase()

      if (query === '') {
        return options
      }

      return options.filter((option) =>
        option.name.toLowerCase().includes(query),
      )
    }, [options, search])

    // `min-w-0`: in the narrow content column this flex child must
    // be allowed to shrink below the toggle's 148px target width —
    // the toggle truncates its label instead of forcing document
    // horizontal overflow.
    return (
      <div
        ref={containerRef}
        className="relative min-w-0"
      >
        <button
          ref={setTriggerRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={
            hasSelection
              ? `Research groups, ${selectedCount} selected`
              : 'Research groups, none selected'
          }
          onClick={() =>
            onOpenChange(!open)
          }
          className={[
            // `w-[148px]` is a target width, not a floor: the toggle
            // shrinks (label truncates) when the narrow column is
            // smaller, so it never forces document overflow.
            'flex h-8 w-[148px] min-w-0 max-w-full items-center gap-[7px] rounded border px-2.5 text-[12px] font-medium leading-[18px] transition',
            'focus-visible:outline-2 focus-visible:outline focus-visible:outline-focus focus-visible:outline-offset-1',
            hasSelection
              ? 'border-border-default bg-surface text-text'
              : 'border-border-subtle bg-transparent text-text-muted hover:border-border-default hover:bg-surface hover:text-text',
          ].join(' ')}
        >
          <span className="min-w-0 flex-1 truncate text-left">
            Research groups
          </span>

          {hasSelection && (
            <span
              aria-hidden="true"
              className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-surface-muted px-[5px] text-[10px] font-semibold leading-[14px] text-text"
            >
              {selectedCount}
            </span>
          )}

          <span
            aria-hidden="true"
            className={`material-symbols-outlined icon-stable shrink-0 text-[14px] ${hasSelection ? 'text-text' : 'text-text-tertiary'}`}
          >
            expand_more
          </span>
        </button>

        {open && (
          // The width clamp accounts for the fixed 240px sidebar +
          // the 48px page gutters that bound the toggle's left
          // offset, so an open menu cannot push the document width
          // at narrow viewports (the final responsive filter panel
          // belongs to a later slice).
          <div
            role="dialog"
            aria-label="Research groups"
            className="absolute left-0 top-[calc(100%+6px)] z-50 flex max-h-[360px] w-[300px] max-w-[calc(100vw-288px)] flex-col overflow-hidden rounded-md border border-border-subtle bg-surface shadow-[0_12px_32px_rgba(0,0,0,0.32)]"
          >
            <div className="flex items-center justify-between px-3 pb-1.5 pt-3">
              <span className="text-[13px] font-semibold leading-5 text-text">
                Research groups
              </span>

              {hasSelection && (
                <button
                  type="button"
                  onClick={onClear}
                  className="rounded text-[11px] font-semibold leading-4 text-text-muted transition hover:text-text focus-visible:outline-2 focus-visible:outline focus-visible:outline-focus"
                >
                  Clear
                </button>
              )}
            </div>

            {showSearch && (
              <div className="px-3 pb-2">
                <input
                  type="search"
                  value={search}
                  onChange={(event) =>
                    setSearch(
                      event.target.value,
                    )
                  }
                  placeholder="Search research groups"
                  aria-label="Search research groups"
                  className="h-8 w-full rounded border border-border-subtle bg-surface-quiet px-2.5 text-xs leading-4 text-text placeholder:text-text-tertiary focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus/20"
                />
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
              {visibleOptions.length === 0 ? (
                <p className="px-2.5 py-3 text-xs leading-4 text-text-tertiary">
                  {showSearch
                    ? 'No matching research groups.'
                    : 'No research groups.'}
                </p>
              ) : (
                <fieldset>
                  <legend className="sr-only">
                    Research groups
                  </legend>

                  {visibleOptions.map(
                    (option) => (
                      <label
                        key={option.id}
                        className="flex h-[34px] cursor-pointer items-center gap-2 rounded px-2.5 text-xs leading-[18px] text-text transition hover:bg-surface-muted"
                      >
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(
                            option.id,
                          )}
                          onChange={(event) =>
                            onToggle(
                              option.id,
                              event.target.checked,
                            )
                          }
                          className="h-4 w-4 shrink-0 rounded border-border-field accent-control-accent"
                        />

                        <span className="min-w-0 truncate">
                          {option.name}
                        </span>
                      </label>
                    ),
                  )}
                </fieldset>
              )}
            </div>
          </div>
        )}
      </div>
    )
  })
