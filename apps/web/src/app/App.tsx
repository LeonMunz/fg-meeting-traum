import type { ComponentProps, ReactNode } from 'react'
import { RouterProvider } from 'react-router/dom'
import { SessionProvider } from '../api/SessionProvider'
import { AppearanceProvider } from '../features/appearance/AppearanceProvider'

import { useRoutes } from 'react-router'

import { appRoutes } from './routes'

/*
 * Declarative application entry.
 *
 * The canonical route configuration (app/routes.tsx) is rendered
 * here with `useRoutes` for declarative embeddings — notably the
 * MemoryRouter-based test harnesses, which drive the full
 * authenticated route tree (shell, auth gate, placeholders) exactly
 * as production does: `useRoutes` matches the SAME `appRoutes` array
 * the production data router mounts, so both strategies render one
 * and the same route tree.
 *
 * The browser entry (main.tsx) does NOT use this component: it
 * mounts the SAME route array through the data router
 * (`createBrowserRouter` + `RouterProvider` from `react-router/dom`),
 * which is the strategy that enables React Router's native View
 * Transition integration for opted-in global navigations.
 */
export function AppRoutes() {
  const element = useRoutes(appRoutes)

  return <>{element}</>
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <AppearanceProvider>
      <SessionProvider>
        {children}
      </SessionProvider>
    </AppearanceProvider>
  )
}

type DataRouterAppProps = Pick<
  ComponentProps<typeof RouterProvider>,
  'router'
>

/** Production data-router composition, kept shared with its regression test. */
export function DataRouterApp({ router }: DataRouterAppProps) {
  return (
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  )
}

export function App() {
  return (
    <AppProviders>
      <AppRoutes />
    </AppProviders>
  )
}
