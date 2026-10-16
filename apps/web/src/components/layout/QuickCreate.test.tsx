// @vitest-environment happy-dom

import { useState } from 'react'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, useLocation } from 'react-router'

import type {
  ApiProject,
  ApiProjectWorkItemConfiguration,
  ApiWorkItem,
} from '../../api/types'
import { QuickCreate } from './QuickCreate'

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  getProjectWorkItemConfiguration: vi.fn(),
  listProjectMemberships: vi.fn(),
  listProjectWorkItems: vi.fn(),
  createWorkItem: vi.fn(),
  reloadResearchGroups: vi.fn(async () => {}),
  groupsLoading: false,
  groupsError: null as string | null,
  groups: [
    { id: 11, name: 'FG Example', role: 'member' as const },
    { id: 12, name: 'Other Group', role: 'member' as const },
  ],
}))

vi.mock('../../api/projects', () => ({
  listProjects: mocks.listProjects,
  getProjectWorkItemConfiguration: mocks.getProjectWorkItemConfiguration,
  listProjectMemberships: mocks.listProjectMemberships,
}))

vi.mock('../../api/work-items', () => ({
  listProjectWorkItems: mocks.listProjectWorkItems,
  createWorkItem: mocks.createWorkItem,
  createWorkItemComment: vi.fn(),
  deleteWorkItemComment: vi.fn(),
  listWorkItemComments: vi.fn(),
  listWorkItemHistory: vi.fn(),
  updateWorkItemComment: vi.fn(),
}))

vi.mock('../../api/useSession', () => ({
  useSession: () => ({
    user: {
      id: 1,
      username: 'alex',
      firstName: 'Alex',
      lastName: 'Rivera',
      email: 'alex@example.com',
    },
  }),
}))

vi.mock('../../features/research-group/useResearchGroup', () => ({
  useResearchGroup: () => ({
    groups: mocks.groups,
    loading: mocks.groupsLoading,
    error: mocks.groupsError,
    reloadResearchGroups: mocks.reloadResearchGroups,
  }),
}))

const writableProject: ApiProject = {
  id: 7,
  researchGroupId: 11,
  name: 'Writable Project',
  description: '',
  status: 'active',
  archivedAt: null,
  currentUserRole: 'member',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
}

const secondProject: ApiProject = {
  ...writableProject,
  id: 10,
  researchGroupId: 12,
  name: 'Second Project',
  currentUserRole: 'owner',
}

const viewerProject: ApiProject = {
  ...writableProject,
  id: 8,
  name: 'Viewer Project',
  currentUserRole: 'viewer',
}

const archivedProject: ApiProject = {
  ...writableProject,
  id: 9,
  name: 'Archived Project',
  archivedAt: '2026-10-02T00:00:00Z',
}

const configuration: ApiProjectWorkItemConfiguration = {
  types: [
    { id: 41, name: 'Experiment step', kind: 'task', order: 0, active: true },
    { id: 42, name: 'Milestone', kind: 'milestone', order: 1, active: true },
  ],
  statuses: [
    {
      id: 51,
      name: 'Ready',
      category: 'todo',
      order: 0,
      active: true,
      isDefault: true,
    },
  ],
  labels: [],
}

const secondConfiguration: ApiProjectWorkItemConfiguration = {
  types: [
    { id: 61, name: 'Second task', kind: 'task', order: 0, active: true },
  ],
  statuses: [
    {
      id: 71,
      name: 'Planned',
      category: 'todo',
      order: 0,
      active: true,
      isDefault: true,
    },
  ],
  labels: [],
}

const createdWorkItem: ApiWorkItem = {
  id: 99,
  projectId: 7,
  title: 'Global task',
  description: '',
  typeDefinitionId: 41,
  statusDefinitionId: 51,
  boardPosition: 1,
  labelDefinitionIds: [],
  assigneeIds: [],
  parentId: null,
  dueDate: null,
  blockedReason: null,
  completedAt: null,
  createdAt: '2026-10-14T10:00:00Z',
  updatedAt: '2026-10-14T10:00:00Z',
  createdById: 1,
  meetingOrigin: null,
}

function LocationProbe() {
  const location = useLocation()
  return <output aria-label="Current location">{location.pathname}</output>
}

function Harness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <QuickCreate open={open} onOpenChange={setOpen} />
      <LocationProbe />
    </>
  )
}

function renderQuickCreate(path = '/notes') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Harness />
    </MemoryRouter>,
  )
}

