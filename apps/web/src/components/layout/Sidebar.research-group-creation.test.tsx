// @vitest-environment happy-dom
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
import { MemoryRouter } from 'react-router'

import { fetchWorkspaceNavigationPreferences } from '../../api/workspace-navigation-preferences'
import { createResearchGroup } from '../../api/research-groups'
import type {
  ApiResearchGroup,
  ApiWorkspaceNavigationPreferences,
} from '../../api/types'
import type { ResearchGroupContextValue } from '../../features/research-group/ResearchGroupContext'
import { useResearchGroup } from '../../features/research-group/useResearchGroup'

import { Sidebar } from './Sidebar'

/*
 * Parent render boundary: the real Sidebar (including its
 * zero-group / creation entries and the real
 * CreateResearchGroupDialog) is rendered; only the canonical
 * context hook, the create API, and the preference API are mocked.
 */
vi.mock('../../features/research-group/useResearchGroup', () => ({
  useResearchGroup: vi.fn(),
}))

vi.mock('../../api/research-groups', () => ({
  createResearchGroup: vi.fn(),
}))

vi.mock('../../api/workspace-navigation-preferences', () => ({
  fetchWorkspaceNavigationPreferences: vi.fn(),
  updateWorkspaceNavigationPreferences: vi.fn(),
}))

const GROUP: ApiResearchGroup = {
  id: 17,
  name: 'Existing Group',
  role: 'member',
}

function preferences(
  groupId?: number,
): ApiWorkspaceNavigationPreferences {
  return {
    researchGroupOrder: groupId != null ? [groupId] : [],
    expandedResearchGroups: [],
    expandedProjectSections: [],
  }
}

function contextValue(
  overrides: Partial<ResearchGroupContextValue> = {},
): ResearchGroupContextValue {
  return {
    groups: [GROUP],
    activeResearchGroupId: GROUP.id,
    activeResearchGroup: GROUP,
    loading: false,
    error: null,
    setActiveResearchGroupId: vi.fn(),
    reloadResearchGroups: vi.fn(),
    addResearchGroup: vi.fn(),
    ...overrides,
  }
}

function renderSidebar(value: ResearchGroupContextValue) {
  vi.mocked(useResearchGroup).mockReturnValue(value)

  return render(
    <MemoryRouter initialEntries={['/']}>
      <Sidebar />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(createResearchGroup as ReturnType<typeof vi.fn>).mockReset()

  vi.mocked(fetchWorkspaceNavigationPreferences).mockResolvedValue(
    preferences(),
  )
})

afterEach(() => {
  cleanup()
})

describe('Sidebar Research Group area (parent render boundary)', () => {
  it('does not show the zero-group entry while groups are still loading', () => {
    renderSidebar(
      contextValue({
        groups: [],
        activeResearchGroupId: null,
        activeResearchGroup: null,
        loading: true,
      }),
    )

    // The area stays mounted with the zone's own loading state…
    expect(screen.getByText('Loading…')).toBeVisible()
    // …and never presents a false zero-group creation entry.
    expect(
      screen.queryByRole('button', {
        name: 'New research group',
      }),
    ).toBeNull()
  })

  it('shows the first-group entry once loading resolved with zero groups', async () => {
    vi.mocked(fetchWorkspaceNavigationPreferences).mockResolvedValue(
      preferences(),
    )

    renderSidebar(
      contextValue({
        groups: [],
        activeResearchGroupId: null,
        activeResearchGroup: null,
      }),
    )

    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: 'New research group',
        }),
      ).toBeVisible()
    })

    // No groups yet, so no workspace tree is shown.
    expect(
      screen.queryByRole('navigation', {
        name: 'Research groups',
      }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', {
        name: 'Create research group',
      }),
    ).toBeNull()
  })

  it('does not present a false zero-group state when the group list fails to load', async () => {
    renderSidebar(
      contextValue({
        groups: [],
        activeResearchGroupId: null,
        activeResearchGroup: null,
        error: 'Failed to load research groups.',
      }),
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
    })

    expect(
      screen.queryByRole('button', {
        name: 'New research group',
      }),
    ).toBeNull()
  })

  it('opens the existing creation dialog from the zero-group entry', async () => {
    ;(createResearchGroup as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 42,
      name: 'Brand New',
      role: 'admin',
    })

    renderSidebar(
      contextValue({
        groups: [],
        activeResearchGroupId: null,
        activeResearchGroup: null,
      }),
    )

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'New research group',
      }),
    )

    expect(
      screen.getByRole('dialog', {
        name: 'Create research group',
      }),
    ).toBeVisible()
  })

  it('transitions from the zero-group entry into the workspace tree after a successful first creation', async () => {
    const created: ApiResearchGroup = {
      id: 42,
      name: 'Brand New',
      role: 'admin',
    }
    ;(createResearchGroup as ReturnType<typeof vi.fn>).mockResolvedValue(
      created,
    )

    const value = contextValue({
      groups: [],
      activeResearchGroupId: null,
      activeResearchGroup: null,
    })
    const { rerender } = renderSidebar(value)

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'New research group',
      }),
    )

    fireEvent.change(screen.getByLabelText('Research group name'), {
      target: { value: 'Brand New' },
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Create research group',
      }),
    )

    // The exact server-serialized group is handed to the canonical
    // state; nothing is fabricated client-side.
    const addResearchGroup =
      value.addResearchGroup as ReturnType<typeof vi.fn>
    await waitFor(() => {
      expect(addResearchGroup).toHaveBeenCalledTimes(1)
    })
    expect(addResearchGroup).toHaveBeenCalledWith(created)
    expect(addResearchGroup.mock.calls[0][0]).toBe(created)

    // The provider state now holds the created group (as it would
    // after addResearchGroup runs); the Sidebar boundary renders
    // the workspace tree instead of the zero-group entry.
    Object.assign(value, {
      groups: [created],
      activeResearchGroupId: created.id,
      activeResearchGroup: created,
    })
    rerender(
      <MemoryRouter initialEntries={['/']}>
        <Sidebar />
      </MemoryRouter>,
    )

    expect(
      screen.queryByRole('button', {
        name: 'New research group',
      }),
    ).toBeNull()

    // The created group is a tree row with its own disclosure
    // control…
    expect(
      screen.getByRole('button', {
        name: 'Brand New',
      }),
    ).toBeVisible()
    expect(
      screen.getByRole('button', {
        name: 'Expand Brand New',
      }),
    ).toBeVisible()

    // …and group-scoped navigation is available once the row is
    // expanded (the new hierarchy contract).
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Expand Brand New',
      }),
    )
    expect(
      screen.getByRole('link', { name: 'Projects' }),
    ).toHaveAttribute('href', '/projects?group=42')
  })

  it('keeps a Create research group entry for users with groups', async () => {
    renderSidebar(contextValue())

    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: 'Create research group',
        }),
      ).toBeVisible()
    })

    // The workspace tree is rendered alongside the entry.
    expect(
      screen.getByRole('navigation', {
        name: 'Research groups',
      }),
    ).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Existing Group' }),
    ).toBeVisible()

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Create research group',
      }),
    )

    expect(
      screen.getByRole('dialog', {
        name: 'Create research group',
      }),
    ).toBeVisible()
  })
})
