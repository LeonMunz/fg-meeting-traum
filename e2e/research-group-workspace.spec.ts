import {
  expect,
  test,
  type Page,
} from './diagnostics/failure-diagnostics'

import { login } from './helpers'

/**
 * Enters the canonical Research Group Overview through the
 * Sidebar group-name link (the product path itself) and
 * returns the group id resolved from the resulting canonical
 * workspace URL. Also asserts the shared workspace header
 * (group-name H1 + description) of the Overview area.
 */
async function openGroupOverview(
  page: Page,
  name: string,
): Promise<string> {
  const group =
    page.getByRole('group', { name })

  await expect(group).toBeVisible()

  await group
    .getByRole('link', {
      name,
      exact: true,
    })
    .click()

  await expect(page).toHaveURL(
    /\/groups\/\d+$/,
  )

  const groupId =
    page.url().match(/\/groups\/(\d+)$/)?.[1]
  expect(groupId).not.toBeUndefined()

  // Shared workspace header: group name H1 + the subdued
  // workspace description.
  await expect(
    page.getByRole('heading', {
      name,
      level: 1,
    }),
  ).toBeVisible()

  await expect(
    page.getByText('Research group workspace'),
  ).toBeVisible()

  return groupId!
}

function workspaceTab(
  page: Page,
  label: string,
) {
  return page
    .getByRole('navigation', {
      name: 'Research group sections',
    })
    .getByRole('link', {
      name: label,
      exact: true,
    })
}

