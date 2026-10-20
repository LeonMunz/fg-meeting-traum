import {
  expect,
  test,
  type Page,
  type Response,
} from '@playwright/test'

import { login } from './helpers'
import {
  expectMyWorkReady,
  getMyWorkPreferences,
  getProjectIdInGroup,
  sameMyWorkPreferences,
  setMyWorkPreferences,
  type MyWorkPreferencesSnapshot,
} from './my-work-helpers'

/**
 * RT-06B — cross-tab My Work realtime acceptance (two tabs, ONE
 * session).
 *
 * Proves the full production chain in real browsers:
 *
 *   tab A issues the canonical personal My Work board move
 *   (POST /api/me/work-items/{id}/reorder/ carrying exactly
 *   statusCategory + beforeWorkItemId, through the browser's own
 *   authenticated session)
 *     -> server-persisted personal MyWorkBoardPosition change
 *     -> PostgreSQL NOTIFY at commit
 *     -> the user's authenticated SSE stream (GET
 *        /api/work-items/events/)
 *     -> tab B's native EventSource client
 *     -> one authoritative, SILENT refetch of
 *        GET /api/me/work-items/ on B
 *     -> B's already-open My Work Board shows the new personal
 *        order
 *
 * with NO page.reload(), no navigation, no user action on B, and
 * NO synthetic SSE events (the only event source is the real
 * product chain above).
 *
 * Proven properties:
 * - One BrowserContext, two pages: BOTH tabs demonstrably share the
 *   SAME authenticated session (server-derived identity
 *   /api/auth/me/ + exactly one session cookie in the context), and
 *   EACH tab owns its own successful SSE connection (200
 *   text/event-stream on its own GET /api/work-items/events/).
 * - The starting state is reproducible and DERIVED, not guessed:
 *   the persisted preference is set server-side through the
 *   existing helper (Board view + both relevant Projects as active
 *   Project filter) before either tab opens My Work, and the
 *   initial Todo-column order is computed from the canonical
 *   GET /api/me/work-items/ payload (positioned cards first by
 *   myWorkBoardPosition, then unpositioned in canonical creation
 *   order) and matched against the rendered columns of BOTH tabs.
 * - The mutation is a REAL personal reorder, persisted
 *   server-side (the canonical personal read-back shows the new
 *   order with explicit positions), with the Work Item remaining
 *   in the Todo category — and it is NOT an ordinary Project Board
 *   reorder, status transition, or status PATCH (wire ledgers on
 *   both tabs).
 * - Tab B updates AUTOMATICALLY: the rendered Todo cards reflect
 *   the new order after at least one canonical
 *   GET /api/me/work-items/ on B beyond the refetch baseline
 *   captured IMMEDIATELY before the mutation, after an event-based
 *   initialization barrier proves all of B's startup reads have
 *   settled — so the extra read is post-initialization traffic
 *   (the event-triggered revalidation), never a delayed startup
 *   read. Deliberately NO fixed request-count assumption: this spec
 *   runs against the Vite DEV server, where main.tsx's React
 *   StrictMode double-executes the mount effect in development, so
 *   B's startup legitimately performs THREE canonical reads (two
 *   initial loads + exactly one RC-5 open-handshake revalidation),
 *   not two.
 * - B stays mounted: no reload/navigation (document-level marker),
 *   no loading-skeleton swap (column node-identity marker), no
 *   degraded-mode indicator, one SSE stream for the whole test.
 * - B keeps its Board selection, its filters, and its persisted
 *   preferences: no preference PATCH from either tab and the final
 *   server snapshot equals the baseline snapshot.
 *
 * Test isolation: ONE BrowserContext (shared Django session cookie
 * — the point of this spec), dedicated preference setup through the
 * canonical API before rendering (server-persistent state is
 * established, never assumed), the seeded E2E data
 * ("First Draft Complete" — Paper XYZ / FG Example; "E2E Analyze
 * robot data" — E2E Robot Study / Robotics Lab; both assigned to
 * alex, both in the todo category after the seed AND after
 * my-work.spec.ts in a full sequential run — that spec ends with
 * "First Draft Complete" moved back into Todo), and no waiting via
 * arbitrary sleeps — every step waits on observable product state
 * or observable wire state (Playwright assertions). The spec is
 * independent of the other E2E specs and their execution order:
 * it derives the initial order and the reorder anchors from the
 * live canonical payload instead of assuming a fresh-seed state.
 */

