import {
  expect,
  test,
} from '@playwright/test'

import {
  login,
  logout,
  openProject,
  openProjects,
} from './helpers'

const PROJECT_NAME = 'E2E Golden Path Project'
const PROJECT_DESCRIPTION =
  'Created by the automated browser acceptance test.'
const TASK_TITLE = 'E2E Chris Golden Task'

test(
  'Alex assigns project work to Chris and sees Chris status update',
  async ({ page }) => {
    // --------------------------------------------------------
    // Alex creates a real Project.
    // --------------------------------------------------------

    await login(page, 'alex')
    await openProjects(page)

    await page
      .getByRole('button', {
        name: /New project/,
      })
      .click()

    const createProjectDialog =
      page.getByRole('dialog', {
        name: 'Create project',
      })

    await expect(
      createProjectDialog,
    ).toBeVisible()

    await createProjectDialog
      .getByLabel('Project name')
      .fill(PROJECT_NAME)

    await createProjectDialog
      .getByLabel('Description')
      .fill(PROJECT_DESCRIPTION)

    await createProjectDialog
      .getByRole('button', {
        name: /Create project/,
      })
      .click()

    await expect(
      page.getByText(
        PROJECT_NAME,
        { exact: true },
      ),
    ).toBeVisible()

    // Reload proves Project persistence.
    await page.reload()

    await expect(
      page.getByText(
        PROJECT_NAME,
        { exact: true },
      ),
    ).toBeVisible()

    await openProject(
      page,
      PROJECT_NAME,
    )

    // --------------------------------------------------------
    // Alex adds Chris as Project member.
    // --------------------------------------------------------

    await page
      .getByRole('link', {
        name: 'Members',
        exact: true,
      })
      .click()

    await page
      .getByRole('button', {
        name: /Add member/,
      })
      .click()

    const addMemberDialog =
      page.getByRole('dialog', {
        name: 'Add project member',
      })

    await expect(
      addMemberDialog,
    ).toBeVisible()

    await addMemberDialog
      .getByLabel('Select person')
      .fill('chris')

    const chrisResult =
      addMemberDialog
        .getByRole('button')
        .filter({
          hasText: '@chris',
        })

    await expect(
      chrisResult,
    ).toBeVisible()

    await chrisResult.click()

    await addMemberDialog
      .getByRole('button', {
        name: /Add member/,
      })
      .click()

    await expect(
      addMemberDialog,
    ).not.toBeVisible()

    await expect(
      page.getByText(
        '@chris',
        { exact: true },
      ),
    ).toBeVisible()

    // --------------------------------------------------------
    // Alex creates a Task assigned to Chris.
    // --------------------------------------------------------

    await page
      .getByRole('link', {
        name: /Work Items/,
      })
      .click()

    await page
      .getByRole('button', {
        name: /New work item/,
      })
      .click()

    const workItemDialog =
      page.getByRole('dialog', {
        name: 'New work item',
      })

    await expect(
      workItemDialog,
    ).toBeVisible()

    await workItemDialog
      .getByLabel('Title')
      .fill(TASK_TITLE)

    await workItemDialog
      .getByRole('button', {
        name: 'Add assignee…',
        exact: true,
      })
      .click()

    const assigneeGroup =
      workItemDialog.getByRole(
        'group',
        {
          name: 'Assignees',
        },
      )

    const chrisCheckbox =
      assigneeGroup.getByRole(
        'checkbox',
        {
          name: /Chris/i,
        },
      )

    await expect(
      chrisCheckbox,
    ).toBeVisible()

    await chrisCheckbox.check()

    await workItemDialog
      .getByRole('button', {
        name: /Create work item/,
      })
      .click()

    await expect(
      workItemDialog,
    ).not.toBeVisible()

    await expect(
      page.getByText(
        TASK_TITLE,
        { exact: true },
      ),
    ).toBeVisible()

    // Reload proves Work Item persistence.
    await page.reload()

    await page
      .getByRole('link', {
        name: /Work Items/,
      })
      .click()

    await expect(
      page.getByText(
        TASK_TITLE,
        { exact: true },
      ),
    ).toBeVisible()

    // --------------------------------------------------------
    // Chris sees the canonical item in My Work.
    // --------------------------------------------------------

    await logout(page, 'Alex')
    await login(page, 'chris')

    await page
      .getByRole('link', {
        name: /My Work/,
      })
      .click()

    await expect(page).toHaveURL(
      /\/my-work$/,
    )

    // The My Work Kanban (default Board view) renders the four
    // fixed semantic columns; a card's column IS its semantic
    // status.
    await expect(
      page.getByRole(
        'button',
        { name: 'Board' },
      ),
    ).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    const todoColumn = page.locator(
      '[data-board-column="todo"]',
    )
    const card = todoColumn.getByRole(
      'button',
      { name: `Open ${TASK_TITLE}` },
    )
    await expect(
      card,
    ).toBeVisible()

    // The card carries the owning-Project context.
    await expect(
      card.getByText(
        PROJECT_NAME,
        { exact: true },
      ),
    ).toBeVisible()

    // The item is initially in the semantically expected status
    // `todo`, and not yet in the In progress column.
    const inProgressColumn = page.locator(
      '[data-board-column="in_progress"]',
    )
    await expect(
      inProgressColumn.getByRole(
        'button',
        { name: `Open ${TASK_TITLE}` },
      ),
    ).toHaveCount(0)

    // --------------------------------------------------------
    // Chris changes the status via the current canonical My
    // Work interaction: a Kanban drag into the In progress
    // column. The drop resolves the concrete target solely
    // from the item's own statusTargets and mutates through
    // POST /api/work-items/{id}/transition-status/.
    // --------------------------------------------------------

    // Await the successful server request BEFORE the drag
    // gesture.
    const transitionResponse =
      page.waitForResponse(
        (response) =>
          response.request().method() ===
            'POST' &&
          /\/api\/work-items\/\d+\/transition-status\/$/.test(
            new URL(response.url()).pathname,
          ),
      )

    await inProgressColumn.scrollIntoViewIfNeeded()

    // Native HTML5 drag-and-drop needs a real mouse gesture
    // (not locator.dragTo's single jump) for Chromium to
    // recognize the drag threshold and dispatch
    // dragstart/dragover/drop.
    const cardBox = await card.boundingBox()
    const targetBox =
      await inProgressColumn.boundingBox()
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

    // The server accepted the canonical status-only transition.
    expect(
      (await transitionResponse).ok(),
    ).toBe(true)

    // The authoritative refetched payload moved the card: it
    // is now in the In progress column and no longer in Todo.
    const movedCard = inProgressColumn.getByRole(
      'button',
      { name: `Open ${TASK_TITLE}` },
    )
    await expect(
      movedCard,
    ).toBeVisible()
    await expect(
      card,
    ).toHaveCount(0)

    // Reload proves Chris's status change persisted.
    await page.reload()

    await expect(
      inProgressColumn.getByRole(
        'button',
        { name: `Open ${TASK_TITLE}` },
      ),
    ).toBeVisible()

    // --------------------------------------------------------
    // Alex sees the same canonical status.
    // --------------------------------------------------------

    await logout(page, 'Chris')
    await login(page, 'alex')
    await openProjects(page)

    await openProject(
      page,
      PROJECT_NAME,
    )

    await page
      .getByRole('link', {
        name: /Work Items/,
      })
      .click()

    await expect(
      page.getByText(
        TASK_TITLE,
        { exact: true },
      ),
    ).toBeVisible()

    // List mode makes the status visible on the single row.
    await page
      .getByRole('button', {
        name: /List/,
      })
      .click()

    await expect(
      page.getByText(
        TASK_TITLE,
        { exact: true },
      ),
    ).toBeVisible()

    await expect(
      page.getByText(
        'In progress',
        { exact: true },
      ),
    ).toBeVisible()
  },
)
