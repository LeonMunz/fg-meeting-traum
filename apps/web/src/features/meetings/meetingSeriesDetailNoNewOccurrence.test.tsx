// @vitest-environment happy-dom

import {
  cleanup,
  render,
  screen,
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
  createMeetingSeriesSection,
  deleteMeetingSeries,
  getMeetingSeries,
  listMeetingSeriesSections,
  reorderMeetingSeriesSections,
  updateMeetingSeriesSection,
} from '../../api/meetings'
import { getProject } from '../../api/projects'
import type {
  ApiMeetingSeries,
  ApiMeetingSeriesSection,
  ApiProject,
} from '../../api/types'

import { MeetingSeriesDetailPage } from './MeetingSeriesDetailPage'

vi.mock('../../api/meetings', () => ({
  createMeetingSeriesSection: vi.fn(),
  deleteMeetingSeries: vi.fn(),
  exportMeetingSeriesAgenda: vi.fn(),
  getMeetingSeries: vi.fn(),
  importMeetingSeriesAgenda: vi.fn(),
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

const series: ApiMeetingSeries = {
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

const checkInSection: ApiMeetingSeriesSection = {
  id: 21,
  meetingSeriesId: 7,
  name: 'Check-In',
  description: 'How is everyone doing?',
  position: 0,
  isActive: true,
}

const inactiveSection: ApiMeetingSeriesSection = {
  id: 22,
  meetingSeriesId: 7,
  name: 'Parking Lot',
  description: 'Deferred topics.',
  position: 1,
  isActive: false,
}

function renderPage() {
  vi.mocked(getMeetingSeries).mockResolvedValue(series)
  vi.mocked(listMeetingSeriesSections).mockResolvedValue([
    checkInSection,
    inactiveSection,
  ])
  vi.mocked(getProject).mockResolvedValue(
    {
      currentUserRole: 'owner',
    } as unknown as ApiProject,
  )

  return render(
    <MemoryRouter
      initialEntries={[
        `/meetings/series/${series.id}`,
      ]}
    >
      <Routes>
        <Route
          path="/meetings/series/:seriesId"
          element={<MeetingSeriesDetailPage />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  groupRoleMock.role = 'admin'
  vi.mocked(createMeetingSeriesSection).mockResolvedValue(
    null as unknown as ApiMeetingSeriesSection,
  )
  vi.mocked(deleteMeetingSeries).mockResolvedValue(
    undefined,
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

describe(
  'MeetingSeriesDetailPage: no New Occurrence card',
  () => {
    it('renders no occurrence creation UI at all', async () => {
      renderPage()

      await screen.findByRole('heading', {
        name: 'Template Structure',
      })

      // Card heading and both explanatory sentences are gone.
      expect(
        screen.queryByRole('heading', {
          name: 'New Occurrence',
        }),
      ).not.toBeInTheDocument()
      expect(
        screen.queryByText(
          /Create a meeting from this template\./,
        ),
      ).not.toBeInTheDocument()
      expect(
        screen.queryByText(
          /Active sections will be snapshotted\./,
        ),
      ).not.toBeInTheDocument()

      // No occurrence form fields or submit action remain.
      expect(
        screen.queryByLabelText('Title'),
      ).not.toBeInTheDocument()
      expect(
        screen.queryByLabelText('Date & Time'),
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', {
          name: /Create meeting/,
        }),
      ).not.toBeInTheDocument()
    })

    it('keeps the Snapshot Preview as the only sidebar card, without dead spacing', async () => {
      renderPage()

      const preview = await screen.findByRole(
        'heading',
        { name: 'Snapshot Preview' },
      )

      // Only the ACTIVE section is listed.
      const aside = preview.closest('aside')!
      expect(within(aside).getByText('Check-In')).toBeVisible()
      expect(
        within(aside).queryByText('Parking Lot'),
      ).not.toBeInTheDocument()

      // Exactly one card remains in the sidebar: no empty
      // card and no leftover separation margin.
      const sidebar = screen.getByRole('complementary')
      expect(sidebar.children).toHaveLength(1)
      expect(sidebar.firstElementChild?.className).not.toMatch(/\bmt-\d+\b/)

      // No form survives in the sidebar.
      expect(
        within(aside).queryByRole('form'),
      ).not.toBeInTheDocument()
    })

    it('keeps the remaining template controls intact', async () => {
      renderPage()

      await screen.findByRole('heading', {
        name: 'Template Structure',
      })

      expect(
        screen.getByText(
          /Edit the default sections for this meeting template\./,
        ),
      ).toBeVisible()
      expect(
        screen.getByText('Research Group Meeting', {
          exact: true,
        }),
      ).toBeVisible()
      expect(
        screen.getByRole('button', { name: 'Add section' }),
      ).toBeVisible()
      expect(
        screen.getByRole('button', {
          name: 'Export agenda JSON',
        }),
      ).toBeVisible()
      expect(
        screen.getByLabelText(/Import agenda JSON/),
      ).toBeInTheDocument()
    })
  },
)
