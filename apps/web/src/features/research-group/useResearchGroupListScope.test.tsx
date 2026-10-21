// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import type { ApiResearchGroup } from '../../api/types'

import type {
  ResearchGroupContextValue,
} from './ResearchGroupContext'
import { useResearchGroup } from './useResearchGroup'
import { useResearchGroupListScope } from './useResearchGroupListScope'

/*
 * The hook under test is the REAL
 * useResearchGroupListScope; only the Research Group
 * provider (context) is mocked. A real MemoryRouter
 * with matched routes drives useParams() and
 * useSearchParams() exactly as in the application.
 */
vi.mock('./useResearchGroup', () => ({
  useResearchGroup: vi.fn(),
}))

const GROUP_11: ApiResearchGroup = {
  id: 11,
  name: 'Group Eleven',
  role: 'member',
}

const GROUP_22: ApiResearchGroup = {
  id: 22,
  name: 'Group Twenty Two',
  role: 'admin',
}

function mockProvider(
  groups: ApiResearchGroup[],
  activeResearchGroupId: number | null,
) {
  const value: ResearchGroupContextValue = {
    groups,
    activeResearchGroupId,
    activeResearchGroup:
      groups.find(
        (group) =>
          group.id === activeResearchGroupId,
      ) ?? null,
    loading: false,
    error: null,
    setActiveResearchGroupId: vi.fn(),
    reloadResearchGroups: vi.fn(),
    addResearchGroup: vi.fn(),
  }

  vi.mocked(useResearchGroup).mockReturnValue(
    value,
  )

  return value
}

function readScope() {
  return {
    id: screen
      .getByLabelText('Scoped group id')
      .textContent,
    name: screen
      .getByLabelText('Scoped group name')
      .textContent,
    loading: screen
      .getByLabelText('Loading')
      .textContent,
    error: screen
      .getByLabelText('Scope error')
      .textContent,
    url: screen
      .getByLabelText('Current URL')
      .textContent,
  }
}

/**
 * Route table covering the global list routes AND the
 * Research Group workspace routes the scope contract
 * is prepared for.
 */
function ScopeRoutes({
  navigateTarget,
}: {
  navigateTarget?: string
}) {
  function ScopeProbe() {
    const {
      activeResearchGroupId,
      activeResearchGroup,
      loading,
      error,
    } = useResearchGroupListScope()

    const location = useLocation()
    const navigate = useNavigate()

    return (
      <div>
        <output aria-label="Scoped group id">
          {String(activeResearchGroupId)}
        </output>
        <output aria-label="Scoped group name">
          {activeResearchGroup?.name ?? ''}
        </output>
        <output aria-label="Loading">
          {String(loading)}
        </output>
        <output aria-label="Scope error">
          {error ?? ''}
        </output>
        <output aria-label="Current URL">
          {location.pathname + location.search}
        </output>
        {navigateTarget != null && (
          <button
            type="button"
            onClick={() =>
              navigate(navigateTarget)
            }
          >
            Go
          </button>
        )}
      </div>
    )
  }

  return (
    <Routes>
      <Route path="/projects" element={<ScopeProbe />} />
      <Route path="/meetings" element={<ScopeProbe />} />
      <Route
        path="/groups/:groupId"
        element={<ScopeProbe />}
      />
      <Route
        path="/groups/:groupId/projects"
        element={<ScopeProbe />}
      />
      <Route
        path="/groups/:groupId/meetings"
        element={<ScopeProbe />}
      />
      <Route
        path="/groups/:groupId/settings"
        element={<ScopeProbe />}
      />
      <Route
        path="*"
        element={<div>UNROUTED</div>}
      />
    </Routes>
  )
}

function renderScopeProbe(
  initialUrl: string,
  navigateTarget?: string,
) {
  return render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <ScopeRoutes navigateTarget={navigateTarget} />
    </MemoryRouter>,
  )
}

