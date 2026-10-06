import {
  expect,
  test,
  type Page,
} from '@playwright/test'

import {
  login,
  openProject,
} from './helpers'

/**
 * Browser acceptance for the Sidebar's GLOBAL Quick Access
 * information architecture:
 *
 * - ONE flat, personal, global Quick Access section (never
 *   nested below a Research Group, never collapsible), above
 *   the Research Groups section, max five rows;
 * - the cold-load server response defines the stable snapshot
 *   (no client sort, no live rerank after recordProjectOpen);
 * - cross-Research-Group Project navigation does not
 *   refetch/reorder the snapshot;
 * - central Project-open recording: every logical Project
 *   entry (Quick Access row, Projects list row, deep link)
 *   records exactly one open; tab changes inside the same
 *   Project do not re-record; re-entering records a new open.
 *   The dev server runs under StrictMode, so the counts also
 *   prove the effect replay is a no-op;
 * - Research Group rows: the chevron toggles disclosure only
 *   (never navigates), the name navigates to the group's
 *   Overview, there is no overflow menu, and an expanded
 *   group renders EXACTLY the two child rows (Projects /
 *   Meetings) — no Project shortcuts underneath a group.
 *
 * Determinism note: the E2E run is ONE schema reset followed
 * by sequential specs, so alex's eligible Project set (and
 * the recency rows left by earlier specs) is not controlled
 * here. The spec therefore reconstructs a fully deterministic
 * personal snapshot: it enumerates alex's CURRENT accessible,
 * non-archived Projects through the authenticated API and
 * records explicit opens for ALL of them in a fixed order —
 * with the two cross-Research-Group navigation targets
 * ("Paper XYZ" / FG Example and "E2E Robot Study" / Robotics
 * Lab) opened LAST, so the server's global ranking (newest
 * personal open first) is fully determined by the spec.
 */

type AccessibleProject = {
  id: number
  name: string
  researchGroupId: number
  archivedAt: string | null
}

const PAPER_XYZ = 'Paper XYZ'
const ROBOT_STUDY = 'E2E Robot Study'

function quickAccessNav(page: Page) {
  return page.getByRole('navigation', {
    name: 'Quick access',
  })
}

function quickAccessRows(page: Page) {
  // Quick Access rows are BUTTONS (pure navigation controls):
  // role-based locators can never confuse them with the
  // Projects list's project links (article role="link").
  return quickAccessNav(page).getByRole('button')
}

async function quickAccessRowNames(
  page: Page,
): Promise<string[]> {
  const rows = quickAccessRows(page)
  const count = await rows.count()
  const names: string[] = []

  for (let index = 0; index < count; index += 1) {
    names.push(
      (await rows.nth(index).textContent())?.trim() ??
        '',
    )
  }

  return names
}

