import {
  expect,
  test,
  type Page,
  type Response,
} from '@playwright/test'

import {
  displayNameFor,
  login,
  userMenuTrigger,
} from './helpers'
import {
  expectMyWorkReady,
  getMyWorkPreferences,
  getProjectIdInGroup,
  sameMyWorkPreferences,
  setMyWorkPreferences,
  type MyWorkPreferencesSnapshot,
} from './my-work-helpers'

/**
 * RT-06C1 — native EventSource reconnection browser acceptance
 * (one interrupted context, one live mutation actor).
 *
 * Proves the production RC-1 / RC-5 chain in a real browser:
 *
 *   context B (observed My Work surface) has its live SSE
 *   connection severed by the E2E-only disconnect harness of
 *   vite.e2e.config.ts (a genuine REGULAR connection-level
 *   interruption on B's session ONLY — the application servers and
 *   the database keep running; context A and the foreign session C
 *   stay fully online)
 *     -> the in-flight SSE stream is severed (the client socket is
 *        torn down without any response: no HTTP status, no
 *        synthetic frame)
 *     -> the native EventSource enters its reconnection loop
 *        (readyState CONNECTING, native error events, native retry
 *        GETs for /api/work-items/events/)
 *     -> the RT-04A controller takes the RC-1 branch: keep the
 *        SAME instance, schedule no client-side timer, issue no
 *        fresh auth check
 *     -> the surface degrades to "Sync paused — reconnecting"
 *        while the existing cards stay visible
 *   while B's session is on the harness's HOLD (every subsequent
 *   SSE attempt of B's session is accepted and kept PENDING with no
 *   response bytes — no terminal HTTP error, so the native
 *   EventSource stays in CONNECTING), context A (mutation actor,
 *   still online) commits a canonical personal reorder — B's
 *   stream misses the my_work_changed notification
 *   the harness release forwards B's pending attempt(s)
 *     -> the NATIVE reconnection of the SAME EventSource instance
 *        completes (no new construction, no fresh auth check,
 *        no controlled backoff wait)
 *     -> the server sends a fresh `open` handshake on the
 *        reconnected stream
 *     -> the RC-5 open-handshake revalidation issues one
 *        authoritative GET /api/me/work-items/ on B
 *     -> B's Board renders the reordered cards — without reload,
 *        navigation, loading-skeleton swap, or preference change
 *
 * Proven properties:
 * - The interruption is a connection-level (not a response-level)
 *   one and is observable: the stream request fails
 *   (requestfailed), the probe records CONNECTING error events on
 *   the live instance, the subdued sync-paused indicator appears,
 *   and the live instance never reaches the terminal CLOSED state
 *   (a terminal state would have meant the harness produced an
 *   HTTP status the EventSource could see — it produces none).
 * - The session isolation is observable: foreign session C (user
 *   chris, its own live SSE stream) and context A's ordinary API
 *   traffic stay untouched across the whole
 *   disconnect/hold/release window, and the harness control is
 *   fail-closed (exactly one live SSE connection per named
 *   session — the test asserts the control's 200 success and
 *   relies on its 409 refusal for unknown/ambiguous sessions).
 * - The recovery is the NATIVE tier, not the controlled terminal
 *   tier: transparent in-page instrumentation (injected via
 *   addInitScript; observation-only — it counts EventSource
 *   constructions, records readyState on native error events,
 *   records the server's named `open` handshake frames, and
 *   records close() calls, while delegating every construction to
 *   the REAL native EventSource constructor and returning the
 *   untouched native instance — it never replaces the instance
 *   with a mock, never suppresses or synthesizes stream events,
 *   and never alters the native reconnection behavior) proves:
 *   the construction count is UNCHANGED across the
 *   interruption/recovery, the reconnected handshake is delivered
 *   by the SAME instance that delivered the initial handshake, no
 *   error on the live instance ever carries readyState CLOSED,
 *   the live instance is never close()-ed (never dropped by RC-2),
 *   and context B issues NO GET /api/auth/me/ fresh check after
 *   its startup reads settled (the RC-4 terminal-tier gate).
 * - The missed mutation is adopted: the reorder commits
 *   server-side (canonical GET /api/me/work-items/ read-back on
 *   A shows explicit personal positions — the moved card
 *   immediately before the anchor, every other card's relative
 *   order unchanged), B still shows its EARLIER snapshot while
 *   disconnected (and settles no canonical read at all — there is
 *   no polling), and after the reconnected open handshake B
 *   performs
 *   a new authoritative canonical read and renders the new order.
 * - The interruption is not treated as authentication loss: no
 *   fresh auth check, no redirect to /login, the user menu still
 *   shows alex (the local session state survives), and the
 *   document stays mounted (document-level marker).
 * - The surface degrades and recovers in place: the sync-paused
 *   indicator appears and clears, the cards stay visible through
 *   the interruption, no loading-skeleton swap (column node
 *   identity), no reload/navigation (document marker), the Board
 *   selection and both Project filter chips persist, and the
 *   persisted preference is unchanged (no preference PATCH from
 *   B and the final server snapshot equals the baseline).
 *
 * Test isolation: THREE independent BrowserContexts (A: mutation
 * actor as alex; B: observed My Work surface as alex; C: foreign
 * user chris with its own live SSE stream — the isolation
 * witness), each with its own Django session (server-derived
 * identities verified in all three; distinct sessionid values in
 * A and B), the persisted My Work preference is established
 * SERVER-SIDE through the canonical helper before B renders, the
 * reorder anchors are DERIVED from the live canonical payload (the
 * spec never assumes a fresh-seed state and is independent of the
 * other specs' execution order), and every wait is on observable
 * wire or DOM state — the disconnect/hold/release window is opened
 * and closed by explicit harness control calls, never by arbitrary
 * sleeps.
 *
 * StrictMode note: the dev E2E server runs React in StrictMode,
 * so B's startup may construct a first EventSource that the
 * stream hook closes before its response arrives (the mount
 * effect's simulated unmount). All instance-level assertions are
 * therefore anchored on the instance that delivered the initial
 * `open` handshake (the live instance), and the "no new instance"
 * claim is BASELINE-RELATIVE (construction count at settled
 * startup vs. after the interruption/recovery), never an absolute
 * 1.
 */

