// @vitest-environment happy-dom
//
// Rendered behavioral tests for the Meeting page's parent-level
// Work Item PATCH response reconciliation: a delayed Work Item
// PATCH response from the Meeting Inspector must NEVER replace
// the data displayed for a different or more recently opened
// Work Item.
//
// Root cause this spec pins: MeetingDetailPage.handleInspectorPatch
// ran `const updated = await updateWorkItem(...); setInspectorItem(updated)`
// unconditionally. The selection had no generation/identity guard, so
// after the user switched the Inspector to another Work Item (A -> B),
// closed and reopened it, or merely moved on, A's late response was
// written straight into the visible Inspector state — replacing B's
// (or the freshly re-fetched) Work Item with A's payload.
//
// The canonical contract: an asynchronous PATCH response is accepted
// into the visible Inspector state only if it still belongs to the
// current selection and has not been superseded by a newer selection
// generation (open or close). Persistence is unaffected — an
// initiated PATCH is always sent and persisted; only the stale
// DISPLAY reconciliation is dropped. The shared Inspector's PATCH
// queue and save-feedback identity are untouched.
//
// The spec drives the REAL Meeting integration (MeetingDetailPage +
// shared WorkItemDrawer) with a controlled ("gated") PATCH server:
// every in-flight PATCH is held behind a manual gate, so tests
// control the asynchronous settlement precisely — no network
// timing, no arbitrary sleeps.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

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
  ApiUpdateWorkItemInput,
  ApiLinkedWorkItem,
} from '../../api/types'

/* ── Fixtures ────────────────────────────────────────────────── */

const MEETING_ID = 11
const PROJECT_ID = 7
const WORK_ITEM_A_ID = 101
const WORK_ITEM_B_ID = 102

// Status definitions (Project-configured): 11 = Todo, 12 = In progress.
const STATUS_TODO_ID = 11
const STATUS_IN_PROGRESS_ID = 12

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

// The payload a late A-PATCH response would carry: distinguishable
// from BOTH the baseline A and B, so any display of it is unambiguous
// evidence that a stale response was accepted.
const STALE_A_RESPONSE: ApiWorkItem = {
  id: WORK_ITEM_A_ID,
  projectId: PROJECT_ID,
  title: 'Prepare purchase request (updated)',
  description: '',
  typeDefinitionId: 1,
  statusDefinitionId: STATUS_IN_PROGRESS_ID,
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
  updatedAt: '2026-09-01T12:00:00Z',
  createdById: 1,
  meetingOrigin: null,
}

// The title the second queued PATCH (initiated while the SAME A
// selection was still open) requests. Its stale response is
// distinguishable from BOTH the baseline A and STALE_A_RESPONSE,
// so any display of it is unambiguous evidence that a queued
// PATCH's response was accepted under a selection generation
// the PATCH was not initiated in.
const RENAMED_A_TITLE =
  'Prepare purchase request (renamed)'

