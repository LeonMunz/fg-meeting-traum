import {
  expect,
  type Page,
  test,
} from '@playwright/test'
import { login } from './helpers'
import {
  expectMyWorkPreferenceSave,
  expectMyWorkReady,
  getMyWorkPreferences,
  getProjectIdInGroup,
  getResearchGroupId,
  MY_WORK_PREFERENCES_BASELINE,
  sameMyWorkPreferences,
  setMyWorkPreferences,
} from './my-work-helpers'

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
 * atomic My Work board move `POST /api/me/work-items/{id}/reorder/`
 * carrying exactly `statusCategory` + `beforeWorkItemId` (no
 * boardPosition, no status definition, no standalone
 * transition-status request, no status-changing PATCH, no Project
 * reorder), followed by exactly one authoritative
 * `GET /api/me/work-items/` refetch.
 *
 * My Work preferences are server-persistent, so the two preference
 * scenarios (the rendering scenario and the Research Groups
 * filter/persist scenario) establish the canonical server-side
 * baseline through the shared harness (`./my-work-helpers.ts`)
 * before rendering and wait for the debounced save event-based —
 * each scenario can run standalone, independent of test order.
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

async function expectAppliedFiltersAndActionsOnOneRow(page: Page) {
  const appliedFilters = page.getByRole('group', {
    name: 'Applied filters',
  })
  const toolbarActions = page
    .getByRole('group', { name: 'My Work view' })
    .locator('..')
  const [appliedBox, actionsBox] = await Promise.all([
    appliedFilters.boundingBox(),
    toolbarActions.boundingBox(),
  ])

  expect(appliedBox).not.toBeNull()
  expect(actionsBox).not.toBeNull()
  expect(
    Math.abs(
      appliedBox!.y + appliedBox!.height / 2 -
        (actionsBox!.y + actionsBox!.height / 2),
    ),
  ).toBeLessThanOrEqual(1)
}

type MyWorkFilterCategory =
  | 'Research group'
  | 'Project'
  | 'Work item type'

