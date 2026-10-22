#!/usr/bin/env node
/**
 * Turnkey browser layout check for the shared workspace content
 * width contract (Projects + Meetings constrained frame).
 *
 * Renders the REAL `ProjectListPage` and `MeetingListPage`
 * (fetch stubbed with date-relative fixtures, inside the real
 * `ResearchGroupProvider`) against the REAL production CSS (fresh
 * `vite build`), inside a shell that mirrors the app's width chain
 * (fixed 240px sidebar + 64px topbar + page padding).
 *
 * Contract under test (see
 * `apps/web/src/components/layout/WorkspaceContent.tsx`):
 * - ordinary content is constrained: fluid below the cap, centered,
 *   capped at `--workspace-content-max-width` (1280px) on wide
 *   desktops;
 * - no horizontal overflow at any tested width;
 * - the full-width (Kanban) exemption stays available via
 *   `variant="full"` (asserted by unit tests, not exercised here —
 *   no full-width page is rendered).
 *
 * Viewports: 1440 / 1680 / 1920 (desktop), 900 (tablet), 390
 * (mobile); desktop viewports are checked in Light and Dark.
 *
 * In every rendered iteration the harness ALSO measures the
 * COMPUTED (browser) size of the primary page action icons —
 * the Projects New-project plus icon, the Meetings
 * Meeting-Templates icon, and the Meetings New-meeting plus
 * icon (each contracted to 18px) — plus the already-pinned
 * 16px Upcoming row action icons, the button geometry
 * (36px height / 13px / weight 500), and a FONT EVIDENCE GATE
 * built from browser-side evidence only (reading the
 * cross-origin sheet's cssRules is NOT reliable: a no-cors
 * cross-origin stylesheet throws SecurityError on cssRules
 * even when the CSS loaded fine):
 *   - the external Google Fonts Material Symbols <link>
 *     dispatched its `load` event — the listener is registered
 *     in the harness BEFORE the sheet can load (synchronous
 *     head script right after the <link>, so no event can be
 *     lost), and the mere presence of the <link> element is
 *     never evidence. (The cross-origin no-cors sheet's
 *     resource-timing responseStatus is opaque (0) by spec and
 *     is NOT a usable load proof — diagnostics only),
 *   - the Material Symbols font face actually loads
 *     (document.fonts.load resolves to a loaded face),
 *   - a controlled UNCORRECTED probe element (only the
 *     `.material-symbols-outlined` class, no local correction
 *     class) computes the external unlayered 24px default:
 *     without the external rule a passing icon size is no
 *     evidence (the Tailwind utility would win trivially).
 *
 * Self-test of the gate: `--font-negative` blocks the external
 * Material Symbols stylesheet for the whole run and asserts
 * that EVERY independent proof of the gate (sheet load, font
 * availability, uncorrected probe) FAILS while the icon-target
 * checks keep passing (exit 0 = the gate reliably detects the
 * missing font on every proof — a gate failure of unknown
 * origin does not count).
 *
 * Run from the repository root in a standard dev environment — one
 * where Playwright's Chromium launches. (In the agent sandbox the
 * browser gate is `blocked_sandbox`, so the check cannot run there;
 * the harness below is then kept on disk for manual review.)
 *
 *   node scripts/visual/workspace-content-width-check.mjs
 *
 * Outputs (`.artifacts/workspace-content-visual/`):
 *   - measurements.json        per-viewport computed geometry,
 *                              icon sizes, font load status
 *   - harness.html             standalone harness (open in any
 *                              Chromium-based browser; hashes:
 *                              #/projects, #/meetings, append
 *                              ?dark for the dark theme)
 *   - <page>-<viewport>-<theme>.png screenshots
 *
 * Exit code 0 = all layout assertions pass; 1 = at least one
 * failed. In `--font-negative` mode: 0 = the gate correctly
 * failed on the blocked font while the icon-target checks kept
 * passing; 1 = the gate misbehaved.
 */

import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..', '..')
const WEB = path.join(ROOT, 'apps', 'web')
const OUT = path.join(ROOT, '.artifacts', 'workspace-content-visual')
const ENTRY = path.join(WEB, '.workspace-visual-entry.tsx')
const VITE_CONFIG = path.join(WEB, '.workspace-visual.vite.config.mts')

const MAX_WIDTH = 1280
const DESKTOP_VIEWPORTS = [1440, 1680, 1920]
const NARROW_VIEWPORTS = [900, 390]
const PAGES = ['projects', 'meetings']
// --font-negative: self-test of the font evidence gate. Blocks
// the external Material Symbols stylesheet for the whole run
// (the <link> element stays in the DOM) and asserts that the
// gate FAILS while the icon-target checks (the local
// corrections) keep PASSing. Exit 0 = the gate reliably
// detects the missing font.
const FONT_NEGATIVE = process.argv.includes('--font-negative')

