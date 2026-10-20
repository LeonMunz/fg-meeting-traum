import {
  expect,
  test,
  type Page,
  type Response,
} from '@playwright/test'

import {
  login,
  openProject,
  openProjects,
} from './helpers'

// RT-06A — cross-user Project Board realtime acceptance (two real
// browser sessions).
//
// Proves the full production chain in real browsers:
//
//   user A (alex) drags a card on the Project Board
//     -> canonical backend mutation (persisted status/position)
//     -> PostgreSQL NOTIFY at commit
//     -> the authenticated SSE stream (GET /api/work-items/events/)
//     -> user B's (chris) native EventSource client
//     -> one authoritative, SILENT refetch on B
//     -> B's already-open Board shows the new state
//
// with NO page.reload(), no navigation, and no explicit refetch on B,
// and NO synthetic SSE events (the only event source is the real
// product chain above).
//
// Proven properties:
// - A and B are really different authenticated users (/api/auth/me/).
// - Both demonstrably have access to the SAME project (B added as a
//   member through the normal product flow; B's board renders it).
// - The mutation is persisted server-side (A's reload re-renders it).
// - B receives the new state automatically (rendered state + the real
//   board refetch + exactly one authenticated SSE stream).
// - B's Board never flips into the loading skeleton shell and the
//   document is never replaced (no reload/navigation).
// - B never receives data of a foreign project (exact board content,
//   the foreign card never renders, chris gets 404 on the foreign
//   project API, and the foreign mutation triggers no refetch on B).
//
// Test isolation: two independent BrowserContexts (independent Django
// session cookies), dedicated Projects created through the normal
// product UI inside the isolated fg_e2e schema (reset on every E2E
// run), and no waiting via arbitrary sleeps — every step waits on
// observable product state (Playwright assertions).

const MAIN_PROJECT_NAME = 'E2E Realtime Board Project'
const FOREIGN_PROJECT_NAME =
  'E2E Realtime Foreign Project'
const CARD_MOVING = 'RT Board Task One'
const CARD_STATIC = 'RT Board Task Two'
const FOREIGN_CARD = 'RT Foreign Card'

// Wide enough that all four Board columns stay visible next to each
// other, so the drag source and the drop target are on-screen at
// once (no horizontal board scroll needed mid-drag).
const VIEWPORT = { width: 1920, height: 1000 }

