// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, useLocation } from 'react-router'

import { Sidebar } from './Sidebar'

vi.mock('../../features/research-group/ResearchGroupSelector', () => ({
  ResearchGroupSelector: () => <div>Research group selector</div>,
}))

vi.mock('../../features/research-group/useResearchGroup', () => ({
  useResearchGroup: () => ({
    groups: [{ id: 17, name: 'Research group' }],
    activeResearchGroupId: 17,
    loading: false,
  }),
}))

afterEach(cleanup)

function LocationProbe() {
  const location = useLocation()

  return <output aria-label="Current location">{`${location.pathname}${location.search}`}</output>
}

function renderSidebar(initialEntry = '/meetings?group=17') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Sidebar />
      <LocationProbe />
    </MemoryRouter>,
  )
}

describe('Sidebar personal navigation', () => {
  it('renders Notes directly with Home and My Work, in that order', () => {
    renderSidebar()

    // The personal navigation is the first (unlabeled) nav in the
    // aside, ahead of the research-group section.
    const personalNav = screen.getAllByRole('navigation')[0]
    const entries = Array.from(personalNav.children)

    expect(entries.map((entry) => entry.textContent)).toEqual([
      'homeHome',
      'assignmentMy Work',
      'sticky_note_2Notes',
    ])
  })

  it('points Notes at /notes without any research-group scoping', () => {
    // An active research group is in effect (the mocked
    // useResearchGroup provides activeResearchGroupId 17) — the
    // group-scoped entries carry ?group=…, Notes must not.
    renderSidebar()

    const notes = screen.getByRole('link', { name: /Notes/ })
    expect(notes).toHaveAttribute('href', '/notes')
    expect(notes.getAttribute('href')).not.toContain('group')
  })

  it('highlights Notes when /notes is active', () => {
    renderSidebar('/notes')

    expect(
      screen.getByRole('link', { name: /Notes/ }),
    ).toHaveAttribute('aria-current', 'page')
  })
})

describe('Sidebar research group navigation', () => {
  it('renders active and future sections in the planned order', () => {
    renderSidebar()

    const navigation = screen.getByRole('navigation', {
      name: 'Research group navigation',
    })
    const entries = Array.from(navigation.children)

    expect(entries.map((entry) => entry.textContent)).toEqual([
      'folder_openProjects',
      'groupsMeetings',
      'calendar_todayCalendar',
      'databaseKVP',
      'library_booksKnowledge',
      'storageDataAI',
      'groupPeople',
    ])

    expect(within(navigation).getByRole('link', { name: /Projects/ })).toHaveAttribute(
      'href',
      '/projects?group=17',
    )
    expect(within(navigation).getByRole('link', { name: /Meetings/ })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('keeps Notifications as the only bottom entry, without Settings or Profile', () => {
    renderSidebar()

    const notifications = screen.getByRole('link', {
      name: /Notifications/,
    })
    expect(notifications).toHaveAttribute('href', '/notifications')

    // Personal account destinations moved exclusively to the topbar
    // user menu.
    expect(
      screen.queryByRole('link', { name: /Settings/ }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: /Profile/ }),
    ).not.toBeInTheDocument()
  })

  it('renders future sections as disabled, struck-through non-links', () => {
    renderSidebar()

    const navigation = screen.getByRole('navigation', {
      name: 'Research group navigation',
    })

    for (const label of ['Calendar', 'KVP', 'Knowledge', 'Data', 'People']) {
      expect(
        within(navigation).queryByRole('link', {
          name: new RegExp(label),
        }),
      ).not.toBeInTheDocument()

      const text = within(navigation).getByText(label, { exact: true })
      expect(text).toHaveClass('line-through')
      expect(text.parentElement).toHaveAttribute('aria-disabled', 'true')
    }

    const dataEntry = within(navigation).getByText('Data', { exact: true }).parentElement
    expect(within(dataEntry!).getByText('AI')).toBeInTheDocument()
  })

  it('cannot navigate when a future entry is clicked', () => {
    renderSidebar('/projects?group=17')

    fireEvent.click(screen.getByText('Calendar', { exact: true }))

    expect(screen.getByRole('status', { name: 'Current location' })).toHaveTextContent(
      '/projects?group=17',
    )
  })
})