async function reconstructDeterministicSnapshot(
  page: Page,
): Promise<Map<string, AccessibleProject>> {
  /*
   * The canonical Project listing is Research-Group-scoped —
   * there is NO global /api/projects/ collection endpoint:
   * enumerate the accessible Research Groups first, then each
   * group's project list, and flatten (id-deduplicated) the
   * eligible Projects for the deterministic setup. These
   * requests are fixture setup only and run BEFORE the
   * Sidebar's request accounting starts — the Sidebar itself
   * must still make exactly ONE global Quick Access request
   * and ZERO per-Research-Group Quick Access requests (the
   * per-group `/projects/` list routes never match the Quick
   * Access URL patterns asserted below).
   */
  const groups = await page.evaluate(async () => {
    const response = await fetch(
      '/api/research-groups/',
      { credentials: 'same-origin' },
    )

    if (!response.ok) {
      throw new Error(
        `Research Groups request failed: ${response.status}`,
      )
    }

    return response.json()
  }) as Array<{
    id: number
    name: string
  }>

  const projects = await page.evaluate(
    async (groupIds) => {
      const all: unknown[] = []

      for (const groupId of groupIds) {
        const response = await fetch(
          `/api/research-groups/${groupId}/projects/`,
          { credentials: 'same-origin' },
        )

        if (!response.ok) {
          throw new Error(
            `Projects request failed for group ` +
              `${groupId}: ${response.status}`,
          )
        }

        all.push(
          ...(await response.json()) as unknown[],
        )
      }

      return all
    },
    groups.map((group) => group.id),
  ) as AccessibleProject[]

  // The per-RG lists are permission-filtered by the server;
  // flatten + deduplicate by id (a Project belongs to exactly
  // one Research Group, so this is purely defensive).
  const byId = new Map<number, AccessibleProject>()

  for (const project of projects) {
    byId.set(project.id, project)
  }

  const candidates = [...byId.values()]
    .filter(
      (project) => project.archivedAt === null,
    )
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        (a.id < b.id ? -1 : 1),
    )

  expect(
    candidates.some(
      (project) => project.name === PAPER_XYZ,
    ),
  ).toBe(true)
  expect(
    candidates.some(
      (project) => project.name === ROBOT_STUDY,
    ),
  ).toBe(true)

  const byName = new Map(
    candidates.map(
      (project) => [project.name, project],
    ),
  )

  /*
   * Record explicit opens for EVERY eligible Project in a
   * fixed order: the two cross-group targets LAST, so the
   * authoritative global snapshot starts with
   * [E2E Robot Study, Paper XYZ, ...] (newest open first)
   * no matter what earlier specs left behind.
   */
  const openOrder = [
    ...candidates
      .filter(
        (project) =>
          project.name !== PAPER_XYZ &&
          project.name !== ROBOT_STUDY,
      )
      .map((project) => project.id),
    byName.get(PAPER_XYZ)!.id,
    byName.get(ROBOT_STUDY)!.id,
  ]

  await page.evaluate(async (ids) => {
    let csrf = document.cookie
      .split(';')
      .map((cookie) => cookie.trim())
      .find((cookie) =>
        cookie.startsWith('csrftoken='),
      )
      ?.split('=')[1]

    if (!csrf) {
      await fetch('/api/auth/csrf/', {
        credentials: 'same-origin',
      })

      csrf = document.cookie
        .split(';')
        .map((cookie) => cookie.trim())
        .find((cookie) =>
          cookie.startsWith('csrftoken='),
        )
        ?.split('=')[1]
    }

    for (const id of ids) {
      const response = await fetch(
        `/api/me/projects/${id}/open/`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-CSRFToken': csrf ?? '',
          },
          body: JSON.stringify({}),
        },
      )

      if (!response.ok) {
        throw new Error(
          `Open ${id} failed: ${response.status}`,
        )
      }
    }
  }, openOrder)

  return byName
}

async function ensureGroupExpanded(
  page: Page,
  groupName: string,
) {
  const group = page.getByRole('group', {
    name: groupName,
  })

  await expect(group).toBeVisible()

  const chevron = group.locator(
    'button[aria-controls]',
  )

  if (
    (await chevron.getAttribute('aria-expanded')) !==
    'true'
  ) {
    await chevron.click()

    await expect(chevron).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  }

  return group
}

