import {
  expect,
  test,
  type Page,
} from '@playwright/test'

import { login } from './helpers'

const TEMPLATE_TITLE =
  'E2E Import Template'

// The version-1 portable agenda document the browser uploads.
const importDocument = {
  schemaVersion: 1,
  sections: [
    {
      name: 'Alpha',
      description: '',
      isActive: true,
    },
    {
      name: 'Beta',
      description: '',
      isActive: true,
    },
  ],
}

const filePayload = () => ({
  name: 'agenda.json',
  mimeType: 'application/json',
  buffer: Buffer.from(
    JSON.stringify(importDocument),
  ),
})

/**
 * Create a disposable group-scoped Meeting Template with the
 * given Section names and land on its detail page.
 */
async function createImportTemplate(
  page: Page,
  sectionNames: string[],
) {
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

  await expect(page).toHaveURL(
    /\/meetings\/series\/\d+$/,
  )

  for (
    let index = 0;
    index < sectionNames.length;
    index += 1
  ) {
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
  'Meeting Template agenda JSON import replaces the complete agenda only after confirmation',
  async ({ page }) => {
    await login(page, 'alex')

    // --------------------------------------------------------
    // 1. Create a disposable template with two sections.
    // --------------------------------------------------------

    await createImportTemplate(
      page,
      ['Check-In', 'Research'],
    )

    let importRequests = 0
    page.on('request', (request) => {
      if (
        request
          .url()
          .includes('/agenda-import.json')
      ) {
        importRequests += 1
      }
    })

    const importInput =
      page.locator('input[type="file"]')

    // The write affordance is a single file input, present
    // for a manager.
    await expect(importInput).toHaveCount(1)

    // --------------------------------------------------------
    // 2. Cancellation: selecting a file opens a named
    //    confirmation; cancelling makes no request and
    //    leaves the agenda unchanged.
    // --------------------------------------------------------

    await importInput.setInputFiles(
      filePayload(),
    )

    const dialog = page.getByRole(
      'dialog',
      { name: 'Replace agenda?' },
    )
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(
      TEMPLATE_TITLE,
    )
    await expect(dialog).toContainText(
      'replaces the complete existing agenda',
    )
    expect(importRequests).toBe(0)

    await dialog
      .getByRole('button', {
        name: 'Cancel',
      })
      .click()

    await expect(dialog).toBeHidden()
    expect(importRequests).toBe(0)

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

    // --------------------------------------------------------
    // 3. Confirmation: exactly one import request; the page
    //    refreshes to the imported order and the Template
    //    identity stays unchanged.
    // --------------------------------------------------------

    await importInput.setInputFiles(
      filePayload(),
    )
    await expect(dialog).toBeVisible()

    await dialog
      .getByRole('button', {
        name: 'Replace agenda',
      })
      .click()

    await expect
      .poll(() => importRequests)
      .toBe(1)

    await expect(dialog).toBeHidden()

    // The imported sections replace the complete prior
    // agenda, in the document's order.
    await expect(
      page.locator('span.font-semibold', {
        hasText: /^Alpha$/,
      }),
    ).toBeVisible()
    await expect(
      page.locator('span.font-semibold', {
        hasText: /^Beta$/,
      }),
    ).toBeVisible()
    await expect(
      page.locator('span.font-semibold', {
        hasText: /^Check-In$/,
      }),
    ).toHaveCount(0)
    await expect(
      page.locator('span.font-semibold', {
        hasText: /^Research$/,
      }),
    ).toHaveCount(0)

    // Template identity is preserved.
    await expect(
      page.getByText(
        `${TEMPLATE_TITLE}. Edit the default sections for this meeting template. New occurrences will snapshot these sections.`,
      ),
    ).toBeVisible()

    expect(importRequests).toBe(1)
  },
)

test(
  'Meeting Template agenda import: idle, confirmation, pending, and error states at desktop and mobile widths',
  async ({ page }, testInfo) => {
    await login(page, 'alex')

    await createImportTemplate(
      page,
      ['Check-In'],
    )

    const importInput =
      page.locator('input[type="file"]')
    await expect(importInput).toHaveCount(1)

    const dialog = page.getByRole(
      'dialog',
      { name: 'Replace agenda?' },
    )

    const desktop = { width: 1280, height: 800 }
    const mobile = { width: 390, height: 844 }

    const capture = async (label: string) => {
      const buffer = await page.screenshot()
      await testInfo.attach(label, {
        body: buffer,
        contentType: 'image/png',
      })
    }

    // Set the viewport and await the real condition before any
    // capture: the setViewportSize call itself is awaited (the
    // browser confirms the resize), the committed viewport size
    // is read back, and the page's actual layout-viewport width
    // is asserted behaviorally (polling until the resize is
    // observable, never a fixed sleep), so each artifact
    // reliably represents the named width.
    const setViewport = async (
      size: { width: number; height: number },
    ) => {
      await page.setViewportSize(size)
      expect(page.viewportSize()).toEqual(size)
      await expect
        .poll(() => page.evaluate(() => window.innerWidth))
        .toBe(size.width)
    }

    // --------------------------------------------------------
    // Idle state at desktop and mobile widths.
    // --------------------------------------------------------

    await setViewport(desktop)
    await capture('desktop-idle')
    await setViewport(mobile)
    await capture('mobile-idle')

    // --------------------------------------------------------
    // Confirmation state: the named replacement dialog.
    // --------------------------------------------------------

    await importInput.setInputFiles(
      filePayload(),
    )
    await expect(dialog).toBeVisible()

    await setViewport(desktop)
    await capture('desktop-confirmation')
    await setViewport(mobile)
    await capture('mobile-confirmation')

    await dialog
      .getByRole('button', {
        name: 'Cancel',
      })
      .click()
    await expect(dialog).toBeHidden()

    // --------------------------------------------------------
    // Error state: a failed import keeps the agenda
    // unchanged and surfaces retryable inline feedback.
    // --------------------------------------------------------

    await page.route(
      '**/agenda-import.json',
      (route) =>
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Agenda import failed.',
          }),
        }),
    )

    await importInput.setInputFiles(
      filePayload(),
    )
    await expect(dialog).toBeVisible()

    await setViewport(desktop)
    await dialog
      .getByRole('button', {
        name: 'Replace agenda',
      })
      .click()

    await expect(
      dialog.getByRole('alert'),
    ).toHaveText('Agenda import failed.')
    await capture('desktop-error')

    // The agenda is unchanged and the flow is retryable.
    await expect(
      page.locator('span.font-semibold', {
        hasText: /^Check-In$/,
      }),
    ).toBeVisible()

    await setViewport(mobile)
    await capture('mobile-error')

    await page.unroute('**/agenda-import.json')

    // --------------------------------------------------------
    // Pending state: a delayed import response keeps the
    // confirmation disabled with a visible pending label,
    // then completes and refreshes the agenda.
    // --------------------------------------------------------

    await page.route(
      '**/agenda-import.json',
      async (route) => {
        await new Promise(
          (resolve) =>
            setTimeout(resolve, 1500),
        )
        await route.continue()
      },
    )

    await importInput.setInputFiles(
      filePayload(),
    )
    await expect(dialog).toBeVisible()

    await setViewport(desktop)
    await dialog
      .getByRole('button', {
        name: 'Replace agenda',
      })
      .click()

    const pendingButton = dialog.getByRole(
      'button',
      { name: 'Importing…' },
    )
    await expect(pendingButton).toBeVisible()
    await expect(pendingButton).toBeDisabled()
    await capture('desktop-pending')

    await setViewport(mobile)
    await capture('mobile-pending')

    // The delayed import completes, closes the dialog, and
    // the agenda reflects the imported sections.
    await expect(dialog).toBeHidden()
    await expect(
      page.locator('span.font-semibold', {
        hasText: /^Alpha$/,
      }),
    ).toBeVisible()

    await page.unroute('**/agenda-import.json')
  },
)

