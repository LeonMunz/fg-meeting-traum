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

async function createProject(
  page: Page,
  name: string,
  description: string,
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
    .fill(description)

  await dialog
    .getByRole('button', {
      name: /Create project/,
    })
    .click()

  await expect(
    page.getByText(
      name,
      { exact: true },
    ),
  ).toBeVisible()
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

test(
  'private Project is hidden from and inaccessible to Maria',
  async ({ page }) => {
    const projectName =
      'E2E Private Alex Project'

    await login(page, 'alex')

    await createProject(
      page,
      projectName,
      'Private browser acceptance project.',
    )

    await openProject(
      page,
      projectName,
    )

    const projectPath =
      new URL(page.url()).pathname

    const match =
      projectPath.match(
        /^\/projects\/(\d+)\/work-items$/,
      )

    expect(match).not.toBeNull()

    const projectId = match![1]

    await logout(page)
    await login(page, 'maria')
    await openProjects(page)

    // Maria must not discover the Project.
    await expect(
      page.getByText(
        projectName,
        { exact: true },
      ),
    ).toHaveCount(0)

    // Knowing the URL must not bypass Project privacy.
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
  'Project settings persist for owner and are read-only for member',
  async ({ page }) => {
    const originalName =
      'E2E Settings Project'

    const updatedName =
      'E2E Settings Project Updated'

    const updatedDescription =
      'Persisted through the Project settings API.'

    await login(page, 'alex')

    await createProject(
      page,
      originalName,
      'Initial E2E settings description.',
    )

    await openProject(
      page,
      originalName,
    )

    // Chris becomes a normal Project member.
    await addChris(page)

    // --------------------------------------------------------
    // Alex updates Project settings.
    // --------------------------------------------------------

    await page
      .getByRole('link', {
        name: 'Settings',
        exact: true,
      })
      .click()

    const nameInput =
      page.getByLabel('Project name')

    const descriptionInput =
      page.getByLabel('Description')

    await nameInput.fill(updatedName)

    await descriptionInput.fill(
      updatedDescription,
    )

    const projectStatusGroup =
      page.getByRole('group', {
        name: 'Project status',
      })

    await projectStatusGroup
      .getByText(
        'Paused',
        { exact: true },
      )
      .click()

    await expect(
      projectStatusGroup.getByRole(
        'radio',
        {
          name: /Paused/,
        },
      ),
    ).toBeChecked()

    await page
      .getByRole('button', {
        name: /Save changes/,
      })
      .click()

    await expect(
      page.getByText(
        'All changes are saved.',
        { exact: true },
      ),
    ).toBeVisible()

    // Reload proves persistence in PostgreSQL.
    await page.reload()

    await page
      .getByRole('link', {
        name: 'Settings',
        exact: true,
      })
      .click()

    await expect(
      page.getByLabel('Project name'),
    ).toHaveValue(updatedName)

    await expect(
      page.getByLabel('Description'),
    ).toHaveValue(
      updatedDescription,
    )

    await expect(
      page.getByRole('radio', {
        name: /Paused/,
      }),
    ).toBeChecked()

    // --------------------------------------------------------
    // Chris sees the same Project, but cannot edit settings.
    // --------------------------------------------------------

    await logout(page)
    await login(page, 'chris')
    await openProjects(page)

    await openProject(
      page,
      updatedName,
    )

    await page
      .getByRole('link', {
        name: 'Settings',
        exact: true,
      })
      .click()

    await expect(
      page.getByText(
        'Read-only settings',
        { exact: true },
      ),
    ).toBeVisible()

    await expect(
      page.getByLabel('Project name'),
    ).toBeDisabled()

    await expect(
      page.getByLabel('Description'),
    ).toBeDisabled()

    await expect(
      page.getByRole('radio', {
        name: /Paused/,
      }),
    ).toBeDisabled()

    await expect(
      page.getByRole('button', {
        name: /Save changes/,
      }),
    ).toHaveCount(0)
  },
)
