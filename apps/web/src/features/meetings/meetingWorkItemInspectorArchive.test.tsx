// @vitest-environment happy-dom
//
// Rendered regression tests for the Meeting → shared Work Item
// Inspector read-only contract: a Work Item whose Project is
// ARCHIVED must open from a Meeting in the established read-only
// Inspector state (the same archive-state rule the Project Work
// Items surface and the My Work drawer apply: viewer OR archived
// Project), with every archive-restricted editing control
// unavailable or disabled and NO mutation request originating from
// a disabled interaction. Work Items of active Projects keep their
// existing editing behavior, existing viewer/editor permissions are
// unchanged, and moving between archived and active items must not
// leave stale read-only state behind.
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'

import { MemoryRouter, Route, Routes } from 'react-router'

import { ResearchGroupProvider } from '../research-group/ResearchGroupProvider'
import { SessionProvider } from '../../api/SessionProvider'
import { MeetingDetailPage } from './MeetingDetailPage'

import * as authApi from '../../api/auth'
import * as meetingsApi from '../../api/meetings'
import * as projectsApi from '../../api/projects'
import * as researchGroupsApi from '../../api/research-groups'
import * as workItemsApi from '../../api/work-items'

vi.mock('../../api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof authApi>()
  return { ...actual, me: vi.fn() }
})

vi.mock('../../api/meetings', async (importOriginal) => {
  const actual = await importOriginal<typeof meetingsApi>()
  return {
    ...actual,
    getMeeting: vi.fn(),
    listMeetingParticipants: vi.fn(),
    listMeetingItems: vi.fn(),
    listMeetingSections: vi.fn(),
    focusMeetingItem: vi.fn(),
    markMeetingItemDone: vi.fn(),
    reopenMeetingItem: vi.fn(),
    markMeetingItemFollowUp: vi.fn(),
    getMeetingItemFollowUpTargets: vi.fn(),
    scheduleMeetingItemFollowUp: vi.fn(),
  }
})

vi.mock('../../api/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof projectsApi>()
  return {
    ...actual,
    getProject: vi.fn(),
    getProjectWorkItemConfiguration: vi.fn(),
    listProjectMemberships: vi.fn(),
    listResearchGroupMembers: vi.fn(),
  }
})

vi.mock('../../api/research-groups', async (importOriginal) => {
  const actual =
    await importOriginal<typeof researchGroupsApi>()
  return {
    ...actual,
    listResearchGroups: vi.fn(),
    listResearchGroupMemberships: vi.fn(),
  }
})

vi.mock('../../api/work-items', async (importOriginal) => {
  const actual =
    await importOriginal<typeof workItemsApi>()
  return {
    ...actual,
    getWorkItem: vi.fn(),
    listProjectWorkItems: vi.fn(),
    listWorkItemComments: vi.fn(),
    listWorkItemHistory: vi.fn(),
    updateWorkItem: vi.fn(),
    createWorkItemComment: vi.fn(),
  }
})

import type {
  ApiLinkedWorkItem,
  ApiMeeting,
  ApiMeetingItem,
  ApiMeetingNote,
  ApiMeetingSection,
  ApiProject,
  ApiProjectMembership,
  ApiProjectWorkItemConfiguration,
  ApiWorkItem,
} from '../../api/types'

/* ── Fixtures ────────────────────────────────────────────────── */

const MEETING_ID = 11
const ARCHIVED_PROJECT_ID = 7
const ACTIVE_PROJECT_ID = 8
const WORK_ITEM_A_ID = 101
const WORK_ITEM_B_ID = 102

const LINKED_A: ApiLinkedWorkItem = {
  id: WORK_ITEM_A_ID,
  title: 'Prepare purchase request',
  projectId: ARCHIVED_PROJECT_ID,
  projectName: 'Lab Ops',
  statusName: 'In progress',
  assigneeNames: ['Alex Dev'],
}

const LINKED_B: ApiLinkedWorkItem = {
  id: WORK_ITEM_B_ID,
  title: 'Book lab room',
  projectId: ACTIVE_PROJECT_ID,
  projectName: 'Materials',
  statusName: 'In progress',
  assigneeNames: ['Alex Dev'],
}

