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
 * Run from the repository root in a standard dev environment — one
 * where Playwright's Chromium launches. (In the agent sandbox the
 * browser gate is `blocked_sandbox`, so the check cannot run there;
 * the harness below is then kept on disk for manual review.)
 *
 *   node scripts/visual/workspace-content-width-check.mjs
 *
 * Outputs (`.artifacts/workspace-content-visual/`):
 *   - measurements.json        per-viewport computed geometry
 *   - harness.html             standalone harness (open in any
 *                              Chromium-based browser; hashes:
 *                              #/projects, #/meetings, append
 *                              ?dark for the dark theme)
 *   - <page>-<viewport>-<theme>.png screenshots
 *
 * Exit code 0 = all layout assertions pass; 1 = at least one failed.
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

let failures = 0
function check(label, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL'
  if (!ok) {
    failures += 1
  }
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`)
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

window.fetch = (async (input: unknown) => {
  const url = String(
    typeof input === 'string'
      ? input
      : (input as Request).url,
  )
  const key = Object.keys(ROUTES).find((k) =>
    url.startsWith(k),
  )
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
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1" rel="stylesheet" />
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
  const measurements = []

  for (const width of [
    ...DESKTOP_VIEWPORTS,
    ...NARROW_VIEWPORTS,
  ]) {
    const themes = DESKTOP_VIEWPORTS.includes(width)
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
          (route) => {
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

            return out
          },
          route,
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
          check(
            `${route}@${width}/${theme}: project row keeps its 4-track desktop grid`,
            String(
              m.projectRow.grid,
            ).split(' ').length === 4,
            m.projectRow.grid,
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
      }
    }
  }

  writeFileSync(
    path.join(OUT, 'measurements.json'),
    JSON.stringify(measurements, null, 2),
  )

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
