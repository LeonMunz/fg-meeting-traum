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
import {
  MemoryRouter,
  Route,
  Routes,
} from 'react-router'

import {
  createMeetingSeries,
  deleteMeetingSeries,
  listMeetingSeries,
} from '../../api/meetings'
import { listProjects } from '../../api/projects'
import { ApiError } from '../../api/client'
import type {
  ApiMeetingSeries,
  ApiProject,
  ApiProjectRole,
} from '../../api/types'

import { MeetingSeriesListPage } from './MeetingSeriesListPage'

vi.mock('../../api/meetings', () => ({
  createMeetingSeries: vi.fn(),
  deleteMeetingSeries: vi.fn(),
  listMeetingSeries: vi.fn(),
}))

vi.mock('../../api/projects', () => ({
  listProjects: vi.fn(),
}))

vi.mock('../../api/useSession', () => ({
  useSession: () => ({
    user: { id: 1, username: 'alex' },
  }),
}))

const scopeMock = vi.hoisted(() => ({
  role: 'admin' as 'admin' | 'member',
  projectRole: 'owner' as ApiProjectRole,
}))

vi.mock(
  '../research-group/useResearchGroupListScope',
  () => ({
    useResearchGroupListScope: () => ({
      activeResearchGroupId: 3,
      activeResearchGroup: {
        id: 3,
        name: 'FG Group',
        role: scopeMock.role,
      },
      loading: false,
      error: null,
    }),
  }),
)

const baseProject: Omit<
  ApiProject,
  'currentUserRole'
> = {
  id: 42,
  researchGroupId: 3,
  name: 'Gamma Project',
  description: '',
  status: 'active',
  archivedAt: null,
  createdAt: '2026-09-01T09:00:00Z',
  updatedAt: '2026-09-01T09:00:00Z',
}

function projectSnapshot(): ApiProject {
  return {
    ...baseProject,
    currentUserRole: scopeMock.projectRole,
  }
}

const alpha: ApiMeetingSeries = {
  id: 11,
  researchGroupId: 3,
  scope: 'group',
  projectId: null,
  title: 'Alpha Sync',
  description: 'Alpha template.',
  isArchived: false,
  createdById: 1,
  createdAt: '2026-09-01T09:00:00Z',
  updatedAt: '2026-09-01T09:00:00Z',
}

const beta: ApiMeetingSeries = {
  ...alpha,
  id: 12,
  title: 'Beta Sync',
}

const gamma: ApiMeetingSeries = {
  ...alpha,
  id: 13,
  scope: 'project',
  projectId: 42,
  title: 'Gamma Sync',
}

