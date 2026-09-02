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

    // The status select is backed by the Project's configured status
    // definitions (option value = definition ID). A freshly created Work
    // Item starts in the Project's default status ("Todo"). Assert the
    // *visible* selected option — the option the user actually sees.
    await expect(statusSelect).toBeEnabled()
    await expect(statusSelect.locator('option')).toHaveCount(4)
    await expect(
      statusSelect.locator('option:checked'),
    ).toHaveText('Todo')

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
    // 3 & 4. The Board card moved to Review AND the open editor's
    //        visible status immediately reads Review too.
    // --------------------------------------------------------

    await expect(inspector).toBeVisible()
    await expect(
      reviewColumn.getByRole('button', {
        name: `Open ${TASK_TITLE}`,
      }),
    ).toBeVisible()
    await expect(
      statusSelect.locator('option:checked'),
    ).toHaveText('Review')

    // --------------------------------------------------------
    // 5. Reloading confirms the server persisted the status and
    //    both the Board and the editor still agree on Review.
    // --------------------------------------------------------

    await page.reload()

    const reviewColumnAfterReload = page.locator(
      '[data-board-column="review"]',
    )

    await expect(
      reviewColumnAfterReload.getByRole('button', {
        name: `Open ${TASK_TITLE}`,
      }),
    ).toBeVisible()

    // Reopen the editor and confirm it reads Review from the server.
    await page
      .getByRole('button', {
        name: `Open ${TASK_TITLE}`,
      })
      .click()
    await expect(inspector).toBeVisible()
    await expect(
      statusSelect.locator('option:checked'),
    ).toHaveText('Review')

    // --------------------------------------------------------
    // 6. Inverse: change the editor status Review -> Todo. The card
    //    must immediately move back to the Todo column and the
    //    editor's visible status must read Todo.
    // --------------------------------------------------------

    await statusSelect.selectOption({
      label: 'Todo',
    })

    const todoColumnAfterEdit = page.locator(
      '[data-board-column="todo"]',
    )

    await expect(
      todoColumnAfterEdit.getByRole('button', {
        name: `Open ${TASK_TITLE}`,
      }),
    ).toBeVisible()
    await expect(
      statusSelect.locator('option:checked'),
    ).toHaveText('Todo')

    // --------------------------------------------------------
    // 7. Reload again: both the Board and the editor stay on Todo.
    // --------------------------------------------------------

    await page.reload()

    const todoColumnAfterReload = page.locator(
      '[data-board-column="todo"]',
    )

    await expect(
      todoColumnAfterReload.getByRole('button', {
        name: `Open ${TASK_TITLE}`,
      }),
    ).toBeVisible()

    await page
      .getByRole('button', {
        name: `Open ${TASK_TITLE}`,
      })
      .click()
    await expect(inspector).toBeVisible()
    await expect(
      statusSelect.locator('option:checked'),
    ).toHaveText('Todo')
  },
)

const LIST_PROJECT_NAME =
  'E2E Board List Validation Project'
const LIST_TASK_TITLE = 'E2E Board List Task'

