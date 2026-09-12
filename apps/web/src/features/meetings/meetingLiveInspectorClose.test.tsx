// @vitest-environment happy-dom
//
// Rendered behavioral tests for the Meeting Live linked Work Item
// inspector outside-click contract: the shared Work Item inspector
// opened from a Live Meeting closes when the user clicks a genuine
// Meeting surface — mirroring the established Project view
// contextual-selection behavior — while clicks inside the inspector
// and clicks on (another) linked Work Item never close it.
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
  const actual = await importOriginal<typeof researchGroupsApi>()
  return {
    ...actual,
    listResearchGroups: vi.fn(),
    listResearchGroupMemberships: vi.fn(),
  }
})

vi.mock('../../api/work-items', async (importOriginal) => {
  const actual = await importOriginal<typeof workItemsApi>()
  return {
    ...actual,
    getWorkItem: vi.fn(),
    listProjectWorkItems: vi.fn(),
    listWorkItemComments: vi.fn(),
    listWorkItemHistory: vi.fn(),
    updateWorkItem: vi.fn(),
  }
})

import type {
  ApiMeeting,
  ApiMeetingItem,
  ApiMeetingNote,
  ApiMeetingSection,
  ApiProject,
  ApiProjectWorkItemConfiguration,
  ApiProjectMembership,
  ApiWorkItem,
  ApiLinkedWorkItem,
} from '../../api/types'

/* ── Fixtures ────────────────────────────────────────────────── */

const MEETING_ID = 11
const PROJECT_ID = 7
const WORK_ITEM_A_ID = 101
const WORK_ITEM_B_ID = 102

const LINKED_A: ApiLinkedWorkItem = {
  id: WORK_ITEM_A_ID,
  title: 'Prepare purchase request',
  projectId: PROJECT_ID,
  projectName: 'Lab Ops',
  statusName: 'In progress',
  assigneeNames: ['Alex Dev'],
}

const LINKED_B: ApiLinkedWorkItem = {
  id: WORK_ITEM_B_ID,
  title: 'Book lab room',
  projectId: PROJECT_ID,
  projectName: 'Lab Ops',
  statusName: 'Todo',
  assigneeNames: [],
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
    position: 0,
    outcome: 'not_discussed',
    followUpSchedule: null,
    workItemIds: [],
    notes: [makeNote({ linkedWorkItem: LINKED_A })],
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
    createdById: 1,
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-01T09:01:00Z',
  }
}

function makeProject(): ApiProject {
  return {
    id: PROJECT_ID,
    researchGroupId: 1,
    name: 'Lab Ops',
    description: '',
    status: 'active',
    archivedAt: null,
    currentUserRole: 'member',
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
    projectId: PROJECT_ID,
    title: LINKED_A.title,
    description: '',
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

function makeMembership(): ApiProjectMembership {
  return {
    id: 1,
    role: 'member',
    addedAt: null,
    user: {
      id: 1,
      username: 'alex',
      firstName: 'Alex',
      lastName: 'Dev',
    },
  }
}

function renderLivePage(
  items: ApiMeetingItem[],
) {
  vi.mocked(meetingsApi.getMeeting).mockResolvedValue(
    makeMeeting(),
  )
  vi.mocked(meetingsApi.listMeetingParticipants).mockResolvedValue([])
  vi.mocked(
    meetingsApi.listMeetingItems,
  ).mockResolvedValue(items)
  vi.mocked(
    meetingsApi.listMeetingSections,
  ).mockResolvedValue([makeSection()])
  vi.mocked(
    researchGroupsApi.listResearchGroups,
  ).mockResolvedValue([{ id: 1, name: 'FG', role: 'admin' }])
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

  vi.mocked(projectsApi.getProject).mockResolvedValue(
    makeProject(),
  )
  vi.mocked(
    projectsApi.getProjectWorkItemConfiguration,
  ).mockResolvedValue(makeConfiguration())
  vi.mocked(
    projectsApi.listProjectMemberships,
  ).mockResolvedValue([makeMembership()])
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
        makeWorkItem(
          id === WORK_ITEM_B_ID
            ? {
                id: WORK_ITEM_B_ID,
                title: LINKED_B.title,
                statusDefinitionId: 11,
                type: 'task',
                status: 'todo',
              }
            : undefined,
        ),
      ),
  )

  return render(
    <MemoryRouter initialEntries={[`/meetings/${MEETING_ID}`]}>
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

const liveWorkspace = () =>
  screen.getByRole('main', { name: 'Agenda item' })

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

const openInspectorFor = async (
  title: string,
) => {
  fireEvent.click(linkedButton(title))
  await waitFor(() => {
    expect(inspectorRegion()).toBeTruthy()
  })
}

afterEach(() => {
  cleanup()
})

/* ── Behavioral assertions ───────────────────────────────────── */

describe('Live Meeting linked Work Item inspector outside-click close', () => {

  it('opens the shared Inspector from a linked Work Item in a Live Meeting', async () => {
    renderLivePage([makeItem()])
    await waitForLive()

    await openInspectorFor(LINKED_A.title)

    // The shared inspector rendered in place — no navigation.
    expect(inspectorRegion()).toBeVisible()
    expect(
      screen.getByRole('heading', {
        name: 'Work item',
      }),
    ).toBeVisible()

    // Opening never changed the Meeting's current pointer or any
    // agenda outcome, and never triggered a domain mutation.
    expect(
      vi.mocked(meetingsApi.focusMeetingItem),
    ).not.toHaveBeenCalled()
    expect(
      vi.mocked(meetingsApi.markMeetingItemDone),
    ).not.toHaveBeenCalled()
  })

  it('closes the Inspector when a genuine Meeting Live surface is clicked', async () => {
    renderLivePage([makeItem()])
    await waitForLive()

    await openInspectorFor(LINKED_A.title)

    // The current item's title heading (in the Live workspace)
    // is a genuine outside surface.
    const outside = screen.getByRole('heading', {
      name: 'Budget review',
    })
    fireEvent.click(outside)

    await waitFor(() => {
      expect(
        screen.queryByRole('region', { name: 'Work item' }),
      ).toBeNull()
    })

    // The Meeting itself is untouched by the dismissal.
    expect(liveWorkspace()).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'End meeting' }),
    ).toBeTruthy()
  })

  it('keeps the Inspector open for clicks inside it', async () => {
    renderLivePage([makeItem()])
    await waitForLive()

    await openInspectorFor(LINKED_A.title)

    // The "Work item" heading is INSIDE the inspector's
    // boundary subtree — clicking it must not close.
    fireEvent.click(
      screen.getByRole('heading', {
        name: 'Work item',
      }),
    )

    expect(inspectorRegion()).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Close work item' }),
    ).toBeVisible()
  })

  it('switches the Inspector to another linked Work Item instead of closing', async () => {
    const items = [
      makeItem({
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
      }),
    ]
    renderLivePage(items)
    await waitForLive()

    await openInspectorFor(LINKED_A.title)
    expect(
      screen.getByRole('button', {
        name: LINKED_A.title,
      }),
    ).toBeVisible()

    // The second linked Work Item is a Work Item target, not an
    // outside surface: the inspector swaps in place to it.
    fireEvent.click(linkedButton(LINKED_B.title))

    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: LINKED_B.title,
        }),
      ).toBeVisible()
    })
    expect(inspectorRegion()).toBeVisible()

    // The previously open item is no longer displayed.
    expect(
      screen.queryByRole('button', {
        name: LINKED_A.title,
      }),
    ).toBeNull()
  })
})
