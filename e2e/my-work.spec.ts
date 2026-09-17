import {
  expect,
  type Page,
  test,
} from '@playwright/test'

import { login } from './helpers'

/**
 * Focused acceptance spec for the cross-project My Work
 * (`/my-work` over the canonical `GET /api/me/work-items/`).
 *
 * Seed data (seed_dev + seed_e2e_scope) assigns alex exactly two
 * Work Items across two Projects and two Research Groups:
 *  - "First Draft Complete" — Paper XYZ (FG Example), due
 *    2025-12-01 (overdue), concrete status "Todo" (category todo),
 *    concrete type "Milestone"
 *  - "E2E Analyze robot data" — E2E Robot Study (Robotics Lab),
 *    concrete status "Todo" (category todo), concrete type "Task"
 *
 * Both seeded items resolve to the `todo` semantic category, so in
 * the global Kanban they both sit in the Todo column (the other
 * three global columns render empty).
 *
 * The final test drags "First Draft Complete" into In progress and
 * therefore mutates the canonical seed data; it is deliberately the
 * LAST test in this file (the specs that run afterwards only assert
 * card visibility, never its category). The Playwright webServer
 * resets the E2E schema before the run, so the mutation never leaks
 * into a later run.
 *
 * That drag test proves the canonical wire contract: exactly one
 * `POST /api/work-items/{id}/transition-status/` carrying only the
 * concrete target `statusDefinitionId` (no boardPosition, no
 * status-changing PATCH, no reorder), followed by exactly one
 * authoritative `GET /api/me/work-items/` refetch.
 */

function expectNoHorizontalOverflow(page: Page) {
  return page
    .evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    )
    .then((overflow) => {
      expect(overflow).toBeLessThanOrEqual(0)
    })
}

