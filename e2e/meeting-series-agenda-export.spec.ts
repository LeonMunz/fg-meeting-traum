import { promises as fs } from 'node:fs'

import {
  expect,
  test,
  type Page,
} from '@playwright/test'

import { login, openGroupMeetings } from './helpers'

const TEMPLATE_TITLE =
  'E2E Export Template'

/**
 * Create a disposable group-scoped Meeting Template with the
 * given Section names and land on its detail page.
 */
async function createExportTemplate(
  page: Page,
  sectionNames: string[],
) {
  await openGroupMeetings(page, 'FG Example')

  await expect(page).toHaveURL(
    /\/meetings\?group=\d+$/,
  )

  const meetingsUrl = new URL(page.url())
  const groupId =
    meetingsUrl.searchParams.get('group') ??
    '1'

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

  // Creation navigates to the new template's
  // detail page.
  await expect(page).toHaveURL(
    /\/meetings\/series\/\d+$/,
  )

  for (
    let index = 0;
    index < sectionNames.length;
    index += 1
  ) {
    // Reload before every add for a clean form
    // state (matches the template specs).
    if (index > 0) {
      await page.reload()
    }

    const name = sectionNames[index]

    await page
      .getByLabel('Section name')
      .fill(name)

    await page
      .getByRole('button', {
        name: /Add section/,
      })
      .click()

    await expect(
      page.locator('span.font-semibold', {
        hasText: new RegExp(`^${name}$`),
      }),
    ).toBeVisible()
  }
}

test(
  'Meeting Template agenda JSON export downloads the server attachment',
  async ({ page }) => {
    await login(page, 'alex')

    // --------------------------------------------------------
    // 1. Create a disposable template with two sections.
    // --------------------------------------------------------

    await createExportTemplate(
      page,
      ['Check-In', 'Research'],
    )

    // --------------------------------------------------------
    // 2. The export control is a read affordance: visible
    //    and enabled on the readable detail page.
    // --------------------------------------------------------

    const exportButton = page.getByRole(
      'button',
      { name: 'Export agenda JSON' },
    )

    await expect(exportButton).toBeVisible()
    await expect(exportButton).toBeEnabled()

    // --------------------------------------------------------
    // 3. One activation downloads the server-produced
    //    attachment.
    // --------------------------------------------------------

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      exportButton.click(),
    ])

    // The server-provided attachment filename
    // (slugified Template title).
    expect(
      download.suggestedFilename(),
    ).toBe('e2e-export-template.json')

    // The attachment is the version-1 portable
    // document: every section in canonical order
    // with exactly the portable fields.
    const filePath =
      await download.path()
    expect(filePath).toBeTruthy()

    const document = JSON.parse(
      await fs.readFile(filePath, 'utf8'),
    )
    expect(document).toEqual({
      schemaVersion: 1,
      sections: [
        {
          name: 'Check-In',
          description: '',
          isActive: true,
        },
        {
          name: 'Research',
          description: '',
          isActive: true,
        },
      ],
    })

    // --------------------------------------------------------
    // 4. The Template page and agenda stay intact
    //    after the export.
    // --------------------------------------------------------

    await expect(
      page.getByRole('heading', {
        name: 'Template Structure',
      }),
    ).toBeVisible()

    await expect(
      page.locator('span.font-semibold', {
        hasText: /^Check-In$/,
      }),
    ).toBeVisible()

    await expect(
      page.locator('span.font-semibold', {
        hasText: /^Research$/,
      }),
    ).toBeVisible()

    await expect(exportButton).toBeEnabled()
  },
)

test(
  'Meeting Template agenda export: idle, pending, and error states at desktop and mobile widths',
  async ({ page }, testInfo) => {
    await login(page, 'alex')

    await createExportTemplate(
      page,
      ['Check-In'],
    )

    const exportButton = page.getByRole(
      'button',
      { name: 'Export agenda JSON' },
    )

    await expect(exportButton).toBeVisible()

    const desktop = {
      width: 1280,
      height: 800,
    }
    const mobile = {
      width: 390,
      height: 844,
    }

    const capture = async (
      label: string,
    ) => {
      const buffer =
        await page.screenshot()
      await testInfo.attach(
        label,
        {
          body: buffer,
          contentType: 'image/png',
        },
      )
    }

    // --------------------------------------------------------
    // Idle state at desktop and mobile widths.
    // --------------------------------------------------------

    page.setViewportSize(desktop)
    await capture('desktop-idle')

    page.setViewportSize(mobile)
    await capture('mobile-idle')

    // --------------------------------------------------------
    // Pending state: a delayed export response keeps
    // the control disabled with a visible pending
    // label.
    // --------------------------------------------------------

    await page.route(
      '**/agenda-export.json',
      async (route) => {
        await new Promise(
          (resolve) =>
            setTimeout(resolve, 1500),
        )
        await route.continue()
      },
    )

    page.setViewportSize(desktop)
    await exportButton.click()

    const pendingButton = page.getByRole(
      'button',
      { name: 'Exporting…' },
    )
    await expect(pendingButton).toBeVisible()
    await expect(pendingButton).toBeDisabled()
    await capture('desktop-pending')

    page.setViewportSize(mobile)
    await capture('mobile-pending')

    // The delayed export completes and re-enables
    // the control.
    await expect(exportButton).toBeVisible()
    await expect(exportButton).toBeEnabled()

    // --------------------------------------------------------
    // Error state: a failed export keeps the page
    // unchanged and surfaces concise recoverable
    // inline feedback.
    // --------------------------------------------------------

    await page.route(
      '**/agenda-export.json',
      (route) =>
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Agenda export failed.',
          }),
        }),
    )

    page.setViewportSize(desktop)
    await exportButton.click()

    await expect(
      page.getByRole('alert'),
    ).toHaveText('Agenda export failed.')
    await capture('desktop-error')

    // The agenda is unchanged and the control
    // is retryable.
    await expect(
      page.locator('span.font-semibold', {
        hasText: /^Check-In$/,
      }),
    ).toBeVisible()
    await expect(exportButton).toBeEnabled()

    page.setViewportSize(mobile)
    await capture('mobile-error')

    await page.unroute(
      '**/agenda-export.json',
    )
  },
)
