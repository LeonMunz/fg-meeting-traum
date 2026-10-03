import {
  expect,
  type Locator,
  type Page,
} from '@playwright/test'

export const PASSWORD = 'DevPass1!'

/**
 * The redesigned Meeting Detail uses an inline quick-add: a quiet
 * "+ Add item" button expands into a title input (required field)
 * plus Add / Cancel. Enter also submits.
 */
export async function quickAddAgendaItem(
  page: Page,
  title: string,
  sectionName = 'Agenda',
) {
  // The Meeting Section's accessible name is the section heading
  // text; scoping by the exact section text targets that one
  // section (no other element carries the section name).
  const section = page
    .locator('section')
    .filter({ hasText: sectionName })

  const input = page.getByLabel(`Add item to ${sectionName}`)

  // The inline composer collapses after a successful submit and
  // stays open after a failed one. If it is already open for this
  // exact section, reuse it; otherwise open it via the
  // 'Add item' / 'Add first item' trigger (the trigger is hidden
  // while the composer is open).
  const addButton = section
    .getByRole('button', { name: 'Add item', exact: true })
    .or(
      section.getByRole('button', {
        name: 'Add first item',
        exact: true,
      }),
    )

  if (await input.isVisible().catch(() => false)) {
    // Composer already open: use it directly.
  } else {
    await addButton.scrollIntoViewIfNeeded()
    await addButton.click()
    await input.waitFor({ state: 'visible' })
  }

  await input.fill(title)

  // The quick-add form's submit is 'Add'; scope it to the form so
  // the participant panel's separate 'Add' button is never matched.
  await section
    .getByRole('button', { name: 'Add', exact: true })
    .click()

  // The newly created item title is visible inside this section.
  await expect(
    section.getByText(title, { exact: true }),
  ).toBeVisible()
}

/**
 * Create a global account invitation through the existing backend
 * API using the browser's own authenticated session (the invitation
 * surface is the user menu / settings, not a dedicated page flow in
 * these scenarios). Returns the one-time raw token from the
 * creation response.
 */
export async function createAccountInvitation(
  page: Page,
  targetEmail: string,
): Promise<string> {
  const created = await page.evaluate(
    async (email) => {
      let csrf = document.cookie
        .split(';')
        .map((c) => c.trim())
        .find((c) => c.startsWith('csrftoken='))
        ?.split('=')[1]

      if (!csrf) {
        await fetch('/api/auth/csrf/', { credentials: 'same-origin' })
        csrf = document.cookie
          .split(';')
          .map((c) => c.trim())
          .find((c) => c.startsWith('csrftoken='))
          ?.split('=')[1]
      }

      const res = await fetch('/api/account-invitations/', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-CSRFToken': csrf ?? '',
        },
        body: JSON.stringify({ targetEmail: email }),
      })

      return { status: res.status, data: await res.json() }
    },
    targetEmail,
  )

  expect(created.status).toBe(201)
  expect(typeof created.data.token).toBe('string')
  return created.data.token as string
}

/**
 * Seeded E2E accounts carry a first_name that capitalizes the username
 * (alex -> Alex, ...). Newly registered accounts have no first_name and
 * are displayed by their username.
 */
export function displayNameFor(username: string): string {
  return username.charAt(0).toUpperCase() + username.slice(1)
}

/**
 * The authenticated topbar's user menu trigger, addressed by its
 * accessibility contract: the account menu button's accessible name is
 * the current user's display name (first name, falling back to
 * username). This is unique on every page — feature headers (Meeting
 * actions, New project, ...) never carry the account name — so it stays
 * unambiguous regardless of which page the test runs on.
 */
export function userMenuTrigger(
  page: Page,
  displayName: string,
) {
  return page.getByRole('button', {
    name: displayName,
    exact: true,
  })
}

export async function login(
  page: Page,
  username: string,
) {
  await page.goto('/login')

  await page
    .getByLabel('Username')
    .fill(username)

  await page
    .getByLabel('Password', { exact: true })
    .fill(PASSWORD)

  await page
    .getByRole('button', {
      name: /Sign in/,
    })
    .click()

  await expect(
    userMenuTrigger(
      page,
      displayNameFor(username),
    ),
  ).toBeVisible()
}

export async function logout(
  page: Page,
  displayName: string,
) {
  await userMenuTrigger(page, displayName).click()

  await page
    .getByRole('menuitem', {
      name: 'Sign out',
    })
    .click()

  await expect(
    page.getByLabel('Username'),
  ).toBeVisible()
}