test(
  'Board to List: switching views renders the List without a crash ' +
    'and the created Work Item remains visible in both views',
  async ({ page }) => {
    await login(page, 'alex')
    await openProjects(page)

    // Create a fresh Project so the assertion is isolated.
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
      .fill(LIST_PROJECT_NAME)

    await createProjectDialog
      .getByRole('button', {
        name: /Create project/,
      })
      .click()

    await expect(
      page.getByText(LIST_PROJECT_NAME, {
        exact: true,
      }),
    ).toBeVisible()

    await openProject(page, LIST_PROJECT_NAME)

    // Create one Work Item.
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
      .fill(LIST_TASK_TITLE)

    await createDialog
      .getByRole('button', {
        name: /Create work item/,
      })
      .click()

    await expect(createDialog).not.toBeVisible()

    // --------------------------------------------------------
    // 1. The Work Item is visible on the Board (default view).
    // --------------------------------------------------------

    await expect(
      page.getByRole('button', {
        name: `Open ${LIST_TASK_TITLE}`,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // 2. Switch to the List view. This is the exact interaction that
    //    used to white-screen the whole page when the List read the
    //    legacy string `type`/`status` fields (now undefined).
    // --------------------------------------------------------

    await page
      .getByRole('button', {
        name: 'List',
        exact: true,
      })
      .click()

    // The page must still be rendered (no blank white screen): the
    // Work Items panel header and the created item are present.
    await expect(
      page.getByRole('heading', {
        name: 'Work Items',
        exact: true,
      }),
    ).toBeVisible()

    await expect(
      page.getByRole('button', {
        name: `Open ${LIST_TASK_TITLE}`,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // 3. The item's type label renders from the Work Item
    //    configuration (not from a legacy string field).
    // --------------------------------------------------------

    const listRow = page.getByRole('button', {
      name: `Open ${LIST_TASK_TITLE}`,
    })

    await expect(
      listRow.locator('[aria-label="Task"]'),
    ).toBeVisible()

    // --------------------------------------------------------
    // 4. Switching back to the Board still shows the item — the
    //    created Work Item remains visible across views.
    // --------------------------------------------------------

    await page
      .getByRole('button', {
        name: 'Board',
        exact: true,
      })
      .click()

    await expect(
      page.getByRole('button', {
        name: `Open ${LIST_TASK_TITLE}`,
      }),
    ).toBeVisible()
  },
)

// ------------------------------------------------------------------
// Persisted Board card ordering with drag insertion indicator.
//
// Verifies the full spec:
//  1. create A, B, C in Todo
//  2. drag C between A and B
//  3. assert visual order A, C, B
//  4. reload
//  5. assert A, C, B persists
//  6. create/move items in Review
//  7. drag B into a specific position in Review
//  8. assert exact order
//  9. assert editor status matches Review
//  10. reload
//  11. assert order and status persist
// Plus: the insertion indicator is visible during drag, moves to the
// intended gap, and disappears after drop.
// ------------------------------------------------------------------

const ORDER_PROJECT_NAME = 'E2E Board Order Project'

async function createWorkItemInProject(
  page: import('@playwright/test').Page,
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

/** Drag a Board card to a precise vertical position inside a column. */
async function dragCardToGap(
  page: import('@playwright/test').Page,
  sourceTitle: string,
  targetColumnStatus: string,
  beforeTitle: string | null,
) {
  const sourceCard = page.getByRole('button', {
    name: `Open ${sourceTitle}`,
  })

  await sourceCard.scrollIntoViewIfNeeded()
  const sourceBox = await sourceCard.boundingBox()

  if (!sourceBox) {
    throw new Error(`Source card "${sourceTitle}" not found.`)
  }

  const targetColumn = page.locator(
    `[data-board-column="${targetColumnStatus}"]`,
  )

  await targetColumn.scrollIntoViewIfNeeded()

  let targetY: number
  let targetX: number

  if (beforeTitle === null) {
    // Drop after the last card: aim at the bottom of the column body.
    const targetBox = await targetColumn.boundingBox()

    if (!targetBox) {
      throw new Error('Target column not found.')
    }

    targetX = targetBox.x + targetBox.width / 2
    targetY = targetBox.y + targetBox.height - 24
  } else {
    // Drop just above the top edge of the "before" card.
    const beforeCard = page.getByRole('button', {
      name: `Open ${beforeTitle}`,
    })
    const beforeBox = await beforeCard.boundingBox()

    if (!beforeBox) {
      throw new Error(`Before card "${beforeTitle}" not found.`)
    }

    targetX = beforeBox.x + beforeBox.width / 2
    targetY = beforeBox.y - 4
  }

  // Native HTML5 drag-and-drop needs a real mouse gesture with steps.
  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2,
    sourceBox.y + sourceBox.height / 2,
  )
  await page.mouse.down()

  // Move in several steps so Chromium dispatches dragover events and
  // the insertion indicator can track the pointer.
  await page.mouse.move(
    targetX,
    targetY,
    { steps: 24 },
  )

  await page.mouse.up()
}

/** Read the visible Board order of cards inside a status column. */
async function boardColumnTitles(
  page: import('@playwright/test').Page,
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
    const label = await cards.nth(i).getAttribute('aria-label')
    titles.push(label?.replace(/^Open /, '') ?? '')
  }

  return titles
}

test(
  'Board ordering: reorder within a column and exact insertion ' +
    'across columns persist, with a live insertion indicator',
  async ({ page }) => {
    await login(page, 'alex')

    await openProjects(page)

    await page
      .getByRole('button', { name: /New project/ })
      .click()

    const createProjectDialog = page.getByRole('dialog', {
      name: 'Create project',
    })
    await createProjectDialog
      .getByLabel('Project name')
      .fill(ORDER_PROJECT_NAME)
    await createProjectDialog
      .getByRole('button', { name: /Create project/ })
      .click()
    await expect(
      page.getByText(ORDER_PROJECT_NAME, { exact: true }),
    ).toBeVisible()
    await openProject(page, ORDER_PROJECT_NAME)

    // 1. Create A, B, C in Todo (the Project default status).
    await createWorkItemInProject(page, 'Card A')
    await createWorkItemInProject(page, 'Card B')
    await createWorkItemInProject(page, 'Card C')

    const todo = () => boardColumnTitles(page, 'todo')


    await expect.poll(todo).toEqual([
      'Card A',
      'Card B',
      'Card C',
    ])

    // 2. Drag C between A and B (i.e. before B).
    //    Assert the insertion indicator is visible during the drag.
    const sourceCard = page.getByRole('button', {
      name: 'Open Card C',
    })
    const beforeCard = page.getByRole('button', {
      name: 'Open Card B',
    })

    const sBox = await sourceCard.boundingBox()
    const bBox = await beforeCard.boundingBox()

    if (!sBox || !bBox) {
      throw new Error('Drag source/target not found.')
    }

    const indicator = page.locator(
      '[data-board-insertion-indicator]',
    )

    await page.mouse.move(
      sBox.x + sBox.width / 2,
      sBox.y + sBox.height / 2,
    )
    await page.mouse.down()
    await page.mouse.move(
      bBox.x + bBox.width / 2,
      bBox.y - 4,
      { steps: 16 },
    )

    // 3. The insertion indicator is visible while hovering the gap.
    await expect(indicator).toBeVisible()

    await page.mouse.up()

    // The indicator disappears after the drop.
    await expect(indicator).toHaveCount(0)

    // The new visual order is A, C, B.
    await expect.poll(todo).toEqual([
      'Card A',
      'Card C',
      'Card B',
    ])

    // 4. Reload (we stay on the project page; the Board re-renders from
    //    the server).
    await page.reload()
    await expect
      .poll(() => boardColumnTitles(page, 'todo').then((t) => t.length))
      .toBeGreaterThanOrEqual(3)

    // 5. The order persists after reload.
    await expect.poll(todo).toEqual([
      'Card A',
      'Card C',
      'Card B',
    ])

    // 6. Create D, E in Review via the editor, then move F in.
    //    First create D in Todo, then set it to Review through the
    //    editor (non-drag status change => end of Review column).
    await createWorkItemInProject(page, 'Card D')
    await createWorkItemInProject(page, 'Card E')

    const setEditorStatus = async (
      title: string,
      statusLabel: string,
    ) => {
      await page
        .getByRole('button', { name: `Open ${title}` })
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
      await statusSelect.selectOption({
        label: statusLabel,
      })
      await page.keyboard.press('Escape')
    }

    await setEditorStatus('Card D', 'Review')
    await setEditorStatus('Card E', 'Review')

    const review = () => boardColumnTitles(page, 'review')
    // D and E appended to Review in creation order.
    await expect.poll(review).toEqual([
      'Card D',
      'Card E',
    ])

    // 7. Drag B (from Todo) into Review between D and E.
    await dragCardToGap(
      page,
      'Card B',
      'review',
      'Card E',
    )

    // 8. Exact order: Review D, B, E; Todo A, C.
    await expect.poll(review).toEqual([
      'Card D',
      'Card B',
      'Card E',
    ])
    await expect.poll(todo).toEqual([
      'Card A',
      'Card C',
    ])

    // 9. The editor status for B now reads Review (Board/Editor in sync).
    await page
      .getByRole('button', { name: 'Open Card B' })
      .click()
    const inspectorB = page.getByRole('region', {
      name: 'Work item',
      exact: true,
    })
    await expect(inspectorB).toBeVisible()
    await expect(
      inspectorB
        .getByLabel('Status', { exact: true })
        .locator('option:checked'),
    ).toHaveText('Review')
    await page.keyboard.press('Escape')

    // 10. Reload (we stay on the project page).
    await page.reload()
    await expect
      .poll(() => boardColumnTitles(page, 'review').then((t) => t.length))
      .toBeGreaterThanOrEqual(1)

    // 11. Order and status persist.
    await expect.poll(review).toEqual([
      'Card D',
      'Card B',
      'Card E',
    ])
    await expect.poll(todo).toEqual([
      'Card A',
      'Card C',
    ])

    // B still reads Review in the editor after reload.
    await page
      .getByRole('button', { name: 'Open Card B' })
      .click()
    await expect(
      page
        .getByRole('region', { name: 'Work item', exact: true })
        .getByLabel('Status', { exact: true })
        .locator('option:checked'),
    ).toHaveText('Review')
  },
)
