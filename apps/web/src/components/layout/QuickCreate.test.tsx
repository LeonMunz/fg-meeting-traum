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
  groupsLoading: false,
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
    error: null,
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

async function selectProject(name = 'Writable Project') {
  const trigger = screen.getByRole('button', { name: 'Select project' })
  fireEvent.click(trigger)
  const listbox = await screen.findByRole('listbox', { name: 'Projects' })
  fireEvent.click(within(listbox).getByRole('option', { name }))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.groupsLoading = false
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
  it('finishes loading Projects when the drawer opens before Research Groups are ready', async () => {
    mocks.groupsLoading = true
    const view = renderQuickCreate()

    const dialog = await openDrawer()
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Select project' }),
    )
    const listbox = await screen.findByRole('listbox', { name: 'Projects' })
    expect(within(listbox).getByText('Loading Projects…')).toBeVisible()

    mocks.groupsLoading = false
    view.rerender(
      <MemoryRouter initialEntries={['/notes']}>
        <Harness />
      </MemoryRouter>,
    )

    expect(
      await within(listbox).findByRole('option', {
        name: 'Writable Project',
      }),
    ).toBeVisible()
  })

  it('opens the drawer directly from the menu and W without an intermediate selector', async () => {
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
    expect(
      within(dialog).getByRole('button', { name: 'Select project' }),
    ).toHaveTextContent('Select project…')
    expect(screen.queryByRole('menu', { name: 'Select Project' }))
      .not.toBeInTheDocument()
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByLabelText('Title')),
    )
  })

  it('opens the drawer directly on the platform shortcut and ignores repeat, IME, editors, and modal states', async () => {
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

  it('opens the drawer with Ctrl+Alt+K on Windows and Linux platforms', async () => {
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

  it('selects only writable active Projects in the searchable grouped header picker and creates once', async () => {
    const createdEvents: Event[] = []
    const listener = (event: Event) => createdEvents.push(event)
    window.addEventListener('fg-workspace:work-item-created', listener)

    const dialog = await (renderQuickCreate('/notes'), openDrawer())
    const createButton = within(dialog).getByRole('button', {
      name: 'Create work item',
    })
    expect(createButton).toBeDisabled()

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Select project' }),
    )
    const listbox = await screen.findByRole('listbox', { name: 'Projects' })
    await waitFor(() =>
      expect(
        within(listbox).getByRole('group', { name: 'FG Example' }),
      ).toBeVisible(),
    )
    expect(
      within(listbox).getByRole('group', { name: 'Other Group' }),
    ).toBeVisible()
    expect(within(listbox).queryByText('Viewer Project')).not.toBeInTheDocument()
    expect(within(listbox).queryByText('Archived Project')).not.toBeInTheDocument()

    const search = screen.getByLabelText('Search projects')
    fireEvent.change(search, { target: { value: 'writable' } })
    expect(
      within(listbox).getByRole('option', { name: 'Writable Project' }),
    ).toBeVisible()
    expect(
      within(listbox).queryByRole('option', { name: 'Second Project' }),
    ).not.toBeInTheDocument()

    fireEvent.click(
      within(listbox).getByRole('option', { name: 'Writable Project' }),
    )
    await waitFor(() =>
      expect(within(dialog).getByText('Experiment step')).toBeVisible(),
    )
    expect(within(dialog).queryByText('Vera Viewer')).not.toBeInTheDocument()

    fireEvent.change(within(dialog).getByLabelText('Title'), {
      target: { value: 'Global task' },
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

  it('preselects a writable Project route while keeping the header picker available', async () => {
    renderQuickCreate('/projects/7/work-items')
    const dialog = await openDrawer()

    await waitFor(() =>
      expect(
        within(dialog).getByRole('button', { name: 'Select project' }),
      ).toHaveTextContent('Writable Project'),
    )
    expect(screen.getByLabelText('Current location')).toHaveTextContent(
      '/projects/7/work-items',
    )
  })

  it('preserves title and description and resets Project-specific values when switching', async () => {
    renderQuickCreate('/notes')
    const dialog = await openDrawer()
    await selectProject('Writable Project')
    await waitFor(() =>
      expect(within(dialog).getByText('Experiment step')).toBeVisible(),
    )

    fireEvent.change(within(dialog).getByLabelText('Title'), {
      target: { value: 'Preserved title' },
    })
    fireEvent.change(within(dialog).getByLabelText(/Description/), {
      target: { value: 'Preserved description' },
    })
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Milestone' }))
    fireEvent.change(within(dialog).getByLabelText('Parent'), {
      target: { value: '80' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add assignee…' }))
    fireEvent.click(
      within(dialog).getByRole('checkbox', { name: /Alex Rivera/ }),
    )

    await selectProject('Second Project')

    await waitFor(() =>
      expect(within(dialog).getByText('Second task')).toBeVisible(),
    )
    expect(within(dialog).getByLabelText('Title')).toHaveValue('Preserved title')
    expect(within(dialog).getByLabelText(/Description/)).toHaveValue(
      'Preserved description',
    )
    await waitFor(() =>
      expect(within(dialog).getByRole('radio', { name: 'Second task' }))
        .toBeChecked(),
    )
    expect(within(dialog).getByLabelText('Parent')).toHaveValue('')
    expect(within(dialog).queryByText('Alex Rivera')).not.toBeInTheDocument()
  })

  it('operates the header picker by keyboard and dismisses it before the drawer', async () => {
    renderQuickCreate()
    const dialog = await openDrawer()
    const trigger = within(dialog).getByRole('button', {
      name: 'Select project',
    })

    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(
      await screen.findByRole('listbox', { name: 'Projects' }),
    ).toBeVisible()
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText('Search projects')),
    )
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' })
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('option', { name: 'Writable Project' }),
      ),
    )

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: 'Projects' }))
      .not.toBeInTheDocument()
    expect(dialog).toBeVisible()
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('shows empty and loading-failure states inside the drawer picker without guessing context', async () => {
    mocks.listProjects.mockResolvedValue([viewerProject, archivedProject])
    renderQuickCreate('/settings/appearance')
    const dialog = await openDrawer()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Select project' }))
    expect(await screen.findByText('No writable Projects')).toBeVisible()
    expect(mocks.getProjectWorkItemConfiguration).not.toHaveBeenCalled()
    cleanup()

    mocks.listProjects.mockRejectedValue(new Error('Access unavailable'))
    renderQuickCreate('/projects/7/work-items')
    const failedDialog = await openDrawer()
    fireEvent.click(
      within(failedDialog).getByRole('button', { name: 'Select project' }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Access unavailable',
    )
    expect(mocks.getProjectWorkItemConfiguration).not.toHaveBeenCalled()
  })

  it('keeps entered values and the drawer open after a submission error', async () => {
    mocks.createWorkItem.mockRejectedValueOnce(
      new Error('Your Project access changed.'),
    )
    renderQuickCreate('/projects/7/work-items')
    const dialog = await openDrawer()
    await waitFor(() =>
      expect(within(dialog).getByText('Experiment step')).toBeVisible(),
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

  it('ignores a stale Project context response after switching Projects', async () => {
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
    await selectProject('Writable Project')
    await selectProject('Second Project')
    await waitFor(() =>
      expect(within(dialog).getByText('Second task')).toBeVisible(),
    )

    await act(async () => resolveFirst?.(configuration))
    expect(within(dialog).getByText('Second task')).toBeVisible()
    expect(within(dialog).queryByText('Experiment step')).not.toBeInTheDocument()
  })
})