async function openMyWorkFilterCategory(
  page: Page,
  category: MyWorkFilterCategory,
) {
  const listbox = page.getByRole('listbox', {
    name: `${category} options`,
  })
  if (await listbox.isVisible()) {
    return listbox
  }

  const dialog = page.getByRole('dialog', { name: 'Filter by' })
  if (!(await dialog.isVisible())) {
    await page
      .getByRole('button', { name: /^Filter,/ })
      .click()
  } else {
    const back = dialog.getByRole('button', {
      name: 'Back to filter categories',
    })
    if (await back.isVisible()) {
      await back.click()
    }
  }

  await dialog
    .getByRole('button', {
      name: new RegExp(`^${category}(?: \\d+)?$`),
    })
    .click()
  await expect(listbox).toBeVisible()
  return listbox
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

  // Canonical server-side baseline (the real backend contract:
  // Board view, no active filters) persisted BEFORE the first load,
  // so the page renders from a known persisted state and the test
  // never depends on a previous test's leftover preferences or the
  // execution order.
  const persisted = await setMyWorkPreferences(
    page,
    MY_WORK_PREFERENCES_BASELINE,
  )
  expect(
    sameMyWorkPreferences(
      persisted,
      MY_WORK_PREFERENCES_BASELINE,
    ),
  ).toBe(true)

  await page.goto('/my-work')

  // Functionally ready (web-first): the persisted preference is
  // loaded and APPLIED (Board active, no filter row) and both
  // Work Items are fully rendered — before any assertion below.
  await expectMyWorkReady(page, {
    viewMode: 'board',
    visibleTitles: [
      'First Draft Complete',
      'E2E Analyze robot data',
    ],
  })

  const filterTrigger = page.getByRole('button', {
    name: 'Filter, 0 active categories',
  })
  const toolbar = page.getByRole('toolbar', {
    name: 'My Work controls',
  })
  await expect(
    toolbar.getByRole('group', { name: 'Applied filters' }),
  ).toHaveCount(0)
  await expect(toolbar.locator(':scope > *')).toHaveCount(1)
  const viewSwitch = page.getByRole('group', {
    name: 'My Work view',
  })
  const [viewSwitchBox, filterTriggerBox] = await Promise.all([
    viewSwitch.boundingBox(),
    filterTrigger.boundingBox(),
  ])
  expect(viewSwitchBox).not.toBeNull()
  expect(filterTriggerBox).not.toBeNull()
  expect(filterTriggerBox!.x).toBeGreaterThanOrEqual(
    viewSwitchBox!.x + viewSwitchBox!.width,
  )

  await filterTrigger.focus()
  await filterTrigger.press('Enter')
  const filterDialog = page.getByRole('dialog', { name: 'Filter by' })
  await expect(filterDialog).toBeVisible()
  const filterDialogBox = await filterDialog.boundingBox()
  expect(filterDialogBox).not.toBeNull()
  expect(
    Math.abs(
      filterDialogBox!.x + filterDialogBox!.width -
        (filterTriggerBox!.x + filterTriggerBox!.width),
    ),
  ).toBeLessThanOrEqual(1)
  await expect(
    filterDialog.getByRole('button', { name: 'Research group' }),
  ).toBeVisible()
  await expect(
    filterDialog.getByRole('button', { name: 'Project' }),
  ).toBeVisible()
  await expect(
    filterDialog.getByRole('button', { name: 'Work item type' }),
  ).toBeVisible()

  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value
    }, theme)
    await filterDialog.screenshot({
      path: testInfo.outputPath(`my-work-filter-${theme}.png`),
    })
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
  })

  await page.keyboard.press('Escape')
  await expect(filterDialog).toBeHidden()
  await expect(filterTrigger).toBeFocused()

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

  // The semantic status is communicated by the COLUMN (icon +
  // written label) — the card must NOT redundantly render the
  // concrete statusName.
  await expect(
    page.getByRole('heading', { name: 'Todo' }),
  ).toBeVisible()
  await expect(
    firstDraftRow.getByText('Todo', { exact: true }),
  ).toHaveCount(0)
  await expect(
    robotRow.getByText('Todo', { exact: true }),
  ).toHaveCount(0)

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
  // concrete type (the semantic status comes from the column —
  // the card itself does NOT repeat it).
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
    firstDraftCard.getByText('Todo', {
      exact: true,
    }),
  ).toHaveCount(0)
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
  await expect(
    robotCard.getByText('Todo', { exact: true }),
  ).toHaveCount(0)

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
    .getByRole('button', { name: 'Board' })
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
    page.getByRole('button', { name: 'Board' }),
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

  // Critical invariant: the document itself never overflows — in
  // BOTH user-visible layout states. Material Symbols is a
  // ligature icon font loaded with default (swap) font-display:
  // before the woff2 arrives, the literal keywords render as wide
  // fallback text, so the mid-font-swap render is user-visible too
  // and must not overflow. The immediate sample is taken right
  // after the final board render (hydration complete, Done column
  // attached); the settled sample after document.fonts.ready plus
  // two animation frames. Font timing is nondeterministic, so the
  // test asserts only on layout, never on font state.
  const measureDocumentOverflow = (): number =>
    document.documentElement.scrollWidth -
    document.documentElement.clientWidth

  const overflowImmediate =
    await page.evaluate(measureDocumentOverflow)
  expect(
    overflowImmediate,
    `immediate (pre-font-settle) document overflow at ${viewport.width}px viewport`,
  ).toBeLessThanOrEqual(0)

  await page.evaluate(() =>
    Promise.all([
      document.fonts.ready,
      new Promise<void>((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(
            () => resolve(),
          )
        )
      }),
    ])
  )

  const overflowSettled =
    await page.evaluate(measureDocumentOverflow)
  expect(
    overflowSettled,
    `settled (post-font-settle) document overflow at ${viewport.width}px viewport`,
  ).toBeLessThanOrEqual(0)

  // Intentional board-scroll contract: the full grid extends past
  // the narrow viewport but is contained by its own scroller, so
  // the scroller must actually scroll horizontally.
  const scroller = await page
    .locator(
      '[data-testid="my-work-board-scroller"]',
    )
    .evaluate((el) => ({
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
    }))
  expect(
    scroller.scrollWidth,
    'board scroller must contain a horizontally scrollable grid',
  ).toBeGreaterThan(scroller.clientWidth)

  await openMyWorkFilterCategory(page, 'Project')
  await expect(
    page.getByRole('searchbox', { name: 'Search projects' }),
  ).toBeFocused()
  const dialogBox = await page
    .getByRole('dialog', { name: 'Filter by' })
    .boundingBox()
  if (!dialogBox) {
    throw new Error('Filter command dialog bounding box not found')
  }
  expect(dialogBox.x).toBeGreaterThanOrEqual(0)
  expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(
    viewport.width,
  )
  expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(
    viewport.height,
  )
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

  // The final content (Board or List) renders only after the items
  // AND the preference snapshot have resolved; the view switch is
  // inert while the snapshot is still hydrating (it only acts on
  // the loaded preference). Wait for the seeded card first so the
  // List switch below acts on hydrated state — the required
  // baseline for this test.
  await expect(
    page.getByRole('button', {
      name: 'Open First Draft Complete',
    }),
  ).toBeVisible()

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

