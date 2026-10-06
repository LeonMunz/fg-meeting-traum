// @vitest-environment happy-dom

import {
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import {
  Outlet,
  RouterProvider,
  createMemoryRouter,
} from 'react-router'
import {
  act,
} from 'react'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import { ApiError } from '../../api/client'
import {
  getResearchGroup,
  listResearchGroups,
} from '../../api/research-groups'
import type { ApiResearchGroup } from '../../api/types'

import { ResearchGroupOverviewPage } from './ResearchGroupOverviewPage'
import { ResearchGroupProvider } from './ResearchGroupProvider'
import { ResearchGroupSettingsPage } from './ResearchGroupSettingsPage'

vi.mock('../../api/research-groups', () => ({
  getResearchGroup: vi.fn(),
  listResearchGroups: vi.fn(),
  listResearchGroupMemberships: vi.fn(),
  updateResearchGroup: vi.fn(),
  updateResearchGroupMembership: vi.fn(),
}))

const syncResearchGroupContextSpy = vi.hoisted(() => vi.fn())

vi.mock('./useSyncResearchGroupContext', () => ({
  useSyncResearchGroupContext: (groupId: number | null) => {
    syncResearchGroupContextSpy(groupId)
  },
}))

/*
 * The settings page mounts the member management dialogs; the
 * route-contract test under exercise does not open them.
 */
vi.mock('./AddResearchGroupMemberDialog', () => ({
  AddResearchGroupMemberDialog: () => null,
}))

vi.mock('./RemoveResearchGroupMemberDialog', () => ({
  RemoveResearchGroupMemberDialog: () => null,
}))

const GROUP_AURORA: ApiResearchGroup = {
  id: 11,
  name: 'Aurora Research',
  role: 'member',
}

const GROUP_BEACON: ApiResearchGroup = {
  id: 12,
  name: 'Beacon Lab',
  role: 'admin',
}

function ProviderLayout() {
  return (
    <ResearchGroupProvider>
      <Outlet />
    </ResearchGroupProvider>
  )
}

function createRouter(initialPath: string) {
  return createMemoryRouter(
    [
      {
        element: <ProviderLayout />,
        children: [
          {
            path: '/groups/:groupId',
            element: <ResearchGroupOverviewPage />,
          },
          {
            path: '/groups/:groupId/settings',
            element: <ResearchGroupSettingsPage />,
          },
        ],
      },
    ],
    { initialEntries: [initialPath] },
  )
}

beforeEach(() => {
  vi.clearAllMocks()

  syncResearchGroupContextSpy.mockReset()

  ;(listResearchGroups as ReturnType<typeof vi.fn>)
    .mockResolvedValue([
      GROUP_AURORA,
      GROUP_BEACON,
    ])

  ;(getResearchGroup as ReturnType<typeof vi.fn>)
    .mockImplementation(async (id: number) => {
      if (id === GROUP_AURORA.id) {
        return GROUP_AURORA
      }

      if (id === GROUP_BEACON.id) {
        return GROUP_BEACON
      }

      throw new ApiError(
        404,
        { error: 'Research group not found' },
      )
    })
})

afterEach(() => {
  cleanup()
})

describe('ResearchGroupOverviewPage', () => {
  it('renders the overview for an accessible research group', async () => {
    const router =
      createRouter('/groups/11')

    render(
      <RouterProvider
        router={router}
      />,
    )

    await screen.findByRole(
      'heading',
      { name: 'Aurora Research' },
    )

    expect(
      screen.getByText(
        'Research group overview',
      ),
    ).toBeInTheDocument()

    expect(
      screen.queryByText(
        'Research group not found',
      ),
    ).not.toBeInTheDocument()

    expect(getResearchGroup).toHaveBeenCalledWith(
      11,
    )

    expect(
      syncResearchGroupContextSpy,
    ).toHaveBeenCalledWith(11)
  })

  it('keeps the existing group-scoped Projects and Meetings destinations', async () => {
    const router =
      createRouter('/groups/11')

    render(
      <RouterProvider
        router={router}
      />,
    )

    await screen.findByRole(
      'heading',
      { name: 'Aurora Research' },
    )

    expect(
      screen.getByRole(
        'link',
        { name: 'Projects' },
      ),
    ).toHaveAttribute(
      'href',
      '/projects?group=11',
    )

    expect(
      screen.getByRole(
        'link',
        { name: 'Meetings' },
      ),
    ).toHaveAttribute(
      'href',
      '/meetings?group=11',
    )
  })

  it('resolves the corresponding group when :groupId changes', async () => {
    const router =
      createRouter('/groups/11')

    render(
      <RouterProvider
        router={router}
      />,
    )

    await screen.findByRole(
      'heading',
      { name: 'Aurora Research' },
    )

    await act(async () => {
      router.navigate(
        '/groups/12',
      )
    })

    await screen.findByRole(
      'heading',
      { name: 'Beacon Lab' },
    )

    expect(
      screen.queryByRole(
        'heading',
        { name: 'Aurora Research' },
      ),
    ).not.toBeInTheDocument()

    expect(
      screen.getByRole(
        'link',
        { name: 'Projects' },
      ),
    ).toHaveAttribute(
      'href',
      '/projects?group=12',
    )
  })

  it('shows the not-found state for an inaccessible or nonexistent group', async () => {
    ;(getResearchGroup as ReturnType<typeof vi.fn>)
      .mockRejectedValue(
        new ApiError(
          404,
          {
            error:
              'Research group not found',
          },
        ),
      )

    const router =
      createRouter('/groups/99')

    render(
      <RouterProvider
        router={router}
      />,
    )

    await screen.findByRole(
      'heading',
      { name: 'Research group' },
    )

    await waitFor(() => {
      expect(
        screen.getByText(
          'Research group not found',
        ),
      ).toHaveClass('text-error')
    })
  })

  it('reports an invalid group id without calling the API', async () => {
    const router =
      createRouter('/groups/not-a-group')

    render(
      <RouterProvider
        router={router}
      />,
    )

    await screen.findByRole(
      'heading',
      { name: 'Research group' },
    )

    expect(
      screen.getByText(
        'Research group not found.',
      ),
    ).toBeInTheDocument()

    expect(
      getResearchGroup,
    ).not.toHaveBeenCalled()
  })

  it('offers the admin-only Settings destination on the Overview for admins', async () => {
    const router =
      createRouter('/groups/12')

    render(
      <RouterProvider
        router={router}
      />,
    )

    await screen.findByRole(
      'heading',
      { name: 'Beacon Lab' },
    )

    const settings =
      screen.getByRole(
        'link',
        { name: 'Settings' },
      )

    expect(settings).toHaveAttribute(
      'href',
      '/groups/12/settings',
    )

    // The group-scoped destinations remain.
    expect(
      screen.getByRole('link', {
        name: 'Projects',
      }),
    ).toHaveAttribute('href', '/projects?group=12')
    expect(
      screen.getByRole('link', {
        name: 'Meetings',
      }),
    ).toHaveAttribute('href', '/meetings?group=12')
  })

  it('does not offer the Settings destination on the Overview for non-admins', async () => {
    const router =
      createRouter('/groups/11')

    render(
      <RouterProvider
        router={router}
      />,
    )

    await screen.findByRole(
      'heading',
      { name: 'Aurora Research' },
    )

    expect(
      screen.queryByRole(
        'link',
        { name: 'Settings' },
      ),
    ).not.toBeInTheDocument()
  })

  it('keeps /groups/:groupId/settings rendering the existing settings page', async () => {
    const router =
      createRouter(
        '/groups/11/settings',
      )

    render(
      <RouterProvider
        router={router}
      />,
    )

    await screen.findByRole(
      'heading',
      { name: 'Aurora Research' },
    )

    expect(
      screen.getByText(
        'Research group settings are managed by admins.',
      ),
    ).toBeInTheDocument()

    expect(
      screen.queryByText(
        'Research group overview',
      ),
    ).not.toBeInTheDocument()
  })
})
