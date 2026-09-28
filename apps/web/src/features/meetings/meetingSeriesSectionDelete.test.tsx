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
  deleteMeetingSeriesSection,
  getMeetingSeries,
  listMeetingSeriesSections,
  reorderMeetingSeriesSections,
  updateMeetingSeriesSection,
} from '../../api/meetings'
import { ApiError } from '../../api/client'
import { getProject } from '../../api/projects'
import type {
  ApiMeetingSeries,
  ApiMeetingSeriesSection,
  ApiProject,
} from '../../api/types'

import { MeetingSeriesDetailPage } from './MeetingSeriesDetailPage'

vi.mock('../../api/meetings', () => ({
  createMeetingFromSeries: vi.fn(),
  createMeetingSeriesSection: vi.fn(),
  deleteMeetingSeries: vi.fn(),
  deleteMeetingSeriesSection: vi.fn(),
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

const checkInSection: ApiMeetingSeriesSection = {
  id: 21,
  meetingSeriesId: 7,
  name: 'Check-In',
  description: 'How is everyone doing?',
  position: 0,
  isActive: true,
}

const topsSection: ApiMeetingSeriesSection = {
  id: 22,
  meetingSeriesId: 7,
  name: 'TOPs',
  description: 'Topic of the day.',
  position: 1,
  isActive: true,
}

// The server is authoritative: after a successful deletion the
// refetched section list no longer contains the deleted Section.
let currentSections: ApiMeetingSeriesSection[] = []

function renderPage(
  series: ApiMeetingSeries,
  sections: ApiMeetingSeriesSection[],
) {
  currentSections = sections
  vi.mocked(getMeetingSeries).mockResolvedValue(series)
  vi.mocked(listMeetingSeriesSections).mockImplementation(
    async () => currentSections,
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

async function openSectionDeleteDialog() {
  await screen.findByRole('heading', {
    name: 'Template Structure',
  })

  fireEvent.click(
    screen.getByRole('button', {
      name: 'Delete section TOPs',
    }),
  )

  return screen.getByRole('dialog', {
    name: 'Delete section "TOPs"?',
  })
}

beforeEach(() => {
  groupRoleMock.role = 'admin'
  currentSections = [
    checkInSection,
    topsSection,
  ]
  vi.mocked(deleteMeetingSeriesSection).mockImplementation(
    async (sectionId) => {
      currentSections = currentSections.filter(
        (section) => section.id !== sectionId,
      )
    },
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
    null as unknown as ApiMeetingSeriesSection,
  )
  vi.mocked(reorderMeetingSeriesSections).mockResolvedValue(
    [],
  )
  vi.mocked(updateMeetingSeriesSection).mockResolvedValue(
    null as unknown as ApiMeetingSeriesSection,
  )
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('MeetingSeriesDetailPage section deletion', () => {
  it('offers the delete action on the Section-Kachel to a user who can manage the template', async () => {
    renderPage(groupSeries, [
      checkInSection,
      topsSection,
    ])

    await screen.findByRole('heading', {
      name: 'Template Structure',
    })

    const trigger = screen.getByRole('button', {
      name: 'Delete section TOPs',
    })
    expect(trigger).toBeVisible()

    // The existing editing affordance stays intact next to it.
    expect(
      screen.getByRole('button', {
        name: 'Delete section Check-In',
      }),
    ).toBeVisible()
  })

  it('does not offer the delete action to a project viewer', async () => {
    vi.mocked(getProject).mockResolvedValue(
      {
        currentUserRole: 'viewer',
      } as unknown as ApiProject,
    )

    renderPage(projectSeries, [
      checkInSection,
      topsSection,
    ])

    await screen.findByRole('heading', {
      name: 'Template Structure',
    })
    // Let the project role lookup settle.
    await waitFor(() => {
      expect(getProject).toHaveBeenCalledWith(42)
    })

    expect(
      screen.queryByRole('button', {
        name: 'Delete section TOPs',
      }),
    ).not.toBeInTheDocument()
  })

  it('requires explicit confirmation, names the section, and explains the effect', async () => {
    renderPage(groupSeries, [
      checkInSection,
      topsSection,
    ])

    const dialog = await openSectionDeleteDialog()

    // The confirmation names the exact Section.
    expect(
      within(dialog).getByText(
        'Delete section "TOPs"?',
      ),
    ).toBeInTheDocument()

    // Existing Meetings keep their Sections.
    expect(
      within(dialog)
        .getByText(
          /already created keep their sections/,
        )
        .textContent,
    ).toMatch(/keep their sections/)

    // Future Meetings and not-yet-opened occurrences no
    // longer receive the Section.
    expect(
      within(dialog)
        .getByText(
          /will no longer include this section/,
        )
        .textContent,
    ).toMatch(/will no longer include this section/)

    // Not the last active Section: no extra explanation.
    expect(
      within(dialog).queryByText(
        /no agenda section/,
      ),
    ).not.toBeInTheDocument()

    // No delete request before confirmation.
    expect(
      deleteMeetingSeriesSection,
    ).not.toHaveBeenCalled()
  })

  it('explains the missing agenda section when deleting the last active section', async () => {
    renderPage(groupSeries, [
      { ...checkInSection, isActive: false },
      topsSection,
    ])

    const dialog = await openSectionDeleteDialog()

    expect(
      within(dialog)
        .getByText(
          /will initially have no agenda section/,
        )
        .textContent,
    ).toMatch(
      /will initially have no agenda section/,
    )
  })

  it('cancelling performs no write and keeps the section', async () => {
    renderPage(groupSeries, [
      checkInSection,
      topsSection,
    ])

    const dialog = await openSectionDeleteDialog()
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'Cancel',
      }),
    )

    expect(
      screen.queryByRole('dialog', {
        name: 'Delete section "TOPs"?',
      }),
    ).not.toBeInTheDocument()
    expect(
      deleteMeetingSeriesSection,
    ).not.toHaveBeenCalled()

    // The Section-Kachel is still rendered and intact.
    expect(
      screen.getByRole('button', {
        name: 'Delete section TOPs',
      }),
    ).toBeVisible()
  })

  it('a successful deletion refreshes the list and the Snapshot Preview', async () => {
    renderPage(groupSeries, [
      checkInSection,
      topsSection,
    ])

    const dialog = await openSectionDeleteDialog()
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'Delete section',
      }),
    )

    await waitFor(() => {
      expect(deleteMeetingSeriesSection)
        .toHaveBeenCalledTimes(1)
      expect(deleteMeetingSeriesSection).toHaveBeenCalledWith(22)
    })

    // The authoritative Template state is re-fetched from
    // the server (initial load + one refresh).
    await waitFor(() => {
      expect(
        vi.mocked(listMeetingSeriesSections)
          .mock.calls.length,
      ).toBeGreaterThanOrEqual(2)
    })

    // The dialog is closed; the Section-Kachel and the
    // Snapshot Preview entry are gone, the sibling stays.
    expect(
      screen.queryByRole('dialog', {
        name: 'Delete section "TOPs"?',
      }),
    ).not.toBeInTheDocument()
    await waitFor(() => {
      expect(
        screen.queryByRole('button', {
          name: 'Delete section TOPs',
        }),
      ).not.toBeInTheDocument()
    })
    expect(
      screen.getByRole('button', {
        name: 'Delete section Check-In',
      }),
    ).toBeVisible()
    // The Section name is gone from BOTH the section list
    // and the Snapshot Preview.
    await waitFor(() => {
      expect(
        screen.queryAllByText('TOPs', { exact: true }),
      ).toHaveLength(0)
    })
  })

  it('a failed deletion keeps the section and surfaces the existing action-error pattern', async () => {
    vi.mocked(deleteMeetingSeriesSection)
      .mockRejectedValueOnce(
        new ApiError(500, {
          error: 'Server exploded.',
        }),
      )

    renderPage(groupSeries, [
      checkInSection,
      topsSection,
    ])

    const dialog = await openSectionDeleteDialog()
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'Delete section',
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
    // The Section-Kachel is preserved.
    expect(
      screen.getByRole('button', {
        name: 'Delete section TOPs',
      }),
    ).toBeVisible()
    expect(
      deleteMeetingSeriesSection,
    ).toHaveBeenCalledTimes(1)
  })
})
