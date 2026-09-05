import {
  expect,
  test,
  type Page,
} from '@playwright/test'

import {
  login,
  logout,
  openProject,
  openProjects,
} from './helpers'

// The redesigned Meeting Detail uses an inline quick-add: a quiet
// "+ Add item" button expands into a title input (required field)
// plus Add / Cancel. Enter also submits.
export async function quickAddAgendaItem(
  page: Page,
  title: string,
  sectionName = 'Agenda',
) {
  // The Meeting Section's accessible name is the section heading
  // text; scoping by the exact section text targets that one
  // section (no other element carries the section name).
  const section = page
    .locator('section')
    .filter({ hasText: sectionName })

  const input = page.getByLabel(`Add item to ${sectionName}`)

  // The inline composer stays open after a successful submit (its
  // input is cleared for the next item). If it is already open for
  // this exact section, reuse it; otherwise open it via the
  // 'Add item' / 'Add first item' trigger (the trigger is hidden
  // while the composer is open).
  const addButton = section
    .getByRole('button', { name: 'Add item', exact: true })
    .or(
      section.getByRole('button', {
        name: 'Add first item',
        exact: true,
      }),
    )

  if (await input.isVisible().catch(() => false)) {
    // Composer already open: use it directly.
  } else {
    await addButton.scrollIntoViewIfNeeded()
    await addButton.click()
    await input.waitFor({ state: 'visible' })
  }

  await input.fill(title)

  // The quick-add form's submit is 'Add'; scope it to the form so the
  // participant panel's separate 'Add' button is never matched.
  await section
    .getByRole('button', { name: 'Add', exact: true })
    .click()

  // The newly created item title is visible inside this section.
  await expect(
    section.getByText(title, { exact: true }),
  ).toBeVisible()
}

const MEETING_TITLE =
  'E2E FG Weekly'

const AGENDA_TITLE =
  'E2E Rewrite Introduction'

test(
  'Meeting participants agenda and status persist',
  async ({ page }) => {
    // --------------------------------------------------------
    // Alex creates a real Meeting.
    // --------------------------------------------------------

    await login(page, 'alex')

    await page
      .getByRole('link', {
        name: /Meetings/,
      })
      .click()

    await expect(page).toHaveURL(
      /\/meetings\?group=\d+$/,
    )

    await expect(
      page.getByRole('heading', {
        name: 'Meetings',
        exact: true,
      }),
    ).toBeVisible()

    await page
      .getByRole('button', {
        name: /New meeting/,
      })
      .click()

    await page
      .getByLabel('Title')
      .fill(MEETING_TITLE)

    await page
      .getByLabel('Date and time')
      .fill('2030-01-02T10:30')

    await page
      .locator('form')
      .getByRole('button', {
        name: /Create meeting/,
      })
      .click()

    await expect(
      page.getByText(
        MEETING_TITLE,
        { exact: true },
      ),
    ).toBeVisible()

    // Reload proves Meeting persistence.
    await page.reload()

    await expect(
      page.getByText(
        MEETING_TITLE,
        { exact: true },
      ),
    ).toBeVisible()

    // --------------------------------------------------------
    // Open Meeting detail.
    // --------------------------------------------------------

    const meetingRow =
      page
        .getByRole('button')
        .filter({
          hasText: MEETING_TITLE,
        })

    await expect(
      meetingRow,
    ).toBeVisible()

    await meetingRow.click()

    await expect(page).toHaveURL(
      /\/meetings\/\d+$/,
    )

    await expect(
      page.getByRole('heading', {
        name: MEETING_TITLE,
        exact: true,
      }),
    ).toBeVisible()

    // Creator is automatically a participant (avatar in the
    // participant bar; @username is shown in the manage panel).
    await expect(
      page.getByTitle('Alex Dev'),
    ).toBeVisible()

    // --------------------------------------------------------
    // Alex adds Chris as participant.
    // --------------------------------------------------------

    const manageButton = page
      .getByRole('button', {
        name: 'Manage',
        exact: true,
      })
      .first()

    await manageButton.scrollIntoViewIfNeeded()

    await manageButton.click()

    const participantSelect =
      page.getByLabel(
        'Add participant',
      )

    const chrisOption =
      participantSelect
        .locator('option')
        .filter({
          hasText: /Chris|chris/i,
        })

    await expect(
      chrisOption,
    ).toHaveCount(1)

    const chrisValue =
      await chrisOption.getAttribute(
        'value',
      )

    expect(chrisValue).not.toBeNull()

    await participantSelect.selectOption(
      chrisValue!,
    )

    await page
      .getByRole('button', {
        name: 'Add',
        exact: true,
      })
      .click()

    // The manage panel lists each participant with @username.
    await expect(
      page.getByText('@alex', { exact: true }),
    ).toBeVisible()
    await expect(
      page.getByText('@chris', { exact: true }),
    ).toBeVisible()

    // Close the manage panel (the toggle now reads 'Done').
    await page.getByRole('button', {
      name: 'Done',
      exact: true,
    }).click()

    // --------------------------------------------------------
    // Alex creates and discusses an agenda item.
    // --------------------------------------------------------

    // The standalone Meeting gets an "Agenda" section by default.
    await expect(
      page.getByRole('heading', {
        name: 'Agenda',
        exact: true,
      }),
    ).toHaveCount(1)

    // Add an item under the default Agenda section.
    await quickAddAgendaItem(
      page,
      AGENDA_TITLE,
    )

    await expect(
      page.getByText(
        AGENDA_TITLE,
        { exact: true },
      ),
    ).toBeVisible()

    const agendaItem =
      page
        .locator('li')
        .filter({
          has: page.getByText(
            AGENDA_TITLE,
            { exact: true },
          ),
        })

    await expect(
      agendaItem,
    ).toBeVisible()

    // --------------------------------------------------------
    // Alex starts the Meeting via the lifecycle action.
    // --------------------------------------------------------

    await page
      .getByRole('button', {
        name: 'Start meeting',
      })
      .click()

    await expect(
      page.getByRole('button', { name: 'End meeting' }),
    ).toBeVisible()

    // Live shell: Start has already made the single item
    // the current (discussing) item. It is listed in the
    // Agenda rail with its accessible status and titled in
    // the Current Item workspace.
    const agendaSection = page
      .getByRole('navigation', { name: 'Agenda' })

    const currentAgendaItem = agendaSection
      .locator('li')
      .filter({
        has: page.getByText(AGENDA_TITLE, {
          exact: true,
        }),
      })

    // Current item: no Focus button (only not_discussed
    // items are focusable), accessible status is exposed.
    await expect(
      currentAgendaItem.getByRole('button', {
        name: `Focus ${AGENDA_TITLE}`,
      }),
    ).toHaveCount(0)

    // The status hint is sr-only text inside the row: it is
    // attached to the DOM (read by screen readers) but visually
    // hidden, so assert the exact text is attached.
    await expect(
      currentAgendaItem
        .getByText('Discussing now', { exact: true }),
    ).toBeAttached()

    // The current item is shown as the Current Item heading.
    const workspace = page.getByRole('main', {
      name: 'Current item',
    })

    await expect(
      workspace.getByRole('heading', {
        name: AGENDA_TITLE,
        exact: true,
      }),
    ).toBeVisible()

    // Close it with the canonical Done action, now offered by
    // the Current Item workspace.
    await page
      .getByRole('button', {
        name: `Mark ${AGENDA_TITLE} as done`,
      })
      .click()

    await expect(
      page.getByRole('button', {
        name: `Mark ${AGENDA_TITLE} as done`,
      }),
    ).toHaveCount(0)

    // The item stays in the Agenda rail, resolved. Its status
    // hint is sr-only text: assert the exact text is attached.
    await expect(
      currentAgendaItem
        .getByText('Completed', { exact: true }),
    ).toBeAttached()

    // With no unresolved items, the workspace shows the calm
    // no-current-item state.
    await expect(
      page.getByRole('main', {
        name: 'Current item',
      }),
    ).toContainText('No current item')

    // --------------------------------------------------------
    // Reload proves all Meeting state persisted.
    // --------------------------------------------------------

    await page.reload()

    await expect(
      page.getByRole('heading', {
        name: MEETING_TITLE,
        exact: true,
      }),
    ).toBeVisible()

    // Participant state persists across the reload. While Live the
    // participants bar (avatar chips) is intentionally hidden, so the
    // persisted participant set is represented by the header metadata
    // count: Alex (creator) + Chris (added before Start).
    //
    // The count renders as <span>{n}</span>{' '}{plural}, i.e. three
    // separate text nodes, so an exact single-node match fails. A
    // regex on the metadata <span> (the only element whose text spans
    // "N participants") matches reliably. Scope to the <header> that
    // wraps the meeting title so this is not a page-global match.
    const header = page
      .getByRole('heading', { name: MEETING_TITLE, exact: true })
      .locator('xpath=ancestor::header[1]')

    await expect(
      header.getByText(/2 participants/),
    ).toBeVisible()

    // The Meeting was NOT ended in this flow, so it is still
    // LIVE and still uses the Live Agenda | Current Item shell
    // after the reload. The agenda item persists in the Agenda
    // rail, resolved, and the workspace shows the no-current-
    // item state.
    const persistedAgenda = page.getByRole('navigation', {
      name: 'Agenda',
    })

    const persistedItem = persistedAgenda
      .locator('li')
      .filter({
        has: page.getByText(AGENDA_TITLE, {
          exact: true,
        }),
      })

    // The exact agenda item title persists in the rail.
    await expect(
      persistedItem
        .getByText(AGENDA_TITLE, { exact: true }),
    ).toBeVisible()

    // The resolved status is the sr-only "Completed" hint
    // attached to that item.
    await expect(
      persistedItem
        .getByText('Completed', { exact: true }),
    ).toBeAttached()

    // The Meeting is still Live (End meeting is available), and
    // there is no current item to discuss.
    await expect(
      page.getByRole('button', { name: 'End meeting' }),
    ).toBeVisible()

    await expect(
      page.getByRole('main', {
        name: 'Current item',
      }),
    ).toContainText('No current item')
  },
)

