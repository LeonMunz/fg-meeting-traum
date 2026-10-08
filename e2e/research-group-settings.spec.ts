import {
  expect,
  test,
  type Page,
} from '@playwright/test'

import {
  login,
  logout,
} from './helpers'

/**
 * State ownership: each test in this spec creates its own Research
 * Group through the user-facing creation flow and mutates only that
 * group (rename, memberships, roles). The shared seeded Research
 * Groups (Robotics Lab, FG Example) and their memberships are never
 * touched; the run-level fg_e2e reset is the only cleanup.
 */

type OwnedResearchGroup = {
  id: string
  name: string
}

/**
 * Creates a test-owned Research Group through the user-facing
 * creation flow (the permanent sidebar entry + dialog) for the
 * currently logged-in user. The server response proves the creator
 * becomes admin of the new group, and creation lands on the new
 * group's canonical Overview.
 */
async function createResearchGroup(
  page: Page,
  name: string,
): Promise<OwnedResearchGroup> {
  const createEntry =
    page.getByRole('button', {
      name: 'Create research group',
    })

  await expect(createEntry).toBeVisible()
  await createEntry.click()

  const dialog =
    page.getByRole('dialog', {
      name: 'Create research group',
    })

  await expect(dialog).toBeVisible()

  const createResponse =
    page.waitForResponse(
      (response) =>
        response
          .url()
          .endsWith('/api/research-groups/') &&
        response.request().method() === 'POST',
    )

  await dialog
    .getByLabel('Research group name')
    .fill(name)

  await dialog
    .getByRole('button', {
      name: 'Create research group',
    })
    .click()

  const response = await createResponse
  expect(response.status()).toBe(201)
  const created = (await response.json()) as {
    id: number
    role: string
  }

  // The creator is admin of the new group.
  expect(created.role).toBe('admin')

  await expect(dialog).toBeHidden()

  // Creation lands on the new group's canonical Overview, where
  // the admin-only Settings link is available to the creator.
  await expect(page).toHaveURL(
    new RegExp(`/groups/${created.id}$`),
  )

  return {
    id: String(created.id),
    name,
  }
}

/**
 * Opens the test-owned group's admin Settings from its Overview.
 */
async function openOwnedGroupSettings(
  page: Page,
  group: OwnedResearchGroup,
) {
  await page
    .getByRole('link', {
      name: 'Settings',
      exact: true,
    })
    .click()

  await expect(page).toHaveURL(
    new RegExp(`/groups/${group.id}/settings$`),
  )
}

/**
 * Adds the named seeded account as a regular member of the
 * test-owned group through the Members settings dialog.
 */
async function addMemberBySearch(
  page: Page,
  username: string,
) {
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
    username,
  )

  const candidate =
    dialog
      .getByRole('button')
      .filter({
        hasText: `@${username}`,
      })

  await expect(
    candidate,
  ).toBeVisible()
  await candidate.click()

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

  // The new membership is immediately reflected in the
  // settings list.
  await expect(
    page.getByText(
      `@${username}`,
      { exact: true },
    ),
  ).toBeVisible()
}

test(
  'admin can rename group and manage member roles',
  async ({ page }) => {
    await login(page, 'alex')

    const suffix =
      Date.now()
    const group =
      await createResearchGroup(
        page,
        `E2E Settings Rename ${suffix}`,
      )
    const renamedName =
      `E2E Settings Rename Verified ${suffix}`

    await openOwnedGroupSettings(
      page,
      group,
    )

    const settingsPath =
      new URL(page.url()).pathname

    // --------------------------------------------------------
    // General
    // --------------------------------------------------------

    await expect(
      page.getByRole('heading', {
        name: group.name,
        exact: true,
      }),
    ).toBeVisible()

    const nameInput =
      page.getByLabel(
        'Research group name',
      )

    await expect(
      nameInput,
    ).toHaveValue(group.name)

    await nameInput.fill(
      renamedName,
    )

    await page
      .getByRole('button', {
        name: 'Save',
        exact: true,
      })
      .click()

    await expect(
      page.getByRole('heading', {
        name: renamedName,
        exact: true,
      }),
    ).toBeVisible()

    // The renamed test-owned group is reflected in the
    // workspace tree; the final name remains the renamed one.
    await expect(
      page
        .getByRole('group', { name: renamedName })
        .getByRole('button', {
          name: renamedName,
          exact: true,
        }),
    ).toHaveAttribute('aria-current', 'true')

    // --------------------------------------------------------
    // Members
    // --------------------------------------------------------

    await page
      .getByRole('button', {
        name: 'Members',
        exact: true,
      })
      .click()

    // Chris is added to this test-owned group; the seeded
    // Chris membership of Robotics Lab is not touched.
    await addMemberBySearch(
      page,
      'chris',
    )

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

    // The authorization assertions below require Chris to be
    // a non-admin of his own group, so the test-owned role is
    // returned to member (no shared seed state is restored —
    // the membership belongs to this test).
    await chrisRole.selectOption(
      'member',
    )

    await expect(
      chrisRole,
    ).toHaveValue('member')

    // --------------------------------------------------------
    // Non-admin may open the URL but cannot manage settings.
    // --------------------------------------------------------

    await logout(page, 'Alex')
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

    // The admin-only Settings destination is hidden from a
    // normal member's Overview entirely (no affordance at
    // all).
    const overviewPath =
      settingsPath.replace(/\/settings$/, '')

    await page.goto(
      overviewPath,
    )

    await expect(
      page.getByRole('link', {
        name: 'Settings',
        exact: true,
      }),
    ).toHaveCount(0)
  },
)

test(
  'admin can search and add a research group member',
  async ({ page }) => {
    await login(page, 'alex')

    const group =
      await createResearchGroup(
        page,
        `E2E Settings Add Member ${Date.now()}`,
      )

    await openOwnedGroupSettings(
      page,
      group,
    )

    await page
      .getByRole('button', {
        name: 'Members',
        exact: true,
      })
      .click()

    await addMemberBySearch(
      page,
      'laura',
    )

    // Once added, Laura must no longer be discoverable as a
    // candidate of this test-owned group.
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
