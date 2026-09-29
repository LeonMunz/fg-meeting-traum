// @vitest-environment happy-dom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  StrictMode,
  forwardRef,
  useImperativeHandle,
  useRef,
} from 'react'
import type { ForwardedRef } from 'react'
import { MemoryRouter } from 'react-router'

import { App } from '../../app/App'
import { ApiError } from '../../api/client'
import {
  archivePersonalNote,
  createPersonalNote,
  deletePersonalNote,
  getPersonalNote,
  listArchivedPersonalNotes,
  listPersonalNotes,
  restorePersonalNote,
  setPersonalNotePinned,
  updatePersonalNote,
} from '../../api/personal-notes'
import type { ApiPersonalNote } from '../../api/types'

import {
  displayNoteTitle,
  formatNoteUpdatedDate,
  NotesPage,
} from './NotesPage'

/*
 * The canonical RichMarkdownEditor (the single Markdown surface in the
 * app) is mocked at the module boundary: the mock records the props the
 * page passes (the exact editor contract this slice must hold —
 * canonical Markdown value, editable, variant "full", labels,
 * placeholder, onChange/onCommit wiring) and renders the value plus a
 * toolbar stub in edit mode and a typed textarea standing in for the
 * ProseMirror document, so typing behavior is testable without the
 * Tiptap graph. The real editor's Markdown semantics are covered by
 * the editor's own suites.
 */
const richMarkdownEditor = vi.hoisted(() => ({
  lastProps: null as Record<string, unknown> | null,
  focusEndCalls: 0,
}))

vi.mock('../../components/editor/RichMarkdownEditor', () => ({
  RichMarkdownEditor: forwardRef(
    (
      props: Record<string, unknown>,
      ref: ForwardedRef<{ focusEnd: () => void }>,
    ) => {
      richMarkdownEditor.lastProps = props
      const editable = props.readOnly !== true
      const textareaRef = useRef<HTMLTextAreaElement>(null)

      // The page's writing handoff (Enter in the title, click on
      // free document surface) goes through the imperative handle:
      // the stand-in focuses the editable surface with the caret at
      // the end — mirroring the real editor's focusEnd() contract —
      // and records that the handoff happened.
      useImperativeHandle(ref, () => ({
        focusEnd: () => {
          const el = textareaRef.current
          if (!el) {
            return
          }
          richMarkdownEditor.focusEndCalls += 1
          el.focus()
          const end = el.value.length
          el.setSelectionRange(end, end)
        },
      }))

      return (
        <div data-testid="note-editor">
        <div
          data-testid="note-content"
          data-editable={String(editable)}
        >
          {String(props.value ?? '')}
        </div>

        {editable && (
          <>
            {/* Selection-anchored bubble toolbar — present in every
                editable mode (default and contextual), mirroring the
                real editor. */}
            <div
              role="toolbar"
              aria-label="Selection formatting"
              data-testid="note-editor-bubble-toolbar"
            />

            {/* Permanent bottom toolbar — default mode only;
                contextual mode (Notes) mounts no permanent bar. */}
            {props.toolbarMode !== 'contextual' && (
              <div
                role="toolbar"
                aria-label="Formatting"
                data-testid="note-editor-toolbar"
              />
            )}

            <textarea
              ref={textareaRef}
              aria-label={String(props.ariaLabel ?? '')}
              placeholder={String(props.placeholder ?? '')}
              value={String(props.value ?? '')}
              onChange={(event) =>
                (
                  props.onChange as
                    | ((markdown: string) => void)
                    | undefined
                )?.(event.target.value)
              }
              onBlur={() =>
                (
                  props.onCommit as
                    | ((markdown: string) => void)
                    | undefined
                )?.(String(props.value ?? ''))
              }
            />
          </>
        )}
        </div>
      )
    },
  ),
}))

/*
 * The page must talk to the canonical client functions. Every client
 * function is mocked: listPersonalNotes (list + search), create and
 * update (this slice), and pin / archive / restore / detail /
 * archive-listing, which must NOT be called in this slice.
 */
vi.mock('../../api/personal-notes', () => ({
  listPersonalNotes: vi.fn(),
  listArchivedPersonalNotes: vi.fn(),
  getPersonalNote: vi.fn(),
  createPersonalNote: vi.fn(),
  updatePersonalNote: vi.fn(),
  deletePersonalNote: vi.fn(),
  setPersonalNotePinned: vi.fn(),
  archivePersonalNote: vi.fn(),
  restorePersonalNote: vi.fn(),
}))

const { sessionUser, session } = vi.hoisted(() => {
  const sessionUser = {
    id: 1,
    username: 'alex',
    firstName: 'Alex',
    lastName: '',
    email: 'alex@example.com',
  }
  const session = {
    user: sessionUser,
    loading: false,
    error: null,
    login: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    setAuthenticatedUser: vi.fn(),
  }
  return { sessionUser, session }
})

vi.mock('../../api/useSession', () => ({
  useSession: () => session,
}))

vi.mock('../../api/auth', () => ({
  me: vi.fn().mockResolvedValue(sessionUser),
  login: vi.fn(),
  logout: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../api/research-groups', () => ({
  listResearchGroups: vi.fn().mockResolvedValue([
    {
      id: 1,
      name: 'FG Research Group',
      description: '',
      status: 'active',
      createdById: 1,
      createdAt: '2026-01-01T00:00:00Z',
    },
  ]),
}))

/*
 * The page source itself, inlined as raw text by Vite: the
 * "single canonical editor" contract is a structural one, so the
 * check inspects the page's imports directly.
 */
const notesPageSource = (
  import.meta.glob('./NotesPage.tsx', {
    query: '?raw',
    import: 'default',
    eager: true,
  })['./NotesPage.tsx'] as string
)

/* ── Fixtures ─────────────────────────────────────────────────── */

function note(
  overrides: Partial<ApiPersonalNote> &
    Pick<ApiPersonalNote, 'id' | 'title' | 'content'>,
): ApiPersonalNote {
  return {
    pinned: false,
    archivedAt: null,
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-29T09:00:00Z',
    ...overrides,
  }
}

const ALPHA = note({
  id: 1,
  title: 'Alpha',
  content: 'Alpha body',
  updatedAt: '2026-09-29T09:00:00Z',
})

const BETA = note({
  id: 2,
  title: 'Beta',
  content: 'Beta body',
  updatedAt: '2026-09-29T08:00:00Z',
})

const GAMMA = note({
  id: 3,
  title: 'Gamma',
  content: 'Gamma body',
  updatedAt: '2026-09-29T07:00:00Z',
})

const DEFAULT_NOTES = [ALPHA, BETA, GAMMA]

