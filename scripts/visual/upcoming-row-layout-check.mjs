#!/usr/bin/env node
/**
 * Turnkey browser layout check for the Upcoming Meeting row
 * (Slice 21 visual acceptance).
 *
 * Renders the REAL `UpcomingMeetingsList` component (presentation-only)
 * against the REAL production CSS (fresh `vite build`) with the
 * acceptance fixtures, inside a shell that mirrors the app's width
 * chain (fixed 240px sidebar + page padding px-6 / lg:px-8), and
 * measures the COMPUTED grid geometry at the acceptance viewports:
 * 1440 / 1200 / 1100 / 900 / 390.
 *
 * This is a component+CSS harness, not the full authenticated app:
 * the row layout under test lives entirely in
 * `apps/web/src/features/meetings/UpcomingMeetings.tsx` plus the
 * compiled Tailwind CSS, so no backend/login is required.
 *
 * Run from the repository root in a standard dev environment — one
 * where Playwright's Chromium launches. (In the agent sandbox the
 * cached Chromium bundle is broken — `icudtl.dat not found` — so the
 * check cannot run there.)
 *
 *   node scripts/visual/upcoming-row-layout-check.mjs
 *
 * Outputs (`.artifacts/upcoming-row-visual/`):
 *   - measurements.json          per-viewport computed geometry
 *   - upcoming-row-<viewport>.png screenshots of the list
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
const OUT = path.join(ROOT, '.artifacts', 'upcoming-row-visual')
const ENTRY = path.join(WEB, '.upcoming-visual-entry.tsx')
const VITE_CONFIG = path.join(WEB, '.upcoming-visual.vite.config.mts')

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

/* ── 1. Fresh production build (the fix lives in the compiled CSS) ── */

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
import { UpcomingMeetingsList } from './src/features/meetings/UpcomingMeetings'
import type { UpcomingDateGroup } from './src/features/meetings/upcomingGroups'

function iso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string {
  return new Date(year, month - 1, day, hour, minute).toISOString()
}

const groups: UpcomingDateGroup[] = [
  {
    date: '2026-09-23',
    label: 'Today',
    items: [
      {
        id: 'meeting:1',
        title: 'Morning Research Sync',
        scheduledAt: iso(2026, 9, 23, 9, 30),
        meetingId: 1,
        status: 'upcoming',
        recurrenceId: null,
        recurring: false,
        occurrenceId: null,
        originalScheduledAt: null,
        rescheduled: false,
        researchGroupId: 1,
        projectId: null,
        participantIds: [1, 2, 3, 4],
      },
      {
        id: 'meeting:2',
        title: 'Live Research Session',
        scheduledAt: iso(2026, 9, 23, 12, 0),
        meetingId: 2,
        status: 'live',
        recurrenceId: null,
        recurring: false,
        occurrenceId: null,
        originalScheduledAt: null,
        rescheduled: false,
        researchGroupId: 1,
        projectId: null,
        participantIds: [1, 2, 3, 4],
      },
      {
        id: 'meeting:3',
        title: 'Project Review',
        scheduledAt: iso(2026, 9, 23, 14, 30),
        meetingId: 3,
        status: 'upcoming',
        recurrenceId: null,
        recurring: false,
        occurrenceId: null,
        originalScheduledAt: null,
        rescheduled: false,
        researchGroupId: 1,
        projectId: null,
        participantIds: [1, 2],
      },
      {
        id: 'meeting:4',
        title: 'Very Long Research Coordination Meeting Title That Keeps Growing And Growing',
        scheduledAt: iso(2026, 9, 23, 17, 30),
        meetingId: 4,
        status: 'upcoming',
        recurrenceId: null,
        recurring: false,
        occurrenceId: null,
        originalScheduledAt: null,
        rescheduled: false,
        researchGroupId: 1,
        projectId: null,
        participantIds: [1, 2, 3, 4, 5],
      },
    ],
  },
  {
    date: '2026-09-24',
    label: 'Tomorrow',
    items: [
      {
        id: 'occurrence:occ-v1',
        title: 'Weekly Research Sync',
        scheduledAt: iso(2026, 9, 24, 10, 0),
        meetingId: null,
        status: null,
        recurrenceId: 10,
        recurring: true,
        occurrenceId: 'occ-v1',
        originalScheduledAt: null,
        rescheduled: false,
        researchGroupId: 1,
        projectId: null,
        participantIds: [],
      },
    ],
  },
]