/**
 * EventSource readyState CONNECTING (0) — the native
 * reconnection-in-flight state. Read as a named constant to keep
 * the assertions decoupled from the numeric literal.
 */
const EventSource_CONNECTING = 0

// Seeded cards (seed_dev + seed_e2e_scope): both assigned to alex,
// both in the `todo` semantic category.
const CARD_DRAFT = 'First Draft Complete'
const CARD_ROBOT = 'E2E Analyze robot data'

const DRAFT_GROUP = 'FG Example'
const DRAFT_PROJECT = 'Paper XYZ'
const ROBOT_GROUP = 'Robotics Lab'
const ROBOT_PROJECT = 'E2E Robot Study'

// Wide enough that all four global columns stay visible next to
// each other (the same convention the other realtime specs use).
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
 * The transparent in-page probe (see RECONNECT_PROBE_SCRIPT): one
 * record per observed fact, keyed by the instance id assigned at
 * construction.
 */
interface ProbeSnapshot {
  constructions: { instanceId: number; url: string }[]
  errors: { instanceId: number; readyState: number }[]
  handshakes: { instanceId: number; userId: number }[]
  closes: { instanceId: number }[]
}

const EMPTY_PROBE: ProbeSnapshot = {
  constructions: [],
  errors: [],
  handshakes: [],
  closes: [],
}

/**
 * Observation-only EventSource instrumentation, injected into
 * context B before any page script runs (addInitScript).
 *
 * The wrapper delegates EVERY construction to the real native
 * EventSource constructor and returns the untouched native
 * instance; it attaches observation listeners and records close()
 * calls. It never replaces the instance with a mock, never
 * suppresses or synthesizes events, and never alters the native
 * reconnection behavior — the only effect is the bookkeeping
 * object on window that the test reads.
 */
const RECONNECT_PROBE_SCRIPT = `
(() => {
  if (window.__rtReconnectProbe) {
    return;
  }
  const realEventSource = window.EventSource;
  const probe = {
    constructions: [],
    errors: [],
    handshakes: [],
    closes: [],
  };
  let nextInstanceId = 1;
  window.__rtReconnectProbe = probe;

  function observedEventSource(url, options) {
    const instanceId = nextInstanceId;
    nextInstanceId += 1;
    probe.constructions.push({
      instanceId: instanceId,
      url: String(url),
    });
    const source = new realEventSource(url, options);
    source.addEventListener('error', () => {
      // Observation of the NATIVE error event: readyState is read
      // as the browser's own bookkeeping (CONNECTING = native
      // reconnection in flight, CLOSED = terminal).
      probe.errors.push({
        instanceId: instanceId,
        readyState: source.readyState,
      });
    });
    source.addEventListener('open', (event) => {
      // Only the server's named "open" handshake frame carries the
      // {userId} JSON payload; the native connection-open event
      // carries no data and is not a handshake.
      const raw =
        event && typeof event.data === 'string' ? event.data : '';
      if (raw === '') {
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          typeof parsed.userId === 'number'
        ) {
          probe.handshakes.push({
            instanceId: instanceId,
            userId: parsed.userId,
          });
        }
      } catch {
        // Not a JSON handshake frame — ignored.
      }
    });
    const realClose = source.close.bind(source);
    source.close = function close() {
      // Record the lifecycle fact, then delegate unchanged.
      probe.closes.push({ instanceId: instanceId });
      return realClose();
    };
    return source;
  }

  observedEventSource.prototype = realEventSource.prototype;
  observedEventSource.CONNECTING = realEventSource.CONNECTING;
  observedEventSource.OPEN = realEventSource.OPEN;
  observedEventSource.CLOSED = realEventSource.CLOSED;
  window.EventSource = observedEventSource;
})();
`