test(
  'workspace tabs persist the shared header and scope every area to the URL group',
  async ({ page }) => {
    await login(page, 'alex')

    const roboticsId =
      await openGroupOverview(
        page,
        'Robotics Lab',
      )

    // Admins see all four workspace tabs, with Overview
    // active on the index route.
    await expect(
      workspaceTab(page, 'Overview'),
    ).toHaveAttribute('aria-current', 'page')
    await expect(
      workspaceTab(page, 'Settings'),
    ).toBeVisible()

    // --------------------------------------------------------
    // Projects: scoped to the URL group, header + tabs kept.
    // --------------------------------------------------------

    await workspaceTab(
      page,
      'Projects',
    ).click()

    await expect(page).toHaveURL(
      new RegExp(
        `/groups/${roboticsId}/projects$`,
      ),
    )

    // The Robotics Lab project is listed …
    await expect(
      page.getByRole('heading', {
        name: 'E2E Robot Study',
        exact: true,
      }),
    ).toBeVisible()

    // … the FG Example project is NOT.
    await expect(
      page.getByRole('heading', {
        name: 'Paper XYZ',
        exact: true,
      }),
    ).toHaveCount(0)

    // The shared header + tab bar survived the switch …
    await expect(
      page.getByRole('heading', {
        name: 'Robotics Lab',
        level: 1,
      }),
    ).toBeVisible()

    // … and the page carries a LOCAL H2 (no second H1).
    await expect(
      page.getByRole('heading', {
        name: 'Projects',
        level: 2,
      }),
    ).toBeVisible()

    await expect(
      workspaceTab(page, 'Projects'),
    ).toHaveAttribute('aria-current', 'page')

    // Project creation stays reachable in the workspace.
    await expect(
      page.getByRole('button', {
        name: /New project/,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // Meetings: scoped list, internal tabs stay subordinate.
    // --------------------------------------------------------

    await workspaceTab(
      page,
      'Meetings',
    ).click()

    await expect(page).toHaveURL(
      new RegExp(
        `/groups/${roboticsId}/meetings$`,
      ),
    )

    await expect(
      page.getByRole('heading', {
        name: 'Robotics Lab',
        level: 1,
      }),
    ).toBeVisible()

    await expect(
      page.getByRole('heading', {
        name: 'Meetings',
        level: 2,
        exact: true,
      }),
    ).toBeVisible()

    const internalTabs =
      page.getByRole('tablist', {
        name: 'Meetings',
      })
    await expect(
      internalTabs.getByRole('tab', {
        name: 'Past',
      }),
    ).toBeVisible()

    await expect(
      workspaceTab(page, 'Meetings'),
    ).toHaveAttribute('aria-current', 'page')

    // Meeting creation stays reachable in the workspace. The
    // locator is scoped to the page <header> via its H2
    // "Meetings" heading because the Upcoming empty state
    // renders its own "New meeting" CTA.
    await expect(
      page
        .locator('header')
        .filter({
          has: page.getByRole('heading', {
            name: 'Meetings',
            level: 2,
            exact: true,
          }),
        })
        .getByRole('button', {
          name: /New meeting/,
        }),
    ).toBeVisible()

    // An internal tab switch keeps the ?tab= parameter,
    // the active workspace tab, and the shared header.
    await internalTabs
      .getByRole('tab', { name: 'Past' })
      .click()

    await expect(page).toHaveURL(
      new RegExp(
        `/groups/${roboticsId}/meetings\\?tab=past$`,
      ),
    )

    await expect(
      page.getByRole('heading', {
        name: 'Robotics Lab',
        level: 1,
      }),
    ).toBeVisible()

    await expect(
      workspaceTab(page, 'Meetings'),
    ).toHaveAttribute('aria-current', 'page')

    // --------------------------------------------------------
    // Settings (admin only) renders inside the layout.
    // --------------------------------------------------------

    await workspaceTab(
      page,
      'Settings',
    ).click()

    await expect(page).toHaveURL(
      new RegExp(
        `/groups/${roboticsId}/settings$`,
      ),
    )

    await expect(
      page.getByRole('heading', {
        name: 'Robotics Lab',
        level: 1,
      }),
    ).toBeVisible()

    await expect(
      page.getByLabel('Research group name'),
    ).toBeVisible()

    await expect(
      workspaceTab(page, 'Settings'),
    ).toHaveAttribute('aria-current', 'page')

    // No second group-name heading from the settings page.
    await expect(
      page.getByRole('heading', {
        name: 'Robotics Lab',
        level: 1,
      }),
    ).toHaveCount(1)

    // --------------------------------------------------------
    // Group switch: header, scope, and data follow the NEW
    // URL group.
    // --------------------------------------------------------

    await page
      .getByRole('group', {
        name: 'FG Example',
      })
      .getByRole('link', {
        name: 'FG Example',
        exact: true,
      })
      .click()

    await expect(page).toHaveURL(
      /\/groups\/\d+$/,
    )

    const fgId =
      page.url().match(/\/groups\/(\d+)$/)?.[1]
    expect(fgId).not.toBeUndefined()
    expect(fgId).not.toBe(roboticsId)

    await expect(
      page.getByRole('heading', {
        name: 'FG Example',
        level: 1,
      }),
    ).toBeVisible()

    await workspaceTab(
      page,
      'Projects',
    ).click()

    await expect(page).toHaveURL(
      new RegExp(`/groups/${fgId}/projects$`),
    )

    // The data belongs to the NEW group …
    await expect(
      page.getByRole('heading', {
        name: 'Paper XYZ',
        exact: true,
      }),
    ).toBeVisible()

    // … and the old group's data is gone.
    await expect(
      page.getByRole('heading', {
        name: 'E2E Robot Study',
        exact: true,
      }),
    ).toHaveCount(0)

    await expect(
      page.getByRole('heading', {
        name: 'FG Example',
        level: 1,
      }),
    ).toBeVisible()
  },
)

test(
  'deep links and browser Back/Forward restore the matching workspace area',
  async ({ page }) => {
    await login(page, 'alex')

    const roboticsId =
      await openGroupOverview(
        page,
        'Robotics Lab',
      )

    // Deep link directly into the workspace Meetings area
    // with the internal tab parameter.
    await page.goto(
      `/groups/${roboticsId}/meetings?tab=past`,
    )

    await expect(
      page.getByRole('heading', {
        name: 'Robotics Lab',
        level: 1,
      }),
    ).toBeVisible()

    await expect(
      workspaceTab(page, 'Meetings'),
    ).toHaveAttribute('aria-current', 'page')

    await expect(
      page
        .getByRole('tablist', {
          name: 'Meetings',
        })
        .getByRole('tab', { name: 'Past' }),
    ).toHaveAttribute('aria-selected', 'true')

    // Back → the previous workspace area (Overview) …
    await page.goBack()

    await expect(page).toHaveURL(
      new RegExp(`/groups/${roboticsId}$`),
    )

    await expect(
      workspaceTab(page, 'Overview'),
    ).toHaveAttribute('aria-current', 'page')

    // … Forward → the Meetings deep link again.
    await page.goForward()

    await expect(page).toHaveURL(
      new RegExp(
        `/groups/${roboticsId}/meetings\\?tab=past$`,
      ),
    )

    await expect(
      workspaceTab(page, 'Meetings'),
    ).toHaveAttribute('aria-current', 'page')
  },
)

test(
  'non-admins see no Settings tab and get no admin access via the direct URL',
  async ({ page }) => {
    await login(page, 'chris')

    const roboticsId =
      await openGroupOverview(
        page,
        'Robotics Lab',
      )

    // No Settings tab for non-admins — the other three
    // tabs stay.
    await expect(
      workspaceTab(page, 'Settings'),
    ).toHaveCount(0)

    await expect(
      workspaceTab(page, 'Overview'),
    ).toHaveAttribute('aria-current', 'page')
    await expect(
      workspaceTab(page, 'Projects'),
    ).toBeVisible()
    await expect(
      workspaceTab(page, 'Meetings'),
    ).toBeVisible()

    // Direct URL: the group itself is accessible (the
    // shared header renders), but the admin surface is
    // refused and no workspace tab claims the route.
    await page.goto(
      `/groups/${roboticsId}/settings`,
    )

    await expect(
      page.getByText(
        'Research group settings are managed by admins.',
      ),
    ).toBeVisible()

    await expect(
      page.getByLabel('Research group name'),
    ).toHaveCount(0)

    await expect(
      page.getByRole('button', {
        name: /Add member/,
      }),
    ).toHaveCount(0)

    await expect(
      page.getByRole('heading', {
        name: 'Robotics Lab',
        level: 1,
      }),
    ).toBeVisible()

    // No workspace tab claims the refused route.
    const workspaceLinks = page
      .getByRole('navigation', {
        name: 'Research group sections',
      })
      .getByRole('link')

    await expect(workspaceLinks).toHaveCount(3)

    for (
      const link of
      await workspaceLinks.all()
    ) {
      await expect(
        link,
      ).not.toHaveAttribute(
        'aria-current',
      )
    }
  },
)

test(
  'an inaccessible group shows a not-found view without foreign data',
  async ({ page }) => {
    await login(page, 'alex')

    await page.goto('/groups/999999')

    await expect(
      page.getByRole('heading', {
        name: 'Research group',
        level: 1,
      }),
    ).toBeVisible()

    await expect(
      page.getByText(
        'Research group is not available.',
      ),
    ).toBeVisible()

    // No workspace tab bar …
    await expect(
      page.getByRole('navigation', {
        name: 'Research group sections',
      }),
    ).toHaveCount(0)

    // … and no data or header of any other group.
    await expect(
      page.getByRole('heading', {
        name: 'E2E Robot Study',
        exact: true,
      }),
    ).toHaveCount(0)

    await expect(
      page.getByRole('heading', {
        name: 'Paper XYZ',
        exact: true,
      }),
    ).toHaveCount(0)

    await expect(
      page.getByRole('heading', {
        name: 'Robotics Lab',
        level: 1,
      }),
    ).toHaveCount(0)

    await expect(
      page.getByRole('heading', {
        name: 'FG Example',
        level: 1,
      }),
    ).toHaveCount(0)
  },
)
