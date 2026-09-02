import {
  useEffect,
  useState,
} from 'react'
import type { FormEvent } from 'react'

import {
  listProjects,
} from '../../api/projects'
import {
  listMeetingSeries,
} from '../../api/meetings'
import { useResearchGroup } from '../research-group/useResearchGroup'

import type {
  ApiMeetingScope,
  ApiMeetingSeries,
  ApiProject,
} from '../../api/types'

export type CreateMeetingInput = {
  title: string
  scheduledAt: string
  researchGroupId: number
  scope: ApiMeetingScope
  projectId: number | null
  seriesId: number | null
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
  const {
    groups,
    activeResearchGroup,
  } = useResearchGroup()

  const [title, setTitle] = useState('')
  const [scheduledAt, setScheduledAt] =
    useState(getDefaultDateTimeValue)
  const [researchGroupId, setResearchGroupId] = useState('')
  const [projects, setProjects] = useState<ApiProject[]>([])
  const [projectId, setProjectId] = useState('')
  const [series, setSeries] = useState<ApiMeetingSeries[]>([])
  const [seriesId, setSeriesId] = useState('')

  useEffect(() => {
    if (!open) {
      setTitle('')
      setScheduledAt(getDefaultDateTimeValue())
      setResearchGroupId(
        String(activeResearchGroup?.id ?? ''),
      )
      setProjects([])
      setProjectId('')
      setSeries([])
      setSeriesId('')
      return
    }

    if (researchGroupId === '') {
      setResearchGroupId(
        String(activeResearchGroup?.id ?? ''),
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Load the projects available for the selected research group so the
  // Project dropdown can offer them. Only write-role projects allow
  // Meeting creation; the server remains authoritative.
  useEffect(() => {
    const gid = Number(researchGroupId)
    if (!open || !Number.isInteger(gid) || gid <= 0) {
      setProjects([])
      setProjectId('')
      return
    }

    let cancelled = false
    listProjects(gid)
      .then((nextProjects) => {
        if (cancelled) {
          return
        }

        const writable = nextProjects.filter(
          (project) =>
            project.currentUserRole === 'owner' ||
            project.currentUserRole === 'member',
        )

        setProjects(writable)

        // Reset a Project selection that no longer applies.
        setProjectId((current) =>
          writable.some((p) => p.id === Number(current))
            ? current
            : '',
        )
      })
      .catch(() => {
        if (!cancelled) {
          setProjects([])
          setProjectId('')
        }
      })

    return () => {
      cancelled = true
    }
  }, [open, researchGroupId])

  // Load meeting templates (series) scoped to the selected Research Group.
  // The dropdown filters to templates matching the current scope/project.
  useEffect(() => {
    const gid = Number(researchGroupId)
    if (!open || !Number.isInteger(gid) || gid <= 0) {
      setSeries([])
      setSeriesId('')
      return
    }

    let cancelled = false
    listMeetingSeries(gid)
      .then((nextSeries) => {
        if (cancelled) {
          return
        }
        setSeries(nextSeries)
        setSeriesId((current) => {
          if (current === '') {
            return ''
          }
          const match = nextSeries.find(
            (candidate) => candidate.id === Number(current),
          )
          if (!match) {
            return ''
          }
          const wantedProject =
            projectId === '' ? null : Number(projectId)
          const ok =
            match.scope === 'group'
              ? match.projectId === null
              : match.projectId === wantedProject
          return ok ? current : ''
        })
      })
      .catch(() => {
        if (!cancelled) {
          setSeries([])
          setSeriesId('')
        }
      })

    return () => {
      cancelled = true
    }
  }, [open, researchGroupId, projectId])

  if (!open) {
    return null
  }

  const scope: ApiMeetingScope =
    projectId === '' ? 'group' : 'project'

  const selectedProjectId =
    projectId === '' ? null : Number(projectId)

  const availableSeries = series.filter((candidate) => {
    if (candidate.isArchived) {
      return false
    }
    if (scope === 'group') {
      return candidate.scope === 'group'
    }
    return (
      candidate.scope === 'project' &&
      candidate.projectId === selectedProjectId
    )
  })

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()

    const trimmedTitle = title.trim()

    if (!trimmedTitle || !scheduledAt || !researchGroupId) {
      return
    }

    const scheduledDate = new Date(scheduledAt)

    if (Number.isNaN(scheduledDate.getTime())) {
      return
    }

    const resolvedProjectId =
      projectId === '' ? null : Number(projectId)

    onCreate({
      title: trimmedTitle,
      scheduledAt: scheduledDate.toISOString(),
      researchGroupId: Number(researchGroupId),
      scope,
      projectId: resolvedProjectId,
      seriesId: seriesId === '' ? null : Number(seriesId),
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
              Create a Research Group Meeting or a Project Meeting.
            </p>
          </div>

          <div className="space-y-5 px-6 py-5">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-on-surface">
                Research group
              </span>

              <select
                value={researchGroupId}
                onChange={(event) => {
                  setResearchGroupId(event.target.value)
                  setProjectId('')
                  setSeriesId('')
                }}
                className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
              >
                {groups.map((group) => (
                  <option
                    key={group.id}
                    value={group.id}
                  >
                    {group.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-on-surface">
                Project
              </span>

              <select
                value={projectId}
                onChange={(event) => {
                  setProjectId(event.target.value)
                  setSeriesId('')
                }}
                className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
              >
                <option value="">No project (Research Group Meeting)</option>

                {projects.map((project) => (
                  <option
                    key={project.id}
                    value={project.id}
                  >
                    {project.name}
                  </option>
                ))}
              </select>

              <span className="mt-1.5 block text-xs text-on-surface-variant">
                {scope === 'project'
                  ? 'This will be a Project Meeting.'
                  : 'This will be a Research Group Meeting.'}
              </span>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-on-surface">
                Meeting template
              </span>

              <select
                value={seriesId}
                onChange={(event) =>
                  setSeriesId(event.target.value)
                }
                className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
              >
                <option value="">No template</option>

                {availableSeries.map((candidate) => (
                  <option
                    key={candidate.id}
                    value={candidate.id}
                  >
                    {candidate.title}
                  </option>
                ))}
              </select>

              <span className="mt-1.5 block text-xs text-on-surface-variant">
                {seriesId === ''
                  ? 'Creates a standalone meeting.'
                  : 'Uses the template sections as the starting structure.'}
              </span>
            </label>

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
                placeholder="Weekly Sync"
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
                !scheduledAt ||
                !researchGroupId
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
