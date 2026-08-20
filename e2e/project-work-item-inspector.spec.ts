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
        name: 'Add a description…',
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
    // The compact editor's placeholder isn't a native `placeholder`
    // attribute (it's a contenteditable, not a textarea) — Tiptap's
    // Placeholder extension renders it via `data-placeholder` +
    // CSS `::before` on the empty paragraph (see index.css).
    await expect(
      reasonInput.locator('p'),
    ).toHaveAttribute(
      'data-placeholder',
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
    await page.keyboard.type('   ')
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
    await page.keyboard.type(BLOCKED_REASON)

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

const BLOCKED_RICH_PROJECT_NAME =
  'E2E Inspector Blocked Rich Project'
const BLOCKED_RICH_TASK_A_TITLE =
  'E2E Inspector Blocked Rich Task A'
const BLOCKED_RICH_TASK_B_TITLE =
  'E2E Inspector Blocked Rich Task B'

test(
  'Work Item inspector: Blocked reason is a compact Markdown/Rich-Text ' +
    'editor — typed Markdown becomes formatted content, commits on ' +
    'blur/switch, persists through reload, editing an existing reason ' +
    'applies Bold through the BubbleMenu, and Esc cancels a pending ' +
    'block / restores the canonical reason without closing the inspector',
  async ({ page }) => {
    await login(page, 'alex')
    await openProjects(page)
    await createHistoryTestProject(
      page,
      BLOCKED_RICH_PROJECT_NAME,
    )

    await createHistoryTestWorkItem(
      page,
      BLOCKED_RICH_TASK_A_TITLE,
    )
    await createHistoryTestWorkItem(
      page,
      BLOCKED_RICH_TASK_B_TITLE,
    )

    const inspector = page.getByRole('region', {
      name: 'Work item',
      exact: true,
    })

    const boardCardA = page.getByRole('button', {
      name: `Open ${BLOCKED_RICH_TASK_A_TITLE}`,
    })
    const boardCardB = page.getByRole('button', {
      name: `Open ${BLOCKED_RICH_TASK_B_TITLE}`,
    })

    const blockedSwitch = inspector.getByRole('switch', {
      name: 'Blocked',
      exact: true,
    })
    const reasonEditor = inspector.getByLabel('Blocked reason', {
      exact: true,
    })

    // --------------------------------------------------------
    // 1-3. Open an unblocked Work Item, activate Blocked — the
    //    compact rich editor appears, focused, with its own
    //    (smaller) Formatting toolbar.
    // --------------------------------------------------------

    await boardCardA.click()
    await expect(inspector).toBeVisible()
    await expect(blockedSwitch).toHaveAttribute(
      'aria-checked',
      'false',
    )

    await blockedSwitch.click()
    await expect(reasonEditor).toBeVisible()
    await expect(reasonEditor).toBeFocused()

    const reasonToolbar = inspector.getByRole('toolbar', {
      name: 'Formatting',
    })
    await expect(reasonToolbar).toBeVisible()

    for (const label of [
      'Bold',
      'Italic',
      'Inline code',
      'Link',
      'Bullet list',
      'Numbered list',
    ]) {
      await expect(
        reasonToolbar.getByRole('button', {
          name: label,
          exact: true,
        }),
      ).toBeVisible()
    }
    for (const label of [
      'Checklist',
      'Quote',
      'Heading 2',
      'Heading 3',
    ]) {
      await expect(
        reasonToolbar.getByRole('button', {
          name: label,
          exact: true,
        }),
      ).toHaveCount(0)
    }

    // --------------------------------------------------------
    // 4. Enter Markdown containing bold, a bullet list, and
    //    inline code.
    // --------------------------------------------------------

    await page.keyboard.type('Waiting for ')
    await page.keyboard.type('**reviewer feedback**')
    await page.keyboard.type(' on the draft:')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')

    await reasonToolbar
      .getByRole('button', {
        name: 'Bullet list',
        exact: true,
      })
      .click()
    await page.keyboard.type('Reviewer 1')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Reviewer 2 via ')
    await page.keyboard.type('`review.md`')

    // --------------------------------------------------------
    // 5 & 6. Switch to B without blurring first — the click's own
    //    focus change must blur (and queue/commit) the reason
    //    PATCH before the inspector swaps.
    // --------------------------------------------------------

    await boardCardB.click()
    await expect(inspector).toBeVisible()
    await expect(
      inspector.getByRole('button', {
        name: BLOCKED_RICH_TASK_B_TITLE,
        exact: true,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // 7 & 8. Reopen A — Blocked = Yes, reason renders formatted,
    //    never as raw Markdown syntax.
    // --------------------------------------------------------

    await boardCardA.click()
    await expect(inspector).toBeVisible()
    await expect(blockedSwitch).toHaveAttribute(
      'aria-checked',
      'true',
    )

    await expect(
      inspector.locator('strong', {
        hasText: 'reviewer feedback',
      }),
    ).toBeVisible()
    await expect(
      inspector.locator('li', {
        hasText: /^Reviewer 1$/,
      }),
    ).toBeVisible()
    await expect(
      inspector.locator('code', {
        hasText: 'review.md',
      }),
    ).toBeVisible()

    const postedText = await inspector.innerText()
    expect(postedText).not.toContain('**')
    expect(postedText).not.toContain('`review.md`')

    // --------------------------------------------------------
    // 9. Reload and confirm persistence.
    // --------------------------------------------------------

    await page.reload()
    await boardCardA.click()
    await expect(inspector).toBeVisible()
    await expect(blockedSwitch).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await expect(
      inspector.locator('strong', {
        hasText: 'reviewer feedback',
      }),
    ).toBeVisible()
    await expect(
      inspector.locator('li', {
        hasText: /^Reviewer 1$/,
      }),
    ).toBeVisible()
    await expect(
      inspector.locator('code', {
        hasText: 'review.md',
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // 10 & 11. Click the existing reason to edit it, select all,
    //    and apply Bold through the BubbleMenu — reusing the exact
    //    same BubbleMenu Description/Comments use.
    // --------------------------------------------------------

    await inspector
      .getByRole('button', { name: /Waiting for/ })
      .click()
    await expect(reasonEditor).toBeVisible()
    await expect(reasonEditor).toBeFocused()
    await expect(reasonEditor).toContainText('Waiting for')

    await page.keyboard.press('ControlOrMeta+a')

    const bubbleToolbar = inspector.getByRole('toolbar', {
      name: 'Selection formatting',
    })
    await expect(bubbleToolbar).toBeVisible()

    const bubbleBoldButton = bubbleToolbar.getByRole('button', {
      name: 'Bold',
      exact: true,
    })
    await bubbleBoldButton.click()
    await expect(bubbleBoldButton).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    // --------------------------------------------------------
    // 12 & 13. Save via blur (switching away), reopen, and
    //    confirm the additional formatting persisted.
    // --------------------------------------------------------

    await boardCardB.click()
    await expect(inspector).toBeVisible()

    await boardCardA.click()
    await expect(inspector).toBeVisible()
    await expect(blockedSwitch).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await expect(
      inspector.locator('strong', {
        hasText: 'Waiting for',
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // 18. Esc during a new pending block cancels it — no PATCH,
    //    Blocked reverts to No, and the inspector stays open.
    // --------------------------------------------------------

    await boardCardB.click()
    await expect(inspector).toBeVisible()
    await expect(blockedSwitch).toHaveAttribute(
      'aria-checked',
      'false',
    )

    await blockedSwitch.click()
    await expect(reasonEditor).toBeVisible()
    await page.keyboard.type(
      'Just started typing a reason',
    )
    await page.keyboard.press('Escape')

    await expect(inspector).toBeVisible()
    await expect(blockedSwitch).toHaveAttribute(
      'aria-checked',
      'false',
    )
    await expect(reasonEditor).toHaveCount(0)

    // Confirm nothing was actually sent to the server.
    await page.reload()
    await boardCardB.click()
    await expect(inspector).toBeVisible()
    await expect(blockedSwitch).toHaveAttribute(
      'aria-checked',
      'false',
    )

    // --------------------------------------------------------
    // 19. Esc while editing an EXISTING blocked reason restores
    //    the canonical Markdown and keeps the item blocked — the
    //    inspector stays open throughout.
    // --------------------------------------------------------

    await boardCardA.click()
    await expect(inspector).toBeVisible()
    await expect(blockedSwitch).toHaveAttribute(
      'aria-checked',
      'true',
    )

    await inspector
      .getByRole('button', { name: /Waiting for/ })
      .click()
    await expect(reasonEditor).toBeVisible()

    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type(
      'Trying to overwrite the saved reason',
    )
    await page.keyboard.press('Escape')

    await expect(inspector).toBeVisible()
    await expect(blockedSwitch).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await expect(reasonEditor).toHaveCount(0)
    await expect(
      inspector.getByText(
        'Trying to overwrite the saved reason',
      ),
    ).toHaveCount(0)
    await expect(
      inspector.locator('strong', {
        hasText: 'Waiting for',
      }),
    ).toBeVisible()
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
    const historyList = inspector.getByRole('list', { name: 'Activity' })

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
    await expect(reasonInput).toBeFocused()
    await page.keyboard.type(HISTORY_BLOCKED_REASON)
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

test(
  'Work Item inspector: Activity comment composer is a compact ' +
    'Markdown/Rich-Text editor — typed Markdown becomes formatted ' +
    'content, posts via Cmd/Ctrl+Enter without closing the inspector, ' +
    'persists through reload, and reads as visually distinct from ' +
    'System History',
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
    const activityList = inspector.getByRole('list', { name: 'Activity' })

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

    const composerEditor = inspector.getByLabel(
      'Comment',
      { exact: true },
    )
    await expect(composerEditor).toHaveCount(0)

    // Clicking it expands into a compact RichMarkdownEditor with
    // Cancel / Comment, autofocused.
    await idleComposer.click()
    await expect(composerEditor).toBeVisible()
    await expect(composerEditor).toBeFocused()
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
    // 2. The compact toolbar only shows the smaller Comment subset
    //    (Bold/Italic/Inline code/Link/Bullet/Numbered list) — never
    //    the Description toolbar's headings/quote/checklist.
    // --------------------------------------------------------

    const composerToolbar = inspector.getByRole('toolbar', {
      name: 'Formatting',
    })
    await expect(composerToolbar).toBeVisible()
    await expect(
      inspector.getByText('Markdown supported', {
        exact: true,
      }),
    ).toBeVisible()

    for (const label of [
      'Bold',
      'Italic',
      'Inline code',
      'Link',
      'Bullet list',
      'Numbered list',
    ]) {
      await expect(
        composerToolbar.getByRole('button', {
          name: label,
          exact: true,
        }),
      ).toBeVisible()
    }
    for (const label of [
      'Checklist',
      'Quote',
      'Heading 2',
      'Heading 3',
    ]) {
      await expect(
        composerToolbar.getByRole('button', {
          name: label,
          exact: true,
        }),
      ).toHaveCount(0)
    }

    // --------------------------------------------------------
    // 3. Type Markdown-supported content — **bold** and
    //    `inline code` typed as literal Markdown input (proving the
    //    compact editor's own input rules turn typed syntax into
    //    formatting live), plus a bullet list via the toolbar.
    // --------------------------------------------------------

    await page.keyboard.type('We should ')
    await page.keyboard.type('**verify this**')
    await page.keyboard.type(' before merging.')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')

    await composerToolbar
      .getByRole('button', {
        name: 'Bullet list',
        exact: true,
      })
      .click()
    await page.keyboard.type('Check references')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Check figures with ')
    await page.keyboard.type('`refs.bib`')

    // --------------------------------------------------------
    // 4 & 5. Cmd/Ctrl+Enter posts without clicking the button,
    //    and the comment appears without closing the inspector —
    //    rendered as formatted content, never raw Markdown syntax.
    // --------------------------------------------------------

    await expect(postButton).toBeEnabled()
    await page.keyboard.press('ControlOrMeta+Enter')

    await expect(inspector).toBeVisible()
    await expect(
      activityList.locator('strong', {
        hasText: 'verify this',
      }),
    ).toBeVisible()
    await expect(
      activityList.locator('li', {
        hasText: /^Check references$/,
      }),
    ).toBeVisible()
    await expect(
      activityList.locator('code', {
        hasText: 'refs.bib',
      }),
    ).toBeVisible()

    const postedText = await activityList.innerText()
    expect(postedText).not.toContain('**')
    expect(postedText).not.toContain('`refs.bib`')

    // Composer collapses back to idle after a successful post — and
    // with it, its toolbar (no toolbar left anywhere: the posted
    // comment renders read-only).
    await expect(idleComposer).toBeVisible()
    await expect(composerEditor).toHaveCount(0)
    await expect(
      inspector.getByRole('toolbar', { name: 'Formatting' }),
    ).toHaveCount(0)

    // --------------------------------------------------------
    // 2 & 6. The System History "created" entry still renders,
    //    in its own quiet/system voice, alongside — but visually
    //    distinct from — the human comment's own formatted body.
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

    // --------------------------------------------------------
    // Reload/reopen — the formatted Comment still renders correctly.
    // --------------------------------------------------------

    await page.reload()
    await page
      .getByRole('button', {
        name: `Open ${COMMENT_TASK_A_TITLE}`,
      })
      .click()
    await expect(inspector).toBeVisible()

    await expect(
      activityList.locator('strong', {
        hasText: 'verify this',
      }),
    ).toBeVisible()
    await expect(
      activityList.locator('li', {
        hasText: /^Check references$/,
      }),
    ).toBeVisible()
    await expect(
      activityList.locator('code', {
        hasText: 'refs.bib',
      }),
    ).toBeVisible()

    const reloadedText = await activityList.innerText()
    expect(reloadedText).not.toContain('**')
    expect(reloadedText).not.toContain('`refs.bib`')
  },
)

const DRAFT_PROJECT_NAME =
  'E2E Inspector Comment Draft Project'
const DRAFT_TASK_A_TITLE =
  'E2E Inspector Draft Task A'
const DRAFT_TASK_B_TITLE =
  'E2E Inspector Draft Task B'
const DRAFT_PREFIX_A = 'Draft only meant for Task A — '
const DRAFT_BOLD_A = 'never sent yet'
const POSTED_COMMENT_A =
  'Posted comment that belongs to Task A only.'

test(
  'Work Item inspector: comment drafts (including Markdown ' +
    'formatting) survive Work Item switching, never leak across ' +
    'items, Esc collapses without discarding a draft, explicit ' +
    'Cancel discards it, and Activity stays race-safe across ' +
    'switches',
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
    const activityList = inspector.getByRole('list', { name: 'Activity' })

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
    const composerEditor = inspector.getByLabel(
      'Comment',
      { exact: true },
    )
    const postButton = inspector.getByRole('button', {
      name: 'Comment',
      exact: true,
    })

    async function expectDraftRestored() {
      await expect(composerEditor).toBeVisible()
      await expect(
        composerEditor.locator('strong', {
          hasText: DRAFT_BOLD_A,
        }),
      ).toBeVisible()
      await expect(composerEditor).toContainText(
        DRAFT_PREFIX_A.trim(),
      )
      const text = await composerEditor.innerText()
      expect(text).not.toContain('**')
    }

    // --------------------------------------------------------
    // 7. Open A, type an unsent Markdown draft — do not send it.
    // --------------------------------------------------------

    await boardCardA.click()
    await expect(inspector).toBeVisible()
    await idleComposer.click()
    await expect(composerEditor).toBeFocused()
    await page.keyboard.type(DRAFT_PREFIX_A)
    await page.keyboard.type(`**${DRAFT_BOLD_A}**`)
    await page.keyboard.type('.')
    await expectDraftRestored()

    // --------------------------------------------------------
    // 8 & 11. Switch to B without sending — B starts with a
    //    clean, idle composer; A's draft never appears on B.
    // --------------------------------------------------------

    await boardCardB.click()
    await expect(inspector).toBeVisible()
    await expect(idleComposer).toBeVisible()
    await expect(composerEditor).toHaveCount(0)
    await expect(
      activityList.getByText(DRAFT_BOLD_A),
    ).toHaveCount(0)

    // --------------------------------------------------------
    // 9. Returning to A restores the composer, expanded, with
    //    the exact unsent Markdown draft still formatted in it —
    //    and it was genuinely never sent to the server.
    // --------------------------------------------------------

    await boardCardA.click()
    await expect(inspector).toBeVisible()
    await expectDraftRestored()
    await expect(
      activityList.getByText(DRAFT_BOLD_A),
    ).toHaveCount(0)

    // --------------------------------------------------------
    // 10. Esc collapses the composer but explicitly KEEPS the
    //    draft — reopening shows the exact same formatted draft.
    // --------------------------------------------------------

    await page.keyboard.press('Escape')
    await expect(idleComposer).toBeVisible()
    await expect(composerEditor).toHaveCount(0)

    await idleComposer.click()
    await expectDraftRestored()

    // --------------------------------------------------------
    // 11. Explicit Cancel discards the draft — reopening the
    //    composer starts empty again.
    // --------------------------------------------------------

    await inspector
      .getByRole('button', { name: 'Cancel', exact: true })
      .click()
    await expect(idleComposer).toBeVisible()
    await expect(composerEditor).toHaveCount(0)

    await idleComposer.click()
    await expect(composerEditor).toBeVisible()
    await expect(
      composerEditor.locator('strong'),
    ).toHaveCount(0)
    await expect(postButton).toBeDisabled()

    // --------------------------------------------------------
    // Now actually post A's comment, then confirm it never
    // leaks onto B's Activity feed (11, continued).
    // --------------------------------------------------------

    await page.keyboard.type(POSTED_COMMENT_A)
    await postButton.click()

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

const EDIT_PROJECT_NAME =
  'E2E Inspector Comment Edit Project'
const EDIT_TASK_TITLE =
  'E2E Inspector Comment Edit Task'
const EDIT_COMMENT_ORIGINAL =
  'Initial note before formatting.'

test(
  'Work Item inspector: editing own Markdown comment applies ' +
    'Bold through the BubbleMenu, Save persists it through reload, ' +
    'and the existing delete flow still works',
  async ({ page }) => {
    await login(page, 'alex')
    await openProjects(page)
    await createHistoryTestProject(page, EDIT_PROJECT_NAME)
    await createHistoryTestWorkItem(page, EDIT_TASK_TITLE)

    const inspector = page.getByRole('region', {
      name: 'Work item',
      exact: true,
    })
    const activityList = inspector.getByRole('list', { name: 'Activity' })

    await page
      .getByRole('button', {
        name: `Open ${EDIT_TASK_TITLE}`,
      })
      .click()
    await expect(inspector).toBeVisible()

    // --------------------------------------------------------
    // Post a plain-text comment to edit — same composer flow
    // already covered elsewhere.
    // --------------------------------------------------------

    await inspector
      .getByRole('button', { name: 'Add a comment…' })
      .click()
    await page.keyboard.type(EDIT_COMMENT_ORIGINAL)
    await page.keyboard.press('ControlOrMeta+Enter')

    const commentRow = inspector
      .locator('li')
      .filter({ hasText: EDIT_COMMENT_ORIGINAL })
    await expect(commentRow).toBeVisible()

    // --------------------------------------------------------
    // 12. Edit own Markdown comment — the edit surface is the same
    //    compact RichMarkdownEditor, starting from the comment's
    //    canonical Markdown body.
    // --------------------------------------------------------

    await commentRow.hover()
    await commentRow
      .getByRole('button', { name: 'Comment actions' })
      .click()
    await inspector
      .getByRole('button', { name: 'Edit', exact: true })
      .click()

    const editEditor = inspector.getByLabel('Edit comment', {
      exact: true,
    })
    await expect(editEditor).toBeVisible()
    await expect(editEditor).toBeFocused()
    await expect(editEditor).toContainText(
      EDIT_COMMENT_ORIGINAL,
    )

    // --------------------------------------------------------
    // 13. Apply Bold through the BubbleMenu on the selected text —
    //    reusing the exact same BubbleMenu Description uses.
    // --------------------------------------------------------

    await page.keyboard.press('ControlOrMeta+a')

    const bubbleToolbar = inspector.getByRole('toolbar', {
      name: 'Selection formatting',
    })
    await expect(bubbleToolbar).toBeVisible()

    const bubbleBoldButton = bubbleToolbar.getByRole('button', {
      name: 'Bold',
      exact: true,
    })
    await bubbleBoldButton.click()
    await expect(bubbleBoldButton).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    // --------------------------------------------------------
    // 14. Save — the edit surface closes and the comment renders
    //    formatted, not raw Markdown syntax.
    // --------------------------------------------------------

    await inspector
      .getByRole('button', { name: 'Save', exact: true })
      .click()
    await expect(editEditor).toHaveCount(0)

    await expect(
      commentRow.locator('strong', {
        hasText: EDIT_COMMENT_ORIGINAL,
      }),
    ).toBeVisible()
    const editedText = await commentRow.innerText()
    expect(editedText).not.toContain('**')

    // --------------------------------------------------------
    // 15. Reload and verify the formatting persisted.
    // --------------------------------------------------------

    await page.reload()
    await page
      .getByRole('button', { name: `Open ${EDIT_TASK_TITLE}` })
      .click()
    await expect(inspector).toBeVisible()

    const reloadedCommentRow = inspector
      .locator('li')
      .filter({ hasText: EDIT_COMMENT_ORIGINAL })
    await expect(
      reloadedCommentRow.locator('strong', {
        hasText: EDIT_COMMENT_ORIGINAL,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // 16. The existing delete flow still works.
    // --------------------------------------------------------

    await reloadedCommentRow.hover()
    await reloadedCommentRow
      .getByRole('button', { name: 'Comment actions' })
      .click()
    await inspector
      .getByRole('button', { name: 'Delete', exact: true })
      .click()

    await expect(
      inspector.getByText('Delete this comment?'),
    ).toBeVisible()
    await inspector
      .getByRole('button', { name: 'Delete', exact: true })
      .click()

    await expect(
      activityList.getByText(EDIT_COMMENT_ORIGINAL),
    ).toHaveCount(0)
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

const CLOSE_PROJECT_NAME =
  'E2E Inspector Outside Click Project'
const CLOSE_TASK_A_TITLE =
  'E2E Inspector Outside Click Task A'
const CLOSE_TASK_B_TITLE =
  'E2E Inspector Outside Click Task B'

test(
  'Work Item inspector: outside interaction closes it like ' +
    'clearing a contextual selection, while every Work Item target ' +
    '(Board card, List row), dragging, and the Board/List view ' +
    'switch never close it',
  async ({ page }) => {
    // Wide enough that the Board's status columns and the fixed
    // inspector drawer are both fully on-screen at once — needed for
    // the drag step, mirroring project-work-item-board-drag.spec.ts.
    await page.setViewportSize({
      width: 1920,
      height: 1000,
    })

    await login(page, 'alex')
    await openProjects(page)
    await createHistoryTestProject(
      page,
      CLOSE_PROJECT_NAME,
    )

    await createHistoryTestWorkItem(
      page,
      CLOSE_TASK_A_TITLE,
    )
    await createHistoryTestWorkItem(
      page,
      CLOSE_TASK_B_TITLE,
    )

    const inspector = page.getByRole('region', {
      name: 'Work item',
      exact: true,
    })

    const boardCardA = page.getByRole('button', {
      name: `Open ${CLOSE_TASK_A_TITLE}`,
    })
    const boardCardB = page.getByRole('button', {
      name: `Open ${CLOSE_TASK_B_TITLE}`,
    })

    // --------------------------------------------------------
    // 1 & 2. Open A, then click B — the inspector stays open and
    //    swaps in place to show B.
    // --------------------------------------------------------

    await boardCardA.click()
    await expect(inspector).toBeVisible()

    await boardCardB.click()
    await expect(inspector).toBeVisible()
    await expect(
      inspector.getByRole('button', {
        name: CLOSE_TASK_B_TITLE,
        exact: true,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // 3. Clicking inside the inspector keeps it open.
    // --------------------------------------------------------

    await inspector
      .getByRole('heading', {
        name: 'Work item',
        exact: true,
      })
      .click()

    await expect(inspector).toBeVisible()
    await expect(
      inspector.getByRole('button', {
        name: CLOSE_TASK_B_TITLE,
        exact: true,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // 4. Clicking empty Board space (a status column with no
    //    Work Items in it) closes the inspector.
    // --------------------------------------------------------

    const emptyColumn = page.locator(
      '[data-board-column="done"]',
    )
    await expect(emptyColumn).toBeVisible()
    await emptyColumn.click()

    await expect(inspector).not.toBeVisible()

    // --------------------------------------------------------
    // 5 & 6. Reopen A on Board, then click List — this is an
    //    intentional exception: the inspector stays open, A is
    //    still the one displayed, and A's List row itself receives
    //    the ordinary selected-state styling (it is not merely
    //    "some Work Item is open", it is genuinely still A).
    // --------------------------------------------------------

    await boardCardA.click()
    await expect(inspector).toBeVisible()
    await expect(
      inspector.getByRole('button', {
        name: CLOSE_TASK_A_TITLE,
        exact: true,
      }),
    ).toBeVisible()

    const listToggle = page.getByRole('button', {
      name: 'List',
      exact: true,
    })
    const boardToggle = page.getByRole('button', {
      name: 'Board',
      exact: true,
    })

    await listToggle.click()

    // List is genuinely showing (Board columns are gone)...
    await expect(
      page.locator('[data-board-column]'),
    ).toHaveCount(0)
    // ...yet the inspector never closed, and still shows A.
    await expect(inspector).toBeVisible()
    await expect(
      inspector.getByRole('button', {
        name: CLOSE_TASK_A_TITLE,
        exact: true,
      }),
    ).toBeVisible()

    const listRowAAfterSwitch = page.getByRole(
      'button',
      {
        name: `Open ${CLOSE_TASK_A_TITLE}`,
      },
    )
    await expect(
      listRowAAfterSwitch,
    ).toHaveClass(/outline-primary/)

    // --------------------------------------------------------
    // Switching back to Board is the same exception in reverse:
    // inspector stays open, still on A, and A's Board card itself
    // receives the selected-state marker.
    // --------------------------------------------------------

    await boardToggle.click()

    await expect(
      page.locator('[data-board-column]').first(),
    ).toBeVisible()
    await expect(inspector).toBeVisible()
    await expect(
      inspector.getByRole('button', {
        name: CLOSE_TASK_A_TITLE,
        exact: true,
      }),
    ).toBeVisible()
    await expect(boardCardA).toHaveAttribute(
      'data-selected',
      'true',
    )

    // --------------------------------------------------------
    // 10. An ordinary toolbar/filter interaction — unlike the
    //    view switch — still closes the inspector, and still
    //    performs its own normal action.
    // --------------------------------------------------------

    const searchInput = page.getByRole(
      'searchbox',
      { name: /Search work items/ },
    )
    await searchInput.click()

    await expect(inspector).not.toBeVisible()
    await expect(searchInput).toBeFocused()

    // --------------------------------------------------------
    // 7 & 8. Reopen, then drag a Work Item card to another status
    //    column — the inspector must NOT close because of the
    //    drag, and the status change still applies exactly as in
    //    the dedicated drag suite.
    // --------------------------------------------------------

    await boardCardA.click()
    await expect(inspector).toBeVisible()

    const statusSelect = inspector.getByLabel(
      'Status',
      { exact: true },
    )
    await expect(statusSelect).toHaveValue('todo')

    const reviewColumn = page.locator(
      '[data-board-column="review"]',
    )
    await reviewColumn.scrollIntoViewIfNeeded()

    const cardBox = await boardCardA.boundingBox()
    const targetBox = await reviewColumn.boundingBox()

    if (!cardBox || !targetBox) {
      throw new Error(
        'Work item card or target column not found.',
      )
    }

    await page.mouse.move(
      cardBox.x + cardBox.width / 2,
      cardBox.y + cardBox.height / 2,
    )
    await page.mouse.down()
    await page.mouse.move(
      targetBox.x + targetBox.width / 2,
      targetBox.y + targetBox.height / 2,
      { steps: 20 },
    )
    await page.mouse.up()

    // The drag never dispatched a "click" — the inspector is still
    // open and now reflects the new (dragged-to) status.
    await expect(inspector).toBeVisible()
    await expect(statusSelect).toHaveValue('review')

    // --------------------------------------------------------
    // 9. List row -> another List row still switches without
    //    closing.
    // --------------------------------------------------------

    await listToggle.click()
    await expect(
      page.locator('[data-board-column]'),
    ).toHaveCount(0)

    const listRowA = page.getByRole('button', {
      name: `Open ${CLOSE_TASK_A_TITLE}`,
    })
    const listRowB = page.getByRole('button', {
      name: `Open ${CLOSE_TASK_B_TITLE}`,
    })

    await listRowA.click()
    await expect(inspector).toBeVisible()
    await expect(
      inspector.getByRole('button', {
        name: CLOSE_TASK_A_TITLE,
        exact: true,
      }),
    ).toBeVisible()

    await listRowB.click()
    await expect(inspector).toBeVisible()
    await expect(
      inspector.getByRole('button', {
        name: CLOSE_TASK_B_TITLE,
        exact: true,
      }),
    ).toBeVisible()
  },
)

const RICH_PROJECT_NAME =
  'E2E Inspector Rich Description Project'
const RICH_TASK_A_TITLE =
  'E2E Inspector Rich Description Task A'
const RICH_TASK_B_TITLE =
  'E2E Inspector Rich Description Task B'
const RICH_TASK_PLAIN_TITLE =
  'E2E Inspector Rich Description Plain Task'
const PLAIN_DESCRIPTION =
  'Just a plain sentence, no Markdown at all.'

test(
  'Work Item inspector: Description is a Markdown/Rich-Text editor — ' +
    'plain text renders normally, typed Markdown becomes formatted ' +
    'content (never raw syntax), edits are safely queued across a ' +
    'Work Item switch, persist through reload, and the Bubble toolbar ' +
    'applies Bold to a selection',
  async ({ page }) => {
    await login(page, 'alex')
    await openProjects(page)
    await createHistoryTestProject(page, RICH_PROJECT_NAME)

    // --------------------------------------------------------
    // 1. A pre-existing plain-text Description (created the same way
    //    any legacy/plain Work Item description would be) renders as
    //    an ordinary paragraph, not specially interpreted.
    // --------------------------------------------------------

    await page
      .getByRole('button', { name: /New work item/ })
      .click()

    const createDialog = page.getByRole('dialog', {
      name: 'New work item',
    })

    await createDialog
      .getByLabel('Title')
      .fill(RICH_TASK_PLAIN_TITLE)
    await createDialog
      .getByLabel('Description', { exact: false })
      .fill(PLAIN_DESCRIPTION)

    await createDialog
      .getByRole('button', { name: /Create work item/ })
      .click()
    await expect(createDialog).not.toBeVisible()

    const inspector = page.getByRole('region', {
      name: 'Work item',
      exact: true,
    })

    await page
      .getByRole('button', {
        name: `Open ${RICH_TASK_PLAIN_TITLE}`,
      })
      .click()
    await expect(inspector).toBeVisible()
    await expect(
      inspector.getByText(PLAIN_DESCRIPTION, {
        exact: true,
      }),
    ).toBeVisible()

    await page
      .getByRole('button', { name: 'Close work item' })
      .click()
    await expect(inspector).not.toBeVisible()

    // --------------------------------------------------------
    // Create the two Work Items used for the rest of this test.
    // --------------------------------------------------------

    await createHistoryTestWorkItem(page, RICH_TASK_A_TITLE)
    await createHistoryTestWorkItem(page, RICH_TASK_B_TITLE)

    const boardCardA = page.getByRole('button', {
      name: `Open ${RICH_TASK_A_TITLE}`,
    })
    const boardCardB = page.getByRole('button', {
      name: `Open ${RICH_TASK_B_TITLE}`,
    })

    // --------------------------------------------------------
    // 2. Empty state is the lightweight click target, and clicking it
    //    activates the rich editor in place (no separate form).
    // --------------------------------------------------------

    await boardCardA.click()
    await expect(inspector).toBeVisible()

    await inspector
      .getByRole('button', { name: 'Add a description…' })
      .click()

    const descriptionEditor = inspector.getByLabel(
      'Work item description',
    )
    await expect(descriptionEditor).toBeVisible()
    await expect(descriptionEditor).toBeFocused()

    const bottomToolbar = inspector.getByRole('toolbar', {
      name: 'Formatting',
    })
    await expect(bottomToolbar).toBeVisible()
    await expect(
      inspector.getByText('Markdown supported', {
        exact: true,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // 3. Type Markdown-supported content: a Heading 2 (via the
    //    toolbar, to avoid depending on Enter's exact node-splitting
    //    behavior), then **bold** and `inline code` typed as literal
    //    Markdown input — proving the editor's own input rules turn
    //    typed syntax into formatting live, not just on parse.
    // --------------------------------------------------------

    await page.keyboard.type('Expected outcome')

    const heading2Button = bottomToolbar.getByRole('button', {
      name: 'Heading 2',
      exact: true,
    })
    await heading2Button.click()
    await expect(heading2Button).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    await page.keyboard.press('End')
    await page.keyboard.press('Enter')

    // Pressing Enter at the end of a heading may or may not carry the
    // heading forward, depending on the schema default — normalize to
    // a plain paragraph either way before continuing.
    if (
      (await heading2Button.getAttribute('aria-pressed')) ===
      'true'
    ) {
      await heading2Button.click()
    }

    await page.keyboard.type('Some ')
    await page.keyboard.type('**bold**')
    await page.keyboard.type(' text and a list:')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')

    await bottomToolbar
      .getByRole('button', {
        name: 'Bullet list',
        exact: true,
      })
      .click()
    await page.keyboard.type('first item')
    await page.keyboard.press('Enter')
    await page.keyboard.type('second item with ')
    await page.keyboard.type('`inline code`')
    await page.keyboard.type(' here')

    // --------------------------------------------------------
    // 7 & 8. Select the bold word — the Bubble toolbar appears near
    //    the selection — and toggle Bold off and back on through it,
    //    proving the toolbar drives the same live formatting.
    // --------------------------------------------------------

    await inspector
      .getByText('bold', { exact: true })
      .dblclick()

    const bubbleToolbar = inspector.getByRole('toolbar', {
      name: 'Selection formatting',
    })
    await expect(bubbleToolbar).toBeVisible()

    const bubbleBoldButton = bubbleToolbar.getByRole(
      'button',
      { name: 'Bold', exact: true },
    )
    await expect(bubbleBoldButton).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await bubbleBoldButton.click()
    await expect(bubbleBoldButton).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    await bubbleBoldButton.click()
    await expect(bubbleBoldButton).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    // --------------------------------------------------------
    // 4. Switch to Work Item B without blurring first — A's edit is
    //    safely committed/queued, exactly like the plain-text fields.
    // --------------------------------------------------------

    await boardCardB.click()
    await expect(inspector).toBeVisible()
    await expect(
      inspector.getByRole('button', {
        name: RICH_TASK_B_TITLE,
        exact: true,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // 5. Reopen A — content renders as formatted rich content, never
    //    raw Markdown syntax.
    // --------------------------------------------------------

    await boardCardA.click()
    await expect(inspector).toBeVisible()

    await expect(
      inspector.getByRole('heading', {
        name: 'Expected outcome',
        level: 2,
      }),
    ).toBeVisible()
    await expect(
      inspector.locator('strong', { hasText: 'bold' }),
    ).toBeVisible()
    await expect(
      inspector.locator('li', { hasText: 'first item' }),
    ).toBeVisible()
    await expect(
      inspector.locator('code', {
        hasText: 'inline code',
      }),
    ).toBeVisible()

    const inspectorText = await inspector.innerText()
    expect(inspectorText).not.toContain('##')
    expect(inspectorText).not.toContain('**')
    expect(inspectorText).not.toContain('`inline code`')

    // --------------------------------------------------------
    // 9. The existing Description history event still fires — no new/
    //    different history contract, and the body itself is never
    //    stored in the event.
    // --------------------------------------------------------

    const activityList = inspector.getByRole('list', { name: 'Activity' })
    await expect(
      activityList.getByText('Alex Dev changed the description', {
        exact: true,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // 6. Reload — persisted Markdown renders identically.
    // --------------------------------------------------------

    await page.reload()
    await boardCardA.click()
    await expect(inspector).toBeVisible()

    await expect(
      inspector.getByRole('heading', {
        name: 'Expected outcome',
        level: 2,
      }),
    ).toBeVisible()
    await expect(
      inspector.locator('strong', { hasText: 'bold' }),
    ).toBeVisible()
    await expect(
      inspector.locator('li', { hasText: 'first item' }),
    ).toBeVisible()
    await expect(
      inspector.locator('code', {
        hasText: 'inline code',
      }),
    ).toBeVisible()

    const reloadedText = await inspector.innerText()
    expect(reloadedText).not.toContain('##')
    expect(reloadedText).not.toContain('**')
  },
)