// Seeded cards (seed_dev + seed_e2e_scope): both assigned to alex,
// both in the `todo` semantic category.
const CARD_DRAFT = 'First Draft Complete'
const CARD_ROBOT = 'E2E Analyze robot data'

const DRAFT_GROUP = 'FG Example'
const DRAFT_PROJECT = 'Paper XYZ'
const ROBOT_GROUP = 'Robotics Lab'
const ROBOT_PROJECT = 'E2E Robot Study'

// Wide enough that all four global columns stay visible next to
// each other (the same convention the Project Board realtime spec
// uses).
const VIEWPORT = { width: 1920, height: 1000 }

/**
 * Mirrors the canonical GET /api/me/work-items/ item payload (the
 * backend PersonalMyWorkView + the frontend ApiPersonalWorkItem
 * contract) — only the fields this spec consumes.
 */
interface PersonalWorkItemDto {
  id: number
  title: string
  statusDefinitionId: number | null
  statusCategory: string
  statusName: string
  myWorkBoardPosition: number | null
  projectId: number
  projectName: string
}

/**
 * Per-tab wire ledger: everything this spec must PROVE on the
 * wire, observed while the page runs (no positional request
 * counting — only identity-based matching).
 */
interface TabLedger {
  /** Canonical personal My Work list READS (GET, exact pathname)
   *  that have SETTLED (response received). */
  myWorkGets: number
  /** Canonical personal My Work list READS currently in flight
   *  (request sent, response not yet received) — the
   *  initialization barrier waits for this to settle to 0. */
  myWorkGetsInFlight: number
  /** Preference writes (PATCH /api/me/preferences/my-work/). */
  preferencePatches: number
  /** Ordinary Project-board mutations: POST
   *  /api/work-items/{id}/reorder/, POST
   *  /api/work-items/{id}/transition-status/, or
   *  PATCH /api/work-items/{id}/. */
  ordinaryMutations: number
  /** Every SSE stream response of this tab. */
  sseResponses: Response[]
}

function observeTab(page: Page): TabLedger {
  const ledger: TabLedger = {
    myWorkGets: 0,
    myWorkGetsInFlight: 0,
    preferencePatches: 0,
    ordinaryMutations: 0,
    sseResponses: [],
  }

  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    const method = request.method()

    if (
      method === 'GET' &&
      pathname === '/api/me/work-items/'
    ) {
      ledger.myWorkGetsInFlight += 1
    }

    if (
      method === 'PATCH' &&
      pathname === '/api/me/preferences/my-work/'
    ) {
      ledger.preferencePatches += 1
    }

    if (
      (method === 'POST' &&
        /\/api\/work-items\/\d+\/reorder\/$/.test(pathname)) ||
      (method === 'POST' &&
        /\/api\/work-items\/\d+\/transition-status\/$/.test(
          pathname,
        )) ||
      (method === 'PATCH' &&
        /\/api\/work-items\/\d+\/$/.test(pathname))
    ) {
      ledger.ordinaryMutations += 1
    }
  })

  page.on('response', (response) => {
    const url = response.url()

    if (
      response.request().method() === 'GET' &&
      new URL(url).pathname === '/api/me/work-items/'
    ) {
      ledger.myWorkGets += 1
      ledger.myWorkGetsInFlight -= 1
    }

    if (url.includes('/api/work-items/events/')) {
      ledger.sseResponses.push(response)
    }
  })

  return ledger
}

/**
 * Render order of ONE My Work Board column over an already-loaded
 * canonical payload — mirrors the product rule
 * (orderMyWorkBoardColumn): explicitly positioned cards first
 * (myWorkBoardPosition ascending), then unpositioned cards in the
 * canonical creation order (the payload's input order).
 */
