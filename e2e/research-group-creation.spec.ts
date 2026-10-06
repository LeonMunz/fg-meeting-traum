import { expect, test } from '@playwright/test'

import {
  createAccountInvitation,
  login,
  logout,
  PASSWORD,
  userMenuTrigger,
} from './helpers'

test(
  'authenticated user can create a research group and immediately access it',
  async ({ page }) => {
    // "maria" is a normal authenticated user (member of FG Example,
    // admin of no group) and is not used by any other E2E spec.
    await login(page, 'maria')

    const groupName = `E2E Created Group ${Date.now()}`

    // --------------------------------------------------------
    // Open creation from the sidebar's Create research group
    // entry (the workspace tree replaced the former selector
    // dropdown).
    // --------------------------------------------------------

    const createEntry = page.getByRole('button', {
      name: 'Create research group',
    })
    await expect(createEntry).toBeVisible()
    await createEntry.click()

    const dialog = page.getByRole('dialog', {
      name: 'Create research group',
    })
    await expect(dialog).toBeVisible()

    const createResponse = page.waitForResponse(
      (response) =>
        response
          .url()
          .endsWith('/api/research-groups/') &&
        response.request().method() === 'POST',
    )

    await dialog
      .getByLabel('Research group name')
      .fill(groupName)
    await dialog
      .getByRole('button', {
        name: 'Create research group',
      })
      .click()

    // --------------------------------------------------------
    // Success: the server response proves the creator's
    // membership; the dialog closes without a page reload.
    // --------------------------------------------------------

    const response = await createResponse
    expect(response.status()).toBe(201)
    const created = await response.json()
    expect(created.role).toBe('admin')
    const newGroupId = String(created.id)

    await expect(dialog).toBeHidden()

    // The new group is immediately the active Research Group in
    // the workspace tree, with no page reload.
    const createdRowLabel = page
      .getByRole('group', { name: groupName })
      .getByRole('button', {
        name: groupName,
        exact: true,
      })
    await expect(createdRowLabel).toBeVisible()
    await expect(createdRowLabel).toHaveAttribute(
      'aria-current',
      'true',
    )

    // --------------------------------------------------------
    // The new group is a workspace tree row: its name and chevron
    // share disclosure state. There is no
    // overflow / three-dot menu — the admin-only Settings
    // destination lives on the group's Overview.
    // --------------------------------------------------------

    await expect(
      page.getByRole('button', {
        name: `Collapse ${groupName}`,
      }),
    ).toBeVisible()

    await expect(
      page.getByRole('button', {
        name: `More options for ${groupName}`,
      }),
    ).toHaveCount(0)

    await page
      .getByRole('link', {
        name: 'Settings',
        exact: true,
      })
      .click()

    await expect(page).toHaveURL(
      new RegExp(`/groups/${newGroupId}/settings$`),
    )

    // The Overview route remains canonical even though the name
    // controls disclosure rather than navigation.
    await page.goto(`/groups/${newGroupId}`)

    // --------------------------------------------------------
    // Navigate within the new group.
    // --------------------------------------------------------

    await page
      .getByRole('group', { name: groupName })
      .getByRole('link', { name: /Projects/ })
      .click()

    await expect(page).toHaveURL(
      new RegExp(`/projects\\?group=${newGroupId}$`),
    )

    await expect(
      page.getByRole('heading', {
        name: 'Projects',
        exact: true,
      }),
    ).toBeVisible()
    await expect(
      page.getByText(
        `Projects you can access in ${groupName}.`,
      ),
    ).toBeVisible()

    // --------------------------------------------------------
    // Reload: membership is persisted server-side, so access is
    // preserved and the group stays active and selectable.
    // --------------------------------------------------------

    await page.reload()

    // The reload lands on the scoped Projects list, where the
    // row is not route-active (the Overview owns the active
    // presentation): open the canonical Overview directly; the
    // admin Settings destination survives the reload there.
    await expect(
      createdRowLabel,
    ).toBeVisible()

    await page.goto(`/groups/${newGroupId}`)

    await expect(page).toHaveURL(
      new RegExp(`/groups/${newGroupId}$`),
    )
    await expect(createdRowLabel).toHaveAttribute(
      'aria-current',
      'true',
    )

    await page
      .getByRole('link', {
        name: 'Settings',
        exact: true,
      })
      .click()

    await expect(page).toHaveURL(
      new RegExp(`/groups/${newGroupId}/settings$`),
    )
  },
)

