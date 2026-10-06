// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { listProjects } from '../../api/projects'
import type { ApiProject } from '../../api/types'

import { ProjectListPage } from './ProjectListPage'

const routerMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
}))

vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => routerMocks.navigate,
}))

vi.mock('../../api/projects', () => ({
  createProject: vi.fn(),
  listProjects: vi.fn(),
}))

vi.mock('../research-group/useResearchGroupListScope', () => ({
  useResearchGroupListScope: () => ({
    activeResearchGroupId: 11,
    activeResearchGroup: {
      id: 11,
      name: 'Bravo Group',
      role: 'member',
    },
    loading: false,
    error: null,
  }),
}))

vi.mock('./CreateProjectDialog', () => ({
  CreateProjectDialog: () => null,
}))

const PROJECT: ApiProject = {
  id: 201,
  researchGroupId: 11,
  name: 'Paper One',
  description: 'Project description',
  status: 'active',
  archivedAt: null,
  currentUserRole: 'owner',
  createdAt: '2026-01-01T08:00:00Z',
  updatedAt: '2026-10-05T08:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listProjects).mockResolvedValue([PROJECT])
})

afterEach(() => {
  cleanup()
})

describe('ProjectListPage project entry', () => {
  it.each([
    ['mouse', (row: HTMLElement) => fireEvent.click(row)],
    [
      'keyboard',
      (row: HTMLElement) =>
        fireEvent.keyDown(row, { key: 'Enter' }),
    ],
  ])(
    'opens a project with a native View Transition by %s',
    async (_activation, activate) => {
      render(<ProjectListPage />)

      const row = await screen.findByRole('link', {
        name: /Paper One/,
      })

      activate(row)

      expect(routerMocks.navigate).toHaveBeenCalledWith(
        '/projects/201/work-items',
        { viewTransition: true },
      )
    },
  )
})

describe('ProjectListPage workspace content frame', () => {
  it('renders the complete page inside one shared constrained workspace frame', async () => {
    const { container } = render(<ProjectListPage />)

    const frames = container.querySelectorAll(
      '[data-fg-workspace-content="constrained"]',
    )
    expect(frames).toHaveLength(1)

    const frame = frames[0] as HTMLElement

    // Heading + action, filter/search toolbar and the project
    // list all share the same frame (no independently narrowed
    // table).
    const heading = await screen.findByRole(
      'heading',
      { name: 'Projects' },
    )
    expect(frame.contains(heading)).toBe(true)
    expect(
      frame.contains(
        screen.getByRole('button', {
          name: /New project/,
        }),
      ),
    ).toBe(true)
    expect(
      frame.contains(
        screen.getByRole('searchbox', {
          name: /search projects/i,
        }),
      ),
    ).toBe(true)
    expect(
      frame.contains(
        await screen.findByRole('link', {
          name: /Paper One/,
        }),
      ),
    ).toBe(true)
  })
})
