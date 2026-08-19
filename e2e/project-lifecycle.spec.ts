import {
  expect,
  test,
  type Page,
} from '@playwright/test'

import {
  login,
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

  await expect(dialog).not.toBeVisible()

  await expect(
    page.getByText(
      name,
      { exact: true },
    ),
  ).toBeVisible()
}


async function openVisibleProject(
  page: Page,
  name: string,
) {
  await page
    .getByText(
      name,
      { exact: true },
    )
    .click()

  await expect(page).toHaveURL(
    /\/projects\/\d+\/work-items$/,
  )

  await expect(
    page.getByRole('heading', {
      name,
      exact: true,
    }),
  ).toBeVisible()
}


async function openSettings(
  page: Page,
) {
  await page
    .getByRole('link', {
        name: 'Settings',
        exact: true,
      })
    .click()

  await expect(
    page.getByRole('heading', {
      name: 'Project settings',
      exact: true,
    }),
  ).toBeVisible()
}


async function backToProjects(
  page: Page,
) {
  await page
    .getByRole('link', {
      name: 'Projects',
      exact: true,
    })
    .first()
    .click()

  await expect(
    page.getByRole('heading', {
      name: 'Projects',
      exact: true,
    }),
  ).toBeVisible()
}


test(
  'owner archives restores and deletes an empty Project',
  async ({ page }) => {
    const projectName =
      'E2E Lifecycle Empty Project'

    await login(page, 'alex')

    // --------------------------------------------------------
    // Create an empty Project.
    // --------------------------------------------------------

    await createProject(
      page,
      projectName,
      'Browser acceptance project for archive and restore.',
    )

    await openVisibleProject(
      page,
      projectName,
    )

    const projectPath =
      new URL(page.url()).pathname

    // --------------------------------------------------------
    // Archive.
    // --------------------------------------------------------

    await openSettings(page)

    await page
      .getByRole('button', {
        name: 'Archive',
        exact: true,
      })
      .click()

    const archiveDialog =
      page.getByRole('alertdialog', {
        name: 'Archive project?',
      })

    await expect(
      archiveDialog,
    ).toBeVisible()

    await archiveDialog
      .getByRole('button', {
        name: 'Archive project',
        exact: true,
      })
      .click()

    await expect(
      archiveDialog,
    ).not.toBeVisible()

    await expect(
      page.getByText(
        'Archived project',
        { exact: true },
      ),
    ).toBeVisible()

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

    // Persistence must survive reload.
    await page.reload()

    await expect(
      page.getByText(
        'Archived project',
        { exact: true },
      ),
    ).toBeVisible()

    // --------------------------------------------------------
    // Archived Project disappears from current Projects.
    // --------------------------------------------------------

    await backToProjects(page)

    await expect(
      page.getByText(
        projectName,
        { exact: true },
      ),
    ).toHaveCount(0)

    const archivedButton =
      page.getByRole('button', {
        name: /^Archived/,
      })

    await expect(
      archivedButton,
    ).toBeVisible()

    await archivedButton.click()

    await expect(
      page.getByText(
        projectName,
        { exact: true },
      ),
    ).toBeVisible()

    // --------------------------------------------------------
    // Restore.
    // --------------------------------------------------------

    await openVisibleProject(
      page,
      projectName,
    )

    await openSettings(page)

    await page
      .getByRole('button', {
        name: 'Restore',
        exact: true,
      })
      .click()

    await expect(
      page.getByText(
        'Archived project',
        { exact: true },
      ),
    ).toHaveCount(0)

    await expect(
      page.getByLabel('Project name'),
    ).toBeEnabled()

    // Persistence must survive reload.
    await page.reload()

    await expect(
      page.getByText(
        'Archived project',
        { exact: true },
      ),
    ).toHaveCount(0)

    // Restored Project belongs to current Projects again.
    await backToProjects(page)

    await expect(
      page.getByText(
        projectName,
        { exact: true },
      ),
    ).toBeVisible()

    // --------------------------------------------------------
    // Empty Project can be permanently deleted.
    // --------------------------------------------------------

    await openVisibleProject(
      page,
      projectName,
    )

    await openSettings(page)

    const deleteButton =
      page.getByRole('button', {
        name: 'Delete',
        exact: true,
      })

    await expect(
      deleteButton,
    ).toBeEnabled()

    await deleteButton.click()

    const deleteDialog =
      page.getByRole('alertdialog', {
        name: 'Delete project permanently?',
      })

    await expect(
      deleteDialog,
    ).toBeVisible()

    await deleteDialog
      .getByRole('button', {
        name: 'Delete project',
        exact: true,
      })
      .click()

    await expect(page).toHaveURL(
      /\/projects\?group=\d+$/,
    )

    await expect(
      page.getByText(
        projectName,
        { exact: true },
      ),
    ).toHaveCount(0)

    // It must not exist in the archive either.
    await page
      .getByRole('button', {
        name: /^Archived/,
      })
      .click()

    await expect(
      page.getByText(
        projectName,
        { exact: true },
      ),
    ).toHaveCount(0)

    // Direct access proves that the Project itself is gone.
    await page.goto(projectPath)

    await expect(
      page.getByRole('heading', {
        name: 'Project not found',
        exact: true,
      }),
    ).toBeVisible()
  },
)


test(
  'Project with work cannot be deleted and archive preserves its work',
  async ({ page }) => {
    const projectName =
      'E2E Lifecycle Project With Work'

    const workItemTitle =
      'E2E Lifecycle Protected Work'

    await login(page, 'alex')

    // --------------------------------------------------------
    // Create Project and one canonical Work Item.
    // --------------------------------------------------------

    await createProject(
      page,
      projectName,
      'Project whose existing work must survive archival.',
    )

    await openVisibleProject(
      page,
      projectName,
    )

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
      .fill(workItemTitle)

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
        workItemTitle,
        { exact: true },
      ),
    ).toBeVisible()

    // --------------------------------------------------------
    // Existing work prevents permanent Project deletion.
    // --------------------------------------------------------

    await openSettings(page)

    const deleteButton =
      page.getByRole('button', {
        name: 'Delete',
        exact: true,
      })

    await expect(
      deleteButton,
    ).toBeDisabled()

    await expect(
      page.getByText(
        /This project contains 1 work item, so permanent deletion is unavailable\./,
      ),
    ).toBeVisible()

    const archiveButton =
      page.getByRole('button', {
        name: 'Archive',
        exact: true,
      })

    await expect(
      archiveButton,
    ).toBeEnabled()

    // --------------------------------------------------------
    // Archive is the safe lifecycle operation.
    // --------------------------------------------------------

    await archiveButton.click()

    const archiveDialog =
      page.getByRole('alertdialog', {
        name: 'Archive project?',
      })

    await expect(
      archiveDialog,
    ).toBeVisible()

    await archiveDialog
      .getByRole('button', {
        name: 'Archive project',
        exact: true,
      })
      .click()

    await expect(
      archiveDialog,
    ).not.toBeVisible()

    await expect(
      page.getByText(
        'Archived project',
        { exact: true },
      ),
    ).toBeVisible()

    // --------------------------------------------------------
    // Reload proves archive persistence and retained work.
    // --------------------------------------------------------

    await page.reload()

    await expect(
      page.getByText(
        'Archived project',
        { exact: true },
      ),
    ).toBeVisible()

    await page
      .getByRole('link', {
        name: /Work Items/,
      })
      .click()

    await expect(
      page.getByText(
        workItemTitle,
        { exact: true },
      ),
    ).toBeVisible()
  },
)
