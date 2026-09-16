import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useNavigate } from 'react-router'

import { ApiError } from '../../api/client'
import {
  ACTIVITY_DOMAINS,
  listActivityFeed,
} from '../../api/activity'
import { getHome } from '../../api/home'
import type {
  ActivityDomain,
  ApiActivityEvent,
  ApiHome,
} from '../../api/types'

import { ActivityRail } from './ActivityRail'
import {
  ContinueWorkingSection,
  HomeSection,
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
 * - `GET /api/home/` — the Home primary column (Needs attention,
 *   Today & next, Continue working). The API's `myWork` section is
 *   intentionally NOT displayed on Home; the full My Work list
 *   lives in its own application area.
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

  // Activity domain filter — local to this Home session (no
  // persistence). All four selected is the canonical unfiltered
  // feed; only a strict subset goes on the wire.
  const [activityDomains, setActivityDomains] = useState<
    ActivityDomain[]
  >([...ACTIVITY_DOMAINS])

  // Monotonic guard for the Activity request: a filter change may
  // refetch while an earlier request is still in flight, and only
  // the newest request may settle the rail state (an out-of-order
  // stale response must never overwrite a newer filter's results).
  const activityRequestSeq = useRef(0)

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
    const seq = ++activityRequestSeq.current

    setActivityLoading(true)
    setActivityError(null)

    const isAllDomains =
      activityDomains.length === ACTIVITY_DOMAINS.length

    try {
      const events = await listActivityFeed({
        limit: ACTIVITY_RAIL_LIMIT,
        // The absent parameter is the canonical all-domains
        // state — never sent for the full selection.
        domains: isAllDomains
          ? undefined
          : activityDomains,
      })

      if (seq !== activityRequestSeq.current) {
        return
      }

      setActivity(events)
    } catch (error) {
      if (seq !== activityRequestSeq.current) {
        return
      }

      setActivity([])
      setActivityError(
        getErrorMessage(
          error,
          'Activity could not be loaded.',
        ),
      )
    } finally {
      if (seq === activityRequestSeq.current) {
        setActivityLoading(false)
      }
    }
  }, [activityDomains])

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
    <div className="mx-auto w-full max-w-[1440px] px-5 py-8 md:px-8 md:py-10">
      <header>
        <h1 className="text-[28px] font-semibold leading-[34px] tracking-tight text-text">
          Home
        </h1>

        <p className="mt-1.5 text-[13px] leading-5 text-text-muted">
          What needs your attention, what's coming up, and where
          you left off.
        </p>
      </header>

      <div className="mt-8 grid gap-y-7 xl:grid-cols-[minmax(0,1fr)_320px] xl:gap-x-8">
        {/* Main Home content — dominant width */}
        <div className="min-w-0 space-y-6">
          {homeLoading ? (
            <>
              <HomeSection
                id="home-needs-attention"
                title="Needs attention"
              >
                <SectionLoading />
              </HomeSection>

              <HomeSection
                id="home-today-next"
                title="Today & next"
              >
                <SectionLoading />
              </HomeSection>

              <HomeSection
                id="home-continue-working"
                title="Continue working"
              >
                <SectionLoading />
              </HomeSection>
            </>
          ) : homeError ? (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 text-sm leading-5 text-text-muted"
            >
              <span className="material-symbols-outlined text-[18px] text-danger">
                cloud_off
              </span>

              <span className="font-medium text-text">
                Home couldn't be loaded
              </span>

              <span className="min-w-0 break-words">
                {homeError}
              </span>

              <button
                type="button"
                onClick={() => void loadHome()}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-default px-3 text-[13px] font-semibold text-text transition hover:bg-surface-hover"
              >
                <span className="material-symbols-outlined text-[15px]">
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

              <ContinueWorkingSection
                candidates={home.continueWorking}
                onOpenWorkItemProject={openWorkItemProject}
                onOpenMeeting={openMeeting}
              />
            </>
          ) : null}
        </div>

        {/* Activity rail — visually secondary sticky context column, independent state */}
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
            domains={activityDomains}
            onDomainsChange={setActivityDomains}
          />
        </aside>
      </div>
    </div>
  )
}
