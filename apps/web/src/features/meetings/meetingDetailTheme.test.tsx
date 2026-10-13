// @vitest-environment happy-dom
/**
 * Meeting Detail theme contract (Dark + Light).
 *
 * Proves the rendered Meeting Detail workspace — upcoming, live,
 * completed and cancelled states plus the inline editors and the
 * delete dialog — is bound to the semantic theme tokens of
 * `index.css` (the same vocabulary the migrated shell consumes),
 * never to raw Dark-only colors or static white/black alpha
 * treatments, in BOTH themes through the central `data-theme`
 * switch the Appearance feature owns.
 *
 * Division of labor with the other suites (no duplication):
 *   - THIS suite pins the rendered class bindings of the audited
 *     surfaces (which semantic role each surface uses) and that no
 *     raw color class survives anywhere on the rendered workspace;
 *   - `e2e/token-contract.test.ts` pins the approved Light/Dark
 *     VALUES of those semantic tokens;
 *   - `features/appearance/*` pins the theme switch + persistence
 *     contract (surviving reload);
 *   - `scripts/visual/meeting-detail-theme-check.mjs` (host
 *     browser gate) verifies the COMPUTED styles of the same
 *     surfaces in a real browser, with screenshots.
 *
 * Together they prove Dark -> Light updates surfaces and text and
 * Light -> Dark restores the correct treatment, because the
 * rendered elements keep one stable class binding while the
 * central data-theme switch re-resolves every bound token.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router'

import * as meetingsApi from '../../api/meetings'
import * as projectsApi from '../../api/projects'
import * as workItemsApi from '../../api/work-items'
import type {
  ApiMeeting,
  ApiMeetingItem,
  ApiMeetingParticipant,
  ApiMeetingSection,
} from '../../api/types'

import { MeetingDetailPage } from './MeetingDetailPage'

vi.mock('../../api/meetings', () => ({
  addMeetingParticipant: vi.fn(),
  createMeetingItem: vi.fn(),
  createMeetingNote: vi.fn(),
  createMeetingSection: vi.fn(),
  deleteMeeting: vi.fn(),
  deleteMeetingNote: vi.fn(),
  deleteMeetingItem: vi.fn(),
  endMeeting: vi.fn(),
  focusMeetingItem: vi.fn(),
  getMeeting: vi.fn(),
  listMeetingItems: vi.fn(),
  listMeetingParticipants: vi.fn(),
  listMeetingSections: vi.fn(),
  markMeetingItemDone: vi.fn(),
  reorderMeetingSections: vi.fn(),
  reopenMeeting: vi.fn(),
  reopenMeetingItem: vi.fn(),
  removeMeetingParticipant: vi.fn(),
  searchMeetingParticipantCandidates: vi.fn(),
  startMeeting: vi.fn(),
  updateMeetingItem: vi.fn(),
  updateMeetingNote: vi.fn(),
  updateMeetingSection: vi.fn(),
}))

vi.mock('../../api/projects', () => ({
  getProject: vi.fn(),
  getProjectWorkItemConfiguration: vi.fn(),
  listProjectMemberships: vi.fn(),
}))

vi.mock('../../api/work-items', () => ({
  getWorkItem: vi.fn(),
  listProjectWorkItems: vi.fn(),
  updateWorkItem: vi.fn(),
}))

const sessionMock = vi.hoisted(() => ({
  user: { id: 2, username: 'chris' } as {
    id: number
    username: string
  },
}))

vi.mock('../../api/useSession', () => ({
  useSession: () => ({ user: sessionMock.user }),
}))

vi.mock('../research-group/useResearchGroup', () => ({
  useResearchGroup: () => ({
    groups: [{ id: 3, name: 'FG Group', role: 'member' }],
    activeResearchGroupId: 3,
    activeResearchGroup: {
      id: 3,
      name: 'FG Group',
      role: 'member',
    },
    loading: false,
    error: null,
    setActiveResearchGroupId: vi.fn(),
    reloadResearchGroups: vi.fn(),
    addResearchGroup: vi.fn(),
  }),
}))

// ── Theme helpers ────────────────────────────────────────────────

type Theme = 'light' | 'dark'

function setTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme
}

/**
 * True when the element's class list carries the given color
 * utility (variant prefixes such as `hover:` are ignored).
 */
function hasColorClass(
  el: Element,
  utility: string,
): boolean {
  const classes = el.className
    .toString()
    .split(/\s+/)

  return classes.some(
    (value) =>
      value === utility ||
      value.endsWith(`:${utility}`),
  )
}

/**
 * Raw (non-token) color classes are the failure mode this
 * migration removes: arbitrary hex values and static white /
 * black alpha treatments that cannot follow the theme.
 * Arbitrary LENGTH values (e.g. `text-[13px]`) are not colors
 * and stay allowed.
 */