test(
  'Meeting agenda creates canonical project work for Chris',
  async ({ page }) => {
    const projectName =
      'E2E Meeting Work Project'

    const taskTitle =
      'E2E Meeting Chris Task'

    // --------------------------------------------------------
    // Alex creates a Project for the Meeting follow-up.
    // --------------------------------------------------------

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

    await expect(
      createProjectDialog,
    ).toBeVisible()

    await createProjectDialog
      .getByLabel('Project name')
      .fill(projectName)

    await createProjectDialog
      .getByLabel('Description')
      .fill(
        'Project created by the Meeting browser acceptance test.',
      )

    await createProjectDialog
      .getByRole('button', {
        name: /Create project/,
      })
      .click()

    await expect(
      page.getByText(
        projectName,
        { exact: true },
      ),
    ).toBeVisible()

    await openProject(
      page,
      projectName,
    )

    // --------------------------------------------------------
    // Chris becomes a normal Project member.
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

    const addMemberDialog =
      page.getByRole('dialog', {
        name: 'Add project member',
      })

    await addMemberDialog
      .getByLabel('Select person')
      .fill('chris')

    const chrisResult =
      addMemberDialog
        .getByRole('button')
        .filter({
          hasText: '@chris',
        })

    await expect(
      chrisResult,
    ).toBeVisible()

    await chrisResult.click()

    await addMemberDialog
      .getByRole('button', {
        name: /Add member/,
      })
      .click()

    await expect(
      addMemberDialog,
    ).not.toBeVisible()

    await expect(
      page.getByText(
        '@alex',
        { exact: true },
      )
      .first(),
    ).toBeVisible()

    // --------------------------------------------------------
    // Alex creates a Meeting and Agenda Item.
    // --------------------------------------------------------

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
      .fill('E2E Work Meeting')

    await page
      .getByLabel('Date and time')
      .fill('2030-02-03T11:00')

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
          hasText: 'E2E Work Meeting',
        })

    await expect(
      meetingRow,
    ).toBeVisible()

    await meetingRow.click()

    await expect(page).toHaveURL(
      /\/meetings\/\d+$/,
    )

    // Add an item under the default Agenda section.
    await quickAddAgendaItem(
      page,
      taskTitle,
    )

    const agendaItem =
      page
        .locator('li')
        .filter({
          has: page.getByText(
            taskTitle,
            { exact: true },
          ),
        })

    await expect(
      agendaItem,
    ).toBeVisible()

    // --------------------------------------------------------
    // Agenda Item creates canonical WorkItem.
    // --------------------------------------------------------

    // The redesign moved item actions into a per-item menu.
    const itemTitle = taskTitle
    await agendaItem.getByRole('button', {
      name: `Actions for agenda item ${itemTitle}`,
    }).click()
    await page.getByRole('menuitem', {
      name: 'Create work item',
    }).click()

    const workItemDialog =
      page.getByRole('dialog', {
        name: 'Create work item',
      })

    await expect(
      workItemDialog,
    ).toBeVisible()

    await workItemDialog
      .getByLabel('Project')
      .selectOption({
        label: projectName,
      })

    await expect(
      workItemDialog.getByLabel('Title'),
    ).toHaveValue(taskTitle)

    const assigneeGroup =
      workItemDialog.getByRole(
        'group',
        {
          name: 'Assignees',
        },
      )

    const chrisCheckbox =
      assigneeGroup.getByRole(
        'checkbox',
        {
          name: /Chris|chris/i,
        },
      )

    await expect(
      chrisCheckbox,
    ).toBeVisible()

    await chrisCheckbox.check()

    await workItemDialog
      .getByRole('button', {
        name: /Create work item/,
      })
      .click()

    await expect(
      workItemDialog,
    ).not.toBeVisible()

    await expect(
      agendaItem,
    ).toContainText(
      '1 linked work item',
    )

    // Reload proves MeetingItem -> WorkItem link persistence.
    await page.reload()

    const persistedAgendaItem =
      page
        .locator('li')
        .filter({
          has: page.getByText(
            taskTitle,
            { exact: true },
          ),
        })

    await expect(
      persistedAgendaItem,
    ).toContainText(
      '1 linked work item',
    )

    // --------------------------------------------------------
    // Chris sees exactly that canonical WorkItem in My Work.
    // --------------------------------------------------------

    await logout(page)
    await login(page, 'chris')

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
        taskTitle,
        { exact: true },
      ),
    ).toBeVisible()

    await expect(
      page.getByText(
        projectName,
        { exact: true },
      ),
    ).toBeVisible()

    // Reload proves Chris sees persisted canonical Project work.
    await page.reload()

    await expect(
      page.getByText(
        taskTitle,
        { exact: true },
      ),
    ).toBeVisible()

    await expect(
      page.getByText(
        projectName,
        { exact: true },
      ),
    ).toBeVisible()
  },
)

