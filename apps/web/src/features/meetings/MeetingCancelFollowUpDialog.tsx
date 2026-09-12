import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { RefObject } from 'react'

import { ApiError } from '../../api/client'
import { cancelMeetingItemFollowUp } from '../../api/meetings'
import type {
  ApiCancelMeetingItemFollowUpResult,
  ApiMeetingItem,
} from '../../api/types'
import { formatMeetingDateCompact } from './shared'

type MeetingCancelFollowUpDialogProps = {
  sourceItem: ApiMeetingItem | null
  returnFocusRef: RefObject<HTMLButtonElement | null>
  onClose: () => void
  /**
   * Runs after a successful cancellation and is expected to refresh
   * canonical Meeting + item state. Selection/Current preservation
   * is the caller's responsibility (cancellation is a reversal and
   * must not advance, reconcile, or re-select Current).
   */
  onCancelled: (
    result: ApiCancelMeetingItemFollowUpResult,
  ) => Promise<void>
}

function getErrorMessage(
  error: unknown,
  fallback: string,
) {
  if (
    error instanceof ApiError &&
    error.detail &&
    typeof error.detail === 'object' &&
    'error' in error.detail
  ) {
    const detail = error.detail as { error?: unknown }
    if (typeof detail.error === 'string') {
      return detail.error
    }
  }

  if (error instanceof Error && error.message) {
    return error.message
  }

  return fallback
}

// Minimal focus trap for the two dialog buttons + the dialog
// container itself: Tab / Shift+Tab cycle within the dialog.
const FOCUSABLE_SELECTOR = 'button:not([disabled])'

export function MeetingCancelFollowUpDialog({
  sourceItem,
  returnFocusRef,
  onClose,
  onCancelled,
}: MeetingCancelFollowUpDialogProps) {
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const neutralRef = useRef<HTMLButtonElement>(null)
  const destructiveRef = useRef<HTMLButtonElement>(null)

  const schedule = sourceItem?.followUpSchedule ?? null

  useEffect(() => {
    // Initial focus on the neutral action (safe default).
    neutralRef.current?.focus()
  }, [])

  const close = useCallback(() => {
    onClose()
    queueMicrotask(() => returnFocusRef.current?.focus())
  }, [onClose, returnFocusRef])

  useEffect(() => {
    if (sourceItem == null || cancelling) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        queueMicrotask(() => returnFocusRef.current?.focus())
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [cancelling, onClose, returnFocusRef, sourceItem])

  const handleTabTrap = (event: React.KeyboardEvent) => {
    if (event.key !== 'Tab' || dialogRef.current == null) return

    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        FOCUSABLE_SELECTOR,
      ),
    )
    if (focusable.length === 0) return

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

  const confirm = async () => {
    if (cancelling || schedule == null) return

    setCancelling(true)
    setError(null)

    try {
      const result = await cancelMeetingItemFollowUp(
        schedule.id,
      )
      await onCancelled(result)
      onClose()
      queueMicrotask(() => returnFocusRef.current?.focus())
    } catch (cancelError) {
      // Keep the dialog open with the error: the source is still
      // scheduled and nothing may be mutated client-side.
      setError(
        getErrorMessage(
          cancelError,
          'Follow-up could not be cancelled.',
        ),
      )
    } finally {
      setCancelling(false)
    }
  }

  if (sourceItem == null || schedule == null) {
    return null
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay-scrim px-4 py-8 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !cancelling) {
          close()
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cancel-follow-up-title"
        aria-describedby="cancel-follow-up-prompt"
        onKeyDown={handleTabTrap}
        className="w-full max-w-md overflow-hidden rounded-2xl border border-border-structural bg-surface shadow-xl"
      >
        <div className="border-b border-border-subtle px-6 py-5">
          <h2
            id="cancel-follow-up-title"
            className="text-lg font-semibold tracking-tight text-text"
          >
            Cancel follow-up?
          </h2>
          <p
            id="cancel-follow-up-prompt"
            className="mt-1 text-sm text-text-muted"
          >
            This will remove the scheduled follow-up from {schedule.targetMeetingTitle} · {formatMeetingDateCompact(schedule.targetMeetingScheduledAt)}.
          </p>
          <p className="mt-2 text-sm font-medium text-text">
            {schedule.targetMeetingSectionName}
          </p>
          <p className="mt-1 text-xs text-text-muted">
            If the generated agenda item has already been changed, it will be kept as a normal agenda item.
          </p>
        </div>

        {error != null && (
          <p
            role="alert"
            className="mx-6 mt-4 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger"
          >
            {error}
          </p>
        )}

        <div className="mt-5 flex items-center justify-end gap-3 border-t border-border-subtle bg-surface-footer px-6 py-4">
          <button
            ref={neutralRef}
            type="button"
            disabled={cancelling}
            onClick={close}
            className="h-9 rounded-lg px-4 text-sm font-medium text-text-muted outline-none transition hover:bg-surface-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-60"
          >
            Keep follow-up
          </button>
          <button
            ref={destructiveRef}
            type="button"
            disabled={cancelling}
            onClick={() => void confirm()}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-danger px-4 text-sm font-semibold text-text-inverse outline-none transition hover:bg-danger/80 focus-visible:ring-2 focus-visible:ring-danger focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:bg-action-disabled-bg disabled:text-action-disabled-text disabled:hover:bg-action-disabled-bg"
          >
            {cancelling && (
              <span
                aria-hidden="true"
                className="material-symbols-outlined animate-spin text-[18px]"
              >
                refresh
              </span>
            )}
            {cancelling ? 'Cancelling…' : 'Cancel follow-up'}
          </button>
        </div>
      </div>
    </div>
  )
}
