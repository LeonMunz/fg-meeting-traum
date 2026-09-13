import { expect, test } from '@playwright/test'

import { PASSWORD, login } from './helpers'

const INVITED_EMAIL = 'chris@example.com'

/**
 * Create an invitation through the normal Invitations UI (Settings)
 * for an email that already belongs to an existing fixture account,
 * and return the one-time registration link shown after creation.
 */
async function createInvitationForExistingAccount(
  page: import('@playwright/test').Page,
  email: string,
): Promise<string> {
  await login(page, 'alex')

  await page.getByRole('link', { name: 'Settings' }).click()

  await expect(
    page.getByRole('heading', { name: 'Invitations', exact: true }),
  ).toBeVisible()

  await page.getByLabel('Email address').fill(email)
  await page.getByRole('button', { name: 'Create invitation' }).click()

  await expect(
    invitationRows(page, email, 'Pending'),
  ).toHaveCount(1)

  const panel = page
    .getByRole('status')
    .filter({ hasText: `Invitation created for ${email}.` })
  await expect(panel).toBeVisible()

  const link = (await panel.locator('code').textContent())?.trim() ?? ''
  expect(link).toContain('/register?token=')
  return link
}

/**
 * The invitation list intentionally preserves terminal history for the
 * same email, so row assertions are scoped by email AND current status —
 * never by row position.
 */
function invitationRows(
  page: import('@playwright/test').Page,
  email: string,
  status: 'Pending' | 'Accepted',
) {
  return page
    .getByRole('listitem')
    .filter({ hasText: email })
    .filter({ hasText: status })
}

test('an existing account redeems its invitation through the registration flow', async ({ browser, page }) => {
  // 1. Alex creates an invitation for an existing fixture account
  //    (chris) through the normal Invitations UI.
  const link = await createInvitationForExistingAccount(page, INVITED_EMAIL)

  // 2. A fresh, unauthenticated browser context opens the link.
  const context = await browser.newContext()
  const invitePage = await context.newPage()
  await invitePage.goto(link)

  // 3. The flow recognizes that an account already exists and shows the
  //    invited email — without any new-account registration fields.
  await expect(
    invitePage.getByText('An account already exists for this email.'),
  ).toBeVisible()
  await expect(
    invitePage.getByText(INVITED_EMAIL, { exact: true }),
  ).toBeVisible()
  await expect(
    invitePage.getByRole('button', { name: 'Create account' }),
  ).toHaveCount(0)
  await expect(invitePage.getByLabel('Confirm password')).toHaveCount(0)

  // The raw token is removed from the visible URL and never rendered.
  expect(new URL(invitePage.url()).searchParams.get('token')).toBeNull()
  const token = new URL(link).searchParams.get('token')
  await expect(invitePage.getByText(token!)).toHaveCount(0)

  // 4. Sign in as the invited existing account inside the flow.
  await invitePage.getByLabel('Username').fill('chris')
  await invitePage.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await invitePage.getByRole('button', { name: 'Sign in' }).click()

  // 5. The authenticated identity is shown and an explicit accept action
  //    is offered — but nothing is accepted automatically.
  await expect(invitePage.getByText(/You are signed in as/)).toBeVisible()
  await expect(
    invitePage.getByRole('button', { name: 'Accept invitation' }),
  ).toBeVisible()
  await expect(
    invitationRows(page, INVITED_EMAIL, 'Pending'),
  ).toHaveCount(1)

  // 6. The explicit accept action consumes the invitation.
  await invitePage.getByRole('button', { name: 'Accept invitation' }).click()
  await expect(invitePage.getByRole('status')).toContainText(
    'Your invitation has been accepted.',
  )

  // 7. The normal authenticated application can be entered.
  await invitePage
    .getByRole('button', { name: 'Continue to workspace' })
    .click()
  await expect(invitePage).toHaveURL('http://127.0.0.1:4173/')
  await expect(invitePage.getByRole('button', { name: 'Sign out' })).toBeVisible()
  const meResp = await invitePage.evaluate(async () => {
    const res = await fetch('/api/auth/me/', { credentials: 'same-origin' })
    return { status: res.status, data: await res.json() }
  })
  expect(meResp.status).toBe(200)
  expect(meResp.data.username).toBe('chris')
  expect(meResp.data.email).toBe(INVITED_EMAIL)

  // 8. The invitation is Accepted for the inviter.
  await page.reload()
  await expect(
    invitationRows(page, INVITED_EMAIL, 'Pending'),
  ).toHaveCount(0)
  await expect(
    invitationRows(page, INVITED_EMAIL, 'Accepted'),
  ).toHaveCount(1)

  // 9. Reusing the same link no longer permits redemption.
  const reused = await context.newPage()
  await reused.goto(link)
  await expect(
    reused.getByText('This invitation has already been used.'),
  ).toBeVisible()
  await expect(reused.getByRole('button', { name: 'Sign in' })).toHaveCount(0)
  await expect(reused.getByRole('button', { name: 'Accept invitation' })).toHaveCount(0)
  await expect(reused.getByLabel('Username')).toHaveCount(0)

  await context.close()
})

