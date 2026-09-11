export const APPEARANCE_STORAGE_KEY =
  'fg-workspace.appearance'

export type Appearance = 'dark' | 'light'

export function isAppearance(
  value: unknown,
): value is Appearance {
  return value === 'dark' || value === 'light'
}

export function readAppearancePreference(): Appearance {
  try {
    const stored = window.localStorage.getItem(
      APPEARANCE_STORAGE_KEY,
    )

    return isAppearance(stored) ? stored : 'dark'
  } catch {
    return 'dark'
  }
}

export function applyAppearance(
  appearance: Appearance,
) {
  document.documentElement.dataset.theme = appearance

  const themeColor = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  )

  themeColor?.setAttribute(
    'content',
    appearance === 'dark' ? '#18191b' : '#f8f9ff',
  )
}

export function storeAppearancePreference(
  appearance: Appearance,
) {
  try {
    window.localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      appearance,
    )
  } catch {
    // A device-local preference must never prevent use of the workspace.
  }
}
