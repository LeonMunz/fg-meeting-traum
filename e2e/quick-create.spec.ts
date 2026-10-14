import { expect, test } from '@playwright/test'

import { login, openProject, openProjects } from './helpers'

test('global Quick Create opens the Work Item drawer directly and refreshes My Work', async ({
  page,
}) => {
  const title = `Quick Create ${Date.now()}`
  let createRequests = 0

  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/api\/projects\/\d+\/work-items\/$/.test(request.url())
    ) {
      createRequests += 1
    }
  })

  await login(page, 'alex')
  await page.goto('/my-work')

  const quickCreateTrigger = page.getByRole('button', {
    name: /Quick create/,
  })
  await expect(quickCreateTrigger).toBeVisible()

  const isMac = await page.evaluate(() =>
    /Mac|iPhone|iPad|iPod/i.test(
      navigator.platform || navigator.userAgent,
    ),
  )

  // Mouse path: the + trigger opens the compact Quick Create menu.
  await quickCreateTrigger.click()
  const quickMenu = page.getByRole('menu', { name: 'Quick create' })
  await expect(quickMenu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(quickMenu).not.toBeVisible()

  // Global shortcut: opens the canonical Work Item drawer directly,
  // without showing the menu.
  await page.keyboard.press(isMac ? 'Meta+Alt+K' : 'Control+Alt+K')
  await expect(quickMenu).not.toBeVisible()

  const dialog = page.getByRole('dialog', { name: 'New work item' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Title')).toBeFocused()
  await dialog.getByRole('button', { name: 'Select project' }).click()
  const projectPicker = dialog.getByRole('listbox', { name: 'Projects' })
  await expect(projectPicker).toBeVisible()
  await dialog.getByLabel('Search projects').fill('Paper XYZ')
  await projectPicker.getByRole('option', { name: 'Paper XYZ' }).click()
  await expect(dialog.getByText('Paper XYZ', { exact: true })).toBeVisible()
  await dialog.getByLabel('Title').fill(title)

  await dialog.getByRole('button', { name: 'Add assignee…' }).click()
  const alexRow = dialog.locator('label').filter({ hasText: 'Alex Dev' })
  await alexRow.getByRole('checkbox').check()

  await dialog
    .getByRole('button', { name: 'Create work item' })
    .click()

  await expect(dialog).not.toBeVisible()
  await expect(
    page.getByText('Work item created in Paper XYZ.', { exact: true }),
  ).toBeVisible()
  await expect(page.getByText(title, { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/\/my-work$/)
  expect(createRequests).toBe(1)

  await openProjects(page)
  await openProject(page, 'Paper XYZ')
  await page.getByRole('button', { name: /Quick create/ }).click()
  await page
    .getByRole('menu', { name: 'Quick create' })
    .getByRole('menuitem', { name: /New work item/ })
    .click()

  const projectDialog = page.getByRole('dialog', {
    name: 'New work item',
  })
  await expect(projectDialog).toBeVisible()
  await expect(
    projectDialog.getByText('Paper XYZ', { exact: true }),
  ).toBeVisible()
  await expect(
    projectDialog.getByRole('button', { name: 'Select project' }),
  ).toHaveText(/Paper XYZ/)

  await projectDialog.getByRole('button', { name: 'Cancel' }).click()
  expect(createRequests).toBe(1)
})
