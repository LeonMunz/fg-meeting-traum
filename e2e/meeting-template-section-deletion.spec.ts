import {
  expect,
  test,
  type Page,
} from '@playwright/test'

import {
  datePartPlusDays,
  login,
  replaceControlValue,
} from './helpers'

const TEMPLATE_TITLE =
  'E2E Section Delete Weekly'

const EXISTING_MEETING_TITLE =
  'E2E Section Delete Existing'

const FUTURE_MEETING_TITLE =
  'E2E Section Delete Future'

/**
 * Create a one-time Meeting from the Template through the
 * current Meetings-page create dialog (the template detail
 * page offers no occurrence creation anymore). The Meeting is
 * scheduled inside the canonical Upcoming window, so the
 * created Meeting appears as a normal Upcoming row; the
 * Meeting is opened from that row and its URL returned.
 */
async function createOneTimeMeetingFromTemplate(
  page: Page,
  title: string,
  daysAhead: number,
  time: string,
): Promise<string> {
  await page
    .getByRole('link', { name: /Meetings/ })
    .click()

  // The Meetings page header CTA. Scoped to the page
  // <header> because the empty Upcoming state renders its
  // own "New meeting" CTA.
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

  await page
    .getByLabel('Meeting template')
    .selectOption({ label: TEMPLATE_TITLE })

  // The dialog's calendar/time-suggestion buttons carry
  // aria-labels that CONTAIN 'date' / 'time', so label-based
  // locators are substring-ambiguous in strict mode. Target
  // the editable controls by their actual role + exact
  // name: Date is a plain textbox; Time is the editable
  // combobox of the time-suggestion listbox contract.
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

  // The Meetings list stays open after creation: open the
  // new row to navigate into the Meeting.
  await page
    .getByRole('button', {
      name: new RegExp(`^Open ${title} `),
    })
    .click()

  await expect(page).toHaveURL(/\/meetings\/\d+$/)
  return page.url()
}

