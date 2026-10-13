#!/usr/bin/env node
/**
 * Turnkey browser visual gate: Meeting Detail workspace theme
 * correctness (Dark + Light), covering the upcoming preparation
 * view, the Live shell, and the completed / cancelled read-only
 * states, with representative editor and dialog surfaces.
 *
 * Renders the REAL `MeetingDetailPage` (full import graph minus
 * the Work Item Inspector, which is stubbed — the theme audit
 * never opens it) against the REAL production CSS (fresh
 * `vite build`) inside a shell that mirrors the AppShell width
 * chain (fixed 240px sidebar + page padding px-6 / lg:px-8).
 * The API boundary is mocked at build time (the page's own
 * `api/*` modules are aliased to deterministic fixtures), so the
 * gate needs no backend, login, or database — it is a
 * component+CSS harness, exactly like the other
 * `scripts/visual/*-check.mjs` gates.
 *
 * For every state (upcoming / live / completed / cancelled) in
 * BOTH themes, at the desktop (1440) and narrow (390) viewports,
 * the gate verifies the COMPUTED styles of the audited surfaces
 * against the canonical token values parsed from
 * `apps/web/src/index.css` (single source of truth):
 *
 *   - page title (h1) foreground
 *   - agenda section card surface + border (upcoming / cancelled)
 *   - Quick Add bar surface + border + participant avatar fill
 *     (upcoming)
 *   - "Start meeting" primary action (fill + foreground) and
 *     "Add user" accent text (upcoming)
 *   - Live focus pane surface + border and "End meeting" danger
 *     foreground (live)
 *   - read-only states expose no preparation controls (no "+ Add
 *     section" / "Start meeting")
 *   - html[data-theme] carries the audited theme
 *
 * Plus, on the upcoming desktop pass (both themes), the
 * representative editor / dialog states:
 *
 *   - the inline section composer (opened via "+ Add section"):
 *     composer surface, input text + placeholder colors, Save /
 *     Cancel control colors;
 *   - the topic Markdown composer (opened by activating the
 *     rendered topic): composer surface + border, textarea text,
 *     Save / Cancel control colors;
 *   - the Delete meeting dialog (opened via "Meeting actions"):
 *     overlay scrim, dialog surface, Cancel / Delete control
 *     colors.
 *
 * A full-page screenshot is captured for every state × theme ×
 * viewport (and for each opened editor / dialog surface), so the
 * result doubles as the visual acceptance evidence for a manual
 * review of both themes side by side.
 *
 * Run from the repository root in a browser-capable environment:
 *
 *   node scripts/visual/meeting-detail-theme-check.mjs
 *
 * Known build noise: the harness build emits `[EMPTY_IMPORT_META]`
 * warnings from `vite/preload-helper.js` (the helper Vite ships for
 * chunk preloading). The IIFE format rewrites `import.meta` to `{}`;
 * the only dynamic import in the audited graph (WorkItemDrawer,
 * aliased to a null stub) is inlined as `Promise.resolve().then(...)`
 * — no chunk is fetched and `import.meta.url` is never read, so the
 * warnings have no runtime consequence for this gate. They are
 * documented rather than suppressed so a future real `import.meta`
 * use in the audited graph stays visible.
 *
 * Outputs (`.artifacts/meeting-detail-theme-visual/`):
 *   - measurements.json     computed styles per state/theme/viewport
 *   - meeting-detail-<state>-<theme>-<viewport>.png
 *   - meeting-detail-<state>-<theme>-<surface>.png  (editor/dialog)
 *   - harness.html          kept openable in any browser
 *
 * Exit code 0 = all assertions pass; 1 = at least one failed (a
 * browser that cannot launch is reported as ENVIRONMENT/HARNESS
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
const OUT = path.join(ROOT, '.artifacts', 'meeting-detail-theme-visual')
const ENTRY = path.join(
  WEB,
  '.meeting-detail-theme-visual-entry.tsx',
)
const VITE_CONFIG = path.join(
  WEB,
  '.meeting-detail-theme-visual.vite.config.mts',
)
const MOCK_MEETINGS = path.join(
  WEB,
  '.meeting-detail-theme-visual-mock-meetings.ts',
)
const MOCK_PROJECTS = path.join(
  WEB,
  '.meeting-detail-theme-visual-mock-projects.ts',
)
const MOCK_WORK_ITEMS = path.join(
  WEB,
  '.meeting-detail-theme-visual-mock-work-items.ts',
)
const MOCK_SESSION = path.join(
  WEB,
  '.meeting-detail-theme-visual-mock-session.ts',
)
const MOCK_GROUP = path.join(
  WEB,
  '.meeting-detail-theme-visual-mock-group.ts',
)
const MOCK_DRAWER = path.join(
  WEB,
  '.meeting-detail-theme-visual-mock-drawer.tsx',
)

const STATES = ['upcoming', 'live', 'completed', 'cancelled']
const THEMES = ['dark', 'light']
const VIEWPORTS = [
  { name: 'desktop', width: 1440 },
  { name: 'narrow', width: 390 },
]

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

/* ── 1. Fresh production build (the tokens live in the CSS) ───── */

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
  console.error('Production build failed — cannot verify theme.')
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

