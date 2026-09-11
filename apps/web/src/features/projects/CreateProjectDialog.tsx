import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'

export type CreateProjectInput = {
  name: string
  description: string
  status: 'active' | 'paused'
}

type CreateProjectDialogProps = {
  open: boolean
  onClose: () => void
  onCreate: (project: CreateProjectInput) => void
}

export function CreateProjectDialog({
  open,
  onClose,
  onCreate,
}: CreateProjectDialogProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<CreateProjectInput['status']>('active')

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

  const reset = () => {
    setName('')
    setDescription('')
    setStatus('active')
  }

  const handleClose = () => {
    reset()
    onClose()
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()

    const trimmedName = name.trim()
    if (!trimmedName) return

    onCreate({
      name: trimmedName,
      description: description.trim(),
      status,
    })

    reset()
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay-scrim px-4 py-8 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          handleClose()
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-project-title"
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-border-structural bg-surface shadow-xl"
      >
        <div className="flex items-start justify-between border-b border-border-structural px-6 py-5">
          <div>
            <h2
              id="create-project-title"
              className="text-lg font-semibold tracking-tight text-text"
            >
              Create project
            </h2>

            <p className="mt-1 text-sm text-text-muted">
              Create a separate workspace for a research project.
            </p>
          </div>

          <button
            type="button"
            onClick={handleClose}
            aria-label="Close dialog"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition hover:bg-surface-hover hover:text-text"
          >
            <span className="material-symbols-outlined text-[20px]">
              close
            </span>
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="space-y-5 px-6 py-6">
            <div>
              <label
                htmlFor="project-name"
                className="mb-1.5 block text-sm font-medium text-text"
              >
                Project name
              </label>

              <input
                id="project-name"
                autoFocus
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Quantum Materials Study"
                className="h-10 w-full rounded-lg border border-border-field bg-surface px-3 text-sm text-text outline-none transition placeholder:text-text-muted/60 focus:border-focus focus:ring-2 focus:ring-focus/15"
              />
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label
                  htmlFor="project-description"
                  className="block text-sm font-medium text-text"
                >
                  Description
                </label>

                <span className="text-xs text-text-muted">
                  Optional
                </span>
              </div>

              <textarea
                id="project-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What is this project about?"
                rows={3}
                className="w-full resize-none rounded-lg border border-border-field bg-surface px-3 py-2.5 text-sm leading-5 text-text outline-none transition placeholder:text-text-muted/60 focus:border-focus focus:ring-2 focus:ring-focus/15"
              />
            </div>

            <fieldset>
              <legend className="mb-2 block text-sm font-medium text-text">
                Initial status
              </legend>

              <div className="grid grid-cols-2 gap-3">
                <label
                  className={[
                    'flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition',
                    status === 'active'
                      ? 'border-border-field bg-option-selected-bg text-option-selected-text'
                      : 'border-border-field hover:bg-surface-hover',
                  ].join(' ')}
                >
                  <input
                    type="radio"
                    name="project-status"
                    value="active"
                    checked={status === 'active'}
                    onChange={() => setStatus('active')}
                    className="mt-0.5 accent-control-accent"
                  />

                  <span>
                    <span className="flex items-center gap-1.5 text-sm font-medium text-text">
                      <span className="h-2 w-2 rounded-full bg-emerald-500" />
                      Active
                    </span>

                    <span className="mt-1 block text-xs leading-4 text-text-muted">
                      Work can start immediately.
                    </span>
                  </span>
                </label>

                <label
                  className={[
                    'flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition',
                    status === 'paused'
                      ? 'border-border-field bg-option-selected-bg text-option-selected-text'
                      : 'border-border-field hover:bg-surface-hover',
                  ].join(' ')}
                >
                  <input
                    type="radio"
                    name="project-status"
                    value="paused"
                    checked={status === 'paused'}
                    onChange={() => setStatus('paused')}
                    className="mt-0.5 accent-control-accent"
                  />

                  <span>
                    <span className="flex items-center gap-1.5 text-sm font-medium text-text">
                      <span className="h-2 w-2 rounded-full bg-amber-500" />
                      Paused
                    </span>

                    <span className="mt-1 block text-xs leading-4 text-text-muted">
                      Set up now and activate later.
                    </span>
                  </span>
                </label>
              </div>
            </fieldset>

            <div className="rounded-lg bg-surface-quiet px-4 py-3">
              <div className="flex gap-2.5">
                <span className="material-symbols-outlined mt-0.5 text-[18px] text-text-muted">
                  lock
                </span>

                <p className="text-xs leading-5 text-text-muted">
                  You will be the project owner. Members and their roles can be
                  managed from the project afterwards.
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-border-structural bg-surface-footer px-6 py-4">
            <button
              type="button"
              onClick={handleClose}
              className="h-9 rounded-lg px-4 text-sm font-medium text-text-muted transition hover:bg-surface-hover hover:text-text"
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={!name.trim()}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-action px-4 text-sm font-semibold text-text-inverse shadow-sm transition hover:bg-action-hover disabled:cursor-not-allowed disabled:opacity-45"
            >
              <span className="material-symbols-outlined text-[18px]">
                add
              </span>
              Create project
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
