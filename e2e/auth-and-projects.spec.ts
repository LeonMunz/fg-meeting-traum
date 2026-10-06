import {
  expect,
  test,
  type Page,
} from '@playwright/test'

import { displayNameFor, openGroupProjects, userMenuTrigger } from './helpers'

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
    .getByLabel('Password', { exact: true })
    .fill(PASSWORD)

  await page
    .getByRole('button', {
      name: 'Sign in',
    })
    .click()

  await expect(
    userMenuTrigger(page, displayNameFor(username)),
  ).toBeVisible()
}

test(
  'Alex sees only projects he may access',
  async ({ page }) => {
    await login(page, 'alex')

    await openGroupProjects(page, 'FG Example')

    await expect(page).toHaveURL(
      /\/projects\?group=\d+$/,
    )

    await expect(
      page.getByRole('heading', {
        name: 'Projects',
        exact: true,
      }),
    ).toBeVisible()

    // Scoped to the Projects content surface (the record-title
    // heading of each list row): the global Quick Access Sidebar
    // may carry a legitimate shortcut for the same projects,
    // independently of this authorization surface.
    await expect(
      page.getByRole('heading', {
        name: 'Paper XYZ',
        exact: true,
      }),
    ).toBeVisible()

    await expect(
      page.getByRole('heading', {
        name: 'Maria Private Project',
        exact: true,
      }),
    ).toHaveCount(0)
  },
)
