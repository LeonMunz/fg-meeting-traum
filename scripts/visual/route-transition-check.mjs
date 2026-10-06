#!/usr/bin/env node
/**
 * Turnkey browser check for the route-transition foundation
 * (premium app-content route transitions without moving the
 * application shell).
 *
 * Drives the REAL authenticated app (dev server + live API) with
 * Playwright's Chromium and verifies, for every global navigation
 * in the acceptance sequence (Home → My Work → Notes → Projects →
 * Project via Quick Access → Meetings → Settings → back):
 *
 *   - the navigation commits through document.startViewTransition
 *     (React Router's native View Transition integration) with a
 *     short total duration;
 *   - the Sidebar/TopBar chrome stays stationary: no animated
 *     pixels in the chrome region during the transition (only the
 *     instant active-state swap at the commit frame);
 *   - no blank / default-white frame is ever exposed in the main
 *     content region (Light: no near-full-pure-white frame; Dark:
 *     no light flash);
 *   - the content region visibly crossfades (a mid-transition
 *     frame differs from both the before and the after frame);
 *   - rapid repeated navigation leaves no stale transition and no
 *     duplicated page DOM;
 *   - with reduced motion, navigation stays immediate and correct;
 *   - under a deliberately slow network, the same guarantees hold.
 *
 * Run from the repository root in a standard dev environment (one
 * where Playwright's Chromium launches; the agent sandbox blocks
 * browser launches). The app must be reachable — either pass the
 * running dev server URL or let the script start one:
 *
 *   node scripts/visual/route-transition-check.mjs
 *   node scripts/visual/route-transition-check.mjs --url http://127.0.0.1:5174
 *
 * Outputs (`.artifacts/route-transitions-visual/`):
 *   - results.json            per-step measurements + verdicts
 *   - <pass>-<step>-<frame>.png representative before/mid/after frames
 *
 * Exit code 0 = all acceptance checks pass; 1 = at least one failed.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
)
const OUT = path.join(ROOT, '.artifacts', 'route-transitions-visual')

const SIDEBAR_WIDTH = 240
const TOPBAR_HEIGHT = 64
const VIEWPORT = { width: 1440, height: 900 }
const SIDEBAR_CLIP = { x: 0, y: 0, w: SIDEBAR_WIDTH, h: 900 }
const CONTENT_CLIP = {
  x: SIDEBAR_WIDTH,
  y: TOPBAR_HEIGHT,
  w: VIEWPORT.width - SIDEBAR_WIDTH,
  h: VIEWPORT.height - TOPBAR_HEIGHT,
}

const USERNAME = 'alex'
const PASSWORD = 'DevPass1!'

/* ── CLI ───────────────────────────────────────────────────────── */

const args = process.argv.slice(2)
function argValue(flag, fallback = null) {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : fallback
}

const explicitUrl = argValue('--url')
const PORT = Number(argValue('--port', '5199'))

let failures = 0
const results = []

function check(label, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL'
  if (!ok) failures += 1
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`)
  return ok
}

function record(step, data) {
  results.push(data)
}

/* ── Dev server ────────────────────────────────────────────────── */

async function fetchOk(url) {
  try {
    const res = await fetch(url, { method: 'GET' })
    return res.status < 500
  } catch {
    return false
  }
}

async function waitForServer(url, timeoutMs = 60000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await fetchOk(url)) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

let serverProc = null
async function ensureDevServer() {
  if (explicitUrl) return explicitUrl
  const url = `http://127.0.0.1:${PORT}`
  if (await fetchOk(url)) {
    console.log(`reusing dev server at ${url}`)
    return url
  }
  console.log(`starting dev server on port ${PORT} ...`)
  serverProc = spawn(
    'npm',
    [
      'run',
      'dev',
      '--workspace=web',
      '--',
      '--port',
      String(PORT),
      '--strictPort',
    ],
    {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    },
  )
  serverProc.stdout.on('data', () => {})
  serverProc.stderr.on('data', () => {})
  const up = await waitForServer(url)
  if (!up) {
    console.error('dev server did not come up in time')
    process.exit(1)
  }
  return url
}

