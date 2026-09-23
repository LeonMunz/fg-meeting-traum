import {
  expect,
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

  // The inline composer stays open after a successful submit (its
  // input is cleared for the next item). If it is already open for
  // this exact section, reuse it; otherwise open it via the
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
  await page
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
