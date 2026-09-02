import {
  useEffect,
  useMemo,
  useState,
} from 'react'
import type { FormEvent } from 'react'

import { ApiError } from '../../api/client'
import { createWorkItemFromMeetingItem } from '../../api/meetings'
import {
  getProjectWorkItemConfiguration,
  listProjectMemberships,
  listProjects,
} from '../../api/projects'
import type {
  ApiMeetingItem,
  ApiProject,
  ApiProjectMembership,
  ApiWorkItem,
  ApiWorkItemTypeDefinition,
} from '../../api/types'

type CreateMeetingWorkItemDialogProps = {
  open: boolean
  researchGroupId: number
  meetingItem: ApiMeetingItem | null
  onClose: () => void
  onCreated: (workItem: ApiWorkItem) => void
}

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

    if (typeof detail.error === 'string') {
      return detail.error
    }
  }

  return fallback
}

function getPersonName(
  membership: ApiProjectMembership,
) {
  const fullName = [
    membership.user.firstName,
    membership.user.lastName,
  ]
    .filter(Boolean)
    .join(' ')
    .trim()

  return fullName || membership.user.username
}

export function CreateMeetingWorkItemDialog({
  open,
  researchGroupId,
  meetingItem,
  onClose,
  onCreated,
}: CreateMeetingWorkItemDialogProps) {
  const [projects, setProjects] =
    useState<ApiProject[]>([])

  const [memberships, setMemberships] =
    useState<ApiProjectMembership[]>([])

  const [projectId, setProjectId] =
    useState('')

  const [typeDefinitions, setTypeDefinitions] =
    useState<ApiWorkItemTypeDefinition[]>([])

  const [typeDefinitionId, setTypeDefinitionId] =
    useState<number | null>(null)

  const [title, setTitle] =
    useState('')

  const [description, setDescription] =
    useState('')

  const [dueDate, setDueDate] =
    useState('')

  const [assigneeIds, setAssigneeIds] =
    useState<number[]>([])

  const [loadingProjects, setLoadingProjects] =
    useState(false)

  const [loadingMembers, setLoadingMembers] =
    useState(false)

  const [submitting, setSubmitting] =
    useState(false)

  const [error, setError] =
    useState<string | null>(null)

  useEffect(() => {
    if (!open || !meetingItem) {
      return
    }

    setTitle(meetingItem.title)
    setDescription(meetingItem.notes)
    setTypeDefinitionId(null)
    setTypeDefinitions([])
    setDueDate('')
    setAssigneeIds([])
    setMemberships([])
    setProjectId('')
    setError(null)

    let cancelled = false

    const load = async () => {
      setLoadingProjects(true)

      try {
        const nextProjects =
          await listProjects(researchGroupId)

        if (cancelled) {
          return
        }

        const writableProjects =
          nextProjects.filter(
            (project) =>
              project.currentUserRole !==
              'viewer',
          )

        setProjects(writableProjects)

        if (writableProjects.length > 0) {
          setProjectId(
            String(writableProjects[0].id),
          )
        }
      } catch (loadError) {
        if (!cancelled) {
          setProjects([])
          setError(
            getErrorMessage(
              loadError,
              'Projects could not be loaded.',
            ),
          )
        }
      } finally {
        if (!cancelled) {
          setLoadingProjects(false)
        }
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [
    meetingItem,
    open,
    researchGroupId,
  ])

  useEffect(() => {
    if (!open || !projectId) {
      setMemberships([])
      setAssigneeIds([])
      return
    }

    const numericProjectId =
      Number(projectId)

    if (!Number.isInteger(numericProjectId)) {
      return
    }

    let cancelled = false

    const load = async () => {
      setLoadingMembers(true)
      setError(null)

      try {
        const nextMemberships =
          await listProjectMemberships(
            numericProjectId,
          )

        if (cancelled) {
          return
        }

        setMemberships(nextMemberships)
        setAssigneeIds([])
      } catch (loadError) {
        if (!cancelled) {
          setMemberships([])
          setAssigneeIds([])
          setError(
            getErrorMessage(
              loadError,
              'Project members could not be loaded.',
            ),
          )
        }
      } finally {
        if (!cancelled) {
          setLoadingMembers(false)
        }
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [open, projectId])

  useEffect(() => {
    if (!open || !projectId) {
      setTypeDefinitions([])
      setTypeDefinitionId(null)
      return
    }

    const numericProjectId =
      Number(projectId)

    if (!Number.isInteger(numericProjectId)) {
      return
    }

    let cancelled = false

    const load = async () => {
      try {
        const config =
          await getProjectWorkItemConfiguration(
            numericProjectId,
          )

        if (cancelled) {
          return
        }

        const activeTypes = config.types.filter(
          (typeDefinition) =>
            typeDefinition.active,
        )

        setTypeDefinitions(activeTypes)

        // The Type defaults to the first active type definition.
        setTypeDefinitionId(
          activeTypes.length > 0
            ? activeTypes[0].id
            : null,
        )
      } catch (loadError) {
        if (!cancelled) {
          setTypeDefinitions([])
          setTypeDefinitionId(null)
          setError(
            getErrorMessage(
              loadError,
              'Work item options could not be loaded.',
            ),
          )
        }
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [open, projectId])

  const eligibleAssignees = useMemo(
    () =>
      memberships.filter(
        (membership) =>
          membership.role === 'owner' ||
          membership.role === 'member',
      ),
    [memberships],
  )

  if (!open || !meetingItem) {
    return null
  }

  const toggleAssignee = (
    userId: number,
  ) => {
    setAssigneeIds((current) =>
      current.includes(userId)
        ? current.filter(
            (candidate) =>
              candidate !== userId,
          )
        : [...current, userId],
    )
  }

  const handleSubmit = async (
    event: FormEvent,
  ) => {
    event.preventDefault()

    const numericProjectId =
      Number(projectId)

    if (
      !Number.isInteger(numericProjectId) ||
      typeDefinitionId == null ||
      !title.trim() ||
      submitting
    ) {
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      const workItem =
        await createWorkItemFromMeetingItem(
          meetingItem.id,
          {
            projectId: numericProjectId,
            typeDefinitionId,
            title: title.trim(),
            description: description.trim(),
            assigneeIds,
            dueDate:
              dueDate || null,
          },
        )

      // A Project page opened in another tab (or still mounted in
      // this SPA) must pick up the new canonical WorkItem without
      // requiring a hard reload.
      window.dispatchEvent(
        new CustomEvent('fg-workspace:work-item-created', {
          detail: workItem,
        }),
      )

      onCreated(workItem)
      onClose()
    } catch (submitError) {
      setError(
        getErrorMessage(
          submitError,
          'Select a valid project and type before creating a work item.',
        ),
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="meeting-work-item-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4"
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-xl overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest shadow-xl"
      >
        <div className="border-b border-outline-variant px-6 py-5">
          <h2
            id="meeting-work-item-title"
            className="text-lg font-semibold text-on-surface"
          >
            Create work item
          </h2>

          <p className="mt-1 text-sm text-on-surface-variant">
            Turn this agenda item into project work.
          </p>
        </div>

        <div className="space-y-5 px-6 py-5">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-on-surface">
              Project
            </span>

            <select
              value={projectId}
              disabled={
                loadingProjects ||
                projects.length === 0
              }
              onChange={(event) =>
                setProjectId(
                  event.target.value,
                )
              }
              className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus:border-primary"
            >
              {projects.length === 0 ? (
                <option value="">
                  {loadingProjects
                    ? 'Loading projects…'
                    : 'No writable projects available'}
                </option>
              ) : (
                projects.map((project) => (
                  <option
                    key={project.id}
                    value={project.id}
                  >
                    {project.name}
                  </option>
                ))
              )}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-on-surface">
              Type
            </span>

            <select
              value={typeDefinitionId == null ? '' : typeDefinitionId}
              disabled={typeDefinitions.length === 0}
              onChange={(event) => {
                const next = Number(event.target.value)

                if (Number.isInteger(next)) {
                  setTypeDefinitionId(next)
                }
              }}
              className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus:border-primary"
            >
              {typeDefinitions.length === 0 ? (
                <option value="">
                  {loadingProjects
                    ? 'Loading…'
                    : 'No work item types available'}
                </option>
              ) : (
                typeDefinitions.map((typeDefinition) => (
                  <option
                    key={typeDefinition.id}
                    value={typeDefinition.id}
                  >
                    {typeDefinition.name}
                  </option>
                ))
              )}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-on-surface">
              Title
            </span>

            <input
              type="text"
              value={title}
              onChange={(event) =>
                setTitle(event.target.value)
              }
              className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-on-surface">
              Description
            </span>

            <textarea
              value={description}
              onChange={(event) =>
                setDescription(
                  event.target.value,
                )
              }
              rows={3}
              className="w-full resize-y rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2.5 text-sm text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
            />
          </label>

          <fieldset>
            <legend className="text-sm font-medium text-on-surface">
              Assignees
            </legend>

            <div
              role="group"
              aria-label="Assignees"
              className="mt-2 rounded-lg border border-outline-variant"
            >
              {loadingMembers ? (
                <div className="px-4 py-3 text-sm text-on-surface-variant">
                  Loading project members…
                </div>
              ) : eligibleAssignees.length === 0 ? (
                <div className="px-4 py-3 text-sm text-on-surface-variant">
                  No eligible assignees.
                </div>
              ) : (
                eligibleAssignees.map(
                  (membership) => (
                    <label
                      key={membership.id}
                      className="flex items-center gap-3 border-b border-outline-variant px-4 py-3 last:border-b-0"
                    >
                      <input
                        type="checkbox"
                        checked={assigneeIds.includes(
                          membership.user.id,
                        )}
                        onChange={() =>
                          toggleAssignee(
                            membership.user.id,
                          )
                        }
                      />

                      <span className="text-sm text-on-surface">
                        {getPersonName(
                          membership,
                        )}{' '}
                        <span className="text-on-surface-variant">
                          @
                          {
                            membership.user
                              .username
                          }
                        </span>
                      </span>
                    </label>
                  ),
                )
              )}
            </div>
          </fieldset>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-on-surface">
              Due date
            </span>

            <input
              type="date"
              value={dueDate}
              onChange={(event) =>
                setDueDate(
                  event.target.value,
                )
              }
              className="h-10 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus:border-primary"
            />
          </label>
        </div>

        {error && (
          <div
            role="alert"
            className="border-t border-error/20 bg-error-container/35 px-6 py-3 text-sm text-error"
          >
            {error}
          </div>
        )}

        <div className="flex justify-end gap-3 border-t border-outline-variant bg-surface-container-low/45 px-6 py-4">
          <button
            type="button"
            disabled={submitting}
            onClick={onClose}
            className="h-9 rounded-lg px-4 text-sm font-medium text-on-surface-variant hover:bg-surface-container-high disabled:opacity-45"
          >
            Cancel
          </button>

          <button
            type="submit"
            disabled={
              submitting ||
              loadingProjects ||
              !projectId ||
              !title.trim()
            }
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45"
          >
            <span className="material-symbols-outlined text-[18px]">
              task_alt
            </span>

            {submitting
              ? 'Creating…'
              : 'Create work item'}
          </button>
        </div>
      </form>
    </div>
  )
}
