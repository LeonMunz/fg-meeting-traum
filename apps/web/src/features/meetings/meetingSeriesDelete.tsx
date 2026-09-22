import {
  useEffect,
  useRef,
  useState,
} from 'react'

import type {
  ApiMeetingSeries,
  ApiProjectRole,
} from '../../api/types'

/**
 * Shared Meeting Template deletion affordances, used by the
 * template list row menu and the template management page.
 * Keeping the three-dot "Template actions" trigger, the
 * destructive menu entry, the confirmation dialog, and the
 * manage-visibility rule in one place guarantees the same
 * copy, styling, keyboard behavior, and permission gating
 * everywhere. The actual delete request (state + refresh)
 * lives in each page.
 */

// The server remains authoritative; this only decides whether
// to render the destructive management control.
export function canManageMeetingSeries(
  series: ApiMeetingSeries,
  context: {
    canManageGroupTemplate: boolean
    projectRole: ApiProjectRole | null
  },
): boolean {
  if (series.scope === 'group') {
    return context.canManageGroupTemplate
  }

  if (series.projectId == null) {
    return false
  }

  return (
    context.projectRole === 'owner' ||
    context.projectRole === 'member'
  )
}

// Three-dot "Template actions" trigger with the destructive
// "Delete template" entry. Same trigger/menu/keyboard behavior
// as the Meeting detail's "Meeting actions" menu; only the
// delete request itself (state + refresh) lives in the page.
export function TemplateActionsMenu({
  onDeleteRequest,
}: {
  onDeleteRequest: () => void
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
      document.removeEventListener(
        'mousedown',
        onOutside,
        true,
      )
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

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Template actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        className={[
          'flex h-9 w-9 items-center justify-center rounded-lg text-text-muted outline-none transition hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-focus/40',
          open ? 'bg-surface-hover' : '',
        ].join(' ')}
      >
        <span
          aria-hidden="true"
          className="material-symbols-outlined text-[20px]"
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
          className="z-50 w-52 rounded-xl border border-border-subtle bg-surface p-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onDeleteRequest()
            }}
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm text-danger outline-none transition hover:bg-danger-bg focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
          >
            <span
              aria-hidden="true"
              className="material-symbols-outlined text-[17px] text-text-muted"
            >
              delete
            </span>

            <span className="truncate">
              Delete template
            </span>
          </button>
        </div>
      )}
    </div>
  )
}

export function MeetingSeriesDeleteDialog({
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
        role="dialog"
        aria-modal="true"
        aria-labelledby="series-delete-title"
        className="w-full max-w-md overflow-hidden rounded-2xl border border-border-subtle bg-surface shadow-xl"
      >
        <div className="px-6 py-5">
          <h2
            id="series-delete-title"
            className="text-lg font-semibold tracking-tight text-text"
          >
            Delete meeting template?
          </h2>

          <p className="mt-2 text-sm text-text-muted">
            This permanently deletes the meeting
            template "{title}" and its sections.
            Meetings already created from this
            template are not deleted.
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
              : 'Delete template'}
          </button>
        </div>
      </div>
    </div>
  )
}
