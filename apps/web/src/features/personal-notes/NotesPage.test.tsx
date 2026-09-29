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
import { StrictMode } from 'react'
import { MemoryRouter } from 'react-router'

import { App } from '../../app/App'
import { ApiError } from '../../api/client'
import {
  archivePersonalNote,
  createPersonalNote,
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
 * The read-only Markdown surface is the canonical
 * RichMarkdownEditor (readOnly) — the Tiptap graph is covered by its
 * own suites; here the module boundary stands in and records the
 * props the page passes, which is exactly the read-only contract
 * this slice must hold.
 */
const richMarkdownEditor = vi.hoisted(() => ({
  lastProps: null as Record<string, unknown> | null,
}))

vi.mock('../../components/editor/RichMarkdownEditor', () => ({
  RichMarkdownEditor: (props: Record<string, unknown>) => {
    richMarkdownEditor.lastProps = props
    return (
      <div
        data-testid="note-content"
        data-read-only={String(Boolean(props.readOnly))}
      >
        {String(props.value ?? '')}
      </div>
    )
  },
}))

/*
 * The page must talk to exactly one canonical client function for the
 * whole slice (listPersonalNotes — initial list AND search). Every
 * other client function is mocked too: any call to a detail, create,
 * update, pin, archive, restore, or archive-listing request is a test
 * failure.
 */
vi.mock('../../api/personal-notes', () => ({
  listPersonalNotes: vi.fn(),
  listArchivedPersonalNotes: vi.fn(),
  getPersonalNote: vi.fn(),
  createPersonalNote: vi.fn(),
  updatePersonalNote: vi.fn(),
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
  richMarkdownEditor.lastProps = null
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
  return within(listRegion()).getAllByRole('button')
}

function rowTitle(button: HTMLElement): string {
  return (
    button.querySelector('.truncate')?.textContent ?? ''
  )
}

/*
 * Debounce block in the repository's canonical shape: the page
 * mounts and settles on REAL timers first; fake timers are enabled
 * only around the debounce window, and restored in finally.
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
    // Nothing selected yet — no fake note in the reading surface.
    expect(
      screen.queryByTestId('note-content'),
    ).not.toBeInTheDocument()

    resolveInitial([ALPHA])
    await screen.findByRole('heading', { name: 'Alpha' })

    expect(
      screen.queryByRole('status'),
    ).not.toBeInTheDocument()
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

    const rows = rowButtons()
    expect(rowTitle(rows[0])).toBe('Order A')
    expect(rowTitle(rows[1])).toBe('Order B')
  })

  it('automatically selects the first note returned by the backend', async () => {
    renderPage()
    await settleInitialLoad()

    expect(
      screen.getByRole('heading', { name: 'Alpha' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Alpha/ }),
    ).toHaveAttribute('aria-current', 'true')
    expect(
      screen.getByTestId('note-content'),
    ).toHaveTextContent('Alpha body')
  })

  it('shows a restrained empty state for an empty collection', async () => {
    renderPage([])
    await settleInitialLoad()

    expect(screen.getByText('No notes yet.')).toBeInTheDocument()
    // No fake selected note and no non-functional create control.
    expect(
      screen.getByText('Select a note to read it.'),
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('note-content'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', {
        name: /new note/i,
      }),
    ).not.toBeInTheDocument()
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

    fireEvent.click(
      screen.getByRole('button', { name: /Gamma/ }),
    )

    expect(
      screen.getByRole('heading', { name: 'Gamma' }),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('note-content'),
    ).toHaveTextContent('Gamma body')
  })

  it('changes the selection without any new network request', async () => {
    renderPage()
    await settleInitialLoad()

    fireEvent.click(
      screen.getByRole('button', { name: /Beta/ }),
    )
    await screen.findByRole('heading', { name: 'Beta' })

    expect(listPersonalNotes).toHaveBeenCalledTimes(1)
    expect(getPersonalNote).not.toHaveBeenCalled()
  })

  it('renders untitled notes with a presentation fallback only', async () => {
    const untitled = note({
      id: 9,
      title: '',
      content: 'Untitled body',
    })
    renderPage([untitled, BETA])
    await settleInitialLoad()

    // List row AND reading surface use the fallback…
    expect(
      screen.getByRole('button', { name: /Untitled/ }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Untitled' }),
    ).toBeInTheDocument()
    // …while the stored title stays untouched (no update request).
    expect(updatePersonalNote).not.toHaveBeenCalled()
  })

  it('conveys the selected row accessibly, not through color alone', async () => {
    renderPage([ALPHA, BETA])
    await settleInitialLoad()

    expect(
      screen.getByRole('button', { name: /Alpha/ }),
    ).toHaveAttribute('aria-current', 'true')
    expect(
      screen.getByRole('button', { name: /Beta/ }),
    ).not.toHaveAttribute('aria-current')

    fireEvent.click(
      screen.getByRole('button', { name: /Beta/ }),
    )
    await screen.findByRole('heading', { name: 'Beta' })

    expect(
      screen.getByRole('button', { name: /Beta/ }),
    ).toHaveAttribute('aria-current', 'true')
    expect(
      screen.getByRole('button', { name: /Alpha/ }),
    ).not.toHaveAttribute('aria-current')
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
    expect(rowButtons()).toHaveLength(1)
    expect(rowTitle(rowButtons()[0])).toBe('Alpha')
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

    const rows = rowButtons()
    expect(rows).toHaveLength(1)
    expect(rowTitle(rows[0])).toBe('Gamma')
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
      expect(rowButtons()).toHaveLength(1)

      fireEvent.change(searchInput(), {
        target: { value: '' },
      })
      await flushDebounce()
    } finally {
      vi.useRealTimers()
    }

    expect(listPersonalNotes).toHaveBeenLastCalledWith('')
    expect(rowButtons()).toHaveLength(3)
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

    fireEvent.click(
      screen.getByRole('button', { name: /Beta/ }),
    )
    await screen.findByRole('heading', { name: 'Beta' })

    vi.useFakeTimers()
    try {
      fireEvent.change(searchInput(), {
        target: { value: 'keep' },
      })
      await flushDebounce()
    } finally {
      vi.useRealTimers()
    }

    // Backend order rendered (Gamma first) — but Beta stays selected.
    expect(rowTitle(rowButtons()[0])).toBe('Gamma')
    expect(
      screen.getByRole('button', { name: /Beta/ }),
    ).toHaveAttribute('aria-current', 'true')
    expect(
      screen.getByRole('heading', { name: 'Beta' }),
    ).toBeInTheDocument()
  })

  it('falls back to the first result when the selection is gone', async () => {
    renderPage(
      undefined,
      async (query?: string) =>
        query === 'miss' ? [GAMMA, ALPHA] : DEFAULT_NOTES,
    )
    await settleInitialLoad()

    fireEvent.click(
      screen.getByRole('button', { name: /Beta/ }),
    )
    await screen.findByRole('heading', { name: 'Beta' })

    vi.useFakeTimers()
    try {
      fireEvent.change(searchInput(), {
        target: { value: 'miss' },
      })
      await flushDebounce()
    } finally {
      vi.useRealTimers()
    }

    expect(
      screen.getByRole('button', { name: /Gamma/ }),
    ).toHaveAttribute('aria-current', 'true')
    expect(
      screen.getByRole('heading', { name: 'Gamma' }),
    ).toBeInTheDocument()
  })

  it('clears the selection when the search has no results', async () => {
    renderPage(
      undefined,
      async (query?: string) =>
        query === 'nothing' ? [] : DEFAULT_NOTES,
    )
    await settleInitialLoad()

    fireEvent.click(
      screen.getByRole('button', { name: /Beta/ }),
    )
    await screen.findByRole('heading', { name: 'Beta' })

    vi.useFakeTimers()
    try {
      fireEvent.change(searchInput(), {
        target: { value: 'nothing' },
      })
      await flushDebounce()
    } finally {
      vi.useRealTimers()
    }

    expect(
      within(listRegion()).queryAllByRole('button'),
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

      const rowsAfterFast = rowButtons()
      expect(rowsAfterFast).toHaveLength(1)
      expect(rowTitle(rowsAfterFast[0])).toBe('Gamma')

      // The stale response arrives LATE — it must be dropped.
      resolveSlow([ALPHA, BETA])
      await act(async () => {})
    } finally {
      vi.useRealTimers()
    }

    const rowsAfterStale = rowButtons()
    expect(rowsAfterStale).toHaveLength(1)
    expect(rowTitle(rowsAfterStale[0])).toBe('Gamma')
    expect(
      screen.getByRole('heading', { name: 'Gamma' }),
    ).toBeInTheDocument()
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
    await screen.findByRole('heading', { name: 'Alpha' })

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
    const rows = within(
      within(listRegion()).getByRole('list'),
    ).getAllByRole('button')
    expect(rows).toHaveLength(3)
    expect(rows.map(rowTitle)).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
    ])
    expect(
      screen.getByRole('heading', { name: 'Alpha' }),
    ).toBeInTheDocument()
    // Header and search remain intact…
    expect(
      screen.getByRole('heading', { name: 'Notes', level: 1 }),
    ).toBeInTheDocument()
    expect(searchInput()).toBeInTheDocument()
    // …and the failure is compact + retryable.
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Search failed.')
    expect(alert).toHaveTextContent('Search exploded.')
    expect(
      screen.getByRole('button', { name: 'Retry' }),
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

    await screen.findByRole('heading', { name: 'Alpha' })

    expect(
      screen.getByRole('button', { name: /Alpha/ }),
    ).toHaveAttribute('aria-current', 'true')
    expect(
      screen.getByTestId('note-content'),
    ).toHaveTextContent('Alpha body')
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

    await screen.findByRole('heading', { name: 'Gamma' })

    // The stale first response arrives LATE — it must be
    // dropped.
    resolveFirst([ALPHA])
    await act(async () => {})

    const rows = within(
      within(listRegion()).getByRole('list'),
    ).getAllByRole('button')
    expect(rows.map(rowTitle)).toEqual(['Gamma'])
    expect(
      screen.getByRole('heading', { name: 'Gamma' }),
    ).toBeInTheDocument()
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

      const rowsAfterFast = within(
        within(listRegion()).getByRole('list'),
      ).getAllByRole('button')
      expect(rowsAfterFast.map(rowTitle)).toEqual(
        ['Gamma'],
      )

      // The stale search response arrives LATE — dropped.
      resolveSlow([ALPHA, BETA])
      await act(async () => {})
    } finally {
      vi.useRealTimers()
    }

    const rowsAfterStale = within(
      within(listRegion()).getByRole('list'),
    ).getAllByRole('button')
    expect(rowsAfterStale.map(rowTitle)).toEqual(['Gamma'])
    expect(
      screen.getByRole('heading', { name: 'Gamma' }),
    ).toBeInTheDocument()
  })
})


/* ── Rendering ────────────────────────────────────────────────── */

describe('read-only rendering', () => {
  it('renders the selected content read-only through the canonical Markdown surface', async () => {
    renderPage([ALPHA])
    await settleInitialLoad()

    const content = screen.getByTestId('note-content')
    expect(content).toHaveTextContent('Alpha body')
    expect(content).toHaveAttribute(
      'data-read-only',
      'true',
    )
    expect(richMarkdownEditor.lastProps).toMatchObject({
      readOnly: true,
      value: 'Alpha body',
    })
  })

  it('mounts no editable control or formatting toolbar', async () => {
    renderPage()
    await settleInitialLoad()

    expect(richMarkdownEditor.lastProps).toMatchObject({
      readOnly: true,
    })
    expect(
      screen.queryByRole('toolbar'),
    ).not.toBeInTheDocument()
    // The only input on the page is the search field.
    expect(
      screen.queryByRole('textbox'),
    ).not.toBeInTheDocument()
    expect(
      screen.getAllByRole('searchbox'),
    ).toHaveLength(1)
    // The only buttons are the note rows themselves.
    expect(rowButtons()).toHaveLength(DEFAULT_NOTES.length)
  })

  it('shows a quiet empty-content state without fabricating content', async () => {
    const empty = note({
      id: 5,
      title: 'Empty',
      content: '',
    })
    renderPage([empty])
    await settleInitialLoad()

    expect(
      screen.getByText('This note has no content.'),
    ).toBeInTheDocument()
    // The Markdown surface is never mounted for empty content
    // (the read-only empty state is the caller's, per the
    // RichMarkdownEditor contract).
    expect(
      screen.queryByTestId('note-content'),
    ).not.toBeInTheDocument()
    expect(richMarkdownEditor.lastProps).toBeNull()
  })

  it('issues no create/pin/archive/restore/detail requests in this slice', async () => {
    renderPage()
    await settleInitialLoad()

    fireEvent.click(
      screen.getByRole('button', { name: /Beta/ }),
    )
    await screen.findByRole('heading', { name: 'Beta' })

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
    expect(updatePersonalNote).not.toHaveBeenCalled()
    expect(setPersonalNotePinned).not.toHaveBeenCalled()
    expect(archivePersonalNote).not.toHaveBeenCalled()
    expect(restorePersonalNote).not.toHaveBeenCalled()
    expect(getPersonalNote).not.toHaveBeenCalled()
    expect(listArchivedPersonalNotes).not.toHaveBeenCalled()
  })
})

/* ── AppShell integration & structure ─────────────────────────── */

describe('AppShell integration', () => {
  it('renders /notes inside the authenticated AppShell with one Notes workspace (no second shell)', async () => {
    vi.mocked(listPersonalNotes).mockResolvedValue([ALPHA])

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
    await screen.findByRole('heading', { name: 'Alpha' })
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
