// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter } from 'react-router'

import { me } from '../api/auth'
import { listResearchGroups } from '../api/research-groups'
import type { ApiUser } from '../api/types'
import { fetchGlobalProjectQuickAccess } from '../api/project-quick-access'
import { fetchWorkspaceNavigationPreferences } from '../api/workspace-navigation-preferences'

import { DataRouterApp } from './App'
import { appRoutes } from './routes'

vi.mock('../api/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/auth')>()),
  me: vi.fn(),
}))

vi.mock('../api/research-groups', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/research-groups')>()),
  listResearchGroups: vi.fn(),
}))

vi.mock('../api/project-quick-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/project-quick-access')>()),
  fetchGlobalProjectQuickAccess: vi.fn(),
}))

vi.mock('../api/workspace-navigation-preferences', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../api/workspace-navigation-preferences')
  >()),
  fetchWorkspaceNavigationPreferences: vi.fn(),
}))

vi.mock('../features/home/HomePage', () => ({
  HomePage: () => <h1>Home</h1>,
}))

const USER: ApiUser = {
  id: 1,
  username: 'alex',
  firstName: 'Alex',
  lastName: '',
  email: 'alex@example.com',
}

function renderProductionRouter(initialEntry: string) {
  const router = createMemoryRouter(appRoutes, {
    initialEntries: [initialEntry],
  })

  render(<DataRouterApp router={router} />)

  return router
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listResearchGroups).mockResolvedValue([])
  vi.mocked(fetchGlobalProjectQuickAccess).mockResolvedValue([])
  vi.mocked(fetchWorkspaceNavigationPreferences).mockResolvedValue({
    researchGroupOrder: [],
    expandedResearchGroups: [],
    expandedProjectSections: [],
  })
})

afterEach(() => {
  cleanup()
})

describe('production data-router composition', () => {
  it('renders the login route under the global providers', async () => {
    vi.mocked(me).mockRejectedValue(new Error('Not authenticated'))

    renderProductionRouter('/login')

    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('Unexpected Application Error!'),
    ).not.toBeInTheDocument()
  })

  it('redirects an unauthenticated application route to login', async () => {
    vi.mocked(me).mockRejectedValue(new Error('Not authenticated'))

    const router = renderProductionRouter('/')

    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/login')
  })

  it('mounts an authenticated application route inside AppShell', async () => {
    vi.mocked(me).mockResolvedValue(USER)

    renderProductionRouter('/')

    const homeHeading = await screen.findByRole('heading', {
      name: 'Home',
    })
    expect(homeHeading.closest('main')).not.toBeNull()
    expect(screen.getByRole('complementary')).toBeInTheDocument()
    expect(screen.getByRole('banner')).toBeInTheDocument()
  })
})
