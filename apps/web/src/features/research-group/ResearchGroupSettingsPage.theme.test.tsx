// @vitest-environment happy-dom
/**
 * Research Group Settings theme contract (Dark + Light).
 *
 * Proves the rendered Settings surfaces — the internal
 * General / Members tab strip, the General form (label,
 * input, Save button incl. disabled state), the Members list
 * (rows, role selects, Remove action), the permission
 * refusal, the loading / load-error states, and the
 * Add / Remove member management dialogs (search,
 * candidates, role choice, confirm / cancel, error states)
 * — are bound to the semantic functional tokens of
 * `index.css` (the same vocabulary the shared workspace
 * layout and the Overview content consume), never to the
 * static legacy Material tokens (`on-surface`,
 * `on-surface-variant`, `surface-container*`,
 * `outline-variant`, `primary`, `error`) or to raw colors,
 * in BOTH themes through the central `data-theme` switch.
 *
 * Division of labor (no duplication):
 *   - THIS suite pins the rendered class bindings of the
 *     Settings content and its management dialogs — plus the
 *     WCAG AA (4.5:1) contrast of the essential
 *     text / background pairs (resolved per theme from the
 *     canonical stylesheet) and that no legacy / raw color
 *     class survives in the migrated surface;
 *   - `ResearchGroupWorkspaceLayout.test.tsx` pins routing,
 *     the embedded presentation mode, and the admin-only
 *     Settings visibility;
 *   - `ResearchGroupOverviewPage.theme.test.tsx` pins the
 *     shared workspace layout (header, tab bar, not-found)
 *     above this surface;
 *   - `e2e/token-contract.test.ts` pins the approved
 *     Light/Dark VALUES of those semantic tokens.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import {
  Outlet,
  RouterProvider,
  createMemoryRouter,
} from 'react-router'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import { ApiError } from '../../api/client'
import {
  getResearchGroup,
  getResearchGroupMemberOffboardingPreview,
  listResearchGroupMemberships,
  listResearchGroups,
  searchResearchGroupMemberCandidates,
} from '../../api/research-groups'
import type {
  ApiResearchGroup,
  ApiResearchGroupMembership,
  ApiResearchGroupMemberOffboardingPreview,
} from '../../api/types'

import { ResearchGroupSettingsPage } from './ResearchGroupSettingsPage'
import { ResearchGroupProvider } from './ResearchGroupProvider'
import { ResearchGroupWorkspaceLayout } from './ResearchGroupWorkspaceLayout'

/*
 * Canonical stylesheet, read from disk (the same pattern as
 * the workspace theme contract and `e2e/token-contract.test.ts`):
 * the WCAG AA check below resolves the token VALUES per theme
 * instead of hard-coding them, so a value change in index.css
 * is caught here. Read directly (not through the Vite module
 * pipeline) because the unit suite stubs CSS — `?raw`
 * included — to an empty string.
 */
const indexCss = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../index.css',
  ),
  'utf8',
)

vi.mock('../../api/research-groups', () => ({
  listResearchGroups: vi.fn(),
  getResearchGroup: vi.fn(),
  listResearchGroupMemberships: vi.fn(),
  updateResearchGroup: vi.fn(),
  updateResearchGroupMembership: vi.fn(),
  searchResearchGroupMemberCandidates: vi.fn(),
  addResearchGroupMembership: vi.fn(),
  getResearchGroupMemberOffboardingPreview: vi.fn(),
  offboardResearchGroupMember: vi.fn(),
}))

type Theme = 'light' | 'dark'

function setTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme
}

/**
 * True when the element's class list carries the given color
 * utility (variant prefixes such as `hover:` are matched
 * explicitly by passing the full prefixed token).
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

/*
 * The exact legacy Material utilities the Settings surfaces
 * must not consume. They are static across themes and were
 * the root cause of the Dark Mode defects (dark text on the
 * dark canvas, white input surfaces, invisible labels).
 */
