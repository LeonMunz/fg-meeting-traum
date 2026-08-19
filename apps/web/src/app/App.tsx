import { Navigate, Route, Routes } from 'react-router'

import { SessionProvider } from '../api/SessionProvider'
import { useSession } from '../api/useSession'
import { AppShell } from '../components/layout/AppShell'
import { LoginPage } from '../features/auth/LoginPage'
import { DashboardPage } from '../features/dashboard/DashboardPage'
import { MyWorkPage } from '../features/my-work/MyWorkPage'
import { MeetingListPage } from '../features/meetings/MeetingListPage'
import { MeetingDetailPage } from '../features/meetings/MeetingDetailPage'
import { ProjectDetailPage } from '../features/projects/ProjectDetailPage'
import { ProjectListPage } from '../features/projects/ProjectListPage'
import { ResearchGroupProvider } from '../features/research-group/ResearchGroupProvider'
import { ResearchGroupSettingsPage } from '../features/research-group/ResearchGroupSettingsPage'
import { useResearchGroupListScope } from '../features/research-group/useResearchGroupListScope'

function ResearchGroupPlaceholderPage({
  title,
  description,
}: {
  title: string
  description?: string
}) {
  const {
    activeResearchGroup,
    loading,
    error,
  } = useResearchGroupListScope()

  if (loading) {
    return (
      <div className="mx-auto max-w-[1440px] p-10">
        <p className="text-sm text-on-surface-variant">
          Loading…
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[1440px] p-10">
      <h1 className="text-3xl font-semibold tracking-tight">
        {title}
      </h1>

      <p className="mt-1.5 text-sm text-on-surface-variant">
        {activeResearchGroup
          ? `${title} in ${activeResearchGroup.name}.`
          : error ?? 'No research group available.'}
      </p>

      <div className="mt-6 rounded-xl border border-outline-variant bg-surface-container-lowest p-8 shadow-sm">
        <p className="text-on-surface-variant">
          {description ??
            'This area will be implemented next.'}
        </p>
      </div>
    </div>
  )
}

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
                  path="/groups/:groupId/settings"
                  element={<ResearchGroupSettingsPage />}
                />

                <Route
                  path="/projects"
                  element={<ProjectListPage />}
                />

                <Route path="/projects/:projectId">
                  <Route
                    index
                    element={
                      <Navigate
                        to="work-items"
                        replace
                      />
                    }
                  />

                  <Route
                    path="work-items"
                    element={<ProjectDetailPage />}
                  />

                  <Route
                    path="overview"
                    element={<ProjectDetailPage />}
                  />

                  <Route
                    path="members"
                    element={
                      <Navigate
                        to="../settings"
                        replace
                      />
                    }
                  />

                  <Route
                    path="settings"
                    element={<ProjectDetailPage />}
                  />
                </Route>

                <Route
                  path="/goals"
                  element={<ResearchGroupPlaceholderPage title="Goals" />}
                />

                <Route
                  path="/meetings"
                  element={<MeetingListPage />}
                />

                <Route
                  path="/meetings/:meetingId"
                  element={<MeetingDetailPage />}
                />


                <Route
                  path="/kvp"
                  element={<ResearchGroupPlaceholderPage title="KVP" />}
                />

                <Route
                  path="/knowledge"
                  element={<ResearchGroupPlaceholderPage title="Knowledge" />}
                />

                <Route
                  path="/data"
                  element={
                    <ResearchGroupPlaceholderPage
                      title="Data"
                      description="Research data sources will be connected here later, for example OneDrive or Sciebo."
                    />
                  }
                />

                <Route
                  path="/calendar"
                  element={<ResearchGroupPlaceholderPage title="Calendar" />}
                />

                <Route
                  path="/people"
                  element={<ResearchGroupPlaceholderPage title="People" />}
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
