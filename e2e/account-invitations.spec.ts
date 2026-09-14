import { expect, test } from '@playwright/test'

import { login, userMenuTrigger } from './helpers'

/**
 * Read the exact invitation records for one normalized email through
 * the authenticated inviter's own invitation list API
 * (permission-filtered to the inviter's invitations; the
 * authenticated inviter session is the browser page's). Returns a
 * stable, order-independent `[{ id, status }]` list.
 *
 * The UI list rows intentionally do not expose the invitation ID, so
 * this read-only API read is the deterministic way to pin pre-/post-
 * attempt identity by stable ID — without relying on UI row counts,
 * which may include historical Accepted/terminal rows from other
 * tests in the same run.
 */
async function invitationRowsFor(
  page: import('@playwright/test').Page,
  invitedEmail: string,
): Promise<{ id: string; status: string }[]> {
  const rows = await page.evaluate(
    async (email: string): Promise<{ id: string; status: string }[]> => {
      const res = await fetch('/api/account-invitations/', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      })
      const data = await res.json()
      return (data.invitations ?? [])
        .filter(
          (i: { invitedEmail: string }) =>
            i.invitedEmail === email,
        )
        .map((i: { id: string; status: string }) => ({
          id: i.id,
          status: i.status,
        }))
    },
    invitedEmail,
  )

  return rows.sort((a, b) => a.id.localeCompare(b.id))
}

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
  //    (Settings opens on Appearance; Invitations is a Settings tab).
  //    Settings lives in the user menu, not the sidebar.
  await userMenuTrigger(page, 'Alex').click()
  await page
    .getByRole('menuitem', { name: 'Settings' })
    .click()

  await expect(page).toHaveURL(/\/settings\/appearance$/)

  await page
    .getByRole('link', { name: 'Invitations' })
    .click()

  await expect(page).toHaveURL(/\/settings\/invitations$/)

  await expect(
    page.getByRole('heading', {
      name: 'Invitations',
      exact: true,
    }),
  ).toBeVisible()

  const suffix = Date.now()
  const firstEmail = `invitee-${suffix}@example.com`
  const secondEmail = `invitee-2-${suffix}@example.com`

  const dialog = page.getByRole('dialog')

  // 3. Open the reusable invite dialog and create the first
  //    invitation for a unique email.
  await page
    .getByRole('button', { name: 'Invite person' })
    .click()

  await expect(dialog).toBeVisible()
  await expect(
    dialog.getByRole('heading', {
      name: 'Invite to FG Workspace',
    }),
  ).toBeVisible()

  await dialog
    .getByLabel('Email', { exact: true })
    .fill(firstEmail)

  await dialog
    .getByRole('button', { name: 'Send invitation' })
    .click()

  // 4. Success state: the invited email and the one-time registration
  //    link are shown in the dialog, which does not close
  //    automatically.
  await expect(
    dialog.getByText('Invitation created'),
  ).toBeVisible()
  await expect(
    dialog.getByText(firstEmail, { exact: true }),
  ).toBeVisible()
  await expect(dialog.locator('code')).toBeVisible()

  const firstLink = (
    await dialog.locator('code').textContent()
  )?.trim() ?? ''
  expect(firstLink).toContain('/register?token=')
  const firstToken = new URL(firstLink).searchParams.get('token')
  expect(firstToken).toBeTruthy()

  // 5. Copy the link through the dialog and read it back from the
  //    clipboard.
  await dialog.getByRole('button', { name: 'Copy', exact: true }).click()

  await expect(
    dialog.getByText('Link copied to clipboard.'),
  ).toBeVisible()

  const firstClipboard = await page.evaluate(() =>
    navigator.clipboard.readText(),
  )
  expect(firstClipboard).toContain('/register?token=')

  // 6. A fresh, unauthenticated browser context opens the link and the
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

  // 7. Close the dialog; the created invitation appears under
  //    Pending.
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).not.toBeVisible()

  await expect(
    page
      .getByRole('listitem')
      .filter({ hasText: firstEmail }),
  ).toContainText('Pending')

  // 8. Reopen the dialog: the form is fresh and clean.
  await page
    .getByRole('button', { name: 'Invite person' })
    .click()

  await expect(dialog).toBeVisible()
  await expect(
    dialog.getByLabel('Email', { exact: true }),
  ).toHaveValue('')

  // 9. Create a second invitation through the reopened dialog.
  await dialog
    .getByLabel('Email', { exact: true })
    .fill(secondEmail)

  await dialog
    .getByRole('button', { name: 'Send invitation' })
    .click()

  await expect(
    dialog.getByText('Invitation created'),
  ).toBeVisible()

  const secondLink = (
    await dialog.locator('code').textContent()
  )?.trim() ?? ''
  expect(secondLink).toContain('/register?token=')

  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).not.toBeVisible()

  await expect(
    page
      .getByRole('listitem')
      .filter({ hasText: secondEmail }),
  ).toContainText('Pending')

  // 10. Revoke the second (newly created, pending) invitation through
  //     the confirmation dialog.
  await page
    .getByRole('button', {
      name: `Revoke invitation to ${secondEmail}`,
    })
    .click()

  await expect(dialog).toBeVisible()

  await dialog
    .getByRole('button', { name: 'Revoke invitation' })
    .click()

  await expect(dialog).not.toBeVisible()

  // 11. It becomes visibly Revoked and no longer offers revoke.
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

  // 12. The revoked invitation cannot be used for registration.
  const revokedPage = await freshContext.newPage()
  await revokedPage.goto(secondLink)

  await expect(
    revokedPage.getByText('This invitation is no longer valid.'),
  ).toBeVisible()

  await revokedPage.close()
  await freshContext.close()

  // 13. Inviting an email that already has an FG Workspace account
  //     shows the account_exists message in the dialog. The inviter's
  //     list may already contain historical invitations for that
  //     account (e.g. Accepted rows left by the existing-account
  //     redemption flow earlier in the same run), so the pre-attempt
  //     records are pinned by exact ID through the authenticated
  //     inviter API instead of assuming an empty list.
  const chrisEmail = 'chris@example.com'
  const chrisBefore = await invitationRowsFor(page, chrisEmail)

  await page
    .getByRole('button', { name: 'Invite person' })
    .click()

  await expect(dialog).toBeVisible()

  await dialog
    .getByLabel('Email', { exact: true })
    .fill(chrisEmail)

  await dialog
    .getByRole('button', { name: 'Send invitation' })
    .click()

  await expect(
    dialog.getByText('This person already has an FG Workspace account.'),
  ).toBeVisible()

  // The dialog stays open and retains the entered email.
  await expect(
    dialog.getByLabel('Email', { exact: true }),
  ).toHaveValue(chrisEmail)
  await expect(
    dialog.getByText('Invitation created'),
  ).not.toBeVisible()

  // The rejected creation adds no invitation and mutates none: the
  // exact pre-attempt record set (zero, one, or many historical
  // records) is unchanged by ID and status.
  expect(await invitationRowsFor(page, chrisEmail)).toEqual(chrisBefore)

  // 14. Creating another pending invitation for a non-account email
  //     that already has one shows the pending_invitation_exists
  //     message in the dialog and creates no additional invitation —
  //     pinned by exact ID the same way.
  const firstBefore = await invitationRowsFor(page, firstEmail)

  await dialog
    .getByLabel('Email', { exact: true })
    .fill(firstEmail)

  await dialog
    .getByRole('button', { name: 'Send invitation' })
    .click()

  await expect(
    dialog.getByText(
      'An invitation for this email address is already pending.',
    ),
  ).toBeVisible()
  await expect(
    dialog.getByLabel('Email', { exact: true }),
  ).toHaveValue(firstEmail)

  // The existing pending invitation and its record are left
  // completely unchanged.
  expect(await invitationRowsFor(page, firstEmail)).toEqual(firstBefore)

  // 15. Close the dialog; no new invitation was created by the
  //     rejected attempts.
  await dialog
    .getByRole('button', { name: 'Close dialog' })
    .click()

  await expect(dialog).not.toBeVisible()
})
