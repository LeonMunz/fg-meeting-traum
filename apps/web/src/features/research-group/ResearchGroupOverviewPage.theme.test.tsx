// @vitest-environment happy-dom
/**
 * Research Group Overview theme contract (Dark + Light).
 *
 * Proves the rendered Overview — heading, subtitle, description, the
 * project-style section tab bar (Overview / Projects / Meetings,
 * Settings for admins), and the loading, error, and not-found states —
 * is bound to the semantic functional tokens of `index.css` (the same
 * vocabulary the migrated shell and the Project Detail section tabs
 * consume), never to the static legacy Material tokens
 * (`on-surface`, `on-surface-variant`, `surface-container*`,
 * `outline-variant`, `error`) or to raw colors, in BOTH themes through
 * the central `data-theme` switch the Appearance feature owns.
 *
 * Division of labor (no duplication):
 *   - THIS suite pins the rendered class bindings of the Overview
 *     surfaces — including the tab bar's Project-Detail treatment
 *     (38px bar, 28px gaps, subtle bottom border, 13px medium labels,
 *     2px underline on the active tab, no button surface) — plus the
 *     WCAG AA (4.5:1) contrast of the error message on the canvas
 *     (resolved per theme from the canonical stylesheet) and that no
 *     legacy / raw color class survives;
 *   - `ResearchGroupOverviewPage.test.tsx` pins routing, group-scoped
 *     destinations, tab order, and the admin-only Settings
 *     visibility;
 *   - `e2e/token-contract.test.ts` pins the approved Light/Dark VALUES
 *     of those semantic tokens.
 *
 * Together they prove the Overview keeps one stable class binding while
 * the central data-theme switch re-resolves every bound token, so Dark
 * -> Light and Light -> Dark both render a legible, on-system surface.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import {
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
import { getResearchGroup } from '../../api/research-groups'

import { ResearchGroupOverviewPage } from './ResearchGroupOverviewPage'

/*
 * Canonical stylesheet, read from disk (the same pattern as
 * `e2e/token-contract.test.ts`): the WCAG AA check below resolves
 * the token VALUES per theme instead of hard-coding them, so a
 * value change in index.css is caught here. Read directly (not
 * through the Vite module pipeline) because the unit suite stubs
 * CSS — `?raw` included — to an empty string.
 */
const indexCss = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../index.css',
  ),
  'utf8',
)

vi.mock('../../api/research-groups', () => ({
  getResearchGroup: vi.fn(),
  listResearchGroups: vi.fn(),
  listResearchGroupMemberships: vi.fn(),
  updateResearchGroup: vi.fn(),
  updateResearchGroupMembership: vi.fn(),
}))

vi.mock('./useSyncResearchGroupContext', () => ({
  useSyncResearchGroupContext: () => {},
}))

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

/*
 * The exact legacy Material utilities the Overview must no longer
 * consume. They are static across themes and were the root cause of
 * the Dark Mode defects (dark-blue title, white buttons, pale
 * divider).
 */
const FORBIDDEN_LEGACY_TOKENS = new Set([
  'text-on-surface',
  'text-on-surface-variant',
  'border-outline-variant',
  'bg-surface-container-lowest',
  'bg-surface-container',
  'hover:bg-surface-container',
  'text-error',
])

/*
 * Raw (non-token) color classes are the other failure mode this
 * migration removes: arbitrary hex values and static white / black
 * alpha treatments that cannot follow the theme.
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

/**
 * The tab bar must render with the Project Detail section-tab
 * treatment (see ProjectDetailPage): a 38px-tall bar on a subtle
 * full-width bottom border, 28px gaps, horizontally overflowing on
 * narrow viewports, 13px medium labels, a 2px `bg-text` underline on
 * the active tab only, muted text + hover for the inactive tabs, and
 * the canonical visible keyboard focus. The former button surface
 * (fill, border, hover background, icons) must be gone.
 *
 * `expectedLabels` pins the tab order; the FIRST tab (Overview) is
 * the active tab on the Overview route.
 */
