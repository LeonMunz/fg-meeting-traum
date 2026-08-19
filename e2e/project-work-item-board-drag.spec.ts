import {
  expect,
  test,
} from '@playwright/test'

import {
  login,
  openProject,
  openProjects,
} from './helpers'

// TEMPORARY validation test for the Board drag-and-drop slice.
// Not part of the permanent suite — safe to delete after review.

// Wide enough that all four Board columns stay visible next to the
// open inspector drawer, so the drag source and drop target are both
// on-screen at once (no horizontal board scroll needed mid-drag).
test.use({ viewport: { width: 1920, height: 1000 } })

const PROJECT_NAME =
  'E2E Board Drag Validation Project'
const TASK_TITLE = 'E2E Board Drag Task'

test(
  'Board drag-and-drop: dragging a selected card changes status, ' +
    'the inspector stays open and reflects it, the change persists, ' +
    'and the inspector status control still works as a non-drag alternative',
  async ({ page }) => {
    await login(page, 'alex')
    await openProjects(page)

    await page
      .getByRole('button', {
        name: /New project/,
      })
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
      page.getByText(PROJECT_NAME, {
        exact: true,
      }),
    ).toBeVisible()

    await openProject(page, PROJECT_NAME)

    await page
      .getByRole('button', {
        name: /New work item/,
      })
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

    await expect(createDialog).not.toBeVisible()

    // --------------------------------------------------------
    // 1. Opening the card still opens the inspector.
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

    const statusSelect = inspector.getByLabel(
      'Status',
      { exact: true },
    )

    await expect(statusSelect).toHaveValue('todo')

    // --------------------------------------------------------
    // 2. Dragging the selected card itself to another status
    //    column changes only its status.
    // --------------------------------------------------------

    const card = page.getByRole('button', {
      name: `Open ${TASK_TITLE}`,
    })

    const reviewColumn = page.locator(
      '[data-board-column="review"]',
    )

    // The inspector is a fixed-position drawer over the right of the
    // viewport, so scroll the target column into the board's
    // horizontally-scrollable area before computing coordinates —
    // otherwise the drawer can sit on top of it and swallow the drop.
    await reviewColumn.scrollIntoViewIfNeeded()

    // Native HTML5 drag-and-drop needs a real mouse gesture (not
    // locator.dragTo's single jump) for Chromium to recognize the
    // drag threshold and dispatch dragstart/dragover/drop.
    const cardBox = await card.boundingBox()
    const targetBox = await reviewColumn.boundingBox()

    if (!cardBox || !targetBox) {
      throw new Error(
        'Work item card or target column not found.',
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
    // 3 & 4. Inspector stays open and reflects the new status.
    // --------------------------------------------------------

    await expect(inspector).toBeVisible()
    await expect(statusSelect).toHaveValue('review')

    await expect(
      reviewColumn.getByRole('button', {
        name: `Open ${TASK_TITLE}`,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // 5. Reloading confirms the server persisted the status.
    // --------------------------------------------------------

    await page.reload()

    await expect(
      page.getByRole('button', {
        name: `Open ${TASK_TITLE}`,
      }),
    ).toBeVisible()

    const reviewColumnAfterReload = page.locator(
      '[data-board-column="review"]',
    )

    await expect(
      reviewColumnAfterReload.getByRole('button', {
        name: `Open ${TASK_TITLE}`,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // 6. Moving status through the inspector still works as
    //    the non-drag alternative.
    // --------------------------------------------------------

    await page
      .getByRole('button', {
        name: `Open ${TASK_TITLE}`,
      })
      .click()

    await expect(inspector).toBeVisible()
    await expect(statusSelect).toHaveValue('review')

    await statusSelect.selectOption('done')

    await expect(statusSelect).toHaveValue('done')

    const doneColumn = page.locator(
      '[data-board-column="done"]',
    )

    await expect(
      doneColumn.getByRole('button', {
        name: `Open ${TASK_TITLE}`,
      }),
    ).toBeVisible()
  },
)
