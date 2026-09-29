// @vitest-environment happy-dom

// Picker interaction + create-default contract for the canonical
// WorkItemDrawer (create AND edit modes):
//
//   Assignee picker
//   - inside interactions (selecting / unselecting rows, typing in
//     the search input) keep the picker open — multi-select stays
//     efficient;
//   - any pointer press OUTSIDE the trigger + popover region (title,
//     Description, Due date, Type, other properties, blank drawer
//     space) dismisses it, without closing the drawer itself;
//   - the trigger keeps toggling, and Escape dismisses the picker
//     first;
//   - every dismissal (outside press, trigger, Escape) clears the
//     search query so the next open starts clean;
//   - the document outside-click listener is attached only while the
//     picker is open and removed on close and on unmount (no global
//     listener leak).
//
//   Due date
//   - clicking ANYWHERE on the enabled Due date field opens the
//     native browser date picker via `showPicker()` from the user
//     gesture;
//   - a missing `showPicker` is a graceful no-op (never throws);
//   - disabled / read-only fields never attempt to open the picker;
//   - date changes persist exactly as before.
//
//   Create default type
//   - the ACTIVE canonical Task TypeDefinition is seeded by its
//     machine-readable `kind === 'task'` — never by the display
//     `name`, never by position, with no fallback to another type
//     (renamed canonical Tasks still win; a custom type named "Task"
//     with `kind = null` never does);
//   - without an active canonical Task the type stays unselected and
//     create validation blocks submission;
//   - every fresh drawer session re-seeds Task, and a manually
//     chosen type is never clobbered.

import {
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

import type {
  ApiProjectWorkItemConfiguration,
  ApiUpdateWorkItemInput,
  ApiWorkItem,
  ApiWorkItemTypeDefinition,
} from '../../api/types'

import {
  WorkItemDrawer,
  WorkItemInspector,
} from './WorkItemDrawer'

const DEFAULT_STATUSES: ApiProjectWorkItemConfiguration['statuses'] = [
  {
    id: 10,
    name: 'To do',
    category: 'todo',
    order: 0,
    active: true,
    isDefault: true,
  },
  {
    id: 11,
    name: 'In progress',
    category: 'in_progress',
    order: 1,
    active: true,
    isDefault: false,
  },
]

function makeConfiguration(
  types: ApiWorkItemTypeDefinition[],
): ApiProjectWorkItemConfiguration {
  return {
    types,
    statuses: DEFAULT_STATUSES,
    labels: [],
  }
}

const CANONICAL_TYPES: ApiWorkItemTypeDefinition[] = [
  { id: 1, name: 'Epic', kind: 'epic', order: 0, active: true },
  {
    id: 2,
    name: 'Milestone',
    kind: 'milestone',
    order: 1,
    active: true,
  },
  {
    id: 3,
    name: 'Deliverable',
    kind: 'deliverable',
    order: 2,
    active: true,
  },
  { id: 4, name: 'Task', kind: 'task', order: 3, active: true },
]

const ASSIGNEES = [
  { id: '11', name: 'Alex Rivera', initials: 'AR' },
  { id: '12', name: 'Ben Okafor', initials: 'BO' },
  { id: '13', name: 'Cleo Santos', initials: 'CS' },
]

function makeItem(
  overrides: Partial<ApiWorkItem> = {},
): ApiWorkItem {
  return {
    id: 42,
    title: 'Ship the report',
    description: '',
    type: 'task' as const,
    status: 'todo' as const,
    assigneeIds: [] as number[],
    parentId: null,
    dueDate: null,
    blockedReason: null,
    completedAt: null,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    boardPosition: 1,
    labelDefinitionIds: [] as number[],
    typeDefinitionId: 4,
    statusDefinitionId: 10,
    createdById: 1,
    projectId: 7,
    ...overrides,
  } as ApiWorkItem
}

function renderCreatePanel(
  configuration: ApiProjectWorkItemConfiguration =
    makeConfiguration(CANONICAL_TYPES),
  readOnly = false,
) {
  const onClose = vi.fn()
  const onCreate = vi.fn(async () => {})

  const result = render(
    <WorkItemDrawer
      open={true}
      mode="create"
      projectName="Alpha"
      item={null}
      readOnly={readOnly}
      currentUserId={1}
      workItemConfiguration={configuration}
      assignees={ASSIGNEES}
      parentItems={[]}
      onClose={onClose}
      onCreate={onCreate}
      onPatch={vi.fn(async () => {})}
    />,
  )

  return { onClose, onCreate, ...result }
}

function renderInspectorPanel(
  configuration: ApiProjectWorkItemConfiguration =
    makeConfiguration(CANONICAL_TYPES),
  item: ApiWorkItem = makeItem(),
  assignees = ASSIGNEES,
  readOnly = false,
) {
  const onClose = vi.fn()
  const patches: Array<{
    workItemId: number
    patch: ApiUpdateWorkItemInput
  }> = []

  const onPatch = vi.fn(
    async (
      workItemId: number,
      patch: ApiUpdateWorkItemInput,
    ) => {
      patches.push({ workItemId, patch })
    },
  )

  const result = render(
    <WorkItemInspector
      projectName="Alpha"
      item={item}
      readOnly={readOnly}
      currentUserId={1}
      workItemConfiguration={configuration}
      assignees={assignees}
      parentItems={[]}
      onClose={onClose}
      onPatch={onPatch}
    />,
  )

  return {
    item,
    onClose,
    onPatch,
    patches,
    ...result,
  }
}

// ── showPicker test seam ───────────────────────────────────────────
//
// happy-dom does not implement HTMLInputElement.showPicker; install a
// spy on the prototype for the picker tests and restore the original
// descriptor (absent) afterwards.

function installShowPicker() {
  const original = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'showPicker',
  )

  const spy = vi.fn()

  Object.defineProperty(HTMLInputElement.prototype, 'showPicker', {
    value: spy,
    configurable: true,
    writable: true,
  })

  return {
    spy,
    restore() {
      if (original === undefined) {
        delete (
          HTMLInputElement.prototype as {
            showPicker?: unknown
          }
        ).showPicker
      } else {
        Object.defineProperty(
          HTMLInputElement.prototype,
          'showPicker',
          original,
        )
      }
    },
  }
}

