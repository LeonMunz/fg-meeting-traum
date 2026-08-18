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
      const meeting = await createMeeting(
        activeResearchGroupId,
        {
          title: input.title,
          scheduledAt: input.scheduledAt,
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
          <h1 className="text-3xl font-semibold tracking-tight text-on-surface">
            Meetings
          </h1>

          <p className="mt-1.5 text-sm leading-6 text-on-surface-variant">
            {activeResearchGroup
              ? `Meetings in ${activeResearchGroup.name}.`
              : 'Research group meetings and follow-up work.'}
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
          className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
        >
          <span className="material-symbols-outlined text-[19px]">
            add
          </span>
          New meeting
        </button>
      </header>

      {pageLoading ? (
        <div className="mt-8 flex min-h-64 items-center justify-center rounded-xl border border-outline-variant bg-surface-container-lowest">
          <span className="material-symbols-outlined mr-2 animate-spin text-[20px] text-on-surface-variant">
            refresh
          </span>

          <span className="text-sm text-on-surface-variant">
            Loading meetings…
          </span>
        </div>
      ) : pageError ? (
        <div
          role="alert"
          className="mt-8 flex min-h-64 flex-col items-center justify-center rounded-xl border border-outline-variant bg-surface-container-lowest px-6 py-10 text-center"
        >
          <span className="material-symbols-outlined text-[28px] text-error">
            cloud_off
          </span>

          <h2 className="mt-3 text-base font-semibold text-on-surface">
            Meetings couldn't be loaded
          </h2>

          <p className="mt-1 max-w-md text-sm text-on-surface-variant">
            {pageError}
          </p>

          <button
            type="button"
            onClick={() => void loadMeetings()}
            className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg border border-outline-variant px-4 text-sm font-semibold text-on-surface transition hover:bg-surface-container-low"
          >
            <span className="material-symbols-outlined text-[18px]">
              refresh
            </span>
            Try again
          </button>
        </div>
      ) : activeResearchGroupId == null ? (
        <div className="mt-8 rounded-xl border border-dashed border-outline-variant bg-surface-container-lowest px-6 py-12 text-center">
          <p className="text-sm text-on-surface-variant">
            No research group is currently available.
          </p>
        </div>
      ) : sortedMeetings.length === 0 ? (
        <div className="mt-8 flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-outline-variant bg-surface-container-lowest px-6 py-12 text-center">
          <span className="material-symbols-outlined text-[30px] text-on-surface-variant">
            groups
          </span>

          <h2 className="mt-3 text-base font-semibold text-on-surface">
            No meetings yet
          </h2>

          <p className="mt-1 text-sm text-on-surface-variant">
            Create the first meeting for this research group.
          </p>

          <button
            type="button"
            onClick={() => {
              setCreateError(null)
              setCreateDialogOpen(true)
            }}
            className="mt-5 inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white"
          >
            <span className="material-symbols-outlined text-[18px]">
              add
            </span>
            Create meeting
          </button>
        </div>
      ) : (
        <section className="mt-8 overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest">
          <div className="grid grid-cols-[minmax(280px,1fr)_220px_140px_120px] border-b border-outline-variant bg-surface-container-low px-6 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-on-surface-variant">
              Meeting
            </div>

            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-on-surface-variant">
              Scheduled
            </div>

            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-on-surface-variant">
              Status
            </div>

            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-on-surface-variant">
              People
            </div>
          </div>

          <div className="divide-y divide-outline-variant/60">
            {sortedMeetings.map((meeting) => (
              <button
                key={meeting.id}
                type="button"
                onClick={() =>
                  navigate(`/meetings/${meeting.id}`)
                }
                className="grid w-full grid-cols-[minmax(280px,1fr)_220px_140px_120px] items-center gap-4 px-6 py-4 text-left transition hover:bg-surface-container-low"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-on-surface">
                    {meeting.title}
                  </div>

                  <div className="mt-1 text-xs text-on-surface-variant">
                    Meeting #{meeting.id}
                  </div>
                </div>

                <div className="text-sm text-on-surface-variant">
                  {formatMeetingDate(
                    meeting.scheduledAt,
                  )}
                </div>

                <div>
                  <span className="inline-flex rounded-full bg-surface-container-high px-2.5 py-1 text-xs font-medium text-on-surface">
                    {statusLabels[meeting.status]}
                  </span>
                </div>

                <div className="text-sm text-on-surface-variant">
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
