#!/usr/bin/env node
/**
 * Focused visual gate: Project workspace entry continuity, including
 * the Work Items header band surface.
 *
 * Drives the REAL authenticated app (dev server + live API) with
 * Playwright's Chromium and verifies, for BOTH Project entry paths
 * (Sidebar Quick Access row and the scoped Projects list row):
 *
 *   - the navigation commits through document.startViewTransition;
 *   - the Work Items header band (the band with "Work Items", item
 *     count, subtitle, New work item, Board / List) is present with
 *     a stable, approved surface from the first destination frame
 *     until the board content is ready - never blank, never a
 *     foreign/legacy-white surface;
 *   - in a Dark pass: html[data-theme] stays 'dark' for every frame
 *     and no light/white Work Items-header frame is observed
 *     (the white-flash regression this gate exists for);
 *   - in a Light pass: no loading-phase frame exposes more pure
 *     white than the final loaded destination frame itself
 *     (no white beyond the destination's own surfaces);
 *   - the Sidebar chrome stays stationary;
 *   - mouse and keyboard list-row activation behave identically;
 *   - rapid switching between Projects settles cleanly;
 *   - final state: the loaded Work Items board is present.
 *
 * Per destination frame the script records:
 *   - html[data-theme]
 *   - computed backgroundColor of the Work Items header band
 *   - computed backgroundColor of the document (content canvas)
 *
 * Run from the repository root in a browser-capable environment:
 *
 *   node scripts/visual/project-entry-check.mjs --url <dev server>
 *   node scripts/visual/project-entry-check.mjs --url "http://localhost:5173"
 *
 * Outputs (`.artifacts/project-entry-visual/`):
 *   - results.json  per-step frame statistics + verdicts
 *   - PNG frames for visual review (before / loading / skeleton / after)
 *
 * Exit code 0 = all acceptance checks pass; 1 = at least one failed.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
)
const OUT = path.join(ROOT, '.artifacts', 'project-entry-visual')

const VIEWPORT = { width: 1440, height: 900 }
const SIDEBAR_WIDTH = 240
const TOPBAR_HEIGHT = 64
const CONTENT_CLIP = {
  x: SIDEBAR_WIDTH,
  y: TOPBAR_HEIGHT,
  w: VIEWPORT.width - SIDEBAR_WIDTH,
  h: VIEWPORT.height - TOPBAR_HEIGHT,
}
const SIDEBAR_CLIP = { x: 0, y: 0, w: SIDEBAR_WIDTH, h: VIEWPORT.height }

const USERNAME = 'alex'
const PASSWORD = 'DevPass1!'
const FRAME_COUNT = 10

// A loading-phase frame in Light may not expose more pure white
// than the final loaded destination frame itself: the loaded
// workspace legitimately contains white (approved) surfaces; the
// flash regression is white that does NOT belong to the
// destination.
const LIGHT_WHITE_TOLERANCE = 0.02
// Dark: any light Work Items header background is a flash. Dark
// band #1b1d20 has all channels < 128; any Light-theme value
// (#ffffff etc.) does not.
const DARK_HEADER_CHANNEL_LIMIT = 128
// Dark: significant light exposure anywhere in the content region.
const DARK_LIGHT_LIMIT = 0.02

const args = process.argv.slice(2)
function argValue(flag, fallback = null) {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : fallback
}
const explicitUrl = argValue('--url')

let failures = 0
const results = []

function check(label, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL'
  if (!ok) failures += 1
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`)
  return ok
}

/* ── Dev server ────────────────────────────────────────────────── */

async function fetchOk(url) {
  try {
    const res = await fetch(url)
    return res.status < 500
  } catch {
    return false
  }
}

async function ensureDevServer() {
  if (!explicitUrl) {
    console.error('pass --url <running dev server> (app under test)')
    process.exit(1)
  }
  if (!(await fetchOk(explicitUrl))) {
    console.error(`dev server not reachable at ${explicitUrl}`)
    process.exit(1)
  }
  return explicitUrl
}

/* ── In-page measurement helpers ───────────────────────────────── */

