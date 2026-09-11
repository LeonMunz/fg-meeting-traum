import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { useNavigate } from 'react-router'

import { ApiError } from '../../api/client'
import {
  createMeeting,
  createMeetingFromSeries,
  listMeetings,
} from '../../api/meetings'
import type {
  ApiMeeting,
  ApiMeetingStatus,
} from '../../api/types'
import { useResearchGroupListScope } from '../research-group/useResearchGroupListScope'
import {
  CreateMeetingDialog,
  type CreateMeetingInput,
} from './CreateMeetingDialog'

const statusLabels: Record<ApiMeetingStatus, string> = {
  upcoming: 'Upcoming',
  live: 'Live',
  completed: 'Completed',
}

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

function formatMeetingDate(value: string) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

export function MeetingListPage() {
  const navigate = useNavigate()

  const {
    activeResearchGroupId,
    activeResearchGroup,
    loading: researchGroupsLoading,
    error: researchGroupsError,
  } = useResearchGroupListScope()

  const [meetings, setMeetings] =
    useState<ApiMeeting[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] =
    useState<string | null>(null)
  const [createDialogOpen, setCreateDialogOpen] =
    useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] =
    useState<string | null>(null)

  const loadMeetings = useCallback(async () => {
    if (activeResearchGroupId == null) {
      setMeetings([])
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)

    try {
      const nextMeetings = await listMeetings(
        activeResearchGroupId,
      )

      setMeetings(nextMeetings)
    } catch (loadError) {
      setMeetings([])
      setError(
        getErrorMessage(
          loadError,
          'Meetings could not be loaded.',
        ),
      )
    } finally {
      setLoading(false)
    }
  }, [activeResearchGroupId])

  useEffect(() => {
    void loadMeetings()
  }, [loadMeetings])

  const sortedMeetings = useMemo(
    () =>
      [...meetings].sort((a, b) =>
        a.scheduledAt.localeCompare(b.scheduledAt),
      ),
    [meetings],
  )

  const handleCreateMeeting = async (
    input: CreateMeetingInput,
  ) => {
    if (activeResearchGroupId == null) {
      return
    }


    setCreating(true)
    setCreateError(null)

    try {
      const meeting =
        input.seriesId != null
          ? await createMeetingFromSeries(
              input.seriesId,
              {
                title: input.title,
                scheduledAt: input.scheduledAt,
                participantIds: input.participantIds,
              },
            )
          : await createMeeting(
              Number(input.researchGroupId),
              {
                title: input.title,
                scheduledAt: input.scheduledAt,
                scope: input.scope,
                projectId: input.projectId,
                participantIds: input.participantIds,
              },
            )

      setMeetings((current) => [
        ...current.filter(
          (candidate) =>
            candidate.id !== meeting.id,
        ),
        meeting,
      ])

      setCreateDialogOpen(false)
    } catch (createMeetingError) {
      setCreateError(
        getErrorMessage(
          createMeetingError,
          'Meeting could not be created.',
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
          <h1 className="text-3xl font-semibold tracking-tight text-text">
            Meetings
          </h1>

          <p className="mt-1.5 text-sm leading-6 text-text-muted">
            {activeResearchGroup
              ? `Meetings in ${activeResearchGroup.name}.`
              : 'Research Group Meetings and follow-up work.'}
          </p>
        </div>

        <button
          type="button"
          disabled={
            activeResearchGroupId == null ||
            pageLoading
          }
          onClick={() => {
            setCreateError(null)
            setCreateDialogOpen(true)
          }}
          className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-text-inverse shadow-sm transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
        >
          <span className="material-symbols-outlined text-[19px]">
            add
          </span>
          New meeting
        </button>

        <button
          type="button"
          onClick={() => navigate('/meetings/series')}
          className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg border border-border-subtle bg-surface px-4 text-sm font-semibold text-text transition hover:bg-surface-hover"
        >
          <span className="material-symbols-outlined text-[19px]">
            event_repeat
          </span>
          Meeting Templates
        </button>
      </header>

      {pageLoading ? (
        <div className="mt-8 flex min-h-64 items-center justify-center rounded-xl border border-border-subtle bg-surface-quiet">
          <span className="material-symbols-outlined mr-2 animate-spin text-[20px] text-text-muted">
            refresh
          </span>

          <span className="text-sm text-text-muted">
            Loading meetings…
          </span>
        </div>
      ) : pageError ? (
        <div
          role="alert"
          className="mt-8 flex min-h-64 flex-col items-center justify-center rounded-xl border border-border-subtle bg-surface-quiet px-6 py-10 text-center"
        >
          <span className="material-symbols-outlined text-[28px] text-danger">
            cloud_off
          </span>

          <h2 className="mt-3 text-base font-semibold text-text">
            Meetings couldn't be loaded
          </h2>

          <p className="mt-1 max-w-md text-sm text-text-muted">
            {pageError}
          </p>

          <button
            type="button"
            onClick={() => void loadMeetings()}
            className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg border border-border-subtle px-4 text-sm font-semibold text-text transition hover:bg-surface-hover"
          >
            <span className="material-symbols-outlined text-[18px]">
              refresh
            </span>
            Try again
          </button>
        </div>
      ) : activeResearchGroupId == null ? (
        <div className="mt-8 rounded-xl border border-dashed border-border-default bg-surface-quiet px-6 py-12 text-center">
          <p className="text-sm text-text-muted">
            No research group is currently available.
          </p>
        </div>
      ) : sortedMeetings.length === 0 ? (
        <div className="mt-8 flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-border-default bg-surface-quiet px-6 py-12 text-center">
          <span className="material-symbols-outlined text-[30px] text-text-muted">
            groups
          </span>

          <h2 className="mt-3 text-base font-semibold text-text">
            No meetings yet
          </h2>

          <p className="mt-1 text-sm text-text-muted">
            Create the first meeting for this research group.
          </p>

          <button
            type="button"
            onClick={() => {
              setCreateError(null)
              setCreateDialogOpen(true)
            }}
            className="mt-5 inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-text-inverse"
          >
            <span className="material-symbols-outlined text-[18px]">
              add
            </span>
            Create meeting
          </button>
        </div>
      ) : (
        <section className="mt-8 overflow-hidden rounded-xl border border-border-subtle bg-surface-quiet">
          <div className="grid grid-cols-[minmax(280px,1fr)_220px_140px_120px] border-b border-border-subtle bg-surface-header px-6 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">
              Meeting
            </div>

            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">
              Scheduled
            </div>

            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">
              Status
            </div>

            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">
              People
            </div>
          </div>

          <div className="divide-y divide-border-subtle">
            {sortedMeetings.map((meeting) => (
              <button
                key={meeting.id}
                type="button"
                onClick={() =>
                  navigate(`/meetings/${meeting.id}`)
                }
                className="grid w-full grid-cols-[minmax(280px,1fr)_220px_140px_120px] items-center gap-4 px-6 py-4 text-left transition hover:bg-surface-hover"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-text">
                    {meeting.title}
                  </div>

                  <div className="mt-1 text-xs text-text-muted">
                    Meeting #{meeting.id}
                  </div>
                </div>

                <div className="text-sm text-text-muted">
                  {formatMeetingDate(
                    meeting.scheduledAt,
                  )}
                </div>

                <div>
                  <span className="inline-flex rounded-full bg-surface-muted px-2.5 py-1 text-xs font-medium text-text">
                    {statusLabels[meeting.status]}
                  </span>
                </div>

                <div className="text-sm text-text-muted">
                  {meeting.participantIds.length}
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      <CreateMeetingDialog
        open={createDialogOpen}
        submitting={creating}
        submitError={createError}
        onClose={() => {
          if (!creating) {
            setCreateDialogOpen(false)
          }
        }}
        onCreate={(input) =>
          void handleCreateMeeting(input)
        }
      />
    </div>
  )
}
