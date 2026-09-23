import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useNavigate } from 'react-router'

import { ApiError } from '../../api/client'
import {
  createMeeting,
  createMeetingFromSeries,
  createMeetingRecurrence,
  listMeetings,
  listPersonalMeetingRecurrenceOccurrences,
} from '../../api/meetings'
import type {
  ApiMeeting,
  ApiCreateMeetingRecurrenceInput,
  ApiMeetingRecurrenceOccurrence,
} from '../../api/types'
import { useResearchGroupListScope } from '../research-group/useResearchGroupListScope'
import {
  CreateMeetingDialog,
  type CreateMeetingInput,
} from './CreateMeetingDialog'
import {
  buildUpcomingList,
  selectUpcomingConcreteMeetings,
  selectUpcomingWindowRows,
  upcomingRequestWindow,
} from './upcomingModel'
import { groupUpcomingByDate } from './upcomingGroups'
import { UpcomingMeetingsList } from './UpcomingMeetings'

const MEETINGS_TABS = [
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'series', label: 'Series' },
  { id: 'past', label: 'Past' },
] as const

type MeetingsTabId = (typeof MEETINGS_TABS)[number]['id']

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

/**
 * Clearly intentional placeholder shell for the tabs that this
 * checkpoint does not implement yet (Series overview, Past). No data
 * is requested and no product behavior is simulated.
 */
function ComingSoonPanel({
  icon,
  title,
  description,
}: {
  icon: string
  title: string
  description: string
}) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-[10px] border border-dashed border-border-default bg-surface-quiet px-6 py-12 text-center">
      <span className="material-symbols-outlined text-[28px] text-text-muted">
        {icon}
      </span>

      <h2 className="mt-3 text-base font-semibold text-text">
        {title}
      </h2>

      <p className="mt-1 max-w-md text-sm text-text-muted">
        {description}
      </p>
    </div>
  )
}

/**
 * Non-modal, transient success feedback for a created recurring
 * series. Fixed-positioned (outside the document flow) so it never
 * shifts the Upcoming list, and it auto-dismisses without an action
 * button. Placed TOP-RIGHT, below the sticky 64px global TopBar
 * (`top-20` = 80px keeps a 16px gap under the header). Deliberately
 * page-local: the repository has no application-wide notification
 * architecture, and none is introduced here.
 */
const SERIES_TOAST_DURATION_MS = 4500

// Exported (presentation-only) so the standalone visual harness
// (`scripts/visual/upcoming-date-group-check.mjs`) can render the
// real toast against the real production CSS.
export function SeriesCreatedToast() {
  return (
    <div
      role="status"
      className="fixed top-20 right-6 z-50 w-max max-w-[min(360px,calc(100vw-3rem))] rounded-[10px] border border-border-subtle bg-surface px-4 py-3 shadow-md"
    >
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden="true"
          className="material-symbols-outlined mt-0.5 shrink-0 text-[18px] text-success"
        >
          check_circle
        </span>

        <div className="min-w-0">
          <p className="text-sm font-medium text-text">
            Series created
          </p>
          <p className="mt-0.5 text-xs text-text-muted">
            Upcoming occurrences are now available.
          </p>
        </div>
      </div>
    </div>
  )
}

