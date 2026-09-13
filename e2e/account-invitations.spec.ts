import { expect, test } from '@playwright/test'

import { login } from './helpers'

test('an authenticated user manages account invitations through the settings UI', async ({ browser, page }) => {
  // 1. Log in as an existing active account.
  await login(page, 'alex')

  // The one-time link is copied through the UI; allow reading the
  // clipboard back to prove the copy behavior end to end.
  await page.context().grantPermissions(
    ['clipboard-read', 'clipboard-write'],
    { origin: 'http://127.0.0.1:4173' },
  )

  // 2. Navigate through the normal UI to invitation management
  //    (the Invitations section of Settings).
  await page
    .getByRole('link', { name: 'Settings' })
    .click()

  await expect(
    page.getByRole('heading', {
      name: 'Invitations',
      exact: true,
    }),
  ).toBeVisible()

  const suffix = Date.now()
  const firstEmail = `invitee-${suffix}@example.com`
  const secondEmail = `invitee-2-${suffix}@example.com`

  // 3. Create an invitation for a unique email through the form.
  await page
    .getByLabel('Email address')
    .fill(firstEmail)

  await page
    .getByRole('button', { name: 'Create invitation' })
    .click()

  // 4. It appears in the inviter's list as Pending.
  await expect(
    page
      .getByRole('listitem')
      .filter({ hasText: firstEmail }),
  ).toContainText('Pending')

  // 5. The one-time registration link is shown after creation.
  const firstPanel = page
    .getByRole('status')
    .filter({
      hasText: `Invitation created for ${firstEmail}.`,
    })
  await expect(firstPanel).toBeVisible()
  await expect(firstPanel.locator('code')).toBeVisible()

  // 6. Copy the link through the UI and read it back from the clipboard.
  await firstPanel
    .getByRole('button', { name: 'Copy invitation link' })
    .click()

  await expect(
    firstPanel.getByText('Link copied to clipboard.'),
  ).toBeVisible()

  const firstLink = await page.evaluate(() =>
    navigator.clipboard.readText(),
  )
  expect(firstLink).toContain('/register?token=')
  const firstToken = new URL(firstLink).searchParams.get('token')
  expect(firstToken).toBeTruthy()

  // 7. A fresh, unauthenticated browser context opens the link and the
  //    Registration page recognizes the invited email.
  const freshContext = await browser.newContext()
  const freshPage = await freshContext.newPage()

  await freshPage.goto(firstLink)
  await expect(
    freshPage.getByText(firstEmail, { exact: true }),
  ).toBeVisible()
  await expect(
    freshPage.getByRole('button', { name: 'Create account' }),
  ).toBeVisible()

  await freshPage.close()

  // 8. Back in the inviter session: create a second invitation.
  await page
    .getByLabel('Email address')
    .fill(secondEmail)

  await page
    .getByRole('button', { name: 'Create invitation' })
    .click()

  await expect(
    page
      .getByRole('listitem')
      .filter({ hasText: secondEmail }),
  ).toContainText('Pending')

  const secondPanel = page
    .getByRole('status')
    .filter({
      hasText: `Invitation created for ${secondEmail}.`,
    })
  await expect(secondPanel).toBeVisible()

  const secondLink = (
    await secondPanel.locator('code').textContent()
  )?.trim() ?? ''
  expect(secondLink).toContain('/register?token=')

  // 9. Revoke the second (newly created, pending) invitation through
  //    the confirmation dialog.
  await page
    .getByRole('button', {
      name: `Revoke invitation to ${secondEmail}`,
    })
    .click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  await dialog
    .getByRole('button', { name: 'Revoke invitation' })
    .click()

  await expect(dialog).not.toBeVisible()

  // 10. It becomes visibly Revoked and no longer offers revoke.
  await expect(
    page
      .getByRole('listitem')
      .filter({ hasText: secondEmail }),
  ).toContainText('Revoked')

  await expect(
    page.getByRole('button', {
      name: `Revoke invitation to ${secondEmail}`,
    }),
  ).not.toBeVisible()

  // 11. The revoked invitation cannot be used for registration.
  const revokedPage = await freshContext.newPage()
  await revokedPage.goto(secondLink)

  await expect(
    revokedPage.getByText('This invitation is no longer valid.'),
  ).toBeVisible()

  await revokedPage.close()
  await freshContext.close()
})