function columnRenderOrder(
  items: readonly PersonalWorkItemDto[],
): PersonalWorkItemDto[] {
  const positioned = items
    .filter((item) => item.myWorkBoardPosition != null)
    .sort(
      (left, right) =>
        (left.myWorkBoardPosition as number) -
        (right.myWorkBoardPosition as number),
    )
  const unpositioned = items.filter(
    (item) => item.myWorkBoardPosition == null,
  )
  return [...positioned, ...unpositioned]
}

/** The visible order of card titles in the My Work Todo column. */
async function todoColumnTitles(page: Page): Promise<string[]> {
  const column = page.locator('[data-board-column="todo"]')
  const cards = column.getByRole('button', { name: /^Open / })
  const count = await cards.count()
  const titles: string[] = []
  for (let i = 0; i < count; i += 1) {
    const label = await cards
      .nth(i)
      .getAttribute('aria-label')
    titles.push(label?.replace(/^Open /, '') ?? '')
  }
  return titles
}

/**
 * Read the authenticated user's canonical My Work payload through
 * the browser's own session (the same endpoint the page renders
 * from — no second truth).
 */
async function fetchMyWorkPayload(
  page: Page,
): Promise<PersonalWorkItemDto[]> {
  return page.evaluate(async () => {
    const res = await fetch('/api/me/work-items/', {
      credentials: 'same-origin',
    })

    if (!res.ok) {
      throw new Error(
        `My Work payload read failed: ${res.status}`,
      )
    }

    return (await res.json()) as PersonalWorkItemDto[]
  })
}

/**
 * The username of the browser's OWN authenticated session — the
 * server-derived identity (the same endpoint the app uses to
 * recover its session state), not a client-side label.
 */
async function currentUsername(page: Page): Promise<string> {
  const me = await page.evaluate(async () => {
    const res = await fetch('/api/auth/me/', {
      credentials: 'same-origin',
    })
    return { status: res.status, data: await res.json() }
  })

  expect(me.status).toBe(200)
  return me.data.username as string
}

interface PersonalReorderResult {
  status: number
  body: {
    id: number
    statusDefinitionId: number | null
  }
}

/**
 * One canonical personal My Work board move through the browser's
 * OWN authenticated session (the same request shape the Board
 * drag-and-drop sends — no test backdoor, no synthetic event).
 * CSRF exactly like the app's authenticated fetches: the rotating
 * csrftoken cookie, established through the canonical endpoint
 * when absent.
 */
async function postPersonalReorder(
  page: Page,
  workItemId: number,
  statusCategory: string,
  beforeWorkItemId: number | null,
): Promise<PersonalReorderResult> {
  return page.evaluate(
    async ({
      workItemId,
      statusCategory,
      beforeWorkItemId,
    }: {
      workItemId: number
      statusCategory: string
      beforeWorkItemId: number | null
    }) => {
      const csrfFromCookie = () =>
        document.cookie
          .split(';')
          .map((c) => c.trim())
          .find((c) => c.startsWith('csrftoken='))
          ?.split('=')[1]

      let csrf = csrfFromCookie()

      if (!csrf) {
        await fetch('/api/auth/csrf/', {
          credentials: 'same-origin',
        })
        csrf = csrfFromCookie()
      }

      const res = await fetch(
        `/api/me/work-items/${workItemId}/reorder/`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-CSRFToken': csrf ?? '',
          },
          body: JSON.stringify({
            statusCategory,
            beforeWorkItemId,
          }),
        },
      )

      return {
        status: res.status,
        body: (await res.json()) as PersonalReorderResult['body'],
      }
    },
    { workItemId, statusCategory, beforeWorkItemId },
  )
}

