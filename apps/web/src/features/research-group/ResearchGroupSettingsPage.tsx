import {
  useCallback,
  useEffect,
  useState,
} from 'react'
import { useParams } from 'react-router'

import { ApiError } from '../../api/client'
import {
  getResearchGroup,
  listResearchGroupMemberships,
  updateResearchGroup,
  updateResearchGroupMembership,
} from '../../api/research-groups'
import type {
  ApiResearchGroup,
  ApiResearchGroupMembership,
} from '../../api/types'
import { AddResearchGroupMemberDialog } from './AddResearchGroupMemberDialog'
import { useResearchGroup } from './useResearchGroup'
import { useSyncResearchGroupContext } from './useSyncResearchGroupContext'

type SettingsTab =
  | 'general'
  | 'members'

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

function getMemberName(
  membership: ApiResearchGroupMembership,
) {
  const fullName = [
    membership.user.firstName,
    membership.user.lastName,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    fullName ||
    membership.user.username
  )
}

export function ResearchGroupSettingsPage() {
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

  const {
    reloadResearchGroups,
  } = useResearchGroup()

  const [group, setGroup] =
    useState<ApiResearchGroup | null>(
      null,
    )

  const [
    memberships,
    setMemberships,
  ] = useState<
    ApiResearchGroupMembership[]
  >([])

  const [name, setName] =
    useState('')

  const [tab, setTab] =
    useState<SettingsTab>(
      'general',
    )

  const [loading, setLoading] =
    useState(true)

  const [error, setError] =
    useState<string | null>(null)

  const [
    savingGeneral,
    setSavingGeneral,
  ] = useState(false)

  const [
    updatingMembershipId,
    setUpdatingMembershipId,
  ] = useState<number | null>(
    null,
  )

  const [
    addMemberOpen,
    setAddMemberOpen,
  ] = useState(false)

  const loadSettings =
    useCallback(async () => {
      if (groupId == null) {
        setGroup(null)
        setMemberships([])
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
        setName(nextGroup.name)

        if (
          nextGroup.role ===
          'admin'
        ) {
          const nextMemberships =
            await listResearchGroupMemberships(
              groupId,
            )

          setMemberships(
            nextMemberships,
          )
        } else {
          setMemberships([])
        }
      } catch (loadError) {
        setGroup(null)
        setMemberships([])
        setError(
          getErrorMessage(
            loadError,
            'Research group settings could not be loaded.',
          ),
        )
      } finally {
        setLoading(false)
      }
    }, [groupId])

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  const handleSaveGeneral =
    async () => {
      if (
        groupId == null ||
        group == null
      ) {
        return
      }

      const normalizedName =
        name.trim()

      if (
        !normalizedName ||
        normalizedName ===
          group.name
      ) {
        return
      }

      setSavingGeneral(true)
      setError(null)

      try {
        const updated =
          await updateResearchGroup(
            groupId,
            {
              name:
                normalizedName,
            },
          )

        setGroup(updated)
        setName(updated.name)

        await reloadResearchGroups()
      } catch (saveError) {
        setError(
          getErrorMessage(
            saveError,
            'Research group could not be updated.',
          ),
        )
      } finally {
        setSavingGeneral(false)
      }
    }

  const handleRoleChange =
    async (
      membership:
        ApiResearchGroupMembership,
      role: 'admin' | 'member',
    ) => {
      if (
        groupId == null ||
        role === membership.role
      ) {
        return
      }

      setUpdatingMembershipId(
        membership.id,
      )
      setError(null)

      try {
        await updateResearchGroupMembership(
          groupId,
          membership.id,
          { role },
        )

        await reloadResearchGroups()
        await loadSettings()
      } catch (updateError) {
        setError(
          getErrorMessage(
            updateError,
            'Member role could not be changed.',
          ),
        )
      } finally {
        setUpdatingMembershipId(
          null,
        )
      }
    }

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

  if (group.role !== 'admin') {
    return (
      <div className="mx-auto max-w-[1100px] px-8 py-10">
        <h1 className="text-3xl font-semibold tracking-tight text-on-surface">
          {group.name}
        </h1>

        <p className="mt-1.5 text-sm text-on-surface-variant">
          Research group settings
        </p>

        <div className="mt-8 max-w-xl border-t border-outline-variant pt-6">
          <p className="text-sm text-on-surface-variant">
            Research group settings are managed by admins.
          </p>
        </div>
      </div>
    )
  }

  const normalizedName =
    name.trim()

  const canSaveGeneral =
    normalizedName.length > 0 &&
    normalizedName !== group.name &&
    !savingGeneral

  return (
    <div className="mx-auto max-w-[1100px] px-8 py-10">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight text-on-surface">
          {group.name}
        </h1>

        <p className="mt-1.5 text-sm text-on-surface-variant">
          Research group settings
        </p>
      </header>

      <div className="mt-8 flex gap-6 border-b border-outline-variant">
        <button
          type="button"
          onClick={() =>
            setTab('general')
          }
          className={[
            '-mb-px border-b-2 px-1 pb-3 text-sm font-medium transition',
            tab === 'general'
              ? 'border-primary text-on-surface'
              : 'border-transparent text-on-surface-variant hover:text-on-surface',
          ].join(' ')}
        >
          General
        </button>

        <button
          type="button"
          onClick={() =>
            setTab('members')
          }
          className={[
            '-mb-px border-b-2 px-1 pb-3 text-sm font-medium transition',
            tab === 'members'
              ? 'border-primary text-on-surface'
              : 'border-transparent text-on-surface-variant hover:text-on-surface',
          ].join(' ')}
        >
          Members
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="mt-6 max-w-2xl rounded-lg border border-error/20 bg-error/5 px-4 py-3 text-sm text-error"
        >
          {error}
        </div>
      )}

      {tab === 'general' ? (
        <section className="mt-8 max-w-2xl">
          <h2 className="text-base font-semibold text-on-surface">
            General
          </h2>

          <p className="mt-1 text-sm text-on-surface-variant">
            Basic information about this research group.
          </p>

          <div className="mt-6">
            <label
              htmlFor="research-group-name"
              className="block text-sm font-medium text-on-surface"
            >
              Research group name
            </label>

            <input
              id="research-group-name"
              value={name}
              onChange={(event) =>
                setName(
                  event.target.value,
                )
              }
              className="mt-2 h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
            />
          </div>

          <div className="mt-5 flex justify-end">
            <button
              type="button"
              disabled={
                !canSaveGeneral
              }
              onClick={() =>
                void handleSaveGeneral()
              }
              className="inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {savingGeneral
                ? 'Saving…'
                : 'Save'}
            </button>
          </div>
        </section>
      ) : (
        <section className="mt-8 max-w-3xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-on-surface">
                Members
              </h2>

              <p className="mt-1 text-sm text-on-surface-variant">
                People with access to this research group.
              </p>
            </div>

            <button
              type="button"
              onClick={() =>
                setAddMemberOpen(true)
              }
              className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg bg-primary px-3.5 text-sm font-semibold text-white transition hover:bg-primary/90"
            >
              <span className="material-symbols-outlined text-[18px]">
                person_add
              </span>

              Add member
            </button>
          </div>

          <div className="mt-6 overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest">
            <div className="divide-y divide-outline-variant/60">
              {memberships.map(
                (membership) => (
                  <div
                    key={
                      membership.id
                    }
                    className="flex items-center gap-4 px-5 py-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-on-surface">
                        {getMemberName(
                          membership,
                        )}
                      </div>

                      <div className="mt-0.5 truncate text-xs text-on-surface-variant">
                        @
                        {
                          membership
                            .user
                            .username
                        }
                      </div>
                    </div>

                    <select
                      value={
                        membership.role
                      }
                      disabled={
                        updatingMembershipId ===
                        membership.id
                      }
                      onChange={(
                        event,
                      ) =>
                        void handleRoleChange(
                          membership,
                          event.target
                            .value as
                            | 'admin'
                            | 'member',
                        )
                      }
                      aria-label={`Role for ${getMemberName(membership)}`}
                      className="h-9 min-w-28 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:cursor-wait disabled:opacity-50"
                    >
                      <option value="member">
                        Member
                      </option>

                      <option value="admin">
                        Admin
                      </option>
                    </select>
                  </div>
                ),
              )}
            </div>
          </div>
        </section>
      )}
      {groupId != null && (
        <AddResearchGroupMemberDialog
          open={addMemberOpen}
          researchGroupId={groupId}
          onClose={() =>
            setAddMemberOpen(false)
          }
          onAdded={async () => {
            await reloadResearchGroups()
            await loadSettings()
          }}
        />
      )}
    </div>
  )
}
