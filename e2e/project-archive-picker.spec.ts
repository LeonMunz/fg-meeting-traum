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


async function openProject(
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
  'archived Project stays in archive but is excluded from Meeting work picker',
  async ({ page }) => {
    const archivedProjectName =
      'E2E Archived Meeting Picker Project'

    const activeProjectName =
      'E2E Active Meeting Picker Project'

    const meetingTitle =
      'E2E Archive Filter Meeting'

    const agendaTitle =
      'E2E Archive Filter Agenda'

    await login(page, 'alex')

    // --------------------------------------------------------
    // Create one Project that will be archived and one that
    // stays writable.
    // --------------------------------------------------------

    await createProject(
      page,
      archivedProjectName,
      'Archived Project must never appear in normal work pickers.',
    )

    await createProject(
      page,
      activeProjectName,
      'Active Project remains available for new Meeting work.',
    )

    // --------------------------------------------------------
    // Archive the first Project.
    // --------------------------------------------------------

    await openProject(
      page,
      archivedProjectName,
    )

    await page
      .getByRole('link', {
        name: 'Settings',
        exact: true,
      })
      .click()

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

    // --------------------------------------------------------
    // Default Project view excludes it.
    // --------------------------------------------------------

    await backToProjects(page)

    await expect(
      page.getByText(
        archivedProjectName,
        { exact: true },
      ),
    ).toHaveCount(0)

    await expect(
      page.getByText(
        activeProjectName,
        { exact: true },
      ),
    ).toBeVisible()

    // --------------------------------------------------------
    // Explicit Archived view still includes it.
    // --------------------------------------------------------

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
        archivedProjectName,
        { exact: true },
      ),
    ).toBeVisible()

    // --------------------------------------------------------
    // Create Meeting + Agenda Item.
    // --------------------------------------------------------

    await page
      .getByRole('link', {
        name: /Meetings/,
      })
      .click()

    await expect(page).toHaveURL(
      /\/meetings\?group=\d+$/,
    )

    await page
      .getByRole('button', {
        name: /New meeting/,
      })
      .click()

    await page
      .getByLabel('Title')
      .fill(meetingTitle)

    await page
      .getByLabel('Date and time')
      .fill('2030-04-05T10:00')

    await page
      .locator('form')
      .getByRole('button', {
        name: /Create meeting/,
      })
      .click()

    const meetingRow =
      page
        .getByRole('button')
        .filter({
          hasText: meetingTitle,
        })

    await expect(
      meetingRow,
    ).toBeVisible()

    await meetingRow.click()

    await expect(page).toHaveURL(
      /\/meetings\/\d+$/,
    )

    await page
      .getByLabel('Agenda item')
      .fill(agendaTitle)

    await page
      .getByLabel('Notes')
      .fill(
        'Verify archived Projects are excluded from new work.',
      )

    await page
      .getByRole('button', {
        name: /Add agenda item/,
      })
      .click()

    const agendaItem =
      page
        .locator('article')
        .filter({
          has: page.getByText(
            agendaTitle,
            { exact: true },
          ),
        })

    await expect(
      agendaItem,
    ).toBeVisible()

    // --------------------------------------------------------
    // Meeting Work Item picker must use the safe default list.
    // --------------------------------------------------------

    await agendaItem
      .getByRole('button')
      .filter({
        hasText: 'Create work item',
      })
      .click()

    const workItemDialog =
      page.getByRole('dialog', {
        name: 'Create work item',
      })

    await expect(
      workItemDialog,
    ).toBeVisible()

    const projectSelect =
      workItemDialog.getByLabel(
        'Project',
      )

    const activeOption =
      projectSelect.getByRole(
        'option',
        {
          name: activeProjectName,
          exact: true,
        },
      )

    const archivedOption =
      projectSelect.getByRole(
        'option',
        {
          name: archivedProjectName,
          exact: true,
        },
      )

    // Wait for the API-backed Project list to finish loading
    // before asserting absence of the archived Project.
    await expect(
      activeOption,
    ).toHaveCount(1)

    await expect(
      archivedOption,
    ).toHaveCount(0)
  },
)
