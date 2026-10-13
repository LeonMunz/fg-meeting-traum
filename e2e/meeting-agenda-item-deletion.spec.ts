import {
  expect,
  test,
  type Page,
} from '@playwright/test'

import {
  datePartPlusDays,
  login,
  openGroupMeetings,
  openGroupProjects,
  openProject,
  openProjects,
  quickAddAgendaItem,
  replaceControlValue,
} from './helpers'

// The isolated E2E schema is reset once when Playwright starts —
// NOT between test cases — so every fixture identity in this file
// must stay unique across tests: a shared Meeting title would leave
// a second "Open <title>" row in the Upcoming list when the other
// test runs, and the row locator would no longer be unambiguous.
const ELIGIBLE_MEETING_TITLE =
  'E2E Item Delete Eligible'

const PROTECTED_MEETING_TITLE =
  'E2E Item Delete Protected'

const FIRST_TOPIC =
  'E2E Delete First Topic'

const SECOND_TOPIC =
  'E2E Delete Second Topic'

const PROJECT_NAME =
  'E2E Item Delete Project'

const WORK_ITEM_TITLE =
  'E2E Item Delete Linked Task'

/**
 * Create a one-time Meeting through the Meetings page header
 * CTA (no Template) inside the canonical Upcoming window and
 * open its detail. Returns on the Meeting detail route, once the
 * Agenda section's preparation composer is rendered (readiness
 * gate below).
 */
async function createAndOpenOneTimeMeeting(
  page: Page,
  title: string,
  daysAhead: number,
  time: string,
) {
  const header = page
    .locator('header')
    .filter({
      has: page.getByRole('heading', {
        name: 'Meetings',
        exact: true,
      }),
    })

  await header
    .getByRole('button', { name: /New meeting/ })
    .click()

  await page
    .getByLabel('Title')
    .fill(title)

  await replaceControlValue(
    page.getByRole('textbox', {
      name: 'Date',
      exact: true,
    }),
    datePartPlusDays(daysAhead),
  )

  await replaceControlValue(
    page.getByRole('combobox', {
      name: 'Time',
      exact: true,
    }),
    time,
  )

  await page
    .locator('form')
    .getByRole('button', { name: /Create meeting/ })
    .click()

  await expect(
    page.getByRole('dialog', { name: 'New meeting' }),
  ).toBeHidden()

  // The Meetings list stays open after creation: open the new
  // row to navigate into the Meeting.
  await page
    .getByRole('button', {
      name: new RegExp(`^Open ${title} `),
    })
    .click()

  await expect(page).toHaveURL(/\/meetings\/\d+$/)

  // Readiness gate: the URL updates the moment the client-side
  // navigation fires, BEFORE the Meeting detail data has loaded
  // and the Agenda section rendered. The preparation composer's
  // "+ Add topic" trigger only exists once the section has
  // rendered AND the authenticated user may prepare the Meeting
  // (the affordance is preparer-only). quickAddAgendaItem picks
  // its quick-add branch from a single non-waiting visibility
  // probe; run it before this condition holds and it falls
  // through to the Live-rail branch, which then waits forever
  // for an "Add item" button that never appears in the Upcoming
  // view.
  await expect(
    page
      .getByRole('region', { name: 'Agenda' })
      .getByRole('button', { name: '+ Add topic' }),
  ).toBeVisible()
}

/**
 * The agenda-item Delete action confirms through the page's
 * real `window.confirm`: accept it (or count it) and activate
 * the Delete entry of the given item's row menu.
 */
async function activateItemDelete(
  page: Page,
  topic: string,
  onConfirm: (dialog: import('@playwright/test').Dialog) => void | Promise<void>,
) {
  page.once('dialog', (dialog) => {
    void onConfirm(dialog)
  })

  const itemRow = page
    .locator('li')
    .filter({
      has: page.getByText(topic, {
        exact: true,
      }),
    })

  await itemRow
    .getByRole('button', {
      name: `Actions for agenda item ${topic}`,
    })
    .click()

  await page
    .getByRole('menuitem', { name: 'Delete' })
    .click()
}

/**
 * Open the given item's row menu. MenuTrigger unmounts its menu
 * content while closed, so row-level entries (linked Work Items,
 * outcome markers) are only observable while the menu is open.
 */
async function openItemActionsMenu(
  page: Page,
  topic: string,
) {
  const itemRow = page
    .locator('li')
    .filter({
      has: page.getByText(topic, {
        exact: true,
      }),
    })

  await itemRow
    .getByRole('button', {
      name: `Actions for agenda item ${topic}`,
    })
    .click()

  await expect(page.getByRole('menu')).toBeVisible()
}

