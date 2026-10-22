// @vitest-environment happy-dom
/**
 * Research Group Overview — content contract under the shared
 * workspace layout.
 *
 * The group header (name + description), the persistent section
 * tab bar, and the group-resolution states (loading / not-found
 * / error) are owned by the SHARED workspace layout — see
 * `ResearchGroupWorkspaceLayout.test.tsx` (router integration)
 * and `ResearchGroupOverviewPage.theme.test.tsx` (theme
 * contract for the shared surfaces). This suite pins the
 * OVERVIEW PAGE'S remaining responsibilities:
 *
 * - the page renders only its own content section (no second
 *   Research-Group heading, no own tab bar, no own container);
 * - the page no longer fetches the group of its own — the
 *   layout resolved the group through the existing provider /
 *   scope mechanism BEFORE mounting this page;
 * - the layout's group-resolution gate keeps the overview
 *   content out for invalid / inaccessible group ids.
 */

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
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

import {
  getResearchGroup,
  listResearchGroups,
} from '../../api/research-groups'
import type { ApiResearchGroup } from '../../api/types'

import { ResearchGroupOverviewPage } from './ResearchGroupOverviewPage'
import { ResearchGroupProvider } from './ResearchGroupProvider'
import { ResearchGroupWorkspaceLayout } from './ResearchGroupWorkspaceLayout'

vi.mock('../../api/research-groups', () => ({
  getResearchGroup: vi.fn(),
  listResearchGroups: vi.fn(),
  listResearchGroupMemberships: vi.fn(),
  updateResearchGroup: vi.fn(),
  updateResearchGroupMembership: vi.fn(),
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

/**
 * The canonical workspace route structure (layout parent +
 * overview index child) — the same nesting `appRoutes`
 * registers.
 */
function createRouter(initialPath: string) {
  return createMemoryRouter(
    [
      {
        element: <ProviderLayout />,
        children: [
          {
            path: '/groups/:groupId',
            element:
              <ResearchGroupWorkspaceLayout />,
            children: [
              {
                index: true,
                element:
                  <ResearchGroupOverviewPage />,
              },
            ],
          },
        ],
      },
    ],
    { initialEntries: [initialPath] },
  )
}

beforeEach(() => {
  vi.clearAllMocks()

  ;(listResearchGroups as ReturnType<typeof vi.fn>)
    .mockResolvedValue([
      GROUP_AURORA,
      GROUP_BEACON,
    ])

  ;(getResearchGroup as ReturnType<typeof vi.fn>)
    .mockResolvedValue(GROUP_AURORA)
})

afterEach(() => {
  cleanup()
})

describe('ResearchGroupOverviewPage (workspace index content)', () => {
  it('renders only the overview content below the shared workspace header', async () => {
    const router =
      createRouter('/groups/11')

    render(
      <RouterProvider
        router={router}
      />,
    )

    // The shared header (layout) carries the ONE group-name
    // H1 + the workspace description.
    await screen.findByRole(
      'heading',
      {
        name: 'Aurora Research',
        level: 1,
      },
    )

    expect(
      screen.getAllByRole('heading'),
    ).toHaveLength(1)

    expect(
      screen.getByText('Research group workspace'),
    ).toBeInTheDocument()

    // The overview content section renders …
    expect(
      screen.getByText(
        /This is the overview for this research group/,
      ),
    ).toBeInTheDocument()

  })

  it('does not fetch the group itself — the layout resolved it', async () => {
    const router =
      createRouter('/groups/11')

    render(
      <RouterProvider
        router={router}
      />,
    )

    await screen.findByRole(
      'heading',
      {
        name: 'Aurora Research',
        level: 1,
      },
    )

    // Identity comes from the provider list the layout
    // resolved — the overview page issues no group fetch of
    // its own.
    expect(
      listResearchGroups,
    ).toHaveBeenCalled()

    expect(
      getResearchGroup,
    ).not.toHaveBeenCalled()
  })

  it('keeps the tab bar free of a second Overview tab and a second nav', async () => {
    const router =
      createRouter('/groups/11')

    render(
      <RouterProvider
        router={router}
      />,
    )

    await screen.findByRole(
      'heading',
      {
        name: 'Aurora Research',
        level: 1,
      },
    )

    // Exactly ONE workspace section navigation (the
    // layout's persistent tab bar) …
    const navs =
      screen.getAllByRole('navigation', {
        name: 'Research group sections',
      })
    expect(navs).toHaveLength(1)

    // … and the Overview tab is the ONLY link to the index
    // route.
    const overviewLinks =
      within(navs[0]!)
        .getAllByRole('link')
        .filter((link) =>
          link.getAttribute(
            'href',
          ) === '/groups/11',
        )
    expect(overviewLinks).toHaveLength(1)
    expect(overviewLinks[0]).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('follows the group when :groupId changes', async () => {
    const router =
      createRouter('/groups/11')

    render(
      <RouterProvider
        router={router}
      />,
    )

    await screen.findByRole(
      'heading',
      {
        name: 'Aurora Research',
        level: 1,
      },
    )

    await act(async () => {
      router.navigate(
        '/groups/12',
      )
    })

    await screen.findByRole(
      'heading',
      {
        name: 'Beacon Lab',
        level: 1,
      },
    )

    expect(
      screen.queryByRole(
        'heading',
        { name: 'Aurora Research' },
      ),
    ).not.toBeInTheDocument()

    // The overview content stays part of the workspace on
    // the new group.
    expect(
      screen.getByText(
        /This is the overview for this research group/,
      ),
    ).toBeInTheDocument()
  })

  it('renders no overview content for an inaccessible group (layout gate)', async () => {
    const router =
      createRouter('/groups/99')

    render(
      <RouterProvider
        router={router}
      />,
    )

    await screen.findByRole(
      'heading',
      {
        name: 'Research group',
        level: 1,
      },
    )

    await waitFor(() => {
      expect(
        screen.getByText(
          'Research group is not available.',
        ),
      ).toBeInTheDocument()
    })

    // No overview content, no workspace tab bar.
    expect(
      screen.queryByText(
        /This is the overview for this research group/,
      ),
    ).not.toBeInTheDocument()

    expect(
      screen.queryByRole('navigation', {
        name: 'Research group sections',
      }),
    ).not.toBeInTheDocument()
  })

  it('renders the not-found gate for an invalid group id without any group fetch', async () => {
    const router =
      createRouter(
        '/groups/not-a-group',
      )

    render(
      <RouterProvider
        router={router}
      />,
    )

    await screen.findByRole(
      'heading',
      {
        name: 'Research group',
        level: 1,
      },
    )

    expect(
      screen.getByText(
        'Research group is not available.',
      ),
    ).toBeInTheDocument()

    expect(
      getResearchGroup,
    ).not.toHaveBeenCalled()
  })
})
