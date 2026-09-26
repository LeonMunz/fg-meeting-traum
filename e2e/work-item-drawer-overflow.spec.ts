import {
  expect,
  test,
  type Locator,
  type Page,
} from '@playwright/test'

import {
  login,
  logout,
  openProject,
  openProjects,
} from './helpers'

// Work Item Drawer layout-stabilization acceptance (LPM-20):
//   1. The drawer keeps one vertical-only scrolling model — with
//      normal content, enough Activity content to scroll, and
//      pathological long/unbroken user content, neither the drawer's
//      main scroll container nor the Activity list may develop a
//      horizontal overflow (scrollWidth <= clientWidth), and vertical
//      scrolling must keep working.
//   2. In title edit mode the input (border + focus ring included)
//      stays geometrically inside the content column — no clipping,
//      edit and view mode aligned — and long titles remain editable
//      without widening the drawer. Title save still succeeds.
//
// The browser measures real computed geometry; DOM/source inspection
// alone is not sufficient for this acceptance.

const PROJECT_NAME =
  'E2E Drawer Overflow Project'
const TASK_TITLE =
  'E2E Drawer Overflow Task'
const PATHOLOGICAL_TITLE =
  'x'.repeat(160)
const NORMAL_COMMENT =
  'First comment with normal text.'
const SCROLLING_COMMENT =
  'Scrolling activity line. '.repeat(40)
const PATHOLOGICAL_COMMENT =
  'y'.repeat(400)

test.use({
  viewport: { width: 1280, height: 800 },
})

type ScrollMetrics = {
  scrollWidth: number
  clientWidth: number
  scrollHeight: number
  clientHeight: number
}

/**
 * Reads the live geometry of the drawer's main scroll container
 * (`div.space-y-7.overflow-y-auto`) and the Activity list
 * (`ul[aria-label="Activity"]`).
 */
async function readDrawerScrollMetrics(
  page: Page,
): Promise<{
  main: ScrollMetrics
  activity: ScrollMetrics
}> {
  return page.evaluate(() => {
    const region = document.querySelector(
      '[aria-labelledby="work-item-drawer-title"]',
    )
    if (!region) {
      throw new Error('Work Item drawer region not found')
    }
    const main = region.querySelector(
      '.space-y-7.overflow-y-auto',
    )
    const activity = region.querySelector(
      'ul[aria-label="Activity"]',
    )
    if (!main || !activity) {
      throw new Error('Drawer scroll containers not found')
    }
    const metrics = (el: HTMLElement): ScrollMetrics => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    })
    return {
      main: metrics(main),
      activity: metrics(activity),
    }
  })
}

async function postComment(
  page: Page,
  inspector: Locator,
  body: string,
) {
  const activityList = inspector.getByRole(
    'list',
    { name: 'Activity' },
  )

  const idleComposer = inspector.getByRole(
    'button',
    { name: 'Add a comment…' },
  )
  await expect(idleComposer).toBeVisible()
  await idleComposer.click()

  const composer = inspector.getByLabel(
    'Comment',
    { exact: true },
  )
  await expect(composer).toBeVisible()
  await composer.fill(body)

  await page.keyboard.press('ControlOrMeta+Enter')

  await expect(
    activityList.getByText(body, { exact: true }),
  ).toBeVisible()
}