const FORBIDDEN_LEGACY_TOKENS = new Set([
  'text-on-surface',
  'text-on-surface-variant',
  'hover:text-on-surface',
  'placeholder:text-on-surface-variant/60',
  'border-outline-variant',
  'divide-outline-variant',
  'divide-outline-variant/60',
  'bg-on-surface/25',
  'bg-surface-container-lowest',
  'bg-surface-container',
  'bg-surface-container-low',
  'bg-surface-container-low/45',
  'bg-surface-container-high',
  'hover:bg-surface-container-low',
  'hover:bg-surface-container-high',
  'bg-primary',
  'hover:bg-primary/90',
  'bg-primary-fixed/55',
  'bg-primary-fixed/35',
  'text-primary',
  'border-primary',
  'focus:border-primary',
  'focus:ring-primary/15',
  'text-error',
  'bg-error',
  'bg-error/5',
  'bg-error-container',
  'border-error/20',
  'border-error/25',
  'hover:bg-error/5',
  'text-white',
])

/*
 * Raw (non-token) color classes are the other failure mode
 * this migration removes: arbitrary hex values and static
 * white / black alpha treatments that cannot follow the theme.
 */
const FORBIDDEN_RAW_COLOR_CLASS =
  /(^|\s)[a-z-]*-(?:\[[^\]]*#[0-9a-fA-F]+\]|white(?:\/[\d.]+)?|black(?:\/[\d.]+)?)(\s|$)/

function assertOnlyFunctionalColors(
  root: ParentNode,
  label: string,
) {
  const legacyOffenders: string[] = []
  const rawOffenders: string[] = []

  root.querySelectorAll('*').forEach((el) => {
    el.className
      .toString()
      .split(/\s+/)
      .filter((value) => value.length > 0)
      .forEach((token) => {
        if (FORBIDDEN_LEGACY_TOKENS.has(token)) {
          legacyOffenders.push(
            `${el.tagName.toLowerCase()} ${token}`,
          )
        }

        if (FORBIDDEN_RAW_COLOR_CLASS.test(` ${token} `)) {
          rawOffenders.push(
            `${el.tagName.toLowerCase()} ${token}`,
          )
        }
      })
  })

  expect(
    legacyOffenders,
    `legacy token classes in ${label}`,
  ).toEqual([])
  expect(
    rawOffenders,
    `raw color classes in ${label}`,
  ).toEqual([])
}

function exactClasses(el: Element): string[] {
  return el.className
    .toString()
    .split(/\s+/)
    .filter((value) => value.length > 0)
}

function expectClasses(
  el: Element,
  utilities: string[],
  label: string,
) {
  utilities.forEach((utility) => {
    expect(
      hasColorClass(el, utility),
      `${label}: ${utility}`,
    ).toBe(true)
  })
}

const GROUP: ApiResearchGroup = {
  id: 11,
  name: 'Aurora Research',
  role: 'admin',
}

const MEMBERSHIPS: ApiResearchGroupMembership[] = [
  {
    id: 1,
    role: 'admin',
    joinedAt: null,
    user: {
      id: 1,
      username: 'ada',
      firstName: 'Ada',
      lastName: 'Lovelace',
    },
  },
  {
    id: 2,
    role: 'member',
    joinedAt: null,
    user: {
      id: 2,
      username: 'alan',
      firstName: 'Alan',
      lastName: 'Turing',
    },
  },
]

type RenderSettingsOptions = {
  initialPath?: string
  groups?: ApiResearchGroup[]
  group?: ApiResearchGroup
  memberships?: ApiResearchGroupMembership[]
  groupLoad?: 'resolve' | 'reject' | 'pending'
  groupLoadError?: unknown
  offboardingLoad?: 'resolve' | 'reject'
  offboardingError?: unknown
}

const EMPTY_OFFBOARDING_PREVIEW: ApiResearchGroupMemberOffboardingPreview =
  {
    membershipId: 2,
    user: MEMBERSHIPS[1].user,
    researchGroupRole: 'member',
    finalResearchGroupAdmin: false,
    projects: [],
  }

/**
 * The canonical workspace route structure (layout parent +
 * settings child), rendered under the Research Group
 * provider — the same nesting `appRoutes` registers.
 */
function renderSettings(
  options: RenderSettingsOptions = {},
) {
  const {
    initialPath = '/groups/11/settings',
    groups = [GROUP],
    group = GROUP,
    memberships = MEMBERSHIPS,
    groupLoad = 'resolve',
    groupLoadError,
    offboardingLoad = 'resolve',
    offboardingError,
  } = options

  const router = createMemoryRouter(
    [
      {
        element: (
          <ResearchGroupProvider>
            <Outlet />
          </ResearchGroupProvider>
        ),
        children: [
          {
            path: '/groups/:groupId',
            element:
              <ResearchGroupWorkspaceLayout />,
            children: [
              {
                path: 'settings',
                element: (
                  <ResearchGroupSettingsPage
                    embedded
                  />
                ),
              },
            ],
          },
        ],
      },
    ],
    { initialEntries: [initialPath] },
  )

  vi.mocked(listResearchGroups).mockResolvedValue(
    groups,
  )
  if (groupLoad === 'pending') {
    vi.mocked(getResearchGroup).mockReturnValue(
      new Promise<never>(() => {}),
    )
  } else if (groupLoad === 'reject') {
    vi.mocked(getResearchGroup).mockRejectedValue(
      groupLoadError,
    )
  } else {
    vi.mocked(getResearchGroup).mockResolvedValue(
      group,
    )
  }
  vi.mocked(listResearchGroupMemberships).mockResolvedValue(
    memberships,
  )
  vi.mocked(
    searchResearchGroupMemberCandidates,
  ).mockResolvedValue([])
  if (offboardingLoad === 'reject') {
    vi.mocked(
      getResearchGroupMemberOffboardingPreview,
    ).mockRejectedValue(
      offboardingError,
    )
  } else {
    vi.mocked(
      getResearchGroupMemberOffboardingPreview,
    ).mockResolvedValue(
      EMPTY_OFFBOARDING_PREVIEW,
    )
  }

  return render(
    <RouterProvider
      router={router}
    />,
  )
}

/**
 * Resolves the `General` / `Members` internal tab button.
 */
function settingsTab(label: string) {
  return screen.getByRole(
    'button',
    { name: label },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.theme
})

describe('Research Group Settings theme contract', () => {
  it.each(['light', 'dark'] as Theme[])(
    'binds the General tab strip and content to functional tokens in %s',
    async (theme) => {
      setTheme(theme)

      const { container } = renderSettings()

      // The shared workspace header renders first; the
      // Settings content appears once the group load resolves.
      await screen.findByRole(
        'heading',
        {
          name: 'General',
          level: 2,
        },
      )

      // Internal tab strip: functional border + the
      // canonical active / inactive tab roles (the same
      // treatment the Meetings internal tabs use inside
      // the workspace).
      const generalTab = settingsTab('General')
      const membersTab = settingsTab('Members')
      const tabStrip =
        generalTab.parentElement as HTMLElement

      expectClasses(
        tabStrip,
        ['flex', 'gap-6', 'border-b', 'border-border-subtle'],
        'tab strip',
      )
      expectClasses(
        generalTab,
        [
          'border-tab-active',
          'text-text',
          'outline-none',
          'focus-visible:ring-2',
          'focus-visible:ring-focus',
        ],
        'active General tab',
      )
      expect(
        exactClasses(generalTab),
      ).not.toContain('text-text-muted')
      expectClasses(
        membersTab,
        [
          'border-transparent',
          'text-text-muted',
          'hover:text-text',
          'focus-visible:ring-2',
          'focus-visible:ring-focus',
        ],
        'inactive Members tab',
      )
      expect(
        exactClasses(membersTab),
      ).not.toContain('text-text')

      // General content: functional text roles.
      expectClasses(
        screen.getByText(
          'Basic information about this research group.',
        ),
        ['text-text-muted'],
        'General description',
      )
      expectClasses(
        screen.getByText('Research group name'),
        ['text-text'],
        'General label',
      )

      // The name input: functional field border, surface,
      // text, and focus tokens.
      const nameInput = screen.getByLabelText(
        'Research group name',
      )
      expectClasses(
        nameInput,
        [
          'border-border-field',
          'bg-surface',
          'text-text',
          'outline-none',
          'focus:border-focus',
          'focus:ring-2',
          'focus:ring-focus/15',
        ],
        'name input',
      )

      // The Save button: functional primary action role.
      const saveButton = screen.getByRole(
        'button',
        { name: 'Save' },
      )
      expectClasses(
        saveButton,
        [
          'bg-action',
          'text-text-inverse',
          'hover:bg-action-hover',
        ],
        'Save button',
      )

      assertOnlyFunctionalColors(
        container,
        `General (${theme})`,
      )
    },
  )

  it.each(['light', 'dark'] as Theme[])(
    'keeps the Save button states distinguishable in %s',
    async (theme) => {
      setTheme(theme)

      renderSettings()

      const saveButton = await screen.findByRole(
        'button',
        { name: 'Save' },
      )

      // Unchanged name: disabled with the functional
      // disabled treatment (never a recolored surface).
      expect(saveButton).toBeDisabled()
      expect(
        hasColorClass(saveButton, 'disabled:opacity-40'),
      ).toBe(true)
      expect(
        hasColorClass(
          saveButton,
          'disabled:cursor-not-allowed',
        ),
      ).toBe(true)

      // A meaningful change re-enables the SAME button
      // (state change, not a different styled control).
      fireEvent.change(
        screen.getByLabelText('Research group name'),
        { target: { value: 'Aurora Lab' } },
      )

      await waitFor(() => {
        expect(saveButton).toBeEnabled()
      })
    },
  )

  it.each(['light', 'dark'] as Theme[])(
    'binds the Members list to functional tokens in %s',
    async (theme) => {
      setTheme(theme)

      const { container } = renderSettings()

      await screen.findByRole(
        'heading',
        {
          name: 'Aurora Research',
          level: 1,
        },
      )

      await screen.findByRole(
        'heading',
        { name: 'General', level: 2 },
      )

      settingsTab('Members').click()

      const heading = await screen.findByRole(
        'heading',
        { name: 'Members', level: 2 },
      )
      expectClasses(
        heading,
        ['text-text'],
        'Members heading',
      )
      expectClasses(
        screen.getByText(
          'People with access to this research group.',
        ),
        ['text-text-muted'],
        'Members description',
      )

      // Add member: functional primary action role.
      const addMemberButton = screen.getByRole(
        'button',
        { name: 'Add member' },
      )
      expectClasses(
        addMemberButton,
        [
          'bg-action',
          'text-text-inverse',
          'hover:bg-action-hover',
        ],
        'Add member button',
      )

      // The member card: functional surface + structural
      // border, functional divider.
      const memberName = screen.getByText('Ada Lovelace')
      const card = memberName.closest(
        'div.rounded-xl',
      ) as HTMLElement
      expect(card).not.toBeNull()
      expectClasses(
        card,
        ['bg-surface', 'border-border-structural'],
        'member card',
      )
      const divider = card.querySelector('.divide-y')
      expect(divider).not.toBeNull()
      expect(
        hasColorClass(
          divider as Element,
          'divide-border-structural/60',
        ),
      ).toBe(true)

      // Member rows: functional text roles.
      expectClasses(
        memberName,
        ['text-text'],
        'member name',
      )
      expectClasses(
        screen.getByText('@ada'),
        ['text-text-muted'],
        'member username',
      )

      // Role select: functional field tokens.
      const roleSelect = screen.getByRole('combobox', {
        name: 'Role for Ada Lovelace',
      })
      expectClasses(
        roleSelect,
        [
          'border-border-field',
          'bg-surface',
          'text-text',
          'focus:border-focus',
          'focus:ring-2',
          'focus:ring-focus/15',
        ],
        'role select',
      )

      // Remove action: the legible danger-text role (the
      // static `danger` token only reaches 3.06:1 on the
      // Dark card surface).
      const removeButton = screen.getByRole('button', {
        name: 'Remove Ada Lovelace',
      })
      expectClasses(
        removeButton,
        [
          'text-overview-error',
          'hover:bg-danger/5',
          'disabled:opacity-45',
        ],
        'Remove action',
      )

      assertOnlyFunctionalColors(
        container,
        `Members (${theme})`,
      )
    },
  )

  it.each(['light', 'dark'] as Theme[])(
    'keeps the Add member dialog thematically consistent in %s',
    async (theme) => {
      setTheme(theme)

      const { container } = renderSettings()

      await screen.findByRole(
        'heading',
        {
          name: 'Aurora Research',
          level: 1,
        },
      )

      await screen.findByRole(
        'heading',
        { name: 'General', level: 2 },
      )

      settingsTab('Members').click()
      await screen.findByRole(
        'heading',
        { name: 'Members', level: 2 },
      )

      screen
        .getByRole('button', { name: 'Add member' })
        .click()

      const dialog = await screen.findByRole('dialog', {
        name: 'Add member',
      })

      // Overlay + card: functional scrim, surface, border.
      const overlay = dialog.parentElement as HTMLElement
      expectClasses(
        overlay,
        ['bg-overlay-scrim'],
        'dialog overlay',
      )
      expectClasses(
        dialog,
        [
          'bg-surface',
          'border-border-structural',
          'rounded-2xl',
        ],
        'dialog card',
      )

      expectClasses(
        screen.getByRole('heading', {
          name: 'Add member',
        }),
        ['text-text'],
        'dialog title',
      )
      expectClasses(
        screen.getByText(
          'Add an existing user to this research group.',
        ),
        ['text-text-muted'],
        'dialog description',
      )
      expectClasses(
        screen.getByRole('button', {
          name: 'Close dialog',
        }),
        [
          'text-text-muted',
          'hover:bg-surface-hover',
          'hover:text-text',
        ],
        'close button',
      )

      // Search field: functional field tokens.
      const searchInput = screen.getByLabelText(
        'Search person',
      )
      expectClasses(
        searchInput,
        [
          'border-border-field',
          'bg-surface',
          'text-text',
          'placeholder:text-text-muted/60',
          'focus:border-focus',
          'focus:ring-2',
          'focus:ring-focus/15',
        ],
        'search input',
      )
      expectClasses(
        screen.getByText('Enter at least 2 characters.'),
        ['text-text-muted'],
        'search hint',
      )

      // Role choice: functional selected / unselected
      // option-card treatment + themed control accent.
      const roleCards = screen
        .getByRole('group', { name: 'Role' })
        .querySelectorAll('label')
      expect(roleCards.length).toBe(2)
      const [memberCard, adminCard] = roleCards

      expectClasses(
        memberCard,
        [
          'border-border-field',
          'bg-option-selected-bg',
        ],
        'selected role card',
      )
      expectClasses(
        adminCard,
        [
          'border-border-field',
          'hover:bg-surface-hover',
        ],
        'unselected role card',
      )
      expect(
        hasColorClass(adminCard, 'bg-option-selected-bg'),
      ).toBe(false)

      const radio = screen.getByRole('radio', {
        name: 'Member',
      })
      expectClasses(
        radio,
        ['accent-control-accent'],
        'role radio',
      )

      // Search results: functional row, selected row,
      // initials chip, confirmation icon.
      vi.mocked(
        searchResearchGroupMemberCandidates,
      ).mockResolvedValue([
        {
          id: 7,
          username: 'grace',
          firstName: 'Grace',
          lastName: 'Hopper',
        },
      ])
      fireEvent.change(searchInput, {
        target: { value: 'gra' },
      })

      const candidateName = await screen.findByText(
        'Grace Hopper',
      )
      expectClasses(
        candidateName,
        ['text-text'],
        'candidate name',
      )
      expectClasses(
        screen.getByText('@grace'),
        ['text-text-muted'],
        'candidate username',
      )
      const candidateRow = candidateName.closest(
        'button',
      ) as HTMLElement
      expect(candidateRow).not.toBeNull()
      expect(
        hasColorClass(candidateRow, 'hover:bg-surface-hover'),
      ).toBe(true)
      expectClasses(
        screen.getByText('GH'),
        ['bg-surface-muted', 'text-text'],
        'candidate initials',
      )

      // Selecting the candidate: functional selected row +
      // action-colored confirmation, and the primary
      // action re-enables.
      candidateRow.click()
      await waitFor(() => {
        expect(
          hasColorClass(candidateRow, 'bg-option-selected-bg'),
        ).toBe(true)
      })
      expectClasses(
        screen.getByText('check_circle'),
        ['text-action'],
        'candidate check',
      )
      const primaryButton = await within(dialog).findByRole(
        'button',
        { name: 'Add member' },
      )
      expect(primaryButton).toBeEnabled()

      // Footer: functional band, muted Cancel, functional
      // primary action with its disabled state.
      const footer =
        dialog.querySelector('footer') as HTMLElement
      expect(footer).not.toBeNull()
      expectClasses(
        footer,
        [
          'border-t',
          'border-border-structural',
          'bg-surface-footer',
        ],
        'dialog footer',
      )
      const cancelButton = within(footer).getByRole(
        'button',
        { name: 'Cancel' },
      )
      expectClasses(
        cancelButton,
        [
          'text-text-muted',
          'hover:bg-surface-hover',
          'hover:text-text',
        ],
        'Cancel button',
      )

      assertOnlyFunctionalColors(
        container,
        `Add member dialog (${theme})`,
      )
    },
  )

  it.each(['light', 'dark'] as Theme[])(
    'keeps the Remove member dialog thematically consistent in %s',
    async (theme) => {
      setTheme(theme)

      const { container } = renderSettings()

      await screen.findByRole(
        'heading',
        {
          name: 'Aurora Research',
          level: 1,
        },
      )

      await screen.findByRole(
        'heading',
        { name: 'General', level: 2 },
      )

      settingsTab('Members').click()
      await screen.findByRole(
        'heading',
        { name: 'Members', level: 2 },
      )

      screen
        .getByRole('button', { name: 'Remove Alan Turing' })
        .click()

      const dialog = await screen.findByRole('alertdialog',
        { name: 'Remove member' },
      )

      const overlay = dialog.parentElement as HTMLElement
      expectClasses(
        overlay,
        ['bg-overlay-scrim'],
        'dialog overlay',
      )
      expectClasses(
        dialog,
        [
          'bg-surface',
          'border-border-structural',
          'rounded-2xl',
        ],
        'dialog card',
      )

      expectClasses(
        screen.getByRole('heading', {
          name: 'Remove member',
        }),
        ['text-text'],
        'dialog title',
      )
      expectClasses(
        screen.getByText(
          'Remove Alan Turing from this research group.',
        ),
        ['text-text-muted'],
        'dialog description',
      )

      // Impact summary: functional inset surface.
      await screen.findByText(
        'No project responsibilities',
      )
      const infoBox = screen
        .getByText('No project responsibilities')
        .parentElement as HTMLElement
      expectClasses(
        infoBox,
        [
          'border-border-subtle',
          'bg-surface-subtle',
        ],
        'impact summary',
      )
      expectClasses(
        screen.getByText('No project responsibilities'),
        ['text-text'],
        'impact summary title',
      )
      expectClasses(
        screen.getByText(
          'Historical authorship and activity are preserved.',
        ),
        ['text-text-muted'],
        'impact summary description',
      )

      // Footer: functional band, bordered Cancel,
      // functional danger action.
      const footer =
        dialog.querySelector('footer') as HTMLElement
      expectClasses(
        footer,
        [
          'border-t',
          'border-border-structural',
        ],
        'dialog footer',
      )
      const cancelButton = within(footer).getByRole(
        'button',
        { name: 'Cancel' },
      )
      expectClasses(
        cancelButton,
        [
          'border-border-field',
          'text-text',
          'hover:bg-surface-hover',
          'disabled:opacity-45',
        ],
        'Cancel button',
      )
      const removeButton = within(footer).getByRole(
        'button',
        { name: 'Remove member' },
      )
      expectClasses(
        removeButton,
        [
          'bg-danger',
          'text-text-inverse',
          'disabled:opacity-40',
        ],
        'Remove member button',
      )
      expect(removeButton).toBeEnabled()

      assertOnlyFunctionalColors(
        container,
        `Remove member dialog (${theme})`,
      )
    },
  )

  it.each(['light', 'dark'] as Theme[])(
    'keeps the Remove member dialog error state legible in %s',
    async (theme) => {
      setTheme(theme)

      const { container } = renderSettings({
        offboardingLoad: 'reject',
        offboardingError: new Error('Preview failed'),
      })

      await screen.findByRole(
        'heading',
        {
          name: 'Aurora Research',
          level: 1,
        },
      )

      await screen.findByRole(
        'heading',
        { name: 'General', level: 2 },
      )

      settingsTab('Members').click()
      await screen.findByRole(
        'heading',
        { name: 'Members', level: 2 },
      )

      screen
        .getByRole('button', { name: 'Remove Alan Turing' })
        .click()

      await screen.findByRole('alertdialog', {
        name: 'Remove member',
      })

      const message = await screen.findByText(
        'Preview failed',
      )
      expectClasses(
        message,
        ['text-overview-error'],
        'dialog error message',
      )
      const alert = message.closest('[role="alert"]')
      expect(alert).not.toBeNull()
      expectClasses(
        alert as Element,
        [
          'border-danger/20',
          'bg-danger/5',
        ],
        'dialog error alert',
      )
      expect(
        hasColorClass(message, 'text-error'),
      ).toBe(false)
      expect(
        hasColorClass(message, 'text-danger'),
      ).toBe(false)

      assertOnlyFunctionalColors(
        container,
        `Remove dialog error (${theme})`,
      )
    },
  )

  it.each(['light', 'dark'] as Theme[])(
    'keeps the permission refusal legible in %s',
    async (theme) => {
      setTheme(theme)

      const nonAdminGroup: ApiResearchGroup = {
        ...GROUP,
        role: 'member',
      }

      const { container } = renderSettings({
        groups: [nonAdminGroup],
        group: nonAdminGroup,
      })

      await screen.findByRole(
        'heading',
        {
          name: 'Aurora Research',
          level: 1,
        },
      )

      const note = await screen.findByText(
        'Research group settings are managed by admins.',
      )
      expectClasses(
        note,
        ['text-text-muted'],
        'permission note',
      )
      expectClasses(
        note.parentElement as Element,
        ['border-t', 'border-border-subtle'],
        'permission note border',
      )

      assertOnlyFunctionalColors(
        container,
        `permission refusal (${theme})`,
      )
    },
  )

  it.each(['light', 'dark'] as Theme[])(
    'keeps the load error legible in %s',
    async (theme) => {
      setTheme(theme)

      const { container } = renderSettings({
        groupLoad: 'reject',
        groupLoadError: new ApiError(
          500,
          { error: 'Load failed' },
        ),
      })

      // The workspace chrome (header + tabs) stays up; the
      // Settings content shows its traceable load error on
      // the canvas.
      await screen.findByRole(
        'heading',
        {
          name: 'Aurora Research',
          level: 1,
        },
      )

      const message = await screen.findByText(
        'Load failed',
      )
      expectClasses(
        message,
        ['text-overview-error'],
        'load error message',
      )
      expect(
        hasColorClass(message, 'text-error'),
      ).toBe(false)
      expect(
        hasColorClass(message, 'text-danger'),
      ).toBe(false)

      assertOnlyFunctionalColors(
        container,
        `load error (${theme})`,
      )
    },
  )

  it.each(['light', 'dark'] as Theme[])(
    'renders a muted loading spinner while the settings resolve in %s',
    async (theme) => {
      setTheme(theme)

      const { container } = renderSettings({
        groupLoad: 'pending',
      })

      await screen.findByRole(
        'heading',
        {
          name: 'Aurora Research',
          level: 1,
        },
      )

      const spinner = await screen.findByText(
        'refresh',
      )
      expectClasses(
        spinner,
        ['text-text-muted'],
        'settings spinner',
      )

      assertOnlyFunctionalColors(
        container,
        `settings loading (${theme})`,
      )
    },
  )

  it.each(['light', 'dark'] as Theme[])(
    'keeps the essential Settings text/background pairs at WCAG AA in %s',
    (theme) => {
      /*
       * Value-based contrast contract, resolved per theme
       * from the canonical stylesheet (the same pattern as
       * the workspace theme contract): the class assertions
       * above pin WHICH role each surface consumes, this
       * pins that the bound PAIRS clear WCAG AA for normal
       * text (4.5:1) in BOTH themes. `danger` is a
       * deliberately static token (identical in both
       * themes), so it is always read from the Light
       * @theme block.
       */
      const themeBlock = cssBlock(
        indexCss,
        theme === 'light'
          ? '@theme'
          : "html[data-theme='dark']",
      )
      const staticBlock = cssBlock(
        indexCss,
        '@theme',
      )

      const pairs: Array<[string, string, string]> = [
        // Page + card text on the canvas / card surface.
        ['text', 'canvas', themeBlock],
        ['text', 'surface', themeBlock],
        // Secondary text on the card surface and the
        // support chip surface.
        ['text-muted', 'surface', themeBlock],
        ['text-muted', 'surface-muted', themeBlock],
        ['text', 'surface-muted', themeBlock],
        // Error / danger text on the canvas (load error,
        // not-found style message).
        ['overview-error', 'canvas', themeBlock],
        // Button labels on the primary and danger actions.
        ['text-inverse', 'action', themeBlock],
        ['text-inverse', 'danger', staticBlock],
      ]

      pairs.forEach(([fg, bg, block]) => {
        expect(
          contrastRatio(
            tokenHex(block, fg),
            tokenHex(block, bg),
          ),
          `${fg} on ${bg} (${theme})`,
        ).toBeGreaterThanOrEqual(4.5)
      })
    },
  )
})

/** The declaration body of the flat CSS block starting at `marker`. */
function cssBlock(css: string, marker: string): string {
  const start = css.indexOf(marker)
  expect(
    start,
    `stylesheet block ${marker} must exist`,
  ).toBeGreaterThanOrEqual(0)
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

/** The hex value of `--color-<token>` inside a block. */
function tokenHex(block: string, token: string): string {
  const match = block.match(
    new RegExp(
      `--color-${token}:\\s*(#[0-9a-fA-F]{6})\\s*;`,
    ),
  )
  expect(
    match,
    `--color-${token} must be a hex token`,
  ).not.toBeNull()
  return match ? match[1] : ''
}

function srgbChannel(value: number): number {
  const scaled = value / 255

  return scaled <= 0.03928
    ? scaled / 12.92
    : ((scaled + 0.055) / 1.055) ** 2.4
}

/** WCAG 2.x relative luminance of a #rrggbb color. */
function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)

  return (
    0.2126 * srgbChannel(r) +
    0.7152 * srgbChannel(g) +
    0.0722 * srgbChannel(b)
  )
}

/** WCAG 2.x contrast ratio (1..21) between two colors. */
function contrastRatio(
  a: string,
  b: string,
): number {
  const la = luminance(a)
  const lb = luminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)

  return (hi + 0.05) / (lo + 0.05)
}
