import {
  expect,
  test,
} from '@playwright/test'

import {
  login,
  logout,
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

const BLOCKED_PROJECT_NAME =
  'E2E Inspector Blocked Project'
const BLOCKED_TASK_A_TITLE =
  'E2E Inspector Blocked Task A'
const BLOCKED_TASK_B_TITLE =
  'E2E Inspector Blocked Task B'
const BLOCKED_REASON =
  'Waiting for ethics approval'

test(
  'Work Item inspector: Blocked cannot be activated without a ' +
    'non-empty reason',
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
      .fill(BLOCKED_PROJECT_NAME)

    await createProjectDialog
      .getByRole('button', {
        name: /Create project/,
      })
      .click()

    await expect(
      page.getByText(
        BLOCKED_PROJECT_NAME,
        { exact: true },
      ),
    ).toBeVisible()

    await openProject(
      page,
      BLOCKED_PROJECT_NAME,
    )

    for (const title of [
      BLOCKED_TASK_A_TITLE,
      BLOCKED_TASK_B_TITLE,
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
        name: `Open ${BLOCKED_TASK_A_TITLE}`,
      },
    )
    const boardCardB = page.getByRole(
      'button',
      {
        name: `Open ${BLOCKED_TASK_B_TITLE}`,
      },
    )

    const blockedSwitch = inspector.getByRole(
      'switch',
      { name: 'Blocked', exact: true },
    )
    const reasonInput = inspector.getByLabel(
      'Blocked reason',
      { exact: true },
    )

    // --------------------------------------------------------
    // 1 & 2. Open an unblocked Work Item.
    // --------------------------------------------------------

    await boardCardA.click()
    await expect(inspector).toBeVisible()
    await expect(
      blockedSwitch,
    ).toHaveAttribute(
      'aria-checked',
      'false',
    )

    // --------------------------------------------------------
    // 3. Activating Blocked reveals the reason editor beneath
    //    it, focused immediately, without an immediate PATCH.
    // --------------------------------------------------------

    await blockedSwitch.click()
    await expect(
      blockedSwitch,
    ).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await expect(
      reasonInput,
    ).toBeVisible()
    await expect(
      reasonInput,
    ).toBeFocused()
    await expect(
      reasonInput,
    ).toHaveAttribute(
      'placeholder',
      'Why is this work item blocked?',
    )

    // --------------------------------------------------------
    // 4. Leaving it empty must not block the item.
    // --------------------------------------------------------

    await reasonInput.press('Tab')
    await expect(
      blockedSwitch,
    ).toHaveAttribute(
      'aria-checked',
      'false',
    )
    await expect(
      reasonInput,
    ).toHaveCount(0)

    // Confirm the server was never told this Work Item is blocked.
    await page.reload()
    await boardCardA.click()
    await expect(inspector).toBeVisible()
    await expect(
      blockedSwitch,
    ).toHaveAttribute(
      'aria-checked',
      'false',
    )

    // A whitespace-only reason must not block the item either.
    await blockedSwitch.click()
    await expect(
      reasonInput,
    ).toBeFocused()
    await reasonInput.fill('   ')
    await reasonInput.press('Tab')
    await expect(
      blockedSwitch,
    ).toHaveAttribute(
      'aria-checked',
      'false',
    )
    await expect(
      reasonInput,
    ).toHaveCount(0)

    // --------------------------------------------------------
    // 5 & 6. Activate again, enter a valid reason, then switch
    //    to B without blurring first — the click's own focus
    //    change must blur (and queue) the reason PATCH before
    //    the inspector swaps to B.
    // --------------------------------------------------------

    await blockedSwitch.click()
    await expect(
      reasonInput,
    ).toBeFocused()
    await reasonInput.fill(BLOCKED_REASON)

    await boardCardB.click()

    // --------------------------------------------------------
    // 7. The reason persisted; A becomes blocked.
    // --------------------------------------------------------

    await expect(inspector).toBeVisible()
    await expect(
      inspector.getByRole('button', {
        name: BLOCKED_TASK_B_TITLE,
        exact: true,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // 8. Reopen A and confirm the reason is visible.
    // --------------------------------------------------------

    await boardCardA.click()
    await expect(inspector).toBeVisible()
    await expect(
      blockedSwitch,
    ).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await expect(
      inspector.getByText(
        BLOCKED_REASON,
        { exact: true },
      ),
    ).toBeVisible()

    // --------------------------------------------------------
    // 9 & 10. Yes -> No immediately PATCHes blockedReason: null
    //    and the reason disappears.
    // --------------------------------------------------------

    await blockedSwitch.click()
    await expect(
      blockedSwitch,
    ).toHaveAttribute(
      'aria-checked',
      'false',
    )
    await expect(
      inspector.getByText(
        BLOCKED_REASON,
        { exact: true },
      ),
    ).toHaveCount(0)

    // --------------------------------------------------------
    // 11. Reload/reopen confirms it remains unblocked.
    // --------------------------------------------------------

    await page.reload()
    await boardCardA.click()
    await expect(inspector).toBeVisible()
    await expect(
      blockedSwitch,
    ).toHaveAttribute(
      'aria-checked',
      'false',
    )
    await expect(
      inspector.getByText(
        BLOCKED_REASON,
        { exact: true },
      ),
    ).toHaveCount(0)
  },
)

const HISTORY_PROJECT_NAME =
  'E2E Inspector History Project'
const HISTORY_TASK_A_TITLE =
  'E2E Inspector History Task A'
const HISTORY_TASK_B_TITLE =
  'E2E Inspector History Task B'
const HISTORY_BLOCKED_REASON =
  'Waiting for data collection'

async function createHistoryTestProject(
  page: import('@playwright/test').Page,
  projectName: string,
) {
  await page
    .getByRole('button', { name: /New project/ })
    .click()

  const createProjectDialog = page.getByRole(
    'dialog',
    { name: 'Create project' },
  )

  await createProjectDialog
    .getByLabel('Project name')
    .fill(projectName)

  await createProjectDialog
    .getByRole('button', {
      name: /Create project/,
    })
    .click()

  await expect(
    page.getByText(projectName, { exact: true }),
  ).toBeVisible()

  await openProject(page, projectName)
}

async function createHistoryTestWorkItem(
  page: import('@playwright/test').Page,
  title: string,
) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/work-items/') &&
      response.request().method() === 'POST',
  )

  await page
    .getByRole('button', { name: /New work item/ })
    .click()

  const createDialog = page.getByRole('dialog', {
    name: 'New work item',
  })

  await createDialog
    .getByLabel('Title')
    .fill(title)

  await createDialog
    .getByRole('button', {
      name: /Create work item/,
    })
    .click()

  await expect(createDialog).not.toBeVisible()

  const response = await responsePromise
  const body = await response.json()
  return body.id as number
}

test(
  'Work Item inspector: Activity renders a readable History ' +
    'timeline, updates live after edits, and stays race-safe ' +
    'across switches',
  async ({ page }) => {
    await login(page, 'alex')
    await openProjects(page)
    await createHistoryTestProject(
      page,
      HISTORY_PROJECT_NAME,
    )

    const taskAId = await createHistoryTestWorkItem(
      page,
      HISTORY_TASK_A_TITLE,
    )
    await createHistoryTestWorkItem(
      page,
      HISTORY_TASK_B_TITLE,
    )

    const inspector = page.getByRole('region', {
      name: 'Work item',
      exact: true,
    })
    // History evolved into Activity — the combined feed still
    // renders History events, just under a renamed section heading.
    const historyHeading = inspector.getByRole(
      'heading',
      { name: 'Activity', exact: true },
    )
    // Scope timeline-text assertions to the Activity feed itself —
    // "Blocked reason" wording can otherwise also match the
    // Properties section's own reason readout.
    const historyList = inspector.getByRole('list')

    const boardCardA = page.getByRole('button', {
      name: `Open ${HISTORY_TASK_A_TITLE}`,
    })
    const boardCardB = page.getByRole('button', {
      name: `Open ${HISTORY_TASK_B_TITLE}`,
    })

    // --------------------------------------------------------
    // 1 & 2 & 3. Open A — History appears at the bottom with the
    // created event visible.
    // --------------------------------------------------------

    await boardCardA.click()
    await expect(inspector).toBeVisible()
    await expect(historyHeading).toBeVisible()

    await expect(
      historyList.getByText(
        `Alex Dev created this work item`,
      ),
    ).toBeVisible()

    // --------------------------------------------------------
    // 4 & 5. Change status through the inspector — a corresponding
    // history event appears without closing the inspector.
    // --------------------------------------------------------

    const statusSelect = inspector.getByLabel(
      'Status',
      { exact: true },
    )
    await statusSelect.selectOption('in_progress')

    await expect(
      historyList.getByText('Alex Dev changed status'),
    ).toBeVisible()
    await expect(
      historyList.getByText('To do → In progress'),
    ).toBeVisible()

    // --------------------------------------------------------
    // 6. A blocked-reason change creates an understandable entry.
    // --------------------------------------------------------

    await inspector
      .getByRole('switch', {
        name: 'Blocked',
        exact: true,
      })
      .click()

    const reasonInput = inspector.getByLabel(
      'Blocked reason',
      { exact: true },
    )
    await reasonInput.fill(HISTORY_BLOCKED_REASON)
    await reasonInput.press('Tab')

    await expect(
      historyList.getByText(
        'Alex Dev marked this work item as blocked',
      ),
    ).toBeVisible()
    await expect(
      historyList.getByText(HISTORY_BLOCKED_REASON, {
        exact: true,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // 10. No raw JSON anywhere in the History section.
    // --------------------------------------------------------

    const historyText = await inspector.innerText()
    expect(historyText).not.toContain('"changes"')
    expect(historyText).not.toContain('"eventType"')
    expect(historyText).not.toContain('{"from"')

    // --------------------------------------------------------
    // 7 & 8. Switch from A to B — B's History replaces A's.
    // --------------------------------------------------------

    await boardCardB.click()
    await expect(inspector).toBeVisible()

    await expect(
      historyList.getByText(
        'Alex Dev created this work item',
      ),
    ).toBeVisible()
    await expect(
      historyList.getByText('Alex Dev changed status'),
    ).toHaveCount(0)
    await expect(
      historyList.getByText(HISTORY_BLOCKED_REASON, {
        exact: true,
      }),
    ).toHaveCount(0)

    // --------------------------------------------------------
    // 9. Switch back to A — the correct (A) history returns.
    // --------------------------------------------------------

    await boardCardA.click()
    await expect(inspector).toBeVisible()
    await expect(
      historyList.getByText('Alex Dev changed status'),
    ).toBeVisible()
    await expect(
      historyList.getByText(HISTORY_BLOCKED_REASON, {
        exact: true,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // Race regression: delay A's next History response, switch to
    // B while that fetch is still in flight, and confirm the late
    // A response never overwrites B's History once it finally
    // arrives.
    // --------------------------------------------------------

    // Leave A first so the next click on A starts a brand new fetch
    // (clicking an already-open Work Item is a no-op).
    await boardCardB.click()
    await expect(inspector).toBeVisible()
    await expect(
      historyList.getByText(
        'Alex Dev created this work item',
      ),
    ).toBeVisible()

    await page.route(
      `**/api/work-items/${taskAId}/history/`,
      async (route) => {
        const response = await route.fetch()
        await new Promise((resolve) =>
          setTimeout(resolve, 1200),
        )
        await route.fulfill({ response })
      },
    )

    // Switch to A — its History fetch is now in flight (delayed) —
    // then immediately switch back to B before it resolves.
    await boardCardA.click()
    await boardCardB.click()

    await expect(inspector).toBeVisible()
    await expect(
      historyList.getByText(
        'Alex Dev created this work item',
      ),
    ).toBeVisible()

    // Give the delayed A response time to actually land.
    await page.waitForTimeout(1500)

    // B's History must still be showing — never clobbered by the
    // stale, late-arriving A response.
    await expect(
      historyList.getByText('Alex Dev changed status'),
    ).toHaveCount(0)
    await expect(
      historyList.getByText(HISTORY_BLOCKED_REASON, {
        exact: true,
      }),
    ).toHaveCount(0)

    await page.unroute(
      `**/api/work-items/${taskAId}/history/`,
    )
  },
)

const COMMENT_PROJECT_NAME =
  'E2E Inspector Comment Project'
const COMMENT_TASK_A_TITLE =
  'E2E Inspector Comment Task A'
const COMMENT_BODY_A =
  'Can we confirm the final references before marking this done?'

test(
  'Work Item inspector: Activity comment composer expands, posts ' +
    'via Cmd/Ctrl+Enter without closing the inspector, and reads ' +
    'as visually distinct from System History',
  async ({ page }) => {
    await login(page, 'alex')
    await openProjects(page)
    await createHistoryTestProject(
      page,
      COMMENT_PROJECT_NAME,
    )
    await createHistoryTestWorkItem(
      page,
      COMMENT_TASK_A_TITLE,
    )

    const inspector = page.getByRole('region', {
      name: 'Work item',
      exact: true,
    })
    const activityHeading = inspector.getByRole(
      'heading',
      { name: 'Activity', exact: true },
    )
    const activityList = inspector.getByRole('list')

    await page
      .getByRole('button', {
        name: `Open ${COMMENT_TASK_A_TITLE}`,
      })
      .click()
    await expect(inspector).toBeVisible()
    await expect(activityHeading).toBeVisible()

    // --------------------------------------------------------
    // 3. Idle composer is compact — a single "Add a comment…"
    //    row, not a big form.
    // --------------------------------------------------------

    const idleComposer = inspector.getByRole(
      'button',
      { name: 'Add a comment…' },
    )
    await expect(idleComposer).toBeVisible()

    const textarea = inspector.getByLabel(
      'Comment',
      { exact: true },
    )
    await expect(textarea).toHaveCount(0)

    // Clicking it expands into a textarea with Cancel / Comment.
    await idleComposer.click()
    await expect(textarea).toBeVisible()
    await expect(
      inspector.getByRole('button', {
        name: 'Cancel',
        exact: true,
      }),
    ).toBeVisible()

    const postButton = inspector.getByRole(
      'button',
      { name: 'Comment', exact: true },
    )
    await expect(postButton).toBeVisible()
    await expect(postButton).toBeDisabled()

    // --------------------------------------------------------
    // 4 & 5. Cmd/Ctrl+Enter posts without clicking the button,
    //    and the comment appears without closing the inspector.
    // --------------------------------------------------------

    await textarea.fill(COMMENT_BODY_A)
    await expect(postButton).toBeEnabled()
    await textarea.press('ControlOrMeta+Enter')

    await expect(inspector).toBeVisible()
    await expect(
      activityList.getByText(COMMENT_BODY_A, {
        exact: true,
      }),
    ).toBeVisible()

    // Composer collapses back to idle after a successful post.
    await expect(idleComposer).toBeVisible()
    await expect(textarea).toHaveCount(0)

    // --------------------------------------------------------
    // 2 & 6. The System History "created" entry still renders,
    //    in its own quiet/system voice, alongside — but visually
    //    distinct from — the human comment's own body text.
    // --------------------------------------------------------

    await expect(
      activityList.getByText(
        'Alex Dev created this work item',
      ),
    ).toBeVisible()
    await expect(
      activityList.getByText('Alex Dev', {
        exact: true,
      }),
    ).toBeVisible()
    await expect(
      activityList.getByText(COMMENT_BODY_A, {
        exact: true,
      }),
    ).toBeVisible()
  },
)

const DRAFT_PROJECT_NAME =
  'E2E Inspector Comment Draft Project'
const DRAFT_TASK_A_TITLE =
  'E2E Inspector Draft Task A'
const DRAFT_TASK_B_TITLE =
  'E2E Inspector Draft Task B'
const DRAFT_TEXT_A =
  'Draft only meant for Task A — never sent yet.'
const POSTED_COMMENT_A =
  'Posted comment that belongs to Task A only.'

test(
  'Work Item inspector: comment drafts survive Work Item ' +
    'switching, never leak across items, and Activity stays ' +
    'race-safe across switches',
  async ({ page }) => {
    await login(page, 'alex')
    await openProjects(page)
    await createHistoryTestProject(
      page,
      DRAFT_PROJECT_NAME,
    )

    const taskAId = await createHistoryTestWorkItem(
      page,
      DRAFT_TASK_A_TITLE,
    )
    await createHistoryTestWorkItem(
      page,
      DRAFT_TASK_B_TITLE,
    )

    const inspector = page.getByRole('region', {
      name: 'Work item',
      exact: true,
    })
    const activityList = inspector.getByRole('list')

    const boardCardA = page.getByRole('button', {
      name: `Open ${DRAFT_TASK_A_TITLE}`,
    })
    const boardCardB = page.getByRole('button', {
      name: `Open ${DRAFT_TASK_B_TITLE}`,
    })

    const idleComposer = inspector.getByRole(
      'button',
      { name: 'Add a comment…' },
    )
    const textarea = inspector.getByLabel(
      'Comment',
      { exact: true },
    )

    // --------------------------------------------------------
    // 7. Open A, type an unsent draft — do not send it.
    // --------------------------------------------------------

    await boardCardA.click()
    await expect(inspector).toBeVisible()
    await idleComposer.click()
    await textarea.fill(DRAFT_TEXT_A)

    // --------------------------------------------------------
    // 8 & 11. Switch to B without sending — B starts with a
    //    clean, idle composer; A's draft never appears on B.
    // --------------------------------------------------------

    await boardCardB.click()
    await expect(inspector).toBeVisible()
    await expect(idleComposer).toBeVisible()
    await expect(textarea).toHaveCount(0)
    await expect(
      activityList.getByText(DRAFT_TEXT_A),
    ).toHaveCount(0)

    // --------------------------------------------------------
    // 9. Returning to A restores the composer, expanded, with
    //    the exact unsent draft text still in it — and it was
    //    genuinely never sent to the server.
    // --------------------------------------------------------

    await boardCardA.click()
    await expect(inspector).toBeVisible()
    await expect(textarea).toBeVisible()
    await expect(textarea).toHaveValue(DRAFT_TEXT_A)
    await expect(
      activityList.getByText(DRAFT_TEXT_A),
    ).toHaveCount(0)

    // --------------------------------------------------------
    // Now actually post A's comment, then confirm it never
    // leaks onto B's Activity feed (11, continued).
    // --------------------------------------------------------

    await textarea.fill(POSTED_COMMENT_A)
    await inspector
      .getByRole('button', {
        name: 'Comment',
        exact: true,
      })
      .click()

    await expect(
      activityList.getByText(POSTED_COMMENT_A, {
        exact: true,
      }),
    ).toBeVisible()

    await boardCardB.click()
    await expect(inspector).toBeVisible()
    await expect(
      activityList.getByText(POSTED_COMMENT_A, {
        exact: true,
      }),
    ).toHaveCount(0)

    // --------------------------------------------------------
    // 12. Race regression: delay A's Activity responses, switch
    //    to A and immediately back to B before they resolve — B's
    //    Activity must never be clobbered by the late response.
    // --------------------------------------------------------

    await page.route(
      `**/api/work-items/${taskAId}/comments/`,
      async (route) => {
        if (route.request().method() !== 'GET') {
          await route.continue()
          return
        }

        const response = await route.fetch()
        await new Promise((resolve) =>
          setTimeout(resolve, 1200),
        )
        await route.fulfill({ response })
      },
    )
    await page.route(
      `**/api/work-items/${taskAId}/history/`,
      async (route) => {
        const response = await route.fetch()
        await new Promise((resolve) =>
          setTimeout(resolve, 1200),
        )
        await route.fulfill({ response })
      },
    )

    await boardCardA.click()
    await boardCardB.click()

    await expect(inspector).toBeVisible()
    await expect(
      activityList.getByText(POSTED_COMMENT_A, {
        exact: true,
      }),
    ).toHaveCount(0)

    // Give the delayed A responses time to actually land.
    await page.waitForTimeout(1500)

    // Still B's Activity — never clobbered by the delayed, stale
    // A response landing after the switch.
    await expect(
      activityList.getByText(POSTED_COMMENT_A, {
        exact: true,
      }),
    ).toHaveCount(0)

    await page.unroute(
      `**/api/work-items/${taskAId}/comments/`,
    )
    await page.unroute(
      `**/api/work-items/${taskAId}/history/`,
    )
  },
)

const VIEWER_PROJECT_NAME =
  'E2E Inspector Viewer Comment Project'
const VIEWER_TASK_TITLE =
  'E2E Inspector Viewer Comment Task'

test(
  'Work Item inspector: a viewer never sees an enabled comment ' +
    'composer',
  async ({ page }) => {
    await login(page, 'alex')
    await openProjects(page)
    await createHistoryTestProject(
      page,
      VIEWER_PROJECT_NAME,
    )
    await createHistoryTestWorkItem(
      page,
      VIEWER_TASK_TITLE,
    )

    // --------------------------------------------------------
    // Invite Laura as a Viewer.
    // --------------------------------------------------------

    await page
      .getByRole('link', {
        name: 'Settings',
        exact: true,
      })
      .click()

    await page
      .getByRole('button', {
        name: /Add member/,
      })
      .click()

    const addMemberDialog = page.getByRole(
      'dialog',
      { name: 'Add project member' },
    )
    await expect(addMemberDialog).toBeVisible()

    await addMemberDialog
      .getByLabel('Select person')
      .fill('laura')

    await addMemberDialog
      .getByRole('button')
      .filter({ hasText: '@laura' })
      .click()

    await addMemberDialog
      .getByText('Viewer', { exact: true })
      .click()

    await addMemberDialog
      .getByRole('button', {
        name: /Add member/,
      })
      .click()

    await expect(
      addMemberDialog,
    ).not.toBeVisible()

    // --------------------------------------------------------
    // 13. As Laura (viewer), the Work Item inspector never
    //    renders an enabled comment composer.
    // --------------------------------------------------------

    await logout(page)
    await login(page, 'laura')
    await openProjects(page)
    await openProject(page, VIEWER_PROJECT_NAME)

    await page
      .getByRole('button', {
        name: `Open ${VIEWER_TASK_TITLE}`,
      })
      .click()

    const inspector = page.getByRole('region', {
      name: 'Work item',
      exact: true,
    })
    await expect(inspector).toBeVisible()

    // No composer at all — not merely disabled.
    await expect(
      inspector.getByRole('button', {
        name: 'Add a comment…',
      }),
    ).toHaveCount(0)
    await expect(
      inspector.getByLabel('Comment', {
        exact: true,
      }),
    ).toHaveCount(0)
  },
)
