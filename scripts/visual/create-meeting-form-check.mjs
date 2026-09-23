#!/usr/bin/env node
/**
 * Turnkey browser layout check for the Create Meeting dialog
 * (Schedule-first progressive recurrence visual acceptance).
 *
 * Renders the REAL `CreateMeetingDialog` component against the REAL
 * production CSS (fresh `vite build`) with stubbed data dependencies
 * (projects / meeting-series / research-group), and drives the form
 * through its acceptance states:
 *   - `default`:           no Template selected (Repeat disabled + gated);
 *   - `templateNonRepeat`: Template + Does not repeat (enabled, no
 *                          recurrence details);
 *   - `weekly`:            Template + Weekly (weekday row auto-selected);
 *   - `daily` / `monthly`: Template + Daily / Monthly (no weekday row);
 *   - `weeklyInvalid`:     Weekly with every weekday deselected (field
 *                          error, no summary, disabled Create series);
 *   - `templateRemoved`:   Template removed after configuring a recurrence
 *                          (canonical reset: disabled `Does not repeat` +
 *                          gating helper, no leftover details).
 *
 * It measures the COMPUTED geometry at the acceptance viewports:
 * 1440 / 1280 (desktop), 900 (tablet), 390 (mobile) against the slice
 * targets:
 *   - modal width 560 px, max-width calc(100vw - 32px);
 *   - Date | Time row: minmax(0,1fr) / 120-128 px, 10-12 px gap
 *     (stacked single column below 480 px);
 *   - field order Title → Context → Meeting template → Schedule
 *     → Repeat → Participants;
 *   - weekday buttons height >= 36 px;
 *   - recurrence details indentation 12-16 px, row gap 10-12 px
 *     (no left-border timeline treatment);
 *   - footer buttons 36 px tall, 8 px gap, right-aligned;
 *   - `Time zone: <IANA>` line, `Research group` Context option,
 *     `Does not repeat` default, gating helper without a Template,
 *     `Create meeting` / `Create series` primary copy.
 *
 * This is a component+CSS harness, not the full authenticated app:
 * the layout under test lives entirely in
 * `apps/web/src/features/meetings/CreateMeetingDialog.tsx` plus the
 * compiled Tailwind CSS, so no backend/login is required.
 *
 * Run from the repository root in a standard dev environment — one
 * where Playwright's Chromium launches. (In the agent sandbox the
 * cached Chromium bundle is broken — `icudtl.dat not found` — so the
 * check cannot run there.)
 *
 *   node scripts/visual/create-meeting-form-check.mjs
 *
 * Outputs (`.artifacts/create-meeting-form-visual/`):
 *   - measurements.json            per-viewport computed geometry
 *   - create-meeting-<state>-<viewport>.png  screenshots of the dialog
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
const OUT = path.join(ROOT, '.artifacts', 'create-meeting-form-visual')
const ENTRY = path.join(WEB, '.create-meeting-visual-entry.tsx')
const VITE_CONFIG = path.join(WEB, '.create-meeting-visual.vite.config.mts')
const STUBS = path.join(OUT, 'stubs')

const VIEWPORTS = [1440, 1280, 900, 390]
const DESKTOP = [1440, 1280, 900]
const MOBILE = [390]

let failures = 0
function check(label, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL'
  if (!ok) {
    failures += 1
  }
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`)
}

/* ── 1. Fresh production build (the layout lives in the compiled CSS) ── */

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
  .match(/assets\/(index-[^\"]+\.css)/)?.[1]
if (!cssFile) {
  console.error('Could not locate the built CSS in dist/index.html.')
  process.exit(1)
}
const cssPath = path.join(WEB, 'dist', 'assets', cssFile)

/* ── 2. Bundle the real dialog with stubbed data dependencies ───────── */

mkdirSync(OUT, { recursive: true })
mkdirSync(STUBS, { recursive: true })
rmSync(path.join(OUT, 'assets'), { recursive: true, force: true })

writeFileSync(
  path.join(STUBS, 'projects.ts'),
  `export function listProjects(_gid: number): Promise<never[]> {
  return Promise.resolve([])
}
`,
)
writeFileSync(
  path.join(STUBS, 'meetings.ts'),
  `export function listMeetingSeries(_gid: number): Promise<never[]> {
  return Promise.resolve([
    {
      id: 7,
      researchGroupId: 1,
      scope: 'group',
      projectId: null,
      title: 'Weekly template',
      description: '',
      isArchived: false,
      createdById: 1,
      createdAt: '2026-09-10T08:00:00Z',
      updatedAt: '2026-09-10T08:00:00Z',
    },
  ] as never[])
}
export function searchMeetingSeriesParticipantCandidates(
  _seriesId: number,
  _query: string,
): Promise<never[]> {
  return Promise.resolve([])
}
export function searchStandaloneMeetingParticipantCandidates(
  _gid: number,
  _params: unknown,
): Promise<never[]> {
  return Promise.resolve([])
}
`,
)
writeFileSync(
  path.join(STUBS, 'researchGroup.ts'),
  `export function useResearchGroup() {
  return {
    groups: [{ id: 1, name: 'FG', role: 'admin' }],
    activeResearchGroupId: 1,
    activeResearchGroup: { id: 1, name: 'FG', role: 'admin' },
    loading: false,
    error: null,
    setActiveResearchGroupId: () => {},
    reloadResearchGroups: () => {},
    addResearchGroup: () => {},
  }
}
`,
)

writeFileSync(
  ENTRY,
  `import { createRoot } from 'react-dom/client'
import { CreateMeetingDialog } from './src/features/meetings/CreateMeetingDialog'

createRoot(document.getElementById('root') as HTMLElement).render(
  <CreateMeetingDialog
    open
    submitting={false}
    submitError={null}
    onClose={() => {}}
    onCreate={() => {}}
    onCreateSeries={() => {}}
  />,
)
`,
)
writeFileSync(
  VITE_CONFIG,
  `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '../../api/projects': path.resolve(
        '${STUBS.replace(/\\/g, '/')}',
        'projects.ts',
      ),
      '../../api/meetings': path.resolve(
        '${STUBS.replace(/\\/g, '/')}',
        'meetings.ts',
      ),
      '../research-group/useResearchGroup': path.resolve(
        '${STUBS.replace(/\\/g, '/')}',
        'researchGroup.ts',
      ),
    },
  },
  build: {
    outDir: '${path.relative(WEB, OUT).replace(/\\/g, '/')}',
    emptyOutDir: false,
    rollupOptions: {
      input: {
        'create-meeting-visual': '.create-meeting-visual-entry.tsx',
      },
      output: { format: 'iife' },
    },
  },
})
`,
)

console.log('== Bundling the real CreateMeetingDialog component ==')
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
      (f) => f.startsWith('create-meeting-visual-') && f.endsWith('.js'),
    )
  : undefined
if (!bundleMatch) {
  console.error('Could not locate the bundle in the harness build output.')
  process.exit(1)
}
const bundleFile = bundleMatch

/* ── 3. Harness page ────────────────────────────────────────────────── */

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
</style>
<script>document.documentElement.dataset.theme = 'dark'</script>
</head>
<body>
<div id="root"></div>
<script src="${path.join(OUT, 'assets', bundleFile).replace(/\\/g, '/')}" ></script>
</body>
</html>
`,
)

/* ── 4. Measure + drive in a real browser at each viewport ──────────── */

const { chromium } = await import(
  path.join(ROOT, 'node_modules', 'playwright', 'index.mjs')
)

let browser
let launchFailed = false
const measurements = []

async function measureDefaultState(page) {
  return page.evaluate(() => {
    const modal = document.querySelector('[role="dialog"]')
    const rect = (el) => {
      const r = el.getBoundingClientRect()
      return {
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
        right: r.right,
      }
    }
    const labelFor = (htmlFor) =>
      document.querySelector(`label[for="${htmlFor}"]`)
    const topOf = (el) => el.getBoundingClientRect().top

    const dateInput = document.getElementById('create-meeting-date')
    const timeInput = document.getElementById('create-meeting-time')
    const grid = dateInput.closest('div[class*="grid"]')
    const gridStyle = grid ? getComputedStyle(grid) : null

    const tzLine = Array.from(modal.querySelectorAll('p')).find((p) =>
      p.textContent.startsWith('Time zone: '),
    )

    const footer = modal.querySelector('form')?.lastElementChild
    const buttons = footer ? Array.from(footer.querySelectorAll('button')) : []

    const contextOptions = Array.from(
      document.getElementById('create-meeting-project')?.options ?? [],
    ).map((o) => o.textContent)
    const repeatSelect = document.getElementById('create-meeting-repeat')

    return {
      modal: rect(modal),
      order: {
        Title: topOf(
          document.querySelector(
            'label input[placeholder="Weekly Sync"]',
          ).closest('label'),
        ),
        Context: topOf(labelFor('create-meeting-project')),
        'Meeting template': topOf(labelFor('create-meeting-template')),
        Schedule: topOf(
          Array.from(modal.querySelectorAll('h3')).find(
            (h) => h.textContent === 'Schedule',
          ),
        ),
        Repeat: topOf(labelFor('create-meeting-repeat')),
        Participants: topOf(labelFor('create-meeting-participants')),
      },
      date: rect(dateInput),
      time: rect(timeInput),
      gridColumns: gridStyle ? gridStyle.gridTemplateColumns : null,
      timezoneLine: tzLine ? tzLine.textContent : null,
      contextOptions,
      repeat: {
        value: repeatSelect.value,
        disabled: repeatSelect.disabled,
      },
      gatingHelper: modal.textContent.includes(
        'Choose a meeting template to enable recurrence.',
      ),
      footerButtons: buttons.map((b) => ({
        text: b.textContent.trim(),
        ...rect(b),
      })),
    }
  })
}

async function measureWeeklyState(page) {
  return page.evaluate(() => {
    const modal = document.querySelector('[role="dialog"]')
    const rect = (el) => {
      const r = el.getBoundingClientRect()
      return {
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
      }
    }

    const weekdayButtons = Array.from(
      document.querySelectorAll(
        'button[aria-label="Monday"], button[aria-label="Tuesday"], button[aria-label="Wednesday"], button[aria-label="Thursday"], button[aria-label="Friday"], button[aria-label="Saturday"], button[aria-label="Sunday"]',
      ),
    )
    const weekdayGrid = document.querySelector(
      '#create-meeting-recurrence-weekdays-label',
    )
      ?.parentElement?.querySelector('[role="group"]')

    const details = document.getElementById(
      'create-meeting-recurrence-interval',
    )?.closest('div.ml-3\\.5')
    const repeatSelect = document.getElementById('create-meeting-repeat')

    const everyBlock =
      details?.querySelector('div') ?? null
    const onLabel =
      weekdayGrid?.previousElementSibling ?? null

    // The summary <p> carries an aria-hidden Material Symbols icon span
    // (ligature text "repeat"); the VISIBLE copy is the paragraph's
    // direct text nodes only — raw textContent would include the icon.
    const copyOf = (el) =>
      Array.from(el.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join('')
        .trim()

    const summary = Array.from(modal.querySelectorAll('p')).find((p) =>
      /^Every .* · (no end|until |\d+ meeting)/.test(copyOf(p)),
    )

    const submit = Array.from(
      modal.querySelectorAll('button[type="submit"]'),
    )[0]

    return {
      weekdayButtonCount: weekdayButtons.length,
      weekdayButtons: weekdayButtons.map((b) => rect(b)),
      weekdayGridColumns: weekdayGrid
        ? getComputedStyle(weekdayGrid).gridTemplateColumns
        : null,
      detailsIndent:
        details && repeatSelect
          ? details.getBoundingClientRect().left -
            repeatSelect.getBoundingClientRect().left
          : null,
      everyBottom: everyBlock
        ? everyBlock.getBoundingClientRect().bottom
        : null,
      onTop: onLabel ? onLabel.getBoundingClientRect().top : null,
      summaryText: summary ? copyOf(summary) : null,
      summaryFontSizePx: summary
        ? Number.parseFloat(getComputedStyle(summary).fontSize)
        : null,
      submitText: submit ? submit.textContent.trim() : null,
      hasLeftBorder: Boolean(details) && getComputedStyle(details).borderLeftWidth !== '0px',
      templateHelper: modal.textContent.includes(
        'Uses the template sections as the starting structure.',
      ),
    }
  })
}

/** Repeat/editor state flags for the progressive-recurrence states. */
async function measureRepeatState(page) {
  return page.evaluate(() => {
    const modal = document.querySelector('[role="dialog"]')
    const repeatSelect = document.getElementById('create-meeting-repeat')
    const submit = modal.querySelector('button[type="submit"]')
    const weekdayButtons = Array.from(
      modal.querySelectorAll(
        'button[aria-label="Monday"], button[aria-label="Tuesday"], button[aria-label="Wednesday"], button[aria-label="Thursday"], button[aria-label="Friday"], button[aria-label="Saturday"], button[aria-label="Sunday"]',
      ),
    )
    const endModeRadios = Array.from(
      modal.querySelectorAll(
        'input[name="create-meeting-recurrence-end-mode"]',
      ),
    )
    const intervalInput =
      document.getElementById('create-meeting-recurrence-interval')
    // The summary <p> carries an aria-hidden Material Symbols icon span
    // (ligature text "repeat"); the VISIBLE copy is the paragraph's
    // direct text nodes only — raw textContent would include the icon.
    const copyOf = (el) =>
      Array.from(el.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join('')
        .trim()

    const summary = Array.from(modal.querySelectorAll('p')).find((p) =>
      /^Every .* · (no end|until |\d+ meeting)/.test(copyOf(p)),
    )

    return {
      repeatValue: repeatSelect ? repeatSelect.value : null,
      repeatDisabled: repeatSelect ? repeatSelect.disabled : null,
      submitText: submit ? submit.textContent.trim() : null,
      submitDisabled: submit ? submit.disabled : null,
      hasInterval: Boolean(intervalInput),
      intervalValue: intervalInput ? intervalInput.value : null,
      weekdayCount: weekdayButtons.length,
      endModeRadioCount: endModeRadios.length,
      summaryText: summary ? copyOf(summary) : null,
      summaryFontSizePx: summary
        ? Number.parseFloat(getComputedStyle(summary).fontSize)
        : null,
      alertText: Array.from(modal.querySelectorAll('[role="alert"]'))
        .map((alert) => alert.textContent.trim())
        .join(' | '),
      templateHelper: modal.textContent.includes(
        'Uses the template sections as the starting structure.',
      ),
      gatingHelper: modal.textContent.includes(
        'Choose a meeting template to enable recurrence.',
      ),
    }
  })
}

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
    await page.setViewportSize({ width, height: 1100 })
    await page.goto(`file://${htmlPath}`)
    await page.waitForSelector('#create-meeting-repeat')
    // Let webfonts settle so text metrics match the real app.
    await page.evaluate(() =>
      Promise.race([
        document.fonts.ready,
        new Promise((resolve) => setTimeout(resolve, 4000)),
      ]),
    )

    const entry = {
      viewport: width,
      default: null,
      templateNonRepeat: null,
      weekly: null,
      daily: null,
      monthly: null,
      weeklyInvalid: null,
      templateRemoved: null,
    }

    /* ── State A: default (no Template selected) ── */
    entry.default = await measureDefaultState(page)
    const d = entry.default
    const modalClip = {
      x: Math.max(0, d.modal.left - 4),
      y: Math.max(0, d.modal.top - 4),
      width: d.modal.width + 8,
      height: d.modal.height + 8,
    }
    await page.screenshot({
      path: path.join(OUT, `create-meeting-default-${width}.png`),
      clip: modalClip,
    })

    console.log(`== Viewport ${width}px — default state ==`)
    if (DESKTOP.includes(width)) {
      check(
        `modal width is exactly 560px`,
        Math.round(d.modal.width) === 560,
        `width=${Math.round(d.modal.width)}px`,
      )
    } else {
      check(
        `modal width is 100vw - 32px (${width - 32}px)`,
        Math.round(d.modal.width) === width - 32,
        `width=${Math.round(d.modal.width)}px`,
      )
    }

    const order = d.order
    const orderNames = Object.keys(order)
    const ordered = orderNames.every(
      (name, i) =>
        i === 0 || order[name] > order[orderNames[i - 1]],
    )
    check(
      'field order Title → Context → Meeting template → Schedule → Repeat → Participants',
      ordered,
      JSON.stringify(
        Object.fromEntries(
          orderNames.map((n) => [n, Math.round(order[n])]),
        ),
      ),
    )

    const gap = d.time.left - (d.date.left + d.date.width)
    if (DESKTOP.includes(width)) {
      check(
        'Date | Time row: Time column 120-128px',
        d.time.width >= 120 && d.time.width <= 128,
        `time=${Math.round(d.time.width)}px`,
      )
      check(
        'Date | Time row: 10-12px gap',
        gap >= 10 && gap <= 12,
        `gap=${Math.round(gap)}px`,
      )
      check(
        'Date | Time row: two computed tracks (flex / 128px)',
        /[\d.]+px\s+128px$/.test(d.gridColumns ?? ''),
        d.gridColumns,
      )
    } else {
      check(
        'Date | Time row: stacked single column',
        /^\s*[\d.]+px\s*$/.test(d.gridColumns ?? ''),
        d.gridColumns,
      )
    }

    check(
      'Time zone line reads "Time zone: <IANA>"',
      typeof d.timezoneLine === 'string' &&
        d.timezoneLine.startsWith('Time zone: ') &&
        d.timezoneLine.length > 'Time zone: '.length,
      d.timezoneLine,
    )
    check(
      'Context offers "Research group" (no "Research group meeting")',
      d.contextOptions[0] === 'Research group' &&
        !d.contextOptions.some((o) => /no project/i.test(o)),
      JSON.stringify(d.contextOptions),
    )
    check(
      'Repeat is visible, defaults to "Does not repeat", disabled without a Template',
      d.repeat.value === 'none' && d.repeat.disabled,
      `value=${d.repeat.value} disabled=${d.repeat.disabled}`,
    )
    check('gating helper shown without a Template', d.gatingHelper)
    check(
      'footer: right-aligned Cancel + Create meeting',
      d.footerButtons.length === 2 &&
        d.footerButtons[0].text === 'Cancel' &&
        d.footerButtons[1].text.includes('Create meeting'),
      JSON.stringify(d.footerButtons.map((b) => b.text)),
    )
    const [cancel, submit] = d.footerButtons
    if (cancel && submit) {
      check(
        'footer: button height 36px',
        Math.round(cancel.height) === 36 &&
          Math.round(submit.height) === 36,
        `cancel=${Math.round(cancel.height)}px submit=${Math.round(submit.height)}px`,
      )
      check(
        'footer: 8px gap',
        Math.round(submit.left - cancel.right) === 8,
        `gap=${Math.round(submit.left - cancel.right)}px`,
      )
      const footerEl = d.footerButtons[1]
      check(
        'footer: right-aligned (submit near modal right edge)',
        Math.round(d.modal.right - footerEl.right) <= 48 + 2,
        `margin=${Math.round(d.modal.right - footerEl.right)}px`,
      )
    }

    /* ── State B: Template selected + Does not repeat ── */
    await page.selectOption('#create-meeting-template', '7')
    await page.fill('input[placeholder="Weekly Sync"]', 'Team Rituals')
    entry.templateNonRepeat = await measureRepeatState(page)
    const tnr = entry.templateNonRepeat
    await page.screenshot({
      path: path.join(
        OUT,
        `create-meeting-template-nonrepeat-${width}.png`,
      ),
      clip: modalClip,
    })

    console.log(
      `== Viewport ${width}px — template + does-not-repeat state ==`,
    )
    check(
      'Repeat enabled with a Template, still Does not repeat',
      tnr.repeatDisabled === false && tnr.repeatValue === 'none',
      `value=${tnr.repeatValue} disabled=${tnr.repeatDisabled}`,
    )
    check(
      'no recurrence details, no summary, one-time primary action',
      tnr.hasInterval === false &&
        tnr.weekdayCount === 0 &&
        tnr.endModeRadioCount === 0 &&
        tnr.summaryText === null &&
        tnr.submitText?.includes('Create meeting') === true,
      JSON.stringify({
        summary: tnr.summaryText,
        submit: tnr.submitText,
      }),
    )
    check(
      'one-time submit enabled (title/date/time valid, no recurrence)',
      tnr.submitDisabled === false,
    )
    check(
      'template helper shown with a Template selected',
      tnr.templateHelper,
    )

    /* ── State C: Template + Repeat = Weekly ── */
    await page.selectOption('#create-meeting-repeat', 'weekly')
    await page.waitForSelector('button[aria-label="Monday"]')
    await page.evaluate(() =>
      document
        .querySelector('button[aria-label="Monday"]')
        ?.scrollIntoView({ block: 'nearest' }),
    )
    entry.weekly = await measureWeeklyState(page)
    const w = entry.weekly
    await page.screenshot({
      path: path.join(OUT, `create-meeting-weekly-${width}.png`),
      clip: modalClip,
    })

    console.log(`== Viewport ${width}px — weekly state ==`)
    check(
      'weekday buttons: Mon-Sun (7) rendered, height >= 36px',
      w.weekdayButtonCount === 7 &&
        w.weekdayButtons.every((b) => b.height >= 36),
      w.weekdayButtons
        .map((b) => `${Math.round(b.height)}px`)
        .join('/'),
    )
    if (DESKTOP.includes(width)) {
      check(
        'weekday row: compact 7 tracks filling the width',
        (w.weekdayGridColumns ?? '').split(' ').length === 7,
        w.weekdayGridColumns,
      )
    }
    check(
      'no left-border timeline treatment on the details',
      w.hasLeftBorder === false,
    )
    if (w.detailsIndent != null) {
      check(
        'details indentation 12-16px',
        w.detailsIndent >= 12 && w.detailsIndent <= 16,
        `indent=${Math.round(w.detailsIndent)}px`,
      )
    }
    if (w.everyBottom != null && w.onTop != null) {
      const rowGap = w.onTop - w.everyBottom
      check(
        'details row gap 10-12px',
        rowGap >= 10 && rowGap <= 12,
        `gap=${Math.round(rowGap)}px`,
      )
    }
    check(
      'valid weekly summary rendered (secondary copy, no placeholder)',
      typeof w.summaryText === 'string' &&
        /^Every (week|\d+ weeks) on .+ at .+ · no end$/.test(w.summaryText) &&
        // Secondary presentation: the summary renders at the 12px
        // (text-xs) secondary size, not the 14px primary body copy.
        w.summaryFontSizePx === 12,
      `${w.summaryText} (font ${w.summaryFontSizePx}px)`,
    )
    const hasPlaceholder = await page.evaluate(() =>
      document
        .querySelector('[role="dialog"]')
        ?.textContent.includes(
          'Complete the recurrence details to see the schedule summary.',
        ) ?? false,
    )
    check('no invalid-state summary placeholder present', !hasPlaceholder)
    check(
      'primary action renames to Create series',
      w.submitText?.includes('Create series') === true,
      w.submitText,
    )
    check(
      'template helper shown with a Template selected',
      w.templateHelper,
    )

    /* ── State D: Template + Repeat = Daily ── */
    await page.selectOption('#create-meeting-repeat', 'daily')
    entry.daily = await measureRepeatState(page)
    const dd = entry.daily
    await page.screenshot({
      path: path.join(OUT, `create-meeting-daily-${width}.png`),
      clip: modalClip,
    })

    console.log(`== Viewport ${width}px — daily state ==`)
    check(
      'Daily: interval + Ends render, no weekday row',
      dd.hasInterval === true &&
        dd.weekdayCount === 0 &&
        dd.endModeRadioCount === 3,
      JSON.stringify({
        interval: dd.hasInterval,
        weekdays: dd.weekdayCount,
      }),
    )
    check(
      'Daily: valid summary, Create series enabled',
      typeof dd.summaryText === 'string' &&
        /^Every (day|\d+ days) at .+ · no end$/.test(dd.summaryText) &&
        dd.submitText?.includes('Create series') === true &&
        dd.submitDisabled === false,
      dd.summaryText,
    )

    /* ── State E: Template + Repeat = Monthly ── */
    await page.selectOption('#create-meeting-repeat', 'monthly')
    entry.monthly = await measureRepeatState(page)
    const mo = entry.monthly
    await page.screenshot({
      path: path.join(OUT, `create-meeting-monthly-${width}.png`),
      clip: modalClip,
    })

    console.log(`== Viewport ${width}px — monthly state ==`)
    check(
      'Monthly: interval + Ends render, no weekday row',
      mo.hasInterval === true && mo.weekdayCount === 0,
      JSON.stringify({
        interval: mo.hasInterval,
        weekdays: mo.weekdayCount,
      }),
    )
    check(
      'Monthly: same-day-of-month rule in the summary (no day control)',
      typeof mo.summaryText === 'string' &&
        /^Every (month|\d+ months) on day \d+ at .+ · no end$/.test(
          mo.summaryText,
        ),
      mo.summaryText,
    )

    /* ── State F: manually invalid Weekly (every weekday deselected) ── */
    await page.selectOption('#create-meeting-repeat', 'weekly')
    const deselected = await page.evaluate(() => {
      const group = document
        .getElementById('create-meeting-recurrence-weekdays-label')
        ?.parentElement?.querySelector('[role="group"]')
      if (!group) {
        return 0
      }
      const pressed = Array.from(
        group.querySelectorAll('button[aria-pressed="true"]'),
      )
      pressed.forEach((button) => button.click())
      return pressed.length
    })
    entry.weeklyInvalid = await measureRepeatState(page)
    const inv = entry.weeklyInvalid
    await page.screenshot({
      path: path.join(OUT, `create-meeting-weekly-invalid-${width}.png`),
      clip: modalClip,
    })

    console.log(`== Viewport ${width}px — weekly-invalid state ==`)
    check(
      'the auto-selected weekday(s) were deselected',
      deselected >= 1,
      `deselected=${deselected}`,
    )
    check(
      'field error "Select at least one weekday." is the presentation',
      inv.alertText === 'Select at least one weekday.',
      inv.alertText,
    )
    check(
      'no summary while the recurrence is invalid',
      inv.summaryText === null,
      inv.summaryText,
    )
    check(
      'Create series disabled while the recurrence is invalid',
      inv.submitDisabled === true &&
        inv.submitText?.includes('Create series') === true,
      `disabled=${inv.submitDisabled}`,
    )

    /* ── State G: Template removed after configuring a recurrence ── */
    await page.evaluate(() => {
      document
        .getElementById('create-meeting-recurrence-weekdays-label')
        ?.parentElement?.querySelector('button[aria-label="Monday"]')
        ?.click()
    })
    await page.fill('#create-meeting-recurrence-interval', '2')
    await page.click('#create-meeting-recurrence-end-mode-date')
    await page.fill('[aria-label="End date"]', '2026-11-30')
    await page.selectOption('#create-meeting-template', '')
    entry.templateRemoved = await measureRepeatState(page)
    const rm = entry.templateRemoved
    await page.screenshot({
      path: path.join(OUT, `create-meeting-template-removed-${width}.png`),
      clip: modalClip,
    })

    console.log(`== Viewport ${width}px — template-removed state ==`)
    check(
      'Repeat back to Does not repeat and disabled (canonical reset)',
      rm.repeatValue === 'none' && rm.repeatDisabled === true,
      `value=${rm.repeatValue} disabled=${rm.repeatDisabled}`,
    )
    check(
      'gating helper re-shown, template helper gone',
      rm.gatingHelper === true && rm.templateHelper === false,
    )
    check(
      'no recurrence details or summary survive the removal',
      rm.hasInterval === false &&
        rm.weekdayCount === 0 &&
        rm.endModeRadioCount === 0 &&
        rm.summaryText === null,
    )
    check(
      'one-time primary action restored and enabled',
      rm.submitText?.includes('Create meeting') === true &&
        rm.submitDisabled === false,
      `submit=${rm.submitText}`,
    )
    measurements.push(entry)
  }
} catch (error) {
  if (!launchFailed) {
    throw error
  }
  // Launch failure: the clean ENVIRONMENT/HARNESS message above is the
  // report; no raw stack needed.
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
  // open `.artifacts/create-meeting-form-visual/harness.html` and resize
  // the window — the layout tracks the viewport.
  cpSync(cssPath, path.join(OUT, 'production.css'))
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