function assertProjectStyleTabBar(
  nav: HTMLElement,
  expectedLabels: string[],
) {
  const navClasses = exactClasses(nav)

  for (const utility of [
    'h-[38px]',
    'gap-7',
    'overflow-x-auto',
    'items-stretch',
    'border-b',
    'border-border-subtle',
  ]) {
    expect(navClasses, `nav ${utility}`).toContain(utility)
  }

  const links = Array.from(
    nav.querySelectorAll('a'),
  ) as HTMLElement[]

  expect(
    links.map((link) => link.textContent),
  ).toEqual(expectedLabels)

  links.forEach((link, index) => {
    const selected = index === 0
    const classes = exactClasses(link)

    // Project-Detail tab typography and overflow behavior.
    for (const utility of [
      'text-[13px]',
      'font-medium',
      'leading-5',
      'shrink-0',
      'relative',
      'flex',
      'items-center',
    ]) {
      expect(classes, `tab ${utility}`).toContain(utility)
    }

    // Visible keyboard focus in the canonical focus token.
    for (const utility of [
      'outline-none',
      'focus-visible:ring-2',
      'focus-visible:ring-focus',
    ]) {
      expect(classes, `tab ${utility}`).toContain(utility)
    }

    // No former button surface: no fill, no border, no hover
    // background, no rounded pill, no icon inside the tab.
    for (const utility of [
      'bg-surface-quiet',
      'border-border-subtle',
      'hover:bg-surface-hover',
      'rounded-lg',
      'h-9',
      'px-3.5',
    ]) {
      expect(classes, `tab !${utility}`).not.toContain(utility)
    }
    expect(
      link.querySelector('.material-symbols-outlined'),
    ).toBeNull()

    if (selected) {
      // Active tab: neutral primary text + 2px underline,
      // marked for assistive tech via aria-current.
      expect(classes).toContain('text-text')
      expect(classes).not.toContain('text-text-muted')
      expect(link).toHaveAttribute('aria-current', 'page')

      const underline =
        link.querySelector('span[aria-hidden="true"]')
      expect(underline).not.toBeNull()
      const underlineClasses = exactClasses(
        underline as Element,
      )
      for (const utility of [
        'absolute',
        'inset-x-0',
        'bottom-0',
        'h-0.5',
        'bg-text',
      ]) {
        expect(underlineClasses, `underline ${utility}`).toContain(
          utility,
        )
      }
    } else {
      // Inactive tabs: muted text turning primary on
      // hover, no underline, no aria-current.
      expect(classes).toContain('text-text-muted')
      expect(classes).toContain('hover:text-text')
      expect(classes).not.toContain('text-text')
      expect(
        link.querySelector('span[aria-hidden="true"]'),
      ).toBeNull()
      expect(link).not.toHaveAttribute('aria-current')
    }
  })
}

function renderOverview(initialPath: string) {
  const router = createMemoryRouter(
    [
      {
        path: '/groups/:groupId',
        element: <ResearchGroupOverviewPage />,
      },
    ],
    { initialEntries: [initialPath] },
  )

  return render(
    <RouterProvider router={router} />,
  )
}

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

beforeEach(() => {
  vi.clearAllMocks()

  ;(getResearchGroup as ReturnType<typeof vi.fn>)
    .mockReset()
})

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.theme
})

