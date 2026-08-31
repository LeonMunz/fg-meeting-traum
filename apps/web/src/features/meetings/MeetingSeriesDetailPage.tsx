import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from 'react'
import {
  useNavigate,
  useParams,
} from 'react-router'

import { ApiError } from '../../api/client'
import {
  createMeetingFromSeries,
  createMeetingSeriesSection,
  getMeetingSeries,
  listMeetingSeriesSections,
  reorderMeetingSeriesSections,
  updateMeetingSeriesSection,
} from '../../api/meetings'
import type {
  ApiMeetingSeries,
  ApiMeetingSeriesSection,
} from '../../api/types'
import { useSyncResearchGroupContext } from '../research-group/useSyncResearchGroupContext'

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

export function MeetingSeriesDetailPage() {
  const navigate = useNavigate()
  const { seriesId: seriesIdParam } = useParams()

  const parsedSeriesId = Number(seriesIdParam)
  const seriesId =
    Number.isInteger(parsedSeriesId) &&
    parsedSeriesId > 0
      ? parsedSeriesId
      : null

  const [series, setSeries] =
    useState<ApiMeetingSeries | null>(null)

  useSyncResearchGroupContext(
    series?.researchGroupId,
  )

  const [sections, setSections] =
    useState<ApiMeetingSeriesSection[]>([])

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] =
    useState<string | null>(null)

  const [actionError, setActionError] =
    useState<string | null>(null)

  // Section form
  const [sectionName, setSectionName] =
    useState('')
  const [sectionDescription, setSectionDescription] =
    useState('')
  const [creatingSection, setCreatingSection] =
    useState(false)

  // Occurrence form
  const [occurrenceTitle, setOccurrenceTitle] =
    useState('')
  const [occurrenceDate, setOccurrenceDate] =
    useState('')
  const [creatingOccurrence, setCreatingOccurrence] =
    useState(false)

  // Editing
  const [editingSectionId, setEditingSectionId] =
    useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] =
    useState('')
  const [savingSection, setSavingSection] =
    useState(false)

  // Drag reorder state
  const [draggingId, setDraggingId] =
    useState<number | null>(null)

  const loadSeries = useCallback(async () => {
    if (seriesId == null) {
      setSeries(null)
      setSections([])
      setLoadError('Invalid series ID.')
      setLoading(false)
      return
    }

    setLoading(true)
    setLoadError(null)
    setActionError(null)

    try {
      const [fetchedSeries, nextSections] = await Promise.all([
        getMeetingSeries(seriesId),
        listMeetingSeriesSections(seriesId),
      ])

      setSeries(fetchedSeries)
      setSections(nextSections)
    } catch (error) {
      setSeries(null)
      setSections([])
      setLoadError(
        getErrorMessage(
          error,
          'Series could not be loaded.',
        ),
      )
    } finally {
      setLoading(false)
    }
  }, [seriesId])

  useEffect(() => {
    void loadSeries()
  }, [loadSeries])

  const handleCreateSection = async (
    event: FormEvent,
  ) => {
    event.preventDefault()

    if (
      seriesId == null ||
      !sectionName.trim() ||
      creatingSection
    ) {
      return
    }

    setCreatingSection(true)
    setActionError(null)

    try {
      const newSection =
        await createMeetingSeriesSection(
          seriesId,
          {
            name: sectionName.trim(),
            description:
              sectionDescription.trim(),
          },
        )

      setSections((current) => [
        ...current,
        newSection,
      ])

      setSectionName('')
      setSectionDescription('')
    } catch (error) {
      setActionError(
        getErrorMessage(
          error,
          'Section could not be created.',
        ),
      )
    } finally {
      setCreatingSection(false)
    }
  }

  const handleToggleSectionActive = async (
    section: ApiMeetingSeriesSection,
  ) => {
    setActionError(null)

    try {
      const updated =
        await updateMeetingSeriesSection(
          section.id,
          {
            isActive: !section.isActive,
          },
        )

      setSections((current) =>
        current.map((s) =>
          s.id === updated.id ? updated : s,
        ),
      )
    } catch (error) {
      setActionError(
        getErrorMessage(
          error,
          'Section could not be updated.',
        ),
      )
    }
  }

  const handleStartEdit = (
    section: ApiMeetingSeriesSection,
  ) => {
    setEditingSectionId(section.id)
    setEditName(section.name)
    setEditDescription(section.description)
  }

  const handleSaveEdit = async () => {
    if (
      editingSectionId == null ||
      !editName.trim() ||
      savingSection
    ) {
      return
    }

    setSavingSection(true)
    setActionError(null)

    try {
      const updated =
        await updateMeetingSeriesSection(
          editingSectionId,
          {
            name: editName.trim(),
            description:
              editDescription.trim(),
          },
        )

      setSections((current) =>
        current.map((s) =>
          s.id === updated.id ? updated : s,
        ),
      )

      setEditingSectionId(null)
      setEditName('')
      setEditDescription('')
    } catch (error) {
      setActionError(
        getErrorMessage(
          error,
          'Section could not be updated.',
        ),
      )
    } finally {
      setSavingSection(false)
    }
  }

  const handleCreateOccurrence = async (
    event: FormEvent,
  ) => {
    event.preventDefault()

    if (
      seriesId == null ||
      creatingOccurrence
    ) {
      return
    }

    setCreatingOccurrence(true)
    setActionError(null)

    try {
      const payload: {
        title?: string
        scheduledAt?: string
      } = {}

      if (occurrenceTitle.trim()) {
        payload.title =
          occurrenceTitle.trim()
      }

      if (occurrenceDate) {
        payload.scheduledAt =
          occurrenceDate
      }

      const meeting =
        await createMeetingFromSeries(
          seriesId,
          payload,
        )

      // Navigate to the new meeting.
      navigate(
        `/meetings/${meeting.id}`,
      )
    } catch (error) {
      setActionError(
        getErrorMessage(
          error,
          'Occurrence could not be created.',
        ),
      )
    } finally {
      setCreatingOccurrence(false)
    }
  }

  const handleDragStart = (
    sectionId: number,
  ) => {
    setDraggingId(sectionId)
  }

  const handleDragOver = (
    event: React.DragEvent,
    targetId: number,
  ) => {
    event.preventDefault()

    if (draggingId == null || draggingId === targetId) {
      return
    }

    const newSections = [...sections]
    const dragIndex = newSections.findIndex(
      (s) => s.id === draggingId,
    )
    const targetIndex = newSections.findIndex(
      (s) => s.id === targetId,
    )

    if (
      dragIndex === -1 ||
      targetIndex === -1
    ) {
      return
    }

    const [dragged] =
      newSections.splice(dragIndex, 1)
    newSections.splice(targetIndex, 0, dragged)

    setSections(newSections)

    // Persist the new order.
    void reorderMeetingSeriesSections(
      seriesId!,
      {
        sectionIds: newSections.map(
          (s) => s.id,
        ),
      },
    ).then((updated) => {
      setSections(updated)
    }).catch((err) => {
      setActionError(
        getErrorMessage(
          err,
          'Order could not be saved.',
        ),
      )
      // Reload to restore correct order.
      void loadSeries()
    })
  }

  const handleDragEnd = () => {
    setDraggingId(null)
  }

  if (loading) {
    return (
      <div className="w-full px-6 py-8 lg:px-8 lg:py-10 xl:px-10">
        <div className="flex min-h-72 items-center justify-center rounded-xl border border-outline-variant bg-surface-container-lowest">
          <span className="material-symbols-outlined mr-2 animate-spin text-[20px] text-on-surface-variant">
            refresh
          </span>

          <span className="text-sm text-on-surface-variant">
            Loading series…
          </span>
        </div>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="w-full px-6 py-8 lg:px-8 lg:py-10 xl:px-10">
        <button
          type="button"
          onClick={() =>
            navigate('/meetings/series')
          }
          className="inline-flex items-center gap-2 text-sm font-medium text-on-surface-variant hover:text-primary"
        >
          <span className="material-symbols-outlined text-[18px]">
            arrow_back
          </span>
          Meeting Series
        </button>

        <div
          role="alert"
          className="mt-6 flex min-h-64 flex-col items-center justify-center rounded-xl border border-outline-variant bg-surface-container-lowest px-6 py-10 text-center"
        >
          <span className="material-symbols-outlined text-[28px] text-error">
            error
          </span>

          <h1 className="mt-3 text-lg font-semibold text-on-surface">
            Series unavailable
          </h1>

          <p className="mt-1 text-sm text-on-surface-variant">
            {loadError}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full px-6 py-8 lg:px-8 lg:py-10 xl:px-10">
      <button
        type="button"
        onClick={() =>
          navigate('/meetings/series')
        }
        className="inline-flex items-center gap-2 text-sm font-medium text-on-surface-variant transition hover:text-primary"
      >
        <span className="material-symbols-outlined text-[18px]">
          arrow_back
        </span>
        Meeting Series
      </button>

      <header className="mt-5 border-b border-outline-variant pb-6">
        <h1 className="text-3xl font-semibold tracking-tight text-on-surface">
          Series Structure
        </h1>

        <p className="mt-1.5 text-sm text-on-surface-variant">
          Edit the default sections for this meeting series.
          New occurrences will snapshot these sections.
        </p>
      </header>

      {actionError && (
        <div
          role="alert"
          className="mt-5 rounded-lg bg-error-container px-4 py-3 text-sm text-error"
        >
          {actionError}
        </div>
      )}

      <div className="mt-8 grid gap-8 xl:grid-cols-[minmax(0,1fr)_360px]">
        {/* Sections */}
        <section>
          <div className="flex items-end justify-between gap-6">
            <div>
              <h2 className="text-lg font-semibold text-on-surface">
                Sections
              </h2>

              <p className="mt-1 text-sm text-on-surface-variant">
                Drag to reorder. Only active sections are
                snapshotted into new occurrences.
              </p>
            </div>

            <div className="text-sm text-on-surface-variant">
              {sections.length}{' '}
              {sections.length === 1
                ? 'section'
                : 'sections'}
            </div>
          </div>

          {/* Add section form */}
          <form
            onSubmit={handleCreateSection}
            className="mt-5 rounded-xl border border-outline-variant bg-surface-container-lowest p-5"
          >
            <div className="grid gap-4">
              <label>
                <span className="mb-1.5 block text-sm font-medium text-on-surface">
                  Section name
                </span>

                <input
                  type="text"
                  value={sectionName}
                  onChange={(event) =>
                    setSectionName(
                      event.target.value,
                    )
                  }
                  placeholder="e.g. Check-In"
                  className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
                />
              </label>

              <label>
                <span className="mb-1.5 block text-sm font-medium text-on-surface">
                  Description
                </span>

                <input
                  type="text"
                  value={sectionDescription}
                  onChange={(event) =>
                    setSectionDescription(
                      event.target.value,
                    )
                  }
                  placeholder="Optional"
                  className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
                />
              </label>
            </div>

            <div className="mt-4 flex justify-end">
              <button
                type="submit"
                disabled={
                  creatingSection ||
                  !sectionName.trim()
                }
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <span className="material-symbols-outlined text-[18px]">
                  add
                </span>

                {creatingSection
                  ? 'Adding…'
                  : 'Add section'}
              </button>
            </div>
          </form>

          {/* Section list */}
          {sections.length === 0 ? (
            <div className="mt-5 rounded-xl border border-dashed border-outline-variant bg-surface-container-lowest px-6 py-12 text-center">
              <span className="material-symbols-outlined text-[28px] text-on-surface-variant">
                view_kanban
              </span>

              <p className="mt-3 text-sm font-medium text-on-surface">
                No sections yet
              </p>

              <p className="mt-1 text-sm text-on-surface-variant">
                Add the first section above.
              </p>
            </div>
          ) : (
            <div className="mt-5 space-y-2">
              {sections.map((section) => (
                <div
                  key={section.id}
                  draggable
                  onDragStart={() =>
                    handleDragStart(section.id)
                  }
                  onDragOver={(event) =>
                    handleDragOver(
                      event,
                      section.id,
                    )
                  }
                  onDragEnd={handleDragEnd}
                  className={[
                    'rounded-xl border p-4 transition',
                    draggingId === section.id
                      ? 'border-primary/40 bg-primary/5'
                      : 'border-outline-variant bg-surface-container-lowest',
                    !section.isActive
                      ? 'opacity-60'
                      : '',
                  ].join(' ')}
                >
                  {editingSectionId ===
                  section.id ? (
                    /* Editing mode */
                    <div>
                      <div className="grid gap-3">
                        <label>
                          <span className="mb-1 block text-xs font-medium text-on-surface-variant">
                            Name
                          </span>

                          <input
                            type="text"
                            value={editName}
                            onChange={(
                              event,
                            ) =>
                              setEditName(
                                event.target
                                  .value,
                              )
                            }
                            className="h-9 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus:border-primary"
                          />
                        </label>

                        <label>
                          <span className="mb-1 block text-xs font-medium text-on-surface-variant">
                            Description
                          </span>

                          <input
                            type="text"
                            value={
                              editDescription
                            }
                            onChange={(
                              event,
                            ) =>
                              setEditDescription(
                                event.target
                                  .value,
                              )
                            }
                            className="h-9 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus:border-primary"
                          />
                        </label>
                      </div>

                      <div className="mt-3 flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            setEditingSectionId(
                              null,
                            )
                          }
                          className="h-8 rounded-lg border border-outline-variant px-3 text-xs font-semibold text-on-surface transition hover:bg-surface-container-low"
                        >
                          Cancel
                        </button>

                        <button
                          type="button"
                          disabled={
                            savingSection ||
                            !editName.trim()
                          }
                          onClick={() =>
                            void handleSaveEdit()
                          }
                          className="h-8 rounded-lg bg-primary px-3 text-xs font-semibold text-white transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
                        >
                          {savingSection
                            ? 'Saving…'
                            : 'Save'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* View mode */
                    <div className="flex items-center gap-3">
                      <span className="material-symbols-outlined text-[18px] text-on-surface-variant cursor-grab">
                        drag_indicator
                      </span>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-on-surface-variant">
                            #{section.position + 1}
                          </span>

                          <span className="text-sm font-semibold text-on-surface">
                            {section.name}
                          </span>

                          {!section.isActive && (
                            <span className="inline-flex rounded-full bg-surface-container-high px-2 py-0.5 text-[10px] font-medium text-on-surface-variant">
                              Inactive
                            </span>
                          )}
                        </div>

                        {section.description && (
                          <p className="mt-0.5 text-xs text-on-surface-variant">
                            {section.description}
                          </p>
                        )}
                      </div>

                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() =>
                            handleStartEdit(
                              section,
                            )
                          }
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-on-surface-variant transition hover:bg-surface-container-low"
                        >
                          <span className="material-symbols-outlined text-[18px]">
                            edit
                          </span>
                        </button>

                        <button
                          type="button"
                          onClick={() =>
                            void handleToggleSectionActive(
                              section,
                            )
                          }
                          className={[
                            'flex h-8 w-8 items-center justify-center rounded-lg transition',
                            section.isActive
                              ? 'text-on-surface-variant hover:bg-surface-container-low'
                              : 'text-primary hover:bg-primary/10',
                          ].join(' ')}
                        >
                          <span className="material-symbols-outlined text-[18px]">
                            {section.isActive
                              ? 'visibility'
                              : 'visibility_off'}
                          </span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Sidebar: Create occurrence */}
        <aside>
          <div className="rounded-xl border border-outline-variant bg-surface-container-lowest">
            <div className="border-b border-outline-variant px-5 py-4">
              <h2 className="text-base font-semibold text-on-surface">
                New Occurrence
              </h2>

              <p className="mt-1 text-xs text-on-surface-variant">
                Create a meeting from this series. Active
                sections will be snapshotted.
              </p>
            </div>

            <form
              onSubmit={handleCreateOccurrence}
              className="p-5"
            >
              <div className="grid gap-4">
                <label>
                  <span className="mb-1.5 block text-sm font-medium text-on-surface">
                    Title
                  </span>

                  <input
                    type="text"
                    value={occurrenceTitle}
                    onChange={(event) =>
                      setOccurrenceTitle(
                        event.target.value,
                      )
                    }
                    placeholder="Uses series name"
                    className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
                  />
                </label>

                <label>
                  <span className="mb-1.5 block text-sm font-medium text-on-surface">
                    Date & Time
                  </span>

                  <input
                    type="datetime-local"
                    value={occurrenceDate}
                    onChange={(event) =>
                      setOccurrenceDate(
                        event.target.value,
                      )
                    }
                    className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
                  />
                </label>
              </div>

              <div className="mt-4">
                <button
                  type="submit"
                  disabled={creatingOccurrence}
                  className="w-full inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <span className="material-symbols-outlined text-[18px]">
                    event
                  </span>

                  {creatingOccurrence
                    ? 'Creating…'
                    : 'Create meeting'}
                </button>
              </div>
            </form>
          </div>

          {/* Active sections preview */}
          <div className="mt-5 rounded-xl border border-outline-variant bg-surface-container-lowest">
            <div className="border-b border-outline-variant px-5 py-4">
              <h2 className="text-base font-semibold text-on-surface">
                Snapshot Preview
              </h2>

              <p className="mt-1 text-xs text-on-surface-variant">
                Active sections that will be copied into
                new occurrences.
              </p>
            </div>

            <div className="p-5">
              {sections.filter((s) => s.isActive)
                .length === 0 ? (
                <p className="text-sm text-on-surface-variant">
                  No active sections.
                </p>
              ) : (
                <ol className="list-decimal space-y-1 pl-4 text-sm text-on-surface">
                  {sections
                    .filter((s) => s.isActive)
                    .map((s) => (
                      <li key={s.id}>
                        {s.name}
                      </li>
                    ))}
                </ol>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
