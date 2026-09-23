import {
  expect,
  test,
  type Page,
} from '@playwright/test'

import {
  datePartPlusDays,
  login,
  quickAddAgendaItem,
} from './helpers'
const TEMPLATE_NAME = 'E2E Occurrence Template'

const SERIES_TITLE = 'E2E Occurrence Weekly'

/**
 * The accessible row name of the series' occurrence that falls on
 * local calendar date `daysFromToday`. Upcoming rows identify each
 * occurrence by title + EFFECTIVE local date + local time (the same
 * locale format the date-group headings use), so an occurrence is
 * targetable by semantic identity — no positional disambiguation.
 */
const ROW_DATE_FORMAT = new Intl.DateTimeFormat('en', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
})

function seriesOccurrenceRowName(daysFromToday: number) {
  const now = new Date()
  const occurrenceDate = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + daysFromToday,
  )
  return `Open ${SERIES_TITLE} on ${ROW_DATE_FORMAT.format(occurrenceDate)} at 10:00`
}

const AGENDA_ITEM_TITLE =
  'E2E Occurrence Agenda Item'

/**
 * Count every materialization request the page issues. The
 * canonical endpoint is the idempotent occurrence
 * materialization POST; opening a virtual occurrence from
 * Upcoming is the ONLY flow in this spec that may trigger it,
 * and only on explicit row activation.
 */
function trackMaterializeRequests(page: Page) {
  const requests: { url: string; payload: string }[] = []

  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().includes(
        '/occurrences/materialize/',
      )
    ) {
      requests.push({
        url: request.url(),
        payload: request.postData() ?? '',
      })
    }
  })

  return requests
}

/**
 * Create a Meeting Template (group scope) through the existing
 * template management surface, then give it one ACTIVE "Agenda"
 * section through the Template-management "Add section" form.
 * Fresh Templates have no sections, and materialization snapshots
 * only the Template's ACTIVE sections — so the fixture must
 * establish the structure the acceptance proves instead of
 * expecting content an empty Template cannot provide.
 */
async function createTemplate(page: Page) {
  await page
    .getByRole('link', {
      name: /Meetings/,
    })
    .click()

  await page
    .getByRole('button', {
      name: /Meeting Templates/,
    })
    .click()

  await expect(
    page.getByRole('heading', {
      name: 'New meeting template',
    }),
  ).toBeVisible()

  await page
    .getByLabel('Name')
    .fill(TEMPLATE_NAME)

  await page
    .getByRole('button', {
      name: 'Create template',
    })
    .click()

  // Creation navigates to the new template's detail page.
  await expect(page).toHaveURL(
    /\/meetings\/series\/\d+$/,
  )

  // Establish the real Template structure: one active "Agenda"
  // section through the canonical Template-management "Add
  // section" form (POST /api/meeting-series/{id}/sections/).
  await page
    .getByLabel('Section name')
    .fill('Agenda')

  await page
    .getByRole('button', {
      name: 'Add section',
      exact: true,
    })
    .click()

  await expect(
    page.locator('span.font-semibold', {
      hasText: /^Agenda$/,
    }),
  ).toBeVisible()
}

/**
 * Create a Weekly recurring series (tomorrow, 10:00 local) on
 * the template through the existing "New meeting" dialog. No
 * concrete Meeting is created by this: every occurrence stays
 * virtual until explicitly opened.
 */
async function createWeeklySeries(page: Page) {
  await page
    .getByRole('link', {
      name: /Meetings/,
    })
    .click()

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

  const dialog = page.getByRole('dialog', {
    name: 'New meeting',
  })

  await page
    .getByLabel('Title')
    .fill(SERIES_TITLE)
  // The dialog's calendar/time-suggestion buttons carry
  // aria-labels that CONTAIN 'date' / 'time', so label-based
  // locators are substring-ambiguous in strict mode. Target the
  // editable controls by their actual role + exact name: Date is
  // a plain textbox; Time is the editable combobox of the
  // time-suggestion listbox contract.
  //
  // The Date/Time inputs are controlled by a focus-derived
  // display value (locale-formatted while unfocused, canonical
  // while focused) and commit on blur, so the E2E performs the
  // normal user interaction: focus the field, select the
  // canonical value, replace it with real keystrokes, and tab
  // away to commit (a programmatic fill does not reliably commit
  // a replacement into these fields).
  const dateBox = page.getByRole('textbox', {
    name: 'Date',
    exact: true,
  })
  await dateBox.click()
  await dateBox.press('ControlOrMeta+a')
  await dateBox.pressSequentially(datePartPlusDays(1))
  await dateBox.press('Tab')

  const timeBox = page.getByRole('combobox', {
    name: 'Time',
    exact: true,
  })
  await timeBox.click()
  await timeBox.press('ControlOrMeta+a')
  await timeBox.pressSequentially('10:00')
  await timeBox.press('Tab')
  await page
    .getByLabel('Meeting template')
    .selectOption({ label: TEMPLATE_NAME })
  await page
    .getByLabel('Repeat')
    .selectOption('weekly')

  // The start date's weekday is preselected automatically for
  // Weekly rules; the "Never" end mode is the dialog default.
  await dialog
    .getByRole('button', { name: 'Create series' })
    .click()

  await expect(
    dialog,
  ).toBeHidden()
}

