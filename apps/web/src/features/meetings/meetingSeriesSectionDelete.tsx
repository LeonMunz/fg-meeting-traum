import type { ApiMeetingSeriesSection } from '../../api/types'

/**
 * Confirmation dialog for permanently deleting ONE Template
 * Section. The Section-Kachel (tile) on the template management
 * page offers the destructive action; the actual delete request
 * (state + refresh) lives in the page.
 */
export function MeetingSeriesSectionDeleteDialog({
  section,
  isLastActiveSection,
  deleting,
  error,
  onCancel,
  onConfirm,
}: {
  section: ApiMeetingSeriesSection
  isLastActiveSection: boolean
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
        aria-labelledby="series-section-delete-title"
        className="w-full max-w-md overflow-hidden rounded-2xl border border-border-subtle bg-surface shadow-xl"
      >
        <div className="px-6 py-5">
          <h2
            id="series-section-delete-title"
            className="text-lg font-semibold tracking-tight text-text"
          >
            Delete section "{section.name}"?
          </h2>

          <p className="mt-2 text-sm text-text-muted">
            This permanently deletes the section
            "{section.name}" from this meeting
            template. Meetings that were already
            created keep their sections and their
            content. New meetings — and recurring
            occurrences that have not been opened
            yet — will no longer include this
            section.
          </p>

          {isLastActiveSection && (
            <p className="mt-2 text-sm text-text-muted">
              This is the last active section of the
              template, so new meetings will
              initially have no agenda section.
            </p>
          )}

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
              : 'Delete section'}
          </button>
        </div>
      </div>
    </div>
  )
}