const KNOWN_NOTES: Record<number, ApiPersonalNote> = {
  1: ALPHA,
  2: BETA,
  3: GAMMA,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/* ── Render helpers ───────────────────────────────────────────── */

function resetApiMocks() {
  vi.mocked(listPersonalNotes).mockReset()
  vi.mocked(listArchivedPersonalNotes).mockReset()
  vi.mocked(getPersonalNote).mockReset()
  vi.mocked(createPersonalNote).mockReset()
  vi.mocked(updatePersonalNote).mockReset()
  vi.mocked(setPersonalNotePinned).mockReset()
  vi.mocked(archivePersonalNote).mockReset()
  vi.mocked(restorePersonalNote).mockReset()
  vi.mocked(deletePersonalNote).mockReset()
  richMarkdownEditor.lastProps = null
  richMarkdownEditor.focusEndCalls = 0
  createdCounter = 0

  // Default echo for saves: apply the changed fields to the known
  // fixture note and bump updatedAt (tests override per scenario).
  vi.mocked(updatePersonalNote).mockImplementation(
    async (id, input) => {
      const base = KNOWN_NOTES[id] ??
        note({
          id,
          title: '',
          content: '',
          createdAt: '2026-09-29T12:00:00Z',
          updatedAt: '2026-09-29T12:00:00Z',
        })
      return { ...base, ...input, updatedAt: '2026-09-29T10:00:00Z' }
    },
  )
}

let createdCounter = 0

function freshCreatedNote(
  overrides: Partial<ApiPersonalNote> = {},
): ApiPersonalNote {
  createdCounter += 1
  return note({
    id: 9000 + createdCounter,
    title: '',
    content: '',
    createdAt: '2026-09-29T12:00:00Z',
    updatedAt: '2026-09-29T12:00:00Z',
    ...overrides,
  })
}

/**
 * Mount the page. The initial request fires during the mount effect,
 * so the listPersonalNotes implementation must be in place BEFORE the
 * render call: pass `listImpl` to override the default resolved list.
 */
function renderPage(
  initialNotes: ApiPersonalNote[] = DEFAULT_NOTES,
  listImpl?: (
    query?: string,
  ) => Promise<ApiPersonalNote[]>,
) {
  if (listImpl) {
    vi.mocked(listPersonalNotes).mockImplementation(listImpl)
  } else {
    vi.mocked(listPersonalNotes).mockImplementation(
      async () => initialNotes,
    )
  }

  if (vi.mocked(createPersonalNote).mockImplementation === undefined) {
    vi.mocked(createPersonalNote).mockImplementation(
      async () => freshCreatedNote(),
    )
  }

  return render(
    <MemoryRouter initialEntries={['/notes']}>
      <NotesPage />
    </MemoryRouter>,
  )
}

/**
 * Mount the page inside React.StrictMode — the same wrapper the
 * real Vite app uses (main.tsx). In development, StrictMode
 * double-invokes mount Effects: run → cleanup → replay.
 */
function renderStrictPage(
  initialNotes: ApiPersonalNote[] = DEFAULT_NOTES,
  listImpl?: (
    query?: string,
  ) => Promise<ApiPersonalNote[]>,
) {
  if (listImpl) {
    vi.mocked(listPersonalNotes).mockImplementation(listImpl)
  } else {
    vi.mocked(listPersonalNotes).mockImplementation(
      async () => initialNotes,
    )
  }

  if (vi.mocked(createPersonalNote).mockImplementation === undefined) {
    vi.mocked(createPersonalNote).mockImplementation(
      async () => freshCreatedNote(),
    )
  }

  return render(
    <StrictMode>
      <MemoryRouter initialEntries={['/notes']}>
        <NotesPage />
      </MemoryRouter>
    </StrictMode>,
  )
}

/** Real-timer settle for the pending initial request. */
async function settleInitialLoad() {
  await waitFor(() => {
    expect(
      screen.queryByRole('status'),
    ).not.toBeInTheDocument()
  })
}

function searchInput() {
  return screen.getByRole('searchbox', {
    name: 'Search notes',
  })
}

function listRegion() {
  return screen.getByRole('region', {
    name: 'Notes list',
  })
}

function rowButtons() {
  // The navigator region also hosts the New-note action; each note
  // row holds exactly TWO sibling buttons: the selection button
  // (the whole practical title/date region) and the overflow
  // trigger ("More actions for …"). This helper returns the
  // selection buttons — the trigger carries the aria-label, the
  // selection button derives its name from its content.
  return within(listRegion())
    .getAllByRole('listitem')
    .map((item) => {
      const buttons = within(item).getAllByRole('button')
      return buttons.find(
        (button) => !button.hasAttribute('aria-label'),
      ) as HTMLElement
    })
}

/** The row's overflow trigger ("More actions for <title>"). */
function overflowTrigger(title: string) {
  return screen.getByRole('button', {
    name: `More actions for ${title}`,
  })
}

/** The selection buttons of a list element (no overflow triggers). */
function selectionButtonsIn(list: HTMLElement) {
  return Array.from(list.querySelectorAll('button')).filter(
    (button) => !button.hasAttribute('aria-label'),
  ) as HTMLElement[]
}

function rowTitles() {
  return rowButtons().map(rowTitle)
}

function rowTitle(button: HTMLElement): string {
  return (
    button.querySelector('.truncate')?.textContent ?? ''
  )
}

function titleInput() {
  return screen.getByRole('textbox', {
    name: 'Note title',
  })
}

function contentInput() {
  return screen.getByRole('textbox', {
    name: 'Note content',
  })
}

function noteContent() {
  return screen.getByTestId('note-content')
}

function newNoteButton() {
  return screen.getByRole('button', {
    name: 'New note',
  })
}

/*
 * A row's accessible name is its title FOLLOWED by the quiet
 * "updated" date (both spans are part of the button), so lookups
 * match on the title prefix.
 */
function rowNamePrefix(title: string) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped}`)
}

function rowByTitle(title: string) {
  return screen.getByRole('button', {
    name: rowNamePrefix(title),
  })
}

/*
 * Debounce block in the repository's canonical shape: the page
 * mounts and settles on REAL timers first; fake timers are enabled
 * only around the debounce window, and restored in finally. Both the
 * search debounce and the autosave debounce use the same 300 ms
 * window.
 */
async function flushDebounce() {
  await act(async () => {
    vi.advanceTimersByTime(300)
  })
}

beforeEach(() => {
  resetApiMocks()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/* ── New note ─────────────────────────────────────────────────── */

describe('new note', () => {
  it('offers a keyboard-accessible "+ New note" action in the navigator', async () => {
    renderPage()
    await settleInitialLoad()

    const button = newNoteButton()
    expect(button).toBeInTheDocument()
    expect(button).toBeEnabled()
    // A native <button> is keyboard-activatable by construction.
    expect(button.tagName).toBe('BUTTON')
    // The compact icon button: the icon is decorative, the
    // accessible name comes from the label (keyboard/screen-reader
    // users get the same "New note" name).
    expect(button).toHaveAccessibleName('New note')
    // …and it is focusable by keyboard.
    button.focus()
    expect(button).toHaveFocus()
    // The action belongs to the Notes navigator — it no longer
    // floats in the far corner of the document pane.
    expect(listRegion().contains(button)).toBe(true)
    expect(
      screen
        .getByRole('region', {
          name: 'Selected note',
        })
        .contains(button),
    ).toBe(false)
  })

  it('keeps the create action visible and obvious in the empty state', async () => {
    renderPage([])
    await settleInitialLoad()

    expect(screen.getByText('No notes yet.')).toBeInTheDocument()
    expect(newNoteButton()).toBeEnabled()
  })

  it('sends exactly one capture-first createPersonalNote({}) on click', async () => {
    const created = freshCreatedNote({
      title: 'Fresh idea',
      content: 'Fresh body',
    })
    vi.mocked(createPersonalNote).mockResolvedValue(
      created,
    )
    renderPage()
    await settleInitialLoad()

    fireEvent.click(newNoteButton())
    await screen.findByRole('button', {
      name: rowNamePrefix('Fresh idea'),
    })

    expect(createPersonalNote).toHaveBeenCalledTimes(1)
    expect(createPersonalNote).toHaveBeenCalledWith({})
  })

  it('does not duplicate the POST on repeated clicks while it is pending', async () => {
    const gate = deferred<ApiPersonalNote>()
    vi.mocked(createPersonalNote).mockImplementation(
      () => gate.promise,
    )
    renderPage()
    await settleInitialLoad()

    fireEvent.click(newNoteButton())
    expect(newNoteButton()).toBeDisabled()
    fireEvent.click(newNoteButton())
    fireEvent.click(newNoteButton())

    expect(createPersonalNote).toHaveBeenCalledTimes(1)

    gate.resolve(freshCreatedNote({ title: 'Fresh idea' }))
    await screen.findByRole('button', {
      name: rowNamePrefix('Fresh idea'),
    })
    expect(newNoteButton()).toBeEnabled()
  })

  it('inserts the authoritative created note first, selects it, and moves focus to its title', async () => {
    const created = freshCreatedNote({
      title: 'Fresh idea',
      content: 'Fresh body',
    })
    vi.mocked(createPersonalNote).mockResolvedValue(
      created,
    )
    renderPage()
    await settleInitialLoad()

    fireEvent.click(newNoteButton())
    await screen.findByRole('button', {
      name: rowNamePrefix('Fresh idea'),
    })

    // Newest updated/created first — the created note leads the
    // active list and is selected…
    expect(rowTitles()[0]).toBe('Fresh idea')
    expect(rowByTitle('Fresh idea')).toHaveAttribute(
      'aria-current',
      'true',
    )
    // …the writing surface shows the AUTHORITATIVE created
    // representation (never a client-fabricated one)…
    expect(titleInput()).toHaveValue('Fresh idea')
    expect(noteContent()).toHaveTextContent('Fresh body')
    // …and focus moved into the new note's writing flow (title).
    expect(document.activeElement).toBe(titleInput())
    // No collection refetch was needed to display it.
    expect(listPersonalNotes).toHaveBeenCalledTimes(1)
  })

  it('clears an active search before creating so the new note is visible and selected', async () => {
    const gate = deferred<ApiPersonalNote>()
    vi.mocked(createPersonalNote).mockImplementation(
      () => gate.promise,
    )
    renderPage(
      undefined,
      async (query?: string) =>
        query === 'alpha'
          ? [ALPHA]
          : Promise.resolve(DEFAULT_NOTES),
    )
    await settleInitialLoad()

    vi.useFakeTimers()
    try {
      fireEvent.change(searchInput(), {
        target: { value: 'alpha' },
      })
      await flushDebounce()
      expect(rowTitles()).toEqual(['Alpha'])

      // Create while the search is active: the created note does
      // NOT match 'alpha' — it must still become visible.
      fireEvent.click(newNoteButton())
      await act(async () => {
        gate.resolve(freshCreatedNote())
      })
    } finally {
      vi.useRealTimers()
    }

    // The search query was cleared first…
    expect(searchInput()).toHaveValue('')
    // …and the created (untitled) note is visible + selected.
    expect(rowTitles()[0]).toBe('Untitled')
    expect(rowByTitle('Untitled')).toHaveAttribute(
      'aria-current',
      'true',
    )
  })

  it('keeps the previous state on create failure and allows creating again', async () => {
    let attempts = 0
    vi.mocked(createPersonalNote).mockImplementation(
      async () => {
        attempts += 1
        if (attempts === 1) {
          throw new ApiError(500, {
            error: 'Create exploded.',
          })
        }

        return freshCreatedNote({ title: 'Retry me' })
      },
    )
    renderPage()
    await settleInitialLoad()

    fireEvent.click(newNoteButton())
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      "Note couldn't be created.",
    )
    expect(alert).toHaveTextContent('Create exploded.')

    // Previous list/selection/content untouched; nothing
    // fabricated…
    expect(rowTitles()).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
    ])
    expect(rowByTitle('Alpha')).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(noteContent()).toHaveTextContent('Alpha body')
    expect(
      screen.queryByRole('button', { name: /Retry me/ }),
    ).not.toBeInTheDocument()
    // …search state preserved (still empty, still functional).
    expect(searchInput()).toHaveValue('')
    // …and the action is usable again.
    expect(newNoteButton()).toBeEnabled()

    fireEvent.click(newNoteButton())
    await screen.findByRole('button', {
      name: rowNamePrefix('Retry me'),
    })
    expect(createPersonalNote).toHaveBeenCalledTimes(2)
    expect(
      screen.queryByRole('alert'),
    ).not.toBeInTheDocument()
    expect(rowByTitle('Retry me')).toHaveAttribute(
      'aria-current',
      'true',
    )
  })

  it('requires no list refetch to display the created note', async () => {
    const gate = deferred<ApiPersonalNote>()
    vi.mocked(createPersonalNote).mockImplementation(
      () => gate.promise,
    )
    renderPage(
      undefined,
      async (query?: string) =>
        query === 'alpha'
          ? [ALPHA]
          : Promise.resolve(DEFAULT_NOTES),
    )
    await settleInitialLoad()

    vi.useFakeTimers()
    try {
      fireEvent.change(searchInput(), {
        target: { value: 'alpha' },
      })
      await flushDebounce()
      expect(listPersonalNotes).toHaveBeenCalledTimes(2)

      fireEvent.click(newNoteButton())
      await act(async () => {
        gate.resolve(freshCreatedNote({ title: 'Instant' }))
      })

      // The created note renders IMMEDIATELY from the POST
      // response — the debounced re-request caused by clearing the
      // search has not even fired yet…
      expect(rowTitles()[0]).toBe('Instant')
      expect(rowByTitle('Instant')).toHaveAttribute(
        'aria-current',
        'true',
      )
      expect(listPersonalNotes).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

/* ── Title editing ────────────────────────────────────────────── */

describe('title editing', () => {
  it('edits the selected note title directly (no modal, no separate edit mode)', async () => {
    renderPage()
    await settleInitialLoad()

    const title = titleInput()
    expect(title).toHaveValue('Alpha')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.change(title, {
      target: { value: 'Alpha, revised' },
    })

    // Title editing is local immediately: input AND list row.
    expect(title).toHaveValue('Alpha, revised')
    expect(rowTitles()[0]).toBe('Alpha, revised')
    // Nothing persisted before the debounce window.
    expect(updatePersonalNote).not.toHaveBeenCalled()
  })

  it('shows "Untitled" for an empty local title without ever persisting the literal', async () => {
    renderPage()
    await settleInitialLoad()

    vi.useFakeTimers()
    try {
      fireEvent.change(titleInput(), {
        target: { value: '' },
      })

      // Presentation fallback in the list row…
      expect(rowTitles()[0]).toBe('Untitled')
      // …while the input holds the empty string (the fallback is
      // a placeholder, never the value).
      expect(titleInput()).toHaveValue('')
      expect(titleInput()).toHaveAttribute(
        'placeholder',
        'Untitled',
      )

      await flushDebounce()
      await act(async () => {})
    } finally {
      vi.useRealTimers()
    }

    // The PATCH carries the empty title — never "Untitled".
    expect(updatePersonalNote).toHaveBeenCalledTimes(1)
    expect(updatePersonalNote).toHaveBeenCalledWith(1, {
      title: '',
    })
  })

  it('respects the backend 255-character title contract', async () => {
    renderPage()
    await settleInitialLoad()

    expect(titleInput()).toHaveAttribute(
      'maxlength',
      '255',
    )
  })
})

/* ── Content editing ──────────────────────────────────────────── */

describe('content editing', () => {
  it('renders the selected content in the editable canonical editor (a continuous writing surface)', async () => {
    renderPage()
    await settleInitialLoad()

    expect(noteContent()).toHaveAttribute(
      'data-editable',
      'true',
    )
    expect(richMarkdownEditor.lastProps).toMatchObject({
      variant: 'full',
      value: 'Alpha body',
      placeholder: 'Start writing…',
      ariaLabel: 'Note content',
    })
    expect(
      richMarkdownEditor.lastProps?.readOnly,
    ).toBeFalsy()
    expect(
      typeof richMarkdownEditor.lastProps?.onChange,
    ).toBe('function')
    expect(
      typeof richMarkdownEditor.lastProps?.onCommit,
    ).toBe('function')
    // No read-only mode, no "no content" card.
    expect(
      screen.queryByText('This note has no content.'),
    ).not.toBeInTheDocument()
  })

  it('initializes the editor from the note\'s existing canonical Markdown', async () => {
    const markdown =
      '# Heading\n\n- first\n- **bold** item'
    renderPage([
      note({
        id: 7,
        title: 'Markdown note',
        content: markdown,
      }),
    ])
    await settleInitialLoad()

    // The canonical Markdown string is the editor's value — no
    // re-parsing, no second representation.
    expect(richMarkdownEditor.lastProps).toMatchObject({
      value: markdown,
      variant: 'full',
    })
    expect(noteContent().textContent).toBe(markdown)
    expect(contentInput()).toHaveValue(markdown)
  })

  it('typing updates the visible draft immediately (before any save)', async () => {
    renderPage()
    await settleInitialLoad()

    fireEvent.change(contentInput(), {
      target: { value: 'Alpha body plus more' },
    })

    // The visible draft (editor surface + underlying value) updates
    // immediately, with no PATCH yet.
    expect(noteContent()).toHaveTextContent(
      'Alpha body plus more',
    )
    expect(contentInput()).toHaveValue(
      'Alpha body plus more',
    )
    expect(richMarkdownEditor.lastProps).toMatchObject({
      value: 'Alpha body plus more',
    })
    expect(updatePersonalNote).not.toHaveBeenCalled()
  })
})

/* ── Autosave ─────────────────────────────────────────────────── */

describe('autosave', () => {
  it('debounces a title edit into a PATCH carrying only the changed field', async () => {
    renderPage()
    await settleInitialLoad()

    vi.useFakeTimers()
    try {
      fireEvent.change(titleInput(), {
        target: { value: 'Alpha v2' },
      })
      expect(updatePersonalNote).not.toHaveBeenCalled()

      await act(async () => {
        vi.advanceTimersByTime(299)
      })
      expect(updatePersonalNote).not.toHaveBeenCalled()

      await act(async () => {
        vi.advanceTimersByTime(1)
      })
      await act(async () => {})
    } finally {
      vi.useRealTimers()
    }

    // Title-only change → title-only PATCH (no no-op content).
    expect(updatePersonalNote).toHaveBeenCalledTimes(1)
    expect(updatePersonalNote).toHaveBeenCalledWith(
      1,
      { title: 'Alpha v2' },
    )
  })

  it('debounces a content edit into a PATCH carrying only the changed field', async () => {
    renderPage()
    await settleInitialLoad()

    vi.useFakeTimers()
    try {
      fireEvent.change(contentInput(), {
        target: { value: 'Alpha body v2' },
      })
      await flushDebounce()
      await act(async () => {})
    } finally {
      vi.useRealTimers()
    }

    expect(updatePersonalNote).toHaveBeenCalledTimes(1)
    expect(updatePersonalNote).toHaveBeenCalledWith(
      1,
      { content: 'Alpha body v2' },
    )
  })

  it('coalesces rapid title+content edits into a single PATCH with the latest values', async () => {
    renderPage()
    await settleInitialLoad()

    vi.useFakeTimers()
    try {
      fireEvent.change(titleInput(), {
        target: { value: 'Alpha v2' },
      })
      fireEvent.change(titleInput(), {
        target: { value: 'Alpha v3' },
      })
      fireEvent.change(contentInput(), {
        target: { value: 'Alpha body v2' },
      })
      await flushDebounce()
      await act(async () => {})
    } finally {
      vi.useRealTimers()
    }

    expect(updatePersonalNote).toHaveBeenCalledTimes(1)
    expect(updatePersonalNote).toHaveBeenCalledWith(1, {
      title: 'Alpha v3',
      content: 'Alpha body v2',
    })
  })

  it('sends no PATCH when the draft is unchanged from the last acknowledged state', async () => {
    renderPage()
    await settleInitialLoad()

    vi.useFakeTimers()
    try {
      // Type, then revert back to the acknowledged title.
      fireEvent.change(titleInput(), {
        target: { value: 'Temporary' },
      })
      fireEvent.change(titleInput(), {
        target: { value: 'Alpha' },
      })
      await flushDebounce()
      await act(async () => {})
    } finally {
      vi.useRealTimers()
    }

    // No timestamp churn from a no-op save.
    expect(updatePersonalNote).not.toHaveBeenCalled()
  })

  it('updates updatedAt from the latest server response (list row + surface)', async () => {
    vi.mocked(updatePersonalNote).mockImplementation(
      async (id, input) => ({
        ...KNOWN_NOTES[id],
        ...input,
        updatedAt: '2026-09-30T09:00:00Z',
      }),
    )
    renderPage()
    await settleInitialLoad()

    vi.useFakeTimers()
    try {
      fireEvent.change(titleInput(), {
        target: { value: 'Alpha v2' },
      })
      await flushDebounce()
      await act(async () => {})
    } finally {
      vi.useRealTimers()
    }

    const updatedLabel = `Updated ${formatNoteUpdatedDate(
      '2026-09-30T09:00:00Z',
    )}`
    expect(screen.getByText(updatedLabel)).toBeInTheDocument()
    expect(
      rowByTitle('Alpha v2').textContent,
    ).toContain(formatNoteUpdatedDate('2026-09-30T09:00:00Z'))
  })

  it('has no explicit Save button anywhere in the page', async () => {
    renderPage()
    await settleInitialLoad()

    expect(
      screen.queryByRole('button', {
        name: /^save$/i,
      }),
    ).not.toBeInTheDocument()
  })

  it('moves a saved note to the front in the plain active list (canonical recency) and keeps the selection stable', async () => {
    vi.mocked(updatePersonalNote).mockImplementation(
      async (id, input) => ({
        ...KNOWN_NOTES[id],
        ...input,
        updatedAt: '2026-09-30T09:00:00Z',
      }),
    )
    renderPage()
    await settleInitialLoad()
    expect(rowTitles()).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
    ])

    fireEvent.click(rowByTitle('Beta'))
    await waitFor(() =>
      expect(noteContent()).toHaveTextContent('Beta body'),
    )

    vi.useFakeTimers()
    try {
      fireEvent.change(titleInput(), {
        target: { value: 'Beta v2' },
      })
      await flushDebounce()
      await act(async () => {})
    } finally {
      vi.useRealTimers()
    }

    // The save bumped Beta's updatedAt → canonical recency puts it
    // FIRST, while the selection stays on Beta.
    expect(rowTitles()[0]).toBe('Beta v2')
    expect(rowByTitle('Beta v2')).toHaveAttribute(
      'aria-current',
      'true',
    )
  })

  it('replaces the saved entry in place while a search is active (no reordering mid-search)', async () => {
    renderPage(
      undefined,
      async (query?: string) =>
        query === 'am'
          ? [GAMMA, BETA]
          : Promise.resolve(DEFAULT_NOTES),
    )
    await settleInitialLoad()

    vi.useFakeTimers()
    try {
      fireEvent.change(searchInput(), {
        target: { value: 'am' },
      })
      await flushDebounce()
    } finally {
      vi.useRealTimers()
    }

    // Backend search order: Gamma first, Beta second.
    expect(rowTitles()).toEqual(['Gamma', 'Beta'])

    fireEvent.click(rowByTitle('Beta'))
    await waitFor(() =>
      expect(noteContent()).toHaveTextContent('Beta body'),
    )

    vi.useFakeTimers()
    try {
      fireEvent.change(titleInput(), {
        target: { value: 'Beta v2' },
      })
      await flushDebounce()
      await act(async () => {})
    } finally {
      vi.useRealTimers()
    }

    // Deliberate list-order handling: the entry is reconciled IN
    // PLACE — the backend's search order stays authoritative.
    expect(rowTitles()).toEqual(['Gamma', 'Beta v2'])
  })
})

/* ── Save race safety ─────────────────────────────────────────── */

describe('save race safety', () => {
  it('a slower response to an older draft can never overwrite the newer local text', async () => {
    const older = deferred<ApiPersonalNote>()
    const newer = deferred<ApiPersonalNote>()
    vi.mocked(updatePersonalNote).mockImplementation(
      async (_id, input) =>
        input.content === 'draft A'
          ? older.promise
          : newer.promise,
    )
    renderPage()
    await settleInitialLoad()

    vi.useFakeTimers()
    try {
      // draft A → PATCH A
      fireEvent.change(contentInput(), {
        target: { value: 'draft A' },
      })
      await flushDebounce()
      expect(updatePersonalNote).toHaveBeenCalledTimes(1)

      // user types more → draft B → PATCH B
      fireEvent.change(contentInput(), {
        target: { value: 'draft AB' },
      })
      await flushDebounce()
      expect(updatePersonalNote).toHaveBeenCalledTimes(2)

      // PATCH B resolves first…
      newer.resolve({
        ...ALPHA,
        content: 'draft AB',
        updatedAt: '2026-09-29T10:00:00Z',
      })
      await act(async () => {})
      expect(noteContent()).toHaveTextContent('draft AB')

      // …PATCH A (the OLDER draft) resolves LAST — dropped.
      older.resolve({
        ...ALPHA,
        content: 'draft A',
        updatedAt: '2026-09-29T09:30:00Z',
      })
      await act(async () => {})
    } finally {
      vi.useRealTimers()
    }

    // Final visible state stays at B — never reverts to A.
    expect(noteContent()).toHaveTextContent('draft AB')
    expect(richMarkdownEditor.lastProps).toMatchObject({
      value: 'draft AB',
    })
  })

  it('out-of-order PATCH responses cannot regress the acknowledged state', async () => {
    const older = deferred<ApiPersonalNote>()
    const newer = deferred<ApiPersonalNote>()
    vi.mocked(updatePersonalNote).mockImplementation(
      async (_id, input) =>
        input.title === 'Older title'
          ? older.promise
          : newer.promise,
    )
    renderPage()
    await settleInitialLoad()

    vi.useFakeTimers()
    try {
      fireEvent.change(titleInput(), {
        target: { value: 'Older title' },
      })
      await flushDebounce()

      fireEvent.change(titleInput(), {
        target: { value: 'Newer title' },
      })
      await flushDebounce()

      // Newer resolves first (acknowledged)…
      newer.resolve({
        ...ALPHA,
        title: 'Newer title',
        updatedAt: '2026-09-30T09:00:00Z',
      })
      await act(async () => {})

      // …older resolves last — it must not regress the row
      // metadata or the title.
      older.resolve({
        ...ALPHA,
        title: 'Older title',
        updatedAt: '2026-09-29T09:30:00Z',
      })
      await act(async () => {})
    } finally {
      vi.useRealTimers()
    }

    expect(titleInput()).toHaveValue('Newer title')
    expect(rowTitles()[0]).toBe('Newer title')
    // Acknowledged updatedAt is the NEWER save's.
    expect(
      screen.getByText(
        `Updated ${formatNoteUpdatedDate('2026-09-30T09:00:00Z')}`,
      ),
    ).toBeInTheDocument()
  })

  it('a save for note A cannot mutate the selected note B', async () => {
    const aSave = deferred<ApiPersonalNote>()
    vi.mocked(updatePersonalNote).mockImplementation(
      async (id, input) => {
        if (id === 1) {
          return aSave.promise
        }

        return {
          ...KNOWN_NOTES[id],
          ...input,
          updatedAt: '2026-09-29T11:00:00Z',
        }
      },
    )
    renderPage()
    await settleInitialLoad()

    vi.useFakeTimers()
    try {
      // A (selected) becomes dirty…
      fireEvent.change(contentInput(), {
        target: { value: 'Alpha dirty' },
      })
      // …and the user switches to B: A's draft is flushed
      // immediately (no debounce), selection changes without
      // waiting for the network.
      fireEvent.click(rowByTitle('Beta'))
      await act(async () => {})

      expect(updatePersonalNote).toHaveBeenCalledTimes(1)
      expect(updatePersonalNote).toHaveBeenLastCalledWith(
        1,
        { content: 'Alpha dirty' },
      )
      // B's surface shows B — never A's draft.
      expect(noteContent()).toHaveTextContent('Beta body')
      expect(titleInput()).toHaveValue('Beta')

      // Edit B while A's save is still in flight…
      fireEvent.change(contentInput(), {
        target: { value: 'Beta dirty' },
      })

      // A's save resolves — it may update ONLY A.
      aSave.resolve({
        ...ALPHA,
        content: 'Alpha dirty',
        updatedAt: '2026-09-30T09:00:00Z',
      })
      await act(async () => {})

      // B's draft is untouched…
      expect(noteContent()).toHaveTextContent('Beta dirty')
      expect(titleInput()).toHaveValue('Beta')
      // …A's row is updated and A moved first (plain-list
      // canonical recency)…
      expect(rowTitles()[0]).toBe('Alpha')
      // …and B's own autosave proceeds independently with B's
      // draft.
      await flushDebounce()
      await act(async () => {})
      expect(updatePersonalNote).toHaveBeenLastCalledWith(
        2,
        { content: 'Beta dirty' },
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('switching A → B with A dirty does not lose A\'s draft', async () => {
    vi.mocked(updatePersonalNote).mockImplementation(
      () => deferred<ApiPersonalNote>().promise,
    )
    renderPage()
    await settleInitialLoad()

    vi.useFakeTimers()
    try {
      fireEvent.change(titleInput(), {
        target: { value: 'Alpha in progress' },
      })

      // Switch before the debounce fires — the latest draft is
      // flushed immediately.
      fireEvent.click(rowByTitle('Beta'))
      await act(async () => {})
    } finally {
      vi.useRealTimers()
    }

    // A's latest draft was saved…
    expect(updatePersonalNote).toHaveBeenCalledWith(1, {
      title: 'Alpha in progress',
    })
    // …the list row reflects the local title immediately…
    expect(
      rowTitle(rowByTitle('Alpha in progress')),
    ).toBe('Alpha in progress')
    // …and B's surface shows B's own content — never A's draft.
    expect(noteContent()).toHaveTextContent('Beta body')
    expect(titleInput()).toHaveValue('Beta')
  })

  it('switching back to A before its save resolves still shows the latest local draft', async () => {
    const aSave = deferred<ApiPersonalNote>()
    vi.mocked(updatePersonalNote).mockImplementation(
      () => aSave.promise,
    )
    renderPage()
    await settleInitialLoad()

    vi.useFakeTimers()
    try {
      fireEvent.change(contentInput(), {
        target: { value: 'Alpha latest' },
      })
      // A → B (A's draft flushes, save in flight)…
      fireEvent.click(rowByTitle('Beta'))
      await act(async () => {})
      // …and straight back to A before the save resolves.
      fireEvent.click(rowByTitle('Alpha'))
      await act(async () => {})
    } finally {
      vi.useRealTimers()
    }

    // The LATEST local draft is shown, not the stale canonical
    // content…
    expect(noteContent()).toHaveTextContent('Alpha latest')
    expect(richMarkdownEditor.lastProps).toMatchObject({
      value: 'Alpha latest',
    })
    // …and the in-flight save is NOT duplicated for the same
    // draft.
    expect(updatePersonalNote).toHaveBeenCalledTimes(1)

    // The eventual save response updates ONLY A.
    vi.useFakeTimers()
    try {
      await act(async () => {
        aSave.resolve({
          ...ALPHA,
          content: 'Alpha latest',
          updatedAt: '2026-09-29T10:00:00Z',
        })
      })
    } finally {
      vi.useRealTimers()
    }

    expect(noteContent()).toHaveTextContent('Alpha latest')
  })

  it('unmount performs the final flush without unsafe state writes afterwards', async () => {
    const gate = deferred<ApiPersonalNote>()
    vi.mocked(updatePersonalNote).mockImplementation(
      () => gate.promise,
    )
    const view = renderPage()
    await settleInitialLoad()

    fireEvent.change(contentInput(), {
      target: { value: 'Alpha before unmount' },
    })

    act(() => {
      view.unmount()
    })

    // The pending draft was flushed (latest content) before the
    // page went away…
    expect(updatePersonalNote).toHaveBeenCalledTimes(1)
    expect(updatePersonalNote).toHaveBeenLastCalledWith(1, {
      content: 'Alpha before unmount',
    })

    // …and the response resolving AFTER unmount performs no state
    // write (no crash, no re-render of the dead page).
    await act(async () => {
      gate.resolve({
        ...ALPHA,
        content: 'Alpha before unmount',
        updatedAt: '2026-09-29T10:00:00Z',
      })
    })
    expect(updatePersonalNote).toHaveBeenCalledTimes(1)
  })
})

/* ── Save failure ─────────────────────────────────────────────── */

describe('save failure', () => {
  it('keeps the local draft intact and shows a quiet error state', async () => {
    vi.mocked(updatePersonalNote).mockRejectedValue(
      new ApiError(500, { error: 'Save exploded.' }),
    )
    renderPage()
    await settleInitialLoad()

    vi.useFakeTimers()
    try {
      fireEvent.change(contentInput(), {
        target: { value: 'Alpha kept' },
      })
      await flushDebounce()
      await act(async () => {})
    } finally {
      vi.useRealTimers()
    }

    // The error is visible, non-destructive…
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent("Couldn't save.")
    expect(alert).toHaveTextContent('Save exploded.')
    // …the draft is intact (no revert to the old server text)…
    expect(noteContent()).toHaveTextContent('Alpha kept')
    expect(contentInput()).toHaveValue('Alpha kept')
    expect(richMarkdownEditor.lastProps).toMatchObject({
      value: 'Alpha kept',
    })
    // …the list row keeps the local title/content truth.
    expect(rowTitles()[0]).toBe('Alpha')
  })

  it('a later edit saves successfully and clears the error', async () => {
    let attempts = 0
    vi.mocked(updatePersonalNote).mockImplementation(
      async (id, input) => {
        attempts += 1
        if (attempts === 1) {
          throw new ApiError(500, {
            error: 'Save exploded.',
          })
        }

        return {
          ...KNOWN_NOTES[id],
          ...input,
          updatedAt: '2026-09-29T10:00:00Z',
        }
      },
    )
    renderPage()
    await settleInitialLoad()

    vi.useFakeTimers()
    try {
      fireEvent.change(contentInput(), {
        target: { value: 'Alpha kept' },
      })
      await flushDebounce()
      await act(async () => {})
    } finally {
      vi.useRealTimers()
    }

    expect(screen.getByRole('alert')).toHaveTextContent(
      "Couldn't save.",
    )

    // A later edit reschedules the save (no retry storm — exactly
    // one new PATCH).
    vi.useFakeTimers()
    try {
      fireEvent.change(contentInput(), {
        target: { value: 'Alpha kept v2' },
      })
      await flushDebounce()
      await act(async () => {})
    } finally {
      vi.useRealTimers()
    }

    expect(updatePersonalNote).toHaveBeenCalledTimes(2)
    expect(
      screen.queryByRole('alert'),
    ).not.toBeInTheDocument()
    expect(noteContent()).toHaveTextContent('Alpha kept v2')
    expect(screen.getByRole('status')).toHaveTextContent(
      'Saved',
    )
  })

  it('Retry saves the preserved draft and clears the error', async () => {
    let attempts = 0
    vi.mocked(updatePersonalNote).mockImplementation(
      async (id, input) => {
        attempts += 1
        if (attempts === 1) {
          throw new ApiError(500, {
            error: 'Save exploded.',
          })
        }

        return {
          ...KNOWN_NOTES[id],
          ...input,
          updatedAt: '2026-09-29T10:00:00Z',
        }
      },
    )
    renderPage()
    await settleInitialLoad()

    vi.useFakeTimers()
    try {
      fireEvent.change(contentInput(), {
        target: { value: 'Alpha kept' },
      })
      await flushDebounce()
      await act(async () => {})
    } finally {
      vi.useRealTimers()
    }

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent("Couldn't save.")

    fireEvent.click(
      within(alert).getByRole('button', {
        name: 'Retry',
      }),
    )

    await waitFor(() => {
      expect(
        screen.queryByRole('alert'),
      ).not.toBeInTheDocument()
    })

    expect(updatePersonalNote).toHaveBeenCalledTimes(2)
    expect(noteContent()).toHaveTextContent('Alpha kept')
    expect(screen.getByRole('status')).toHaveTextContent(
      'Saved',
    )
  })
})

/* ── Search interaction with saving ───────────────────────────── */

describe('search interaction', () => {
  it('a search response cannot clobber a newer local draft of the matching note', async () => {
    const saveGate = deferred<ApiPersonalNote>()
    const searchGate = deferred<ApiPersonalNote[]>()
    vi.mocked(listPersonalNotes).mockImplementation(
      async (query?: string) => {
        if (query === 'alpha') {
          return searchGate.promise
        }

        return Promise.resolve(DEFAULT_NOTES)
      },
    )
    vi.mocked(updatePersonalNote).mockImplementation(
      async () => saveGate.promise,
    )
    renderPage()
    await settleInitialLoad()

    vi.useFakeTimers()
    try {
      // The user's draft is NEWER than what the (stale) search
      // will return.
      fireEvent.change(contentInput(), {
        target: {
          value: 'Alpha body, editing',
        },
      })
      fireEvent.change(searchInput(), {
        target: { value: 'alpha' },
      })
      // Both 300 ms windows come due: the autosave PATCH goes out,
      // then the search request.
      await flushDebounce()
      expect(updatePersonalNote).toHaveBeenCalledTimes(1)

      // The stale search response arrives — it must not replace
      // the newer local draft.
      searchGate.resolve([
        { ...ALPHA, content: 'Alpha body' },
      ])
      await act(async () => {})

      expect(noteContent()).toHaveTextContent(
        'Alpha body, editing',
      )

      // The save acknowledges — then an even LATER stale search
      // must not clobber the ACKNOWLEDGED state either.
      saveGate.resolve({
        ...ALPHA,
        content: 'Alpha body, editing',
        updatedAt: '2026-09-29T09:30:00Z',
      })
      await act(async () => {})
    } finally {
      vi.useRealTimers()
    }

    vi.useFakeTimers()
    try {
      const staleAgain = deferred<ApiPersonalNote[]>()
      vi.mocked(listPersonalNotes).mockImplementation(
        async (query?: string) => {
          if (query === 'alph') {
            return staleAgain.promise
          }

          return Promise.resolve(DEFAULT_NOTES)
        },
      )

      fireEvent.change(searchInput(), {
        target: { value: 'alph' },
      })
      await flushDebounce()
      staleAgain.resolve([
        {
          ...ALPHA,
          content: 'Alpha body',
          updatedAt: '2026-09-29T08:59:00Z',
        },
      ])
      await act(async () => {})
    } finally {
      vi.useRealTimers()
    }

    // The acknowledged save survived both stale search responses.
    expect(noteContent()).toHaveTextContent(
      'Alpha body, editing',
    )
    expect(richMarkdownEditor.lastProps).toMatchObject({
      value: 'Alpha body, editing',
    })
    expect(
      screen.getByText(
        `Updated ${formatNoteUpdatedDate('2026-09-29T09:30:00Z')}`,
      ),
    ).toBeInTheDocument()
  })

  it('completes a pending save when a search drops the selected note (no data loss)', async () => {
    const saveGate = deferred<ApiPersonalNote>()
    const searchGate = deferred<ApiPersonalNote[]>()
    vi.mocked(updatePersonalNote).mockImplementation(
      async (id, input) => {
        if (id === 1) {
          return saveGate.promise
        }

        return {
          ...KNOWN_NOTES[id],
          ...input,
          updatedAt: '2026-09-29T10:00:00Z',
        }
      },
    )
    renderPage(
      undefined,
      async (query?: string) => {
        if (query === 'miss') {
          return searchGate.promise
        }

        return Promise.resolve(DEFAULT_NOTES)
      },
    )
    await settleInitialLoad()

    vi.useFakeTimers()
    try {
      // Alpha (selected) becomes dirty, then a search arrives that
      // no longer matches it.
      fireEvent.change(contentInput(), {
        target: { value: 'Alpha dirty' },
      })
      fireEvent.change(searchInput(), {
        target: { value: 'miss' },
      })
      // Autosave flush + search request both come due at 300 ms.
      await flushDebounce()
      expect(updatePersonalNote).toHaveBeenCalledTimes(1)

      // The search result drops Alpha — the selection falls back
      // to the first result (Gamma)…
      searchGate.resolve([GAMMA])
      await act(async () => {})
      expect(noteContent()).toHaveTextContent('Gamma body')

      // …and Alpha's pending save completes SAFELY, updating only
      // Alpha — never the selected Gamma.
      saveGate.resolve({
        ...ALPHA,
        content: 'Alpha dirty',
        updatedAt: '2026-09-30T09:00:00Z',
      })
      await act(async () => {})
      expect(noteContent()).toHaveTextContent('Gamma body')
      expect(titleInput()).toHaveValue('Gamma')
    } finally {
      vi.useRealTimers()
    }

    // Clearing the search restores the ordinary active list…
    vi.useFakeTimers()
    try {
      fireEvent.change(searchInput(), {
        target: { value: '' },
      })
      await flushDebounce()
    } finally {
      vi.useRealTimers()
    }

    // …with Alpha's edit intact (no data loss).
    fireEvent.click(rowByTitle('Alpha'))
    await act(async () => {})
    expect(noteContent()).toHaveTextContent('Alpha dirty')
  })
})

/* ── Initial load ─────────────────────────────────────────────── */

describe('initial load', () => {
  it('performs exactly one initial active-list request without a query', async () => {
    renderPage()
    await settleInitialLoad()

    expect(listPersonalNotes).toHaveBeenCalledTimes(1)
    expect(listPersonalNotes).toHaveBeenCalledWith(
      undefined,
    )
  })

  it('shows a loading state while the initial request is pending, then renders the result', async () => {
    let resolveInitial!: (
      value: ApiPersonalNote[],
    ) => void

    renderPage(
      [],
      () =>
        new Promise<ApiPersonalNote[]>((resolve) => {
          resolveInitial = resolve
        }),
    )

    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Loading notes…')
    expect(listPersonalNotes).toHaveBeenCalledTimes(1)
    // Nothing selected yet — no fake note in the writing surface.
    expect(
      screen.queryByTestId('note-content'),
    ).not.toBeInTheDocument()

    resolveInitial([ALPHA])
    await screen.findByRole('button', {
      name: rowNamePrefix('Alpha'),
    })

    expect(
      screen.queryByRole('status'),
    ).not.toBeInTheDocument()
    expect(noteContent()).toHaveTextContent('Alpha body')
    expect(titleInput()).toHaveValue('Alpha')
  })

  it('preserves the backend order (never re-sorts client-side)', async () => {
    // Deliberately OUT of canonical updated_at order: the first
    // returned item is the OLDER one. A client-side re-sort by
    // recency would flip these — the page must render the backend
    // order as given.
    const older = note({
      id: 11,
      title: 'Order A',
      content: 'a',
      updatedAt: '2026-09-20T08:00:00Z',
    })
    const newer = note({
      id: 12,
      title: 'Order B',
      content: 'b',
      updatedAt: '2026-09-29T09:00:00Z',
    })
    renderPage([older, newer])
    await settleInitialLoad()

    expect(rowTitles()).toEqual(['Order A', 'Order B'])
  })

  it('automatically selects the first note returned by the backend', async () => {
    renderPage()
    await settleInitialLoad()

    expect(rowByTitle('Alpha')).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(noteContent()).toHaveTextContent('Alpha body')
    expect(titleInput()).toHaveValue('Alpha')
  })

  it('shows a restrained empty state that still offers creation', async () => {
    renderPage([])
    await settleInitialLoad()

    expect(screen.getByText('No notes yet.')).toBeInTheDocument()
    // No fake selected note…
    expect(
      screen.getByText('Select a note to read it.'),
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('note-content'),
    ).not.toBeInTheDocument()
    // …but the create path is visible and usable.
    expect(newNoteButton()).toBeInTheDocument()
    expect(newNoteButton()).toBeEnabled()
  })

  it('issues no per-note detail requests when the collection already carries the full note', async () => {
    renderPage()
    await settleInitialLoad()

    expect(getPersonalNote).not.toHaveBeenCalled()
    expect(listPersonalNotes).toHaveBeenCalledTimes(1)
  })
})

/* ── Selection ────────────────────────────────────────────────── */

describe('selection', () => {
  it('selects a row locally on click', async () => {
    renderPage()
    await settleInitialLoad()

    fireEvent.click(rowByTitle('Gamma'))

    expect(rowByTitle('Gamma')).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(noteContent()).toHaveTextContent('Gamma body')
    expect(titleInput()).toHaveValue('Gamma')
  })

  it('changes the selection without any new network request', async () => {
    renderPage()
    await settleInitialLoad()

    fireEvent.click(rowByTitle('Beta'))
    await waitFor(() =>
      expect(noteContent()).toHaveTextContent('Beta body'),
    )

    expect(listPersonalNotes).toHaveBeenCalledTimes(1)
    expect(getPersonalNote).not.toHaveBeenCalled()
    // A clean previous note is NOT "saved back" on selection.
    expect(updatePersonalNote).not.toHaveBeenCalled()
  })

  it('renders untitled notes with a presentation fallback only', async () => {
    const untitled = note({
      id: 9,
      title: '',
      content: 'Untitled body',
    })
    renderPage([untitled, BETA])
    await settleInitialLoad()

    // List row AND writing surface use the fallback…
    expect(rowByTitle('Untitled')).toBeInTheDocument()
    expect(titleInput()).toHaveValue('')
    expect(titleInput()).toHaveAttribute(
      'placeholder',
      'Untitled',
    )
    // …while the stored title stays untouched (no update
    // request).
    expect(updatePersonalNote).not.toHaveBeenCalled()
  })

  it('conveys the selected row accessibly, not through color alone', async () => {
    renderPage([ALPHA, BETA])
    await settleInitialLoad()

    expect(rowByTitle('Alpha')).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(rowByTitle('Beta')).not.toHaveAttribute(
      'aria-current',
    )

    fireEvent.click(rowByTitle('Beta'))
    await waitFor(() =>
      expect(noteContent()).toHaveTextContent('Beta body'),
    )

    expect(rowByTitle('Beta')).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(rowByTitle('Alpha')).not.toHaveAttribute(
      'aria-current',
    )
  })
})

/* ── Search ───────────────────────────────────────────────────── */

describe('search', () => {
  it('calls listPersonalNotes with the typed query only after the debounce', async () => {
    renderPage(
      undefined,
      async (query?: string) =>
        query === 'alp' ? [ALPHA] : DEFAULT_NOTES,
    )
    await settleInitialLoad()
    expect(listPersonalNotes).toHaveBeenCalledTimes(1)

    vi.useFakeTimers()
    try {
      fireEvent.change(searchInput(), {
        target: { value: 'alp' },
      })
      // Still within the debounce window: no new request yet.
      expect(listPersonalNotes).toHaveBeenCalledTimes(1)

      await act(async () => {
        vi.advanceTimersByTime(299)
      })
      expect(listPersonalNotes).toHaveBeenCalledTimes(1)

      await act(async () => {
        vi.advanceTimersByTime(1)
      })
      await act(async () => {})
    } finally {
      vi.useRealTimers()
    }

    expect(listPersonalNotes).toHaveBeenCalledTimes(2)
    expect(listPersonalNotes).toHaveBeenLastCalledWith(
      'alp',
    )
    // The backend result (only ALPHA) is what renders.
    expect(rowTitles()).toEqual(['Alpha'])
  })

  it('renders the backend result set verbatim (no client-side filtering)', async () => {
    // The query matches the CONTENT of GAMMA only — a client-side
    // title filter of the loaded list would hide it. The backend
    // result is authoritative: exactly what it returns renders.
    renderPage(
      undefined,
      async (query?: string) =>
        query === 'amma' ? [GAMMA] : DEFAULT_NOTES,
    )
    await settleInitialLoad()

    vi.useFakeTimers()
    try {
      fireEvent.change(searchInput(), {
        target: { value: 'amma' },
      })
      await flushDebounce()
    } finally {
      vi.useRealTimers()
    }

    expect(rowTitles()).toEqual(['Gamma'])
  })

  it('re-requests the ordinary active list when the query is cleared', async () => {
    renderPage(
      undefined,
      async (query?: string) =>
        query === 'alp' ? [ALPHA] : DEFAULT_NOTES,
    )
    await settleInitialLoad()

    vi.useFakeTimers()
    try {
      fireEvent.change(searchInput(), {
        target: { value: 'alp' },
      })
      await flushDebounce()
      expect(rowTitles()).toEqual(['Alpha'])

      fireEvent.change(searchInput(), {
        target: { value: '' },
      })
      await flushDebounce()
    } finally {
      vi.useRealTimers()
    }

    expect(listPersonalNotes).toHaveBeenLastCalledWith('')
    expect(rowTitles()).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
    ])
  })

  it('keeps the current selection when it still exists in the result', async () => {
    renderPage(
      undefined,
      async (query?: string) =>
        query === 'keep'
          ? [GAMMA, BETA, ALPHA]
          : DEFAULT_NOTES,
    )
    await settleInitialLoad()

    fireEvent.click(rowByTitle('Beta'))
    await waitFor(() =>
      expect(noteContent()).toHaveTextContent('Beta body'),
    )

    vi.useFakeTimers()
    try {
      fireEvent.change(searchInput(), {
        target: { value: 'keep' },
      })
      await flushDebounce()
    } finally {
      vi.useRealTimers()
    }

    // Backend order rendered (Gamma first) — but Beta stays
    // selected.
    expect(rowTitles()[0]).toBe('Gamma')
    expect(rowByTitle('Beta')).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(noteContent()).toHaveTextContent('Beta body')
  })

  it('falls back to the first result when the selection is gone', async () => {
    renderPage(
      undefined,
      async (query?: string) =>
        query === 'miss' ? [GAMMA, ALPHA] : DEFAULT_NOTES,
    )
    await settleInitialLoad()

    fireEvent.click(rowByTitle('Beta'))
    await waitFor(() =>
      expect(noteContent()).toHaveTextContent('Beta body'),
    )

    vi.useFakeTimers()
    try {
      fireEvent.change(searchInput(), {
        target: { value: 'miss' },
      })
      await flushDebounce()
    } finally {
      vi.useRealTimers()
    }

    expect(rowByTitle('Gamma')).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(noteContent()).toHaveTextContent('Gamma body')
  })

  it('clears the selection when the search has no results', async () => {
    renderPage(
      undefined,
      async (query?: string) =>
        query === 'nothing' ? [] : DEFAULT_NOTES,
    )
    await settleInitialLoad()

    fireEvent.click(rowByTitle('Beta'))
    await waitFor(() =>
      expect(noteContent()).toHaveTextContent('Beta body'),
    )

    vi.useFakeTimers()
    try {
      fireEvent.change(searchInput(), {
        target: { value: 'nothing' },
      })
      await flushDebounce()
    } finally {
      vi.useRealTimers()
    }

    // No note rows at all (the navigator's New-note action is a
    // region resident, not a row).
    expect(
      within(listRegion()).queryAllByRole('listitem'),
    ).toHaveLength(0)
    expect(
      screen.queryByRole('button', {
        name: /Beta|Alpha|Gamma/,
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText('No notes match "nothing".'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Select a note to read it.'),
    ).toBeInTheDocument()
  })

  it('never lets a stale slower response overwrite a newer search result', async () => {
    let resolveSlow!: (value: ApiPersonalNote[]) => void

    renderPage(
      undefined,
      (query?: string) => {
        if (query === 'slow') {
          return new Promise<ApiPersonalNote[]>((resolve) => {
            resolveSlow = resolve
          })
        }

        if (query === 'fast') {
          return Promise.resolve([GAMMA])
        }

        return Promise.resolve(DEFAULT_NOTES)
      },
    )
    await settleInitialLoad()

    vi.useFakeTimers()
    try {
      // First search goes out and stays pending…
      fireEvent.change(searchInput(), {
        target: { value: 'slow' },
      })
      await flushDebounce()
      expect(listPersonalNotes).toHaveBeenLastCalledWith(
        'slow',
      )

      // …while a newer search completes.
      fireEvent.change(searchInput(), {
        target: { value: 'fast' },
      })
      await flushDebounce()

      expect(rowTitles()).toEqual(['Gamma'])

      // The stale response arrives LATE — it must be dropped.
      resolveSlow([ALPHA, BETA])
      await act(async () => {})
    } finally {
      vi.useRealTimers()
    }

    expect(rowTitles()).toEqual(['Gamma'])
    expect(noteContent()).toHaveTextContent('Gamma body')
  })

  it('distinguishes "no notes exist" from "no notes match this search"', async () => {
    renderPage(undefined, async () => [])
    await settleInitialLoad()

    expect(screen.getByText('No notes yet.')).toBeInTheDocument()

    vi.useFakeTimers()
    try {
      fireEvent.change(searchInput(), {
        target: { value: 'anything' },
      })
      await flushDebounce()
    } finally {
      vi.useRealTimers()
    }

    expect(
      screen.getByText('No notes match "anything".'),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('No notes yet.'),
    ).not.toBeInTheDocument()
  })
})

/* ── Errors ───────────────────────────────────────────────────── */

describe('errors', () => {
  it('shows a page-local initial-load error with Retry', async () => {
    renderPage(
      undefined,
      () =>
        Promise.reject(
          new ApiError(500, { error: 'Server error.' }),
        ),
    )

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      "Notes couldn't be loaded",
    )
    expect(alert).toHaveTextContent('Server error.')
    expect(
      screen.getByRole('button', { name: 'Try again' }),
    ).toBeInTheDocument()
  })

  it('repeats the active list request on Retry', async () => {
    let attempts = 0

    renderPage(
      undefined,
      () => {
        attempts += 1
        if (attempts === 1) {
          return Promise.reject(
            new ApiError(500, { error: 'Server error.' }),
          )
        }

        return Promise.resolve([ALPHA])
      },
    )

    await screen.findByRole('alert')
    fireEvent.click(
      screen.getByRole('button', { name: 'Try again' }),
    )
    await screen.findByRole('button', {
      name: rowNamePrefix('Alpha'),
    })

    expect(listPersonalNotes).toHaveBeenCalledTimes(2)
    expect(
      screen.queryByRole('alert'),
    ).not.toBeInTheDocument()
  })

  it('keeps the page and the last result set on a search failure', async () => {
    renderPage(
      undefined,
      async (query?: string) => {
        if (query === 'bad') {
          throw new ApiError(500, {
            error: 'Search exploded.',
          })
        }

        return DEFAULT_NOTES
      },
    )
    await settleInitialLoad()

    vi.useFakeTimers()
    try {
      fireEvent.change(searchInput(), {
        target: { value: 'bad' },
      })
      await flushDebounce()
    } finally {
      vi.useRealTimers()
    }

    // The last successful result set is preserved (rows are scoped
    // to the list itself — the search-error Retry button lives in
    // the same section but outside the list).
    const rows = selectionButtonsIn(
      within(listRegion()).getByRole('list'),
    )
    expect(rows.map(rowTitle)).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
    ])
    expect(noteContent()).toHaveTextContent('Alpha body')
    // Header, create action, and search remain intact…
    expect(
      screen.getByRole('heading', { name: 'Notes', level: 1 }),
    ).toBeInTheDocument()
    expect(newNoteButton()).toBeInTheDocument()
    expect(searchInput()).toBeInTheDocument()
    // …and the failure is compact + retryable.
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Search failed.')
    expect(alert).toHaveTextContent('Search exploded.')
    expect(
      within(alert).getByRole('button', { name: 'Retry' }),
    ).toBeInTheDocument()
  })
})

/* ── StrictMode lifecycle ─────────────────────── ───── */

describe('StrictMode lifecycle', () => {
  it('settles to the empty state when the initial response is [] (no permanent skeleton)', async () => {
    renderStrictPage([])

    await screen.findByText('No notes yet.')

    // The loading status is gone — the skeleton did NOT persist.
    expect(
      screen.queryByRole('status'),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText('Select a note to read it.'),
    ).toBeInTheDocument()

    // Exactly the StrictMode dev replay of the single mount Effect
    // (one request in production, pinned by the non-StrictMode
    // test above): both request the ordinary active list, and NO
    // spurious third request (e.g. a replayed empty search) exists.
    expect(listPersonalNotes).toHaveBeenCalledTimes(2)
    expect(
      listPersonalNotes,
    ).toHaveBeenNthCalledWith(1, undefined)
    expect(
      listPersonalNotes,
    ).toHaveBeenNthCalledWith(2, undefined)
  })

  it('renders notes and selects the first note under StrictMode', async () => {
    renderStrictPage([ALPHA, BETA])

    await screen.findByRole('button', {
      name: rowNamePrefix('Alpha'),
    })

    expect(rowByTitle('Alpha')).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(noteContent()).toHaveTextContent('Alpha body')
    expect(titleInput()).toHaveValue('Alpha')
  })

  it('lets no stale replayed request overwrite the live render', async () => {
    let resolveFirst!: (value: ApiPersonalNote[]) => void

    renderStrictPage(
      undefined,
      () => {
        // The first mount Effect instance's request stays
        // pending…
        if (
          vi
            .mocked(listPersonalNotes)
            .mock.calls.length === 1
        ) {
          return new Promise<ApiPersonalNote[]>(
            (resolve) => {
              resolveFirst = resolve
            },
          )
        }

        // …the replayed instance's request settles with the
        // live set.
        return Promise.resolve([GAMMA])
      },
    )

    await screen.findByRole('button', {
      name: rowNamePrefix('Gamma'),
    })

    // The stale first response arrives LATE — it must be
    // dropped.
    resolveFirst([ALPHA])
    await act(async () => {})

    const rows = selectionButtonsIn(
      within(listRegion()).getByRole('list'),
    )
    expect(rows.map(rowTitle)).toEqual(['Gamma'])
    expect(noteContent()).toHaveTextContent('Gamma body')
  })

  it('keeps ordinary search race protection under StrictMode', async () => {
    let resolveSlow!: (value: ApiPersonalNote[]) => void

    renderStrictPage(
      undefined,
      (query?: string) => {
        if (query === 'slow') {
          return new Promise<ApiPersonalNote[]>(
            (resolve) => {
              resolveSlow = resolve
            },
          )
        }

        if (query === 'fast') {
          return Promise.resolve([GAMMA])
        }

        return Promise.resolve(DEFAULT_NOTES)
      },
    )
    await settleInitialLoad()

    vi.useFakeTimers()
    try {
      fireEvent.change(searchInput(), {
        target: { value: 'slow' },
      })
      await flushDebounce()
      fireEvent.change(searchInput(), {
        target: { value: 'fast' },
      })
      await flushDebounce()

      const rowsAfterFast = selectionButtonsIn(
        within(listRegion()).getByRole('list'),
      )
      expect(rowsAfterFast.map(rowTitle)).toEqual(
        ['Gamma'],
      )

      // The stale search response arrives LATE — dropped.
      resolveSlow([ALPHA, BETA])
      await act(async () => {})
    } finally {
      vi.useRealTimers()
    }

    const rowsAfterStale = selectionButtonsIn(
      within(listRegion()).getByRole('list'),
    )
    expect(rowsAfterStale.map(rowTitle)).toEqual(['Gamma'])
    expect(noteContent()).toHaveTextContent('Gamma body')
  })
})

/* ── Editable rendering ────────────────────────────────────────── */

describe('editable rendering', () => {
  it('renders the selected note as a writing surface (title + editor), not a read-only card', async () => {
    renderPage()
    await settleInitialLoad()

    // The title is an editable, explicitly labeled input.
    const title = titleInput()
    expect(title).toBeInTheDocument()
    expect(title).toHaveValue('Alpha')
    expect(
      title.getAttribute('aria-label'),
    ).toBe('Note title')

    // The content is the canonical editor, editable, with an
    // explicit label and a quiet placeholder.
    const content = contentInput()
    expect(content).toBeInTheDocument()
    expect(
      content.getAttribute('aria-label'),
    ).toBe('Note content')
    expect(content).toHaveAttribute(
      'placeholder',
      'Start writing…',
    )

    // The formatting toolbar is contextual (secondary, while
    // editing): the selection bubble toolbar is present…
    expect(
      screen.getByRole('toolbar', {
        name: 'Selection formatting',
      }),
    ).toBeInTheDocument()
    // …and NO permanent bottom toolbar sits under the document…
    expect(
      screen.queryByRole('toolbar', {
        name: 'Formatting',
      }),
    ).not.toBeInTheDocument()
    // …and the only other buttons are the note rows + the create
    // action.
    expect(rowButtons()).toHaveLength(DEFAULT_NOTES.length)
  })

  it('shows an editable empty editor with a quiet placeholder for empty content', async () => {
    const empty = note({
      id: 5,
      title: 'Empty',
      content: '',
    })
    renderPage([empty])
    await settleInitialLoad()

    // The editor IS mounted (editable, empty) — no read-only
    // "no content" state…
    expect(noteContent()).toBeInTheDocument()
    expect(noteContent()).toHaveTextContent('')
    expect(noteContent()).toHaveAttribute(
      'data-editable',
      'true',
    )
    expect(
      screen.queryByText('This note has no content.'),
    ).not.toBeInTheDocument()
    expect(contentInput()).toHaveValue('')
    expect(contentInput()).toHaveAttribute(
      'placeholder',
      'Start writing…',
    )
    // …and nothing is fabricated or persisted.
    expect(richMarkdownEditor.lastProps).toMatchObject({
      value: '',
    })
    expect(updatePersonalNote).not.toHaveBeenCalled()
  })

  it('mounts no read-only editor mode or duplicate surface', async () => {
    renderPage()
    await settleInitialLoad()

    expect(richMarkdownEditor.lastProps).toMatchObject({
      variant: 'full',
    })
    expect(
      richMarkdownEditor.lastProps?.readOnly,
    ).toBeFalsy()
    // One editor surface per selected note.
    expect(screen.getAllByTestId('note-editor')).toHaveLength(
      1,
    )
  })

  it('introduces no second editor or Markdown implementation', () => {
    const source =
      notesPageSource

    // The page composes the single canonical editor…
    expect(source).toContain(
      "from '../../components/editor/RichMarkdownEditor'",
    )
    // …and never reaches for Tiptap or another Markdown library
    // itself.
    expect(source).not.toMatch(/@tiptap/)
    expect(source).not.toMatch(
      /react-markdown|marked|showdown|remark/,
    )
  })

  it('issues no pin/archive/restore/detail requests while browsing, and no save for clean notes', async () => {
    renderPage()
    await settleInitialLoad()

    fireEvent.click(rowByTitle('Beta'))
    await waitFor(() =>
      expect(noteContent()).toHaveTextContent('Beta body'),
    )

    vi.useFakeTimers()
    try {
      // A search round-trip as well.
      fireEvent.change(searchInput(), {
        target: { value: 'beta' },
      })
      await flushDebounce()
    } finally {
      vi.useRealTimers()
    }

    expect(createPersonalNote).not.toHaveBeenCalled()
    // No save for a note whose draft was never touched.
    expect(updatePersonalNote).not.toHaveBeenCalled()
    expect(setPersonalNotePinned).not.toHaveBeenCalled()
    expect(archivePersonalNote).not.toHaveBeenCalled()
    expect(restorePersonalNote).not.toHaveBeenCalled()
    expect(getPersonalNote).not.toHaveBeenCalled()
    expect(listArchivedPersonalNotes).not.toHaveBeenCalled()
  })
})

/* ── Document-first workspace (presentation contract) ─────────── */

describe('document-first workspace', () => {
  it('owns the Notes identity in the navigator (heading + create + search)', async () => {
    renderPage()
    await settleInitialLoad()

    const navigator = listRegion()
    // The Notes-level heading lives in the navigator…
    const heading = navigator.querySelector('h1')
    expect(heading).not.toBeNull()
    expect(heading).toHaveTextContent('Notes')
    // …together with the create action and the search field — one
    // control area, not a header above both columns.
    expect(navigator.contains(newNoteButton())).toBe(true)
    expect(navigator.contains(searchInput())).toBe(true)
  })

  it('keeps note rows keyboard-selectable inside the navigator', async () => {
    renderPage([ALPHA, BETA])
    await settleInitialLoad()

    // Native buttons: focusable + keyboard-activatable by
    // construction.
    rowButtons().forEach((row) =>
      expect(row.tagName).toBe('BUTTON'),
    )

    // Selection semantics unchanged.
    expect(rowByTitle('Alpha')).toHaveAttribute(
      'aria-current',
      'true',
    )
    fireEvent.click(rowByTitle('Beta'))
    await waitFor(() =>
      expect(noteContent()).toHaveTextContent('Beta body'),
    )
    expect(rowByTitle('Beta')).toHaveAttribute(
      'aria-current',
      'true',
    )
  })

  it('requests the contextual (bubble-only) toolbar for the Notes editor', async () => {
    renderPage()
    await settleInitialLoad()

    // The page composes the canonical editor in contextual mode…
    expect(richMarkdownEditor.lastProps).toMatchObject({
      variant: 'full',
      toolbarMode: 'contextual',
    })
    // …the selection bubble toolbar stays available in the
    // editable Notes editor…
    expect(
      screen.getByRole('toolbar', {
        name: 'Selection formatting',
      }),
    ).toBeInTheDocument()
    // …and no permanent bottom toolbar (with its "Markdown
    // supported" copy) sits under the document.
    expect(
      screen.queryByRole('toolbar', {
        name: 'Formatting',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Markdown supported'),
    ).not.toBeInTheDocument()
  })

  it('fabricates no custom-property controls or fake metadata', async () => {
    renderPage()
    await settleInitialLoad()

    expect(
      screen.queryByRole('button', {
        name: /add property/i,
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(/property/i),
    ).not.toBeInTheDocument()
  })

  it('presents the selected note as a borderless document (no card panel)', async () => {
    renderPage()
    await settleInitialLoad()

    const region = screen.getByRole('region', {
      name: 'Selected note',
    })
    const article = screen.getByRole('article')

    // Neither the pane nor the document carries a card
    // treatment: no borders, no shadows.
    expect(region.className).not.toMatch(
      /border|shadow-/,
    )
    expect(article.className).not.toMatch(
      /border|shadow-/,
    )
    // The title stays a borderless, transparent input — no
    // resting form-field rectangle.
    expect(titleInput()).toHaveClass('bg-transparent')
  })

  it('keeps the zero-note state quiet with an obvious create path', async () => {
    renderPage([])
    await settleInitialLoad()

    // No dashed placeholder card — one quiet line of copy…
    expect(screen.getByText('Select a note to read it.')).toBeInTheDocument()
    expect(
      screen.queryByRole('region', {
        name: 'Selected note',
      }),
    ).not.toHaveClass('border-dashed')
    // …and the navigator still clearly offers New note.
    expect(newNoteButton()).toBeEnabled()
  })
})

/* ── Writing focus handoff (interaction contract) ─────────────── */

describe('writing focus handoff', () => {
  it('renders the title with the stronger document-title presentation', async () => {
    renderPage()
    await settleInitialLoad()

    const title = titleInput()
    // The document title carries the strongest type in the
    // pane; the empty placeholder matches its weight so it
    // never reads as small, weak text.
    expect(title).toHaveClass('text-[34px]')
    expect(title).toHaveClass('font-semibold')
    // …still a borderless, transparent surface — no form-field
    // chrome.
    expect(title).toHaveClass('bg-transparent')
    expect(title.className).not.toMatch(/border-/)
  })

  it('Enter in the title prevents the default and hands focus to the editor', async () => {
    renderPage()
    await settleInitialLoad()

    const title = titleInput()
    title.focus()
    expect(title).toHaveFocus()

    const seen: KeyboardEvent[] = []
    title.addEventListener('keydown', (event) =>
      seen.push(event),
    )

    fireEvent.keyDown(title, { key: 'Enter' })

    // No newline, no submit: the default is suppressed…
    expect(seen).toHaveLength(1)
    expect(seen[0].defaultPrevented).toBe(true)
    // …the title value is untouched…
    expect(title).toHaveValue('Alpha')
    // …and the editor received the handoff — focused, caret at
    // the end of the document content.
    expect(richMarkdownEditor.focusEndCalls).toBe(1)
    const editor =
      contentInput() as HTMLTextAreaElement
    expect(editor).toHaveFocus()
    expect(editor.selectionStart).toBe(
      editor.value.length,
    )
    expect(editor.selectionEnd).toBe(
      editor.value.length,
    )
  })

  it('Enter in the title never creates a note', async () => {
    renderPage()
    await settleInitialLoad()

    const title = titleInput()
    title.focus()
    fireEvent.keyDown(title, { key: 'Enter' })

    expect(createPersonalNote).not.toHaveBeenCalled()
    expect(
      rowByTitle('Alpha'),
    ).toHaveAttribute('aria-current', 'true')
  })

  it('Enter in the title flushes the draft exactly once (no duplicate PATCH)', async () => {
    renderPage()
    await settleInitialLoad()

    vi.useFakeTimers()
    try {
      fireEvent.change(titleInput(), {
        target: { value: 'Alpha v2' },
      })
      const title = titleInput()
      title.focus()
      fireEvent.keyDown(title, { key: 'Enter' })
      await flushDebounce()
      await act(async () => {})
    } finally {
      vi.useRealTimers()
    }

    expect(updatePersonalNote).toHaveBeenCalledTimes(1)
    expect(updatePersonalNote).toHaveBeenCalledWith(
      1,
      { title: 'Alpha v2' },
    )
  })

  it('empty note: title → Enter → the editor is immediately writable', async () => {
    vi.mocked(createPersonalNote).mockResolvedValue(
      freshCreatedNote(),
    )
    renderPage([])
    await settleInitialLoad()

    fireEvent.click(newNoteButton())
    await screen.findByRole('button', {
      name: rowNamePrefix('Untitled'),
    })
    await waitFor(() =>
      expect(titleInput()).toHaveFocus(),
    )

    fireEvent.change(titleInput(), {
      target: { value: 'Fresh thought' },
    })
    fireEvent.keyDown(titleInput(), { key: 'Enter' })

    expect(contentInput()).toHaveFocus()
    // The empty editor is ready: editable, quiet placeholder.
    expect(noteContent()).toHaveAttribute(
      'data-editable',
      'true',
    )
    expect(contentInput()).toHaveValue('')
    expect(contentInput()).toHaveAttribute(
      'placeholder',
      'Start writing…',
    )

    // …and typing lands in the document draft.
    fireEvent.change(contentInput(), {
      target: { value: 'First words.' },
    })
    expect(richMarkdownEditor.lastProps).toMatchObject({
      value: 'First words.',
    })
  })

  it('clicking free document surface focuses the editor at the end', async () => {
    renderPage()
    await settleInitialLoad()

    const article = screen.getByRole('article')

    // A genuine click (press, no movement, release) on the
    // article's own surface — not on a descendant.
    fireEvent.mouseDown(article, {
      clientX: 40,
      clientY: 200,
    })
    fireEvent.mouseUp(article, {
      clientX: 40,
      clientY: 200,
    })
    fireEvent.click(article, {
      clientX: 40,
      clientY: 200,
    })

    expect(richMarkdownEditor.focusEndCalls).toBe(1)
    const editor =
      contentInput() as HTMLTextAreaElement
    expect(editor).toHaveFocus()
    expect(editor.selectionStart).toBe(
      editor.value.length,
    )

    // …and below the writing column (the column container).
    const column =
      article.parentElement as HTMLElement
    fireEvent.mouseDown(column, {
      clientX: 40,
      clientY: 400,
    })
    fireEvent.mouseUp(column, {
      clientX: 40,
      clientY: 400,
    })
    fireEvent.click(column, {
      clientX: 40,
      clientY: 400,
    })
    expect(richMarkdownEditor.focusEndCalls).toBe(2)
  })

  it('clicks on title, editor content, and Retry keep their native behavior', async () => {
    renderPage()
    await settleInitialLoad()

    // Title input…
    fireEvent.click(titleInput())
    // …and editor content: no handoff.
    fireEvent.click(contentInput())
    expect(richMarkdownEditor.focusEndCalls).toBe(0)

    // With a failing save, the Retry control INSIDE the document
    // surface must still re-send the save…
    vi.mocked(updatePersonalNote).mockRejectedValue(
      new ApiError(500, {
        error: 'Save exploded.',
      }),
    )
    vi.useFakeTimers()
    try {
      fireEvent.change(contentInput(), {
        target: { value: 'Alpha kept' },
      })
      await flushDebounce()
      await act(async () => {})
    } finally {
      vi.useRealTimers()
    }

    const retry = screen.getByRole('button', {
      name: 'Retry',
    })
    fireEvent.click(retry)

    expect(updatePersonalNote).toHaveBeenCalledTimes(2)
    expect(richMarkdownEditor.focusEndCalls).toBe(0)
  })

  it('a press-drag-release (text selection) is never converted into the handoff', async () => {
    renderPage()
    await settleInitialLoad()

    const column =
      screen.getByRole('article').parentElement as HTMLElement

    // Press, drag across the surface, release — the browser's
    // synthetic click then lands on the surface itself.
    fireEvent.mouseDown(column, {
      clientX: 100,
      clientY: 100,
    })
    fireEvent.mouseUp(column, {
      clientX: 180,
      clientY: 100,
    })
    fireEvent.click(column, {
      clientX: 180,
      clientY: 100,
    })

    expect(richMarkdownEditor.focusEndCalls).toBe(0)
    expect(contentInput()).not.toHaveFocus()
  })
})

/* ── AppShell integration & structure ─────────────────────────── */

describe('AppShell integration', () => {
  it('renders /notes inside the authenticated AppShell with one Notes workspace (no second shell)', async () => {
    vi.mocked(listPersonalNotes).mockResolvedValue([ALPHA])
    vi.mocked(createPersonalNote).mockImplementation(
      async () => freshCreatedNote(),
    )

    render(
      <MemoryRouter initialEntries={['/notes']}>
        <App />
      </MemoryRouter>,
    )

    const heading = await screen.findByRole('heading', {
      name: 'Notes',
      level: 1,
    })

    // Exactly one app shell: one <main> (AppShell) and one <aside>
    // (the Sidebar) — the Notes page composes INSIDE it, it does not
    // bring a second shell of its own.
    expect(
      document.querySelectorAll('main'),
    ).toHaveLength(1)
    expect(
      document.querySelectorAll('aside'),
    ).toHaveLength(1)
    expect(document.querySelector('main')!.contains(heading)).toBe(
      true,
    )

    // The Personal navigation entry is live inside that Sidebar and
    // points at the unscoped /notes route.
    const notesLink = screen.getByRole('link', {
      name: /Notes/,
    })
    expect(notesLink).toHaveAttribute('href', '/notes')

    // The workspace itself rendered with its note.
    await screen.findByRole('button', {
      name: rowNamePrefix('Alpha'),
    })
    expect(noteContent()).toHaveTextContent('Alpha body')
  })
})

describe('layout structure', () => {
  it('is authored as one workspace that stacks on narrow widths without a fixed-width overflow dependency', async () => {
    renderPage()
    await settleInitialLoad()

    const rail = listRegion()
    const detail = screen.getByRole('region', {
      name: 'Selected note',
    })
    const workspace = rail.parentElement!

    // Structural proxy for "no horizontal document scroll": the two
    // columns are siblings of ONE flex container — stacked
    // (`flex-col`) by default, side-by-side only at the desktop
    // breakpoint — the rail is full-width when stacked (no hard
    // minimum width), and the detail column is `min-w-0` so long
    // note lines wrap instead of widening the document.
    expect(workspace.className).toContain('flex-col')
    expect(workspace.className).toContain('lg:flex-row')
    expect(rail.className).toContain('w-full')
    expect(detail.className).toContain('min-w-0')
  })
})

/* ── Presentation helpers ─────────────────────────────────────── */

describe('presentation helpers', () => {
  it('falls back to "Untitled" only for blank titles', () => {
    expect(
      displayNoteTitle(note({ id: 1, title: '', content: '' })),
    ).toBe('Untitled')
    expect(
      displayNoteTitle(
        note({ id: 1, title: '   ', content: '' }),
      ),
    ).toBe('Untitled')
    expect(
      displayNoteTitle(
        note({ id: 1, title: 'Real title', content: '' }),
      ),
    ).toBe('Real title')
  })

  it('formats the updated timestamp quietly (year only when older)', () => {
    const now = new Date()
    const thisYear = new Date(
      now.getFullYear(),
      8,
      29,
      9,
      0,
      0,
    )
    // Same calendar year: "Sep 29" — no year noise.
    expect(
      formatNoteUpdatedDate(thisYear.toISOString()),
    ).toBe('Sep 29')

    const older = new Date(
      now.getFullYear() - 1,
      8,
      29,
      9,
      0,
      0,
    )
    expect(
      formatNoteUpdatedDate(older.toISOString()),
    ).toBe('Sep 29, ' + String(now.getFullYear() - 1))

    expect(formatNoteUpdatedDate(null)).toBe('')
    expect(formatNoteUpdatedDate('not-a-date')).toBe('')
  })
})

/* ── Permanent delete: overflow menu ───────────────────────────── */

describe('permanent delete: overflow menu', () => {
  it('exposes one overflow action per rendered note, secondary to the row', async () => {
    renderPage()
    await settleInitialLoad()

    for (const title of ['Alpha', 'Beta', 'Gamma']) {
      const trigger = overflowTrigger(title)
      expect(trigger).toBeInTheDocument()
      expect(trigger).toHaveAttribute(
        'aria-haspopup',
        'menu',
      )
      expect(trigger).toHaveAttribute(
        'aria-expanded',
        'false',
      )
    }

    // Every rendered note gets its OWN trigger (three total —
    // one per row, none shared).
    expect(
      screen.getAllByRole('button', {
        name: /More actions for /,
      }),
    ).toHaveLength(DEFAULT_NOTES.length)
  })

  it('opening the menu does not select an unselected note', async () => {
    renderPage()
    await settleInitialLoad()

    expect(rowByTitle('Alpha')).toHaveAttribute(
      'aria-current',
      'true',
    )

    fireEvent.click(overflowTrigger('Beta'))
    const menu = screen.getByRole('menu')

    // The menu opened…
    expect(menu).toBeInTheDocument()
    expect(overflowTrigger('Beta')).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    // …but the selection never moved.
    expect(rowByTitle('Beta')).not.toHaveAttribute(
      'aria-current',
    )
    expect(rowByTitle('Alpha')).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(noteContent()).toHaveTextContent(
      'Alpha body',
    )
  })

  it('contains exactly one menu item: Delete note', async () => {
    renderPage()
    await settleInitialLoad()

    fireEvent.click(overflowTrigger('Alpha'))

    expect(
      screen.getAllByRole('menu'),
    ).toHaveLength(1)
    const items = screen.getAllByRole('menuitem')
    expect(items).toHaveLength(1)
    expect(items[0]).toHaveAccessibleName(
      'Delete note',
    )
  })

  it('closes on Escape and on an outside click', async () => {
    renderPage()
    await settleInitialLoad()

    // Escape closes.
    fireEvent.click(overflowTrigger('Alpha'))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(
      screen.queryByRole('menu'),
    ).not.toBeInTheDocument()
    expect(overflowTrigger('Alpha')).toHaveAttribute(
      'aria-expanded',
      'false',
    )

    // An outside click closes.
    fireEvent.click(overflowTrigger('Beta'))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.mouseDown(searchInput())
    expect(
      screen.queryByRole('menu'),
    ).not.toBeInTheDocument()
    expect(overflowTrigger('Beta')).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })

  it('keeps the trigger and the menu item keyboard-activatable', async () => {
    renderPage()
    await settleInitialLoad()

    // Native <button> elements: keyboard-activatable by
    // construction (the repository's convention for row
    // actions).
    const trigger = overflowTrigger('Gamma')
    expect(trigger.tagName).toBe('BUTTON')
    trigger.focus()
    expect(trigger).toHaveFocus()

    fireEvent.click(trigger)
    const item = screen.getByRole('menuitem', {
      name: 'Delete note',
    })
    expect(item.tagName).toBe('BUTTON')
    item.focus()
    expect(item).toHaveFocus()
  })

  it('renders the row as sibling buttons (no nested interactive controls)', async () => {
    renderPage()
    await settleInitialLoad()

    const items = within(listRegion()).getAllByRole('listitem')
    expect(items).toHaveLength(DEFAULT_NOTES.length)

    for (const item of items) {
      const buttons = within(item).getAllByRole('button')
      // Exactly two siblings: the selection button + the
      // overflow trigger.
      expect(buttons).toHaveLength(2)
      // No button is nested inside ANOTHER button.
      buttons.forEach((button) =>
        expect(
          button.parentElement?.closest('button'),
        ).toBeNull(),
      )
    }
  })

  it('keeps selection and overflow controls inside one row container', async () => {
    renderPage()
    await settleInitialLoad()

    const items = within(listRegion()).getAllByRole('listitem')

    for (const item of items) {
      const buttons = within(item).getAllByRole('button')
      // Both controls live inside a single direct child of the
      // <li> — the row container that owns the selected/hovered
      // surface. (The trigger additionally sits in the menu's
      // own non-interactive positioning wrapper.)
      const row = item.firstElementChild as HTMLElement
      expect(row).not.toBeNull()
      expect(row.contains(buttons[0]!)).toBe(true)
      expect(row.contains(buttons[1]!)).toBe(true)
      // Neither control is nested inside ANOTHER button.
      buttons.forEach((button) =>
        expect(button.parentElement?.closest('button')).toBeNull(),
      )
    }
  })
})

/* ── Permanent delete: confirmation ────────────────────────────── */

function dialogRegion() {
  return screen.getByRole('dialog')
}

function dialogButton(name: string) {
  return within(dialogRegion()).getByRole(
    'button',
    { name },
  )
}

async function openDeleteDialog(title: string) {
  fireEvent.click(overflowTrigger(title))
  fireEvent.click(
    screen.getByRole('menuitem', {
      name: 'Delete note',
    }),
  )
  await screen.findByRole('dialog')
}

describe('permanent delete: confirmation', () => {
  it('opens the confirmation from Delete note without issuing a DELETE yet', async () => {
    renderPage()
    await settleInitialLoad()

    fireEvent.click(overflowTrigger('Alpha'))
    fireEvent.click(
      screen.getByRole('menuitem', {
        name: 'Delete note',
      }),
    )
    const dialog = await screen.findByRole('dialog')

    // The menu closed; the confirmation is open with the exact
    // copy contract.
    expect(
      screen.queryByRole('menu'),
    ).not.toBeInTheDocument()
    expect(dialog).toHaveAccessibleName('Delete note?')
    expect(dialog).toHaveTextContent(
      'Permanently delete "Alpha"?',
    )
    expect(dialog).toHaveTextContent(
      "This can't be undone.",
    )
    // No DELETE request has been issued yet.
    expect(deletePersonalNote).not.toHaveBeenCalled()
  })

  it('Cancel performs no DELETE and keeps the note', async () => {
    renderPage()
    await settleInitialLoad()

    fireEvent.click(overflowTrigger('Alpha'))
    fireEvent.click(
      screen.getByRole('menuitem', {
        name: 'Delete note',
      }),
    )
    await screen.findByRole('dialog')
    fireEvent.click(dialogButton('Cancel'))

    expect(
      screen.queryByRole('dialog'),
    ).not.toBeInTheDocument()
    expect(deletePersonalNote).not.toHaveBeenCalled()
    expect(
      screen.queryByRole('button', {
        name: rowNamePrefix('Alpha'),
      }),
    ).toBeInTheDocument()
  })

  it('uses the Untitled fallback for an empty title', async () => {
    const untitled = note({
      id: 9,
      title: '',
      content: 'Untitled body',
    })
    renderPage([untitled])
    await settleInitialLoad()

    await openDeleteDialog('Untitled')
    expect(dialogRegion()).toHaveTextContent(
      'Permanently delete "Untitled"?',
    )
  })

  it('issues exactly one DELETE for one explicit confirmation', async () => {
    renderPage()
    await settleInitialLoad()

    await openDeleteDialog('Alpha')
    fireEvent.click(dialogButton('Delete'))

    await waitFor(() =>
      expect(
        screen.queryByRole('button', {
          name: rowNamePrefix('Alpha'),
        }),
      ).not.toBeInTheDocument(),
    )

    expect(deletePersonalNote).toHaveBeenCalledTimes(1)
    expect(deletePersonalNote).toHaveBeenCalledWith(1)
  })

  it('blocks duplicate confirmations while the delete is pending', async () => {
    const gate = deferred<void>()
    vi.mocked(deletePersonalNote).mockImplementation(
      () => gate.promise,
    )
    renderPage()
    await settleInitialLoad()

    await openDeleteDialog('Alpha')
    fireEvent.click(dialogButton('Delete'))
    expect(deletePersonalNote).toHaveBeenCalledTimes(1)

    // Pending: restrained "Deleting…" state and both actions
    // locked (no duplicate activation possible).
    const deleteButton = dialogButton('Deleting…')
    expect(deleteButton).toBeDisabled()
    expect(dialogButton('Cancel')).toBeDisabled()
    fireEvent.click(deleteButton)
    expect(deletePersonalNote).toHaveBeenCalledTimes(1)

    await act(async () => {
      gate.resolve()
    })
    expect(
      screen.queryByRole('dialog'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', {
        name: rowNamePrefix('Alpha'),
      }),
    ).not.toBeInTheDocument()
  })
})

/* ── Permanent delete: success reconciliation ──────────────────── */

describe('permanent delete: success reconciliation', () => {
  it('removes the row without any list refetch', async () => {
    renderPage()
    await settleInitialLoad()

    await openDeleteDialog('Alpha')
    fireEvent.click(dialogButton('Delete'))

    await waitFor(() =>
      expect(
        screen.queryByRole('button', {
          name: rowNamePrefix('Alpha'),
        }),
      ).not.toBeInTheDocument(),
    )

    // No refetch was required or performed to prove the delete.
    expect(listPersonalNotes).toHaveBeenCalledTimes(1)
    expect(rowTitles()).toEqual([
      'Beta',
      'Gamma',
    ])
  })

  it('deleting an unselected note preserves the current selection', async () => {
    renderPage()
    await settleInitialLoad()

    await openDeleteDialog('Beta')
    fireEvent.click(dialogButton('Delete'))

    await waitFor(() =>
      expect(
        screen.queryByRole('button', {
          name: rowNamePrefix('Beta'),
        }),
      ).not.toBeInTheDocument(),
    )

    expect(rowByTitle('Alpha')).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(noteContent()).toHaveTextContent(
      'Alpha body',
    )
    expect(titleInput()).toHaveValue('Alpha')
  })

  it('deleting the selected middle note selects the next row', async () => {
    renderPage()
    await settleInitialLoad()
    fireEvent.click(rowByTitle('Beta'))

    await openDeleteDialog('Beta')
    fireEvent.click(dialogButton('Delete'))

    await waitFor(() =>
      expect(
        screen.queryByRole('button', {
          name: rowNamePrefix('Beta'),
        }),
      ).not.toBeInTheDocument(),
    )

    expect(rowByTitle('Gamma')).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(noteContent()).toHaveTextContent(
      'Gamma body',
    )
  })

  it('deleting the selected final row selects the previous row', async () => {
    renderPage()
    await settleInitialLoad()
    fireEvent.click(rowByTitle('Gamma'))

    await openDeleteDialog('Gamma')
    fireEvent.click(dialogButton('Delete'))

    await waitFor(() =>
      expect(
        screen.queryByRole('button', {
          name: rowNamePrefix('Gamma'),
        }),
      ).not.toBeInTheDocument(),
    )

    expect(rowByTitle('Beta')).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(noteContent()).toHaveTextContent(
      'Beta body',
    )
  })

  it('deleting the only note lands in the quiet empty state', async () => {
    renderPage([ALPHA])
    await settleInitialLoad()

    await openDeleteDialog('Alpha')
    fireEvent.click(dialogButton('Delete'))

    await waitFor(() =>
      expect(
        screen.queryByRole('button', {
          name: rowNamePrefix('Alpha'),
        }),
      ).not.toBeInTheDocument(),
    )

    // Navigator + create path remain; the restrained empty
    // state is shown (no error, no broken editor surface).
    expect(
      screen.getByText('No notes yet.'),
    ).toBeInTheDocument()
    expect(newNoteButton()).toBeEnabled()
    expect(
      screen.getByText('Select a note to read it.'),
    ).toBeInTheDocument()
    // Focus moved to the sensible next action (New note). The
    // handoff is a passive effect after the reconciled commit —
    // the row-disappearance wait above proves the removal, not
    // the later focus handoff — so wait for it explicitly.
    await waitFor(() => expect(newNoteButton()).toHaveFocus())
  })

  it('keeps an active search query intact after deleting a result', async () => {
    renderPage(
      undefined,
      (query?: string) =>
        query === 'alph'
          ? Promise.resolve([ALPHA])
          : Promise.resolve(DEFAULT_NOTES),
    )
    await settleInitialLoad()

    vi.useFakeTimers()
    try {
      fireEvent.change(searchInput(), {
        target: { value: 'alph' },
      })
      await flushDebounce()
    } finally {
      vi.useRealTimers()
    }
    expect(rowTitles()).toEqual(['Alpha'])

    await openDeleteDialog('Alpha')
    fireEvent.click(dialogButton('Delete'))

    await waitFor(() =>
      expect(
        screen.queryByRole('button', {
          name: rowNamePrefix('Alpha'),
        }),
      ).not.toBeInTheDocument(),
    )

    // The query stays exactly as it was — no reset, no
    // re-request — and the search empty state explains the
    // (now empty) result set.
    expect(searchInput()).toHaveValue('alph')
    expect(listPersonalNotes).toHaveBeenCalledTimes(2)
    expect(
      screen.getByText('No notes match "alph".'),
    ).toBeInTheDocument()
  })

  it('lets no stale list/search response resurrect the deleted note', async () => {
    let resolveStale!: (value: ApiPersonalNote[]) => void

    renderPage(
      undefined,
      (query?: string) => {
        if (query === 'stale') {
          return new Promise<ApiPersonalNote[]>(
            (resolve) => {
              resolveStale = resolve
            },
          )
        }

        return Promise.resolve(DEFAULT_NOTES)
      },
    )
    await settleInitialLoad()

    // Issue a search whose response will arrive LATE (after the
    // delete) and still contain the doomed note.
    vi.useFakeTimers()
    try {
      fireEvent.change(searchInput(), {
        target: { value: 'stale' },
      })
      await flushDebounce()
    } finally {
      vi.useRealTimers()
    }

    await openDeleteDialog('Alpha')
    fireEvent.click(dialogButton('Delete'))
    await waitFor(() =>
      expect(
        screen.queryByRole('button', {
          name: rowNamePrefix('Alpha'),
        }),
      ).not.toBeInTheDocument(),
    )

    // The stale response (search mode) arrives — it must NOT
    // resurrect the deleted note.
    resolveStale([ALPHA])
    await act(async () => {})

    expect(
      screen.queryByRole('button', {
        name: rowNamePrefix('Alpha'),
      }),
    ).not.toBeInTheDocument()
  })
})

/* ── Permanent delete: autosave race safety ────────────────────── */

describe('permanent delete: autosave race safety', () => {
  it('lets no pending debounce send a new PATCH after confirmation', async () => {
    renderPage()
    await settleInitialLoad()

    vi.useFakeTimers()
    try {
      // Dirty draft waiting for its debounce (no PATCH yet).
      fireEvent.change(titleInput(), {
        target: { value: 'Alpha doomed' },
      })
      expect(updatePersonalNote).not.toHaveBeenCalled()

      // Open the menu + confirmation and confirm with
      // SYNCHRONOUS queries (async findBy polling cannot run on
      // the fake clock).
      fireEvent.click(overflowTrigger('Alpha doomed'))
      fireEvent.click(
        screen.getByRole('menuitem', {
          name: 'Delete note',
        }),
      )
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      fireEvent.click(dialogButton('Delete'))

      // The full debounce window elapses after the deletion is
      // confirmed: nothing may be sent for this note.
      await act(async () => {
        vi.advanceTimersByTime(500)
      })
      await act(async () => {})
    } finally {
      vi.useRealTimers()
    }

    expect(updatePersonalNote).not.toHaveBeenCalled()
    expect(deletePersonalNote).toHaveBeenCalledTimes(1)
    expect(
      screen.queryByRole('button', {
        name: rowNamePrefix('Alpha doomed'),
      }),
    ).not.toBeInTheDocument()
  })

  it('lets no stale PATCH success reinsert or overwrite after deletion', async () => {
    const staleSave = deferred<ApiPersonalNote>()
    vi.mocked(updatePersonalNote).mockImplementation(
      () => staleSave.promise,
    )
    renderPage()
    await settleInitialLoad()

    vi.useFakeTimers()
    try {
      fireEvent.change(titleInput(), {
        target: { value: 'Alpha stale save' },
      })
      await flushDebounce()
    } finally {
      vi.useRealTimers()
    }
    expect(updatePersonalNote).toHaveBeenCalledTimes(1)

    // Delete while that PATCH is still in flight.
    await openDeleteDialog('Alpha stale save')
    fireEvent.click(dialogButton('Delete'))
    await waitFor(() =>
      expect(
        screen.queryByRole('button', {
          name: rowNamePrefix('Alpha stale save'),
        }),
      ).not.toBeInTheDocument(),
    )

    // The stale PATCH SUCCEEDS late — it must not reinsert the
    // note or overwrite the surviving selection.
    staleSave.resolve({
      ...ALPHA,
      title: 'Alpha stale save',
      updatedAt: '2026-09-30T09:00:00Z',
    })
    await act(async () => {})

    expect(
      screen.queryByRole('button', {
        name: rowNamePrefix('Alpha stale save'),
      }),
    ).not.toBeInTheDocument()
    // Selection moved to the next row and shows ITS content.
    expect(rowByTitle('Beta')).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(noteContent()).toHaveTextContent(
      'Beta body',
    )
  })

  it('lets no stale PATCH failure surface a save error after a successful delete', async () => {
    const staleSave = deferred<ApiPersonalNote>()
    vi.mocked(updatePersonalNote).mockImplementation(
      () => staleSave.promise,
    )
    renderPage()
    await settleInitialLoad()

    vi.useFakeTimers()
    try {
      fireEvent.change(titleInput(), {
        target: { value: 'Alpha doomed save' },
      })
      await flushDebounce()
    } finally {
      vi.useRealTimers()
    }

    await openDeleteDialog('Alpha doomed save')
    fireEvent.click(dialogButton('Delete'))
    await waitFor(() =>
      expect(
        screen.queryByRole('button', {
          name: rowNamePrefix('Alpha doomed save'),
        }),
      ).not.toBeInTheDocument(),
    )

    // The stale PATCH FAILS late — no "Couldn't save" may appear
    // for a note the user already destroyed.
    staleSave.reject(new ApiError(500, {
      error: 'Save exploded.',
    }))
    await act(async () => {})

    expect(
      screen.queryByText("Couldn't save."),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', {
        name: rowNamePrefix('Alpha doomed save'),
      }),
    ).not.toBeInTheDocument()
  })

  it('keeps the note and its draft intact when the DELETE fails', async () => {
    const straggler = deferred<ApiPersonalNote>()
    vi.mocked(deletePersonalNote).mockRejectedValue(
      new ApiError(500, {
        error: 'Delete exploded.',
      }),
    )
    vi.mocked(updatePersonalNote).mockImplementation(
      () => straggler.promise,
    )
    renderPage()
    await settleInitialLoad()

    // A dirty draft exists (no flush before the dialog).
    fireEvent.change(titleInput(), {
      target: { value: 'Alpha keep me' },
    })

    await openDeleteDialog('Alpha keep me')
    fireEvent.click(dialogButton('Delete'))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'Delete exploded.',
    )

    // The note is still here with its draft intact…
    expect(
      screen.getByRole('button', {
        name: rowNamePrefix('Alpha keep me'),
      }),
    ).toBeInTheDocument()
    expect(titleInput()).toHaveValue(
      'Alpha keep me',
    )
    // …the dialog stayed open with the error (retryable), and
    // the delete was attempted exactly once.
    expect(dialogRegion()).toBeInTheDocument()
    expect(deletePersonalNote).toHaveBeenCalledTimes(1)

    // Settle the failure-path save flush (no save error may
    // appear for the acknowledged draft).
    straggler.resolve({
      ...ALPHA,
      title: 'Alpha keep me',
      updatedAt: '2026-09-30T09:00:00Z',
    })
    await act(async () => {})
    expect(
      screen.queryByText("Couldn't save."),
    ).not.toBeInTheDocument()
  })

  it('permits a retry after a failed DELETE', async () => {
    let attempts = 0
    vi.mocked(deletePersonalNote).mockImplementation(
      () => {
        attempts += 1
        if (attempts === 1) {
          throw new ApiError(500, {
            error: 'Delete exploded.',
          })
        }

        return Promise.resolve(undefined)
      },
    )
    renderPage()
    await settleInitialLoad()

    await openDeleteDialog('Alpha')
    fireEvent.click(dialogButton('Delete'))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'Delete exploded.',
    )

    // The destructive action is usable again (Retry).
    const deleteButton = dialogButton('Delete')
    expect(deleteButton).toBeEnabled()
    fireEvent.click(deleteButton)

    await waitFor(() =>
      expect(
        screen.queryByRole('button', {
          name: rowNamePrefix('Alpha'),
        }),
      ).not.toBeInTheDocument(),
    )

    expect(deletePersonalNote).toHaveBeenCalledTimes(2)
    expect(
      screen.queryByRole('dialog'),
    ).not.toBeInTheDocument()
  })

  it('lets autosave resume safely after a failed deletion', async () => {
    const resumeSave = deferred<ApiPersonalNote>()
    vi.mocked(deletePersonalNote).mockRejectedValue(
      new ApiError(500, {
        error: 'Delete exploded.',
      }),
    )
    vi.mocked(updatePersonalNote).mockImplementation(
      () => resumeSave.promise,
    )
    renderPage()
    await settleInitialLoad()

    // Dirty draft; the failed delete must not lose it — and
    // autosave must be able to resume.
    fireEvent.change(titleInput(), {
      target: { value: 'Alpha still here' },
    })

    await openDeleteDialog('Alpha still here')
    fireEvent.click(dialogButton('Delete'))
    await screen.findByRole('alert')

    // The failure path re-flushed the dirty draft (the canonical
    // save path — exactly the changed field).
    expect(updatePersonalNote).toHaveBeenCalledTimes(1)
    expect(updatePersonalNote).toHaveBeenCalledWith(1, {
      title: 'Alpha still here',
    })

    // The resumed save acknowledges without a save error.
    resumeSave.resolve({
      ...ALPHA,
      title: 'Alpha still here',
      updatedAt: '2026-09-30T09:00:00Z',
    })
    await act(async () => {})

    expect(
      screen.getByRole('button', {
        name: rowNamePrefix('Alpha still here'),
      }),
    ).toBeInTheDocument()
    expect(titleInput()).toHaveValue(
      'Alpha still here',
    )
    expect(
      screen.queryByText("Couldn't save."),
    ).not.toBeInTheDocument()
  })
})

/* ── Permanent delete: accessibility ───────────────────────────── */

describe('permanent delete: accessibility', () => {
  it('wires the trigger, menu, and dialog roles and names correctly', async () => {
    renderPage()
    await settleInitialLoad()

    const trigger = overflowTrigger('Alpha')
    expect(trigger).toHaveAttribute(
      'aria-haspopup',
      'menu',
    )
    expect(trigger).toHaveAttribute(
      'aria-expanded',
      'false',
    )

    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(trigger).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(
      screen.getByRole('menuitem', {
        name: 'Delete note',
      }),
    ).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('menuitem', {
        name: 'Delete note',
      }),
    )
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAttribute(
      'aria-modal',
      'true',
    )
    expect(dialog).toHaveAccessibleName(
      'Delete note?',
    )

    // The description carries the irreversible warning (not
    // color-only: the destructive state is written out).
    const description = document.getElementById(
      'note-delete-description',
    )
    expect(description).not.toBeNull()
    expect(description).toHaveTextContent(
      "This can't be undone.",
    )
  })

  it('focuses the safe action first, traps Tab, and returns focus to the trigger on Escape', async () => {
    renderPage()
    await settleInitialLoad()

    const trigger = overflowTrigger('Beta')
    fireEvent.click(trigger)
    fireEvent.click(
      screen.getByRole('menuitem', {
        name: 'Delete note',
      }),
    )
    await screen.findByRole('dialog')

    // The SAFE (non-destructive) action is focused first.
    const cancel = dialogButton('Cancel')
    expect(cancel).toHaveFocus()

    // Tab trap: Shift+Tab from the first focusable wraps to the
    // last (the destructive action).
    const destroy = dialogButton('Delete')
    fireEvent.keyDown(cancel, {
      key: 'Tab',
      shiftKey: true,
    })
    expect(destroy).toHaveFocus()

    // Escape cancels — and focus returns to the originating
    // overflow trigger.
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog'),
      ).not.toBeInTheDocument(),
    )
    await act(async () => {})
    expect(trigger).toHaveFocus()
  })
})