createRoot(
  document.getElementById('root') as HTMLElement,
).render(
  <UpcomingMeetingsList
    groups={groups}
    loading={false}
    recurrenceLoading={false}
    onNewMeeting={() => {}}
    onOpenMeeting={() => {}}
  />,
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
      input: { 'upcoming-visual': '.upcoming-visual-entry.tsx' },
      output: { format: 'iife' },
    },
  },
})
`,
)

console.log('== Bundling the real UpcomingMeetingsList component ==')
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
      f.startsWith('upcoming-visual-') && f.endsWith('.js'),
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
  body { margin: 0; }
  /* Mirrors AppShell (fixed 240px sidebar) + the Meetings page
     container (px-6, lg:px-8 at >=1024px). */
  #shell {
    margin-left: 240px;
    padding-left: 24px;
    padding-right: 24px;
  }
  @media (min-width: 1024px) {
    #shell { padding-left: 32px; padding-right: 32px; }
  }
</style>
<script>document.documentElement.dataset.theme = 'dark'</script>
</head>
<body>
<div id="shell"><div id="root"></div></div>
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
    await page.setViewportSize({ width, height: 1000 })
    await page.goto(`file://${htmlPath}`)
    await page.waitForSelector('[aria-label="Upcoming meetings"]')
    // Let webfonts settle so text metrics match the real app.
    await page.evaluate(() =>
      Promise.race([
        document.fonts.ready,
        new Promise((resolve) => setTimeout(resolve, 4000)),
      ]),
    )

    const m = await page.evaluate(() => {
      const section = document.querySelector(
        '[aria-label="Upcoming meetings"]',
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
      return {
        viewportWidth: window.innerWidth,
        shellWidth: Math.round(
          document
            .getElementById('shell')
            .getBoundingClientRect().width,
        ),
        sectionOverflow:
          section.scrollWidth - section.clientWidth,
        rows: rows.map((row) => {
          const cells = Array.from(row.children).map((cell) => ({
            box: box(cell),
            display: getComputedStyle(cell).display,
            text: (cell.textContent || '').trim().slice(0, 80),
            scrollWidth: cell.scrollWidth,
            clientWidth: cell.clientWidth,
          }))
          const kebab = row.querySelector(
            'button[aria-label^="Meeting actions"]',
          )
          const title =
            row.children[1] && row.children[1].children[0]
              ? row.children[1].children[0]
              : null
          return {
            columns: getComputedStyle(row)
              .gridTemplateColumns,
            row: box(row),
            rowOverflow: row.scrollWidth - row.clientWidth,
            cells,
            kebab: kebab ? box(kebab) : null,
            title: title
              ? {
                  box: box(title),
                  truncated:
                    title.scrollWidth > title.clientWidth &&
                    getComputedStyle(title).textOverflow ===
                      'ellipsis',
                }
              : null,
          }
        }),
      }
    })

    const shotPath = path.join(OUT, `upcoming-row-${width}.png`)
    const sectionBox = await page
      .locator('[aria-label="Upcoming meetings"]')
      .boundingBox()
    if (sectionBox) {
      await page.screenshot({ path: shotPath, clip: sectionBox })
    }

    measurements.push({
      viewport: width,
      ...m,
      screenshot: path.relative(ROOT, shotPath),
    })

    console.log(
      `\n== ${width}px — container ${m.shellWidth}px, computed columns per row: ==`,
    )
    for (const row of m.rows) {
      console.log(
        `  ${row.cells.map((c) => c.text.slice(0, 22)).join(' | ')}`,
      )
      console.log(`    columns: ${row.columns}`)
    }

    /* ── Assertions ───────────────────────────────────────────── */
    const byTitle = (t) =>
      m.rows.find((r) =>
        r.cells.some((c) => c.text.startsWith(t)),
      )

    if (DESKTOP.includes(width)) {
      for (const row of m.rows) {
        const label = row.cells
          .map((c) => c.text)
          .find(Boolean) || 'row'
        check(
          `${label}: four computed tracks (104 / flex / 96 / 48)`,
          /^104px\s+[\d.]+px\s+96px\s+48px$/.test(row.columns),
          row.columns,
        )
        check(
          `${label}: no row overflow`,
          row.rowOverflow <= 0,
          `overflow=${row.rowOverflow}px`,
        )
      }
      const plain = byTitle('Project Review')
      if (plain) {
        check(
          'Project Review: kebab on the same visual row as Time',
          plain.kebab != null &&
            Math.abs(plain.kebab.cy - plain.cells[0].box.cy) <= 8,
          `kebab.cy=${plain.kebab?.cy} time.cy=${plain.cells[0].box.cy}`,
        )
        check(
          'Project Review: kebab sits 16px in from the row edge',
          plain.kebab != null &&
            Math.abs(plain.kebab.right - (plain.row.right - 16)) <= 3,
          `kebab.right=${plain.kebab?.right} row.right-16=${plain.row.right - 16}`,
        )
        const people = plain.cells[2]
        check(
          'Project Review: People visible in its own column',
          people.display !== 'none' &&
            people.text === '2 people',
          `display=${people.display} text="${people.text}"`,
        )
        check(
          'Project Review: People not clipped',
          people.scrollWidth <= people.clientWidth + 1,
          `scroll=${people.scrollWidth} client=${people.clientWidth}`,
        )
        check(
          'Project Review: People column ends before the Actions track',
          Math.abs(
            people.box.right - (plain.row.right - 16 - 48 - 16),
          ) <= 3,
          `people.right=${people.box.right} expected=${plain.row.right - 80}`,
        )
        check(
          'Project Review: compact row height (~68px)',
          plain.row.height >= 60 && plain.row.height <= 70,
          `height=${plain.row.height}px`,
        )
      }
      const live = byTitle('Live Research Session')
      if (live) {
        check(
          'Live Research Session (metadata row): height 68–72px',
          live.row.height >= 60 && live.row.height <= 74,
          `height=${live.row.height}px`,
        )
      }
      const long = byTitle('Very Long Research')
      if (long) {
        check(
          'Long title: People/Actions regions still present',
          long.cells.length === 4 &&
            long.cells[2].text === '5 people' &&
            long.kebab != null,
          `cells=${long.cells.length} people="${long.cells[2].text}"`,
        )
        console.log(
          `    note: long title truncated=${long.title?.truncated} (depends on available width)`,
        )
      }
      const virtual = byTitle('Weekly Research Sync')
      if (virtual) {
        check(
          'Virtual occurrence: Actions track kept, no unsupported action',
          virtual.cells.length === 4 &&
            virtual.kebab == null &&
            virtual.cells[3].text === '',
          `cells=${virtual.cells.length} kebab=${virtual.kebab ? 'present' : 'absent'}`,
        )
      }
    }

    if (TABLET.includes(width)) {
      for (const row of m.rows) {
        const label = row.cells
          .map((c) => c.text)
          .find(Boolean) || 'row'
        check(
          `${label}: three computed tracks (88 / flex / 40)`,
          /^88px\s+[\d.]+px\s+40px$/.test(row.columns),
          row.columns,
        )
        const people = row.cells[2]
        check(
          `${label}: desktop People node display-removed (consumes no width)`,
          people.display === 'none',
          `display=${people.display}`,
        )
      }
      const plain = byTitle('Project Review')
      if (plain) {
        const peopleText = plain.cells[1].text
        check(
          'Project Review: People folded into the Meeting metadata',
          peopleText.includes('2 people'),
          `metadata="${peopleText}"`,
        )
        check(
          'Project Review: kebab on the same visual row as Time',
          plain.kebab != null &&
            Math.abs(plain.kebab.cy - plain.cells[0].box.cy) <= 8,
          `kebab.cy=${plain.kebab?.cy} time.cy=${plain.cells[0].box.cy}`,
        )
        check(
          'Project Review: kebab 16px in from the row edge',
          plain.kebab != null &&
            Math.abs(plain.kebab.right - (plain.row.right - 16)) <= 3,
          `kebab.right=${plain.kebab?.right}`,
        )
      }
    }

    if (MOBILE.includes(width)) {
      for (const row of m.rows) {
        const label = row.cells
          .map((c) => c.text)
          .find(Boolean) || 'row'
        check(
          `${label}: stacked single-column layout`,
          /^[\d.]+px$/.test(row.columns),
          row.columns,
        )
      }
      check(
        'Mobile: no horizontal overflow in the list',
        m.sectionOverflow <= 0,
        `overflow=${m.sectionOverflow}px`,
      )
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
  // open `.artifacts/upcoming-row-visual/harness.html` and resize
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
