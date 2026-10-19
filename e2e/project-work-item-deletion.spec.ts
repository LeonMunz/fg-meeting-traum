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

test('Board card menu is keyboard-operable: Enter/Space open ONLY the menu, keyboard Delete opens the dialog', async ({
  page,
}) => {
  const title = taskTitle('Keyboard')

  await login(page, 'alex')
  await openProjects(page)
  await createProject(page, projectLabel('Keyboard'))
  await createWorkItem(page, title)

  const card = openButton(page, title)
  await expect(card).toBeVisible()

  // The REAL three-dot trigger, keyboard only: focus + Enter.
  const trigger = card.getByRole('button', {
    name: 'Work item actions',
  })
  await trigger.focus()
  await expect(trigger).toBeFocused()
  await page.keyboard.press('Enter')

  // The menu opens from the keyboard activation…
  await expect(
    page.getByRole('menuitem', { name: 'Delete work item' }),
  ).toBeVisible()

  // …and the drawer did NOT open (the regression: the Enter
  // keydown used to bubble through the card and open it too).
  await expect(inspectorRegion(page)).not.toBeVisible()
  await expect(card).toBeVisible()

  // Escape closes the menu again (the keyboard close path).
  await page.keyboard.press('Escape')
  await expect(
    page.getByRole('menuitem', { name: 'Delete work item' }),
  ).not.toBeVisible()
  await expect(inspectorRegion(page)).not.toBeVisible()

  // Space on the focused trigger opens the menu as well (native
  // button activation on keyup) — still never the drawer.
  await expect(trigger).toBeFocused()
  await page.keyboard.press('Space')
  await expect(
    page.getByRole('menuitem', { name: 'Delete work item' }),
  ).toBeVisible()
  await expect(inspectorRegion(page)).not.toBeVisible()

  // Keyboard-selecting Delete work item opens ONLY the existing
  // confirmation dialog (the menuitem keydown must not open the
  // card either).
  const deleteItem = page.getByRole('menuitem', {
    name: 'Delete work item',
  })
  await deleteItem.focus()
  await expect(deleteItem).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(deleteDialog(page)).toBeVisible()
  await expect(inspectorRegion(page)).not.toBeVisible()

  // Cancel keeps the card; the drawer never opened.
  await deleteDialog(page)
    .getByRole('button', { name: /Cancel/ })
    .click()
  await expect(deleteDialog(page)).not.toBeVisible()
  await expect(card).toBeVisible()
  await expect(inspectorRegion(page)).not.toBeVisible()
})

// The rejected styling pass rendered this menu at the wrong scale:
// the global UNLAYERED `button { font: inherit }` reset in
// src/index.css beat the item's layered text-[13px]/font-medium
// utilities (the label inherited the page's 16px), and the Google
// Fonts stylesheet's unlayered `.material-symbols-outlined
// { font-size: 24px }` beat the icon's text-[14px] — the 16px label +
// 24px glyph then overflowed the compact w-45 panel and clipped the
// label with an ellipsis. This test guards the RENDERED (computed) typography, the
// absence of truncation, and the untouched interactability/placement
// of the shared Work Item action menu.
test('Board card menu renders the Delete item at 13px with the full label, no truncation', async ({
  page,
}) => {
  const title = taskTitle('MenuType')

  await login(page, 'alex')
  await openProjects(page)
  await createProject(page, projectLabel('MenuType'))
  await createWorkItem(page, title)

  const card = openButton(page, title)
  await expect(card).toBeVisible()

  // Open the REAL three-dot menu from the Board card.
  await card
    .getByRole('button', { name: 'Work item actions' })
    .click()

  const item = page.getByRole('menuitem', {
    name: 'Delete work item',
  })
  await expect(item).toBeVisible()

  // Opening the menu never opens the Work Item drawer.
  await expect(inspectorRegion(page)).not.toBeVisible()

  // The rendered label: the menu item's text span (the icon span is
  // aria-hidden, so the exact text sits on the label span alone).
  const label = item.getByText('Delete work item', { exact: true })

  const labelMetrics = await label.evaluate((el) => ({
    fontSize: Number.parseFloat(getComputedStyle(el).fontSize),
    fontWeight: getComputedStyle(el).fontWeight,
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }))

  // Computed typography is the compact 13px / 500 contract — not the
  // inherited page size (16px / 400) the unlayered reset used to
  // force.
  expect(labelMetrics.fontSize).toBeGreaterThanOrEqual(12.5)
  expect(labelMetrics.fontSize).toBeLessThanOrEqual(13.5)
  expect(labelMetrics.fontWeight).toBe('500')

  // The complete "Delete work item" label fits the compact panel: no
  // ellipsis (a truncated label reports a larger scrollWidth than
  // its visible box).
  expect(labelMetrics.clientWidth).toBeGreaterThan(0)
  expect(labelMetrics.scrollWidth).toBeLessThanOrEqual(
    labelMetrics.clientWidth,
  )

  // The trash glyph renders at ~14px, not the 24px the Google Fonts
  // stylesheet's unlayered rule used to force.
  const iconFontSize = await item
    .locator('span[aria-hidden="true"]')
    .evaluate((el) =>
      Number.parseFloat(getComputedStyle(el).fontSize),
    )
  expect(iconFontSize).toBeGreaterThanOrEqual(13.5)
  expect(iconFontSize).toBeLessThanOrEqual(14.5)

  // The item stays interactable: clicking opens ONLY the existing
  // confirmation dialog (the delete path is unchanged)…
  await item.click()
  await expect(deleteDialog(page)).toBeVisible()
  await expect(inspectorRegion(page)).not.toBeVisible()

  // …and Cancel keeps the card; the drawer never opened.
  await deleteDialog(page)
    .getByRole('button', { name: /Cancel/ })
    .click()
  await expect(deleteDialog(page)).not.toBeVisible()
  await expect(card).toBeVisible()
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