export function MeetingListPage() {
  const navigate = useNavigate()

  const {
    activeResearchGroupId,
    activeResearchGroup,
    loading: researchGroupsLoading,
    error: researchGroupsError,
  } = useResearchGroupListScope()

  const [activeTab, setActiveTab] =
    useState<MeetingsTabId>('upcoming')
  const tabRefs = useRef<Map<MeetingsTabId, HTMLButtonElement>>(
    new Map(),
  )

  // `null` = still loading; the load state is derived from the data
  // itself so the page can keep rendering what already arrived.
  const [meetings, setMeetings] =
    useState<ApiMeeting[] | null>(null)
  const [meetingsError, setMeetingsError] =
    useState<string | null>(null)
  const [occurrences, setOccurrences] =
    useState<ApiMeetingRecurrenceOccurrence[] | null>(null)
  const [occurrencesError, setOccurrencesError] =
    useState<string | null>(null)
  const [createDialogOpen, setCreateDialogOpen] =
    useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] =
    useState<string | null>(null)
  // Transient (auto-dismissing) success feedback for a created
  // recurring series: no concrete Meeting is created, so the
  // confirmation is a non-modal toast — the series' occurrences
  // appear in Upcoming from the feed refetch.
  const [seriesToastVisible, setSeriesToastVisible] =
    useState(false)
  const seriesToastTimer = useRef<number | null>(null)

  // One request window per page session: today → +42 days (local).
  const requestWindow = useMemo(
    () => upcomingRequestWindow(),
    [],
  )

  const loadMeetings = useCallback(async () => {
    if (activeResearchGroupId == null) {
      setMeetings([])
      setMeetingsError(null)
      return
    }

    setMeetings(null)
    setMeetingsError(null)

    try {
      setMeetings(
        await listMeetings(activeResearchGroupId),
      )
    } catch (loadError) {
      setMeetingsError(
        getErrorMessage(
          loadError,
          'Meetings could not be loaded.',
        ),
      )
    }
  }, [activeResearchGroupId])

  const loadOccurrences = useCallback(async () => {
    setOccurrences(null)
    setOccurrencesError(null)

    try {
      setOccurrences(
        await listPersonalMeetingRecurrenceOccurrences(
          requestWindow.from,
          requestWindow.to,
        ),
      )
    } catch (loadError) {
      setOccurrencesError(
        getErrorMessage(
          loadError,
          'Recurring meetings could not be loaded.',
        ),
      )
    }
  }, [requestWindow])

  const dismissSeriesToast =
    useCallback(() => {
      if (seriesToastTimer.current != null) {
        window.clearTimeout(
          seriesToastTimer.current,
        )
        seriesToastTimer.current = null
      }
      setSeriesToastVisible(false)
    }, [])

  const showSeriesToast = useCallback(() => {
    if (seriesToastTimer.current != null) {
      window.clearTimeout(
        seriesToastTimer.current,
      )
    }
    setSeriesToastVisible(true)
    seriesToastTimer.current = window.setTimeout(
      () => setSeriesToastVisible(false),
      SERIES_TOAST_DURATION_MS,
    )
  }, [])

  useEffect(
    () => dismissSeriesToast,
    [dismissSeriesToast],
  )

  useEffect(() => {
    if (activeResearchGroupId == null) {
      return
    }

    void loadMeetings()
    void loadOccurrences()
  }, [
    activeResearchGroupId,
    loadMeetings,
    loadOccurrences,
  ])

  const upcomingGroups = useMemo(() => {
    if (meetings == null) {
      return null
    }

    return groupUpcomingByDate(
      // One canonical visible window over the EFFECTIVE displayed
      // time of every row kind (concrete + recurring): local today →
      // +42 days, the same value and boundary semantics as the feed
      // request. Applied post-merge, after deduplication.
      selectUpcomingWindowRows(
        buildUpcomingList(
          selectUpcomingConcreteMeetings(meetings),
          occurrences ?? [],
        ),
        requestWindow,
      ),
    )
  }, [meetings, occurrences, requestWindow])

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
        ...(current ?? []).filter(
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

  const handleCreateSeries = async (
    input: ApiCreateMeetingRecurrenceInput,
  ) => {
    setCreating(true)
    setCreateError(null)

    try {
      await createMeetingRecurrence(input)

      // No concrete Meeting was created. The new series' effective
      // occurrences become visible through the feed refetch.
      setCreateDialogOpen(false)
      showSeriesToast()
      void loadOccurrences()
    } catch (createSeriesError) {
      // The dialog stays open with all recurrence fields preserved;
      // there is no fallback to ordinary Meeting creation.
      setCreateError(
        getErrorMessage(
          createSeriesError,
          'Recurring series could not be created.',
        ),
      )
    } finally {
      setCreating(false)
    }
  }

  const openCreateDialog = () => {
    setCreateError(null)
    dismissSeriesToast()
    setCreateDialogOpen(true)
  }

  const handleTabKeyDown = (
    event: React.KeyboardEvent,
    current: MeetingsTabId,
  ) => {
    if (
      event.key !== 'ArrowRight' &&
      event.key !== 'ArrowLeft'
    ) {
      return
    }

    event.preventDefault()

    const ids = MEETINGS_TABS.map(
      (tab) => tab.id,
    )
    const index = ids.indexOf(current)
    const nextId = ids[
      (index +
        (event.key === 'ArrowRight' ? 1 : -1) +
        ids.length) %
      ids.length
    ]

    setActiveTab(nextId)
    tabRefs.current.get(nextId)?.focus()
  }

  const groupUnavailable =
    activeResearchGroupId == null

  const pageError =
    researchGroupsError || meetingsError

  const listLoading =
    researchGroupsLoading || meetings == null

  const recurrencePending =
    !listLoading &&
    meetings != null &&
    !pageError &&
    occurrences == null &&
    occurrencesError == null

  return (
    <div className="w-full px-6 py-8 lg:px-8">
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold tracking-tight text-text">
            Meetings
          </h1>

          <p className="mt-1 text-sm leading-6 text-text-muted">
            {activeResearchGroup
              ? `Your meetings in ${activeResearchGroup.name}.`
              : 'Research Group Meetings and follow-up work.'}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => navigate('/meetings/series')}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-border-subtle bg-surface px-3.5 text-sm font-semibold text-text transition hover:bg-surface-hover"
          >
            <span className="material-symbols-outlined text-[18px]">
              event_repeat
            </span>
            Meeting Templates
          </button>

          <button
            type="button"
            disabled={groupUnavailable || listLoading}
            onClick={openCreateDialog}
            className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg bg-accent px-3.5 text-sm font-semibold text-text-inverse shadow-sm transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
          >
            <span
              aria-hidden="true"
              className="material-symbols-outlined text-[18px]"
            >
              add
            </span>
            New meeting
          </button>
        </div>
      </header>

      <div
        role="tablist"
        aria-label="Meetings"
        className="mt-6 flex h-10 items-stretch gap-6 border-b border-border-subtle"
      >
        {MEETINGS_TABS.map((tab) => {
          const selected = activeTab === tab.id

          return (
            <button
              key={tab.id}
              ref={(node) => {
                if (node) {
                  tabRefs.current.set(tab.id, node)
                }
              }}
              type="button"
              role="tab"
              id={`meetings-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`meetings-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(event) =>
                handleTabKeyDown(event, tab.id)
              }
              className={[
                '-mb-px border-b-2 px-0.5 text-sm font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-focus',
                selected
                  ? 'border-tab-active text-text'
                  : 'border-transparent text-text-muted hover:text-text',
              ].join(' ')}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      <div
        role="tabpanel"
        id={`meetings-panel-${activeTab}`}
        aria-labelledby={`meetings-tab-${activeTab}`}
        className="mt-4"
      >
        {activeTab === 'upcoming' &&
          (pageError ? (
            <div
              role="alert"
              className="flex min-h-64 flex-col items-center justify-center rounded-[10px] border border-border-subtle bg-surface-quiet px-6 py-10 text-center"
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
                onClick={() => {
                  void loadMeetings()
                  void loadOccurrences()
                }}
                className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg border border-border-subtle px-4 text-sm font-semibold text-text transition hover:bg-surface-hover"
              >
                <span className="material-symbols-outlined text-[18px]">
                  refresh
                </span>
                Try again
              </button>
            </div>
          ) : groupUnavailable ? (
            <div className="rounded-[10px] border border-dashed border-border-default bg-surface-quiet px-6 py-12 text-center">
              <p className="text-sm text-text-muted">
                No research group is currently available.
              </p>
            </div>
          ) : (
            <>
              {occurrencesError && (
                <div
                  role="alert"
                  className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[10px] border border-border-subtle bg-warning-bg px-4 py-3"
                >
                  <span className="flex min-w-0 items-center gap-2 text-sm text-text">
                    <span
                      aria-hidden="true"
                      className="material-symbols-outlined shrink-0 text-[18px] text-warning"
                    >
                      error_outline
                    </span>
                    <span className="min-w-0">
                      Some recurring meetings
                      couldn't be loaded:
                    </span>
                    <span className="min-w-0 truncate text-text-muted">
                      {occurrencesError}
                    </span>
                  </span>

                  <button
                    type="button"
                    onClick={() =>
                      void loadOccurrences()
                    }
                    className="ml-auto inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border-subtle bg-surface px-3 text-xs font-semibold text-text transition hover:bg-surface-hover"
                  >
                    <span
                      aria-hidden="true"
                      className="material-symbols-outlined text-[16px]"
                    >
                      refresh
                    </span>
                    Retry
                  </button>
                </div>
              )}

              <UpcomingMeetingsList
                groups={upcomingGroups ?? []}
                loading={listLoading}
                recurrenceLoading={recurrencePending}
                onNewMeeting={openCreateDialog}
                onOpenMeeting={(meetingId) =>
                  navigate(`/meetings/${meetingId}`)
                }
              />
            </>
          ))}

        {activeTab === 'series' && (
          <ComingSoonPanel
            icon="repeat"
            title="Series overview is coming soon"
            description="Recurring series you create will appear here, with their rule and upcoming occurrences."
          />
        )}

        {activeTab === 'past' && (
          <ComingSoonPanel
            icon="history"
            title="Past view is coming soon"
            description="Completed meetings will appear here so you can review what happened."
          />
        )}
      </div>

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
        onCreateSeries={(input) =>
          void handleCreateSeries(input)
        }
      />

      {seriesToastVisible && <SeriesCreatedToast />}
    </div>
  )
}
