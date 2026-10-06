import {
  useCallback,
  useEffect,
  useState,
} from 'react'
import {
  Link,
  useParams,
} from 'react-router'

import { ApiError } from '../../api/client'
import { getResearchGroup } from '../../api/research-groups'
import type { ApiResearchGroup } from '../../api/types'
import { useSyncResearchGroupContext } from './useSyncResearchGroupContext'

function getErrorMessage(
  error: unknown,
  fallback: string,
) {
  if (
    error instanceof ApiError &&
    error.detail &&
    typeof error.detail === 'object' &&
    'error' in error.detail
  ) {
    const detail = error.detail as {
      error?: unknown
    }

    if (
      typeof detail.error === 'string'
    ) {
      return detail.error
    }
  }

  return fallback
}

export function ResearchGroupOverviewPage() {
  const { groupId: rawGroupId } =
    useParams<{
      groupId: string
    }>()

  const parsedGroupId =
    Number(rawGroupId)

  const groupId =
    Number.isInteger(parsedGroupId) &&
    parsedGroupId > 0
      ? parsedGroupId
      : null

  useSyncResearchGroupContext(
    groupId,
  )

  const [group, setGroup] =
    useState<ApiResearchGroup | null>(
      null,
    )

  const [loading, setLoading] =
    useState(true)

  const [error, setError] =
    useState<string | null>(null)

  const loadGroup =
    useCallback(async () => {
      if (groupId == null) {
        setGroup(null)
        setError(
          'Research group not found.',
        )
        setLoading(false)
        return
      }

      setLoading(true)
      setError(null)

      try {
        const nextGroup =
          await getResearchGroup(
            groupId,
          )

        setGroup(nextGroup)
      } catch (loadError) {
        setGroup(null)
        setError(
          getErrorMessage(
            loadError,
            'Research group could not be loaded.',
          ),
        )
      } finally {
        setLoading(false)
      }
    }, [groupId])

  useEffect(() => {
    void loadGroup()
  }, [loadGroup])

  if (loading) {
    return (
      <div className="flex min-h-[360px] items-center justify-center">
        <span className="material-symbols-outlined animate-spin text-[22px] text-on-surface-variant">
          refresh
        </span>
      </div>
    )
  }

  if (!group) {
    return (
      <div className="mx-auto max-w-[1100px] px-8 py-10">
        <h1 className="text-3xl font-semibold tracking-tight text-on-surface">
          Research group
        </h1>

        <p className="mt-2 text-sm text-error">
          {error ??
            'Research group not found.'}
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[1100px] px-8 py-10">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight text-on-surface">
          {group.name}
        </h1>

        <p className="mt-1.5 text-sm text-on-surface-variant">
          Research group overview
        </p>
      </header>

      <section className="mt-8 max-w-xl border-t border-outline-variant pt-6">
        <p className="text-sm text-on-surface-variant">
          This is the overview for this research group. Open its projects and meetings from here.
        </p>

        <nav
          aria-label="Research group destinations"
          className="mt-5 flex flex-wrap gap-3"
        >
          <Link
            to={`/projects?group=${groupId}`}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-lowest px-3.5 text-sm font-medium text-on-surface transition hover:bg-surface-container"
          >
            <span
              aria-hidden="true"
              className="material-symbols-outlined text-[18px]"
            >
              folder_open
            </span>

            Projects
          </Link>

          <Link
            to={`/meetings?group=${groupId}`}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-lowest px-3.5 text-sm font-medium text-on-surface transition hover:bg-surface-container"
          >
            <span
              aria-hidden="true"
              className="material-symbols-outlined text-[18px]"
            >
              groups
            </span>

            Meetings
          </Link>

          {/*
           * The admin Research Group settings destination,
           * reachable from the group's Overview after the
           * Sidebar overflow menu was removed (frozen contract
           * R-4). Admin-only: the settings page enforces the
           * canonical admin rule itself.
           */}
          {group.role === 'admin' && (
            <Link
              to={`/groups/${groupId}/settings`}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-lowest px-3.5 text-sm font-medium text-on-surface transition hover:bg-surface-container"
            >
              <span
                aria-hidden="true"
                className="material-symbols-outlined text-[18px]"
              >
                settings
              </span>

              Settings
            </Link>
          )}
        </nav>
      </section>
    </div>
  )
}
