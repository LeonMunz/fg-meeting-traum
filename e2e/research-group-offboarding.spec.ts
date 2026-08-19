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

type ResearchGroupState = {
  id: number
  name: string
}

async function selectResearchGroup(
  page: Page,
  name: string,
) {
  const switcher =
    page.getByRole('button', {
      name: /^Research group:/,
    })

  await expect(switcher).toBeVisible()
  await switcher.click()

  const menu = page.getByRole('menu')

  await expect(menu).toBeVisible()

  const option = menu
    .getByRole('menuitem')
    .filter({
      hasText: name,
    })

  await expect(option).toBeVisible()
  await option.click()

  await expect(
    page.getByRole('button', {
      name: `Research group: ${name}`,
    }),
  ).toBeVisible()
}

async function openResearchGroupSettings(
  page: Page,
) {
  const switcher =
    page.getByRole('button', {
      name: /^Research group:/,
    })

  await switcher.click()

  await page
    .getByRole('menuitem', {
      name: /Research group settings/,
    })
    .click()

  await expect(page).toHaveURL(
    /\/groups\/\d+\/settings$/,
  )
}

async function openResearchGroupMembers(
  page: Page,
) {
  await openResearchGroupSettings(page)

  await page
    .getByRole('button', {
      name: 'Members',
      exact: true,
    })
    .click()

  // Proves the administrative membership
  // list has finished rendering.
  await expect(
    page.getByText(
      '@alex',
      { exact: true },
    ),
  ).toBeVisible()
}

async function ensureLauraIsResearchGroupMember(
  page: Page,
) {
  const laura =
    page.getByText(
      '@laura',
      { exact: true },
    )

  if (
    await laura.count() > 0
  ) {
    return
  }

  await page
    .getByRole('button', {
      name: 'Add member',
      exact: true,
    })
    .click()

  const dialog =
    page.getByRole('dialog', {
      name: 'Add member',
    })

  await expect(dialog).toBeVisible()

  await dialog
    .getByLabel('Search person')
    .fill('laura')

  const candidate =
    dialog
      .getByRole('button')
      .filter({
        hasText: '@laura',
      })

  await expect(candidate).toBeVisible()
  await candidate.click()

  await dialog
    .getByRole('button', {
      name: 'Add member',
      exact: true,
    })
    .click()

  await expect(dialog).not.toBeVisible()

  await expect(
    page.getByText(
      '@laura',
      { exact: true },
    ),
  ).toBeVisible()
}

function getResearchGroupMemberRow(
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
      'Research Group offboarding browser acceptance project.',
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

  await openProject(
    page,
    name,
  )
}