test('My Work Research Groups multiselect filters, persists, and restores', async ({ page }, testInfo) => {
  const myWorkRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/api/me/work-items/')) {
      myWorkRequests.push(request.url())
    }
  })

  await login(page, 'alex')

  // Canonical server-side baseline BEFORE the UI change: the test
  // starts from a known persisted state (Board view, no filter)
  // regardless of earlier tests or their leftover in-flight saves.
  const persisted = await setMyWorkPreferences(
    page,
    MY_WORK_PREFERENCES_BASELINE,
  )
  expect(
    sameMyWorkPreferences(
      persisted,
      MY_WORK_PREFERENCES_BASELINE,
    ),
  ).toBe(true)

  // The complete-snapshot PATCH carries relational IDs — resolve
  // the seeded group's ID from the canonical list endpoint.
  const fgExampleId = await getResearchGroupId(
    page,
    'FG Example',
  )
  const roboticsLabId = await getResearchGroupId(
    page,
    'Robotics Lab',
  )

  await page.goto('/my-work')

  // Functionally ready: the baseline preference is applied (Board
  // active, no filter) and both seeded Work Items are fully
  // rendered — before any assertion below.
  await expectMyWorkReady(page, {
    viewMode: 'board',
    visibleTitles: [
      'First Draft Complete',
      'E2E Analyze robot data',
    ],
  })

  const firstDraftCard = page.getByRole('button', {
    name: 'Open First Draft Complete',
  })
  const robotCard = page.getByRole('button', {
    name: 'Open E2E Analyze robot data',
  })

  // The single command trigger is visible in the toolbar (no active
  // filter in the baseline).
  const toggle = page.getByRole('button', {
    name: 'Filter, 0 active categories',
  })
  await expect(toggle).toBeVisible()

  // The page is fully loaded (final content + hydrated preference).
  // The ABSOLUTE initial request count is deliberately not asserted:
  // the dev harness (React StrictMode) may legitimately issue the
  // canonical GET more than once on mount. The contract under test
  // is that changing the filter adds NO further items request.
  const requestCountBeforeFilterChange =
    myWorkRequests.length
  expect(requestCountBeforeFilterChange).toBeGreaterThanOrEqual(
    1,
  )

  // Open the Research Group command view and select "FG Example".
  await openMyWorkFilterCategory(page, 'Research group')
  const groupOption = page.getByRole('option', {
    name: 'FG Example',
  })
  await expect(groupOption).toBeVisible()

  // Event-based persistence: the wait for the debounced
  // complete-snapshot save is registered BEFORE the UI action. It
  // must target the preference endpoint (method + pathname),
  // succeed, and carry exactly the intended snapshot (baseline +
  // the one selected Research Group).
  const preferenceSaveFlushed = expectMyWorkPreferenceSave(page, {
    ...MY_WORK_PREFERENCES_BASELINE,
    researchGroupIds: [fgExampleId],
  })

  await groupOption.click()

  // Filtering applies immediately WITHOUT a page reload or a
  // refetch of the personal endpoint.
  await expect(robotCard).toBeHidden()
  await expect(firstDraftCard).toBeVisible()
  expect(myWorkRequests.length).toBe(
    requestCountBeforeFilterChange,
  )

  // The active filter is visible in the shared toolbar: the trigger
  // shows a category badge and the summary shows an "FG: ..." chip.
  await expect(
    page.getByRole('button', {
      name: 'Filter, 1 active category',
    }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', {
      name: 'Remove Research Group filter FG Example',
    }),
  ).toBeVisible()

  await preferenceSaveFlushed
  const roboticsOption = page.getByRole('option', {
    name: 'Robotics Lab',
  })
  const multiGroupSaveFlushed = expectMyWorkPreferenceSave(page, {
    ...MY_WORK_PREFERENCES_BASELINE,
    researchGroupIds: [fgExampleId, roboticsLabId].sort(
      (a, b) => a - b,
    ),
  })
  await roboticsOption.click()
  await expect(groupOption).toHaveAttribute('aria-selected', 'true')
  await expect(roboticsOption).toHaveAttribute('aria-selected', 'true')
  await expect(firstDraftCard).toBeVisible()
  await expect(robotCard).toBeVisible()
  await expectAppliedFiltersAndActionsOnOneRow(page)
  await multiGroupSaveFlushed

  const singleGroupSaveFlushed = expectMyWorkPreferenceSave(page, {
    ...MY_WORK_PREFERENCES_BASELINE,
    researchGroupIds: [fgExampleId],
  })
  await roboticsOption.click()
  await expect(robotCard).toBeHidden()
  await singleGroupSaveFlushed

  // The applied filter survives a full reload (server-side
  // preference restore) — the final one-group save has landed.
  await page.reload()
  await expectMyWorkReady(page, {
    viewMode: 'board',
    visibleTitles: ['First Draft Complete'],
    hiddenTitles: ['E2E Analyze robot data'],
  })
  await expect(
    page.getByRole('button', {
      name: 'Filter, 1 active category',
    }),
  ).toBeVisible()

  await page.goto('/')
  await page.goto('/my-work')
  await expectMyWorkReady(page, {
    viewMode: 'board',
    visibleTitles: ['First Draft Complete'],
    hiddenTitles: ['E2E Analyze robot data'],
  })

  // Board -> List keeps the same active filter (one row only).
  await page
    .getByRole('button', { name: 'List' })
    .click()
  await expect(
    page.getByRole('button', {
      name: 'Open First Draft Complete',
    }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', {
      name: 'Open E2E Analyze robot data',
    }),
  ).toHaveCount(0)

  // Back to Board, then remove the single applied chip: both items
  // return. The clearing save is waited on the same event-based way
  // (registered before the action, payload verified) and the server
  // state is re-read afterwards: the persisted state is the
  // canonical baseline again, so the later specs start clean without
  // depending on this test's execution order or an in-flight save.
  await page
    .getByRole('button', { name: 'Board' })
    .click()
  const clearedSave = expectMyWorkPreferenceSave(
    page,
    MY_WORK_PREFERENCES_BASELINE,
  )
  await page
    .getByRole('button', {
      name: 'Remove Research Group filter FG Example',
    })
    .click()
  await expect(
    page.getByRole('button', {
      name: 'Filter, 0 active categories',
    }),
  ).toBeVisible()
  await expect(firstDraftCard).toBeVisible()
  await expect(robotCard).toBeVisible()

  await clearedSave
  const serverState = await getMyWorkPreferences(page)
  expect(
    sameMyWorkPreferences(
      serverState,
      MY_WORK_PREFERENCES_BASELINE,
    ),
  ).toBe(true)

  await page.screenshot({
    path: testInfo.outputPath(
      'my-work-research-group-filter.png',
    ),
    fullPage: true,
  })
})

