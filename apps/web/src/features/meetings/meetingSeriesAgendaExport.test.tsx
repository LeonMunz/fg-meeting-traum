// @vitest-environment happy-dom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
  listMeetingSeriesSections,
  reorderMeetingSeriesSections,
  updateMeetingSeriesSection,
} from '../../api/meetings'
import { ApiError } from '../../api/client'
import type { ApiFileDownload } from '../../api/client'
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
  exportMeetingSeriesAgenda: vi.fn(),
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

function renderPage() {
  vi.mocked(getMeetingSeries).mockResolvedValue(
    groupSeries,
  )

  return render(
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
}

let createObjectURLSpy: ReturnType<
  typeof vi.spyOn
>
let revokeObjectURLSpy: ReturnType<
  typeof vi.spyOn
>
const clickedAnchors: HTMLAnchorElement[] = []

beforeEach(() => {
  groupRoleMock.role = 'admin'
  clickedAnchors.length = 0

  vi.mocked(listMeetingSeriesSections).mockResolvedValue(
    [],
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

  createObjectURLSpy = vi
    .spyOn(URL, 'createObjectURL')
    .mockReturnValue('blob:mock-123')
  revokeObjectURLSpy = vi
    .spyOn(URL, 'revokeObjectURL')
    .mockImplementation(() => undefined)
  vi.spyOn(
    HTMLAnchorElement.prototype,
    'click',
  ).mockImplementation(
    function (
      this: HTMLAnchorElement,
    ) {
      clickedAnchors.push(this)
    },
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe(
  'MeetingSeriesDetailPage agenda JSON export',
  () => {
    it('shows the export control to a reader who cannot manage the template', async () => {
      groupRoleMock.role = 'member'

      renderPage()

      await screen.findByRole('heading', {
        name: 'Template Structure',
      })

      const exportButton = screen.getByRole(
        'button',
        { name: 'Export agenda JSON' },
      )
      expect(exportButton).toBeVisible()
      expect(exportButton).toBeEnabled()

      // The destructive management control stays hidden.
      expect(
        screen.queryByRole('button', {
          name: 'Template actions',
        }),
      ).not.toBeInTheDocument()
    })

    it('keeps the management menu alongside the export control for a manager', async () => {
      renderPage()

      await screen.findByRole('button', {
        name: 'Export agenda JSON',
      })

      expect(
        screen.getByRole('button', {
          name: 'Template actions',
        }),
      ).toBeVisible()
    })

    it('downloads the exact server Blob once with the route Template id and the server filename', async () => {
      const payloadBlob = new Blob(
        ['{"schemaVersion":1,"sections":[]}'],
        { type: 'application/json' },
      )
      const textSpy = vi.spyOn(payloadBlob, 'text')

      vi.mocked(
        exportMeetingSeriesAgenda,
      ).mockResolvedValueOnce({
        blob: payloadBlob,
        filename:
          'Weekly-Research-Sync-agenda.json',
      })

      renderPage()

      await screen.findByRole('heading', {
        name: 'Template Structure',
      })

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Export agenda JSON',
        }),
      )

      await waitFor(() => {
        expect(exportMeetingSeriesAgenda).toHaveBeenCalledTimes(
          1,
        )
        expect(exportMeetingSeriesAgenda).toHaveBeenCalledWith(
          7,
        )
      })

      // The exact server-produced Blob is what the
      // browser downloads; it is never parsed or
      // read in the browser.
      expect(createObjectURLSpy).toHaveBeenCalledTimes(1)
      expect(createObjectURLSpy).toHaveBeenCalledWith(
        payloadBlob,
      )
      expect(textSpy).not.toHaveBeenCalled()

      expect(clickedAnchors).toHaveLength(1)
      const anchor = clickedAnchors[0]
      expect(anchor.href).toBe('blob:mock-123')
      expect(anchor.download).toBe(
        'Weekly-Research-Sync-agenda.json',
      )

      // The temporary anchor and object URL are
      // removed after activation.
      expect(anchor.isConnected).toBe(false)
      expect(revokeObjectURLSpy).toHaveBeenCalledWith(
        'blob:mock-123',
      )

      // A successful export surfaces no error.
      expect(
        screen.queryByRole('alert'),
      ).not.toBeInTheDocument()
    })

    it('falls back to the stable .json filename when the header filename is absent', async () => {
      vi.mocked(
        exportMeetingSeriesAgenda,
      ).mockResolvedValueOnce({
        blob: new Blob(['{}']),
        filename: null,
      })

      renderPage()

      await screen.findByRole('heading', {
        name: 'Template Structure',
      })

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Export agenda JSON',
        }),
      )

      await waitFor(() => {
        expect(createObjectURLSpy).toHaveBeenCalledTimes(
          1,
        )
      })

      expect(clickedAnchors).toHaveLength(1)
      // One stable safe name: no unsanitized Template
      // title text.
      expect(clickedAnchors[0].download).toBe(
        'meeting-template-agenda.json',
      )
    })

    it('prevents duplicate activation while the export is pending', async () => {
      let resolveExport: (
        value: ApiFileDownload,
      ) => void = () => undefined

      vi.mocked(
        exportMeetingSeriesAgenda,
      ).mockImplementationOnce(
        () =>
          new Promise<ApiFileDownload>(
            (resolve) => {
              resolveExport = resolve
            },
          ),
      )

      renderPage()

      await screen.findByRole('heading', {
        name: 'Template Structure',
      })

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Export agenda JSON',
        }),
      )

      // While pending the control is disabled and
      // exposes a visible pending state.
      const pending = await screen.findByRole(
        'button',
        { name: 'Exporting…' },
      )
      expect(pending).toBeDisabled()

      // A second activation attempt while pending is
      // a no-op: exactly one client call.
      fireEvent.click(pending)
      expect(exportMeetingSeriesAgenda).toHaveBeenCalledTimes(
        1,
      )

      resolveExport({
        blob: new Blob(['{}']),
        filename: null,
      })

      // The control is re-enabled afterwards.
      await screen.findByRole('button', {
        name: 'Export agenda JSON',
      })
      expect(exportMeetingSeriesAgenda).toHaveBeenCalledTimes(
        1,
      )
    })

    it('keeps the template page unchanged with retryable feedback after an API error', async () => {
      vi.mocked(
        exportMeetingSeriesAgenda,
      ).mockRejectedValueOnce(
        new ApiError(500, {
          error: 'Agenda export failed.',
        }),
      )

      renderPage()

      await screen.findByRole('heading', {
        name: 'Template Structure',
      })

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Export agenda JSON',
        }),
      )

      // Concise recoverable inline feedback.
      await screen.findByRole('alert')
      expect(
        screen.getByRole('alert'),
      ).toHaveTextContent('Agenda export failed.')

      // The Template page and agenda stay intact.
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
      // No download was started on failure.
      expect(
        createObjectURLSpy,
      ).not.toHaveBeenCalled()
      expect(clickedAnchors).toHaveLength(0)

      // A later activation retries normally.
      const retryBlob = new Blob(['{}'])
      vi.mocked(
        exportMeetingSeriesAgenda,
      ).mockResolvedValueOnce({
        blob: retryBlob,
        filename: 'retry.json',
      })

      const retry = await screen.findByRole(
        'button',
        { name: 'Export agenda JSON' },
      )
      expect(retry).toBeEnabled()
      fireEvent.click(retry)

      await waitFor(() => {
        expect(exportMeetingSeriesAgenda).toHaveBeenCalledTimes(
          2,
        )
      })
      expect(createObjectURLSpy).toHaveBeenCalledTimes(1)
      expect(createObjectURLSpy).toHaveBeenCalledWith(
        retryBlob,
      )
    })
  },
)
