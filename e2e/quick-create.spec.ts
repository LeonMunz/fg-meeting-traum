import { expect, test } from '@playwright/test'

import { login, openProject, openProjects } from './helpers'

test('global Quick Create opens the Work Item drawer with explicit Research Group + Project selection and refreshes My Work', async ({
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

  // Global creation starts WITHOUT any implicit context: both
  // selectors are unselected and the Project control is dependent
  // on the Research Group choice.
  const researchGroupSelect = dialog.getByRole('combobox', {
    name: 'Research Group',
    exact: true,
  })
  const projectSelect = dialog.getByRole('combobox', {
    name: 'Project',
    exact: true,
  })
  await expect(researchGroupSelect).toBeEnabled()
  await expect(
    researchGroupSelect.locator('option:checked'),
  ).toHaveText('Select research group…')
  await expect(projectSelect).toBeDisabled()
  await expect(projectSelect.locator('option:checked')).toHaveText(
    'Select a Research Group first',
  )
  // Creation is impossible before a valid context exists.
  await expect(
    dialog.getByRole('button', { name: 'Create work item' }),
  ).toBeDisabled()

  // Explicit Research Group selection exposes only that group's
  // writable Projects — and never preselects one of them.
  await researchGroupSelect.selectOption({ label: 'FG Example' })
  await expect(projectSelect).toBeEnabled()
  await expect(projectSelect.locator('option:checked')).toHaveText(
    'Select project…',
  )
  await expect(
    projectSelect.locator('option', { hasText: 'Paper XYZ' }),
  ).toHaveCount(1)

  await projectSelect.selectOption({ label: 'Paper XYZ' })
  await expect(projectSelect.locator('option:checked')).toHaveText(
    'Paper XYZ',
  )
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

  // Opening the same global Quick Create from a writable Project
  // route still starts WITHOUT preselection (no implicit context
  // from the route).
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
    projectDialog
      .getByRole('combobox', { name: 'Research Group', exact: true })
      .locator('option:checked'),
  ).toHaveText('Select research group…')
  await expect(
    projectDialog
      .getByRole('combobox', { name: 'Project', exact: true })
      .locator('option:checked'),
  ).toHaveText('Select a Research Group first')
  await expect(
    projectDialog.getByRole('button', { name: 'Create work item' }),
  ).toBeDisabled()

  await projectDialog.getByRole('button', { name: 'Cancel' }).click()
  expect(createRequests).toBe(1)
})
