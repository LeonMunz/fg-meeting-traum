import {
  expect,
  test,
  type Page,
} from '@playwright/test'

import {
  login,
  logout,
  openProject,
  openProjects,
} from './helpers'

type ProjectMembershipState = {
  role: 'owner' | 'member' | 'viewer'
  user: {
    id: number
    username: string
  }
}

type WorkItemState = {
  title: string
  assigneeIds: number[]
}

async function createProject(
  page: Page,
  name: string,
) {
  await openProjects(page)

  await page
    .getByRole('button', {
      name: /New project/,
    })
    .click()

  const dialog =
    page.getByRole('dialog', {
      name: 'Create project',
    })

  await expect(dialog).toBeVisible()

  await dialog
    .getByLabel('Project name')
    .fill(name)

  await dialog
    .getByLabel('Description')
    .fill(
      'Assignment resolution browser acceptance project.',
    )

  await dialog
    .getByRole('button', {
      name: /Create project/,
    })
    .click()

  await expect(dialog).not.toBeVisible()

  await expect(
    page.getByText(
      name,
      { exact: true },
    ),
  ).toBeVisible()

  await openProject(page, name)
}

async function addChris(
  page: Page,
) {
  await page
    .getByRole('link', {
        name: 'Settings',
        exact: true,
      })
    .click()

  await page
    .getByRole('button', {
      name: /Add member/,
    })
    .click()

  const dialog =
    page.getByRole('dialog', {
      name: 'Add project member',
    })

  await expect(dialog).toBeVisible()

  await dialog
    .getByLabel('Select person')
    .fill('chris')

  const result =
    dialog
      .getByRole('button')
      .filter({
        hasText: '@chris',
      })

  await expect(result).toBeVisible()
  await result.click()

  await dialog
    .getByRole('button', {
      name: /Add member/,
    })
    .click()

  await expect(dialog).not.toBeVisible()

  await expect(
    page.getByText(
      '@chris',
      { exact: true },
    ),
  ).toBeVisible()
}

async function createTaskAssignedToChris(
  page: Page,
  title: string,
) {
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

  const dialog =
    page.getByRole('dialog', {
      name: 'New work item',
    })

  await expect(dialog).toBeVisible()

  await dialog
    .getByLabel('Title')
    .fill(title)

  const assignees =
    dialog.getByRole(
      'group',
      {
        name: 'Assignees',
      },
    )

  const chrisCheckbox =
    assignees.getByRole(
      'checkbox',
      {
        name: /Chris/i,
      },
    )

  await expect(
    chrisCheckbox,
  ).toBeVisible()

  await chrisCheckbox.check()

  await dialog
    .getByRole('button', {
      name: /Create work item/,
    })
    .click()

  await expect(dialog).not.toBeVisible()

  await expect(
    page.getByText(
      title,
      { exact: true },
    ),
  ).toBeVisible()
}

function getProjectId(
  page: Page,
) {
  const match =
    new URL(page.url())
      .pathname
      .match(/^\/projects\/(\d+)\/work-items$/)

  expect(match).not.toBeNull()

  return Number(match![1])
}

function getMemberRow(
  page: Page,
  username: string,
) {
  return page
    .getByText(
      `@${username}`,
      { exact: true },
    )
    .locator(
      'xpath=ancestor::div[.//select][1]',
    )
}

async function readProjectState(
  page: Page,
  projectId: number,
) {
  return page.evaluate(
    async (id) => {
      const [
        membershipsResponse,
        workItemsResponse,
      ] = await Promise.all([
        fetch(
          `/api/projects/${id}/memberships/`,
        ),
        fetch(
          `/api/projects/${id}/work-items/`,
        ),
      ])

      if (!membershipsResponse.ok) {
        throw new Error(
          `Memberships request failed: ${membershipsResponse.status}`,
        )
      }

      if (!workItemsResponse.ok) {
        throw new Error(
          `Work Items request failed: ${workItemsResponse.status}`,
        )
      }

      return {
        memberships:
          await membershipsResponse.json(),
        workItems:
          await workItemsResponse.json(),
      }
    },
    projectId,
  ) as Promise<{
    memberships: ProjectMembershipState[]
    workItems: WorkItemState[]
  }>
}

