import {
  expect,
  test,
  type Page,
} from '@playwright/test'

import { login } from './helpers'

async function selectResearchGroup(
  page: Page,
  name: string,
) {
  const switcher = page.getByRole(
    'button',
    {
      name: /^Research group:/,
    },
  )

  await expect(switcher).toBeVisible()
  await switcher.click()

  const menu = page.getByRole('menu')

  await expect(menu).toBeVisible()

  const groupOption = menu
    .getByRole('menuitem')
    .filter({
      hasText: name,
    })

  await expect(groupOption).toBeVisible()
  await groupOption.click()

  await expect(
    page.getByRole(
      'button',
      {
        name: `Research group: ${name}`,
      },
    ),
  ).toBeVisible()
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

    await expect(
      page.getByLabel(
        'Filter by research group',
      ),
    ).toHaveValue('all')

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

    await page
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
    // Placeholder group pages use the same explicit scope.
    // --------------------------------------------------------

    await selectResearchGroup(
      page,
      'Robotics Lab',
    )

    await page
      .getByRole('link', {
        name: /People/,
      })
      .click()

    await expect(page).toHaveURL(
      new RegExp(
        `/people\\?group=${roboticsGroupId}$`,
      ),
    )

    await expect(
      page.getByText(
        'People in Robotics Lab.',
        { exact: true },
      ),
    ).toBeVisible()

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
      /\/projects\/\d+$/,
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
      page.getByRole(
        'button',
        {
          name:
            'Research group: Robotics Lab',
        },
      ),
    ).toBeVisible()

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

    await page
      .getByRole('link', {
        name: /Meetings/,
      })
      .click()

    await expect(page).toHaveURL(
      /\/meetings\?group=\d+$/,
    )

    await page
      .getByRole('button', {
        name: /New meeting/,
      })
      .click()

    await page
      .getByLabel('Title')
      .fill(
        'E2E Robotics Scope Meeting',
      )

    await page
      .getByLabel('Date and time')
      .fill('2030-03-04T09:00')

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
      page.getByRole(
        'button',
        {
          name:
            'Research group: Robotics Lab',
        },
      ),
    ).toBeVisible()

    // Switching groups on an Entity exits to the new group's list.
    await selectResearchGroup(
      page,
      'FG Example',
    )

    await expect(page).toHaveURL(
      /\/meetings\?group=\d+$/,
    )

    await expect(
      page.getByRole(
        'button',
        {
          name:
            'Research group: FG Example',
        },
      ),
    ).toBeVisible()

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
      page.getByRole(
        'button',
        {
          name:
            'Research group: Robotics Lab',
        },
      ),
    ).toBeVisible()
  },
)