test(
  'Meeting lifecycle goes upcoming -> live -> completed and persists',
  async ({ page }) => {
    await login(page, 'alex')

    await page
      .getByRole('link', {
        name: /Meetings/,
      })
      .click()

    await page
      .getByRole('button', {
        name: /New meeting/,
      })
      .click()

    await page
      .getByLabel('Title')
      .fill('E2E Lifecycle Weekly')

    await page
      .getByLabel('Date and time')
      .fill('2030-01-05T09:00')

    await page
      .locator('form')
      .getByRole('button', {
        name: /Create meeting/,
      })
      .click()

    const lifecycleRow =
      page
        .getByRole('button')
        .filter({
          hasText: 'E2E Lifecycle Weekly',
        })

    await lifecycleRow.click()

    await expect(page).toHaveURL(/\/meetings\/\d+$/)

    // Upcoming: Start meeting is offered.
    await expect(
      page.getByRole('button', { name: 'Start meeting' }),
    ).toBeVisible()

    await page
      .getByRole('button', {
        name: 'Start meeting',
      })
      .click()

    // Live state is shown.
    // Live: the End meeting button confirms the live state.
    await expect(
      page.getByRole('button', { name: 'End meeting' }),
    ).toBeVisible()

    // End the meeting.
    await page
      .getByRole('button', {
        name: 'End meeting',
      })
      .click()

    // Completed: the Reopen button confirms the completed state.
    await expect(
      page.getByRole('button', { name: 'Reopen meeting' }),
    ).toBeVisible()

    // Mutating controls are disabled when completed.
    await expect(
      page.getByRole('button', { name: 'Start meeting' }),
    ).toHaveCount(0)

    await expect(
      page.getByRole('button', {
        name: 'Add item',
        exact: true,
      }),
    ).toHaveCount(0)

    await expect(
      page.getByRole('button', {
        name: 'Edit structure',
        exact: true,
      }),
    ).toHaveCount(0)

    // Reload proves the completed state persisted.
    await page.reload()

    await expect(
      page.getByRole('button', { name: 'Reopen meeting' }),
    ).toBeVisible()

    // Reopen the completed meeting -> back to live.
    await page
      .getByRole('button', {
        name: 'Reopen meeting',
      })
      .click()

    await expect(
      page.getByRole('button', { name: 'End meeting' }),
    ).toBeVisible()

    // Ending again returns to completed.
    await page
      .getByRole('button', {
        name: 'End meeting',
      })
      .click()

    await expect(
      page.getByRole('button', { name: 'Reopen meeting' }),
    ).toBeVisible()
  },
)

test(
  'Standalone Meeting: sections and items persist across reload',
  async ({ page }) => {
    await login(page, 'alex')

    await page
      .getByRole('link', {
        name: /Meetings/,
      })
      .click()

    await page
      .getByRole('button', {
        name: /New meeting/,
      })
      .click()

    // Default: active research group, no project.
    await page
      .getByLabel('Title')
      .fill('E2E Section Meeting')

    await page
      .getByLabel('Date and time')
      .fill('2030-02-01T09:00')

    await page
      .locator('form')
      .getByRole('button', {
        name: /Create meeting/,
      })
      .click()

    const row = page
      .getByRole('button')
      .filter({
        hasText: 'E2E Section Meeting',
      })
    await row.click()

    await expect(page).toHaveURL(/\/meetings\/\d+$/)

    // The default Agenda section is visible.
    await expect(
      page.getByRole('heading', {
        name: 'Agenda',
        exact: true,
      }),
    ).toBeVisible()

    // Add a second section through explicit structure editing.
    await page
      .getByRole('button', {
        name: 'Edit structure',
        exact: true,
      })
      .click()

    await page
      .getByLabel('New section name')
      .fill('TOPs')

    await page
      .getByRole('button', {
        name: 'Add section',
        exact: true,
      })
      .click()

    await page
      .getByRole('button', {
        name: 'Done editing structure',
        exact: true,
      })
      .click()

    await expect(
      page.getByRole('heading', {
        name: 'TOPs',
        exact: true,
      }),
    ).toBeVisible()

    // Add an item under each section.
    await quickAddAgendaItem(
      page,
      'Agenda item A',
    )

    await quickAddAgendaItem(
      page,
      'TOPs item C',
      'TOPs',
    )

    await expect(
      page.getByText('Agenda item A', { exact: true }),
    ).toBeVisible()

    await expect(
      page.getByText('TOPs item C', { exact: true }),
    ).toBeVisible()

    // Reload: sections + items remain correctly grouped.
    await page.reload()

    await expect(
      page.getByRole('heading', {
        name: 'Agenda',
        exact: true,
      }),
    ).toBeVisible()

    await expect(
      page.getByRole('heading', {
        name: 'TOPs',
        exact: true,
      }),
    ).toBeVisible()

    await expect(
      page.getByText('Agenda item A', { exact: true }),
    ).toBeVisible()

    await expect(
      page.getByText('TOPs item C', { exact: true }),
    ).toBeVisible()
  },
)

