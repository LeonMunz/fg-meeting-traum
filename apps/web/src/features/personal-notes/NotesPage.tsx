import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'

import { ApiError } from '../../api/client'
import { listPersonalNotes } from '../../api/personal-notes'
import type { ApiPersonalNote } from '../../api/types'
import { RichMarkdownEditor } from '../../components/editor/RichMarkdownEditor'

/**
 * Read-only Personal Notes workspace (Personal → Notes).
 *
 * The page renders exactly what the canonical owner-scoped listing
 * `GET /api/me/notes/` returns — one request on mount, backend ordering
 * preserved (never re-sorted client-side), no per-note detail requests
 * (the collection representation already IS the full canonical note).
 * Search stays backend-authoritative through
 * `listPersonalNotes(query)`; nothing is filtered client-side.
 *
 * Page-local state only (no global store, no persistence): the search
 * query, the selected note id, and request/error flags. Selection is
 * derived from the rendered result set, never a second copy of a note.
 */

/** Fixed debounce window for the backend note search. */
const NOTES_SEARCH_DEBOUNCE_MS = 300

const UPDATED_DATE = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
})

const UPDATED_DATE_WITH_YEAR = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

/**
 * Quiet "updated" metadata for note rows and the reading surface.
 * Same calendar year → "Sep 29"; older → "Sep 29, 2025". Unparseable
 * values render nothing (no raw ISO strings in the UI).
 */
export function formatNoteUpdatedDate(
  value: string | null,
): string {
  if (!value) {
    return ''
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return ''
  }

  if (date.getFullYear() === new Date().getFullYear()) {
    return UPDATED_DATE.format(date)
  }

  return UPDATED_DATE_WITH_YEAR.format(date)
}

/**
 * Presentation fallback for capture-first notes with an empty title.
 * Display only — never mutates or persists the note.
 */
export function displayNoteTitle(note: ApiPersonalNote): string {
  return note.title.trim() ? note.title : 'Untitled'
}

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

function NotesListSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="flex flex-col gap-2"
    >
      {Array.from({ length: 5 }, (_, index) => (
        <div
          key={index}
          className="animate-pulse rounded-lg px-3 py-2.5"
        >
          <div className="h-3.5 w-3/4 rounded bg-surface-muted" />

          <div className="mt-2 h-2.5 w-1/3 rounded bg-surface-muted/70" />
        </div>
      ))}
    </div>
  )
}

function NoteDetailSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="h-6 w-56 animate-pulse rounded bg-surface-muted" />

      <div className="mt-3 h-3 w-32 animate-pulse rounded bg-surface-muted/70" />

      <div className="mt-8 flex flex-col gap-3">
        <div className="h-4 w-full animate-pulse rounded bg-surface-muted/70" />

        <div className="h-4 w-11/12 animate-pulse rounded bg-surface-muted/70" />

        <div className="h-4 w-4/5 animate-pulse rounded bg-surface-muted/70" />
      </div>
    </div>
  )
}

