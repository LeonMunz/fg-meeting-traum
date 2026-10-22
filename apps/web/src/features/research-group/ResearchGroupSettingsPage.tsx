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
import { RemoveResearchGroupMemberDialog } from './RemoveResearchGroupMemberDialog'
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

/**
 * Research Group settings presentation modes:
 *
 * - default: the STANDALONE rendering — owns its outer container
 *   and the Research-Group header (group name + subtitle);
 * - `embedded`: rendered inside the Research Group workspace
 *   layout (`/groups/:groupId/settings`) — the layout owns the
 *   outer container, the group header, and the persistent
 *   workspace tab bar (this page is its active tab), so the
 *   redundant Research-Group header and outer container are
 *   omitted here. The internal General / Members navigation,
 *   the member management, the group rename, and the admin
 *   authorization rule are UNCHANGED in both modes.
 */
type ResearchGroupSettingsPageProps = {
  embedded?: boolean
}

export function ResearchGroupSettingsPage({
  embedded = false,
}: ResearchGroupSettingsPageProps) {
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

  const [
    memberToRemove,
    setMemberToRemove,
  ] = useState<
    ApiResearchGroupMembership | null
  >(null)

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
        <span className="material-symbols-outlined animate-spin text-[22px] text-text-muted">
          refresh
        </span>
      </div>
    )
  }

  if (!group) {
    /*
     * In workspace mode the shared layout already renders the
     * group header — this state must not add a second
     * Research-Group heading of its own.
     */
    return embedded ? (
      <p className="text-sm text-overview-error">
        {error ??
          'Research group not found.'}
      </p>
    ) : (
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

  if (group.role !== 'admin') {
    const adminNote = (
      <div className="max-w-xl border-t border-border-subtle pt-6">
        <p className="text-sm text-text-muted">
          Research group settings are managed by admins.
        </p>
      </div>
    )

    return embedded ? (
      adminNote
    ) : (
      <div className="mx-auto max-w-[1100px] px-8 py-10">
        <h1 className="text-3xl font-semibold tracking-tight text-text">
          {group.name}
        </h1>

        <p className="mt-1.5 text-sm text-text-muted">
          Research group settings
        </p>

        <div className="mt-8">
          {adminNote}
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

  /*
   * The internal General / Members navigation and the
   * administrative content — unchanged in both presentation
   * modes. In workspace mode the shared layout owns the group
   * header above, so the redundant Research-Group header is
   * omitted and the internal tab strip sits directly below the
   * workspace tabs (no doubled top margin).
   */
  const settingsContent = (
    <>
      <div
        className={[
          'flex gap-6 border-b border-border-subtle',
          embedded ? '' : 'mt-8',
        ].join(' ')}
      >
        <button
          type="button"
          onClick={() =>
            setTab('general')
          }
          className={[
            '-mb-px border-b-2 px-1 pb-3 text-sm font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-focus',
            tab === 'general'
              ? 'border-tab-active text-text'
              : 'border-transparent text-text-muted hover:text-text',
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
            '-mb-px border-b-2 px-1 pb-3 text-sm font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-focus',
            tab === 'members'
              ? 'border-tab-active text-text'
              : 'border-transparent text-text-muted hover:text-text',
          ].join(' ')}
        >
          Members
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="mt-6 max-w-2xl rounded-lg border border-danger/20 bg-danger/5 px-4 py-3 text-sm text-overview-error"
        >
          {error}
        </div>
      )}

      {tab === 'general' ? (
        <section className="mt-8 max-w-2xl">
          <h2 className="text-base font-semibold text-text">
            General
          </h2>

          <p className="mt-1 text-sm text-text-muted">
            Basic information about this research group.
          </p>

          <div className="mt-6">
            <label
              htmlFor="research-group-name"
              className="block text-sm font-medium text-text"
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
              className="mt-2 h-10 w-full rounded-lg border border-border-field bg-surface px-3 text-sm text-text outline-none transition focus:border-focus focus:ring-2 focus:ring-focus/15"
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
              className="inline-flex h-9 items-center rounded-lg bg-action px-4 text-sm font-semibold text-text-inverse transition hover:bg-action-hover disabled:cursor-not-allowed disabled:opacity-40"
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
              <h2 className="text-base font-semibold text-text">
                Members
              </h2>

              <p className="mt-1 text-sm text-text-muted">
                People with access to this research group.
              </p>
            </div>

            <button
              type="button"
              onClick={() =>
                setAddMemberOpen(true)
              }
              className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg bg-action px-3.5 text-sm font-semibold text-text-inverse transition hover:bg-action-hover"
            >
              <span
                aria-hidden="true"
                className="material-symbols-outlined text-[18px]"
              >
                person_add
              </span>

              Add member
            </button>
          </div>

          <div className="mt-6 overflow-hidden rounded-xl border border-border-structural bg-surface">
            <div className="divide-y divide-border-structural/60">
              {memberships.map(
                (membership) => (
                  <div
                    key={
                      membership.id
                    }
                    className="flex items-center gap-4 px-5 py-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-text">
                        {getMemberName(
                          membership,
                        )}
                      </div>

                      <div className="mt-0.5 truncate text-xs text-text-muted">
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
                      className="h-9 min-w-28 rounded-lg border border-border-field bg-surface px-3 text-sm text-text outline-none transition focus:border-focus focus:ring-2 focus:ring-focus/15 disabled:cursor-wait disabled:opacity-50"
                    >
                      <option value="member">
                        Member
                      </option>

                      <option value="admin">
                        Admin
                      </option>
                    </select>

                    <button
                      type="button"
                      disabled={
                        updatingMembershipId ===
                        membership.id
                      }
                      onClick={() => {
                        setError(null)
                        setMemberToRemove(
                          membership,
                        )
                      }}
                      aria-label={`Remove ${getMemberName(membership)}`}
                      className="inline-flex h-9 items-center justify-center rounded-lg px-3 text-sm font-medium text-overview-error transition hover:bg-danger/5 disabled:opacity-45"
                    >
                      Remove
                    </button>
                  </div>
                ),
              )}
            </div>
          </div>
        </section>
      )}
    </>
  )

  const memberDialogs = (
    <>
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

      {groupId != null && (
        <RemoveResearchGroupMemberDialog
          open={
            memberToRemove != null
          }
          researchGroupId={groupId}
          membership={memberToRemove}
          onClose={() =>
            setMemberToRemove(null)
          }
          onRemoved={async () => {
            await reloadResearchGroups()
            await loadSettings()
          }}
        />
      )}
    </>
  )

  return embedded ? (
    <div>
      {settingsContent}

      {memberDialogs}
    </div>
  ) : (
    <div className="mx-auto max-w-[1100px] px-8 py-10">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight text-text">
          {group.name}
        </h1>

        <p className="mt-1.5 text-sm text-text-muted">
          Research group settings
        </p>
      </header>

      {settingsContent}

      {memberDialogs}
    </div>
  )
}