test(
  'Work Item drawer: Activity stays vertical-only (normal, scrolling, pathological) and title editing never clips',
  async ({ page }) => {
    await login(page, 'alex')
    await openProjects(page)

    // --------------------------------------------------------
    // Setup: a fresh project with one Work Item.
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
      .getByRole('button', {
        name: /Create project/,
      })
      .click()

    await expect(
      page.getByText(PROJECT_NAME, { exact: true }),
    ).toBeVisible()
    await openProject(page, PROJECT_NAME)

    await page
      .getByRole('button', { name: /New work item/ })
      .click()

    const createDialog = page.getByRole(
      'dialog',
      { name: 'New work item' },
    )
    await createDialog
      .getByLabel('Title')
      .fill(TASK_TITLE)
    await createDialog
      .getByRole('button', {
        name: /Create work item/,
      })
      .click()

    // --------------------------------------------------------
    // 1. Open the real drawer over the Board.
    // --------------------------------------------------------

    await page
      .getByRole('button', {
        name: `Open ${TASK_TITLE}`,
      })
      .click()

    const inspector = page.getByRole('region', {
      name: 'Work item',
      exact: true,
    })
    await expect(inspector).toBeVisible()
    await expect(
      inspector.getByRole('heading', {
        name: 'Activity',
        exact: true,
      }),
    ).toBeVisible()

    const titleView = inspector.getByRole('button', {
      name: TASK_TITLE,
      exact: true,
    })
    await expect(titleView).toBeVisible()
    const titleViewBox = await titleView.boundingBox()
    expect(titleViewBox).not.toBeNull()

    // --------------------------------------------------------
    // 2. Seed Activity: normal content, enough content for
    //    vertical scrolling, and a pathological long/unbroken
    //    comment.
    // --------------------------------------------------------

    await postComment(
      page,
      inspector,
      NORMAL_COMMENT,
    )
    await postComment(
      page,
      inspector,
      SCROLLING_COMMENT,
    )
    await postComment(
      page,
      inspector,
      PATHOLOGICAL_COMMENT,
    )

    // --------------------------------------------------------
    // 3. No horizontal overflow anywhere in the drawer's scroll
    //    model; vertical scrolling still works.
    // --------------------------------------------------------

    let metrics = await readDrawerScrollMetrics(page)
    expect(
      metrics.main.scrollWidth,
      `main container gained horizontal overflow: ${JSON.stringify(metrics.main)}`,
    ).toBeLessThanOrEqual(metrics.main.clientWidth)
    expect(
      metrics.activity.scrollWidth,
      `Activity list gained horizontal overflow: ${JSON.stringify(metrics.activity)}`,
    ).toBeLessThanOrEqual(metrics.activity.clientWidth)

    // The seeded Activity list is taller than its own (capped)
    // viewport — the drawer's vertical scroll model is intact.
    expect(
      metrics.activity.scrollHeight,
    ).toBeGreaterThan(metrics.activity.clientHeight)
    // The whole drawer content is taller than the drawer at this
    // viewport, so the main container scrolls vertically too.
    expect(metrics.main.scrollHeight).toBeGreaterThan(
      metrics.main.clientHeight,
    )

    const scrolled = await page.evaluate(() => {
      const region = document.querySelector(
        '[aria-labelledby="work-item-drawer-title"]',
      )
      const main = region!.querySelector(
        '.space-y-7.overflow-y-auto',
      )!
      const activity = region!.querySelector(
        'ul[aria-label="Activity"]',
      )!
      main.scrollTop = 120
      activity.scrollTop = 60
      return {
        main: main.scrollTop,
        activity: activity.scrollTop,
      }
    })
    expect(scrolled.main).toBeGreaterThan(0)
    expect(scrolled.activity).toBeGreaterThan(0)

    // The drawer width is fixed — it must not jump as Activity grows.
    const drawerWidth = (
      await inspector.boundingBox()
    )!.width
    metrics = await readDrawerScrollMetrics(page)
    expect(
      (await inspector.boundingBox())!.width,
    ).toBe(drawerWidth)

    await page.screenshot({
      path: test.info().outputPath(
        'drawer-activity-seeded.png',
      ),
    })

    // --------------------------------------------------------
    // 4. Title edit mode: the input stays geometrically inside
    //    the content column, the focus ring is not clipped
    //    (inset), and edit mode aligns with view mode.
    // --------------------------------------------------------

    await titleView.click()

    const titleInput = inspector.getByLabel(
      'Work item title',
      { exact: true },
    )
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()

    const titleGeometry = await page.evaluate(() => {
      const input = document.querySelector(
        'input[aria-label="Work item title"]',
      )
      const region = document.querySelector(
        '[aria-labelledby="work-item-drawer-title"]',
      )
      const main = region!.querySelector(
        '.space-y-7.overflow-y-auto',
      )
      const inputBox = input!.getBoundingClientRect()
      const mainBox = main!.getBoundingClientRect()
      const regionBox = region!.getBoundingClientRect()
      return {
        input: {
          left: inputBox.left,
          right: inputBox.right,
          top: inputBox.top,
          bottom: inputBox.bottom,
        },
        main: {
          left: mainBox.left,
          right: mainBox.right,
        },
        region: {
          left: regionBox.left,
          right: regionBox.right,
        },
        boxShadow: getComputedStyle(input!).boxShadow,
      }
    })

    // The complete input — border and all — stays inside the
    // scroll container's content area (the container clips at its
    // padding box; anything outside was the former clipping).
    expect(
      titleGeometry.input.left,
    ).toBeGreaterThanOrEqual(titleGeometry.main.left - 0.5)
    expect(
      titleGeometry.input.right,
    ).toBeLessThanOrEqual(titleGeometry.main.right + 0.5)
    // ...and of course inside the drawer itself.
    expect(titleGeometry.input.left).toBeGreaterThanOrEqual(
      titleGeometry.region.left - 0.5,
    )
    expect(titleGeometry.input.right).toBeLessThanOrEqual(
      titleGeometry.region.right - 0.5,
    )

    // The focus ring is painted inside the border box, so it can
    // never be clipped at the container edge.
    expect(titleGeometry.boxShadow).toContain('inset')

    // Edit mode and view mode stay aligned: both span the same
    // horizontal extent.
    expect(
      Math.abs(titleGeometry.input.left - titleViewBox!.x),
    ).toBeLessThan(1)
    expect(
      Math.abs(
        titleGeometry.input.right -
          (titleViewBox!.x + titleViewBox!.width),
      ),
    ).toBeLessThan(1)

    await page.screenshot({
      path: test.info().outputPath(
        'drawer-title-edit-focused.png',
      ),
    })

    // --------------------------------------------------------
    // 5. Long (pathological, unbroken) title: still editable,
    //    save succeeds, no drawer widening, no horizontal
    //    overflow in view mode.
    // --------------------------------------------------------

    await titleInput.fill(PATHOLOGICAL_TITLE)
    await titleInput.press('Enter')

    const pathologicalTitle = inspector.getByRole(
      'button',
      { name: PATHOLOGICAL_TITLE, exact: true },
    )
    await expect(pathologicalTitle).toBeVisible()

    const pathologicalMetrics =
      await pathologicalTitle.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }))
    expect(
      pathologicalMetrics.scrollWidth,
    ).toBeLessThanOrEqual(
      pathologicalMetrics.clientWidth,
    )

    metrics = await readDrawerScrollMetrics(page)
    expect(
      metrics.main.scrollWidth,
      `long unbroken title widened the drawer: ${JSON.stringify(metrics.main)}`,
    ).toBeLessThanOrEqual(metrics.main.clientWidth)
    expect(
      (await inspector.boundingBox())!.width,
    ).toBe(drawerWidth)

    await page.screenshot({
      path: test.info().outputPath(
        'drawer-title-long.png',
      ),
    })

    // --------------------------------------------------------
    // Cleanup: deterministically close the drawer before
    // logging out. While the drawer is open, its header
    // (the "Work item actions" button) covers the global
    // user-menu trigger, so the logout click would be
    // intercepted by the drawer.
    // --------------------------------------------------------

    await page
      .getByRole('button', {
        name: 'Close work item',
      })
      .click()
    await expect(inspector).not.toBeVisible()

    await logout(page, 'Alex')
  },
)
