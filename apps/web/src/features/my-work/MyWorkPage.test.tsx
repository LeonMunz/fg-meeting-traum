// @vitest-environment happy-dom

import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from '@testing-library/react'
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { MemoryRouter } from 'react-router'

import { listMyWork, updateWorkItem } from '../../api/work-items'
import {
  getProjectWorkItemConfiguration,
} from '../../api/projects'
import type {
  ApiPersonalWorkItem,
} from '../../api/types'

import { MyWorkPage } from './MyWorkPage'

vi.mock('../../api/work-items', () => ({
  listMyWork: vi.fn(),
  updateWorkItem: vi.fn(),
}))

vi.mock('../../api/projects', () => ({
  getProjectWorkItemConfiguration: vi.fn(),
}))

vi.mock('../research-group/useResearchGroup', () => ({
  useResearchGroup: () => ({ groups: [] }),
}))

const PROJECT_ID = 7
const ITEM_ID = 5
const TASK_TITLE = 'E2E Chris Golden Task'

const STATUS_DEFINITIONS = [
  { id: 10, name: 'Todo', category: 'todo', order: 0, active: true, isDefault: true },
  { id: 11, name: 'In Progress', category: 'in_progress', order: 1, active: true, isDefault: false },
  { id: 12, name: 'Review', category: 'review', order: 2, active: true, isDefault: false },
  { id: 13, name: 'Done', category: 'done', order: 3, active: true, isDefault: false },
]

const CONFIGURATION = {
  types: [{ id: 4, name: 'Task', order: 0, active: true }],
  statuses: STATUS_DEFINITIONS,
  labels: [],
}

function makeItem(
  overrides: Partial<ApiPersonalWorkItem> = {},
): ApiPersonalWorkItem {
  return {
    id: ITEM_ID,
    projectId: PROJECT_ID,
    title: TASK_TITLE,
    description: '',
    typeDefinitionId: 4,
    statusDefinitionId: 10,
    boardPosition: 1,
    labelDefinitionIds: [],
    assigneeIds: [1],
    parentId: null,
    dueDate: null,
    blockedReason: null,
    completedAt: null,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    createdById: 1,
    meetingOrigin: null,
    projectName: 'Golden Project',
    researchGroupId: 1,
    researchGroupName: 'Golden Group',
    ...overrides,
  } as ApiPersonalWorkItem
}

function renderPage() {
  return render(
    <MemoryRouter>
      <MyWorkPage />
    </MemoryRouter>,
  )
}

function statusLabel() {
  return `Status for ${TASK_TITLE}`
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('My Work status synchronization', () => {
  it('reads the status from statusDefinitionId and writes the canonical definition ID (single mutation)', async () => {
    vi.mocked(listMyWork).mockResolvedValue([makeItem()])
    vi.mocked(
      getProjectWorkItemConfiguration,
    ).mockResolvedValue(CONFIGURATION)

    // The backend echoes the WorkItem with the new canonical
    // statusDefinitionId and NO legacy `status` field.
    vi.mocked(updateWorkItem).mockResolvedValue(
      makeItem({ statusDefinitionId: 11 }),
    )

    const { getByLabelText } = renderPage()
    const statusSelect = () =>
      getByLabelText(statusLabel())

    // The control renders the category resolved from the canonical
    // statusDefinitionId (todo), not a legacy fixed-string field.
    await waitFor(() => {
      expect(statusSelect()).toHaveValue('todo')
    })

    expect(
      getProjectWorkItemConfiguration,
    ).toHaveBeenCalledWith(PROJECT_ID)

    await act(async () => {
      fireEvent.change(statusSelect(), {
        target: { value: 'in_progress' },
      })
    })

    // Exactly one canonical mutation, carrying the definition ID.
    // Deep equality proves no legacy `status` field is sent.
    expect(updateWorkItem).toHaveBeenCalledTimes(1)
    expect(updateWorkItem).toHaveBeenCalledWith(ITEM_ID, {
      statusDefinitionId: 11,
    })

    // The control reflects the new status after the mutation.
    await waitFor(() => {
      expect(statusSelect()).toHaveValue('in_progress')
    })

    // No duplicate mutation request was introduced.
    expect(updateWorkItem).toHaveBeenCalledTimes(1)
  })

  it('attempts the mutation exactly once and surfaces an error when the PATCH fails', async () => {
    vi.mocked(listMyWork).mockResolvedValue([makeItem()])
    vi.mocked(
      getProjectWorkItemConfiguration,
    ).mockResolvedValue(CONFIGURATION)
    vi.mocked(updateWorkItem).mockRejectedValue(
      new Error('boom'),
    )

    const { getByLabelText, getByText } = renderPage()
    const statusSelect = () =>
      getByLabelText(statusLabel())

    await waitFor(() => {
      expect(statusSelect()).toHaveValue('todo')
    })

    await act(async () => {
      fireEvent.change(statusSelect(), {
        target: { value: 'in_progress' },
      })
    })

    // No retry loop: exactly one canonical mutation was attempted,
    // carrying the definition ID (no legacy `status` field).
    expect(updateWorkItem).toHaveBeenCalledTimes(1)
    expect(updateWorkItem).toHaveBeenCalledWith(ITEM_ID, {
      statusDefinitionId: 11,
    })

    // The failure is surfaced to the user.
    await waitFor(() => {
      expect(
        getByText('Work item status could not be updated.'),
      ).toBeInTheDocument()
    })
  })
})
