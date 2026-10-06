import { Navigate, Outlet } from 'react-router'
import type { RouteObject } from 'react-router'

import { AppShell } from '../components/layout/AppShell'
import { SettingsLayout } from '../components/layout/SettingsLayout'
import { InvitationsSettingsPage } from '../features/account-invitations/InvitationsSettingsPage'
import { AppearanceSettingsPage } from '../features/appearance/AppearanceSettingsPage'
import { LoginPage } from '../features/auth/LoginPage'
import { RegistrationPage } from '../features/auth/RegistrationPage'
import { HomePage } from '../features/home/HomePage'
import { MyWorkPage } from '../features/my-work/MyWorkPage'
import { NotesPage } from '../features/personal-notes/NotesPage'
import { MeetingListPage } from '../features/meetings/MeetingListPage'
import { MeetingDetailPage } from '../features/meetings/MeetingDetailPage'
import { MeetingSeriesListPage } from '../features/meetings/MeetingSeriesListPage'
import { MeetingSeriesDetailPage } from '../features/meetings/MeetingSeriesDetailPage'
import { ProjectDetailPage } from '../features/projects/ProjectDetailPage'
import { ProjectListPage } from '../features/projects/ProjectListPage'
import { ResearchGroupProvider } from '../features/research-group/ResearchGroupProvider'
import { ResearchGroupOverviewPage } from '../features/research-group/ResearchGroupOverviewPage'
import { ResearchGroupSettingsPage } from '../features/research-group/ResearchGroupSettingsPage'

import {
  PlaceholderPage,
  RequireAuth,
  ResearchGroupPlaceholderPage,
} from './route-helpers'

/*
 * Canonical application route configuration.
 *
 * ONE route array serves every rendering strategy:
 * - production entry (main.tsx) mounts it through the data router
 *   (`createBrowserRouter` + `RouterProvider` from `react-router/dom`),
 *   which is the only strategy that enables React Router's native
 *   View Transition integration for opted-in navigations;
 * - the declarative `App` (app/App.tsx) renders the SAME array with
 *   `useRoutes`, keeping the MemoryRouter-based test harnesses intact.
 *
 * The authenticated layout is the AppShell: Sidebar + TopBar stay
 * mounted across navigations, and the routed page content renders
 * inside AppShell's <main> (the fg-route-content transition scope).
 */
export const appRoutes: RouteObject[] = [
  {
    path: '/login',
    element: <LoginPage />,
  },
  {
    path: '/register',
    element: <RegistrationPage />,
  },
  {
    path: '/*',
    element: (
      <RequireAuth>
        <ResearchGroupProvider>
          <AppShell>
            <Outlet />
          </AppShell>
        </ResearchGroupProvider>
      </RequireAuth>
    ),
    children: [
      {
        index: true,
        element: <HomePage />,
      },
      {
        path: 'my-work',
        element: <MyWorkPage />,
      },
      {
        path: 'notes',
        element: <NotesPage />,
      },
      {
        path: 'groups/:groupId',
        element: <ResearchGroupOverviewPage />,
      },
      {
        path: 'groups/:groupId/settings',
        element: <ResearchGroupSettingsPage />,
      },
      {
        path: 'projects',
        element: <ProjectListPage />,
      },
      {
        path: 'projects/:projectId',
        children: [
          {
            index: true,
            element: <Navigate to="work-items" replace />,
          },
          {
            path: 'work-items',
            element: <ProjectDetailPage />,
          },
          {
            path: 'overview',
            element: <ProjectDetailPage />,
          },
          {
            path: 'members',
            element: <ProjectDetailPage />,
          },
          {
            path: 'settings',
            element: <ProjectDetailPage />,
          },
        ],
      },
      {
        path: 'goals',
        element: (
          <ResearchGroupPlaceholderPage title="Goals" />
        ),
      },
      {
        path: 'meetings',
        element: <MeetingListPage />,
      },
      {
        path: 'meetings/series',
        element: <MeetingSeriesListPage />,
      },
      {
        path: 'meetings/series/:seriesId',
        element: <MeetingSeriesDetailPage />,
      },
      {
        path: 'meetings/:meetingId',
        element: <MeetingDetailPage />,
      },
      {
        path: 'kvp',
        element: (
          <ResearchGroupPlaceholderPage title="KVP" />
        ),
      },
      {
        path: 'knowledge',
        element: (
          <ResearchGroupPlaceholderPage title="Knowledge" />
        ),
      },
      {
        path: 'data',
        element: (
          <ResearchGroupPlaceholderPage
            title="Data"
            description="Research data sources will be connected here later, for example OneDrive or Sciebo."
          />
        ),
      },
      {
        path: 'calendar',
        element: (
          <ResearchGroupPlaceholderPage title="Calendar" />
        ),
      },
      {
        path: 'people',
        element: (
          <ResearchGroupPlaceholderPage title="People" />
        ),
      },
      {
        path: 'notifications',
        element: <PlaceholderPage title="Notifications" />,
      },
      {
        path: 'settings',
        element: <SettingsLayout />,
        children: [
          {
            index: true,
            element: <Navigate to="appearance" replace />,
          },
          {
            path: 'appearance',
            element: <AppearanceSettingsPage />,
          },
          {
            path: 'invitations',
            element: <InvitationsSettingsPage />,
          },
        ],
      },
      {
        path: 'profile',
        element: <PlaceholderPage title="Profile" />,
      },
      {
        path: '*',
        element: <Navigate to="/" replace />,
      },
    ],
  },
]