/** The visible order of card titles inside one Board column. */
async function boardColumnTitles(
  page: Page,
  status: string,
): Promise<string[]> {
  const column = page.locator(
    `[data-board-column="${status}"]`,
  )
  const cards = column.getByRole('button', {
    name: /^Open /,
  })
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

/** Create a Project through the normal product dialog. */
async function createProject(
  page: Page,
  projectName: string,
): Promise<void> {
  await page
    .getByRole('button', { name: /New project/ })
    .click()

  const dialog = page.getByRole('dialog', {
    name: 'Create project',
  })

  await dialog.getByLabel('Project name').fill(projectName)

  await dialog
    .getByRole('button', { name: /Create project/ })
    .click()

  await expect(
    page.getByText(projectName, { exact: true }),
  ).toBeVisible()
}

/** Create a Work Item through the normal product dialog. */
async function createWorkItem(
  page: Page,
  title: string,
): Promise<void> {
  await page
    .getByRole('button', { name: /New work item/ })
    .click()

  const dialog = page.getByRole('dialog', {
    name: 'New work item',
  })

  await dialog.getByLabel('Title').fill(title)

  await dialog
    .getByRole('button', { name: /Create work item/ })
    .click()

  await expect(dialog).not.toBeVisible()
}

/**
 * Add a Project member through the normal product flow (Members
 * tab -> Add member dialog). The caller must be on the Members tab.
 */
async function addProjectMember(
  page: Page,
  username: string,
): Promise<void> {
  await page
    .getByRole('button', { name: /Add member/ })
    .click()

  const dialog = page.getByRole('dialog', {
    name: 'Add project member',
  })

  await expect(dialog).toBeVisible()

  await dialog.getByLabel('Select person').fill(username)

  await dialog
    .getByRole('button')
    .filter({ hasText: `@${username}` })
    .click()

  await dialog
    .getByRole('button', { name: /Add member/ })
    .click()

  await expect(dialog).not.toBeVisible()

  await expect(
    page.getByText(`@${username}`, { exact: true }),
  ).toBeVisible()
}

/**
 * Drag a Board card into the center of another status column with a
 * real mouse gesture (native HTML5 drag-and-drop needs the drag
 * threshold + stepped dragover events; a single jump is not
 * recognized by Chromium).
 */
async function dragCardToColumn(
  page: Page,
  cardTitle: string,
  targetColumn: string,
): Promise<void> {
  const card = page.getByRole('button', {
    name: `Open ${cardTitle}`,
  })
  const column = page.locator(
    `[data-board-column="${targetColumn}"]`,
  )

  await card.scrollIntoViewIfNeeded()
  await column.scrollIntoViewIfNeeded()

  const cardBox = await card.boundingBox()
  const columnBox = await column.boundingBox()

  if (!cardBox || !columnBox) {
    throw new Error(
      `Drag geometry not found for "${cardTitle}" ` +
        `-> column "${targetColumn}".`,
    )
  }

  await page.mouse.move(
    cardBox.x + cardBox.width / 2,
    cardBox.y + cardBox.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(
    columnBox.x + columnBox.width / 2,
    columnBox.y + columnBox.height / 2,
    { steps: 24 },
  )
  await page.mouse.up()
}

/**
 * The foreign-project mutation as a real, authorized, canonical
 * API mutation through the browser's OWN authenticated session
 * (A's Django session cookie + CSRF — the same request shape the
 * Board's drag-and-drop sends; no test backdoor, no synthetic
 * event). It resolves the Review target exactly the way the UI
 * does (first ACTIVE definition of the target category by
 * configured order, stable id tie-break), sends
 * POST /api/work-items/{id}/reorder/ for a drop into the empty
 * Review column, and then proves the PERSISTED result by reading
 * the foreign project's own Work Items API back.
 *
 * This replaces the second UI drag. The cross-user realtime
 * acceptance is carried by the first UI drag (unchanged); the
 * foreign-project isolation acceptance is defined by a real,
 * committed mutation and its broadcast, and the synthetic HTML5
 * drag against a freshly-mounted Board is an unstable gesture
 * (Chromium intermittently does not start the native drag), not
 * part of what this test proves.
 */
async function reorderForeignCardViaApi(
  page: Page,
  foreignProjectId: number,
): Promise<void> {
  const result = await page.evaluate(
    async ({
      projectId,
      cardTitle,
    }: {
      projectId: number
      cardTitle: string
    }) => {
      // CSRF exactly like the app's authenticated fetches: the
      // rotating csrftoken cookie, established through the
      // canonical endpoint when absent.
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

      const listUrl = `/api/projects/${projectId}/work-items/`
      const itemsRes = await fetch(listUrl, {
        credentials: 'same-origin',
      })

      if (!itemsRes.ok) {
        throw new Error(
          `Foreign Work Items read failed: ${itemsRes.status}`,
        )
      }

      const items = (await itemsRes.json()) as Array<{
        id: number
        title: string
        statusDefinitionId: number | null
      }>

      const card = items.find((item) => item.title === cardTitle)

      if (!card) {
        throw new Error(
          `Foreign card "${cardTitle}" not found.`,
        )
      }

      const configRes = await fetch(
        `/api/projects/${projectId}/work-item-configuration/`,
        { credentials: 'same-origin' },
      )

      if (!configRes.ok) {
        throw new Error(
          `Foreign configuration read failed: ${configRes.status}`,
        )
      }

      const config = (await configRes.json()) as {
        statuses: Array<{
          id: number
          category: string
          order: number
          active: boolean
        }>
      }

      // Precondition: the card currently sits in the Todo
      // category (where the original UI drag started).
      const todoDefinitionIds = new Set(
        config.statuses
          .filter((s) => s.active && s.category === 'todo')
          .map((s) => s.id),
      )

      if (
        card.statusDefinitionId === null ||
        !todoDefinitionIds.has(card.statusDefinitionId)
      ) {
        throw new Error(
          'Precondition failed: the foreign card is not in the ' +
            'Todo category.',
        )
      }

      // The Board's cross-column drop targets the first ACTIVE
      // definition of the target category by configured order
      // (stable id tie-break) — mirror that resolution exactly.
      let reviewDefinition: {
        id: number
        order: number
      } | null = null

      for (const candidate of config.statuses) {
        if (!candidate.active || candidate.category !== 'review') {
          continue
        }

        if (
          reviewDefinition === null ||
          candidate.order < reviewDefinition.order ||
          (candidate.order === reviewDefinition.order &&
            candidate.id < reviewDefinition.id)
        ) {
          reviewDefinition = {
            id: candidate.id,
            order: candidate.order,
          }
        }
      }

      if (reviewDefinition === null) {
        throw new Error(
          'No active Review status definition in the foreign ' +
            'project.',
        )
      }

      // The canonical Board-drop request for a drop into the
      // (empty) Review column: target StatusDefinition + null
      // insertion anchor (end of the column) — the SAME endpoint
      // and payload the UI drag sends.
      const reorderRes = await fetch(
        `/api/work-items/${card.id}/reorder/`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-CSRFToken': csrf ?? '',
          },
          body: JSON.stringify({
            statusDefinitionId: reviewDefinition.id,
            beforeWorkItemId: null,
          }),
        },
      )

      const updated = (await reorderRes.json()) as {
        statusDefinitionId?: number | null
      }

      // Authoritative persistence read-back through the foreign
      // project's own Work Items API.
      const afterRes = await fetch(listUrl, {
        credentials: 'same-origin',
      })

      if (!afterRes.ok) {
        throw new Error(
          `Foreign Work Items re-read failed: ${afterRes.status}`,
        )
      }

      const after = (await afterRes.json()) as Array<{
        id: number
        statusDefinitionId: number | null
        boardPosition: number | null
      }>

      const afterCard = after.find((item) => item.id === card.id)

      return {
        reorderStatus: reorderRes.status,
        updatedStatusDefinitionId:
          updated.statusDefinitionId ?? null,
        afterStatusDefinitionId:
          afterCard?.statusDefinitionId ?? null,
        afterBoardPosition: afterCard?.boardPosition ?? null,
        reviewDefinitionId: reviewDefinition.id,
      }
    },
    {
      projectId: foreignProjectId,
      cardTitle: FOREIGN_CARD,
    },
  )

  expect(result.reorderStatus).toBe(200)
  expect(result.updatedStatusDefinitionId).toBe(
    result.reviewDefinitionId,
  )
  // The mutation is PERSISTED server-side in the foreign project:
  // the card now carries the Review StatusDefinition and the
  // server-normalized column position (it is the only card of the
  // foreign project's Review column).
  expect(result.afterStatusDefinitionId).toBe(
    result.reviewDefinitionId,
  )
  expect(result.afterBoardPosition).toBe(1)
}