export async function openProjects(
  page: Page,
) {
  // The workspace tree keeps the active group's child destinations
  // behind its disclosure control: reveal the active group first,
  // then take the Projects child. The link is scoped to the active
  // group's node so other expanded groups can never make it
  // ambiguous.
  const activeRow = page
    .locator(
      'nav[aria-label="Research groups"] button[aria-current="true"]',
    )
    .locator('..')
    .locator('..')

  await expect(activeRow).toBeVisible()

  const chevron = activeRow.getByRole('button', {
    name: /^Expand /,
  })

  if (await chevron.isVisible()) {
    await chevron.click()
  }

  await activeRow
    .getByRole('link', {
      name: /Projects/,
    })
    .click()

  await expect(page).toHaveURL(
    /\/projects\?group=\d+$/,
  )
}

/**
 * The workspace tree renders Research Group rows collapsed by
 * default: the manual expansion state is a persisted personal
 * preference, and the E2E reset starts without one. Expands the
 * named group's row when its manual state is still collapsed so
 * the spec can reach the group's child destinations (Projects /
 * Meetings). Idempotent: a group that is already manually
 * expanded (or only contextually revealed by the route) is left
 * untouched.
 */
export async function expandResearchGroup(
  page: Page,
  groupName: string,
) {
  // The tree hydrates asynchronously (group + preference GET);
  // wait until the group node actually renders.
  await expect(
    page.getByRole('group', {
      name: groupName,
    }),
  ).toBeVisible()

  const chevron = page.getByRole('button', {
    name: `Expand ${groupName}`,
  })

  if (await chevron.isVisible()) {
    await chevron.click()

    await expect(
      page.getByRole('button', {
        name: `Collapse ${groupName}`,
      }),
    ).toHaveAttribute('aria-expanded', 'true')
  }
}

/**
 * Navigates to a Research Group's Meetings child destination via
 * the workspace tree (expanding the group first when needed).
 * The link is scoped to the group's node so other expanded
 * groups can never make it ambiguous.
 */
export async function openGroupMeetings(
  page: Page,
  groupName: string,
) {
  await expandResearchGroup(page, groupName)

  await page
    .getByRole('group', {
      name: groupName,
    })
    .getByRole('link', {
      name: /Meetings/,
    })
    .click()
}

/**
 * Navigates to a Research Group's Projects child destination via
 * the workspace tree (expanding the group first when needed).
 * The link is scoped to the group's node so other expanded
 * groups can never make it ambiguous.
 */
export async function openGroupProjects(
  page: Page,
  groupName: string,
) {
  await expandResearchGroup(page, groupName)

  await page
    .getByRole('group', {
      name: groupName,
    })
    .getByRole('link', {
      name: /Projects/,
    })
    .click()

  await expect(page).toHaveURL(
    /\/projects\?group=\d+$/,
  )
}
export async function openProject(
  page: Page,
  projectName: string,
) {
  const projectLink = page
    .getByRole('link')
    .filter({
      hasText: projectName,
    })

  await expect(projectLink).toBeVisible()
  await projectLink.click()

  await expect(page).toHaveURL(
    /\/projects\/\d+\/work-items$/,
  )

  await expect(
    page.getByText(
      projectName,
      { exact: true },
    ).first(),
  ).toBeVisible()
}

/**
 * Replaces the complete value of a prefilled, focus-controlled schedule
 * control (the Meeting create dialog's Date and Time fields).
 *
 * Those controls start prefilled with a valid canonical default and
 * switch between the locale display and the canonical editing form on
 * focus. A one-step `fill()` from the unfocused prefilled state races
 * the focus-driven rerender: the replacement text can be appended to
 * the existing canonical value (e.g. `2026-09-29` becomes
 * `2026-09-292026-10-06`), leaving the field invalid and the
 * `Create meeting` submit disabled.
 *
 * This helper therefore enters the control's focused editing state with
 * an explicit click first (the focus rerender commits before the
 * replacement starts), replaces the complete current value, and asserts
 * the resulting canonical value exactly.
 */
export async function replaceControlValue(
  control: Locator,
  value: string,
) {
  await control.click()
  await control.fill(value)
  await expect(control).toHaveValue(value)
}

/**
 * Local calendar date (`YYYY-MM-DD`) `days` days after today. The
 * Upcoming view only shows effective meetings inside the canonical
 * initial window (local today → +42 days), so E2E fixtures that must
 * appear in the Meetings overview derive their date from the current
 * date instead of hard-coding a far-future day.
 */
export function datePartPlusDays(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
