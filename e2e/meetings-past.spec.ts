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

/**
 * The Meetings page header CTA. Scoped to the page <header>
 * because the empty Upcoming state renders its own "New meeting"
 * CTA.
 */
async function clickHeaderNewMeeting(page: Page) {
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
}

test(
  'Past lists the explicitly completed Meeting read-only and opens its detail without mutation',
  async ({ page }) => {
    await login(page, 'alex')

    await openGroupMeetings(page, 'FG Example')

    // The Past list must never materialize an occurrence (it has
    // no virtual rows at all) — count every materialization
    // request across the whole flow.
    let materializeRequests = 0
    page.on('request', (request) => {
      if (
        request
          .url()
          .includes('/occurrences/materialize/')
      ) {
        materializeRequests += 1
      }
    })

    // A one-time Meeting scheduled earlier TODAY (past clock
    // time, today's local date group). Completion is still an
    // EXPLICIT lifecycle transition — the past time alone never
    // puts it in Past.
    const now = new Date()
    const title = `E2E Past ${Date.now()
      .toString(36)
      .slice(-6)}`
    const today = datePartPlusDays(0)
    const pastHour = Math.max(
      0,
      now.getHours() - 1,
    )
    const time = `${String(
      pastHour,
    ).padStart(2, '0')}:00`
    // The Past group header of today's local date, exactly as
    // the app renders it (weekday + short month + day + the
    // explicit year).
    const todayLabel = new Intl.DateTimeFormat(
      'en',
      {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      },
    ).format(now)

    // 1) Create the Meeting (no template, no participants).
    await clickHeaderNewMeeting(page)

    await page.getByLabel('Title').fill(title)

    await replaceControlValue(
      page.getByRole('textbox', { name: 'Date', exact: true }),
      today,
    )

    await replaceControlValue(
      page.getByRole('combobox', { name: 'Time', exact: true }),
      time,
    )

    await page
      .locator('form')
      .getByRole('button', { name: /Create meeting/ })
      .click()

    // 2) Open it from Upcoming (a concrete row: direct
    //    navigation, no materialization) and drive the explicit
    //    lifecycle upcoming -> live -> completed.
    const upcomingRow = page
      .getByRole('button')
      .filter({ hasText: title })

    await upcomingRow.click()

    await expect(page).toHaveURL(/\/meetings\/\d+$/)

    await page
      .getByRole('button', { name: 'Start meeting' })
      .click()

    await expect(
      page.getByRole('button', { name: 'End meeting' }),
    ).toBeVisible()

    await page
      .getByRole('button', { name: 'End meeting' })
      .click()

    // Completed: the Reopen action confirms the state.
    await expect(
      page.getByRole('button', {
        name: 'Reopen meeting',
      }),
    ).toBeVisible()

    // 3) Back on the Meetings page: the completed Meeting has
    //    left the Upcoming view (lifecycle-scoped exclusion).
    await openGroupMeetings(page, 'FG Example')

    await expect(
      page
        .getByRole('button')
        .filter({ hasText: title }),
    ).toHaveCount(0)

    // 4) The Past tab lists it exactly once under today's
    //    unambiguous date group — no duplicate, no occurrence
    //    row, no Upcoming row actions on the row.
    await page
      .getByRole('tab', { name: 'Past' })
      .click()

    const pastSection = page.getByRole('region', {
      name: 'Completed meetings',
    })

    await expect(pastSection).toBeVisible()

    const pastRow = pastSection
      .getByRole('button')
      .filter({ hasText: title })

    await expect(pastRow).toHaveCount(1)

    await expect(
      pastSection.getByRole('heading', {
        name: todayLabel,
        exact: true,
      }),
    ).toBeVisible()

    // The row is a plain open affordance: it carries NO nested
    // row actions (no edit / cancel / exclude / delete).
    await expect(
      pastRow.getByRole('button'),
    ).toHaveCount(0)

    // 5) Pointer activation opens the EXISTING Meeting detail
    //    by its canonical id — the completed detail offers
    //    Reopen — and issues no materialization request.
    await pastRow.click()

    await expect(page).toHaveURL(/\/meetings\/\d+$/)

    await expect(
      page.getByRole('button', {
        name: 'Reopen meeting',
      }),
    ).toBeVisible()

    expect(materializeRequests).toBe(0)

    // 6) Keyboard activation: the same row opens the detail
    //    with Enter as well.
    await openGroupMeetings(page, 'FG Example')

    await page
      .getByRole('tab', { name: 'Past' })
      .click()

    const keyboardRow = page
      .getByRole('region', {
        name: 'Completed meetings',
      })
      .getByRole('button')
      .filter({ hasText: title })

    await keyboardRow.focus()
    await keyboardRow.press('Enter')

    await expect(page).toHaveURL(/\/meetings\/\d+$/)

    // 7) Across list load, tab activation, and both opens the
    //    Past view stayed read-only: zero materialization
    //    requests, no occurrence requests of its own.
    expect(materializeRequests).toBe(0)
  },
)
