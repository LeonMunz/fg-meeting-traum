import {
  useCallback,
  useEffect,
  useState,
} from 'react'
import { useNavigate } from 'react-router'

import { ApiError } from '../../api/client'
import {
  createMeetingSeries,
  listMeetingSeries,
} from '../../api/meetings'
import { listProjects } from '../../api/projects'
import type {
  ApiMeetingScope,
  ApiMeetingSeries,
  ApiProject,
} from '../../api/types'
import { useResearchGroupListScope } from '../research-group/useResearchGroupListScope'

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
    const detail = error.detail as {
      error?: unknown
    }

    if (typeof detail.error === 'string') {
      return detail.error
    }
  }

  if (error instanceof Error && error.message) {
    return error.message
  }

  return fallback
}

export function MeetingSeriesListPage() {
  const navigate = useNavigate()

  const {
    activeResearchGroupId,
    activeResearchGroup,
    loading: researchGroupsLoading,
    error: researchGroupsError,
  } = useResearchGroupListScope()

  const [series, setSeries] =
    useState<ApiMeetingSeries[]>([])
  const [projects, setProjects] =
    useState<ApiProject[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] =
    useState<string | null>(null)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [scope, setScope] =
    useState<ApiMeetingScope>('group')
  const [projectId, setProjectId] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] =
    useState<string | null>(null)

  const loadSeries = useCallback(async () => {
    if (activeResearchGroupId == null) {
      setSeries([])
      setProjects([])
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)

    try {
      const [nextSeries, nextProjects] = await Promise.all([
        listMeetingSeries(activeResearchGroupId),
        listProjects(activeResearchGroupId),
      ])

      setSeries(nextSeries)
      setProjects(nextProjects)
    } catch (loadError) {
      setSeries([])
      setProjects([])
      setError(
        getErrorMessage(
          loadError,
          'Meeting templates could not be loaded.',
        ),
      )
    } finally {
      setLoading(false)
    }
  }, [activeResearchGroupId])

  useEffect(() => {
    void loadSeries()
  }, [loadSeries])

  const handleCreate = async (
    event: React.FormEvent,
  ) => {
    event.preventDefault()

    if (
      activeResearchGroupId == null ||
      !title.trim() ||
      (scope === 'project' && !projectId) ||
      creating
    ) {
      return
    }

    setCreating(true)
    setCreateError(null)

    try {
      const newSeries = await createMeetingSeries(
        activeResearchGroupId,
        {
          title: title.trim(),
          description: description.trim(),
          scope,
          projectId:
            scope === 'project'
              ? Number(projectId)
              : undefined,
        },
      )

      setSeries((current) => [
        ...current.filter(
          (candidate) =>
            candidate.id !== newSeries.id,
        ),
        newSeries,
      ])

      setTitle('')
      setDescription('')
      setScope('group')
      setProjectId('')

      // Navigate to the new series detail page.
      navigate(
        `/meetings/series/${newSeries.id}`,
      )
    } catch (err) {
      setCreateError(
        getErrorMessage(
          err,
          'Meeting template could not be created.',
        ),
      )
    } finally {
      setCreating(false)
    }
  }

  const pageLoading =
    researchGroupsLoading || loading

  const pageError =
    researchGroupsError || error

  return (
    <div className="w-full px-6 py-8 lg:px-8 lg:py-10 xl:px-10">
      <header className="flex items-start justify-between gap-6">
        <div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => navigate('/meetings')}
              className="inline-flex items-center gap-1 text-sm font-medium text-text-muted hover:text-accent-text"
            >
              <span className="material-symbols-outlined text-[18px]">
                arrow_back
              </span>
              Meetings
            </button>
          </div>

          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-text">
            Meeting Templates
          </h1>

          <p className="mt-1.5 text-sm leading-6 text-text-muted">
            {activeResearchGroup
              ? `Meeting templates in ${activeResearchGroup.name}.`
              : 'Manage meeting templates.'}
          </p>
        </div>
      </header>

      {/* Create form */}
      <form
        onSubmit={handleCreate}
        className="mt-6 rounded-xl border border-border-subtle bg-surface-quiet p-5"
      >
        <h2 className="text-sm font-semibold text-text">
          New meeting template
        </h2>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label>
            <span className="mb-1.5 block text-sm font-medium text-text">
              Name
            </span>

            <input
              type="text"
              value={title}
              onChange={(event) =>
                setTitle(event.target.value)
              }
              placeholder="e.g. Weekly Sync"
              className="h-10 w-full rounded-lg border border-border-control bg-surface px-3 text-sm text-text outline-none focus:border-focus focus:ring-2 focus:ring-focus/15"
            />
          </label>

          <fieldset>
            <legend className="mb-1.5 block text-sm font-medium text-text">
              Scope
            </legend>

            <div className="flex h-10 items-center gap-5 rounded-lg border border-border-control bg-surface-quiet px-3">
              {(['group', 'project'] as const).map((value) => (
                <label key={value} className="flex items-center gap-2 text-sm text-text">
                  <input
                    type="radio"
                    name="meeting-series-scope"
                    value={value}
                    checked={scope === value}
                    onChange={() => {
                      setScope(value)
                      if (value === 'group') {
                        setProjectId('')
                      }
                    }}
                  />
                  {value === 'group' ? 'Research group' : 'Project'}
                </label>
              ))}
            </div>
          </fieldset>

          {scope === 'project' && (
            <label>
              <span className="mb-1.5 block text-sm font-medium text-text">
                Project
              </span>

              <select
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
                className="h-10 w-full rounded-lg border border-border-control bg-surface px-3 text-sm text-text outline-none focus:border-focus focus:ring-2 focus:ring-focus/15"
                required
              >
                <option value="">Select a project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>

              {projects.length === 0 && (
                <span className="mt-1 block text-xs text-text-muted">
                  You do not have access to a project in this research group.
                </span>
              )}
            </label>
          )}

          <label>
            <span className="mb-1.5 block text-sm font-medium text-text">
              Description
            </span>

            <input
              type="text"
              value={description}
              onChange={(event) =>
                setDescription(event.target.value)
              }
              placeholder="Optional"
              className="h-10 w-full rounded-lg border border-border-control bg-surface px-3 text-sm text-text outline-none focus:border-focus focus:ring-2 focus:ring-focus/15"
            />
          </label>
        </div>

        {createError && (
          <div
            role="alert"
            className="mt-3 text-sm text-danger"
          >
            {createError}
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <button
            type="submit"
            disabled={
              creating || !title.trim()
              || (scope === 'project' && !projectId)
            }
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-action px-4 text-sm font-semibold text-text-inverse transition hover:bg-action-hover disabled:cursor-not-allowed disabled:opacity-45"
          >
            <span className="material-symbols-outlined text-[18px]">
              add
            </span>

            {creating
              ? 'Creating…'
              : 'Create template'}
          </button>
        </div>
      </form>

      {/* Series list */}
      {pageLoading ? (
        <div className="mt-8 flex min-h-48 items-center justify-center rounded-xl border border-border-subtle bg-surface-quiet">
          <span className="material-symbols-outlined mr-2 animate-spin text-[20px] text-text-muted">
            refresh
          </span>

          <span className="text-sm text-text-muted">
            Loading templates…
          </span>
        </div>
      ) : pageError ? (
        <div
          role="alert"
          className="mt-8 flex min-h-48 flex-col items-center justify-center rounded-xl border border-border-subtle bg-surface-quiet px-6 py-10 text-center"
        >
          <span className="material-symbols-outlined text-[28px] text-danger">
            cloud_off
          </span>

          <h2 className="mt-3 text-base font-semibold text-text">
            Templates couldn't be loaded
          </h2>

          <p className="mt-1 text-sm text-text-muted">
            {pageError}
          </p>

          <button
            type="button"
            onClick={() => void loadSeries()}
            className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg border border-border-subtle px-4 text-sm font-semibold text-text transition hover:bg-surface-hover"
          >
            <span className="material-symbols-outlined text-[18px]">
              refresh
            </span>
            Try again
          </button>
        </div>
      ) : series.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-border-default bg-surface-quiet px-6 py-12 text-center">
          <span className="material-symbols-outlined text-[28px] text-text-muted">
            event_repeat
          </span>

          <p className="mt-3 text-sm font-medium text-text">
            No meeting templates yet
          </p>

          <p className="mt-1 text-sm text-text-muted">
            Create a meeting template above.
          </p>
        </div>
      ) : (
        <section className="mt-8 overflow-hidden rounded-xl border border-border-subtle bg-surface-quiet">
          <div className="grid grid-cols-[minmax(180px,1fr)_minmax(140px,220px)_1fr_100px] gap-4 border-b border-border-subtle bg-surface-header px-6 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">
              Series
            </div>

            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">
              Scope
            </div>

            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">
              Description
            </div>

            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">
              Status
            </div>
          </div>

          <div className="divide-y divide-border-subtle">
            {series.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() =>
                  navigate(
                    `/meetings/series/${s.id}`,
                  )
                }
                className="grid w-full grid-cols-[minmax(180px,1fr)_minmax(140px,220px)_1fr_100px] items-center gap-4 px-6 py-4 text-left transition hover:bg-surface-hover"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-text">
                    {s.title}
                  </div>
                </div>

                <div className="min-w-0 truncate text-sm text-text-muted">
                  {s.scope === 'group'
                    ? 'Research Group'
                    : projects.find((project) => project.id === s.projectId)?.name ?? 'Project'}
                </div>

                <div className="min-w-0 truncate text-sm text-text-muted">
                  {s.description || '—'}
                </div>

                <div>
                  {s.isArchived ? (
                    <span className="inline-flex rounded-full bg-surface-muted px-2.5 py-1 text-xs font-medium text-text-muted">
                      Archived
                    </span>
                  ) : (
                    <span className="inline-flex rounded-full bg-status-active-bg px-2.5 py-1 text-xs font-medium text-status-active-text">
                      Active
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
