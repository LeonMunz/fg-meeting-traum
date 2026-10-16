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
  await page.keyboard.press(isMac ? 'Meta+Period' : 'Control+Alt+K')
  await expect(quickMenu).not.toBeVisible()

  const dialog = page.getByRole('dialog', { name: 'New work item' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Title')).toBeFocused()

  // Re-pressing the shortcut while the drawer is open (Title
  // focused) is a no-op: no second drawer, no reset of the draft.
  await dialog.getByLabel('Title').fill('Draft before re-press')
  await page.keyboard.press(isMac ? 'Meta+Period' : 'Control+Alt+K')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Title')).toHaveValue(
    'Draft before re-press',
  )

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

  // A different AppShell route: the SAME global shortcut opens the
  // SAME drawer again — still WITHOUT any implicit context from the
  // route.
  await page.keyboard.press(isMac ? 'Meta+Period' : 'Control+Alt+K')
  await expect(dialog).toBeVisible()
  await expect(
    dialog
      .getByRole('combobox', { name: 'Research Group', exact: true })
      .locator('option:checked'),
  ).toHaveText('Select research group…')
  await expect(
    dialog
      .getByRole('combobox', { name: 'Project', exact: true })
      .locator('option:checked'),
  ).toHaveText('Select a Research Group first')
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()

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

test('Project-local New Work Item opens the same create Drawer with the validated source context (editable) and creates exclusively in the selected target Project', async ({
  page,
}) => {
  const titleA = `Quick Create A ${Date.now()}`
  const titleB = `Quick Create B ${Date.now()}`
  const createRequests: string[] = []

  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/api\/projects\/\d+\/work-items\/$/.test(request.url())
    ) {
      createRequests.push(request.url())
    }
  })

  await login(page, 'alex')

  // A second writable Project in the same Research Group: the
  // alternate creation target.
  await openProjects(page)
  await page
    .getByRole('button', { name: /New project/ })
    .click()
  const createProjectDialog = page.getByRole('dialog', {
    name: 'Create project',
  })
  await expect(createProjectDialog).toBeVisible()
  await createProjectDialog
    .getByLabel('Project name')
    .fill('Quick Create B')
  await createProjectDialog
    .getByLabel('Description')
    .fill('Second target Project for the unified create flow.')
  await createProjectDialog
    .getByRole('button', { name: /Create project/ })
    .click()
  await expect(createProjectDialog).not.toBeVisible()

  // Source Project A: the Project-local create entry.
  await openProject(page, 'Paper XYZ')
  const newWorkItemButton = page.getByRole('button', {
    name: /New work item/,
  })
  await expect(newWorkItemButton).toBeVisible()
  await newWorkItemButton.click()

  const dialog = page.getByRole('dialog', { name: 'New work item' })
  await expect(dialog).toBeVisible()
  const researchGroupSelect = dialog.getByRole('combobox', {
    name: 'Research Group',
    exact: true,
  })
  const projectSelect = dialog.getByRole('combobox', {
    name: 'Project',
    exact: true,
  })

  // The source Project's ACTUAL Research Group and Project are
  // preselected after their eligibility has been validated — and
  // both selectors remain editable.
  await expect(researchGroupSelect).toBeEnabled()
  await expect(
    researchGroupSelect.locator('option:checked'),
  ).toHaveText('FG Example')
  await expect(projectSelect).toBeEnabled()
  await expect(
    projectSelect.locator('option:checked'),
  ).toHaveText('Paper XYZ')

  // Creation stays locked while the required Title is empty — it
  // becomes available once the validated source context and a valid
  // Title both exist (creation without touching the selectors
  // targets the source Project).
  await expect(
    dialog.getByRole('button', { name: 'Create work item' }),
  ).toBeDisabled()
  await dialog.getByLabel('Title').fill(titleA)
  await expect(
    dialog.getByRole('button', { name: 'Create work item' }),
  ).toBeEnabled()
  await dialog
    .getByRole('button', { name: 'Create work item' })
    .click()

  await expect(dialog).not.toBeVisible()
  await expect(
    page.getByText('Work item created in Paper XYZ.', {
      exact: true,
    }),
  ).toBeVisible()
  expect(createRequests).toHaveLength(1)

  // The source Project view refreshes — it actually owns the item.
  await expect(page.getByText(titleA, { exact: true })).toBeVisible()

  // A second launch from the same Project prefills the SAME
  // validated context again.
  await newWorkItemButton.click()
  await expect(dialog).toBeVisible()
  await expect(
    researchGroupSelect.locator('option:checked'),
  ).toHaveText('FG Example')
  await expect(
    projectSelect.locator('option:checked'),
  ).toHaveText('Paper XYZ')

  // Switching the target to Project B reloads its canonical
  // configuration; creation becomes available once B's context is
  // loaded and the required Title is entered.
  await projectSelect.selectOption({ label: 'Quick Create B' })
  await expect(
    projectSelect.locator('option:checked'),
  ).toHaveText('Quick Create B')
  await dialog.getByLabel('Title').fill(titleB)
  await expect(
    dialog.getByRole('button', { name: 'Create work item' }),
  ).toBeEnabled()
  await dialog
    .getByRole('button', { name: 'Create work item' })
    .click()

  await expect(dialog).not.toBeVisible()
  await expect(
    page.getByText('Work item created in Quick Create B.', {
      exact: true,
    }),
  ).toBeVisible()
  expect(createRequests).toHaveLength(2)

  // The second creation went to the SELECTED target (Project B),
  // never to the source Project A — and the source Project view
  // is not refreshed with a foreign Work Item.
  await expect(page.getByText(titleB, { exact: true })).toHaveCount(0)

  // Project B's page shows the created Work Item.
  await openProjects(page)
  await openProject(page, 'Quick Create B')
  await expect(page.getByText(titleB, { exact: true })).toBeVisible()

  const targetMatch = /\/projects\/(\d+)\/work-items/.exec(page.url())
  expect(targetMatch).not.toBeNull()
  const targetProjectId = targetMatch![1]
  expect(
    new RegExp(
      `api/projects/${targetProjectId}/work-items/$`,
    ).test(createRequests[1]),
  ).toBe(true)
  expect(
    new RegExp(
      `api/projects/${targetProjectId}/work-items/$`,
    ).test(createRequests[0]),
  ).toBe(false)
})
