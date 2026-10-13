import {
  expect,
  test,
  type Page,
} from '@playwright/test'

import {
  datePartPlusDays,
  login,
  openGroupMeetings,
  replaceControlValue,
} from './helpers'

const MEETING_TITLE = 'E2E Section Reorder Meeting'
const SECTION_B = 'E2E Reorder Section B'
const SECTION_C = 'E2E Reorder Section C'

async function createAndOpenMeeting(page: Page) {
  await openGroupMeetings(page, 'FG Example')

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

  await page.getByLabel('Title').fill(MEETING_TITLE)
  await replaceControlValue(
    page.getByRole('textbox', {
      name: 'Date',
      exact: true,
    }),
    datePartPlusDays(12),
  )
  await replaceControlValue(
    page.getByRole('combobox', {
      name: 'Time',
      exact: true,
    }),
    '09:30',
  )

  await page
    .locator('form')
    .getByRole('button', { name: /Create meeting/ })
    .click()

  await expect(
    page.getByRole('dialog', { name: 'New meeting' }),
  ).toBeHidden()

  await page
    .getByRole('button', {
      name: new RegExp(`^Open ${MEETING_TITLE} `),
    })
    .click()

  await expect(page).toHaveURL(/\/meetings\/\d+$/)
  await expect(
    page.getByRole('heading', {
      name: MEETING_TITLE,
      exact: true,
    }),
  ).toBeVisible()
}

async function addSection(page: Page, name: string) {
  await page
    .getByRole('button', {
      name: '+ Add section',
      exact: true,
    })
    .click()
  await page.getByLabel('New section name').fill(name)
  await page.getByLabel('New section name').press('Enter')
  await expect(
    page.getByRole('heading', {
      name,
      exact: true,
    }),
  ).toBeVisible()
  await expect(
    page.getByLabel('New section name'),
  ).toHaveCount(0)
}

async function expectSectionOrder(
  page: Page,
  expected: string[],
) {
  await expect
    .poll(() =>
      page
        .getByRole('heading', { level: 2 })
        .allTextContents(),
    )
    .toEqual(expected)
}

async function moveSection(
  page: Page,
  section: string,
  direction: 'Move up' | 'Move down',
) {
  await page
    .getByRole('button', {
      name: `Actions for section ${section}`,
    })
    .click()
  await page
    .getByRole('menuitem', {
      name: direction,
      exact: true,
    })
    .click()
}

test(
  'Upcoming Meeting section order updates immediately and persists in both directions',
  async ({ page }) => {
    await login(page, 'alex')
    await createAndOpenMeeting(page)

    await addSection(page, SECTION_B)
    await addSection(page, SECTION_C)

    const initialOrder = ['Agenda', SECTION_B, SECTION_C]
    const movedUpOrder = [SECTION_B, 'Agenda', SECTION_C]

    await expectSectionOrder(page, initialOrder)

    const moveUpResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        /\/api\/meetings\/\d+\/sections\/reorder\/$/.test(
          response.url(),
        ),
    )

    await moveSection(page, SECTION_B, 'Move up')
    expect((await moveUpResponse).status()).toBe(200)
    await expectSectionOrder(page, movedUpOrder)

    await page.reload()
    await expect(
      page.getByRole('heading', {
        name: MEETING_TITLE,
        exact: true,
      }),
    ).toBeVisible()
    await expectSectionOrder(page, movedUpOrder)

    const moveDownResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        /\/api\/meetings\/\d+\/sections\/reorder\/$/.test(
          response.url(),
        ),
    )

    await moveSection(page, SECTION_B, 'Move down')
    expect((await moveDownResponse).status()).toBe(200)
    await expectSectionOrder(page, initialOrder)

    await page.reload()
    await expect(
      page.getByRole('heading', {
        name: MEETING_TITLE,
        exact: true,
      }),
    ).toBeVisible()
    await expectSectionOrder(page, initialOrder)
  },
)