const PAGE_HELPERS = `
  window.__vt = { events: [], pending: 0 }
  const __origVt = document.startViewTransition
    ? document.startViewTransition.bind(document)
    : null
  if (__origVt) {
    document.startViewTransition = (cb) => {
      const t = __origVt(cb)
      const rec = { start: performance.now() }
      window.__vt.events.push(rec)
      window.__vt.pending += 1
      t.finished.then(() => {
        rec.end = performance.now()
        window.__vt.pending -= 1
      })
      return t
    }
  }

  window.__loadImage = (dataUrl) =>
    new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = reject
      img.src = dataUrl
    })

  window.__regionStats = async (dataUrl, x, y, w, h) => {
    const img = await window.__loadImage(dataUrl)
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, x, y, w, h, 0, 0, w, h)
    const d = ctx.getImageData(0, 0, w, h).data
    let pureWhite = 0
    let light = 0
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2]
      if (r === 255 && g === 255 && b === 255) pureWhite += 1
      if (Math.max(r, g, b) >= 235) light += 1
    }
    const total = w * h
    return { pureWhite: pureWhite / total, light: light / total }
  }

  window.__regionDiff = async (aUrl, bUrl, x, y, w, h) => {
    const a = await window.__loadImage(aUrl)
    const b = await window.__loadImage(bUrl)
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(a, x, y, w, h, 0, 0, w, h)
    const ad = ctx.getImageData(0, 0, w, h).data
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(b, x, y, w, h, 0, 0, w, h)
    const bd = ctx.getImageData(0, 0, w, h).data
    let diff = 0
    for (let i = 0; i < ad.length; i += 4) {
      if (
        Math.abs(ad[i] - bd[i]) > 4 ||
        Math.abs(ad[i + 1] - bd[i + 1]) > 4 ||
        Math.abs(ad[i + 2] - bd[i + 2]) > 4
      ) diff += 1
    }
    return diff
  }

  // Phase marker for the frame captured right after this call:
  // 'source'  = old page still,
  // 'loading' = destination in flight (loading shell or the panel
  //             loading frame),
  // 'loaded'  = destination board/empty state committed.
  window.__phase = () => {
    const onProject = /\\/projects\\/\\d+\\/.test(location.pathname)
    if (!onProject) return 'source'
    const boardReady =
      document.querySelector('[data-board-column]') !== null ||
      [...document.querySelectorAll('h2, p')].some(
        (el) => el.textContent.trim() === 'No work items yet.',
      )
    return boardReady ? 'loaded' : 'loading'
  }

  // Per-frame environment probe: theme, the Work Items header
  // band's computed background, and the content canvas background.
  // The band is resolved as the first non-transparent ancestor of
  // the "Work Items" heading (its own bg-work-items-header fill).
  window.__frameInfo = () => {
    const theme = document.documentElement.dataset.theme || null
    let headerBg = null
    const h2 = [...document.querySelectorAll('h2')].find(
      (h) => h.textContent.trim() === 'Work Items',
    )
    if (h2) {
      let el = h2
      while (el && el !== document.body) {
        const bg = getComputedStyle(el).backgroundColor
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
          headerBg = bg
          break
        }
        el = el.parentElement
      }
    }
    const canvasBg = getComputedStyle(document.body).backgroundColor
    return { theme, headerBg, canvasBg }
  }
`

/* ── Screenshot helpers ────────────────────────────────────────── */

async function shot(page) {
  return (
    await page.screenshot({
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height },
    })
  ).toString('base64')
}

function dataUrl(b64) {
  return `data:image/png;base64,${b64}`
}

async function saveFrame(page, name, b64) {
  writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(b64, 'base64'))
}

/* ── Frame verdicts ────────────────────────────────────────────── */

