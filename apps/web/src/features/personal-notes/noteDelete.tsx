import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

/**
 * Shared Personal Note row deletion affordances (canonical
 * reference: ``docs/domain/personal-notes.md`` — permanent delete).
 *
 * Keeping the three-dot "More actions" trigger, the single
 * destructive "Delete note" menu entry, and the explicit
 * confirmation dialog in one place guarantees the same copy,
 * styling, keyboard behavior, and double-submit protection
 * everywhere. The actual delete request + the page-local
 * reconciliation (list, selection, drafts, save bookkeeping)
 * lives in NotesPage; these components only trigger and confirm
 * it.
 *
 * Trigger/menu behavior follows the existing row-action menu
 * convention (three-dot `more_horiz` ghost trigger, fixed menu
 * anchored to the trigger, close on Escape / outside mousedown /
 * scroll). The dialog follows the existing destructive
 * confirmation convention (safe action focused first, Tab trap,
 * Escape cancels, destructive "Deleting…" pending state, compact
 * inline error).
 */

// The one-item popover sizes itself to its content (min-width
// 104px) and anchors its RIGHT edge to the trigger's right edge
// with a small offset — a tiny desktop context menu, not a
// fixed-width panel.

export function NoteActionsMenu({
  displayTitle,
  onTriggerRef,
  onRequestDelete,
}: {
  displayTitle: string
  onTriggerRef: (element: HTMLButtonElement | null) => void
  onRequestDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, right: 0 })
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    const onOutside = (event: MouseEvent) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(event.target as Node)
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
    if (!open && wrapperRef.current) {
      const rect =
        wrapperRef.current.getBoundingClientRect()

      setPosition({
        top: rect.bottom + 3,
        right: Math.max(8, window.innerWidth - rect.right),
      })
    }

    setOpen((current) => !current)
  }

  return (
    <div
      ref={wrapperRef}
      className="relative shrink-0"
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        ref={onTriggerRef}
        aria-label={`More actions for ${displayTitle}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        className={[
          'flex h-6 w-6 items-center justify-center rounded-md outline-none transition-colors',
          'group-hover:text-text-muted/75 focus-visible:ring-2 focus-visible:ring-focus focus-visible:text-text-muted',
          open
            ? 'text-text-muted/75'
            : 'text-text-muted/45',
        ].join(' ')}
      >
        <span
          aria-hidden="true"
          className="material-symbols-outlined text-[14px]"
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
            right: position.right,
          }}
          className="z-50 w-max min-w-[104px] rounded-md border border-border-subtle bg-surface p-[3px] shadow-sm"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onRequestDelete()
            }}
            className="flex h-7 w-full items-center whitespace-nowrap rounded px-2 text-left text-[13px] font-medium text-danger/70 outline-none transition-colors hover:bg-danger-bg hover:text-danger focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset focus-visible:text-danger"
          >
            Delete note
          </button>
        </div>
      )}
    </div>
  )
}

// Minimal focus trap for the two dialog buttons + the dialog
// container itself: Tab / Shift+Tab cycle within the dialog.
const FOCUSABLE_SELECTOR = 'button:not([disabled])'

export function NoteDeleteDialog({
  title,
  deleting,
  error,
  onCancel,
  onConfirm,
}: {
  title: string
  deleting: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  // Initial focus on the safe (non-destructive) action.
  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  // Escape cancels — never while the delete is in flight (the
  // request must not be abandoned mid-write).
  useEffect(() => {
    if (deleting) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () =>
      window.removeEventListener('keydown', handleKeyDown)
  }, [deleting, onCancel])

  const handleTabTrap = (event: ReactKeyboardEvent) => {
    if (event.key !== 'Tab' || dialogRef.current == null) {
      return
    }

    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        FOCUSABLE_SELECTOR,
      ),
    )
    if (focusable.length === 0) {
      return
    }

    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    const active =
      document.activeElement as HTMLElement | null

    if (event.shiftKey) {
      if (active === first || !dialogRef.current.contains(active)) {
        event.preventDefault()
        last.focus()
      }
    } else if (active === last || !dialogRef.current.contains(active)) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 px-4 py-8 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (
          event.target === event.currentTarget &&
          !deleting
        ) {
          onCancel()
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="note-delete-title"
        aria-describedby="note-delete-description"
        onKeyDown={handleTabTrap}
        className="w-full max-w-md overflow-hidden rounded-2xl border border-border-subtle bg-surface shadow-xl"
      >
        <div className="px-6 py-5">
          <h2
            id="note-delete-title"
            className="text-lg font-semibold tracking-tight text-text"
          >
            Delete note?
          </h2>

          <p
            id="note-delete-description"
            className="mt-2 text-sm text-text-muted"
          >
            <span className="block break-words">
              Permanently delete "{title}"?
            </span>

            <span className="mt-1 block font-medium text-danger">
              This can't be undone.
            </span>
          </p>

          {error && (
            <p
              role="alert"
              className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger"
            >
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border-subtle px-6 py-4">
          <button
            ref={cancelRef}
            type="button"
            disabled={deleting}
            onClick={onCancel}
            className="inline-flex h-9 items-center rounded-lg px-3.5 text-sm font-medium text-text-muted outline-none transition hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-focus/40 disabled:opacity-60"
          >
            Cancel
          </button>

          <button
            type="button"
            disabled={deleting}
            onClick={onConfirm}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-danger-subtle px-3.5 text-sm font-semibold text-danger outline-none transition hover:bg-danger-bg focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 disabled:opacity-60"
          >
            {deleting && (
              <span
                aria-hidden="true"
                className="material-symbols-outlined animate-spin text-[18px]"
              >
                refresh
              </span>
            )}
            {deleting
              ? 'Deleting…'
              : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}