// Primary page action icon contract — asserted against the
// COMPUTED browser values, never against the JSX classes. The
// external Google Fonts Material Symbols stylesheet is UNLAYERED:
// it ships `.material-symbols-outlined { font-size: 24px; ... }`
// outside any cascade layer, so it beats every Tailwind utility
// (Tailwind v4 emits utilities in the `utilities` cascade layer).
// A `text-[18px]` class on the icon therefore does NOT pin the
// artwork size; only a local unlayered two-class (0,2,0) rule
// can — the established pattern of `UpcomingMeetings.css` and
// `MeetingDetailPage.css`.
const ICON_TARGETS = {
  projects: [
    {
      id: 'projects-new-project-plus',
      buttonLabel: 'New project',
      expectedPx: 18,
    },
  ],
  meetings: [
    {
      id: 'meetings-meeting-templates-icon',
      buttonLabel: 'Meeting Templates',
      expectedPx: 18,
    },
    {
      id: 'meetings-new-meeting-plus',
      buttonLabel: 'New meeting',
      expectedPx: 18,
    },
  ],
}
// The already-pinned 16px Upcoming row action icons (the
// `.fg-upcoming-row-icon.material-symbols-outlined` rule in
// `UpcomingMeetings.css`) must stay 16px — regression guard
// against accidental unification.
const UPCOMING_ROW_ICON_EXPECTED_PX = 16
// Button geometry of the primary page actions — must not change
// while the icon artwork size is corrected.
const PRIMARY_BUTTON = {
  height: '36px',
  fontSize: '13px',
  fontWeight: '500',
}

