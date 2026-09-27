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
  exportMeetingSeriesAgenda,
  getMeetingSeries,
  importMeetingSeriesAgenda,
  listMeetingSeriesSections,
  reorderMeetingSeriesSections,
  updateMeetingSeriesSection,
} from '../../api/meetings'
import { ApiError } from '../../api/client'
import { getProject } from '../../api/projects'
import type {
  ApiMeetingSeries,
  ApiMeetingSeriesAgendaDocument,
  ApiMeetingSeriesSection,
  ApiProject,
} from '../../api/types'

import { MeetingSeriesDetailPage } from './MeetingSeriesDetailPage'

vi.mock('../../api/meetings', () => ({
  createMeetingFromSeries: vi.fn(),
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

function section(
  id: number,
  name: string,
  position: number,
): ApiMeetingSeriesSection {
  return {
    id,
    meetingSeriesId: 7,
    name,
    description: '',
    position,
    isActive: true,
  }
}

const importInput = () =>
  screen.getByLabelText(
    /Import agenda JSON/,
  ) as HTMLInputElement

// A section name renders once in the section list and, for
// active sections, again in the Snapshot Preview. Scope name
// queries to the section list container to stay strict.
const sectionList = () =>
  within(
    screen.getByText('Sections').closest(
      'section',
    ) as HTMLElement,
  )

function selectFile(
  content: string,
  name = 'agenda.json',
) {
  const file = new File(
    [content],
    name,
    { type: 'application/json' },
  )

  fireEvent.change(importInput(), {
    target: { files: [file] },
  })
}

async function renderLoaded(
  initialSections: ApiMeetingSeriesSection[] = [],
) {
  vi.mocked(getMeetingSeries).mockResolvedValue(
    groupSeries,
  )
  vi.mocked(
    listMeetingSeriesSections,
  ).mockResolvedValue(initialSections)

  render(
    <MemoryRouter
      initialEntries={[
        `/meetings/series/${groupSeries.id}`,
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

  await screen.findByRole('heading', {
    name: 'Template Structure',
  })
}

const validDocument: ApiMeetingSeriesAgendaDocument =
  {
    schemaVersion: 1,
    sections: [
      {
        name: 'Check-In',
        description: '',
        isActive: true,
      },
      {
        name: 'Research',
        description: '',
        isActive: true,
      },
    ],
  }

beforeEach(() => {
  groupRoleMock.role = 'admin'

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
  vi.mocked(exportMeetingSeriesAgenda).mockResolvedValue({
    blob: new Blob(['{}']),
    filename: null,
  })
  vi.mocked(
    listMeetingSeriesSections,
  ).mockResolvedValue([])
  vi.mocked(importMeetingSeriesAgenda).mockResolvedValue(
    validDocument,
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe(
  'MeetingSeriesDetailPage agenda JSON import',
  () => {
    it('hides the import control from a readable non-manager while keeping the export control', async () => {
      groupRoleMock.role = 'member'

      await renderLoaded()

      expect(
        screen.queryByLabelText(/Import agenda JSON/),
      ).not.toBeInTheDocument()
      expect(
        screen.getByRole('button', {
          name: 'Export agenda JSON',
        }),
      ).toBeVisible()
    })

    it('shows the import control to a manager alongside export and the actions menu', async () => {
      await renderLoaded()

      expect(importInput()).toBeInTheDocument()
      expect(
        screen.getByRole('button', {
          name: 'Export agenda JSON',
        }),
      ).toBeVisible()
      expect(
        screen.getByRole('button', {
          name: 'Template actions',
        }),
      ).toBeVisible()
    })

    it('stages one selected file behind an explicit named confirmation; cancelling makes no request and leaves the page unchanged', async () => {
      await renderLoaded([section(100, 'Old A', 0)])

      selectFile(JSON.stringify(validDocument))

      const dialog = await screen.findByRole(
        'dialog',
        { name: 'Replace agenda?' },
      )
      expect(
        within(dialog).getByText(/Weekly Research Sync/),
      ).toBeInTheDocument()
      expect(
        within(dialog).getByText(
          /replaces the complete existing agenda/,
        ),
      ).toBeInTheDocument()

      // No request is made until the user confirms.
      expect(
        importMeetingSeriesAgenda,
      ).not.toHaveBeenCalled()

      fireEvent.click(
        within(dialog).getByRole('button', {
          name: 'Cancel',
        }),
      )

      await waitFor(() => {
        expect(
          screen.queryByRole('dialog', {
            name: 'Replace agenda?',
          }),
        ).not.toBeInTheDocument()
      })
      expect(
        importMeetingSeriesAgenda,
      ).not.toHaveBeenCalled()
      expect(
        sectionList().getByText('Old A'),
      ).toBeInTheDocument()
    })

    it('confirmation causes exactly one client call with the route id and the parsed document', async () => {
      await renderLoaded()

      selectFile(JSON.stringify(validDocument))

      const dialog = await screen.findByRole(
        'dialog',
        { name: 'Replace agenda?' },
      )

      fireEvent.click(
        within(dialog).getByRole('button', {
          name: 'Replace agenda',
        }),
      )

      await waitFor(() => {
        expect(
          importMeetingSeriesAgenda,
        ).toHaveBeenCalledTimes(1)
      })
      expect(
        importMeetingSeriesAgenda,
      ).toHaveBeenCalledWith(7, validDocument)
    })

    it('prevents duplicate confirmation while the import is pending', async () => {
      let resolveImport: (
        value: ApiMeetingSeriesAgendaDocument,
      ) => void = () => undefined

      vi.mocked(
        importMeetingSeriesAgenda,
      ).mockImplementationOnce(
        () =>
          new Promise<
            ApiMeetingSeriesAgendaDocument
          >((resolve) => {
            resolveImport = resolve
          }),
      )

      await renderLoaded()

      selectFile(JSON.stringify(validDocument))

      const dialog = await screen.findByRole(
        'dialog',
        { name: 'Replace agenda?' },
      )

      fireEvent.click(
        within(dialog).getByRole('button', {
          name: 'Replace agenda',
        }),
      )

      const pending = within(dialog).getByRole(
        'button',
        { name: 'Importing…' },
      )
      expect(pending).toBeDisabled()

      fireEvent.click(pending)
      expect(
        importMeetingSeriesAgenda,
      ).toHaveBeenCalledTimes(1)

      resolveImport(validDocument)

      await waitFor(() => {
        expect(
          screen.queryByRole('dialog', {
            name: 'Replace agenda?',
          }),
        ).not.toBeInTheDocument()
      })
      expect(
        importMeetingSeriesAgenda,
      ).toHaveBeenCalledTimes(1)
    })

    it('on success performs the authoritative Sections refetch and renders the replacement order', async () => {
      vi.mocked(listMeetingSeriesSections)
        .mockResolvedValueOnce([
          section(100, 'Old A', 0),
          section(101, 'Old B', 1),
        ])
        .mockResolvedValueOnce([
          section(200, 'New X', 0),
          section(201, 'New Y', 1),
        ])

      vi.mocked(
        importMeetingSeriesAgenda,
      ).mockResolvedValue(validDocument)

      await renderLoaded()

      expect(sectionList().getByText('Old A')).toBeInTheDocument()

      selectFile(JSON.stringify(validDocument))

      const dialog = await screen.findByRole(
        'dialog',
        { name: 'Replace agenda?' },
      )
      fireEvent.click(
        within(dialog).getByRole('button', {
          name: 'Replace agenda',
        }),
      )

      await sectionList().findByText('New X')
      expect(
        sectionList().queryByText('Old A'),
      ).toBeNull()
      expect(
        sectionList().queryByText('Old B'),
      ).toBeNull()

      await waitFor(() => {
        expect(
          listMeetingSeriesSections,
        ).toHaveBeenCalledTimes(2)
      })
      expect(
        listMeetingSeriesSections,
      ).toHaveBeenLastCalledWith(7)

      const names = sectionList()
        .getAllByText(/^(New X|New Y)$/)
        .map((el) => el.textContent)
      expect(names).toEqual(['New X', 'New Y'])

      expect(
        screen.getByText(
          'Weekly Research Sync. Edit the default sections for this meeting template. New occurrences will snapshot these sections.',
        ),
      ).toBeInTheDocument()
    })

    it('lets the same file be selected again after a failed import', async () => {
      vi.mocked(
        importMeetingSeriesAgenda,
      ).mockRejectedValueOnce(
        new ApiError(400, {
          error: 'Unsupported schema version.',
        }),
      )

      await renderLoaded()

      selectFile(JSON.stringify(validDocument))
      const dialog = await screen.findByRole(
        'dialog',
        { name: 'Replace agenda?' },
      )
      fireEvent.click(
        within(dialog).getByRole('button', {
          name: 'Replace agenda',
        }),
      )
      await within(dialog).findByRole('alert')

      // The input was cleared, so choosing the same file
      // again fires a fresh change and re-opens the
      // confirmation.
      vi.mocked(
        importMeetingSeriesAgenda,
      ).mockResolvedValue(validDocument)

      selectFile(JSON.stringify(validDocument))

      const reopened = await screen.findByRole(
        'dialog',
        { name: 'Replace agenda?' },
      )
      fireEvent.click(
        within(reopened).getByRole('button', {
          name: 'Replace agenda',
        }),
      )

      await waitFor(() => {
        expect(
          importMeetingSeriesAgenda,
        ).toHaveBeenCalledTimes(2)
      })
      expect(
        screen.queryByRole('dialog', {
          name: 'Replace agenda?',
        }),
      ).toBeNull()
    })

    it('malformed local JSON makes no import request and shows retryable inline feedback', async () => {
      await renderLoaded([section(100, 'Old A', 0)])

      selectFile('{not valid json')

      await screen.findByRole('alert')
      expect(
        screen.getByRole('alert'),
      ).toHaveTextContent(
        'The selected file is not valid JSON.',
      )
      expect(
        screen.queryByRole('dialog', {
          name: 'Replace agenda?',
        }),
      ).not.toBeInTheDocument()
      expect(
        importMeetingSeriesAgenda,
      ).not.toHaveBeenCalled()

      // The existing agenda is untouched and a valid file
      // can still be staged (retryable).
      expect(
        sectionList().getByText('Old A'),
      ).toBeInTheDocument()

      selectFile(JSON.stringify(validDocument))
      await screen.findByRole('dialog', {
        name: 'Replace agenda?',
      })
      expect(
        importMeetingSeriesAgenda,
      ).not.toHaveBeenCalled()
    })

    it('keeps the agenda intact with retryable feedback when the import request fails', async () => {
      vi.mocked(
        importMeetingSeriesAgenda,
      ).mockRejectedValueOnce(
        new ApiError(403, {
          error: 'You cannot write this template.',
        }),
      )

      await renderLoaded([section(100, 'Old A', 0)])

      expect(sectionList().getByText('Old A')).toBeInTheDocument()

      selectFile(JSON.stringify(validDocument))

      const dialog = await screen.findByRole(
        'dialog',
        { name: 'Replace agenda?' },
      )
      fireEvent.click(
        within(dialog).getByRole('button', {
          name: 'Replace agenda',
        }),
      )

      await within(dialog).findByRole('alert')
      expect(
        within(dialog).getByRole('alert'),
      ).toHaveTextContent(
        'You cannot write this template.',
      )
      expect(dialog).toBeVisible()
      expect(
        sectionList().getByText('Old A'),
      ).toBeInTheDocument()
      expect(
        listMeetingSeriesSections,
      ).toHaveBeenCalledTimes(1)
    })
  },
)