function parseRgb(rgbString) {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(rgbString ?? '')
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function isDarkColor(rgbString) {
  const rgb = parseRgb(rgbString)
  if (!rgb) return null
  return rgb.every((channel) => channel < DARK_HEADER_CHANNEL_LIMIT)
}

/**
 * Verdicts for a batch of destination frames (loading + loaded).
 * `afterStats` are the pixel stats of the final loaded frame, used
 * as the Light-theme white reference (the destination's own
 * surfaces).
 */
function checkFrameBatch(page, passName, label, frames, afterStats) {
  const isDark = passName.startsWith('dark')

  let themeViolation = null
  let lightHeader = null
  let blankHeader = null
  let whiteExcess = null
  let worstLight = 0

  for (const f of frames) {
    if (f.phase === 'source') continue

    if (isDark) {
      if (f.info.theme !== 'dark' && themeViolation == null) {
        themeViolation = { i: f.i, theme: f.info.theme }
      }
      if (f.info.headerBg == null && blankHeader == null) {
        blankHeader = { i: f.i, phase: f.phase }
      } else if (
        f.info.headerBg != null &&
        isDarkColor(f.info.headerBg) === false &&
        lightHeader == null
      ) {
        lightHeader = { i: f.i, phase: f.phase, headerBg: f.info.headerBg }
      }
      worstLight = Math.max(worstLight, f.stats.light)
    } else {
      // Light: no loading-phase frame may exceed the destination's
      // own white footprint.
      if (
        f.phase === 'loading' &&
        f.stats.pureWhite > afterStats.pureWhite + LIGHT_WHITE_TOLERANCE &&
        whiteExcess == null
      ) {
        whiteExcess = {
          i: f.i,
          pureWhite: f.stats.pureWhite,
          after: afterStats.pureWhite,
        }
      }
    }
  }

  if (isDark) {
    check(
      `${label}: Dark theme stays dark for the whole navigation`,
      themeViolation == null,
      themeViolation
        ? `frame ${themeViolation.i}: theme=${themeViolation.theme}`
        : 'theme=dark on all destination frames',
    )
    check(
      `${label}: no light/white Work Items header frame in Dark`,
      lightHeader == null,
      lightHeader
        ? `frame ${lightHeader.i} (${lightHeader.phase}): headerBg=${lightHeader.headerBg}`
        : 'header band dark on all frames where present',
    )
    check(
      `${label}: Work Items header band never blank once the destination is up`,
      blankHeader == null,
      blankHeader
        ? `frame ${blankHeader.i} (${blankHeader.phase}): no header surface`
        : 'header band present on all destination frames',
    )
    check(
      `${label}: no light exposure in the content region (Dark)`,
      worstLight < DARK_LIGHT_LIMIT,
      `worstLight=${worstLight.toFixed(3)} (limit ${DARK_LIGHT_LIMIT})`,
    )
  } else {
    check(
      `${label}: no white beyond the destination's own surfaces (Light)`,
      whiteExcess == null,
      whiteExcess
        ? `frame ${whiteExcess.i}: pureWhite=${whiteExcess.pureWhite.toFixed(3)} > loaded ${whiteExcess.after.toFixed(3)} + ${LIGHT_WHITE_TOLERANCE}`
        : `loaded.pureWhite=${afterStats.pureWhite.toFixed(3)}`,
    )
  }
}

/* ── Navigation drivers ────────────────────────────────────────── */

async function clickQuickAccessRow(page, index = 0) {
  const row = page
    .locator('nav[aria-label="Quick access"] button')
    .nth(index)
  if ((await row.count()) === 0) return false
  const name = (await row.textContent() ?? '').trim()
  await row.click()
  return name
}

async function ensureGroupExpanded(page) {
  const chevron = page.locator(
    'nav[aria-label="Research groups"] button[aria-expanded]',
  )
  const count = await chevron.count()
  if (count === 0) return false
  if ((await chevron.first().getAttribute('aria-expanded')) !== 'true') {
    await chevron.first().click()
  }
  return true
}

async function gotoScopedProjects(page) {
  const ok = await ensureGroupExpanded(page)
  if (!ok) return false
  await page
    .locator('nav[aria-label="Research groups"]')
    .getByRole('link', { name: 'Projects', exact: true })
    .click()
  await page.waitForURL(/\/projects\?group=/, { timeout: 10000 })
  return true
}

async function firstProjectRow(page) {
  const row = page
    .locator('main article[role="link"]')
    .first()
  await row.waitFor({ timeout: 10000 })
  return row
}

async function waitForProjectLoaded(page, timeoutMs = 15000) {
  try {
    await page
      .locator('[data-board-column]')
      .first()
      .waitFor({ timeout: timeoutMs })
    return true
  } catch {
    // A Project without work items renders the canonical empty
    // state instead of board columns.
  }
  try {
    await page
      .getByText('No work items yet.')
      .first()
      .waitFor({ timeout: 3000 })
    return true
  } catch {
    return false
  }
}

/* ── Frame sampling ────────────────────────────────────────────── */

async function sampleFrames(page, count) {
  const frames = []
  for (let i = 0; i < count; i += 1) {
    const [phase, info] = await page.evaluate(() => [
      window.__phase(),
      window.__frameInfo(),
    ])
    const shotB64 = await shot(page)
    const stats = await page.evaluate(
      ([u, c]) => window.__regionStats(u, c.x, c.y, c.w, c.h),
      [dataUrl(shotB64), CONTENT_CLIP],
    )
    frames.push({ i: i, phase, info, stats, shot: shotB64 })
  }
  return frames
}

/* ── Entry capture ─────────────────────────────────────────────── */

/**
 * Perform one Project entry navigation and measure every frame of
 * the loading phase for the white-flash signature.
 */
async function captureEntry(page, passName, stepName, act, {
  expectVt = true,
}) {
  const label = `${passName}/${stepName}`
  const data = { pass: passName, step: stepName, urlBefore: page.url() }

  const before = await shot(page)
  const beforeStats = await page.evaluate(
    ([u, c]) => window.__regionStats(u, c.x, c.y, c.w, c.h),
    [dataUrl(before), CONTENT_CLIP],
  )
  data.beforeStats = beforeStats

  await page.evaluate(() => {
    window.__vt.events.length = 0
    window.__vt.pending = 0
  })

  await act(page)

  // Sample frames as fast as possible through the transition window.
  const frames = await sampleFrames(page, FRAME_COUNT)

  // Dedicated loading-shell frame (slow network: the shell is up).
  let shellShot = null
  let shellOk = null
  try {
    await page
      .locator('[role="status"][aria-label="Loading project"]')
      .waitFor({ timeout: 12000, state: 'visible' })
    shellShot = await shot(page)
    shellOk = await page.evaluate(() => {
      const shell = document.querySelector(
        '[role="status"][aria-label="Loading project"]',
      )
      if (!shell) return { present: false }
      const groups = shell.querySelectorAll('[role="group"]').length
      const nav = shell.querySelector(
        'nav[aria-label="Loading project sections"]',
      )
      const region = shell.querySelector(
        'section[aria-label="Loading project work items"]',
      )
      const spinners = shell.querySelectorAll(
        '[role="progressbar"], .animate-spin',
      ).length
      return { present: true, groups, nav: !!nav, region: !!region, spinners }
    })
  } catch {
    shellOk = { present: false, note: 'loading shell not visible in window' }
  }

  const loaded = await waitForProjectLoaded(page)
  await page.waitForFunction(() => window.__vt.pending === 0, null, {
    timeout: 5000,
  }).catch(() => {})
  const after = await shot(page)
  data.urlAfter = page.url()
  const afterInfo = await page.evaluate(() => window.__frameInfo())
  const afterStats = await page.evaluate(
    ([u, c]) => window.__regionStats(u, c.x, c.y, c.w, c.h),
    [dataUrl(after), CONTENT_CLIP],
  )
  data.afterInfo = afterInfo
  data.afterStats = afterStats

  const vt = await page.evaluate(() => window.__vt)
  data.vt = {
    calls: vt.events.length,
    durationsMs: vt.events.map((e) =>
      e.end != null ? Math.round(e.end - e.start) : null,
    ),
    pending: vt.pending,
  }

  // Representative frames for review.
  await saveFrame(page, `${passName}-${stepName}-before`, before)
  const firstLoading = frames.find((f) => f.phase === 'loading')
  if (firstLoading) {
    await saveFrame(
      page,
      `${passName}-${stepName}-loading-${firstLoading.i}`,
      firstLoading.shot,
    )
  }
  if (shellShot) await saveFrame(page, `${passName}-${stepName}-skeleton`, shellShot)
  await saveFrame(page, `${passName}-${stepName}-after`, after)

  console.log(`\n${label}: ${data.urlBefore} → ${data.urlAfter}`)

  if (expectVt) {
    check(
      `${label}: route committed through startViewTransition`,
      data.vt.calls >= 1 && data.vt.pending === 0,
      `calls=${data.vt.calls} durations=${JSON.stringify(data.vt.durationsMs)} pending=${data.vt.pending}`,
    )
  }

  checkFrameBatch(page, passName, label, frames, afterStats)

  const sidebarDiff = await page.evaluate(
    ([a, b, c]) => window.__regionDiff(a, b, c.x, c.y, c.w, c.h),
    [dataUrl(before), dataUrl(after), SIDEBAR_CLIP],
  )
  check(
    `${label}: chrome (Sidebar) stays stationary`,
    sidebarDiff / (SIDEBAR_CLIP.w * SIDEBAR_CLIP.h) <= 0.02,
    `diffFrac=${(sidebarDiff / (SIDEBAR_CLIP.w * SIDEBAR_CLIP.h)).toFixed(4)}`,
  )

  check(`${label}: loaded Work Items board present`, loaded)

  if (shellOk && shellOk.present) {
    data.shell = shellOk
    check(
      `${label}: loading shell is semantic (nav + region + 4 column groups)`,
      shellOk.nav && shellOk.region && shellOk.groups === 4,
      JSON.stringify(shellOk),
    )
    check(
      `${label}: loading shell has no spinner / progressbar`,
      shellOk.spinners === 0,
      `spinners=${shellOk.spinners}`,
    )
    if (shellShot) {
      const shellStats = await page.evaluate(
        ([u, c]) => window.__regionStats(u, c.x, c.y, c.w, c.h),
        [dataUrl(shellShot), CONTENT_CLIP],
      )
      data.shellStats = shellStats
      const isDark = passName.startsWith('dark')
      check(
        `${label}: loading shell carries the destination's own surfaces`,
        isDark
          ? shellStats.light < DARK_LIGHT_LIMIT
          : shellStats.pureWhite <= afterStats.pureWhite + LIGHT_WHITE_TOLERANCE,
        isDark
          ? `light=${shellStats.light.toFixed(3)} (limit ${DARK_LIGHT_LIMIT})`
          : `pureWhite=${shellStats.pureWhite.toFixed(3)} vs loaded ${afterStats.pureWhite.toFixed(3)}`,
      )
    }
  } else if (!passName.startsWith('dark')) {
    // On a fast network the shell may never be captured - that is
    // expected; note it, do not fail.
    data.shellNote = 'loading shell not captured (fast resolve)'
  }

  results.push(data)
  return data
}

/* ── Rapid switching ───────────────────────────────────────────── */

async function rapidSwitchingCheck(page, passName) {
  console.log(`\n${passName}/rapid: switching between Projects`)

  const qaRows = page.locator('nav[aria-label="Quick access"] button')
  if ((await qaRows.count()) < 2) {
    console.log('  [SKIP] fewer than 2 Quick Access rows; cannot switch between distinct Projects')
    results.push({ pass: passName, step: 'rapid', skipped: 'no-qa-data' })
    return
  }

  // Land on Project A first (setup, not measured).
  await gotoHome(page)
  await clickQuickAccessRow(page, 0)
  if (!(await waitForProjectLoaded(page))) throw new Error('rapid setup: project A did not load')

  const before = await shot(page)
  await page.evaluate(() => {
    window.__vt.events.length = 0
    window.__vt.pending = 0
  })

  // A → B → A at short intervals.
  const targets = [1, 0, 1]
  for (const idx of targets) {
    await qaRows.nth(idx).click()
    await page.waitForTimeout(150)
  }

  // Sample the settle window.
  const frames = await sampleFrames(page, 8)
  const settled = await waitForProjectLoaded(page)
  await page.waitForFunction(() => window.__vt.pending === 0, null, { timeout: 8000 })
  const after = await shot(page)
  const afterStats = await page.evaluate(
    ([u, c]) => window.__regionStats(u, c.x, c.y, c.w, c.h),
    [dataUrl(after), CONTENT_CLIP],
  )

  const mainCount = await page.locator('main').count()
  const pending = await page.evaluate(() => window.__vt.pending)

  check('settles on a loaded Project', settled)
  check('no pending transition left', pending === 0, `pending=${pending}`)
  check('exactly one <main>', mainCount === 1, `mainCount=${mainCount}`)

  checkFrameBatch(page, passName, 'rapid', frames, afterStats)

  await saveFrame(page, `${passName}-rapid-before`, before)
  await saveFrame(page, `${passName}-rapid-after`, after)
  results.push({
    pass: passName,
    step: 'rapid',
    frames: frames.map((f) => ({
      i: f.i,
      phase: f.phase,
      info: f.info,
      stats: f.stats,
    })),
  })
}

/* ── Setup ─────────────────────────────────────────────────────── */

async function gotoHome(page) {
  await page
    .getByRole('link', { name: 'Home', exact: true })
    .first()
    .click()
  await page.waitForURL(/\/$/, { timeout: 10000 })
}

async function login(page, base) {
  await page.goto(`${base}/login`)
  // Stable semantic contracts: the login form's own input ids.
  // (getByLabel('Password') is ambiguous - it also matches the
  // "Show password" toggle button.)
  await page.locator('#login-username').fill(USERNAME)
  await page.locator('#login-password').fill(PASSWORD)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.getByRole('heading', { name: 'Home', level: 1 }).waitFor({ timeout: 15000 })
}

async function setTheme(page, base, theme) {
  await page.goto(`${base}/settings/appearance`)
  await page
    .getByRole('radio', { name: theme === 'dark' ? 'Dark' : 'Light' })
    .click()
  const applied = await page.evaluate(() => document.documentElement.dataset.theme)
  if (applied !== theme) throw new Error(`theme ${theme} not applied (got ${applied})`)
  await page.goto(`${base}/`)
  await page.getByRole('heading', { name: 'Home', level: 1 }).waitFor({ timeout: 15000 })
}

async function backToList(page) {
  await page.goBack()
  await page.waitForURL(/\/projects\?group=/, { timeout: 10000 })
  await page.locator('main article[role="link"]').first().waitFor({ timeout: 10000 })
}

async function main() {
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  const base = await ensureDevServer()
  console.log(`app under test: ${base}`)

  const { chromium } = await import(
    pathToFileURL(path.join(ROOT, 'node_modules', 'playwright', 'index.mjs'))
  )

  const browser = await chromium.launch({ headless: true })

  try {
    for (const pass of [
      { name: 'light', theme: 'light', slow: false, reduced: false },
      { name: 'dark', theme: 'dark', slow: false, reduced: false },
      { name: 'light-slow', theme: 'light', slow: true, reduced: false },
      { name: 'dark-slow', theme: 'dark', slow: true, reduced: false },
      { name: 'light-reduced', theme: 'light', slow: false, reduced: true },
    ]) {
      const ctx = await browser.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        reducedMotion: pass.reduced ? 'reduce' : undefined,
      })
      const page = await ctx.newPage()
      await page.addInitScript(PAGE_HELPERS)

      if (pass.slow) {
        const cdp = await ctx.newCDPSession(page)
        await cdp.send('Network.enable')
        await cdp.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 1500,
          downloadThroughput: 500 * 1024,
          uploadThroughput: 500 * 1024,
        })
      }

      console.log(`\n=== PASS: ${pass.name} ===`)
      await login(page, base)
      await setTheme(page, base, pass.theme)

      // Path A: Home → Quick Access row.
      await captureEntry(page, pass.name, 'qa-to-project', async (p) => {
        const name = await clickQuickAccessRow(p, 0)
        if (!name) throw new Error('no Quick Access rows available (no data)')
        return name
      }, { expectVt: !pass.reduced })

      // Path B: Research Group → scoped Projects list → row.
      await gotoHome(page)
      const listOk = await gotoScopedProjects(page)
      if (!listOk) throw new Error('no Research Group available for scoped Projects list')
      await firstProjectRow(page)

      await captureEntry(page, pass.name, 'list-mouse-to-project', async (p) => {
        await p
          .locator('main article[role="link"]')
          .first()
          .click()
      }, { expectVt: !pass.reduced })

      await backToList(page)
      await captureEntry(page, pass.name, 'list-keyboard-to-project', async (p) => {
        const r = p.locator('main article[role="link"]').first()
        await r.focus()
        await p.keyboard.press('Enter')
      }, { expectVt: !pass.reduced })

      if (!pass.slow && !pass.reduced) {
        await rapidSwitchingCheck(page, pass.name)
      }

      await ctx.close()
    }
  } finally {
    await browser.close()
  }

  writeFileSync(
    path.join(OUT, 'results.json'),
    JSON.stringify(
      {
        viewport: VIEWPORT,
        limits: {
          LIGHT_WHITE_TOLERANCE,
          DARK_HEADER_CHANNEL_LIMIT,
          DARK_LIGHT_LIMIT,
        },
        results,
      },
      null,
      2,
    ),
  )

  console.log(`\n=== SUMMARY: ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} ===`)
  console.log(`artifacts: ${OUT}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