async function addLauraToProject(
  page: Page,
) {
  await page
    .getByRole('button', {
      name: /Members/,
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
    .fill('laura')

  const result =
    dialog
      .getByRole('button')
      .filter({
        hasText: '@laura',
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
      '@laura',
      { exact: true },
    ),
  ).toBeVisible()
}

async function createTaskAssignedToLaura(
  page: Page,
  title: string,
) {
  await page
    .getByRole('button', {
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

  const lauraCheckbox =
    assignees.getByRole(
      'checkbox',
      {
        name: /Laura/i,
      },
    )

  await expect(
    lauraCheckbox,
  ).toBeVisible()

  await lauraCheckbox.check()

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
      .match(
        /^\/projects\/(\d+)$/,
      )

  expect(match).not.toBeNull()

  return Number(match![1])
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

      if (
        !membershipsResponse.ok
      ) {
        throw new Error(
          `Memberships request failed: ${membershipsResponse.status}`,
        )
      }

      if (
        !workItemsResponse.ok
      ) {
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
    memberships:
      ProjectMembershipState[]
    workItems: WorkItemState[]
  }>
}

test(
  'admin removes uncomplicated research group member',
  async ({ page }) => {
    await login(page, 'alex')

    await selectResearchGroup(
      page,
      'Robotics Lab',
    )

    await openResearchGroupMembers(
      page,
    )

    await ensureLauraIsResearchGroupMember(
      page,
    )

    const lauraRow =
      getResearchGroupMemberRow(
        page,
        'laura',
      )

    await lauraRow
      .getByRole('button', {
        name: /^Remove /,
      })
      .click()

    const dialog =
      page.getByRole(
        'alertdialog',
        {
          name: 'Remove member',
        },
      )

    await expect(dialog).toBeVisible()

    await expect(
      dialog.getByText(
        'No project responsibilities',
        { exact: true },
      ),
    ).toBeVisible()

    await expect(
      dialog.getByText(
        'Historical authorship and activity are preserved.',
        { exact: true },
      ),
    ).toBeVisible()

    const removeButton =
      dialog.getByRole(
        'button',
        {
          name: 'Remove member',
          exact: true,
        },
      )

    await expect(
      removeButton,
    ).toBeEnabled()

    await removeButton.click()

    await expect(dialog).not.toBeVisible()

    await expect(
      page.getByText(
        '@laura',
        { exact: true },
      ),
    ).toHaveCount(0)

    // Reload proves the removal persisted.
    await page.reload()

    await page
      .getByRole('button', {
        name: 'Members',
        exact: true,
      })
      .click()

    await expect(
      page.getByText(
        '@laura',
        { exact: true },
      ),
    ).toHaveCount(0)
  },
)

test(
  'admin offboards assigned member and leaves work unassigned',
  async ({ page }) => {
    const projectName =
      'E2E RG Offboarding Project'

    const taskTitle =
      'E2E Laura Offboarding Work'

    await login(page, 'alex')

    await selectResearchGroup(
      page,
      'Robotics Lab',
    )

    await openResearchGroupMembers(
      page,
    )

    await ensureLauraIsResearchGroupMember(
      page,
    )

    await createProject(
      page,
      projectName,
    )

    const projectId =
      getProjectId(page)

    const projectPath =
      new URL(page.url()).pathname

    await addLauraToProject(page)

    await createTaskAssignedToLaura(
      page,
      taskTitle,
    )

    const before =
      await readProjectState(
        page,
        projectId,
      )

    const lauraMembership =
      before.memberships.find(
        (membership) =>
          membership.user.username ===
          'laura',
      )

    expect(
      lauraMembership,
    ).toBeDefined()

    // --------------------------------------------------------
    // Research Group offboarding
    // --------------------------------------------------------

    await openResearchGroupMembers(
      page,
    )

    const lauraRow =
      getResearchGroupMemberRow(
        page,
        'laura',
      )

    await lauraRow
      .getByRole('button', {
        name: /^Remove /,
      })
      .click()

    const dialog =
      page.getByRole(
        'alertdialog',
        {
          name: 'Remove member',
        },
      )

    await expect(dialog).toBeVisible()

    await expect(
      dialog.getByText(
        'Resolve current responsibilities',
        { exact: true },
      ),
    ).toBeVisible()

    await expect(
      dialog.getByText(
        projectName,
        { exact: true },
      ),
    ).toBeVisible()

    await expect(
      dialog.getByText(
        /1 work item is currently assigned to/i,
      ),
    ).toBeVisible()

    // Laura is only a Project member.
    // Ownership controls must stay hidden.
    await expect(
      dialog.getByText(
        'Project ownership',
        { exact: true },
      ),
    ).toHaveCount(0)

    const removeButton =
      dialog.getByRole(
        'button',
        {
          name: 'Remove member',
          exact: true,
        },
      )

    // Required responsibility decision
    // has not been made yet.
    await expect(
      removeButton,
    ).toBeDisabled()

    await dialog
      .getByRole('radio', {
        name:
          /Leave work unassigned/,
      })
      .check()

    await expect(
      removeButton,
    ).toBeEnabled()

    await removeButton.click()

    await expect(dialog).not.toBeVisible()

    await expect(
      page.getByText(
        '@laura',
        { exact: true },
      ),
    ).toHaveCount(0)

    // --------------------------------------------------------
    // Canonical Project state
    // --------------------------------------------------------

    const after =
      await readProjectState(
        page,
        projectId,
      )

    expect(
      after.memberships.some(
        (membership) =>
          membership.user.username ===
          'laura',
      ),
    ).toBe(false)

    const task =
      after.workItems.find(
        (item) =>
          item.title === taskTitle,
      )

    expect(task).toBeDefined()

    // Work survives but current responsibility
    // has been removed.
    expect(
      task!.assigneeIds,
    ).not.toContain(
      lauraMembership!.user.id,
    )

    expect(
      task!.assigneeIds,
    ).toHaveLength(0)

    // --------------------------------------------------------
    // Laura has lost RG and Project access.
    // --------------------------------------------------------

    await logout(page)
    await login(page, 'laura')

    const groups =
      await page.evaluate(
        async () => {
          const response =
            await fetch(
              '/api/research-groups/',
            )

          if (!response.ok) {
            throw new Error(
              `Research Groups request failed: ${response.status}`,
            )
          }

          return response.json()
        },
      ) as ResearchGroupState[]

    expect(
      groups.some(
        (group) =>
          group.name ===
          'Robotics Lab',
      ),
    ).toBe(false)

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

test(
  'admin archives final-owner project while offboarding member',
  async ({ page }) => {
    const projectName =
      'E2E RG Offboarding Owner Project'

    // --------------------------------------------------------
    // Ensure Laura belongs to the Research Group.
    // --------------------------------------------------------

    await login(page, 'alex')

    await selectResearchGroup(
      page,
      'Robotics Lab',
    )

    await openResearchGroupMembers(
      page,
    )

    await ensureLauraIsResearchGroupMember(
      page,
    )

    // --------------------------------------------------------
    // Laura creates a private Project.
    // She is its only owner.
    // --------------------------------------------------------

    await logout(page)
    await login(page, 'laura')

    await selectResearchGroup(
      page,
      'Robotics Lab',
    )

    await createProject(
      page,
      projectName,
    )

    const projectId =
      getProjectId(page)

    // No Work Items are created deliberately:
    // this case should expose only the
    // ownership decision.
    await logout(page)

    // --------------------------------------------------------
    // Alex offboards Laura as Research Group admin.
    // --------------------------------------------------------

    await login(page, 'alex')

    await selectResearchGroup(
      page,
      'Robotics Lab',
    )

    await openResearchGroupMembers(
      page,
    )

    const lauraRow =
      getResearchGroupMemberRow(
        page,
        'laura',
      )

    await lauraRow
      .getByRole('button', {
        name: /^Remove /,
      })
      .click()

    const dialog =
      page.getByRole(
        'alertdialog',
        {
          name: 'Remove member',
        },
      )

    await expect(dialog).toBeVisible()

    await expect(
      dialog.getByText(
        projectName,
        { exact: true },
      ),
    ).toBeVisible()

    await expect(
      dialog.getByText(
        'Project ownership',
        { exact: true },
      ),
    ).toBeVisible()

    await expect(
      dialog.getByText(
        /is the only owner of this active project/i,
      ),
    ).toBeVisible()

    // There is no assigned work in this Project,
    // therefore assignment controls must stay hidden.
    await expect(
      dialog.getByText(
        'Assigned work',
        { exact: true },
      ),
    ).toHaveCount(0)

    const removeButton =
      dialog.getByRole(
        'button',
        {
          name: 'Remove member',
          exact: true,
        },
      )

    // Final-owner Projects require an explicit
    // ownership decision.
    await expect(
      removeButton,
    ).toBeDisabled()

    await dialog
      .getByRole('radio', {
        name: /Archive project/,
      })
      .check()

    await expect(
      removeButton,
    ).toBeEnabled()

    const offboardingResponsePromise =
      page.waitForResponse(
        (response) =>
          response.url().includes(
            '/offboarding/',
          ) &&
          response.request().method() ===
            'POST',
      )

    await removeButton.click()

    const offboardingResponse =
      await offboardingResponsePromise

    expect(
      offboardingResponse.status(),
    ).toBe(200)

    const requestData =
      offboardingResponse
        .request()
        .postDataJSON() as {
          projects: Array<{
            projectId: number
            ownershipResolution?: {
              mode: string
            }
            assignmentResolution?: unknown
          }>
        }

    expect(
      requestData.projects,
    ).toEqual([
      {
        projectId,
        ownershipResolution: {
          mode: 'archive',
        },
      },
    ])

    const responseData =
      await offboardingResponse.json() as {
        summary: {
          removedProjectMembershipCount:
            number
          affectedWorkItemCount: number
          ownershipTransferCount: number
          archivedProjectCount: number
        }
      }

    expect(
      responseData.summary
        .removedProjectMembershipCount,
    ).toBe(1)

    expect(
      responseData.summary
        .affectedWorkItemCount,
    ).toBe(0)

    expect(
      responseData.summary
        .ownershipTransferCount,
    ).toBe(0)

    expect(
      responseData.summary
        .archivedProjectCount,
    ).toBe(1)

    await expect(dialog).not.toBeVisible()

    await expect(
      page.getByText(
        '@laura',
        { exact: true },
      ),
    ).toHaveCount(0)
  },
)
