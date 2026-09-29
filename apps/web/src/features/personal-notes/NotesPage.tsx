import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'

import { ApiError } from '../../api/client'
import {
  createPersonalNote,
  deletePersonalNote,
  listPersonalNotes,
  updatePersonalNote,
} from '../../api/personal-notes'
import type {
  ApiPersonalNote,
  ApiUpdatePersonalNoteInput,
} from '../../api/types'
import {
  RichMarkdownEditor,
  type RichMarkdownEditorHandle,
} from '../../components/editor/RichMarkdownEditor'

import {
  NoteActionsMenu,
  NoteDeleteDialog,
} from './noteDelete'

/**
 * Personal Notes workspace (Personal → Notes): capture-first note
 * creation plus an editable title/content surface with race-safe
 * autosave.
 *
 * Data model (page-local only — no global store, no persistence):
 *
 * - `notes` is always the last server-acknowledged result set (initial
 *   load or search), reconciled per-note against the locally
 *   acknowledged saves (`lastKnownRef`): a stale list/search response
 *   can never clobber a newer acknowledged save of the same note.
 * - `drafts` holds the explicit local draft (title + content) of the
 *   note currently being written. The title input, the editor, and the
 *   list row render the draft whenever one exists, so server
 *   responses and list refreshes never reset the user's newer
 *   unsaved text. A note without a draft renders its canonical
 *   title/content.
 * - Autosave watches the selected note's draft: while it differs from
 *   the acknowledged representation, a debounced PATCH carries exactly
 *   the changed fields. Per-note monotonically increasing save
 *   generations plus an in-flight duplicate guard make overlapping
 *   PATCHes race-safe: a slower response to an older draft is dropped
 *   and can never overwrite newer local text, a newer acknowledged
 *   response, or another note.
 *
 * Search stays backend-authoritative through
 * `listPersonalNotes(query)`; nothing is filtered client-side.
 * Selection is page-local (an id into the rendered set). The
 * StrictMode-safe list/search lifecycle (request generations, the
 * live ref, the idempotent search effect) is preserved unchanged.
 */

/** Fixed debounce window for the backend note search. */
const NOTES_SEARCH_DEBOUNCE_MS = 300

/**
 * Repository-consistent autosave debounce window (the same 300 ms
 * family as the note search and the My Work preference saves).
 */
const NOTES_AUTOSAVE_DEBOUNCE_MS = 300

/** Backend title contract (docs/domain/personal-notes.md §7). */
const NOTE_TITLE_MAX_LENGTH = 255

/** How long the quiet "Saved" status stays visible before it fades. */
const SAVED_STATUS_FADE_MS = 2000

/**
 * A surface click that moved this far (or more) from its press point
 * was a drag (a text-selection gesture), not a click — it never
 * triggers the editor focus handoff.
 */
const SURFACE_CLICK_DRAG_TOLERANCE_PX = 4

type NoteDraft = {
  title: string
  content: string
}

type NoteSaveStatus =
  | { state: 'saving' }
  | { state: 'saved' }
  | { state: 'error'; message: string }

type SaveStatuses = Record<number, NoteSaveStatus>

/** Whether the currently displayed list is the plain active list or a search. */
type ListMode = 'plain' | 'search'

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
 * Quiet "updated" metadata for note rows and the writing surface.
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

/** True when the note has a local draft that differs from its acknowledged representation. */
function isDraftDirty(
  notes: ApiPersonalNote[] | null,
  drafts: Record<number, NoteDraft>,
  noteId: number,
): boolean {
  if (notes == null) {
    return false
  }

  const note = notes.find((entry) => entry.id === noteId)
  const draft = drafts[noteId]

  if (!note || !draft) {
    return false
  }

  return draft.title !== note.title ||
    draft.content !== note.content
}

function NotesListSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="flex flex-col gap-0.5"
    >
      {Array.from({ length: 5 }, (_, index) => (
        <div
          key={index}
          className="animate-pulse rounded-md px-2.5 py-[5px]"
        >
          <div className="h-3 w-3/4 rounded bg-surface-muted" />

          <div className="mt-1 h-2 w-1/3 rounded bg-surface-muted/70" />
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
   * The last SUCCESSFUL result set (initial load or search),
   * reconciled per-note against acknowledged saves. Null until the
   * first successful response — the page never renders a
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

  /**
   * Explicit local drafts (title + content) of the note(s) currently
   * being written — the only place unsaved text lives. A draft that
   * equals the acknowledged representation is dropped (clean).
   */
  const [drafts, setDrafts] = useState<
    Record<number, NoteDraft>
  >({})

  /** Per-note save feedback; only the selected note's state renders. */
  const [saveStates, setSaveStates] =
    useState<SaveStatuses>({})

  /** Create-in-flight guard (one POST at a time) + its failure message. */
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] =
    useState<string | null>(null)

  /**
   * Permanent-delete confirmation state (page-local): the note
   * whose confirmation dialog is open, the note whose DELETE is in
   * flight (one at a time), and the failure message the dialog
   * shows after a failed delete.
   */
  const [deleteTargetId, setDeleteTargetId] =
    useState<number | null>(null)
  const [deletingNoteId, setDeletingNoteId] =
    useState<number | null>(null)
  const [deleteError, setDeleteError] =
    useState<string | null>(null)

  /*
   * Request race safety: every outgoing list/search request claims a
   * monotonically increasing id; only the LATEST claim may write state,
   * so a slow initial load can never clobber a newer search result and
   * a stale search can never clobber a newer one.
   *
   * liveRef tracks whether a CURRENT Effect instance is alive: it is
   * set on every Effect run (including React StrictMode's development
   * replay, where the first cleanup has already run) and cleared by
   * cleanup. A replayed Effect therefore re-lives the page, while a
   * real unmount leaves the flag dead — so a response to the latest
   * request is dropped only after a real unmount, never after a
   * StrictMode replay.
   *
   * hasRenderedNotesRef tracks (synchronously, across awaits) whether
   * any result set has ever rendered — the split between the page-local
   * initial error and the compact search error. A successful create is
   * also a rendered result set (the POST response is canonical server
   * state), so it flips the flag too.
   */
  const requestIdRef = useRef(0)
  const liveRef = useRef(false)
  const hasRenderedNotesRef = useRef(false)

  /*
   * Autosave machinery (refs — none of this re-renders):
   *
   * - listModeRef: whether the displayed list is the plain active
   *   list or a search result (decides save-driven reordering).
   * - sessionCreatedRef: notes created in this session, keyed by id —
   *   their canonical POST representations are re-inserted when a
   *   stale list response predates them.
   * - lastKnownRef: the newest locally known canonical
   *   representation per note (applied list entries and acknowledged
   *   saves both feed it); stale responses lose to it.
   * - saveTimerRef / saveSeqRef: the pending debounced save and the
   *   monotonically increasing save generation per note.
   * - inFlightRef: the PATCH currently in flight per note (content +
   *   seq) — the duplicate-send guard.
   */
  const listModeRef = useRef<ListMode>('plain')
  const sessionCreatedRef = useRef<
    Map<number, ApiPersonalNote>
  >(new Map())
  const lastKnownRef = useRef<
    Map<number, ApiPersonalNote>
  >(new Map())
  const saveTimerRef = useRef<
    Record<number, ReturnType<typeof setTimeout>>
  >({})
  const saveSeqRef = useRef<Record<number, number>>({})
  const inFlightRef = useRef<
    Record<
      number,
      { seq: number; title: string; content: string }
    >
  >({})

  /*
   * Permanent-delete race guards (consistent with the
   * generation/ref architecture above):
   *
   * - pendingDeleteIdsRef: the note whose DELETE is IN FLIGHT.
   *   While an id is present, no new autosave may be scheduled or
   *   flushed for that note (deletion intent wins over autosave).
   *   The row stays rendered (no optimistic removal) so a FAILED
   *   delete leaves the note and its draft exactly in place.
   * - removedNoteIdsRef: the notes whose delete SUCCEEDED. A
   *   stale list/search response predating the delete must never
   *   resurrect them (applyNotes drops them).
   * - deleteTriggerRefs / rowButtonRefs: each row's overflow
   *   trigger and selection-button elements — focus returns to the
   *   originating trigger on cancel and to the surviving selected
   *   row after a successful delete.
   * - deleteFocusRef: the one-shot focus target after a dialog
   *   closes via a successful delete.
   */
  const pendingDeleteIdsRef = useRef<
    Set<number>
  >(new Set())
  const removedNoteIdsRef = useRef<
    Set<number>
  >(new Set())
  const deleteTriggerRefs = useRef<
    Map<number, HTMLButtonElement>
  >(new Map())
  const rowButtonRefs = useRef<
    Map<number, HTMLButtonElement>
  >(new Map())
  const deleteFocusRef = useRef<
    | { kind: 'row'; noteId: number }
    | { kind: 'trigger'; noteId: number }
    | { kind: 'new-note' }
    | null
  >(null)

  /**
   * Latest render values for the event/cleanup paths (selection
   * flush, list-response flush, unmount flush) — always current,
   * never a stale closure.
   */
  const latestRef = useRef<{
    notes: ApiPersonalNote[] | null
    drafts: Record<number, NoteDraft>
    selectedNoteId: number | null
  }>({ notes: null, drafts: {}, selectedNoteId: null })
  latestRef.current = { notes, drafts, selectedNoteId }

/** The created note whose title input should receive focus. */
  const pendingTitleFocusIdRef = useRef<
    number | null
  >(null)
  const titleInputRef = useRef<HTMLInputElement>(null)

  /** New-note action — the sensible focus target in the empty state. */
  const newNoteButtonRef = useRef<HTMLButtonElement>(null)

  /**
   * Imperative handle into the canonical editor: the writing
   * handoff (Enter in the title, click on free document surface)
   * asks the editor to focus with the caret at the document end —
   * never reaches into its DOM.
   */
  const editorRef = useRef<RichMarkdownEditorHandle>(null)

  /*
   * Free-surface click detection. The handoff fires ONLY when the
   * click target is one of these document-surface containers itself
   * (the pane, the writing column, the article, or the editor
   * surface wrapper). A click originating in ANY descendant — the
   * title input, the editor content, a button, a link, the toolbar,
   * a popover, future property controls — keeps its native behavior.
   * `surfaceMouseDownRef` remembers the press point so a
   * press-drag-release (text selection) can never be mistaken for a
   * surface click.
   */
  const documentColumnRef = useRef<HTMLDivElement>(null)
  const documentArticleRef = useRef<HTMLElement>(null)
  const editorSurfaceRef = useRef<HTMLDivElement>(null)
  const surfaceMouseDownRef = useRef<
    { x: number; y: number } | null
  >(null)

  function handleDocumentSurfaceClick(
    event: ReactMouseEvent<HTMLElement>,
  ) {
    const down = surfaceMouseDownRef.current
    surfaceMouseDownRef.current = null

    // A press that moved is a selection/scroll gesture — never a
    // surface click, even when it lands back on the surface.
    if (
      down != null &&
      (Math.abs(event.clientX - down.x) >
        SURFACE_CLICK_DRAG_TOLERANCE_PX ||
        Math.abs(event.clientY - down.y) >
          SURFACE_CLICK_DRAG_TOLERANCE_PX)
    ) {
      return
    }

    const target = event.target
    const isDocumentSurface =
      target === event.currentTarget ||
      target === documentColumnRef.current ||
      target === documentArticleRef.current ||
      target === editorSurfaceRef.current
    if (!isDocumentSurface) {
      return
    }

    if (selectedNoteId == null) {
      return
    }

    editorRef.current?.focusEnd()
  }

  const performSave = useCallback(
    async (
      noteId: number,
      seq: number,
      draft: NoteDraft,
      changed: { title: boolean; content: boolean },
    ) => {
      // Exactly the changed fields — no pinned/archive/system
      // fields, no no-op churn.
      const payload: ApiUpdatePersonalNoteInput = {}
      if (changed.title) {
        payload.title = draft.title
      }
      if (changed.content) {
        payload.content = draft.content
      }

      inFlightRef.current[noteId] = {
        seq,
        title: draft.title,
        content: draft.content,
      }

      try {
        const updated = await updatePersonalNote(
          noteId,
          payload,
        )

        if (inFlightRef.current[noteId]?.seq === seq) {
          delete inFlightRef.current[noteId]
        }

        if (!liveRef.current) {
          // Unmounted: no state writes, ever.
          return
        }

        if (saveSeqRef.current[noteId] !== seq) {
          // A newer save for THIS note was claimed while this one
          // was in flight. Its response is the acknowledged truth —
          // this response belongs to an older draft and must never
          // overwrite newer local text or a newer acknowledged
          // response.
          return
        }

        // Server-authoritative reconciliation for this note only:
        // acknowledge the returned canonical note…
        lastKnownRef.current.set(noteId, updated)

        setNotes((prev) => {
          if (
            prev == null ||
            !prev.some((note) => note.id === noteId)
          ) {
            // Not part of the current result set (e.g. filtered out
            // by an active search) — never fabricate a row.
            return prev
          }

          let next = prev.map((note) =>
            note.id === noteId ? updated : note,
          )

          // Deliberate list-order handling: a real save bumped
          // `updatedAt`, so in the canonical recency order the note
          // belongs FIRST — applied to the plain active list, where
          // it matches the backend's own ordering. While a search is
          // active the backend result order stays authoritative:
          // the entry is replaced in place (the edited note may no
          // longer match the query, and reordering mid-search would
          // disrupt the search unexpectedly).
          if (listModeRef.current === 'plain') {
            const index = next.findIndex(
              (note) => note.id === noteId,
            )
            if (index > 0) {
              const [entry] = next.splice(index, 1)
              next = [entry, ...next]
            }
          }

          return next
        })

        // …and reconcile the draft: one that now equals the
        // acknowledged note is clean (drop it); a NEWER draft the
        // user typed while this save was in flight is preserved
        // untouched — the autosave effect reschedules whatever
        // remains unsaved.
        setDrafts((prev) => {
          const current = prev[noteId]
          if (!current) {
            return prev
          }

          if (
            current.title === updated.title &&
            current.content === updated.content
          ) {
            const next = { ...prev }
            delete next[noteId]
            return next
          }

          return prev
        })

        setSaveStates((prev) => ({
          ...prev,
          [noteId]: { state: 'saved' },
        }))
      } catch (error) {
        if (inFlightRef.current[noteId]?.seq === seq) {
          delete inFlightRef.current[noteId]
        }

        if (!liveRef.current) {
          return
        }

        if (saveSeqRef.current[noteId] !== seq) {
          // A newer save superseded this failure — its outcome owns
          // the status.
          return
        }

        // The local draft stays intact; the user can retry or keep
        // editing (the next edit reschedules the save).
        setSaveStates((prev) => ({
          ...prev,
          [noteId]: {
            state: 'error',
            message: getErrorMessage(
              error,
              'Something went wrong.',
            ),
          },
        }))
      }
    },
    [],
  )

  /**
   * Send a note's current dirty draft immediately (no debounce).
   * Used when the selection moves away from the note, when a
   * list/search response drops the selected note, on editor/title
   * blur, and as the best-effort final flush on unmount.
   *
   * No-ops when the note has no dirty draft, or when a save carrying
   * exactly this draft is already in flight — the same acknowledged
   * draft is never PATCHed twice.
   */
  const flushNow = useCallback(
    (noteId: number | null, updateStatus = true) => {
      if (noteId == null) {
        return
      }

      // A note under permanent-deletion intent is never written:
      // the user chose destruction, and the DELETE outcome owns
      // this note from this point on (a FAILED delete explicitly
      // re-enables saving in confirmDeleteNote).
      if (pendingDeleteIdsRef.current.has(noteId)) {
        return
      }

      const {
        notes: currentNotes,
        drafts: currentDrafts,
      } = latestRef.current
      if (currentNotes == null) {
        return
      }

      const note = currentNotes.find(
        (entry) => entry.id === noteId,
      )
      const draft = currentDrafts[noteId]
      if (!note || !draft) {
        return
      }

      const changed = {
        title: draft.title !== note.title,
        content: draft.content !== note.content,
      }

      if (!changed.title && !changed.content) {
        // Nothing to save — a lingering status (e.g. an old failure)
        // no longer describes reality, unless a save with this same
        // draft is still in flight (its outcome will set the status).
        if (updateStatus && !inFlightRef.current[noteId]) {
          setSaveStates((prev) => {
            if (!(noteId in prev)) {
              return prev
            }

            const next = { ...prev }
            delete next[noteId]
            return next
          })
        }

        return
      }

      const inFlight = inFlightRef.current[noteId]
      if (
        inFlight &&
        inFlight.title === draft.title &&
        inFlight.content === draft.content
      ) {
        return
      }

      const pending = saveTimerRef.current[noteId]
      if (pending) {
        clearTimeout(pending)
        delete saveTimerRef.current[noteId]
      }

      const seq = (saveSeqRef.current[noteId] ?? 0) + 1
      saveSeqRef.current[noteId] = seq

      if (updateStatus) {
        setSaveStates((prev) =>
          prev[noteId]?.state === 'saving'
            ? prev
            : { ...prev, [noteId]: { state: 'saving' } },
        )
      }

      void performSave(noteId, seq, draft, changed)
    },
    [performSave],
  )

  // The unmount cleanup always has the LATEST flush at hand.
  const flushRef = useRef<() => void>(() => {})
  flushRef.current = () =>
    flushNow(latestRef.current.selectedNoteId, false)

  useEffect(() => {
    liveRef.current = true

    return () => {
      liveRef.current = false

      // Best-effort final flush of the selected note's unsaved
      // draft: fires the network write only — the live ref guard
      // inside performSave keeps the response from writing state
      // after unmount, and nothing below may schedule work.
      flushRef.current()

      for (const key of Object.keys(saveTimerRef.current)) {
        clearTimeout(saveTimerRef.current[Number(key)])
        delete saveTimerRef.current[Number(key)]
      }
    }
  }, [])

  /*
   * Autosave for the selected note: while its draft differs from the
   * acknowledged representation, a debounced PATCH carries exactly
   * the changed fields. The debounce resets on every change, so rapid
   * title+content edits coalesce into one PATCH with the LATEST
   * values. An in-flight save carrying this exact draft suppresses a
   * duplicate. The effect cleanup cancels the pending timer on any
   * input change, so a superseded draft never leaves a stale timer.
   */
  useEffect(() => {
    if (notes == null || selectedNoteId == null) {
      return
    }

    const note = notes.find(
      (entry) => entry.id === selectedNoteId,
    )
    const draft = drafts[selectedNoteId]
    if (!note || !draft) {
      return
    }

    // Deletion intent wins over autosave: no new save may be
    // scheduled for a note whose DELETE is in flight (its pending
    // debounce was cancelled when the deletion was confirmed).
    if (
      pendingDeleteIdsRef.current.has(
        selectedNoteId,
      )
    ) {
      return
    }

    const changed = {
      title: draft.title !== note.title,
      content: draft.content !== note.content,
    }

    if (!changed.title && !changed.content) {
      return
    }

    const inFlight = inFlightRef.current[selectedNoteId]
    if (
      inFlight &&
      inFlight.title === draft.title &&
      inFlight.content === draft.content
    ) {
      return
    }

    const seq = (saveSeqRef.current[selectedNoteId] ?? 0) + 1
    saveSeqRef.current[selectedNoteId] = seq

    setSaveStates((prev) =>
      prev[selectedNoteId]?.state === 'saving'
        ? prev
        : { ...prev, [selectedNoteId]: { state: 'saving' } },
    )

    const timer = setTimeout(() => {
      delete saveTimerRef.current[selectedNoteId]
      void performSave(selectedNoteId, seq, draft, changed)
    }, NOTES_AUTOSAVE_DEBOUNCE_MS)
    saveTimerRef.current[selectedNoteId] = timer

    return () => clearTimeout(timer)
  }, [notes, drafts, selectedNoteId, performSave])

  /*
   * The quiet "Saved" status fades after a short while — it must
   * never dominate the writing surface.
   */
  useEffect(() => {
    const savedIds = Object.keys(saveStates).filter(
      (id) => saveStates[Number(id)].state === 'saved',
    )

    if (savedIds.length === 0) {
      return
    }

    const timer = setTimeout(() => {
      setSaveStates((prev) => {
        const next: SaveStatuses = { ...prev }
        for (const id of savedIds) {
          delete next[Number(id)]
        }
        return next
      })
    }, SAVED_STATUS_FADE_MS)

    return () => clearTimeout(timer)
  }, [saveStates])

  /*
   * Reconcile a server result set into local state:
   *
   * - session-created notes missing from this (stale) response are
   *   re-inserted from their canonical POST representations (newest
   *   created first);
   * - every entry is compared against the locally acknowledged save
   *   for that note (`lastKnownRef`); the NEWER representation wins,
   *   so a stale response can never clobber a newer acknowledged
   *   save of a note currently being edited;
   * - when this response drops the currently selected note while it
   *   still has an unacknowledged draft, that draft is flushed first:
   *   the autosave effect follows the current selection, and without
   *   this the pending debounce would be cancelled together with the
   *   selection and the edit would be lost.
   *
   * Selection contract (unchanged): keep the current selection when
   * it still exists in the returned set, otherwise select the first
   * result, otherwise nothing (an empty result set clears the
   * selection — no fake selected note).
   */
  const applyNotes = useCallback(
    (incoming: ApiPersonalNote[], mode: ListMode) => {
      hasRenderedNotesRef.current = true
      listModeRef.current = mode

      const {
        notes: currentNotes,
        drafts: currentDrafts,
        selectedNoteId: currentSelected,
      } = latestRef.current

      const presentIds = new Set(
        incoming.map((note) => note.id),
      )

      const missingCreated: ApiPersonalNote[] = []
      for (const [id, created] of sessionCreatedRef.current) {
        if (!presentIds.has(id)) {
          missingCreated.push(created)
        }
      }
      // Newest created first (Map iteration is oldest-first).
      missingCreated.reverse()

      const merged: ApiPersonalNote[] = [
        ...missingCreated,
        ...incoming.map((note) => {
          const known = lastKnownRef.current.get(note.id)
          const picked =
            known && known.updatedAt > note.updatedAt
              ? known
              : note
          lastKnownRef.current.set(note.id, picked)
          return picked
        }),
      ]
        // A note whose permanent delete already SUCCEEDED must
        // never reappear from a stale list/search response
        // (deleting it removed it from the server).
        .filter(
          (note) =>
            !removedNoteIdsRef.current.has(
              note.id,
            ),
        )

      const nextSelected =
        currentSelected != null &&
        merged.some((note) => note.id === currentSelected)
          ? currentSelected
          : merged.length > 0
            ? merged[0].id
            : null

      if (
        currentSelected != null &&
        nextSelected !== currentSelected &&
        isDraftDirty(
          currentNotes,
          currentDrafts,
          currentSelected,
        )
      ) {
        flushNow(currentSelected)
      }

      setNotes(merged)
      setSelectedNoteId(nextSelected)
    },
    [flushNow],
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
        const result = await listPersonalNotes(
          searchQuery,
        )

        if (
          requestId !== requestIdRef.current ||
          !liveRef.current
        ) {
          return
        }

        setInitialPhase('ready')
        setSearching(false)
        applyNotes(
          result,
          searchQuery === undefined ? 'plain' : 'search',
        )
      } catch (error) {
        if (
          requestId !== requestIdRef.current ||
          !liveRef.current
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
   * Debounced backend search. `requestedQueryRef` holds the query the
   * last issued request was for ('' IS the ordinary active list the
   * initial mount request asked for), so this Effect issues a search
   * only when the query has CHANGED since that request. That makes the
   * Effect body idempotent across StrictMode's development replay —
   * a replayed Effect with the same empty query schedules nothing,
   * instead of firing a spurious second/third active-list request.
   * Clearing the query back to empty re-requests the ordinary active
   * list (the query changed away from and back to '').
   */
  const requestedQueryRef = useRef('')

  useEffect(() => {
    if (requestedQueryRef.current === query) {
      return
    }

    requestedQueryRef.current = query

    const timer = setTimeout(() => {
      void runLoad(query)
    }, NOTES_SEARCH_DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [query, runLoad])

  const selectedNote =
    notes?.find((note) => note.id === selectedNoteId) ?? null

  /** The note whose delete confirmation dialog is open. */
  const deleteTargetNote =
    deleteTargetId != null
      ? (notes?.find(
          (note) => note.id === deleteTargetId,
        ) ?? null)
      : null

  /*
   * The writing surface always renders the local draft when one
   * exists — server responses never reset newer unsaved text — and
   * the note's canonical title/content otherwise (a freshly selected
   * note initializes its surface from its canonical representation).
   */
  const selectedDraft =
    selectedNoteId != null ? drafts[selectedNoteId] : undefined
  const effectiveTitle =
    selectedDraft?.title ?? selectedNote?.title ?? ''
  const effectiveContent =
    selectedDraft?.content ?? selectedNote?.content ?? ''

  const selectedSaveStatus =
    selectedNoteId != null
      ? saveStates[selectedNoteId]
      : undefined

  /** Quiet `Updated …` label for the selected note's metadata line. */
  const selectedUpdatedLabel = selectedNote
    ? formatNoteUpdatedDate(selectedNote.updatedAt)
    : ''

  const hasNotes = notes != null && notes.length > 0
  const hasActiveQuery = query.trim() !== ''

  /*
   * Update one field of the selected note's draft (creating the draft
   * from the canonical representation on first touch). Typing is
   * immediate: the draft is the value the title input, the editor,
   * and the list row render from.
   */
  function updateDraftField(
    field: 'title' | 'content',
    value: string,
  ) {
    if (selectedNoteId == null || !selectedNote) {
      return
    }

    const noteId = selectedNoteId
    const canonical = selectedNote

    setDrafts((prev) => {
      const base =
        prev[noteId] ?? {
          title: canonical.title,
          content: canonical.content,
        }

      if (base[field] === value) {
        return prev
      }

      return { ...prev, [noteId]: { ...base, [field]: value } }
    })
  }

  /*
   * Moving the selection flushes the previous note's latest local
   * draft immediately (fire-and-forget — the selection changes
   * without waiting for the network), then selects the new note. The
   * previous note's eventual save response updates ONLY that note.
   */
  function handleSelectNote(noteId: number) {
    if (noteId === selectedNoteId) {
      return
    }

    flushNow(selectedNoteId)
    setSelectedNoteId(noteId)
  }

  /*
   * Capture-first create: POST the empty object (no modal, no
   * metadata step, no client-invented title/content) and use the
   * authoritative created representation. An active search is
   * cleared FIRST, so the created note never has to match it; the
   * restored ordinary list (existing search contract) contains it.
   * The created note is inserted at the front (newest
   * updated/created first) and selected immediately — no collection
   * refetch is required to display it.
   */
  async function handleCreateNote() {
    if (creating) {
      return
    }

    setCreating(true)
    setCreateError(null)

    if (query.trim() !== '') {
      setQuery('')
    }

    try {
      const created = await createPersonalNote({})

      if (!liveRef.current) {
        return
      }

      sessionCreatedRef.current.set(created.id, created)
      lastKnownRef.current.set(created.id, created)
      hasRenderedNotesRef.current = true

      setNotes((prev) => {
        const base =
          prev == null
            ? []
            : prev.filter((note) => note.id !== created.id)
        return [created, ...base]
      })

      // A successful create IS a rendered result set: leave the
      // initial error/loading states even if the first load is still
      // pending or has failed.
      setInitialPhase('ready')
      setInitialError(null)

      // The writing flow starts at the new note's title.
      pendingTitleFocusIdRef.current = created.id
      setSelectedNoteId(created.id)
    } catch (error) {
      if (!liveRef.current) {
        return
      }

      // Stay on the page, keep the existing list/selection, keep the
      // action usable — nothing is fabricated.
      setCreateError(
        getErrorMessage(error, 'Something went wrong.'),
      )
    } finally {
      if (liveRef.current) {
        setCreating(false)
      }
    }
  }

  /*
   * Permanent delete (docs/domain/personal-notes.md): the overflow
   * menu's "Delete note" entry opens the explicit confirmation
   * dialog; only the dialog's destructive action issues a DELETE.
   * Opening the menu or the dialog never selects the note and
   * never touches its content or autosave state.
   */
  function handleRequestDelete(noteId: number) {
    if (deleteTargetId != null || deletingNoteId != null) {
      return
    }

    setDeleteError(null)
    setDeleteTargetId(noteId)
  }

  /** Close the dialog WITHOUT deleting (Cancel / Escape / overlay). */
  function closeDeleteDialog() {
    if (deletingNoteId != null) {
      return
    }

    const id = deleteTargetId
    setDeleteTargetId(null)
    setDeleteError(null)

    // Restore focus to the originating overflow trigger.
    if (id != null) {
      queueMicrotask(() =>
        deleteTriggerRefs.current.get(id)?.focus(),
      )
    }
  }

  /** The one explicit confirmation — exactly one DELETE request. */
  async function confirmDeleteNote() {
    const noteId = deleteTargetId
    if (noteId == null || deletingNoteId != null) {
      return
    }

    // From this moment, deletion intent wins over autosave for
    // this note (consistent with the existing generation/ref
    // architecture):
    // 1. mark the id as pending — no new autosave may be scheduled
    //    or flushed for it (guards in the autosave effect and in
    //    flushNow); the row stays rendered while the request is in
    //    flight (no optimistic removal);
    // 2. cancel the pending debounced save;
    // 3. claim a newer save generation so EVERY in-flight PATCH for
    //    this note (an older draft) is dropped by the existing
    //    saveSeqRef guard: its success can never reinsert or
    //    reconcile the note, its failure can never surface a save
    //    error. No request is aborted — the guards are enough.
    pendingDeleteIdsRef.current.add(noteId)

    const pendingTimer = saveTimerRef.current[noteId]
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      delete saveTimerRef.current[noteId]
    }
    saveSeqRef.current[noteId] =
      (saveSeqRef.current[noteId] ?? 0) + 1

    setDeleteError(null)
    setDeletingNoteId(noteId)
    const wasSelected = selectedNoteId === noteId

    try {
      await deletePersonalNote(noteId)
    } catch (error) {
      if (!liveRef.current) {
        return
      }

      // The delete FAILED: the note is alive again. Lift the
      // pending intent (stale responses may legitimately carry it),
      // keep the note + draft intact, and let autosave resume
      // safely: a stale in-flight marker is cleared and the
      // canonical flush re-acknowledges the current draft (a no-op
      // when it is already clean).
      pendingDeleteIdsRef.current.delete(noteId)
      delete inFlightRef.current[noteId]
      setDeletingNoteId(null)
      setDeleteError(
        getErrorMessage(error, 'Something went wrong.'),
      )
      flushNow(noteId)
      return
    }

    if (!liveRef.current) {
      return
    }

    // Success: the row is physically gone server-side. Purge every
    // page-local trace of this note so neither a stale draft, a
    // stale save, nor a stale list/search response can bring it
    // back — and remove the row from the CURRENT rendered set (no
    // refetch).
    pendingDeleteIdsRef.current.delete(noteId)
    removedNoteIdsRef.current.add(noteId)

    const pending = saveTimerRef.current[noteId]
    if (pending) {
      clearTimeout(pending)
      delete saveTimerRef.current[noteId]
    }
    delete saveSeqRef.current[noteId]
    delete inFlightRef.current[noteId]
    lastKnownRef.current.delete(noteId)
    sessionCreatedRef.current.delete(noteId)

    setDrafts((prev) => {
      if (!(noteId in prev)) {
        return prev
      }

      const next = { ...prev }
      delete next[noteId]
      return next
    })

    setSaveStates((prev) => {
      if (!(noteId in prev)) {
        return prev
      }

      const next = { ...prev }
      delete next[noteId]
      return next
    })

    const currentNotes = latestRef.current.notes
    const index = currentNotes?.findIndex(
      (entry) => entry.id === noteId,
    ) ?? -1
    const remaining = currentNotes
      ? currentNotes.filter(
          (entry) => entry.id !== noteId,
        )
      : []

    setNotes((prev) =>
      prev == null
        ? prev
        : prev.filter((entry) => entry.id !== noteId),
    )

    if (wasSelected) {
      // Deterministic selection from the currently rendered rows:
      // the row that occupied the FOLLOWING position; the previous
      // row when the deleted row was last; nothing when no notes
      // remain. No note is created; the search query is untouched.
      const nextId =
        remaining.length > 0
          ? remaining[Math.min(
              index,
              remaining.length - 1,
            )]?.id ?? null
          : null
      setSelectedNoteId(nextId)
      deleteFocusRef.current =
        nextId != null
          ? { kind: 'row', noteId: nextId }
          : { kind: 'new-note' }
    } else {
      // The current selection is untouched; focus returns to the
      // originating overflow trigger (the row survives).
      deleteFocusRef.current = {
        kind: 'trigger',
        noteId,
      }
    }

    setDeleteTargetId(null)
    setDeletingNoteId(null)
    setDeleteError(null)
  }

  /*
   * One-shot focus handoff after a successful delete: the surviving
   * selected row, the originating trigger (unselected delete), or
   * the New-note action (empty state).
   */
  useEffect(() => {
    const target = deleteFocusRef.current
    if (target == null) {
      return
    }

    deleteFocusRef.current = null

    if (target.kind === 'row') {
      rowButtonRefs.current.get(target.noteId)?.focus()
    } else if (target.kind === 'trigger') {
      deleteTriggerRefs.current.get(target.noteId)?.focus()
    } else {
      newNoteButtonRef.current?.focus()
    }
  }, [notes, selectedNoteId])

  /*
   * After creating a note, move focus into its writing flow — the
   * title input (the editor conventions of the repository start
   * free-form surfaces from the top field).
   */
  useEffect(() => {
    if (pendingTitleFocusIdRef.current == null) {
      return
    }

    if (selectedNoteId !== pendingTitleFocusIdRef.current) {
      return
    }

    pendingTitleFocusIdRef.current = null
    titleInputRef.current?.focus()
  }, [selectedNoteId])

  return (
    <div className="w-full px-6 py-8 lg:px-8">
      {initialPhase === 'error' ? (
        <div
          role="alert"
          className="flex min-h-64 flex-col items-center justify-center rounded-[10px] border border-border-subtle bg-surface-quiet px-6 py-10 text-center"
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
        <div className="flex flex-col gap-6 lg:min-h-[calc(100vh-8rem)] lg:flex-row">
          {initialPhase === 'loading' && (
            <p role="status" className="sr-only">
              Loading notes…
            </p>
          )}

          {/* Notes navigator: owns the Notes-level identity (heading
              + create action), the search, and the active list —
              secondary to the document pane (fixed width on
              desktop, full-width stacked on narrow viewports). */}
          <section
            aria-label="Notes list"
            className="w-full shrink-0 lg:w-[232px] lg:border-r lg:border-border-subtle lg:pr-4"
          >
            <header className="flex items-center justify-between gap-2">
              <h1 className="text-[15px] font-semibold tracking-tight text-text">
                Notes
              </h1>

              <button
                ref={newNoteButtonRef}
                type="button"
                onClick={() => void handleCreateNote()}
                disabled={creating}
                aria-busy={creating || undefined}
                aria-label="New note"
                title="New note"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-45"
              >
                <span
                  aria-hidden="true"
                  className="material-symbols-outlined text-[18px]"
                >
                  add
                </span>
              </button>
            </header>

            <label className="relative mt-2 block">
              <span
                aria-hidden="true"
                className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-[16px] text-text-muted"
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
                className="h-8 w-full rounded-md border border-border-subtle bg-surface pl-8 pr-3 text-[13px] text-text outline-none transition placeholder:text-text-muted/70 focus:border-focus focus:ring-2 focus:ring-focus/15"
              />
            </label>

            {createError && (
              <div
                role="alert"
                className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[10px] border border-border-subtle bg-danger-bg px-3 py-2.5"
              >
                <span
                  aria-hidden="true"
                  className="material-symbols-outlined shrink-0 text-[18px] text-danger"
                >
                  error_outline
                </span>

                <span className="min-w-0 text-sm text-text">
                  <span className="font-medium">
                    Note couldn't be created.
                  </span>{' '}
                  <span className="text-text-muted">
                    {createError}
                  </span>
                </span>

                <button
                  type="button"
                  onClick={() => void handleCreateNote()}
                  className="ml-auto inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border-subtle bg-surface px-3 text-xs font-semibold text-text transition hover:bg-surface-hover"
                >
                  <span
                    aria-hidden="true"
                    className="material-symbols-outlined text-[16px]"
                  >
                    refresh
                  </span>
                  Try again
                </button>
              </div>
            )}

            {searchError && (
              <div
                role="alert"
                className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[10px] border border-border-subtle bg-warning-bg px-3 py-2.5"
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
                  <p className="px-2.5 py-6 text-center text-sm text-text-muted">
                    No notes match "{query.trim()}".
                  </p>
                ) : (
                  <div className="px-2.5 py-6 text-center">
                    <p className="text-sm text-text-muted">
                      No notes yet.
                    </p>

                    <p className="mt-1 text-xs text-text-muted/80">
                      Use New note to capture your first thought.
                    </p>
                  </div>
                )
              ) : (
                <ul className="flex flex-col">
                  {notes.map((note) => {
                    const selected =
                      note.id === selectedNoteId

                    // The row reflects the current local title
                    // immediately — the draft, not the last
                    // acknowledged representation.
                    const draft = drafts[note.id]
                    const rowNote = draft
                      ? { ...note, title: draft.title }
                      : note

                    return (
                      <li key={note.id}>
                        {/*
                         * One row container owns the subtle
                         * selected/hovered surface across the
                         * COMPLETE row (title/date + trigger);
                         * the selection button + overflow
                         * trigger are SIBLINGS inside it — no
                         * button nested in another, and the 24px
                         * inline trigger sits in the row's right
                         * edge, never outside the row surface.
                         */}
                        <div
                          className={[
                            'group flex items-center rounded-md transition-colors',
                            selected
                              ? 'bg-surface-muted'
                              : 'hover:bg-surface-muted/50',
                          ].join(' ')}
                        >
                          <button
                            type="button"
                            ref={(element) => {
                              if (element) {
                                rowButtonRefs.current.set(
                                  note.id,
                                  element,
                                )
                              } else {
                                rowButtonRefs.current.delete(
                                  note.id,
                                )
                              }
                            }}
                            onClick={() =>
                              handleSelectNote(note.id)
                            }
                            aria-current={
                              selected ? 'true' : undefined
                            }
                            className={[
                              'min-w-0 flex-1 rounded-md px-2.5 py-[5px] text-left text-text',
                              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
                            ].join(' ')}
                          >
                            <span className="block truncate text-[13px] font-medium leading-[1.3]">
                              {displayNoteTitle(rowNote)}
                            </span>

                            <span className="mt-px block text-[11px] leading-[1.3] text-text-muted">
                              {formatNoteUpdatedDate(
                                note.updatedAt,
                              )}
                            </span>
                          </button>

                          <NoteActionsMenu
                            displayTitle={displayNoteTitle(
                              rowNote,
                            )}
                            onTriggerRef={(element) => {
                              if (element) {
                                deleteTriggerRefs.current.set(
                                  note.id,
                                  element,
                                )
                              } else {
                                deleteTriggerRefs.current.delete(
                                  note.id,
                                )
                              }
                            }}
                            onRequestDelete={() =>
                              handleRequestDelete(note.id)
                            }
                          />
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </section>

          {/* Document pane: the selected note IS the work surface.
              The writing column is width-constrained (max-w-[760px])
              and biased LEFT of the pane center on wide desktops
              (asymmetric right padding) — closer to the navigator,
              calm right margin, readable line length — and simply
              fills the pane below xl. It carries no card, border,
              or panel. min-w-0 so long lines wrap, never overflow.
              The row is full workspace height on desktop, so the
              navigator's right border reads as a continuous
              navigator | document separator. */}
          <section
            aria-label="Selected note"
            className="flex min-w-0 flex-1 flex-col xl:pr-24 2xl:pr-32"
            onMouseDown={(event) => {
              surfaceMouseDownRef.current = {
                x: event.clientX,
                y: event.clientY,
              }
            }}
            onClick={handleDocumentSurfaceClick}
          >
            <div
              ref={documentColumnRef}
              className="w-full max-w-[760px] flex-1"
            >
              {initialPhase === 'loading' ? (
                <NoteDetailSkeleton />
              ) : selectedNote ? (
                <article ref={documentArticleRef}>
                  {/*
                   * The document title: a borderless input that
                   * reads as the document's headline, not a form
                   * field — transparent background, no resting
                   * rectangle, a quiet ring on keyboard focus only.
                   */}
                  <input
                    ref={titleInputRef}
                    type="text"
                    aria-label="Note title"
                    value={effectiveTitle}
                    maxLength={NOTE_TITLE_MAX_LENGTH}
                    placeholder="Untitled"
                    onChange={(event) =>
                      updateDraftField(
                        'title',
                        event.target.value,
                      )
                    }
                    onKeyDown={(event) => {
                      // Enter in the title is the "start writing"
                      // handoff — never a newline, never a submit,
                      // never a new Note: move straight into the
                      // document (caret at the end). The natural
                      // blur that follows flushes the title draft
                      // through the existing save model (no
                      // duplicate PATCH: flushNow is idempotent for
                      // an in-flight identical draft).
                      if (
                        event.key === 'Enter' &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault()
                        editorRef.current?.focusEnd()
                      }
                    }}
                    onBlur={() =>
                      flushNow(selectedNoteId)
                    }
                    className="w-full min-w-0 bg-transparent text-[34px] font-semibold tracking-tight text-text outline-none placeholder:font-semibold placeholder:text-text-muted/55 focus-visible:rounded-[4px] focus-visible:ring-2 focus-visible:ring-focus/40"
                  />

                  {/*
                   * One quiet system-metadata line: the Updated
                   * date and the save status, both secondary to
                   * the title — no card, no input chrome. (The
                   * future Properties slot sits below this line;
                   * see the marker above the body.)
                   */}
                  {(selectedUpdatedLabel !== '' ||
                    (selectedSaveStatus != null &&
                      selectedSaveStatus.state !==
                        'error')) && (
                    <p className="mt-2 flex flex-wrap items-baseline gap-x-1.5 text-[11px] text-text-muted">
                      {selectedUpdatedLabel !== '' && (
                        <span>
                          Updated{' '}
                          {selectedUpdatedLabel}
                        </span>
                      )}

                      {selectedUpdatedLabel !== '' &&
                        selectedSaveStatus != null &&
                        selectedSaveStatus.state !==
                          'error' && (
                          <span aria-hidden="true">·</span>
                        )}

                      {selectedSaveStatus &&
                        selectedSaveStatus.state !==
                          'error' && (
                          <span role="status">
                            {selectedSaveStatus.state ===
                              'saving'
                              ? 'Saving…'
                              : 'Saved'}
                          </span>
                        )}
                    </p>
                  )}

                  {selectedSaveStatus?.state ===
                    'error' && (
                    <div
                      role="alert"
                      className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[10px] border border-border-subtle bg-danger-bg px-4 py-2.5"
                    >
                      <span
                        aria-hidden="true"
                        className="material-symbols-outlined shrink-0 text-[18px] text-danger"
                      >
                        error_outline
                      </span>

                      <span className="min-w-0 text-sm text-text">
                        <span className="font-medium">
                          Couldn't save.
                        </span>{' '}
                        <span className="text-text-muted">
                          {selectedSaveStatus.message}
                        </span>
                      </span>

                      <button
                        type="button"
                        onClick={() =>
                          flushNow(selectedNoteId)
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

                  {/*
                   * Future Properties slot: when Personal Note
                   * Properties land, their section renders HERE —
                   * directly below the title + system-metadata line,
                   * above the body — without moving either.
                   * Deliberately empty for now: no placeholder card,
                   * no controls, no fake properties.
                   */}

                  <div
                    ref={editorSurfaceRef}
                    className="mt-6 min-h-[240px]"
                  >
                    {/*
                     * The continuous writing surface: the canonical
                     * Markdown editor, editable, driven by the local
                     * draft (never toggling between read and edit
                     * modes). Contextual toolbar mode: formatting is
                     * disclosed on selection (Bubble toolbar) with
                     * no permanent bar under the document. Blur
                     * commits early via onCommit; the debounced
                     * autosave is what actually persists.
                     */}
                    <RichMarkdownEditor
                      ref={editorRef}
                      value={effectiveContent}
                      onChange={(markdown) =>
                        updateDraftField(
                          'content',
                          markdown,
                        )
                      }
                      onCommit={() =>
                        flushNow(selectedNoteId)
                      }
                      placeholder="Start writing…"
                      ariaLabel="Note content"
                      variant="full"
                      toolbarMode="contextual"
                      className="break-words fg-note-document"
                    />
                  </div>
                </article>
              ) : (
                <div className="flex h-full min-h-[280px] items-center justify-center">
                  <p className="text-sm text-text-muted">
                    Select a note to read it.
                  </p>
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      {deleteTargetId != null && (
        <NoteDeleteDialog
          title={
            deleteTargetNote
              ? displayNoteTitle(deleteTargetNote)
              : 'Untitled'
          }
          deleting={deletingNoteId != null}
          error={deleteError}
          onCancel={closeDeleteDialog}
          onConfirm={() => void confirmDeleteNote()}
        />
      )}
    </div>
  )
}
