import {
  expect,
  test,
  type Page,
} from '@playwright/test'

import {
  login,
  openProject,
  openProjects,
} from './helpers'

// AP-03: a failed Project Work Item configuration GET must never leak
// a Work Item into a guessed status column (the old behavior folded
// unresolvable statuses into "Todo"). The Work Items surface shows
// its explicit retryable error state instead — no board, no drop
// targets, no status-dependent mutation — and Retry re-issues the
// configuration fetch for the current project only (no page reload),
// restoring the board with the item in its REAL resolved column.

// Wide enough that all four Board columns stay visible (the same
// layout constraint the Board drag spec documents).
test.use({ viewport: { width: 1920, height: 1000 } })

const PROJECT_NAME = 'E2E Config Retry Project'
const ITEM_TITLE = 'E2E Config Retry Item'

const CONFIG_GET_URL =
  /\/api\/projects\/\d+\/work-item-configuration\//
const REORDER_URL = /\/api\/work-items\/\d+\/reorder\//

const SIMULATED_CONFIG_ERROR =
  'Simulated configuration failure.'

async function createWorkItemInProject(
  page: Page,
  title: string,
) {
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

/** Read the visible Board card titles inside one status column. */
async function columnTitles(
  page: Page,
  status: string,
): Promise<string[]> {
  const cards = page
    .locator(`[data-board-column="${status}"]`)
    .getByRole('button', { name: /^Open / })
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

test(
  'failed Work Item config GET: the retryable error state ' +
    'replaces the board, no item is guessed into a column and no ' +
    'reorder is sent, and Retry refetches the configuration and ' +
    'restores the board with the item in its real Done column',
  async ({ page }) => {
    await login(page, 'alex')
    await openProjects(page)

    // --------------------------------------------------------
    // 1. A project with one Work Item.
    // --------------------------------------------------------
    await page
      .getByRole('button', { name: /New project/ })
      .click()

    const createProjectDialog = page.getByRole(
      'dialog',
      { name: 'Create project' },
    )
    await createProjectDialog
      .getByLabel('Project name')
      .fill(PROJECT_NAME)
    await createProjectDialog
      .getByRole('button', { name: /Create project/ })
      .click()
    await expect(
      page.getByText(PROJECT_NAME, { exact: true }),
    ).toBeVisible()

    await openProject(page, PROJECT_NAME)
    await createWorkItemInProject(page, ITEM_TITLE)

    // --------------------------------------------------------
    // 2. Move the item to its real Done status BEFORE the
    //    failure simulation — via the inspector's canonical
    //    status transition, not a Board drag.
    // --------------------------------------------------------
    await page
      .getByRole('button', {
        name: `Open ${ITEM_TITLE}`,
      })
      .click()

    const inspector = page.getByRole('region', {
      name: 'Work item',
      exact: true,
    })
    await expect(inspector).toBeVisible()

    const statusSelect = inspector.getByLabel(
      'Status',
      { exact: true },
    )
    const statusOptions = await statusSelect.evaluate(
      (select) => {
        const element = select as HTMLSelectElement

        return Array.from(element.options).map((option) => ({
          id: option.value,
          name: option.text,
        }))
      },
    )
    const doneId = statusOptions.find(
      (option) => option.name === 'Done',
    )?.id
    if (doneId == null) {
      throw new Error(
        'Expected a "Done" status definition in the ' +
          `status select, got: ${JSON.stringify(statusOptions)}`,
      )
    }

    await statusSelect.selectOption(doneId)
    await expect(statusSelect).toHaveValue(doneId)

    await page
      .getByRole('button', { name: 'Close work item' })
      .click()
    await expect(inspector).not.toBeVisible()

    // Sanity: before the failure, the item sits in its real
    // Done column and nowhere else.
    await expect.poll(() => columnTitles(page, 'done')).toEqual([
      ITEM_TITLE,
    ])
    await expect.poll(() => columnTitles(page, 'todo')).toEqual([])

    // --------------------------------------------------------
    // 3/4. Fail the Project config GET with HTTP 500. All
    //    config GETs fail until Retry is clicked — the dev
    //    app mounts under React StrictMode, so the initial
    //    load may issue the configuration fetch more than
    //    once; every one of them must fail for the error
    //    state to be the settled result.
    // --------------------------------------------------------
    const configGets: string[] = []
    const reorderRequests: string[] = []
    page.on('request', (request) => {
      if (
        request.method() === 'GET' &&
        CONFIG_GET_URL.test(request.url())
      ) {
        configGets.push(request.url())
      }
      if (REORDER_URL.test(request.url())) {
        reorderRequests.push(request.url())
      }
    })
    await page.route(CONFIG_GET_URL, (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: SIMULATED_CONFIG_ERROR,
        }),
      }),
    )

    await page.reload()

    // --------------------------------------------------------
    // 5. The explicit, retryable error state.
    // --------------------------------------------------------
    const errorSection = page.locator(
      'section[aria-label="Work item status configuration error"]',
    )
    const retry = errorSection.getByRole('button', {
      name: 'Retry',
    })

    await expect(errorSection).toBeVisible()
    await expect(retry).toBeVisible()
    await expect(
      errorSection.getByRole('alert'),
    ).toContainText(
      'Work item status configuration unavailable',
    )
    await expect(
      errorSection.getByRole('alert'),
    ).toContainText(SIMULATED_CONFIG_ERROR)
    await expect(
      errorSection.getByRole('alert'),
    ).toContainText(
      'Work items stay hidden until it loads again.',
    )

    // --------------------------------------------------------
    // 6. No guessed column membership: the board is NOT
    //    rendered, the item is on NO column, and nothing
    //    status-dependent is sent.
    // --------------------------------------------------------
    await expect(page.locator('[data-board-column]')).toHaveCount(0)
    await expect(
      page.getByRole('button', {
        name: `Open ${ITEM_TITLE}`,
      }),
    ).toHaveCount(0)
    expect(reorderRequests).toEqual([])

    // --------------------------------------------------------
    // 7/8. Retry: lift the interception so the re-issued
    //    config GET reaches the real backend.
    // --------------------------------------------------------
    const configGetsBeforeRetry = configGets.length
    expect(configGetsBeforeRetry).toBeGreaterThanOrEqual(1)

    await page.unroute(CONFIG_GET_URL)
    await retry.click()

    // Exactly ONE re-issued config GET — no page reload, no
    // double fetch (mirrors the unit-level contract).
    await expect
      .poll(() => configGets.length)
      .toBe(configGetsBeforeRetry + 1)

    // --------------------------------------------------------
    // 9. The board comes back with the item in its REAL
    //    Done column — never a guessed Todo card.
    // --------------------------------------------------------
    await expect(
      page.getByRole('button', {
        name: `Open ${ITEM_TITLE}`,
      }),
    ).toBeVisible()
    await expect.poll(() => columnTitles(page, 'done')).toEqual([
      ITEM_TITLE,
    ])
    await expect.poll(() => columnTitles(page, 'todo')).toEqual([])

    // --------------------------------------------------------
    // 10. The error state is gone and the board is
    //     interactive again: the restored card is a live
    //     drag source (dragDisabled=false while the
    //     configuration is ready and the project is
    //     editable).
    // --------------------------------------------------------
    await expect(errorSection).toHaveCount(0)
    await expect(
      page
        .locator('[data-board-column="done"]')
        .getByRole('button', {
          name: `Open ${ITEM_TITLE}`,
        }),
    ).toHaveAttribute('draggable', 'true')
  },
)