/**
 * The username of the browser's OWN authenticated session — the
 * server-derived identity (the same endpoint the app uses to recover
 * its session state), not a client-side label.
 */
async function currentUsername(
  page: Page,
): Promise<string> {
  const me = await page.evaluate(async () => {
    const res = await fetch('/api/auth/me/', {
      credentials: 'same-origin',
    })
    return { status: res.status, data: await res.json() }
  })

  expect(me.status).toBe(200)
  return me.data.username as string
}

/** The numeric Project id from a Project detail page URL. */
function projectIdFromUrl(page: Page): number {
  const match = page
    .url()
    .match(/\/projects\/(\d+)/)

  if (!match) {
    throw new Error(`No project id in URL: ${page.url()}`)
  }

  return Number(match[1])
}

test(
  'Project Board realtime: a drag by user A appears on user B\'s ' +
    'already-open Board automatically — without reload, skeleton ' +
    'swap, or foreign project data',
  async ({ browser }, testInfo) => {
    // This test drives two complete browser sessions (two logins,
    // two project setups, two live SSE streams) - give it an
    // explicit, larger wall-clock budget than the suite default
    // (still a cap, not a wait).
    testInfo.setTimeout(90_000)

    // Two independent BrowserContexts = two independent Django
    // sessions (session cookies never cross contexts), and two
    // independent SSE streams.
    const contextA = await browser.newContext({
      viewport: VIEWPORT,
    })
    const contextB = await browser.newContext({
      viewport: VIEWPORT,
    })
    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()

    try {
      // ============================================================
      // Setup: user A (alex) builds the fixtures through the normal
      // product UI.
      // ============================================================
      await login(pageA, 'alex')
      expect(await currentUsername(pageA)).toBe('alex')
      await openProjects(pageA)

      // Foreign project first: chris receives NO membership in it
      // (used later for the no-foreign-data check).
      await createProject(pageA, FOREIGN_PROJECT_NAME)
      await openProject(pageA, FOREIGN_PROJECT_NAME)
      const foreignProjectId = projectIdFromUrl(pageA)
      await createWorkItem(pageA, FOREIGN_CARD)
      await expect
        .poll(() => boardColumnTitles(pageA, 'todo'))
        .toEqual([FOREIGN_CARD])

      // Main project: alex = owner (creator), chris = member (added
      // below through the Members tab).
      await openProjects(pageA)
      await createProject(pageA, MAIN_PROJECT_NAME)
      await openProject(pageA, MAIN_PROJECT_NAME)
      const projectId = projectIdFromUrl(pageA)
      expect(projectId).not.toBe(foreignProjectId)

      await pageA
        .getByRole('link', { name: 'Members', exact: true })
        .click()
      await addProjectMember(pageA, 'chris')
      await pageA
        .getByRole('link', { name: 'Work Items', exact: true })
        .click()

      await createWorkItem(pageA, CARD_MOVING)
      await createWorkItem(pageA, CARD_STATIC)

      await expect
        .poll(() => boardColumnTitles(pageA, 'todo'))
        .toEqual([CARD_MOVING, CARD_STATIC])

      // ============================================================
      // User B (chris) opens the SAME Board in the second context.
      // ============================================================
      await login(pageB, 'chris')
      expect(await currentUsername(pageB)).toBe('chris')

      // Network evidence collectors on B (attached BEFORE the
      // navigation so every request of this page is observed):
      //  - every authoritative Board read (GET of the Project's
      //    Work Items),
      //  - every SSE stream response.
      const boardFetchUrl = `/api/projects/${projectId}/work-items/`
      let boardFetchCount = 0
      const sseResponses: Response[] = []
      pageB.on('response', (response) => {
        const url = response.url()
        if (url.includes(boardFetchUrl)) {
          boardFetchCount += 1
        }
        if (url.includes('/api/work-items/events/')) {
          sseResponses.push(response)
        }
      })

      // B's real SSE stream: the EventSource request must be
      // answered 200 text/event-stream by the authenticated product
      // endpoint (an unauthenticated request receives 401 before any
      // stream byte — so a 200 here is chris's own session).
      const sseResponsePromise = pageB.waitForResponse(
        (response) =>
          response
            .url()
            .includes('/api/work-items/events/'),
        { timeout: 30_000 },
      )

      // Deep link straight into the Board (chris's membership makes
      // the Project readable); no sidebar group state involved.
      await pageB.goto(`/projects/${projectId}/work-items`)

      const sseResponse = await sseResponsePromise
      expect(sseResponse.status()).toBe(200)
      expect(
        sseResponse.headers()['content-type'],
      ).toContain('text/event-stream')

      // B sees the starting state of the SAME project: both cards
      // in Todo in creation order, Review empty.
      await expect
        .poll(() => boardColumnTitles(pageB, 'todo'), {
          timeout: 15_000,
        })
        .toEqual([CARD_MOVING, CARD_STATIC])
      await expect
        .poll(() => boardColumnTitles(pageB, 'review'))
        .toEqual([])

      // B's stream is healthy: no degraded-mode indicator.
      await expect(
        pageB.getByText('Sync paused — reconnecting'),
      ).toHaveCount(0)

      // Mount / no-swap evidence, checked again after the update:
      //  1. a full page load or navigation would replace <html> and
      //     lose the marker -> proves B stayed on the same document;
      //  2. Board column nodes only exist in the LOADED panel: a
      //     loading-skeleton swap would unmount and recreate them,
      //     losing the marker -> proves the silent revalidation
      //     never flips the panel into the skeleton shell.
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

      // ============================================================
      // User A performs the real canonical Board mutation: drag
      // CARD_MOVING from Todo to Review (a status change with a
      // changed persisted position through the product's own
      // drag-and-drop -> POST /api/work-items/{id}/reorder/ ->
      // commit + NOTIFY).
      // ============================================================
      const baselineBoardFetchCount = boardFetchCount

      await dragCardToColumn(pageA, CARD_MOVING, 'review')

      // A's own canonical revalidation shows the card in Review —
      // the mutation was accepted and committed server-side.
      await expect
        .poll(() => boardColumnTitles(pageA, 'review'), {
          timeout: 15_000,
        })
        .toEqual([CARD_MOVING])

      // ============================================================
      // B receives the new state automatically: no page.reload(),
      // no navigation, no explicit refetch anywhere on B.
      // ============================================================
      await expect
        .poll(() => boardColumnTitles(pageB, 'review'), {
          timeout: 15_000,
        })
        .toEqual([CARD_MOVING])
      await expect
        .poll(() => boardColumnTitles(pageB, 'todo'), {
          timeout: 15_000,
        })
        .toEqual([CARD_STATIC])

      // B stayed on the same document (no reload / navigation):
      await expect(
        pageB.locator('html'),
      ).toHaveAttribute('data-rt-no-reload', '1')

      // ...and the loaded Board never flipped into the loading
      // skeleton shell (the revalidation is silent):
      await expect(
        pageB.locator('[data-board-column="todo"]'),
      ).toHaveAttribute('data-rt-node-identity', '1')

      // The stream stayed connected (no degraded mode on B):
      await expect(
        pageB.getByText('Sync paused — reconnecting'),
      ).toHaveCount(0)

      // And the update came through a REAL authoritative refetch of
      // this Project's Work Items on B (the event carries no data —
      // the board re-rendered from a new server payload):
      expect(boardFetchCount).toBeGreaterThanOrEqual(
        baselineBoardFetchCount + 1,
      )

      // ============================================================
      // Persistence: the mutation is server-side state, not just
      // client state. (A's context only — B is untouched here.)
      // ============================================================
      await pageA.reload()
      await expect
        .poll(() => boardColumnTitles(pageA, 'review'), {
          timeout: 15_000,
        })
        .toEqual([CARD_MOVING])
      await expect
        .poll(() => boardColumnTitles(pageA, 'todo'))
        .toEqual([CARD_STATIC])

      // ============================================================
      // No foreign Project data reaches B: A now mutates the
      // FOREIGN project (chris has no membership in it) with the
      // SAME canonical request the Board drag would send (POST
      // /api/work-items/{id}/reorder/ through A's own browser
      // session) — see reorderForeignCardViaApi for why this is
      // an authorized API mutation instead of a second synthetic
      // UI drag. B's board must not change at all and B must not
      // be able to read the foreign project at all.
      // ============================================================
      const fetchCountAfterMainUpdate = boardFetchCount

      await openProjects(pageA)
      await openProject(pageA, FOREIGN_PROJECT_NAME)
      await reorderForeignCardViaApi(pageA, foreignProjectId)

      // B's board still shows EXACTLY the main project's state —
      // the foreign card never rendered on B:
      await expect
        .poll(() => boardColumnTitles(pageB, 'review'))
        .toEqual([CARD_MOVING])
      await expect
        .poll(() => boardColumnTitles(pageB, 'todo'))
        .toEqual([CARD_STATIC])
      await expect(
        pageB.getByText(FOREIGN_CARD, { exact: true }),
      ).toHaveCount(0)

      // chris cannot read the foreign project at all (404 — no
      // membership, no existence leak):
      const foreignStatus = await pageB.evaluate(
        async (url) => {
          const res = await fetch(url, {
            credentials: 'same-origin',
          })
          return res.status
        },
        `/api/projects/${foreignProjectId}/work-items/`,
      )
      expect(foreignStatus).toBe(404)

      // The foreign mutation triggered no Board refetch on B:
      expect(boardFetchCount).toBe(fetchCountAfterMainUpdate)

      // Exactly one SSE stream for B across the whole test (the
      // real connection — no duplicate, no reconnect):
      expect(sseResponses).toHaveLength(1)
    } finally {
      await contextA.close()
      await contextB.close()
    }
  },
)
