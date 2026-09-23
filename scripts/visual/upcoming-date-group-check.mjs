#!/usr/bin/env node
/**
 * Turnkey browser visual check for the Upcoming date-group
 * presentation and the series-create success toast (date-group /
 * success-feedback stabilization slice).
 *
 * Renders the REAL `UpcomingMeetingsList` (built from the REAL
 * `groupUpcomingByDate` labels) plus the REAL `SeriesCreatedToast`
 * against the REAL production CSS (fresh `vite build`) inside a
 * shell that mirrors the app's width chain (fixed 240px sidebar +
 * page padding px-6 / lg:px-8 — the real AppShell keeps the fixed
 * 240px sidebar at EVERY viewport, including 390px), and verifies
 * the computed layout at the acceptance viewports: 1440 / 900 /
 * 390.
 *
 * Shell fidelity notes:
 *   - the harness mount is `#visual-root`, NOT `#root`: the app's
 *     base CSS applies `min-width: 320px` to `#root`, which would
 *     inflate the 390px shell column (240px sidebar + px-6 =
 *     102px) to 320px and create an artificial 584px-wide document
 *     (264 + 320). In the real app `#root` is the full-width
 *     top-level root (>= 320px at every acceptance viewport), so
 *     the min-width is inert there and the mobile list column is a
 *     plain 102px div.
 *   - the toast toggle button is capped at the shell column width
 *     (max-w-full) so this harness-only chrome can never overflow
 *     the mobile column (an overflowing clicked button scrolls the
 *     document horizontally and shifts every viewport-relative
 *     measurement).
 *
 * Checks performed (per viewport):
 *   - header copy: `Today · Wed, Sep 23` / `Tomorrow · Thu, Sep 24`
 *     (relative + absolute) and `Fri, Sep 25` (absolute only);
 *   - header geometry: 12px / 600, 32px band, NO all-caps
 *     text-transform;
 *   - the Today header carries the slightly stronger text color, the
 *     other headers the secondary muted color (no badge / accent
 *     bar);
 *   - ONE shared list container: the section's direct children are
 *     exactly the group wrappers — no per-day cards;
 *   - group separation: first group has NO leading margin, every
 *     later group has an 8px margin-top before its header;
 *   - ordinary row dividers stay subtle: the visible 1px line
 *     (Tailwind v4 `divide-y` = border-bottom of every
 *     :not(:last-child) row, border-top 0px) resolves to the
 *     canonical `--color-border-subtle` token; the group header
 *     underline uses the SAME subtle token (the group boundary is
 *     distinguished by its header surface, not a stronger border);
 *   - row geometry: 4 desktop / 3 tablet / 1 mobile tracks;
 *     compact 60–74px rows at desktop + tablet; mobile rows are
 *     intentionally stacked (time / title+metadata / actions) and
 *     are asserted behaviorally — single track, stacked regions
 *     without overlap, compact py-3/px-4 padding, min-height floor
 *     kept, no row-internal horizontal overflow (NO desktop height
 *     band on the stacked mobile row);
 *   - no horizontal overflow at any viewport, and the list stays
 *     inside the viewport;
 *   - the toast is position:fixed in the TOP-RIGHT (below the
 *     sticky header), fits the viewport, and its appearance does NOT
 *     shift the Upcoming list (list bounding box measured with and
 *     without the toast).
 *
 * This is a component+CSS harness, not the full authenticated app:
 * the presentation under test lives entirely in
 * `apps/web/src/features/meetings/UpcomingMeetings.tsx`,
 * `upcomingGroups.ts`, and `MeetingListPage.tsx` (toast) plus the
 * compiled Tailwind CSS, so no backend/login is required.
 *
 * Run from the repository root in a standard dev environment — one
 * where Playwright's Chromium launches. (In the agent sandbox the
 * cached Chromium bundle is broken — `icudtl.dat not found` — so the
 * browser phase cannot run there; the build/bundle phases still run
 * and are verified.)
 *
 *   node scripts/visual/upcoming-date-group-check.mjs
 *
 * Outputs (`.artifacts/upcoming-date-group-visual/`):
 *   - measurements.json              per-viewport computed geometry
 *   - date-group-<viewport>.png      list without toast
 *   - date-group-toast-<viewport>.png list WITH the success toast
 *   - harness.html                   kept openable in any browser
 *
 * Exit code 0 = all layout assertions pass; 1 = at least one failed
 * (a browser that cannot launch is reported as ENVIRONMENT/HARNESS
 * and also exits 1).
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

const ROOT = path.resolve(
  new URL('.', import.meta.url).pathname,
  '..',
  '..',
)
const WEB = path.join(ROOT, 'apps', 'web')
const OUT = path.join(ROOT, '.artifacts', 'upcoming-date-group-visual')
const ENTRY = path.join(WEB, '.upcoming-dategroup-visual-entry.tsx')
const VITE_CONFIG = path.join(
  WEB,
  '.upcoming-dategroup-visual.vite.config.mts',
)

const VIEWPORTS = [1440, 900, 390]

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
  console.error(
    'Production build failed — cannot verify layout.',
  )
  process.exit(1)
}
const cssFile = readFileSync(
  path.join(WEB, 'dist', 'index.html'),
  'utf8',
)
  .match(/assets\/(index-[^"]+\.css)/)
  ?.[1]
if (!cssFile) {
  console.error(
    'Could not locate the built CSS in dist/index.html.',
  )
  process.exit(1)
}
const cssPath = path.join(WEB, 'dist', 'assets', cssFile)

/* ── 2. Bundle the real components with a throwaway vite build ──── */

