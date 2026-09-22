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
  createMeetingFromSeries,
  createMeetingSeriesSection,
  deleteMeetingSeries,
  getMeetingSeries,
  listMeetingSeriesSections,
  reorderMeetingSeriesSections,
  updateMeetingSeriesSection,
} from '../../api/meetings'
import { ApiError } from '../../api/client'
import { getProject } from '../../api/projects'
import type {
  ApiMeetingSeries,
  ApiProject,
} from '../../api/types'

import { MeetingSeriesDetailPage } from './MeetingSeriesDetailPage'

vi.mock('../../api/meetings', () => ({
  createMeetingFromSeries: vi.fn(),
  createMeetingSeriesSection: vi.fn(),
  deleteMeetingSeries: vi.fn(),
  getMeetingSeries: vi.fn(),
  listMeetingSeriesSections: vi.fn(),
  reorderMeetingSeriesSections: vi.fn(),
  updateMeetingSeriesSection: vi.fn(),
}))

vi.mock('../../api/projects', () => ({
  getProject: vi.fn(),
}))

vi.mock('../../api/useSession', () => ({
  useSession: () => ({
    user: { id: 1, username: 'alex' },
  }),
}))

const groupRoleMock = vi.hoisted(() => ({
  role: 'admin' as 'admin' | 'member',
}))

vi.mock('../research-group/useResearchGroup', () => ({
  useResearchGroup: () => ({
    groups: [
      {
        id: 3,
        name: 'FG Group',
        role: groupRoleMock.role,
      },
    ],
    activeResearchGroupId: 3,
    activeResearchGroup: {
      id: 3,
      name: 'FG Group',
      role: groupRoleMock.role,
    },
    loading: false,
    error: null,
    setActiveResearchGroupId: vi.fn(),
    reloadResearchGroups: vi.fn(),
    addResearchGroup: vi.fn(),
  }),
}))

vi.mock(
  '../research-group/useSyncResearchGroupContext',
  () => ({
    useSyncResearchGroupContext: vi.fn(),
  }),
)

const groupSeries: ApiMeetingSeries = {
  id: 7,
  researchGroupId: 3,
  scope: 'group',
  projectId: null,
  title: 'Weekly Research Sync',
  description: 'Weekly template.',
  isArchived: false,
  createdById: 1,
  createdAt: '2026-09-01T09:00:00Z',
  updatedAt: '2026-09-01T09:00:00Z',
}

const projectSeries: ApiMeetingSeries = {
  ...groupSeries,
  id: 8,
  scope: 'project',
  projectId: 42,
}

function renderPage(
  series: ApiMeetingSeries,
) {
  vi.mocked(getMeetingSeries).mockResolvedValue(
    series,
  )

  return render(
    <MemoryRouter
      initialEntries={[
        `/meetings/series/${series.id}`,
      ]}
    >
      <Routes>
        <Route
          path="/meetings/series"
          element={
            <div data-testid="series-list-probe">
              template list
            </div>
          }
        />
        <Route
          path="/meetings/series/:seriesId"
          element={<MeetingSeriesDetailPage />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

function openDeleteMenu() {
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Template actions',
    }),
  )
  fireEvent.click(
    screen.getByRole('menuitem', {
      name: 'Delete template',
    }),
  )
}

