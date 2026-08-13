import type { ReactNode } from 'react'

import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'

type AppShellProps = {
  children: ReactNode
}

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="min-h-screen bg-background text-on-surface">
      <Sidebar />

      <div className="ml-[240px] min-h-screen">
        <TopBar />

        <main className="min-h-[calc(100vh-64px)]">
          {children}
        </main>
      </div>
    </div>
  )
}