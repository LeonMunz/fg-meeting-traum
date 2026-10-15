// @vitest-environment happy-dom

// CANONICAL STATUS REGRESSION — Work Item inspector (edit mode).
//
// Root cause this spec pins: the edit inspector converted the
// selected status option back to its semantic CATEGORY
// (`option.category`), no-opped against the legacy fixed-string
// `item.status` field, and resolved the PATCH target through
// `resolveStatusDefinitionIdByCategory` — which returns the FIRST
// active definition of that category. With two definitions sharing
// a category (e.g. two `in_progress` statuses), selecting the
// second one silently PATCHed the first definition's ID, losing
// the identity of the selected status.
//
// The canonical contract (docs/domain/foundation.md §3a.2 + §6.2 +
// §7 + Board ↔ Editor invariant): the inspector resolves the
// Work Item's actual status from the canonical `statusDefinitionId`
// (ID lookup only — never display names or semantic categories),
// offers the Project's ACTIVE StatusDefinitions as selectable
// targets in configured order (option values are concrete
// definition IDs), and mutates exclusively through
// `statusDefinitionId`.

import {
  act,
  cleanup,
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

import type {
  ApiProjectWorkItemConfiguration,
  ApiUpdateWorkItemInput,
  ApiWorkItem,
} from '../../api/types'

import { WorkItemInspector } from './WorkItemDrawer'

// Project configuration with TWO ACTIVE statuses sharing the
// `in_progress` category (ids 11 and 12) — the exact shape that
// the category-based resolution collapsed into one option — plus
// a referenced-able inactive `review` status (id 15).
const CONFIGURATION: ApiProjectWorkItemConfiguration = {
  types: [
    { id: 1, name: 'Task', kind: 'task', order: 0, active: true },
  ],
  statuses: [
    {
      id: 10,
      name: 'Todo',
      category: 'todo',
      order: 0,
      active: true,
      isDefault: true,
    },
    {
      id: 11,
      name: 'In Progress',
      category: 'in_progress',
      order: 1,
      active: true,
      isDefault: false,
    },
    {
      id: 12,
      name: 'Stalled',
      category: 'in_progress',
      order: 2,
      active: true,
      isDefault: false,
    },
    {
      id: 13,
      name: 'Review',
      category: 'review',
      order: 3,
      active: true,
      isDefault: false,
    },
    {
      id: 14,
      name: 'Done',
      category: 'done',
      order: 4,
      active: true,
      isDefault: false,
    },
    {
      id: 15,
      name: 'Archived review',
      category: 'review',
      order: 5,
      active: false,
      isDefault: false,
    },
  ],
  labels: [],
}

// The canonical backend payload: definition IDs, NO legacy
// `type` / `status` strings.
function makeItem(
  overrides: Partial<ApiWorkItem> = {},
): ApiWorkItem {
  return {
    id: 42,
    projectId: 7,
    title: 'Ship the report',
    description: '',
    assigneeIds: [],
    parentId: null,
    dueDate: null,
    blockedReason: null,
    completedAt: null,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    boardPosition: 1,
    labelDefinitionIds: [],
    typeDefinitionId: 1,
    statusDefinitionId: 10,
    createdById: 1,
    ...overrides,
  } as ApiWorkItem
}

function makeServer(
  item: ApiWorkItem,
) {
  let serverItem: ApiWorkItem = item
  const patches: ApiUpdateWorkItemInput[] = []
  const onPatch = vi.fn(async (
    _workItemId: number,
    patch: ApiUpdateWorkItemInput,
  ): Promise<void> => {
    patches.push(patch)
    serverItem = { ...serverItem, ...patch } as ApiWorkItem
  })

  return {
    get item() {
      return serverItem
    },
    patches,
    onPatch,
  }
}

function makeProps(
  item: ApiWorkItem,
  onPatch: (
    workItemId: number,
    patch: ApiUpdateWorkItemInput,
  ) => Promise<void>,
  workItemConfiguration:
    | ApiProjectWorkItemConfiguration
    | null = CONFIGURATION,
) {
  return {
    projectName: 'Infrastructure',
    item,
    readOnly: false,
    currentUserId: 1,
    workItemConfiguration,
    assignees: [],
    parentItems: [],
    onClose: () => {},
    onPatch,
  }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  // No network in unit tests: the inspector's History/Comments
  // fetches are the only network callers; they fail closed and
  // never affect the status surface under test.
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (async () => {
      throw new Error('no network in unit test')
    }) as typeof fetch,
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function statusSelect(): HTMLSelectElement {
  return screen.getByLabelText(
    'Status',
  ) as HTMLSelectElement
}

function optionStates(
  select: HTMLSelectElement,
): Array<{
  value: string
  text: string
  disabled: boolean
}> {
  return Array.from(
    select.options,
  ).map((option) => ({
    value: option.value,
    text: option.text,
    disabled: option.disabled,
  }))
}

describe('Work Item inspector — canonical status display', () => {
  it('reflects the actual statusDefinitionId in the status control', () => {
    render(
      <WorkItemInspector
        {...makeProps(
          makeItem({ statusDefinitionId: 12 }),
          () => Promise.resolve(),
        )}
      />,
    )

    const select = statusSelect()

    // The SELECTED option is the second in_progress definition
    // ("Stalled") — not the first ("In Progress"), which is what
    // the old category-based resolution always returned.
    expect(select).toHaveValue('12')
    expect(select.selectedOptions[0].text).toBe(
      'Stalled',
    )
  })

  it('offers the ACTIVE StatusDefinitions in configured order with definition-ID values', () => {
    render(
      <WorkItemInspector
        {...makeProps(
          makeItem(),
          () => Promise.resolve(),
        )}
      />,
    )

    const states = optionStates(
      statusSelect(),
    )

    // The inactive definition (15) is absent when it is not the
    // item's current status...
    expect(
      states.find((option) => option.value === '15'),
    ).toBeUndefined()

    // ...and the options are exactly the five ACTIVE definitions,
    // in configured order, valued by definition ID.
    expect(states).toEqual([
      { value: '10', text: 'Todo', disabled: false },
      { value: '11', text: 'In Progress', disabled: false },
      { value: '12', text: 'Stalled', disabled: false },
      { value: '13', text: 'Review', disabled: false },
      { value: '14', text: 'Done', disabled: false },
    ])
  })

  it('shows a clearly identifiable unavailable state when the configuration is missing (never fabricates a status)', () => {
    render(
      <WorkItemInspector
        {...makeProps(
          makeItem(),
          () => Promise.resolve(),
          null,
        )}
      />,
    )

    const select = statusSelect()

    // Nothing is fabricated: the control shows the explicit
    // unavailable placeholder and is disabled...
    expect(select).toBeDisabled()
    expect(select).toHaveValue('')
    expect(optionStates(select)).toEqual([
      {
        value: '',
        text: 'Status unavailable',
        disabled: true,
      },
    ])

    // ...and no configured status name leaks into the control.
    expect(
      screen.queryByText('In Progress'),
    ).toBeNull()
  })

  it('shows the unavailable state for a statusDefinitionId the configuration cannot resolve', () => {
    render(
      <WorkItemInspector
        {...makeProps(
          makeItem({ statusDefinitionId: 999 }),
          () => Promise.resolve(),
        )}
      />,
    )

    const select = statusSelect()

    // An unresolvable ID must NOT fall back to the first active
    // definition of some category (e.g. "Todo", id 10) — it must
    // surface as unavailable.
    expect(select).toBeDisabled()
    expect(select).toHaveValue('')
    expect(optionStates(select)).toEqual([
      {
        value: '',
        text: 'Status unavailable',
        disabled: true,
      },
    ])
  })
})

describe('Work Item inspector — canonical status mutation', () => {
  it('keeps two same-category statuses independently selectable and PATCHes the exact selected definition ID', async () => {
    // The item starts on the FIRST in_progress definition.
    const server = makeServer(
      makeItem({ statusDefinitionId: 11 }),
    )
    const { rerender } = render(
      <WorkItemInspector
        {...makeProps(
          server.item,
          server.onPatch,
        )}
      />,
    )

    const select = statusSelect()
    expect(select).toHaveValue('11')

    // Switch to the SECOND in_progress definition (same
    // category!): the canonical PATCH carries its EXACT ID —
    // the category-based code would have re-PATCHed id 11 here.
    act(() => {
      select.value = '12'
      select.dispatchEvent(
        new Event('change', { bubbles: true }),
      )
    })

    await waitFor(() => {
      expect(server.onPatch).toHaveBeenCalledTimes(1)
    })

    expect(server.patches).toEqual([
      { statusDefinitionId: 12 },
    ])
    expect('status' in server.patches[0]).toBe(false)

    // The parent reconciles with the authoritative Work Item;
    // switching BACK to the first definition issues its exact ID
    // too (bidirectional within one category).
    rerender(
      <WorkItemInspector
        {...makeProps(
          server.item,
          server.onPatch,
        )}
      />,
    )
    expect(select).toHaveValue('12')

    act(() => {
      select.value = '11'
      select.dispatchEvent(
        new Event('change', { bubbles: true }),
      )
    })

    await waitFor(() => {
      expect(server.onPatch).toHaveBeenCalledTimes(2)
    })
    expect(server.patches).toEqual([
      { statusDefinitionId: 12 },
      { statusDefinitionId: 11 },
    ])
  })

  it('issues no PATCH when the current statusDefinitionId is (re)selected', async () => {
    const server = makeServer(
      makeItem({ statusDefinitionId: 12 }),
    )
    render(
      <WorkItemInspector
        {...makeProps(
          server.item,
          server.onPatch,
        )}
      />,
    )

    const select = statusSelect()

    // Same concrete ID: React's change semantics + the
    // inspector's own ID-level guard must both prevent a
    // redundant PATCH.
    act(() => {
      select.value = '12'
      select.dispatchEvent(
        new Event('change', { bubbles: true }),
      )
    })

    await flush()
    expect(server.onPatch).not.toHaveBeenCalled()
  })

  it('keeps a referenced inactive status identifiable, but not selectable as a new target', async () => {
    const server = makeServer(
      makeItem({ statusDefinitionId: 15 }),
    )
    render(
      <WorkItemInspector
        {...makeProps(
          server.item,
          server.onPatch,
        )}
      />,
    )

    // The inactive definition the Work Item actually references
    // stays displayed as its current status...
    const select = statusSelect()
    expect(select).toHaveValue('15')
    expect(select.selectedOptions[0].text).toBe(
      'Archived review',
    )

    // ...but it is offered only as a disabled (non-selectable)
    // entry: the selectable targets are exactly the five ACTIVE
    // definitions.
    const states = optionStates(select)
    expect(
      states
        .filter((option) => !option.disabled)
        .map((option) => option.value),
    ).toEqual(['10', '11', '12', '13', '14'])
    expect(
      states.find((option) => option.value === '15'),
    ).toEqual({
      value: '15',
      text: 'Archived review',
      disabled: true,
    })

    // Switching to an active definition PATCHes its exact ID.
    act(() => {
      select.value = '13'
      select.dispatchEvent(
        new Event('change', { bubbles: true }),
      )
    })

    await waitFor(() => {
      expect(server.onPatch).toHaveBeenCalledTimes(1)
    })
    expect(server.patches).toEqual([
      { statusDefinitionId: 13 },
    ])
  })

  it('does not leave a misleading persisted selection when the PATCH fails', async () => {
    const item = makeItem({ statusDefinitionId: 11 })
    const onPatch = vi.fn(
      async (
        _workItemId: number,
        _patch: ApiUpdateWorkItemInput,
      ): Promise<void> => {
        throw new Error('Status change rejected.')
      },
    )
    const { rerender } = render(
      <WorkItemInspector
        {...makeProps(item, onPatch)}
      />,
    )

    const select = statusSelect()

    act(() => {
      select.value = '12'
      select.dispatchEvent(
        new Event('change', { bubbles: true }),
      )
    })

    await waitFor(() => {
      expect(
        screen.getByRole('alert', {
          name: 'Status change rejected.',
        }),
      ).toBeInTheDocument()
    })

    // The item was never updated: the control must still reflect
    // the actual (server) status, and no "Saved".
    expect(select).toHaveValue('11')
    expect(select.selectedOptions[0].text).toBe(
      'In Progress',
    )
    expect(
      screen.queryByText('Saved', { exact: true }),
    ).toBeNull()
    expect(screen.queryByText('Saving…')).toBeNull()

    // A retry after the item is (re)rendered from the server
    // state starts from the actual status again.
    rerender(
      <WorkItemInspector
        {...makeProps(item, onPatch)}
      />,
    )
    expect(select).toHaveValue('11')
  })
})
