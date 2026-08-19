import {
  expect,
  test,
} from '@playwright/test'

import {
  login,
  openProject,
  openProjects,
} from './helpers'

// TEMPORARY validation test for the Work Item inspector slice.
// Not part of the permanent suite — safe to delete after review.

const PROJECT_NAME =
  'E2E Inspector Validation Project'
const TASK_TITLE =
  'E2E Inspector Original Title'
const TASK_TITLE_EDITED =
  'E2E Inspector Edited Title'

const RACE_PROJECT_NAME =
  'E2E Inspector Race Project'
const RACE_TASK_TITLE =
  'E2E Inspector Race Original'
const RACE_TASK_TITLE_EDITED =
  'E2E Inspector Race Edited'

test(
  'Work Item inspector: create stays modal, edit is a non-modal autosaving region',
  async ({ page }) => {
    await login(page, 'alex')
    await openProjects(page)

    await page
      .getByRole('button', {
        name: /New project/,
      })
      .click()

    const createProjectDialog =
      page.getByRole('dialog', {
        name: 'Create project',
      })

    await createProjectDialog
      .getByLabel('Project name')
      .fill(PROJECT_NAME)

    await createProjectDialog
      .getByRole('button', {
        name: /Create project/,
      })
      .click()

    await expect(
      page.getByText(PROJECT_NAME, {
        exact: true,
      }),
    ).toBeVisible()

    await openProject(page, PROJECT_NAME)

    // --------------------------------------------------------
    // 1. Create flow still opens a modal dialog and can create
    //    a Work Item.
    // --------------------------------------------------------

    await page
      .getByRole('button', {
        name: /New work item/,
      })
      .click()

    const createDialog = page.getByRole(
      'dialog',
      { name: 'New work item' },
    )

    await expect(
      createDialog,
    ).toBeVisible()
    await expect(
      createDialog,
    ).toHaveAttribute(
      'aria-modal',
      'true',
    )

    await createDialog
      .getByLabel('Title')
      .fill(TASK_TITLE)

    await createDialog
      .getByRole('button', {
        name: /Create work item/,
      })
      .click()

    await expect(
      createDialog,
    ).not.toBeVisible()

    await expect(
      page.getByText(TASK_TITLE, {
        exact: true,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // 2. Opening an existing Work Item produces a non-modal
    //    detail region (not a dialog).
    // --------------------------------------------------------

    await page
      .getByRole('button', {
        name: `Open ${TASK_TITLE}`,
      })
      .click()

    const inspector = page.getByRole(
      'region',
      { name: 'Work item', exact: true },
    )

    await expect(
      inspector,
    ).toBeVisible()
    await expect(
      page.getByRole('dialog'),
    ).toHaveCount(0)

    // --------------------------------------------------------
    // 3. Detail mode has no "Save changes" / Cancel footer.
    // --------------------------------------------------------

    await expect(
      inspector.getByRole('button', {
        name: /Save changes/,
      }),
    ).toHaveCount(0)
    await expect(
      inspector.getByRole('button', {
        name: 'Cancel',
        exact: true,
      }),
    ).toHaveCount(0)

    // --------------------------------------------------------
    // 4. Title edit persists after blur.
    // --------------------------------------------------------

    await inspector
      .getByRole('button', {
        name: TASK_TITLE,
        exact: true,
      })
      .click()

    const titleInput =
      inspector.getByLabel(
        'Work item title',
      )

    await expect(
      titleInput,
    ).toBeVisible()

    await titleInput.fill(
      TASK_TITLE_EDITED,
    )
    await titleInput.press('Tab')

    await expect(
      inspector.getByRole('button', {
        name: TASK_TITLE_EDITED,
        exact: true,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // 5. Status change persists immediately without a global
    //    save.
    // --------------------------------------------------------

    const statusSelect =
      inspector.getByLabel('Status', {
        exact: true,
      })

    await expect(
      statusSelect,
    ).toHaveValue('todo')

    await statusSelect.selectOption(
      'in_progress',
    )

    await expect(
      statusSelect,
    ).toHaveValue('in_progress')

    // --------------------------------------------------------
    // 6. Closing and reopening the same Work Item shows
    //    persisted values.
    // --------------------------------------------------------

    await page
      .getByRole('button', {
        name: 'Close work item',
      })
      .click()

    await expect(
      inspector,
    ).not.toBeVisible()

    await page
      .getByRole('button', {
        name: `Open ${TASK_TITLE_EDITED}`,
      })
      .click()

    await expect(
      inspector,
    ).toBeVisible()

    await expect(
      inspector.getByRole('button', {
        name: TASK_TITLE_EDITED,
        exact: true,
      }),
    ).toBeVisible()

    await expect(
      inspector.getByLabel('Status', {
        exact: true,
      }),
    ).toHaveValue('in_progress')
  },
)

test(
  'Work Item inspector: overlapping detail changes are serialized and both persist',
  async ({ page }) => {
    await login(page, 'alex')
    await openProjects(page)

    await page
      .getByRole('button', {
        name: /New project/,
      })
      .click()

    const createProjectDialog =
      page.getByRole('dialog', {
        name: 'Create project',
      })

    await createProjectDialog
      .getByLabel('Project name')
      .fill(RACE_PROJECT_NAME)

    await createProjectDialog
      .getByRole('button', {
        name: /Create project/,
      })
      .click()

    await expect(
      page.getByText(
        RACE_PROJECT_NAME,
        { exact: true },
      ),
    ).toBeVisible()

    await openProject(
      page,
      RACE_PROJECT_NAME,
    )

    await page
      .getByRole('button', {
        name: /New work item/,
      })
      .click()

    const createDialog = page.getByRole(
      'dialog',
      { name: 'New work item' },
    )

    await createDialog
      .getByLabel('Title')
      .fill(RACE_TASK_TITLE)

    await createDialog
      .getByRole('button', {
        name: /Create work item/,
      })
      .click()

    await expect(
      createDialog,
    ).not.toBeVisible()

    await page
      .getByRole('button', {
        name: `Open ${RACE_TASK_TITLE}`,
      })
      .click()

    const inspector = page.getByRole(
      'region',
      { name: 'Work item', exact: true },
    )

    await expect(
      inspector,
    ).toBeVisible()

    // Delay only the FIRST PATCH's response for this Work Item, so
    // the second (title) change is fired while the first (status)
    // change's network round-trip is still outstanding. The request
    // itself is let through immediately via route.fetch() (so the
    // server processes it — and a second, unserialized request would
    // see its write already applied), but the *response* is held
    // back before being delivered to the page. That reproduces
    // "server processed early, client told late" — the exact
    // ordering that lets a stale response clobber a newer one on the
    // client if requests for the same Work Item aren't serialized.
    let patchCount = 0

    await page.route(
      '**/api/work-items/*/',
      async (route) => {
        if (
          route.request().method() !==
          'PATCH'
        ) {
          await route.continue()
          return
        }

        patchCount += 1

        if (patchCount === 1) {
          const response = await route.fetch()

          await new Promise((resolve) =>
            setTimeout(resolve, 1000),
          )

          await route.fulfill({
            response,
          })
          return
        }

        await route.continue()
      },
    )

    const statusSelect =
      inspector.getByLabel('Status', {
        exact: true,
      })

    // Fire the first change (status) — its PATCH response is delayed.
    await statusSelect.selectOption(
      'in_progress',
    )

    // Without awaiting that PATCH's completion, immediately fire a
    // second, different change (title).
    await inspector
      .getByRole('button', {
        name: RACE_TASK_TITLE,
        exact: true,
      })
      .click()

    const titleInput =
      inspector.getByLabel(
        'Work item title',
      )

    await titleInput.fill(
      RACE_TASK_TITLE_EDITED,
    )
    await titleInput.press('Tab')

    // While the first request is still in flight, the indicator must
    // show "Saving…" and never "Saved" — nothing may be reported as
    // saved while another save for this Work Item is still pending.
    await expect(
      inspector.getByText('Saving…', {
        exact: true,
      }),
    ).toBeVisible()
    await expect(
      inspector.getByText('Saved', {
        exact: true,
      }),
    ).toHaveCount(0)

    // Both changes eventually settle.
    await expect(
      statusSelect,
    ).toHaveValue('in_progress')
    await expect(
      inspector.getByRole('button', {
        name: RACE_TASK_TITLE_EDITED,
        exact: true,
      }),
    ).toBeVisible()

    expect(patchCount).toBe(2)

    // Give the deliberately delayed first response time to actually
    // arrive before checking the end state below — otherwise this
    // assertion could pass merely because it ran before the stale
    // response had a chance to land and (if unserialized) clobber
    // apiWorkItems.
    await page.waitForTimeout(1600)

    await expect(
      statusSelect,
    ).toHaveValue('in_progress')
    await expect(
      inspector.getByRole('button', {
        name: RACE_TASK_TITLE_EDITED,
        exact: true,
      }),
    ).toBeVisible()

    await page.unroute(
      '**/api/work-items/*/',
    )

    // Close and reopen: the canonical server state — fetched fresh,
    // with no client-side caching involved — must reflect BOTH
    // changes, proving neither PATCH silently lost the other's write.
    await page
      .getByRole('button', {
        name: 'Close work item',
      })
      .click()

    await expect(
      inspector,
    ).not.toBeVisible()

    await page
      .getByRole('button', {
        name: `Open ${RACE_TASK_TITLE_EDITED}`,
      })
      .click()

    await expect(
      inspector,
    ).toBeVisible()

    await expect(
      inspector.getByRole('button', {
        name: RACE_TASK_TITLE_EDITED,
        exact: true,
      }),
    ).toBeVisible()

    await expect(
      inspector.getByLabel('Status', {
        exact: true,
      }),
    ).toHaveValue('in_progress')
  },
)
