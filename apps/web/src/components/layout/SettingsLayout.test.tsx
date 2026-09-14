// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react'
import {
  MemoryRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  APPEARANCE_STORAGE_KEY,
} from '../../features/appearance/appearance'
import { AppearanceProvider } from '../../features/appearance/AppearanceProvider'
import { AppearanceSettingsPage } from '../../features/appearance/AppearanceSettingsPage'
import { InvitationsSettingsPage } from '../../features/account-invitations/InvitationsSettingsPage'
import { listAccountInvitations } from '../../api/account-invitations'
import { SettingsLayout } from './SettingsLayout'

vi.mock('../../api/account-invitations', () => ({
  listAccountInvitations: vi.fn(),
  createAccountInvitation: vi.fn(),
  revokeAccountInvitation: vi.fn(),
}))

function LocationProbe() {
  const location = useLocation()

  return <span data-testid="settings-location">{location.pathname}</span>
}

function renderSettings(initialEntry: string) {
  document.documentElement.dataset.theme = 'dark'

  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/settings" element={<SettingsLayout />}>
          <Route
            index
            element={<Navigate to="appearance" replace />}
          />
          <Route
            path="appearance"
            element={
              <AppearanceProvider>
                <AppearanceSettingsPage />
              </AppearanceProvider>
            }
          />
          <Route
            path="invitations"
            element={<InvitationsSettingsPage />}
          />
        </Route>
      </Routes>

      <LocationProbe />
    </MemoryRouter>,
  )
}

function currentPath(): string {
  return screen
    .getByTestId('settings-location')
    .textContent ?? ''
}

const appearanceNav = () =>
  screen.getByRole('link', { name: 'Appearance' })
const invitationsNav = () =>
  screen.getByRole('link', { name: 'Invitations' })

beforeEach(() => {
  vi.clearAllMocks()
  ;(listAccountInvitations as ReturnType<typeof vi.fn>).mockResolvedValue({
    invitations: [],
  })
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

describe('Settings routes and shared navigation', () => {
  it('redirects /settings to /settings/appearance', () => {
    renderSettings('/settings')

    expect(currentPath()).toBe('/settings/appearance')
    expect(
      screen.getByRole('radiogroup', { name: 'Appearance' }),
    ).toBeVisible()
  })

  it('renders Appearance content on /settings/appearance', () => {
    renderSettings('/settings/appearance')

    expect(currentPath()).toBe('/settings/appearance')
    expect(
      screen.getByRole('heading', { name: 'Appearance' }),
    ).toBeVisible()
    expect(
      screen.getByText('Choose how FG Workspace looks on this device.'),
    ).toBeVisible()
    expect(
      screen.getAllByRole('radio'),
    ).toHaveLength(2)
  })

  it('keeps the Appearance page free of invitation UI', () => {
    renderSettings('/settings/appearance')

    expect(
      screen.queryByRole('heading', { name: 'Invitations' }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Invite person' }),
    ).toBeNull()
    expect(screen.queryByLabelText('Email', { exact: true })).toBeNull()
    expect(
      screen.queryByText(/Manage invitations you have created/),
    ).toBeNull()
  })

  it('renders Invitations content on /settings/invitations', async () => {
    renderSettings('/settings/invitations')

    expect(currentPath()).toBe('/settings/invitations')
    expect(
      screen.getByRole('heading', { name: 'Invitations' }),
    ).toBeVisible()
    expect(
      screen.getByText(/Manage invitations you have created for FG Workspace\./),
    ).toBeVisible()
    expect(
      await screen.findByRole('button', { name: 'Invite person' }),
    ).toBeVisible()
  })

  it('keeps the Invitations page free of Appearance controls', async () => {
    renderSettings('/settings/invitations')

    await screen.findByRole('button', { name: 'Invite person' })

    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(
      screen.queryByRole('radio', { name: /Dark/ }),
    ).toBeNull()
    expect(
      screen.queryByRole('radio', { name: /Light/ }),
    ).toBeNull()
  })

  it('marks the Appearance section active on /settings/appearance', () => {
    renderSettings('/settings/appearance')

    expect(appearanceNav()).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(invitationsNav()).not.toHaveAttribute('aria-current')
  })

  it('marks the Invitations section active on /settings/invitations', async () => {
    renderSettings('/settings/invitations')

    await screen.findByRole('button', { name: 'Invite person' })

    expect(invitationsNav()).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(appearanceNav()).not.toHaveAttribute('aria-current')
  })

  it('switches between sections through the navigation', async () => {
    renderSettings('/settings/appearance')

    expect(
      screen.getByRole('radiogroup', { name: 'Appearance' }),
    ).toBeVisible()

    fireEvent.click(invitationsNav())

    expect(currentPath()).toBe('/settings/invitations')
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(
      await screen.findByRole('button', { name: 'Invite person' }),
    ).toBeVisible()
    expect(invitationsNav()).toHaveAttribute(
      'aria-current',
      'page',
    )

    fireEvent.click(appearanceNav())

    expect(currentPath()).toBe('/settings/appearance')
    expect(
      screen.getByRole('radiogroup', { name: 'Appearance' }),
    ).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Invite person' }),
    ).toBeNull()
  })

  it('still applies and persists appearance choices on the route', () => {
    renderSettings('/settings/appearance')

    fireEvent.click(screen.getByRole('radio', { name: /Light/ }))

    expect(document.documentElement.dataset.theme).toBe('light')
    expect(
      window.localStorage.getItem(APPEARANCE_STORAGE_KEY),
    ).toBe('light')
    expect(
      screen.getByRole('radio', { name: /Light/ }),
    ).toBeChecked()
  })
})