test(
  'Delete a Template Section: tile, dialog, list, Snapshot Preview',
  async ({ page }: { page: Page }) => {
    await login(page, 'alex')

    // --------------------------------------------------------
    // Create a Meeting Template with two Sections.
    // --------------------------------------------------------

    await page
      .getByRole('link', {
        name: /Meetings/,
      })
      .click()

    await expect(page).toHaveURL(
      /\/meetings\?group=\d+$/,
    )

    const meetingsUrl = new URL(page.url())
    const groupId =
      meetingsUrl.searchParams.get('group') ?? '1'

    await page.goto(
      `/meetings/series?group=${groupId}`,
    )

    await page
      .getByLabel('Name')
      .fill(TEMPLATE_TITLE)

    await page
      .getByRole('button', {
        name: /Create template/,
      })
      .click()

    await expect(page).toHaveURL(
      /\/meetings\/series\/\d+$/,
    )

    await page
      .getByLabel('Section name')
      .fill('Check-In')

    await page
      .getByRole('button', {
        name: /Add section/,
      })
      .click()

    await expect(
      page
        .locator('span.font-semibold', {
          hasText: /^Check-In$/,
        }),
    ).toBeVisible()

    // Reload for a clean form state before adding the
    // second section.
    await page.reload()

    await page
      .getByLabel('Section name')
      .fill('Research')

    await page
      .getByRole('button', {
        name: /Add section/,
      })
      .click()

    await expect(
      page
        .locator('span.font-semibold', {
          hasText: /^Research$/,
        }),
    ).toBeVisible()

    // Both Sections are listed in the Snapshot Preview.
    //
    // The Snapshot Preview is the only `list` on the
    // template management page, and its items are
    // plain `<li>` elements: the Section name is
    // visible text only, with no accessible name.
    // Scope to that list and match the item text
    // instead of a role name.
    const snapshotPreviewList =
      page.getByRole('list')

    await expect(
      snapshotPreviewList
        .getByRole('listitem')
        .filter({
          hasText: /^Check-In$/,
        }),
    ).toBeVisible()
    await expect(
      snapshotPreviewList
        .getByRole('listitem')
        .filter({
          hasText: /^Research$/,
        }),
    ).toBeVisible()

    // --------------------------------------------------------
    // Create an existing one-time Meeting from the Template
    // (it snapshots BOTH sections).
    // --------------------------------------------------------

    const existingMeetingUrl =
      await createOneTimeMeetingFromTemplate(
        page,
        EXISTING_MEETING_TITLE,
        30,
        '10:00',
      )

    // Both snapshotted sections are visible.
    await expect(
      page.getByRole('heading', {
        name: 'Check-In',
        exact: true,
      }),
    ).toBeVisible()
    await expect(
      page.getByRole('heading', {
        name: 'Research',
        exact: true,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // Delete the "Research" Section from the Template.
    // --------------------------------------------------------

    await page.goto(
      `/meetings/series?group=${groupId}`,
    )

    const templateRow = page
      .getByRole('button')
      .filter({
        hasText: TEMPLATE_TITLE,
      })

    await templateRow.click()

    await expect(page).toHaveURL(
      /\/meetings\/series\/\d+$/,
    )

    const deleteResearch = page.getByRole('button', {
      name: 'Delete section Research',
    })

    await deleteResearch.scrollIntoViewIfNeeded()
    await deleteResearch.click()

    // The confirmation dialog names the Section and
    // explains the effect on existing and future Meetings.
    const dialog = page.getByRole('dialog', {
      name: 'Delete section "Research"?',
    })

    await expect(dialog).toBeVisible()
    await expect(
      dialog.getByText(
        /already created keep their sections/,
      ),
    ).toBeVisible()
    await expect(
      dialog.getByText(
        /will no longer include this section/,
      ),
    ).toBeVisible()
    // Two active Sections remain available: no last-active
    // explanation.
    await expect(
      dialog.getByText(/no agenda section/),
    ).toHaveCount(0)

    await dialog
      .getByRole('button', {
        name: 'Delete section',
      })
      .click()

    // --------------------------------------------------------
    // Resulting list + Snapshot Preview.
    // --------------------------------------------------------

    await expect(dialog).not.toBeVisible()

    // The Section-Kachel is gone from the list.
    await expect(
      page.getByRole('button', {
        name: 'Delete section Research',
      }),
    ).toHaveCount(0)
    await expect(
      page
        .locator('span.font-semibold', {
          hasText: /^Check-In$/,
        }),
    ).toBeVisible()
    // The section counter reflects the remaining Section.
    await expect(
      page.getByText('1 section', {
        exact: true,
      }),
    ).toBeVisible()

    // The Snapshot Preview lists only the remaining
    // active Section.
    await expect(
      snapshotPreviewList
        .getByRole('listitem')
        .filter({
          hasText: /^Check-In$/,
        }),
    ).toBeVisible()
    await expect(
      snapshotPreviewList
        .getByRole('listitem')
        .filter({
          hasText: /^Research$/,
        }),
    ).toHaveCount(0)

    // --------------------------------------------------------
    // The existing Meeting keeps its Section.
    // --------------------------------------------------------

    await page.goto(existingMeetingUrl)

    await expect(
      page.getByRole('heading', {
        name: 'Check-In',
        exact: true,
      }),
    ).toBeVisible()
    await expect(
      page.getByRole('heading', {
        name: 'Research',
        exact: true,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // A Meeting created AFTER the deletion snapshots only
    // the remaining active Section.
    // --------------------------------------------------------

    await createOneTimeMeetingFromTemplate(
      page,
      FUTURE_MEETING_TITLE,
      31,
      '10:00',
    )

    await expect(
      page.getByRole('heading', {
        name: 'Check-In',
        exact: true,
      }),
    ).toBeVisible()
    await expect(
      page.getByRole('heading', {
        name: 'Research',
        exact: true,
      }),
    ).toHaveCount(0)
  },
)