/* ── 2. Canonical token values from the real stylesheet ───────── */

function parseThemeTokens(theme) {
  const css = readFileSync(
    path.join(WEB, 'src', 'index.css'),
    'utf-8',
  )
  const block =
    theme === 'light'
      ? css.match(/@theme\s*{([\s\S]*?)\n}/)?.[1] ?? ''
      : css.match(
          /html\[data-theme='dark'\]\s*{([\s\S]*?)\n}/,
        )?.[1] ?? ''
  const tokens = {}
  for (const match of block.matchAll(
    /--color-([a-z0-9-]+):\s*([^;]+);/g,
  )) {
    tokens[match[1]] = match[2].trim().toLowerCase()
  }
  return tokens
}

const LIGHT_TOKENS = parseThemeTokens('light')
// The Dark layer overrides only the tokens it declares; every
// other functional token inherits the Light (canonical) value.
const DARK_TOKENS = {
  ...LIGHT_TOKENS,
  ...parseThemeTokens('dark'),
}

function hexToRgb(value) {
  // Exactly one leading '#', then exactly six hex digits (either
  // case — the canonical tokens in index.css are uppercase).
  // Anything else (rgb()/rgba() values, alpha-valued 8-digit hex,
  // shorthand) returns null and passes through unchanged.
  const match = value.match(/^#([0-9a-f]{6})$/i)
  if (!match) return null
  const hex = match[1]
  return (
    'rgb(' +
    [0, 2, 4]
      .map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
      .join(', ') +
    ')'
  )
}

// Focused regression checks for the hex → RGB conversion above,
// using canonical CSS token values (as defined in index.css).
for (const [hexValue, expectedRgb] of [
  ['#EDEEF0', 'rgb(237, 238, 240)'],
  ['#212225', 'rgb(33, 34, 37)'],
  ['#FFFFFF', 'rgb(255, 255, 255)'],
  ['#363A3F', 'rgb(54, 58, 63)'],
]) {
  const actualRgb = hexToRgb(hexValue)
  check(
    `hexToRgb(${hexValue}) === ${expectedRgb}`,
    actualRgb === expectedRgb,
    `actual ${actualRgb}`,
  )
}

/* ── 3. Mock API boundary + throwaway bundle ──────────────────── */

const MEETING_TITLE = 'Theme Check Weekly'
const SECTION_NAME = 'Agenda'
const ITEM_TITLE = 'Weekly review'

function localIso(dayOffset, hour, minute) {
  const now = new Date()
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + dayOffset,
    hour,
    minute,
  ).toISOString()
}
function nowIso(minutesAgo) {
  return new Date(
    Date.now() - minutesAgo * 60 * 1000,
  ).toISOString()
}

