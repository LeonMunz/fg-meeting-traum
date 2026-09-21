import {
  expect,
  type Page,
} from '@playwright/test'

/**
 * Shared E2E harness for My Work preferences
 * (GET/PATCH /api/me/preferences/my-work/).
 *
 * My Work preferences are server-persistent personal view state. A fresh
 * browser context does NOT isolate them, and within one E2E run the
 * `fg_e2e` schema is only reset once (before the run), so every scenario
 * that renders from — or mutates — the preference state must establish a
 * known server-side baseline itself instead of relying on a previous
 * test's leftover state or execution order.
 *
 * The harness never invents a second preference truth: the snapshot
 * shape and the baseline mirror the canonical backend contract
 * (`default_my_work_snapshot()` in
 * `apps/api/work_items/my_work_preferences.py` — `viewMode` `board`
 * plus three empty filter arrays), and all setup/read operations go
 * through the existing production API with the browser's own
 * authenticated session.
 */

export type MyWorkPreferencesViewMode = 'board' | 'list'

/** The complete preference snapshot over the canonical API contract. */
export interface MyWorkPreferencesSnapshot {
  viewMode: MyWorkPreferencesViewMode
  researchGroupIds: number[]
  projectIds: number[]
  workItemTypes: string[]
}

/**
 * The canonical baseline snapshot: the real backend default for a user
 * with no preference row (Board view, no active filters). Every
 * migrated scenario seeds this state server-side before rendering, so
 * it starts from a known persisted state independent of test order.
 */
export const MY_WORK_PREFERENCES_BASELINE: MyWorkPreferencesSnapshot = {
  viewMode: 'board',
  researchGroupIds: [],
  projectIds: [],
  workItemTypes: [],
}

const PREFERENCES_PATHNAME = '/api/me/preferences/my-work/'

/** Order-insensitive ID-list comparison (the server sorts ID lists). */
function idListsEqual(
  a: readonly number[],
  b: readonly number[],
): boolean {
  const normalize = (list: readonly number[]) =>
    [...list].sort((x, y) => x - y).join(',')
  return normalize(a) === normalize(b)
}

/** Order-insensitive string-set comparison (filter semantics are set-like). */
function stringSetsEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  const normalize = (list: readonly string[]) =>
    [...new Set(list)].sort().join('|')
  return normalize(a) === normalize(b)
}

/**
 * Order-insensitive comparison of two complete preference snapshots.
 * The server returns ID lists sorted and `workItemTypes` in input
 * order; none of that ordering is part of the filter semantics.
 */
export function sameMyWorkPreferences(
  a: MyWorkPreferencesSnapshot,
  b: MyWorkPreferencesSnapshot,
): boolean {
  return (
    a.viewMode === b.viewMode &&
    idListsEqual(a.researchGroupIds, b.researchGroupIds) &&
    idListsEqual(a.projectIds, b.projectIds) &&
    stringSetsEqual(a.workItemTypes, b.workItemTypes)
  )
}

/**
 * Read the authenticated user's current preference snapshot from the
 * server (the authoritative persisted state).
 */
export async function getMyWorkPreferences(
  page: Page,
): Promise<MyWorkPreferencesSnapshot> {
  const response = await page.request.get(PREFERENCES_PATHNAME)
  expect(
    response.ok(),
    'Reading My Work preferences must succeed.',
  ).toBe(true)
  return (await response.json()) as MyWorkPreferencesSnapshot
}

/**
 * Deterministically persist a COMPLETE preference snapshot directly
 * through the production API (setup never goes through UI clicks).
 * Returns the normalized server snapshot (authoritative).
 */
export async function setMyWorkPreferences(
  page: Page,
  snapshot: MyWorkPreferencesSnapshot,
): Promise<MyWorkPreferencesSnapshot> {
  const response = await page.request.patch(PREFERENCES_PATHNAME, {
    data: snapshot,
    headers: {
      'X-CSRFToken': await ensureCsrfToken(page),
    },
  })
  expect(
    response.status(),
    'Persisting My Work preferences must succeed (a structurally valid complete snapshot is persisted atomically).',
  ).toBe(200)
  return (await response.json()) as MyWorkPreferencesSnapshot
}

/**
 * Resolve a seeded Research Group's ID from the canonical list
 * endpoint (preferences reference relational IDs, never names).
 */
export async function getResearchGroupId(
  page: Page,
  name: string,
): Promise<number> {
  const response = await page.request.get('/api/research-groups/')
  expect(
    response.ok(),
    'Listing Research Groups must succeed.',
  ).toBe(true)
  const groups = (await response.json()) as Array<{
    id: number
    name: string
  }>
  const group = groups.find(
    (candidate) => candidate.name === name,
  )
  expect(
    group,
    `Seeded Research Group "${name}" must be accessible to the authenticated user.`,
  ).toBeTruthy()
  return (group as { id: number }).id
}

export interface MyWorkReadyExpectation {
  /** The persisted viewMode the final view must reflect. */
  viewMode: MyWorkPreferencesViewMode
  /** Work Item titles that must be rendered in the final view. */
  visibleTitles?: readonly string[]
  /** Work Item titles that must NOT be rendered (filtered out). */
  hiddenTitles?: readonly string[]
}

