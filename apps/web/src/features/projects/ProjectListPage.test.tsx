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

describe('ProjectListPage embedded presentation mode', () => {
  it('renders no own frame or outer padding and a local H2 heading (no H1, no group subtitle)', async () => {
    const { container } = render(
      <ProjectListPage embedded />,
    )

    const root =
      container.firstElementChild as HTMLElement

    // The page renders its header row directly — the
    // workspace layout owns the outer padding and the
    // shared constrained frame.
    expect(
      root.className,
    ).not.toContain('px-6')
    expect(
      container.querySelectorAll(
        '[data-fg-workspace-content]',
      ),
    ).toHaveLength(0)

    // Local H2 page heading — no H1, no group subtitle
    // (the shared workspace header carries the group
    // identity).
    expect(
      screen.getByRole('heading', {
        name: 'Projects',
        level: 2,
      }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', {
        name: 'Projects',
        level: 1,
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(
        /Projects you can access in/,
      ),
    ).not.toBeInTheDocument()

    // The list behavior stays intact …
    const row = await screen.findByRole(
      'link',
      { name: /Paper One/ },
    )
    expect(row).toBeInTheDocument()

    // … and the action button is enabled once the list has
    // settled (it is disabled while the scope or the list is
    // still loading).
    expect(
      screen.getByRole('button', {
        name: /New project/,
      }),
    ).toBeEnabled()
  })

  it('keeps the standalone presentation unchanged by default', async () => {
    const { container } = render(<ProjectListPage />)

    const root =
      container.firstElementChild as HTMLElement

    // Standalone: own padded wrapper + own frame + H1.
    expect(root.className).toContain('px-6')
    expect(
      container.querySelectorAll(
        '[data-fg-workspace-content="constrained"]',
      ),
    ).toHaveLength(1)
    expect(
      screen.getByRole('heading', {
        name: 'Projects',
        level: 1,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Projects you can access in Bravo Group.',
      ),
    ).toBeInTheDocument()
  })
})
