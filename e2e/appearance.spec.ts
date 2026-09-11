import {
  expect,
  test,
} from '@playwright/test'

import { login } from './helpers'

const storageKey = 'fg-workspace.appearance'

async function expectAppearance(
  page: import('@playwright/test').Page,
  appearance: 'dark' | 'light',
) {
  await expect(page.locator('html')).toHaveAttribute(
    'data-theme',
    appearance,
  )

  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).colorScheme,
      ),
    )
    .toBe(appearance)
}

test('Appearance defaults to Dark and persists both explicit choices', async ({
  page,
}, testInfo) => {
  await page.goto('/login')
  await page.evaluate((key) => localStorage.removeItem(key), storageKey)
  await page.reload()

  await expectAppearance(page, 'dark')

  await login(page, 'alex')

  await page
    .getByRole('link', {
      name: /Settings/,
    })
    .click()

  const appearance = page.getByRole('radiogroup', {
    name: 'Appearance',
  })

  await expect(appearance.getByRole('radio')).toHaveCount(2)
  await expect(
    appearance.getByRole('radio', { name: /Dark/ }),
  ).toBeChecked()

  await page.screenshot({
    path: testInfo.outputPath('appearance-dark.png'),
    fullPage: true,
  })

  await appearance.getByRole('radio', { name: /Light/ }).click()
  await expectAppearance(page, 'light')
  await expect(
    appearance.getByRole('radio', { name: /Light/ }),
  ).toBeChecked()
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey))
    .toBe('light')

  await page.reload()
  await expectAppearance(page, 'light')

  await page.screenshot({
    path: testInfo.outputPath('appearance-light.png'),
    fullPage: true,
  })

  await page.getByRole('radio', { name: /Dark/ }).click()
  await expectAppearance(page, 'dark')

  await page.reload()
  await expectAppearance(page, 'dark')
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey))
    .toBe('dark')
})
