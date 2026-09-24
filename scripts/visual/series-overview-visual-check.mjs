#!/usr/bin/env node
/**
 * Turnkey browser layout check for the Meetings Series overview
 * (Series overview tab visual acceptance).
 *
 * Renders the REAL `MeetingSeriesList` component (presentation-only)
 * against the REAL production CSS (fresh `vite build`) with the
 * acceptance fixtures — active (same-year next), active (other-year
 * next), a long title, and an ended Series — plus the loading,
 * error, and empty states. The harness DOM mirrors the real app's
 * width chain faithfully: #root sits directly under <body> exactly
 * like apps/web/index.html, and the app's own Tailwind classes
 * build the chain below it (AppShell's ml-[240px] fixed-sidebar
 * offset + the Meetings page's w-full px-6 lg:px-8 content
 * wrapper). That placement matters: the global
 * "html, body, #root { min-width: 320px }" rule in index.css
 * targets the top-level root — an earlier harness revision put
 * #root INSIDE the offset shell, which made the 390px
 * document-overflow check measure the harness's own DOM (a 320px
 * floor in a ~100px column) instead of the app's layout. Measures
 * the COMPUTED grid geometry at the acceptance viewports:
 * 1440 / 1200 / 1100 / 900 / 390.
 *
 * This is a component+CSS harness, not the full authenticated app:
 * the row layout under test lives entirely in
 * `apps/web/src/features/meetings/MeetingSeriesList.tsx` plus the
 * compiled Tailwind CSS, so no backend/login is required.
 *
 * Run from the repository root in a standard dev environment — one
 * where Playwright's Chromium launches. (In the agent sandbox the
 * cached Chromium bundle is broken — `icudtl.dat not found` — so
 * the check cannot run there.)
 *
 *   node scripts/visual/series-overview-visual-check.mjs
 *
 * Outputs (`.artifacts/series-overview-visual/`):
 *   - measurements.json              per-viewport computed geometry
 *   - series-overview-<viewport>.png full-page screenshots
 *
 * On a browser-launch failure the kept artifacts still allow a
 * manual check: open `.artifacts/series-overview-visual/harness.html`
 * in any Chromium-based browser and resize the window — the layout
 * tracks the viewport.
 *
 * Exit code 0 = all layout assertions pass; 1 = at least one failed
 * (or the browser could not launch in this environment).
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
const OUT = path.join(ROOT, '.artifacts', 'series-overview-visual')
const ENTRY = path.join(WEB, '.series-visual-entry.tsx')
const VITE_CONFIG = path.join(WEB, '.series-visual.vite.config.mts')

const VIEWPORTS = [1440, 1200, 1100, 900, 390]
const DESKTOP = [1440, 1200, 1100]
const TABLET = [900]
const MOBILE = [390]

let failures = 0
function check(label, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL'
  if (!ok) {
    failures += 1
  }
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`)
}

/* ── 1. Fresh production build (the layout lives in compiled CSS) ── */

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
const cssFile = readFileSync(
  path.join(WEB, 'dist', 'index.html'),
  'utf8',
)
  .match(/assets\/(index-[^"]+\.css)/)
  ?.[1]
if (!cssFile) {
  console.error('Could not locate the built CSS in dist/index.html.')
  process.exit(1)
}
const cssPath = path.join(WEB, 'dist', 'assets', cssFile)

/* ── 2. Bundle the real component with a throwaway vite build ──── */

mkdirSync(OUT, { recursive: true })
// Start from a clean bundle directory (a previous run's hashed
// bundle would otherwise accumulate).
rmSync(path.join(OUT, 'assets'), { recursive: true, force: true })

writeFileSync(
  ENTRY,
  `import { createRoot } from 'react-dom/client'
import { MeetingSeriesList } from './src/features/meetings/MeetingSeriesList'
import type { ApiMeetingRecurrenceOverview } from './src/api/types'

function iso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string {
  return new Date(year, month - 1, day, hour, minute).toISOString()
}

const creator = {
  id: 1,
  username: 'ana',
  firstName: 'Ana',
  lastName: 'Lis',
}

// Acceptance fixtures in the backend's canonical order: active
// Series by nextOccurrenceScheduledAt ascending, ended after. The
// fixture rules are semantically consistent with their next
// occurrence (weekday/day-of-month match the rule).
const series: ApiMeetingRecurrenceOverview[] = [
  {
    id: 1,
    title: 'Weekly Research Sync',
    meetingSeriesId: 7,
    researchGroupId: 1,
    scope: 'group',
    projectId: null,
    frequency: 'weekly',
    interval: 2,
    weekdays: [1, 3],
    startDate: '2026-09-08',
    localTime: '10:30',
    timezone: 'Europe/Berlin',
    endDate: null,
    count: null,
    creator,
    peopleCount: 7,
    status: 'active',
    nextOccurrenceScheduledAt: iso(2026, 9, 29, 10, 30),
  },
  {
    id: 2,
    title: 'Quarterly Coordination And Research Alignment Working Session With External Partners',
    meetingSeriesId: 8,
    researchGroupId: 1,
    scope: 'group',
    projectId: null,
    frequency: 'weekly',
    interval: 1,
    weekdays: [0],
    startDate: '2026-09-21',
    localTime: '09:00',
    timezone: 'Europe/Berlin',
    endDate: null,
    count: null,
    creator,
    peopleCount: 1,
    status: 'active',
    nextOccurrenceScheduledAt: iso(2026, 10, 5, 9, 0),
  },
  {
    id: 3,
    title: 'Design Review',
    meetingSeriesId: 9,
    researchGroupId: 1,
    scope: 'group',
    projectId: null,
    frequency: 'weekly',
    interval: 1,
    weekdays: [1],
    startDate: '2026-09-22',
    localTime: '10:00',
    timezone: 'Europe/Berlin',
    endDate: null,
    count: null,
    creator,
    peopleCount: 4,
    status: 'active',
    nextOccurrenceScheduledAt: iso(2026, 10, 6, 10, 0),
  },
  {
    id: 4,
    title: 'Distant Audit',
    meetingSeriesId: 10,
    researchGroupId: 1,
    scope: 'group',
    projectId: null,
    frequency: 'monthly',
    interval: 1,
    weekdays: [],
    startDate: '2026-09-05',
    localTime: '09:00',
    timezone: 'Europe/Berlin',
    endDate: null,
    count: null,
    creator,
    peopleCount: 3,
    status: 'active',
    nextOccurrenceScheduledAt: iso(2027, 1, 5, 9, 0),
  },
  {
    id: 5,
    title: 'Old Project Sync',
    meetingSeriesId: 11,
    researchGroupId: 1,
    scope: 'group',
    projectId: null,
    frequency: 'weekly',
    interval: 1,
    weekdays: [1],
    startDate: '2026-06-02',
    localTime: '10:00',
    timezone: 'Europe/Berlin',
    endDate: null,
    count: 3,
    creator,
    peopleCount: 2,
    status: 'ended',
    nextOccurrenceScheduledAt: null,
  },
]

const noOp = () => {}

createRoot(
  document.getElementById('root') as HTMLElement,
).render(
  <div className="min-h-screen bg-canvas text-text">
    <div className="ml-[240px] min-h-screen">
      <div id="page-content" className="w-full px-6 py-8 lg:px-8">
    <MeetingSeriesList
      series={series}
      error={null}
      onRetry={noOp}
      onNewMeeting={noOp}
    />

    <div className="mt-8">
      <div className="mb-2 text-xs font-medium text-text-muted">
        Loading state
      </div>
      <MeetingSeriesList
        series={null}
        error={null}
        onRetry={noOp}
        onNewMeeting={noOp}
      />
    </div>

    <div className="mt-8">
      <div className="mb-2 text-xs font-medium text-text-muted">
        Error state
      </div>
      <MeetingSeriesList
        series={null}
        error='The overview request returned HTTP 500.'
        onRetry={noOp}
        onNewMeeting={noOp}
      />
    </div>

    <div className="mt-8">
      <div className="mb-2 text-xs font-medium text-text-muted">
        Empty state
      </div>
      <MeetingSeriesList
        series={[]}
        error={null}
        onRetry={noOp}
        onNewMeeting={noOp}
      />
    </div>
      </div>
    </div>
  </div>,
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
      input: { 'series-visual': '.series-visual-entry.tsx' },
      output: { format: 'iife' },
    },
  },
})
`,
)

console.log('== Bundling the real MeetingSeriesList component ==')
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
      f.startsWith('series-visual-') && f.endsWith('.js'),
    )
  : undefined
if (!bundleMatch) {
  console.error('Could not locate the bundle in the harness build output.')
  process.exit(1)
}
const bundleFile = bundleMatch

/* ── 3. Harness page mirroring the app shell width chain ───────── */

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
<link rel="stylesheet" href="${cssPath.replace(/\\/g, '/')}" />
<style>
  html[data-theme='dark'] { background: #18191b; color-scheme: dark; }
</style>
<script>document.documentElement.dataset.theme = 'dark'</script>
</head>
<body>
<!-- #root is a direct <body> child, exactly like the real
     apps/web/index.html. The app's 240px sidebar offset and the
     Meetings page padding live INSIDE the rendered tree (AppShell
     + page wrapper), so the global "html, body, #root
     { min-width: 320px }" rule from index.css applies to the
     top-level root exactly as in production. -->
<div id="root"></div>
<script src="${path.join(OUT, 'assets', bundleFile).replace(/\\/g, '/')}" ></script>
</body>
</html>
`,
)

/* ── 4. Measure in a real browser at each viewport ──────────────── */

const { chromium } = await import(
  path.join(ROOT, 'node_modules', 'playwright', 'index.mjs')
)

let browser
let launchFailed = false
const measurements = []

// The other-year fixture's next-occurrence year (for the
// "year shown only when it differs" check, evaluated against the
// browser's actual clock).
const OTHER_YEAR_FIXTURE_TITLE = 'Distant Audit'
const OTHER_YEAR_FIXTURE_YEAR = 2027

try {
  try {
    browser = await chromium.launch({ headless: true })
  } catch (launchError) {
    launchFailed = true
    console.error(
      '\nBrowser launch failed (ENVIRONMENT / HARNESS — not a layout defect):',
    )
    console.error(
      String(launchError.message)
        .split('\n')
        .slice(0, 6)
        .join('\n'),
    )
    console.error(
      'Run this check in a standard dev environment where Playwright Chromium is healthy (e.g. `npx playwright install chromium`).',
    )
    throw launchError
  }

  const page = await browser.newPage()

  for (const width of VIEWPORTS) {
    await page.setViewportSize({ width, height: 1400 })
    await page.goto(`file://${htmlPath}`)
    await page.waitForSelector('[aria-label="Meeting series"]')
    // Let webfonts settle so text metrics match the real app.
    await page.evaluate(() =>
      Promise.race([
        document.fonts.ready,
        new Promise((resolve) => setTimeout(resolve, 4000)),
      ]),
    )

    const m = await page.evaluate(() => {
      const section = document.querySelector(
        '[aria-label="Meeting series"]',
      )
      const rows = Array.from(
        section.querySelectorAll('div[class*="min-h-[68px]"]'),
      )
      const box = (el) => {
        const r = el.getBoundingClientRect()
        return {
          left: Math.round(r.left),
          top: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height),
          right: Math.round(r.right),
          bottom: Math.round(r.bottom),
          cy: Math.round(r.top + r.height / 2),
        }
      }
      const firstText = (el) => {
        const span = el.querySelector('span.truncate')
        return span ? span.textContent || '' : ''
      }
      const content =
        document.getElementById('page-content')
      return {
        viewportWidth: window.innerWidth,
        // The Meetings page's content column (border-box): what
        // the app's real width chain (fixed 240px sidebar offset
        // + px-6 / lg:px-8) leaves for page content here.
        contentWidth: Math.round(
          content.getBoundingClientRect().width,
        ),
        sectionOverflow:
          section.scrollWidth - section.clientWidth,
        documentOverflow:
          document.documentElement.scrollWidth - window.innerWidth,
        currentYear: new Date().getFullYear(),
        rows: rows.map((row) => {
          const cells = Array.from(row.children).map((cell) => ({
            box: box(cell),
            display: getComputedStyle(cell).display,
            text: (cell.textContent || '').trim().slice(0, 200),
            // Rendered (visible) text: the display:none
            // responsive copies are excluded — textContent would
            // mix them in and mislead the breakpoint assertions.
            visibleText: cell.innerText.trim().slice(0, 200),
            scrollWidth: cell.scrollWidth,
            clientWidth: cell.clientWidth,
          }))
          const titleSpan = row.querySelector(
            'span.truncate',
          )
          return {
            columns: getComputedStyle(row)
              .gridTemplateColumns,
            row: box(row),
            rowOverflow: row.scrollWidth - row.clientWidth,
            cursor: getComputedStyle(row).cursor,
            interactiveChildren:
              row.querySelectorAll(
                'button, a, [role="button"]',
              ).length,
            tabStop: row.querySelector('[tabindex]') != null,
            title: titleSpan
              ? {
                  text: firstText(row),
                  box: box(titleSpan),
                  truncated:
                    titleSpan.scrollWidth >
                      titleSpan.clientWidth &&
                    getComputedStyle(titleSpan)
                      .textOverflow === 'ellipsis',
                }
              : null,
            cells,
          }
        }),
      }
    })

    const shotPath = path.join(
      OUT,
      `series-overview-${width}.png`,
    )
    await page.screenshot({ path: shotPath, fullPage: true })

    measurements.push({
      viewport: width,
      ...m,
      screenshot: path.relative(ROOT, shotPath),
    })

    console.log(
      `\n== ${width}px — container ${m.contentWidth}px, computed columns per row: ==`,
    )
    for (const row of m.rows) {
      console.log(
        `  ${row.title?.text.slice(0, 28) || 'row'} — ${row.columns}`,
      )
    }

    /* ── Assertions ───────────────────────────────────────────── */
    const byTitle = (prefix) =>
      m.rows.find((r) => (r.title?.text || '').startsWith(prefix))
    const nextShape = /· \d{2}:\d{2}$/

    // Compactness contract: 68px is the row's `min-h-[68px]` floor
    // and py-3 (12px) its vertical padding — the same shared row
    // geometry as the Upcoming list. Below desktop the row
    // intentionally stacks and its metadata wraps, so a row may
    // legitimately grow WITH its content. The invariant is therefore
    // content-relative, not a per-breakpoint magic ceiling: the row
    // must be exactly as tall as its visible content plus its own
    // padding (or the 68px floor, whichever is larger). Wrapped
    // lines show up 1:1 in the content height (a longer next label
    // wrapping an extra line at 390px is valid layout); anything
    // that adds height WITHOUT content — a stray margin, an
    // accidentally visible track, a nested container — makes the
    // row taller than its content and fails here.
    const ROW_MIN_H = 68 // min-h-[68px]
    const ROW_PY = 12 // py-3
    const ROUND_TOL = 2 // measurement rounding tolerance
    const PEOPLE_SHAPE = /\b\d+ people\b|\b1 person\b/

    for (const row of m.rows) {
      const label = row.title?.text.slice(0, 24) || 'row'
      // Read-only = no pointer affordance, no interactive
      // descendants, no tab stop. A plain div's default
      // `cursor: auto` is not evidence of interactivity.
      check(
        `${label}: read-only row (no pointer cursor, no interactive descendants, no tab stop)`,
        row.cursor !== 'pointer' &&
          row.interactiveChildren === 0 &&
          !row.tabStop,
        `cursor=${row.cursor} interactive=${row.interactiveChildren} tabStop=${row.tabStop}`,
      )
      check(
        `${label}: no row overflow`,
        row.rowOverflow <= 0,
        `overflow=${row.rowOverflow}px`,
      )
      check(
        `${label}: compact row height (>= ${60}px sensible minimum)`,
        row.row.height >= 60,
        `height=${row.row.height}px`,
      )
      const visibleCells = row.cells.filter(
        (c) => c.display !== 'none',
      )
      const contentHeight = Math.max(
        ...visibleCells.map((c) => c.box.height),
      )
      const expectedHeight = Math.max(
        ROW_MIN_H,
        contentHeight + 2 * ROW_PY,
      )
      check(
        `${label}: row height exactly content-driven (max(68px floor, content + py-3); wrapping is legit, dead space is not)`,
        Math.abs(row.row.height - expectedHeight) <= ROUND_TOL,
        `height=${row.row.height}px content=${contentHeight}px expected=${expectedHeight}px`,
      )
      // Clipping / overlap guards: a cell's content must stay
      // inside the cell box (scrollWidth — a deliberate ellipsis is
      // contained by its own truncate span, so it never counts) and
      // the cell box must stay inside the row (no escape past the
      // list container, no overlap with a neighbouring row).
      for (const [index, cell] of visibleCells.entries()) {
        const b = cell.box
        check(
          `${label}: cell${index} no clipping/overflow (content inside cell, cell inside row)`,
          cell.scrollWidth <= cell.clientWidth &&
            b.top >= row.row.top &&
            b.bottom <= row.row.bottom &&
            b.left >= row.row.left &&
            b.right <= row.row.right,
          `scrollW=${cell.scrollWidth} clientW=${cell.clientWidth} cell=[${b.left},${b.top},${b.right},${b.bottom}] row=[${row.row.left},${row.row.top},${row.row.right},${row.row.bottom}]`,
        )
      }
    }
    check(
      'No horizontal overflow in the document',
      m.documentOverflow <= 0,
      `overflow=${m.documentOverflow}px`,
    )

    if (DESKTOP.includes(width)) {
      for (const row of m.rows) {
        const label = row.title?.text.slice(0, 24) || 'row'
        check(
          `${label}: three computed tracks (flex / 190 / 96)`,
          /^[\d.]+px\s+190px\s+96px$/.test(row.columns),
          row.columns,
        )
      }
      const sync = byTitle('Weekly Research Sync')
      if (sync) {
        check(
          'Weekly Research Sync: next in its own track, ending " · HH:MM"',
          sync.cells[1].display !== 'none' &&
            nextShape.test(sync.cells[1].text),
          `next="${sync.cells[1].text}"`,
        )
        check(
          'Weekly Research Sync: schedule summary secondary metadata',
          /Every 2 weeks on Tuesday and Thursday at/.test(
            sync.cells[0].text,
          ),
          `metadata="${sync.cells[0].text.slice(0, 60)}"`,
        )
        check(
          'Weekly Research Sync: folded next/people copies hidden on desktop',
          !/· \d{2}:\d{2}/.test(sync.cells[0].visibleText) &&
            !/\b\d+ people\b|\b1 person\b/.test(
              sync.cells[0].visibleText,
            ),
          `metadata="${sync.cells[0].visibleText.slice(0, 80)}"`,
        )
        check(
          'Weekly Research Sync: people visible in its track',
          sync.cells[2].display !== 'none' &&
            sync.cells[2].text === '7 people',
          `people="${sync.cells[2].text}"`,
        )
      }
      const long = byTitle('Quarterly Coordination')
      if (long) {
        check(
          'Long title: still three tracks, people + next intact',
          long.cells.length === 3 &&
            long.cells[2].text === '1 person' &&
            nextShape.test(long.cells[1].text),
          `people="${long.cells[2].text}" next="${long.cells[1].text}"`,
        )
        console.log(
          `    note: long title truncated=${long.title?.truncated} (depends on available width)`,
        )
      }
      const distant = byTitle(OTHER_YEAR_FIXTURE_TITLE)
      if (distant) {
        const otherYear = OTHER_YEAR_FIXTURE_YEAR
        if (otherYear !== m.currentYear) {
          check(
            'Distant Audit: other-year next shows the year',
            distant.cells[1].text.includes(String(otherYear)),
            `next="${distant.cells[1].text}"`,
          )
        } else {
          check(
            'Distant Audit: same-year next omits the year',
            !/(, )?\b\d{4}\b/.test(distant.cells[1].text),
            `next="${distant.cells[1].text}"`,
          )
        }
      }
      const ended = byTitle('Old Project Sync')
      if (ended) {
        check(
          'Old Project Sync (ended): EMPTY next track (no fabricated date)',
          ended.cells[1].text === '',
          `next="${ended.cells[1].text}"`,
        )
        check(
          'Old Project Sync (ended): people still rendered',
          ended.cells[2].text === '2 people',
          `people="${ended.cells[2].text}"`,
        )
      }
    }

    if (TABLET.includes(width)) {
      for (const row of m.rows) {
        const label = row.title?.text.slice(0, 24) || 'row'
        check(
          `${label}: two computed tracks (flex / 96)`,
          /^[\d.]+px\s+96px$/.test(row.columns),
          row.columns,
        )
        check(
          `${label}: dedicated next track display-removed`,
          row.cells[1].display === 'none',
          `display=${row.cells[1].display}`,
        )
      }
      const sync = byTitle('Weekly Research Sync')
      if (sync) {
        // On tablet the next label folds into the secondary
        // metadata (visible there; the dedicated track is
        // removed) while the people count stays in its dedicated
        // track. Asserted on VISIBLE text (innerText): the cell's
        // textContent also carries the display:none desktop copy.
        check(
          'Weekly Research Sync: next folded into the secondary metadata (visible there)',
          /· \d{2}:\d{2}/.test(sync.cells[0].visibleText) &&
            !/\b\d+ people\b|\b1 person\b/.test(
              sync.cells[0].visibleText,
            ),
          `metadata="${sync.cells[0].visibleText.slice(0, 80)}"`,
        )
        check(
          'Weekly Research Sync: people in its dedicated track (not folded)',
          sync.cells[2].display !== 'none' &&
            sync.cells[2].visibleText === '7 people',
          `people="${sync.cells[2].visibleText}"`,
        )
      }
    }

    if (MOBILE.includes(width)) {
      check(
        'Mobile: no horizontal overflow in the list',
        m.sectionOverflow <= 0,
        `overflow=${m.sectionOverflow}px`,
      )
      // On mobile everything folds into the row metadata and the
      // dedicated tracks are removed — asserted on VISIBLE text for
      // EVERY row (an active row must show schedule + next + people;
      // an ended row must show schedule + people and no next).
      for (const row of m.rows) {
        const label = row.title?.text.slice(0, 24) || 'row'
        check(
          `${label}: stacked single-column layout`,
          /^[\d.]+px$/.test(row.columns),
          row.columns,
        )
        check(
          `${label}: dedicated next + people tracks removed (folded into the metadata)`,
          row.cells[1].display === 'none' &&
            row.cells[2].display === 'none',
          `next=${row.cells[1].display} people=${row.cells[2].display}`,
        )
        const meta = row.cells[0].visibleText
        const active = /\bActive\b/.test(meta)
        check(
          `${label}: schedule summary visible in the row metadata`,
          /Every /.test(meta),
          `metadata="${meta.slice(0, 80)}"`,
        )
        if (active) {
          check(
            `${label}: next meeting visible in the row metadata`,
            /· \d{2}:\d{2}/.test(meta),
            `metadata="${meta.slice(0, 80)}"`,
          )
          check(
            `${label}: people count visible in the row metadata`,
            PEOPLE_SHAPE.test(meta),
            `metadata="${meta.slice(0, 80)}"`,
          )
        } else {
          check(
            `${label}: ended row shows no next meeting`,
            !/· \d{2}:\d{2}/.test(meta),
            `metadata="${meta.slice(0, 80)}"`,
          )
        }
      }
    }
  }
} catch (error) {
  if (!launchFailed) {
    throw error
  }
  // Launch failure: the clean ENVIRONMENT/HARNESS message above is
  // the report; no raw stack needed.
} finally {
  if (browser) {
    await browser.close().catch(() => {})
  }
  // Remove the throwaway source files from the repo…
  rmSync(ENTRY, { force: true })
  rmSync(VITE_CONFIG, { force: true })
  rmSync(path.join(OUT, 'index.html'), { force: true })
  // …but keep the harness artifacts (harness.html + bundle + CSS),
  // so the result can be inspected in ANY Chromium-based browser:
  // open `.artifacts/series-overview-visual/harness.html` and resize
  // the window — the layout tracks the viewport.
  cpSync(
    path.join(WEB, 'dist', 'assets', cssFile),
    path.join(OUT, 'production.css'),
  )
}

if (launchFailed) {
  process.exit(1)
}

writeFileSync(
  path.join(OUT, 'measurements.json'),
  JSON.stringify(measurements, null, 2),
)

console.log(
  `\n== Result: ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} ==`,
)
console.log(`Artifacts: ${path.relative(ROOT, OUT)}/`)
process.exit(failures === 0 ? 0 : 1)
