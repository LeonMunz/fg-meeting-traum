import { useEffect } from 'react'

export type ProjectLifecycleAction =
  | 'archive'
  | 'delete'

type ProjectLifecycleDialogProps = {
  open: boolean
  action: ProjectLifecycleAction
  projectName: string
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}

const content = {
  archive: {
    icon: 'archive',
    title: 'Archive project?',
    description:
      'The project will leave the current workspace and become read-only. Its work, members and history stay available, and an owner can restore it later.',
    button: 'Archive project',
  },
  delete: {
    icon: 'delete',
    title: 'Delete project permanently?',
    description:
      'This permanently removes this empty project. This action cannot be undone.',
    button: 'Delete project',
  },
} satisfies Record<
  ProjectLifecycleAction,
  {
    icon: string
    title: string
    description: string
    button: string
  }
>

export function ProjectLifecycleDialog({
  open,
  action,
  projectName,
  busy,
  onClose,
  onConfirm,
}: ProjectLifecycleDialogProps) {
  useEffect(() => {
    if (!open || busy) {
      return
    }

    const handleKeyDown = (
      event: KeyboardEvent,
    ) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener(
      'keydown',
      handleKeyDown,
    )

    return () => {
      window.removeEventListener(
        'keydown',
        handleKeyDown,
      )
    }
  }, [busy, onClose, open])

  if (!open) {
    return null
  }

  const dialog = content[action]
  const destructive = action === 'delete'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-on-surface/25 px-4 py-8 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (
          !busy &&
          event.target === event.currentTarget
        ) {
          onClose()
        }
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="project-lifecycle-title"
        className="w-full max-w-md overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-lowest shadow-xl"
      >
        <div className="px-6 py-6">
          <div
            className={[
              'flex h-11 w-11 items-center justify-center rounded-full',
              destructive
                ? 'bg-error-container text-error'
                : 'bg-surface-container-high text-on-surface-variant',
            ].join(' ')}
          >
            <span
              aria-hidden="true"
              className="material-symbols-outlined text-[22px]"
            >
              {dialog.icon}
            </span>
          </div>

          <h2
            id="project-lifecycle-title"
            className="mt-4 text-lg font-semibold tracking-tight text-on-surface"
          >
            {dialog.title}
          </h2>

          <p className="mt-2 text-sm leading-6 text-on-surface-variant">
            <span className="font-medium text-on-surface">
              {projectName}
            </span>
            {' — '}
            {dialog.description}
          </p>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-outline-variant bg-surface-container-low/45 px-6 py-4">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="h-9 rounded-lg px-4 text-sm font-medium text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-45"
          >
            Cancel
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={[
              'inline-flex h-9 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-55',
              destructive
                ? 'bg-error hover:opacity-90'
                : 'bg-primary hover:bg-primary/90',
            ].join(' ')}
          >
            <span
              aria-hidden="true"
              className="material-symbols-outlined text-[18px]"
            >
              {dialog.icon}
            </span>

            {busy
              ? 'Working…'
              : dialog.button}
          </button>
        </div>
      </div>
    </div>
  )
}
