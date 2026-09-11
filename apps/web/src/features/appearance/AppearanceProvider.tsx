import {
  useCallback,
  useMemo,
  useState,
} from 'react'
import type { ReactNode } from 'react'

import {
  applyAppearance,
  isAppearance,
  readAppearancePreference,
  storeAppearancePreference,
  type Appearance,
} from './appearance'
import { AppearanceContext } from './AppearanceContext'

type AppearanceProviderProps = {
  children: ReactNode
}

function getInitialAppearance(): Appearance {
  const bootstrappedAppearance =
    document.documentElement.dataset.theme

  return isAppearance(bootstrappedAppearance)
    ? bootstrappedAppearance
    : readAppearancePreference()
}

export function AppearanceProvider({
  children,
}: AppearanceProviderProps) {
  const [appearance, setAppearanceState] =
    useState<Appearance>(getInitialAppearance)

  const setAppearance = useCallback(
    (nextAppearance: Appearance) => {
      applyAppearance(nextAppearance)
      storeAppearancePreference(nextAppearance)
      setAppearanceState(nextAppearance)
    },
    [],
  )

  const value = useMemo(
    () => ({
      appearance,
      setAppearance,
    }),
    [appearance, setAppearance],
  )

  return (
    <AppearanceContext.Provider value={value}>
      {children}
    </AppearanceContext.Provider>
  )
}