/** Read the probe's bookkeeping from the page (no network needed). */
async function readProbe(page: Page): Promise<ProbeSnapshot> {
  const snapshot = await page.evaluate(() => {
    const windowProbe = window as unknown as {
      __rtReconnectProbe?: ProbeSnapshot
    }
    return windowProbe.__rtReconnectProbe
  })
  return snapshot ?? EMPTY_PROBE
}

/**
 * Per-context wire ledger: everything this spec must PROVE on the
 * wire, observed while the page runs (identity-based matching, no
 * positional request counting).
 */
interface ContextLedger {
  /** Canonical personal My Work list READS (GET, exact pathname)
   *  that SETTLED with 200 (a failed read carries no state). */
  myWorkGets: number
  /** Canonical personal My Work list READS currently in flight
   *  (request sent, neither response nor failure observed) — the
   *  initialization barrier waits for this to settle to 0. */
  myWorkGetsInFlight: number
  /** Preference writes (PATCH /api/me/preferences/my-work/). */
  preferencePatches: number
  /** Fresh authentication checks (GET /api/auth/me/, settled). */
  authMeGets: number
  /** Canonical PERSONAL reorders (POST
   *  /api/me/work-items/{id}/reorder/). */
  personalReorders: number
  /** Ordinary Project-board mutations: POST
   *  /api/work-items/{id}/reorder/, POST
   *  /api/work-items/{id}/transition-status/, or
   *  PATCH /api/work-items/{id}/. */
  ordinaryMutations: number
  /** Every settled SSE stream response of this context's pages. */
  sseResponses: Response[]
  /** Failed SSE stream requests (the network-level view of the
   *  interruption: the severed in-flight stream; native retry
   *  attempts held by the harness stay PENDING and never fail). */
  sseRequestFailures: string[]
}

