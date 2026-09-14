// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, useLocation } from 'react-router'

import type { ApiUser } from '../../api/types'
import { TopBar } from './TopBar'

const { session } = vi.hoisted(() => ({
  session: {
    user: {
      id: 1,
      username: 'leon',
      firstName: 'Leo',
      lastName: 'Dev',
      email: 'leon@example.com',
    } as ApiUser,
    loading: false,
    error: null,
    login: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    setAuthenticatedUser: vi.fn(),
  },
}))

vi.mock('../../api/useSession', () => ({
  useSession: () => session,
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function LocationProbe() {
  const location = useLocation()

  return (
    <output aria-label="Current location">
      {location.pathname}
    </output>
  )
}

function renderTopBar(initialEntry = '/my-work') {
  const utils = render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <TopBar />
      <LocationProbe />
    </MemoryRouter>,
  )

  const location = () =>
    screen.getByLabelText('Current location').textContent

  return { location, ...utils }
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Leo' }))
}

describe('authenticated topbar user menu', () => {
  it('renders the username menu trigger and no permanent Sign out control', () => {
    renderTopBar()

    const trigger = screen.getByRole('button', { name: 'Leo' })

    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    // The permanent topbar Sign out button is gone.
    expect(
      screen.queryByRole('button', { name: 'Sign out' }),
    ).not.toBeInTheDocument()
  })

  it('opens and closes the menu from the trigger without navigating', () => {
    const { location } = renderTopBar()

    const trigger = screen.getByRole('button', { name: 'Leo' })

    fireEvent.click(trigger)

    const menu = screen.getByRole('menu')
    const items = within(menu).getAllByRole('menuitem')

    // Final contract: Profile, Invite, Settings, then a divider,
    // then Sign out.
    expect(items).toHaveLength(4)
    expect(items[0].textContent).toContain('Profile')
    expect(items[1].textContent).toContain('Invite to FG Workspace')
    expect(items[2].textContent).toContain('Settings')
    expect(items[3].textContent).toContain('Sign out')

    // The divider is the only non-interactive row, and it precedes
    // Sign out.
    const rows = Array.from(menu.children)
    expect(rows).toHaveLength(5)
    expect(rows[3].tagName).toBe('DIV')
    expect(rows[3].textContent).toBe('')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(trigger)

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(location()).toBe('/my-work')
  })

  it('Profile closes the menu and navigates to /profile', () => {
    const { location } = renderTopBar()

    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Profile' }))

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(location()).toBe('/profile')
  })

  it('Invite to FG Workspace opens the existing invite dialog, closes the menu, and does not navigate', () => {
    const { location } = renderTopBar()

    openMenu()
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Invite to FG Workspace' }),
    )

    // The existing dialog opened on the same page; the menu is closed.
    const dialog = screen.getByRole('dialog', {
      name: 'Invite to FG Workspace',
    })
    expect(within(dialog).getByLabelText('Email')).toBeVisible()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(location()).toBe('/my-work')
  })

  it('closing the invite dialog returns to the current page', () => {
    const { location } = renderTopBar()

    openMenu()
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Invite to FG Workspace' }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))

    expect(
      screen.queryByRole('dialog', { name: 'Invite to FG Workspace' }),
    ).not.toBeInTheDocument()
    expect(location()).toBe('/my-work')
  })

  it('Settings closes the menu and navigates to /settings/appearance', () => {
    const { location } = renderTopBar()

    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }))

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(location()).toBe('/settings/appearance')
  })

  it('Sign out closes the menu and uses the existing session logout', () => {
    renderTopBar()

    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }))

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(session.logout).toHaveBeenCalledTimes(1)
  })

  it('Escape closes the menu', () => {
    renderTopBar()

    openMenu()
    expect(screen.getByRole('menu')).toBeVisible()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Leo' }),
    ).toHaveAttribute('aria-expanded', 'false')
  })

  it('an outside click closes the menu', () => {
    renderTopBar()

    openMenu()
    expect(screen.getByRole('menu')).toBeVisible()

    fireEvent.mouseDown(document.body)

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Leo' }),
    ).toHaveAttribute('aria-expanded', 'false')
  })

  it('menu actions are keyboard operable buttons', () => {
    renderTopBar()

    openMenu()

    for (const label of [
      'Profile',
      'Invite to FG Workspace',
      'Settings',
      'Sign out',
    ]) {
      expect(
        screen.getByRole('menuitem', { name: label }),
      ).toHaveAttribute('type', 'button')
    }

    // Menu items are native, focusable buttons (keyboard operable by
    // browser semantics); the trigger itself is keyboard reachable.
    const settingsItem = screen.getByRole('menuitem', {
      name: 'Settings',
    }) as HTMLButtonElement
    settingsItem.focus()
    expect(document.activeElement).toBe(settingsItem)
  })
})
