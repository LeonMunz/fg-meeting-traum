import {
  expect,
  test,
} from '@playwright/test'

// Seeded E2E credentials (see settings_e2e reset seed); they must never
// appear in the product UI itself.
const SEED_USER = 'alex'
const SEED_PASSWORD = 'DevPass1!'

test('renders the reduced auth page unauthenticated', async ({
  page,
}) => {
  await page.goto('/login')

  await expect(
    page.getByRole('heading', { name: 'Sign in' }),
  ).toBeVisible()
  await expect(page.getByText('FG Workspace')).toBeVisible()
  await expect(page.getByText('Research OS')).toBeVisible()
  await expect(page.getByLabel('Username')).toBeVisible()
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible()

  // No development credentials or example values in the product UI.
  await expect(page.getByText('DevPass1!')).toHaveCount(0)
  await expect(
    page.getByText('Development credentials'),
  ).toHaveCount(0)
  await expect(
    page.getByPlaceholder('e.g. alex'),
  ).toHaveCount(0)
  await expect(page.getByText('e.g. alex')).toHaveCount(0)
})

test('logs in and keeps the session across a reload', async ({
  page,
}) => {
  await page.goto('/login')

  await page.getByLabel('Username').fill(SEED_USER)
  await page.getByLabel('Password', { exact: true }).fill(SEED_PASSWORD)
  await page
    .getByRole('button', { name: 'Sign in' })
    .click()

  await expect(
    page.getByRole('button', { name: 'Sign out' }),
  ).toBeVisible()

  // Session persistence: a reload still resolves the server session.
  await page.reload()
  await expect(
    page.getByRole('button', { name: 'Sign out' }),
  ).toBeVisible()
})

test('renders the canonical inline error for incorrect credentials', async ({
  page,
}) => {
  await page.goto('/login')

  await page.getByLabel('Username').fill(SEED_USER)
  await page.getByLabel('Password', { exact: true }).fill('not-the-seed-password')
  await page
    .getByRole('button', { name: 'Sign in' })
    .click()

  await expect(
    page.getByText('The username or password is incorrect.'),
  ).toBeVisible()

  // Still unauthenticated on the login page.
  await expect(page.getByLabel('Username')).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Sign out' }),
  ).toHaveCount(0)
})
