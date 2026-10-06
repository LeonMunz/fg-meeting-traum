// @vitest-environment happy-dom

// LAYER-OWNERSHIP REGRESSION — Meeting Template import dialog vs.
// shell chrome.
//
// Root cause this spec pins:
// `.fg-route-content` (the AppShell <main>, the ONE named View
// Transition surface) carries `view-transition-name`, and per CSS
// View Transitions §2.1.1 (Rendering Consolidation) an element whose
// computed `view-transition-name` is not none — at ANY time, not only
// while a transition runs — forms a stacking context. While the
// "Replace agenda?" confirmation was rendered inside that <main> as
// route content of the Meeting Series detail page, its `fixed inset-0
// z-50` overlay competed only WITHIN the route-content context
// (effective z=0 at the root level). The fixed Sidebar (z-30, a
// sibling of the <main> in the root stacking context) therefore
// painted over the overlay wherever the two overlap — and at mobile
// widths the centered dialog spans the full viewport, so the Sidebar
// subtree intercepted pointer events aimed at the dialog's buttons.
//
// The fix is layer ownership, not a z-index escalation: the overlay
// portals to document.body (the application overlay root; the same
// pattern the Work Item inspector, create modal, and invitation
// dialog use), where it competes in the root stacking context.
//
// This spec reproduces the production containment relationship by
// mounting the page inside a `<main class="fg-route-content">`
// wrapper (the AppShell chrome itself is irrelevant to the contract —
// the stacking boundary is the <main>) and asserts the placement
// contract against the REAL MeetingSeriesDetailPage:
//   - the overlay scrim is a direct child of document.body and NOT a
//     descendant of the route content surface,
//   - the viewport-centered geometry and scrim classes are unchanged,
//   - the accessibility contract (role=dialog, aria-modal, labelled
//     title) is unchanged,
//   - outside-click cancellation still works across the portal,
//   - the pending state still protects the dialog from outside clicks.
//
// SCOPE: happy-dom has no layout engine, so this spec proves the
// DOM-level layer ownership/placement contract, not paint order or
// pixel geometry (the browser-visible result is covered by
// e2e/meeting-series-agenda-import.spec.ts and the manual visual
// check).

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
  getMeetingSeries,
  importMeetingSeriesAgenda,
  listMeetingSeriesSections,
} from '../../api/meetings'
import { getProject } from '../../api/projects'
import type {
  ApiMeetingSeries,
  ApiMeetingSeriesAgendaDocument,
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

const importDocument: ApiMeetingSeriesAgendaDocument = {
  schemaVersion: 1,
  sections: [
    {
      name: 'Alpha',
      description: '',
      isActive: true,
    },
  ],
}

// The AppShell <main> — the named View Transition surface and, per
// the View Transitions spec, the stacking context that traps
// anything rendered inside it.
function routeContent(): HTMLElement {
  const main = document.querySelector<HTMLElement>(
    'main.fg-route-content',
  )

  if (!main) {
    throw new Error('route content surface not found.')
  }

  return main
}

function renderPage() {
  vi.mocked(getMeetingSeries).mockResolvedValue(
    groupSeries,
  )
  vi.mocked(
    listMeetingSeriesSections,
  ).mockResolvedValue([])
  vi.mocked(getProject).mockResolvedValue({
    currentUserRole: 'owner',
  } as never)
  vi.mocked(importMeetingSeriesAgenda).mockResolvedValue(
    importDocument,
  )

  render(
    <MemoryRouter
      initialEntries={[
        `/meetings/series/${groupSeries.id}`,
      ]}
    >
      <Routes>
        <Route
          path="/meetings/series/:seriesId"
          element={
            <main className="fg-route-content">
              <MeetingSeriesDetailPage />
            </main>
          }
        />
      </Routes>
    </MemoryRouter>,
  )

  return screen.findByRole('heading', {
    name: 'Template Structure',
  })
}

function openImportDialog(): Promise<HTMLElement> {
  const input = screen.getByLabelText(
    /Import agenda JSON/,
  ) as HTMLInputElement

  const file = new File(
    [JSON.stringify(importDocument)],
    'agenda.json',
    { type: 'application/json' },
  )

  fireEvent.change(input, {
    target: { files: [file] },
  })

  const dialog = screen.findByRole('dialog', {
    name: 'Replace agenda?',
  })

  // The dialog panel; its direct parent is the overlay scrim.
  return dialog.then((panel) => panel.parentElement as HTMLElement)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  groupRoleMock.role = 'admin'
})

describe(
  'Meeting Template import dialog layer ownership',
  () => {
    it('renders the confirmation overlay on the document.body overlay root, not inside the route content', async () => {
      await renderPage()

      const scrim = await openImportDialog()

      // LAYER CONTRACT: the overlay root is a direct child of
      // document.body — the application overlay root — and NOT a
      // descendant of the route content surface whose
      // `view-transition-name` traps stacking.
      expect(scrim.parentElement).toBe(document.body)
      expect(routeContent().contains(scrim)).toBe(false)

      // The viewport-centered geometry and scrim are unchanged —
      // the fix moves DOM ownership, not placement.
      expect(scrim).toHaveClass(
        'fixed',
        'inset-0',
        'z-50',
      )

      // The route remains mounted BEHIND the overlay.
      expect(
        routeContent().contains(
          screen.getByRole('heading', {
            name: 'Template Structure',
          }),
        ),
      ).toBe(true)

      // Accessibility contract is unchanged: the labelled modal
      // dialog (getByRole already resolves the labelled title).
      const dialog = await screen.findByRole('dialog', {
        name: 'Replace agenda?',
      })
      expect(dialog).toHaveAttribute('aria-modal', 'true')
      expect(
        dialog.getAttribute('aria-labelledby'),
      ).toBeTruthy()
      expect(
        document.getElementById(
          dialog.getAttribute('aria-labelledby')!,
        ),
      ).toHaveTextContent('Replace agenda?')
    })

    it('still cancels the portaled overlay on an outside click', async () => {
      await renderPage()

      const scrim = await openImportDialog()

      // A press on the scrim itself dismisses the dialog — across
      // the portal.
      fireEvent.mouseDown(scrim)

      await waitFor(() => {
        expect(
          screen.queryByRole('dialog', {
            name: 'Replace agenda?',
          }),
        ).not.toBeInTheDocument()
      })
      expect(
        document.body.contains(scrim),
      ).toBe(false)

      // Cancelling made no import request and closed the overlay.
      expect(
        importMeetingSeriesAgenda,
      ).not.toHaveBeenCalled()
    })

    it('keeps the portaled overlay protected from outside clicks while the import is pending', async () => {
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

      await renderPage()

      const scrim = await openImportDialog()

      fireEvent.click(
        within(
          await screen.findByRole('dialog', {
            name: 'Replace agenda?',
          }),
        ).getByRole('button', {
          name: 'Replace agenda',
        }),
      )

      // Pending state: the confirmation button is disabled and the
      // dialog is visible.
      const pending = within(
        await screen.findByRole('dialog', {
          name: 'Replace agenda?',
        }),
      ).getByRole('button', { name: 'Importing…' })
      expect(pending).toBeDisabled()

      // An outside press must NOT cancel while pending.
      fireEvent.mouseDown(scrim)
      expect(
        screen.getByRole('dialog', {
          name: 'Replace agenda?',
        }),
      ).toBeVisible()

      resolveImport(importDocument)

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
  },
)
