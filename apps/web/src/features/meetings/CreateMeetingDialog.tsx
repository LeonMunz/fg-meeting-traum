import {
  useEffect,
  useState,
} from 'react'
import type { FormEvent } from 'react'

export type CreateMeetingInput = {
  title: string
  scheduledAt: string
}

type CreateMeetingDialogProps = {
  open: boolean
  submitting: boolean
  submitError: string | null
  onClose: () => void
  onCreate: (input: CreateMeetingInput) => void
}

function getDefaultDateTimeValue() {
  const date = new Date()
  date.setMinutes(date.getMinutes() + 60)

  const local = new Date(
    date.getTime() - date.getTimezoneOffset() * 60_000,
  )

  return local.toISOString().slice(0, 16)
}

export function CreateMeetingDialog({
  open,
  submitting,
  submitError,
  onClose,
  onCreate,
}: CreateMeetingDialogProps) {
  const [title, setTitle] = useState('')
  const [scheduledAt, setScheduledAt] =
    useState(getDefaultDateTimeValue)

  useEffect(() => {
    if (!open) {
      setTitle('')
      setScheduledAt(getDefaultDateTimeValue())
    }
  }, [open])

  if (!open) {
    return null
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()

    const trimmedTitle = title.trim()

    if (!trimmedTitle || !scheduledAt) {
      return
    }

    const scheduledDate = new Date(scheduledAt)

    if (Number.isNaN(scheduledDate.getTime())) {
      return
    }

    onCreate({
      title: trimmedTitle,
      scheduledAt: scheduledDate.toISOString(),
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4">
      <div className="w-full max-w-lg overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest shadow-xl">
        <form onSubmit={handleSubmit}>
          <div className="border-b border-outline-variant px-6 py-5">
            <h2 className="text-lg font-semibold text-on-surface">
              New meeting
            </h2>

            <p className="mt-1 text-sm text-on-surface-variant">
              Create a meeting in the active research group.
            </p>
          </div>

          <div className="space-y-5 px-6 py-5">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-on-surface">
                Title
              </span>

              <input
                autoFocus
                type="text"
                value={title}
                onChange={(event) =>
                  setTitle(event.target.value)
                }
                placeholder="FG Weekly"
                className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none transition placeholder:text-on-surface-variant/60 focus:border-primary focus:ring-2 focus:ring-primary/15"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-on-surface">
                Date and time
              </span>

              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={(event) =>
                  setScheduledAt(event.target.value)
                }
                className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
              />
            </label>
          </div>

          {submitError && (
            <div
              role="alert"
              className="border-t border-error/20 bg-error-container/35 px-6 py-3 text-sm text-error"
            >
              {submitError}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 border-t border-outline-variant bg-surface-container-low/45 px-6 py-4">
            <button
              type="button"
              disabled={submitting}
              onClick={onClose}
              className="h-9 rounded-lg px-4 text-sm font-medium text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface disabled:opacity-45"
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={
                submitting ||
                !title.trim() ||
                !scheduledAt
              }
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <span className="material-symbols-outlined text-[18px]">
                add
              </span>

              {submitting
                ? 'Creating…'
                : 'Create meeting'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
