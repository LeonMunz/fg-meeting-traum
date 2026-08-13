import { Navigate, Route, Routes } from 'react-router'

import { AppShell } from '../components/layout/AppShell'
import { DashboardPage } from '../features/dashboard/DashboardPage'

function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="mx-auto max-w-[1440px] p-10">
      <h1 className="text-3xl font-semibold tracking-tight">
        {title}
      </h1>

      <div className="mt-6 rounded-xl border border-outline-variant bg-surface-container-lowest p-8 shadow-sm">
        <p className="text-on-surface-variant">
          This area will be implemented next.
        </p>
      </div>
    </div>
  )
}

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<DashboardPage />} />

        <Route
          path="/my-work"
          element={<PlaceholderPage title="My Work" />}
        />

        <Route
          path="/projects"
          element={<PlaceholderPage title="Projects" />}
        />

        <Route
          path="/goals"
          element={<PlaceholderPage title="Goals" />}
        />

        <Route
          path="/meetings"
          element={<PlaceholderPage title="Meetings" />}
        />

        <Route
          path="/kvp"
          element={<PlaceholderPage title="KVP" />}
        />

        <Route
          path="/knowledge"
          element={<PlaceholderPage title="Knowledge" />}
        />

        <Route
          path="/calendar"
          element={<PlaceholderPage title="Calendar" />}
        />

        <Route
          path="/people"
          element={<PlaceholderPage title="People" />}
        />

        <Route
          path="/notifications"
          element={<PlaceholderPage title="Notifications" />}
        />

        <Route
          path="/settings"
          element={<PlaceholderPage title="Settings" />}
        />

        <Route
          path="/profile"
          element={<PlaceholderPage title="Profile" />}
        />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  )
}