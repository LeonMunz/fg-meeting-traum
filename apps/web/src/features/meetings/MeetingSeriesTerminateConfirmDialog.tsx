import { useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

/**
 * Explicit in-app confirmation for terminating a WHOLE recurring
 * Series from the Series overview (no `window.confirm`):
 *
 * - stops all future scheduled occurrences of the series,
 * - cancels (without deleting) the already-created upcoming
 *   concrete Meetings in the future,
 * - keeps past and in-progress Meetings and their Notes fully
 *   available,
 * - does NOT delete the series' Meeting Template,
 * - cannot be undone (no restoration / reactivation in V1).
 *
 * The dialog only confirms the explicit intent it is asked to —
 * the trash action exists on a row ONLY when the server's
 * per-row `canTerminate` permission report grants it, and the
 * termination endpoint revalidates the rule as the final
 * authority.
 *
 * Conventions (the established destructive-confirmation pattern of
 * the Meetings feature — see `MeetingDeleteConfirmDialog`): the
 * safe action receives the initial focus, Tab is trapped inside
 * the dialog, Escape / overlay mousedown cancel WITHOUT mutation
 * (never while the request is in flight), the destructive action
 * shows its pending state, a failed operation keeps the dialog
 * open with a compact retryable error, and focus is returned to
 * the originating trigger when the dialog closes (if it is still
 * in the document). The fixed `z-50` layer sits above the sticky
 * app shell (TopBar `z-20`), so the confirmation is always
 * visible above the header.
 */

type MeetingSeriesTerminateConfirmDialogProps = {
  /** The Series title, quoted in the confirmation copy. */
  seriesTitle: string
  /** True while the confirmed termination is in flight. */
  terminating: boolean
  /** Non-null after a failed confirmation attempt (retryable). */
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}

// Minimal focus trap for the two dialog buttons: Tab / Shift+Tab
// cycle within the dialog.
const FOCUSABLE_SELECTOR = 'button:not([disabled])'

export function MeetingSeriesTerminateConfirmDialog({
  seriesTitle,
  terminating,
  error,
  onCancel,
  onConfirm,
}: MeetingSeriesTerminateConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const safeRef = useRef<HTMLButtonElement>(null)
  // The originating trigger (the row's trash action), captured
  // BEFORE the initial-focus effect below moves focus to the
  // safe action — effect declaration order decides the
  // capture instant.
  const previouslyFocusedRef =
    useRef<HTMLElement | null>(null)

  // Capture the current focus first (the dialog's own focus
  // movement must not be mistaken for the originating
  // trigger).
  useEffect(() => {
    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
  }, [])

  // Initial focus on the safe (non-destructive) action.
  useEffect(() => {
    safeRef.current?.focus()
  }, [])

  // Return focus to the originating trigger (the row's trash
  // action) when the dialog closes by ANY path — Keep series,
  // Escape, overlay, or success. The trigger is gone from the
  // document after a successful termination, so the restore is a
  // no-op then.
  useEffect(() => {
    return () => {
      const previouslyFocused =
        previouslyFocusedRef.current

      if (
        previouslyFocused != null &&
        previouslyFocused.isConnected
      ) {
        previouslyFocused.focus()
      }
    }
  }, [])

  // Escape cancels — never while the termination is in flight (the
  // request must not be abandoned mid-write).
  useEffect(() => {
    if (terminating) {
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
  }, [terminating, onCancel])

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay-scrim px-4 py-8 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !terminating) {
          onCancel()
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="meeting-series-terminate-confirm-title"
        aria-describedby="meeting-series-terminate-confirm-prompt"
        onKeyDown={handleTabTrap}
        className="w-full max-w-md overflow-hidden rounded-2xl border border-border-structural bg-surface shadow-xl"
      >
        <div className="border-b border-border-subtle px-6 py-5">
          <h2
            id="meeting-series-terminate-confirm-title"
            className="text-lg font-semibold tracking-tight text-text"
          >
            Delete meeting series?
          </h2>

          <p
            id="meeting-series-terminate-confirm-prompt"
            className="mt-2 text-sm text-text-muted"
          >
            <span className="block break-words">
              Stop the recurring series "{seriesTitle}"?
            </span>

            <span className="mt-2 block space-y-1">
              <span className="block">
                Future scheduled occurrences will stop.
              </span>

              <span className="block">
                Already-created upcoming meetings in the future
                will be cancelled.
              </span>

              <span className="block">
                Past and in-progress meetings and their notes
                remain available.
              </span>

              <span className="block">
                The meeting template is not deleted.
              </span>
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

        <div className="mt-5 flex items-center justify-end gap-3 border-t border-border-subtle bg-surface-footer px-6 py-4">
          <button
            ref={safeRef}
            type="button"
            disabled={terminating}
            onClick={onCancel}
            className="h-9 rounded-lg px-4 text-sm font-medium text-text-muted outline-none transition hover:bg-surface-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-60"
          >
            Keep series
          </button>

          <button
            type="button"
            disabled={terminating}
            onClick={onConfirm}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-danger px-4 text-sm font-semibold text-text-inverse outline-none transition hover:bg-danger/80 focus-visible:ring-2 focus-visible:ring-danger focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:bg-action-disabled-bg disabled:text-action-disabled-text disabled:hover:bg-action-disabled-bg"
          >
            {terminating && (
              <span
                aria-hidden="true"
                className="material-symbols-outlined animate-spin text-[18px]"
              >
                refresh
              </span>
            )}
            {terminating ? 'Deleting…' : 'Delete series'}
          </button>
        </div>
      </div>
    </div>
  )
}
