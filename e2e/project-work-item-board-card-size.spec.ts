import {
  expect,
  type Page,
  test,
} from '@playwright/test'

import {
  login,
  openProject,
  openProjects,
} from './helpers'

// Focused regression: Project Board Work Item cards keep fixed
// outer dimensions for any title length.
//
// Three fixture titles exercise the three required shapes:
//   1. a normal short title (the reference layout),
//   2. a long title with spaces (used to wrap to multiple lines
//      and grow the card height),
//   3. a very long unbroken string (used to inflate the board
//      grid's intrinsic width and widen every column).
//
// All three cards must end up with identical outer dimensions,
// the title must render on exactly one visual line with an
// ellipsis, the three-dot action menu must stay visible and
// right-aligned, the footer must keep its position, and opening
// a card must still expose the complete underlying title.

test.use({ viewport: { width: 1920, height: 1000 } })

const PROJECT_NAME = 'E2E Board Card Fixed Size Project'
const SHORT_TITLE = 'Short title'
const LONG_SPACED_TITLE =
  'Investigate interoperability findings from the quarterly ' +
  'cross-institution research data exchange pilot program'
// 100 characters, no spaces: far wider than a standard column.
const LONG_UNBROKEN_TITLE =
  'interoperabilitaetsuntersuchungsergebnisberichtedatenvergleichsprotokolldokumentationsergebnisse2026'

const TITLES = [
  SHORT_TITLE,
  LONG_SPACED_TITLE,
  LONG_UNBROKEN_TITLE,
] as const

function boardCard(page: Page, title: string) {
  return page
    .locator('[data-board-column="todo"]')
    .getByRole('button', { name: `Open ${title}` })
}

async function cardBox(page: Page, title: string) {
  const box = await boardCard(page, title).boundingBox()
  expect(box, `Board card for "${title}" must be visible`).not.toBeNull()
  return box as { x: number; y: number; width: number; height: number }
}

async function createWorkItem(page: Page, title: string) {
  await page
    .getByRole('button', { name: /New work item/ })
    .click()

  const dialog = page.getByRole('dialog', { name: 'New work item' })

  await dialog.getByLabel('Title').fill(title)

  await dialog
    .getByRole('button', { name: /Create work item/ })
    .click()

  await expect(dialog).not.toBeVisible()
  await expect(boardCard(page, title)).toBeVisible()
}

test('Project Board cards keep fixed size and truncate long titles', async ({
  page,
}) => {
  await login(page, 'alex')
  await openProjects(page)

  await page.getByRole('button', { name: /New project/ }).click()

  const createProjectDialog = page.getByRole('dialog', {
    name: 'Create project',
  })
  await createProjectDialog
    .getByLabel('Project name')
    .fill(PROJECT_NAME)
  await createProjectDialog
    .getByRole('button', { name: /Create project/ })
    .click()
  await expect(
    page.getByText(PROJECT_NAME, { exact: true }),
  ).toBeVisible()

  await openProject(page, PROJECT_NAME)

  for (const title of TITLES) {
    await createWorkItem(page, title)
  }

  // The board itself must not grow beyond its scroll container:
  // long title content may never inflate the grid's intrinsic
  // width (that would widen every column, not just one card).
  const boardGeometry = await page
    .locator('[data-board-column]')
    .first()
    .evaluate((column) => {
      const grid = column.parentElement
      const scroller = grid?.parentElement
      return {
        scrollerClientWidth: scroller?.clientWidth ?? -1,
        scrollerScrollWidth: scroller?.scrollWidth ?? -1,
      }
    })

  expect(
    boardGeometry.scrollerScrollWidth,
    'the board must not overflow horizontally because of a long title',
  ).toBeLessThanOrEqual(boardGeometry.scrollerClientWidth + 1)

  // 1. All three cards have identical outer dimensions.
  const shortBox = await cardBox(page, SHORT_TITLE)
  const spacedBox = await cardBox(page, LONG_SPACED_TITLE)
  const unbrokenBox = await cardBox(page, LONG_UNBROKEN_TITLE)

  expect(
    Math.abs(shortBox.width - spacedBox.width),
    `card width must not change for "${LONG_SPACED_TITLE.slice(0, 30)}…"`,
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs(shortBox.width - unbrokenBox.width),
    'card width must not change for the unbroken title',
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs(shortBox.height - spacedBox.height),
    `card height must not change for "${LONG_SPACED_TITLE.slice(0, 30)}…"`,
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs(shortBox.height - unbrokenBox.height),
    'card height must not change for the unbroken title',
  ).toBeLessThanOrEqual(1)

  // 2. Long titles render on exactly one visual line and truncate
  //    with a visible ellipsis.
  for (const title of [LONG_SPACED_TITLE, LONG_UNBROKEN_TITLE]) {
    const metrics = await boardCard(page, title)
      .locator('h3')
      .evaluate((heading) => {
        const el = heading as HTMLElement
        const css = window.getComputedStyle(heading)
        return {
          whiteSpace: css.whiteSpace,
          overflowX: css.overflowX,
          textOverflow: css.textOverflow,
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          offsetHeight: el.offsetHeight,
        }
      })

    expect(metrics.whiteSpace).toBe('nowrap')
    expect(metrics.overflowX).toBe('hidden')
    expect(metrics.textOverflow).toBe('ellipsis')
    // The stored title is genuinely longer than the visible box,
    // so the ellipsis is actually rendered (not just styled).
    expect(
      metrics.scrollWidth,
      'the title must overflow the visible title box',
    ).toBeGreaterThan(metrics.clientWidth)
    // Exactly one visual line (leading-5 = 20px), never wrapped.
    expect(metrics.offsetHeight).toBeGreaterThanOrEqual(19)
    expect(metrics.offsetHeight).toBeLessThanOrEqual(21)
  }

  // 3. The three-dot action menu stays visible and its right edge
  //    is aligned across all three cards (never pushed by the title).
  let menuRightEdge: number | null = null
  for (const title of TITLES) {
    const menu = boardCard(page, title).getByRole('button', {
      name: 'Work item actions',
    })
    await expect(
      menu,
      `action menu for "${title.slice(0, 30)}" must be visible`,
    ).toBeVisible()
    const box = (await menu.boundingBox()) as {
      x: number
      width: number
    }
    const rightEdge = box.x + box.width
    if (menuRightEdge === null) {
      menuRightEdge = rightEdge
      continue
    }
    expect(
      Math.abs(menuRightEdge - rightEdge),
      `action menu must stay right-aligned for "${title.slice(0, 30)}"`,
    ).toBeLessThanOrEqual(1)
  }

  // 4. The footer (assignee row) sits at the same offset below the
  //    card top for all three cards.
  let footerOffset: number | null = null
  for (const title of TITLES) {
    const card = await cardBox(page, title)
    const footer = (await boardCard(
      page,
      title,
    ).getByText('Unassigned').boundingBox()) as { y: number }
    const offset = footer.y - card.y
    if (footerOffset === null) {
      footerOffset = offset
      continue
    }
    expect(
      Math.abs(footerOffset - offset),
      `footer must stay put for "${title.slice(0, 30)}"`,
    ).toBeLessThanOrEqual(1)
  }

  // 5. Opening a long-titled card still exposes the complete title.
  await boardCard(page, LONG_UNBROKEN_TITLE).click()

  const drawer = page.getByRole('region', { name: 'Work item', exact: true })
  await expect(drawer).toBeVisible()
  await expect(
    drawer.getByRole('button', {
      name: LONG_UNBROKEN_TITLE,
      exact: true,
    }),
  ).toBeVisible()
})