mkdirSync(OUT, { recursive: true })
rmSync(path.join(OUT, 'assets'), {
  recursive: true,
  force: true,
})

writeFileSync(
  ENTRY,
  `import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { groupUpcomingByDate } from './src/features/meetings/upcomingGroups'
import type { UpcomingMeeting } from './src/features/meetings/upcomingModel'
import { UpcomingMeetingsList } from './src/features/meetings/UpcomingMeetings'
import { SeriesCreatedToast } from './src/features/meetings/MeetingListPage'

// Fixed clock: Wednesday, September 23, 2026, 09:00 local — the
// same reference the unit tests pin, built from LOCAL date parts so
// the expected header copy is stable in every time zone.
const NOW = new Date(2026, 8, 23, 9, 0)

function iso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string {
  return new Date(
    year,
    month - 1,
    day,
    hour,
    minute,
  ).toISOString()
}

const items: UpcomingMeeting[] = [
  {
    id: 'meeting:1',
    title: 'Morning Research Sync',
    scheduledAt: iso(2026, 9, 23, 17, 0),
    meetingId: 1,
    status: 'upcoming',
    recurrenceId: null,
    recurring: false,
    occurrenceId: null,
    originalScheduledAt: null,
    rescheduled: false,
    researchGroupId: 1,
    projectId: null,
    participantIds: [1],
  },
  {
    id: 'occurrence:occ-v1',
    title: 'Weekly Sync',
    scheduledAt: iso(2026, 9, 23, 18, 30),
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
  {
    id: 'meeting:2',
    title: 'Team Coordination',
    scheduledAt: iso(2026, 9, 24, 17, 30),
    meetingId: 2,
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
  {
    id: 'occurrence:occ-v2',
    title: 'Board Sync',
    scheduledAt: iso(2026, 9, 25, 9, 30),
    meetingId: null,
    status: null,
    recurrenceId: 11,
    recurring: true,
    occurrenceId: 'occ-v2',
    originalScheduledAt: null,
    rescheduled: false,
    researchGroupId: 1,
    projectId: null,
    participantIds: [],
  },
]

function Harness() {
  const [toastVisible, setToastVisible] = useState(false)
  // Real label generation + grouping (fixed NOW).
  const groups = groupUpcomingByDate(items, NOW)

  return (
    <div>
      <button
        type="button"
        id="toast-toggle"
        className="max-w-full"
        onClick={() =>
          setToastVisible((current) => !current)
        }
      >
        Toggle success toast
      </button>

      <div className="mt-4">
        <UpcomingMeetingsList
          groups={groups}
          loading={false}
          recurrenceLoading={false}
          onNewMeeting={() => {}}
          onOpenMeeting={() => {}}
        />
      </div>

      {toastVisible && <SeriesCreatedToast />}
    </div>
  )
}

createRoot(
  document.getElementById('visual-root') as HTMLElement,
).render(<Harness />)
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
      .replace(/\\\\/g, '/')}',
    emptyOutDir: false,
    rollupOptions: {
      input: {
        'upcoming-dategroup-visual':
          '.upcoming-dategroup-visual-entry.tsx',
      },
      output: { format: 'iife' },
    },
  },
})
`,
)