test(
  'Series occurrence: snapshotted sections editable without mutating series',
  async ({ page }) => {
    await login(page, 'alex')

    // --------------------------------------------------------
    // Create a Meeting Series.
    // --------------------------------------------------------

    await page
      .getByRole('link', {
        name: /Meetings/,
      })
      .click()

    await expect(page).toHaveURL(
      /\/meetings\?group=\d+$/,
    )

    // Navigate to the series list for the active group.
    const meetingsUrl = new URL(page.url())
    const groupId =
      meetingsUrl.searchParams.get('group') ?? '1'

    await page.goto(
      `/meetings/series?group=${groupId}`,
    )

    await page
      .getByLabel('Name')
      .fill('E2E Series Weekly')

    await page
      .getByRole('button', {
        name: /Create template/,
      })
      .click()

    await expect(page).toHaveURL(
      /\/meetings\/series\/\d+$/,
    )

    // --------------------------------------------------------
    // Add two sections to the template.
    // --------------------------------------------------------

    await page
      .getByLabel('Section name')
      .fill('Check-In')

    await page
      .getByRole('button', {
        name: /Add section/,
      })
      .click()

    await expect(
      page.locator('span.font-semibold', { hasText: /^Check-In$/ }),
    ).toBeVisible()

    // Reload for a clean form state before adding the second section.
    await page.reload()

    await page
      .getByLabel('Section name')
      .fill('Research')

    await page
      .getByRole('button', {
        name: /Add section/,
      })
      .click()

    await expect(
      page.locator('span.font-semibold', { hasText: /^Research$/ }),
    ).toBeVisible()

    await expect(
      page.locator('span.font-semibold', { hasText: /^Research$/ }),
    ).toBeVisible()

    // --------------------------------------------------------
    // Create an occurrence from the series.
    // --------------------------------------------------------

    await page
      .getByLabel('Date & Time')
      .fill('2030-03-01T10:00')

    await page
      .getByRole('button', {
        name: /Create meeting/,
      })
      .click()

    // The occurrence is navigated to directly.
    await expect(page).toHaveURL(/\/meetings\/\d+$/)

    // Both snapshotted sections are visible.
    await expect(
      page.getByRole('heading', {
        name: 'Check-In',
        exact: true,
      }),
    ).toBeVisible()

    await expect(
      page.getByRole('heading', {
        name: 'Research',
        exact: true,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // Edit the occurrence: rename the Check-In section.
    // --------------------------------------------------------

    const checkInMenu = page
      .getByRole('button', {
        name: 'Actions for section Check-In',
      })

    await checkInMenu.scrollIntoViewIfNeeded()

    await checkInMenu.click()

    await page
      .getByRole('menuitem', {
        name: 'Rename / describe',
      })
      .click()

    await page
      .getByLabel('Name', {
        exact: true,
      })
      .fill('Renamed Check-In')

    await page
      .getByRole('button', {
        name: 'Save',
        exact: true,
      })
      .click()

    await expect(
      page.getByRole('heading', {
        name: 'Renamed Check-In',
        exact: true,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // Verify the Series structure is unchanged.
    // --------------------------------------------------------

    await page.goto(
      `/meetings/series?group=${groupId}`,
    )

    const originalSeriesRow = page
      .getByRole('button')
      .filter({
        hasText: 'E2E Series Weekly',
      })

    await originalSeriesRow.click()

    await expect(page).toHaveURL(
      /\/meetings\/series\/\d+$/,
    )

    // The series still has the original section names.
    await expect(
      page.locator('span.font-semibold', { hasText: /^Check-In$/ }),
    ).toBeVisible()

    await expect(
      page.getByText('Research', { exact: true }).first(),
    ).toBeVisible()

    // The occurrence rename must NOT appear in the series.
    await expect(
      page.getByText('Renamed Check-In', { exact: true }),
    ).toHaveCount(0)
  },
)

test(
  'Create Meeting dialog: optional Meeting template selection',
  async ({ page }) => {
    await login(page, 'alex')

    await page
      .getByRole('link', {
        name: /Meetings/,
      })
      .click()

    await expect(page).toHaveURL(
      /\/meetings\?group=\d+$/,
    )

    const meetingsUrl = new URL(page.url())
    const groupId =
      meetingsUrl.searchParams.get('group') ?? '1'

    // --------------------------------------------------------
    // 1. Create a Meeting Template (group-scoped) with one section.
    // --------------------------------------------------------

    await page.goto(
      `/meetings/series?group=${groupId}`,
    )

    await page
      .getByLabel('Name')
      .fill('E2E Template Select Weekly')

    await page
      .getByRole('button', {
        name: /Create template/,
      })
      .click()

    await expect(page).toHaveURL(
      /\/meetings\/series\/\d+$/,
    )

    await page
      .getByLabel('Section name')
      .fill('Template Section One')

    await page
      .getByRole('button', {
        name: /Add section/,
      })
      .click()

    await expect(
      page
        .locator('span.font-semibold', {
          hasText: /^Template Section One$/,
        }),
    ).toBeVisible()

    // --------------------------------------------------------
    // 2. Open the create-Meeting dialog.
    // --------------------------------------------------------

    await page
      .getByRole('link', {
        name: /Meetings/,
      })
      .click()

    await page
      .getByRole('button', {
        name: /New meeting/,
      })
      .click()

    // The dialog exposes a "Meeting template" select with a
    // "No template" default, and the group-scoped template we
    // just created is available.
    const templateSelect = page.getByLabel('Meeting template')

    await expect(templateSelect).toBeVisible()
    await expect(templateSelect).toHaveValue('')

    const option = templateSelect.locator('option', {
      hasText: 'E2E Template Select Weekly',
    })
    await expect(option).toBeAttached()

    // --------------------------------------------------------
    // 3. Select the template and create the Meeting.
    // --------------------------------------------------------

    await templateSelect.selectOption(
      'E2E Template Select Weekly',
    )

    await page
      .getByLabel('Title')
      .fill('E2E Template Select Meeting')

    await page
      .getByLabel('Date and time')
      .fill('2030-04-01T10:00')

    await page
      .locator('form')
      .getByRole('button', {
        name: /Create meeting/,
      })
      .click()

    // --------------------------------------------------------
    // 4. The created Meeting shows the template's section
    //    (snapped into an occurrence-level MeetingSection).
    // --------------------------------------------------------

    const row = page
      .getByRole('button')
      .filter({
        hasText: 'E2E Template Select Meeting',
      })
    await row.click()

    await expect(page).toHaveURL(/\/meetings\/\d+$/)
    await expect(
      page.getByRole('heading', {
        name: 'Template Section One',
        exact: true,
      }),
    ).toBeVisible()
  },
)

test(
  'Delete meeting requires confirmation and removes the Meeting',
  async ({ page }) => {
    await login(page, 'alex')

    await page
      .getByRole('link', {
        name: /Meetings/,
      })
      .click()

    await expect(page).toHaveURL(
      /\/meetings\?group=\d+$/,
    )

    // --------------------------------------------------------
    // 1. Create a Meeting.
    // --------------------------------------------------------

    await page
      .getByRole('button', {
        name: /New meeting/,
      })
      .click()

    await page
      .getByLabel('Title')
      .fill('E2E Delete Meeting')

    await page
      .getByLabel('Date and time')
      .fill('2030-02-03T09:00')

    await page
      .locator('form')
      .getByRole('button', {
        name: /Create meeting/,
      })
      .click()

    await expect(
      page.getByText('E2E Delete Meeting', {
        exact: true,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // 2. Open the Meeting detail.
    // --------------------------------------------------------

    const meetingRow = page
      .getByRole('button')
      .filter({ hasText: 'E2E Delete Meeting' })

    await meetingRow.click()

    await expect(page).toHaveURL(/\/meetings\/\d+$/)

    await expect(
      page.getByRole('heading', {
        name: 'E2E Delete Meeting',
        exact: true,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // 3. Initiate Delete meeting, then cancel: the
    //    Meeting must remain.
    // --------------------------------------------------------

    await page
      .getByRole('button', {
        name: 'Meeting actions',
      })
      .click()

    await page
      .getByRole('menuitem', {
        name: 'Delete meeting',
      })
      .click()

    const deleteDialog = page.getByRole('dialog', {
      name: /Delete meeting\?/,
    })

    await expect(deleteDialog).toBeVisible()

    await deleteDialog
      .getByRole('button', {
        name: 'Cancel',
        exact: true,
      })
      .click()

    await expect(deleteDialog).toHaveCount(0)

    // Still on the Meeting detail page with the Meeting intact.
    await expect(
      page.getByRole('heading', {
        name: 'E2E Delete Meeting',
        exact: true,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // 4. Initiate again and confirm the deletion.
    // --------------------------------------------------------

    await page
      .getByRole('button', {
        name: 'Meeting actions',
      })
      .click()

    await page
      .getByRole('menuitem', {
        name: 'Delete meeting',
      })
      .click()

    const confirmDialog = page.getByRole('dialog', {
      name: /Delete meeting\?/,
    })

    await expect(confirmDialog).toBeVisible()

    await confirmDialog
      .getByRole('button', {
        name: 'Delete meeting',
        exact: true,
      })
      .click()

    // --------------------------------------------------------
    // 5. Successful deletion returns to the Meetings
    //    overview, where the Meeting is absent.
    // --------------------------------------------------------

    await expect(page).toHaveURL(
      /\/meetings(\?group=\d+)?$/,
    )

    await expect(
      page.getByText('E2E Delete Meeting', {
        exact: true,
      }),
    ).toHaveCount(0)
  },
)

const NOTE_MEETING_TITLE =
  'E2E Note Persistence Weekly'

const NOTE_AGENDA_TITLE =
  'E2E Note Agenda Item'

const NOTE_CONTENT =
  'E2E note: agree on release date.'

const NOTE_EDITED_CONTENT =
  'E2E note: release moved to Friday.'

test(
  'Meeting Notes persist across reload and lifecycle transition',
  async ({ page }) => {
    await login(page, 'alex')

    // --------------------------------------------------------
    // 1. Create a Meeting.
    // --------------------------------------------------------

    await page
      .getByRole('link', {
        name: /Meetings/,
      })
      .click()

    await page
      .getByRole('button', {
        name: /New meeting/,
      })
      .click()

    await page
      .getByLabel('Title')
      .fill(NOTE_MEETING_TITLE)

    await page
      .getByLabel('Date and time')
      .fill('2030-03-01T10:00')

    await page
      .locator('form')
      .getByRole('button', {
        name: /Create meeting/,
      })
      .click()

    const noteRow =
      page
        .getByRole('button')
        .filter({
          hasText: NOTE_MEETING_TITLE,
        })

    await noteRow.click()

    await expect(page).toHaveURL(/\/meetings\/\d+$/)

    // --------------------------------------------------------
    // 2. Add an agenda item (upcoming).
    // --------------------------------------------------------

    await quickAddAgendaItem(
      page,
      NOTE_AGENDA_TITLE,
    )

    await expect(
      page.getByText(NOTE_AGENDA_TITLE, {
        exact: true,
      }),
    ).toBeVisible()

    // Upcoming: no Add note control.
    await expect(
      page.getByRole('button', {
        name: /Add note…/,
      }),
    ).toHaveCount(0)

    // --------------------------------------------------------
    // 3. Start the Meeting.
    // --------------------------------------------------------

    await page
      .getByRole('button', {
        name: 'Start meeting',
      })
      .click()

    await expect(
      page.getByRole('button', {
        name: 'End meeting',
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // 4. Add a note to the agenda item.
    // --------------------------------------------------------

    await page
      .getByRole('button', {
        name: /Add note…/,
      })
      .click()

    await page
      .getByLabel(`Add note to ${NOTE_AGENDA_TITLE}`)
      .fill(NOTE_CONTENT)

    await page
      .getByRole('button', {
        name: /^Add note$/,
        exact: true,
      })
      .click()

    // The note is visible.
    await expect(
      page.getByText(NOTE_CONTENT, {
        exact: true,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // 5. Reload and verify the note persists.
    // --------------------------------------------------------

    await page.reload()

    await expect(
      page.getByText(NOTE_CONTENT, {
        exact: true,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // 6. Edit the note.
    // --------------------------------------------------------

    // Open the note actions menu. The trigger is a menu button
    // rendered in a hover row; use getByRole with the label.
    const noteActions = page.getByRole(
      'button',
      { name: /Note actions for/ },
    )

    await expect(noteActions).toHaveCount(1)
    await noteActions.click()

    await page
      .getByRole('menuitem', {
        name: 'Edit note',
      })
      .click()

    await page
      .getByLabel(`Edit note on ${NOTE_AGENDA_TITLE}`)
      .fill(NOTE_EDITED_CONTENT)

    await page
      .getByRole('button', {
        name: /^Save$/,
        exact: true,
      })
      .click()

    await expect(
      page.getByText(NOTE_EDITED_CONTENT, {
        exact: true,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // 7. Reload and verify the edit persisted.
    // --------------------------------------------------------

    await page.reload()

    await expect(
      page.getByText(NOTE_EDITED_CONTENT, {
        exact: true,
      }),
    ).toBeVisible()

    await expect(
      page.getByText(NOTE_CONTENT, {
        exact: true,
      }),
    ).toHaveCount(0)

    // --------------------------------------------------------
    // 8. Resolve the current (discussing) item, then End.
    //    The canonical End action rejects while an item is still
    //    discussing, so the item is explicitly marked done.
    // --------------------------------------------------------

    // Done lives in the Current Item workspace (it was
    // deliberately moved out of the Agenda rows).
    const noteWorkspace = page.getByRole('main', {
      name: 'Current item',
    })

    await expect(
      noteWorkspace.getByRole('heading', {
        name: NOTE_AGENDA_TITLE,
        exact: true,
      }),
    ).toBeVisible()

    await noteWorkspace
      .getByRole('button', {
        name: `Mark ${NOTE_AGENDA_TITLE} as done`,
      })
      .click()

    // The Agenda rail now shows the item as resolved.
    const noteAgendaItem = page
      .getByRole('navigation', { name: 'Agenda' })
      .locator('li')
      .filter({
        has: page.getByText(NOTE_AGENDA_TITLE, {
          exact: true,
        }),
      })

    await expect(
      noteAgendaItem
        .getByText('Completed', { exact: true }),
    ).toBeVisible()

    // No Done action remains anywhere (workspace switched
    // to the no-current-item state).
    await expect(
      page.getByRole('button', {
        name: `Mark ${NOTE_AGENDA_TITLE} as done`,
      }),
    ).toHaveCount(0)

    await page
      .getByRole('button', {
        name: 'End meeting',
      })
      .click()

    await expect(
      page.getByRole('button', {
        name: 'Reopen meeting',
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // 9. Completed: the protocol shows the note and offers no
    //    Add/Edit/Delete authoring controls.
    // --------------------------------------------------------

    await expect(
      page.getByText(NOTE_EDITED_CONTENT, {
        exact: true,
      }),
    ).toBeVisible()

    await expect(
      page.getByRole('button', {
        name: /Add note…/,
      }),
    ).toHaveCount(0)

    // No per-note "Edit note" menu is exposed in Completed.
    await expect(
      page.getByRole('button', {
        name: /Note actions for/,
      }),
    ).toHaveCount(0)

    // --------------------------------------------------------
    // 10. Reload the Completed Meeting; the note is still
    //     visible and still read-only.
    // --------------------------------------------------------

    await page.reload()

    await expect(
      page.getByText(NOTE_EDITED_CONTENT, {
        exact: true,
      }),
    ).toBeVisible()

    await expect(
      page.getByRole('button', {
        name: /Add note…/,
      }),
    ).toHaveCount(0)

    await expect(
      page.getByRole('button', {
        name: /Note actions for/,
      }),
    ).toHaveCount(0)
  },
)

test(
  'Meeting Note creates canonical linked work at the exact Note',
  async ({ page }) => {
    const projectName =
      'E2E Note Linked Work Project'

    const meetingTitle =
      'E2E Note Linked Weekly'

    const agendaTitle =
      'E2E Note Linked Agenda'

    const noteContent =
      'Check new quotation tomorrow'

    // --------------------------------------------------------
    // Alex creates a writable target Project.
    // --------------------------------------------------------

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

    await expect(
      createProjectDialog,
    ).toBeVisible()

    await createProjectDialog
      .getByLabel('Project name')
      .fill(projectName)

    await createProjectDialog
      .getByRole('button', {
        name: /Create project/,
      })
      .click()

    await expect(
      page.getByText(projectName, {
        exact: true,
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // Create and open a Research Group Meeting.
    // --------------------------------------------------------

    await page
      .getByRole('link', {
        name: /Meetings/,
      })
      .click()

    await page
      .getByRole('button', {
        name: /New meeting/,
      })
      .click()

    await page
      .getByLabel('Title')
      .fill(meetingTitle)

    await page
      .getByLabel('Date and time')
      .fill('2030-04-01T10:00')

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
          hasText: meetingTitle,
        })

    await meetingRow.click()

    await expect(page).toHaveURL(
      /\/meetings\/\d+$/,
    )

    await quickAddAgendaItem(
      page,
      agendaTitle,
    )

    // --------------------------------------------------------
    // Start the Meeting (Notes are Live-only).
    // --------------------------------------------------------

    await page
      .getByRole('button', {
        name: 'Start meeting',
      })
      .click()

    await expect(
      page.getByRole('button', {
        name: 'End meeting',
      }),
    ).toBeVisible()

    // --------------------------------------------------------
    // Draft a Note and choose "Create work item". The Note is
    // persisted FIRST; only then does the dialog open, anchored
    // to that exact persisted Note.
    // --------------------------------------------------------

    await page
      .getByRole('button', {
        name: /Add note…/,
      })
      .click()

    const noteInput = page.getByLabel(
      `Add note to ${agendaTitle}`,
    )

    await noteInput.fill(noteContent)

    await page
      .getByRole('button', {
        name: 'Create work item',
      })
      .click()

    // The composer closed and the Note persisted.
    await expect(
      noteInput,
    ).toHaveCount(0)

    // The current item's title is shown as the Current Item
    // heading while Live (and as an h4 in the Protocol after
    // the Meeting ends), so assert it by role without coupling
    // to one layout.
    await expect(
      page.getByRole('heading', {
        name: agendaTitle,
        exact: true,
      }),
    ).toBeVisible()

    // The persisted Note content is unique on the page (the
    // Work Item dialog was just dismissed; the dialog fields
    // prefilled this exact string are no longer in the tree).
    // The nearest ancestor <li> of the Note text is the Note
    // row itself, in BOTH the Live Current Item workspace and
    // the classic Protocol layout. Scoping to that exact
    // <li> keeps every Linked-work assertion below tied to
    // this exact Note (never a page-global Work Item match).
    const noteBlock = page
      .getByText(noteContent, { exact: true })
      .locator('xpath=ancestor::li[1]')

    await expect(
      noteBlock,
    ).toBeVisible()

    const workItemDialog =
      page.getByRole('dialog', {
        name: 'Create work item',
      })

    await expect(
      workItemDialog,
    ).toBeVisible()

    // Research Group Meeting: NO arbitrary Project is
    // preselected; the user must choose explicitly.
    await expect(
      workItemDialog
        .getByLabel('Project'),
    ).toHaveValue('')

    // Title + Description are prefilled from the exact Note.
    await expect(
      workItemDialog
        .getByLabel('Title'),
    ).toHaveValue(noteContent)

    await expect(
      workItemDialog
        .getByLabel('Description'),
    ).toHaveValue(noteContent)

    // Choose the target Project explicitly.
    await workItemDialog
      .getByLabel('Project')
      .selectOption({
        label: projectName,
      })

    await workItemDialog
      .getByRole('button', {
        name: /Create work item/,
      })
      .click()

    await expect(
      workItemDialog,
    ).not.toBeVisible()

    // --------------------------------------------------------
    // The Note remains visible; Linked work appears under
    // that exact Note, and the default Create work item
    // action for the Note disappears.
    // --------------------------------------------------------

    await expect(
      noteBlock.locator(
        'p.whitespace-pre-wrap',
      ),
    ).toHaveText(
      noteContent,
    )

    await expect(
      noteBlock.getByText(
        'Linked work',
        { exact: true },
      ),
    ).toBeVisible()

    await expect(
      noteBlock
        .getByRole('button', {
          name: /Open linked work item/,
        }),
    ).toBeVisible()

    await expect(
      page.getByRole('button', {
        name: `Create work item from note: ${noteContent}`,
      }),
    ).toHaveCount(0)

    // --------------------------------------------------------
    // Click the linked Work Item: the existing Inspector
    // opens in place without leaving the Meeting.
    // --------------------------------------------------------

    await noteBlock
      .getByRole('button', {
        name: /Open linked work item/,
      })
      .click()

    const inspector =
      page.getByRole('region', {
        name: 'Work item',
      })

    await expect(
      inspector,
    ).toBeVisible()

    // Source traceability is resolved from the source
    // relation and shown in the Inspector.
    await expect(
      inspector.getByText(
        'Created from',
      ),
    ).toBeVisible()

    await expect(
      inspector.getByText(
        meetingTitle,
      ),
    ).toBeVisible()

    await expect(
      inspector.getByText(
        agendaTitle,
      ),
    ).toBeVisible()

    await expect(
      inspector.getByText(
        'Source note',
      ),
    ).toBeVisible()

    await expect(
      inspector
        .locator(
          'p.whitespace-pre-wrap',
        ),
    ).toHaveText(
      noteContent,
    )

    // --------------------------------------------------------
    // Close the Inspector; the same Meeting context
    // remains.
    // --------------------------------------------------------

    await page
      .getByRole('button', {
        name: 'Close work item',
      })
      .click()

    await expect(
      inspector,
    ).not.toBeVisible()

    await expect(
      page.getByRole('heading', {
        name: meetingTitle,
      }),
    ).toBeVisible()

    await expect(
      noteBlock.locator(
        'p.whitespace-pre-wrap',
      ),
    ).toHaveText(
        noteContent,
    )

    await expect(page).toHaveURL(
      /\/meetings\/\d+$/,
    )

    // --------------------------------------------------------
    // Complete the Meeting: the current item is explicitly
    // resolved (canonical End rejects while discussing), linked
    // work stays visible, Notes remain read-only.
    // --------------------------------------------------------

    // Resolve the current item from the Current Item
    // workspace (Done no longer lives in the Agenda rows).
    const liveWorkspace = page.getByRole('main', {
      name: 'Current item',
    })

    await liveWorkspace
      .getByRole('button', {
        name: `Mark ${agendaTitle} as done`,
      })
      .click()

    await expect(
      page.getByRole('button', {
        name: `Mark ${agendaTitle} as done`,
      }),
    ).toHaveCount(0)

    // The Agenda rail now shows the item as resolved. Its
    // accessible name carries the "Completed" status hint.
    const doneAgendaItem = page
      .getByRole('navigation', { name: 'Agenda' })
      .locator('li')
      .filter({
        has: page.getByText(agendaTitle, { exact: true }),
      })

    // The status hint is sr-only text: assert the exact text
    // is attached within the resolved agenda item.
    await expect(
      doneAgendaItem
        .getByText('Completed', { exact: true }),
    ).toBeAttached()

    await page
      .getByRole('button', {
        name: 'End meeting',
      })
      .click()

    await expect(
      page.getByRole('button', {
        name: 'Reopen meeting',
      }),
    ).toBeVisible()

    await expect(
      noteBlock.getByText(
        'Linked work',
        { exact: true },
      ),
    ).toBeVisible()

    await expect(
      page.getByRole('button', {
        name: /Add note…/,
      }),
    ).toHaveCount(0)

    await expect(
      page.getByRole('button', {
        name: /Add note$/,
      }),
    ).toHaveCount(0)

    // No per-note Edit/Delete menu in Completed.
    await expect(
      page.getByRole('button', {
        name: /Note actions for/,
      }),
    ).toHaveCount(0)

    // --------------------------------------------------------
    // Reload: Note + Linked work persist.
    // --------------------------------------------------------

    await page.reload()

    await expect(
      page.getByRole('button', {
        name: 'Reopen meeting',
      }),
    ).toBeVisible()

    await expect(
      noteBlock.locator(
        'p.whitespace-pre-wrap',
      ),
    ).toHaveText(
      noteContent,
    )

    await expect(
      noteBlock.getByText(
        'Linked work',
        { exact: true },
      ),
    ).toBeVisible()

    await expect(
      page.getByRole('button', {
        name: `Create work item from note: ${noteContent}`,
      }),
    ).toHaveCount(0)
  },
)

test(
  'Project Meeting preselects its writable Project for Note work',
  async ({ page }) => {
    const projectName =
      'E2E Project Meeting Work Project'

    const meetingTitle =
      'E2E Project Meeting Work'

    const agendaTitle =
      'E2E PM Agenda'

    const noteContent =
      'Prepare the budget sheet'

    // Alex creates the target Project.
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
      .fill(projectName)

    await createProjectDialog
      .getByRole('button', {
        name: /Create project/,
      })
      .click()

    await expect(
      page.getByText(projectName, {
        exact: true,
      }),
    ).toBeVisible()

    // Create a Project Meeting for that Project.
    await page
      .getByRole('link', {
        name: /Meetings/,
      })
      .click()

    await page
      .getByRole('button', {
        name: /New meeting/,
      })
      .click()

    const newMeetingDialog =
      page.getByRole('dialog', {
        name: 'New meeting',
      })

    await newMeetingDialog
      .getByLabel('Project')
      .selectOption({
        label: projectName,
      })

    await newMeetingDialog
      .getByLabel('Title')
      .fill(meetingTitle)

    await newMeetingDialog
      .getByLabel('Date and time')
      .fill('2030-05-02T09:00')

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
          hasText: meetingTitle,
        })

    await meetingRow.click()

    await expect(page).toHaveURL(
      /\/meetings\/\d+$/,
    )

    await quickAddAgendaItem(
      page,
      agendaTitle,
    )

    await page
      .getByRole('button', {
        name: 'Start meeting',
      })
      .click()

    // Add a persisted Note.
    await page
      .getByRole('button', {
        name: /Add note…/,
      })
      .click()

    await page
      .getByLabel(`Add note to ${agendaTitle}`)
      .fill(noteContent)

    await page
      .getByRole('button', {
        name: /^Add note$/,
        exact: true,
      })
      .click()

    // The saved Note's <p> is the only element whose full text
    // equals the Note content. Its parent <li> is the Note row
    // itself: the outer Agenda Item <li> only contains the Note
    // as descendant content, so every assertion below is scoped
    // to that exact Note.
    const noteBlock = page
      .getByText(
        noteContent,
        { exact: true },
      )
      .locator('xpath=..')

    // Open the Note-anchored work dialog from the persisted
    // Note.
    await noteBlock
      .getByRole('button', {
        name: `Create work item from note: ${noteContent}`,
      })
      .click()

    const workItemDialog =
      page.getByRole('dialog', {
        name: 'Create work item',
      })

    await expect(
      workItemDialog,
    ).toBeVisible()

    // The Meeting's own writable Project is preselected.
    await expect(
      workItemDialog
        .getByLabel('Project')
        .locator('option:checked'),
    ).toHaveText(
      projectName,
    )

    await workItemDialog
      .getByRole('button', {
        name: /Create work item/,
      })
      .click()

    await expect(
      workItemDialog,
    ).not.toBeVisible()

    // Linked work appears under the exact Note in the
    // Meeting's own Project.
    await expect(
      noteBlock.getByText(
        'Linked work',
      ),
    ).toBeVisible()

    await expect(
      noteBlock.getByText(
        projectName,
      ),
    ).toBeVisible()

    await expect(
      page.getByRole('button', {
        name: `Create work item from note: ${noteContent}`,
      }),
    ).toHaveCount(0)
  },
)
test(
  'Delete Note removes only the Note, not the agenda item',
  async ({ page }) => {
    await login(page, 'alex')

    await page
      .getByRole('link', {
        name: /Meetings/,
      })
      .click()

    await page
      .getByRole('button', {
        name: /New meeting/,
      })
      .click()

    await page
      .getByLabel('Title')
      .fill('E2E Note Delete Weekly')

    await page
      .getByLabel('Date and time')
      .fill('2030-03-02T10:00')

    await page
      .locator('form')
      .getByRole('button', {
        name: /Create meeting/,
      })
      .click()

    const deleteRow =
      page
        .getByRole('button')
        .filter({
          hasText: 'E2E Note Delete Weekly',
        })

    await deleteRow.click()

    await expect(page).toHaveURL(/\/meetings\/\d+$/)

    await quickAddAgendaItem(
      page,
      'E2E Delete Agenda',
    )

    await page
      .getByRole('button', {
        name: 'Start meeting',
      })
      .click()

    await expect(
      page.getByRole('button', {
        name: 'End meeting',
      }),
    ).toBeVisible()

    const deleteNoteContent =
      'E2E note to be deleted.'

    await page
      .getByRole('button', {
        name: /Add note…/,
      })
      .click()

    await page
      .getByLabel('Add note to E2E Delete Agenda')
      .fill(deleteNoteContent)

    await page
      .getByRole('button', {
        name: /^Add note$/,
        exact: true,
      })
      .click()

    await expect(
      page.getByText(deleteNoteContent, {
        exact: true,
      }),
    ).toBeVisible()

    // Open the note actions menu and select Delete note.
    const noteActions = page.getByRole(
      'button',
      { name: /Note actions for/ },
    )

    await noteActions.click()

    await page
      .getByRole('menuitem', {
        name: 'Delete note',
      })
      .click()

    // Confirm through the destructive dialog.
    await page
      .getByRole('dialog', {
        name: /Delete note\?/,
      })
      .getByRole('button', {
        name: /Delete note/,
      })
      .click()

    // The note is gone.
    await expect(
      page.getByText(deleteNoteContent, {
        exact: true,
      }),
    ).toHaveCount(0)

    // The agenda item itself is still present. Its title
    // correctly appears in BOTH panes (Agenda rail + Current
    // Item heading), so scope each assertion explicitly.
    const deleteAgenda = page.getByRole('navigation', {
      name: 'Agenda',
    })

    await expect(
      deleteAgenda
        .locator('li')
        .filter({
          has: page.getByText('E2E Delete Agenda', {
            exact: true,
          }),
        })
        .getByText('E2E Delete Agenda', { exact: true }),
    ).toBeVisible()

    const deleteWorkspace = page.getByRole('main', {
      name: 'Current item',
    })

    await expect(
      deleteWorkspace.getByRole('heading', {
        name: 'E2E Delete Agenda',
        exact: true,
      }),
    ).toBeVisible()
  },
)

test(
  'Live MeetingItem state machine end-to-end flow',
  async ({ page }) => {
    // --------------------------------------------------------
    // Alex creates a real Meeting with 3 agenda items.
    // --------------------------------------------------------

    await login(page, 'alex')

    await page
      .getByRole('link', {
        name: /Meetings/,
      })
      .click()

    await page
      .getByRole('button', {
        name: /New meeting/,
      })
      .click()

    await page
      .getByLabel('Title')
      .fill('E2E Live State Machine')

    await page
      .getByLabel('Date and time')
      .fill('2030-02-03T09:00')

    await page
      .locator('form')
      .getByRole('button', {
        name: /Create meeting/,
      })
      .click()

    await expect(
      page.getByText('E2E Live State Machine', { exact: true }),
    ).toBeVisible()

    const meetingRow = page
      .getByRole('button')
      .filter({ hasText: 'E2E Live State Machine' })
    await meetingRow.click()

    await expect(page).toHaveURL(/\/meetings\/\d+$/)

    // Add 3 agenda items (upcoming layout).
    const titles = ['Alpha', 'Beta', 'Gamma']
    for (const title of titles) {
      await quickAddAgendaItem(page, title)
      await expect(
        page.getByText(title, { exact: true }),
      ).toBeVisible()
    }

    // Live shell: the Agenda rail lists every item with its
    // accessible status; the Current Item workspace shows the
    // current item. These locators are used below.
    const agenda = page.getByRole('navigation', {
      name: 'Agenda',
    })
    const workspace = page.getByRole('main', {
      name: 'Current item',
    })

    const agendaItem = (title: string) =>
      agenda.locator('li').filter({
        has: page.getByText(title, { exact: true }),
      })

    // The Agenda rail exposes each item's status through an
    // sr-only text hint, so the symbol alone is never the only
    // signal. The hint is a child sr-only text node (attached to
    // the DOM, read by screen readers, visually hidden), so
    // assert the exact text is attached within the item.
    const itemHasStatus = async (
      title: string,
      status: string,
    ) => {
      await expect(
        agendaItem(title).getByText(status, { exact: true }),
      ).toBeAttached()
    }

    // --------------------------------------------------------
    // Start: the first item becomes current (discussing) and
    // the Live shell takes over the layout.
    // --------------------------------------------------------

    await page
      .getByRole('button', { name: 'Start meeting' })
      .click()

    await expect(
      page.getByRole('button', { name: 'End meeting' }),
    ).toBeVisible()

    await expect(
      page.getByRole('main', { name: 'Current item' }),
    ).toContainText('Alpha')

    await itemHasStatus('Alpha', 'Discussing now')

    // The Done action lives in the Current Item workspace.
    await expect(
      page.getByRole('button', { name: 'Mark Alpha as done' }),
    ).toBeVisible()

    // --------------------------------------------------------
    // Focus the second item (Beta) from the Agenda rail.
    // --------------------------------------------------------

    await agendaItem('Beta')
      .getByRole('button', { name: 'Focus Beta' })
      .click()

    await expect(
      workspace,
    ).toContainText('Beta')

    await itemHasStatus('Beta', 'Discussing now')
    await itemHasStatus('Alpha', 'Open')
    await expect(
      agendaItem('Alpha')
        .getByRole('button', { name: 'Focus Alpha' }),
    ).toBeVisible()

    // --------------------------------------------------------
    // Done Beta -> next (Gamma) becomes current.
    // --------------------------------------------------------

    await page
      .getByRole('button', { name: 'Mark Beta as done' })
      .click()

    await expect(
      workspace,
    ).toContainText('Gamma')

    await itemHasStatus('Beta', 'Completed')
    await itemHasStatus('Gamma', 'Discussing now')

    // --------------------------------------------------------
    // Follow up Gamma -> Gamma follow_up; the only remaining
    // not_discussed item (Alpha) becomes current.
    // --------------------------------------------------------

    await page
      .getByRole('button', {
        name: 'Mark Gamma as follow-up',
      })
      .click()

    await expect(
      workspace,
    ).toContainText('Alpha')

    await itemHasStatus('Gamma', 'Resolved with follow-up')
    await itemHasStatus('Alpha', 'Discussing now')

    // --------------------------------------------------------
    // Reload proves persistence of all item states: Alpha is
    // already current, Beta stays done, Gamma stays follow-up.
    // --------------------------------------------------------

    await page.reload()

    await itemHasStatus('Alpha', 'Discussing now')
    await itemHasStatus('Beta', 'Completed')
    await itemHasStatus('Gamma', 'Resolved with follow-up')
    await expect(
      workspace,
    ).toContainText('Alpha')

    // --------------------------------------------------------
    // End is rejected while a current item exists: with Alpha
    // still current, End must fail and the Meeting stays live.
    // --------------------------------------------------------

    await page
      .getByRole('button', { name: 'End meeting' })
      .click()

    // The End action is rejected visibly; the Meeting stays live
    // with the current item still discussing.
    await expect(
      page.getByRole('alert'),
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'End meeting' }),
    ).toBeVisible()
    await itemHasStatus('Alpha', 'Discussing now')
    await expect(
      workspace,
    ).toContainText('Alpha')
    await expect(
      page.getByRole('button', { name: 'Start meeting' }),
    ).toBeHidden()

    // --------------------------------------------------------
    // Finish the final current item, then End succeeds.
    // --------------------------------------------------------

    await page
      .getByRole('button', { name: 'Mark Alpha as done' })
      .click()

    await itemHasStatus('Alpha', 'Completed')
    // Alpha is no longer announced as discussing.
    await expect(
      agendaItem('Alpha').getByText('Discussing now', {
        exact: true,
      }),
    ).toHaveCount(0)

    // All items resolved: the workspace no longer offers a
    // Done action and shows the no-current-item state.
    await expect(
      page.getByRole('button', { name: 'Mark Alpha as done' }),
    ).toHaveCount(0)
    await expect(
      workspace,
    ).toContainText('No current item')

    await page
      .getByRole('button', { name: 'End meeting' })
      .click()

    await expect(
      page.getByRole('button', { name: 'Reopen meeting' }),
    ).toBeVisible()

    // Canonical completed-state signal: the live lifecycle
    // control is gone, while the Completed action replaces it.
    await expect(
      page.getByRole('button', { name: 'End meeting' }),
    ).toBeHidden()
  },
)