let failures = 0
const groupFailCounts = {}
function check(label, ok, detail = '', group = null) {
  const mark = ok ? 'PASS' : 'FAIL'
  if (!ok) {
    failures += 1
    if (group) {
      groupFailCounts[group] = (groupFailCounts[group] || 0) + 1
    }
  }
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`)
}

/* ── Fixture routing: shared resolution + regression checks ──── */
// API prefix -> fixture name served by the embedded fetch stub.
// Resolution is LONGEST-PREFIX-FIRST, so the specific routes
// /api/research-groups/11/projects/ and
// /api/research-groups/11/meetings/ take precedence over the
// generic /api/research-groups/ prefix. (The former
// insertion-order Object.keys(ROUTES).find(url.startsWith) let
// the bare /api/research-groups/ prefix match the Project and
// Meeting list requests first and serve them the GROUPS
// fixture.)
const ROUTE_FIXTURES = {
  '/api/research-groups/': 'GROUPS',
  '/api/research-groups/11/projects/': 'PROJECTS',
  '/api/research-groups/11/meetings/': 'MEETINGS',
  '/api/meeting-recurrences/occurrences/': 'OCCURRENCES',
}

// Longest-prefix-first resolution: deterministic and
// independent of object key insertion order. This EXACT
// function is injected verbatim (via .toString()) into the
// embedded fetch stub below, so the regression checks assert
// the shipped routing logic itself.
function resolveFixtureKey(url, prefixes) {
  return (
    prefixes
      .slice()
      .sort((a, b) => b.length - a.length)
      .find((k) => url.startsWith(k)) || null
  )
}

function resolveFixture(url) {
  const key = resolveFixtureKey(url, Object.keys(ROUTE_FIXTURES))
  return key ? { key, fixture: ROUTE_FIXTURES[key] } : null
}

// Regression: the four explicit request -> fixture assignments
// (the real client URLs of listProjects / listMeetings /
// listPersonalMeetingRecurrenceOccurrences). If a Project- or
// Meeting-list request ever resolved to GROUPS again, one of
// these checks fails.
const ROUTING_CASES = [
  ['/api/research-groups/', 'GROUPS'],
  [
    '/api/research-groups/11/projects/?includeArchived=true',
    'PROJECTS',
  ],
  ['/api/research-groups/11/meetings/', 'MEETINGS'],
  [
    '/api/meeting-recurrences/occurrences/?from=2026-10-22T00:00:00Z&to=2026-12-03T00:00:00Z',
    'OCCURRENCES',
  ],
]
for (const [url, expectedFixture] of ROUTING_CASES) {
  const hit = resolveFixture(url)
  check(
    `fixture routing: ${url} -> ${expectedFixture}`,
    hit != null && hit.fixture === expectedFixture,
    hit
      ? `served ${hit.fixture} via prefix ${hit.key}`
      : 'no fixture matched the request',
  )
}

/* ── 1. Fresh production build (the contract lives in compiled CSS) ── */

console.log('== Building production frontend (fresh CSS) ==')
const build = spawnSync(
  'npm',
  ['run', 'build', '--workspace=web'],
  {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
)
if (build.status !== 0) {
  console.error('Production build failed — cannot verify layout.')
  process.exit(1)
}
const cssName = readFileSync(
  path.join(WEB, 'dist', 'index.html'),
  'utf8',
)
  .match(/assets\/(index-[^"]+\.css)/)
  ?.[1]
if (!cssName) {
  console.error('Could not locate the built CSS in dist/index.html.')
  process.exit(1)
}

/* ── 2. Bundle the REAL pages with a throwaway vite build ────────── */

mkdirSync(OUT, { recursive: true })
rmSync(path.join(OUT, 'assets'), { recursive: true, force: true })

writeFileSync(
  ENTRY,
  `import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router'

import { ResearchGroupProvider } from './src/features/research-group/ResearchGroupProvider'
import { MeetingListPage } from './src/features/meetings/MeetingListPage'
import { ProjectListPage } from './src/features/projects/ProjectListPage'

/* ── Date-relative fixtures (always inside the +42d window) ────── */

function localIso(
  dayOffset: number,
  hour: number,
  minute: number,
): string {
  const d = new Date()
  d.setDate(d.getDate() + dayOffset)
  d.setHours(hour, minute, 0, 0)
  return d.toISOString()
}

const GROUPS = [
  { id: 11, name: 'Bravo Group', role: 'member' },
]

const PROJECTS = [
  {
    id: 201,
    researchGroupId: 11,
    name: 'Quantum Materials Characterization Platform',
    description:
      'Shared instrument access, sample pipeline and characterization protocol consolidation for the materials team.',
    status: 'active',
    archivedAt: null,
    currentUserRole: 'owner',
    createdAt: '2026-01-05T08:00:00Z',
    updatedAt: localIso(0, 8, 15),
  },
  {
    id: 202,
    researchGroupId: 11,
    name: 'Long-Running Field Deployment & Data Archive',
    description:
      'Sensor field site operations, raw data archival, and quarterly integrity audits across three deployment zones.',
    status: 'paused',
    archivedAt: null,
    currentUserRole: 'member',
    createdAt: '2025-11-20T08:00:00Z',
    updatedAt: localIso(1, 17, 40),
  },
  {
    id: 203,
    researchGroupId: 11,
    name: 'Grant Horizon 2027 Writing Sprint',
    description:
      'Cross-group proposal drafting, budget alignment and reviewer Q&A preparation for the Horizon 2027 call.',
    status: 'active',
    archivedAt: null,
    currentUserRole: 'viewer',
    createdAt: '2026-03-12T08:00:00Z',
    updatedAt: localIso(2, 11, 5),
  },
]

const MEETINGS = [
  {
    id: 301,
    researchGroupId: 11,
    scope: 'group',
    projectId: null,
    seriesId: null,
    title: 'Weekly Group Sync',
    scheduledAt: localIso(0, 16, 0),
    startedAt: null,
    endedAt: null,
    status: 'upcoming',
    currentMeetingItemId: null,
    participantIds: [1, 2, 3, 4],
    // Drives the direct row actions (Edit pencil + destructive
    // trash) on this concrete row so the harness can re-measure
    // the already-pinned 16px row action icon artwork
    // (regression guard against accidental unification).
    actionPermissions: {
      canEdit: true,
      canDelete: true,
      canCancel: false,
    },
    createdById: 1,
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-01T08:00:00Z',
  },
  {
    id: 302,
    researchGroupId: 11,
    scope: 'group',
    projectId: null,
    seriesId: null,
    title: 'Instrument Calibration Review',
    scheduledAt: localIso(1, 9, 30),
    startedAt: null,
    endedAt: null,
    status: 'upcoming',
    currentMeetingItemId: null,
    participantIds: [1, 2],
    createdById: 1,
    createdAt: '2026-09-02T08:00:00Z',
    updatedAt: '2026-09-02T08:00:00Z',
  },
  {
    id: 303,
    researchGroupId: 11,
    scope: 'group',
    projectId: null,
    seriesId: null,
    title: 'Grant Writing Session — Horizon Deadline',
    scheduledAt: localIso(3, 14, 0),
    startedAt: null,
    endedAt: null,
    status: 'upcoming',
    currentMeetingItemId: null,
    participantIds: [1, 2, 3],
    createdById: 1,
    createdAt: '2026-09-03T08:00:00Z',
    updatedAt: '2026-09-03T08:00:00Z',
  },
]

const OCCURRENCES = [
  {
    occurrenceId: 'occ-v1',
    recurrenceId: 50,
    title: 'Monthly Research Readout',
    originalScheduledAt: localIso(5, 10, 0),
    scheduledAt: localIso(5, 10, 0),
    materialized: false,
    meetingId: null,
    meetingSeriesId: 9,
    researchGroupId: 11,
    projectId: null,
  },
]

const ROUTES: Record<string, unknown> = {
  '/api/research-groups/': GROUPS,
  '/api/research-groups/11/projects/': PROJECTS,
  '/api/research-groups/11/meetings/': MEETINGS,
  '/api/meeting-recurrences/occurrences/': OCCURRENCES,
}

// Longest-prefix-first fixture resolution: injected verbatim
// from the harness (resolveFixtureKey.toString()), so the
// tested routing logic and the shipped fetch stub cannot drift
// apart.
${resolveFixtureKey.toString()}

window.fetch = (async (input: unknown) => {
  const url = String(
    typeof input === 'string'
      ? input
      : (input as Request).url,
  )
  const key = resolveFixtureKey(url, Object.keys(ROUTES))
  const body = key ? ROUTES[key] : []
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}) as typeof fetch

/* ── Hash-driven page + theme selection ──────────────────────────── */

const hash = window.location.hash.replace(/^#\\/?/, '')
const [route, themeQuery] = hash.split('?')
const page = route === 'meetings' ? 'meetings' : 'projects'

document.documentElement.dataset.theme =
  themeQuery === 'dark' ? 'dark' : 'light'

createRoot(
  document.getElementById('root') as HTMLElement,
).render(
  <MemoryRouter initialEntries={['/' + page]}>
    <ResearchGroupProvider>
      {page === 'projects' ? (
        <ProjectListPage />
      ) : (
        <MeetingListPage />
      )}
    </ResearchGroupProvider>
  </MemoryRouter>,
)
`,
)

writeFileSync(
  VITE_CONFIG,
  `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '${path
      .relative(WEB, OUT)
      .replace(/\\/g, '/')}',
    emptyOutDir: false,
    rollupOptions: {
      input: { 'workspace-visual': '.workspace-visual-entry.tsx' },
      output: { format: 'iife' },
    },
  },
})
`,
)

console.log(
  '== Bundling the real ProjectListPage + MeetingListPage ==',
)
const bundle = spawnSync(
  'npx',
  ['vite', 'build', `--config=${VITE_CONFIG}`],
  {
    cwd: WEB,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
)
if (bundle.status !== 0) {
  console.error('Component bundle build failed.')
  process.exit(1)
}
const assetsDir = path.join(OUT, 'assets')
const bundleMatch = existsSync(assetsDir)
  ? readdirSync(assetsDir).find((f) =>
      f.startsWith('workspace-visual-') &&
      f.endsWith('.js'),
    )
  : undefined
if (!bundleMatch) {
  console.error(
    'Could not locate the bundle in the harness build output.',
  )
  process.exit(1)
}
const bundleFile = bundleMatch

/* ── 3. Harness page mirroring the app shell width chain ─────────── */

// Copy the production CSS next to the harness so the kept harness
// stays self-contained (independent of a later `dist` rebuild).
cpSync(
  path.join(WEB, 'dist', 'assets', cssName),
  path.join(OUT, 'assets', 'index-prod.css'),
)

const htmlPath = path.join(OUT, 'harness.html')
writeFileSync(
  htmlPath,
  `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