const FORBIDDEN_RAW_COLOR_CLASS =
  /(^|\s)[a-z-]*-(?:\[[^\]]*#[0-9a-fA-F]+\]|white(?:\/[\d.]+)?|black(?:\/[\d.]+)?)(\s|$)/

function assertNoRawColors(
  container: ParentNode,
  label: string,
) {
  const offenders: string[] = []

  container.querySelectorAll('*').forEach((el) => {
    const classes = el.className.toString()

    if (FORBIDDEN_RAW_COLOR_CLASS.test(classes)) {
      offenders.push(
        `${el.tagName.toLowerCase()} ${classes
          .split(/\s+/)
          .filter((c) =>
            FORBIDDEN_RAW_COLOR_CLASS
              .test(` ${c} `),
          )
          .join(' ')}`,
      )
    }
  })

  expect(
    offenders,
    `raw color classes in ${label}`,
  ).toEqual([])
}

// ── Fixtures ─────────────────────────────────────────────────────

const section: ApiMeetingSection = {
  id: 21,
  meetingId: 11,
  sourceSeriesSectionId: null,
  name: 'Agenda',
  description: '',
  position: 0,
  isVisible: true,
}

const item: ApiMeetingItem = {
  id: 31,
  meetingId: 11,
  meetingSectionId: 21,
  title: 'Weekly review',
  contextNotes: '',
  content: 'Weekly review topic',
  position: 0,
  outcome: 'not_discussed',
  followUpSchedule: null,
  workItemIds: [],
  notes: [],
  createdById: 2,
  createdAt: '2026-09-01T09:00:00Z',
  updatedAt: '2026-09-01T09:00:00Z',
}

const participant: ApiMeetingParticipant = {
  id: 301,
  user: {
    id: 2,
    username: 'chris',
    firstName: 'Chris',
    lastName: 'Example',
  },
  addedAt: '2026-09-01T09:00:00Z',
}

function makeMeeting(
  overrides: Partial<ApiMeeting> = {},
): ApiMeeting {
  return {
    id: 11,
    researchGroupId: 3,
    scope: 'group',
    projectId: null,
    seriesId: null,
    title: 'Collab Weekly',
    scheduledAt: '2026-09-30T09:00:00Z',
    startedAt: null,
    endedAt: null,
    status: 'upcoming',
    currentMeetingItemId: null,
    participantIds: [2],
    actionPermissions: {
      canEdit: true,
      canDelete: true,
      canCancel: false,
    },
    createdById: 2,
    createdAt: '2026-09-01T09:00:00Z',
    updatedAt: '2026-09-01T09:00:00Z',
    ...overrides,
  }
}

function renderPage(meeting: ApiMeeting) {
  vi.mocked(meetingsApi.getMeeting).mockResolvedValue(
    meeting,
  )
  vi.mocked(
    meetingsApi.listMeetingParticipants,
  ).mockResolvedValue([participant])
  vi.mocked(meetingsApi.listMeetingItems).mockResolvedValue(
    [item],
  )
  vi.mocked(
    meetingsApi.listMeetingSections,
  ).mockResolvedValue([section])
  vi.mocked(projectsApi.getProject).mockResolvedValue(
    null as never,
  )
  vi.mocked(workItemsApi.getWorkItem).mockResolvedValue(
    null as never,
  )

  return render(
    <MemoryRouter initialEntries={['/meetings/11']}>
      <Routes>
        <Route
          path="/meetings"
          element={<div>Meetings list marker</div>}
        />
        <Route
          path="/meetings/:meetingId"
          element={<MeetingDetailPage />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  setTheme('dark')
})

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute(
    'data-theme',
  )
})

// ── Upcoming preparation view ────────────────────────────────────

