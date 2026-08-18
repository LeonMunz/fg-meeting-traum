import {
  expect,
  type Page,
} from '@playwright/test'

export const PASSWORD = 'DevPass1!'

export async function login(
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
      name: /Sign in/,
    })
    .click()

  await expect(
    page.getByRole('button', {
      name: /Sign out/,
    }),
  ).toBeVisible()
}

export async function logout(
  page: Page,
) {
  await page
    .getByRole('button', {
      name: /Sign out/,
    })
    .click()

  await expect(
    page.getByLabel('Username'),
  ).toBeVisible()
}

export async function openProjects(
  page: Page,
) {
  await page
    .getByRole('link', {
      name: /Projects/,
    })
    .click()

  await expect(page).toHaveURL(
    /\/projects\?group=\d+$/,
  )
}

export async function openProject(
  page: Page,
  projectName: string,
) {
  const projectLink = page
    .getByRole('link')
    .filter({
      hasText: projectName,
    })

  await expect(projectLink).toBeVisible()
  await projectLink.click()

  await expect(
    page.getByText(
      projectName,
      { exact: true },
    ).first(),
  ).toBeVisible()
}