test(
  'global quick access renders one stable section with central open recording',
  async ({ page }) => {
    await login(page, 'alex')

    const byName =
      await reconstructDeterministicSnapshot(page)
    const paperXyz = byName.get(PAPER_XYZ)!
    const robotStudy = byName.get(ROBOT_STUDY)!

    // --------------------------------------------------------
    // Request accounting: from here on, EVERY cold load must
    // produce exactly ONE global Quick Access request, no
    // per-Research-Group Quick Access request may happen at
    // all, and every logical Project entry must record
    // exactly ONE open.
    // --------------------------------------------------------

    const requestCounts = {
      globalQuickAccess: 0,
      perGroupQuickAccess: 0,
    }

    const projectOpens = new Map<number, number>()

    page.on('request', (request) => {
      const url = request.url()

      if (
        request.method() === 'GET' &&
        url.endsWith(
          '/api/me/project-quick-access/',
        )
      ) {
        requestCounts.globalQuickAccess += 1
        return
      }

      if (
        url.match(
          /\/api\/research-groups\/\d+\/project-quick-access\//,
        ) !== null
      ) {
        requestCounts.perGroupQuickAccess += 1
        return
      }

      const openMatch = url.match(
        /\/api\/me\/projects\/(\d+)\/open\/$/,
      )

      if (
        request.method() === 'POST' &&
        openMatch !== null
      ) {
        const projectId = Number(openMatch[1])

        projectOpens.set(
          projectId,
          (projectOpens.get(projectId) ?? 0) + 1,
        )
      }
    })

    const openCount = (projectId: number) =>
      projectOpens.get(projectId) ?? 0

    // --------------------------------------------------------
    // Reload: the Sidebar's cold load issues its ONE global
    // Quick Access request and renders the authoritative
    // server order as the stable snapshot.
    // --------------------------------------------------------

    await page.reload()

    await expect
      .poll(
        () => requestCounts.globalQuickAccess,
        {
          message:
            'cold-load global Quick Access request',
        },
      )
      .toBe(1)

    // --------------------------------------------------------
    // ONE global Quick Access section, above Research
    // Groups, flat, max five rows, exact server order.
    // --------------------------------------------------------

    await expect(
      quickAccessNav(page),
    ).toHaveCount(1)

    const quickAccessBox =
      await quickAccessNav(page).boundingBox()
    const researchGroupsBox =
      await page
        .getByRole('navigation', {
          name: 'Research groups',
        })
        .boundingBox()

    expect(quickAccessBox).not.toBeNull()
    expect(researchGroupsBox).not.toBeNull()
    expect(quickAccessBox!.y).toBeLessThan(
      researchGroupsBox!.y,
    )

    const rows = quickAccessRows(page)

    // The two targets were opened last: they rank first,
    // in exactly the open order (newest first).
    await expect(rows.first()).toHaveText(ROBOT_STUDY)
    await expect(rows.nth(1)).toHaveText(PAPER_XYZ)

    expect(
      await rows.count(),
    ).toBeLessThanOrEqual(5)

    const snapshotOrder =
      await quickAccessRowNames(page)

    // Flat presentation: no duplicate row, and every row a
    // real eligible Project.
    expect(
      new Set(snapshotOrder).size,
    ).toBe(snapshotOrder.length)

    for (const name of snapshotOrder) {
      expect(
        byName.has(name),
        `unexpected Quick Access row "${name}"`,
      ).toBe(true)
    }

    // --------------------------------------------------------
    // Research Group rows: no overflow menu anywhere; an
    // expanded group renders EXACTLY Projects + Meetings
    // (no Project shortcuts underneath a group, no third
    // hierarchy level).
    // --------------------------------------------------------

    await expect(
      page.getByRole('button', {
        name: /More options for /,
      }),
    ).toHaveCount(0)

    const roboticsGroup =
      await ensureGroupExpanded(page, 'Robotics Lab')

    await expect(
      roboticsGroup.getByRole('link', {
        name: 'Projects',
        exact: true,
      }),
    ).toBeVisible()
    await expect(
      roboticsGroup.getByRole('link', {
        name: 'Meetings',
        exact: true,
      }),
    ).toBeVisible()

    // EXACTLY two child rows — and the group's only
    // disclosure control is the row's own chevron (no
    // nested disclosure, no nested group, no Project
    // children).
    expect(
      await roboticsGroup.getByRole('link').count(),
    ).toBe(2)
    expect(
      await roboticsGroup
        .locator('button[aria-expanded]')
        .count(),
    ).toBe(1)
    expect(
      await roboticsGroup.getByRole('group').count(),
    ).toBe(0)

    const fgExampleGroup =
      await ensureGroupExpanded(page, 'FG Example')

    expect(
      await fgExampleGroup.getByRole('link').count(),
    ).toBe(2)

    // --------------------------------------------------------
    // Chevron toggles disclosure only — it never navigates
    // (on a neutral route the group has no contextual
    // reveal, so the chevron state follows the manual
    // state exactly).
    // --------------------------------------------------------

    const homeUrl = page.url()
    const roboticsChevron = roboticsGroup.locator(
      'button[aria-controls]',
    )

    await roboticsChevron.click()
    await expect(roboticsChevron).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(page.url()).toBe(homeUrl)

    await roboticsChevron.click()
    await expect(roboticsChevron).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(page.url()).toBe(homeUrl)

    // --------------------------------------------------------
    // The name row is pure navigation to the group's
    // Overview (no select-in-place), and route-active there.
    // --------------------------------------------------------

    await roboticsGroup
      .getByRole('button', {
        name: 'Robotics Lab',
        exact: true,
      })
      .click()

    await expect(page).toHaveURL(/\/groups\/\d+$/)
    await expect(
      roboticsGroup
        .getByRole('button', {
          name: 'Robotics Lab',
          exact: true,
        }),
    ).toHaveAttribute('aria-current', 'true')

    // The Overview is not a concrete Project route: the
    // snapshot is untouched and no further Quick Access
    // request fired.
    expect(
      await quickAccessRowNames(page),
    ).toEqual(snapshotOrder)
    expect(
      requestCounts.globalQuickAccess,
    ).toBe(1)

    // --------------------------------------------------------
    // The scoped child rows navigate to the group's scoped
    // lists.
    // --------------------------------------------------------

    await roboticsGroup
      .getByRole('link', {
        name: 'Projects',
        exact: true,
      })
      .click()

    await expect(page).toHaveURL(
      new RegExp(
        `/projects\\?group=${robotStudy.researchGroupId}$`,
      ),
    )

    // --------------------------------------------------------
    // Cross-Research-Group navigation: the snapshot stays
    // stable (same rows, same order) and each logical
    // Project entry records exactly one open.
    // --------------------------------------------------------

    // Quick Access → Project (Robotics Lab target).
    await quickAccessNav(page)
      .getByRole('button', {
        name: ROBOT_STUDY,
        exact: true,
      })
      .click()

    await expect(page).toHaveURL(
      /\/projects\/\d+\/work-items$/,
    )
    const robotStudyPath =
      new URL(page.url()).pathname

    // The entered Project keeps its slot; only the active
    // emphasis changes.
    expect(
      await quickAccessRowNames(page),
    ).toEqual(snapshotOrder)
    await expect(
      quickAccessNav(page).getByRole('button', {
        name: ROBOT_STUDY,
        exact: true,
      }),
    ).toHaveAttribute('aria-current', 'true')
    // The open POST is issued by a post-render route
    // effect: deterministically WAIT for its observation
    // (bounded poll — no sleep) instead of reading the
    // counter synchronously against the in-flight effect.
    await expect
      .poll(() => openCount(robotStudy.id))
      .toBe(1)

    // Tab changes inside the same Project do not
    // re-record. The exact count at re-entry below is the
    // deterministic guard: a stray tab-change POST would
    // surface as 3 there.
    await page
      .getByRole('link', {
        name: 'Members',
        exact: true,
      })
      .click()
    expect(
      openCount(robotStudy.id),
    ).toBe(1)

    await page
      .getByRole('link', {
        name: 'Work Items',
        exact: true,
      })
      .click()
    expect(
      openCount(robotStudy.id),
    ).toBe(1)

    // Cross-group: Robotics Lab → FG Example. No refetch,
    // no reorder — the snapshot is global, never
    // partitioned by Research Group.
    await quickAccessNav(page)
      .getByRole('button', {
        name: PAPER_XYZ,
        exact: true,
      })
      .click()

    await expect(page).toHaveURL(
      /\/projects\/\d+\/work-items$/,
    )
    const paperXyzPath =
      new URL(page.url()).pathname

    expect(
      await quickAccessRowNames(page),
    ).toEqual(snapshotOrder)
    await expect(
      quickAccessNav(page).getByRole('button', {
        name: PAPER_XYZ,
        exact: true,
      }),
    ).toHaveAttribute('aria-current', 'true')
    await expect(
      quickAccessNav(page).getByRole('button', {
        name: ROBOT_STUDY,
        exact: true,
      }),
    ).not.toHaveAttribute('aria-current')
    await expect
      .poll(() => openCount(paperXyz.id))
      .toBe(1)

    // Leaving and later re-entering records a NEW open —
    // and still does not reorder the snapshot.
    await quickAccessNav(page)
      .getByRole('button', {
        name: ROBOT_STUDY,
        exact: true,
      })
      .click()

    await expect(page).toHaveURL(
      /\/projects\/\d+\/work-items$/,
    )
    expect(
      new URL(page.url()).pathname,
    ).toBe(robotStudyPath)
    await expect
      .poll(() => openCount(robotStudy.id))
      .toBe(2)
    expect(
      await quickAccessRowNames(page),
    ).toEqual(snapshotOrder)

    // The whole cross-group session used exactly ONE global
    // Quick Access request and no per-group endpoint.
    expect(
      requestCounts.globalQuickAccess,
    ).toBe(1)
    expect(
      requestCounts.perGroupQuickAccess,
    ).toBe(0)

    // --------------------------------------------------------
    // Deep link: a fresh page load into a concrete Project
    // counts as a logical entry (one new open) and re-
    // renders the exact snapshot returned by its ONE cold-load
    // request. That request may adopt a newly ranked server
    // snapshot from earlier opens; the subsequent route-level
    // open must not live-rerank the loaded snapshot.
    // --------------------------------------------------------

    const deepLinkQuickAccessResponse =
      page.waitForResponse(
        (response) =>
          response.request().method() === 'GET' &&
          new URL(response.url()).pathname ===
            '/api/me/project-quick-access/',
      )
    const deepLinkOpenResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname ===
          `/api/me/projects/${paperXyz.id}/open/`,
    )

    await page.goto(paperXyzPath)

    const quickAccessResponse =
      await deepLinkQuickAccessResponse

    expect(
      quickAccessResponse.status(),
      'The deep-link Quick Access request must succeed.',
    ).toBe(200)

    const deepLinkSnapshot =
      (await quickAccessResponse.json()) as Array<{
        name: string
      }>
    const deepLinkOrder = deepLinkSnapshot.map(
      (project) => project.name,
    )

    expect(deepLinkOrder.length).toBeLessThanOrEqual(5)
    await expect
      .poll(
        () => quickAccessRowNames(page),
        {
          message:
            'deep-link Sidebar matches the cold-load server snapshot',
        },
      )
      .toEqual(deepLinkOrder)
    expect(requestCounts.globalQuickAccess).toBe(2)

    // The route-level open completes after the cold-load
    // snapshot was chosen. It records the logical entry but
    // never invalidates or reorders that rendered snapshot.
    const openResponse = await deepLinkOpenResponse

    expect(
      openResponse.status(),
      'The deep-link Project open must succeed.',
    ).toBe(200)
    await expect
      .poll(() => openCount(paperXyz.id))
      .toBe(2)
    await expect
      .poll(() => quickAccessRowNames(page))
      .toEqual(deepLinkOrder)

    // --------------------------------------------------------
    // Projects list → Project: the first entry into a
    // snapshot member from the scoped list records one open
    // and does not reorder the rendered snapshot.
    // --------------------------------------------------------

    // The last rendered row is always inside the five-slot
    // snapshot (all Projects when fewer than five are
    // eligible, the fifth slot otherwise).
    const listEntryName =
      deepLinkOrder[deepLinkOrder.length - 1]
    const listEntry = byName.get(listEntryName)!

    expect(listEntry).toBeDefined()

    const listQuickAccessResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname ===
          '/api/me/project-quick-access/',
    )

    await page.goto(
      `/projects?group=${listEntry.researchGroupId}`,
    )

    const listLoadResponse =
      await listQuickAccessResponse

    expect(
      listLoadResponse.status(),
      'The Projects-list Quick Access request must succeed.',
    ).toBe(200)

    const listLoadSnapshot =
      (await listLoadResponse.json()) as Array<{
        name: string
      }>
    const listLoadOrder = listLoadSnapshot
      .slice(0, 5)
      .map((project) => project.name)

    await expect
      .poll(
        () => quickAccessRowNames(page),
        {
          message:
            'Projects-list Sidebar matches its cold-load server snapshot',
        },
      )
      .toEqual(listLoadOrder)
    expect(requestCounts.globalQuickAccess).toBe(3)

    const globalRequestsBeforeProjectEntry =
      requestCounts.globalQuickAccess
    const listEntryOpenResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname ===
          `/api/me/projects/${listEntry.id}/open/`,
    )

    await openProject(
      page,
      listEntryName,
    )

    const listOpenResponse =
      await listEntryOpenResponse

    expect(
      listOpenResponse.status(),
      'The Projects-list Project open must succeed.',
    ).toBe(200)
    await expect
      .poll(() => openCount(listEntry.id))
      .toBe(1)

    // recordProjectOpen never invalidates or reorders the
    // rendered snapshot.
    await expect
      .poll(() => quickAccessRowNames(page))
      .toEqual(listLoadOrder)
    expect(requestCounts.globalQuickAccess).toBe(
      globalRequestsBeforeProjectEntry,
    )

    // --------------------------------------------------------
    // The surrounding shell is untouched: personal
    // destinations, group creation, and notifications all
    // remain functional.
    // --------------------------------------------------------

    await expect(
      page.getByRole('link', { name: /Home/ }),
    ).toBeVisible()
    await expect(
      page.getByRole('link', {
        name: /My Work/,
      }),
    ).toBeVisible()
    await expect(
      page.getByRole('link', { name: /Notes/ }),
    ).toBeVisible()
    await expect(
      page.getByRole('button', {
        name: 'Create research group',
      }),
    ).toBeVisible()
    await expect(
      page.getByRole('link', {
        name: /Notifications/,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // Final accounting: every cold load produced exactly
    // ONE global Quick Access request (initial reload + two
    // deep navigations); no per-group Quick Access request
    // ever happened.
    // --------------------------------------------------------

    expect(
      requestCounts.globalQuickAccess,
    ).toBe(3)
    expect(
      requestCounts.perGroupQuickAccess,
    ).toBe(0)
  },
)