function observeLedger(page: Page): ContextLedger {
  const ledger: ContextLedger = {
    myWorkGets: 0,
    myWorkGetsInFlight: 0,
    preferencePatches: 0,
    authMeGets: 0,
    personalReorders: 0,
    ordinaryMutations: 0,
    sseResponses: [],
    sseRequestFailures: [],
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
      method === 'POST' &&
      /\/api\/me\/work-items\/\d+\/reorder\/$/.test(pathname)
    ) {
      ledger.personalReorders += 1
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
    const pathname = new URL(url).pathname
    const method = response.request().method()

    if (
      method === 'GET' &&
      pathname === '/api/me/work-items/'
    ) {
      ledger.myWorkGetsInFlight -= 1
      if (response.status() === 200) {
        ledger.myWorkGets += 1
      }
    }

    if (
      method === 'GET' &&
      pathname === '/api/auth/me/'
    ) {
      ledger.authMeGets += 1
    }

    if (pathname === '/api/work-items/events/') {
      ledger.sseResponses.push(response)
    }
  })

  page.on('requestfailed', (request) => {
    const url = request.url()
    const pathname = new URL(url).pathname

    if (pathname === '/api/me/work-items/') {
      ledger.myWorkGetsInFlight -= 1
    }

    if (pathname === '/api/work-items/events/') {
      ledger.sseRequestFailures.push(
        request.failure()?.errorText ?? 'unknown',
      )
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
 * the page's own session (the same endpoint the page renders from
 * — no second truth).
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
 * The SERVER-DERIVED identity of the page's own authenticated
 * session (the same endpoint the app recovers its session state
 * from), plus the user id the `open` handshake frame must carry.
 */
async function currentMe(
  page: Page,
): Promise<{ id: number; username: string }> {
  const me = await page.evaluate(async () => {
    const res = await fetch('/api/auth/me/', {
      credentials: 'same-origin',
    })
    return {
      status: res.status,
      data: (await res.json()) as {
        id: number
        username: string
      },
    }
  })

  expect(
    me.status,
    'The session identity read must succeed (the context is authenticated).',
  ).toBe(200)
  return me.data
}

interface PersonalReorderResult {
  status: number
  body: {
    id: number
    statusDefinitionId: number | null
  }
}

/**
 * One canonical personal My Work board move through the page's
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
  'My Work realtime: a network interruption is recovered by the ' +
    'native reconnection of the SAME EventSource instance — the ' +
    'missed personal reorder is adopted on the open-handshake ' +
    'refetch, without reload, skeleton swap, or preference change',
  async ({ browser, request }, testInfo) => {
    // This test drives three live contexts (one of them
    // disconnected and held by the harness), with a native
    // ~3 s reconnection interval — give it an explicit, larger
    // wall-clock budget than the suite default (still a cap, not
    // a wait).
    testInfo.setTimeout(120_000)

    // Context A: the mutation actor — its own independent Django
    // session, authenticated as alex. It never renders My Work;
    // it performs the canonical API reads and the personal
    // reorder through its own session.
    const contextA = await browser.newContext({
      viewport: VIEWPORT,
    })
    const pageA = await contextA.newPage()

    // Context B: the observed My Work surface — its own
    // independent Django session, also authenticated as alex. The
    // transparent observation probe is installed BEFORE any page
    // script runs (it is the only instrumentation this spec adds
    // to the browser).
    const contextB = await browser.newContext({
      viewport: VIEWPORT,
    })
    await contextB.addInitScript(RECONNECT_PROBE_SCRIPT)
    const pageB = await contextB.newPage()

    // Context C: the FOREIGN session — user chris with its own
    // independent Django session and its own live SSE stream. It
    // is the isolation witness: the whole
    // disconnect/hold/release window on B's session must leave
    // C's stream untouched.
    const contextC = await browser.newContext({
      viewport: VIEWPORT,
    })

    // The session ids the E2E-only disconnect harness (the
    // vite.e2e.config.ts SSE proxy, loopback-only) addresses. The
    // harness matches EXACTLY one live SSE connection per named
    // session and fails closed (409) otherwise.
    let sessionBId: string | null = null
    let sessionCId: string | null = null

    try {
      // ============================================================
      // 1. Two independent contexts, one user, a real connection.
      // ============================================================
      await login(pageA, 'alex')
      const meA = await currentMe(pageA)
      expect(meA.username).toBe('alex')

      // Wire ledger on B attached BEFORE its first navigation —
      // it only ever sees B's live page traffic (the server-side
      // preference setup below goes through A's context API
      // request context, not page traffic).
      const ledgerB = observeLedger(pageB)

      await login(pageB, 'alex')
      const meB = await currentMe(pageB)
      expect(meB.username).toBe('alex')
      // Same user, two INDEPENDENT sessions: each context holds
      // exactly one session cookie.
      expect(meB.id).toBe(meA.id)
      const sessionCookiesA = (await contextA.cookies()).filter(
        (cookie) => cookie.name === 'sessionid',
      )
      const sessionCookiesB = (await contextB.cookies()).filter(
        (cookie) => cookie.name === 'sessionid',
      )
      expect(sessionCookiesA).toHaveLength(1)
      expect(sessionCookiesB).toHaveLength(1)
      expect(sessionCookiesA[0].value).not.toBe(
        sessionCookiesB[0].value,
      )
      sessionBId = sessionCookiesB[0].value

      // Reproducible starting state, set SERVER-SIDE through the
      // existing preference helper BEFORE B renders My Work: the
      // Board view plus both relevant Projects as the active
      // Project filter (both seeded Todo cards stay visible). The
      // returned normalized snapshot is the authoritative
      // persisted baseline.
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

      // B opens My Work; its OWN SSE connection must be answered
      // 200 text/event-stream by the authenticated product
      // endpoint (an unauthenticated request receives 401 before
      // any stream byte).
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
      // response observed). The `open` handshake is the FIRST
      // frame of the stream body, so every canonical read counted
      // from now on postdates the connection.
      const sseSettledReadsBaselineB = ledgerB.myWorkGets

      // B renders the initial personal server state (persisted
      // Board view + both seeded cards visible).
      await expectMyWorkReady(pageB, {
        viewMode: 'board',
        visibleTitles: [CARD_DRAFT, CARD_ROBOT],
      })

      // ============================================================
      // 2. Reproducible starting order — derived from the
      //    canonical My Work payload (read through A's session),
      //    never guessed from a random DOM order.
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

      // B renders exactly the payload-derived order.
      await expect
        .poll(() => todoColumnTitles(pageB))
        .toEqual(visibleTitles)

      // Initialization barrier on B (event-based, NO fixed
      // request-count assumption): wait until ALL of B's startup
      // reads have settled, so the post-reconnect refetch is
      // cleanly separated from initialization traffic. B's
      // startup reads are (1) the initial load — run TWICE in
      // this dev-server E2E environment, because main.tsx mounts
      // the app in React StrictMode and StrictMode double-executes
      // mount effects in development — and (2) exactly one RC-5
      // open-handshake revalidation. The barrier waits on
      // observable wire events, not a count: at least one
      // canonical read SETTLES after the stream was established
      // (in StrictMode the second initial load's response may
      // settle in the same window and is counted harmlessly along
      // with it), and NO read is in flight.
      await expect
        .poll(
          () =>
            ledgerB.myWorkGets - sseSettledReadsBaselineB >= 1 &&
            ledgerB.myWorkGetsInFlight === 0,
          {
            timeout: 15_000,
            message:
              'B must settle its startup My Work reads (initial ' +
              'load — twice under React StrictMode in the dev ' +
              'E2E environment — plus the RC-5 open-handshake ' +
              'revalidation) before the interruption.',
          },
        )
        .toBe(true)

      // B's SSE connection is AUTHENTICATED and FUNCTIONING: the
      // probe observed the server's `open` handshake frame, and
      // it carries the server-verified own user id. (The native
      // connection-open event carries no data and is not counted
      // as a handshake.)
      const probeBaseline = await readProbe(pageB)
      expect(
        probeBaseline.handshakes.length,
        'B must have received the initial `open` handshake frame on its stream.',
      ).toBe(1)
      expect(
        probeBaseline.handshakes[0].userId,
        'The open handshake must carry the connected user\'s own id.',
      ).toBe(meA.id)

      // The LIVE instance: the one that delivered the initial
      // handshake (under StrictMode an earlier discarded instance
      // may have been constructed and closed before its response
      // arrived — all instance-level assertions are anchored on
      // this one).
      const survivingInstanceId =
        probeBaseline.handshakes[0].instanceId
      const constructionsBefore =
        probeBaseline.constructions.length
      expect(
        probeBaseline.constructions.some(
          (c) => c.instanceId === survivingInstanceId,
        ),
      ).toBe(true)
      expect(
        probeBaseline.closes.every(
          (c) => c.instanceId !== survivingInstanceId,
        ),
        'The live instance must not have been closed at startup.',
      ).toBe(true)
      const connectingErrorsBeforeDisconnect = probeBaseline.errors.filter(
        (e) =>
          e.instanceId === survivingInstanceId &&
          e.readyState === EventSource_CONNECTING,
      ).length

      // Mount / no-swap evidence on B, set while B renders the
      // starting state:
      //  1. a full page load or navigation would replace <html>
      //     and lose the marker;
      //  2. the Todo column node only exists in the LOADED board:
      //     a loading-skeleton swap would unmount and recreate it.
      await pageB.evaluate(() => {
        document.documentElement.setAttribute(
          'data-rt-no-reload',
          '1',
        )
      })
      await pageB
        .locator('[data-board-column="todo"]')
        .evaluate((el) =>
          el.setAttribute('data-rt-node-identity', '1'),
        )

      // The wire floor for the recovery proof: at settled startup
      // (barrier passed, handshake observed, no read in flight),
      // every canonical 200 read on B predates the interruption.
      // While B's session is on hold no read can settle at all —
      // so any canonical 200 read counted AFTER this point is
      // post-reconnection traffic.
      const readsBeforeInterruptionB = ledgerB.myWorkGets
      const authMeBaselineB = ledgerB.authMeGets
      // A startup record may already exist (under StrictMode the
      // discarded first instance's aborted GET fails at the
      // network level) — the interruption proof must be a GROWTH
      // beyond this baseline, never a non-empty count.
      const sseFailuresBeforeDisconnect = ledgerB.sseRequestFailures.length
      expect(ledgerB.sseResponses).toHaveLength(1)

      // ============================================================
      // 3. The interruption — a genuine REGULAR connection-level
      //    sever on B's session ONLY, through the E2E-only
      //    disconnect harness of vite.e2e.config.ts (loopback-only
      //    control endpoints on the E2E Vite server).
      //
      //    First: the foreign-session isolation witness — context
      //    C (user chris, its own session) establishes its own
      //    live, functioning SSE stream, so the whole
      //    disconnect/hold/release window can be proven to leave
      //    every OTHER session untouched.
      // ============================================================
      await contextC.addInitScript(RECONNECT_PROBE_SCRIPT)
      const pageC = await contextC.newPage()

      // Wire ledger on C attached BEFORE its first navigation.
      const ledgerC = observeLedger(pageC)

      await login(pageC, 'chris')
      const meC = await currentMe(pageC)
      expect(meC.username).toBe('chris')
      const sessionCookiesC = (await contextC.cookies()).filter(
        (cookie) => cookie.name === 'sessionid',
      )
      expect(sessionCookiesC).toHaveLength(1)
      expect(sessionCookiesC[0].value).not.toBe(sessionBId)
      sessionCId = sessionCookiesC[0].value

      // C opens My Work; its OWN SSE connection must be answered
      // 200 text/event-stream (the same authenticated product
      // endpoint as B's).
      const sseResponsePromiseC = pageC.waitForResponse(
        (response) =>
          response
            .url()
            .includes('/api/work-items/events/'),
        { timeout: 30_000 },
      )
      await pageC.goto('/my-work')
      const sseResponseC = await sseResponsePromiseC
      expect(sseResponseC.status()).toBe(200)
      expect(
        sseResponseC.headers()['content-type'],
      ).toContain('text/event-stream')

      // C's stream is AUTHENTICATED and FUNCTIONING: the probe
      // observed the server's `open` handshake frame, and it
      // carries chris's own server-verified user id.
      await expect
        .poll(
          async () => (await readProbe(pageC)).handshakes.length,
          {
            timeout: 15_000,
            message:
              'C must receive the initial `open` handshake ' +
              'frame on its own stream.',
          },
        )
        .toBe(1)
      const probeC0 = await readProbe(pageC)
      expect(probeC0.handshakes[0].userId).toBe(meC.id)
      const survivingInstanceIdC = probeC0.handshakes[0].instanceId
      // C's wire baseline (baseline-relative, like B's): the
      // isolation proof is that NOTHING about C's stream changes
      // across B's whole disconnect/hold/release window.
      const sseResponsesBaselineC = ledgerC.sseResponses.length
      const sseFailuresBaselineC = ledgerC.sseRequestFailures.length
      const probeErrorsBaselineC = probeC0.errors.length
      expect(sseResponsesBaselineC).toBe(1)

      // The harness severs B's ONE live SSE connection — a
      // connection-level interruption (the client socket is torn
      // down WITHOUT any response: no HTTP status, no synthetic
      // frame, so the native EventSource takes the RC-1
      // CONNECTING path and can never be driven into the terminal
      // CLOSED path) — and arms B's per-session HOLD: every
      // subsequent SSE attempt of B's session is accepted and
      // kept PENDING with no response bytes (in particular no
      // terminal HTTP error) until the explicit release below.
      // Context A, context C, and every ordinary API request
      // keep being served throughout.
      const disconnectResponse = await request.post(
        '/__e2e/realtime/disconnect',
        { data: { sessionId: sessionBId } },
      )
      expect(
        disconnectResponse.status(),
        'The harness disconnect must succeed: B\'s session has exactly one live SSE connection (the harness fails closed with 409 for unknown or ambiguous sessions).',
      ).toBe(200)

      // The degradation is OBSERVABLE: the subdued sync-paused
      // indicator appears (the stream was connected once, so the
      // product shows the degraded state — never a modal, toast,
      // or loading shell).
      await expect
        .poll(
          () =>
            pageB
              .getByText('Sync paused — reconnecting')
              .isVisible(),
          {
            timeout: 15_000,
            message:
              'B must show the subdued sync-paused indicator ' +
              'after its stream is severed.',
          },
        )
        .toBe(true)

      // The native EventSource entered its RECONNECTING state:
      // the probe recorded a native error event on the live
      // instance with readyState CONNECTING (the browser's own
      // bookkeeping — the RC-1 branch the controller takes for a
      // connection-level interruption).
      await expect
        .poll(
          async () => {
            const probe = await readProbe(pageB)
            const liveConnecting = probe.errors.filter(
              (e) =>
                e.instanceId === survivingInstanceId &&
                e.readyState === EventSource_CONNECTING,
            ).length
            return liveConnecting > connectingErrorsBeforeDisconnect
          },
          {
            timeout: 15_000,
            message:
              'The probe must record a CONNECTING-state error ' +
              'on the live EventSource instance while B\'s ' +
              'connection is severed (native reconnection in ' +
              'flight).',
          },
        )
        .toBe(true)

      // The interruption is observable on the wire too: the
      // in-flight stream request itself failed (severed in
      // flight by the harness; the native retry that follows is
      // held PENDING and does not fail).
      await expect
        .poll(
          () => ledgerB.sseRequestFailures.length,
          {
            timeout: 15_000,
            message:
              'B\'s in-flight SSE stream request must fail when ' +
              'the harness severs B\'s connection.',
          },
        )
        .toBeGreaterThan(sseFailuresBeforeDisconnect)

      // Degraded mode: the existing My Work cards stay visible in
      // their earlier order — no navigation, no loading-skeleton
      // replacement, the Board selection persists.
      const degradedTitles = await todoColumnTitles(pageB)
      expect(
        degradedTitles,
        'B must keep showing its earlier snapshot while its connection is severed.',
      ).toEqual(visibleTitles)
      await expect(
        pageB.locator('[data-my-work-board-skeleton="true"]'),
      ).toHaveCount(0)
      await expect(pageB.locator('html')).toHaveAttribute(
        'data-rt-no-reload',
        '1',
      )
      await expect(pageB).toHaveURL(/\/my-work$/)
      await expect(
        pageB
          .getByRole('group', { name: 'My Work view' })
          .getByRole('button', { name: 'Board' }),
      ).toHaveAttribute('aria-pressed', 'true')

      // Visual evidence for the host-terminal run: the degraded
      // surface (sync-paused line + still-visible cards).
      await pageB.screenshot({
        path: testInfo.outputPath(
          'realtime-native-reconnect-degraded.png',
        ),
      })

      // ============================================================
      // 4. While B is disconnected and on hold: context A
      //    performs the real canonical PERSONAL reorder and the
      //    mutation commits server-side — B's stream misses the
      //    notification.
      // ============================================================
      // A's ledger, attached right before the mutation: it must
      // show exactly the canonical personal reorder and no
      // ordinary Project Board mutation.
      const ledgerA = observeLedger(pageA)

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
      // GET /api/me/work-items/) shows the NEW PERSISTED order —
      // server state, not client state.
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
      // anchor.
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

      // A's mutation is purely the canonical PERSONAL reorder —
      // no ordinary Project Board reorder, no status-only
      // transition, no status-changing PATCH.
      expect(ledgerA.personalReorders).toBe(1)
      expect(ledgerA.ordinaryMutations).toBe(0)

      // B is still OFFLINE: it shows its EARLIER snapshot and
      // settled no canonical read at all (the stream is down,
      // the my_work_changed notification is missed, and the
      // product has no polling — the wire floor from step 3 is
      // still holding).
      expect(
        await todoColumnTitles(pageB),
        'B must not adopt the mutation before the reconnection.',
      ).toEqual(visibleTitles)
      expect(
        ledgerB.myWorkGets,
        'B must settle no canonical My Work read while offline.',
      ).toBe(readsBeforeInterruptionB)

      // Isolation (foreign session C, user chris): while B is
      // disconnected and on hold, C's stream is untouched — it
      // is still the SAME single original stream: no request
      // failure, no reconnection, no second stream, and no error
      // on C's live instance. (Context A's ordinary API traffic
      // is proven live by the mutation and the read-back above —
      // both answered while B's session was on hold.)
      expect(
        ledgerC.sseRequestFailures.length,
        'C\'s stream must suffer no request failure while B\'s session is on hold.',
      ).toBe(sseFailuresBaselineC)
      expect(
        ledgerC.sseResponses.length,
        'C must still be on its single original stream (no reconnection) while B\'s session is on hold.',
      ).toBe(sseResponsesBaselineC)
      const probeCMid = await readProbe(pageC)
      expect(
        probeCMid.errors.length,
        'C\'s live instance must record no error (no reconnection) while B\'s session is on hold.',
      ).toBe(probeErrorsBaselineC)
      expect(probeCMid.handshakes.length).toBe(1)
      await expect(pageC).toHaveURL(/\/my-work$/)

      // ============================================================
      // 5. Release B's hold — the NATIVE reconnection of the SAME
      //    EventSource instance must recover the surface.
      // ============================================================
      // The reconnected stream answers a NEW 200 text/event-stream
      // (registered before the release — the native retry cannot
      // precede it).
      const reconnectedSsePromise = pageB.waitForResponse(
        (response) =>
          response
            .url()
            .includes('/api/work-items/events/') &&
          response.status() === 200,
        { timeout: 30_000 },
      )
      // The release forwards B's pending SSE attempt(s) to
      // Django and clears the hold; the native connection
      // establishment proceeds normally — the REAL 200
      // text/event-stream and the REAL server open handshake flow
      // through (the browser never receives a synthetic frame or
      // an artificial authentication result).
      const releaseResponse = await request.post(
        '/__e2e/realtime/release',
        { data: { sessionId: sessionBId } },
      )
      expect(
        releaseResponse.status(),
        'The harness release must succeed: B\'s session is on hold.',
      ).toBe(200)
      const reconnectedSse = await reconnectedSsePromise
      expect(
        reconnectedSse.headers()['content-type'],
      ).toContain('text/event-stream')

      // The recovery is the NATIVE tier: the probe saw a SECOND
      // `open` handshake — delivered by the SAME instance that
      // delivered the first (the original live EventSource is
      // reused), with NO new construction across the whole
      // interruption/recovery cycle.
      await expect
        .poll(
          async () => {
            const probe = await readProbe(pageB)
            return {
              handshakes: probe.handshakes.length,
              constructions: probe.constructions.length,
              sameInstance:
                probe.handshakes.length >= 2 &&
                probe.handshakes[1].instanceId ===
                  survivingInstanceId,
            }
          },
          {
            timeout: 15_000,
            message:
              'The reconnected stream must deliver a second ' +
              '`open` handshake on the ORIGINAL EventSource ' +
              'instance, with no new EventSource construction ' +
              '(native reconnection, not a controlled ' +
              'reconnect).',
          },
        )
        .toEqual({
          handshakes: 2,
          constructions: constructionsBefore,
          sameInstance: true,
        })

      const probeRecovered = await readProbe(pageB)
      expect(
        probeRecovered.handshakes[1].userId,
        'The reconnected open handshake must carry the connected user\'s own id.',
      ).toBe(meA.id)

      // RC-5: the open surface authoritatively revalidates on the
      // successful (re)connection — B issues a NEW canonical
      // GET /api/me/work-items/ beyond the pre-interruption wire
      // floor (a read that predates the mutation's commit cannot
      // carry the new order, so this is the post-reconnect
      // revalidation).
      await expect
        .poll(() => ledgerB.myWorkGets, {
          timeout: 15_000,
          message:
            'B must perform a new authoritative canonical My ' +
            'Work read after the reconnected open handshake ' +
            '(RC-5 revalidation).',
        })
        .toBeGreaterThan(readsBeforeInterruptionB)

      // The new VISIBLE order: the pair swapped, the rest of the
      // column keeps its relative order — and B adopts it
      // AUTOMATICALLY, without reload or manual refresh.
      const newVisibleTitles = [
        movedItem.title,
        anchorItem.title,
        ...visibleTitles.slice(2),
      ]
      await expect
        .poll(() => todoColumnTitles(pageB), { timeout: 15_000 })
        .toEqual(newVisibleTitles)

      // The sync-paused indicator cleared: the stream is
      // connected again.
      await expect(
        pageB.getByText('Sync paused — reconnecting'),
      ).toHaveCount(0)

      // B stayed on the same document (no reload / navigation)
      // ...and the loaded board never flipped into the
      // loading skeleton shell (the revalidation is silent):
      await expect(pageB.locator('html')).toHaveAttribute(
        'data-rt-no-reload',
        '1',
      )
      await expect(
        pageB.locator('[data-board-column="todo"]'),
      ).toHaveAttribute('data-rt-node-identity', '1')
      await expect(
        pageB.locator('[data-my-work-board-skeleton="true"]'),
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
        pageB.locator(`span[title="PJ: ${DRAFT_PROJECT}"]`),
      ).toBeVisible()
      await expect(
        pageB.locator(`span[title="PJ: ${ROBOT_PROJECT}"]`),
      ).toBeVisible()

      // ============================================================
      // 6. The interruption was NOT treated as authentication
      //    loss, and the recovery was NOT the terminal tier.
      // ============================================================
      // No RC-4 fresh authentication check was issued by B after
      // its startup reads settled — the terminal-tier gate runs
      // only after a CLOSED failure, and the live instance never
      // reached one.
      expect(
        ledgerB.authMeGets,
        'B must issue no fresh /api/auth/me/ check for a regular network interruption (the RC-4 gate is terminal-tier only).',
      ).toBe(authMeBaselineB)
      // The local session state survived: the user menu still
      // shows alex (had the app reported an authentication loss,
      // the session would be cleared and the page redirected to
      // /login — the URL and document-marker assertions above
      // would have failed).
      await expect(
        userMenuTrigger(pageB, displayNameFor('alex')),
      ).toBeVisible()

      // The live instance never reached the terminal state and
      // was never dropped (RC-2 drops the closed instance before
      // constructing a replacement — neither happened): every
      // error the live instance recorded across the whole test
      // carries readyState CONNECTING, and it was never close()-ed.
      const liveErrors = probeRecovered.errors.filter(
        (e) => e.instanceId === survivingInstanceId,
      )
      expect(
        liveErrors.length,
        'The live instance must have recorded its reconnection errors.',
      ).toBeGreaterThanOrEqual(1)
      expect(
        liveErrors.every(
          (e) => e.readyState === EventSource_CONNECTING,
        ),
        `The live instance must never reach the terminal CLOSED state for a regular interruption (errors: ${JSON.stringify(liveErrors)}).`,
      ).toBe(true)
      expect(
        probeRecovered.closes.every(
          (c) => c.instanceId !== survivingInstanceId,
        ),
        'The live EventSource instance must never be close()-ed across the interruption/recovery.',
      ).toBe(true)

      // Exactly two settled SSE streams for B across the whole
      // test: the initial connection and the NATIVE reconnection
      // (no duplicate, no controlled reconnect stream).
      expect(ledgerB.sseResponses).toHaveLength(2)
      for (const response of ledgerB.sseResponses) {
        expect(response.status()).toBe(200)
        expect(
          response.headers()['content-type'],
        ).toContain('text/event-stream')
      }

      // Isolation (final): across B's whole disconnect/hold/
      // release window, foreign session C stayed on its single
      // original stream — untouched (no failure, no reconnection,
      // no second stream, no close of C's live instance), and its
      // page is still mounted.
      expect(
        ledgerC.sseRequestFailures.length,
        'C\'s stream must suffer no request failure across B\'s whole interruption window.',
      ).toBe(sseFailuresBaselineC)
      expect(
        ledgerC.sseResponses.length,
        'C must remain on its single original stream after B\'s recovery.',
      ).toBe(sseResponsesBaselineC)
      const probeCFinal = await readProbe(pageC)
      expect(
        probeCFinal.errors.length,
        'C\'s live instance must record no error across B\'s whole interruption window.',
      ).toBe(probeErrorsBaselineC)
      expect(probeCFinal.handshakes.length).toBe(1)
      expect(
        probeCFinal.closes.every(
          (c) => c.instanceId !== survivingInstanceIdC,
        ),
        'C\'s live stream instance must never be close()-ed.',
      ).toBe(true)
      await expect(pageC).toHaveURL(/\/my-work$/)

      // ============================================================
      // 7. Persisted preferences untouched: the interruption and
      //    the recovery neither change ViewMode nor filters, and
      //    B wrote no single preference PATCH.
      // ============================================================
      expect(ledgerB.preferencePatches).toBe(0)
      const finalPrefs = await getMyWorkPreferences(pageA)
      expect(
        sameMyWorkPreferences(baselinePrefs, finalPrefs),
        `Reconnection must not change the persisted My Work preferences.\n  baseline: ${JSON.stringify(baselinePrefs)}\n  final: ${JSON.stringify(finalPrefs)}`,
      ).toBe(true)

      // B itself performed no ordinary Project Board mutation:
      // the update arrived through the canonical refetch only.
      expect(ledgerB.ordinaryMutations).toBe(0)

      // Visual evidence for the host-terminal run: the recovered
      // Board showing the reordered cards.
      await pageB.screenshot({
        path: testInfo.outputPath(
          'realtime-native-reconnect-recovered.png',
        ),
      })
    } finally {
      // Teardown: explicitly release every held/tracked
      // connection of the two driven sessions (the context close
      // below closes the browser side; the reset is the
      // deterministic server-side release of the harness).
      if (sessionBId !== null) {
        await request
          .post('/__e2e/realtime/reset', {
            data: { sessionId: sessionBId },
          })
          .catch(() => {})
      }
      if (sessionCId !== null) {
        await request
          .post('/__e2e/realtime/reset', {
            data: { sessionId: sessionCId },
          })
          .catch(() => {})
      }
      await contextA.close()
      await contextB.close()
      await contextC.close()
    }
  },
)
