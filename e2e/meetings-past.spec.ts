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
    //    by its canonical id with the validated Past origin
    //    (?from=past) — the completed detail offers Reopen —
    //    and issues no materialization request.
    await pastRow.click()

    await expect(page).toHaveURL(
      /\/meetings\/\d+\?from=past$/,
    )

    await expect(
      page.getByRole('button', {
        name: 'Reopen meeting',
      }),
    ).toBeVisible()

    expect(materializeRequests).toBe(0)

    // 5a) The completed detail's Meetings action returns to the
    //     ORIGIN tab: the Meetings page on the Past tab with the
    //     completed Meeting visible in the archive again (the
    //     list URL additionally carries the page's active
    //     Research Group scope — parameter order is not part of
    //     the contract).
    await page
      .getByRole('button', { name: 'Meetings' })
      .click()

    await expect(page).toHaveURL(
      /\/meetings\?[^#]*tab=past/,
    )

    await expect(
      page.getByRole('tab', { name: 'Past' }),
    ).toHaveAttribute('aria-selected', 'true')

    await expect(
      page
        .getByRole('region', {
          name: 'Completed meetings',
        })
        .getByRole('button')
        .filter({ hasText: title }),
    ).toHaveCount(1)

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

    await expect(page).toHaveURL(
      /\/meetings\/\d+\?from=past$/,
    )

    // 7) Direct URL reload: the Past tab is URL-addressable —
    //    navigating straight to /meetings?tab=past (and reloading
    //    it) selects the Past tab immediately, with the
    //    completed Meeting visible, without any tab click.
    await page.goto('/meetings?tab=past')
    await expect(
      page.getByRole('tab', { name: 'Past' }),
    ).toHaveAttribute('aria-selected', 'true')

    await page.reload()
    await expect(
      page.getByRole('tab', { name: 'Past' }),
    ).toHaveAttribute('aria-selected', 'true')
    await expect(
      page
        .getByRole('region', {
          name: 'Completed meetings',
        })
        .getByRole('button')
        .filter({ hasText: title }),
    ).toHaveCount(1)

    // 8) Across list load, tab activation, both opens, the
    //    origin-carrying return, and the direct tab reload the
    //    Past view stayed read-only: zero materialization
    //    requests, no occurrence requests of its own.
    expect(materializeRequests).toBe(0)
  },
)

test(
  'An overdue (yesterday) upcoming Meeting stays visible in Upcoming and can be started late',
  async ({ page }) => {
    await login(page, 'alex')

    await openGroupMeetings(page, 'FG Example')

    // This flow must never materialize an occurrence — the
    // overdue Meeting is a concrete row (direct navigation).
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

    // A one-time Meeting scheduled for YESTERDAY: its
    // scheduled start lies before today's local midnight,
    // while its lifecycle status is still `upcoming`.
    const title = `E2E Overdue ${Date.now()
      .toString(36)
      .slice(-6)}`
    const yesterday = datePartPlusDays(-1)
    const time = '07:30'
    const yesterdayDate = new Date()
    yesterdayDate.setDate(
      yesterdayDate.getDate() - 1,
    )
    // The Upcoming date-group header of the scheduled day
    // (weekday + short month + day, local — the same
    // rendering the list uses for non-relative dates).
    const scheduledDayLabel = new Intl.DateTimeFormat(
      'en',
      {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      },
    ).format(yesterdayDate)
    // The Completed header's compact scheduled slot
    // (the same day + 24h clock, exactly as rendered).
    const compactScheduledSlot =
      `${scheduledDayLabel} · ${time}`

    // 1) Create the overdue Meeting.
    await clickHeaderNewMeeting(page)

    await page.getByLabel('Title').fill(title)

    await replaceControlValue(
      page.getByRole('textbox', { name: 'Date', exact: true }),
      yesterday,
    )

    await replaceControlValue(
      page.getByRole('combobox', { name: 'Time', exact: true }),
      time,
    )

    await page
      .locator('form')
      .getByRole('button', { name: /Create meeting/ })
      .click()

    // 2) The overdue concrete Meeting stays visible in
    //    Upcoming under its own (past) date group — the
    //    canonical Start path is lifecycle-gated, not
    //    time-gated.
    await expect(
      page.getByRole('heading', {
        name: scheduledDayLabel,
        exact: true,
      }),
    ).toBeVisible()

    const overdueRow = page
      .getByRole('button')
      .filter({ hasText: title })

    await expect(overdueRow).toBeVisible()

    // 3) Open it from Upcoming (a concrete row: direct
    //    navigation, no materialization) and confirm the
    //    original planned slot is what the detail shows.
    await overdueRow.click()

    await expect(page).toHaveURL(/\/meetings\/\d+$/)

    const detailHeader = page
      .locator('header')
      .filter({
        has: page.getByRole('heading', {
          name: title,
          level: 1,
        }),
      })

    await expect(
      page.getByRole('button', { name: 'Start meeting' }),
    ).toBeVisible()

    // The upcoming header carries the original planned
    // day label + clock time.
    await expect(
      detailHeader.getByText(scheduledDayLabel),
    ).toBeVisible()
    await expect(
      detailHeader.getByText(time),
    ).toBeVisible()

    // 4) Start late: upcoming -> live. The Live header's
    //    elapsed timer renders ONLY from the
    //    server-recorded startedAt, so its presence proves
    //    the actual start timestamp was persisted.
    await page
      .getByRole('button', { name: 'Start meeting' })
      .click()

    await expect(
      page.getByRole('button', { name: 'End meeting' }),
    ).toBeVisible()

    const liveHeader = page
      .locator('header')
      .filter({
        has: page.getByRole('heading', {
          name: title,
          level: 1,
        }),
      })

    await expect(
      liveHeader.getByRole('status'),
    ).toContainText(/Live · \d{1,2}:\d{2}/)

    // 5) End the Meeting: completed. The Completed
    //    header's meta line still reports the ORIGINAL
    //    scheduled slot (start/end never rewrite
    //    scheduledAt).
    await page
      .getByRole('button', { name: 'End meeting' })
      .click()

    await expect(
      page.getByRole('button', {
        name: 'Reopen meeting',
      }),
    ).toBeVisible()

    const completedHeader = page
      .locator('header')
      .filter({
        has: page.getByRole('heading', {
          name: title,
          level: 1,
        }),
      })

    await expect(
      completedHeader.getByText(compactScheduledSlot, {
        exact: true,
      }),
    ).toBeVisible()

    // 6) No occurrence materialization across the whole
    //    late-start flow.
    expect(materializeRequests).toBe(0)
  },
)