test(
  'Opening a virtual upcoming occurrence resolves it into the normal Meeting workspace',
  async ({ page }) => {
    await login(page, 'alex')

    const materializeRequests =
      trackMaterializeRequests(page)

    await createTemplate(page)
    await createWeeklySeries(page)

    // Back in Upcoming: the series' first occurrence appears
    // as a normal recurring row.
    const upcoming = page.locator(
      '[aria-label="Upcoming meetings"]',
    )

    // The series' first occurrence falls on tomorrow; its row is
    // selected by that occurrence's unique accessible identity.
    const firstRow = upcoming.getByRole('button', {
      name: seriesOccurrenceRowName(1),
    })

    await expect(firstRow).toBeVisible()
    // The row is a normal interactive row (same contract as a
    // concrete Meeting row) — not a disabled/decorated element.
    await expect(firstRow).toHaveAttribute(
      'tabindex',
      '0',
    )
    // The recurring indicator is subtle secondary metadata: a
    // decorative (aria-hidden) icon plus the visible word.
    // Match the word by containment, not exact element text —
    // the indicator element's full text also carries the icon's
    // font-ligature word, so an exact match finds no element even
    // though the word is rendered and visible.
    await expect(
      firstRow.getByText('Recurring'),
    ).toBeVisible()

    // No materialization happens from rendering the list,
    // creating the series, or letting the occurrence enter the
    // Upcoming window.
    expect(materializeRequests).toHaveLength(0)

    // --------------------------------------------------------
    // Explicit Open: the virtual occurrence is resolved by
    // exactly ONE materialization request and the Meeting
    // detail of the returned Meeting opens.
    // --------------------------------------------------------

    await firstRow.click()

    await expect(page).toHaveURL(
      /\/meetings\/\d+$/,
    )

    expect(materializeRequests).toHaveLength(1)
    expect(materializeRequests[0].url).toContain(
      '/occurrences/materialize/',
    )
    // The request carries the stable occurrence identity pair
    // as reported by the feed, plus the concrete Meeting title.
    const firstPayload = JSON.parse(
      materializeRequests[0].payload,
    )
    expect(firstPayload.title).toBe(SERIES_TITLE)
    expect(
      typeof firstPayload.occurrenceId,
    ).toBe('string')
    expect(
      typeof firstPayload.originalScheduledAt,
    ).toBe('string')

    const firstMeetingUrl = new URL(
      page.url(),
    ).pathname
    const firstMeetingId =
      firstMeetingUrl.split('/').pop()

    // The normal Meeting workspace: the Template's Agenda
    // section is present (snapshotted at first
    // materialization) — the same detail UI an ordinary
    // concrete Meeting uses.
    await expect(
      page.getByRole('heading', {
        name: 'Agenda',
        exact: true,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // Agenda persistence across navigation.
    // --------------------------------------------------------

    await quickAddAgendaItem(
      page,
      AGENDA_ITEM_TITLE,
    )

    // Navigate away (Home) and back to Upcoming.
    await page
      .getByRole('link', {
        name: /Home/,
      })
      .click()
    await page
      .getByRole('link', {
        name: /Meetings/,
      })
    .click()

    await expect(upcoming).toBeVisible()
    // Still exactly one materialization request: seeing the
    // now-materialized row again is a read, not a write.
    expect(materializeRequests).toHaveLength(1)

    // The first occurrence is a concrete Meeting row now;
    // opening it navigates directly — no second
    // materialization.
    const returnedFirstRow = upcoming.getByRole('button', {
      name: seriesOccurrenceRowName(1),
    })

    await expect(returnedFirstRow).toBeVisible()
    await returnedFirstRow.click()

    await expect(page).toHaveURL(firstMeetingUrl)
    expect(materializeRequests).toHaveLength(1)

    // The Agenda item survived the round trip.
    await expect(
      page
        .getByText(AGENDA_ITEM_TITLE, { exact: true }),
    ).toBeVisible()

    // --------------------------------------------------------
    // A second, later occurrence resolves into a DIFFERENT
    // concrete Meeting with its own independent Agenda, while
    // the first Meeting's content stays unchanged.
    // --------------------------------------------------------

    await page
      .getByRole('link', {
        name: /Meetings/,
      })
      .click()

    // The next weekly occurrence (first + 7 days) is still
    // virtual; its row is selected by its own accessible
    // identity.
    const laterRow = upcoming.getByRole('button', {
      name: seriesOccurrenceRowName(8),
    })

    await expect(laterRow).toBeVisible()
    expect(materializeRequests).toHaveLength(1)

    await laterRow.click()

    await expect(page).toHaveURL(
      /\/meetings\/\d+$/,
    )
    expect(materializeRequests).toHaveLength(2)
    // A different occurrence was resolved…
    const secondPayload = JSON.parse(
      materializeRequests[1].payload,
    )
    expect(secondPayload.occurrenceId).not.toBe(
      firstPayload.occurrenceId,
    )
    // …into a different concrete Meeting.
    const secondMeetingUrl = new URL(
      page.url(),
    ).pathname
    expect(secondMeetingUrl).not.toBe(firstMeetingUrl)

    // The second Meeting snapshots the Template structure
    // (Agenda section present) but does NOT inherit the first
    // Meeting's items.
    await expect(
      page.getByRole('heading', {
        name: 'Agenda',
        exact: true,
      }),
    ).toBeVisible()
    expect(
      page
        .getByText(AGENDA_ITEM_TITLE, {
          exact: true,
        }),
    ).toHaveCount(0)

    // The first Meeting's content remains unchanged.
    await page
      .getByRole('link', {
        name: /Meetings/,
      })
      .click()
    await upcoming
      .getByRole('button', {
        name: seriesOccurrenceRowName(1),
      })
      .click()

    await expect(page).toHaveURL(firstMeetingUrl)
    expect(materializeRequests).toHaveLength(2)
    await expect(
      page
        .getByText(AGENDA_ITEM_TITLE, { exact: true }),
    ).toBeVisible()
  },
)
