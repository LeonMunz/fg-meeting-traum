// @vitest-environment happy-dom

import {
  createRef,
  useState,
} from 'react'
import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
} from '@testing-library/react'
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import type { ApiWorkItemTypeKind } from '../../api/types'
import {
  WORK_ITEM_TYPE_FILTER_OPTIONS,
} from './myWorkTypeFilter'
import {
  MyWorkFilterCommandMenu,
  type MyWorkFilterCommandMenuHandle,
  type MyWorkFilterCommandMenuProps,
} from './MyWorkFilterCommandMenu'

afterEach(cleanup)

const GROUPS = [
  { id: 1, name: 'Biology Lab' },
  { id: 2, name: 'Robotics Lab' },
]

const PROJECTS = [
  { id: 10, name: 'Cell Atlas' },
  { id: 20, name: 'Robot Study' },
  { id: 30, name: 'Paper XYZ' },
]

function baseProps(
  overrides: Partial<MyWorkFilterCommandMenuProps> = {},
): MyWorkFilterCommandMenuProps {
  return {
    researchGroupOptions: GROUPS,
    selectedResearchGroupIds: [],
    onResearchGroupToggle: vi.fn(),
    onClearResearchGroups: vi.fn(),
    projectOptions: PROJECTS,
    selectedProjectIds: [],
    onProjectToggle: vi.fn(),
    onClearProjects: vi.fn(),
    selectedWorkItemTypes: [],
    onWorkItemTypeToggle: vi.fn(),
    onClearWorkItemTypes: vi.fn(),
    onClearAll: vi.fn(),
    ...overrides,
  }
}

function ControlledMenu({
  initialGroups = [],
  initialProjects = [],
  initialTypes = [],
  spies,
}: {
  initialGroups?: number[]
  initialProjects?: number[]
  initialTypes?: ApiWorkItemTypeKind[]
  spies: {
    group: (id: number, selected: boolean) => void
    project: (id: number, selected: boolean) => void
    type: (kind: ApiWorkItemTypeKind, selected: boolean) => void
    clearGroups: () => void
    clearProjects: () => void
    clearTypes: () => void
    clearAll: () => void
  }
}) {
  const [groups, setGroups] = useState(initialGroups)
  const [projects, setProjects] = useState(initialProjects)
  const [types, setTypes] = useState(initialTypes)

  return (
    <MyWorkFilterCommandMenu
      {...baseProps()}
      selectedResearchGroupIds={groups}
      selectedProjectIds={projects}
      selectedWorkItemTypes={types}
      onResearchGroupToggle={(id, selected) => {
        spies.group(id, selected)
        setGroups((current) =>
          selected
            ? [...current, id]
            : current.filter((candidate) => candidate !== id),
        )
      }}
      onProjectToggle={(id, selected) => {
        spies.project(id, selected)
        setProjects((current) =>
          selected
            ? [...current, id]
            : current.filter((candidate) => candidate !== id),
        )
      }}
      onWorkItemTypeToggle={(kind, selected) => {
        spies.type(kind, selected)
        setTypes((current) =>
          selected
            ? [...current, kind]
            : current.filter((candidate) => candidate !== kind),
        )
      }}
      onClearResearchGroups={() => {
        spies.clearGroups()
        setGroups([])
      }}
      onClearProjects={() => {
        spies.clearProjects()
        setProjects([])
      }}
      onClearWorkItemTypes={() => {
        spies.clearTypes()
        setTypes([])
      }}
      onClearAll={spies.clearAll}
    />
  )
}

function controlledSpies() {
  return {
    group: vi.fn(),
    project: vi.fn(),
    type: vi.fn(),
    clearGroups: vi.fn(),
    clearProjects: vi.fn(),
    clearTypes: vi.fn(),
    clearAll: vi.fn(),
  }
}

function openRoot(getByRole: ReturnType<typeof render>['getByRole']) {
  fireEvent.click(getByRole('button', { name: /Filter, \d+ active/ }))
  return getByRole('dialog', { name: 'Filter by' })
}

