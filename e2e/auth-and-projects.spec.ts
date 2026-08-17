import {
  expect,
  test,
  type Page,
} from '@playwright/test'

const PASSWORD = 'DevPass1!'

async function login(
  page: Page,
  username: string,
) {
  await page.goto('/login')

  await page
    .getByLabel('Username')
    .fill(username)

  await page
    .getByLabel('Password')
    .fill(PASSWORD)

  await page
    .getByRole('button', {
      name: 'Sign in',
    })
    .click()

  await expect(
    page.getByRole('button', {
      name: 'Sign out',
    }),
  ).toBeVisible()
}

test(
  'Alex sees only projects he may access',
  async ({ page }) => {
    await login(page, 'alex')

    await page
      .getByRole('link', {
        name: /Projects/,
      })
      .click()

    await expect(page).toHaveURL(
      /\/projects$/,
    )

    await expect(
      page.getByRole('heading', {
        name: 'Projects',
        exact: true,
      }),
    ).toBeVisible()

    await expect(
      page.getByText(
        'Paper XYZ',
        { exact: true },
      ),
    ).toBeVisible()

    await expect(
      page.getByText(
        'Maria Private Project',
        { exact: true },
      ),
    ).toHaveCount(0)
  },
)
