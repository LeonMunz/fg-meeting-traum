// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, useLocation } from 'react-router'

import { createResearchGroup } from '../../api/research-groups'
import type { ApiResearchGroup } from '../../api/types'

import { ResearchGroupSelector } from './ResearchGroupSelector'
import { useResearchGroup } from './useResearchGroup'
import type { ResearchGroupContextValue } from './ResearchGroupContext'

vi.mock('../../api/research-groups', () => ({
  createResearchGroup: vi.fn(),
}))

vi.mock('./useResearchGroup', () => ({
  useResearchGroup: vi.fn(),
}))

const MEMBER_GROUP: ApiResearchGroup = {
  id: 17,
  name: 'Existing Group',
  role: 'member',
}

function createContextValue(
  overrides: Partial<ResearchGroupContextValue> = {},
): ResearchGroupContextValue {
  return {
    groups: [MEMBER_GROUP],
    activeResearchGroupId: MEMBER_GROUP.id,
    activeResearchGroup: MEMBER_GROUP,
    loading: false,
    error: null,
    setActiveResearchGroupId: vi.fn(),
    reloadResearchGroups: vi.fn(),
    addResearchGroup: vi.fn(),
    ...overrides,
  }
}

function LocationProbe() {
  const location = useLocation()

  return (
    <output aria-label="Current location">
      {`${location.pathname}${location.search}`}
    </output>
  )
}

function renderSelector(
  contextValue: ResearchGroupContextValue,
  initialEntry = '/projects?group=17',
) {
  vi.mocked(useResearchGroup).mockReturnValue(contextValue)

  const utils = render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <ResearchGroupSelector />
      <LocationProbe />
    </MemoryRouter>,
  )

  return {
    contextValue,
    location: () =>
      screen.getByLabelText('Current location').textContent!,
    ...utils,
  }
}

async function openDropdown() {
  const switcher = screen.getByRole('button', {
    name: /^Research group:/,
  })
  await waitFor(() => expect(switcher).toBeVisible())
  fireEvent.click(switcher)

  await waitFor(() => {
    expect(screen.getByRole('menu')).toBeVisible()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(createResearchGroup as ReturnType<typeof vi.fn>).mockReset()
})

afterEach(() => {
  cleanup()
})

describe('ResearchGroupSelector creation entry point', () => {
  it('shows the creation action to a non-admin authenticated user', async () => {
    renderSelector(createContextValue())
    await openDropdown()

    expect(
      screen.getByRole('menuitem', {
        name: 'Create research group',
      }),
    ).toBeVisible()

    // The admin-only settings entry must not be confused with the
    // creation entry: creation is available regardless of role.
    expect(
      screen.queryByRole('menuitem', {
        name: /Research group settings/,
      }),
    ).not.toBeInTheDocument()
  })

  it('opens the creation dialog from the dropdown', async () => {
    ;(createResearchGroup as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 42,
      name: 'New Group',
      role: 'admin',
    })

    renderSelector(createContextValue())
    await openDropdown()

    fireEvent.click(
      screen.getByRole('menuitem', {
        name: 'Create research group',
      }),
    )

    expect(
      await screen.findByRole('dialog', {
        name: 'Create research group',
      }),
    ).toBeVisible()
  })

  it('shows a creation entry point when the user has no Research Group', () => {
    renderSelector(
      createContextValue({
        groups: [],
        activeResearchGroupId: null,
        activeResearchGroup: null,
      }),
    )

    const createButton = screen.getByRole('button', {
      name: 'New research group',
    })
    expect(createButton).toBeVisible()

    fireEvent.click(createButton)

    expect(
      screen.getByRole('dialog', {
        name: 'Create research group',
      }),
    ).toBeVisible()
  })

  it('registers the exact server-created group and navigates into it', async () => {
    const created: ApiResearchGroup = {
      id: 42,
      name: 'Brand New Group',
      role: 'admin',
    }
    ;(createResearchGroup as ReturnType<typeof vi.fn>).mockResolvedValue(
      created,
    )

    const { contextValue, location } =
      renderSelector(createContextValue())
    const addResearchGroup =
      contextValue.addResearchGroup as ReturnType<typeof vi.fn>
    await openDropdown()

    fireEvent.click(
      screen.getByRole('menuitem', {
        name: 'Create research group',
      }),
    )

    fireEvent.change(screen.getByLabelText('Research group name'), {
      target: { value: 'Brand New Group' },
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Create research group',
      }),
    )

    await waitFor(() => {
      expect(createResearchGroup).toHaveBeenCalledTimes(1)
      expect(createResearchGroup).toHaveBeenCalledWith({
        name: 'Brand New Group',
      })
    })
    // The exact server response object is handed to the canonical
    // state: nothing is synthesized client-side.
    await waitFor(() => {
      expect(addResearchGroup).toHaveBeenCalledTimes(1)
    })
    expect(addResearchGroup).toHaveBeenCalledWith(created)
    expect(addResearchGroup.mock.calls[0][0]).toBe(created)

    // On a group-scoped list page the URL points into the new group.
    await waitFor(() => {
      expect(location()).toBe('/projects?group=42')
    })

    // The dialog is closed after success.
    expect(
      screen.queryByRole('dialog', { name: 'Create research group' }),
    ).toBeNull()
  })

  it('keeps an entity detail page on its own route while the new group becomes active', async () => {
    const created: ApiResearchGroup = {
      id: 42,
      name: 'Brand New Group',
      role: 'admin',
    }
    ;(createResearchGroup as ReturnType<typeof vi.fn>).mockResolvedValue(
      created,
    )

    const { contextValue, location } = renderSelector(
      createContextValue(),
      '/projects/5/work-items',
    )
    const addResearchGroup =
      contextValue.addResearchGroup as ReturnType<typeof vi.fn>

    const createButton = screen.getByRole('button', {
      name: /^Research group:/,
    })
    fireEvent.click(createButton)
    fireEvent.click(
      screen.getByRole('menuitem', {
        name: 'Create research group',
      }),
    )

    fireEvent.change(screen.getByLabelText('Research group name'), {
      target: { value: 'Brand New Group' },
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Create research group',
      }),
    )

    await waitFor(() => {
      expect(addResearchGroup).toHaveBeenCalledWith(created)
    })
    // The old entity belongs to the old group: the user exits it into
    // the new group's Project list, matching group-switch behavior.
    await waitFor(() => {
      expect(location()).toBe('/projects?group=42')
    })
  })
})
