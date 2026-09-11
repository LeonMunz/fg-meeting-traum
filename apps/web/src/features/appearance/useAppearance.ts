import { use } from 'react'

import { AppearanceContext } from './AppearanceContext'

export function useAppearance() {
  const context = use(AppearanceContext)

  if (!context) {
    throw new Error(
      'useAppearance must be used within AppearanceProvider',
    )
  }

  return context
}
