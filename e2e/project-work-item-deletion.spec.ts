import {
  expect,
  type Page,
  test,
} from '@playwright/test'

import {
  login,
  openProject,
  openProjects,
} from './helpers'

// Each test recreates its project, and the E2E DB is only reset between
// runs. Per-test project/Work Item names keep every locator unambiguous
// even when a previous test's project is still present in the list.
const projectLabel = (suffix: string) => `E2E Deletion ${suffix} Project`
const taskTitle = (suffix: string) => `E2E Deletable ${suffix} Task`

const inspectorRegion = (page: Page) =>
  page.getByRole('region', { name: 'Work item', exact: true })

async function createProject(
  page: Page,
  name: string,
) {
  await page
    .getByRole('button', { name: /New project/ })
    .click()

  const dialog = page.getByRole('dialog', {
    name: 'Create project',
  })

  await expect(dialog).toBeVisible()

  await dialog.getByLabel('Project name').fill(name)

  await dialog
    .getByRole('button', { name: /Create project/ })
    .click()

  await expect(
    page.getByText(name, { exact: true }),
  ).toBeVisible()

  await openProject(page, name)
}

async function createWorkItem(
  page: Page,
  title: string,
) {
  await page
    .getByRole('button', { name: /New work item/ })
    .click()

  const dialog = page.getByRole('dialog', {
    name: 'New work item',
  })

  await expect(dialog).toBeVisible()

  await dialog.getByLabel('Title').fill(title)

  await dialog
    .getByRole('button', { name: /Create work item/ })
    .click()

  await expect(dialog).not.toBeVisible()
}

const openButton = (page: Page, title: string) =>
  page.getByRole('button', { name: `Open ${title}`, exact: true })

const deleteDialog = (page: Page) =>
  page.getByRole('dialog', { name: 'Delete work item?' })

async function requestDelete(page: Page) {
  await page
    .getByRole('button', { name: 'Work item actions' })
    .click()

  await page
    .getByRole('menuitem', { name: 'Delete work item' })
    .click()
}

test('Work Item can be deleted from the drawer action menu', async ({
  page,
}) => {
  const title = taskTitle('Drawer')

  await login(page, 'alex')
  await openProjects(page)
  await createProject(page, projectLabel('Drawer'))
  await createWorkItem(page, title)

  // 1. Open the Work Item inspector from the Board card.
  await openButton(page, title).click()

  const inspector = inspectorRegion(page)
  await expect(inspector).toBeVisible()

  // The drawer header's own trigger is distinct from the (also visible)
  // Board card's trigger, so scope to the inspector region.
  const drawerActions = inspector.getByRole('button', {
    name: 'Work item actions',
  })

  // 2. Open the Work item actions menu (drawer header) -> Cancel.
  await drawerActions.click()
  await page
    .getByRole('menuitem', { name: 'Delete work item' })
    .click()

  await expect(deleteDialog(page)).toBeVisible()
  await deleteDialog(page)
    .getByRole('button', { name: /Cancel/ })
    .click()
  await expect(deleteDialog(page)).not.toBeVisible()

  // 3. The Work Item still exists: drawer open and card still present.
  await expect(inspector).toBeVisible()
  await expect(openButton(page, title)).toBeVisible()

  // 4. Delete again and confirm.
  await drawerActions.click()
  await page
    .getByRole('menuitem', { name: 'Delete work item' })
    .click()

  await expect(deleteDialog(page)).toBeVisible()
  await deleteDialog(page)
    .getByRole('button', { name: /^Delete work item$/ })
    .click()

  // 5. The drawer closes and the item disappears from the view.
  await expect(deleteDialog(page)).not.toBeVisible()
  await expect(inspector).not.toBeVisible()
  await expect(openButton(page, title)).not.toBeVisible()
  await expect(page.getByText(title, { exact: true })).toHaveCount(0)
})

test('Work Item can be deleted from a Board card without opening the drawer', async ({
  page,
}) => {
  const title = taskTitle('Board')

  await login(page, 'alex')
  await openProjects(page)
  await createProject(page, projectLabel('Board'))
  await createWorkItem(page, title)

  const card = openButton(page, title)
  await expect(card).toBeVisible()

  // Opening the card's menu must NOT open the drawer.
  await requestDelete(page)
  await expect(inspectorRegion(page)).not.toBeVisible()

  // Delete -> Cancel keeps the card.
  await expect(deleteDialog(page)).toBeVisible()
  await deleteDialog(page)
    .getByRole('button', { name: /Cancel/ })
    .click()
  await expect(deleteDialog(page)).not.toBeVisible()
  await expect(card).toBeVisible()

  // Open the menu again and confirm.
  await requestDelete(page)
  await expect(inspectorRegion(page)).not.toBeVisible()
  await expect(deleteDialog(page)).toBeVisible()
  await deleteDialog(page)
    .getByRole('button', { name: /^Delete work item$/ })
    .click()

  // The card disappears; the drawer never opened.
  await expect(deleteDialog(page)).not.toBeVisible()
  await expect(card).not.toBeVisible()
  await expect(page.getByText(title, { exact: true })).toHaveCount(0)
  await expect(inspectorRegion(page)).not.toBeVisible()
})

test('Work Item can be deleted from a List row without opening the drawer', async ({
  page,
}) => {
  const title = taskTitle('List')

  await login(page, 'alex')
  await openProjects(page)
  await createProject(page, projectLabel('List'))
  await createWorkItem(page, title)

  // Switch to List view (exact match avoids the /List/ ambiguity).
  await page
    .getByRole('button', { name: /^List$/ })
    .click()

  const row = openButton(page, title)
  await expect(row).toBeVisible()

  // Opening the row's menu must NOT open the drawer.
  await requestDelete(page)
  await expect(inspectorRegion(page)).not.toBeVisible()

  // Confirm deletion.
  await expect(deleteDialog(page)).toBeVisible()
  await deleteDialog(page)
    .getByRole('button', { name: /^Delete work item$/ })
    .click()

  // The row disappears; the drawer never opened.
  await expect(deleteDialog(page)).not.toBeVisible()
  await expect(row).not.toBeVisible()
  await expect(page.getByText(title, { exact: true })).toHaveCount(0)
  await expect(inspectorRegion(page)).not.toBeVisible()
})
