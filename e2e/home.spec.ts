import {
  expect,
  test,
  type Page,
} from '@playwright/test'

import { login } from './helpers'

const MEETING_TITLE = 'E2E Home Weekly'
const SEED_WORK_ITEM = 'First Draft Complete'

/** datetime-local value for 12:00 on the current local date. */
function todayNoon(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}T12:00`
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  )

  expect(overflow).toBeLessThanOrEqual(0)
}

async function createMeetingToday(page: Page) {
  await page
    .getByRole('link', { name: /Meetings/ })
    .click()

  await page
    .getByRole('button', { name: /New meeting/ })
    .click()

  const dialog = page.getByRole('dialog', {
    name: 'New meeting',
  })

  await dialog.getByLabel('Title').fill(MEETING_TITLE)
  await dialog.getByLabel('Date and time').fill(todayNoon())

  await page
    .locator('form')
    .getByRole('button', { name: /Create meeting/ })
    .click()

  await expect(page.getByText(MEETING_TITLE)).toBeVisible()
}

test('Home renders the four sections in order with seeded data', async ({
  page,
}, testInfo) => {
  await login(page, 'alex')

  // Login lands on the canonical Home route.
  await expect(page).toHaveURL(/\/$/)

  // Dark mode is the default theme.
  await expect(page.locator('html')).toHaveAttribute(
    'data-theme',
    'dark',
  )

  // Hierarchy: single page heading + the four sections in order,
  // Activity as a separate complementary rail.
  await expect(
    page.getByRole('heading', {
      name: 'Home',
      level: 1,
    }),
  ).toBeVisible()

  const sectionHeadings = page
    .getByRole('heading', { level: 2 })

  await expect(sectionHeadings).toHaveText([
    'Needs attention',
    'Today & next',
    'My work',
    'Continue working',
    'Activity',
  ])

  // Seeded overdue, assigned Work Item: the Needs attention row
  // shows the title, Project, due date, and the Overdue reason
  // (backend attentionReasons — not recomputed). The reason chip
  // also renders a Material symbol ligature, so match the user-
  // visible label within the row rather than as an exact page-
  // wide text node.
  const needsAttention = page.getByRole('region', {
    name: 'Needs attention',
  })

  await expect(
    needsAttention.getByRole('button', {
      name: /First Draft Complete/,
    }),
  ).toBeVisible()
  await expect(
    needsAttention
      .getByRole('button', { name: /First Draft Complete/ })
      .getByText('Overdue'),
  ).toBeVisible()

  // The same Work Item is also an active My work row (intentional
  // overlap; each Home module answers a different question).
  await expect(
    page
      .getByRole('region', { name: 'My work' })
      .getByRole('button', {
        name: /First Draft Complete/,
      }),
  ).toBeVisible()

  // No Meetings exist yet: Today & next shows its stable empty
  // state.
  await expect(
    page
      .getByRole('region', { name: 'Today & next' })
      .getByText('Nothing upcoming in the current window.'),
  ).toBeVisible()

  // The canonical E2E seed (seed_e2e_scope) creates the "E2E
  // Analyze robot data" Task through the Work Item service, which
  // logs the creation event — the Activity rail is deterministically
  // populated, not empty.
  await expect(
    page
      .getByRole('complementary', { name: 'Activity' })
      .getByRole('button', { name: /E2E Analyze robot data/ }),
  ).toBeVisible()

  // Desktop two-area layout: main content dominates, Activity is a
  // secondary right rail.
  const mainBox = await needsAttention.boundingBox()
  const activityBox = await page
    .getByRole('complementary', { name: 'Activity' })
    .boundingBox()

  expect(mainBox).not.toBeNull()
  expect(activityBox).not.toBeNull()
  expect(activityBox!.x).toBeGreaterThan(mainBox!.x)
  expect(mainBox!.width).toBeGreaterThan(activityBox!.width)

  await expectNoHorizontalOverflow(page)

  await page.screenshot({
    path: testInfo.outputPath('home-desktop.png'),
    fullPage: true,
  })
})

test('Home meeting + work item navigation and independent Activity', async ({
  page,
}, testInfo) => {
  await login(page, 'alex')

  // Create a real Meeting scheduled for today through the canonical
  // Meeting flow (alex = creator => MEETING_READ).
  await createMeetingToday(page)

  // Return to Home (sidebar link; accessible name includes the
  // icon ligature text).
  await page.getByRole('link', { name: /Home/ }).click()

  await expect(
    page.getByRole('heading', {
      name: 'Home',
      level: 1,
    }),
  ).toBeVisible()

  // Today & next shows the Meeting candidate under the Today group
  // with its safe context label.
  const todayNext = page.getByRole('region', {
    name: 'Today & next',
  })

  await expect(
    todayNext.getByText('Today', { exact: true }),
  ).toBeVisible()
  await expect(
    todayNext.getByRole('button', {
      name: new RegExp(MEETING_TITLE),
    }),
  ).toBeVisible()
  await expect(
    todayNext.getByText('Research Group Meeting'),
  ).toBeVisible()

  // Continue working independently surfaces the personally created
  // Meeting with a relative recency label (not "last opened").
  // Scope the recency assertion to the Meeting row: the seeded Work
  // Item row carries its own recency label.
  const continueWorking = page.getByRole('region', {
    name: 'Continue working',
  })

  const continueMeetingRow = continueWorking.getByRole('button', {
    name: new RegExp(MEETING_TITLE),
  })

  await expect(continueMeetingRow).toBeVisible()
  await expect(
    continueMeetingRow.getByText(/Just now|now/i),
  ).toBeVisible()

  // The Activity rail (independent request) shows the creation
  // event with actor + verb semantics.
  const activity = page.getByRole('complementary', {
    name: 'Activity',
  })

  const meetingActivityRow = activity.getByRole('button', {
    name: new RegExp(MEETING_TITLE),
  })

  await expect(meetingActivityRow).toBeVisible()
  await expect(meetingActivityRow).toHaveText(/Alex Dev created/)

  // Meeting row -> canonical Meeting detail route.
  await todayNext
    .getByRole('button', {
      name: new RegExp(MEETING_TITLE),
    })
    .click()

  await expect(page).toHaveURL(/\/meetings\/\d+$/)
  await expect(
    page.getByRole('heading', {
      name: MEETING_TITLE,
      level: 1,
    }),
  ).toBeVisible()

  // Back to Home: Work Item row -> canonical Project Work Items
  // surface.
  await page.getByRole('link', { name: /Home/ }).click()

  const needsAttention = page.getByRole('region', {
    name: 'Needs attention',
  })

  await needsAttention
    .getByRole('button', {
      name: /First Draft Complete/,
    })
    .click()

  await expect(page).toHaveURL(
    /\/projects\/\d+\/work-items$/,
  )

  await expectNoHorizontalOverflow(page)

  await page.screenshot({
    path: testInfo.outputPath('home-populated-desktop.png'),
    fullPage: true,
  })
})

test('Home falls back to a single column on narrow widths', async ({
  page,
}, testInfo) => {
  await login(page, 'alex')

  // Below the two-column breakpoint the page stacks: main Home
  // content first, Activity after — no crushed main column.
  await page.setViewportSize({
    width: 1024,
    height: 768,
  })

  await expect(
    page.getByRole('heading', {
      name: 'Home',
      level: 1,
    }),
  ).toBeVisible()

  const mainBox = await page
    .getByRole('region', { name: 'Needs attention' })
    .boundingBox()
  const activityBox = await page
    .getByRole('complementary', { name: 'Activity' })
    .boundingBox()

  expect(mainBox).not.toBeNull()
  expect(activityBox).not.toBeNull()

  // Stacked: the Activity rail starts below the main content and
  // shares its left edge (full column width).
  expect(activityBox!.y).toBeGreaterThan(mainBox!.y + mainBox!.height - 1)
  expect(Math.abs(activityBox!.x - mainBox!.x)).toBeLessThanOrEqual(1)

  // Rows remain readable: the Work Item title is visible and not
  // clipped to nothing.
  await expect(
    page
      .getByRole('region', { name: 'Needs attention' })
      .getByRole('button', {
        name: /First Draft Complete/,
      }),
  ).toBeVisible()

  await expectNoHorizontalOverflow(page)

  await page.screenshot({
    path: testInfo.outputPath('home-narrow.png'),
    fullPage: true,
  })
})