function dueDateField() {
  return screen.getByLabelText(
    'Due date',
  ) as HTMLInputElement
}

function assigneeTrigger() {
  return screen.getByRole('button', {
    name: /add assignee/i,
  }) as HTMLButtonElement
}

function searchInput() {
  return screen.getByPlaceholderText(
    'Search members…',
  ) as HTMLInputElement
}

beforeEach(() => {
  // No network in unit tests: the inspector's History/Comments
  // fetches are the only network callers; they fail closed and never
  // affect the surfaces under test.
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

/* ── Create mode: Assignee picker ───────────────────────────────── */

describe(
  'Work Item drawer (create) — Assignee picker',
  () => {
    it('stays open while selecting and unselecting assignees', () => {
      renderCreatePanel()

      fireEvent.click(assigneeTrigger())
      expect(searchInput()).toBeInTheDocument()

      fireEvent.click(
        screen.getByRole('checkbox', {
          name: /Alex Rivera/,
        }),
      )
      expect(
        screen.getByRole('button', {
          name: 'Remove Alex Rivera',
        }),
      ).toBeInTheDocument()
      // still open — the selection did not dismiss
      expect(searchInput()).toBeInTheDocument()

      fireEvent.click(
        screen.getByRole('checkbox', {
          name: /Ben Okafor/,
        }),
      )
      expect(
        screen.getByRole('button', {
          name: 'Remove Ben Okafor',
        }),
      ).toBeInTheDocument()
      expect(searchInput()).toBeInTheDocument()

      // unselecting also keeps it open
      fireEvent.click(
        screen.getByRole('checkbox', {
          name: /Alex Rivera/,
        }),
      )
      expect(
        screen.queryByRole('button', {
          name: 'Remove Alex Rivera',
        }),
      ).not.toBeInTheDocument()
      expect(searchInput()).toBeInTheDocument()
    })

    it('stays open while typing in the search input', () => {
      renderCreatePanel()

      fireEvent.click(assigneeTrigger())
      const search = searchInput()

      // a pointer press inside the region + typing never dismiss
      fireEvent.mouseDown(search)
      fireEvent.change(search, {
        target: { value: 'ben' },
      })

      expect(
        screen.getByRole('checkbox', {
          name: /Ben Okafor/,
        }),
      ).toBeInTheDocument()
      expect(
        screen.queryByRole('checkbox', {
          name: /Alex Rivera/,
        }),
      ).not.toBeInTheDocument()
      expect(search).toBeInTheDocument()
    })

    it.each([
      [
        'the Title field',
        () =>
          screen.getByPlaceholderText(
            'What needs to be done?',
          ),
      ],
      [
        'the Description field',
        () =>
          screen.getByPlaceholderText(
            'Add context, expected outcome, or relevant notes…',
          ),
      ],
      [
        'the Due date field',
        () => screen.getByLabelText('Due date'),
      ],
      [
        'a Type option',
        () =>
          screen.getByRole('radio', { name: 'Epic' }),
      ],
      [
        'blank drawer space (heading)',
        () =>
          screen.getByRole('heading', {
            name: 'New work item',
          }),
      ],
    ])(
      'dismisses on an outside press at %s — and the drawer stays open',
      (_label, locate) => {
        const { onClose } = renderCreatePanel()

        fireEvent.click(assigneeTrigger())
        expect(searchInput()).toBeInTheDocument()

        fireEvent.mouseDown(locate())

        expect(
          screen.queryByPlaceholderText('Search members…'),
        ).not.toBeInTheDocument()
        // the Work Item Drawer itself never closes because the
        // picker closed
        expect(
          screen.getByRole('heading', {
            name: 'New work item',
          }),
        ).toBeInTheDocument()
        expect(onClose).not.toHaveBeenCalled()
      },
    )

    it('dismisses on Escape and keeps the drawer open', () => {
      const { onClose } = renderCreatePanel()

      fireEvent.click(assigneeTrigger())
      expect(searchInput()).toBeInTheDocument()

      fireEvent.keyDown(document, { key: 'Escape' })

      expect(
        screen.queryByPlaceholderText('Search members…'),
      ).not.toBeInTheDocument()
      expect(onClose).not.toHaveBeenCalled()
      expect(
        screen.getByRole('heading', {
          name: 'New work item',
        }),
      ).toBeInTheDocument()
    })

    it('starts clean (empty query) when reopened after an outside dismissal', () => {
      renderCreatePanel()

      fireEvent.click(assigneeTrigger())
      fireEvent.change(searchInput(), {
        target: { value: 'cle' },
      })
      expect(
        screen.getByRole('checkbox', {
          name: /Cleo Santos/,
        }),
      ).toBeInTheDocument()

      fireEvent.mouseDown(
        screen.getByRole('heading', {
          name: 'New work item',
        }),
      )
      expect(
        screen.queryByPlaceholderText('Search members…'),
      ).not.toBeInTheDocument()

      fireEvent.click(assigneeTrigger())
      expect(searchInput()).toHaveValue('')
      expect(
        screen.getByRole('checkbox', {
          name: /Alex Rivera/,
        }),
      ).toBeInTheDocument()
    })

    it('keeps toggling via the trigger and clears the query when the trigger closes it', () => {
      renderCreatePanel()

      fireEvent.click(assigneeTrigger())
      fireEvent.change(searchInput(), {
        target: { value: 'ale' },
      })

      fireEvent.click(assigneeTrigger())
      expect(
        screen.queryByPlaceholderText('Search members…'),
      ).not.toBeInTheDocument()

      fireEvent.click(assigneeTrigger())
      expect(searchInput()).toHaveValue('')
    })

    it('attaches the outside-click listener only while open and removes it on close and on unmount', () => {
      const addSpy = vi.spyOn(
        document,
        'addEventListener',
      )
      const removeSpy = vi.spyOn(
        document,
        'removeEventListener',
      )

      const mousedownAdds = (
        spy: typeof addSpy,
      ) =>
        spy.mock.calls.filter(
          (call) => call[0] === 'mousedown',
        ).length

      const { unmount } = renderCreatePanel()

      const baseAdds = mousedownAdds(addSpy)
      const baseRemoves = mousedownAdds(removeSpy)

      // at rest: no picker listener
      expect(mousedownAdds(addSpy)).toBe(baseAdds)

      fireEvent.click(assigneeTrigger())
      expect(
        mousedownAdds(addSpy) - baseAdds,
      ).toBe(1)

      // outside press closes -> listener removed
      fireEvent.mouseDown(
        screen.getByRole('heading', {
          name: 'New work item',
        }),
      )
      expect(
        mousedownAdds(removeSpy) - baseRemoves,
      ).toBe(1)

      // open again, then unmount with the picker open
      fireEvent.click(assigneeTrigger())
      expect(
        mousedownAdds(addSpy) - baseAdds,
      ).toBe(2)
      unmount()
      expect(
        mousedownAdds(removeSpy) - baseRemoves,
      ).toBe(2)
    })
  },
)

/* ── Edit mode: Assignee picker ─────────────────────────────────── */

describe(
  'Work Item drawer (edit) — Assignee picker',
  () => {
    it('stays open after selecting an assignee and issues the PATCH', async () => {
      const { patches } = renderInspectorPanel()

      fireEvent.click(assigneeTrigger())
      expect(searchInput()).toBeInTheDocument()

      fireEvent.click(
        screen.getByRole('checkbox', {
          name: /Alex Rivera/,
        }),
      )

      // still open after the selection
      expect(searchInput()).toBeInTheDocument()
      await waitFor(() =>
        expect(patches).toHaveLength(1),
      )
      expect(patches[0]).toEqual({
        workItemId: 42,
        patch: { assigneeIds: [11] },
      })
    })

    it('stays open while typing in the search input', () => {
      renderInspectorPanel()

      fireEvent.click(assigneeTrigger())
      const search = searchInput()

      fireEvent.mouseDown(search)
      fireEvent.change(search, {
        target: { value: 'ok' },
      })

      expect(
        screen.getByRole('checkbox', {
          name: /Ben Okafor/,
        }),
      ).toBeInTheDocument()
      expect(
        screen.queryByRole('checkbox', {
          name: /Cleo Santos/,
        }),
      ).not.toBeInTheDocument()
      expect(search).toBeInTheDocument()
    })

    it.each([
      [
        'the Title',
        () =>
          screen.getByRole('button', {
            name: 'Ship the report',
          }),
      ],
      [
        'the Due date field',
        () => screen.getByLabelText('Due date'),
      ],
      [
        'the Type property',
        () => screen.getByLabelText('Type'),
      ],
      [
        'blank drawer space (heading)',
        () =>
          screen.getByRole('heading', { name: 'Work item' }),
      ],
    ])(
      'dismisses on an outside press at %s — and the drawer stays open',
      (_label, locate) => {
        const { onClose } = renderInspectorPanel()

        fireEvent.click(assigneeTrigger())
        expect(searchInput()).toBeInTheDocument()

        fireEvent.mouseDown(locate())

        expect(
          screen.queryByPlaceholderText('Search members…'),
        ).not.toBeInTheDocument()
        expect(onClose).not.toHaveBeenCalled()
        expect(
          screen.getByRole('heading', {
            name: 'Work item',
          }),
        ).toBeInTheDocument()
      },
    )

    it('dismisses on Escape and keeps the drawer open', () => {
      const { onClose } = renderInspectorPanel()

      fireEvent.click(assigneeTrigger())
      expect(searchInput()).toBeInTheDocument()

      fireEvent.keyDown(document, { key: 'Escape' })

      expect(
        screen.queryByPlaceholderText('Search members…'),
      ).not.toBeInTheDocument()
      expect(onClose).not.toHaveBeenCalled()
      expect(
        screen.getByRole('heading', { name: 'Work item' }),
      ).toBeInTheDocument()
    })

    it('starts clean (empty query) when reopened after an outside dismissal', () => {
      renderInspectorPanel()

      fireEvent.click(assigneeTrigger())
      fireEvent.change(searchInput(), {
        target: { value: 'river' },
      })
      expect(
        screen.getByRole('checkbox', {
          name: /Alex Rivera/,
        }),
      ).toBeInTheDocument()

      fireEvent.mouseDown(
        screen.getByRole('heading', { name: 'Work item' }),
      )
      expect(
        screen.queryByPlaceholderText('Search members…'),
      ).not.toBeInTheDocument()

      fireEvent.click(assigneeTrigger())
      expect(searchInput()).toHaveValue('')
    })

    it('attaches the outside-click listener only while open and removes it on close and on unmount', () => {
      const addSpy = vi.spyOn(
        document,
        'addEventListener',
      )
      const removeSpy = vi.spyOn(
        document,
        'removeEventListener',
      )

      const mousedownAdds = (
        spy: typeof addSpy,
      ) =>
        spy.mock.calls.filter(
          (call) => call[0] === 'mousedown',
        ).length

      const { unmount } = renderInspectorPanel()

      const baseAdds = mousedownAdds(addSpy)
      const baseRemoves = mousedownAdds(removeSpy)

      expect(mousedownAdds(addSpy)).toBe(baseAdds)

      fireEvent.click(assigneeTrigger())
      expect(
        mousedownAdds(addSpy) - baseAdds,
      ).toBe(1)

      fireEvent.mouseDown(
        screen.getByRole('heading', { name: 'Work item' }),
      )
      expect(
        mousedownAdds(removeSpy) - baseRemoves,
      ).toBe(1)

      fireEvent.click(assigneeTrigger())
      expect(
        mousedownAdds(addSpy) - baseAdds,
      ).toBe(2)
      unmount()
      expect(
        mousedownAdds(removeSpy) - baseRemoves,
      ).toBe(2)
    })
  },
)

/* ── Due date: native picker from the full field ────────────────── */

describe('Work Item drawer — Due date native picker', () => {
  let picker: {
    spy: ReturnType<typeof vi.fn>
    restore: () => void
  }

  beforeEach(() => {
    picker = installShowPicker()
  })

  afterEach(() => {
    picker.restore()
  })

  it('create: clicking the enabled Due date field calls showPicker', () => {
    renderCreatePanel()

    fireEvent.click(dueDateField())

    expect(picker.spy).toHaveBeenCalledTimes(1)
  })

  it('edit: clicking the enabled Due date field calls showPicker', () => {
    renderInspectorPanel()

    fireEvent.click(dueDateField())

    expect(picker.spy).toHaveBeenCalledTimes(1)
  })

  it('does not throw when the browser has no showPicker', () => {
    // remove the spy installed above: the field must gracefully
    // fall back to the native input behavior
    delete (
      HTMLInputElement.prototype as {
        showPicker?: unknown
      }
    ).showPicker

    renderCreatePanel()

    expect(() =>
      fireEvent.click(dueDateField()),
    ).not.toThrow()
    expect(dueDateField()).toHaveValue('')
  })

  it('a read-only (disabled) Due date field never attempts to open the picker', () => {
    renderCreatePanel(
      makeConfiguration(CANONICAL_TYPES),
      true,
    )

    const field = dueDateField()
    expect(field).toBeDisabled()

    fireEvent.click(field)

    expect(picker.spy).not.toHaveBeenCalled()
  })

  it('create: a changed date persists exactly as before (submit payload)', async () => {
    const { onCreate } = renderCreatePanel()

    fireEvent.change(
      screen.getByPlaceholderText('What needs to be done?'),
      { target: { value: 'Write notes' } },
    )
    fireEvent.change(dueDateField(), {
      target: { value: '2026-10-01' },
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Create work item',
      }),
    )

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledTimes(1),
    )
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Write notes',
        dueDate: '2026-10-01',
      }),
    )
  })

  it('edit: a changed date persists exactly as before (single-field PATCH)', async () => {
    const { patches } = renderInspectorPanel()

    fireEvent.change(dueDateField(), {
      target: { value: '2026-10-01' },
    })

    await waitFor(() =>
      expect(patches).toHaveLength(1),
    )
    expect(patches[0]).toEqual({
      workItemId: 42,
      patch: { dueDate: '2026-10-01' },
    })
  })
})

