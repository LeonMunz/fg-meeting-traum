import {
  expect,
  test,
  type Page,
} from './diagnostics/failure-diagnostics'

import {
  datePartPlusDays,
  login,
  openResearchGroupOverview,
  replaceControlValue,
} from './helpers'

async function selectResearchGroup(
  page: Page,
  name: string,
) {
  await openResearchGroupOverview(page, name)

  await expect(
    page
      .getByRole('group', { name })
      .getByRole('button', {
        name,
        exact: true,
      }),
  ).toHaveAttribute(
    'aria-current',
    'true',
  )
}

async function expandResearchGroup(
  page: Page,
  name: string,
) {
  // Ensure the group's child rows (Projects / Meetings) are
  // reachable. The group may already be visible - either
  // manually expanded through persisted navigation
  // preferences or contextually revealed by the current
  // route - in which case there is nothing to do. The
  // disclosure control is located inside the group
  // container by its ARIA relation to the children region
  // (aria-controls) and its current state is read from
  // aria-expanded, so the helper works from both starting
  // states and never toggles a group that is already open.
  const group = page.getByRole('group', { name })

  await expect(group).toBeVisible()

  const chevron = group.locator(
    'button[aria-controls][aria-label]',
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
}

function getGroupIdFromUrl(
  page: Page,
): string {
  const groupId =
    new URL(page.url())
      .searchParams
      .get('group')

  expect(groupId).not.toBeNull()

  return groupId!
}

type OwnedResearchGroup = {
  id: string
  name: string
}

/**
 * State ownership: creates a test-owned Research Group through
 * the user-facing creation flow for the currently logged-in
 * user. The server response proves the creator becomes admin of
 * the new group, and creation lands on the new group's canonical
 * Overview.
 */
async function createResearchGroup(
  page: Page,
  name: string,
): Promise<OwnedResearchGroup> {
  const createEntry =
    page.getByRole('button', {
      name: 'Create research group',
    })

  await expect(createEntry).toBeVisible()
  await createEntry.click()

  const dialog =
    page.getByRole('dialog', {
      name: 'Create research group',
    })

  await expect(dialog).toBeVisible()

  const createResponse =
    page.waitForResponse(
      (response) =>
        response
          .url()
          .endsWith('/api/research-groups/') &&
        response.request().method() === 'POST',
    )

  await dialog
    .getByLabel('Research group name')
    .fill(name)

  await dialog
    .getByRole('button', {
      name: 'Create research group',
    })
    .click()

  const response = await createResponse
  expect(response.status()).toBe(201)
  const created = (await response.json()) as {
    id: number
    role: string
  }

  // The creator is admin of the new group.
  expect(created.role).toBe('admin')

  await expect(dialog).toBeHidden()

  // Creation lands on the new group's canonical Overview.
  await expect(page).toHaveURL(
    new RegExp(`/groups/${created.id}$`),
  )

  return {
    id: String(created.id),
    name,
  }
}

test(
  'personal work stays global while group navigation follows explicit context',
  async ({ page, context }) => {
    await login(page, 'alex')

    // --------------------------------------------------------
    // My Work is personal and aggregates Research Groups.
    // --------------------------------------------------------

    await page
      .getByRole('link', {
        name: /My Work/,
      })
      .click()

    await expect(page).toHaveURL(
      /\/my-work$/,
    )

    // Neutral / global baseline of the current My Work contract: the
    // Research Group filter (the multiselect toggle that replaced the
    // legacy single-select "Filter by research group" = "all") has no
    // group selected, so My Work is not scoped by the filter.
    await expect(
      page.getByRole('button', {
        name: 'Research groups, none selected',
      }),
    ).toBeVisible()

    await expect(
      page.getByText(
        'First Draft Complete',
        { exact: true },
      ),
    ).toBeVisible()

    await expect(
      page.getByText(
        'E2E Analyze robot data',
        { exact: true },
      ),
    ).toBeVisible()

    // Changing the active Research Group must not scope My
    // Work: enter the canonical Overview directly, then verify
    // My Work stays personal and unscoped when it is returned to.
    await selectResearchGroup(
      page,
      'Robotics Lab',
    )

    await expect(page).toHaveURL(
      /\/groups\/\d+$/,
    )

    await page
      .getByRole('link', {
        name: /My Work/,
      })
      .click()

    await expect(page).toHaveURL(
      /\/my-work$/,
    )

    await expect(
      page.getByText(
        'First Draft Complete',
        { exact: true },
      ),
    ).toBeVisible()

    await expect(
      page.getByText(
        'E2E Analyze robot data',
        { exact: true },
      ),
    ).toBeVisible()

    // --------------------------------------------------------
    // Group navigation follows the selected Research Group.
    // --------------------------------------------------------

    await expandResearchGroup(
      page,
      'Robotics Lab',
    )

    await page
      .getByRole('group', {
        name: 'Robotics Lab',
      })
      .getByRole('link', {
        name: /Projects/,
      })
      .click()

    await expect(page).toHaveURL(
      /\/projects\?group=\d+$/,
    )

    const roboticsGroupId =
      getGroupIdFromUrl(page)

    // The scoped list renders each Project name as a heading;
    // the heading role keeps these assertions off the Sidebar's
    // global Quick Access rows (buttons) for the same Projects.
    await expect(
      page.getByRole('heading', {
        name: 'E2E Robot Study',
        exact: true,
      }),
    ).toBeVisible()

    await expect(
      page.getByRole('heading', {
        name: 'Paper XYZ',
        exact: true,
      }),
    ).toHaveCount(0)

    // Enter the canonical Overview directly (the Sidebar name
    // controls disclosure), then reach the new group's scoped
    // list from that context.
    await selectResearchGroup(
      page,
      'FG Example',
    )

    await expect(page).toHaveURL(
      /\/groups\/\d+$/,
    )

    await page
      .getByRole('group', {
        name: 'FG Example',
      })
      .getByRole('link', {
        name: /Projects/,
      })
      .click()

    await expect(page).toHaveURL(
      /\/projects\?group=\d+$/,
    )

    const fgExampleGroupId =
      getGroupIdFromUrl(page)

    expect(fgExampleGroupId).not.toBe(
      roboticsGroupId,
    )

    await expect(
      page.getByRole('heading', {
        name: 'Paper XYZ',
        exact: true,
      }),
    ).toBeVisible()

    await expect(
      page.getByRole('heading', {
        name: 'E2E Robot Study',
        exact: true,
      }),
    ).toHaveCount(0)

    // --------------------------------------------------------
    // The legacy flat group placeholders are gone from the
    // workspace tree.
    // --------------------------------------------------------

    await selectResearchGroup(
      page,
      'Robotics Lab',
    )

    const researchGroups = page.getByRole(
      'navigation',
      { name: 'Research groups' },
    )

    for (const label of [
      'Calendar',
      'KVP',
      'Knowledge',
      'Data',
      'People',
    ]) {
      await expect(
        researchGroups
          .getByText(label, { exact: true }),
      ).toHaveCount(0)
    }

    // --------------------------------------------------------
    // URLs remain authoritative across separate browser tabs.
    // --------------------------------------------------------

    const otherPage =
      await context.newPage()

    await otherPage.goto(
      `/projects?group=${fgExampleGroupId}`,
    )

    await expect(
      otherPage.getByRole('heading', {
        name: 'Paper XYZ',
        exact: true,
      }),
    ).toBeVisible()

    await expect(
      otherPage.getByRole('heading', {
        name: 'E2E Robot Study',
        exact: true,
      }),
    ).toHaveCount(0)

    await page.goto(
      `/projects?group=${roboticsGroupId}`,
    )

    await expect(
      page.getByRole('heading', {
        name: 'E2E Robot Study',
        exact: true,
      }),
    ).toBeVisible()

    await expect(
      page.getByRole('heading', {
        name: 'Paper XYZ',
        exact: true,
      }),
    ).toHaveCount(0)

    await otherPage.close()

    // --------------------------------------------------------
    // Entity deep links derive context from the Entity.
    // --------------------------------------------------------

    const robotProject =
      page
        .getByRole('link')
        .filter({
          hasText: 'E2E Robot Study',
        })

    await expect(robotProject).toBeVisible()
    await robotProject.click()

    await expect(page).toHaveURL(
      /\/projects\/\d+\/work-items$/,
    )

    const robotProjectPath =
      new URL(page.url()).pathname

    // From the Entity deep link, enter the other group's
    // canonical Overview directly; its scoped list is the next
    // step.
    await selectResearchGroup(
      page,
      'FG Example',
    )

    await expect(page).toHaveURL(
      /\/groups\/\d+$/,
    )

    await page
      .getByRole('group', {
        name: 'FG Example',
      })
      .getByRole('link', {
        name: /Projects/,
      })
      .click()

    await expect(page).toHaveURL(
      new RegExp(
        `/projects\\?group=${fgExampleGroupId}$`,
      ),
    )

    await page.goto(robotProjectPath)

    // The Entity deep link contextually REVEALS the owning
    // group (expansion only — expansion never creates
    // selected styling).
    const roboticsGroup = page
      .getByRole('group', {
        name: 'Robotics Lab',
      })

    await expect(
      roboticsGroup.locator(
        'button[aria-controls][aria-label]',
      ),
    ).toHaveAttribute('aria-expanded', 'true')
    await expect(
      roboticsGroup
        .getByRole('button', {
          name: 'Robotics Lab',
          exact: true,
        }),
    ).not.toHaveAttribute('aria-current')

    // --------------------------------------------------------
    // Invalid explicit group context never leaks another group.
    // --------------------------------------------------------

    await page.goto(
      '/projects?group=999999',
    )

    await expect(
      page.getByText(
        'Research group is not available.',
        { exact: true },
      ),
    ).toBeVisible()

    // Heading role again: the list is empty here, while the
    // Sidebar's global Quick Access may still show these
    // Projects as personal rows.
    await expect(
      page.getByRole('heading', {
        name: 'Paper XYZ',
        exact: true,
      }),
    ).toHaveCount(0)

    await expect(
      page.getByRole('heading', {
        name: 'E2E Robot Study',
        exact: true,
      }),
    ).toHaveCount(0)
  },
)

test(
  'meeting deep links restore their Research Group context',
  async ({ page }) => {
    await login(page, 'alex')

    // State ownership: the Meeting is created inside a
    // test-owned Research Group, so no seeded group ever
    // receives the test Meeting (the run-level reset remains
    // the only cleanup).
    const ownedGroup =
      await createResearchGroup(
        page,
        `E2E Scope Deep Link ${Date.now()}`,
      )

    // The creation flow already landed on the owned group's
    // Overview: the current route contextually reveals its child
    // rows. Synchronize on that reveal by waiting for the
    // destination this test actually needs, instead of toggling
    // the disclosure manually (a toggle racing the contextual
    // reveal would collapse the group).
    const ownedGroupNavigation =
      page.getByRole('group', {
        name: ownedGroup.name,
      })

    const ownedMeetingsLink =
      ownedGroupNavigation.getByRole('link', {
        name: /Meetings/,
      })

    await expect(ownedMeetingsLink).toBeVisible()
    await ownedMeetingsLink.click()

    await expect(page).toHaveURL(
      new RegExp(
        `/meetings\\?group=${ownedGroup.id}$`,
      ),
    )

    await page
      .locator('header')
      .filter({
        has: page.getByRole('heading', {
          name: 'Meetings',
          exact: true,
        }),
      })
      .getByRole('button', { name: /New meeting/ })
      .click()

    await page
      .getByLabel('Title')
      .fill(
        'E2E Owned Scope Meeting',
      )

    await replaceControlValue(
      page.getByRole('textbox', { name: 'Date', exact: true }),
      datePartPlusDays(9),
    )

    await replaceControlValue(
      page.getByRole('combobox', { name: 'Time', exact: true }),
      '09:00',
    )

    await page
      .locator('form')
      .getByRole('button', {
        name: /Create meeting/,
      })
      .click()

    const meetingRow =
      page
        .getByRole('button')
        .filter({
          hasText:
            'E2E Owned Scope Meeting',
        })

    await expect(meetingRow).toBeVisible()
    await meetingRow.click()

    await expect(page).toHaveURL(
      /\/meetings\/\d+$/,
    )

    const meetingPath =
      new URL(page.url()).pathname

    // The Entity deep link restores the provider's Research
    // Group context; the unscoped Meetings list resolves to
    // that group's scope (route-active presentation belongs
    // to the Overview only).
    await page.goto('/meetings')

    await expect(page).toHaveURL(
      new RegExp(
        `/meetings\\?group=${ownedGroup.id}$`,
      ),
    )

    // Switching groups on an Entity exits to the new group's
    // list: the name row takes the Overview first, then the
    // scoped child destination.
    await selectResearchGroup(
      page,
      'FG Example',
    )

    await expect(page).toHaveURL(
      /\/groups\/\d+$/,
    )

    await page
      .getByRole('group', {
        name: 'FG Example',
      })
      .getByRole('link', {
        name: /Meetings/,
      })
      .click()

    await expect(page).toHaveURL(
      /\/meetings\?group=\d+$/,
    )

    // The owned Meeting does not leak into the FG Example
    // scope.
    await expect(
      page.getByText(
        'E2E Owned Scope Meeting',
        { exact: true },
      ),
    ).toHaveCount(0)

    // Opening the owned Meeting directly restores its owning
    // group's context (the provider's active group drives the
    // unscoped list scope).
    await page.goto(meetingPath)

    await expect(
      page.getByRole('heading', {
        name: 'E2E Owned Scope Meeting',
        exact: true,
      }),
    ).toBeVisible()

    await page.goto('/meetings')

    await expect(page).toHaveURL(
      new RegExp(
        `/meetings\\?group=${ownedGroup.id}$`,
      ),
    )
  },
)