beforeEach(() => {
  groupRoleMock.role = 'admin'
  vi.mocked(listMeetingSeriesSections).mockResolvedValue(
    [],
  )
  vi.mocked(deleteMeetingSeries).mockResolvedValue(
    undefined,
  )
  vi.mocked(getProject).mockResolvedValue(
    {
      currentUserRole: 'owner',
    } as unknown as ApiProject,
  )
  vi.mocked(createMeetingFromSeries).mockResolvedValue(
    null as unknown as import('../../api/types').ApiMeeting,
  )
  vi.mocked(createMeetingSeriesSection).mockResolvedValue(
    null as unknown as import('../../api/types').ApiMeetingSeriesSection,
  )
  vi.mocked(reorderMeetingSeriesSections).mockResolvedValue(
    [],
  )
  vi.mocked(updateMeetingSeriesSection).mockResolvedValue(
    null as unknown as import('../../api/types').ApiMeetingSeriesSection,
  )
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('MeetingSeriesDetailPage template deletion', () => {
  it('offers the delete action to a user who can manage the template', async () => {
    renderPage(groupSeries)

    await screen.findByRole('heading', {
      name: 'Template Structure',
    })

    const trigger = screen.getByRole('button', {
      name: 'Template actions',
    })
    expect(trigger).toBeVisible()

    fireEvent.click(trigger)
    expect(
      screen.getByRole('menuitem', {
        name: 'Delete template',
      }),
    ).toBeVisible()
  })

  it('does not offer the delete action to a user who cannot manage the template', async () => {
    groupRoleMock.role = 'member'

    renderPage(groupSeries)

    await screen.findByRole('heading', {
      name: 'Template Structure',
    })

    expect(
      screen.queryByRole('button', {
        name: 'Template actions',
      }),
    ).not.toBeInTheDocument()
  })

  it('requires explicit confirmation and names the template before deleting', async () => {
    renderPage(groupSeries)

    await screen.findByRole('heading', {
      name: 'Template Structure',
    })

    openDeleteMenu()

    const dialog = screen.getByRole('dialog', {
      name: 'Delete meeting template?',
    })
    expect(dialog).toBeVisible()
    // The confirmation names the exact template.
    expect(
      within(dialog).getByText(/Weekly Research Sync/),
    ).toBeInTheDocument()

    // No delete request before confirmation.
    expect(deleteMeetingSeries).not.toHaveBeenCalled()
  })

  it('cancelling leaves the template unchanged', async () => {
    renderPage(groupSeries)

    await screen.findByRole('heading', {
      name: 'Template Structure',
    })

    openDeleteMenu()

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

    // The template is still rendered and intact.
    expect(
      screen.getByRole('heading', {
        name: 'Template Structure',
      }),
    ).toBeVisible()
    expect(
      screen.getByText(
        'Weekly Research Sync. Edit the default sections for this meeting template. New occurrences will snapshot these sections.',
      ),
    ).toBeInTheDocument()
  })

  it('confirming invokes the delete operation for that template and leaves the detail state', async () => {
    renderPage(groupSeries)

    await screen.findByRole('heading', {
      name: 'Template Structure',
    })

    openDeleteMenu()

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
      expect(deleteMeetingSeries).toHaveBeenCalledWith(7)
    })

    // After the server confirms deletion the page leaves the
    // deleted template's detail state (the template list is the
    // new authoritative view, re-fetched from the server).
    await screen.findByTestId('series-list-probe')
    expect(
      screen.queryByRole('heading', {
        name: 'Template Structure',
      }),
    ).not.toBeInTheDocument()
  })

  it('a failed delete keeps the template state and surfaces the failure', async () => {
    vi.mocked(deleteMeetingSeries).mockRejectedValueOnce(
      new ApiError(500, {
        error: 'Server exploded.',
      }),
    )

    renderPage(groupSeries)

    await screen.findByRole('heading', {
      name: 'Template Structure',
    })

    openDeleteMenu()

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

    // The dialog is still open: no false success.
    expect(dialog).toBeVisible()
    // No navigation away from the template detail.
    expect(
      screen.queryByTestId('series-list-probe'),
    ).not.toBeInTheDocument()
    // The template state is preserved.
    expect(
      screen.getByRole('heading', {
        name: 'Template Structure',
      }),
    ).toBeVisible()
    expect(
      screen.getByText(
        'Weekly Research Sync. Edit the default sections for this meeting template. New occurrences will snapshot these sections.',
      ),
    ).toBeInTheDocument()
  })

  it('offers deletion to a project owner but not a project viewer', async () => {
    vi.mocked(getProject).mockResolvedValue(
      {
        currentUserRole: 'owner',
      } as unknown as ApiProject,
    )

    renderPage(projectSeries)

    await screen.findByRole('button', {
      name: 'Template actions',
    })

    // Viewer on the same project-scoped template.
    cleanup()
    vi.mocked(getProject).mockResolvedValue(
      {
        currentUserRole: 'viewer',
      } as unknown as ApiProject,
    )

    renderPage(projectSeries)

    await screen.findByRole('heading', {
      name: 'Template Structure',
    })
    // Let the project role lookup settle.
    await waitFor(() => {
      expect(getProject).toHaveBeenCalledWith(42)
    })

    expect(
      screen.queryByRole('button', {
        name: 'Template actions',
      }),
    ).not.toBeInTheDocument()
  })
})
