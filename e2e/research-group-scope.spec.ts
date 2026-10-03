import {
  expect,
  test,
  type Page,
} from './diagnostics/failure-diagnostics'

import { datePartPlusDays, login, replaceControlValue } from './helpers'

async function selectResearchGroup(
  page: Page,
  name: string,
) {
  // The workspace tree row label is the canonical group
  // selection control (the former selector dropdown was
  // replaced by the hierarchical tree). It is addressed through
  // the group container with the exact accessible name so the
  // row's sibling controls (chevron "Expand <name>", overflow
  // "More options for <name>") can never match.
  const label = page
    .getByRole('group', { name })
    .getByRole('button', {
      name,
      exact: true,
    })

  await expect(label).toBeVisible()
  await label.click()

  await expect(label).toHaveAttribute(
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

  const chevron = group.locator('button[aria-controls]')

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

    // Changing the active Research Group must not scope My Work.
    await selectResearchGroup(
      page,
      'Robotics Lab',
    )

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

    await expect(
      page.getByText(
        'E2E Robot Study',
        { exact: true },
      ),
    ).toBeVisible()

    await expect(
      page.getByText(
        'Paper XYZ',
        { exact: true },
      ),
    ).toHaveCount(0)

    await selectResearchGroup(
      page,
      'FG Example',
    )

    await expect(page).toHaveURL(
      /\/projects\?group=\d+$/,
    )

    const fgExampleGroupId =
      getGroupIdFromUrl(page)

    expect(fgExampleGroupId).not.toBe(
      roboticsGroupId,
    )

    await expect(
      page.getByText(
        'Paper XYZ',
        { exact: true },
      ),
    ).toBeVisible()

    await expect(
      page.getByText(
        'E2E Robot Study',
        { exact: true },
      ),
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
      otherPage.getByText(
        'Paper XYZ',
        { exact: true },
      ),
    ).toBeVisible()

    await expect(
      otherPage.getByText(
        'E2E Robot Study',
        { exact: true },
      ),
    ).toHaveCount(0)

    await page.goto(
      `/projects?group=${roboticsGroupId}`,
    )

    await expect(
      page.getByText(
        'E2E Robot Study',
        { exact: true },
      ),
    ).toBeVisible()

    await expect(
      page.getByText(
        'Paper XYZ',
        { exact: true },
      ),
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

    await selectResearchGroup(
      page,
      'FG Example',
    )

    await expect(page).toHaveURL(
      new RegExp(
        `/projects\\?group=${fgExampleGroupId}$`,
      ),
    )

    await page.goto(robotProjectPath)

    await expect(
      page
        .getByRole('group', { name: 'Robotics Lab' })
        .getByRole('button', {
          name: 'Robotics Lab',
          exact: true,
        }),
    ).toHaveAttribute('aria-current', 'true')

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

    await expect(
      page.getByText(
        'Paper XYZ',
        { exact: true },
      ),
    ).toHaveCount(0)

    await expect(
      page.getByText(
        'E2E Robot Study',
        { exact: true },
      ),
    ).toHaveCount(0)
  },
)

test(
  'meeting deep links restore their Research Group context',
  async ({ page }) => {
    await login(page, 'alex')

    await selectResearchGroup(
      page,
      'Robotics Lab',
    )

    await expandResearchGroup(
      page,
      'Robotics Lab',
    )

    await page
      .getByRole('group', {
        name: 'Robotics Lab',
      })
      .getByRole('link', {
        name: /Meetings/,
      })
      .click()

    await expect(page).toHaveURL(
      /\/meetings\?group=\d+$/,
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
        'E2E Robotics Scope Meeting',
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
            'E2E Robotics Scope Meeting',
        })

    await expect(meetingRow).toBeVisible()
    await meetingRow.click()

    await expect(page).toHaveURL(
      /\/meetings\/\d+$/,
    )

    const meetingPath =
      new URL(page.url()).pathname

    await expect(
      page
        .getByRole('group', { name: 'Robotics Lab' })
        .getByRole('button', {
          name: 'Robotics Lab',
          exact: true,
        }),
    ).toHaveAttribute('aria-current', 'true')

    // Switching groups on an Entity exits to the new group's list.
    await selectResearchGroup(
      page,
      'FG Example',
    )

    await expect(page).toHaveURL(
      /\/meetings\?group=\d+$/,
    )

    await expect(
      page
        .getByRole('group', { name: 'FG Example' })
        .getByRole('button', {
          name: 'FG Example',
          exact: true,
        }),
    ).toHaveAttribute('aria-current', 'true')

    // Opening the Robotics meeting directly restores Robotics context.
    await page.goto(meetingPath)

    await expect(
      page.getByRole('heading', {
        name:
          'E2E Robotics Scope Meeting',
        exact: true,
      }),
    ).toBeVisible()

    await expect(
      page
        .getByRole('group', { name: 'Robotics Lab' })
        .getByRole('button', {
          name: 'Robotics Lab',
          exact: true,
        }),
    ).toHaveAttribute('aria-current', 'true')
  },
)