test(
  'a user with zero research groups can create their first group from the sidebar',
  async ({ page }) => {
    // --------------------------------------------------------
    // Bootstrap a genuine zero-membership account through the
    // existing invite/registration flow: registration creates no
    // Research Group membership (pinned backend invariant).
    // --------------------------------------------------------

    await login(page, 'alex')

    const suffix = Date.now()
    const invitedEmail = `first-group-${suffix}@example.com`
    const token = await createAccountInvitation(
      page,
      invitedEmail,
    )

    await logout(page, 'Alex')

    const newUsername = `firstgroup${suffix}`
    await page.goto(
      `/register?token=${encodeURIComponent(token)}`,
    )

    await page.getByLabel('Username').fill(newUsername)
    await page
      .getByLabel('Password', { exact: true })
      .fill(PASSWORD)
    await page
      .getByLabel('Confirm password')
      .fill(PASSWORD)
    await page
      .getByRole('button', { name: 'Create account' })
      .click()

    // Authenticated application shell for the new account.
    await expect(page).toHaveURL('http://127.0.0.1:4173/')
    await expect(
      userMenuTrigger(page, newUsername),
    ).toBeVisible()

    // The API proves zero Research Groups before creation.
    const groups = await page.evaluate(async () => {
      const res = await fetch('/api/research-groups/', {
        credentials: 'same-origin',
      })
      return res.json()
    })
    expect(groups).toEqual([])

    // --------------------------------------------------------
    // The permanent, bottom-anchored Create research group
    // action is visible even with zero Research Groups.
    // --------------------------------------------------------

    const createEntry = page.getByRole('button', {
      name: 'Create research group',
    })
    await expect(createEntry).toBeVisible()

    // Clicking opens the existing creation dialog.
    await createEntry.click()

    const dialog = page.getByRole('dialog', {
      name: 'Create research group',
    })
    await expect(dialog).toBeVisible()

    const groupName = `First Group ${suffix}`
    const createResponse = page.waitForResponse(
      (response) =>
        response
          .url()
          .endsWith('/api/research-groups/') &&
        response.request().method() === 'POST',
    )

    await dialog
      .getByLabel('Research group name')
      .fill(groupName)
    await dialog
      .getByRole('button', {
        name: 'Create research group',
      })
      .click()

    // --------------------------------------------------------
    // The server response proves the creator's Owner membership;
    // the dialog closes, the new group appears in the workspace
    // tree, and the permanent Create action remains available.
    // --------------------------------------------------------

    const response = await createResponse
    expect(response.status()).toBe(201)
    const created = await response.json()
    expect(created.role).toBe('admin')
    const newGroupId = String(created.id)

    await expect(dialog).toBeHidden()
    await expect(createEntry).toBeVisible()

    const groupLabel = page
      .getByRole('group', { name: groupName })
      .getByRole('button', {
        name: groupName,
        exact: true,
      })
    await expect(groupLabel).toBeVisible()
    await expect(groupLabel).toHaveAttribute(
      'aria-current',
      'true',
    )

    // --------------------------------------------------------
    // Group-scoped navigation is usable, without a page reload.
    // --------------------------------------------------------

    await expect(
      page.getByRole('navigation', {
        name: 'Research groups',
      }),
    ).toBeVisible()

    await page
      .getByRole('group', { name: groupName })
      .getByRole('link', { name: /Projects/ })
      .click()

    await expect(page).toHaveURL(
      new RegExp(`/projects\\?group=${newGroupId}$`),
    )

    // --------------------------------------------------------
    // Reload: membership is persisted server-side, so the first
    // group remains active and keeps its admin destination.
    // --------------------------------------------------------

    await page.reload()

    // The reload lands on the scoped Projects list (the
    // active presentation belongs to the Overview): open that
    // canonical route directly; the admin Settings destination
    // survives the reload there.
    await expect(groupLabel).toBeVisible()

    await page.goto(`/groups/${newGroupId}`)

    await expect(page).toHaveURL(
      new RegExp(`/groups/${newGroupId}$`),
    )
    await expect(groupLabel).toHaveAttribute(
      'aria-current',
      'true',
    )

    await page
      .getByRole('link', {
        name: 'Settings',
        exact: true,
      })
      .click()

    await expect(page).toHaveURL(
      new RegExp(`/groups/${newGroupId}/settings$`),
    )
  },
)