/**
 * Wait until the My Work page is functionally ready — user-visible
 * (web-first) state only, no timing heuristics:
 *
 * 1. the loading skeleton is gone — it is the ONLY thing rendered
 *    until BOTH the Work Items GET and the preference snapshot GET
 *    have resolved (auth is already resolved by the shared login);
 * 2. no fatal load error is shown;
 * 3. the persisted preference is APPLIED — the view switch's pressed
 *    state is driven by the loaded snapshot's `viewMode`;
 * 4. the Work Items are fully loaded — the expected rows/cards are
 *    rendered (and the expected absent ones are not).
 */
export async function expectMyWorkReady(
  page: Page,
  expectation: MyWorkReadyExpectation,
): Promise<void> {
  // 1. Final content: the skeleton resolves in place and is removed.
  await expect(
    page.locator('[data-my-work-board-skeleton="true"]'),
  ).toHaveCount(0)

  // 2. A failed load is a fatal, user-visible error — not readiness.
  await expect(
    page.getByRole('alert', {
      name: /My Work couldn't be loaded/,
    }),
  ).toHaveCount(0)

  // 3. The persisted viewMode is applied: exactly the expected view
  //    of the "My Work view" switch is pressed.
  const viewSwitch = page.getByRole('group', {
    name: 'My Work view',
  })
  await expect(
    viewSwitch.getByRole('button', { name: 'Board' }),
  ).toHaveAttribute(
    'aria-pressed',
    String(expectation.viewMode === 'board'),
  )
  await expect(
    viewSwitch.getByRole('button', { name: 'List' }),
  ).toHaveAttribute(
    'aria-pressed',
    String(expectation.viewMode === 'list'),
  )

  // 4. Work Items fully loaded: Board cards and List rows share the
  //    same accessible identity (`Open <title>`).
  for (const title of expectation.visibleTitles ?? []) {
    await expect(
      page.getByRole('button', { name: `Open ${title}` }),
    ).toBeVisible()
  }

  for (const title of expectation.hiddenTitles ?? []) {
    await expect(
      page.getByRole('button', { name: `Open ${title}` }),
    ).toHaveCount(0)
  }
}

/**
 * Resolve a seeded Project's ID inside a seeded Research Group via
 * the canonical group Project-list endpoint (preferences reference
 * relational IDs, never names).
 */
export async function getProjectIdInGroup(
  page: Page,
  groupName: string,
  projectName: string,
): Promise<number> {
  const groupId = await getResearchGroupId(
    page,
    groupName,
  )
  const response = await page.request.get(
    `/api/research-groups/${groupId}/projects/`,
  )
  expect(
    response.ok(),
    `Listing the Projects of "${groupName}" must succeed.`,
  ).toBe(true)
  const projects = (await response.json()) as Array<{
    id: number
    name: string
  }>
  const project = projects.find(
    (candidate) => candidate.name === projectName,
  )
  expect(
    project,
    `Seeded Project "${projectName}" must be accessible inside "${groupName}".`,
  ).toBeTruthy()
  return (project as { id: number }).id
}

/**
 * Event-based wait for the page's debounced preference save.
 *
 * Register the wait BEFORE the UI action that triggers the save. The
 * correct request is identified by method AND endpoint (exact
 * pathname match — the Vite dev server proxies `/api`), the response
 * must be successful, and — when `expected` is given — the returned
 * normalized server snapshot must equal it (payload-level proof that
 * exactly the intended state was persisted).
 */
export function expectMyWorkPreferenceSave(
  page: Page,
  expected?: MyWorkPreferencesSnapshot,
): Promise<MyWorkPreferencesSnapshot> {
  return page
    .waitForResponse((response) =>
      response.request().method() === 'PATCH' &&
      new URL(response.url()).pathname ===
        PREFERENCES_PATHNAME)
    .then(async (response) => {
      expect(
        response.status(),
        'The My Work preference save (PATCH /api/me/preferences/my-work/) must succeed.',
      ).toBe(200)

      const snapshot =
        (await response.json()) as MyWorkPreferencesSnapshot

      if (expected) {
        expect(
          sameMyWorkPreferences(snapshot, expected),
          `Persisted My Work preference snapshot mismatch.\n  expected: ${JSON.stringify(expected)}\n  received: ${JSON.stringify(snapshot)}`,
        ).toBe(true)
      }

      return snapshot
    })
}

/**
 * Ensure the authenticated browser session carries a CSRF cookie and
 * return its value (the production client sends it as `X-CSRFToken`
 * on every unsafe request).
 */
async function ensureCsrfToken(
  page: Page,
): Promise<string> {
  const readToken = async (): Promise<
    string | undefined
  > => {
    const cookies = await page.context().cookies()
    return cookies.find(
      (cookie) => cookie.name === 'csrftoken',
    )?.value
  }

  let token = await readToken()
  if (!token) {
    // The canonical public endpoint ensures the CSRF cookie is set
    // (the same fallback the E2E invitation helper uses).
    const response = await page.request.get(
      '/api/auth/csrf/',
    )
    expect(
      response.ok(),
      'The CSRF bootstrap endpoint must succeed.',
    ).toBe(true)
    token = await readToken()
  }

  expect(
    token,
    'The authenticated E2E session must carry a CSRF cookie for preference writes.',
  ).toBeTruthy()
  return token as string
}
