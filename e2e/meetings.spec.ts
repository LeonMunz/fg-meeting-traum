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

    // Creator is automatically a participant.
    await expect(
      page.getByText(
        '@alex',
        { exact: true },
      ),
    ).toBeVisible()

    // --------------------------------------------------------
    // Alex adds Chris as participant.
    // --------------------------------------------------------

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

    await expect(
      page.getByText(
        '@chris',
        { exact: true },
      ),
    ).toBeVisible()

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
    await page
      .getByLabel('Add item to Agenda')
      .fill(AGENDA_TITLE)

    await page
      .getByRole('button', {
        name: 'Add Agenda item',
      })
      .click()

    await expect(
      page.getByText(
        AGENDA_TITLE,
        { exact: true },
      ),
    ).toBeVisible()

    const agendaItem =
      page
        .locator('article')
        .filter({
          has: page.getByText(
            AGENDA_TITLE,
            { exact: true },
          ),
        })

    await expect(
      agendaItem,
    ).toBeVisible()

    await agendaItem
      .getByRole('button')
      .filter({
        hasText: 'Mark discussed',
      })
      .click()

    await expect(
      agendaItem
        .getByRole('button')
        .filter({
          hasText: 'Discussed',
        }),
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

    await expect(
      page.getByText(
        '@alex',
        { exact: true },
      ),
    ).toBeVisible()

    await expect(
      page.getByText(
        '@chris',
        { exact: true },
      ),
    ).toBeVisible()

    await expect(
      page.getByText(
        AGENDA_TITLE,
        { exact: true },
      ),
    ).toBeVisible()

    const persistedAgendaItem =
      page
        .locator('article')
        .filter({
          has: page.getByText(
            AGENDA_TITLE,
            { exact: true },
          ),
        })

    await expect(
      persistedAgendaItem
        .getByRole('button')
        .filter({
          hasText: 'Discussed',
        }),
    ).toBeVisible()

    await expect(
      page.getByRole('button', { name: 'End meeting' }),
    ).toBeVisible()
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
        '@chris',
        { exact: true },
      ),
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
    await page
      .getByLabel('Add item to Agenda')
      .fill(taskTitle)

    await page
      .getByRole('button', {
        name: 'Add Agenda item',
      })
      .click()

    const agendaItem =
      page
        .locator('article')
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

    await agendaItem
      .getByRole('button')
      .filter({
        hasText: 'Work item',
      })
      .click()

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
        .locator('article')
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
      page.getByLabel('Add item to Agenda'),
    ).toHaveCount(0)

    await expect(
      page.getByLabel('New section name'),
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

    // Add a second section.
    await page
      .getByLabel('New section name')
      .fill('TOPs')

    await page
      .getByRole('button', {
        name: /Add section/,
      })
      .click()

    await expect(
      page.getByRole('heading', {
        name: 'TOPs',
        exact: true,
      }),
    ).toBeVisible()

    // Add an item under each section.
    await page
      .getByLabel('Add item to Agenda')
      .fill('Agenda item A')

    await page
      .getByRole('button', {
        name: 'Add Agenda item',
      })
      .click()

    await page
      .getByLabel('Add item to TOPs')
      .fill('TOPs item C')

    await page
      .getByRole('button', {
        name: 'Add TOPs item',
      })
      .click()

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

    const checkInSection = page
      .locator('div')
      .filter({
        has: page.getByRole('heading', {
          name: 'Check-In',
          exact: true,
        }),
      })
      .first()

    await checkInSection
      .getByRole('button', {
        name: /Edit Check-In/,
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