test(
  'assigned member becomes viewer after transferring work',
  async ({ page }) => {
    const projectName =
      'E2E Assignment Transfer Project'

    const taskTitle =
      'E2E Transfer Chris Work'

    await login(page, 'alex')

    await createProject(
      page,
      projectName,
    )

    const projectId =
      getProjectId(page)

    await addChris(page)

    await createTaskAssignedToChris(
      page,
      taskTitle,
    )

    const before =
      await readProjectState(
        page,
        projectId,
      )

    const alexMembership =
      before.memberships.find(
        (membership) =>
          membership.user.username ===
          'alex',
      )

    const chrisMembership =
      before.memberships.find(
        (membership) =>
          membership.user.username ===
          'chris',
      )

    expect(alexMembership).toBeDefined()
    expect(chrisMembership).toBeDefined()

    // --------------------------------------------------------
    // Changing assigned Chris to Viewer requires resolution.
    // --------------------------------------------------------

    await page
      .getByRole('link', {
        name: 'Settings',
        exact: true,
      })
      .click()

    const chrisRow =
      getMemberRow(
        page,
        'chris',
      )

    const roleSelect =
      chrisRow.getByRole('combobox')

    await expect(
      roleSelect,
    ).toHaveValue('member')

    await roleSelect.selectOption(
      'viewer',
    )

    const resolutionDialog =
      page.getByRole('dialog', {
        name: 'Resolve assigned work',
      })

    await expect(
      resolutionDialog,
    ).toBeVisible()

    await expect(
      resolutionDialog.getByText(
        /assigned to 1 work item/i,
      ),
    ).toBeVisible()

    const transferTo =
      resolutionDialog.getByRole(
        'combobox',
        {
          name: 'Transfer to',
          exact: true,
        },
      )

    const alexOption =
      transferTo
        .locator('option')
        .filter({
          hasText: '@alex',
        })

    await expect(
      alexOption,
    ).toHaveCount(1)

    const alexOptionValue =
      await alexOption.getAttribute(
        'value',
      )

    expect(
      alexOptionValue,
    ).not.toBeNull()

    await transferTo.selectOption(
      alexOptionValue!,
    )

    await resolutionDialog
      .getByRole('button', {
        name: 'Make viewer',
        exact: true,
      })
      .click()

    await expect(
      resolutionDialog,
    ).not.toBeVisible()

    await expect(
      roleSelect,
    ).toHaveValue('viewer')

    // --------------------------------------------------------
    // Reload proves role + assignments persisted canonically.
    // --------------------------------------------------------

    await page.reload()

    await page
      .getByRole('link', {
        name: /Work Items/,
      })
      .click()

    await expect(
      page.getByText(
        taskTitle,
        { exact: true },
      ),
    ).toBeVisible()

    const after =
      await readProjectState(
        page,
        projectId,
      )

    const afterChris =
      after.memberships.find(
        (membership) =>
          membership.user.username ===
          'chris',
      )

    expect(afterChris?.role).toBe(
      'viewer',
    )

    const task =
      after.workItems.find(
        (item) =>
          item.title === taskTitle,
      )

    expect(task).toBeDefined()

    expect(
      task!.assigneeIds,
    ).not.toContain(
      chrisMembership!.user.id,
    )

    expect(
      task!.assigneeIds,
    ).toContain(
      alexMembership!.user.id,
    )
  },
)

test(
  'removing assigned member can leave work unassigned',
  async ({ page }) => {
    const projectName =
      'E2E Assignment Unassign Project'

    const taskTitle =
      'E2E Unassign Chris Work'

    await login(page, 'alex')

    await createProject(
      page,
      projectName,
    )

    const projectId =
      getProjectId(page)

    const projectPath =
      new URL(page.url()).pathname

    await addChris(page)

    await createTaskAssignedToChris(
      page,
      taskTitle,
    )

    const before =
      await readProjectState(
        page,
        projectId,
      )

    const chrisMembership =
      before.memberships.find(
        (membership) =>
          membership.user.username ===
          'chris',
      )

    expect(chrisMembership).toBeDefined()

    // --------------------------------------------------------
    // Removing assigned Chris requires resolution.
    // --------------------------------------------------------

    await page
      .getByRole('link', {
        name: 'Settings',
        exact: true,
      })
      .click()

    const chrisRow =
      getMemberRow(
        page,
        'chris',
      )

    await chrisRow
      .getByRole('button', {
        name: 'Remove',
        exact: true,
      })
      .click()

    const resolutionDialog =
      page.getByRole('dialog', {
        name: 'Resolve assigned work',
      })

    await expect(
      resolutionDialog,
    ).toBeVisible()

    await resolutionDialog
      .getByRole('radio', {
        name: /Leave work unassigned/,
      })
      .check()

    await resolutionDialog
      .getByRole('button', {
        name: 'Remove member',
        exact: true,
      })
      .click()

    await expect(
      resolutionDialog,
    ).not.toBeVisible()

    await expect(
      page.getByText(
        '@chris',
        { exact: true },
      ),
    ).toHaveCount(0)

    // --------------------------------------------------------
    // Work survives, membership and assignment do not.
    // --------------------------------------------------------

    await page.reload()

    await page
      .getByRole('link', {
        name: /Work Items/,
      })
      .click()

    await expect(
      page.getByText(
        taskTitle,
        { exact: true },
      ),
    ).toBeVisible()

    const after =
      await readProjectState(
        page,
        projectId,
      )

    expect(
      after.memberships.some(
        (membership) =>
          membership.user.username ===
          'chris',
      ),
    ).toBe(false)

    const task =
      after.workItems.find(
        (item) =>
          item.title === taskTitle,
      )

    expect(task).toBeDefined()

    expect(
      task!.assigneeIds,
    ).not.toContain(
      chrisMembership!.user.id,
    )

    expect(
      task!.assigneeIds,
    ).toHaveLength(0)

    // --------------------------------------------------------
    // Removed user also loses direct Project access.
    // --------------------------------------------------------

    await logout(page)
    await login(page, 'chris')

    const projectResponse =
      page.waitForResponse(
        (response) =>
          response.url().endsWith(
            `/api/projects/${projectId}/`,
          ) &&
          response.request().method() ===
            'GET',
      )

    await page.goto(projectPath)

    expect(
      (await projectResponse).status(),
    ).toBe(404)
  },
)