test(
  'Delete an eligible Upcoming agenda item: persisted, sibling survives reload',
  async ({ page }) => {
    await login(page, 'alex')
    await openGroupMeetings(page, 'FG Example')

    await createAndOpenOneTimeMeeting(
      page,
      ELIGIBLE_MEETING_TITLE,
      3,
      '10:00',
    )

    // --------------------------------------------------------
    // Two agenda items in the default Agenda section. Each call
    // returns only after its create has fully settled: the item
    // row is listed AND the composer has collapsed.
    // --------------------------------------------------------

    await quickAddAgendaItem(page, FIRST_TOPIC)
    await quickAddAgendaItem(page, SECOND_TOPIC)

    await expect(
      page.getByText(FIRST_TOPIC, { exact: true }),
    ).toBeVisible()
    await expect(
      page.getByText(SECOND_TOPIC, { exact: true }),
    ).toBeVisible()

    // --------------------------------------------------------
    // Delete the FIRST item through the real UI (the page's
    // window.confirm is accepted). The backend DELETE must
    // actually succeed (204), not just the local UI state.
    // --------------------------------------------------------

    const deletionResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        /\/api\/meeting-items\/\d+\/$/.test(response.url()),
    )

    await activateItemDelete(page, FIRST_TOPIC, (dialog) => {
      expect(dialog.type()).toBe('confirm')
      return dialog.accept()
    })

    expect((await deletionResponse).status()).toBe(204)

    // The deleted item disappears; the sibling remains.
    await expect(
      page.getByText(FIRST_TOPIC, { exact: true }),
    ).toHaveCount(0)
    await expect(
      page.getByText(SECOND_TOPIC, { exact: true }),
    ).toBeVisible()

    // --------------------------------------------------------
    // Reload: the deletion was persisted on the server.
    // --------------------------------------------------------

    await page.reload()

    await expect(
      page.getByRole('heading', { name: ELIGIBLE_MEETING_TITLE }),
    ).toBeVisible()
    await expect(
      page.getByText(FIRST_TOPIC, { exact: true }),
    ).toHaveCount(0)
    await expect(
      page.getByText(SECOND_TOPIC, { exact: true }),
    ).toBeVisible()
  },
)

test(
  'Deleting an item linked to a Work Item is rejected and leaves everything intact',
  async ({ page }) => {
    await login(page, 'alex')

    // --------------------------------------------------------
    // A Project for the linked Work Item (the item's row menu
    // offers no protected fixture without one).
    // --------------------------------------------------------

    await openProjects(page)

    await page
      .getByRole('button', { name: /New project/ })
      .click()

    const createProjectDialog = page.getByRole(
      'dialog',
      { name: 'Create project' },
    )

    await createProjectDialog
      .getByLabel('Project name')
      .fill(PROJECT_NAME)

    await createProjectDialog
      .getByRole('button', { name: /Create project/ })
      .click()

    await expect(
      page.getByText(PROJECT_NAME, { exact: true }),
    ).toBeVisible()

    await openProject(page, PROJECT_NAME)

    // --------------------------------------------------------
    // Upcoming Meeting with one agenda item, then link that
    // item to a canonical Work Item.
    // --------------------------------------------------------

    await openGroupMeetings(page, 'FG Example')
    await createAndOpenOneTimeMeeting(
      page,
      PROTECTED_MEETING_TITLE,
      4,
      '11:00',
    )

    await quickAddAgendaItem(page, FIRST_TOPIC)

    const itemRow = page
      .locator('li')
      .filter({
        has: page.getByText(FIRST_TOPIC, {
          exact: true,
        }),
      })

    await itemRow
      .getByRole('button', {
        name: `Actions for agenda item ${FIRST_TOPIC}`,
      })
      .click()

    await page
      .getByRole('menuitem', { name: 'Create work item' })
      .click()

    const workItemDialog = page.getByRole(
      'dialog',
      { name: 'Create work item' },
    )

    await expect(workItemDialog).toBeVisible()

    await workItemDialog
      .getByLabel('Project')
      .selectOption({ label: PROJECT_NAME })

    await workItemDialog
      .getByLabel('Title')
      .fill(WORK_ITEM_TITLE)

    await workItemDialog
      .getByRole('button', { name: /Create work item/ })
      .click()

    await expect(workItemDialog).not.toBeVisible()

    // The persisted link is exposed as a disabled row-menu entry;
    // MenuTrigger unmounts its content while closed, so observe
    // the entry while the menu is open.
    await openItemActionsMenu(page, FIRST_TOPIC)

    await expect(
      page.getByRole('menuitem', {
        name: '1 linked work item',
      }),
    ).toBeVisible()

    await page.keyboard.press('Escape')

    // --------------------------------------------------------
    // The real backend REJECTS the deletion (409): the error
    // stays visible with the server reason, the item remains,
    // and the Work Item link survives a reload.
    // --------------------------------------------------------

    await activateItemDelete(page, FIRST_TOPIC, (dialog) => {
      expect(dialog.type()).toBe('confirm')
      return dialog.accept()
    })

    const alert = page.getByRole('alert')
    await expect(alert).toBeVisible()
    await expect(alert).toContainText(
      'This agenda item is linked to Work Items',
    )

    // The protected item is still there.
    await expect(
      page.getByText(FIRST_TOPIC, { exact: true }),
    ).toBeVisible()

    await page.reload()

    const persistedItemRow = page
      .locator('li')
      .filter({
        has: page.getByText(FIRST_TOPIC, {
          exact: true,
        }),
      })

    await expect(persistedItemRow).toBeVisible()

    // The persisted link survives the rejection: the row menu
    // again offers the (disabled) linked-work-item entry.
    await openItemActionsMenu(page, FIRST_TOPIC)

    await expect(
      page.getByRole('menuitem', {
        name: '1 linked work item',
      }),
    ).toBeVisible()

    await page.keyboard.press('Escape')

    // The canonical Work Item itself remains on its Project board
    // (the link's target was never deleted).
    await openGroupProjects(page, 'FG Example')
    await openProject(page, PROJECT_NAME)

    await expect(
      page.getByRole('button', {
        name: `Open ${WORK_ITEM_TITLE}`,
      }),
    ).toBeVisible()
  },
)
