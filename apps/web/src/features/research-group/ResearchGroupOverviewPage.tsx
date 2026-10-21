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
        <span className="material-symbols-outlined animate-spin text-[22px] text-text-muted">
          refresh
        </span>
      </div>
    )
  }

  if (!group) {
    return (
      <div className="mx-auto max-w-[1100px] px-8 py-10">
        <h1 className="text-3xl font-semibold tracking-tight text-text">
          Research group
        </h1>

        <p className="mt-2 text-sm text-overview-error">
          {error ??
            'Research group not found.'}
        </p>
      </div>
    )
  }

  /*
   * Project-style section tabs — the same markup and token
   * treatment as the Project Detail section tabs
   * (ProjectDetailPage): a 38px bar on a subtle bottom border,
   * 13px medium labels, a 2px underline on the active tab.
   * The tabs are real routes (group-scoped lists / settings),
   * not local content panels: plain links, no ARIA tablist and
   * no tab state.
   */
  const tabs = [
    {
      id: 'overview',
      label: 'Overview',
      to: `/groups/${groupId}`,
    },
    {
      id: 'projects',
      label: 'Projects',
      to: `/projects?group=${groupId}`,
    },
    {
      id: 'meetings',
      label: 'Meetings',
      to: `/meetings?group=${groupId}`,
    },
  ]

  /*
   * The admin Research Group settings destination, reachable
   * from the group's Overview after the Sidebar overflow menu
   * was removed (frozen contract R-4). Admin-only: the settings
   * page enforces the canonical admin rule itself.
   */
  if (group.role === 'admin') {
    tabs.push({
      id: 'settings',
      label: 'Settings',
      to: `/groups/${groupId}/settings`,
    })
  }

  return (
    <div className="mx-auto max-w-[1100px] px-8 py-10">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight text-text">
          {group.name}
        </h1>

        <p className="mt-1.5 text-sm text-text-muted">
          Research group overview
        </p>

        <nav
          aria-label="Research group sections"
          className="mt-8 flex h-[38px] items-stretch gap-7 overflow-x-auto border-b border-border-subtle"
        >
          {tabs.map((tab) => {
            const selected = tab.id === 'overview'

            return (
              <Link
                key={tab.id}
                to={tab.to}
                aria-current={selected ? 'page' : undefined}
                className={[
                  'relative flex shrink-0 items-center text-[13px] font-medium leading-5 outline-none transition focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-focus',
                  selected
                    ? 'text-text'
                    : 'text-text-muted hover:text-text',
                ].join(' ')}
              >
                {tab.label}

                {selected && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 bottom-0 h-0.5 bg-text"
                  />
                )}
              </Link>
            )
          })}
        </nav>
      </header>

      <section className="mt-7 max-w-xl">
        <p className="text-sm text-text-muted">
          This is the overview for this research group. Open its projects and meetings from here.
        </p>
      </section>
    </div>
  )
}