describe('ResearchGroupOverviewPage theme contract', () => {
  it.each(['light', 'dark'] as Theme[])(
    'binds every Overview surface to functional tokens in %s',
    async (theme) => {
      setTheme(theme)

      ;(getResearchGroup as ReturnType<typeof vi.fn>)
        .mockResolvedValue({
          id: 11,
          name: 'Aurora Research',
          role: 'member',
        })

      const { container } =
        renderOverview('/groups/11')

      const heading = await screen.findByRole(
        'heading',
        { name: 'Aurora Research' },
      )

      expect(hasColorClass(heading, 'text-text')).toBe(true)

      const subtitle = screen.getByText(
        'Research group overview',
      )
      expect(hasColorClass(subtitle, 'text-text-muted')).toBe(true)

      const description = screen.getByText(
        'This is the overview for this research group. Open its projects and meetings from here.',
      )
      expect(
        hasColorClass(description, 'text-text-muted'),
      ).toBe(true)

      // The description keeps its functional muted-text
      // binding; the tab bar (not the content section) is
      // now the divider below the header.
      const nav = screen.getByRole('navigation', {
        name: 'Research group sections',
      })
      assertProjectStyleTabBar(
        nav,
        ['Overview', 'Projects', 'Meetings'],
      )

      assertOnlyFunctionalColors(
        container,
        `overview (${theme})`,
      )
    },
  )

  it.each(['light', 'dark'] as Theme[])(
    'offers all four section tabs with the same treatment for admins in %s',
    async (theme) => {
      setTheme(theme)

      ;(getResearchGroup as ReturnType<typeof vi.fn>)
        .mockResolvedValue({
          id: 12,
          name: 'Beacon Lab',
          role: 'admin',
        })

      renderOverview('/groups/12')

      await screen.findByRole(
        'heading',
        { name: 'Beacon Lab' },
      )

      expect(
        screen.getByRole('link', { name: 'Projects' }),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('link', { name: 'Meetings' }),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('link', { name: 'Settings' }),
      ).toBeInTheDocument()

      const nav = screen.getByRole('navigation', {
        name: 'Research group sections',
      })
      assertProjectStyleTabBar(
        nav,
        [
          'Overview',
          'Projects',
          'Meetings',
          'Settings',
        ],
      )
    },
  )

  it.each(['light', 'dark'] as Theme[])(
    'keeps the not-found / error state legible in %s',
    async (theme) => {
      setTheme(theme)

      ;(getResearchGroup as ReturnType<typeof vi.fn>)
        .mockRejectedValue(
          new ApiError(
            404,
            { error: 'Research group not found' },
          ),
        )

      renderOverview('/groups/99')

      const heading = await screen.findByRole(
        'heading',
        { name: 'Research group' },
      )
      expect(hasColorClass(heading, 'text-text')).toBe(true)

      await waitFor(() => {
        const message = screen.getByText(
          'Research group not found',
        )
        // The message must bind the themeable overview-error
        // role, never the static `danger` token (3.38:1 in
        // Dark) — see the WCAG AA value check below.
        expect(
          hasColorClass(message, 'text-overview-error'),
        ).toBe(true)
        expect(
          hasColorClass(message, 'text-danger'),
        ).toBe(false)
      })

      assertOnlyFunctionalColors(
        document.body,
        `not-found (${theme})`,
      )
    },
  )

  it.each(['light', 'dark'] as Theme[])(
    'keeps the error message at WCAG AA (4.5:1) on the canvas in %s',
    (theme) => {
      /*
       * Value-based contrast contract: the not-found / error
       * message renders directly on the AppShell canvas
       * (`bg-canvas`, no intermediate background in that view),
       * so the pair `overview-error` on `canvas` — resolved per
       * theme from the canonical stylesheet — must clear WCAG AA
       * for normal text. The class assertions in the not-found
       * test pin that the message consumes `overview-error`.
       */
      const block = cssBlock(
        indexCss,
        theme === 'light'
          ? '@theme'
          : "html[data-theme='dark']",
      )

      expect(
        contrastRatio(
          tokenHex(block, 'overview-error'),
          tokenHex(block, 'canvas'),
        ),
      ).toBeGreaterThanOrEqual(4.5)
    },
  )

  it.each(['light', 'dark'] as Theme[])(
    'renders a muted loading spinner in %s',
    async (theme) => {
      setTheme(theme)

      ;(getResearchGroup as ReturnType<typeof vi.fn>)
        .mockReturnValue(
          new Promise<never>(() => {}),
        )

      const { container } =
        renderOverview('/groups/11')

      const spinner = await screen.findByText('refresh')
      expect(
        hasColorClass(spinner, 'text-text-muted'),
      ).toBe(true)

      assertOnlyFunctionalColors(
        container,
        `loading (${theme})`,
      )
    },
  )
})
