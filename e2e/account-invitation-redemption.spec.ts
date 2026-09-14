import { expect, test } from '@playwright/test'

import { PASSWORD, login } from './helpers'

const INVITED_EMAIL = 'chris@example.com'

interface HistoricalFixture {
  link: string
  invitationId: string
}

/**
 * Create a PRE-EXISTING ("historical") pending invitation for an email
 * that already belongs to a fixture account, and return the one-time
 * registration link plus the invitation ID.
 *
 * The production creation UI/API intentionally rejects existing-account
 * emails (409 account_exists), so the redemption flows are exercised
 * against a historical record — one that predates that guard — instead.
 * The E2E-only fixture endpoint (registered exclusively under the
 * isolated settings_e2e schema) writes that record directly at the
 * domain level: it never goes through the production creation flow and
 * creates no memberships. Production preview / sign-in / accept are
 * still exercised by the browser afterwards.
 *
 * The returned `invitationId` is this test's only claim on the created
 * record: several Accepted invitations for the same existing account are
 * valid history, so no assertion in this spec ever counts rows by
 * email + status.
 */
async function createHistoricalInvitationForExistingAccount(
  page: import('@playwright/test').Page,
  email: string,
): Promise<HistoricalFixture> {
  await login(page, 'alex')

  const created = await page.evaluate(async (invitedEmail) => {
    let csrf = document.cookie
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('csrftoken='))
      ?.split('=')[1]

    if (!csrf) {
      await fetch('/api/auth/csrf/', { credentials: 'same-origin' })
      csrf = document.cookie
        .split(';')
        .map((c) => c.trim())
        .find((c) => c.startsWith('csrftoken='))
        ?.split('=')[1]
    }

    const res = await fetch('/api/e2e/fixture/account-invitation/', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-CSRFToken': csrf ?? '',
      },
      body: JSON.stringify({ invitedEmail }),
    })

    return {
      status: res.status,
      data: await res.json(),
      origin: window.location.origin,
    }
  }, email)

  expect(created.status).toBe(201)
  expect(typeof created.data.id).toBe('string')
  expect(typeof created.data.token).toBe('string')
  // The exact record exists and is PENDING from the moment of creation.
  expect(created.data.status).toBe('pending')

  return {
    link: `${created.origin}/register?token=${encodeURIComponent(created.data.token)}`,
    invitationId: created.data.id,
  }
}

/**
 * Pin the exact invitation record by its ID through the inviter-visible
 * invitation list API (permission-filtered to the inviter's own
 * invitations; the authenticated inviter session is the browser page's).
 *
 * The UI list rows deliberately do not expose the invitation ID, so this
 * read-only API assertion is the deterministic way to verify this test's
 * own fixture without colliding with other historical rows for the same
 * email (e.g. Accepted rows left by another test in the same run).
 */
async function expectInvitationStatus(
  page: import('@playwright/test').Page,
  invitationId: string,
  status: 'pending' | 'accepted',
) {
  await expect
    .poll(async () => {
      const found = await page.evaluate(async (id) => {
        const res = await fetch('/api/account-invitations/', {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        })
        const data = await res.json()
        const row = (data.invitations ?? []).find(
          (i: { id: string }) => i.id === id,
        )
        return row ? (row.status as string) : null
      }, invitationId)
      return found
    })
    .toBe(status)
}

test('an existing account redeems its invitation through the registration flow', async ({ browser, page }) => {
  // 1. A historical pending invitation exists for an existing fixture
  //    account (chris); this test holds its exact invitation ID.
  const { link, invitationId } =
    await createHistoricalInvitationForExistingAccount(
      page,
      INVITED_EMAIL,
    )

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
  //    is offered — but nothing is accepted automatically: the exact
  //    fixture record is still PENDING server-side.
  await expect(invitePage.getByText(/You are signed in as/)).toBeVisible()
  await expect(
    invitePage.getByRole('button', { name: 'Accept invitation' }),
  ).toBeVisible()
  await expectInvitationStatus(page, invitationId, 'pending')

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

  // 8. The exact fixture record is now ACCEPTED for the inviter.
  await expectInvitationStatus(page, invitationId, 'accepted')

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
  // 1. A historical pending invitation for chris@example.com exists —
  //    created by this test itself and pinned by its exact invitation
  //    ID, so earlier tests' Accepted rows for the same email are
  //    irrelevant.
  const { link, invitationId } =
    await createHistoricalInvitationForExistingAccount(
      page,
      INVITED_EMAIL,
    )

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

  // Acceptance did not happen: the exact fixture record is still
  // PENDING (not accepted) server-side.
  await expectInvitationStatus(page, invitationId, 'pending')

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

  // The exact fixture record is now ACCEPTED for the inviter.
  await expectInvitationStatus(page, invitationId, 'accepted')

  await context.close()
})
