import {
  useEffect,
  useMemo,
  useState,
} from 'react'
import type {
  FormEvent,
  RefObject,
} from 'react'

import { ApiError } from '../../api/client'
import {
  getMeetingItemFollowUpTargets,
  scheduleMeetingItemFollowUp,
} from '../../api/meetings'
import type {
  ApiMeetingItem,
  ApiMeetingItemFollowUpTargets,
} from '../../api/types'
import { formatMeetingDateCompact } from './shared'

type MeetingFollowUpSchedulingDialogProps = {
  sourceItem: ApiMeetingItem | null
  returnFocusRef: RefObject<HTMLButtonElement | null>
  onClose: () => void
  onScheduled: () => Promise<void>
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
    const detail = error.detail as { error?: unknown }
    if (typeof detail.error === 'string') {
      return detail.error
    }
  }

  if (error instanceof Error && error.message) {
    return error.message
  }

  return fallback
}

export function MeetingFollowUpSchedulingDialog({
  sourceItem,
  returnFocusRef,
  onClose,
  onScheduled,
}: MeetingFollowUpSchedulingDialogProps) {
  const [targets, setTargets] =
    useState<ApiMeetingItemFollowUpTargets | null>(null)
  const [meetingId, setMeetingId] = useState('')
  const [sectionId, setSectionId] = useState('')
  const [loading, setLoading] = useState(false)
  const [scheduling, setScheduling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (sourceItem == null) return

    let cancelled = false
    setTargets(null)
    setMeetingId('')
    setSectionId('')
    setError(null)
    setLoading(true)

    getMeetingItemFollowUpTargets(sourceItem.id)
      .then((nextTargets) => {
        if (cancelled) return

        setTargets(nextTargets)
        const recommendedMeeting =
          nextTargets.recommendedMeetingId == null
            ? null
            : nextTargets.meetings.find(
                (candidate) =>
                  candidate.id ===
                  nextTargets.recommendedMeetingId,
              ) ?? null

        setMeetingId(
          recommendedMeeting == null
            ? ''
            : String(recommendedMeeting.id),
        )
        setSectionId(
          recommendedMeeting?.recommendedSectionId == null
            ? ''
            : String(recommendedMeeting.recommendedSectionId),
        )
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(
            getErrorMessage(
              loadError,
              'Follow-up destinations could not be loaded.',
            ),
          )
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [sourceItem])

  useEffect(() => {
    if (sourceItem == null || scheduling) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
        queueMicrotask(() => returnFocusRef.current?.focus())
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, returnFocusRef, scheduling, sourceItem])

  const selectedMeeting = useMemo(
    () =>
      targets?.meetings.find(
        (candidate) => String(candidate.id) === meetingId,
      ) ?? null,
    [meetingId, targets],
  )

  const selectedSectionBelongsToMeeting =
    selectedMeeting?.sections.some(
      (section) => String(section.id) === sectionId,
    ) ?? false

  const canSchedule =
    !loading &&
    !scheduling &&
    targets != null &&
    selectedMeeting != null &&
    selectedSectionBelongsToMeeting

  const close = () => {
    if (scheduling) return
    onClose()
    queueMicrotask(() => returnFocusRef.current?.focus())
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!canSchedule || sourceItem == null) return

    setScheduling(true)
    setError(null)
    try {
      await scheduleMeetingItemFollowUp(sourceItem.id, {
        targetMeetingId: Number(meetingId),
        targetMeetingSectionId: Number(sectionId),
      })
      await onScheduled()
      onClose()
      queueMicrotask(() => returnFocusRef.current?.focus())
    } catch (scheduleError) {
      setError(
        getErrorMessage(
          scheduleError,
          'Follow-up could not be scheduled.',
        ),
      )
    } finally {
      setScheduling(false)
    }
  }

  if (sourceItem == null) return null

  const hasNoMeetings =
    !loading && targets != null && targets.meetings.length === 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-on-surface/25 px-4 py-8 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedule-follow-up-title"
        aria-describedby="schedule-follow-up-prompt"
        className="w-full max-w-md overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-lowest shadow-xl"
      >
        <form onSubmit={(event) => void submit(event)}>
          <div className="border-b border-outline-variant px-6 py-5">
            <h2
              id="schedule-follow-up-title"
              className="text-lg font-semibold tracking-tight text-on-surface"
            >
              Schedule follow-up
            </h2>
            <p
              id="schedule-follow-up-prompt"
              className="mt-1 text-sm text-on-surface-variant"
            >
              When should this come back?
            </p>
          </div>

          <div className="space-y-4 px-6 py-5">
            {loading ? (
              <p
                role="status"
                className="flex items-center gap-2 text-sm text-on-surface-variant"
              >
                <span
                  aria-hidden="true"
                  className="material-symbols-outlined animate-spin text-[18px]"
                >
                  refresh
                </span>
                Loading planned meetings…
              </p>
            ) : hasNoMeetings ? (
              <div className="rounded-lg bg-surface-container-low px-4 py-3">
                <p className="text-sm font-medium text-on-surface">
                  No planned meetings available.
                </p>
                <p className="mt-1 text-xs text-on-surface-variant">
                  Create or schedule a future meeting first.
                </p>
              </div>
            ) : (
              <>
                <div>
                  <label
                    htmlFor="follow-up-meeting"
                    className="mb-1.5 block text-sm font-medium text-on-surface"
                  >
                    Meeting
                  </label>
                  <select
                    id="follow-up-meeting"
                    autoFocus
                    value={meetingId}
                    onChange={(event) => {
                      const nextMeetingId = event.target.value
                      const nextMeeting = targets?.meetings.find(
                        (candidate) =>
                          String(candidate.id) === nextMeetingId,
                      )
                      setMeetingId(nextMeetingId)
                      setSectionId(
                        nextMeeting?.recommendedSectionId == null
                          ? ''
                          : String(nextMeeting.recommendedSectionId),
                      )
                      setError(null)
                    }}
                    className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
                  >
                    <option value="">Select a meeting</option>
                    {targets?.meetings.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.title} · {formatMeetingDateCompact(candidate.scheduledAt)}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="follow-up-section"
                    className="mb-1.5 block text-sm font-medium text-on-surface"
                  >
                    Section
                  </label>
                  <select
                    id="follow-up-section"
                    value={sectionId}
                    disabled={selectedMeeting == null}
                    onChange={(event) => {
                      setSectionId(event.target.value)
                      setError(null)
                    }}
                    className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    <option value="">Select a section</option>
                    {selectedMeeting?.sections.map((section) => (
                      <option key={section.id} value={section.id}>
                        {section.name}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}

            {error != null && (
              <p
                role="alert"
                className="rounded-lg bg-error-container px-3 py-2 text-sm text-error"
              >
                {error}
              </p>
            )}
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-outline-variant bg-surface-container-low/45 px-6 py-4">
            <button
              type="button"
              disabled={scheduling}
              onClick={close}
              className="h-9 rounded-lg px-4 text-sm font-medium text-on-surface-variant outline-none transition hover:bg-surface-container-high hover:text-on-surface focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSchedule}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white shadow-sm outline-none transition hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {scheduling && (
                <span
                  aria-hidden="true"
                  className="material-symbols-outlined animate-spin text-[18px]"
                >
                  refresh
                </span>
              )}
              {scheduling ? 'Scheduling…' : 'Schedule'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
