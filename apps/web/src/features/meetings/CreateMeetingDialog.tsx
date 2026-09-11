import {
  useEffect,
  useRef,
  useState,
} from 'react'
import type { FormEvent } from 'react'

import {
  listProjects,
} from '../../api/projects'
import {
  listMeetingSeries,
  searchMeetingSeriesParticipantCandidates,
  searchStandaloneMeetingParticipantCandidates,
} from '../../api/meetings'
import { useResearchGroup } from '../research-group/useResearchGroup'
import { getPersonName } from './shared'

import type {
  ApiMeetingScope,
  ApiMeetingParticipantCandidate,
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
  participantIds: number[]
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

function getPersonInitials(person: ApiMeetingParticipantCandidate) {
  const first =
    person.firstName.trim()[0] ??
    person.username.trim()[0] ??
    '?'
  const last = person.lastName.trim()[0] ?? ''

  return `${first}${last}`.toUpperCase()
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
  const [participantQuery, setParticipantQuery] = useState('')
  const [participantCandidates, setParticipantCandidates] = useState<
    ApiMeetingParticipantCandidate[]
  >([])
  const [selectedParticipants, setSelectedParticipants] = useState<
    ApiMeetingParticipantCandidate[]
  >([])
  const [searchingParticipants, setSearchingParticipants] = useState(false)
  const [participantSearchError, setParticipantSearchError] = useState<
    string | null
  >(null)
  const participantSearchVersion = useRef(0)

  const scope: ApiMeetingScope =
    projectId === '' ? 'group' : 'project'

  const selectedProjectId =
    projectId === '' ? null : Number(projectId)

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
      setParticipantQuery('')
      setParticipantCandidates([])
      setSelectedParticipants([])
      setSearchingParticipants(false)
      setParticipantSearchError(null)
      participantSearchVersion.current += 1
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

  useEffect(() => {
    if (!open) {
      return
    }

    const query = participantQuery.trim()
    const groupId = Number(researchGroupId)
    const selectedSeriesId = Number(seriesId)

    participantSearchVersion.current += 1
    const version = participantSearchVersion.current
    setParticipantCandidates([])
    setSearchingParticipants(false)
    setParticipantSearchError(null)

    if (
      query.length < 2 ||
      (!seriesId &&
        (!Number.isInteger(groupId) || groupId <= 0)) ||
      (seriesId &&
        (!Number.isInteger(selectedSeriesId) || selectedSeriesId <= 0))
    ) {
      return
    }

    const timeout = window.setTimeout(() => {
      setSearchingParticipants(true)

      const request = seriesId
        ? searchMeetingSeriesParticipantCandidates(
            selectedSeriesId,
            query,
          )
        : searchStandaloneMeetingParticipantCandidates(groupId, {
            query,
            scope,
            projectId: selectedProjectId,
          })

      void request
        .then((results) => {
          if (participantSearchVersion.current !== version) {
            return
          }
          setParticipantCandidates(results)
        })
        .catch(() => {
          if (participantSearchVersion.current !== version) {
            return
          }
          setParticipantSearchError('People could not be searched.')
        })
        .finally(() => {
          if (participantSearchVersion.current === version) {
            setSearchingParticipants(false)
          }
        })
    }, 250)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [
    open,
    participantQuery,
    projectId,
    researchGroupId,
    scope,
    selectedProjectId,
    seriesId,
  ])

  if (!open) {
    return null
  }

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
      participantIds: selectedParticipants.map(
        (participant) => participant.id,
      ),
    })
  }

  const selectedParticipantIds = new Set(
    selectedParticipants.map((participant) => participant.id),
  )

  const availableParticipantCandidates = participantCandidates.filter(
    (candidate) => !selectedParticipantIds.has(candidate.id),
  )

  const selectParticipant = (
    candidate: ApiMeetingParticipantCandidate,
  ) => {
    setSelectedParticipants((current) =>
      current.some((participant) => participant.id === candidate.id)
        ? current
        : [...current, candidate],
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4 py-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-meeting-title"
        className="max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-xl border border-border-default bg-surface shadow-xl"
      >
        <form onSubmit={handleSubmit}>
          <div className="border-b border-border-subtle px-6 py-5">
            <h2
              id="create-meeting-title"
              className="text-lg font-semibold text-text"
            >
              New meeting
            </h2>

            <p className="mt-1 text-sm text-text-muted">
              Create a Research Group Meeting or a Project Meeting.
            </p>
          </div>

          <div className="space-y-5 px-6 py-5">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-text">
                Research group
              </span>

              <select
                value={researchGroupId}
                onChange={(event) => {
                  setResearchGroupId(event.target.value)
                  setProjectId('')
                  setSeriesId('')
                }}
                className="h-10 w-full rounded-lg border border-border-control bg-surface px-3 text-sm text-text outline-none focus:border-focus focus:ring-2 focus:ring-focus/15"
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

            <div>
              <label
                htmlFor="create-meeting-participants"
                className="mb-1.5 block text-sm font-medium text-text"
              >
                Participants
              </label>

              <div className="relative">
                <span
                  aria-hidden="true"
                  className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-text-muted"
                >
                  search
                </span>
                <input
                  id="create-meeting-participants"
                  type="search"
                  value={participantQuery}
                  onChange={(event) =>
                    setParticipantQuery(event.target.value)
                  }
                  placeholder="Search people..."
                  aria-describedby="create-meeting-participants-help"
                  className="h-10 w-full rounded-lg border border-border-control bg-surface pl-10 pr-3 text-sm text-text outline-none transition placeholder:text-text-muted/60 focus:border-focus focus:ring-2 focus:ring-focus/15"
                />
              </div>

              <p
                id="create-meeting-participants-help"
                className="mt-1.5 text-xs text-text-muted"
              >
                Search by name or username. Enter at least 2 characters.
              </p>

              {participantQuery.trim().length >= 2 && (
                <div
                  aria-live="polite"
                  className="mt-2 max-h-44 overflow-y-auto rounded-xl border border-border-default bg-surface shadow-lg"
                >
                  {searchingParticipants ? (
                    <div className="flex items-center gap-2 px-4 py-3 text-sm text-text-muted">
                      <span
                        aria-hidden="true"
                        className="material-symbols-outlined animate-spin text-[18px]"
                      >
                        refresh
                      </span>
                      Searching…
                    </div>
                  ) : participantSearchError ? (
                    <div role="alert" className="px-4 py-3 text-sm text-danger">
                      {participantSearchError}
                    </div>
                  ) : availableParticipantCandidates.length > 0 ? (
                    <div className="divide-y divide-border-subtle">
                      {availableParticipantCandidates.map((candidate) => (
                        <button
                          key={candidate.id}
                          type="button"
                          onClick={() => selectParticipant(candidate)}
                          className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
                        >
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-muted text-[11px] font-semibold text-text">
                            {getPersonInitials(candidate)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-text">
                              {getPersonName(candidate)}
                            </span>
                            <span className="block truncate text-xs text-text-muted">
                              @{candidate.username}
                            </span>
                          </span>
                          <span className="text-xs font-semibold text-accent-text">
                            Add
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="px-4 py-3 text-sm text-text-muted">
                      {participantCandidates.length > 0
                        ? 'All matching people are selected.'
                        : 'No matching people found.'}
                    </div>
                  )}
                </div>
              )}

              {selectedParticipants.length > 0 && (
                <div
                  role="list"
                  aria-label="Selected participants"
                  className="mt-3 flex flex-wrap gap-2"
                >
                  {selectedParticipants.map((participant) => (
                    <span
                      key={participant.id}
                      role="listitem"
                      className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-accent-subtle px-3 py-1.5 text-sm text-accent-text"
                    >
                      <span className="max-w-40 truncate">
                        {getPersonName(participant)}
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove ${getPersonName(participant)}`}
                        onClick={() =>
                          setSelectedParticipants((current) =>
                            current.filter(
                              (candidate) => candidate.id !== participant.id,
                            ),
                          )
                        }
                        className="-mr-1 flex h-5 w-5 items-center justify-center rounded-full text-accent-text/70 transition hover:bg-accent-text/10 hover:text-accent-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                      >
                        <span
                          aria-hidden="true"
                          className="material-symbols-outlined text-[16px]"
                        >
                          close
                        </span>
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label
                htmlFor="create-meeting-project"
                className="mb-1.5 block text-sm font-medium text-text"
              >
                Project
              </label>

              <select
                id="create-meeting-project"
                aria-describedby="create-meeting-project-help"
                value={projectId}
                onChange={(event) => {
                  setProjectId(event.target.value)
                  setSeriesId('')
                }}
                className="h-10 w-full rounded-lg border border-border-control bg-surface px-3 text-sm text-text outline-none focus:border-focus focus:ring-2 focus:ring-focus/15"
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

              <p
                id="create-meeting-project-help"
                className="mt-1.5 text-xs text-text-muted"
              >
                {scope === 'project'
                  ? 'This will be a Project Meeting.'
                  : 'This will be a Research Group Meeting.'}
              </p>
            </div>

            <div>
              <label
                htmlFor="create-meeting-template"
                className="mb-1.5 block text-sm font-medium text-text"
              >
                Meeting template
              </label>

              <select
                id="create-meeting-template"
                aria-describedby="create-meeting-template-help"
                value={seriesId}
                onChange={(event) =>
                  setSeriesId(event.target.value)
                }
                className="h-10 w-full rounded-lg border border-border-control bg-surface px-3 text-sm text-text outline-none focus:border-focus focus:ring-2 focus:ring-focus/15"
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

              <p
                id="create-meeting-template-help"
                className="mt-1.5 text-xs text-text-muted"
              >
                {seriesId === ''
                  ? 'Creates a standalone meeting.'
                  : 'Uses the template sections as the starting structure.'}
              </p>
            </div>

            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-text">
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
                className="h-10 w-full rounded-lg border border-border-control bg-surface px-3 text-sm text-text outline-none transition placeholder:text-text-muted/60 focus:border-focus focus:ring-2 focus:ring-focus/15"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-text">
                Date and time
              </span>

              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={(event) =>
                  setScheduledAt(event.target.value)
                }
                className="h-10 w-full rounded-lg border border-border-control bg-surface px-3 text-sm text-text outline-none transition focus:border-focus focus:ring-2 focus:ring-focus/15"
              />
            </label>
          </div>

          {submitError && (
            <div
              role="alert"
              className="border-t border-danger-subtle bg-danger-bg px-6 py-3 text-sm text-danger"
            >
              {submitError}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 border-t border-border-subtle bg-surface-hover/30 px-6 py-4">
            <button
              type="button"
              disabled={submitting}
              onClick={onClose}
              className="h-9 rounded-lg px-4 text-sm font-medium text-text-muted transition hover:bg-surface-hover hover:text-text disabled:opacity-45"
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
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-text-inverse shadow-sm transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
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
