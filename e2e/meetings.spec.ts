import {
  expect,
  test,
} from '@playwright/test'

import {
  login,
} from './helpers'

const MEETING_TITLE =
  'E2E FG Weekly'

const AGENDA_TITLE =
  'E2E Rewrite Introduction'

const AGENDA_NOTES =
  'Discuss scope and ownership.'

test(
  'Meeting participants agenda and status persist',
  async ({ page }) => {
    // --------------------------------------------------------
    // Alex creates a real Meeting.
    // --------------------------------------------------------

    await login(page, 'alex')

    await page
      .getByRole('link', {
        name: /Meetings/,
      })
      .click()

    await expect(page).toHaveURL(
      /\/meetings$/,
    )

    await expect(
      page.getByRole('heading', {
        name: 'Meetings',
        exact: true,
      }),
    ).toBeVisible()

    await page
      .getByRole('button', {
        name: /New meeting/,
      })
      .click()

    await page
      .getByLabel('Title')
      .fill(MEETING_TITLE)

    await page
      .getByLabel('Date and time')
      .fill('2030-01-02T10:30')

    await page
      .locator('form')
      .getByRole('button', {
        name: /Create meeting/,
      })
      .click()

    await expect(
      page.getByText(
        MEETING_TITLE,
        { exact: true },
      ),
    ).toBeVisible()

    // Reload proves Meeting persistence.
    await page.reload()

    await expect(
      page.getByText(
        MEETING_TITLE,
        { exact: true },
      ),
    ).toBeVisible()

    // --------------------------------------------------------
    // Open Meeting detail.
    // --------------------------------------------------------

    const meetingRow =
      page
        .getByRole('button')
        .filter({
          hasText: MEETING_TITLE,
        })

    await expect(
      meetingRow,
    ).toBeVisible()

    await meetingRow.click()

    await expect(page).toHaveURL(
      /\/meetings\/\d+$/,
    )

    await expect(
      page.getByRole('heading', {
        name: MEETING_TITLE,
        exact: true,
      }),
    ).toBeVisible()

    // Creator is automatically a participant.
    await expect(
      page.getByText(
        '@alex',
        { exact: true },
      ),
    ).toBeVisible()

    // --------------------------------------------------------
    // Alex adds Chris as participant.
    // --------------------------------------------------------

    const participantSelect =
      page.getByLabel(
        'Add participant',
      )

    const chrisOption =
      participantSelect
        .locator('option')
        .filter({
          hasText: /Chris|chris/i,
        })

    await expect(
      chrisOption,
    ).toHaveCount(1)

    const chrisValue =
      await chrisOption.getAttribute(
        'value',
      )

    expect(chrisValue).not.toBeNull()

    await participantSelect.selectOption(
      chrisValue!,
    )

    await page
      .getByRole('button', {
        name: 'Add',
        exact: true,
      })
      .click()

    await expect(
      page.getByText(
        '@chris',
        { exact: true },
      ),
    ).toBeVisible()

    // --------------------------------------------------------
    // Alex creates and discusses an agenda item.
    // --------------------------------------------------------

    await page
      .getByLabel('Agenda item')
      .fill(AGENDA_TITLE)

    await page
      .getByLabel('Notes')
      .fill(AGENDA_NOTES)

    await page
      .getByRole('button', {
        name: /Add agenda item/,
      })
      .click()

    await expect(
      page.getByText(
        AGENDA_TITLE,
        { exact: true },
      ),
    ).toBeVisible()

    await expect(
      page.getByText(
        AGENDA_NOTES,
        { exact: true },
      ),
    ).toBeVisible()

    const agendaItem =
      page
        .locator('article')
        .filter({
          has: page.getByText(
            AGENDA_TITLE,
            { exact: true },
          ),
        })

    await expect(
      agendaItem,
    ).toBeVisible()

    await agendaItem
      .getByRole('button')
      .filter({
        hasText: 'Mark discussed',
      })
      .click()

    await expect(
      agendaItem
        .getByRole('button')
        .filter({
          hasText: 'Discussed',
        }),
    ).toBeVisible()

    // --------------------------------------------------------
    // Alex starts the Meeting.
    // --------------------------------------------------------

    const meetingStatus =
      page.getByLabel(
        'Meeting status',
      )

    await meetingStatus.selectOption(
      'live',
    )

    await expect(
      meetingStatus,
    ).toHaveValue('live')

    // --------------------------------------------------------
    // Reload proves all Meeting state persisted.
    // --------------------------------------------------------

    await page.reload()

    await expect(
      page.getByRole('heading', {
        name: MEETING_TITLE,
        exact: true,
      }),
    ).toBeVisible()

    await expect(
      page.getByText(
        '@alex',
        { exact: true },
      ),
    ).toBeVisible()

    await expect(
      page.getByText(
        '@chris',
        { exact: true },
      ),
    ).toBeVisible()

    await expect(
      page.getByText(
        AGENDA_TITLE,
        { exact: true },
      ),
    ).toBeVisible()

    await expect(
      page.getByText(
        AGENDA_NOTES,
        { exact: true },
      ),
    ).toBeVisible()

    const persistedAgendaItem =
      page
        .locator('article')
        .filter({
          has: page.getByText(
            AGENDA_TITLE,
            { exact: true },
          ),
        })

    await expect(
      persistedAgendaItem
        .getByRole('button')
        .filter({
          hasText: 'Discussed',
        }),
    ).toBeVisible()

    await expect(
      page.getByLabel(
        'Meeting status',
      ),
    ).toHaveValue('live')
  },
)
