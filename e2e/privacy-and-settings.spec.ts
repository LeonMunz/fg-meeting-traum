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

    await logout(page, 'Alex')
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

    await logout(page, 'Alex')
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

test(
  'Project Header add-member shortcut adds an existing user without leaving Work Items',
  async ({ page }) => {
    const projectName =
      'E2E Header Member Project'

    await login(page, 'alex')

    await createProject(
      page,
      projectName,
      'Header add-member shortcut acceptance project.',
    )

    await openProject(
      page,
      projectName,
    )

    const workItemsPath =
      new URL(page.url()).pathname

    expect(workItemsPath).toMatch(
      /^\/projects\/\d+\/work-items$/,
    )

    // The shortcut is visible to the Project owner on the
    // Work Items page.
    const addButton =
      page.getByRole('button', {
        name: 'Add project member',
        exact: true,
      })

    await expect(addButton).toBeVisible()
    await expect(addButton).toHaveAttribute(
      'title',
      'Add project member',
    )

    // Clicking opens the shared Add-member dialog in place,
    // without navigating to Settings.
    await addButton.click()

    const dialog =
      page.getByRole('dialog', {
        name: 'Add project member',
      })

    await expect(dialog).toBeVisible()
    expect(
      new URL(page.url()).pathname,
    ).toBe(workItemsPath)

    // The dialog lists the eligible candidates (Research
    // Group members who are not yet Project members) for an
    // empty query.
    const row = (username: string) =>
      dialog
        .getByRole('button')
        .filter({
          hasText: username,
        })

    await expect(row('@chris')).toBeVisible()
    await expect(row('@maria')).toBeVisible()
    await expect(row('@laura')).toBeVisible()

    // Typing filters the visible result set: 'mar' matches
    // Maria only.
    await dialog
      .getByLabel('Select person')
      .fill('mar')

    await expect(row('@maria')).toBeVisible()
    await expect(row('@chris')).toHaveCount(0)
    await expect(row('@laura')).toHaveCount(0)

    // Clearing the query restores the full eligible pool.
    await dialog
      .getByLabel('Select person')
      .fill('')

    await expect(row('@chris')).toBeVisible()
    await expect(row('@maria')).toBeVisible()
    await expect(row('@laura')).toBeVisible()

    // A query without matches shows the distinct no-match
    // state (not the everyone-has-access message).
    await dialog
      .getByLabel('Select person')
      .fill('zzz-nobody')

    await expect(
      dialog.getByText('No matching people'),
    ).toBeVisible()
    await expect(
      dialog.getByText(
        'Everyone already has project access',
      ),
    ).toHaveCount(0)

    // Search again for the intended candidate and select it.
    // The canonical default role (Member) is used — no
    // explicit role change.
    await dialog
      .getByLabel('Select person')
      .fill('chris')

    await expect(row('@chris')).toBeVisible()
    await expect(row('@maria')).toHaveCount(0)

    await row('@chris').click()

    // The selected person renders exactly once: the search
    // and the candidate list are replaced by the selected row.
    await expect(
      dialog.getByLabel('Select person'),
    ).toHaveCount(0)
    await expect(row('@chris')).toHaveCount(0)
    await expect(dialog.getByText('@chris')).toBeVisible()

    await expect(
      dialog
        .getByRole('radio', {
          name: /^Member/,
        }),
    ).toBeChecked()

    await dialog
      .getByRole('button', {
        name: /Add member/,
      })
      .click()

    // The backend mutation succeeded: dialog closed, still on
    // the same Work Items route, and the new member is visible
    // in the header cluster without a reload.
    await expect(dialog).not.toBeVisible()
    expect(
      new URL(page.url()).pathname,
    ).toBe(workItemsPath)

    await expect(
      page
        .locator('header')
        .getByTitle('Chris'),
    ).toBeVisible()

    // The same member is present in Settings -> Access.
    await page
      .getByRole('link', {
        name: 'Settings',
        exact: true,
      })
      .click()

    await expect(
      page.getByText(
        '@chris',
        { exact: true },
      ),
    ).toBeVisible()

    // Reload: membership persists and the header still shows
    // the member.
    await page.reload()

    await expect(
      page
        .locator('header')
        .getByTitle('Chris'),
    ).toBeVisible()

    await expect(
      page.getByRole('button', {
        name: 'Add project member',
        exact: true,
      }),
    ).toBeVisible()

    // An unauthorized (non-owner) Project member does not see
    // the header shortcut ...
    await logout(page, 'Alex')
    await login(page, 'chris')
    await openProjects(page)
    await openProject(page, projectName)

    await expect(
      page.getByRole('button', {
        name: 'Add project member',
        exact: true,
      }),
    ).toHaveCount(0)

    // ... while the member cluster itself remains rendered.
    await expect(
      page
        .locator('header')
        .getByTitle('Chris'),
    ).toBeVisible()
  },
)