<link id="fg-material-symbols" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1" rel="stylesheet" />
<script>
  // FONT EVIDENCE GATE — pre-load registration: this inline
  // script runs synchronously while the parser is in <head>,
  // immediately after the Material Symbols <link> above entered
  // the DOM. The link's load/error events are dispatched as
  // tasks only after its fetch settles (network or HTTP cache)
  // — never during this synchronous parse step — so these
  // listeners cannot miss an event, even for a cache hit that
  // settles near-instantly.
  window.__fgSymbolsEvidence = {
    registeredAt: performance.now(),
    loadFired: false,
    errorFired: false,
    loadAt: null,
    errorAt: null,
  }
  ;(function () {
    const ev = window.__fgSymbolsEvidence
    const link = document.getElementById('fg-material-symbols')
    link.addEventListener('load', function () {
      ev.loadFired = true
      ev.loadAt = performance.now()
    })
    link.addEventListener('error', function () {
      ev.errorFired = true
      ev.errorAt = performance.now()
    })
  })()
</script>
<link rel="stylesheet" href="assets/index-prod.css" />
<style>
  body { margin: 0; }
  /* Mirrors AppShell: fixed 240px sidebar + 64px topbar. The main
     content area therefore starts at x=240 and y=64, exactly like
     the production shell. */
  #sidebar {
    position: fixed;
    left: 0; top: 0; bottom: 0;
    width: 240px;
    background: var(--color-surface-chrome);
    border-right: 1px solid var(--color-border-subtle);
  }
  #topbar {
    position: sticky;
    top: 0;
    height: 64px;
    margin-left: 240px;
    background: var(--color-surface-chrome);
    border-bottom: 1px solid var(--color-border-subtle);
  }
  #main { margin-left: 240px; min-height: calc(100vh - 64px); }