test('the wrong authenticated account cannot accept, and switching accounts works', async ({ browser, page }) => {
  // 1. Alex creates an invitation for chris@example.com.
  const link = await createInvitationForExistingAccount(page, INVITED_EMAIL)

  const context = await browser.newContext()
  const invitePage = await context.newPage()
  await invitePage.goto(link)
  await expect(
    invitePage.getByText('An account already exists for this email.'),
  ).toBeVisible()

  // 2. A different existing account (maria) signs in inside the flow.
  await invitePage.getByLabel('Username').fill('maria')
  await invitePage.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await invitePage.getByRole('button', { name: 'Sign in' }).click()

  // 3. The mismatch is explained and no accept control is offered.
  await expect(invitePage.getByRole('alert')).toContainText(
    /different account/i,
  )
  await expect(invitePage.getByRole('alert')).toContainText(
    'maria@example.com',
  )
  await expect(
    invitePage.getByRole('button', { name: 'Accept invitation' }),
  ).toHaveCount(0)
  await expect(invitePage.getByLabel('Username')).toHaveCount(0)

  // Acceptance did not happen: the new invitation is still pending, and
  // the historical Accepted row from the previous test remains unchanged.
  await expect(
    invitationRows(page, INVITED_EMAIL, 'Pending'),
  ).toHaveCount(1)
  await expect(
    invitationRows(page, INVITED_EMAIL, 'Accepted'),
  ).toHaveCount(1)

  // 4. Switch accounts without reloading the page: the invitation flow
  //    (and its in-memory token) is preserved.
  await invitePage
    .getByRole('button', { name: 'Sign out and use another account' })
    .click()
  await expect(invitePage).toHaveURL(/\/register$/)
  expect(new URL(invitePage.url()).searchParams.get('token')).toBeNull()
  await expect(
    invitePage.getByText('An account already exists for this email.'),
  ).toBeVisible()
  await expect(invitePage.getByLabel('Username')).toBeVisible()

  // 5. The correct account signs in and accepts.
  await invitePage.getByLabel('Username').fill('chris')
  await invitePage.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await invitePage.getByRole('button', { name: 'Sign in' }).click()
  await invitePage.getByRole('button', { name: 'Accept invitation' }).click()
  await expect(invitePage.getByRole('status')).toContainText(
    'Your invitation has been accepted.',
  )

  // The new invitation is Accepted for the inviter, and the historical
  // Accepted row from the previous test is preserved.
  await page.reload()
  await expect(
    invitationRows(page, INVITED_EMAIL, 'Pending'),
  ).toHaveCount(0)
  await expect(
    invitationRows(page, INVITED_EMAIL, 'Accepted'),
  ).toHaveCount(2)

  await context.close()
})