/* ── Create mode: canonical Task default by kind ────────────────── */

describe(
  'Work Item drawer (create) — default type',
  () => {
    it('selects the canonical Task by kind, not by name or position', () => {
      renderCreatePanel()

      expect(
        screen.getByRole('radio', { name: 'Task' }),
      ).toBeChecked()
      expect(
        screen.getByRole('radio', { name: 'Epic' }),
      ).not.toBeChecked()
      expect(
        screen.getByRole('radio', { name: 'Milestone' }),
      ).not.toBeChecked()
      expect(
        screen.getByRole('radio', { name: 'Deliverable' }),
      ).not.toBeChecked()
    })

    it('selects a RENAMED canonical Task by kind', () => {
      const types: ApiWorkItemTypeDefinition[] = [
        { id: 1, name: 'Epic', kind: 'epic', order: 0, active: true },
        {
          id: 2,
          name: 'Milestone',
          kind: 'milestone',
          order: 1,
          active: true,
        },
        {
          id: 3,
          name: 'Deliverable',
          kind: 'deliverable',
          order: 2,
          active: true,
        },
        {
          id: 4,
          name: 'Experiment step',
          kind: 'task',
          order: 3,
          active: true,
        },
      ]

      renderCreatePanel(makeConfiguration(types))

      expect(
        screen.getByRole('radio', {
          name: 'Experiment step',
        }),
      ).toBeChecked()
      expect(
        screen.getByRole('radio', { name: 'Epic' }),
      ).not.toBeChecked()
    })

    it('does NOT treat a custom type named "Task" (kind null) as canonical', () => {
      const types: ApiWorkItemTypeDefinition[] = [
        {
          id: 1,
          name: 'Task',
          kind: null,
          order: 0,
          active: true,
        },
        {
          id: 2,
          name: 'Experiment',
          kind: null,
          order: 1,
          active: true,
        },
      ]

      renderCreatePanel(makeConfiguration(types))

      expect(
        screen.getByRole('radio', { name: 'Task' }),
      ).not.toBeChecked()
      expect(
        screen.getByRole('radio', { name: 'Experiment' }),
      ).not.toBeChecked()
      // no selected type -> create validation blocks submission
      expect(
        screen.getByRole('button', {
          name: 'Create work item',
        }),
      ).toBeDisabled()
    })

    it('selects the canonical Task regardless of the configured ordering', () => {
      const types: ApiWorkItemTypeDefinition[] = [
        {
          id: 3,
          name: 'Deliverable',
          kind: 'deliverable',
          order: 0,
          active: true,
        },
        { id: 1, name: 'Epic', kind: 'epic', order: 1, active: true },
        { id: 4, name: 'Task', kind: 'task', order: 2, active: true },
        {
          id: 2,
          name: 'Milestone',
          kind: 'milestone',
          order: 3,
          active: true,
        },
      ]

      renderCreatePanel(makeConfiguration(types))

      expect(
        screen.getByRole('radio', { name: 'Task' }),
      ).toBeChecked()
      expect(
        screen.getByRole('radio', {
          name: 'Deliverable',
        }),
      ).not.toBeChecked()
    })

    it('leaves the type unselected when the canonical Task is inactive (no fallback type)', () => {
      const types: ApiWorkItemTypeDefinition[] = [
        {
          id: 4,
          name: 'Task',
          kind: 'task',
          order: 0,
          active: false,
        },
        {
          id: 5,
          name: 'Experiment',
          kind: null,
          order: 1,
          active: true,
        },
      ]

      renderCreatePanel(makeConfiguration(types))

      // the inactive canonical Task never renders for new items
      expect(
        screen.queryByRole('radio', { name: 'Task' }),
      ).not.toBeInTheDocument()
      expect(
        screen.getByRole('radio', { name: 'Experiment' }),
      ).not.toBeChecked()
      expect(
        screen.getByRole('button', {
          name: 'Create work item',
        }),
      ).toBeDisabled()
    })

    it('re-seeds the canonical Task for every new drawer session', () => {
      const first = renderCreatePanel()
      expect(
        screen.getByRole('radio', { name: 'Task' }),
      ).toBeChecked()

      // a manual choice in THIS session…
      fireEvent.click(
        screen.getByRole('radio', { name: 'Epic' }),
      )
      expect(
        screen.getByRole('radio', { name: 'Epic' }),
      ).toBeChecked()
      first.unmount()

      // …must not leak into the NEXT session
      const second = renderCreatePanel()
      expect(
        screen.getByRole('radio', { name: 'Task' }),
      ).toBeChecked()
      expect(
        screen.getByRole('radio', { name: 'Epic' }),
      ).not.toBeChecked()
      second.unmount()
    })

    it('keeps a manually chosen type after the initial defaulting', () => {
      renderCreatePanel()
      expect(
        screen.getByRole('radio', { name: 'Task' }),
      ).toBeChecked()

      fireEvent.click(
        screen.getByRole('radio', { name: 'Milestone' }),
      )
      expect(
        screen.getByRole('radio', { name: 'Milestone' }),
      ).toBeChecked()
      expect(
        screen.getByRole('radio', { name: 'Task' }),
      ).not.toBeChecked()

      // the choice survives subsequent re-renders (no re-seed)
      fireEvent.change(
        screen.getByPlaceholderText('What needs to be done?'),
        { target: { value: 'Some title' } },
      )
      expect(
        screen.getByRole('radio', { name: 'Milestone' }),
      ).toBeChecked()
      expect(
        screen.getByRole('radio', { name: 'Task' }),
      ).not.toBeChecked()
    })
  },
)