writeFileSync(
  MOCK_MEETINGS,
  `export interface VisualFixture {
  meeting: Record<string, unknown>
}

const MEETING_TITLE = ${JSON.stringify(MEETING_TITLE)}
const SECTION_NAME = ${JSON.stringify(SECTION_NAME)}
const ITEM_TITLE = ${JSON.stringify(ITEM_TITLE)}
const DAY = ${JSON.stringify(localIso(3, 9, 0))}

const section = {
  id: 21,
  meetingId: 11,
  sourceSeriesSectionId: null,
  name: SECTION_NAME,
  description: '',
  position: 0,
  isVisible: true,
}

const item = {
  id: 31,
  meetingId: 11,
  meetingSectionId: 21,
  title: ITEM_TITLE,
  contextNotes: '',
  content: 'Weekly review topic',
  position: 0,
  outcome: 'not_discussed',
  followUpSchedule: null,
  workItemIds: [],
  notes: [],
  createdById: 2,
  createdAt: DAY,
  updatedAt: DAY,
}

const participant = {
  id: 301,
  user: {
    id: 2,
    username: 'chris',
    firstName: 'Chris',
    lastName: 'Example',
  },
  addedAt: DAY,
}

function meetingFor(state: string) {
  const base = {
    id: 11,
    researchGroupId: 3,
    scope: 'group',
    projectId: null,
    seriesId: null,
    title: MEETING_TITLE,
    scheduledAt: DAY,
    startedAt: null,
    endedAt: null,
    status: 'upcoming',
    currentMeetingItemId: null,
    participantIds: [2],
    actionPermissions: {
      canEdit: true,
      canDelete: true,
      canCancel: false,
    },
    createdById: 2,
    createdAt: DAY,
    updatedAt: DAY,
  }

  switch (state) {
    case 'live':
      return {
        ...base,
        status: 'live',
        startedAt: ${JSON.stringify(nowIso(10))},
        currentMeetingItemId: 31,
      }
    case 'completed':
      return {
        ...base,
        status: 'completed',
        startedAt: ${JSON.stringify(nowIso(90))},
        endedAt: ${JSON.stringify(nowIso(30))},
      }
    case 'cancelled':
      return { ...base, status: 'cancelled' }
    default:
      return base
  }
}

function visualState(): string {
  return (
    new URLSearchParams(
      typeof window !== 'undefined'
        ? window.location.search
        : '',
    ).get('state') ?? 'upcoming'
  )
}

export async function getMeeting(
  meetingId: number,
): Promise<Record<string, unknown>> {
  return meetingFor(visualState())
}

export async function listMeetingParticipants(
  meetingId: number,
) {
  return [participant]
}

export async function listMeetingItems(
  meetingId: number,
) {
  return [item]
}

export async function listMeetingSections(
  meetingId: number,
) {
  return [section]
}

export async function searchMeetingParticipantCandidates(
  meetingId: number,
  query: string,
) {
  return []
}

export async function addMeetingParticipant(
  meetingId: number,
  input: unknown,
) {
  return { ...participant, id: 302 }
}

export async function removeMeetingParticipant(
  meetingId: number,
  participantId: number,
) {
  return null
}

export async function createMeetingSection(
  meetingId: number,
  input: { name: string },
) {
  return { ...section, id: 99, name: input.name }
}

export async function updateMeetingSection(
  meetingId: number,
  sectionId: number,
  input: unknown,
) {
  return { ...section, id: sectionId }
}

export async function reorderMeetingSections(
  meetingId: number,
  sectionIds: number[],
) {
  return sectionIds
}

export async function createMeetingItem(
  meetingId: number,
  input: unknown,
) {
  return { ...item, id: 32 }
}

export async function updateMeetingItem(
  meetingId: number,
  itemId: number,
  input: unknown,
) {
  return { ...item, id: itemId }
}

export async function deleteMeetingItem(
  meetingId: number,
  itemId: number,
) {
  return null
}

export async function createMeetingNote(
  meetingId: number,
  itemId: number,
  input: unknown,
) {
  return {
    id: 1,
    meetingItemId: itemId,
    author: participant.user,
    content: 'note',
    createdAt: DAY,
    updatedAt: DAY,
    linkedWorkItem: null,
  }
}

export async function updateMeetingNote(
  meetingId: number,
  noteId: number,
  input: unknown,
) {
  return {
    id: noteId,
    meetingItemId: 31,
    author: participant.user,
    content: 'note',
    createdAt: DAY,
    updatedAt: DAY,
    linkedWorkItem: null,
  }
}

export async function deleteMeetingNote(
  meetingId: number,
  noteId: number,
) {
  return null
}

export async function startMeeting(meetingId: number) {
  return meetingFor('live')
}

export async function endMeeting(meetingId: number) {
  return meetingFor('completed')
}

export async function reopenMeeting(meetingId: number) {
  return meetingFor('upcoming')
}

export async function deleteMeeting(meetingId: number) {
  return null
}

export async function focusMeetingItem(
  meetingId: number,
  itemId: number,
) {
  return meetingFor('live')
}

export async function markMeetingItemDone(
  meetingId: number,
  itemId: number,
) {
  return { ...item, id: itemId, outcome: 'done' }
}

export async function reopenMeetingItem(
  meetingId: number,
  itemId: number,
) {
  return { ...item, id: itemId }
}

export async function getMeetingItemFollowUpTargets(
  meetingId: number,
  itemId: number,
) {
  return {
    recommendedMeetingId: null,
    meetings: [],
  }
}

export async function scheduleMeetingItemFollowUp(
  meetingId: number,
  itemId: number,
  input: unknown,
) {
  return { ...item, id: itemId }
}

export async function cancelMeetingItemFollowUp(
  meetingId: number,
  itemId: number,
) {
  return {
    sourceItem: { ...item, id: itemId },
    disposition: 'removed',
  }
}

export async function createWorkItemFromMeetingItem(
  meetingId: number,
  itemId: number,
  input: unknown,
) {
  return {
    id: 1,
    title: 'work item',
    projectId: 9,
    projectName: 'Theme Check Project',
    statusName: 'Todo',
    assigneeNames: [],
  }
}
`,
)

writeFileSync(
  MOCK_PROJECTS,
  `export async function getProject(
  projectId: number,
) {
  return null
}

export async function getProjectWorkItemConfiguration(
  projectId: number,
) {
  return null
}

export async function listProjectMemberships(
  projectId: number,
) {
  return []
}

export async function listProjects() {
  return []
}
`,
)

writeFileSync(
  MOCK_WORK_ITEMS,
  `export async function getWorkItem(
  workItemId: number,
) {
  return null
}

export async function listProjectWorkItems(
  projectId: number,
) {
  return []
}

export async function updateWorkItem(
  workItemId: number,
  input: unknown,
) {
  return null
}
`,
)

writeFileSync(
  MOCK_SESSION,
  `export function useSession() {
  return {
    user: {
      id: 2,
      username: 'chris',
      firstName: 'Chris',
      lastName: 'Example',
    },
  }
}
`,
)

writeFileSync(
  MOCK_GROUP,
  `export function useResearchGroup() {
  return {
    groups: [
      { id: 3, name: 'FG Group', role: 'member' },
    ],
    activeResearchGroupId: 3,
    activeResearchGroup: {
      id: 3,
      name: 'FG Group',
      role: 'member',
    },
    loading: false,
    error: null,
    setActiveResearchGroupId: () => {},
    reloadResearchGroups: async () => {},
    addResearchGroup: async () => ({ id: 4 }),
  }
}
`,
)

