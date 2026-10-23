import {
  expect,
  type Page,
  test,
} from '@playwright/test'
import { login, openProject, openProjects } from './helpers'
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
 * into a later run. The very last test (the failed-revalidation
 * scenario) drags the same item back into its opposite column and
 * therefore mutates it again — for the same reason it must stay the
 * final test in this file.
 *
 * That drag test proves the canonical wire contract: exactly one
 * atomic My Work board move `POST /api/me/work-items/{id}/reorder/`
 * carrying exactly `statusCategory` + `beforeWorkItemId` (no
 * boardPosition, no status definition, no standalone
 * transition-status request, no status-changing PATCH, no Project
 * reorder), followed by the mutation's authoritative
 * `GET /api/me/work-items/` refetch — and, because the RT-05 page
 * consumes the server's self-echo `my_work_changed` frame on its
 * own stream, at most ONE additional authoritative refetch (the
 * spec waits for that frame on the stream before judging the
 * request bound, so a delayed self-echo is never missed by an
 * early assertion).
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

/**
 * RT-05 realtime observation (browser E2E): the server publishes
 * the personal `my_work_changed` invalidation for the ACTING user
 * in the mutation's own transaction (commit-attached delivery), so
 * the page's own live stream receives the self-echo. The probe is
 * observation-only: it delegates EVERY EventSource construction to
 * the real native constructor (the returned instance is the
 * untouched native one — the app's listeners, payload validation,
 * and native behavior are never altered) and only counts the
 * server's named `open` handshake frames and the `my_work_changed`
 * frames that reach a stream targeting the canonical work-items
 * event endpoint.
 */
const MY_WORK_SSE_PROBE_SCRIPT = `
(() => {
  if (window.__e2eMyWorkSseProbe) {
    return;
  }
  const realEventSource = window.EventSource;
  const probe = {
    openHandshakes: 0,
    myWorkChanged: 0,
  };
  window.__e2eMyWorkSseProbe = probe;

  function observedEventSource(url, options) {
    const source = new realEventSource(url, options);
    if (!String(url).includes('/api/work-items/events/')) {
      return source;
    }
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
          probe.openHandshakes += 1;
        }
      } catch {
        // Not a JSON handshake frame — ignored.
      }
    });
    source.addEventListener('my_work_changed', () => {
      probe.myWorkChanged += 1;
    });
    return source;
  }

  observedEventSource.prototype = realEventSource.prototype;
  observedEventSource.CONNECTING = realEventSource.CONNECTING;
  observedEventSource.OPEN = realEventSource.OPEN;
  observedEventSource.CLOSED = realEventSource.CLOSED;
  window.EventSource = observedEventSource;
})();
`

interface MyWorkSseProbe {
  openHandshakes: number
  myWorkChanged: number
}

function installMyWorkSseProbe(page: Page): void {
  void page.addInitScript(MY_WORK_SSE_PROBE_SCRIPT)
}

async function readMyWorkSseProbe(
  page: Page,
): Promise<MyWorkSseProbe> {
  const probe = await page.evaluate(
    () =>
      (
        window as unknown as {
          __e2eMyWorkSseProbe?: MyWorkSseProbe
        }
      ).__e2eMyWorkSseProbe,
  )
  return probe ?? { openHandshakes: 0, myWorkChanged: 0 }
}

/**
 * Wait until the page's canonical My Work reads are QUIESCENT — no
 * read in flight AND the settled request count unchanged across a
 * bounded quiet window (the check retries, so a request in transit
 * during one window is caught by the next). Returns the settled
 * count. The realtime self-echo makes a bare "exactly N requests"
 * snapshot racy (the echo's refetch may still be in transit), so a
 * request count is only trusted once the wire has proven it is
 * quiet.
 */
