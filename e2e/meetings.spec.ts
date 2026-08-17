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

const AGENDA_NOTES =
  'Discuss scope and ownership.'

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
      /\/meetings$/,
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

    await page
      .getByLabel('Agenda item')
      .fill(AGENDA_TITLE)

    await page
      .getByLabel('Notes')
      .fill(AGENDA_NOTES)

    await page
      .getByRole('button', {
        name: /Add agenda item/,
      })
      .click()

    await expect(
      page.getByText(
        AGENDA_TITLE,
        { exact: true },
      ),
    ).toBeVisible()

    await expect(
      page.getByText(
        AGENDA_NOTES,
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
    // Alex starts the Meeting.
    // --------------------------------------------------------

    const meetingStatus =
      page.getByLabel(
        'Meeting status',
      )

    await meetingStatus.selectOption(
      'live',
    )

    await expect(
      meetingStatus,
    ).toHaveValue('live')

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

    await expect(
      page.getByText(
        AGENDA_NOTES,
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
      page.getByLabel(
        'Meeting status',
      ),
    ).toHaveValue('live')
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
      .getByRole('button', {
        name: /Members/,
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
      /\/meetings$/,
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

    await page
      .getByLabel('Agenda item')
      .fill(taskTitle)

    await page
      .getByLabel('Notes')
      .fill(
        'Create a real Project task for Chris.',
      )

    await page
      .getByRole('button', {
        name: /Add agenda item/,
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
        hasText: 'Create work item',
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
