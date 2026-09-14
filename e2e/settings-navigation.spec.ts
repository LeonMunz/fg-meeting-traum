import {
  expect,
  test,
} from '@playwright/test'

import { login, userMenuTrigger } from './helpers'

test('settings shell: /settings redirect, section tabs, and back/forward', async ({ page }) => {
  await login(page, 'alex')

  // /settings redirects to the Appearance section.
  await page.goto('/settings')
  await expect(page).toHaveURL(/\/settings\/appearance$/)

  // Settings is reachable from the user menu (no longer in the
  // sidebar), and it lands on /settings/appearance.
  await expect(
    page.getByRole('link', { name: 'Settings' }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('link', { name: 'Profile' }),
  ).toHaveCount(0)

  await userMenuTrigger(page, 'Alex').click()
  await page.getByRole('menuitem', { name: 'Settings' }).click()

  await expect(page).toHaveURL(/\/settings\/appearance$/)

  const nav = page.getByRole('navigation', { name: 'Settings' })
  const appearanceTab = nav.getByRole('link', { name: 'Appearance' })
  const invitationsTab = nav.getByRole('link', { name: 'Invitations' })

  // Appearance is the active section and the page shows Appearance only.
  await expect(appearanceTab).toHaveAttribute('aria-current', 'page')
  await expect(invitationsTab).not.toHaveAttribute('aria-current')

  const appearance = page.getByRole('radiogroup', { name: 'Appearance' })
  await expect(appearance).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Invitations', exact: true }),
  ).not.toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Invite person' }),
  ).not.toBeVisible()


  // Switch to Invitations: URL, active section, and content update.
  await invitationsTab.click()

  await expect(page).toHaveURL(/\/settings\/invitations$/)
  await expect(invitationsTab).toHaveAttribute('aria-current', 'page')
  await expect(appearanceTab).not.toHaveAttribute('aria-current')

  const inviteButton = page.getByRole('button', { name: 'Invite person' })
  await expect(inviteButton).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Invitations', exact: true }),
  ).toBeVisible()
  await expect(appearance).not.toBeVisible()


  // Switch back to Appearance: route, active section, and content revert.
  await appearanceTab.click()

  await expect(page).toHaveURL(/\/settings\/appearance$/)
  await expect(appearanceTab).toHaveAttribute('aria-current', 'page')
  await expect(invitationsTab).not.toHaveAttribute('aria-current')
  await expect(appearance).toBeVisible()
  await expect(inviteButton).not.toBeVisible()

  // Browser Back/Forward restore route, content, and active state.
  await page.goBack()

  await expect(page).toHaveURL(/\/settings\/invitations$/)
  await expect(invitationsTab).toHaveAttribute('aria-current', 'page')
  await expect(inviteButton).toBeVisible()

  await page.goForward()

  await expect(page).toHaveURL(/\/settings\/appearance$/)
  await expect(appearanceTab).toHaveAttribute('aria-current', 'page')
  await expect(appearance).toBeVisible()
})