</style>
</head>
<body>
<div id="sidebar"></div>
<div id="topbar"></div>
<div id="main"><div id="root"></div></div>
<script src="assets/${bundleFile}" ></script>
</body>
</html>
`,
)

/* ── 4. Measure in a real browser at each viewport ────────────────── */

const { chromium } = await import(
  path.join(ROOT, 'node_modules', 'playwright', 'index.mjs')
)

let browser
try {
  try {
    browser = await chromium.launch({ headless: true })
  } catch (launchError) {
    console.error(
      '\nBrowser launch failed (ENVIRONMENT / HARNESS — not a layout defect).',
    )
    console.error(
      String(launchError.message)
        .split('\n')
        .slice(0, 6)
        .join('\n'),
    )
    console.error(
      `The harness is kept at ${path
        .relative(ROOT, htmlPath)} — open it in any Chromium-based browser (hashes #/projects and #/meetings, append ?dark) and resize the window.`,
    )
    rmSync(ENTRY, { force: true })
    rmSync(VITE_CONFIG, { force: true })
    process.exit(1)
  }

  const page = await browser.newPage()
  if (FONT_NEGATIVE) {
    console.log(
      '\n== FONT-NEGATIVE MODE: blocking the external Material Symbols stylesheet ==',
    )
    // The <link> element stays in the DOM; only the network
    // response is aborted (and, with it, the font-face
    // registration and any font-file request).
    await page.route('**/*Material+Symbols*', (r) => r.abort())
  }
  const measurements = []
  // Per-iteration record of the three independent gate proofs
  // (font-negative self-test: every proof must itself detect
  // the blocked stylesheet).
  const negativeGateEvidence = []

  // The self-test needs one desktop viewport x both pages
  // (Projects: 1 icon target, Meetings: 2) — not the full
  // matrix.
  const RUN_WIDTHS = FONT_NEGATIVE
    ? [1440]
    : [...DESKTOP_VIEWPORTS, ...NARROW_VIEWPORTS]
  for (const width of RUN_WIDTHS) {
    const themes = FONT_NEGATIVE
      ? ['light']
      : DESKTOP_VIEWPORTS.includes(width)
        ? ['light', 'dark']
        : ['light']

    for (const theme of themes) {
      for (const route of PAGES) {
        await page.setViewportSize({ width, height: 1000 })
        // A unique query token per load: a hash-only change on a
        // file:// URL is a same-document navigation and would not
        // remount the page.
        await page.goto(
          `file://${htmlPath}?load=${
            width
          }${route}${theme}#/${route}${
            theme === 'dark' ? '?dark' : ''
          }`,
          { waitUntil: 'load' },
        )
        const contentSelector =
          route === 'projects'
            ? 'article[role="link"]'
            : '[role="button"][aria-label^="Open"]'
        await page.waitForSelector(contentSelector, {
          timeout: 15000,
        })
        await page.evaluate(() =>
          Promise.race([
            document.fonts.ready,
            new Promise((resolve) =>
              setTimeout(resolve, 4000),
            ),
          ]),
        )

        const m = await page.evaluate(
          async ({ route, iconTargets }) => {
            const frame = document.querySelector(
              '[data-fg-workspace-content="constrained"]',
            )
            if (!frame) {
              return { frame: null }
            }
            const wrapper = frame.parentElement
            const main = document.getElementById('main')
            const cs = getComputedStyle(wrapper)
            const frameRect = frame.getBoundingClientRect()
            const mainRect = main.getBoundingClientRect()
            const wrapperRect = wrapper.getBoundingClientRect()
            const contentLeft =
              wrapperRect.left +
              parseFloat(cs.paddingLeft)
            const contentRight =
              wrapperRect.right -
              parseFloat(cs.paddingRight)

            const out = {
              viewport: window.innerWidth,
              frameCount:
                document.querySelectorAll(
                  '[data-fg-workspace-content]',
                ).length,
              theme:
                document.documentElement.dataset.theme,
              main: {
                left: Math.round(mainRect.left),
                width: Math.round(mainRect.width),
              },
              frame: {
                left: Math.round(frameRect.left),
                width: Math.round(frameRect.width),
                maxWidth: getComputedStyle(frame).maxWidth,
              },
              leftGap: Math.round(frameRect.left - contentLeft),
              rightGap: Math.round(
                contentRight - frameRect.right,
              ),
              docOverflow: Math.round(
                document.documentElement.scrollWidth -
                  window.innerWidth,
              ),
            }

            if (route === 'projects') {
              const row = document.querySelector(
                'article[role="link"]',
              )
              if (row) {
                const desc = row.querySelector('p')
                const title = row.querySelector('h2')
                out.projectRow = {
                  grid: getComputedStyle(row)
                    .gridTemplateColumns,
                  titleTruncated:
                    title &&
                    title.scrollWidth >
                      title.clientWidth,
                  descWidth: desc
                    ? Math.round(desc.getBoundingClientRect().width)
                    : null,
                }
              }
            }

            if (route === 'meetings') {
              const rows = Array.from(
                document.querySelectorAll(
                  '[role="button"][aria-label^="Open"]',
                ),
              )
              const row = rows[0]
              out.meetingRows = rows.length
              if (row) {
                out.meetingRow = {
                  grid: getComputedStyle(row)
                    .gridTemplateColumns,
                }
              }
            }

            /* ── Primary action icons: computed browser values ──
             * The question this harness answers is what the
             * browser ACTUALLY computes after the cascade — the
             * unlayered external 24px default vs the utilities-
             * layer `text-[18px]` — so the size is measured here
             * and never read from the JSX classes.
             */
            const measureButtonIcon = (target) => {
              const button = Array.from(
                document.querySelectorAll('header button'),
              ).find((b) =>
                (b.textContent || '').includes(
                  target.buttonLabel,
                ),
              )
              if (!button) {
                return {
                  id: target.id,
                  found: false,
                  expectedPx: target.expectedPx,
                }
              }
              const icon = button.querySelector(
                '.material-symbols-outlined',
              )
              const buttonCs = getComputedStyle(button)
              const buttonRect = button.getBoundingClientRect()
              const iconCs = icon
                ? getComputedStyle(icon)
                : null
              const iconRect = icon
                ? icon.getBoundingClientRect()
                : null
              return {
                id: target.id,
                found: Boolean(icon),
                expectedPx: target.expectedPx,
                button: {
                  height: buttonCs.height,
                  fontSize: buttonCs.fontSize,
                  fontWeight: buttonCs.fontWeight,
                  box: {
                    x: Math.round(buttonRect.x),
                    y: Math.round(buttonRect.y),
                    width: Math.round(buttonRect.width),
                    height: Math.round(buttonRect.height),
                  },
                },
                icon: iconCs
                  ? {
                      fontSize: iconCs.fontSize,
                      fontFamily: iconCs.fontFamily,
                      box: iconRect
                        ? {
                            width:
                              Math.round(iconRect.width * 10) / 10,
                            height:
                              Math.round(iconRect.height * 10) / 10,
                          }
                        : null,
                    }
                  : null,
              }
            }

            out.iconTargets = iconTargets.map(measureButtonIcon)

            if (route === 'meetings') {
              // The pinned 16px Upcoming row action icons:
              // present in the DOM at rest opacity 0 — the
              // computed size is opacity-independent.
              out.upcomingRowIcons = Array.from(
                document.querySelectorAll(
                  '.fg-upcoming-row-icon.material-symbols-outlined',
                ),
              ).map((el) => {
                const cs = getComputedStyle(el)
                const rect = el.getBoundingClientRect()
                return {
                  fontSize: cs.fontSize,
                  fontFamily: cs.fontFamily,
                  box: {
                    width: Math.round(rect.width * 10) / 10,
                    height: Math.round(rect.height * 10) / 10,
                  },
                }
              })
            }

            // FONT EVIDENCE GATE: the external Google Fonts
            // Material Symbols stylesheet must actually be
            // loaded AND its unlayered
            // `.material-symbols-outlined` default rule must be
            // in effect — without it a passing icon size is NOT
            // evidence. The cross-origin sheet's cssRules is
            // NOT a reliable evidence source (a no-cors
            // cross-origin stylesheet throws SecurityError on
            // cssRules even when the CSS loaded fine), so the
            // gate uses browser-side evidence only: the
            // pre-registered `load` event of the Material
            // Symbols <link> (a cross-origin no-cors
            // stylesheet is an opaque response, so its
            // resource-timing responseStatus is 0 by spec even
            // on a healthy 200 load — it is collected for
            // diagnostics only, never as a load proof), font
            // availability (document.fonts.load), and a
            // controlled UNCORRECTED probe element.
            //
            // PROBE: only the `material-symbols-outlined`
            // class — none of the local corrections (
            // `.fg-page-action-icon` and `.fg-upcoming-row-icon`
            // are two-class selectors and cannot apply). If the
            // external rule is in effect the probe computes 24px
            // + the Material Symbols family; if the external CSS
            // is missing it inherits the body size (16px) and
            // the gate FAILs unambiguously.
            const probe = document.createElement('span')
            probe.className = 'material-symbols-outlined'
            probe.setAttribute('aria-hidden', 'true')
            probe.textContent = 'add'
            document.body.appendChild(probe)
            const probeCs = getComputedStyle(probe)
            const probeInfo = {
              fontSize: probeCs.fontSize,
              fontFamily: probeCs.fontFamily,
            }
            probe.remove()

            // The font face must be registered by the external
            // stylesheet AND actually load. Without the text
            // argument document.fonts.load resolves the face
            // unconditionally (icon characters are PUA /
            // ligature codepoints that plain text would not
            // force).
            const loadedFaces = await document.fonts.load(
              '24px "Material Symbols Outlined"',
            )
            let registeredSymbolsFont = null
            for (const font of document.fonts) {
              if (/material symbols/i.test(font.family || '')) {
                registeredSymbolsFont = {
                  family: font.family,
                  status: font.status,
                }
                break
              }
            }

            const symbolResources = performance
              .getEntriesByType('resource')
              .filter((e) => e.name.includes('Material+Symbols'))
            const lastSymbolResource =
              symbolResources[symbolResources.length - 1]

            let symbolSheetHref = null
            for (const sheet of document.styleSheets) {
              if (
                sheet.href &&
                sheet.href.includes('Material+Symbols')
              ) {
                symbolSheetHref = sheet.href
                break
              }
            }

            // Proof 1 evidence: the pre-registered load/error
            // state of the Material Symbols <link> (the inline
            // head script in harness.html records it before the
            // sheet's fetch can settle).
            const sheetEvidenceRaw = window.__fgSymbolsEvidence
            const sheetEvidence =
              sheetEvidenceRaw != null &&
              typeof sheetEvidenceRaw === 'object'
                ? {
                    registeredAt: sheetEvidenceRaw.registeredAt,
                    loadFired: !!sheetEvidenceRaw.loadFired,
                    errorFired: !!sheetEvidenceRaw.errorFired,
                    loadAt: sheetEvidenceRaw.loadAt,
                    errorAt: sheetEvidenceRaw.errorAt,
                  }
                : null

            out.externalSymbols = {
              sheetHref: symbolSheetHref,
              sheetEvidence,
              resourceTiming: {
                count: symbolResources.length,
                responseStatus: lastSymbolResource
                  ? lastSymbolResource.responseStatus
                  : null,
              },
              registeredFont: registeredSymbolsFont,
              fontLoad: loadedFaces.map((f) => ({
                family: f.family,
                status: f.status,
              })),
              probe: probeInfo,
            }

            return out
          },
          { route, iconTargets: ICON_TARGETS[route] },
        )

        const shotPath = path.join(
          OUT,
          `${route}-${width}-${theme}.png`,
        )
        const mainRect = await page
          .locator('#main')
          .boundingBox()
        if (mainRect) {
          await page.screenshot({
            path: shotPath,
            clip: {
              x: mainRect.x,
              y: 0,
              width: mainRect.width,
              height: 1000,
            },
          })
        }

        measurements.push({
          viewport: width,
          theme,
          page: route,
          screenshot: path.relative(ROOT, shotPath),
          ...m,
        })

        const fr = m.frame
        console.log(
          `\n== ${route} @ ${width}px (${theme}) — main ${
            m.main?.width
          }px, frame ${fr?.width}px (max-width ${
            fr?.maxWidth
          }) ==`,
        )

        /* ── Assertions ──────────────────────────────────────── */
        check(
          `${route}@${width}/${theme}: exactly one constrained frame`,
          m.frame != null && m.frameCount === 1,
          `frameCount=${m.frameCount}`,
        )
        if (fr) {
          check(
            `${route}@${width}/${theme}: frame within the ${MAX_WIDTH}px cap`,
            fr.width <= MAX_WIDTH + 1,
            `width=${fr.width}`,
          )
          check(
            `${route}@${width}/${theme}: frame centered in the padded main area`,
            Math.abs(m.leftGap - m.rightGap) <= 2,
            `leftGap=${m.leftGap} rightGap=${m.rightGap}`,
          )
          check(
            `${route}@${width}/${theme}: no horizontal overflow`,
            m.docOverflow <= 1,
            `docOverflow=${m.docOverflow}`,
          )
          if (NARROW_VIEWPORTS.includes(width)) {
            check(
              `${route}@${width}/${theme}: fluid below the cap (frame == padded width)`,
              Math.abs(m.leftGap + m.rightGap) <= 2,
              `gaps=${m.leftGap}+${m.rightGap}`,
            )
          }
        }
        if (route === 'projects' && m.projectRow) {
          // Responsive contract (Tailwind `lg` = 1024px): the
          // 4-track `minmax(360px,1fr) 120px 120px 120px` grid
          // applies only at >= 1024px; below it the row keeps
          // its base single-track grid. Asserted on the
          // COMPUTED grid-template-columns, never on class
          // names.
          const projectTrackCount = String(
            m.projectRow.grid,
          ).split(' ').length
          const expectedProjectTracks = width >= 1024 ? 4 : 1
          check(
            `${route}@${width}/${theme}: project row grid tracks follow the 1024px lg breakpoint (${expectedProjectTracks} track${expectedProjectTracks === 1 ? '' : 's'})`,
            projectTrackCount === expectedProjectTracks,
            `expected=${expectedProjectTracks} actual=${projectTrackCount} computed=${m.projectRow.grid}`,
          )
        }
        if (route === 'meetings' && m.meetingRow) {
          const tracks = String(
            m.meetingRow.grid,
          ).split(' ').length
          const expected =
            width >= 1100 ? 4 : width >= 768 ? 3 : 1
          check(
            `${route}@${width}/${theme}: meeting row grid tracks unchanged (${expected})`,
            tracks === expected,
            m.meetingRow.grid,
          )
        }

        /* ── Font evidence gate assertions ───────────────────────────── */
        const ext = m.externalSymbols || {}
        const perf = ext.resourceTiming || {
          count: 0,
          responseStatus: null,
        }
        // Proof 1: the pre-registered load event on the
        // Material Symbols <link>. The mere presence of the
        // link element — or of a resource-timing entry — is
        // never evidence: for a cross-origin no-cors
        // stylesheet the resource-timing responseStatus is
        // opaque (0) by spec, hence diagnostics only.
        const sheetEv = ext.sheetEvidence
        const sheetLoadOk =
          sheetEv != null &&
          sheetEv.loadFired === true &&
          sheetEv.errorFired !== true
        check(
          `${route}@${width}/${theme}: evidence gate — external Material Symbols stylesheet actually loaded (pre-registered load event on the <link>)`,
          sheetLoadOk,
          `loadFired=${sheetEv ? sheetEv.loadFired : 'n/a'} errorFired=${
            sheetEv ? sheetEv.errorFired : 'n/a'
          } linkElement=${ext.sheetHref ? 'present' : 'absent'} resourceTiming(entries=${perf.count},status=${perf.responseStatus})`,
          'font-gate',
        )
        const loadedFaces = ext.fontLoad || []
        const fontAvailableOk =
          loadedFaces.some((f) => f.status === 'loaded') &&
          !loadedFaces.some((f) => f.status === 'error')
        check(
          `${route}@${width}/${theme}: evidence gate — Material Symbols font actually available (document.fonts.load)`,
          fontAvailableOk,
          `registered=${
            ext.registeredFont
              ? `${ext.registeredFont.family}:${ext.registeredFont.status}`
              : 'none'
          } loaded=${
            loadedFaces.length
              ? loadedFaces
                  .map((f) => `${f.family}:${f.status}`)
                  .join(',')
              : 'none'
          }`,
          'font-gate',
        )
        const probe = ext.probe
        const probeOk =
          probe != null &&
          probe.fontSize === '24px' &&
          /material symbols/i.test(probe.fontFamily || '')
        check(
          `${route}@${width}/${theme}: evidence gate — uncorrected Material Symbols probe computes the 24px external default`,
          probeOk,
          `fontSize=${probe ? probe.fontSize : 'n/a'} fontFamily=${
            probe ? probe.fontFamily : 'n/a'
          }`,
          'font-gate',
        )
        if (FONT_NEGATIVE) {
          negativeGateEvidence.push({
            iteration: `${route}@${width}/${theme}`,
            sheetLoadOk,
            fontAvailableOk,
            probeOk,
          })
        }

        /* ── Primary action icon assertions ──────────────────────────── */
        for (const t of m.iconTargets || []) {
          if (!t.found) {
            check(
              `${route}@${width}/${theme}: ${t.id} button + icon present`,
              false,
              'button or icon missing from the DOM',
              'icons',
            )
            continue
          }
          check(
            `${route}@${width}/${theme}: ${t.id} computed icon size == ${t.expectedPx}px`,
            t.icon != null &&
              t.icon.fontSize === `${t.expectedPx}px`,
            `actual=${t.icon ? t.icon.fontSize : 'n/a'} fontFamily=${
              t.icon ? t.icon.fontFamily : 'n/a'
            }`,
            'icons',
          )
          check(
            `${route}@${width}/${theme}: ${t.id} button geometry unchanged (36px / 13px / 500)`,
            t.button.height === PRIMARY_BUTTON.height &&
              t.button.fontSize === PRIMARY_BUTTON.fontSize &&
              t.button.fontWeight === PRIMARY_BUTTON.fontWeight,
            `height=${t.button.height} fontSize=${t.button.fontSize} fontWeight=${t.button.fontWeight}`,
            'icons',
          )
        }
        if (route === 'meetings') {
          const rowIcons = m.upcomingRowIcons || []
          check(
            `${route}@${width}/${theme}: upcoming row action icons rendered (the two pinned 16px icons)`,
            rowIcons.length === 2,
            `count=${rowIcons.length}`,
          )
          rowIcons.forEach((ri, i) => {
            check(
              `${route}@${width}/${theme}: upcoming row action icon #${i} stays 16px`,
              ri.fontSize === `${UPCOMING_ROW_ICON_EXPECTED_PX}px`,
              `actual=${ri.fontSize}`,
            )
          })
        }
      }
    }
  }

  writeFileSync(
    path.join(OUT, 'measurements.json'),
    JSON.stringify(measurements, null, 2),
  )

  if (FONT_NEGATIVE) {
    const gateFailures = groupFailCounts['font-gate'] || 0
    const iconFailures = groupFailCounts['icons'] || 0
    // The self-test must not turn green on a gate failure of
    // unknown origin: EVERY independent proof of the gate must
    // itself detect the blocked stylesheet in every iteration.
    const allProofsDetected =
      negativeGateEvidence.length > 0 &&
      negativeGateEvidence.every(
        (ev) =>
          ev.sheetLoadOk === false &&
          ev.fontAvailableOk === false &&
          ev.probeOk === false,
      )
    const negativePass = allProofsDetected && iconFailures === 0
    console.log('\n== FONT-NEGATIVE SELF-TEST ==')
    console.log(
      '  per-iteration gate evidence (every proof must read false — i.e. each one independently detected the blocked sheet):',
    )
    for (const ev of negativeGateEvidence) {
      console.log(
        `    ${ev.iteration}: sheetLoad=${ev.sheetLoadOk} fontAvailable=${ev.fontAvailableOk} probe=${ev.probeOk}`,
      )
    }
    console.log(
      `  font-gate failures: ${gateFailures} (expected: ${negativeGateEvidence.length * 3} = all iterations x 3 proofs)`,
    )
    console.log(`  icon-target failures: ${iconFailures} (expected: 0)`)
    if (failures > gateFailures) {
      console.log(
        `  note: ${failures} total check failure(s) this run — more than the font gate contributed; inspect the output above.`,
      )
    }
    if (!negativePass) {
      console.error(
        '\nNEGATIVE TEST FAILED: every font-gate proof must FAIL when the Material Symbols font is missing while the icon-target checks keep passing.',
      )
      process.exit(1)
    }
    console.log(
      '\nNEGATIVE TEST PASSED: every font-gate proof (sheet load, font availability, uncorrected probe) reliably FAILs when the Material Symbols font is missing.',
    )
    process.exit(0)
  }

  await browser.close()
} finally {
  // Keep the harness + bundle on disk for manual browser review;
  // remove the throwaway build inputs.
  rmSync(ENTRY, { force: true })
  rmSync(VITE_CONFIG, { force: true })
  if (browser) {
    await browser.close().catch(() => {})
  }
}

console.log(
  `\nHarness kept at ${path
    .relative(ROOT, htmlPath)} (hashes #/projects, #/meetings; append ?dark for dark theme).`,
)

if (failures > 0) {
  console.error(`\n${failures} layout check(s) FAILED.`)
  process.exit(1)
}
console.log('\nAll workspace content width checks passed.')