function makeNote(
  overrides: Partial<ApiMeetingNote> = {},
): ApiMeetingNote {
  return {
    id: 1,
    meetingItemId: 2,
    author: {
      id: 1,
      username: 'alex',
      firstName: 'Alex',
      lastName: 'Dev',
    },
    content: 'We should buy more reagents.',
    createdAt: '2026-09-01T09:05:00Z',
    updatedAt: '2026-09-01T09:05:00Z',
    linkedWorkItem: null,
    ...overrides,
  }
}

function makeItem(
  overrides: Partial<ApiMeetingItem> = {},
): ApiMeetingItem {
  return {
    id: 2,
    meetingId: MEETING_ID,
    meetingSectionId: 1,
    title: 'Budget review',
    contextNotes: '',
    content: 'Budget review',
    position: 0,
    outcome: 'not_discussed',
    followUpSchedule: null,
    workItemIds: [],
    notes: [
      makeNote({
        id: 1,
        linkedWorkItem: LINKED_A,
      }),
      makeNote({
        id: 2,
        content: 'And book the lab room.',
        linkedWorkItem: LINKED_B,
      }),
    ],
    createdById: 1,
    createdAt: '2026-09-01T09:00:00Z',
    updatedAt: '2026-09-01T09:00:00Z',
    ...overrides,
  }
}

function makeSection(): ApiMeetingSection {
  return {
    id: 1,
    meetingId: MEETING_ID,
    sourceSeriesSectionId: null,
    name: 'Agenda',
    description: '',
    position: 0,
    isVisible: true,
  }
}

function makeMeeting(): ApiMeeting {
  return {
    id: MEETING_ID,
    researchGroupId: 1,
    scope: 'group',
    projectId: null,
    seriesId: null,
    title: 'FG Weekly',
    scheduledAt: '2026-09-01T09:00:00Z',
    startedAt: '2026-09-01T09:01:00Z',
    endedAt: null,
    status: 'live',
    currentMeetingItemId: 2,
    participantIds: [1],
    actionPermissions: {
      canEdit: true,
      canDelete: true,
      canCancel: false,
    },
    createdById: 1,
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-01T09:01:00Z',
  }
}

function makeArchivedProject(
  role: 'owner' | 'member' | 'viewer' = 'owner',
): ApiProject {
  return {
    id: ARCHIVED_PROJECT_ID,
    researchGroupId: 1,
    name: 'Lab Ops',
    description: '',
    status: 'active',
    archivedAt: '2026-09-01T07:00:00Z',
    currentUserRole: role,
    createdAt: '2026-08-01T08:00:00Z',
    updatedAt: '2026-09-01T07:00:00Z',
  }
}

function makeActiveProject(
  role: 'owner' | 'member' | 'viewer' = 'member',
): ApiProject {
  return {
    id: ACTIVE_PROJECT_ID,
    researchGroupId: 1,
    name: 'Materials',
    description: '',
    status: 'active',
    archivedAt: null,
    currentUserRole: role,
    createdAt: '2026-08-01T08:00:00Z',
    updatedAt: '2026-08-01T08:00:00Z',
  }
}

function makeConfiguration(): ApiProjectWorkItemConfiguration {
  return {
    types: [
      {
        id: 1,
        name: 'Task',
        kind: 'task',
        order: 0,
        active: true,
      },
    ],
    statuses: [
      {
        id: 11,
        name: 'Todo',
        category: 'todo',
        order: 0,
        active: true,
        isDefault: true,
      },
      {
        id: 12,
        name: 'In progress',
        category: 'in_progress',
        order: 1,
        active: true,
        isDefault: false,
      },
    ],
    labels: [],
  }
}

function makeWorkItem(
  overrides: Partial<ApiWorkItem> = {},
): ApiWorkItem {
  return {
    id: WORK_ITEM_A_ID,
    projectId: ARCHIVED_PROJECT_ID,
    title: LINKED_A.title,
    description: 'Compare vendor quotes.',
    typeDefinitionId: 1,
    statusDefinitionId: 12,
    boardPosition: null,
    labelDefinitionIds: [],
    type: 'task',
    status: 'in_progress',
    assigneeIds: [1],
    parentId: null,
    dueDate: null,
    blockedReason: null,
    completedAt: null,
    createdAt: '2026-08-15T08:00:00Z',
    updatedAt: '2026-08-15T08:00:00Z',
    createdById: 1,
    meetingOrigin: null,
    ...overrides,
  }
}

