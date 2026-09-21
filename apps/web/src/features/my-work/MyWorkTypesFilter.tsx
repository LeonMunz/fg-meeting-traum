/**
 * The My Work "Work item types" toolbar filter: a neutral toolbar
 * toggle that opens a multi-select popover of the four canonical
 * semantic Work Item type kinds (Task / Epic / Milestone /
 * Deliverable — a closed set, in canonical order).
 *
 * It reuses the established Research Group / Project filter's visual
 * and interaction pattern exactly (the same toggle, popover,
 * checkbox, and Escape/outside-click contract). The option set is
 * fixed and canonical — it is never derived from the Work Item
 * payload and there is no search field (four options never reach the
 * approved "more than 8" threshold).
 *
 * This component is a controlled PRESENTATION component: it renders
 * whatever `selectedKinds` (the persisted
 * `preferences.workItemTypes`) say and reports user intent through
 * `onToggle` / `onClear`. It owns only transient UI concerns — the
 * open/closed popover state is supplied by the parent (so the
 * applied-row "+N" summary can open and focus this control).
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
} from 'react'

import type {
  ApiWorkItemTypeKind,
} from '../../api/types'

import type {
  WorkItemTypeFilterOption,
} from './myWorkTypeFilter'

interface MyWorkTypesFilterProps {
  /**
   * The canonical Work Item Type options (the closed set of
   * semantic kinds — supplied by the parent from the canonical
   * module constant).
   */
  options: readonly WorkItemTypeFilterOption[]
  /** The persisted selection (`preferences.workItemTypes`). */
  selectedKinds: readonly ApiWorkItemTypeKind[]
  /** Controlled popover open state. */
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Toggle one kind's membership in the selection. */
  onToggle: (
    kind: ApiWorkItemTypeKind,
    checked: boolean,
  ) => void
  /** Clear the whole Work Item Type selection (only `workItemTypes`). */
  onClear: () => void
}

export const MyWorkTypesFilter = forwardRef<
  HTMLButtonElement,
  MyWorkTypesFilterProps
>(function MyWorkTypesFilter(
  {
    options,
    selectedKinds,
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

  const selectedCount = selectedKinds.length
  const hasSelection = selectedCount > 0

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
            ? `Work item types, ${selectedCount} selected`
            : 'Work item types, none selected'
        }
        onClick={() =>
          onOpenChange(!open)
        }
        className={[
          // `w-[148px]` is a target width, not a floor: the
          // toggle shrinks (label truncates) when the narrow
          // column is smaller, so it never forces document
          // overflow.
          'flex h-8 w-[148px] min-w-0 max-w-full items-center gap-[7px] rounded border px-2.5 text-[12px] font-medium leading-[18px] transition',
          'focus-visible:outline-2 focus-visible:outline focus-visible:outline-focus focus-visible:outline-offset-1',
          hasSelection
            ? 'border-border-default bg-surface text-text'
            : 'border-border-subtle bg-transparent text-text-muted hover:border-border-default hover:bg-surface hover:text-text',
        ].join(' ')}
      >
        <span className="min-w-0 flex-1 truncate text-left">
          Work item types
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
          aria-label="Work item types"
          className="absolute left-0 top-[calc(100%+6px)] z-50 flex max-h-[360px] w-[300px] max-w-[calc(100vw-288px)] flex-col overflow-hidden rounded-md border border-border-subtle bg-surface shadow-[0_12px_32px_rgba(0,0,0,0.32)]"
        >
          <div className="flex items-center justify-between px-3 pb-1.5 pt-3">
            <span className="text-[13px] font-semibold leading-5 text-text">
              Work item types
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

          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            {options.length === 0 ? (
              <p className="px-2.5 py-3 text-xs leading-4 text-text-tertiary">
                No work item types.
              </p>
            ) : (
              <fieldset>
                <legend className="sr-only">
                  Work item types
                </legend>

                {options.map((option) => (
                  <label
                    key={option.kind}
                    className="flex h-[34px] cursor-pointer items-center gap-2 rounded px-2.5 text-xs leading-[18px] text-text transition hover:bg-surface-muted"
                  >
                    <input
                      type="checkbox"
                      checked={selectedKinds.includes(
                        option.kind,
                      )}
                      onChange={(event) =>
                        onToggle(
                          option.kind,
                          event.target.checked,
                        )
                      }
                      className="h-4 w-4 shrink-0 rounded border-border-field accent-control-accent"
                    />

                    <span className="min-w-0 truncate">
                      {option.label}
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
          </div>
        </div>
      )}
    </div>
  )
})
