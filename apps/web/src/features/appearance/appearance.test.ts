// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'

import {
  APPEARANCE_STORAGE_KEY,
  applyAppearance,
  readAppearancePreference,
  storeAppearancePreference,
} from './appearance'

afterEach(() => {
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  document.head.innerHTML = ''
})

describe('appearance preference', () => {
  it('resolves missing and invalid preferences to Dark', () => {
    expect(readAppearancePreference()).toBe('dark')

    window.localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      'system',
    )

    expect(readAppearancePreference()).toBe('dark')
  })

  it.each(['dark', 'light'] as const)(
    'persists and resolves %s',
    (appearance) => {
      storeAppearancePreference(appearance)

      expect(
        window.localStorage.getItem(
          APPEARANCE_STORAGE_KEY,
        ),
      ).toBe(appearance)
      expect(readAppearancePreference()).toBe(appearance)
    },
  )

  it.each([
    ['dark', '#18191b'],
    ['light', '#f8f9ff'],
  ] as const)(
    'applies %s to the root and browser theme color',
    (appearance, themeColor) => {
      const meta = document.createElement('meta')
      meta.name = 'theme-color'
      document.head.append(meta)

      applyAppearance(appearance)

      expect(document.documentElement.dataset.theme).toBe(
        appearance,
      )
      expect(meta.content).toBe(themeColor)
    },
  )
})