test(
  'Meeting Template header actions fit within the 390px mobile content width',
  async ({ page }) => {
    await login(page, 'alex')

    await createImportTemplate(
      page,
      ['Check-In'],
    )

    // A manager sees all three header actions, so this is the
    // widest action-row case.
    await expect(
      page.getByRole('button', {
        name: 'Export agenda JSON',
      }),
    ).toBeVisible()
    await expect(
      page.locator('input[type="file"]'),
    ).toHaveCount(1)
    await expect(
      page.getByRole('button', {
        name: 'Template actions',
      }),
    ).toBeVisible()

    await page.setViewportSize({
      width: 390,
      height: 844,
    })
    // Behavioral confirmation that the 390px acceptance width
    // is actually applied to the page's layout viewport before
    // the overflow geometry is measured (polling, never a sleep).
    expect(page.viewportSize()).toEqual({
      width: 390,
      height: 844,
    })
    await expect
      .poll(() => page.evaluate(() => window.innerWidth))
      .toBe(390)

    const actionGroup = page
      .locator('div.ml-auto')
      .filter({
        has: page.getByRole('button', {
          name: 'Export agenda JSON',
        }),
      })
    await expect(actionGroup).toBeVisible()

    // The header action row must not overflow at 390px: the
    // group stays inside the detail page's actual content box
    // (its header spans the padded content column), every
    // visible action fits its own box without clipped
    // content, and no two actions overlap each other.
    const metrics = await actionGroup.evaluate(
      (groupEl) => {
        const headerEl =
          groupEl.closest('header') as HTMLElement
        const groupRect =
          groupEl.getBoundingClientRect()
        const headerRect =
          headerEl.getBoundingClientRect()
        const controls = Array.from(
          groupEl.children,
        ).map((child) => {
          const control =
            child instanceof HTMLButtonElement ||
            child instanceof HTMLLabelElement
              ? child
              : (
                  child.querySelector(
                    'button, label',
                  ) as HTMLElement
                )
          const rect = control.getBoundingClientRect()
          return {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            scrollWidth: control.scrollWidth,
            clientWidth: control.clientWidth,
            scrollHeight: control.scrollHeight,
            clientHeight: control.clientHeight,
          }
        })
        return {
          groupLeft: groupRect.left,
          groupRight: groupRect.right,
          headerLeft: headerRect.left,
          headerRight: headerRect.right,
          innerWidth: window.innerWidth,
          documentScrollWidth:
            document.documentElement.scrollWidth,
          controls,
        }
      },
    )

    // No page-level horizontal overflow at 390px.
    expect(
      metrics.documentScrollWidth,
    ).toBeLessThanOrEqual(metrics.innerWidth + 1)

    // The group is bounded by the actual page content box,
    // not merely the viewport edge.
    expect(metrics.groupLeft).toBeGreaterThanOrEqual(
      metrics.headerLeft - 1,
    )
    expect(metrics.groupRight).toBeLessThanOrEqual(
      metrics.headerRight + 1,
    )

    // All three manager actions are present and each fits
    // its own box (no clipped or overflowing content).
    expect(metrics.controls).toHaveLength(3)
    for (const control of metrics.controls) {
      expect(control.scrollWidth).toBeLessThanOrEqual(
        control.clientWidth + 1,
      )
      expect(control.scrollHeight).toBeLessThanOrEqual(
        control.clientHeight + 1,
      )
      expect(control.right).toBeLessThanOrEqual(
        metrics.headerRight + 1,
      )
    }

    // No two actions overlap each other (side by side or
    // wrapped onto separate lines).
    for (let i = 0; i < metrics.controls.length; i++) {
      for (let j = i + 1; j < metrics.controls.length; j++) {
        const a = metrics.controls[i]
        const b = metrics.controls[j]
        const overlaps =
          a.left < b.right - 1 &&
          b.left < a.right - 1 &&
          a.top < b.bottom - 1 &&
          b.top < a.bottom - 1
        expect(
          overlaps,
          'header actions must not overlap at 390px',
        ).toBe(false)
      }
    }
  },
)