function renderList(
  series: ApiMeetingSeries[],
) {
  vi.mocked(listMeetingSeries).mockResolvedValue(
    series,
  )

  return render(
    <MemoryRouter
      initialEntries={[
        '/meetings/series?group=3',
      ]}
    >
      <Routes>
        <Route
          path="/meetings/series"
          element={<MeetingSeriesListPage />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

function rowByTitle(title: string) {
  return screen.getByRole('button', {
    name: `Open ${title}`,
  })
}

function openRowDeleteMenu(
  title: string,
) {
  const row = rowByTitle(title)

  fireEvent.click(
    within(row).getByRole('button', {
      name: 'Template actions',
    }),
  )
  fireEvent.click(
    within(row).getByRole('menuitem', {
      name: 'Delete template',
    }),
  )
}

beforeEach(() => {
  scopeMock.role = 'admin'
  scopeMock.projectRole = 'owner'
  // Snapshot lazily so per-test role overrides are picked up.
  vi.mocked(
    listProjects,
  ).mockImplementation(async () => [
    projectSnapshot(),
  ])
  vi.mocked(deleteMeetingSeries).mockResolvedValue(
    undefined,
  )
  vi.mocked(createMeetingSeries).mockResolvedValue(
    null as unknown as ApiMeetingSeries,
  )
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('MeetingSeriesListPage row-level deletion', () => {
  it('renders a row actions trigger on each manageable template row', async () => {
    renderList([alpha, beta, gamma])

    const rowA = await screen.findByRole(
      'button',
      { name: 'Open Alpha Sync' },
    )
    const rowB = screen.getByRole('button', {
      name: 'Open Beta Sync',
    })
    const rowC = screen.getByRole('button', {
      name: 'Open Gamma Sync',
    })

    expect(
      within(rowA).getByRole('button', {
        name: 'Template actions',
      }),
    ).toBeVisible()
    expect(
      within(rowB).getByRole('button', {
        name: 'Template actions',
      }),
    ).toBeVisible()
    expect(
      within(rowC).getByRole('button', {
        name: 'Template actions',
      }),
    ).toBeVisible()
  })

  it('does not expose Delete for templates the user cannot manage', async () => {
    // Group member: no group-template management.
    scopeMock.role = 'member'
    // Project viewer: no project-template management.
    scopeMock.projectRole = 'viewer'

    renderList([alpha, beta, gamma])

    await screen.findByRole('button', {
      name: 'Open Alpha Sync',
    })

    expect(
      screen.queryByRole('button', {
        name: 'Template actions',
      }),
    ).not.toBeInTheDocument()
  })

  it('deletes the template of the row whose menu was opened, not another template', async () => {
    renderList([alpha, beta, gamma])

    await screen.findByRole('button', {
      name: 'Open Alpha Sync',
    })

    openRowDeleteMenu('Beta Sync')

    const dialog = screen.getByRole('dialog', {
      name: 'Delete meeting template?',
    })
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'Delete template',
      }),
    )

    await waitFor(() => {
      expect(deleteMeetingSeries).toHaveBeenCalledTimes(1)
      expect(deleteMeetingSeries).toHaveBeenCalledWith(12)
    })

    // Only the selected row is gone.
    expect(
      screen.queryByRole('button', {
        name: 'Open Beta Sync',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: 'Open Alpha Sync',
      }),
    ).toBeVisible()
    expect(
      screen.getByRole('button', {
        name: 'Open Gamma Sync',
      }),
    ).toBeVisible()
  })

  it('opening the menu shows a confirmation dialog that names the selected template', async () => {
    renderList([alpha, beta])

    await screen.findByRole('button', {
      name: 'Open Alpha Sync',
    })

    openRowDeleteMenu('Beta Sync')

    const dialog = screen.getByRole('dialog', {
      name: 'Delete meeting template?',
    })
    expect(dialog).toBeVisible()
    // The confirmation names the exact template.
    expect(
      within(dialog).getByText(/Beta Sync/),
    ).toBeInTheDocument()

    // No delete request before confirmation.
    expect(deleteMeetingSeries).not.toHaveBeenCalled()
  })

  it('cancelling performs no delete and leaves the row unchanged', async () => {
    renderList([alpha])

    const row = await screen.findByRole('button', {
      name: 'Open Alpha Sync',
    })

    openRowDeleteMenu('Alpha Sync')

    const dialog = screen.getByRole('dialog', {
      name: 'Delete meeting template?',
    })
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'Cancel',
      }),
    )

    expect(
      screen.queryByRole('dialog', {
        name: 'Delete meeting template?',
      }),
    ).not.toBeInTheDocument()
    expect(deleteMeetingSeries).not.toHaveBeenCalled()

    // The row is still rendered and intact.
    expect(row).toBeVisible()
    expect(
      within(row).getByText('Alpha template.'),
    ).toBeInTheDocument()
  })

  it('a failed delete keeps the template visible and surfaces the failure', async () => {
    vi.mocked(deleteMeetingSeries).mockRejectedValueOnce(
      new ApiError(500, {
        error: 'Server exploded.',
      }),
    )

    renderList([alpha])

    const row = await screen.findByRole('button', {
      name: 'Open Alpha Sync',
    })

    openRowDeleteMenu('Alpha Sync')

    const dialog = screen.getByRole('dialog', {
      name: 'Delete meeting template?',
    })
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'Delete template',
      }),
    )

    // The failure is surfaced inside the open confirmation.
    await waitFor(() => {
      expect(
        within(dialog).getByRole('alert'),
      ).toHaveTextContent('Server exploded.')
    })

    // No false success: dialog still open, row still present.
    expect(dialog).toBeVisible()
    expect(row).toBeVisible()
    expect(
      within(row).getByRole('button', {
        name: 'Template actions',
      }),
    ).toBeVisible()
  })

  it('does not submit the delete twice while the request is pending', async () => {
    let resolveDelete: () => void = () => {}

    vi.mocked(
      deleteMeetingSeries,
    ).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve
        }),
    )

    renderList([alpha])

    await screen.findByRole('button', {
      name: 'Open Alpha Sync',
    })

    openRowDeleteMenu('Alpha Sync')

    const dialog = screen.getByRole('dialog', {
      name: 'Delete meeting template?',
    })
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'Delete template',
      }),
    )

    await waitFor(() => {
      expect(deleteMeetingSeries).toHaveBeenCalledTimes(1)
    })

    // In-flight: the destructive action is disabled, so a
    // repeated click cannot start a second request.
    const busyButton = within(dialog).getByRole(
      'button',
      { name: 'Deleting…' },
    )
    expect(busyButton).toBeDisabled()
    fireEvent.click(busyButton)
    expect(
      deleteMeetingSeries,
    ).toHaveBeenCalledTimes(1)

    resolveDelete()

    await waitFor(() => {
      expect(
        screen.queryByRole('button', {
          name: 'Open Alpha Sync',
        }),
      ).not.toBeInTheDocument()
    })
    expect(
      deleteMeetingSeries,
    ).toHaveBeenCalledTimes(1)
  })

  it('clicking the row actions trigger does not open the template', async () => {
    renderList([alpha, beta])

    const row = await screen.findByRole('button', {
      name: 'Open Alpha Sync',
    })

    fireEvent.click(
      within(row).getByRole('button', {
        name: 'Template actions',
      }),
    )

    // The menu opened for this row and the list stayed put:
    // no navigation to the template detail.
    expect(
      within(row).getByRole('menuitem', {
        name: 'Delete template',
      }),
    ).toBeVisible()
    expect(row).toBeVisible()
    expect(
      screen.getByRole('button', {
        name: 'Open Beta Sync',
      }),
    ).toBeVisible()
  })
})
