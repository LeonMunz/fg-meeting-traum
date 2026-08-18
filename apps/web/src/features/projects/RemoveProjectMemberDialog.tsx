import { useEffect } from 'react'

type RemoveProjectMemberDialogProps = {
  open: boolean
  memberName: string
  onClose: () => void
  onConfirm: () => void
}

export function RemoveProjectMemberDialog({
  open,
  memberName,
  onClose,
  onConfirm,
}: RemoveProjectMemberDialogProps) {
  useEffect(() => {
    if (!open) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, onClose])

  if (!open) {
    return null
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-on-surface/25 px-4 py-8 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="remove-project-member-title"
        className="w-full max-w-md overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-lowest shadow-xl"
      >
        <div className="px-6 py-6">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-error-container text-error">
            <span
              aria-hidden="true"
              className="material-symbols-outlined text-[22px]"
            >
              person_remove
            </span>
          </div>

          <h2
            id="remove-project-member-title"
            className="mt-4 text-lg font-semibold tracking-tight text-on-surface"
          >
            Remove project member?
          </h2>

          <p className="mt-2 text-sm leading-6 text-on-surface-variant">
            <span className="font-medium text-on-surface">
              {memberName}
            </span>{' '}
            will lose access to this project.
          </p>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-outline-variant bg-surface-container-low/45 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-lg px-4 text-sm font-medium text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface"
          >
            Cancel
          </button>

          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-error px-4 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
          >
            <span
              aria-hidden="true"
              className="material-symbols-outlined text-[18px]"
            >
              person_remove
            </span>
            Remove member
          </button>
        </div>
      </div>
    </div>
  )
}