async function openActionMenu() {
  fireEvent.click(screen.getByRole('button', { name: /Quick create/ }))
  return screen.findByRole('menu', { name: 'Quick create' })
}

async function openDrawer() {
  const menu = await openActionMenu()
  fireEvent.click(
    within(menu).getByRole('menuitem', { name: /New work item/ }),
  )
  return screen.findByRole('dialog', { name: 'New work item' })
}

function researchGroupSelect() {
  return screen.getByLabelText('Research Group') as HTMLSelectElement
}

function projectSelect() {
  return screen.getByLabelText('Project') as HTMLSelectElement
}

async function selectResearchGroup(name: string) {
  const group = mocks.groups.find((candidate) => candidate.name === name)
  if (!group) throw new Error(`Unknown Research Group: ${name}`)
  fireEvent.change(researchGroupSelect(), {
    target: { value: String(group.id) },
  })
}

async function selectProject(name: string) {
  const select = projectSelect()
  const option = (await within(select).findByRole(
    'option',
    { name },
  )) as HTMLOptionElement
  fireEvent.change(select, { target: { value: option.value } })
}

function checkedOption(select: HTMLSelectElement) {
  return (
    Array.from(select.querySelectorAll('option')).find(
      (option) => option.value === select.value,
    ) ?? null
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.groupsLoading = false
  mocks.groupsError = null
  mocks.groups = [
    { id: 11, name: 'FG Example', role: 'member' },
    { id: 12, name: 'Other Group', role: 'member' },
  ]
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
  mocks.listProjects.mockImplementation(async (groupId: number) =>
    groupId === 11
      ? [writableProject, viewerProject, archivedProject]
      : [secondProject],
  )
  mocks.getProjectWorkItemConfiguration.mockImplementation(
    async (projectId: number) =>
      projectId === 10 ? secondConfiguration : configuration,
  )
  mocks.listProjectMemberships.mockImplementation(async (projectId: number) =>
    projectId === 10
      ? [{
          id: 3,
          role: 'owner',
          addedAt: null,
          user: {
            id: 3,
            username: 'sam',
            firstName: 'Sam',
            lastName: 'Lee',
          },
        }]
      : [
          {
            id: 1,
            role: 'member',
            addedAt: null,
            user: {
              id: 1,
              username: 'alex',
              firstName: 'Alex',
              lastName: 'Rivera',
            },
          },
          {
            id: 2,
            role: 'viewer',
            addedAt: null,
            user: {
              id: 2,
              username: 'viewer',
              firstName: 'Vera',
              lastName: 'Viewer',
            },
          },
        ],
  )
  mocks.listProjectWorkItems.mockImplementation(async (projectId: number) =>
    projectId === 7
      ? [{ ...createdWorkItem, id: 80, title: 'Existing parent' }]
      : [],
  )
  mocks.createWorkItem.mockResolvedValue(createdWorkItem)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('global Work Item Quick Create', () => {
  it('opens the drawer from the header + with both selectors unselected and no Project request', async () => {
    renderQuickCreate()
    const dialog = await openDrawer()

    // Neither context is implicitly selected, and no Project
    // listing is fetched before an explicit Research Group choice.
    expect(checkedOption(researchGroupSelect())?.textContent).toBe(
      'Select research group…',
    )
    expect(projectSelect()).toBeDisabled()
    expect(checkedOption(projectSelect())?.textContent).toBe(
      'Select a Research Group first',
    )
    expect(mocks.listProjects).not.toHaveBeenCalled()
    expect(within(dialog).getByRole('button', { name: 'Create work item' }))
      .toBeDisabled()
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByLabelText('Title')),
    )
  })

  it('opens the same unselected state from the menu W action without an intermediate selector', async () => {
    renderQuickCreate()

    const menu = await openActionMenu()
    const action = within(menu).getByRole('menuitem', {
      name: /New work item/,
    })
    // The visible hint documents the global shortcut (platform label);
    // the in-menu W action stays functional without a visible hint.
    expect(action).toHaveTextContent('⌘⌥K')
    await waitFor(() => expect(document.activeElement).toBe(action))

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    await openActionMenu()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    await openActionMenu()
    fireEvent.keyDown(document, { key: 'w' })

    const dialog = await screen.findByRole('dialog', {
      name: 'New work item',
    })
    expect(checkedOption(researchGroupSelect())?.textContent).toBe(
      'Select research group…',
    )
    expect(checkedOption(projectSelect())?.textContent).toBe(
      'Select a Research Group first',
    )
    expect(screen.queryByRole('menu', { name: 'Select Project' }))
      .not.toBeInTheDocument()
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByLabelText('Title')),
    )
  })

  it('opens the same unselected state on the platform shortcut and ignores repeat, IME, editors, and modal states', async () => {
    renderQuickCreate()

    fireEvent.keyDown(document, {
      key: 'k',
      metaKey: true,
      altKey: true,
      repeat: true,
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    const input = document.createElement('input')
    document.body.append(input)
    fireEvent.keyDown(input, { key: 'k', metaKey: true, altKey: true })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    input.remove()

    fireEvent.keyDown(document, {
      key: 'k',
      metaKey: true,
      altKey: true,
      isComposing: true,
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    const modal = document.createElement('div')
    modal.setAttribute('aria-modal', 'true')
    document.body.append(modal)
    fireEvent.keyDown(document, { key: 'k', metaKey: true, altKey: true })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    modal.remove()

    fireEvent.keyDown(document, { key: 'k', metaKey: true, altKey: true })
    const dialog = await screen.findByRole('dialog', {
      name: 'New work item',
    })
    expect(dialog).toBeVisible()
    // The shortcut skips the Quick Create menu entirely.
    expect(screen.queryByRole('menu', { name: 'Quick create' }))
      .not.toBeInTheDocument()
    expect(checkedOption(researchGroupSelect())?.textContent).toBe(
      'Select research group…',
    )
    expect(checkedOption(projectSelect())?.textContent).toBe(
      'Select a Research Group first',
    )
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByLabelText('Title')),
    )
  })

  it('opens the drawer on the physical KeyK when macOS transforms the Option-key value', async () => {
    renderQuickCreate()

    // macOS Option+K reports `key: '˜'` (tilde) on US-layout
    // keyboards while the physical key remains `code: 'KeyK'`;
    // the shortcut must match the physical key, not the transformed
    // key character.
    fireEvent.keyDown(document, {
      key: '˜',
      code: 'KeyK',
      metaKey: true,
      altKey: true,
    })
    expect(
      await screen.findByRole('dialog', { name: 'New work item' }),
    ).toBeVisible()
  })

  it('opens the drawer on Ctrl+Alt+K on Windows and Linux platforms', async () => {
    vi.restoreAllMocks()
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    renderQuickCreate()

    fireEvent.keyDown(document, { key: 'k', metaKey: true, altKey: true })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'k', ctrlKey: true, altKey: true })
    expect(
      await screen.findByRole('dialog', { name: 'New work item' }),
    ).toBeVisible()
  })

  it('does NOT preselect a Research Group or Project from the current Project route', async () => {
    renderQuickCreate('/projects/7/work-items')
    const dialog = await openDrawer()

    expect(checkedOption(researchGroupSelect())?.textContent).toBe(
      'Select research group…',
    )
    expect(checkedOption(projectSelect())?.textContent).toBe(
      'Select a Research Group first',
    )
    expect(mocks.listProjects).not.toHaveBeenCalled()
    expect(within(dialog).getByRole('button', { name: 'Create work item' }))
      .toBeDisabled()
    expect(screen.getByLabelText('Current location')).toHaveTextContent(
      '/projects/7/work-items',
    )
  })

  it('selecting a Research Group exposes only that group\'s writable active Projects without picking one', async () => {
    renderQuickCreate('/notes')
    await openDrawer()

    await selectResearchGroup('FG Example')
    expect(mocks.listProjects).toHaveBeenCalledWith(11)

    const select = projectSelect()
    await waitFor(() => expect(select).toBeEnabled())
    const optionNames = Array.from(
      select.querySelectorAll('option'),
    ).map((option) => option.textContent)

    expect(optionNames).toContain('Writable Project')
    // Viewer / archived Projects are not eligible…
    expect(optionNames).not.toContain('Viewer Project')
    expect(optionNames).not.toContain('Archived Project')
    // …and Projects of other Research Groups never appear.
    expect(optionNames).not.toContain('Second Project')

    // Selecting the group never implicitly chooses a Project.
    expect(checkedOption(select)?.textContent).toBe('Select project…')
    expect(
      screen.getByRole('button', { name: 'Create work item' }),
    ).toBeDisabled()
  })

  it('switching to another Research Group clears the previously selected Project', async () => {
    renderQuickCreate('/notes')
    const dialog = await openDrawer()
    await selectResearchGroup('FG Example')
    await selectProject('Writable Project')
    await waitFor(() =>
      expect(
        within(dialog).getByRole('radio', { name: 'Experiment step' }),
      ).toBeChecked(),
    )

    await selectResearchGroup('Other Group')

    await waitFor(() =>
      expect(checkedOption(projectSelect())?.textContent).toBe(
        'Select project…',
      ),
    )
    expect(mocks.listProjects).toHaveBeenLastCalledWith(12)
    expect(
      within(dialog).queryByRole('radio', { name: 'Experiment step' }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Create work item' }),
    ).toBeDisabled()

    await selectProject('Second Project')
    await waitFor(() =>
      expect(
        within(dialog).getByRole('radio', { name: 'Second task' }),
      ).toBeChecked(),
    )
  })

  it('selecting a Project loads its configuration and defaults to its canonical Task', async () => {
    renderQuickCreate('/notes')
    const dialog = await openDrawer()
    await selectResearchGroup('Other Group')
    await selectProject('Second Project')

    // Project B's own configuration is loaded and its canonical
    // Task (kind === 'task') is the default type.
    expect(mocks.getProjectWorkItemConfiguration).toHaveBeenCalledWith(10)
    await waitFor(() =>
      expect(
        within(dialog).getByRole('radio', { name: 'Second task' }),
      ).toBeChecked(),
    )
    expect(
      within(dialog).queryByRole('radio', { name: 'Milestone' }),
    ).not.toBeInTheDocument()
    expect(
      within(dialog).getByRole('button', { name: 'Create work item' }),
    ).toBeDisabled()

    // …and a Title unlocks creation in Project B.
    fireEvent.change(within(dialog).getByLabelText('Title'), {
      target: { value: 'A task in B' },
    })
    expect(
      within(dialog).getByRole('button', { name: 'Create work item' }),
    ).toBeEnabled()
  })

  it('preserves Title/Description across context changes but resets Project-specific selections', async () => {
    renderQuickCreate('/notes')
    const dialog = await openDrawer()
    await selectResearchGroup('FG Example')
    await selectProject('Writable Project')
    await waitFor(() =>
      expect(
        within(dialog).getByRole('radio', { name: 'Experiment step' }),
      ).toBeChecked(),
    )

    fireEvent.change(within(dialog).getByLabelText('Title'), {
      target: { value: 'Preserved title' },
    })
    fireEvent.change(within(dialog).getByLabelText(/Description/), {
      target: { value: 'Preserved description' },
    })
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Milestone' }))
    fireEvent.change(within(dialog).getByLabelText(/Parent/), {
      target: { value: '80' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add assignee…' }))
    fireEvent.click(
      within(dialog).getByRole('checkbox', { name: /Alex Rivera/ }),
    )

    // Context change: new Research Group → new Project.
    await selectResearchGroup('Other Group')
    await selectProject('Second Project')

    await waitFor(() =>
      expect(
        within(dialog).getByRole('radio', { name: 'Second task' }),
      ).toBeChecked(),
    )
    expect(within(dialog).getByLabelText('Title')).toHaveValue('Preserved title')
    expect(within(dialog).getByLabelText(/Description/)).toHaveValue(
      'Preserved description',
    )
    // Project-bound state did not survive the switch.
    expect(within(dialog).getByLabelText(/Parent/)).toHaveValue('')
    expect(within(dialog).queryByText('Alex Rivera')).not.toBeInTheDocument()
    expect(
      within(dialog).queryByRole('radio', { name: 'Milestone' }),
    ).not.toBeInTheDocument()
  })

  it('ignores a delayed Project A context response after switching to Project B', async () => {
    let resolveFirst:
      | ((value: ApiProjectWorkItemConfiguration) => void)
      | undefined
    mocks.getProjectWorkItemConfiguration.mockImplementation(
      (projectId: number) =>
        projectId === 7
          ? new Promise<ApiProjectWorkItemConfiguration>((resolve) => {
              resolveFirst = resolve
            })
          : Promise.resolve(secondConfiguration),
    )

    renderQuickCreate()
    const dialog = await openDrawer()
    await selectResearchGroup('FG Example')
    await selectProject('Writable Project')

    // Switch Research Groups while Project A's context is pending.
    await selectResearchGroup('Other Group')
    await selectProject('Second Project')
    await waitFor(() =>
      expect(
        within(dialog).getByRole('radio', { name: 'Second task' }),
      ).toBeChecked(),
    )
    expect(checkedOption(projectSelect())?.value).toBe('10')

    // Project A's delayed response must be a strict no-op.
    await act(async () => resolveFirst?.(configuration))
    expect(
      within(dialog).getByRole('radio', { name: 'Second task' }),
    ).toBeChecked()
    expect(
      within(dialog).queryByRole('radio', { name: 'Experiment step' }),
    ).not.toBeInTheDocument()
    expect(checkedOption(projectSelect())?.value).toBe('10')
  })

  it('ignores a delayed Research Group A project listing after switching to Research Group B', async () => {
    let resolveFirst: ((value: ApiProject[]) => void) | undefined
    mocks.listProjects.mockImplementation((groupId: number) =>
      groupId === 11
        ? new Promise<ApiProject[]>((resolve) => {
            resolveFirst = resolve
          })
        : Promise.resolve([secondProject]),
    )

    renderQuickCreate()
    await openDrawer()
    await selectResearchGroup('FG Example')
    await selectResearchGroup('Other Group')
    await selectProject('Second Project')
    await waitFor(() =>
      expect(checkedOption(projectSelect())?.value).toBe('10'),
    )

    // Research Group A's delayed listing must be a strict no-op.
    await act(async () => resolveFirst?.([writableProject]))
    expect(checkedOption(researchGroupSelect())?.value).toBe('12')
    const optionNames = Array.from(
      projectSelect().querySelectorAll('option'),
    ).map((option) => option.textContent)
    expect(optionNames).not.toContain('Writable Project')
  })

  it('creation is impossible before a valid context exists and possible once it does', async () => {
    renderQuickCreate('/notes')
    const dialog = await openDrawer()
    const createButton = within(dialog).getByRole('button', {
      name: 'Create work item',
    })

    // A Title alone never unlocks creation…
    fireEvent.change(within(dialog).getByLabelText('Title'), {
      target: { value: 'No context yet' },
    })
    expect(createButton).toBeDisabled()

    await selectResearchGroup('FG Example')
    expect(createButton).toBeDisabled()

    await selectProject('Writable Project')
    await waitFor(() => expect(createButton).toBeEnabled())
  })

  it('creates exactly once in the explicitly selected Project and invalidates without navigating', async () => {
    const createdEvents: Event[] = []
    const listener = (event: Event) => createdEvents.push(event)
    window.addEventListener('fg-workspace:work-item-created', listener)

    const dialog = await (renderQuickCreate('/notes'), openDrawer())
    await selectResearchGroup('FG Example')
    await selectProject('Writable Project')
    await waitFor(() =>
      expect(
        within(dialog).getByRole('radio', { name: 'Experiment step' }),
      ).toBeChecked(),
    )
    expect(within(dialog).queryByText('Vera Viewer')).not.toBeInTheDocument()

    fireEvent.change(within(dialog).getByLabelText('Title'), {
      target: { value: 'Global task' },
    })
    const createButton = within(dialog).getByRole('button', {
      name: 'Create work item',
    })
    fireEvent.click(createButton)
    fireEvent.click(createButton)

    await waitFor(() => expect(mocks.createWorkItem).toHaveBeenCalledTimes(1))
    expect(mocks.createWorkItem).toHaveBeenCalledWith(7, {
      typeDefinitionId: 41,
      title: 'Global task',
      description: '',
      statusDefinitionId: 51,
    })
    expect(createdEvents).toHaveLength(1)
    expect(
      await screen.findByText('Work item created in Writable Project.'),
    ).toBeVisible()
    expect(screen.getByLabelText('Current location')).toHaveTextContent('/notes')

    window.removeEventListener('fg-workspace:work-item-created', listener)
  })

  it('closes and reopens with both context selections reset', async () => {
    renderQuickCreate('/notes')
    const dialog = await openDrawer()
    await selectResearchGroup('FG Example')
    await selectProject('Writable Project')
    fireEvent.change(within(dialog).getByLabelText('Title'), {
      target: { value: 'Draft from first session' },
    })

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Cancel' }),
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    const reopened = await openDrawer()
    expect(checkedOption(researchGroupSelect())?.textContent).toBe(
      'Select research group…',
    )
    expect(checkedOption(projectSelect())?.textContent).toBe(
      'Select a Research Group first',
    )
    expect(within(reopened).getByLabelText('Title')).toHaveValue('')
    expect(
      within(reopened).getByRole('button', { name: 'Create work item' }),
    ).toBeDisabled()
  })

  it('shows a loading state and recovers when the drawer opens before Research Groups are ready', async () => {
    mocks.groupsLoading = true
    const view = renderQuickCreate()

    await openDrawer()
    expect(researchGroupSelect()).toBeDisabled()
    expect(checkedOption(researchGroupSelect())?.textContent).toBe(
      'Loading research groups…',
    )

    mocks.groupsLoading = false
    view.rerender(
      <MemoryRouter initialEntries={['/notes']}>
        <Harness />
      </MemoryRouter>,
    )

    await waitFor(() => expect(researchGroupSelect()).toBeEnabled())
    expect(
      within(researchGroupSelect()).getByRole('option', {
        name: 'FG Example',
      }),
    ).toBeVisible()
    // Still no implicit selection and no Project request.
    expect(checkedOption(projectSelect())?.textContent).toBe(
      'Select a Research Group first',
    )
    expect(mocks.listProjects).not.toHaveBeenCalled()
  })

  it('shows an empty Research Group state without guessing context', async () => {
    mocks.groups = []
    renderQuickCreate('/settings/appearance')
    const dialog = await openDrawer()

    expect(researchGroupSelect()).toBeDisabled()
    expect(checkedOption(researchGroupSelect())?.textContent).toBe(
      'No Research Groups',
    )
    expect(
      within(dialog).getByRole('button', { name: 'Create work item' }),
    ).toBeDisabled()
    expect(mocks.listProjects).not.toHaveBeenCalled()
  })

  it('shows a Research Group error with Retry and recovers', async () => {
    mocks.groupsError = 'Groups unavailable'
    const view = renderQuickCreate('/notes')
    const dialog = await openDrawer()

    expect(researchGroupSelect()).toBeDisabled()
    expect(checkedOption(researchGroupSelect())?.textContent).toBe(
      'Research groups unavailable',
    )
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Groups unavailable',
    )

    fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }))
    expect(mocks.reloadResearchGroups).toHaveBeenCalledTimes(1)

    mocks.groupsError = null
    view.rerender(
      <MemoryRouter initialEntries={['/notes']}>
        <Harness />
      </MemoryRouter>,
    )
    await waitFor(() => expect(researchGroupSelect()).toBeEnabled())
    expect(
      within(researchGroupSelect()).getByRole('option', {
        name: 'FG Example',
      }),
    ).toBeVisible()
  })

  it('keeps the selected Research Group visible (never substituted) when it becomes unavailable', async () => {
    const view = renderQuickCreate('/notes')
    const dialog = await openDrawer()
    await selectResearchGroup('FG Example')
    await waitFor(() => expect(projectSelect()).toBeEnabled())

    // The group disappears from the authenticated membership.
    mocks.groups = [
      { id: 12, name: 'Other Group', role: 'member' },
    ]
    view.rerender(
      <MemoryRouter initialEntries={['/notes']}>
        <Harness />
      </MemoryRouter>,
    )

    // The stale selection stays visible and selectable context is
    // gone — no other Research Group is implicitly chosen.
    expect(checkedOption(researchGroupSelect())?.textContent).toBe(
      'FG Example',
    )
    expect(checkedOption(researchGroupSelect())?.disabled).toBe(true)
    expect(
      within(dialog).getByRole('alert'),
    ).toHaveTextContent('The selected Research Group is no longer available.')
    expect(projectSelect()).toBeDisabled()
    expect(
      within(dialog).getByRole('button', { name: 'Create work item' }),
    ).toBeDisabled()
  })

  it('restores usable Project selection after a failed Research Group reload is retried successfully', async () => {
    // Project A's context request is deferred so the response in
    // flight at the moment the reload fails can be held back as a
    // stale candidate for the recovery assertions.
    let resolveProjectAContext:
      | ((value: ApiProjectWorkItemConfiguration) => void)
      | undefined
    mocks.getProjectWorkItemConfiguration.mockImplementation(
      (projectId: number) => {
        if (projectId === 7 && resolveProjectAContext === undefined) {
          return new Promise<ApiProjectWorkItemConfiguration>(
            (resolve) => {
              resolveProjectAContext = resolve
            },
          )
        }
        return projectId === 10
          ? secondConfiguration
          : configuration
      },
    )

    const view = renderQuickCreate('/notes')
    const dialog = await openDrawer()

    // The Work Item draft is entered before any context exists and
    // must survive the whole failure/recovery sequence.
    fireEvent.change(within(dialog).getByLabelText('Title'), {
      target: { value: 'Surviving title' },
    })
    fireEvent.change(within(dialog).getByLabelText(/Description/), {
      target: { value: 'Surviving description' },
    })

    // Research Group A and Project A are initially selected.
    await selectResearchGroup('FG Example')
    await selectProject('Writable Project')
    expect(checkedOption(researchGroupSelect())?.textContent).toBe(
      'FG Example',
    )
    expect(checkedOption(projectSelect())?.textContent).toBe(
      'Writable Project',
    )

    // The provider's reload fails: the group list becomes empty
    // and the failure is surfaced.
    mocks.groups = []
    mocks.groupsError = 'Research groups could not be loaded'
    view.rerender(
      <MemoryRouter initialEntries={['/notes']}>
        <Harness />
      </MemoryRouter>,
    )

    // Project A is invalidated and creation is impossible; the
    // last known Research Group name stays visible — no other
    // group is silently substituted.
    expect(checkedOption(researchGroupSelect())?.textContent).toBe(
      'FG Example',
    )
    expect(checkedOption(researchGroupSelect())?.disabled).toBe(true)
    expect(researchGroupSelect()).toBeDisabled()
    expect(projectSelect()).toBeDisabled()
    expect(checkedOption(projectSelect())?.textContent).toBe(
      'Select project…',
    )
    expect(
      within(dialog).getByRole('button', { name: 'Create work item' }),
    ).toBeDisabled()
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Research groups could not be loaded',
    )

    // The retry restores Group A.
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Try again' }),
    )
    expect(mocks.reloadResearchGroups).toHaveBeenCalledTimes(1)
    mocks.groups = [
      { id: 11, name: 'FG Example', role: 'member' },
      { id: 12, name: 'Other Group', role: 'member' },
    ]
    mocks.groupsError = null
    view.rerender(
      <MemoryRouter initialEntries={['/notes']}>
        <Harness />
      </MemoryRouter>,
    )

    // Only Group A's eligible Projects are loaded again — and NO
    // Project is selected automatically.
    expect(mocks.listProjects).toHaveBeenCalledTimes(2)
    expect(mocks.listProjects).toHaveBeenLastCalledWith(11)
    await waitFor(() => expect(projectSelect()).toBeEnabled())
    expect(researchGroupSelect()).toBeEnabled()
    expect(checkedOption(researchGroupSelect())?.textContent).toBe(
      'FG Example',
    )
    expect(checkedOption(projectSelect())?.textContent).toBe(
      'Select project…',
    )
    expect(
      within(dialog).getByRole('button', { name: 'Create work item' }),
    ).toBeDisabled()

    // The stale Project A context response from before the
    // failure is a strict no-op: it neither resurrects the old
    // context nor auto-selects Project A.
    await act(async () => resolveProjectAContext?.(configuration))
    expect(checkedOption(projectSelect())?.textContent).toBe(
      'Select project…',
    )
    expect(
      within(dialog).queryByRole('radio', { name: 'Experiment step' }),
    ).not.toBeInTheDocument()
    expect(
      within(dialog).getByRole('button', { name: 'Create work item' }),
    ).toBeDisabled()

    // Explicitly choosing Project A again restores its canonical
    // Task default and re-enables creation.
    await selectProject('Writable Project')
    await waitFor(() =>
      expect(
        within(dialog).getByRole('radio', { name: 'Experiment step' }),
      ).toBeChecked(),
    )
    expect(
      within(dialog).getByRole('button', { name: 'Create work item' }),
    ).toBeEnabled()

    // The draft survived the entire sequence.
    expect(within(dialog).getByLabelText('Title')).toHaveValue(
      'Surviving title',
    )
    expect(within(dialog).getByLabelText(/Description/)).toHaveValue(
      'Surviving description',
    )
  })

  it('keeps a permanently unavailable Research Group blocked without substituting or re-requesting', async () => {
    const view = renderQuickCreate('/notes')
    const dialog = await openDrawer()
    await selectResearchGroup('FG Example')
    await waitFor(() => expect(projectSelect()).toBeEnabled())
    expect(mocks.listProjects).toHaveBeenCalledTimes(1)

    // A failed reload empties the group list.
    mocks.groups = []
    mocks.groupsError = 'Research groups could not be loaded'
    view.rerender(
      <MemoryRouter initialEntries={['/notes']}>
        <Harness />
      </MemoryRouter>,
    )

    expect(checkedOption(researchGroupSelect())?.textContent).toBe(
      'FG Example',
    )
    expect(projectSelect()).toBeDisabled()
    expect(
      within(dialog).getByRole('button', { name: 'Create work item' }),
    ).toBeDisabled()

    // A retry that fails again does NOT substitute another group,
    // does NOT select a Project, and does NOT issue another
    // Project request.
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Try again' }),
    )
    expect(mocks.reloadResearchGroups).toHaveBeenCalledTimes(1)
    mocks.groups = []
    view.rerender(
      <MemoryRouter initialEntries={['/notes']}>
        <Harness />
      </MemoryRouter>,
    )

    expect(checkedOption(researchGroupSelect())?.textContent).toBe(
      'FG Example',
    )
    expect(researchGroupSelect()).toBeDisabled()
    expect(projectSelect()).toBeDisabled()
    expect(checkedOption(projectSelect())?.textContent).toBe(
      'Select project…',
    )
    expect(
      within(dialog).queryByRole('option', { name: 'Other Group' }),
    ).not.toBeInTheDocument()
    expect(mocks.listProjects).toHaveBeenCalledTimes(1)
    expect(
      within(dialog).getByRole('button', { name: 'Create work item' }),
    ).toBeDisabled()
  })

  it('does not repeat Project requests on a harmless Research Group list refresh', async () => {
    const view = renderQuickCreate('/notes')
    const dialog = await openDrawer()
    await selectResearchGroup('FG Example')
    await selectProject('Writable Project')
    await waitFor(() =>
      expect(
        within(dialog).getByRole('radio', { name: 'Experiment step' }),
      ).toBeChecked(),
    )
    expect(mocks.listProjects).toHaveBeenCalledTimes(1)

    // A successful provider refresh produces a NEW groups array
    // with the SAME membership — no availability transition.
    mocks.groups = [
      { id: 11, name: 'FG Example', role: 'member' },
      { id: 12, name: 'Other Group', role: 'member' },
    ]
    view.rerender(
      <MemoryRouter initialEntries={['/notes']}>
        <Harness />
      </MemoryRouter>,
    )

    // Selection and loaded context are untouched and no repeated
    // Project listing request is issued.
    expect(checkedOption(researchGroupSelect())?.textContent).toBe(
      'FG Example',
    )
    expect(checkedOption(projectSelect())?.textContent).toBe(
      'Writable Project',
    )
    expect(
      within(dialog).getByRole('radio', { name: 'Experiment step' }),
    ).toBeChecked()
    expect(mocks.listProjects).toHaveBeenCalledTimes(1)
  })

  it('shows a missing-writable-Projects state for a selected Research Group', async () => {
    mocks.listProjects.mockResolvedValue([viewerProject, archivedProject])
    renderQuickCreate('/notes')
    const dialog = await openDrawer()

    await selectResearchGroup('FG Example')
    await waitFor(() =>
      expect(checkedOption(projectSelect())?.textContent).toBe(
        'No writable Projects',
      ),
    )
    expect(projectSelect()).toBeDisabled()
    expect(within(dialog).getByText(/owner or member access/)).toBeVisible()
    expect(mocks.getProjectWorkItemConfiguration).not.toHaveBeenCalled()
  })

  it('shows a Project listing failure with Retry and recovers', async () => {
    let shouldFail = true
    mocks.listProjects.mockImplementation(async (groupId: number) => {
      if (shouldFail && groupId === 11) {
        throw new Error('Access unavailable')
      }
      return groupId === 11
        ? [writableProject]
        : [secondProject]
    })

    renderQuickCreate('/notes')
    const dialog = await openDrawer()
    await selectResearchGroup('FG Example')

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Access unavailable',
    )
    expect(projectSelect()).toBeDisabled()
    expect(mocks.getProjectWorkItemConfiguration).not.toHaveBeenCalled()

    shouldFail = false
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(projectSelect()).toBeEnabled())
    expect(
      within(projectSelect()).getByRole('option', {
        name: 'Writable Project',
      }),
    ).toBeVisible()
  })

  it('keeps entered values and the drawer open after a submission error', async () => {
    mocks.createWorkItem.mockRejectedValueOnce(
      new Error('Your Project access changed.'),
    )
    renderQuickCreate('/notes')
    const dialog = await openDrawer()
    await selectResearchGroup('FG Example')
    await selectProject('Writable Project')
    await waitFor(() =>
      expect(
        within(dialog).getByRole('radio', { name: 'Experiment step' }),
      ).toBeChecked(),
    )

    const title = within(dialog).getByLabelText('Title')
    fireEvent.change(title, { target: { value: 'Keep this draft' } })
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Create work item' }),
    )

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Your Project access changed.',
    )
    expect(title).toHaveValue('Keep this draft')
    expect(dialog).toBeVisible()
  })
})
