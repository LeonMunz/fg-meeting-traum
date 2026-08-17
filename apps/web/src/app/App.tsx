import { Navigate, Route, Routes } from 'react-router'

import { SessionProvider } from '../api/SessionProvider'
import { useSession } from '../api/useSession'
import { AppShell } from '../components/layout/AppShell'
import { LoginPage } from '../features/auth/LoginPage'
import { DashboardPage } from '../features/dashboard/DashboardPage'
import { MyWorkPage } from '../features/my-work/MyWorkPage'
import { ProjectDetailPage } from '../features/projects/ProjectDetailPage'
import { ProjectListPage } from '../features/projects/ProjectListPage'
import { ResearchGroupProvider } from '../features/research-group/ResearchGroupProvider'

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

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useSession()

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="material-symbols-outlined text-[24px] animate-spin text-on-surface-variant">
          refresh
        </span>
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" replace />
  }

  return <>{children}</>
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route
        path="/*"
        element={
          <RequireAuth>
            <ResearchGroupProvider>
              <AppShell>
                <Routes>
                <Route path="/" element={<DashboardPage />} />

                <Route
                  path="/my-work"
                  element={<MyWorkPage />}
                />

                <Route
                  path="/projects"
                  element={<ProjectListPage />}
                />

                <Route
                  path="/projects/:projectId"
                  element={<ProjectDetailPage />}
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
            </ResearchGroupProvider>
          </RequireAuth>
        }
      />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export function App() {
  return (
    <SessionProvider>
      <AppRoutes />
    </SessionProvider>
  )
}