test('My Work lists assigned Work Items across Projects and Research Groups', async ({ page }, testInfo) => {
  // Record the wire contract: the page must load from the one
  // canonical personal endpoint and must not fetch per-Project
  // configuration (status/context come from the payload).
  const myWorkRequestUrls: string[] = []
  const projectConfigRequestUrls: string[] = []
  page.on('request', (request) => {
    if (
      request.url().includes('/api/me/work-items/')
    ) {
      myWorkRequestUrls.push(request.url())
    }

    if (
      request
        .url()
        .includes('/work-item-configuration/')
    ) {
      projectConfigRequestUrls.push(
        request.url(),
      )
    }
  })

  await login(page, 'alex')
  await page.goto('/my-work')

  const firstDraftRow = page.getByRole(
    'button',
    { name: 'Open First Draft Complete' },
  )
  const robotRow = page.getByRole(
    'button',
    { name: 'Open E2E Analyze robot data' },
  )

  // Assigned items from two different Projects appear in the
  // same personal view.
  await expect(firstDraftRow).toBeVisible()
  await expect(robotRow).toBeVisible()

  // Cross-Project context on every card/row.
  await expect(
    firstDraftRow.getByText('Paper XYZ', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(
    robotRow.getByText('E2E Robot Study', {
      exact: true,
    }),
  ).toBeVisible()

  // Cross-Research-Group context on every card/row.
  await expect(
    firstDraftRow.getByText('FG Example', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(
    robotRow.getByText('Robotics Lab', {
      exact: true,
    }),
  ).toBeVisible()

  // Concrete project-local status name (the fixed semantic
  // category label must not replace it).
  await expect(
    firstDraftRow.getByText('Todo', { exact: true }),
  ).toBeVisible()
  await expect(
    robotRow.getByText('Todo', { exact: true }),
  ).toBeVisible()

  // Concrete project-local Work Item type name (display metadata
  // from the payload — different Projects show different type
  // names; never a hardcoded or inferred semantic kind).
  await expect(
    firstDraftRow.getByText('Milestone', { exact: true }),
  ).toBeVisible()
  await expect(
    robotRow.getByText('Task', { exact: true }),
  ).toBeVisible()

  // The seeded overdue due date renders with the established
  // attention convention.
  await expect(
    firstDraftRow.getByText(/d overdue/),
  ).toBeVisible()

  // One canonical personal request; no per-Project configuration
  // request to render status or context.
  expect(myWorkRequestUrls.length).toBeGreaterThanOrEqual(1)
  expect(
    myWorkRequestUrls.every(
      (url) => url === 'http://127.0.0.1:4173/api/me/work-items/',
    ),
  ).toBe(true)
  expect(projectConfigRequestUrls).toEqual([])

  await page.screenshot({
    path: testInfo.outputPath('my-work-default.png'),
    fullPage: true,
  })

  await expectNoHorizontalOverflow(page)
})

test('My Work opens in Kanban with the four global semantic columns', async ({ page }, testInfo) => {
  await login(page, 'alex')
  await page.goto('/my-work')

  // The four global semantic columns render in fixed order.
  await expect(
    page.getByRole('heading', { name: 'Todo' }),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'In progress' }),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Review' }),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Done' }),
  ).toBeVisible()

  // Both seeded items (concrete status "Todo", category todo)
  // appear in the Todo column.
  const todoColumn = page.locator(
    '[data-board-column="todo"]',
  )
  await expect(
    todoColumn.getByRole('button', {
      name: 'Open First Draft Complete',
    }),
  ).toBeVisible()
  await expect(
    todoColumn.getByRole('button', {
      name: 'Open E2E Analyze robot data',
    }),
  ).toBeVisible()

  // Cards carry Project + Research Group context and the
  // concrete type + status.
  const firstDraftCard = page.getByRole('button', {
    name: 'Open First Draft Complete',
  })
  const robotCard = page.getByRole('button', {
    name: 'Open E2E Analyze robot data',
  })
  await expect(
    firstDraftCard.getByText('Paper XYZ', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(
    firstDraftCard.getByText('FG Example', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(
    firstDraftCard.getByText('Milestone', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(
    firstDraftCard.getByText('Todo', { exact: true }),
  ).toBeVisible()
  await expect(
    robotCard.getByText('E2E Robot Study', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(
    robotCard.getByText('Robotics Lab', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(
    robotCard.getByText('Task', { exact: true }),
  ).toBeVisible()

  await page.screenshot({
    path: testInfo.outputPath('my-work-kanban.png'),
    fullPage: true,
  })
})

test('switching List/Kanban is presentation-only (no refetch of /api/me/work-items/)', async ({ page }) => {
  const myWorkRequestUrls: string[] = []
  const projectConfigRequestUrls: string[] = []
  page.on('request', (request) => {
    if (
      request.url().includes('/api/me/work-items/')
    ) {
      myWorkRequestUrls.push(request.url())
    }
    if (
      request
        .url()
        .includes('/work-item-configuration/')
    ) {
      projectConfigRequestUrls.push(
        request.url(),
      )
    }
  })

  await login(page, 'alex')
  await page.goto('/my-work')

  const todoColumn = page.getByRole(
    'heading',
    { name: 'Todo' },
  )
  await expect(todoColumn).toBeVisible()

  const requestsAfterLoad = myWorkRequestUrls.length
  expect(requestsAfterLoad).toBeGreaterThanOrEqual(1)

  // Switch to the List view.
  await page
    .getByRole('button', { name: 'List' })
    .click()
  await expect(
    page.getByText('Work item', { exact: true }),
  ).toBeVisible()

  // Switch back to the Kanban.
  await page
    .getByRole('button', { name: 'Kanban' })
    .click()
  await expect(todoColumn).toBeVisible()

  // Presentation-only: no canonical request is repeated and no
  // Project configuration is fetched for either view.
  expect(myWorkRequestUrls.length).toBe(
    requestsAfterLoad,
  )
  expect(projectConfigRequestUrls).toEqual([])
})

test('opening a My Work card opens the canonical Work Item Drawer in place', async ({ page }, testInfo) => {
  // Record the lazy drawer-context contract: before the click the
  // page must not fetch any per-Project drawer context, and after
  // the click the owning Project's context reads are acceptable
  // (and are what make the canonical drawer work).
  const myWorkRequestUrls: string[] = []
  const projectContextRequestUrls: string[] = []
  page.on('request', (request) => {
    const url = request.url()

    if (url.includes('/api/me/work-items/')) {
      myWorkRequestUrls.push(url)
    }

    const pathname = new URL(url).pathname

    if (
      request.method() === 'GET' &&
      (pathname.startsWith('/api/projects/') ||
        pathname.includes('/work-item-configuration/'))
    ) {
      projectContextRequestUrls.push(url)
    }
  })

  await login(page, 'alex')
  await page.goto('/my-work')

  const robotCard = page.getByRole(
    'button',
    { name: 'Open E2E Analyze robot data' },
  )
  await expect(robotCard).toBeVisible()

  // 1. Normal rendering: no per-Project drawer context yet.
  await page.waitForTimeout(500)
  expect(projectContextRequestUrls).toEqual([])

  // 2. Click the card — the URL must stay on /my-work.
  await robotCard.click()
  await expect(page).toHaveURL(/\/my-work$/)

  // 3. The canonical Work Item Drawer (the Project board's
  // non-modal edit inspector) becomes visible in place.
  const drawer = page.getByRole('region', {
    name: 'Work item',
  })
  await expect(drawer).toBeVisible()

  // 4. The drawer carries the CLICKED Work Item: its title (the
  // editable title control) and its canonical identity row
  // (type label + #id).
  await expect(
    drawer.getByRole('button', {
      name: 'E2E Analyze robot data',
    }),
  ).toBeVisible()
  await expect(
    drawer.getByText(/#\d+/),
  ).toBeVisible()

  // 5. Recognizable canonical fields/actions from the Project
  // drawer: the Project context line, the Work item actions
  // (delete) menu, and the close control.
  await expect(
    drawer.getByText('E2E Robot Study', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(
    drawer.getByRole('button', {
      name: 'Work item actions',
    }),
  ).toBeVisible()
  await expect(
    drawer.getByRole('button', {
      name: 'Close work item',
    }),
  ).toBeVisible()

  // 6. The owning-Project drawer context was lazy-loaded AFTER
  // the click (Project + configuration + memberships + Work
  // Items), and no navigation to the Project board occurred.
  await expect
    .poll(() => projectContextRequestUrls.length)
    .toBeGreaterThanOrEqual(1)
  await expect(page).toHaveURL(/\/my-work$/)

  // The My Work board is still rendered underneath (scoped to the
  // board column — the drawer also contains the item title).
  await expect(
    page
      .locator('[data-board-column="todo"]')
      .getByRole('button', {
        name: 'Open E2E Analyze robot data',
      }),
  ).toBeVisible()

  // 7. Close the drawer — My Work is back, still on /my-work.
  await drawer
    .getByRole('button', { name: 'Close work item' })
    .click()

  await expect(drawer).toBeHidden()
  await expect(page).toHaveURL(/\/my-work$/)
  await expect(robotCard).toBeVisible()

  // The closed-drawer board is exactly the pre-open My Work state:
  // the other seeded card is untouched and the Kanban is active.
  await expect(
    page.getByRole('button', {
      name: 'Open First Draft Complete',
    }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Kanban' }),
  ).toHaveAttribute('aria-pressed', 'true')

  await page.screenshot({
    path: testInfo.outputPath(
      'my-work-drawer-closed.png',
    ),
  })
})

test('opening a My Work card does not navigate to the Project Work Items board', async ({ page }) => {
  await login(page, 'alex')
  await page.goto('/my-work')

  const firstDraftCard = page.getByRole(
    'button',
    { name: 'Open First Draft Complete' },
  )
  await expect(firstDraftCard).toBeVisible()

  await firstDraftCard.click()

  // In-place drawer, never the Project board route.
  await expect(page).toHaveURL(/\/my-work$/)
  await expect(
    page.getByRole('region', {
      name: 'Work item',
    }),
  ).toBeVisible()
})

test('My Work Kanban has no document horizontal overflow at a narrow viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({
    width: 390,
    height: 844,
  })

  await login(page, 'alex')
  await page.goto('/my-work')

  // The fourth (Done) column is present in the board but sits to
  // the right of the narrow viewport — the board scrolls
  // horizontally INSIDE its own region.
  const doneColumn = page.getByRole(
    'heading',
    { name: 'Done' },
  )
  await expect(doneColumn).toBeAttached()

  const doneBox = await doneColumn.boundingBox()
  if (!doneBox) {
    throw new Error(
      'Done column bounding box not found',
    )
  }
  const viewport = page.viewportSize()
  if (!viewport) {
    throw new Error('viewport size not set')
  }
  expect(doneBox.x).toBeGreaterThan(viewport.width)

  // Critical invariant: the document itself does not overflow.
  await expectNoHorizontalOverflow(page)

  await page.screenshot({
    path: testInfo.outputPath('my-work-kanban-narrow.png'),
    fullPage: true,
  })
})

test('My Work List has no horizontal overflow at a narrow viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({
    width: 390,
    height: 844,
  })

  await login(page, 'alex')
  await page.goto('/my-work')

  // Switch to the List view at the narrow width.
  await page
    .getByRole('button', { name: 'List' })
    .click()

  // The desktop column headers are intentionally hidden below the xl
  // breakpoint; the rows collapse into stacked metadata. Verify the
  // collapsed layout behaviorally instead of the desktop-only header.
  const firstDraftRow = page.getByRole(
    'button',
    { name: 'Open First Draft Complete' },
  )
  await expect(firstDraftRow).toBeVisible()

  // Title remains visible.
  await expect(
    firstDraftRow.getByText(
      'First Draft Complete',
      { exact: true },
    ),
  ).toBeVisible()
  // The concrete project-local type name remains visible.
  await expect(
    firstDraftRow.getByText('Milestone', { exact: true }),
  ).toBeVisible()
  // The concrete project-local status name remains visible.
  await expect(
    firstDraftRow.getByText('Todo', { exact: true }),
  ).toBeVisible()
  // Cross-Project + cross-Research-Group context remains visible.
  await expect(
    firstDraftRow.getByText('Paper XYZ', { exact: true }),
  ).toBeVisible()
  await expect(
    firstDraftRow.getByText('FG Example', { exact: true }),
  ).toBeVisible()
  // The seeded overdue due date remains available.
  await expect(
    firstDraftRow.getByText(/d overdue/),
  ).toBeVisible()

  // Critical invariant: the document itself does not overflow.
  await expectNoHorizontalOverflow(page)

  await page.screenshot({
    path: testInfo.outputPath('my-work-list-narrow.png'),
    fullPage: true,
  })
})

test('My Work Kanban drag: cross-category drop mutates the canonical status from statusTargets and refetches My Work', async ({ page }, testInfo) => {
  // Capture the wire contract: exactly one canonical status-only
  // transition (POST /api/work-items/{id}/transition-status/
  // carrying only the concrete target statusDefinitionId — no
  // boardPosition), zero ordinary status-changing PATCH
  // /api/work-items/{id}/ requests, zero reorder requests, followed
  // by exactly one authoritative GET /api/me/work-items/ refetch,
  // with zero per-Project configuration requests.
  const myWorkRequestUrls: string[] = []
  const projectConfigRequestUrls: string[] = []
  const transitionRequests: Array<{
    url: string
    payload: Record<string, unknown>
  }> = []
  const statusPatchRequests: string[] = []
  const reorderRequests: string[] = []

  type StatusTarget = {
    statusCategory: string
    statusDefinitionId: number
    statusName: string
  }

  type PersonalWorkItem = {
    id: number
    title: string
    statusCategory: string
    statusName: string
    statusTargets: StatusTarget[]
  }

  let myWorkPayload: PersonalWorkItem[] = []

  page.on('request', (request) => {
    const url = request.url()

    if (url.includes('/api/me/work-items/')) {
      myWorkRequestUrls.push(url)
    }

    if (url.includes('/work-item-configuration/')) {
      projectConfigRequestUrls.push(url)
    }

    const pathname = new URL(url).pathname

    if (
      request.method() === 'POST' &&
      /\/api\/work-items\/\d+\/transition-status\/$/.test(
        pathname,
      )
    ) {
      transitionRequests.push({
        url,
        payload: JSON.parse(
          request.postData() ?? '{}',
        ) as Record<string, unknown>,
      })
    }

    if (
      request.method() === 'POST' &&
      /\/api\/work-items\/\d+\/reorder\/$/.test(
        pathname,
      )
    ) {
      reorderRequests.push(url)
    }

    if (
      request.method() === 'PATCH' &&
      /\/api\/work-items\/\d+\/$/.test(
        pathname,
      )
    ) {
      statusPatchRequests.push(url)
    }
  })

  page.on('response', (response) => {
    if (
      response.url().includes(
        '/api/me/work-items/',
      ) &&
      response.request().method() === 'GET'
    ) {
      void response
        .json()
        .then((payload) => {
          if (Array.isArray(payload)) {
            myWorkPayload =
              payload as PersonalWorkItem[]
          }
        })
        .catch(() => {
          // Non-JSON body; keep the last payload.
        })
    }
  })

  // Wide enough that all four columns are visible at once, so the
  // drag source and drop target are both on-screen (the same
  // convention the Project Board drag spec uses).
  await page.setViewportSize({
    width: 1920,
    height: 1000,
  })

  await login(page, 'alex')
  await page.goto('/my-work')

  const todoColumn = page.locator(
    '[data-board-column="todo"]',
  )
  const card = todoColumn.getByRole(
    'button',
    { name: 'Open First Draft Complete' },
  )
  await expect(card).toBeVisible()

  // The concrete drop target is derived from the CANONICAL payload's
  // statusTargets — never from a status name or any Project
  // configuration.
  await expect
    .poll(() => myWorkPayload.length)
    .toBeGreaterThan(0)

  const item = myWorkPayload.find(
    (candidate) =>
      candidate.title ===
      'First Draft Complete',
  )
  if (!item) {
    throw new Error(
      'Seeded "First Draft Complete" missing from the My Work payload.',
    )
  }
  expect(item.statusCategory).toBe('todo')

  const target = item.statusTargets.find(
    (candidate) =>
      candidate.statusCategory ===
      'in_progress',
  )
  if (!target) {
    throw new Error(
      'Seeded item has no in_progress statusTarget.',
    )
  }

  const myWorkRequestsAfterLoad =
    myWorkRequestUrls.length
  expect(myWorkRequestsAfterLoad).toBeGreaterThanOrEqual(
    1,
  )
  expect(transitionRequests).toEqual([])
  expect(statusPatchRequests).toEqual([])
  expect(reorderRequests).toEqual([])

  // --------------------------------------------------------
  // 1. Drag the card into the "In progress" column.
  // --------------------------------------------------------

  const inProgressColumn = page.locator(
    '[data-board-column="in_progress"]',
  )
  await inProgressColumn.scrollIntoViewIfNeeded()

  // Native HTML5 drag-and-drop needs a real mouse gesture (not
  // locator.dragTo's single jump) for Chromium to recognize the
  // drag threshold and dispatch dragstart/dragover/drop.
  const cardBox = await card.boundingBox()
  const targetBox = await inProgressColumn.boundingBox()
  if (!cardBox || !targetBox) {
    throw new Error(
      'Card or target column bounding box not found.',
    )
  }

  await page.mouse.move(
    cardBox.x + cardBox.width / 2,
    cardBox.y + cardBox.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height / 2,
    { steps: 20 },
  )
  await page.mouse.up()

  // --------------------------------------------------------
  // 2. The card appears in In progress — the authoritative
  //    refetched payload (not local inference) decided its column,
  //    and the returned concrete statusName is displayed.
  // --------------------------------------------------------

  const movedCard = inProgressColumn.getByRole(
    'button',
    { name: 'Open First Draft Complete' },
  )
  await expect(movedCard).toBeVisible()
  await expect(card).toHaveCount(0)

  // A completed drag/drop never opens the Work Item drawer
  // (click and drag are distinguishable).
  await expect(
    page.getByRole('region', {
      name: 'Work item',
    }),
  ).toBeHidden()

  await expect(
    movedCard.getByText(target.statusName, {
      exact: true,
    }),
  ).toBeVisible()

  // Project / Research Group context and the Kanban view survive
  // the move (the filter was untouched — it stayed "all").
  await expect(
    movedCard.getByText('Paper XYZ', { exact: true }),
  ).toBeVisible()
  await expect(
    movedCard.getByText('FG Example', { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Kanban' }),
  ).toHaveAttribute('aria-pressed', 'true')

  // --------------------------------------------------------
  // 3. Wire contract: exactly one canonical mutation carrying only
  //    the concrete target statusDefinitionId (no boardPosition),
  //    followed by exactly one authoritative My Work refetch and
  //    zero Project configuration requests.
  // --------------------------------------------------------

  // Exactly one canonical status-only transition — and the exact
  // payload match proves nothing else (no boardPosition, no status
  // name, no My Work state) was sent.
  expect(transitionRequests).toHaveLength(1)
  const [transition] = transitionRequests
  expect(transition.url).toBe(
    `http://127.0.0.1:4173/api/work-items/${item.id}/transition-status/`,
  )
  expect(transition.payload).toEqual({
    statusDefinitionId: target.statusDefinitionId,
  })

  // The ordinary status PATCH (Project-board reposition-to-end
  // semantics) and the reorder endpoint must NOT be used for the
  // My Work move — project-local board_position is preserved.
  expect(statusPatchRequests).toEqual([])
  expect(reorderRequests).toEqual([])

  // The refetch result is authoritative: the canonical payload now
  // reports the item in the target category with the concrete
  // target status name.
  await expect
    .poll(() =>
      myWorkPayload.find(
        (candidate) => candidate.id === item.id,
      )?.statusCategory,
    )
    .toBe('in_progress')
  expect(
    myWorkPayload.find(
      (candidate) => candidate.id === item.id,
    )?.statusName,
  ).toBe(target.statusName)

  // Exactly one refetch: the mutation's authoritative read.
  expect(myWorkRequestUrls.length).toBe(
    myWorkRequestsAfterLoad + 1,
  )
  expect(projectConfigRequestUrls).toEqual([])

  await page.screenshot({
    path: testInfo.outputPath('my-work-drag-moved.png'),
  })

  // --------------------------------------------------------
  // 4. Same-category drop: no mutation, no refetch (this board has
  //    no within-column reordering).
  // --------------------------------------------------------

  const cardBoxAgain = await movedCard.boundingBox()
  const targetBoxAgain = await inProgressColumn.boundingBox()
  if (!cardBoxAgain || !targetBoxAgain) {
    throw new Error(
      'Card or target column bounding box not found for the same-category drag.',
    )
  }

  await page.mouse.move(
    cardBoxAgain.x + cardBoxAgain.width / 2,
    cardBoxAgain.y + cardBoxAgain.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(
    targetBoxAgain.x + targetBoxAgain.width / 2,
    targetBoxAgain.y + targetBoxAgain.height / 2,
    { steps: 20 },
  )
  await page.mouse.up()

  // Bounded quiet window: nothing should have happened at all.
  await page.waitForTimeout(300)

  expect(transitionRequests).toHaveLength(1)
  expect(statusPatchRequests).toEqual([])
  expect(reorderRequests).toEqual([])
  expect(myWorkRequestUrls.length).toBe(
    myWorkRequestsAfterLoad + 1,
  )
  await expect(movedCard).toBeVisible()

  // The no-op drag also never opens the drawer.
  await expect(
    page.getByRole('region', {
      name: 'Work item',
    }),
  ).toBeHidden()
})
