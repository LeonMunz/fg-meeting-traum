import {
  expect,
  test,
} from '@playwright/test'

import { login } from './helpers'

test('settings shell: /settings redirect, section tabs, and back/forward', async ({ page }) => {
  await login(page, 'alex')

  // /settings redirects to the Appearance section.
  await page.goto('/settings')
  await expect(page).toHaveURL(/\/settings\/appearance$/)

  // The sidebar Settings entry lands on /settings/appearance.
  const sidebarSettings = page.getByRole('link', { name: 'Settings' })

  await sidebarSettings.click()

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

  // The sidebar Settings entry is active on this route.
  await expect(sidebarSettings).toHaveClass(/font-semibold/)

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

  // The sidebar Settings entry stays active on this route too.
  await expect(sidebarSettings).toHaveClass(/font-semibold/)

  // Switch back to Appearance: route, active section, and content revert.
  await appearanceTab.click()

  await expect(page).toHaveURL(/\/settings\/appearance$/)
  await expect(appearanceTab).toHaveAttribute('aria-current', 'page')
  await expect(invitationsTab).not.toHaveAttribute('aria-current')
  await expect(appearance).toBeVisible()
  await expect(inviteButton).not.toBeVisible()
  await expect(sidebarSettings).toHaveClass(/font-semibold/)

  // Browser Back/Forward restore route, content, and active state.
  await page.goBack()

  await expect(page).toHaveURL(/\/settings\/invitations$/)
  await expect(invitationsTab).toHaveAttribute('aria-current', 'page')
  await expect(inviteButton).toBeVisible()
  await expect(sidebarSettings).toHaveClass(/font-semibold/)

  await page.goForward()

  await expect(page).toHaveURL(/\/settings\/appearance$/)
  await expect(appearanceTab).toHaveAttribute('aria-current', 'page')
  await expect(appearance).toBeVisible()
  await expect(sidebarSettings).toHaveClass(/font-semibold/)
})
