import { expect, test } from '@playwright/test'

import { login, userMenuTrigger } from './helpers'

// Seeded E2E credentials (see settings_e2e reset seed); they must never
// appear in the product UI itself.

test('authenticated topbar shows the user menu trigger and no permanent Sign out', async ({ page }) => {
  await login(page, 'alex')

  const trigger = userMenuTrigger(page, 'Alex')

  // A. [avatar] Alex trigger, keyboard/menu semantics, no Sign out beside it.
  await expect(trigger).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await expect(trigger.getByText('Alex')).toBeVisible()

  await expect(
    page.getByRole('button', { name: 'Sign out' }),
  ).toHaveCount(0)

  // Personal account destinations no longer live in the sidebar.
  await expect(
    page.getByRole('link', { name: 'Settings' }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('link', { name: 'Profile' }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('link', { name: 'Notifications' }),
  ).toBeVisible()

  // Clicking the trigger opens the menu (and does not navigate).
  await expect(page).toHaveURL('http://127.0.0.1:4173/')
  await trigger.click()

  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')

  // Final order: Profile, Invite, Settings, divider, Sign out.
  const items = menu.getByRole('menuitem')
  await expect(items).toHaveCount(4)
  await expect(items.nth(0)).toContainText('Profile')
  await expect(items.nth(1)).toContainText('Invite to FG Workspace')
  await expect(items.nth(2)).toContainText('Settings')
  await expect(items.nth(3)).toContainText('Sign out')

  await expect(page).toHaveURL('http://127.0.0.1:4173/')
})

test('Profile closes the menu and navigates to /profile', async ({
  page,
}) => {
  await login(page, 'alex')

  await userMenuTrigger(page, 'Alex').click()
  await page.getByRole('menuitem', { name: 'Profile' }).click()

  await expect(page).toHaveURL(/\/profile$/)
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(
    page.getByRole('heading', { name: 'Profile' }),
  ).toBeVisible()
})

test('Invite to FG Workspace opens the existing dialog without navigating', async ({
  page,
}) => {
  await login(page, 'alex')

  const currentUrl = page.url()

  await userMenuTrigger(page, 'Alex').click()
  await page
    .getByRole('menuitem', { name: 'Invite to FG Workspace' })
    .click()

  // The menu closed, the existing invite dialog opened, and the
  // current route did not change.
  await expect(page.getByRole('menu')).toHaveCount(0)

  const dialog = page.getByRole('dialog', {
    name: 'Invite to FG Workspace',
  })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Email')).toBeVisible()
  await expect(page).toHaveURL(currentUrl)

  // Closing the dialog returns the user to the page they were on.
  await dialog.getByRole('button', { name: 'Close dialog' }).click()
  await expect(
    page.getByRole('dialog', { name: 'Invite to FG Workspace' }),
  ).toHaveCount(0)
  await expect(page).toHaveURL(currentUrl)
})

test('Settings navigates to /settings/appearance', async ({ page }) => {
  await login(page, 'alex')

  await userMenuTrigger(page, 'Alex').click()
  await page.getByRole('menuitem', { name: 'Settings' }).click()

  // The menu closed and the Appearance section is the URL.
  await expect(page).toHaveURL(/\/settings\/appearance$/)
  await expect(page.getByRole('menu')).toHaveCount(0)
})

test('Sign out ends the session and reaches the login state', async ({
  page,
}) => {
  await login(page, 'alex')

  // Sign out from an authenticated page.
  await page.getByRole('link', { name: /Projects/ }).click()
  await expect(page).toHaveURL(/\/projects\?group=\d+$/)

  await userMenuTrigger(page, 'Alex').click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()

  // The authenticated shell disappears and the login form is reached.
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByLabel('Username')).toBeVisible()
  await expect(userMenuTrigger(page, 'Alex')).toHaveCount(0)
})