// The payload PATCH 2's stale response would carry.
const STALE_A_TITLE_RESPONSE: ApiWorkItem = {
  ...makeWorkItemA(),
  title: RENAMED_A_TITLE,
  updatedAt: '2026-09-01T13:00:00Z',
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
    actionPermissions: { canEdit: true, canDelete: true, canCancel: false },
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
        kind: 'task',
        order: 0,
        active: true,
      },
    ],
    statuses: [
      {
        id: STATUS_TODO_ID,
        name: 'Todo',
        category: 'todo',
        order: 0,
        active: true,
        isDefault: true,
      },
      {
        id: STATUS_IN_PROGRESS_ID,
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

// Baseline (pre-PATCH) Work Items as the server would return them
// on a fresh GET — what a reopened Inspector must show after its
// fresh fetch, regardless of any in-flight older response.
function makeWorkItemA(): ApiWorkItem {
  return {
    id: WORK_ITEM_A_ID,
    projectId: PROJECT_ID,
    title: LINKED_A.title,
    description: '',
    typeDefinitionId: 1,
    statusDefinitionId: STATUS_IN_PROGRESS_ID,
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
  }
}

function makeWorkItemB(): ApiWorkItem {
  return {
    ...makeWorkItemA(),
    id: WORK_ITEM_B_ID,
    title: LINKED_B.title,
    statusDefinitionId: STATUS_TODO_ID,
    type: 'task',
    status: 'todo',
    assigneeIds: [],
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

// A-PATCH success payload for the "normal reconciliation" test:
// same item, status moved to Todo (the PATCH that was requested).
const UPDATED_A: ApiWorkItem = {
  ...makeWorkItemA(),
  statusDefinitionId: STATUS_TODO_ID,
  status: 'todo',
  updatedAt: '2026-09-01T12:00:00Z',
}

/* ── Gated PATCH server ──────────────────────────────────────── */
//
// Models the real boundary: the PATCH request is sent (persisted)
// the moment it is initiated; its RESPONSE is held behind a manual
// gate until the test settles it. Every in-flight PATCH is tracked,
// so tests control the asynchronous settlement precisely.

type GatedPatch = {
  workItemId: number
  patch: ApiUpdateWorkItemInput
  resolveWith: (item: ApiWorkItem) => void
  rejectWith: (error: Error) => void
}

const gates: GatedPatch[] = []

beforeEach(() => {
  gates.length = 0
  vi.mocked(workItemsApi.updateWorkItem).mockImplementation(
    (
      workItemId: number,
      patch: ApiUpdateWorkItemInput,
    ) =>
      new Promise<ApiWorkItem>(
        (resolveWith, rejectWith) => {
          gates.push({
            workItemId,
            patch,
            resolveWith,
            rejectWith,
          })
        },
      ),
  )
})

// Settle one gated PATCH (by queue position) and flush the
// microtasks the settlement schedules (parent reconciliation,
// drawer save-feedback).
async function settleGate(
  index: number,
  outcome:
    | { ok: true; item: ApiWorkItem }
    | { ok: false; error: Error },
): Promise<void> {
  const gate = gates[index]
  if (gate == null) {
    throw new Error(`no gated PATCH at position ${index}`)
  }
  await act(async () => {
    if (outcome.ok) {
      gate.resolveWith(outcome.item)
    } else {
      gate.rejectWith(outcome.error)
    }
  })
  await act(async () => {})
}

/* ── Render harness (same integration as the outside-click spec) ── */

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
  // Fresh GETs always answer with the baseline (pre-PATCH)
  // Work Items — exactly what a reopened Inspector fetches.
  vi.mocked(workItemsApi.getWorkItem).mockImplementation(
    (id: number) =>
      Promise.resolve(
        id === WORK_ITEM_B_ID
          ? makeWorkItemB()
          : makeWorkItemA(),
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

const linkedButton = (title: string) =>
  screen.getByRole('button', {
    name: `Open linked work item: ${title}`,
  })

const inspectorRegion = () =>
  screen.getByRole('region', { name: 'Work item' })

const statusSelect = (): HTMLSelectElement =>
  screen.getByLabelText('Status') as HTMLSelectElement

// The displayed Work Item's title (edit mode renders it as a
// button — the same locator the outside-click spec uses).
const displayedTitleButton = (title: string) =>
  screen.getByRole('button', { name: title })

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
    expect(
      displayedTitleButton(
        title,
      ),
    ).toBeTruthy()
  })
}

// Issues one status PATCH through the real Status control. The
// drawer's serialized PATCH queue is chained onto a resolved
// promise, so the initiated PATCH (and thus the API call) settles
// on the next microtask — flush it before asserting.
async function triggerStatusPatch(
  value: string,
): Promise<void> {
  fireEvent.change(statusSelect(), {
    target: { value },
  })
  await act(async () => {})
}

afterEach(() => {
  cleanup()
})

/* ── Behavioral assertions ───────────────────────────────────── */

describe('Meeting Inspector stale PATCH response reconciliation', () => {
  it('keeps the newly opened Work Item displayed when a delayed A-PATCH response arrives after an A -> B switch', async () => {
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
    expect(statusSelect().value).toBe(
      String(STATUS_IN_PROGRESS_ID),
    )

    // Initiate a PATCH for A (12 -> 11) and hold its response.
    await triggerStatusPatch(String(STATUS_TODO_ID))
    expect(
      vi.mocked(workItemsApi.updateWorkItem),
    ).toHaveBeenCalledTimes(1)
    expect(
      vi.mocked(workItemsApi.updateWorkItem),
    ).toHaveBeenCalledWith(WORK_ITEM_A_ID, {
      statusDefinitionId: STATUS_TODO_ID,
    })
    expect(gates).toHaveLength(1)

    // The user switches the Inspector to B while A's
    // response is still in flight. The PATCH itself is
    // unaffected: it was already sent and persists.
    fireEvent.click(linkedButton(LINKED_B.title))
    await waitFor(() => {
      expect(
        displayedTitleButton(LINKED_B.title),
      ).toBeTruthy()
    })

    // A's delayed response finally settles.
    await settleGate(0, {
      ok: true,
      item: STALE_A_RESPONSE,
    })

    // B remains displayed; A's late payload never appears.
    expect(
      displayedTitleButton(LINKED_B.title),
    ).toBeVisible()
    expect(
      screen.queryByRole('button', {
        name: STALE_A_RESPONSE.title,
      }),
    ).toBeNull()
    expect(statusSelect().value).toBe(
      String(STATUS_TODO_ID),
    )
  })

  it('does not let a queued PATCH initiated under a superseded selection adopt the reopened Work Item generation when it finally starts', async () => {
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

    // The module-level updateWorkItem mock accumulates call
    // history across the spec's tests; reset it so the
    // dispatch-order assertions below count exactly this
    // scenario's PATCHes.
    vi.mocked(
      workItemsApi.updateWorkItem,
    ).mockClear()

    // 1. Open A (the initial selection generation).
    await openInspectorFor(LINKED_A.title)
    expect(statusSelect().value).toBe(
      String(STATUS_IN_PROGRESS_ID),
    )

    // 2. Queue two distinct PATCHes for A through the real
    //    Inspector controls.
    //
    // PATCH 1: status 12 -> 11.
    await triggerStatusPatch(String(STATUS_TODO_ID))
    expect(
      vi.mocked(workItemsApi.updateWorkItem),
    ).toHaveBeenCalledTimes(1)

    // PATCH 2: a title edit, enqueued behind PATCH 1 in the
    //    shared Inspector's serialized queue.
    fireEvent.click(
      displayedTitleButton(LINKED_A.title),
    )
    const titleInput = screen.getByLabelText(
      'Work item title',
      { exact: true },
    )
    fireEvent.change(titleInput, {
      target: { value: RENAMED_A_TITLE },
    })
    fireEvent.blur(titleInput)
    await act(async () => {})

    // 3. The second PATCH is waiting: the queue has not
    //    dispatched it while PATCH 1's response is held.
    expect(
      vi.mocked(workItemsApi.updateWorkItem),
    ).toHaveBeenCalledTimes(1)
    expect(gates).toHaveLength(1)

    // 4. Switch A -> B -> A before PATCH 1 completes. Every
    //    selection performs its own authoritative fetch, so
    //    the finally displayed A is the fresh baseline state
    //    of a NEW selection generation.
    fireEvent.click(linkedButton(LINKED_B.title))
    await waitFor(() => {
      expect(
        displayedTitleButton(LINKED_B.title),
      ).toBeTruthy()
    })
    fireEvent.click(linkedButton(LINKED_A.title))
    await waitFor(() => {
      expect(
        displayedTitleButton(LINKED_A.title),
      ).toBeTruthy()
    })
    expect(statusSelect().value).toBe(
      String(STATUS_IN_PROGRESS_ID),
    )

    // 5. Resolve PATCH 1 with a distinguishable stale
    //    response; the queue now releases PATCH 2, which
    //    finally STARTS (its API call is dispatched).
    await settleGate(0, {
      ok: true,
      item: STALE_A_RESPONSE,
    })
    expect(
      vi.mocked(workItemsApi.updateWorkItem),
    ).toHaveBeenCalledTimes(2)
    expect(gates).toHaveLength(2)

    // 6. Resolve PATCH 2 with its own distinguishable
    //    stale response.
    await settleGate(1, {
      ok: true,
      item: STALE_A_TITLE_RESPONSE,
    })

    // 7. Neither stale response overwrites the freshly
    //    displayed A data: the baseline title and status
    //    remain, and no stale payload is rendered.
    expect(
      displayedTitleButton(LINKED_A.title),
    ).toBeVisible()
    expect(
      screen.queryByRole('button', {
        name: STALE_A_RESPONSE.title,
      }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', {
        name: STALE_A_TITLE_RESPONSE.title,
      }),
    ).toBeNull()
    expect(statusSelect().value).toBe(
      String(STATUS_IN_PROGRESS_ID),
    )

    // 8. Both PATCHes were dispatched, in the order they
    //    were initiated — persistence is unaffected by the
    //    display reconciliation.
    expect(
      vi.mocked(workItemsApi.updateWorkItem),
    ).toHaveBeenNthCalledWith(
      1,
      WORK_ITEM_A_ID,
      {
        statusDefinitionId: STATUS_TODO_ID,
      },
    )
    expect(
      vi.mocked(workItemsApi.updateWorkItem),
    ).toHaveBeenNthCalledWith(
      2,
      WORK_ITEM_A_ID,
      {
        title: RENAMED_A_TITLE,
      },
    )
  })

  it('does not let a delayed response overwrite a close/reopened Inspector selection', async () => {
    renderLivePage([makeItem()])
    await waitForLive()

    await openInspectorFor(LINKED_A.title)
    expect(statusSelect().value).toBe(
      String(STATUS_IN_PROGRESS_ID),
    )

    // Initiate a PATCH for A and hold its response.
    await triggerStatusPatch(String(STATUS_TODO_ID))
    expect(gates).toHaveLength(1)

    // Close the Inspector while the PATCH is in flight.
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Close work item',
      }),
    )
    await waitFor(() => {
      expect(
        screen.queryByRole('region', {
          name: 'Work item',
        }),
      ).toBeNull()
    })

    // Reopen A: the Inspector performs a fresh fetch and shows
    // the authoritative baseline state.
    await openInspectorFor(LINKED_A.title)
    expect(statusSelect().value).toBe(
      String(STATUS_IN_PROGRESS_ID),
    )

    // The OLD completion now settles — it belongs to a
    // superseded selection generation.
    await settleGate(0, {
      ok: true,
      item: STALE_A_RESPONSE,
    })

    // The freshly fetched selection state is intact.
    expect(
      displayedTitleButton(LINKED_A.title),
    ).toBeVisible()
    expect(
      screen.queryByRole('button', {
        name: STALE_A_RESPONSE.title,
      }),
    ).toBeNull()
    expect(statusSelect().value).toBe(
      String(STATUS_IN_PROGRESS_ID),
    )
  })

  it('still reconciles a normal PATCH for the currently selected Work Item', async () => {
    renderLivePage([makeItem()])
    await waitForLive()

    await openInspectorFor(LINKED_A.title)

    await triggerStatusPatch(String(STATUS_TODO_ID))
    expect(gates).toHaveLength(1)

    // The response belongs to the still-current selection.
    await settleGate(0, {
      ok: true,
      item: UPDATED_A,
    })

    // The displayed data is reconciled with the authoritative
    // response: the status control now shows the new definition.
    await waitFor(() => {
      expect(statusSelect().value).toBe(
        String(STATUS_TODO_ID),
      )
    })
    expect(
      displayedTitleButton(LINKED_A.title),
    ).toBeVisible()
    // The shared Inspector's own save feedback confirms the
    // settled save.
    await waitFor(() => {
      expect(
        screen.getByText('Saved', { exact: true }),
      ).toBeInTheDocument()
    })
  })

  it('does not replace or corrupt the selected Work Item when a PATCH fails', async () => {
    renderLivePage([makeItem()])
    await waitForLive()

    await openInspectorFor(LINKED_A.title)
    expect(statusSelect().value).toBe(
      String(STATUS_IN_PROGRESS_ID),
    )

    await triggerStatusPatch(String(STATUS_TODO_ID))
    expect(gates).toHaveLength(1)

    // The PATCH is rejected — nothing is persisted, nothing
    // is applied.
    await settleGate(0, {
      ok: false,
      error: new Error('Status definition not found.'),
    })

    // The selected Work Item's displayed state is intact:
    // still the baseline title, still the old status.
    expect(
      displayedTitleButton(LINKED_A.title),
    ).toBeVisible()
    expect(
      screen.queryByRole('button', {
        name: STALE_A_RESPONSE.title,
      }),
    ).toBeNull()
    expect(statusSelect().value).toBe(
      String(STATUS_IN_PROGRESS_ID),
    )
    // The shared Inspector's failure feedback is shown for the
    // item on screen.
    expect(
      screen.getByText('Status definition not found.'),
    ).toBeInTheDocument()
  })
})
