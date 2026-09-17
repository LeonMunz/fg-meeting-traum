import {
  expect,
  type Page,
  test,
} from '@playwright/test'

import { login } from './helpers'

/**
 * Focused acceptance spec for the cross-project My Work List View
 * (`/my-work` over the canonical `GET /api/me/work-items/`).
 *
 * Seed data (seed_dev + seed_e2e_scope) assigns alex exactly two
 * Work Items across two Projects and two Research Groups:
 *  - "First Draft Complete" — Paper XYZ (FG Example), due
 *    2025-12-01 (overdue), concrete status "Todo", concrete type
 *    "Milestone"
 *  - "E2E Analyze robot data" — E2E Robot Study (Robotics Lab),
 *    concrete status "Todo", concrete type "Task"
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

  // Cross-Project context on every row.
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

  // Cross-Research-Group context on every row.
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
    path: testInfo.outputPath('my-work-list.png'),
    fullPage: true,
  })

  await expectNoHorizontalOverflow(page)
})

test('opening a My Work row reaches the canonical Project Work Items surface', async ({ page }) => {
  await login(page, 'alex')
  await page.goto('/my-work')

  const robotRow = page.getByRole(
    'button',
    { name: 'Open E2E Analyze robot data' },
  )
  await expect(robotRow).toBeVisible()

  await robotRow.click()

  // The row acts on the real canonical Work Item: it lands on the
  // item's Project Work Items surface, which renders the same item.
  await expect(page).toHaveURL(
    /\/projects\/\d+\/work-items$/,
  )

  await expect(
    page.getByRole('button', {
      name: 'Open E2E Analyze robot data',
    }),
  ).toBeVisible()
})

test('My Work has no horizontal overflow at a narrow viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({
    width: 390,
    height: 844,
  })

  await login(page, 'alex')
  await page.goto('/my-work')

  const firstDraftRow = page.getByRole(
    'button',
    { name: 'Open First Draft Complete' },
  )
  await expect(firstDraftRow).toBeVisible()

  // Title and canonical status stay understandable when the
  // less-critical columns collapse into row metadata.
  await expect(
    firstDraftRow.getByText('Todo', { exact: true }),
  ).toBeVisible()

  await expectNoHorizontalOverflow(page)

  await page.screenshot({
    path: testInfo.outputPath('my-work-narrow.png'),
    fullPage: true,
  })
})
