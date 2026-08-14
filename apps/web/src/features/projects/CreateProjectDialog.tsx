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
      className="fixed inset-0 z-50 flex items-center justify-center bg-on-surface/25 px-4 py-8 backdrop-blur-[2px]"
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
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-lowest shadow-xl"
      >
        <div className="flex items-start justify-between border-b border-outline-variant px-6 py-5">
          <div>
            <h2
              id="create-project-title"
              className="text-lg font-semibold tracking-tight text-on-surface"
            >
              Create project
            </h2>

            <p className="mt-1 text-sm text-on-surface-variant">
              Create a separate workspace for a research project.
            </p>
          </div>

          <button
            type="button"
            onClick={handleClose}
            aria-label="Close dialog"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface"
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
                className="mb-1.5 block text-sm font-medium text-on-surface"
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
                className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none transition placeholder:text-on-surface-variant/60 focus:border-primary focus:ring-2 focus:ring-primary/15"
              />
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label
                  htmlFor="project-description"
                  className="block text-sm font-medium text-on-surface"
                >
                  Description
                </label>

                <span className="text-xs text-on-surface-variant">
                  Optional
                </span>
              </div>

              <textarea
                id="project-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What is this project about?"
                rows={3}
                className="w-full resize-none rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2.5 text-sm leading-5 text-on-surface outline-none transition placeholder:text-on-surface-variant/60 focus:border-primary focus:ring-2 focus:ring-primary/15"
              />
            </div>

            <fieldset>
              <legend className="mb-2 block text-sm font-medium text-on-surface">
                Initial status
              </legend>

              <div className="grid grid-cols-2 gap-3">
                <label
                  className={[
                    'flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition',
                    status === 'active'
                      ? 'border-primary bg-primary-fixed/45 ring-1 ring-primary/20'
                      : 'border-outline-variant hover:bg-surface-container-low',
                  ].join(' ')}
                >
                  <input
                    type="radio"
                    name="project-status"
                    value="active"
                    checked={status === 'active'}
                    onChange={() => setStatus('active')}
                    className="mt-0.5 accent-primary"
                  />

                  <span>
                    <span className="flex items-center gap-1.5 text-sm font-medium text-on-surface">
                      <span className="h-2 w-2 rounded-full bg-emerald-500" />
                      Active
                    </span>

                    <span className="mt-1 block text-xs leading-4 text-on-surface-variant">
                      Work can start immediately.
                    </span>
                  </span>
                </label>

                <label
                  className={[
                    'flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition',
                    status === 'paused'
                      ? 'border-primary bg-primary-fixed/45 ring-1 ring-primary/20'
                      : 'border-outline-variant hover:bg-surface-container-low',
                  ].join(' ')}
                >
                  <input
                    type="radio"
                    name="project-status"
                    value="paused"
                    checked={status === 'paused'}
                    onChange={() => setStatus('paused')}
                    className="mt-0.5 accent-primary"
                  />

                  <span>
                    <span className="flex items-center gap-1.5 text-sm font-medium text-on-surface">
                      <span className="h-2 w-2 rounded-full bg-amber-500" />
                      Paused
                    </span>

                    <span className="mt-1 block text-xs leading-4 text-on-surface-variant">
                      Set up now and activate later.
                    </span>
                  </span>
                </label>
              </div>
            </fieldset>

            <div className="rounded-lg bg-surface-container-low px-4 py-3">
              <div className="flex gap-2.5">
                <span className="material-symbols-outlined mt-0.5 text-[18px] text-on-surface-variant">
                  lock
                </span>

                <p className="text-xs leading-5 text-on-surface-variant">
                  You will be the project owner. Members and their roles can be
                  managed from the project afterwards.
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-outline-variant bg-surface-container-low/45 px-6 py-4">
            <button
              type="button"
              onClick={handleClose}
              className="h-9 rounded-lg px-4 text-sm font-medium text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface"
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={!name.trim()}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
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
