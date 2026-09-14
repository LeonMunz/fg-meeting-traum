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
    // Open creation from the existing Research Group selector.
    // --------------------------------------------------------

    const switcher = page.getByRole('button', {
      name: /^Research group:/,
    })
    await expect(switcher).toBeVisible()
    await switcher.click()

    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()

    await menu
      .getByRole('menuitem', {
        name: 'Create research group',
      })
      .click()

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

    // The new group is immediately the active Research Group in the
    // canonical selector, with no page reload.
    await expect(
      page.getByRole('button', {
        name: `Research group: ${groupName}`,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // The new group appears in the same selector list, with the
    // creator's Owner (admin) role as the stable visible signal.
    // --------------------------------------------------------

    await page
      .getByRole('button', {
        name: `Research group: ${groupName}`,
      })
      .click()

    await expect(
      page.getByRole('menu'),
    ).toBeVisible()

    const createdOption = page
      .getByRole('menu')
      .getByRole('menuitem')
      .filter({ hasText: groupName })

    await expect(createdOption).toBeVisible()
    await expect(
      createdOption.getByText('admin', { exact: true }),
    ).toBeVisible()

    await page.keyboard.press('Escape')

    // --------------------------------------------------------
    // Navigate within the new group.
    // --------------------------------------------------------

    await page.getByRole('link', { name: /Projects/ }).click()

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

    await expect(
      page.getByRole('button', {
        name: `Research group: ${groupName}`,
      }),
    ).toBeVisible()

    await page
      .getByRole('button', {
        name: `Research group: ${groupName}`,
      })
      .click()

    const reloadedOption = page
      .getByRole('menu')
      .getByRole('menuitem')
      .filter({ hasText: groupName })

    await expect(reloadedOption).toBeVisible()
    await expect(
      reloadedOption.getByText('admin', { exact: true }),
    ).toBeVisible()
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
    // The sidebar exposes the first-group entry in the normal
    // Research Group slot.
    // --------------------------------------------------------

    const zeroStateEntry = page.getByRole('button', {
      name: 'New research group',
    })
    await expect(zeroStateEntry).toBeVisible()

    // Clicking opens the existing creation dialog.
    await zeroStateEntry.click()

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
    // the zero-state entry is replaced by the normal selector.
    // --------------------------------------------------------

    const response = await createResponse
    expect(response.status()).toBe(201)
    const created = await response.json()
    expect(created.role).toBe('admin')
    const newGroupId = String(created.id)

    await expect(dialog).toBeHidden()
    await expect(zeroStateEntry).toBeHidden()

    const switcher = page.getByRole('button', {
      name: `Research group: ${groupName}`,
    })
    await expect(switcher).toBeVisible()

    // --------------------------------------------------------
    // Group-scoped navigation is usable, without a page reload.
    // --------------------------------------------------------

    await expect(
      page.getByRole('navigation', {
        name: 'Research group navigation',
      }),
    ).toBeVisible()

    await page.getByRole('link', { name: /Projects/ }).click()

    await expect(page).toHaveURL(
      new RegExp(`/projects\\?group=${newGroupId}$`),
    )

    // --------------------------------------------------------
    // Reload: membership is persisted server-side, so the first
    // group remains active and selectable.
    // --------------------------------------------------------

    await page.reload()

    await expect(switcher).toBeVisible()
    await switcher.click()

    const option = page
      .getByRole('menu')
      .getByRole('menuitem')
      .filter({ hasText: groupName })

    await expect(option).toBeVisible()
    await expect(
      option.getByText('admin', { exact: true }),
    ).toBeVisible()
  },
)
