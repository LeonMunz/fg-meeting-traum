import {
  expect,
  test,
  type Locator,
  type Page,
} from '@playwright/test'

import {
  login,
  openProject,
  openProjects,
} from './helpers'

// Browser acceptance for the Work Item inspector assignee
// selection: multiple assignees can be selected (rapid,
// consecutive toggles while earlier PATCHes may still be
// pending) and every intended assignment REMAINS assigned
// after reopening the Work Item and after a full page reload.
//
// Per the task's browser acceptance criterion, this verifies the
// selected PILL and CHECKBOX states (not only the API payload):
// the pill row and the picker checkboxes are the user-visible
// truth of the assignment.

const PROJECT_NAME =
  'E2E Assignees Project'
const TASK_TITLE =
  'E2E Assignees Task'

const inspectorRegion = (
  page: Page,
): Locator =>
  page.locator(
    '[aria-labelledby="work-item-drawer-title"]',
  )

const assigneePill = (
  inspector: Locator,
  name: string,
) =>
  inspector.getByRole('button', {
    name: `Remove ${name}`,
  })

const assigneeCheckbox = (
  inspector: Locator,
  name: string,
) =>
  inspector.getByRole('checkbox', {
    name,
  })

async function addProjectMember(
  page: Page,
  username: string,
) {
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
    .fill(username)

  await addMemberDialog
    .getByRole('button')
    .filter({
      hasText: `@${username}`,
    })
    .click()

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
      `@${username}`,
      { exact: true },
    ),
  ).toBeVisible()
}

test(
  'Work Item inspector: multiple assignees survive reopen and reload',
  async ({ page }) => {
    await login(page, 'alex')
    await openProjects(page)

    // --------------------------------------------------------
    // Setup: a fresh project with two additional members
    // (owners/members are the assignable population).
    // --------------------------------------------------------

    await page
      .getByRole('button', {
        name: /New project/,
      })
      .click()

    const createProjectDialog =
      page.getByRole('dialog', {
        name: 'Create project',
      })

    await createProjectDialog
      .getByLabel('Project name')
      .fill(PROJECT_NAME)

    await createProjectDialog
      .getByRole('button', {
        name: /Create project/,
      })
      .click()

    await expect(
      page.getByRole('heading', {
        name: PROJECT_NAME,
        exact: true,
      }),
    ).toBeVisible()

    await openProject(page, PROJECT_NAME)

    await page
      .getByRole('link', {
        name: 'Members',
        exact: true,
      })
      .click()

    await addProjectMember(
      page,
      'chris',
    )
    await addProjectMember(
      page,
      'laura',
    )

    // --------------------------------------------------------
    // Create one Work Item (unassigned).
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
        name: /Create work item/,
      })
      .click()

    await expect(
      workItemDialog,
    ).not.toBeVisible()

    // --------------------------------------------------------
    // Open the Work Item in the inspector and select
    // multiple assignees with rapid consecutive toggles
    // (the first PATCH may still be in flight when the
    // second selection is made).
    // --------------------------------------------------------

    await page
      .getByRole('button', {
        name: `Open ${TASK_TITLE}`,
      })
      .click()

    const inspector =
      inspectorRegion(page)

    await expect(
      inspector,
    ).toBeVisible()

    await inspector
      .getByRole('button', {
        name: 'Add assignee',
      })
      .click()

    // Two rapid selections — the picker stays open.
    await assigneeCheckbox(
      inspector,
      'Chris Dev',
    ).check()
    await assigneeCheckbox(
      inspector,
      'Laura Dev',
    ).check()

    // Autosave settles…
    await expect(
      inspector.getByText(
        'Saved',
        { exact: true },
      ),
    ).toBeVisible()

    // …and BOTH selections are visible: pills AND
    // checkbox states agree.
    await expect(
      assigneePill(inspector, 'Chris Dev'),
    ).toBeVisible()
    await expect(
      assigneePill(inspector, 'Laura Dev'),
    ).toBeVisible()
    await expect(
      assigneeCheckbox(
        inspector,
        'Chris Dev',
      ),
    ).toBeChecked()
    await expect(
      assigneeCheckbox(
        inspector,
        'Laura Dev',
      ),
    ).toBeChecked()
    // And no unintended assignment was introduced or
    // lost.
    await expect(
      assigneePill(inspector, 'Alex Dev'),
    ).not.toBeVisible()

    // --------------------------------------------------------
    // Close the inspector and reopen the same Work
    // Item: every assignee remains assigned.
    // --------------------------------------------------------

    await inspector
      .getByRole('button', {
        name: 'Close work item',
      })
      .click()

    await expect(
      inspector,
    ).not.toBeVisible()

    await page
      .getByRole('button', {
        name: `Open ${TASK_TITLE}`,
      })
      .click()

    await expect(
      inspector,
    ).toBeVisible()

    await expect(
      assigneePill(inspector, 'Chris Dev'),
    ).toBeVisible()
    await expect(
      assigneePill(inspector, 'Laura Dev'),
    ).toBeVisible()

    await inspector
      .getByRole('button', {
        name: 'Add assignee',
      })
      .click()

    await expect(
      assigneeCheckbox(
        inspector,
        'Chris Dev',
      ),
    ).toBeChecked()
    await expect(
      assigneeCheckbox(
        inspector,
        'Laura Dev',
      ),
    ).toBeChecked()

    // --------------------------------------------------------
    // Reload the page: the assignments persist.
    // --------------------------------------------------------

    await page.reload()

    await page
      .getByRole('button', {
        name: `Open ${TASK_TITLE}`,
      })
      .click()

    await expect(
      inspector,
    ).toBeVisible()

    await expect(
      assigneePill(inspector, 'Chris Dev'),
    ).toBeVisible()
    await expect(
      assigneePill(inspector, 'Laura Dev'),
    ).toBeVisible()

    await inspector
      .getByRole('button', {
        name: 'Add assignee',
      })
      .click()

    await expect(
      assigneeCheckbox(
        inspector,
        'Chris Dev',
      ),
    ).toBeChecked()
    await expect(
      assigneeCheckbox(
        inspector,
        'Laura Dev',
      ),
    ).toBeChecked()
    await expect(
      assigneeCheckbox(
        inspector,
        'Alex Dev',
      ),
    ).not.toBeChecked()
  },
)