test('My Work Projects multiselect filters, persists, restores, and narrows with Research Groups', async ({ page }, testInfo) => {
  const myWorkRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/api/me/work-items/')) {
      myWorkRequests.push(request.url())
    }
  })

  await login(page, 'alex')

  // Canonical server-side baseline BEFORE the UI change (Board view,
  // no filter) — independent of earlier tests or their leftover
  // in-flight saves.
  const persisted = await setMyWorkPreferences(
    page,
    MY_WORK_PREFERENCES_BASELINE,
  )
  expect(
    sameMyWorkPreferences(
      persisted,
      MY_WORK_PREFERENCES_BASELINE,
    ),
  ).toBe(true)

  // Complete-snapshot PATCHes carry relational IDs — resolve the
  // seeded Projects through the canonical list endpoints.
  const fgExampleId = await getResearchGroupId(
    page,
    'FG Example',
  )
  const paperXyzId = await getProjectIdInGroup(
    page,
    'FG Example',
    'Paper XYZ',
  )
  const robotStudyId = await getProjectIdInGroup(
    page,
    'Robotics Lab',
    'E2E Robot Study',
  )

  await page.goto('/my-work')

  // Functionally ready: baseline applied (Board, no filter) and both
  // seeded Work Items rendered.
  await expectMyWorkReady(page, {
    viewMode: 'board',
    visibleTitles: [
      'First Draft Complete',
      'E2E Analyze robot data',
    ],
  })

  const firstDraftCard = page.getByRole('button', {
    name: 'Open First Draft Complete',
  })
  const robotCard = page.getByRole('button', {
    name: 'Open E2E Analyze robot data',
  })

  const filterTrigger = page.getByRole('button', {
    name: 'Filter, 0 active categories',
  })
  await expect(filterTrigger).toBeVisible()

  const requestCountBeforeFilterChange =
    myWorkRequests.length
  expect(requestCountBeforeFilterChange).toBeGreaterThanOrEqual(
    1,
  )

  // ── Project options with NO Research Group filter: every seeded
  // Project represented by the canonical payload. ──
  await openMyWorkFilterCategory(page, 'Project')
  const paperOption = page.getByRole('option', {
    name: 'Paper XYZ',
  })
  const robotOption = page.getByRole('option', {
    name: 'E2E Robot Study',
  })
  await expect(paperOption).toBeVisible()
  await expect(robotOption).toBeVisible()

  const projectSearch = page.getByRole('searchbox', {
    name: 'Search projects',
  })
  await projectSearch.fill('Paper')
  await expect(paperOption).toBeVisible()
  await expect(robotOption).toHaveCount(0)
  await projectSearch.fill('')
  await expect(robotOption).toBeVisible()

  // Multi-select both Projects first: OR semantics keeps both items,
  // and both options report immediate selected state.
  const multiProjectSaveFlushed = expectMyWorkPreferenceSave(
    page,
    {
      ...MY_WORK_PREFERENCES_BASELINE,
      projectIds: [paperXyzId, robotStudyId].sort((a, b) => a - b),
    },
  )
  await paperOption.click()
  await robotOption.click()
  await expect(paperOption).toHaveAttribute('aria-selected', 'true')
  await expect(robotOption).toHaveAttribute('aria-selected', 'true')
  await expect(firstDraftCard).toBeVisible()
  await expect(robotCard).toBeVisible()
  await multiProjectSaveFlushed

  // Remove Robot Study again: Paper XYZ is the sole selection for
  // the persistence and restore assertions below.
  const projectSaveFlushed = expectMyWorkPreferenceSave(page, {
    ...MY_WORK_PREFERENCES_BASELINE,
    projectIds: [paperXyzId],
  })
  await robotOption.click()

  await expect(robotCard).toBeHidden()
  await expect(firstDraftCard).toBeVisible()
  expect(myWorkRequests.length).toBe(
    requestCountBeforeFilterChange,
  )

  // The active filter is visible: category badge, "PJ: ..." chip, and
  // the filtered result count.
  await expect(
    page.getByRole('button', {
      name: 'Filter, 1 active category',
    }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', {
      name: 'Remove Project filter Paper XYZ',
    }),
  ).toBeVisible()
  await expect(
    page.getByText('1 work item'),
  ).toBeVisible()

  // The applied filter survives a full reload (server-side
  // preference restore) — the verified save must have landed first.
  await projectSaveFlushed
  await page.reload()
  await expectMyWorkReady(page, {
    viewMode: 'board',
    visibleTitles: ['First Draft Complete'],
    hiddenTitles: ['E2E Analyze robot data'],
  })
  await expect(
    page.getByRole('button', {
      name: 'Filter, 1 active category',
    }),
  ).toBeVisible()

  // Board -> List keeps the same filtered set (one row only), and
  // back to Board. Each switch is a real change against the last
  // persisted snapshot, so each complete-snapshot view-mode save is
  // verified event-based (registered BEFORE the switch) with its
  // exact payload.
  const listModeSaveFlushed = expectMyWorkPreferenceSave(
    page,
    {
      ...MY_WORK_PREFERENCES_BASELINE,
      viewMode: 'list',
      projectIds: [paperXyzId],
    },
  )
  await page
    .getByRole('button', { name: 'List' })
    .click()
  await expect(
    page.getByRole('button', {
      name: 'Open First Draft Complete',
    }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', {
      name: 'Open E2E Analyze robot data',
    }),
  ).toHaveCount(0)
  await listModeSaveFlushed

  const boardModeSaveFlushed = expectMyWorkPreferenceSave(
    page,
    {
      ...MY_WORK_PREFERENCES_BASELINE,
      projectIds: [paperXyzId],
    },
  )
  await page
    .getByRole('button', { name: 'Board' })
    .click()
  await boardModeSaveFlushed

  // ── Research Group → Project narrowing: with FG Example active,
  // the Projects control exposes only that group's Project. ──
  await openMyWorkFilterCategory(page, 'Research group')
  const fgOption = page.getByRole('option', {
    name: 'FG Example',
  })
  const groupSaveFlushed = expectMyWorkPreferenceSave(
    page,
    {
      ...MY_WORK_PREFERENCES_BASELINE,
      researchGroupIds: [fgExampleId],
      projectIds: [paperXyzId],
    },
  )
  await fgOption.click()

  // Combined filters (FG Example + Paper XYZ): the intersection —
  // still exactly the one Paper XYZ item; both applied chips show.
  await expect(firstDraftCard).toBeVisible()
  await expect(robotCard).toBeHidden()
  await expect(
    page.getByRole('button', {
      name: 'Remove Research Group filter FG Example',
    }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', {
      name: 'Remove Project filter Paper XYZ',
    }),
  ).toBeVisible()
  await groupSaveFlushed

  // Move from the Research Group view to Project: only Paper XYZ
  // remains an option.
  await openMyWorkFilterCategory(page, 'Project')
  await expect(
    page.getByRole('option', {
      name: 'Paper XYZ',
    }),
  ).toBeVisible()
  await expect(
    page.getByRole('option', {
      name: 'E2E Robot Study',
    }),
  ).toHaveCount(0)
  await page.keyboard.press('Escape')

  // ── Dependency normalization: a Project selection invalidated by
  // a Research Group scope change is normalized away (never left as
  // an impossible/hidden filter), and the normalized snapshot is
  // what gets persisted. ──
  // Clear the Project selection (chip remove), then the Research
  // Group selection (group popover Clear), returning to the full
  // unfiltered set.
  const chipRemoveSaveFlushed = expectMyWorkPreferenceSave(
    page,
    {
      ...MY_WORK_PREFERENCES_BASELINE,
      researchGroupIds: [fgExampleId],
    },
  )
  await page
    .getByRole('button', {
      name: 'Remove Project filter Paper XYZ',
    })
    .click()
  await chipRemoveSaveFlushed

  const groupClearSaveFlushed =
    expectMyWorkPreferenceSave(
      page,
      MY_WORK_PREFERENCES_BASELINE,
    )
  await openMyWorkFilterCategory(page, 'Research group')
  // Scope to the OPEN Research groups popover (role dialog): a bare
  // `name: 'Clear'` also substring-matches the applied-filters row's
  // "Clear filters" button, which is not the control under test.
  await page
    .getByRole('dialog', { name: 'Filter by' })
    .getByRole('button', { name: 'Clear' })
    .click()
  // The command menu stays open after Clear; dismiss it before the
  // next direct category open.
  await page.keyboard.press('Escape')
  await groupClearSaveFlushed
  await expect(firstDraftCard).toBeVisible()
  await expect(robotCard).toBeVisible()

  // Select E2E Robot Study (unrestricted scope: both Projects are
  // options again).
  const robotSaveFlushed = expectMyWorkPreferenceSave(
    page,
    {
      ...MY_WORK_PREFERENCES_BASELINE,
      projectIds: [robotStudyId],
    },
  )
  await openMyWorkFilterCategory(page, 'Project')
  await robotOption.click()
  await expect(robotCard).toBeVisible()
  await expect(firstDraftCard).toBeHidden()
  await robotSaveFlushed

  // Now select FG Example: E2E Robot Study is OUTSIDE the active
  // group scope — the Project selection is normalized client-side
  // and the normalized snapshot (projectIds []) is persisted. The
  // Group-scope item is visible again: the invalidated selection
  // does not keep hiding it (no impossible filter state).
  const normalizedSaveFlushed =
    expectMyWorkPreferenceSave(page, {
      ...MY_WORK_PREFERENCES_BASELINE,
      researchGroupIds: [fgExampleId],
      projectIds: [],
    })
  await openMyWorkFilterCategory(page, 'Research group')
  await fgOption.click()

  await expect(firstDraftCard).toBeVisible()
  await expect(robotCard).toBeHidden()
  // The Project selection is gone (normalized): no chip, inactive
  // toggle.
  await expect(
    page.getByRole('button', {
      name: 'Remove Project filter E2E Robot Study',
    }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', {
      name: 'Filter, 1 active category',
    }),
  ).toBeVisible()
  await normalizedSaveFlushed

  // ── Clear filters: removes BOTH categories in one save, restores
  // the full set, and leaves the canonical baseline persisted for
  // the later specs. ──
  const clearSaveFlushed = expectMyWorkPreferenceSave(
    page,
    MY_WORK_PREFERENCES_BASELINE,
  )
  await page
    .getByRole('button', { name: 'Clear filters' })
    .click()
  await expect(firstDraftCard).toBeVisible()
  await expect(robotCard).toBeVisible()
  await clearSaveFlushed
  const serverState = await getMyWorkPreferences(page)
  expect(
    sameMyWorkPreferences(
      serverState,
      MY_WORK_PREFERENCES_BASELINE,
    ),
  ).toBe(true)

  await page.screenshot({
    path: testInfo.outputPath(
      'my-work-project-filter.png',
    ),
    fullPage: true,
  })
})

