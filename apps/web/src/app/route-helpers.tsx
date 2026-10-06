/**
 * Internal route-building blocks for the canonical application
 * route configuration (app/routes.tsx): the auth gate and the
 * placeholder pages. Kept separate so routes.tsx stays a pure
 * route-config module.
 */
import { Navigate } from 'react-router'

import { useSession } from '../api/useSession'
import { useResearchGroupListScope } from '../features/research-group/useResearchGroupListScope'

export function ResearchGroupPlaceholderPage({
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

export function PlaceholderPage({ title }: { title: string }) {
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

export function RequireAuth({ children }: { children: React.ReactNode }) {
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

