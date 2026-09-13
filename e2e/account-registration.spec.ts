import { expect, test } from '@playwright/test'

const PASSWORD = 'DevPass1!'

async function createAccountInvitation(
  page: import('@playwright/test').Page,
  targetEmail: string,
): Promise<string> {
  // Create the invitation through the existing backend API using the
  // browser's own session (invitations have no UI yet). Returns the
  // one-time raw token from the creation response.
  const created = await page.evaluate(
    async (email) => {
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

      const res = await fetch('/api/account-invitations/', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-CSRFToken': csrf ?? '',
        },
        body: JSON.stringify({ targetEmail: email }),
      })

      return { status: res.status, data: await res.json() }
    },
    targetEmail,
  )

  expect(created.status).toBe(201)
  expect(typeof created.data.token).toBe('string')
  return created.data.token
}

test('an invited person registers a new account through the registration page', async ({ page }) => {
  // 1. Authenticate as an existing active user.
  await page.goto('/login')
  await page.getByLabel('Username').fill('alex')
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()

  // 2. Create a global account invitation for a unique email and capture
  //    the one-time raw token.
  const suffix = Date.now()
  const invitedEmail = `invitee-${suffix}@example.com`
  const token = await createAccountInvitation(page, invitedEmail)
  expect(token.length).toBeGreaterThan(0)

  // 3. Log out.
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByLabel('Username')).toBeVisible()

  // 4. Open the registration URL carrying the token.
  const newUsername = `invitee${suffix}`
  await page.goto(`/register?token=${encodeURIComponent(token)}`)

  // 5. The invited email is displayed and is not editable.
  await expect(
    page.getByText(invitedEmail, { exact: true }),
  ).toBeVisible()
  const formInputs = page.locator('form input')
  await expect(formInputs).toHaveCount(3)
  for (const input of await formInputs.all()) {
    await expect(input).not.toHaveValue(invitedEmail)
  }

  // The raw token is never rendered, and it is removed from the visible URL.
  await expect(page.getByText(token)).toHaveCount(0)
  await expect(page).toHaveURL('http://127.0.0.1:4173/register')

  // 6. Choose a username and password and register.
  await page.getByLabel('Username').fill(newUsername)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByLabel('Confirm password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()

  // 7. The browser enters the authenticated application.
  await expect(page).toHaveURL('http://127.0.0.1:4173/')
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()

  // 8. /api/auth/me/ reflects the new account.
  const meResp = await page.evaluate(async () => {
    const res = await fetch('/api/auth/me/', { credentials: 'same-origin' })
    return { status: res.status, data: await res.json() }
  })
  expect(meResp.status).toBe(200)
  expect(meResp.data.username).toBe(newUsername)
  expect(meResp.data.email).toBe(invitedEmail)

  // 9. Reload — the session survives.
  await page.reload()
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()

  // 10. No ResearchGroup (and thus no Project) membership was implicitly
  //     created for the new account.
  const groupsResp = await page.evaluate(async () => {
    const res = await fetch('/api/research-groups/', {
      credentials: 'same-origin',
    })
    return { status: res.status, data: await res.json() }
  })
  expect(groupsResp.status).toBe(200)
  expect(groupsResp.data).toEqual([])
})