writeFileSync(
  MOCK_DRAWER,
  `export function WorkItemDrawer(_props: unknown) {
  // The theme audit never opens the Inspector; keep the lazy
  // import graph finite and deterministic.
  return null
}
`,
)

writeFileSync(
  ENTRY,
  `import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router'
import { MeetingDetailPage } from './src/features/meetings/MeetingDetailPage'

const params = new URLSearchParams(window.location.search)
const state = (
  ['upcoming', 'live', 'completed', 'cancelled'] as const
).includes(
  params.get('state') as 'upcoming'
)
  ? (params.get('state') as string)
  : 'upcoming'
const theme =
  params.get('theme') === 'light' ? 'light' : 'dark'

document.documentElement.dataset.theme = theme

createRoot(
  document.getElementById('visual-root') as HTMLElement,
).render(
  <MemoryRouter initialEntries={['/meetings/11']}>
    <Routes>
      <Route
        path="/meetings"
        element={<div>Meetings list marker</div>}
      />
      <Route
        path="/meetings/:meetingId"
        element={<MeetingDetailPage />}
      />
    </Routes>
  </MemoryRouter>,
)
`,
)

const MOCK_MAP = JSON.stringify({
  [path.join(WEB, 'src', 'api', 'meetings.ts')]: MOCK_MEETINGS,
  [path.join(WEB, 'src', 'api', 'projects.ts')]: MOCK_PROJECTS,
  [path.join(WEB, 'src', 'api', 'work-items.ts')]: MOCK_WORK_ITEMS,
  [path.join(WEB, 'src', 'api', 'useSession.ts')]: MOCK_SESSION,
  [path.join(
    WEB,
    'src',
    'features',
    'research-group',
    'useResearchGroup.ts',
  )]: MOCK_GROUP,
  [path.join(
    WEB,
    'src',
    'features',
    'projects',
    'WorkItemDrawer.tsx',
  )]: MOCK_DRAWER,
})

writeFileSync(
  VITE_CONFIG,
  `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

const MOCK_MAP = ${MOCK_MAP}

function mockModulesPlugin() {
  return {
    name: 'fg-meeting-detail-theme-mocks',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      const resolved = await this.resolve(
        source,
        importer,
        { skipSelf: true, ...options },
      )
      if (!resolved) return null
      const cleanId = path.resolve(resolved.id.split('?')[0])
      const target = MOCK_MAP[cleanId]
      if (target) return target
      return null
    },
  }
}

export default defineConfig({
  plugins: [mockModulesPlugin(), react(), tailwindcss()],
  build: {
    outDir: '${path.relative(WEB, OUT).replace(/\\\\/g, '/')}',
    emptyOutDir: false,
    rollupOptions: {
      input: {
        'meeting-detail-theme-visual':
          '.meeting-detail-theme-visual-entry.tsx',
      },
      output: { format: 'iife' },
    },
  },
})
`,
)

mkdirSync(OUT, { recursive: true })
rmSync(path.join(OUT, 'assets'), {
  recursive: true,
  force: true,
})

function cleanupHarnessFiles() {
  rmSync(ENTRY, { force: true })
  rmSync(VITE_CONFIG, { force: true })
  rmSync(MOCK_MEETINGS, { force: true })
  rmSync(MOCK_PROJECTS, { force: true })
  rmSync(MOCK_WORK_ITEMS, { force: true })
  rmSync(MOCK_SESSION, { force: true })
  rmSync(MOCK_GROUP, { force: true })
  rmSync(MOCK_DRAWER, { force: true })
  rmSync(path.join(OUT, 'index.html'), { force: true })
}

console.log(
  '== Bundling the real Meeting Detail page (mocked API) ==',
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
  cleanupHarnessFiles()
  console.error('Component bundle build failed.')
  process.exit(1)
}
const assetsDir = path.join(OUT, 'assets')
const bundleMatch = existsSync(assetsDir)
  ? readdirSync(assetsDir).find(
      (f) =>
        f.startsWith('meeting-detail-theme-visual-') &&
        f.endsWith('.js'),
    )
  : undefined
if (!bundleMatch) {
  cleanupHarnessFiles()
  console.error(
    'Could not locate the bundle in the harness build output.',
  )
  process.exit(1)
}

/* ── 4. Harness page mirroring the app shell width chain ──────── */

cpSync(cssPath, path.join(OUT, 'production.css'))

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
  /* Mirrors AppShell (fixed 240px sidebar at EVERY viewport) —
     the Meeting Detail page carries its own padding. */
  #shell {
    margin-left: 240px;
  }
