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

  // Hierarchy: single page heading + the three primary sections
  // in order, Activity as a separate complementary rail.
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
    'Continue working',
    'Activity',
  ])

  // The full My Work list no longer lives on Home.
  await expect(
    page.getByRole('heading', {
      name: 'My work',
      level: 2,
    }),
  ).not.toBeVisible()

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

  // Needs attention is capped at three visible rows.
  const attentionRows = needsAttention.getByRole('button')
  await expect(attentionRows).not.toHaveCount(0)
  expect(
    await attentionRows.count(),
  ).toBeLessThanOrEqual(3)

  // No Meetings exist yet: Today & next shows its compact empty
  // line, and the timeline is capped at five visible rows.
  const todayNext = page.getByRole('region', {
    name: 'Today & next',
  })

  await expect(
    todayNext.getByText(
      'Nothing upcoming in the current window.',
    ),
  ).toBeVisible()
  expect(
    await todayNext.getByRole('button').count(),
  ).toBeLessThanOrEqual(5)

  // Continue working is capped at four visible rows.
  const continueRows = page
    .getByRole('region', { name: 'Continue working' })
    .getByRole('button')
  expect(
    await continueRows.count(),
  ).toBeLessThanOrEqual(4)

  // The canonical E2E seed (seed_e2e_scope) creates the "E2E
  // Analyze robot data" Task through the Work Item service, which
  // logs the creation event — the Activity rail is deterministically
  // populated, not empty.
  await expect(
    page
      .getByRole('complementary', { name: 'Activity' })
      .getByRole('button', { name: /E2E Analyze robot data/ }),
  ).toBeVisible()

  // Desktop two-area layout: the primary column dominates, Activity
  // is a secondary right rail.
  const activityHeadingBox = await page
    .getByRole('complementary', { name: 'Activity' })
    .getByRole('heading', { name: 'Activity' })
    .boundingBox()

  // Measure the primary column extent across its sections.
  const sectionNames = [
    'Needs attention',
    'Today & next',
    'Continue working',
  ]

  let primaryRight = 0
  let primaryLeft = Infinity
  for (const name of sectionNames) {
    const box = await page
      .getByRole('region', { name })
      .boundingBox()

    if (box) {
      primaryRight = Math.max(primaryRight, box.x + box.width)
      primaryLeft = Math.min(primaryLeft, box.x)
    }
  }

  expect(activityHeadingBox).not.toBeNull()
  expect(primaryRight).toBeGreaterThan(0)
  expect(activityHeadingBox!.x).toBeGreaterThan(primaryLeft)
  // The primary column is wider than the Activity rail.
  expect(
    primaryRight - primaryLeft,
  ).toBeGreaterThan(activityHeadingBox!.width)

  // Sticky rail: scrolling the primary column keeps the Activity
  // rail (and its header) visible.
  await page.evaluate(() => window.scrollBy(0, 400))
  await expect(
    page
      .getByRole('complementary', { name: 'Activity' })
      .getByRole('heading', { name: 'Activity' }),
  ).toBeInViewport()

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

  // The event reads as actor + verb + object on the primary line,
  // with the context + time metadata line below it.
  await expect(meetingActivityRow).toHaveText(
    /Alex Dev created E2E Home Weekly/,
  )
  // Secondary line semantics: the Research Group context + the
  // relative time render together on the same row.
  await expect(meetingActivityRow).toHaveText(
    /FG Example · (Just now|\d+ [mhd])/,
  )

  // Activity row -> canonical Meeting detail route (Activity
  // navigation keeps its canonical target).
  await meetingActivityRow.click()

  await expect(page).toHaveURL(/\/meetings\/\d+$/)

  await page.getByRole('link', { name: /Home/ }).click()

  await expect(
    page.getByRole('heading', {
      name: 'Home',
      level: 1,
    }),
  ).toBeVisible()

  // Meeting row (Today & next) -> canonical Meeting detail route.
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

test('Home stacks primary over Activity on narrow widths', async ({
  page,
}, testInfo) => {
  await login(page, 'alex')

  // Below the two-column breakpoint the page stacks: the main
  // column first, Activity after it — no crushed main column.
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

  const attentionBox = await page
    .getByRole('region', { name: 'Needs attention' })
    .boundingBox()
  const activityBox = await page
    .getByRole('complementary', { name: 'Activity' })
    .boundingBox()

  expect(attentionBox).not.toBeNull()
  expect(activityBox).not.toBeNull()

  // Stacked: Activity starts below the primary content and shares
  // its left edge (full column width).
  expect(
    activityBox!.y,
  ).toBeGreaterThan(attentionBox!.y + attentionBox!.height - 1)
  expect(
    Math.abs(activityBox!.x - attentionBox!.x),
  ).toBeLessThanOrEqual(1)

  // The stacked Activity section is no longer a constrained sticky
  // rail: no independent internal scroll container.
  const activityHasConstrainedScroll = await page
    .getByRole('complementary', { name: 'Activity' })
    .evaluate((root) =>
      Array.from(root.querySelectorAll('*')).some((el) => {
        const style = getComputedStyle(el)
        return (
          style.overflowY === 'auto' ||
          style.overflowY === 'scroll'
        )
      }),
    )

  expect(activityHasConstrainedScroll).toBe(false)

  // Rows remain readable: the Work Item title is visible and the
  // row keeps a tappable height.
  const attentionRow = page
    .getByRole('region', { name: 'Needs attention' })
    .getByRole('button', {
      name: /First Draft Complete/,
    })
  await expect(attentionRow).toBeVisible()
  const rowBox = await attentionRow.boundingBox()
  expect(rowBox).not.toBeNull()
  expect(rowBox!.height).toBeGreaterThanOrEqual(44)

  await expectNoHorizontalOverflow(page)

  await page.screenshot({
    path: testInfo.outputPath('home-narrow.png'),
    fullPage: true,
  })

  // Mobile-like width: still stacked, readable, no overflow.
  await page.setViewportSize({
    width: 390,
    height: 844,
  })

  await expect(
    page.getByRole('heading', {
      name: 'Home',
      level: 1,
    }),
  ).toBeVisible()
  await expect(attentionRow).toBeVisible()

  const mobileAttentionBox = await page
    .getByRole('region', { name: 'Needs attention' })
    .boundingBox()
  const mobileActivityBox = await page
    .getByRole('complementary', { name: 'Activity' })
    .boundingBox()

  expect(mobileAttentionBox).not.toBeNull()
  expect(mobileActivityBox).not.toBeNull()
  expect(
    mobileActivityBox!.y,
  ).toBeGreaterThan(mobileAttentionBox!.y)

  // Stacked Activity is a full-width section, not a narrow rail.
  expect(mobileActivityBox!.width).toBeGreaterThanOrEqual(
    mobileAttentionBox!.width - 1,
  )

  await expectNoHorizontalOverflow(page)

  await page.screenshot({
    path: testInfo.outputPath('home-mobile.png'),
    fullPage: true,
  })
})