describe('Meeting Detail upcoming theme contract', () => {
  it('binds header, agenda and Quick Add surfaces to the semantic tokens in both themes', async () => {
    const { container } = renderPage(
      makeMeeting(),
    )

    const title = await screen.findByRole(
      'heading',
      { name: 'Collab Weekly' },
    )
    const card = container.querySelector(
      'section[aria-label="Agenda"]',
    ) as HTMLElement
    const quickAddBar = container.querySelector(
      'kbd',
    )?.closest('div[class*="rounded-lg"]') as HTMLElement

    expect(card).not.toBeNull()
    expect(quickAddBar).not.toBeNull()

    // One stable binding per surface; the data-theme switch
    // re-resolves each token to the approved value per theme
    // (values pinned by the token contract suite).
    expect(hasColorClass(title, 'text-text')).toBe(true)
    expect(hasColorClass(card, 'bg-surface')).toBe(true)
    expect(hasColorClass(card, 'border-border-subtle')).toBe(true)
    expect(hasColorClass(quickAddBar, 'bg-surface')).toBe(true)
    expect(hasColorClass(quickAddBar, 'border-border-subtle')).toBe(true)

    // The participant avatar keeps the muted neutral fill.
    const avatar = container.querySelector(
      '[aria-label="Participants"] > span',
    ) as HTMLElement

    expect(hasColorClass(avatar, 'bg-surface-muted')).toBe(true)
    expect(hasColorClass(avatar, 'text-text')).toBe(true)

    // The primary lifecycle action uses the themeable action
    // role with the canonical focus ring.
    const start = screen.getByRole('button', {
      name: 'Start meeting',
    })

    expect(hasColorClass(start, 'bg-action')).toBe(true)
    expect(hasColorClass(start, 'text-text-inverse')).toBe(true)
    expect(hasColorClass(start, 'hover:bg-action-hover')).toBe(true)
    expect(hasColorClass(start, 'focus-visible:ring-focus')).toBe(true)

    // Add user is the accent-colored interactive text.
    const addUser = screen.getByRole('button', {
      name: 'Add user',
    })

    expect(hasColorClass(addUser, 'text-accent-text')).toBe(true)
    expect(hasColorClass(addUser, 'focus-visible:ring-focus')).toBe(true)

    assertNoRawColors(container, 'upcoming (dark)')

    // Light: the identical bindings stay raw-color-free; the
    // central switch re-resolves them to the Light values.
    setTheme('light')

    assertNoRawColors(container, 'upcoming (light)')
  })

  it('keeps the inline composers readable and functional on both themes', async () => {
    const { container } = renderPage(
      makeMeeting(),
    )

    await screen.findByRole('heading', {
      name: 'Collab Weekly',
    })

    // Section composer: quiet row expands into the themed
    // input surface.
    fireEvent.click(
      screen.getByRole('button', {
        name: '+ Add section',
      }),
    )

    const input = await screen.findByRole(
      'textbox',
      { name: 'New section name' },
    )
    const composerRow = input.closest('form') as HTMLElement

    expect(composerRow).not.toBeNull()
    expect(hasColorClass(composerRow, 'bg-surface-subtle')).toBe(true)
    expect(hasColorClass(input, 'text-text')).toBe(true)
    expect(hasColorClass(input, 'placeholder:text-text-muted')).toBe(true)

    // Functional on the themed surface: submitting creates the
    // section and closes the composer.
    vi.mocked(
      meetingsApi.createMeetingSection,
    ).mockResolvedValue({
      ...section,
      id: 99,
      name: 'Stand-up',
    })

    fireEvent.change(input, {
      target: { value: 'Stand-up' },
    })
    // The composer's submit path (the Add button fires the
    // form's onSubmit; a real Enter key submits the single-field
    // form through the browser).
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Add',
      }),
    )

    await waitFor(() =>
      expect(
        vi.mocked(meetingsApi.createMeetingSection),
      ).toHaveBeenCalledTimes(1),
    )

    await waitFor(() =>
      expect(
        screen.queryByRole('textbox', {
          name: 'New section name',
        }),
      ).not.toBeInTheDocument(),
    )

    // Reopened with an empty draft: Escape discards without
    // persisting anything.
    fireEvent.click(
      screen.getByRole('button', {
        name: '+ Add section',
      }),
    )

    const secondInput = await screen.findByRole(
      'textbox',
      { name: 'New section name' },
    )

    fireEvent.keyDown(secondInput, { key: 'Escape' })

    await waitFor(() =>
      expect(
        screen.queryByRole('textbox', {
          name: 'New section name',
        }),
      ).not.toBeInTheDocument(),
    )

    expect(
      vi.mocked(meetingsApi.createMeetingSection),
    ).toHaveBeenCalledTimes(1)

    // Topic composer: the rendered topic opens the minimal
    // Markdown editor in place (themed), Escape cancels it.
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Edit topic Weekly review',
      }),
    )

    const topicField = await screen.findByRole(
      'textbox',
      { name: 'Edit topic Weekly review' },
    )
    const topicComposer = topicField.closest(
      'form',
    ) as HTMLElement

    expect(topicComposer).not.toBeNull()
    expect(hasColorClass(topicComposer, 'bg-surface-subtle')).toBe(true)
    expect(hasColorClass(topicComposer, 'border-border-subtle')).toBe(true)
    expect(hasColorClass(topicField, 'text-text')).toBe(true)
    expect(
      hasColorClass(
        topicField,
        'placeholder:text-text-muted',
      ),
    ).toBe(true)

    const save = topicComposer.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement
    const cancel = topicComposer.querySelectorAll(
      'button',
    )[1] as HTMLButtonElement

    expect(hasColorClass(save, 'text-text')).toBe(true)
    expect(hasColorClass(save, 'hover:bg-surface-hover')).toBe(true)
    expect(hasColorClass(save, 'focus-visible:ring-focus')).toBe(true)
    expect(hasColorClass(cancel, 'text-text-muted')).toBe(true)
    expect(hasColorClass(cancel, 'hover:bg-surface-hover')).toBe(true)

    fireEvent.keyDown(topicField, { key: 'Escape' })

    await waitFor(() =>
      expect(
        screen.queryByRole('textbox', {
          name: 'Edit topic Weekly review',
        }),
      ).not.toBeInTheDocument(),
    )

    assertNoRawColors(container, 'upcoming composers (dark)')

    setTheme('light')

    assertNoRawColors(container, 'upcoming composers (light)')
  })

  it('uses the canonical overlay scrim for the delete dialog and keeps it cancellable', async () => {
    const { container } = renderPage(
      makeMeeting(),
    )

    await screen.findByRole('heading', {
      name: 'Collab Weekly',
    })

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Meeting actions',
      }),
    )

    fireEvent.click(
      screen.getByRole('menuitem', {
        name: 'Delete meeting',
      }),
    )

    const dialog = await screen.findByRole(
      'dialog',
      { name: 'Delete meeting?' },
    )
    const scrim = dialog.parentElement as HTMLElement

    expect(hasColorClass(scrim, 'bg-overlay-scrim')).toBe(true)
    expect(hasColorClass(dialog, 'bg-surface')).toBe(true)

    const cancel = dialog.querySelector(
      'button',
    ) as HTMLButtonElement

    expect(hasColorClass(cancel, 'text-text-muted')).toBe(true)
    expect(hasColorClass(cancel, 'hover:bg-surface-hover')).toBe(true)

    const deleteButton = dialog.querySelectorAll(
      'button',
    )[1] as HTMLButtonElement

    expect(hasColorClass(deleteButton, 'bg-danger-subtle')).toBe(true)
    expect(hasColorClass(deleteButton, 'text-danger')).toBe(true)

    // Cancel keeps working on the themed dialog.
    fireEvent.click(cancel)

    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', {
          name: 'Delete meeting?',
        }),
      ).not.toBeInTheDocument(),
    )

    assertNoRawColors(container, 'delete dialog (dark)')

    setTheme('light')

    assertNoRawColors(container, 'delete dialog (light)')
  })
})