test(
  'My Work realtime: a personal reorder in one tab updates the ' +
    'other tab\'s Board automatically — without reload, skeleton ' +
    'swap, or preference change',
  async ({ browser }, testInfo) => {
    // This test drives two live tabs of one session with two SSE
    // streams — give it an explicit, larger wall-clock budget than
    // the suite default (still a cap, not a wait).
    testInfo.setTimeout(90_000)

    // ONE BrowserContext = ONE shared Django session (the session
    // cookie is context-scoped, so both tabs of this context are
    // tabs of the SAME logged-in browser). Two pages = two tabs.
    const context = await browser.newContext({
      viewport: VIEWPORT,
    })
    const pageA = await context.newPage()
    const pageB = await context.newPage()

    try {
      // ============================================================
      // 1. One user, one session, two tabs.
      // ============================================================
      await login(pageA, 'alex')
      expect(await currentUsername(pageA)).toBe('alex')

      // Reproducible starting state, set SERVER-SIDE through the
      // existing preference helper BEFORE either tab opens My
      // Work: the Board view plus both relevant Projects as the
      // active Project filter (both seeded Todo cards stay
      // visible). The returned normalized snapshot is the
      // authoritative persisted baseline.
      const draftProjectId = await getProjectIdInGroup(
        pageA,
        DRAFT_GROUP,
        DRAFT_PROJECT,
      )
      const robotProjectId = await getProjectIdInGroup(
        pageA,
        ROBOT_GROUP,
        ROBOT_PROJECT,
      )
      const baselinePrefs: MyWorkPreferencesSnapshot =
        await setMyWorkPreferences(pageA, {
          viewMode: 'board',
          researchGroupIds: [],
          projectIds: [draftProjectId, robotProjectId],
          workItemTypes: [],
        })
      expect(baselinePrefs.viewMode).toBe('board')

      // Wire ledgers on BOTH tabs, attached before either page
      // mounts My Work (the setup PATCH above went through the
      // context's API request context, not page traffic — the
      // ledgers therefore only ever see the live tabs).
      const ledgerA = observeTab(pageA)
      const ledgerB = observeTab(pageB)

      // Tab A opens My Work; its OWN SSE connection must be
      // answered 200 text/event-stream by the authenticated
      // product endpoint (an unauthenticated request receives 401
      // before any stream byte).
      const sseResponsePromiseA = pageA.waitForResponse(
        (response) =>
          response
            .url()
            .includes('/api/work-items/events/'),
        { timeout: 30_000 },
      )
      await pageA.goto('/my-work')
      const sseResponseA = await sseResponsePromiseA
      expect(sseResponseA.status()).toBe(200)
      expect(
        sseResponseA.headers()['content-type'],
      ).toContain('text/event-stream')

      // A renders the initial personal server state (persisted
      // Board view + both seeded cards visible).
      await expectMyWorkReady(pageA, {
        viewMode: 'board',
        visibleTitles: [CARD_DRAFT, CARD_ROBOT],
      })

      // Tab B: the SAME context (same session), the second tab.
      const sseResponsePromiseB = pageB.waitForResponse(
        (response) =>
          response
            .url()
            .includes('/api/work-items/events/'),
        { timeout: 30_000 },
      )
      await pageB.goto('/my-work')
      const sseResponseB = await sseResponsePromiseB
      expect(sseResponseB.status()).toBe(200)
      expect(
        sseResponseB.headers()['content-type'],
      ).toContain('text/event-stream')

      // Wire-state marker: how many canonical personal reads had
      // ALREADY settled when B's stream was established (this 200
      // response observed). The `open` handshake is the FIRST frame
      // of the stream body (the server sends it on connect, before
      // any event frame), so the RC-5 open-handshake revalidation —
      // and its response — can only land AFTER this marker:
      // every canonical read counted from now on postdates the
      // connection.
      const sseSettledReadsBaselineB = ledgerB.myWorkGets

      // B is authenticated WITHOUT logging in: the server-derived
      // identity is the same user, and the context holds exactly
      // ONE session cookie (one shared Django session, not two).
      expect(await currentUsername(pageB)).toBe('alex')
      const sessionCookies = (await context.cookies()).filter(
        (cookie) => cookie.name === 'sessionid',
      )
      expect(sessionCookies).toHaveLength(1)

      // B renders the SAME initial personal server state.
      await expectMyWorkReady(pageB, {
        viewMode: 'board',
        visibleTitles: [CARD_DRAFT, CARD_ROBOT],
      })

      // ============================================================
      // 2. Reproducible starting order — derived from the
      //    canonical My Work payload, never guessed from a random
      //    DOM order.
      // ============================================================
      const payload = await fetchMyWorkPayload(pageA)

      for (const title of [CARD_DRAFT, CARD_ROBOT]) {
        const item = payload.find((i) => i.title === title)
        expect(
          item,
          `Seeded card "${title}" must be in alex's My Work payload.`,
        ).toBeTruthy()
        expect(
          item!.statusCategory,
          `Seeded card "${title}" must be in the todo category.`,
        ).toBe('todo')
      }

      // The Todo column's render order over the FULL personal
      // column (the server normalizes the whole column, filters
      // are presentation-only): positioned first, then
      // unpositioned in canonical creation order.
      const fullOrder = columnRenderOrder(
        payload.filter((i) => i.statusCategory === 'todo'),
      )

      // The VISIBLE column (the persisted Project filter keeps
      // exactly the two relevant Projects).
      const visibleProjectIds = new Set([
        draftProjectId,
        robotProjectId,
      ])
      const visibleOrder = fullOrder.filter((item) =>
        visibleProjectIds.has(item.projectId),
      )
      expect(
        visibleOrder.length,
        'Both seeded cards must stay visible in the Todo column.',
      ).toBeGreaterThanOrEqual(2)

      const visibleTitles = visibleOrder.map((i) => i.title)
      expect(visibleTitles).toContain(CARD_DRAFT)
      expect(visibleTitles).toContain(CARD_ROBOT)

      // The reorder pair: the SECOND visible card moves BEFORE
      // the FIRST visible card (a valid anchor id — the only
      // order change of a two-card top with an explicit anchor;
      // any other placement would be a server-side no-op).
      const anchorItem = visibleOrder[0]
      const movedItem = visibleOrder[1]

      // BOTH tabs render exactly the payload-derived order.
      await expect
        .poll(() => todoColumnTitles(pageA))
        .toEqual(visibleTitles)
      await expect
        .poll(() => todoColumnTitles(pageB))
        .toEqual(visibleTitles)

      // Initialization barrier on B (event-based, NO fixed
      // request-count assumption): wait until ALL of B's startup
      // reads have settled, so the mutation-triggered refetch is
      // cleanly separated from initialization traffic. B's startup
      // reads are (1) the initial load — run TWICE in this
      // dev-server E2E environment, because main.tsx mounts the app
      // in React StrictMode and StrictMode double-executes mount
      // effects in development (the loadMyWork effect issues both
      // loads and neither is aborted, so both settle), and (2)
      // exactly one RC-5 open-handshake revalidation (the server
      // sends the `open` frame as the first frame of the stream
      // body; the product requests exactly one authoritative
      // revalidation per valid open, and the controller guarantees
      // one onOpen per connection). The barrier therefore waits on
      // observable wire events, not a count: at least one canonical
      // read SETTLES after the stream was established (that is the
      // RC-5 revalidation — the only read the product can issue
      // after the open handshake; in StrictMode the second initial
      // load's response may settle in the same window and is
      // counted harmlessly along with it), and NO read is in
      // flight. From this point on, B can only issue a further
      // canonical read in reaction to a post-initialization
      // trigger — the my_work_changed event of the mutation below
      // (the product has no polling; the spec's own payload reads
      // run on tab A).
      await expect
        .poll(
          () =>
            ledgerB.myWorkGets - sseSettledReadsBaselineB >= 1 &&
            ledgerB.myWorkGetsInFlight === 0,
          {
            timeout: 15_000,
            message:
              'B must settle its startup My Work reads (initial load' +
              ' — twice under React StrictMode in the dev E2E' +
              ' environment — plus the RC-5 open-handshake' +
              ' revalidation) before the mutation.',
          },
        )
        .toBe(true)

      // Mount / no-swap evidence for BOTH tabs, set while both
      // render the starting state:
      //  1. a full page load or navigation would replace <html>
      //     and lose the marker;
      //  2. the Todo column node only exists in the LOADED board:
      //     a loading-skeleton swap would unmount and recreate it.
      for (const page of [pageA, pageB]) {
        await page.evaluate(() => {
          document.documentElement.setAttribute(
            'data-rt-no-reload',
            '1',
          )
        })
        await page
          .locator('[data-board-column="todo"]')
          .evaluate((el) =>
            el.setAttribute('data-rt-node-identity', '1'),
          )
      }

      // ============================================================
      // 3. Tab A performs the real canonical PERSONAL reorder:
      //    POST /api/me/work-items/{id}/reorder/ carrying exactly
      //    statusCategory "todo" + beforeWorkItemId (the valid
      //    anchor id), through A's own authenticated session.
      //    Same-category move: only the user's personal
      //    MyWorkBoardPosition rows change — no Work Item status
      //    mutation, no Project board_position write.
      // ============================================================
      // Refetch baseline on B, captured IMMEDIATELY before the
      // mutation — after the initialization barrier settled, so
      // every startup read has already landed: any canonical read
      // on B beyond this point is post-initialization traffic (the
      // event-triggered revalidation). A delayed startup read
      // cannot fake the proof either: while the barrier waited it
      // would have settled or been in flight, and a read issued
      // before the mutation's commit predates the new order.
      const refetchBaselineB = ledgerB.myWorkGets

      const reorder = await postPersonalReorder(
        pageA,
        movedItem.id,
        'todo',
        anchorItem.id,
      )

      // The mutation was accepted and committed server-side.
      expect(reorder.status).toBe(200)
      expect(reorder.body.id).toBe(movedItem.id)
      // No status change: the response still reports the same
      // concrete project-local status definition.
      expect(reorder.body.statusDefinitionId).toBe(
        movedItem.statusDefinitionId,
      )

      // The personal API read-back (canonical
      // GET /api/me/work-items/) shows the NEW PERSISTED order.
      const afterPayload = await fetchMyWorkPayload(pageA)
      expect(
        afterPayload
          .map((i) => i.id)
          .sort((a, b) => a - b),
        'The move must not add or remove any personal Work Item.',
      ).toEqual(
        payload
          .map((i) => i.id)
          .sort((a, b) => a - b),
      )

      const afterTodoOrder = columnRenderOrder(
        afterPayload.filter(
          (i) => i.statusCategory === 'todo',
        ),
      )
      const movedAfter = afterPayload.find(
        (i) => i.id === movedItem.id,
      )!
      const anchorAfter = afterPayload.find(
        (i) => i.id === anchorItem.id,
      )!

      // The Work Item stays in the Todo category.
      expect(movedAfter.statusCategory).toBe('todo')
      expect(anchorAfter.statusCategory).toBe('todo')
      expect(movedAfter.statusDefinitionId).toBe(
        movedItem.statusDefinitionId,
      )

      // Both cards now carry EXPLICIT personal positions, and
      // the moved card is persisted immediately before the
      // anchor (the new order is server state, not client state).
      expect(movedAfter.myWorkBoardPosition).not.toBeNull()
      expect(anchorAfter.myWorkBoardPosition).not.toBeNull()
      expect(
        movedAfter.myWorkBoardPosition,
      ).toBeLessThan(anchorAfter.myWorkBoardPosition as number)

      const anchorIndexAfter = afterTodoOrder.findIndex(
        (i) => i.id === anchorItem.id,
      )
      expect(
        afterTodoOrder[anchorIndexAfter - 1]?.id,
        'The moved card must be persisted immediately before the anchor.',
      ).toBe(movedItem.id)

      // Every OTHER card of the column keeps its relative order
      // (the move only repositioned the pair).
      const otherIds = (
        column: readonly PersonalWorkItemDto[],
      ) =>
        column
          .filter(
            (i) =>
              i.id !== movedItem.id && i.id !== anchorItem.id,
          )
          .map((i) => i.id)
      expect(otherIds(afterTodoOrder)).toEqual(
        otherIds(
          columnRenderOrder(
            payload.filter(
              (i) => i.statusCategory === 'todo',
            ),
          ),
        ),
      )

      // The sorting is PERSONAL: neither tab performed an
      // ordinary Project Board reorder, a status-only transition,
      // or a status-changing PATCH.
      expect(ledgerA.ordinaryMutations).toBe(0)
      expect(ledgerB.ordinaryMutations).toBe(0)

      // The new VISIBLE order: the pair swapped, the rest of the
      // column keeps its relative order.
      const newVisibleTitles = [
        movedItem.title,
        anchorItem.title,
        ...visibleTitles.slice(2),
      ]

      // ============================================================
      // 4. Tab B updates itself automatically: no reload, no
      //    navigation, no user action, no skeleton swap.
      // ============================================================
      await expect
        .poll(() => todoColumnTitles(pageB), { timeout: 15_000 })
        .toEqual(newVisibleTitles)

      // The update came through a REAL authoritative refetch on
      // B — at least one canonical personal read beyond the
      // pre-mutation baseline captured after B's startup reads had
      // settled (the event carries no data; the board re-rendered
      // from a new server payload — and a read that predates the
      // mutation's commit cannot carry the new order, so this is
      // the event-triggered revalidation).
      await expect
        .poll(() => ledgerB.myWorkGets, { timeout: 15_000 })
        .toBeGreaterThan(refetchBaselineB)

      // B stayed on the same document (no reload / navigation):
      await expect(pageB.locator('html')).toHaveAttribute(
        'data-rt-no-reload',
        '1',
      )

      // ...and the loaded board never flipped into the loading
      // skeleton shell (the revalidation is silent):
      await expect(
        pageB.locator('[data-board-column="todo"]'),
      ).toHaveAttribute('data-rt-node-identity', '1')
      await expect(
        pageB.locator('[data-my-work-board-skeleton="true"]'),
      ).toHaveCount(0)

      // The stream stayed connected (no degraded mode on B), and
      // B never left /my-work:
      await expect(
        pageB.getByText('Sync paused — reconnecting'),
      ).toHaveCount(0)
      await expect(pageB).toHaveURL(/\/my-work$/)

      // B kept its Board selection and its filters:
      await expect(
        pageB
          .getByRole('group', { name: 'My Work view' })
          .getByRole('button', { name: 'Board' }),
      ).toHaveAttribute('aria-pressed', 'true')
      await expect(
        pageB.getByRole('button', {
          name: 'Filter, 1 active category',
        }),
      ).toBeVisible()
      await expect(
        pageB.locator(
          `span[title="PJ: ${DRAFT_PROJECT}"]`,
        ),
      ).toBeVisible()
      await expect(
        pageB.locator(
          `span[title="PJ: ${ROBOT_PROJECT}"]`,
        ),
      ).toBeVisible()

      // Tab A (the mutating tab) renders the same new order: the
      // stream's own my_work_changed echo triggers the canonical
      // SILENT revalidation on A as well (the page itself never
      // performed the move) — and A stayed mounted too, with no
      // skeleton swap:
      await expect
        .poll(() => todoColumnTitles(pageA))
        .toEqual(newVisibleTitles)
      await expect(pageA.locator('html')).toHaveAttribute(
        'data-rt-no-reload',
        '1',
      )
      await expect(
        pageA.locator('[data-board-column="todo"]'),
      ).toHaveAttribute('data-rt-node-identity', '1')

      // Exactly ONE SSE stream per tab across the whole test
      // (the real connections — no duplicate, no reconnect):
      expect(ledgerA.sseResponses).toHaveLength(1)
      expect(ledgerB.sseResponses).toHaveLength(1)

      // ============================================================
      // 5. Persisted preferences untouched: the realtime update
      //    neither changes ViewMode nor filters, and neither tab
      //    wrote a single preference PATCH after the setup.
      // ============================================================
      expect(ledgerA.preferencePatches).toBe(0)
      expect(ledgerB.preferencePatches).toBe(0)
      const finalPrefs = await getMyWorkPreferences(pageA)
      expect(
        sameMyWorkPreferences(baselinePrefs, finalPrefs),
        `Realtime update must not change the persisted My Work preferences.\n  baseline: ${JSON.stringify(baselinePrefs)}\n  final: ${JSON.stringify(finalPrefs)}`,
      ).toBe(true)

      // Visual evidence for the host-terminal run: the
      // auto-updated second tab.
      await pageB.screenshot({
        path: testInfo.outputPath(
          'realtime-my-work-updated-tab.png',
        ),
      })
    } finally {
      await context.close()
    }
  },
)