/* ── Edit mode: Assignees single-row overflow contract ──────────── */
//
// LAYOUT-CONTRACT SCOPE (as in workItemDrawerLayout.test.tsx):
// happy-dom has no layout engine, so real pixel geometry is proven
// by visual acceptance. This block pins the DOM-level contract the
// single-row invariant relies on:
//   - the Assignees value row and its pill group are flex-nowrap, so
//     pills, the "+N" chip, and the Assign trigger can never wrap to
//     a second line;
//   - the Assign trigger carries shrink-0 and is the LAST child of
//     the row in every assignee count, so the "+N" + Assign group
//     stays pinned to the value column's right edge and the dropdown
//     anchored to it keeps the same position;
//   - a fixed, deterministic cap (MAX_VISIBLE_ASSIGNEES = 2, no
//     runtime layout measuring) bounds the individually rendered
//     pills; further assignees collapse into ONE "+N" chip;
//   - pill names truncate (max-w + truncate) instead of growing the
//     row; the pill group may flex-shrink on narrow viewports.

const OVERFLOW_ASSIGNEES = [
  { id: '11', name: 'Anna Kowalska', initials: 'AK' },
  { id: '12', name: 'Ben Okafor', initials: 'BO' },
  { id: '13', name: 'Leon Fischer', initials: 'LF' },
  { id: '14', name: 'Mona Haddad', initials: 'MH' },
  { id: '15', name: 'Nikolai Petrov', initials: 'NP' },
]

