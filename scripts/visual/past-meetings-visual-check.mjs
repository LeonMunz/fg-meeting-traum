#!/usr/bin/env node
/**
 * Turnkey browser layout check for the Meetings Past tab (Past tab
 * visual acceptance).
 *
 * Renders the REAL `PastMeetingsList` component (presentation-only)
 * against the REAL production CSS (fresh `vite build`) with the
 * acceptance fixtures — completed Meetings across MULTIPLE LOCAL
 * DATES AND YEARS (reverse-chronological groups), a long title,
 * and rows with / without participants — plus the loading, error,
 * and empty states. The harness DOM mirrors the real app's width
 * chain faithfully: #root sits directly under <body> exactly like
 * apps/web/index.html, and the app's own Tailwind classes build
 * the chain below it (AppShell's ml-[240px] fixed-sidebar offset +
 * the Meetings page's w-full px-6 lg:px-8 content wrapper). That
 * placement matters: the global "html, body, #root { min-width:
 * 320px }" rule in index.css targets the top-level root — an
 * earlier harness revision put #root INSIDE the offset shell,
 * which made the 390px document-overflow check measure the
 * harness's own DOM (a 320px floor in a ~100px column) instead of
 * the app's layout. Measures the COMPUTED grid geometry at the
 * acceptance viewports: 1440 / 1200 / 1100 / 900 / 390, and
 * screenshots every viewport in Dark AND Light.
 *
 * This is a component+CSS harness, not the full authenticated app:
 * the row layout under test lives entirely in
 * `apps/web/src/features/meetings/PastMeetings.tsx` +
 * `pastModel.ts` plus the compiled Tailwind CSS, so no
 * backend/login is required.
 *
 * Run from the repository root in a standard dev environment — one
 * where Playwright's Chromium launches. (In the agent sandbox the
 * cached Chromium bundle is broken — `icudtl.dat not found` — so
 * the check cannot run there.)
 *
 *   node scripts/visual/past-meetings-visual-check.mjs
 *
 * Outputs (`.artifacts/past-meetings-visual/`):
 *   - measurements.json                 per-viewport computed geometry
 *   - past-meetings-<viewport>-dark.png  dark screenshots
 *   - past-meetings-<viewport>-light.png light screenshots
 *
 * On a browser-launch failure the kept artifacts still allow a
 * manual check: open `.artifacts/past-meetings-visual/harness.html`
 * in any Chromium-based browser and resize the window — the layout
 * tracks the viewport (append ?theme=light for the light variant).
 *
 * Exit code 0 = all layout assertions pass; 1 = at least one failed
 * (or the browser could not launch in this environment).
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(
  new URL('.', import.meta.url).pathname,
  '..',
  '..',
)
const WEB = path.join(ROOT, 'apps', 'web')
const OUT = path.join(ROOT, '.artifacts', 'past-meetings-visual')
const ENTRY = path.join(WEB, '.past-visual-entry.tsx')
const VITE_CONFIG = path.join(
  WEB,
  '.past-visual.vite.config.mts',
)

const VIEWPORTS = [1440, 1200, 1100, 900, 390]

let failures = 0
function check(label, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL'
  if (!ok) {
    failures += 1
  }
  console.log(
    `  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`,
  )
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
rmSync(path.join(OUT, 'assets'), {
  recursive: true,
  force: true,
})

// The entry source below is plain text without backticks or ${}
// sequences, so embedding it in one template literal is safe.
const ENTRY_SOURCE = String.raw`import { createRoot } from 'react-dom/client'
import { PastMeetingsList } from './src/features/meetings/PastMeetings'
import {
  groupPastByDate,
  selectPastMeetings,
} from './src/features/meetings/pastModel'
import type { ApiMeeting } from './src/api/types'

function iso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string {
  return new Date(year, month - 1, day, hour, minute).toISOString()
}

function makeMeeting(
  overrides: Partial<ApiMeeting> & { id: number },
): ApiMeeting {
  return {
    researchGroupId: 1,
    scope: 'group',
    projectId: null,
    seriesId: null,
    title: 'M' + overrides.id,
    scheduledAt: iso(2026, 9, 21, 10, 0),
    startedAt: null,
    endedAt: null,
    status: 'completed',
    currentMeetingItemId: null,
    participantIds: [],
    actionPermissions: {
      canEdit: false,
      canDelete: false,
      canCancel: false,
    },
    createdById: 1,
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-01T08:00:00Z',
    ...overrides,
  }
}

// Acceptance fixtures: completed Meetings across MULTIPLE local
// dates and YEARS (the real model orders and groups them), a
// deliberately long title, and rows with / without participants.
const meetings = [
  makeMeeting({
    id: 1,
    title: 'Weekly Research Sync',
    scheduledAt: iso(2026, 9, 21, 10, 0),
    participantIds: [1, 2, 3, 4, 5, 6, 7],
  }),
  makeMeeting({
    id: 2,
    title: 'Quarterly Coordination And Research Alignment Working Session With External Partners',
    scheduledAt: iso(2026, 9, 21, 9, 0),
  }),
  makeMeeting({
    id: 3,
    title: 'Design Review',
    scheduledAt: iso(2026, 9, 20, 14, 0),
    participantIds: [1, 2, 3, 4],
  }),
  makeMeeting({
    id: 4,
    title: 'Distant Audit',
    scheduledAt: iso(2025, 11, 14, 10, 0),
    participantIds: [1, 2],
  }),
  makeMeeting({
    id: 5,
    title: 'Archive Sync',
    scheduledAt: iso(2024, 2, 5, 11, 0),
    participantIds: [1],
  }),
]

const groups = groupPastByDate(
  selectPastMeetings(meetings),
)

const noOp = () => {}

// ?theme=light for the light variant; default is dark.
const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme =
  params.get('theme') === 'light' ? 'light' : 'dark'

createRoot(
  document.getElementById('root') as HTMLElement,
).render(
  <div className="min-h-screen bg-canvas text-text">
    <div className="ml-[240px] min-h-screen">
      <div id="page-content" className="w-full px-6 py-8 lg:px-8">
    <div className="mb-2 text-xs font-medium text-text-muted">
      Populated (multiple dates and years)
    </div>
    <PastMeetingsList
      groups={groups}
      loading={false}
      error={null}
      onRetry={noOp}
      onOpenMeeting={noOp}
    />

    <div className="mt-8">
      <div className="mb-2 text-xs font-medium text-text-muted">
        Loading state
      </div>
      <PastMeetingsList
        groups={[]}
        loading
        error={null}
        onRetry={noOp}
        onOpenMeeting={noOp}
      />
    </div>

    <div className="mt-8">
      <div className="mb-2 text-xs font-medium text-text-muted">
        Error state
      </div>
      <PastMeetingsList
        groups={[]}
        loading={false}
        error='The meetings request returned HTTP 500.'
        onRetry={noOp}
        onOpenMeeting={noOp}
      />
    </div>

    <div className="mt-8">
      <div className="mb-2 text-xs font-medium text-text-muted">
        Empty state
      </div>
      <PastMeetingsList
        groups={[]}
        loading={false}
        error={null}
        onRetry={noOp}
        onOpenMeeting={noOp}
      />
    </div>
      </div>
    </div>
  </div>,
)
`

writeFileSync(ENTRY, ENTRY_SOURCE)

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
      input: {
        'past-visual': '.past-visual-entry.tsx',
      },
      output: { format: 'iife' },
    },
  },
})
`,
)

console.log(
  '== Bundling the real PastMeetingsList component ==',
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
  ? readdirSync(assetsDir).find(
      (f) =>
        f.startsWith('past-visual-') &&
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
</head>
<body>
<!-- #root is a direct <body> child, exactly like the real
     apps/web/index.html. The app's 240px sidebar offset and the
     Meetings page padding live INSIDE the rendered tree (AppShell
     + page wrapper), so the global "html, body, #root
     { min-width: 320px }" rule from index.css applies to the
     top-level root exactly as in production. The theme is read
     from ?theme=light (default: dark) by the entry script. -->
<div id="root"></div>
<script src="${path
  .join(OUT, 'assets', bundleFile)
  .replace(/\\/g, '/')}" ></script>
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
    await page.setViewportSize({ width, height: 1600 })
    await page.goto(`file://${htmlPath}`)
    await page.waitForSelector(
      '[aria-label="Completed meetings"]',
    )
    // Let webfonts settle so text metrics match the real app.
    await page.evaluate(() =>
      Promise.race([
        document.fonts.ready,
        new Promise((resolve) =>
          setTimeout(resolve, 4000),
        ),
      ]),
    )

    const m = await page.evaluate(() => {
      const section = document.querySelector(
        '[aria-label="Completed meetings"]',
      )
      const rows = Array.from(
        section.querySelectorAll(
          'div[class*="min-h-[68px]"]',
        ),
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
        }
      }
      const content =
        document.getElementById('page-content')
      const headings = Array.from(
        section.querySelectorAll('h3'),
      ).map((h) => h.textContent || '')
      return {
        viewportWidth: window.innerWidth,
        contentWidth: Math.round(
          content.getBoundingClientRect().width,
        ),
        sectionOverflow:
          section.scrollWidth -
          section.clientWidth,
        documentOverflow:
          document.documentElement.scrollWidth -
          window.innerWidth,
        groupHeadings: headings,
        rows: rows.map((row) => {
          const cells = Array.from(
            row.children,
          ).map((cell) => ({
            box: box(cell),
            display:
              getComputedStyle(cell)
                .display,
            visibleText:
              cell.innerText.trim().slice(0, 200),
            scrollWidth: cell.scrollWidth,
            clientWidth: cell.clientWidth,
          }))
          const truncateEl = row.querySelector(
            '.truncate',
          )
          // The direct row child that contains the title —
          // the title's own grid track (the Meeting cell).
          let titleCellEl = truncateEl
          while (
            titleCellEl &&
            titleCellEl.parentElement !== row
          ) {
            titleCellEl = titleCellEl.parentElement
          }
          return {
            columns: getComputedStyle(
              row,
            ).gridTemplateColumns,
            row: box(row),
            rowOverflow:
              row.scrollWidth -
              row.clientWidth,
            // Measured grid metrics (gap-y-1.5 / py-3): the
            // row-height assertion derives its expectation from
            // these instead of hardcoded values.
            rowGap:
              parseFloat(
                getComputedStyle(
                  row,
                ).rowGap,
              ) || 0,
            paddingTop:
              parseFloat(
                getComputedStyle(
                  row,
                ).paddingTop,
              ) || 0,
            paddingBottom:
              parseFloat(
                getComputedStyle(
                  row,
                ).paddingBottom,
              ) || 0,
            cursor:
              getComputedStyle(row)
              .cursor,
            tabIndex: row.getAttribute(
              'tabindex',
            ),
            role: row.getAttribute('role'),
            ariaLabel: row.getAttribute(
              'aria-label',
            ),
            interactiveChildren:
              row.querySelectorAll(
                'button, a',
              ).length,
            title: truncateEl
              ? {
                  text:
                    truncateEl.textContent ||
                    '',
                  box: box(truncateEl),
                  cellIndex: titleCellEl
                    ? Array.prototype
                      .indexOf.call(
                        row.children,
                        titleCellEl,
                      )
                    : -1,
                  scrollWidth:
                    truncateEl.scrollWidth,
                  clientWidth:
                    truncateEl.clientWidth,
                  textOverflow:
                    getComputedStyle(
                      truncateEl,
                    ).textOverflow,
                  truncated:
                    truncateEl.scrollWidth >
                    truncateEl
                      .clientWidth &&
                    getComputedStyle(
                      truncateEl,
                    ).textOverflow ===
                    'ellipsis',
                }
              : null,
            cells,
          }
        }),
      }
    })

    const darkShot = path.join(
      OUT,
      `past-meetings-${width}-dark.png`,
    )
    await page.screenshot({
      path: darkShot,
      fullPage: true,
    })
    await page.goto(
      `file://${htmlPath}?theme=light`,
    )
    await page.waitForSelector(
      '[aria-label="Completed meetings"]',
    )
    await page.evaluate(() =>
      Promise.race([
        document.fonts.ready,
        new Promise((resolve) =>
          setTimeout(resolve, 4000),
        ),
      ]),
    )
    const lightShot = path.join(
      OUT,
      `past-meetings-${width}-light.png`,
    )
    await page.screenshot({
      path: lightShot,
      fullPage: true,
    })

    measurements.push({
      viewport: width,
      ...m,
      screenshots: [
        path.relative(ROOT, darkShot),
        path.relative(ROOT, lightShot),
      ],
    })

    console.log(
      `\n== ${width}px — container ${m.contentWidth}px, computed columns per row: ==`,
    )
    for (const row of m.rows) {
      console.log(
        `  ${(row.title?.text || 'row').slice(0, 28)} — ${row.columns}`,
      )
    }
    console.log(
      '  group headers:',
      m.groupHeadings.join(' | '),
    )

    /* ── Assertions ───────────────────────────────────────────── */
    const PEOPLE_SHAPE =
      /\b\d+ people\b|\b1 person\b/
    const ROW_MIN_H = 68 // min-h-[68px]
    const ROUND_TOL = 2 // measurement rounding tolerance

    check(
      `no document horizontal overflow at ${width}px`,
      m.documentOverflow <= 0,
      `overflow=${m.documentOverflow}px`,
    )
    check(
      `no section horizontal overflow at ${width}px`,
      m.sectionOverflow <= 0,
      `overflow=${m.sectionOverflow}px`,
    )

    // Group headers: four local dates, DESCENDING, each label
    // unambiguous (carries the explicit year).
    check(
      'group headers: four dates descending, all year-bearing',
      m.groupHeadings.length === 4 &&
      m.groupHeadings.every((h) =>
        /, \d{4}$/.test(h),
      ) &&
      m.groupHeadings[0].includes(
        'Sep 21, 2026',
      ) &&
      m.groupHeadings[3].includes(
        'Feb 5, 2024',
      ),
      m.groupHeadings.join(' | '),
    )

    const desktop = width >= 1100

    for (const row of m.rows) {
      const label =
        row.title?.text.slice(0, 24) || 'row'

      // The row is a plain OPEN affordance: role=button + a tab
      // stop + pointer cursor + the accessible open name — and it
      // carries NO nested interactive element (no row actions).
      check(
        `${label}: openable row (role/tabindex/cursor/aria) with no nested actions`,
        row.role === 'button' &&
        row.tabIndex === '0' &&
        row.cursor === 'pointer' &&
        /^Open .+ on .+ at \d{2}:\d{2}$/.test(
          row.ariaLabel || '',
        ) &&
        row.interactiveChildren === 0,
        `role=${row.role} tab=${row.tabIndex} cursor=${row.cursor} children=${row.interactiveChildren} label=${row.ariaLabel}`,
      )

      // Grid contract: desktop (>=1100) three tracks
      // (104px / 1fr / 96px), tablet (768-1099) two tracks
      // (88px / 1fr), mobile one stacked track.
      const colCount = row.columns
        .split(' ')
        .filter(Boolean).length
      const expectedTracks =
        desktop ? 3 : width >= 768 ? 2 : 1
      check(
        `${label}: expected track count (${expectedTracks} at ${width}px)`,
        colCount === expectedTracks,
        `columns=${row.columns}`,
      )

      check(
        `${label}: no row overflow`,
        row.rowOverflow <= 0,
        `overflow=${row.rowOverflow}px`,
      )

      // Compactness: the row is exactly as tall as its visible
      // content (or the 68px floor, whichever is larger) —
      // dead space is not. The expectation is derived from the
      // MEASURED grid geometry, not a viewport-specific
      // formula: visible cells are grouped into the grid rows
      // they occupy — items-center ⇒ same-row cells share the
      // track center Y, and stacked rows' centers always differ
      // by at least the row gap — then the per-row content
      // heights are summed across grid rows, plus the computed
      // grid row gap and vertical padding. This accounts for
      // the mobile stacked layout, where Time and Meeting sit
      // in SEPARATE grid rows (max() over cells would
      // undercount them).
      const visibleCells = row.cells.filter(
        (c) => c.display !== 'none',
      )
      const gridRows = []
      for (const cell of visibleCells) {
        const center =
          cell.box.top + cell.box.height / 2
        const occupied = gridRows.find(
          (g) =>
            Math.abs(g.center - center) <=
            ROUND_TOL,
        )
        if (occupied) {
          occupied.heights.push(
            cell.box.height,
          )
        } else {
          gridRows.push({
            center,
            heights: [cell.box.height],
          })
        }
      }
      const contentHeight = gridRows.reduce(
        (sum, g) =>
          sum + Math.max(...g.heights),
        0,
      )
      const gridRowGap =
        gridRows.length > 1 ? row.rowGap : 0
      const contentTotal =
        contentHeight + gridRowGap
      const expectedHeight = Math.max(
        ROW_MIN_H,
        contentTotal +
          row.paddingTop +
          row.paddingBottom,
      )
      check(
        `${label}: row height exactly content-driven (grid rows + row gap + padding, 68px floor)`,
        Math.abs(
          row.row.height - expectedHeight,
        ) <= ROUND_TOL,
        `height=${row.row.height}px gridRows=${gridRows.length} content=${contentHeight}px gap=${gridRowGap}px padding=${row.paddingTop}+${row.paddingBottom} expected=${expectedHeight}px`,
      )

      // Clipping / overlap guards: a cell's content stays inside
      // the cell box and the cell box stays inside the row.
      for (const [index, cell] of visibleCells.entries()) {
        const b = cell.box
        check(
          `${label}: cell${index} no clipping/overflow (content inside cell, cell inside row)`,
          cell.scrollWidth <=
          cell.clientWidth +
          ROUND_TOL &&
          b.top >= row.row.top - ROUND_TOL &&
          b.bottom <=
          row.row.bottom + ROUND_TOL,
          `cell=${JSON.stringify(b)} scroll=${cell.scrollWidth}/${cell.clientWidth}`,
        )
      }

      // Title contract (measured geometry, no viewport-specific
      // exceptions): the title stays INSIDE its own grid track
      // (the Meeting cell) and never escapes the row, never
      // overlaps a sibling cell, and the row's accessible name
      // retains the COMPLETE title. Ellipsis/truncation applies
      // exactly when the intrinsic text width exceeds the
      // available track — a title that fits renders in full
      // (both outcomes are valid; what is NOT valid is a title
      // that is clipped without an ellipsis or escapes its
      // track).
      if (row.title) {
        const t = row.title
        const host =
          t.cellIndex >= 0
            ? row.cells[t.cellIndex]
            : null
        const needsEllipsis =
          t.scrollWidth >
          t.clientWidth + ROUND_TOL
        const intersects = (a, b) =>
          a.left < b.right - ROUND_TOL &&
          a.right > b.left + ROUND_TOL &&
          a.top < b.bottom - ROUND_TOL &&
          a.bottom > b.top + ROUND_TOL
        const overlaps = visibleCells.some(
          (c) =>
            c !== host &&
            intersects(t.box, c.box),
        )
        check(
          `${label}: title contained in its track, no overlap, complete accessible name${t.text.length > 60 ? ' (long title)' : ''}`,
          host != null &&
          host.display !== 'none' &&
          t.box.left >=
            host.box.left - ROUND_TOL &&
          t.box.right <=
            host.box.right + ROUND_TOL &&
          t.box.top >= host.box.top - ROUND_TOL &&
          t.box.bottom <=
            host.box.bottom + ROUND_TOL &&
          t.box.right <=
            row.row.right + ROUND_TOL &&
          !overlaps &&
          (row.ariaLabel || '').includes(
            t.text,
          ),
          `title=${JSON.stringify(t.box)} track=${host ? JSON.stringify(host.box) : 'none'} overlaps=${overlaps}`,
        )
        check(
          `${label}: title ${needsEllipsis ? 'truncates with ellipsis (wider than track)' : 'fits in full (no clipping)'}`,
          needsEllipsis
            ? t.textOverflow ===
                'ellipsis' &&
              t.box.right <=
                (host ? host.box : row.row)
                  .right + ROUND_TOL
            : t.scrollWidth <=
              t.clientWidth + ROUND_TOL,
          `scroll=${t.scrollWidth} client=${t.clientWidth} textOverflow=${t.textOverflow}`,
        )
      }

      // People responsive convention: at >=1100 the count sits in
      // the dedicated track (3rd cell) — empty, never fabricated,
      // when the Meeting has no participants; below 1100 the
      // dedicated track is hidden and the count folds into the
      // meeting cell's secondary metadata (or is absent).
      if (desktop) {
        const trackText =
          row.cells[2]?.visibleText.trim() ||
          ''
        const hasCountFixture =
          label.startsWith('Weekly') ||
          label.startsWith('Design') ||
          label.startsWith('Distant') ||
          label.startsWith('Archive')
        check(
          `${label}: desktop people track ${hasCountFixture ? 'shows the authoritative count' : 'stays empty (no fabricated count)'}`,
          hasCountFixture
            ? PEOPLE_SHAPE.test(trackText)
            : trackText === '',
          `track=${JSON.stringify(trackText)}`,
        )
      } else {
        const trackHidden =
          row.cells.length === 3 &&
          row.cells[2].display === 'none'
        const metaVisible =
          row.cells.slice(0, 2).some(
            (c) =>
              c.display !== 'none' &&
              PEOPLE_SHAPE.test(c.visibleText),
          )
        // Fixtures WITH participants fold the count into the
        // meeting cell's secondary metadata below 1100px; the
        // long "Quarterly..." fixture (no participants) must NOT
        // render a fabricated count.
        const expectCount = !(
          (row.title?.text || '').startsWith('Quarterly')
        )
        check(
          `${label}: below desktop the dedicated track is hidden and the count folds into the metadata (or is absent)`,
          trackHidden && metaVisible === expectCount,
          `cells=${JSON.stringify(row.cells.map((c) => c.visibleText))}`,
        )
      }
    }

    // State surfaces are present and sane: 5 skeleton rows, the
    // error panel with its Try again action, and the honest empty
    // heading.
    const states = await page.evaluate(() => {
      const skeleton = document.querySelector(
        '[aria-label="Loading completed meetings"]',
      )
      const error = document.querySelector(
        'div[role="alert"]',
      )
      const emptyHeading = Array.from(
        document.querySelectorAll('h2'),
      ).find(
        (h) =>
          h.textContent ===
          'No completed meetings yet',
      )
      return {
        skeletonRows:
          skeleton?.querySelectorAll(
            'div[class*="min-h-[68px]"]',
          ).length ??
          0,
        errorText:
          error?.textContent?.trim() ||
          '',
        errorHasRetry:
          error?.querySelector('button') !=
          null,
        emptyHeading:
          emptyHeading != null,
      }
    })
    check(
      'loading state: 5 row-shaped skeleton rows',
      states.skeletonRows === 5,
      `rows=${states.skeletonRows}`,
    )
    check(
      'error state: message + actionable Try again',
      states.errorText.includes(
        "Meetings couldn't be loaded",
      ) &&
      states.errorText.includes(
        'HTTP 500',
      ) &&
      states.errorHasRetry,
      `text=${states.errorText.slice(0, 80)} retry=${states.errorHasRetry}`,
    )
    check(
      'empty state: honest "No completed meetings yet" heading',
      states.emptyHeading,
    )
  }
} catch (error) {
  if (!launchFailed) {
    console.error(error)
  }
  failures += 1
} finally {
  if (browser) {
    await browser.close()
  }
}

writeFileSync(
  path.join(OUT, 'measurements.json'),
  JSON.stringify(measurements, null, 2),
)

/* The entry/config are throwaway build inputs (untracked, in the
   web workspace dir next to other harness entries). */
for (const f of [ENTRY, VITE_CONFIG]) {
  try {
    rmSync(f, { force: true })
  } catch {
    // best effort
  }
}

if (failures > 0) {
  console.error(
    `\n${failures} layout check(s) FAILED — see .artifacts/past-meetings-visual/`,
  )
  process.exit(1)
}

console.log(
  '\nAll Past-meetings layout checks passed. Artifacts in .artifacts/past-meetings-visual/',
)