</style>
</head>
<body>
<div id="shell"><div id="visual-root"></div></div>
<script src="${path.join(OUT, 'assets', bundleMatch).replace(/\\\\/g, '/')}" ></script>
</body>
</html>
`,
)

/* ── 5. Measure computed styles in a real browser ─────────────── */

// The measurement runs INSIDE the browser page. It is passed to
// `page.evaluate` as a REAL function (with SECTION_NAME as its
// argument): Playwright serializes the function source and invokes
// it in the page context. This must NOT be a string of source
// code — Playwright treats a string argument as a plain
// expression, so an arrow-function source would evaluate to an
// UNINVOKED function object that serializes to `undefined`, and
// the harness would crash on `m.<field>` with an uncaught
// TypeError ("Cannot read properties of undefined (reading
// 'theme')").
function measureMeetingDetail(sectionName) {
  const pick = (el, props) => {
    if (!el) return null
    const s = getComputedStyle(el)
    const out = {}
    for (const p of props) out[p] = s[p]
    return out
  }
  const title = pick(document.querySelector('h1'), ['color'])
  const card = document.querySelector(
    'section[aria-label="' + sectionName + '"]'
  )
  const cardStyle = pick(card, [
    'backgroundColor',
    'borderTopColor',
  ])
  const kbdBar = document
    .querySelector('kbd')
    ?.closest('div[class*="rounded-lg"]')
  const barStyle = pick(kbdBar, [
    'backgroundColor',
    'borderTopColor',
  ])
  const avatar = document.querySelector(
    '[aria-label="Participants"] > span'
  )
  const avatarStyle = pick(avatar, ['backgroundColor'])
  const start = [...document.querySelectorAll('button')]
    // The Start action carries an aria-hidden Material Symbols
    // icon span (ligature text "play_arrow"); the VISIBLE label
    // is the button's direct text nodes only — raw textContent
    // would include the icon ligature and never match.
    .find((b) =>
      Array.from(b.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent)
        .join('')
        .trim() === 'Start meeting',
    )
  const startStyle = pick(start, [
    'backgroundColor',
    'color',
  ])
  const addUser = [...document.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === 'Add user')
  const addUserStyle = pick(addUser, ['color'])
  const pane = document.querySelector(
    'section[data-live-focus-pane]'
  )
  const paneStyle = pick(pane, [
    'backgroundColor',
    'borderTopColor',
  ])
  const end = [...document.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === 'End meeting')
  const endStyle = pick(end, ['color'])
  const addSection =
    !!document.querySelector('button') &&
    [...document.querySelectorAll('button')].some(
      (b) => b.textContent.trim() === '+ Add section',
    )
  const scrim = document.querySelector(
    '[role="dialog"][aria-labelledby="meeting-delete-title"]'
  )?.parentElement
  const scrimStyle = pick(scrim, ['backgroundColor'])
  const dialog = document.querySelector(
    '[role="dialog"][aria-labelledby="meeting-delete-title"]'
  )
  const dialogStyle = pick(dialog, ['backgroundColor'])
  const dialogCancel = dialog
    ? [...dialog.querySelectorAll('button')].find(
        (b) => b.textContent.trim() === 'Cancel',
      )
    : null
  const dialogCancelStyle = pick(dialogCancel, ['color'])
  const dialogDelete = dialog
    ? [...dialog.querySelectorAll('button')].find(
        (b) => b.textContent.trim().startsWith('Delete meeting'),
      )
    : null
  const dialogDeleteStyle = pick(dialogDelete, [
    'backgroundColor',
    'color',
  ])
  const composerInput = document.querySelector(
    'input[aria-label="New section name"]'
  )
  const composerForm = composerInput?.closest('form')
  const composerStyle = pick(composerForm, ['backgroundColor'])
  const composerInputStyle = pick(composerInput, ['color'])
  const composerPlaceholderStyle = composerInput
    ? {
        color: getComputedStyle(
          composerInput,
          '::placeholder',
        ).color,
      }
    : null
  const composerButtons = composerForm
    ? [...composerForm.querySelectorAll('button')]
    : []
  const composerSaveStyle = pick(
    composerButtons.find(
      (b) => b.textContent.trim() === 'Add',
    ),
    ['color'],
  )
  const composerCancelStyle = pick(
    composerButtons.find(
      (b) => b.textContent.trim() === 'Cancel',
    ),
    ['color'],
  )
  const topicField = document.querySelector(
    'textarea[aria-label^="Edit topic"]'
  )
  const topicForm = topicField?.closest('form')
  const topicStyle = pick(topicForm, [
    'backgroundColor',
    'borderTopColor',
  ])
  const topicFieldStyle = pick(topicField, ['color'])
  const topicButtons = topicForm
    ? [...topicForm.querySelectorAll('button')]
    : []
  const topicSaveStyle = pick(
    topicButtons.find(
      (b) => b.textContent.trim().startsWith('Save'),
    ),
    ['color'],
  )
  const topicCancelStyle = pick(
    topicButtons.find(
      (b) => b.textContent.trim() === 'Cancel',
    ),
    ['color'],
  )
  return {
    theme: document.documentElement.dataset.theme ?? null,
    title, card: cardStyle, bar: barStyle,
    avatar: avatarStyle, start: startStyle,
    addUser: addUserStyle, pane: paneStyle,
    end: endStyle, addSection,
    scrim: scrimStyle, dialog: dialogStyle,
    dialogCancel: dialogCancelStyle,
    dialogDelete: dialogDeleteStyle,
    composer: composerStyle,
    composerInput: composerInputStyle,
    composerPlaceholder: composerPlaceholderStyle,
    composerSave: composerSaveStyle,
    composerCancel: composerCancelStyle,
    topic: topicStyle, topicField: topicFieldStyle,
    topicSave: topicSaveStyle, topicCancel: topicCancelStyle,
  }
}

// Every field the measurement object must carry; a missing field
// is a harness-shape failure, reported by name.
const MEASUREMENT_FIELDS = [
  'theme', 'title', 'card', 'bar', 'avatar', 'start', 'addUser',
  'pane', 'end', 'addSection', 'scrim', 'dialog', 'dialogCancel',
  'dialogDelete', 'composer', 'composerInput', 'composerPlaceholder',
  'composerSave', 'composerCancel', 'topic', 'topicField',
  'topicSave', 'topicCancel',
]

const { chromium } = await import(
  path.join(ROOT, 'node_modules', 'playwright', 'index.mjs')
)

let browser
const measurements = []
let currentScenario = ''

// Page-side diagnostics captured for the whole run: uncaught page
// exceptions (pageerror) and console errors. They are surfaced in
// failure details and the final summary; environmental console
// noise (e.g. an offline font fetch) is reported, not asserted on.
const pageDiagnostics = { pageErrors: [], consoleErrors: [] }

function diagnosticsSummary() {
  const parts = []
  if (pageDiagnostics.pageErrors.length) {
    parts.push(
      'uncaught page errors: ' +
        pageDiagnostics.pageErrors.join(' | '),
    )
  }
  if (pageDiagnostics.consoleErrors.length) {
    parts.push(
      'console errors: ' +
        pageDiagnostics.consoleErrors.join(' | '),
    )
  }
  return parts.length
    ? parts.join(' — ')
    : 'no page errors captured'
}

// Runs the in-page measurement and converts every "the page did
// not give us what we asked for" condition into a controlled,
// diagnostic FAIL — never an uncaught TypeError in the harness.
async function measureInPage(page, label) {
  let m
  try {
    m = await page.evaluate(measureMeetingDetail, SECTION_NAME)
  } catch (err) {
    check(
      `${label} — measurement`,
      false,
      `page.evaluate threw: ${err.message}; ${diagnosticsSummary()}`,
    )
    return null
  }
  if (m === null || typeof m !== 'object') {
    check(
      `${label} — measurement`,
      false,
      `page.evaluate returned ${
        m === null ? 'null' : String(m)
      } instead of a measurement object — the page may not have rendered; ${diagnosticsSummary()}`,
    )
    return null
  }
  const missingFields = MEASUREMENT_FIELDS.filter(
    (field) => !(field in m),
  )
  if (missingFields.length) {
    check(
      `${label} — measurement shape`,
      false,
      `measurement object is missing fields: ${missingFields.join(', ')}`,
    )
  }
  return m
}

function tokenValue(theme, name) {
  const raw =
    theme === 'dark' ? DARK_TOKENS[name] : LIGHT_TOKENS[name]
  if (raw == null) return null
  return hexToRgb(raw) ?? raw
}

async function expectStyle(
  label,
  actual,
  theme,
  tokenName,
  prop,
) {
  const expected = tokenValue(theme, tokenName)
  check(
    label,
    expected != null && actual === expected,
    actual === undefined
      ? `${prop}: audited element not found — expected ${expected}`
      : `${prop}: actual ${actual}, expected ${expected}`,
  )
}

try {
  try {
    browser = await chromium.launch({ headless: true })
  } catch (launchError) {
    console.error(
      '\nBrowser launch failed (ENVIRONMENT / HARNESS — not an application defect):',
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
        ' in any Chromium-based browser with ?state=<state>&theme=<theme>.',
    )
    cleanupHarnessFiles()
    process.exit(1)
  }

  const context = await browser.newContext()
  const page = await context.newPage()

  page.on('pageerror', (err) =>
    pageDiagnostics.pageErrors.push(err.message),
  )
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      pageDiagnostics.consoleErrors.push(msg.text())
    }
  })

  for (const state of STATES) {
    for (const theme of THEMES) {
      for (const viewport of VIEWPORTS) {
        const scenario = `${state} / ${theme} / ${viewport.name}`
        currentScenario = scenario
        const scenarioPageErrorOffset =
          pageDiagnostics.pageErrors.length
        await page.setViewportSize({
          width: viewport.width,
          height: 1000,
        })
        await page.goto(
          `file://${htmlPath}?state=${state}&theme=${theme}`,
        )
        await page.waitForFunction(
          (title) =>
            document.querySelector('h1')?.textContent
              .trim() === title,
          MEETING_TITLE,
        )
        await page.evaluate(() =>
          Promise.race([
            document.fonts.ready,
            new Promise((resolve) =>
              setTimeout(resolve, 4000),
            ),
          ]),
        )
        await page.evaluate(() => window.scrollTo(0, 0))

        const m = await measureInPage(page, scenario)

        console.log(
          `== ${scenario} ==`,
        )
        if (!m) {
          // No measurement object: the failure above already
          // records the diagnostic. Capture the rendered state
          // for review and move to the next scenario — the
          // per-surface assertions below have nothing to assert
          // against.
          await page.screenshot({
            path: path.join(
              OUT,
              `meeting-detail-${state}-${theme}-${viewport.name}.png`,
            ),
            fullPage: true,
          })
          continue
        }
        measurements.push({
          state,
          theme,
          viewport: viewport.name,
          ...m,
        })

        check(
          'data-theme',
          m.theme === theme,
          `actual ${m.theme}`,
        )
        check(
          'page title rendered',
          m.title != null,
          'h1 missing',
        )

        if (state === 'upcoming' || state === 'cancelled') {
          check(
            'agenda section card rendered',
            m.card != null,
            `section[aria-label="${SECTION_NAME}"] missing`,
          )
          expectStyle(
            'title text',
            m.title?.color,
            theme,
            'text',
            'color',
          )
          expectStyle(
            'section card surface',
            m.card?.backgroundColor,
            theme,
            'surface',
            'background-color',
          )
          expectStyle(
            'section card border',
            m.card?.borderTopColor,
            theme,
            'border-subtle',
            'border-color',
          )
        }

        if (state === 'upcoming') {
          check(
            'quick add bar rendered',
            m.bar != null,
            'Quick Add bar missing (kbd wrapper not found)',
          )
          check(
            'participant avatar rendered',
            m.avatar != null,
            '[aria-label="Participants"] avatar missing',
          )
          check(
            'start meeting button rendered',
            m.start != null,
            '"Start meeting" button missing',
          )
          check(
            'add user button rendered',
            m.addUser != null,
            '"Add user" button missing',
          )
          expectStyle(
            'quick add bar surface',
            m.bar?.backgroundColor,
            theme,
            'surface',
            'background-color',
          )
          expectStyle(
            'quick add bar border',
            m.bar?.borderTopColor,
            theme,
            'border-subtle',
            'border-color',
          )
          expectStyle(
            'participant avatar fill',
            m.avatar?.backgroundColor,
            theme,
            'surface-muted',
            'background-color',
          )
          expectStyle(
            'start meeting fill',
            m.start?.backgroundColor,
            theme,
            'action',
            'background-color',
          )
          expectStyle(
            'start meeting text',
            m.start?.color,
            theme,
            'text-inverse',
            'color',
          )
          expectStyle(
            'add user accent text',
            m.addUser?.color,
            theme,
            'accent-text',
            'color',
          )
        }

        if (state === 'live') {
          check(
            'live focus pane rendered',
            m.pane != null,
            'section[data-live-focus-pane] missing',
          )
          check(
            'end meeting button rendered',
            m.end != null,
            '"End meeting" button missing',
          )
          expectStyle(
            'title text',
            m.title?.color,
            theme,
            'text',
            'color',
          )
          expectStyle(
            'focus pane surface',
            m.pane?.backgroundColor,
            theme,
            'surface-subtle',
            'background-color',
          )
          expectStyle(
            'focus pane border',
            m.pane?.borderTopColor,
            theme,
            'border-subtle',
            'border-color',
          )
          expectStyle(
            'end meeting text',
            m.end?.color,
            theme,
            'danger',
            'color',
          )
        }

        if (state === 'completed' || state === 'cancelled') {
          check(
            'no preparation controls',
            m.addSection === false,
            `addSection=${m.addSection}`,
          )
        }

        await page.screenshot({
          path: path.join(
            OUT,
            `meeting-detail-${state}-${theme}-${viewport.name}.png`,
          ),
          fullPage: true,
        })

        // Representative editor / dialog states: upcoming
        // desktop only (the other states render their own
        // shells; the audited editor surfaces are upcoming's).
        if (state === 'upcoming' && viewport.name === 'desktop') {
          // Section composer
          const addSectionButton = page
            .getByRole('button', { name: '+ Add section' })
          await addSectionButton.click()
          await page.waitForSelector(
            'input[aria-label="New section name"]',
          )
          const cm = await measureInPage(
            page,
            `${state} / ${theme} / section composer`,
          )
          console.log(
            `== ${state} / ${theme} / section composer ==`,
          )
          if (cm) {
            measurements.push({
              state,
              theme,
              viewport: viewport.name,
              surface: 'section-composer',
              ...cm,
            })
            check(
              'section composer rendered',
              cm.composerInput != null,
              'input[aria-label="New section name"] missing',
            )
            expectStyle(
              'composer surface',
              cm.composer?.backgroundColor,
              theme,
              'surface-subtle',
              'background-color',
            )
            expectStyle(
              'composer input text',
              cm.composerInput?.color,
              theme,
              'text',
              'color',
            )
            expectStyle(
              'composer placeholder',
              cm.composerPlaceholder?.color,
              theme,
              'text-muted',
              'color',
            )
            expectStyle(
              'composer add text',
              cm.composerSave?.color,
              theme,
              'text',
              'color',
            )
            expectStyle(
              'composer cancel text',
              cm.composerCancel?.color,
              theme,
              'text-muted',
              'color',
            )
          }
          await page.screenshot({
            path: path.join(
              OUT,
              `meeting-detail-${state}-${theme}-section-composer.png`,
            ),
          })
          await page.keyboard.press('Escape')
          await page.waitForSelector(
            'input[aria-label="New section name"]',
            { state: 'detached' },
          )

          // Topic Markdown composer
          await page
            .getByRole('button', {
              name: `Edit topic ${ITEM_TITLE}`,
            })
            .click()
          await page.waitForSelector(
            'textarea[aria-label^="Edit topic"]',
          )
          const tm = await measureInPage(
            page,
            `${state} / ${theme} / topic composer`,
          )
          console.log(
            `== ${state} / ${theme} / topic composer ==`,
          )
          if (tm) {
            measurements.push({
              state,
              theme,
              viewport: viewport.name,
              surface: 'topic-composer',
              ...tm,
            })
            check(
              'topic composer rendered',
              tm.topicField != null,
              'textarea[aria-label^="Edit topic"] missing',
            )
            expectStyle(
              'topic composer surface',
              tm.topic?.backgroundColor,
              theme,
              'surface-subtle',
              'background-color',
            )
            expectStyle(
              'topic composer border',
              tm.topic?.borderTopColor,
              theme,
              'border-subtle',
              'border-color',
            )
            expectStyle(
              'topic field text',
              tm.topicField?.color,
              theme,
              'text',
              'color',
            )
            expectStyle(
              'topic save text',
              tm.topicSave?.color,
              theme,
              'text',
              'color',
            )
            expectStyle(
              'topic cancel text',
              tm.topicCancel?.color,
              theme,
              'text-muted',
              'color',
            )
          }
          await page.screenshot({
            path: path.join(
              OUT,
              `meeting-detail-${state}-${theme}-topic-composer.png`,
            ),
          })
          await page.keyboard.press('Escape')
          await page.waitForSelector(
            'textarea[aria-label^="Edit topic"]',
            { state: 'detached' },
          )

          // Delete meeting dialog
          await page
            .getByRole('button', { name: 'Meeting actions' })
            .click()
          await page
            .getByRole('menuitem', { name: 'Delete meeting' })
            .click()
          await page.waitForSelector(
            '[role="dialog"][aria-labelledby="meeting-delete-title"]',
          )
          const dm = await measureInPage(
            page,
            `${state} / ${theme} / delete dialog`,
          )
          console.log(
            `== ${state} / ${theme} / delete dialog ==`,
          )
          if (dm) {
            measurements.push({
              state,
              theme,
              viewport: viewport.name,
              surface: 'delete-dialog',
              ...dm,
            })
            check(
              'delete dialog rendered',
              dm.dialog != null,
              '[role="dialog"][aria-labelledby="meeting-delete-title"] missing',
            )
            check(
              'dialog scrim',
              dm.scrim?.backgroundColor ===
                tokenValue(theme, 'overlay-scrim'),
              `actual ${dm.scrim?.backgroundColor}, expected ${tokenValue(theme, 'overlay-scrim')}`,
            )
            expectStyle(
              'dialog surface',
              dm.dialog?.backgroundColor,
              theme,
              'surface',
              'background-color',
            )
            expectStyle(
              'dialog cancel text',
              dm.dialogCancel?.color,
              theme,
              'text-muted',
              'color',
            )
            expectStyle(
              'dialog delete fill',
              dm.dialogDelete?.backgroundColor,
              theme,
              'danger-subtle',
              'background-color',
            )
            expectStyle(
              'dialog delete text',
              dm.dialogDelete?.color,
              theme,
              'danger',
              'color',
            )
          }
          await page.screenshot({
            path: path.join(
              OUT,
              `meeting-detail-${state}-${theme}-delete-dialog.png`,
            ),
          })
          await page
            .getByRole('dialog', { name: 'Delete meeting?' })
            .getByRole('button', { name: 'Cancel' })
            .click()
          await page.waitForSelector(
            '[role="dialog"][aria-labelledby="meeting-delete-title"]',
            { state: 'detached' },
          )
        }
        check(
          `${scenario} — no uncaught page errors`,
          pageDiagnostics.pageErrors.length ===
            scenarioPageErrorOffset,
          pageDiagnostics.pageErrors
            .slice(scenarioPageErrorOffset)
            .join(' | '),
        )
      }
    }
  }

  await browser.close()
} catch (scenarioFatalError) {
  // A hard Playwright error (navigation, readiness wait, selector
  // timeout) aborts the remaining scenarios. Record it as a
  // controlled diagnostic failure with the captured page errors
  // instead of letting it escape as an uncaught stack, so the
  // partial evidence (measurements.json, screenshots) below is
  // still written and the exit code stays meaningful.
  check(
    `${currentScenario || 'scenario'} — aborted`,
    false,
    `${scenarioFatalError.message}; ${diagnosticsSummary()}`,
  )
} finally {
  cleanupHarnessFiles()
}

/* ── 6. Summary ───────────────────────────────────────────────── */

writeFileSync(
  path.join(OUT, 'measurements.json'),
  JSON.stringify(measurements, null, 2),
)

if (
  pageDiagnostics.pageErrors.length ||
  pageDiagnostics.consoleErrors.length
) {
  console.log(
    '\nPage diagnostics (captured during the run):',
  )
  for (const error of pageDiagnostics.pageErrors) {
    console.log(`  [pageerror] ${error}`)
  }
  for (const error of pageDiagnostics.consoleErrors) {
    console.log(`  [console.error] ${error}`)
  }
}

console.log(
  `\nMeeting Detail theme check: ${
    failures === 0
      ? 'ALL PASS'
      : `${failures} FAILURES`
  } (${measurements.length} measurements)`,
)
console.log(
  `Artifacts: ${path.relative(ROOT, OUT)}`,
)

process.exit(failures === 0 ? 0 : 1)
