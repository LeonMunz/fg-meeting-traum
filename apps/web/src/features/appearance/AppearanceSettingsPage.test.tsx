// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  APPEARANCE_STORAGE_KEY,
} from './appearance'
import { AppearanceProvider } from './AppearanceProvider'
import { AppearanceSettingsPage } from './AppearanceSettingsPage'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

function renderSettings(
  bootstrappedAppearance: 'dark' | 'light' = 'dark',
) {
  document.documentElement.dataset.theme =
    bootstrappedAppearance

  return render(
    <AppearanceProvider>
      <AppearanceSettingsPage />
    </AppearanceProvider>,
  )
}

describe('Appearance settings', () => {
  it('offers exactly Dark and Light with the active choice selected', () => {
    renderSettings()

    const options = screen.getAllByRole('radio')

    expect(options).toHaveLength(2)
    expect(options.map((option) => option.textContent)).toEqual([
      'dark_modeDark',
      'light_modeLight',
    ])
    expect(
      screen.getByRole('radio', { name: /Dark/ }),
    ).toBeChecked()
    expect(
      screen.getByRole('radio', { name: /Light/ }),
    ).not.toBeChecked()
  })

  it('applies and persists a new choice immediately', () => {
    renderSettings()

    fireEvent.click(
      screen.getByRole('radio', { name: /Light/ }),
    )

    expect(document.documentElement.dataset.theme).toBe(
      'light',
    )
    expect(
      window.localStorage.getItem(
        APPEARANCE_STORAGE_KEY,
      ),
    ).toBe('light')
    expect(
      screen.getByRole('radio', { name: /Light/ }),
    ).toBeChecked()

    fireEvent.click(
      screen.getByRole('radio', { name: /Dark/ }),
    )

    expect(document.documentElement.dataset.theme).toBe(
      'dark',
    )
    expect(
      window.localStorage.getItem(
        APPEARANCE_STORAGE_KEY,
      ),
    ).toBe('dark')
  })
})
