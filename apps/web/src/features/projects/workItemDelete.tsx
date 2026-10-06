import {
  useEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

// Shared Work Item deletion UI, used by the Board card, the List row, and
// the Work Item drawer. Keeping the three-dot "Work item actions" trigger
// and the destructive confirmation dialog in one place guarantees the same
// copy, styling, and double-submit/escape behavior everywhere. The actual
// delete API call + collection refresh lives in ProjectDetailPage (a single
// `onDeleteWorkItem`); these components only trigger and confirm it.

export type WorkItemActionMenuSize = 'sm' | 'lg'

export function WorkItemActionMenuItem({
  label,
  icon,
  danger,
  onClick,
}: {
  label: string
  icon: string
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={[
        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm outline-none',
        danger
          ? 'text-work-item-error hover:bg-work-item-error-bg focus-visible:bg-work-item-error-bg'
          : 'text-work-content-text hover:bg-work-surface-row-hover focus-visible:bg-work-surface-row-hover',
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className="material-symbols-outlined text-[17px] text-text-work-faded-70"
      >
        {icon}
      </span>

      <span className="truncate">{label}</span>
    </button>
  )
}

export function WorkItemActionMenuTrigger({
  label,
  size,
  onAction,
  onTriggerPointerDown,
}: {
  label: string
  size?: WorkItemActionMenuSize
  onAction: (action: 'delete') => void
  onTriggerPointerDown?: (event: {
    stopPropagation: () => void
  }) => void
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({
    top: 0,
    left: 0,
  })
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    const onOutside = (event: MouseEvent) => {
      if (
        ref.current &&
        !ref.current.contains(event.target as Node)
      ) {
        setOpen(false)
      }
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    const onScroll = () => setOpen(false)

    document.addEventListener('mousedown', onOutside, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)

    return () => {
      document.removeEventListener('mousedown', onOutside, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  const toggle = () => {
    if (!open && ref.current) {
      const rect =
        ref.current.getBoundingClientRect()

      setPosition({
        top: rect.bottom + 6,
        left: Math.max(8, rect.right - 208),
      })
    }

    setOpen((current) => !current)
  }

  const close = () => setOpen(false)

  const isLarge = size === 'lg'

  return (
    <div
      ref={ref}
      className="relative"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={
        onTriggerPointerDown
          ? (event) =>
              onTriggerPointerDown(event)
          : undefined
      }
      draggable={false}
    >
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        className={[
          'flex items-center justify-center rounded-lg text-text-work-faded-70 outline-none transition hover:bg-work-surface-support focus-visible:bg-work-surface-support focus-visible:ring-2 focus-visible:ring-focus-ring-primary/30',
          isLarge
            ? 'h-9 w-9'
            : 'h-7 w-7',
          open ? 'bg-work-surface-support' : '',
        ].join(' ')}
      >
        <span
          aria-hidden="true"
          className="material-symbols-outlined"
          style={{
            fontSize: isLarge ? 20 : 17,
          }}
        >
          more_horiz
        </span>
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'fixed',
            top: position.top,
            left: position.left,
          }}
          className="z-50 w-52 rounded-xl border border-border-structural bg-surface p-1 shadow-lg shadow-on-surface/10"
        >
          <WorkItemActionMenuItem
            label="Delete work item"
            icon="delete"
            danger
            onClick={() => {
              close()
              onAction('delete')
            }}
          />
        </div>
      )}
    </div>
  )
}

export function WorkItemDeleteDialog({
  open,
  deleting,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean
  deleting: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  if (!open) {
    return null
  }

  // LAYER CONTRACT: this confirmation overlay is an application
  // overlay surface, so it portals to document.body (the application
  // overlay root; the same pattern the Work Item inspector, the
  // create modal, and the Meeting import dialog use) instead of
  // rendering wherever its trigger lives.
  //
  // Why: rendered in place, the overlay is trapped in the stacking
  // context of its host. The page-level dialog (Project / My Work
  // pages) renders inside `.fg-route-content` (the AppShell <main>,
  // the ONE named View Transition surface), whose
  // `view-transition-name` makes it form a stacking context at ALL
  // times (CSS View Transitions S2.1.1) - there, its `z-50`
  // competes only WITHIN that context (effective z=0 at the root
  // level), so the portaled z-40 Work Item inspector paints over it
  // wherever they overlap and its rail intercepts the dialog's
  // pointer input. The drawer's standalone fallback renders inside
  // the inspector's own z-40 boundary element, where the overlay is
  // owned by the inspector layer. From document.body the z-50
  // competes in the ROOT stacking context (above the inspector's
  // z-40, the Sidebar's z-30, and the TopBar's z-20). The fix is
  // layer ownership, not a z-index escalation: geometry, scrim, and
  // interactions are unchanged.
  return createPortal(
    <div
      // The overlay lives on the root overlay layer, OUTSIDE the
      // Work Item inspector boundary, so without this marker a click
      // inside the dialog (e.g. Cancel) would be treated as an
      // "outside click" and close the open inspector. Keep the
      // inspector open while confirming deletion.
      data-work-item-inspector-keep-open="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay-scrim px-4 py-8 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !deleting) {
          onCancel()
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="work-item-delete-title"
        className="w-full max-w-md overflow-hidden rounded-2xl border border-border-structural bg-surface shadow-xl"
      >
        <div className="px-6 py-5">
          <h2
            id="work-item-delete-title"
            className="text-lg font-semibold tracking-tight text-work-content-text"
          >
            Delete work item?
          </h2>

          <p className="mt-2 text-sm text-text-work-faded-70">
            This permanently deletes this work item and its activity.
            Related projects, meetings, and other work items will not be
            deleted.
          </p>

          {error && (
            <p
              role="alert"
              className="mt-3 rounded-lg bg-work-item-error-bg px-3 py-2 text-sm text-work-item-error"
            >
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border-structural px-6 py-4">
          <button
            type="button"
            disabled={deleting}
            onClick={onCancel}
            className="inline-flex h-9 items-center rounded-lg px-3.5 text-sm font-medium text-text-work-faded-70 outline-none transition hover:bg-work-surface-support focus-visible:ring-2 focus-visible:ring-focus-ring-primary/40 disabled:opacity-60"
          >
            Cancel
          </button>

          <button
            type="button"
            disabled={deleting}
            onClick={onConfirm}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-danger px-3.5 text-sm font-semibold text-white outline-none transition hover:bg-danger/80 focus-visible:ring-2 focus-visible:ring-danger focus-visible:ring-offset-2 disabled:opacity-60"
          >
            {deleting && (
              <span
                aria-hidden="true"
                className="material-symbols-outlined animate-spin text-[18px]"
              >
                refresh
              </span>
            )}
            {deleting ? 'Deleting…' : 'Delete work item'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
