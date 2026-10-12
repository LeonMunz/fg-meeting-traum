import { useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

/**
 * Explicit in-app confirmation for the concrete Upcoming Meeting's
 * destructive direct action (no `window.confirm`):
 *
 * - `mode: 'delete'` — a STANDALONE concrete Meeting the server
 *   marks deletable: permanent deletion of exactly this Meeting
 *   (Meeting-owned content is removed; independently owned Work
 *   Items are not).
 * - `mode: 'cancel'` — a MATERIALIZED recurring occurrence the
 *   server marks cancellable: the dedicated cancellation of ONLY
 *   this scheduled occurrence (the series and every other
 *   occurrence stay unchanged).
 * - `mode: 'skip'` — a STILL-VIRTUAL recurring occurrence the
 *   server marks excludable (feed `canExclude`): the dedicated
 *   single-occurrence exclusion of ONLY this scheduled occurrence.
 *   No concrete Meeting exists, so the copy deliberately does NOT
 *   describe the action as deleting an existing Meeting — only the
 *   scheduled occurrence is removed; the recurring series and every
 *   other occurrence stay unchanged.
 *
 * Which mode is offered — and whether the trash action exists at
 * all — is decided by the server-derived `actionPermissions`
 * (canDelete / canCancel) or the feed's `canExclude`; this dialog
 * only confirms the explicit
 * intent it is asked to.
 *
 * Conventions (established destructive-confirmation pattern of the
 * Meetings feature — see `MeetingCancelFollowUpDialog`): the safe
 * action receives the initial focus, Tab is trapped inside the
 * dialog, Escape / overlay mousedown cancel WITHOUT mutation
 * (never while the request is in flight), the destructive action
 * shows its pending state, a failed operation keeps the dialog
 * open with a compact retryable error, and focus is returned to
 * the originating trigger when the dialog closes (if it is still
 * in the document).
 */

export type MeetingDeleteConfirmMode = 'delete' | 'cancel' | 'skip'

type MeetingDeleteConfirmDialogProps = {
  mode: MeetingDeleteConfirmMode
  /** The actual Meeting title, quoted in the confirmation copy. */
  meetingTitle: string
  /**
   * The concrete scheduled slot the row occupies (e.g.
   * "Wed, Sep 23 at 10:00") — shown so the user confirms against
   * the exact occurrence, not just a title.
   */
  whenLabel: string
  /** True while the confirmed operation is in flight. */
  deleting: boolean
  /** Non-null after a failed confirmation attempt (retryable). */
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}

// Minimal focus trap for the two dialog buttons: Tab / Shift+Tab
// cycle within the dialog.
const FOCUSABLE_SELECTOR = 'button:not([disabled])'

export function MeetingDeleteConfirmDialog({
  mode,
  meetingTitle,
  whenLabel,
  deleting,
  error,
  onCancel,
  onConfirm,
}: MeetingDeleteConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const safeRef = useRef<HTMLButtonElement>(null)

  // Initial focus on the safe (non-destructive) action.
  useEffect(() => {
    safeRef.current?.focus()
  }, [])

  // Return focus to the originating trigger (the row's trash
  // action) when the dialog closes by ANY path — Cancel, Escape,
  // overlay, or success. The trigger is gone from the document
  // after a successful deletion, so the restore is a no-op then.
  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null

    return () => {
      if (previouslyFocused && previouslyFocused.isConnected) {
        previouslyFocused.focus()
      }
    }
  }, [])

  // Escape cancels — never while the operation is in flight (the
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

  const isDelete = mode === 'delete'
  const isSkip = mode === 'skip'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay-scrim px-4 py-8 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !deleting) {
          onCancel()
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="meeting-delete-confirm-title"
        aria-describedby="meeting-delete-confirm-prompt"
        onKeyDown={handleTabTrap}
        className="w-full max-w-md overflow-hidden rounded-2xl border border-border-structural bg-surface shadow-xl"
      >
        <div className="border-b border-border-subtle px-6 py-5">
          <h2
            id="meeting-delete-confirm-title"
            className="text-lg font-semibold tracking-tight text-text"
          >
            {isDelete
              ? 'Delete meeting?'
              : isSkip
                ? 'Skip this occurrence?'
                : 'Cancel this occurrence?'}
          </h2>

          <p
            id="meeting-delete-confirm-prompt"
            className="mt-2 text-sm text-text-muted"
          >
            <span className="block break-words">
              {isDelete ? (
                <>
                  Permanently delete "{meetingTitle}"?
                </>
              ) : isSkip ? (
                <>
                  Skip "{meetingTitle}" on {whenLabel}?
                </>
              ) : (
                <>
                  Cancel "{meetingTitle}" on {whenLabel}?
                </>
              )}
            </span>

            <span className="mt-1 block">
              {isDelete
                ? 'The meeting, its agenda, and its notes are removed permanently. Independently owned work items are not deleted.'
                : isSkip
                  ? 'Only this scheduled occurrence is removed. The recurring series and every other occurrence stay unchanged.'
                  : 'Only this scheduled occurrence is cancelled — the recurring series and every other occurrence stay unchanged.'}
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
            disabled={deleting}
            onClick={onCancel}
            className="h-9 rounded-lg px-4 text-sm font-medium text-text-muted outline-none transition hover:bg-surface-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-60"
          >
            {isDelete
              ? 'Cancel'
              : isSkip
                ? 'Keep occurrence'
                : 'Keep meeting'}
          </button>

          <button
            type="button"
            disabled={deleting}
            onClick={onConfirm}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-danger px-4 text-sm font-semibold text-text-inverse outline-none transition hover:bg-danger/80 focus-visible:ring-2 focus-visible:ring-danger focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:bg-action-disabled-bg disabled:text-action-disabled-text disabled:hover:bg-action-disabled-bg"
          >
            {deleting && (
              <span
                aria-hidden="true"
                className="material-symbols-outlined animate-spin text-[18px]"
              >
                refresh
              </span>
            )}
            {isDelete
              ? deleting
                ? 'Deleting…'
                : 'Delete'
              : isSkip
                ? deleting
                  ? 'Skipping…'
                  : 'Skip occurrence'
                : deleting
                  ? 'Cancelling…'
                  : 'Cancel occurrence'}
          </button>
        </div>
      </div>
    </div>
  )
}