// The single Assignees value row: the "Assignees" PropertyRow label
// locates the row's PropertyRow wrapper; the value column's first
// child is the one-row container under test. Anchored to the label
// (not the Assign trigger) so read-only renders — which have no
// trigger — resolve the same way.
function assigneesRow(): HTMLElement {
  const label = screen.getByText('Assignees')
  const propertyRow = label.closest(
    '.flex.items-start.gap-4',
  ) as HTMLElement
  const valueColumn =
    propertyRow.lastElementChild as HTMLElement

  return valueColumn
    .firstElementChild as HTMLElement
}

function pillGroup(): HTMLElement {
  return assigneesRow()
    .firstElementChild as HTMLElement
}

function pillCount(): number {
  // Only the pill spans count — the read-only "Unassigned"
  // placeholder is also a direct span child of the pill group.
  return pillGroup()
    .querySelectorAll(':scope > span.rounded-full')
    .length
}

describe(
  'Work Item drawer (edit) — Assignees single-row overflow',
  () => {
    it('renders one stable row with 0 assignees (trigger pinned, no wrap, no +N)', () => {
      renderInspectorPanel(
        makeConfiguration(CANONICAL_TYPES),
        makeItem({ assigneeIds: [] }),
      )

      const row = assigneesRow()
      expect(row.classList).toContain('flex-nowrap')
      expect(row.classList).not.toContain(
        'flex-wrap',
      )
      expect(pillCount()).toBe(0)
      expect(
        screen.queryByText(/^\+\d+$/),
      ).not.toBeInTheDocument()
      // the trigger is the last child of the same row
      expect(row.lastElementChild).toBe(
        assigneeTrigger().parentElement,
      )
      expect(assigneeTrigger().classList).toContain(
        'shrink-0',
      )
    })

    it('keeps the same row geometry with 1 assignee', () => {
      renderInspectorPanel(
        makeConfiguration(CANONICAL_TYPES),
        makeItem({ assigneeIds: [11] }),
        OVERFLOW_ASSIGNEES,
      )

      const row = assigneesRow()
      expect(row.classList).toContain('flex-nowrap')
      expect(pillCount()).toBe(1)
      expect(
        screen.queryByText(/^\+\d+$/),
      ).not.toBeInTheDocument()
      expect(row.lastElementChild).toBe(
        assigneeTrigger().parentElement,
      )
    })

    it('keeps one row with 5 assignees: 2 pills + "+3" + trigger, all in the same row', () => {
      renderInspectorPanel(
        makeConfiguration(CANONICAL_TYPES),
        makeItem({
          assigneeIds: [11, 12, 13, 14, 15],
        }),
        OVERFLOW_ASSIGNEES,
      )

      const row = assigneesRow()
      expect(row.classList).toContain('flex-nowrap')
      expect(row.classList).not.toContain(
        'flex-wrap',
      )
      // the pill group is also nowrap — pills can never wrap
      expect(
        pillGroup().classList,
      ).toContain('flex-nowrap')
      expect(pillCount()).toBe(2)
      // the hidden assignees collapse into ONE chip
      expect(screen.getByText('+3')).toBeInTheDocument()
      // and the trigger stays the row's last child —
      // it never moves to a second line
      expect(row.lastElementChild).toBe(
        assigneeTrigger().parentElement,
      )
    })

    it('renders long names with a truncating cap inside the pill (layout contract)', () => {
      const longName = [
        'Konstantinopoulos',
        'Papadopoulos-Christodoulou',
      ].join(' ')

      renderInspectorPanel(
        makeConfiguration(CANONICAL_TYPES),
        makeItem({ assigneeIds: [11, 12] }),
        [
          {
            id: '11',
            name: longName,
            initials: 'KP',
          },
          { id: '12', name: 'Ben Okafor', initials: 'BO' },
        ],
      )

      const nameSpan = screen.getByText(longName)
      expect(nameSpan.classList).toContain(
        'truncate',
      )
      expect(nameSpan.classList).toContain(
        'max-w-[4.5rem]',
      )
      // the row still exists as a single nowrap row
      expect(
        assigneesRow().classList,
      ).toContain('flex-nowrap')
      expect(pillCount()).toBe(2)
    })

    it('exposes the +N chip with an accessible label', () => {
      renderInspectorPanel(
        makeConfiguration(CANONICAL_TYPES),
        makeItem({
          assigneeIds: [11, 12, 13, 14, 15],
        }),
        OVERFLOW_ASSIGNEES,
      )

      const moreButton = screen.getByRole('button', {
        name: '3 more assignees',
      }) as HTMLElement

      expect(moreButton).toHaveTextContent('+3')
      // the chip sits in the same row, before the Assign trigger
      expect(
        assigneesRow().contains(moreButton),
      ).toBe(true)
      expect(moreButton.parentElement).toBe(
        assigneeTrigger().parentElement,
      )
    })

    it('opens the picker from the +N chip and keeps hidden assignees manageable', async () => {
      const { patches } = renderInspectorPanel(
        makeConfiguration(CANONICAL_TYPES),
        makeItem({
          assigneeIds: [11, 12, 13, 14, 15],
        }),
        OVERFLOW_ASSIGNEES,
      )

      // Leon Fischer is HIDDEN (beyond the 2 visible pills)
      expect(
        screen.queryByRole('button', {
          name: 'Remove Leon Fischer',
        }),
      ).not.toBeInTheDocument()

      fireEvent.click(
        screen.getByRole('button', {
          name: '3 more assignees',
        }),
      )
      expect(searchInput()).toBeInTheDocument()

      // unselect the hidden assignee through the picker
      fireEvent.click(
        screen.getByRole('checkbox', {
          name: /Leon Fischer/,
        }),
      )

      await waitFor(() =>
        expect(patches).toHaveLength(1),
      )
      expect(patches[0]).toEqual({
        workItemId: 42,
        patch: { assigneeIds: [11, 12, 14, 15] },
      })
      // the selection inside the picker never dismissed it
      expect(searchInput()).toBeInTheDocument()
    })

    it('keeps the X remove action on visible pills', async () => {
      const { patches } = renderInspectorPanel(
        makeConfiguration(CANONICAL_TYPES),
        makeItem({
          assigneeIds: [11, 12, 13, 14, 15],
        }),
        OVERFLOW_ASSIGNEES,
      )

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Remove Anna Kowalska',
        }),
      )

      await waitFor(() =>
        expect(patches).toHaveLength(1),
      )
      expect(patches[0]).toEqual({
        workItemId: 42,
        patch: { assigneeIds: [12, 13, 14, 15] },
      })
      // the picker is not involved — no search input rendered
      expect(
        screen.queryByPlaceholderText('Search members…'),
      ).not.toBeInTheDocument()
    })

    it('never moves the Assign trigger to another row when crossing into overflow', () => {
      // below the cap: 2 assignees, no overflow
      renderInspectorPanel(
        makeConfiguration(CANONICAL_TYPES),
        makeItem({ assigneeIds: [11, 12] }),
        OVERFLOW_ASSIGNEES,
      )

      let row = assigneesRow()
      expect(
        screen.queryByText(/^\+\d+$/),
      ).not.toBeInTheDocument()
      expect(row.lastElementChild).toBe(
        assigneeTrigger().parentElement,
      )
      cleanup()

      // at the cap boundary: 3 assignees — overflow appears, and
      // the trigger stays the last child of the SAME single row
      renderInspectorPanel(
        makeConfiguration(CANONICAL_TYPES),
        makeItem({ assigneeIds: [11, 12, 13] }),
        OVERFLOW_ASSIGNEES,
      )

      row = assigneesRow()
      expect(screen.getByText('+1')).toBeInTheDocument()
      expect(row.classList).toContain('flex-nowrap')
      expect(row.lastElementChild).toBe(
        assigneeTrigger().parentElement,
      )
    })

    it('read-only: +N renders non-interactively and pills keep no X action', () => {
      renderInspectorPanel(
        makeConfiguration(CANONICAL_TYPES),
        makeItem({
          assigneeIds: [11, 12, 13, 14, 15],
        }),
        OVERFLOW_ASSIGNEES,
        true,
      )

      expect(screen.getByText('+3')).toBeInTheDocument()
      expect(
        screen.queryByRole('button', {
          name: /more assignees/,
        }),
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', {
          name: /remove /i,
        }),
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', {
          name: 'Add assignee',
        }),
      ).not.toBeInTheDocument()
      expect(pillCount()).toBe(2)
      expect(
        assigneesRow().classList,
      ).toContain('flex-nowrap')
    })

    it('read-only with 0 assignees keeps the single-row "Unassigned" state', () => {
      renderInspectorPanel(
        makeConfiguration(CANONICAL_TYPES),
        makeItem({ assigneeIds: [] }),
        OVERFLOW_ASSIGNEES,
        true,
      )

      expect(
        screen.getByText('Unassigned'),
      ).toBeInTheDocument()
      expect(pillCount()).toBe(0)
      expect(
        screen.queryByText(/^\+\d+$/),
      ).not.toBeInTheDocument()
      expect(
        assigneesRow().classList,
      ).toContain('flex-nowrap')
    })
  },
)