test('My Work Work Item Types multiselect filters, persists, restores, and combines with Research Groups', async ({ page }, testInfo) => {
  const myWorkRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/api/me/work-items/')) {
      myWorkRequests.push(request.url())
    }
  })

  await login(page, 'alex')

  // Canonical server-side baseline BEFORE the UI change (Board view,
  // no filter) — independent of earlier tests or their leftover
  // in-flight saves.
  const persisted = await setMyWorkPreferences(
    page,
    MY_WORK_PREFERENCES_BASELINE,
  )
  expect(
    sameMyWorkPreferences(
      persisted,
      MY_WORK_PREFERENCES_BASELINE,
    ),
  ).toBe(true)

  // The complete-snapshot PATCH carries relational IDs — resolve
  // the seeded group's ID from the canonical list endpoint.
  const fgExampleId = await getResearchGroupId(
    page,
    'FG Example',
  )

  await page.goto('/my-work')

  // Functionally ready: baseline applied (Board, no filter) and both
  // seeded Work Items rendered. Seed kinds: "First Draft Complete"
  // is the canonical Milestone kind, "E2E Analyze robot data" the
  // canonical Task kind.
  await expectMyWorkReady(page, {
    viewMode: 'board',
    visibleTitles: [
      'First Draft Complete',
      'E2E Analyze robot data',
    ],
  })

  const firstDraftCard = page.getByRole('button', {
    name: 'Open First Draft Complete',
  })
  const robotCard = page.getByRole('button', {
    name: 'Open E2E Analyze robot data',
  })

  // The single command trigger is visible in the toolbar (no active
  // filter in the baseline).
  const typeToggle = page.getByRole('button', {
    name: 'Filter, 0 active categories',
  })
  await expect(typeToggle).toBeVisible()

  const requestCountBeforeFilterChange =
    myWorkRequests.length
  expect(requestCountBeforeFilterChange).toBeGreaterThanOrEqual(
    1,
  )

  // The option set is the CLOSED canonical set of semantic kinds —
  // exactly four, in canonical order, no Other/Unknown category.
  const typeListbox = await openMyWorkFilterCategory(
    page,
    'Work item type',
  )
  await expect(typeListbox.getByRole('option')).toHaveCount(4)
  await expect(typeListbox.getByRole('option')).toHaveText([
    /Task$/,
    /Epic$/,
    /Milestone$/,
    /Deliverable$/,
  ])
  for (const option of await typeListbox.getByRole('option').all()) {
    await expect(option).toHaveAttribute('aria-selected', 'false')
  }

  // Select "Milestone": only its seeded item remains, without a
  // refetch of the personal endpoint.
  const typeSaveFlushed = expectMyWorkPreferenceSave(
    page,
    {
      ...MY_WORK_PREFERENCES_BASELINE,
      workItemTypes: ['milestone'],
    },
  )

  await typeListbox
    .getByRole('option', { name: 'Milestone' })
    .click()

  await expect(robotCard).toBeHidden()
  await expect(firstDraftCard).toBeVisible()
  expect(myWorkRequests.length).toBe(
    requestCountBeforeFilterChange,
  )

  // The active filter is visible: count badge, "WT: ..." chip, and
  // the filtered result count.
  await expect(
    page.getByRole('button', {
      name: 'Filter, 1 active category',
    }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', {
      name: 'Remove Work Item Type filter Milestone',
    }),
  ).toBeVisible()
  await expect(
    page.getByText('1 work item'),
  ).toBeVisible()

  // The applied filter survives a full reload (server-side
  // preference restore) — the verified save must have landed first.
  await typeSaveFlushed
  await page.reload()
  await expectMyWorkReady(page, {
    viewMode: 'board',
    visibleTitles: ['First Draft Complete'],
    hiddenTitles: ['E2E Analyze robot data'],
  })
  await expect(
    page.getByRole('button', {
      name: 'Filter, 1 active category',
    }),
  ).toBeVisible()

  // OR within the category: adding "Task" brings the second seeded
  // item back (both canonical kinds are selected now).
  const orSaveFlushed = expectMyWorkPreferenceSave(
    page,
    {
      ...MY_WORK_PREFERENCES_BASELINE,
      workItemTypes: ['task', 'milestone'],
    },
  )
  await openMyWorkFilterCategory(page, 'Work item type')
  await typeListbox
    .getByRole('option', { name: 'Task' })
    .click()
  await expect(robotCard).toBeVisible()
  await expect(firstDraftCard).toBeVisible()
  await expect(
    page.getByText('2 work items'),
  ).toBeVisible()
  await orSaveFlushed

  // Categories combine RESTRICTIVELY: with FG Example selected, the
  // robotics-lab item is excluded even though its kind (task) is
  // selected.
  const combinedSaveFlushed = expectMyWorkPreferenceSave(
    page,
    {
      ...MY_WORK_PREFERENCES_BASELINE,
      researchGroupIds: [fgExampleId],
      workItemTypes: ['task', 'milestone'],
    },
  )
  await openMyWorkFilterCategory(page, 'Research group')
  // No refetch on a Research Group filter change. The checkpoint
  // is taken right BEFORE the change: the earlier reload
  // legitimately issued its own initial loads, so the original
  // pre-reload baseline is not comparable here.
  const requestCountBeforeGroupChange =
    myWorkRequests.length
  await page
    .getByRole('option', { name: 'FG Example' })
    .click()
  await expect(robotCard).toBeHidden()
  await expect(firstDraftCard).toBeVisible()
  expect(myWorkRequests.length).toBe(
    requestCountBeforeGroupChange,
  )
  await combinedSaveFlushed

  // Board -> List keeps the SAME effective filtered set (one row
  // only), and back to Board. Each switch is a real change against
  // the last persisted snapshot, so each complete-snapshot
  // view-mode save is verified event-based (registered BEFORE the
  // switch) with its exact payload.
  const listModeSaveFlushed = expectMyWorkPreferenceSave(
    page,
    {
      ...MY_WORK_PREFERENCES_BASELINE,
      viewMode: 'list',
      researchGroupIds: [fgExampleId],
      workItemTypes: ['task', 'milestone'],
    },
  )
  await page
    .getByRole('button', { name: 'List' })
    .click()
  await expect(
    page.getByRole('button', {
      name: 'Open First Draft Complete',
    }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', {
      name: 'Open E2E Analyze robot data',
    }),
  ).toHaveCount(0)
  await listModeSaveFlushed

  const boardModeSaveFlushed = expectMyWorkPreferenceSave(
    page,
    {
      ...MY_WORK_PREFERENCES_BASELINE,
      researchGroupIds: [fgExampleId],
      workItemTypes: ['task', 'milestone'],
    },
  )
  await page
    .getByRole('button', { name: 'Board' })
    .click()
  await boardModeSaveFlushed

  // Global "Clear filters" clears ALL THREE categories in one
  // complete snapshot (viewMode preserved) and returns to baseline.
  const clearedSave = expectMyWorkPreferenceSave(
    page,
    MY_WORK_PREFERENCES_BASELINE,
  )
  await page
    .getByRole('button', { name: 'Clear filters' })
    .click()
  await expect(firstDraftCard).toBeVisible()
  await expect(robotCard).toBeVisible()
  await expect(
    page.getByRole('button', {
      name: 'Filter, 0 active categories',
    }),
  ).toBeVisible()

  // The persisted state is the canonical baseline again, so the
  // later specs start clean without depending on this test's
  // execution order or an in-flight save.
  await clearedSave
  const serverState = await getMyWorkPreferences(page)
  expect(
    sameMyWorkPreferences(
      serverState,
      MY_WORK_PREFERENCES_BASELINE,
    ),
  ).toBe(true)

  await page.screenshot({
    path: testInfo.outputPath(
      'my-work-work-item-type-filter.png',
    ),
    fullPage: true,
  })
})

