// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
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
import { MemoryRouter } from 'react-router'

import { createResearchGroup } from '../../api/research-groups'
import type { ApiResearchGroup } from '../../api/types'
import type { ResearchGroupContextValue } from '../../features/research-group/ResearchGroupContext'
import { useResearchGroup } from '../../features/research-group/useResearchGroup'

import { Sidebar } from './Sidebar'

/*
 * Parent render boundary: the real Sidebar and the real
 * ResearchGroupSelector / CreateResearchGroupDialog are rendered;
 * only the canonical context hook and the create API are mocked.
 */
vi.mock('../../features/research-group/useResearchGroup', () => ({
  useResearchGroup: vi.fn(),
}))

vi.mock('../../api/research-groups', () => ({
  createResearchGroup: vi.fn(),
}))

const GROUP: ApiResearchGroup = {
  id: 17,
  name: 'Existing Group',
  role: 'member',
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

    // The area stays mounted with the selector's own loading state…
    expect(screen.getByText('Loading…')).toBeVisible()
    // …and never presents a false zero-group creation entry.
    expect(
      screen.queryByRole('button', {
        name: 'New research group',
      }),
    ).toBeNull()
  })

  it('shows the first-group entry once loading resolved with zero groups', () => {
    renderSidebar(
      contextValue({
        groups: [],
        activeResearchGroupId: null,
        activeResearchGroup: null,
      }),
    )

    expect(
      screen.getByRole('button', {
        name: 'New research group',
      }),
    ).toBeVisible()

    // No active group yet, so group-scoped navigation is not shown.
    expect(
      screen.queryByRole('navigation', {
        name: 'Research group navigation',
      }),
    ).toBeNull()
  })

  it('does not present a false zero-group state when the group list fails to load', () => {
    renderSidebar(
      contextValue({
        groups: [],
        activeResearchGroupId: null,
        activeResearchGroup: null,
        error: 'Failed to load research groups.',
      }),
    )

    expect(
      screen.queryByRole('button', {
        name: 'New research group',
      }),
    ).toBeNull()
    expect(
      screen.queryByText('Research groups unavailable'),
    ).toBeNull()
  })

  it('opens the existing creation dialog from the zero-group entry', () => {
    ;(createResearchGroup as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 42,
      name: 'Brand New',
      role: 'admin',
    })

    const value = contextValue({
      groups: [],
      activeResearchGroupId: null,
      activeResearchGroup: null,
    })
    renderSidebar(value)

    fireEvent.click(
      screen.getByRole('button', {
        name: 'New research group',
      }),
    )

    expect(
      screen.getByRole('dialog', {
        name: 'Create research group',
      }),
    ).toBeVisible()
  })

  it('transitions from the zero-group entry into the normal selector after a successful first creation', async () => {
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
      screen.getByRole('button', {
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
    // after addResearchGroup runs); the Sidebar boundary renders the
    // normal selector instead of the zero-group entry.
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
    expect(
      screen.getByRole('button', {
        name: `Research group: ${created.name}`,
      }),
    ).toBeVisible()

    // Group-scoped navigation is available with the new group active.
    const groupNavigation = screen.getByRole('navigation', {
      name: 'Research group navigation',
    })
    expect(
      within(groupNavigation).getByRole('link', {
        name: /Projects/,
      }),
    ).toHaveAttribute('href', '/projects?group=42')
  })

  it('keeps the normal selector with its dropdown creation action for users with groups', () => {
    renderSidebar(contextValue())

    expect(
      screen.getByRole('button', {
        name: 'Research group: Existing Group',
      }),
    ).toBeVisible()
    expect(
      screen.queryByRole('button', {
        name: 'New research group',
      }),
    ).toBeNull()

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Research group: Existing Group',
      }),
    )

    expect(
      screen.getByRole('menuitem', {
        name: 'Create research group',
      }),
    ).toBeVisible()
  })
})