async function waitForMyWorkWireQuiescence(
  page: Page,
  inFlight: () => number,
  totalCount: () => number,
): Promise<number> {
  let settled = -1
  await expect
    .poll(async () => {
      if (inFlight() > 0) {
        return -1
      }
      const snapshot = totalCount()
      await page.waitForTimeout(250)
      const after = totalCount()
      if (after !== snapshot) {
        return -1
      }
      settled = after
      return after
    }, {
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(0)
  return settled
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

// AP-07: the My Work Kanban card's OWN action menu (the shared
// three-dot "Work item actions" / "Delete work item", rendered
// ONLY when the item's server-derived
// actionPermissions.canDelete is true) had no dedicated browser
// acceptance — the Project Board card path is covered in
// e2e/project-work-item-deletion.spec.ts, but the My Work
// card-originated delete runs through the page-level dialog +
// performWorkItemDelete (no drawer-context guard). This test
// drives the complete flow on a FRESH project + FRESH Work Item
// self-assigned to alex, so the canonical seed data is never
// mutated: the trigger opens ONLY the menu (never the drawer),
// Cancel leaves the item intact without any DELETE, and the
// confirmed delete sends exactly one DELETE
// /api/work-items/{id}/ followed by exactly one authoritative
// GET /api/me/work-items/ refresh that removes the card — while
// the two seeded items and the /my-work URL stay untouched.
test('My Work card action menu deletes the assigned Work Item without opening the drawer', async ({ page }) => {
  // RT-05 self-echo probe: must see every navigation of this page
  // (installed before login / goto).
  installMyWorkSseProbe(page)

  const title = 'E2E My Work Deletion Task'
  const projectName = 'E2E My Work Deletion Project'

  // Wire contract from the very start: setup (project/item
  // create) may only use POST — every canonical Work Item
  // DELETE and every authoritative My Work refetch lands in
  // this ordered log.
  const wireEvents: Array<{
    kind: 'delete' | 'my-work-fetch'
    url: string
  }> = []
  // Canonical personal reads currently in flight (request seen,
  // response not yet settled) — the quiescence barrier's input.
  let myWorkGetsInFlight = 0
  page.on('request', (request) => {
    const url = request.url()
    const pathname = new URL(url).pathname

    if (
      request.method() === 'DELETE' &&
      /\/api\/work-items\/\d+\/$/.test(pathname)
    ) {
      wireEvents.push({ kind: 'delete', url })
    } else if (
      request.method() === 'GET' &&
      pathname === '/api/me/work-items/'
    ) {
      wireEvents.push({ kind: 'my-work-fetch', url })
      myWorkGetsInFlight += 1
    }
  })

  page.on('response', (response) => {
    const url = response.url()
    const pathname = new URL(url).pathname
    if (
      response.request().method() === 'GET' &&
      pathname === '/api/me/work-items/'
    ) {
      myWorkGetsInFlight -= 1
    }
  })

  const inspectorRegion = page.getByRole(
    'region',
    { name: 'Work item', exact: true },
  )

  await login(page, 'alex')

  // Canonical server-side baseline (Board view, no active
  // filters) persisted BEFORE the first My Work render — the
  // same order-independent contract the other scenarios use.
  await setMyWorkPreferences(
    page,
    MY_WORK_PREFERENCES_BASELINE,
  )

  // --------------------------------------------------------
  // Setup: a fresh project (alex = owner) + a fresh Work Item
  // self-assigned to alex in the create dialog itself — the
  // only way the My Work card carries
  // actionPermissions.canDelete without touching the canonical
  // seed data.
  // --------------------------------------------------------
  await openProjects(page)

  await page
    .getByRole('button', { name: /New project/ })
    .click()

  const projectDialog = page.getByRole('dialog', {
    name: 'Create project',
  })
  await expect(projectDialog).toBeVisible()
  await projectDialog.getByLabel('Project name').fill(projectName)
  await projectDialog
    .getByRole('button', { name: /Create project/ })
    .click()
  await expect(
    page.getByText(projectName, { exact: true }),
  ).toBeVisible()

  await openProject(page, projectName)

  await page
    .getByRole('button', { name: /New work item/ })
    .click()

  const workItemDialog = page.getByRole('dialog', {
    name: 'New work item',
  })
  await expect(workItemDialog).toBeVisible()
  await workItemDialog.getByLabel('Title').fill(title)

  // Self-assign through the create dialog's canonical Assignees
  // fieldset (no separate inspector round-trip needed).
  await workItemDialog
    .getByRole('button', { name: 'Add assignee…' })
    .click()
  const alexRow = workItemDialog
    .locator('label')
    .filter({ hasText: 'Alex Dev' })
  await alexRow.getByRole('checkbox').check()
  await expect(alexRow.getByRole('checkbox')).toBeChecked()

  await workItemDialog
    .getByRole('button', { name: /Create work item/ })
    .click()
  await expect(workItemDialog).not.toBeVisible()

  // The board card renders from the creation; the drawer was
  // never part of the setup path.
  await expect(
    page.getByRole('button', {
      name: `Open ${title}`,
      exact: true,
    }),
  ).toBeVisible()
  await expect(inspectorRegion).not.toBeVisible()

  // --------------------------------------------------------
  // My Work: the assigned item is in the canonical personal
  // payload WITH the server-derived delete permission the card
  // menu is gated on.
  // --------------------------------------------------------
  await page.goto('/my-work')

  await expectMyWorkReady(page, {
    viewMode: 'board',
    visibleTitles: [
      title,
      'First Draft Complete',
      'E2E Analyze robot data',
    ],
  })

  const payloadResponse = await page.request.get(
    '/api/me/work-items/',
  )
  expect(
    payloadResponse.ok(),
    'The canonical My Work payload must be readable.',
  ).toBe(true)

  const payload = (await payloadResponse.json()) as Array<{
    id: number
    title: string
    actionPermissions: { canDelete: boolean }
  }>
  const createdItem = payload.find(
    (item) => item.title === title,
  )
  expect(
    createdItem,
    `The self-assigned Work Item "${title}" must be in the canonical My Work payload.`,
  ).toBeTruthy()
  const created = createdItem as {
    id: number
    title: string
    actionPermissions: { canDelete: boolean }
  }
  expect(
    created.actionPermissions.canDelete,
    'The server must carry canDelete=true for the assigned item (the card menu is gated on it).',
  ).toBe(true)
  const workItemId = created.id

  // 1. The card + its server-gated "Work item actions" trigger.
  const myWorkCard = page.getByRole('button', {
    name: `Open ${title}`,
    exact: true,
  })
  await expect(myWorkCard).toBeVisible()

  const trigger = myWorkCard.getByRole('button', {
    name: 'Work item actions',
  })
  await expect(trigger).toBeVisible()

  // 2. The trigger opens ONLY the action menu — never the drawer.
  await trigger.click()
  const deleteMenuItem = myWorkCard.getByRole('menuitem', {
    name: 'Delete work item',
  })
  await expect(deleteMenuItem).toBeVisible()
  await expect(inspectorRegion).not.toBeVisible()

  // 3. Delete work item opens the existing confirmation dialog.
  await deleteMenuItem.click()
  const deleteDialog = page.getByRole('dialog', {
    name: 'Delete work item?',
  })
  await expect(deleteDialog).toBeVisible()
  await expect(inspectorRegion).not.toBeVisible()

  // 4. Cancel: dialog closes, item intact, NO DELETE occurred.
  await deleteDialog
    .getByRole('button', { name: /Cancel/ })
    .click()
  await expect(deleteDialog).not.toBeVisible()
  expect(
    wireEvents.filter((event) => event.kind === 'delete'),
  ).toEqual([])
  await expect(myWorkCard).toBeVisible()
  await expect(page.getByText(title, { exact: true })).toBeVisible()
  await expect(inspectorRegion).not.toBeVisible()

  // 5. Reopen + confirm: exactly ONE DELETE to the canonical
  //    endpoint of THIS item, followed by the delete's own
  //    authoritative My Work refetch (and — the RT-05 self-echo —
  //    exactly one further refetch; proven below).
  //
  // The self-echo frame counter before the confirmed delete (the
  // setup's work-item create published its invalidation before
  // this page's stream existed, so this is the mutation's own
  // baseline).
  const echoFramesBeforeConfirm =
    (await readMyWorkSseProbe(page)).myWorkChanged

  await trigger.click()
  await expect(deleteMenuItem).toBeVisible()
  await expect(inspectorRegion).not.toBeVisible()
  await deleteMenuItem.click()
  await expect(deleteDialog).toBeVisible()
  await deleteDialog
    .getByRole('button', { name: /^Delete work item$/ })
    .click()

  // 6. After the authoritative refresh the card is gone…
  await expect(deleteDialog).not.toBeVisible()
  await expect(myWorkCard).toHaveCount(0)
  await expect(page.getByText(title, { exact: true })).toHaveCount(0)

  // …because the refetched payload decided it: exactly one DELETE
  // to this item's canonical endpoint, an authoritative read
  // following the DELETE directly — and, because the RT-05 page
  // consumes the server's self-echo my_work_changed frame on its
  // own stream, exactly ONE further authoritative refetch after
  // that (nothing else may follow a confirmed delete).
  await expect
    .poll(() =>
      wireEvents.filter((event) => event.kind === 'delete'),
    )
    .toHaveLength(1)
  const deleteEvent = wireEvents.find(
    (event) => event.kind === 'delete',
  )
  if (!deleteEvent) {
    throw new Error(
      'The confirmed delete sent no DELETE request.',
    )
  }
  expect(deleteEvent.url).toBe(
    `http://127.0.0.1:4173/api/work-items/${workItemId}/`,
  )

  // Ordering: an authoritative My Work read follows the DELETE
  // directly (no other ledgered kind may intervene).
  const deleteIndex = wireEvents.indexOf(deleteEvent)
  await expect
    .poll(() => wireEvents[deleteIndex + 1]?.kind)
    .toBe('my-work-fetch')

  // Realtime self-echo barrier: the server publishes one personal
  // my_work_changed per persisted former assignee in the delete's
  // own transaction (commit-attached delivery) — the deleted item
  // was self-assigned to the acting user, so the page's own live
  // stream receives the self-echo. The RT-05 page honors that
  // frame with exactly ONE authoritative SILENT refetch, no matter
  // when the frame lands relative to the delete's own revalidation
  // (the delete flow has no coalescing shortcut). The frame's
  // delivery is independent of the DELETE response, so wait for it
  // ON THE STREAM before judging the request bound — a delayed
  // self-echo must not be missed by an early snapshot.
  await expect
    .poll(async () =>
      (await readMyWorkSseProbe(page)).myWorkChanged)
    .toBeGreaterThan(echoFramesBeforeConfirm)

  // Boundedness: once the wire is quiet, the ledger tail from the
  // DELETE is EXACTLY the delete plus the two authoritative reads
  // (the delete's own revalidation + the one self-echo refetch). A
  // third read would mean an unbounded refetch loop.
  await waitForMyWorkWireQuiescence(
    page,
    () => myWorkGetsInFlight,
    () =>
      wireEvents.filter(
        (event) => event.kind === 'my-work-fetch',
      ).length,
  )
  expect(
    wireEvents.slice(deleteIndex).map((event) => event.kind),
  ).toEqual([
    'delete',
    'my-work-fetch',
    'my-work-fetch',
  ])

  // Persistence: the deletion is committed server-side — the
  // canonical payload no longer carries the item, and the two
  // seeded items remain (read through the browser's own session
  // via the API request context — not page traffic, so the wire
  // ledger above is untouched).
  const readbackResponse = await page.request.get(
    '/api/me/work-items/',
  )
  expect(readbackResponse.ok()).toBe(true)
  const readback = (await readbackResponse.json()) as Array<{
    id: number
    title: string
  }>
  expect(
    readback.find((item) => item.id === workItemId),
    'The deleted Work Item must be gone from the canonical server payload.',
  ).toBeUndefined()
  expect(
    readback.some((item) => item.title === 'First Draft Complete'),
  ).toBe(true)
  expect(
    readback.some((item) => item.title === 'E2E Analyze robot data'),
  ).toBe(true)

  // 7. The URL never left /my-work…
  await expect(page).toHaveURL(/\/my-work$/)

  // …and the two seeded Work Items remain untouched.
  await expect(
    page.getByRole('button', {
      name: 'Open First Draft Complete',
      exact: true,
    }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', {
      name: 'Open E2E Analyze robot data',
      exact: true,
    }),
  ).toBeVisible()

  // The drawer never opened at any point.
  await expect(inspectorRegion).not.toBeVisible()
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
  // RT-05 self-echo probe: must see every navigation of this page
  // (installed before login / goto).
  installMyWorkSseProbe(page)

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
  // Canonical personal reads currently in flight (request seen,
  // response not yet settled) — the quiescence barrier's input.
  let myWorkGetsInFlight = 0

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
      myWorkGetsInFlight += 1
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
      myWorkGetsInFlight -= 1
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

  // Deterministic startup baseline: the SSE `open` handshake
  // (RC-5) revalidates on connect and can still be in flight when
  // the first content renders (StrictMode double-mount + the
  // handshake make the ABSOLUTE startup count timing-dependent).
  // Wait for the handshake frame on the stream AND for the
  // revalidation it triggered to settle — only then does the
  // baseline include ALL startup traffic, so the post-mutation
  // bound below is deterministic.
  await expect
    .poll(async () =>
      (await readMyWorkSseProbe(page)).openHandshakes)
    .toBeGreaterThanOrEqual(1)
  await waitForMyWorkWireQuiescence(
    page,
    () => myWorkGetsInFlight,
    () => myWorkRequestUrls.length,
  )

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

  // The self-echo frame counter before the drag (the stream is
  // live and quiescent behind the barrier above — this is the
  // mutation's own baseline).
  const echoFramesBeforeDrag =
    (await readMyWorkSseProbe(page)).myWorkChanged

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

  // Realtime self-echo barrier: the server publishes exactly one
  // personal my_work_changed for the ACTING user in the move's own
  // transaction (commit-attached delivery; identical nested
  // publications are coalesced), and the page's own live stream
  // receives it as a self-echo. The RT-05 page honors that frame
  // with one authoritative SILENT refetch: a frame delivered while
  // the move's revalidation is still in flight is coalesced into
  // it (one fetch total); a frame delivered after the revalidation
  // settled costs exactly ONE additional refetch (two fetches
  // total) — never more (the held flag is consumed by the flush).
  // The frame's delivery is independent of the mutation response,
  // so wait for it ON THE STREAM before judging the request bound
  // — a delayed self-echo must not be missed by an early snapshot.
  await expect
    .poll(async () =>
      (await readMyWorkSseProbe(page)).myWorkChanged)
    .toBeGreaterThan(echoFramesBeforeDrag)

  // All canonical reads (including any self-echo refetch) settled.
  const settledAfterMove = await waitForMyWorkWireQuiescence(
    page,
    () => myWorkGetsInFlight,
    () => myWorkRequestUrls.length,
  )

  // The mutation's own authoritative read happened ...
  expect(settledAfterMove).toBeGreaterThanOrEqual(
    myWorkRequestsAfterLoad + 1,
  )
  // ... and the self-echo added AT MOST one more (boundedness —
  // no unbounded refetch loop).
  expect(settledAfterMove).toBeLessThanOrEqual(
    myWorkRequestsAfterLoad + 2,
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

  // Bounded quiet window: nothing should have happened at all —
  // the no-op placement sends nothing (the client's isNoOp
  // short-circuit; the server publishes nothing for a genuine
  // no-op move) and the FIRST move's self-echo was already drained
  // by the barrier above, so `settledAfterMove` is the complete
  // wire state to compare against.
  await page.waitForTimeout(300)

  expect(myWorkReorderRequests).toHaveLength(1)
  expect(transitionRequests).toEqual([])
  expect(statusPatchRequests).toEqual([])
  expect(reorderRequests).toEqual([])
  expect(myWorkRequestUrls.length).toBe(settledAfterMove)
  await expect(movedCard).toBeVisible()

  // The no-op drag also never opens the drawer.
  await expect(
    page.getByRole('region', {
      name: 'Work item',
    }),
  ).toBeHidden()
})

test('My Work Kanban drag: a failed revalidation after a successful move stays visible and retryable (the move is never reported as failed)', async ({ page }, testInfo) => {
  // RT-05 self-echo probe: must see every navigation of this page
  // (installed before login / goto).
  installMyWorkSseProbe(page)

  // AP-06: mutation and revalidation are handled separately. The
  // atomic reorder POST succeeds, and the subsequent authoritative
  // GET /api/me/work-items/ revalidation is failed by route
  // interception. The failed revalidation must be VISIBLE (a
  // page-local dismissible notice carrying the server error), must
  // NEVER be reported as a failed move, and must be REPEATABLE
  // (the notice's Retry re-runs ONLY the revalidation and the
  // board renders the authoritative moved position). No optimistic
  // relocation is made, so the card stays in its last
  // authoritative column until the revalidation succeeds.
  //
  // Seed-state independence: in a full sequential run the previous
  // test has moved "First Draft Complete" into In progress; in an
  // isolated run (-g) it is still in Todo — the target column is
  // therefore derived from the item's CURRENT payload category.
  //
  // RT-05: the move's own self-echo (one personal my_work_changed
  // delivered on the page's live stream) may cost ONE additional
  // authoritative refetch on top of the mutation's own
  // revalidation — the documented bound is one or two
  // post-mutation GETs, never unbounded. The SSE probe observes
  // the frame ON THE STREAM, and the wire quiescence barrier
  // settles all reads before the count is judged (the same
  // convention the successful-move test above uses).
  type StatusTarget = {
    statusCategory: string
    statusDefinitionId: number
    statusName: string
  }

  // Mirrors the canonical GET /api/me/work-items/ item payload
  // (the backend PersonalMyWorkListView + the frontend
  // ApiPersonalWorkItem contract): the concrete statusName is
  // display metadata for the canonical statusDefinitionId.
  type PersonalWorkItem = {
    id: number
    title: string
    statusCategory: string
    statusName: string
    statusTargets: StatusTarget[]
  }

  let myWorkPayload: PersonalWorkItem[] = []

  // Wire ledger — the explicit mapping of what happened on the
  // wire: every canonical list READ (GET) with its HTTP status,
  // and every canonical My Work board move (reorder POST) with
  // its exact payload. No positional request counting.
  const listGetResponses: Array<{
    url: string
    status: number
  }> = []
  const reorderPostRequests: Array<{
    url: string
    payload: Record<string, unknown>
  }> = []

  // Identity-based interception decision: the simulated outage
  // applies to a list GET only once the reorder mutation itself
  // has been dispatched. The initial load (and any other
  // pre-mutation read) is necessarily earlier than the reorder,
  // so it always passes through — and the reorder POST never
  // matches the intercepted list URL in the first place.
  let reorderDispatched = false
  // Canonical list GETs currently in flight (request seen,
  // response not yet settled) — the quiescence barrier's input.
  let listGetsInFlight = 0

  page.on('request', (request) => {
    const url = request.url()
    const pathname = new URL(url).pathname

    if (
      request.method() === 'GET' &&
      url.endsWith('/api/me/work-items/')
    ) {
      listGetsInFlight += 1
    }

    if (
      request.method() === 'POST' &&
      /\/api\/me\/work-items\/\d+\/reorder\/$/.test(pathname)
    ) {
      reorderDispatched = true
      reorderPostRequests.push({
        url: request.url(),
        payload: JSON.parse(
          request.postData() ?? '{}',
        ) as Record<string, unknown>,
      })
    }
  })

  page.on('response', (response) => {
    if (
      response.url().endsWith(
        '/api/me/work-items/',
      ) &&
      response.request().method() === 'GET'
    ) {
      listGetsInFlight -= 1
      listGetResponses.push({
        url: response.url(),
        status: response.status(),
      })
      void response
        .json()
        .then((payload) => {
          if (Array.isArray(payload)) {
            myWorkPayload =
              payload as PersonalWorkItem[]
          }
        })
        .catch(() => {
          // Non-JSON body (e.g. the simulated 503): keep the
          // last successful payload.
        })
    }
  })

  // The outage is armed BEFORE the initial load, so this test
  // proves the route passes the initial GET through — it fails
  // only the post-mutation revalidation (keyed to the reorder
  // dispatch, never to a request position).
  await page.route(/\/api\/me\/work-items\/$/, (route) => {
    if (
      route.request().method() === 'GET' &&
      reorderDispatched
    ) {
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Simulated refetch outage.',
        }),
      })
    }
    return route.continue()
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

  const cardName = 'Open First Draft Complete'
  await expect(
    page.getByRole('button', { name: cardName }),
  ).toBeVisible()
  await expect
    .poll(() => myWorkPayload.length)
    .toBeGreaterThan(0)

  const item = myWorkPayload.find(
    (candidate) =>
      candidate.title === 'First Draft Complete',
  )
  if (!item) {
    throw new Error(
      'Seeded "First Draft Complete" missing from the My Work payload.',
    )
  }

  // Cross-category target: the opposite of the item's CURRENT
  // category — the seeded Paper XYZ configuration resolves a
  // concrete status target for each semantic category (the
  // previous test already moved this item cross-category).
  const targetCategory =
    item.statusCategory === 'todo'
      ? 'in_progress'
      : 'todo'
  const target = item.statusTargets.find(
    (candidate) =>
      candidate.statusCategory === targetCategory,
  )
  if (!target) {
    throw new Error(
      `Seeded item has no ${targetCategory} statusTarget.`,
    )
  }

  const sourceColumn = page.locator(
    `[data-board-column="${item.statusCategory}"]`,
  )
  const targetColumn = page.locator(
    `[data-board-column="${targetCategory}"]`,
  )

  // Deterministic startup baseline: the SSE `open` handshake
  // (RC-5) revalidates on connect and can still be in flight when
  // the first content renders (StrictMode double-mount + the
  // handshake make the ABSOLUTE startup count timing-dependent).
  // Wait for the handshake frame on the stream AND for the
  // revalidation it triggered to settle — only then does the
  // baseline include ALL startup traffic, so the post-mutation
  // bound below is deterministic.
  await expect
    .poll(async () =>
      (await readMyWorkSseProbe(page)).openHandshakes)
    .toBeGreaterThanOrEqual(1)
  await waitForMyWorkWireQuiescence(
    page,
    () => listGetsInFlight,
    () => listGetResponses.length,
  )

  // Baseline ledger: every startup list GET (the initial loads
  // plus the RC-5 handshake revalidation) succeeded as a 200
  // passthrough, and no mutation happened yet.
  expect(listGetResponses.length).toBeGreaterThan(0)
  expect(
    listGetResponses.every(
      (entry) => entry.status === 200,
    ),
  ).toBe(true)
  expect(reorderPostRequests).toEqual([])
  const listGetsAfterLoad = listGetResponses.length

  // --------------------------------------------------------
  // 1. Drag the card into the target column: a real
  //    cross-category move — the atomic reorder POST reaches
  //    the backend and succeeds (it never matches the
  //    intercepted list URL).
  // --------------------------------------------------------

  const reorderResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/api\/me\/work-items\/\d+\/reorder\/$/.test(
        new URL(response.url()).pathname,
      ),
  )

  await targetColumn.scrollIntoViewIfNeeded()
  const cardLocator = page.getByRole('button', {
    name: cardName,
  })
  const cardBox = await cardLocator.boundingBox()
  const targetBox = await targetColumn.boundingBox()
  if (!cardBox || !targetBox) {
    throw new Error(
      'Card or target column bounding box not found.',
    )
  }

  // The self-echo frame counter before the drag (the stream is
  // live and quiescent behind the barrier above — this is the
  // mutation's own baseline).
  const echoFramesBeforeDrag =
    (await readMyWorkSseProbe(page)).myWorkChanged

  // Native HTML5 drag-and-drop needs a real mouse gesture (not
  // locator.dragTo's single jump) for Chromium to recognize the
  // drag threshold and dispatch dragstart/dragover/drop.
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

  // The atomic reorder reached the backend and SUCCEEDED —
  // exactly once, at the canonical endpoint, carrying exactly
  // the target column plus the positional anchor (null = end of
  // the column); no boardPosition, no status definition, no My
  // Work state.
  const reorderResponse = await reorderResponsePromise
  expect(reorderResponse.status()).toBeLessThan(300)
  expect(reorderPostRequests).toHaveLength(1)
  expect(reorderPostRequests[0].url).toBe(
    `http://127.0.0.1:4173/api/me/work-items/${item.id}/reorder/`,
  )
  expect(
    Object.keys(reorderPostRequests[0].payload).sort(),
  ).toEqual([
    'beforeWorkItemId',
    'statusCategory',
  ])
  expect(
    reorderPostRequests[0].payload.statusCategory,
  ).toBe(targetCategory)

  // --------------------------------------------------------
  // 2. The post-mutation revalidation GET received the
  //    simulated outage (HTTP 503): no optimistic relocation
  //    (the card stays in its source column) and the failure
  //    is visible — never reported as a failed move.
  // --------------------------------------------------------

  // Realtime self-echo barrier: the server publishes exactly one
  // personal my_work_changed for the ACTING user in the move's own
  // transaction (commit-attached delivery), and the page's own
  // live stream receives it as a self-echo. The RT-05 page honors
  // that frame with one authoritative SILENT refetch: a frame
  // delivered while the move's revalidation is still in flight is
  // coalesced into it (one fetch total); a frame delivered after
  // the revalidation settled costs exactly ONE additional refetch
  // (two fetches total) — never more (the held flag is consumed by
  // the flush). The frame's delivery is independent of the
  // mutation response, so wait for it ON THE STREAM before
  // judging the request bound — a delayed self-echo must not be
  // missed by an early snapshot.
  await expect
    .poll(async () =>
      (await readMyWorkSseProbe(page)).myWorkChanged)
    .toBeGreaterThan(echoFramesBeforeDrag)

  // All canonical reads (including any self-echo refetch) settled.
  const settledAfterMove = await waitForMyWorkWireQuiescence(
    page,
    () => listGetsInFlight,
    () => listGetResponses.length,
  )

  // The mutation's own revalidation read happened ...
  expect(settledAfterMove).toBeGreaterThanOrEqual(
    listGetsAfterLoad + 1,
  )
  // ... and the self-echo added AT MOST one more (boundedness —
  // no unbounded refetch loop; the delayed self-echo is the ONLY
  // second read the RT-05 contract allows).
  expect(settledAfterMove).toBeLessThanOrEqual(
    listGetsAfterLoad + 2,
  )
  // ... and the wire ledger records EVERY post-mutation read as
  // the simulated outage, not a passthrough.
  const postMoveGets = listGetResponses.slice(
    listGetsAfterLoad,
  )
  expect(postMoveGets.length).toBeGreaterThanOrEqual(1)
  expect(postMoveGets.length).toBeLessThanOrEqual(2)
  expect(
    postMoveGets.every(
      (entry) =>
        entry.url ===
        'http://127.0.0.1:4173/api/me/work-items/' &&
        entry.status === 503,
    ),
  ).toBe(true)

  const sourceCard = sourceColumn.getByRole('button', {
    name: cardName,
  })
  const targetCard = targetColumn.getByRole('button', {
    name: cardName,
  })
  await expect(sourceCard).toBeVisible()
  // No optimistic relocation: the card is NOT in the target
  // column yet.
  await expect(targetCard).toHaveCount(0)

  const alertLocator = page.locator('[role="alert"]')
  await expect(alertLocator).toHaveCount(1)
  await expect(alertLocator).toContainText(
    'Simulated refetch outage.',
  )
  await expect(alertLocator).not.toContainText(
    'Work item could not be moved.',
  )

  await page.screenshot({
    path: testInfo.outputPath(
      'my-work-drag-refetch-failed.png',
    ),
  })

  // --------------------------------------------------------
  // 3. Repeatable: lift the failure and retry from the notice —
  //    the retry re-runs ONLY the authoritative GET (no second
  //    reorder POST), the board renders the authoritative moved
  //    position, and the notice clears.
  // --------------------------------------------------------

  await page.unroute(/\/api\/me\/work-items\/$/)
  const listGetsBeforeRetry = listGetResponses.length
  await alertLocator
    .getByRole('button', { name: 'Retry' })
    .click()

  await expect(targetCard).toBeVisible()
  await expect(sourceCard).toHaveCount(0)
  await expect(alertLocator).toHaveCount(0)

  // The retry is a pure re-read: exactly one more canonical
  // list GET (succeeded) and the reorder ledger still holds
  // exactly one POST — the retry never re-sends the move.
  await expect
    .poll(() => listGetResponses.length)
    .toBe(listGetsBeforeRetry + 1)
  expect(
    listGetResponses.slice(listGetsBeforeRetry),
  ).toEqual([
    {
      url: 'http://127.0.0.1:4173/api/me/work-items/',
      status: 200,
    },
  ])
  expect(reorderPostRequests).toHaveLength(1)

  // The refetched payload is authoritative: the item now reports
  // the target category with the concrete target status name.
  await expect
    .poll(() =>
      myWorkPayload.find(
        (candidate) => candidate.id === item.id,
      )?.statusCategory,
    )
    .toBe(targetCategory)
  expect(
    myWorkPayload.find(
      (candidate) => candidate.id === item.id,
    )?.statusName,
  ).toBe(target.statusName)

  await page.screenshot({
    path: testInfo.outputPath(
      'my-work-drag-refetch-retried.png',
    ),
  })
})