function makeMembership(
  role: 'owner' | 'member' = 'owner',
): ApiProjectMembership {
  return {
    id: 1,
    role,
    addedAt: null,
    user: {
      id: 1,
      username: 'alex',
      firstName: 'Alex',
      lastName: 'Dev',
    },
  }
}

/* ── Render helpers ──────────────────────────────────────────── */

type RoleOverrides = {
  archivedRole?: 'owner' | 'member' | 'viewer'
  activeRole?: 'owner' | 'member' | 'viewer'
}

function renderLivePage(roles: RoleOverrides = {}) {
  const archivedRole = roles.archivedRole ?? 'owner'
  const activeRole = roles.activeRole ?? 'member'

  vi.mocked(meetingsApi.getMeeting).mockResolvedValue(
    makeMeeting(),
  )
  vi.mocked(
    meetingsApi.listMeetingParticipants,
  ).mockResolvedValue([])
  vi.mocked(
    meetingsApi.listMeetingItems,
  ).mockResolvedValue([makeItem()])
  vi.mocked(
    meetingsApi.listMeetingSections,
  ).mockResolvedValue([makeSection()])
  vi.mocked(
    researchGroupsApi.listResearchGroups,
  ).mockResolvedValue([
    { id: 1, name: 'FG', role: 'admin' },
  ])
  vi.mocked(
    researchGroupsApi.listResearchGroupMemberships,
  ).mockResolvedValue([])
  vi.mocked(
    projectsApi.listResearchGroupMembers,
  ).mockResolvedValue([])
  vi.mocked(authApi.me).mockResolvedValue({
    id: 1,
    username: 'alex',
    firstName: 'Alex',
    lastName: 'Dev',
    email: 'alex@example.com',
  })

  const projectFor = (projectId: number): ApiProject =>
    projectId === ARCHIVED_PROJECT_ID
      ? makeArchivedProject(
          archivedRole as 'owner' | 'member' | 'viewer',
        )
      : makeActiveProject(
          activeRole as 'owner' | 'member' | 'viewer',
        )

  vi.mocked(projectsApi.getProject).mockImplementation(
    (projectId: number) =>
      Promise.resolve(projectFor(projectId)),
  )
  vi.mocked(
    projectsApi.getProjectWorkItemConfiguration,
  ).mockImplementation(
    (projectId: number) =>
      Promise.resolve(
        projectId === ARCHIVED_PROJECT_ID
          ? makeConfiguration()
          : makeConfiguration(),
      ),
  )
  vi.mocked(
    projectsApi.listProjectMemberships,
  ).mockImplementation(
    (projectId: number) => {
      const role = projectFor(projectId).currentUserRole
      // The Inspector receives only owner/member memberships as
      // assignee candidates; a viewer's own project has no
      // owner/member candidates in this fixture.
      if (role === 'viewer') {
        return Promise.resolve([])
      }

      return Promise.resolve([
        makeMembership(
          role === 'owner' ? 'owner' : 'member',
        ),
      ])
    },
  )
  vi.mocked(
    workItemsApi.listProjectWorkItems,
  ).mockResolvedValue([])
  vi.mocked(
    workItemsApi.listWorkItemComments,
  ).mockResolvedValue([])
  vi.mocked(
    workItemsApi.listWorkItemHistory,
  ).mockResolvedValue([])
  vi.mocked(workItemsApi.getWorkItem).mockImplementation(
    (id: number) =>
      Promise.resolve(
        id === WORK_ITEM_B_ID
          ? makeWorkItem({
              id: WORK_ITEM_B_ID,
              projectId: ACTIVE_PROJECT_ID,
              title: LINKED_B.title,
              description: 'Reserve the shared lab room.',
            })
          : makeWorkItem(),
      ),
  )

  return render(
    <MemoryRouter
      initialEntries={[`/meetings/${MEETING_ID}`]}
    >
      <Routes>
        <Route
          path="/meetings/:meetingId"
          element={
            <SessionProvider>
              <ResearchGroupProvider>
                <MeetingDetailPage />
              </ResearchGroupProvider>
            </SessionProvider>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

const linkedButton = (title: string) =>
  screen.getByRole('button', {
    name: `Open linked work item: ${title}`,
  })

const inspectorRegion = () =>
  screen.getByRole('region', { name: 'Work item' })

const waitForLive = async () => {
  await waitFor(() => {
    expect(
      screen.getByRole('button', { name: 'End meeting' }),
    ).toBeTruthy()
  })
}

const openInspectorFor = async (title: string) => {
  fireEvent.click(linkedButton(title))
  await waitFor(() => {
    expect(inspectorRegion()).toBeTruthy()
    // Wait until the per-item load finished and the item's own
    // title is shown inside the inspector (not the loading
    // placeholder).
    expect(
      within(inspectorRegion()).getByText(title),
    ).toBeTruthy()
  })
}

const READ_ONLY_BANNER = 'This work item is read-only.'

afterEach(() => {
  cleanup()
  vi.mocked(workItemsApi.updateWorkItem).mockReset()
  vi.mocked(workItemsApi.createWorkItemComment).mockReset()
})

/* ── Behavioral assertions ───────────────────────────────────── */

describe('Meeting Work Item Inspector archive read-only enforcement', () => {
  it('opens a Work Item from an archived Project in the read-only state, still fully readable', async () => {
    renderLivePage()
    await waitForLive()

    await openInspectorFor(LINKED_A.title)

    // The archive state (not the role — the user is the Project
    // OWNER) puts the shared Inspector in its established
    // read-only state.
    expect(
      within(inspectorRegion()).getByText(READ_ONLY_BANNER),
    ).toBeVisible()

    // The Work Item remains visible and readable: title,
    // description, Project context, and assignee all render.
    expect(
      within(
        inspectorRegion(),
      ).getByText(LINKED_A.title),
    ).toBeVisible()
    expect(
      within(
        inspectorRegion(),
      ).getByText('Compare vendor quotes.'),
    ).toBeVisible()
    expect(
      within(inspectorRegion()).getByText('Lab Ops'),
    ).toBeVisible()
    expect(
      within(inspectorRegion()).getByText('Alex Dev'),
    ).toBeVisible()
  })

  it('disables or hides every archive-restricted editing control', async () => {
    renderLivePage()
    await waitForLive()

    await openInspectorFor(LINKED_A.title)
    const region = inspectorRegion()

    // Title and Description are plain text, not edit targets.
    expect(
      within(region).queryByRole('button', {
        name: LINKED_A.title,
      }),
    ).toBeNull()

    // Every canonical mutation control is disabled.
    expect(
      within(region).getByRole('combobox', {
        name: 'Type',
      }),
    ).toBeDisabled()
    expect(
      within(region).getByRole('combobox', {
        name: 'Status',
      }),
    ).toBeDisabled()
    expect(
      within(region).getByRole('combobox', {
        name: 'Parent',
      }),
    ).toBeDisabled()
    expect(
      within(region).getByLabelText('Due date'),
    ).toBeDisabled()
    expect(
      within(region).getByRole('switch', {
        name: 'Blocked',
      }),
    ).toBeDisabled()

    // Assignee editing is unavailable.
    expect(
      within(region).queryByRole('button', {
        name: 'Add assignee',
      }),
    ).toBeNull()
    expect(
      within(region).queryByRole('button', {
        name: 'Remove Alex Dev',
      }),
    ).toBeNull()

    // The comment composer is not rendered in the read-only
    // Inspector state.
    expect(
      within(region).queryByText('Add a comment…'),
    ).toBeNull()

    // Deletion is not exposed from the Meeting Inspector (the
    // Meeting integration never passes the delete affordance).
    expect(
      within(region).queryByRole('button', {
        name: 'Work item actions',
      }),
    ).toBeNull()
  })

  it('generates no mutation request for attempted interactions', async () => {
    renderLivePage()
    await waitForLive()

    await openInspectorFor(LINKED_A.title)
    const region = inspectorRegion()

    // Attempt a title edit: the read-only Inspector must
    // refuse to enter edit mode — no edit surface appears.
    fireEvent.click(
      within(region).getByText(LINKED_A.title),
    )
    expect(
      within(region).queryByLabelText(
        'Work item title',
      ),
    ).not.toBeInTheDocument()

    // Attempt a Description edit: the same read-only
    // contract — no Markdown editor surface appears.
    fireEvent.click(
      within(region).getByText('Compare vendor quotes.'),
    )
    expect(
      within(region).queryByLabelText(
        'Work item description',
      ),
    ).not.toBeInTheDocument()

    // The disabled mutation controls (Status, Type, Parent,
    // Due date, Assignees, Blocked) cannot be activated by a
    // user, so no user interaction can reach the PATCH queue —
    // the flush below lets any (impossible) queued mutation
    // settle before the no-request assertion.
    await new Promise((resolve) =>
      setTimeout(resolve, 0),
    )
    await new Promise((resolve) =>
      setTimeout(resolve, 0),
    )
    expect(
      vi.mocked(workItemsApi.updateWorkItem),
    ).not.toHaveBeenCalled()
    expect(
      vi.mocked(
        workItemsApi.createWorkItemComment,
      ),
    ).not.toHaveBeenCalled()

    // No save feedback and no error surface for the
    // refused interactions.
    expect(
      within(region).queryByText('Saving…'),
    ).not.toBeInTheDocument()
    expect(
      within(region).queryByRole('alert'),
    ).not.toBeInTheDocument()
  })

  it('keeps a Work Item from an active Project editable', async () => {
    renderLivePage()
    await waitForLive()

    await openInspectorFor(LINKED_B.title)
    const region = inspectorRegion()

    // No read-only banner; every control keeps its established
    // editable behavior.
    expect(
      within(region).queryByText(READ_ONLY_BANNER),
    ).toBeNull()
    expect(
      within(region).getByRole('button', {
        name: LINKED_B.title,
      }),
    ).toBeVisible()
    expect(
      within(region).getByRole('combobox', {
        name: 'Type',
      }),
    ).toBeEnabled()
    expect(
      within(region).getByRole('combobox', {
        name: 'Status',
      }),
    ).toBeEnabled()
    expect(
      within(region).getByRole('combobox', {
        name: 'Parent',
      }),
    ).toBeEnabled()
    expect(
      within(region).getByLabelText('Due date'),
    ).toBeEnabled()
    expect(
      within(region).getByRole('button', {
        name: 'Add assignee',
      }),
    ).toBeVisible()
    expect(
      within(region).getByText('Add a comment…'),
    ).toBeVisible()
  })

  it('keeps the viewer read-only on an active Project while Meeting interactions stay available', async () => {
    renderLivePage({ activeRole: 'viewer' })
    await waitForLive()

    await openInspectorFor(LINKED_B.title)
    const region = inspectorRegion()

    // The EXISTING viewer rule is unchanged on an active Project.
    expect(
      within(region).getByText(READ_ONLY_BANNER),
    ).toBeVisible()
    expect(
      within(region).queryByRole('button', {
        name: LINKED_B.title,
      }),
    ).toBeNull()
    expect(
      within(region).queryByRole('button', {
        name: 'Add assignee',
      }),
    ).toBeNull()

    // The Project role never bleeds into the Meeting itself: the
    // user is the Meeting creator and keeps the Live controls.
    expect(
      screen.getByRole('button', { name: 'End meeting' }),
    ).toBeVisible()
  })

  it('applies and clears the archive state when moving between items', async () => {
    renderLivePage()
    await waitForLive()

    // Archived first: read-only state.
    await openInspectorFor(LINKED_A.title)
    expect(
      within(inspectorRegion()).getByText(
        READ_ONLY_BANNER,
      ),
    ).toBeVisible()
    expect(
      within(
        inspectorRegion(),
      ).getByRole('combobox', { name: 'Status' }),
    ).toBeDisabled()

    // Switch to the active-Project item: the stale read-only
    // state must NOT carry over.
    fireEvent.click(linkedButton(LINKED_B.title))
    await waitFor(() => {
      expect(
        within(
          inspectorRegion(),
        ).queryByText(READ_ONLY_BANNER),
      ).toBeNull()
      expect(
        within(inspectorRegion()).getByRole('button', {
          name: LINKED_B.title,
        }),
      ).toBeTruthy()
    })
    expect(
      within(
        inspectorRegion(),
      ).getByRole('combobox', { name: 'Status' }),
    ).toBeEnabled()

    // And back to the archived item: the archive state is
    // re-applied, not left behind.
    fireEvent.click(linkedButton(LINKED_A.title))
    await waitFor(() => {
      expect(
        within(
          inspectorRegion(),
        ).getByText(READ_ONLY_BANNER),
      ).toBeTruthy()
    })
    expect(
      within(
        inspectorRegion(),
      ).getByRole('combobox', { name: 'Status' }),
    ).toBeDisabled()
  })
})
