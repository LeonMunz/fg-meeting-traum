// @vitest-environment happy-dom

// CANONICAL TYPE REGRESSION — Work Item inspector (edit mode).
//
// Root cause this spec pins: the edit inspector depended on the
// legacy fixed-string `item.type` field (no longer emitted by the
// canonical backend Work Item payload, which carries only
// `typeDefinitionId`) and sent `{ type: ... }` for type changes —
// a key the backend PATCH contract ignores (it accepts
// `typeDefinitionId`), so every "saved" type change was a silent
// no-op with a false "Saved" flash.
//
// The canonical contract (docs/domain/foundation.md §3a.1 + §3a.7 +
// §7): the inspector derives the Work Item's actual type from
// `typeDefinitionId`, resolves the display name from the owning
// Project's Work Item configuration, resolves the semantic icon
// from the definition's machine-readable `kind` (never from the
// configurable display name), and mutates exclusively through
// `typeDefinitionId` (active same-Project definitions only).

import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
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

// Project configuration covering every presentation case:
// - id 1: canonical Epic (active)
// - id 2: canonical Task RENAMED to "Experiment step" (kind `task`
//   is preserved; the display name must never drive semantics)
// - id 3: CUSTOM type (kind null) whose display name is exactly the
//   built-in "Task" (must never be attributed the canonical Task kind)
// - id 4: canonical Milestone DEACTIVATED (an existing Work Item may
//   still reference it)
const CONFIGURATION: ApiProjectWorkItemConfiguration = {
  types: [
    { id: 1, name: 'Epic', kind: 'epic', order: 0, active: true },
    {
      id: 2,
      name: 'Experiment step',
      kind: 'task',
      order: 1,
      active: true,
    },
    { id: 3, name: 'Task', kind: null, order: 2, active: true },
    {
      id: 4,
      name: 'Milestone',
      kind: 'milestone',
      order: 3,
      active: false,
    },
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
    typeDefinitionId: 2,
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
  // never affect the type surface under test.
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

// The inspector root (portaled overlay surface).
function inspectorRoot(): HTMLElement {
  const root = document.querySelector(
    '[data-work-item-inspector-boundary="true"]',
  )
  expect(root, 'inspector must be rendered').toBeTruthy()
  return root as HTMLElement
}

// The header type label: the configured name rendered OUTSIDE the
// type <select> (whose <option> children carry the same display
// names). Returns null when the text is not rendered as header
// content.
function headerTypeLabel(text: string): Element | null {
  const matches = inspectorRoot().querySelectorAll('span')
  for (const el of matches) {
    if (
      el.textContent === text &&
      el.closest('select') === null
    ) {
      return el
    }
  }
  return null
}

describe('Work Item inspector — canonical type display', () => {
  it('shows the configured name of a RENAMED canonical Task, keeping its semantic kind', () => {
    render(
      <WorkItemInspector
        {...makeProps(makeItem(), () =>
          Promise.resolve())}
      />,
    )

    const root = inspectorRoot()

    // The display name is the Project-configured name — not the
    // legacy built-in label.
    expect(headerTypeLabel('Experiment step')).not.toBeNull()

    // The semantic icon comes from the definition's KIND (task),
    // not from the display name: a renamed Task keeps the Task glyph.
    expect(
      within(root)
        .getByText('check_box_outline_blank', {
          exact: true,
        }),
    ).toBeVisible()
  })

  it('shows a custom (kind null) type named "Task" WITHOUT presenting it as the canonical Task', () => {
    render(
      <WorkItemInspector
        {...makeProps(
          makeItem({ typeDefinitionId: 3 }),
          () => Promise.resolve(),
        )}
      />,
    )

    const root = inspectorRoot()

    // Its configured name is displayed...
    expect(headerTypeLabel('Task')).not.toBeNull()

    // ...but the semantic icon is the neutral custom-type glyph,
    // never the canonical Task glyph (kind null must stay
    // distinguishable from canonical task).
    expect(
      within(root).getByText('task_alt', {
        exact: true,
      }),
    ).toBeVisible()
    expect(
      within(root).queryByText(
        'check_box_outline_blank',
        { exact: true },
      ),
    ).toBeNull()
  })

  it('reflects the actual typeDefinitionId in the type control', () => {
    render(
      <WorkItemInspector
        {...makeProps(
          makeItem({ typeDefinitionId: 1 }),
          () => Promise.resolve(),
        )}
      />,
    )

    const typeSelect = screen.getByLabelText('Type')

    expect(typeSelect).toHaveValue('1')
    expect(
      (typeSelect as HTMLSelectElement)
        .selectedOptions[0].text,
    ).toBe('Epic')
  })

  it('shows a clearly identifiable unavailable state when the configuration is missing (never invents a Task)', () => {
    render(
      <WorkItemInspector
        {...makeProps(
          makeItem({ typeDefinitionId: 2 }),
          () => Promise.resolve(),
          null,
        )}
      />,
    )

    expect(
      headerTypeLabel('Type unavailable'),
    ).not.toBeNull()

    // The actual configured name must not be fabricated...
    expect(headerTypeLabel('Experiment step')).toBeNull()
    // ...and the legacy built-in label must not be invented.
    expect(headerTypeLabel('Task')).toBeNull()

    const typeSelect =
      screen.getByLabelText('Type') as HTMLSelectElement
    expect(typeSelect).toBeDisabled()
  })

  it('shows the unavailable state for a typeDefinitionId the configuration cannot resolve', () => {
    render(
      <WorkItemInspector
        {...makeProps(
          makeItem({ typeDefinitionId: 999 }),
          () => Promise.resolve(),
        )}
      />,
    )

    expect(
      headerTypeLabel('Type unavailable'),
    ).not.toBeNull()
    expect(headerTypeLabel('Task')).toBeNull()

    const typeSelect =
      screen.getByLabelText('Type') as HTMLSelectElement
    expect(typeSelect).toBeDisabled()
  })
})

describe('Work Item inspector — canonical type mutation', () => {
  it('PATCHes exactly the selected active typeDefinitionId (no legacy type key) when the type changes', async () => {
    const server = makeServer(makeItem())
    render(
      <WorkItemInspector
        {...makeProps(
          server.item,
          server.onPatch,
        )}
      />,
    )

    const typeSelect =
      screen.getByLabelText('Type') as HTMLSelectElement
    expect(typeSelect).toHaveValue('2')

    act(() => {
      typeSelect.value = '1'
      typeSelect.dispatchEvent(
        new Event('change', { bubbles: true }),
      )
    })

    await waitFor(() => {
      expect(server.onPatch).toHaveBeenCalledTimes(1)
    })

    expect(server.patches).toEqual([
      { typeDefinitionId: 1 },
    ])
    expect('type' in server.patches[0]).toBe(false)
    expect('status' in server.patches[0]).toBe(false)
  })

  it('keeps the updated type correct after the authoritative rerender', async () => {
    const server = makeServer(makeItem())
    const { rerender } = render(
      <WorkItemInspector
        {...makeProps(
          server.item,
          server.onPatch,
        )}
      />,
    )

    const typeSelect =
      screen.getByLabelText('Type') as HTMLSelectElement

    act(() => {
      typeSelect.value = '1'
      typeSelect.dispatchEvent(
        new Event('change', { bubbles: true }),
      )
    })

    await waitFor(() => {
      expect(server.onPatch).toHaveBeenCalledTimes(1)
    })

    // The parent reconciles with the authoritative Work Item the
    // PATCH returned — the inspector must re-render from it.
    await flush()
    rerender(
      <WorkItemInspector
        {...makeProps(
          server.item,
          server.onPatch,
        )}
      />,
    )

    expect(headerTypeLabel('Epic')).not.toBeNull()
    expect(typeSelect).toHaveValue('1')
  })

  it('issues no PATCH when the current type is (re)selected', async () => {
    const server = makeServer(makeItem())
    render(
      <WorkItemInspector
        {...makeProps(
          server.item,
          server.onPatch,
        )}
      />,
    )

    const typeSelect =
      screen.getByLabelText('Type') as HTMLSelectElement

    // Same value: React's change semantics + the inspector's own
    // guard must both prevent a redundant PATCH.
    act(() => {
      typeSelect.value = '2'
      typeSelect.dispatchEvent(
        new Event('change', { bubbles: true }),
      )
    })

    await flush()
    expect(server.onPatch).not.toHaveBeenCalled()
  })

  it('keeps a referenced inactive type visible and identifiable, but not selectable as a new target', async () => {
    const server = makeServer(
      makeItem({ typeDefinitionId: 4 }),
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
    // stays displayed as its current type...
    expect(headerTypeLabel('Milestone')).not.toBeNull()

    const typeSelect =
      screen.getByLabelText('Type') as HTMLSelectElement
    expect(typeSelect).toHaveValue('4')

    // ...but it is offered only as a disabled (non-selectable)
    // entry: the selectable targets are exactly the three ACTIVE
    // definitions.
    const options = Array.from(
      typeSelect.options,
    ) as HTMLOptionElement[]
    const selectable = options.filter(
      (option) => !option.disabled,
    )
    expect(
      selectable.map((option) => option.value),
    ).toEqual(['1', '2', '3'])
    expect(
      options.find(
        (option) => option.value === '4',
      ),
    ).toHaveProperty('disabled', true)

    // Switching to an active definition PATCHes its ID.
    act(() => {
      typeSelect.value = '1'
      typeSelect.dispatchEvent(
        new Event('change', { bubbles: true }),
      )
    })

    await waitFor(() => {
      expect(server.onPatch).toHaveBeenCalledTimes(1)
    })
    expect(server.patches).toEqual([
      { typeDefinitionId: 1 },
    ])
  })

  it('does not leave a misleading persisted selection when the PATCH fails', async () => {
    const item = makeItem({ typeDefinitionId: 2 })
    const onPatch = vi.fn(
      async (
        _workItemId: number,
        _patch: ApiUpdateWorkItemInput,
      ): Promise<void> => {
        throw new Error('Type change rejected.')
      },
    )
    const { rerender } = render(
      <WorkItemInspector
        {...makeProps(item, onPatch)}
      />,
    )

    const typeSelect =
      screen.getByLabelText('Type') as HTMLSelectElement

    act(() => {
      typeSelect.value = '1'
      typeSelect.dispatchEvent(
        new Event('change', { bubbles: true }),
      )
    })

    await waitFor(() => {
      expect(
        screen.getByRole('alert', {
          name: 'Type change rejected.',
        }),
      ).toBeInTheDocument()
    })

    // The item was never updated: the control and the header must
    // still reflect the actual (server) type, and no "Saved".
    expect(typeSelect).toHaveValue('2')
    expect(
      (typeSelect as HTMLSelectElement)
        .selectedOptions[0].text,
    ).toBe('Experiment step')
    expect(headerTypeLabel('Experiment step')).not.toBeNull()
    expect(headerTypeLabel('Epic')).toBeNull()
    expect(
      screen.queryByText('Saved', { exact: true }),
    ).toBeNull()
    expect(screen.queryByText('Saving…')).toBeNull()

    // A retry after the item is (re)rendered from the server state
    // starts from the actual type again.
    rerender(
      <WorkItemInspector
        {...makeProps(item, onPatch)}
      />,
    )
    expect(typeSelect).toHaveValue('2')
  })
})
