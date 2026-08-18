import {
  expect,
  test,
  type Page,
} from '@playwright/test'

import {
  login,
  logout,
} from './helpers'

async function selectResearchGroup(
  page: Page,
  name: string,
) {
  const switcher = page.getByRole(
    'button',
    {
      name: /^Research group:/,
    },
  )

  await expect(switcher).toBeVisible()
  await switcher.click()

  const menu =
    page.getByRole('menu')

  await expect(menu).toBeVisible()

  const option = menu
    .getByRole('menuitem')
    .filter({
      hasText: name,
    })

  await expect(option).toBeVisible()
  await option.click()

  await expect(
    page.getByRole(
      'button',
      {
        name: `Research group: ${name}`,
      },
    ),
  ).toBeVisible()
}

async function openResearchGroupSettings(
  page: Page,
) {
  const switcher = page.getByRole(
    'button',
    {
      name: /^Research group:/,
    },
  )

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

test(
  'admin can rename group and manage member roles',
  async ({ page }) => {
    await login(page, 'alex')

    await selectResearchGroup(
      page,
      'Robotics Lab',
    )

    await openResearchGroupSettings(
      page,
    )

    const settingsPath =
      new URL(page.url()).pathname

    // --------------------------------------------------------
    // General
    // --------------------------------------------------------

    await expect(
      page.getByRole('heading', {
        name: 'Robotics Lab',
        exact: true,
      }),
    ).toBeVisible()

    const nameInput =
      page.getByLabel(
        'Research group name',
      )

    await expect(
      nameInput,
    ).toHaveValue(
      'Robotics Lab',
    )

    await nameInput.fill(
      'Robotics Lab E2E',
    )

    await page
      .getByRole('button', {
        name: 'Save',
        exact: true,
      })
      .click()

    await expect(
      page.getByRole('heading', {
        name: 'Robotics Lab E2E',
        exact: true,
      }),
    ).toBeVisible()

    await expect(
      page.getByRole(
        'button',
        {
          name:
            'Research group: Robotics Lab E2E',
        },
      ),
    ).toBeVisible()

    // Restore canonical E2E name.
    await nameInput.fill(
      'Robotics Lab',
    )

    await page
      .getByRole('button', {
        name: 'Save',
        exact: true,
      })
      .click()

    await expect(
      page.getByRole('heading', {
        name: 'Robotics Lab',
        exact: true,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // Members
    // --------------------------------------------------------

    await page
      .getByRole('button', {
        name: 'Members',
        exact: true,
      })
      .click()

    const chrisRole =
      page.getByLabel(
        'Role for Chris',
      )

    await expect(
      chrisRole,
    ).toHaveValue('member')

    await chrisRole.selectOption(
      'admin',
    )

    await expect(
      chrisRole,
    ).toHaveValue('admin')

    // Restore canonical E2E role.
    await chrisRole.selectOption(
      'member',
    )

    await expect(
      chrisRole,
    ).toHaveValue('member')

    // --------------------------------------------------------
    // Non-admin may open the URL but cannot manage settings.
    // --------------------------------------------------------

    await logout(page)
    await login(page, 'chris')

    await page.goto(
      settingsPath,
    )

    await expect(
      page.getByText(
        'Research group settings are managed by admins.',
        { exact: true },
      ),
    ).toBeVisible()

    await expect(
      page.getByRole('button', {
        name: 'General',
        exact: true,
      }),
    ).toHaveCount(0)

    await expect(
      page.getByRole('button', {
        name: 'Members',
        exact: true,
      }),
    ).toHaveCount(0)

    // Settings entry itself is also hidden from a normal member.
    const switcher = page.getByRole(
      'button',
      {
        name: /^Research group:/,
      },
    )

    await switcher.click()

    await expect(
      page.getByRole('menuitem', {
        name: /Research group settings/,
      }),
    ).toHaveCount(0)
  },
)


test(
  'admin can search and add a research group member',
  async ({ page }) => {
    await login(page, 'alex')

    await selectResearchGroup(
      page,
      'Robotics Lab',
    )

    await openResearchGroupSettings(
      page,
    )

    await page
      .getByRole('button', {
        name: 'Members',
        exact: true,
      })
      .click()

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

    await expect(
      dialog,
    ).toBeVisible()

    const searchInput =
      dialog.getByLabel(
        'Search person',
      )

    // No broad user enumeration before a useful query.
    await expect(
      dialog.getByText(
        'Enter at least 2 characters.',
        { exact: true },
      ),
    ).toBeVisible()

    await searchInput.fill(
      'laura',
    )

    const lauraCandidate =
      dialog
        .getByRole('button')
        .filter({
          hasText: '@laura',
        })

    await expect(
      lauraCandidate,
    ).toBeVisible()

    await lauraCandidate.click()

    await expect(
      dialog.getByRole(
        'radio',
        {
          name: 'Member',
          exact: true,
        },
      ),
    ).toBeChecked()

    await dialog
      .getByRole('button', {
        name: 'Add member',
        exact: true,
      })
      .click()

    await expect(
      dialog,
    ).toHaveCount(0)

    // New membership is immediately reflected in the settings list.
    await expect(
      page.getByText(
        '@laura',
        { exact: true },
      ),
    ).toBeVisible()

    // Once added, Laura must no longer be discoverable as a candidate.
    await page
      .getByRole('button', {
        name: 'Add member',
        exact: true,
      })
      .click()

    const secondDialog =
      page.getByRole('dialog', {
        name: 'Add member',
      })

    await secondDialog
      .getByLabel(
        'Search person',
      )
      .fill('laura')

    await expect(
      secondDialog.getByText(
        'No matching people found.',
        { exact: true },
      ),
    ).toBeVisible()

    await secondDialog
      .getByRole('button', {
        name: 'Close dialog',
      })
      .click()

    await expect(
      secondDialog,
    ).toHaveCount(0)
  },
)