test('My Work Kanban drag: cross-category drop mutates the canonical status from statusTargets and refetches My Work', async ({ page }, testInfo) => {
  // Capture the wire contract: exactly one canonical My Work board
  // move (POST /api/me/work-items/{id}/reorder/ carrying exactly
  // statusCategory + beforeWorkItemId — no boardPosition, no status
  // definition), zero standalone status-only transition
  // /api/work-items/{id}/transition-status/ requests, zero ordinary
  // status-changing PATCH /api/work-items/{id}/ requests, zero
  // Project reorder /api/work-items/{id}/reorder/ requests, followed
  // by exactly one authoritative GET /api/me/work-items/ refetch,
  // with zero per-Project configuration requests.
  const myWorkRequestUrls: string[] = []
  const projectConfigRequestUrls: string[] = []
  const myWorkReorderRequests: Array<{
    url: string
    payload: Record<string, unknown>
  }> = []
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

    // Refetch count = canonical list READS (GET) only. The atomic
    // board move itself (POST /api/me/work-items/{id}/reorder/)
    // shares the list's URL prefix and is tracked separately in
    // `myWorkReorderRequests`; counting it here would inflate the
    // one-refetch contract by the mutation itself.
    if (
      request.method() === 'GET' &&
      url.includes('/api/me/work-items/')
    ) {
      myWorkRequestUrls.push(url)
    }

    if (url.includes('/work-item-configuration/')) {
      projectConfigRequestUrls.push(url)
    }

    const pathname = new URL(url).pathname

    if (
      request.method() === 'POST' &&
      /\/api\/me\/work-items\/\d+\/reorder\/$/.test(
        pathname,
      )
    ) {
      myWorkReorderRequests.push({
        url,
        payload: JSON.parse(
          request.postData() ?? '{}',
        ) as Record<string, unknown>,
      })
    }

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
  expect(myWorkReorderRequests).toEqual([])
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
  //    refetched payload (not local inference) decided its column.
  //    The concrete statusName is NOT rendered on the card (the
  //    column communicates the semantic status).
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
  ).toHaveCount(0)

  // Project / Research Group context and the Kanban view survive
  // the move (the filter was untouched — it stayed "all").
  await expect(
    movedCard.getByText('Paper XYZ', { exact: true }),
  ).toBeVisible()
  await expect(
    movedCard.getByText('FG Example', { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Board' }),
  ).toHaveAttribute('aria-pressed', 'true')

  // --------------------------------------------------------
  // 3. Wire contract: exactly one canonical My Work board move
  //    (statusCategory + beforeWorkItemId only — no boardPosition,
  //    no status definition; the server resolves the concrete
  //    target from the item's statusTargets), followed by exactly
  //    one authoritative My Work refetch and zero Project
  //    configuration requests.
  // --------------------------------------------------------

  // Exactly one canonical My Work reorder — and the exact payload
  // match proves nothing else (no boardPosition, no status
  // definition, no My Work state) was sent. The drop target is the
  // EMPTY In progress column, so the anchor is the column end
  // (null).
  expect(myWorkReorderRequests).toHaveLength(1)
  const [myWorkReorder] = myWorkReorderRequests
  expect(myWorkReorder.url).toBe(
    `http://127.0.0.1:4173/api/me/work-items/${item.id}/reorder/`,
  )
  expect(myWorkReorder.payload).toEqual({
    statusCategory: 'in_progress',
    beforeWorkItemId: null,
  })

  // The standalone status-only transition, the ordinary status
  // PATCH (Project-board reposition-to-end semantics), and the
  // Project reorder endpoint must NOT be used for the My Work
  // move — project-local board_position is preserved.
  expect(transitionRequests).toEqual([])
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
  // 4. Same-category drop back into its own column: the placement
  //    leaves the persisted order unchanged (the card is the only
  //    item in the column), so it is a strict no-op — no mutation,
  //    no refetch.
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

  expect(myWorkReorderRequests).toHaveLength(1)
  expect(transitionRequests).toEqual([])
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