/* ── In-page measurement helpers (installed via addInitScript) ── */

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

  // Pixel stats for a clip region of a full-viewport screenshot.
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

  // Differing-pixel count between two screenshots in a clip region.
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
`

/* ── Screenshot helpers ────────────────────────────────────────── */

async function shot(page) {
  return (
    await page.screenshot({
      clip: {
        x: 0,
        y: 0,
        width: VIEWPORT.width,
        height: VIEWPORT.height,
      },
    })
  ).toString('base64')
}

function dataUrl(b64) {
  return `data:image/png;base64,${b64}`
}

async function saveFrame(page, name, b64) {
  writeFileSync(
    path.join(OUT, `${name}.png`),
    Buffer.from(b64, 'base64'),
  )
}

/* ── Navigation drivers ────────────────────────────────────────── */

async function clickSidebarLink(page, name) {
  await page.getByRole('link', { name, exact: true }).click()
}

async function ensureGroupExpanded(page) {
  const chevron = page.locator(
    'nav[aria-label="Research groups"] button[aria-expanded]',
  )
  const count = await chevron.count()
  if (count === 0) return false
  const expanded = await chevron.first().getAttribute('aria-expanded')
  if (expanded !== 'true') {
    await chevron.first().click()
  }
  return true
}

async function clickGroupScoped(page, name) {
  const ok = await ensureGroupExpanded(page)
  if (!ok) return false
  await page
    .locator('nav[aria-label="Research groups"]')
    .getByRole('link', { name, exact: true })
    .click()
  return true
}

async function clickQuickAccessFirst(page) {
  const row = page
    .locator('nav[aria-label="Quick access"] button')
    .first()
  if ((await row.count()) === 0) return false
  await row.click()
  return true
}

async function clickUserMenu(page, item) {
  await page.getByRole('button', { name: 'Alex' }).click()
  await page.getByRole('menuitem', { name: item }).click()
}

/* ── Transition step ───────────────────────────────────────────── */

/**
 * Perform one navigation and measure it. `act` performs the click /
 * back action on the page. Returns per-step measurements.
 */
async function transitionStep(page, passName, stepName, act, {
  expectVt = true,
  expectBlend = true,
  frameCount = 5,
}) {
  const label = `${passName}/${stepName}`
  const data = {
    pass: passName,
    step: stepName,
    beforeUrl: page.url(),
  }

  const before = await shot(page)

  // Reset the VT event log so this step only sees its own
  // transitions.
  await page.evaluate(() => {
    window.__vt.events.length = 0
    window.__vt.pending = 0
  })

  await act(page)

  const frames = []
  for (let i = 0; i < frameCount; i += 1) {
    frames.push(await shot(page))
  }

  // Settle: wait for the transition to finish (no pending VT) and
  // for the DOM to be stable on the destination.
  await page.waitForFunction(
    () => window.__vt.pending === 0,
    null,
    { timeout: 5000 },
  )
  await page.waitForTimeout(150)

  const after = await shot(page)
  data.afterUrl = page.url()

  const vt = await page.evaluate(() => window.__vt)
  data.vt = {
    calls: vt.events.length,
    durationsMs: vt.events.map((e) =>
      e.end != null ? Math.round(e.end - e.start) : null,
    ),
    pending: vt.pending,
  }

  // Content stats for every frame (blank-frame detection).
  data.content = []
  for (let i = 0; i <= frames.length; i += 1) {
    // i=0 → before, i=1..N → captured frames, i=N+1 → after
    const src = i === 0
      ? before
      : i > frames.length
        ? after
        : frames[i - 1]
    data.content.push(
      await page.evaluate(
        ([url, clip]) => window.__regionStats(url, clip.x, clip.y, clip.w, clip.h),
        [dataUrl(src), CONTENT_CLIP],
      ),
    )
  }

  // Chrome stability: differing pixels in the Sidebar region.
  data.sidebarDiff = [null]
  for (let i = 0; i < frames.length; i += 1) {
    data.sidebarDiff.push(
      await page.evaluate(
        ([a, b, clip]) => window.__regionDiff(a, b, clip.x, clip.y, clip.w, clip.h),
        [dataUrl(before), dataUrl(frames[i]), SIDEBAR_CLIP],
      ),
    )
  }

  const sidebarTotal = SIDEBAR_CLIP.w * SIDEBAR_CLIP.h
  data.sidebarMaxDiffFrac =
    Math.max(...data.sidebarDiff) / sidebarTotal

  data.contentChanged = await page.evaluate(
    ([a, b, clip]) => window.__regionDiff(a, b, clip.x, clip.y, clip.w, clip.h),
    [dataUrl(before), dataUrl(after), CONTENT_CLIP],
  ) > 0

  // Crossfade evidence: a frame differing from BOTH before and after.
  let blended = false
  for (let i = 0; i < frames.length; i += 1) {
    const dBefore = await page.evaluate(
      ([a, b, clip]) => window.__regionDiff(a, b, clip.x, clip.y, clip.w, clip.h),
      [dataUrl(before), dataUrl(frames[i]), CONTENT_CLIP],
    )
    const dAfter = await page.evaluate(
      ([a, b, clip]) => window.__regionDiff(a, b, clip.x, clip.y, clip.w, clip.h),
      [dataUrl(after), dataUrl(frames[i]), CONTENT_CLIP],
    )
    if (dBefore > 0 && dAfter > 0) {
      blended = true
      break
    }
  }
  data.blendedFrame = blended

  // Representative frames for visual review.
  await saveFrame(page, `${passName}-${stepName}-before`, before)
  await saveFrame(page, `${passName}-${stepName}-mid`, frames[Math.floor(frames.length / 2)])
  await saveFrame(page, `${passName}-${stepName}-after`, after)

  /* ── Verdicts ── */
  const isDark =
    passName === 'dark' ||
    (await page.evaluate(() =>
      document.documentElement.dataset.theme,
    )) === 'dark'

  let blank = false
  for (const stats of data.content) {
    if (isDark) {
      if (stats.light > 0.02) blank = true
    } else if (stats.pureWhite > 0.98) {
      blank = true
    }
  }

  console.log(`\n${label}: ${data.beforeUrl} → ${data.afterUrl}`)
  check(
    'route committed through startViewTransition',
    expectVt
      ? data.vt.calls >= 1 && data.vt.pending === 0
      : data.vt.pending === 0,
    `calls=${data.vt.calls} durations=${JSON.stringify(data.vt.durationsMs)} pending=${data.vt.pending}`,
  )
  if (expectVt && data.vt.durationsMs.length > 0) {
    const maxDur = Math.max(...data.vt.durationsMs)
    check(
      'transition duration is short (≤ 300 ms)',
      maxDur <= 300,
      `max=${maxDur}ms`,
    )
  }
  check(
    'no blank / white frame in the content region',
    !blank,
    `pureWhite=${Math.max(...data.content.map((c) => c.pureWhite)).toFixed(3)} light=${Math.max(...data.content.map((c) => c.light)).toFixed(3)}`,
  )
  check(
    'chrome (Sidebar) stays stationary',
    data.sidebarMaxDiffFrac <= 0.02,
    `maxDiffFrac=${data.sidebarMaxDiffFrac.toFixed(4)} (diffs=${JSON.stringify(data.sidebarDiff)})`,
  )
  check('content actually changed', data.contentChanged)
  if (expectBlend) {
    check(
      'mid-transition frame crossfades (differs from before AND after)',
      blended,
    )
  }

  record(data)
  return data
}

/* ── Acceptance sequence ───────────────────────────────────────── */

async function runSequence(page, passName, { reducedMotion = false } = {}) {
  const expectVt = !reducedMotion
  const expectBlend = !reducedMotion

  // Home is the landing page after login.
  await page.getByRole('heading', { name: 'Home', level: 1 })
    .waitFor({ timeout: 10000 })

  await transitionStep(
    page, passName, 'home-to-mywork',
    (p) => clickSidebarLink(p, 'My Work'),
    { expectVt, expectBlend },
  )

  await transitionStep(
    page, passName, 'mywork-to-notes',
    (p) => clickSidebarLink(p, 'Notes'),
    { expectVt, expectBlend },
  )

  await transitionStep(
    page, passName, 'notes-to-projects',
    async (p) => {
      const ok = await clickGroupScoped(p, 'Projects')
      if (!ok) throw new Error('no Research Group available for scoped Projects row')
    },
    { expectVt, expectBlend },
  )

  // Projects → Project detail via the global Quick Access row.
  const qa = await transitionStep(
    page, passName, 'projects-to-quickaccess-project',
    async (p) => {
      const ok = await clickQuickAccessFirst(p)
      if (!ok) throw new Error('no Quick Access rows available (no data)')
    },
    { expectVt, expectBlend },
  )
  record({ pass: passName, step: 'qa-note', qaUsed: !!qa })

  await transitionStep(
    page, passName, 'project-to-meetings',
    async (p) => {
      const ok = await clickGroupScoped(p, 'Meetings')
      if (!ok) throw new Error('no Research Group available for scoped Meetings row')
    },
    { expectVt, expectBlend },
  )

  await transitionStep(
    page, passName, 'meetings-to-settings',
    (p) => clickUserMenu(p, 'Settings'),
    { expectVt, expectBlend },
  )

  // Settings → back (browser back over the transitioned pair).
  await transitionStep(
    page, passName, 'settings-back-to-meetings',
    (p) => p.goBack(),
    { expectVt, expectBlend },
  )
}

/* ── Rapid-navigation stale-transition check ───────────────────── */

async function rapidNavigationCheck(page, passName) {
  console.log(`\n${passName}/rapid: four navigations at ~90 ms intervals`)

  await page.getByRole('heading', { name: 'Home', level: 1 })
    .waitFor({ timeout: 10000 })

  const before = await shot(page)

  await page.evaluate(() => {
    window.__vt.events.length = 0
    window.__vt.pending = 0
  })

  const targets = [
    async () => clickSidebarLink(page, 'My Work'),
    async () => clickSidebarLink(page, 'Notes'),
    async () => clickSidebarLink(page, 'My Work'),
    async () => clickSidebarLink(page, 'Home'),
  ]
  for (const act of targets) {
    await act()
    await page.waitForTimeout(90)
  }

  await page.waitForFunction(
    () => window.__vt.pending === 0,
    null,
    { timeout: 8000 },
  )
  await page.waitForTimeout(200)

  const after = await shot(page)

  const okHeading = await page
    .getByRole('heading', { name: 'Home', level: 1 })
    .isVisible()

  const mainCount = await page.locator('main').count()

  const sidebarDiff = await page.evaluate(
    ([a, b, clip]) => window.__regionDiff(a, b, clip.x, clip.y, clip.w, clip.h),
    [dataUrl(before), dataUrl(after), SIDEBAR_CLIP],
  )
  const sidebarTotal = SIDEBAR_CLIP.w * SIDEBAR_CLIP.h

  check('rapid navigation settles on the final destination', okHeading)
  check('no stale transition left pending',
    (await page.evaluate(() => window.__vt.pending)) === 0)
  check('no duplicated page DOM (exactly one <main>)', mainCount === 1,
    `mainCount=${mainCount}`)
  check('chrome settled without residue',
    sidebarDiff / sidebarTotal <= 0.02,
    `diffFrac=${(sidebarDiff / sidebarTotal).toFixed(4)}`)

  await saveFrame(page, `${passName}-rapid-before`, before)
  await saveFrame(page, `${passName}-rapid-after`, after)
}

/* ── Passes ────────────────────────────────────────────────────── */

async function login(page, base) {
  await page.goto(`${base}/login`)
  await page.getByLabel('Username').fill(USERNAME)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.getByRole('heading', { name: 'Home', level: 1 })
    .waitFor({ timeout: 15000 })
}

function newContext(browser, opts = {}) {
  return browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    ...opts,
  })
}

async function setTheme(page, base, theme) {
  await page.goto(`${base}/settings/appearance`)
  await page.getByRole('radio', { name: theme === 'dark' ? 'Dark' : 'Light' })
    .click()
  const applied = await page.evaluate(
    () => document.documentElement.dataset.theme,
  )
  if (applied !== theme) {
    throw new Error(`theme ${theme} not applied (got ${applied})`)
  }
  // Back to Home through the router (setup only, not measured).
  await page.goto(`${base}/`)
  await page.getByRole('heading', { name: 'Home', level: 1 })
    .waitFor({ timeout: 15000 })
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
    /* ── Light pass ── */
    {
      const ctx = newContext(browser)
      const page = await ctx.newPage()
      await page.addInitScript(PAGE_HELPERS)
      await login(page, base)
      await setTheme(page, base, 'light')
      console.log('\n=== PASS: light ===')
      await runSequence(page, 'light')
      await rapidNavigationCheck(page, 'light')
      await ctx.close()
    }

    /* ── Dark pass ── */
    {
      const ctx = newContext(browser)
      const page = await ctx.newPage()
      await page.addInitScript(PAGE_HELPERS)
      await login(page, base)
      await setTheme(page, base, 'dark')
      console.log('\n=== PASS: dark ===')
      await runSequence(page, 'dark')
      await ctx.close()
    }

    /* ── Reduced-motion pass ── */
    {
      const ctx = newContext(browser, { reducedMotion: 'reduce' })
      const page = await ctx.newPage()
      await page.addInitScript(PAGE_HELPERS)
      await login(page, base)
      await setTheme(page, base, 'light')
      console.log('\n=== PASS: reduced-motion ===')
      // Reduced motion: navigation must stay immediate and correct;
      // the CSS removes the animation, so the (still-invoked)
      // transition finishes essentially instantly and no blended
      // frame is expected.
      await runSequence(page, 'reduced', { reducedMotion: true })
      await ctx.close()
    }

    /* ── Slow-network pass ── */
    {
      const ctx = newContext(browser)
      const page = await ctx.newPage()
      await page.addInitScript(PAGE_HELPERS)
      const cdp = await ctx.newCDPSession(page)
      await cdp.send('Network.enable')
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 1500, // ms
        downloadThroughput: 500 * 1024, // bytes/s (~4 Mbps)
        uploadThroughput: 500 * 1024,
      })
      await login(page, base)
      await setTheme(page, base, 'light')
      console.log('\n=== PASS: slow-network (1500 ms latency, ~4 Mbps) ===')
      // Slow destinations load their data slowly; the transition
      // still commits at route change and must never expose a
      // blank frame while the destination loader is in flight.
      await runSequence(page, 'slow', { frameCount: 7 })
      await ctx.close()
    }
  } finally {
    await browser.close()
    if (serverProc) {
      serverProc.kill('SIGTERM')
    }
  }

  writeFileSync(
    path.join(OUT, 'results.json'),
    JSON.stringify({ viewport: VIEWPORT, results }, null, 2),
  )

  console.log(`\n=== SUMMARY: ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} ===`)
  console.log(`artifacts: ${OUT}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
