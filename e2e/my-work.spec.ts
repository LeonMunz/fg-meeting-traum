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
 * the read-only global Kanban they both sit in the Todo column (the
 * other three global columns render empty).
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

test('opening a My Work card reaches the canonical Project Work Items surface', async ({ page }) => {
  await login(page, 'alex')
  await page.goto('/my-work')

  const robotCard = page.getByRole(
    'button',
    { name: 'Open E2E Analyze robot data' },
  )
  await expect(robotCard).toBeVisible()

  await robotCard.click()

  // The card acts on the real canonical Work Item: it lands on
  // the item's Project Work Items surface, which renders the
  // same item.
  await expect(page).toHaveURL(
    /\/projects\/\d+\/work-items$/,
  )

  await expect(
    page.getByRole('button', {
      name: 'Open E2E Analyze robot data',
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
