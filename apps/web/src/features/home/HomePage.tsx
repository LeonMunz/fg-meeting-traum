import {
  useCallback,
  useEffect,
  useState,
} from 'react'
import { useNavigate } from 'react-router'

import { ApiError } from '../../api/client'
import { listActivityFeed } from '../../api/activity'
import { getHome } from '../../api/home'
import type {
  ApiActivityEvent,
  ApiHome,
} from '../../api/types'

import { ActivityRail } from './ActivityRail'
import {
  ContinueWorkingSection,
  HomeSection,
  MyWorkSection,
  NeedsAttentionSection,
  SectionLoading,
  TimelineSection,
} from './homeSections'

const ACTIVITY_RAIL_LIMIT = 20

function getErrorMessage(
  error: unknown,
  fallback: string,
): string {
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
 * Home — the authenticated personal re-entry surface at `/`.
 *
 * Two independent requests:
 * - `GET /api/home/` — the four Home sections (main column)
 * - `GET /api/activity/` — the Activity rail (fetched and rendered
 *   independently; its failure never erases Home, and vice versa)
 */
export function HomePage() {
  const navigate = useNavigate()

  const [home, setHome] = useState<ApiHome | null>(null)
  const [homeLoading, setHomeLoading] = useState(true)
  const [homeError, setHomeError] = useState<
    string | null
  >(null)

  const [activity, setActivity] = useState<
    ApiActivityEvent[]
  >([])
  const [activityLoading, setActivityLoading] =
    useState(true)
  const [
    activityError,
    setActivityError,
  ] = useState<string | null>(null)

  const loadHome = useCallback(async () => {
    setHomeLoading(true)
    setHomeError(null)

    try {
      setHome(await getHome())
    } catch (error) {
      setHome(null)
      setHomeError(
        getErrorMessage(
          error,
          'Home could not be loaded.',
        ),
      )
    } finally {
      setHomeLoading(false)
    }
  }, [])

  const loadActivity = useCallback(async () => {
    setActivityLoading(true)
    setActivityError(null)

    try {
      setActivity(
        await listActivityFeed(ACTIVITY_RAIL_LIMIT),
      )
    } catch (error) {
      setActivity([])
      setActivityError(
        getErrorMessage(
          error,
          'Activity could not be loaded.',
        ),
      )
    } finally {
      setActivityLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadHome()
  }, [loadHome])

  useEffect(() => {
    void loadActivity()
  }, [loadActivity])

  // Canonical navigation: Work Item rows open the Project's Work
  // Items surface; Meeting rows open the Meeting detail route.
  const openWorkItemProject = (projectId: number) => {
    navigate(`/projects/${projectId}/work-items`)
  }

  const openMeeting = (meetingId: number) => {
    navigate(`/meetings/${meetingId}`)
  }

  return (
    <div className="w-full px-6 py-8 lg:px-8 lg:py-10 xl:px-10">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight text-text">
          Home
        </h1>

        <p className="mt-1.5 text-sm leading-6 text-text-muted">
          What needs your attention, what's coming up, and where
          you left off.
        </p>
      </header>

      <div className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start">
        {/* Main Home content — dominant width */}
        <div className="min-w-0 space-y-6">
          {homeLoading ? (
            <>
              <HomeSection
                id="home-needs-attention"
                title="Needs attention"
                description="Assigned work that is overdue or blocked."
              >
                <SectionLoading />
              </HomeSection>

              <HomeSection
                id="home-today-next"
                title="Today & next"
                description="Work and meetings scheduled for the coming days."
              >
                <SectionLoading />
              </HomeSection>

              <HomeSection
                id="home-my-work"
                title="My work"
                description="Your active assigned work items."
              >
                <SectionLoading />
              </HomeSection>

              <HomeSection
                id="home-continue-working"
                title="Continue working"
                description="Where you last made changes, based on your recent edits."
              >
                <SectionLoading />
              </HomeSection>
            </>
          ) : homeError ? (
            <div
              role="alert"
              className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-border-subtle bg-surface-quiet px-6 py-10 text-center"
            >
              <span className="material-symbols-outlined text-[28px] text-danger">
                cloud_off
              </span>

              <h2 className="mt-3 text-base font-semibold text-text">
                Home couldn't be loaded
              </h2>

              <p className="mt-1 max-w-md text-sm text-text-muted">
                {homeError}
              </p>

              <button
                type="button"
                onClick={() => void loadHome()}
                className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg border border-border-subtle px-4 text-sm font-semibold text-text transition hover:bg-surface-hover"
              >
                <span className="material-symbols-outlined text-[18px]">
                  refresh
                </span>
                Try again
              </button>
            </div>
          ) : home ? (
            <>
              <NeedsAttentionSection
                items={home.needsAttention}
                onOpenWorkItemProject={openWorkItemProject}
              />

              <TimelineSection
                candidates={home.todayAndNext}
                onOpenWorkItemProject={openWorkItemProject}
                onOpenMeeting={openMeeting}
              />

              <MyWorkSection
                items={home.myWork}
                onOpenWorkItemProject={openWorkItemProject}
              />

              <ContinueWorkingSection
                candidates={home.continueWorking}
                onOpenWorkItemProject={openWorkItemProject}
                onOpenMeeting={openMeeting}
              />
            </>
          ) : null}
        </div>

        {/* Activity rail — visually secondary, independent state */}
        <aside
          aria-label="Activity"
          className="min-w-0"
        >
          <ActivityRail
            events={activity}
            loading={activityLoading}
            error={activityError}
            onRetry={() => void loadActivity()}
            onOpenWorkItemProject={openWorkItemProject}
            onOpenMeeting={openMeeting}
          />
        </aside>
      </div>
    </div>
  )
}