describe('MyWorkFilterCommandMenu', () => {
  it('renders the default trigger and counts active categories rather than values', () => {
    const { getByRole, rerender } = render(
      <MyWorkFilterCommandMenu {...baseProps()} />,
    )

    expect(
      getByRole('button', { name: 'Filter, 0 active categories' }),
    ).toHaveTextContent('Filter')

    rerender(
      <MyWorkFilterCommandMenu
        {...baseProps({
          selectedProjectIds: [10, 20],
          selectedWorkItemTypes: ['task'],
        })}
      />,
    )

    const trigger = getByRole('button', {
      name: 'Filter, 2 active categories',
    })
    expect(trigger).toHaveTextContent('Filter2')
  })

  it('shows exactly the three canonical categories in order', () => {
    const view = render(<MyWorkFilterCommandMenu {...baseProps()} />)
    const dialog = openRoot(view.getByRole)
    const buttons = within(dialog)
      .getAllByRole('button')
      .map((button) => button.textContent?.trim())

    expect(buttons).toEqual([
      'groupsResearch groupchevron_right',
      'folderProjectchevron_right',
      'categoryWork item typechevron_right',
    ])
  })

  it('replaces root content inside the same popover and Back returns to root', () => {
    const view = render(<MyWorkFilterCommandMenu {...baseProps()} />)
    const dialog = openRoot(view.getByRole)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Project' }))

    expect(view.getAllByRole('dialog')).toHaveLength(1)
    expect(view.queryByRole('button', { name: 'Research group' })).toBeNull()
    expect(view.getByRole('listbox', { name: 'Project options' })).toBeInTheDocument()

    fireEvent.click(
      view.getByRole('button', { name: 'Back to filter categories' }),
    )
    expect(view.getByRole('button', { name: 'Research group' })).toBeInTheDocument()
    expect(view.queryByRole('listbox')).toBeNull()
  })

  it('supports multi-selection in all dimensions, reports toggles immediately, and stays open', () => {
    const spies = controlledSpies()
    const view = render(<ControlledMenu spies={spies} />)
    openRoot(view.getByRole)

    fireEvent.click(view.getByRole('button', { name: 'Research group' }))
    fireEvent.click(view.getByRole('option', { name: 'Biology Lab' }))
    fireEvent.click(view.getByRole('option', { name: 'Robotics Lab' }))
    expect(spies.group.mock.calls).toEqual([
      [1, true],
      [2, true],
    ])
    expect(view.getByRole('option', { name: /Biology Lab/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(view.getByRole('dialog', { name: 'Filter by' })).toBeInTheDocument()

    fireEvent.click(
      view.getByRole('button', { name: 'Back to filter categories' }),
    )
    fireEvent.click(view.getByRole('button', { name: 'Project' }))
    fireEvent.click(view.getByRole('option', { name: 'Cell Atlas' }))
    fireEvent.click(view.getByRole('option', { name: 'Robot Study' }))
    expect(spies.project.mock.calls).toEqual([
      [10, true],
      [20, true],
    ])

    fireEvent.click(
      view.getByRole('button', { name: 'Back to filter categories' }),
    )
    fireEvent.click(view.getByRole('button', { name: 'Work item type' }))
    fireEvent.click(view.getByRole('option', { name: 'Task' }))
    fireEvent.click(view.getByRole('option', { name: 'Epic' }))
    expect(spies.type.mock.calls).toEqual([
      ['task', true],
      ['epic', true],
    ])
  })

  it('renders selected rows with checkmarks and no checkbox inputs', () => {
    const view = render(
      <MyWorkFilterCommandMenu
        {...baseProps({ selectedProjectIds: [10, 20] })}
      />,
    )
    openRoot(view.getByRole)
    fireEvent.click(view.getByRole('button', { name: /Project 2/ }))

    for (const name of ['Cell Atlas', 'Robot Study']) {
      const option = view.getByRole('option', { name: new RegExp(name) })
      expect(option).toHaveAttribute('aria-selected', 'true')
      expect(option).toHaveTextContent('check')
      expect(option.querySelector('.text-accent-text')).not.toBeNull()
    }
    expect(view.container.querySelector('input[type="checkbox"]')).toBeNull()
  })

  it('always searches Projects and filters the keyboard-navigable option set', () => {
    const view = render(<MyWorkFilterCommandMenu {...baseProps()} />)
    openRoot(view.getByRole)
    fireEvent.click(view.getByRole('button', { name: 'Project' }))

    const search = view.getByRole('searchbox', { name: 'Search projects' })
    expect(search).toBeInTheDocument()
    fireEvent.change(search, { target: { value: 'robot' } })
    expect(view.getAllByRole('option')).toHaveLength(1)
    expect(view.getByRole('option', { name: 'Robot Study' })).toBeInTheDocument()
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(
      view.getByRole('option', { name: 'Robot Study' }),
    )
  })

  it('shows Research Group search only above eight options', () => {
    const eight = Array.from({ length: 8 }, (_, index) => ({
      id: index + 1,
      name: `Group ${index + 1}`,
    }))
    const view = render(
      <MyWorkFilterCommandMenu
        {...baseProps({ researchGroupOptions: eight })}
      />,
    )
    openRoot(view.getByRole)
    fireEvent.click(view.getByRole('button', { name: 'Research group' }))
    expect(view.queryByRole('searchbox')).toBeNull()

    fireEvent.click(
      view.getByRole('button', { name: 'Back to filter categories' }),
    )
    view.rerender(
      <MyWorkFilterCommandMenu
        {...baseProps({
          researchGroupOptions: [
            ...eight,
            { id: 9, name: 'Ninth Group' },
          ],
        })}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: 'Research group' }))
    expect(
      view.getByRole('searchbox', { name: 'Search research groups' }),
    ).toBeInTheDocument()
  })

  it('renders exactly the canonical semantic type kinds with their semantic colors', () => {
    const view = render(<MyWorkFilterCommandMenu {...baseProps()} />)
    openRoot(view.getByRole)
    fireEvent.click(view.getByRole('button', { name: 'Work item type' }))

    expect(
      view.getAllByRole('option').map((option) => option.textContent?.trim()),
    ).toEqual([
      'assignmentTask',
      'account_treeEpic',
      'flagMilestone',
      'deployed_codeDeliverable',
    ])
    expect(view.container.querySelector('.text-work-type-task')).not.toBeNull()
    expect(view.container.querySelector('.text-work-type-epic')).not.toBeNull()
    expect(view.container.querySelector('.text-work-type-milestone')).not.toBeNull()
    expect(view.container.querySelector('.text-work-type-deliverable')).not.toBeNull()
    expect(view.queryByText(/unknown|custom/i)).toBeNull()
    expect(view.queryByRole('searchbox')).toBeNull()
  })

  it.each([
    [
      'a malformed first entry',
      [
        { kind: 'task', label: 'Custom' },
        ...WORK_ITEM_TYPE_FILTER_OPTIONS,
      ],
    ],
    [
      'duplicate entries',
      [
        { kind: 'task', label: 'Duplicate one' },
        { kind: 'task', label: 'Duplicate two' },
      ],
    ],
    [
      'missing entries',
      [{ kind: 'epic', label: 'Only caller option' }],
    ],
    [
      'reordered entries',
      [...WORK_ITEM_TYPE_FILTER_OPTIONS]
        .reverse()
        .map((option) => ({
          ...option,
          label: `Caller ${option.label}`,
        })),
    ],
    ['an empty option set', []],
  ] as const)(
    'keeps canonical type presentation when legacy caller props contain %s',
    (_caseName, legacyTypeOptions) => {
      // `workItemTypeOptions` is deliberately no longer part of the typed
      // component API. Supplying the legacy extra prop at runtime proves
      // that caller-controlled presentation data cannot affect the fixed
      // domain options.
      const legacyProps = {
        ...baseProps(),
        workItemTypeOptions: legacyTypeOptions,
      }
      const view = render(
        <MyWorkFilterCommandMenu {...legacyProps} />,
      )

      openRoot(view.getByRole)
      fireEvent.click(view.getByRole('button', { name: 'Work item type' }))

      const options = view.getAllByRole('option')
      expect(options).toHaveLength(4)
      expect(options.map((option) => option.textContent?.trim())).toEqual([
        'assignmentTask',
        'account_treeEpic',
        'flagMilestone',
        'deployed_codeDeliverable',
      ])
      expect(view.queryByText(/Custom|Duplicate|Only caller|Caller /)).toBeNull()
    },
  )

  it('clears only the current category and exposes root Clear all', () => {
    const spies = controlledSpies()
    const view = render(
      <ControlledMenu
        spies={spies}
        initialGroups={[1]}
        initialProjects={[10]}
      />,
    )
    openRoot(view.getByRole)

    fireEvent.click(view.getByRole('button', { name: 'Clear all' }))
    expect(spies.clearAll).toHaveBeenCalledOnce()
    expect(spies.clearGroups).not.toHaveBeenCalled()

    fireEvent.click(view.getByRole('button', { name: /Research group 1/ }))
    fireEvent.click(view.getByRole('button', { name: 'Clear' }))
    expect(spies.clearGroups).toHaveBeenCalledOnce()
    expect(spies.clearProjects).not.toHaveBeenCalled()
  })

  it('uses arrow navigation without selecting, then Enter and Space toggle the focused values', () => {
    const spies = controlledSpies()
    const view = render(<ControlledMenu spies={spies} />)
    const trigger = view.getByRole('button', {
      name: 'Filter, 0 active categories',
    })
    fireEvent.keyDown(trigger, { key: 'Enter' })

    const groupCategory = view.getByRole('button', { name: 'Research group' })
    expect(document.activeElement).toBe(groupCategory)
    fireEvent.keyDown(groupCategory, { key: 'ArrowDown' })
    const projectCategory = view.getByRole('button', { name: 'Project' })
    expect(document.activeElement).toBe(projectCategory)
    expect(spies.project).not.toHaveBeenCalled()
    fireEvent.keyDown(projectCategory, { key: 'Enter' })

    const search = view.getByRole('searchbox', { name: 'Search projects' })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    const first = view.getByRole('option', { name: 'Cell Atlas' })
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    const second = view.getByRole('option', { name: 'Robot Study' })
    expect(document.activeElement).toBe(second)
    expect(spies.project).not.toHaveBeenCalled()

    fireEvent.keyDown(second, { key: 'Enter' })
    expect(spies.project).toHaveBeenLastCalledWith(20, true)
    fireEvent.keyDown(second, { key: ' ' })
    expect(spies.project).toHaveBeenLastCalledWith(20, false)
    expect(view.getByRole('dialog', { name: 'Filter by' })).toBeInTheDocument()
  })

  it('supports Alt+Left and Escape restores focus to the trigger', () => {
    const view = render(<MyWorkFilterCommandMenu {...baseProps()} />)
    const trigger = view.getByRole('button', {
      name: 'Filter, 0 active categories',
    })
    fireEvent.click(trigger)
    fireEvent.click(view.getByRole('button', { name: 'Work item type' }))
    fireEvent.keyDown(view.getByRole('dialog'), {
      key: 'ArrowLeft',
      altKey: true,
    })
    expect(view.getByRole('button', { name: 'Research group' })).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('outside dismissal lets the clicked control receive focus and reopening resets to root', () => {
    const view = render(
      <div>
        <MyWorkFilterCommandMenu {...baseProps()} />
        <button type="button">Outside control</button>
      </div>,
    )
    openRoot(view.getByRole)
    fireEvent.click(view.getByRole('button', { name: 'Project' }))
    const outside = view.getByRole('button', { name: 'Outside control' })
    fireEvent.mouseDown(outside)
    outside.focus()

    expect(view.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(outside)

    fireEvent.click(
      view.getByRole('button', { name: 'Filter, 0 active categories' }),
    )
    expect(view.getByRole('button', { name: 'Research group' })).toBeInTheDocument()
    expect(view.queryByRole('searchbox')).toBeNull()
  })

  it('opens a specified category through the typed handle and focuses its first control', () => {
    const ref = createRef<MyWorkFilterCommandMenuHandle>()
    const view = render(
      <MyWorkFilterCommandMenu ref={ref} {...baseProps()} />,
    )

    act(() => ref.current?.openCategory('project'))
    const search = view.getByRole('searchbox', { name: 'Search projects' })
    expect(document.activeElement).toBe(search)
    expect(view.getByRole('listbox', { name: 'Project options' })).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    act(() => ref.current?.openCategory('work-item-type'))
    expect(document.activeElement).toBe(
      view.getByRole('option', { name: 'Task' }),
    )
  })

  it('handles empty options, zero search results, and controlled option removal safely', () => {
    const props = baseProps({ projectOptions: [] })
    const view = render(<MyWorkFilterCommandMenu {...props} />)
    openRoot(view.getByRole)
    fireEvent.click(view.getByRole('button', { name: 'Project' }))
    expect(view.getByText('No projects.')).toBeInTheDocument()
    expect(view.queryByRole('option')).toBeNull()

    view.rerender(
      <MyWorkFilterCommandMenu
        {...props}
        projectOptions={PROJECTS}
      />,
    )
    const search = view.getByRole('searchbox', { name: 'Search projects' })
    fireEvent.change(search, { target: { value: 'does not exist' } })
    expect(view.getByText('No matching projects.')).toBeInTheDocument()

    fireEvent.change(search, { target: { value: '' } })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    const first = view.getByRole('option', { name: 'Cell Atlas' })
    expect(document.activeElement).toBe(first)
    view.rerender(
      <MyWorkFilterCommandMenu
        {...props}
        projectOptions={PROJECTS.slice(1)}
      />,
    )
    expect(document.activeElement).toBe(
      view.getByRole('option', { name: 'Robot Study' }),
    )
  })
})