// ── Live Meeting ─────────────────────────────────────────────────

describe('Meeting Detail live theme contract', () => {
  it('keeps the focus pane, Live pill and End action token-bound', async () => {
    const { container } = renderPage(
      makeMeeting({
        status: 'live',
        startedAt: '2026-09-30T09:00:00Z',
        currentMeetingItemId: 31,
      }),
    )

    const title = await screen.findByRole(
      'heading',
      { name: 'Collab Weekly' },
    )

    expect(hasColorClass(title, 'text-text')).toBe(true)

    const pane = container.querySelector(
      'section[data-live-focus-pane]',
    ) as HTMLElement

    expect(pane).not.toBeNull()
    expect(hasColorClass(pane, 'bg-surface-subtle')).toBe(true)
    expect(hasColorClass(pane, 'border-border-subtle')).toBe(true)

    const end = screen.getByRole('button', {
      name: 'End meeting',
    })

    expect(hasColorClass(end, 'text-danger')).toBe(true)
    expect(hasColorClass(end, 'hover:bg-danger-bg')).toBe(true)
    expect(hasColorClass(end, 'focus-visible:ring-focus')).toBe(true)

    assertNoRawColors(container, 'live (dark)')

    setTheme('light')

    assertNoRawColors(container, 'live (light)')
  })
})

// ── Completed / cancelled read-only states ───────────────────────

describe('Meeting Detail completed/cancelled theme contract', () => {
  it.each(['completed', 'cancelled'] as const)(
    'renders the %s read-only state without raw colors or preparation controls',
    async (status) => {
      const { container } = renderPage(
        makeMeeting({
          status,
          endedAt:
            status === 'completed'
              ? '2026-09-30T10:00:00Z'
              : null,
        }),
      )

      const title = await screen.findByRole(
        'heading',
        { name: 'Collab Weekly' },
      )

      expect(hasColorClass(title, 'text-text')).toBe(true)

      // Read-only: no preparation affordances.
      expect(
        screen.queryByRole('button', {
          name: '+ Add section',
        }),
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', {
          name: 'Start meeting',
        }),
      ).not.toBeInTheDocument()

      assertNoRawColors(container, `${status} (dark)`)

      setTheme('light')

      assertNoRawColors(container, `${status} (light)`)
    },
  )
})