describe(
  'useResearchGroupListScope workspace scope',
  () => {
    beforeEach(() => {
      vi.clearAllMocks()
    })

    afterEach(() => {
      cleanup()
    })

    it(
      'resolves the workspace route path id as the scope',
      async () => {
        const provider = mockProvider(
          [GROUP_11, GROUP_22],
          22,
        )

        renderScopeProbe('/groups/11/projects')

        await waitFor(() => {
          expect(readScope().id).toBe('11')
        })

        const scope = readScope()
        expect(scope.name).toBe('Group Eleven')
        expect(scope.error).toBe('')
        expect(scope.url).toBe('/groups/11/projects')

        // A valid, accessible workspace group
        // synchronizes the provider.
        expect(
          provider.setActiveResearchGroupId,
        ).toHaveBeenCalledTimes(1)
        expect(
          provider.setActiveResearchGroupId,
        ).toHaveBeenCalledWith(11)
      },
    )

    it(
      'does not let a conflicting ?group= override the path id',
      async () => {
        const provider = mockProvider(
          [GROUP_11, GROUP_22],
          22,
        )

        renderScopeProbe(
          '/groups/11/meetings?group=22',
        )

        await waitFor(() => {
          expect(readScope().id).toBe('11')
        })

        const scope = readScope()
        expect(scope.name).toBe('Group Eleven')
        expect(scope.error).toBe('')

        // The query names group 22; the provider must
        // be synced to the PATH group, never to the
        // query group.
        expect(
          provider.setActiveResearchGroupId,
        ).toHaveBeenCalledWith(11)
        expect(
          provider.setActiveResearchGroupId,
        ).not.toHaveBeenCalledWith(22)
      },
    )

    it(
      'resolves an unknown path id to no scope (no fallback)',
      async () => {
        const provider = mockProvider(
          [GROUP_11, GROUP_22],
          22,
        )

        renderScopeProbe('/groups/999/projects')

        await waitFor(() => {
          expect(readScope().error).toBe(
            'Research group is not available.',
          )
        })

        const scope = readScope()
        // No substitution by the active group 22.
        expect(scope.id).toBe('null')
        expect(scope.name).toBe('')
        expect(
          provider.setActiveResearchGroupId,
        ).not.toHaveBeenCalled()
        // No navigation, no ?group= insertion.
        expect(scope.url).toBe('/groups/999/projects')
      },
    )

    it(
      'resolves an unparseable path id to no scope',
      async () => {
        mockProvider([GROUP_11, GROUP_22], 22)

        renderScopeProbe(
          '/groups/not-valid/meetings',
        )

        await waitFor(() => {
          expect(readScope().error).toBe(
            'Research group is not available.',
          )
        })

        const scope = readScope()
        expect(scope.id).toBe('null')
        expect(scope.url).toBe(
          '/groups/not-valid/meetings',
        )
      },
    )

    it(
      'does not fall back to a valid ?group= when the path scope is invalid',
      async () => {
        const provider = mockProvider(
          [GROUP_11, GROUP_22],
          22,
        )

        renderScopeProbe(
          '/groups/999/projects?group=11',
        )

        await waitFor(() => {
          expect(readScope().error).toBe(
            'Research group is not available.',
          )
        })

        expect(readScope().id).toBe('null')
        expect(
          provider.setActiveResearchGroupId,
        ).not.toHaveBeenCalled()
        // The URL is left untouched.
        expect(readScope().url).toBe(
          '/groups/999/projects?group=11',
        )
      },
    )

    it(
      'does not switch the provider for an inaccessible group id',
      async () => {
        // The user only has access to group 22.
        const provider = mockProvider([GROUP_22], 22)

        renderScopeProbe('/groups/11/projects')

        await waitFor(() => {
          expect(readScope().error).toBe(
            'Research group is not available.',
          )
        })

        const scope = readScope()
        expect(scope.id).toBe('null')
        expect(
          provider.setActiveResearchGroupId,
        ).not.toHaveBeenCalled()
        expect(scope.url).toBe('/groups/11/projects')
      },
    )

    it(
      'resolves the new scope when navigating between workspace routes',
      async () => {
        // Group 11 starts as the active provider group, so
        // the first render performs no provider sync and the
        // navigation is the ONLY sync trigger.
        const provider = mockProvider(
          [GROUP_11, GROUP_22],
          11,
        )

        renderScopeProbe(
          '/groups/11/projects',
          '/groups/22/projects',
        )

        await waitFor(() => {
          expect(readScope().id).toBe('11')
        })

        // First render: already active, no sync.
        expect(provider.setActiveResearchGroupId).not.toHaveBeenCalled()

        fireEvent.click(
          screen.getByRole('button', { name: 'Go' }),
        )

        await waitFor(() => {
          expect(readScope().id).toBe('22')
        })

        const scope = readScope()
        expect(scope.name).toBe('Group Twenty Two')
        expect(scope.url).toBe('/groups/22/projects')
        expect(scope.error).toBe('')
        expect(
          provider.setActiveResearchGroupId,
        ).toHaveBeenCalledTimes(1)
        expect(provider.setActiveResearchGroupId).toHaveBeenCalledWith(22)
      },
    )

    it(
      'keeps existing query parameters like tab=series on workspace routes',
      async () => {
        mockProvider([GROUP_11, GROUP_22], 22)

        renderScopeProbe(
          '/groups/11/meetings?tab=series',
        )

        await waitFor(() => {
          expect(readScope().id).toBe('11')
        })

        expect(readScope().url).toBe(
          '/groups/11/meetings?tab=series',
        )
      },
    )

    it(
      'never adds an automatic ?group= on workspace routes (and skips redundant sync)',
      async () => {
        // Group 11 is already the active provider
        // group.
        const provider = mockProvider(
          [GROUP_11, GROUP_22],
          11,
        )

        renderScopeProbe('/groups/11/projects')

        await waitFor(() => {
          expect(readScope().id).toBe('11')
        })

        expect(
          provider.setActiveResearchGroupId,
        ).not.toHaveBeenCalled()
        expect(readScope().url).toBe('/groups/11/projects')
      },
    )

    it(
      'keeps ?group= authoritative on global list routes',
      async () => {
        const provider = mockProvider(
          [GROUP_11, GROUP_22],
          22,
        )

        renderScopeProbe('/projects?group=11')

        await waitFor(() => {
          expect(readScope().id).toBe('11')
        })

        expect(readScope().url).toBe('/projects?group=11')
        expect(
          provider.setActiveResearchGroupId,
        ).toHaveBeenCalledWith(11)
      },
    )

    it(
      'keeps the provider fallback and URL normalization on bare global list URLs',
      async () => {
        mockProvider([GROUP_11, GROUP_22], 11)

        renderScopeProbe('/projects')

        await waitFor(() => {
          expect(readScope().url).toBe(
            '/projects?group=11',
          )
        })

        expect(readScope().id).toBe('11')
        expect(readScope().error).toBe('')
      },
    )

    it(
      'normalizes bare /meetings while preserving the tab parameter',
      async () => {
        mockProvider([GROUP_11, GROUP_22], 11)

        renderScopeProbe('/meetings?tab=series')

        await waitFor(() => {
          const url = new URL(
            readScope().url,
            'http://localhost',
          )
          expect(url.searchParams.get('group')).toBe(
            '11',
          )
          expect(url.searchParams.get('tab')).toBe(
            'series',
          )
        })

        expect(readScope().id).toBe('11')
      },
    )

    it(
      'keeps the unavailable-group error on an invalid ?group= without fallback',
      async () => {
        const provider = mockProvider(
          [GROUP_11, GROUP_22],
          22,
        )

        renderScopeProbe('/projects?group=999')

        await waitFor(() => {
          expect(readScope().error).toBe(
            'Research group is not available.',
          )
        })

        expect(readScope().id).toBe('null')
        expect(
          provider.setActiveResearchGroupId,
        ).not.toHaveBeenCalled()
        expect(readScope().url).toBe('/projects?group=999')
      },
    )

    it(
      'defers resolution while the provider loads, then resolves',
      async () => {
        const state: ResearchGroupContextValue = {
          groups: [],
          activeResearchGroupId: null,
          activeResearchGroup: null,
          loading: true,
          error: null,
          setActiveResearchGroupId: vi.fn(),
          reloadResearchGroups: vi.fn(),
          addResearchGroup: vi.fn(),
        }
        vi.mocked(useResearchGroup).mockImplementation(
          () => state,
        )

        const { rerender } = render(
          <MemoryRouter
            initialEntries={['/groups/11/projects']}
          >
            <ScopeRoutes />
          </MemoryRouter>,
        )

        expect(readScope().loading).toBe('true')
        expect(readScope().id).toBe('null')
        expect(readScope().error).toBe('')
        expect(
          state.setActiveResearchGroupId,
        ).not.toHaveBeenCalled()

        state.groups = [GROUP_11, GROUP_22]
        state.activeResearchGroupId = 22
        state.activeResearchGroup = GROUP_22
        state.loading = false

        rerender(
          <MemoryRouter
            initialEntries={['/groups/11/projects']}
          >
            <ScopeRoutes />
          </MemoryRouter>,
        )

        await waitFor(() => {
          expect(readScope().id).toBe('11')
        })

        expect(
          state.setActiveResearchGroupId,
        ).toHaveBeenCalledWith(11)
      },
    )
  },
)