export function NotesPage() {
  /**
   * The last SUCCESSFUL result set (initial load or search). Null until
   * the first successful response — the page never renders a
   * client-side projection of notes it does not hold from the server.
   */
  const [notes, setNotes] =
    useState<ApiPersonalNote[] | null>(null)

  /**
   * First-load lifecycle: the full error panel only ever replaces an
   * unresolved first load; once a result set has rendered, later
   * failures stay compact, non-fatal search errors.
   */
  const [initialPhase, setInitialPhase] = useState<
    'loading' | 'ready' | 'error'
  >('loading')

  const [initialError, setInitialError] =
    useState<string | null>(null)
  const [searchError, setSearchError] =
    useState<string | null>(null)
  const [searching, setSearching] = useState(false)

  /** Raw search input; the debounced value drives the backend search. */
  const [query, setQuery] = useState('')

  /** Page-local selection — an id into `notes`, never a copy. */
  const [selectedNoteId, setSelectedNoteId] =
    useState<number | null>(null)

  /*
   * Request race safety: every outgoing list/search request claims a
   * monotonically increasing id; only the LATEST claim may write state,
   * so a slow initial load can never clobber a newer search result and
   * a stale search can never clobber a newer one. The mounted flag
   * keeps a response arriving after unmount from touching state.
   * hasRenderedNotesRef tracks (synchronously, across awaits) whether
   * any result set has ever rendered — the split between the page-local
   * initial error and the compact search error.
   */
  const requestIdRef = useRef(0)
  const mountedRef = useRef(true)
  const hasRenderedNotesRef = useRef(false)

  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

  const applyNotes = useCallback(
    (incoming: ApiPersonalNote[]) => {
      hasRenderedNotesRef.current = true
      setNotes(incoming)

      /*
       * Selection contract: keep the current selection when it still
       * exists in the returned set, otherwise select the first result,
       * otherwise nothing (an empty result set clears the selection —
       * no fake selected note).
       */
      setSelectedNoteId((previous) => {
        if (
          previous != null &&
          incoming.some((note) => note.id === previous)
        ) {
          return previous
        }

        return incoming.length > 0
          ? incoming[0].id
          : null
      })
    },
    [],
  )

  const runLoad = useCallback(
    async (searchQuery?: string) => {
      const requestId = ++requestIdRef.current

      if (searchQuery === undefined) {
        // Active-list request (initial load or Retry): show the
        // skeleton again so the page geometry is preserved, and clear
        // any stale error.
        setInitialPhase('loading')
        setInitialError(null)
        setSearchError(null)
      } else {
        // Search: the last successful result set stays visible while
        // the request is in flight.
        setSearching(true)
        setSearchError(null)
      }

      try {
        const result = await listPersonalNotes(searchQuery)

        if (
          requestId !== requestIdRef.current ||
          !mountedRef.current
        ) {
          return
        }

        setInitialPhase('ready')
        setSearching(false)
        applyNotes(result)
      } catch (error) {
        if (
          requestId !== requestIdRef.current ||
          !mountedRef.current
        ) {
          return
        }

        setSearching(false)

        const message = getErrorMessage(
          error,
          'Something went wrong.',
        )

        if (hasRenderedNotesRef.current) {
          // A result set is already on screen: compact, non-fatal
          // search error; the last successful set is preserved.
          setSearchError(message)
        } else {
          // Nothing has ever rendered: the first load failed —
          // page-local error with Retry.
          setInitialPhase('error')
          setInitialError(message)
        }
      }
    },
    [applyNotes],
  )

  // Exactly one initial active-list request on mount.
  useEffect(() => {
    void runLoad(undefined)
  }, [runLoad])

  /*
   * Debounced backend search. The first run (empty query at mount) is
   * skipped — the initial load already requested the ordinary active
   * list, so the page issues exactly one request on mount. Clearing the
   * query back to empty re-requests the ordinary active list.
   */
  const skipFirstSearchRun = useRef(true)

  useEffect(() => {
    if (skipFirstSearchRun.current) {
      skipFirstSearchRun.current = false
      return
    }

    const timer = setTimeout(() => {
      void runLoad(query)
    }, NOTES_SEARCH_DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [query, runLoad])

  const selectedNote =
    notes?.find((note) => note.id === selectedNoteId) ?? null

  const hasNotes = notes != null && notes.length > 0
  const hasActiveQuery = query.trim() !== ''

  return (
    <div className="w-full px-6 py-8 lg:px-8">
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold tracking-tight text-text">
            Notes
          </h1>

          <p className="mt-1 text-sm leading-6 text-text-muted">
            Your personal, private notes.
          </p>
        </div>
      </header>

      {initialPhase === 'error' ? (
        <div
          role="alert"
          className="mt-6 flex min-h-64 flex-col items-center justify-center rounded-[10px] border border-border-subtle bg-surface-quiet px-6 py-10 text-center"
        >
          <span className="material-symbols-outlined text-[28px] text-danger">
            cloud_off
          </span>

          <h2 className="mt-3 text-base font-semibold text-text">
            Notes couldn't be loaded
          </h2>

          <p className="mt-1 max-w-md text-sm text-text-muted">
            {initialError}
          </p>

          <button
            type="button"
            onClick={() =>
              void runLoad(query.trim() || undefined)
            }
            className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg border border-border-subtle px-4 text-sm font-semibold text-text transition hover:bg-surface-hover"
          >
            <span
              aria-hidden="true"
              className="material-symbols-outlined text-[18px]"
            >
              refresh
            </span>
            Try again
          </button>
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-6 lg:flex-row lg:items-start">
          {initialPhase === 'loading' && (
            <p role="status" className="sr-only">
              Loading notes…
            </p>
          )}

          {/* Notes rail: search + list, secondary to the reading
              surface (fixed width on desktop, stacked below). */}
          <section
            aria-label="Notes list"
            className="w-full shrink-0 lg:w-80 lg:border-r lg:border-border-subtle lg:pr-5"
          >
            <label className="relative block">
              <span
                aria-hidden="true"
                className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-text-muted"
              >
                search
              </span>

              <input
                aria-label="Search notes"
                type="search"
                value={query}
                onChange={(event) =>
                  setQuery(event.target.value)
                }
                placeholder="Search notes..."
                className="h-10 w-full rounded-lg border border-border-field bg-surface pl-10 pr-4 text-sm text-text outline-none transition placeholder:text-text-muted/70 focus:border-focus focus:ring-2 focus:ring-focus/15"
              />
            </label>

            {searchError && (
              <div
                role="alert"
                className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[10px] border border-border-subtle bg-warning-bg px-4 py-3"
              >
                <span className="flex min-w-0 items-center gap-2 text-sm text-text">
                  <span
                    aria-hidden="true"
                    className="material-symbols-outlined shrink-0 text-[18px] text-warning"
                  >
                    error_outline
                  </span>

                  <span className="min-w-0">
                    <span className="font-medium">
                      Search failed.
                    </span>{' '}
                    <span className="text-text-muted">
                      {searchError}
                    </span>
                  </span>
                </span>

                <button
                  type="button"
                  onClick={() => void runLoad(query)}
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

            <div
              aria-busy={searching || undefined}
              className="mt-3"
            >
              {initialPhase === 'loading' ? (
                <NotesListSkeleton />
              ) : !hasNotes ? (
                hasActiveQuery ? (
                  <p className="rounded-[10px] border border-dashed border-border-default bg-surface-quiet px-4 py-8 text-center text-sm text-text-muted">
                    No notes match "{query.trim()}".
                  </p>
                ) : (
                  <p className="rounded-[10px] border border-dashed border-border-default bg-surface-quiet px-4 py-8 text-center text-sm text-text-muted">
                    No notes yet.
                  </p>
                )
              ) : (
                <ul className="flex flex-col gap-1">
                  {notes.map((note) => {
                    const selected =
                      note.id === selectedNoteId

                    return (
                      <li key={note.id}>
                        <button
                          type="button"
                          onClick={() =>
                            setSelectedNoteId(note.id)
                          }
                          aria-current={
                            selected ? 'true' : undefined
                          }
                          className={[
                            'w-full rounded-lg px-3 py-2 text-left transition-colors',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
                            selected
                              ? 'bg-surface-muted text-text'
                              : 'text-text hover:bg-surface-muted/50',
                          ].join(' ')}
                        >
                          <span className="block truncate text-sm font-medium">
                            {displayNoteTitle(note)}
                          </span>

                          <span className="mt-0.5 block text-xs text-text-muted">
                            {formatNoteUpdatedDate(
                              note.updatedAt,
                            )}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </section>

          {/* Selected-note reading surface: consumes the remaining
              width (min-w-0 so long lines wrap, never overflow). */}
          <section
            aria-label="Selected note"
            className="min-w-0 flex-1"
          >
            {initialPhase === 'loading' ? (
              <NoteDetailSkeleton />
            ) : selectedNote ? (
              <article>
                <h2 className="text-xl font-semibold tracking-tight text-text">
                  {displayNoteTitle(selectedNote)}
                </h2>

                {formatNoteUpdatedDate(
                  selectedNote.updatedAt,
                ) !== '' && (
                  <p className="mt-1 text-xs text-text-muted">
                    Updated{' '}
                    {formatNoteUpdatedDate(
                      selectedNote.updatedAt,
                    )}
                  </p>
                )}

                <div className="mt-6 min-h-[240px]">
                  {selectedNote.content.trim() ? (
                    <RichMarkdownEditor
                      value={selectedNote.content}
                      readOnly
                      variant="full"
                      className="break-words"
                    />
                  ) : (
                    <p className="text-sm text-text-muted">
                      This note has no content.
                    </p>
                  )}
                </div>
              </article>
            ) : (
              <div className="flex min-h-[240px] items-center justify-center rounded-[10px] border border-dashed border-border-default bg-surface-quiet">
                <p className="text-sm text-text-muted">
                  Select a note to read it.
                </p>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