console.log(
  '== Bundling the real Upcoming list + success toast ==',
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
        f.startsWith('upcoming-dategroup-visual-') &&
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

// Keep the artifact self-contained (openable in ANY
// Chromium-based browser): copy the real production CSS next to
// harness.html instead of pointing into apps/web/dist.
cpSync(cssPath, path.join(OUT, 'production.css'))

// Remove the throwaway source files from the repo (always run —
// including on a browser-launch failure) but keep the harness
// artifacts (harness.html + bundle + production.css).
function cleanupHarnessFiles() {
  rmSync(ENTRY, { force: true })
  rmSync(VITE_CONFIG, { force: true })
  rmSync(path.join(OUT, 'index.html'), { force: true })
}

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
<link rel="stylesheet" href="production.css" />
<style>
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
</head>
<body>
<div id="shell"><div id="visual-root"></div></div>
<script src="${path.join(OUT, 'assets', bundleFile).replace(/\\\\/g, '/')}" ></script>
</body>
</html>
`,
)

/* ── 4. Measure in a real browser at each viewport ──────────────── */

const { chromium } = await import(
  path.join(ROOT, 'node_modules', 'playwright', 'index.mjs')
)

let browser
const measurements = []

try {
  try {
    browser = await chromium.launch({ headless: true })
  } catch (launchError) {
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
      'Run this check in a standard dev environment where Playwright Chromium is healthy (e.g. `npx playwright install chromium`), or open the kept ' +
        path.relative(ROOT, htmlPath) +
        ' in any Chromium-based browser and resize the window.',
    )
    cleanupHarnessFiles()
    process.exit(1)
  }

  const page = await browser.newPage()

  for (const width of VIEWPORTS) {
    await page.setViewportSize({ width, height: 1000 })
    await page.goto(`file://${htmlPath}`)
    await page.waitForSelector(
      '[aria-label="Upcoming meetings"]',
    )
    // Let webfonts settle so text metrics match the real app.
    await page.evaluate(() =>
      Promise.race([
        document.fonts.ready,
        new Promise((resolve) => setTimeout(resolve, 4000)),
      ]),
    )

    // Pin the scroll origin so every measurement is taken from
    // the same viewport reference point.
    await page.evaluate(() => window.scrollTo(0, 0))

    const m = await page.evaluate(() => {
      const section = document.querySelector(
        '[aria-label="Upcoming meetings"]',
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
      const headers = Array.from(
        section.querySelectorAll('h3'),
      ).map((h) => ({
        text: (h.textContent || '').trim(),
        fontSize: getComputedStyle(h).fontSize,
        fontWeight: getComputedStyle(h).fontWeight,
        textTransform: getComputedStyle(h)
          .textTransform,
        height: h.offsetHeight,
        color: getComputedStyle(h).color,
        borderBottomColor:
          getComputedStyle(h)
            .borderBottomColor,
        borderBottomWidth:
          getComputedStyle(h)
            .borderBottomWidth,
      }))
      const wrappers = Array.from(
        section.children,
      ).map((w) => ({
        marginTop: getComputedStyle(w).marginTop,
        hasHeader:
          w.querySelector('h3') != null,
      }))
      const rows = Array.from(
        section.querySelectorAll('div[class*="min-h-[68px]"]'),
      ).map((row) => {
        const r = row.getBoundingClientRect()
        return {
          columns:
            getComputedStyle(row).gridTemplateColumns,
          height: row.getBoundingClientRect().height,
          top: r.top,
          trackCount:
            getComputedStyle(row).gridTemplateColumns
              .trim().split(/\s+/).length,
          paddingTop: getComputedStyle(row).paddingTop,
          paddingBottom: getComputedStyle(row).paddingBottom,
          paddingLeft: getComputedStyle(row).paddingLeft,
          paddingRight: getComputedStyle(row).paddingRight,
          rowScrollWidth: row.scrollWidth,
          rowClientWidth: row.clientWidth,
          children: Array.from(row.children).map(
            (c) => {
              const cr = c.getBoundingClientRect()
              return {
                display: getComputedStyle(c).display,
                top: cr.top,
                bottom: cr.bottom,
                height: cr.height,
              }
            },
          ),
        }
      })
      // Tailwind v4 draws `divide-y` as a 1px border-BOTTOM on
      // every :not(:last-child) row (border-top stays 0px), so
      // the visible line is measured on the rows that actually
      // carry it — never the border-top of the following row
      // (which has no divider rule and would fall back to
      // currentColor).
      const divideContainers = Array.from(
        section.querySelectorAll('.divide-y'),
      ).map((c) => {
        const groupRows = Array.from(c.children)
        const nonLast =
          groupRows.slice(0, -1)
        const cs = (el, prop) =>
          getComputedStyle(el)[prop]
        return {
          rowCount: groupRows.length,
          lineColor: nonLast.map((r) =>
            cs(r, 'borderBottomColor')),
          lineWidth: nonLast.map((r) =>
            cs(r, 'borderBottomWidth')),
          topWidth: nonLast.map((r) =>
            cs(r, 'borderTopWidth')),
          lastBottomWidth:
            groupRows.length > 0
              ? cs(
                  groupRows[groupRows.length - 1],
                  'borderBottomWidth',
                )
              : null,
        }
      })
      // Resolve the canonical subtle-border token through a
      // probe element so the comparison uses the same color
      // space as the computed border colors.
      const probe = document.createElement('div')
      probe.style.borderTopColor =
        'var(--color-border-subtle)'
      document.body.appendChild(probe)
      const subtleToken =
        getComputedStyle(probe).borderTopColor
      probe.remove()
      return {
        viewportWidth: window.innerWidth,
        scrollWidth:
          document.documentElement.scrollWidth,
        section: box(section),
        headers,
        wrappers,
        rows,
        divideContainers,
        subtleToken,
      }
    })

    const shotPath = path.join(OUT, `date-group-${width}.png`)
    await page.screenshot({
      path: shotPath,
      clip: { x: 0, y: 0, width, height: 1000 },
    })

    /* Toggle the toast and re-measure: the list must NOT move. */
    await page.click('#toast-toggle')
    await page.waitForSelector('[role="status"]')
    // Pin the scroll origin again so the before/after boxes
    // share one viewport reference (the invariant under test
    // is the list NOT moving, not a scroll offset).
    await page.evaluate(() => window.scrollTo(0, 0))
    const toast = await page.evaluate(() => {
      const section = document.querySelector(
        '[aria-label="Upcoming meetings"]',
      )
      const toastEl = document.querySelector(
        '[role="status"]',
      )
      const r = toastEl.getBoundingClientRect()
      return {
        position: getComputedStyle(toastEl).position,
        box: {
          left: Math.round(r.left),
          top: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height),
          right: Math.round(r.right),
          bottom: Math.round(r.bottom),
        },
        section: (() => {
          const s =
            section.getBoundingClientRect()
          return {
            left: Math.round(s.left),
            top: Math.round(s.top),
            width: Math.round(s.width),
            height: Math.round(s.height),
          }
        })(),
        scrollWidth:
          document.documentElement.scrollWidth,
      }
    })
    const toastShotPath = path.join(
      OUT,
      `date-group-toast-${width}.png`,
    )
    await page.screenshot({
      path: toastShotPath,
      clip: { x: 0, y: 0, width, height: 1000 },
    })

    measurements.push({
      viewport: width,
      ...m,
      toast,
      screenshot: path.relative(ROOT, shotPath),
      toastScreenshot: path.relative(
        ROOT,
        toastShotPath,
      ),
    })

    /* ── Assertions ─────────────────────────────────────────── */

    const [today, tomorrow, later] = m.headers
    check(
      'header copy: Today carries relative + absolute date',
      today?.text === 'Today · Wed, Sep 23',
      today?.text,
    )
    check(
      'header copy: Tomorrow carries relative + absolute date',
      tomorrow?.text === 'Tomorrow · Thu, Sep 24',
      tomorrow?.text,
    )
    check(
      'header copy: later group is absolute date only',
      later?.text === 'Fri, Sep 25',
      later?.text,
    )

    for (const [label, h] of m.headers.entries()) {
      check(
        `header ${label}: 12px / 600 / 32px band`,
        h.fontSize === '12px' &&
          h.fontWeight === '600' &&
          h.height === 32,
        `${h.fontSize} / ${h.fontWeight} / ${h.height}px`,
      )
      check(
        `header ${label}: no all-caps tracking treatment`,
        h.textTransform === 'none',
        h.textTransform,
      )
    }
    check(
      'header emphasis: Today slightly stronger, others secondary',
      today?.color === 'rgb(28, 32, 36)' &&
        tomorrow?.color === 'rgb(96, 100, 108)' &&
        later?.color === 'rgb(96, 100, 108)',
      `today=${today?.color} tomorrow=${tomorrow?.color} later=${later?.color}`,
    )

    check(
      'one shared list container: exactly the group wrappers are the section children',
      m.wrappers.length === 3 &&
        m.wrappers.every((w) => w.hasHeader),
      `children=${m.wrappers.length}`,
    )
    check(
      'first group: no artificial leading gap',
      m.wrappers[0]?.marginTop === '0px',
      m.wrappers[0]?.marginTop,
    )
    check(
      'later groups: ~8px separation before each header',
      m.wrappers[1]?.marginTop === '8px' &&
        m.wrappers[2]?.marginTop === '8px',
      `${m.wrappers[1]?.marginTop} / ${m.wrappers[2]?.marginTop}`,
    )
    // Row dividers: the visible line is the border-bottom of
    // every non-last row (Tailwind v4 divide-y contract); it
    // must resolve to the canonical subtle token — the same
    // token as the group header underline. The group boundary
    // is distinguished by its header surface, not a stronger
    // border.
    const dividersOk =
      m.divideContainers.length === m.wrappers.length &&
      m.divideContainers.every(
        (c) =>
          c.rowCount >= 1 &&
          c.lineColor.every(
            (col) => col === m.subtleToken,
          ) &&
          c.lineWidth.every((w) => w === '1px') &&
          c.topWidth.every((w) => w === '0px') &&
          c.lastBottomWidth === '0px',
      )
    check(
      'row dividers stay subtle (border-border-subtle)',
      dividersOk &&
        m.subtleToken === 'rgb(224, 225, 230)',
      `token=${m.subtleToken} containers=${JSON.stringify(m.divideContainers)}`,
    )
    check(
      'group boundary underline uses the same subtle token',
      m.headers.every(
        (h) =>
          h.borderBottomColor === m.subtleToken &&
          h.borderBottomWidth === '1px',
      ),
      m.headers
        .map((h) => h.borderBottomColor)
        .join(' / '),
    )

    if (width >= 768) {
      const expectedTracks =
        width >= 1100 ? 4 : 3
      check(
        `row grid unchanged at ${width}px (${expectedTracks} tracks, compact rows)`,
        m.rows.length === 4 &&
          m.rows.every(
            (row) =>
              row.trackCount === expectedTracks &&
              row.height >= 60 &&
              row.height <= 74,
          ),
        m.rows
          .map(
            (row) =>
              `${row.trackCount}t/${Math.round(row.height)}px`,
          )
          .join(' '),
      )
      if (width >= 1100) {
        check(
          `desktop tracks start 104px and end 96px/48px at ${width}px`,
          m.rows.every((row) =>
            /^104px\s+[\d.]+px\s+96px\s+48px$/.test(
              row.columns,
            ),
          ),
          m.rows[0]?.columns,
        )
      }
    } else {
      /* Mobile: the row is intentionally stacked
         (time / title+metadata / actions) — assert
         BEHAVIORAL geometry, never the desktop
         60–74px band. */
      check(
        `mobile rows: single track at ${width}px`,
        m.rows.length === 4 &&
          m.rows.every((row) => row.trackCount === 1),
        m.rows.map((r) => `${r.trackCount}t`).join(' '),
      )
      check(
        'mobile rows: stacked regions, no overlap, single gap slots',
        m.rows.every((row) => {
          const visible = row.children.filter(
            (c) => c.display !== 'none',
          )
          if (visible.length < 2) {
            return false
          }
          for (let i = 1; i < visible.length; i++) {
            const gap =
              visible[i].top - visible[i - 1].bottom
            if (gap < -0.5 || gap > 13) {
              return false
            }
          }
          const firstOffset =
            visible[0].top - row.top
          return (
            firstOffset >=
              parseFloat(row.paddingTop) - 1 &&
            firstOffset <=
              parseFloat(row.paddingTop) + 1
          )
        }),
        m.rows
          .map((row) =>
            row.children
              .filter((c) => c.display !== 'none')
              .map(
                (c) =>
                  `${Math.round(c.top)}-${Math.round(c.bottom)}`,
              )
              .join(','),
          )
          .join(' | '),
      )
      check(
        'mobile rows: min-height floor kept, no accidental blank row',
        m.rows.every(
          (row) =>
            row.height >= 68 && row.height <= 180,
        ),
        m.rows.map((r) => `${Math.round(r.height)}px`).join(' '),
      )
      check(
        'mobile rows: compact py-3 / px-4 padding',
        m.rows.every(
          (row) =>
            row.paddingTop === '12px' &&
            row.paddingBottom === '12px' &&
            row.paddingLeft === '16px' &&
            row.paddingRight === '16px',
        ),
        m.rows
          .map((r) => `${r.paddingTop}/${r.paddingLeft}`)
          .join(' '),
      )
      check(
        `mobile rows: no horizontal overflow within a row at ${width}px`,
        m.rows.every(
          (row) =>
            row.rowScrollWidth <= row.rowClientWidth,
        ),
        m.rows
          .map((r) => `${r.rowScrollWidth}/${r.rowClientWidth}`)
          .join(' '),
      )
    }

    check(
      `no horizontal overflow at ${width}px (list)`,
      m.scrollWidth <= width,
      `scrollWidth=${m.scrollWidth}`,
    )
    check(
      `list stays inside the viewport at ${width}px`,
      m.section.right <= width,
      `right=${m.section.right} (viewport ${width})`,
    )

    check(
      'toast is position:fixed (outside the list flow)',
      toast.position === 'fixed',
      toast.position,
    )
    // top-20 = 80px from the viewport top (below the sticky 64px
    // global TopBar); right-6 = 24px from the right edge.
    check(
      `toast is TOP-RIGHT at ${width}px (top≈80px, right≈viewport-24px)`,
      Math.abs(toast.box.top - 80) <= 2 &&
        Math.abs(toast.box.right - (width - 24)) <= 2,
      `top=${toast.box.top} right=${toast.box.right} (viewport ${width})`,
    )
    check(
      'toast appearance does NOT shift the Upcoming list',
      toast.section.left === m.section.left &&
        toast.section.top === m.section.top &&
        toast.section.width === m.section.width &&
        toast.section.height === m.section.height,
      `before=${JSON.stringify(m.section)} after=${JSON.stringify(toast.section)}`,
    )
    check(
      `toast fits inside the viewport at ${width}px`,
      toast.box.left >= 0 &&
        toast.box.right <= width &&
        toast.box.bottom <= 1000,
      JSON.stringify(toast.box),
    )
    check(
      `no horizontal overflow at ${width}px (with toast)`,
      toast.scrollWidth <= width,
      `scrollWidth=${toast.scrollWidth}`,
    )

    console.log(
      `\n== ${width}px — list at top=${m.section.top}, ` +
        `${m.section.width}px wide; ` +
        `${m.rows.length} rows ==`,
    )
    for (const h of m.headers) {
      console.log(`  header: ${h.text}`)
    }
  }
} finally {
  if (browser) {
    await browser.close()
  }
  cleanupHarnessFiles()
}

writeFileSync(
  path.join(OUT, 'measurements.json'),
  JSON.stringify(measurements, null, 2),
)

console.log(
  `\nMeasurements + screenshots written to ` +
    `.artifacts/upcoming-date-group-visual/`,
)
if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED.`)
  process.exit(1)
}
console.log('\nAll layout checks passed.')
