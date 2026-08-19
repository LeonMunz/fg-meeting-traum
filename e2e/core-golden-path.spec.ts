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
        name: /Members/,
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

    await logout(page)
    await login(page, 'chris')

    await page
      .getByRole('link', {
        name: /My Work/,
      })
      .click()

    await expect(page).toHaveURL(
      /\/my-work$/,
    )

    await expect(
      page.getByText(
        TASK_TITLE,
        { exact: true },
      ),
    ).toBeVisible()

    await expect(
      page.getByText(
        PROJECT_NAME,
        { exact: true },
      ),
    ).toBeVisible()

    const statusSelect =
      page.getByLabel(
        `Status for ${TASK_TITLE}`,
      )

    await expect(
      statusSelect,
    ).toHaveValue('todo')

    await statusSelect.selectOption(
      'in_progress',
    )

    await expect(
      statusSelect,
    ).toHaveValue('in_progress')

    // Reload proves Chris's PATCH persisted.
    await page.reload()

    await expect(
      page.getByLabel(
        `Status for ${TASK_TITLE}`,
      ),
    ).toHaveValue('in_progress')

    // --------------------------------------------------------
    // Alex sees the same canonical status.
    // --------------------------------------------------------

    await logout(page)
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
