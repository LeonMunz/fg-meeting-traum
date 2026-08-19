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

const SWITCH_PROJECT_NAME =
  'E2E Inspector Switch Project'
const SWITCH_TASK_A_TITLE =
  'E2E Inspector Switch Task A'
const SWITCH_TASK_A_TITLE_EDITED =
  'E2E Inspector Switch Task A Edited'
const SWITCH_TASK_B_TITLE =
  'E2E Inspector Switch Task B'
const SWITCH_TASK_B_DESCRIPTION_EDITED =
  'E2E Inspector Switch Task B description edited'

test(
  'Work Item inspector: clicking another Work Item switches the ' +
    'open inspector in place instead of being blocked, without ' +
    'losing an in-progress edit',
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
      .fill(SWITCH_PROJECT_NAME)

    await createProjectDialog
      .getByRole('button', {
        name: /Create project/,
      })
      .click()

    await expect(
      page.getByText(
        SWITCH_PROJECT_NAME,
        { exact: true },
      ),
    ).toBeVisible()

    await openProject(
      page,
      SWITCH_PROJECT_NAME,
    )

    for (const title of [
      SWITCH_TASK_A_TITLE,
      SWITCH_TASK_B_TITLE,
    ]) {
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
        .fill(title)

      await createDialog
        .getByRole('button', {
          name: /Create work item/,
        })
        .click()

      await expect(
        createDialog,
      ).not.toBeVisible()
    }

    const inspector = page.getByRole(
      'region',
      { name: 'Work item', exact: true },
    )

    const boardCardA = page.getByRole(
      'button',
      {
        name: `Open ${SWITCH_TASK_A_TITLE}`,
      },
    )
    const boardCardAEdited = page.getByRole(
      'button',
      {
        name: `Open ${SWITCH_TASK_A_TITLE_EDITED}`,
      },
    )
    const boardCardB = page.getByRole(
      'button',
      {
        name: `Open ${SWITCH_TASK_B_TITLE}`,
      },
    )

    // --------------------------------------------------------
    // Board view: open A, start (but do not blur) a title edit,
    // then click B without closing the inspector first.
    // --------------------------------------------------------

    await boardCardA.click()
    await expect(inspector).toBeVisible()

    await inspector
      .getByRole('button', {
        name: SWITCH_TASK_A_TITLE,
        exact: true,
      })
      .click()

    const titleInput = inspector.getByLabel(
      'Work item title',
    )

    await expect(titleInput).toBeVisible()
    await titleInput.fill(
      SWITCH_TASK_A_TITLE_EDITED,
    )

    // Click B directly, with A's title edit still focused and
    // un-blurred — the click's own focus change must blur (and
    // therefore commit) A's edit before the inspector swaps to B.
    await boardCardB.click()

    // The inspector never closes — it swaps content in place.
    await expect(inspector).toBeVisible()
    await expect(
      inspector.getByRole('button', {
        name: SWITCH_TASK_B_TITLE,
        exact: true,
      }),
    ).toBeVisible()

    // Selected-state moved from A to B.
    await expect(
      boardCardB,
    ).toHaveAttribute(
      'data-selected',
      'true',
    )
    await expect(
      boardCardA,
    ).not.toHaveAttribute(
      'data-selected',
      'true',
    )

    // A's edit was not silently discarded: it is visible on the
    // Board under its new title as soon as the commit settles.
    await expect(
      boardCardAEdited,
    ).toBeVisible()

    // Clicking the already-open Work Item (B) again is a no-op.
    await boardCardB.click()
    await expect(inspector).toBeVisible()
    await expect(
      inspector.getByRole('button', {
        name: SWITCH_TASK_B_TITLE,
        exact: true,
      }),
    ).toBeVisible()

    // Reopening A confirms its edit persisted server-side.
    await boardCardAEdited.click()
    await expect(inspector).toBeVisible()
    await expect(
      inspector.getByRole('button', {
        name: SWITCH_TASK_A_TITLE_EDITED,
        exact: true,
      }),
    ).toBeVisible()

    await page
      .getByRole('button', {
        name: 'Close work item',
      })
      .click()
    await expect(
      inspector,
    ).not.toBeVisible()

    // --------------------------------------------------------
    // List view: the same in-place switch, with an in-progress
    // description edit protected instead of a title edit.
    // --------------------------------------------------------

    await page
      .getByRole('button', {
        name: 'List',
      })
      .click()

    const listRowAEdited = page.getByRole(
      'button',
      {
        name: `Open ${SWITCH_TASK_A_TITLE_EDITED}`,
      },
    )
    const listRowB = page.getByRole(
      'button',
      {
        name: `Open ${SWITCH_TASK_B_TITLE}`,
      },
    )

    await listRowB.click()
    await expect(inspector).toBeVisible()

    await inspector
      .getByRole('button', {
        name: 'Add description…',
      })
      .click()

    const descriptionInput =
      inspector.getByLabel(
        'Work item description',
      )

    await expect(
      descriptionInput,
    ).toBeVisible()
    await descriptionInput.fill(
      SWITCH_TASK_B_DESCRIPTION_EDITED,
    )

    await listRowAEdited.click()

    await expect(inspector).toBeVisible()
    await expect(
      inspector.getByRole('button', {
        name: SWITCH_TASK_A_TITLE_EDITED,
        exact: true,
      }),
    ).toBeVisible()

    await expect(
      listRowAEdited,
    ).toHaveClass(/outline-primary/)
    await expect(
      listRowB,
    ).not.toHaveClass(/outline-primary/)

    // B's in-progress description edit was committed, not lost.
    await listRowB.click()
    await expect(inspector).toBeVisible()
    await expect(
      inspector.getByText(
        SWITCH_TASK_B_DESCRIPTION_EDITED,
        { exact: true },
      ),
    ).toBeVisible()
  },
)
