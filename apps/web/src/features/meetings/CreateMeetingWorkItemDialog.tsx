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
  ApiLinkedWorkItem,
  ApiMeetingItem,
  ApiMeetingNote,
  ApiProject,
  ApiProjectMembership,
  ApiProjectWorkItemConfiguration,
  ApiWorkItem,
  ApiWorkItemTypeDefinition,
} from '../../api/types'

/** Deterministic concise title suggestion from a Meeting Note:
 * the first meaningful line, capped. No LLM/API dependency. */
function suggestTitleFromNote(
  content: string,
) {
  const line =
    content
      .split('\n')
      .map((candidate) =>
        candidate.trim(),
      )
      .find(Boolean) ?? ''

  return line.length > 80
    ? `${line.slice(0, 80)}…`
    : line
}

type CreateMeetingWorkItemDialogProps = {
  open: boolean
  researchGroupId: number
  meetingItem: ApiMeetingItem | null
  /** Project named by a Project Meeting, preselected when it is
   * writable. For Research Group Meetings this stays null and the
   * Project intentionally starts unselected. */
  defaultProjectId?: number | null
  /** The exact persisted MeetingNote this WorkItem becomes primary
   * for. When set, title/description prefill from the Note content
   * and the payload carries `meetingNoteId`. */
  sourceNote?: ApiMeetingNote | null
  onClose: () => void
  onCreated: (
    workItem: ApiWorkItem,
    linkedWorkItem: ApiLinkedWorkItem | null,
  ) => void
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
  defaultProjectId = null,
  sourceNote = null,
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

  const [
    statusDefinitions,
    setStatusDefinitions,
  ] = useState<
    ApiProjectWorkItemConfiguration['statuses']
  >([])

  const [
    statusDefinitionId,
    setStatusDefinitionId,
  ] = useState<number | null>(null)

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

  const [loadingConfig, setLoadingConfig] =
    useState(false)

  const [submitting, setSubmitting] =
    useState(false)

  const [error, setError] =
    useState<string | null>(null)

  useEffect(() => {
    if (!open || !meetingItem) {
      return
    }

    // Prefill from the exact source Note when this flow is anchored
    // to one; otherwise fall back to the agenda item's own fields.
    const sourceContent =
      sourceNote?.content ?? ''

    setTitle(
      sourceNote
        ? suggestTitleFromNote(sourceContent)
        : meetingItem.title,
    )
    setDescription(
      sourceNote
        ? sourceContent
        : meetingItem.contextNotes,
    )
    setTypeDefinitionId(null)
    setTypeDefinitions([])
    setStatusDefinitions([])
    setStatusDefinitionId(null)
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

        // Only preselect the Project when the Meeting itself names
        // one (a Project Meeting) and it is writable. Research Group
        // Meetings intentionally start with NO Project selected —
        // the user must explicitly choose a writable Project.
        const preferred =
          defaultProjectId != null
            ? writableProjects.find(
                (project) =>
                  project.id === defaultProjectId,
              )
            : undefined

        if (preferred) {
          setProjectId(String(preferred.id))
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
    defaultProjectId,
    meetingItem,
    open,
    researchGroupId,
    sourceNote,
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
      setStatusDefinitions([])
      setTypeDefinitionId(null)
      setStatusDefinitionId(null)
      setLoadingConfig(false)
      return
    }

    const numericProjectId =
      Number(projectId)

    if (!Number.isInteger(numericProjectId)) {
      return
    }

    // A fresh or switched Project: drop the previous Project's
    // definitions immediately so a stale Type/Status id can never
    // be submitted, and keep Create disabled until this Project's
    // configuration has loaded.
    setTypeDefinitions([])
    setStatusDefinitions([])
    setTypeDefinitionId(null)
    setStatusDefinitionId(null)
    setLoadingConfig(true)

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

        const activeStatuses =
          config.statuses.filter(
            (statusDefinition) =>
              statusDefinition.active,
          )

        setStatusDefinitions(activeStatuses)
        setTypeDefinitions(activeTypes)

        // The Type defaults to the first active type definition.
        setTypeDefinitionId(
          activeTypes.length > 0
            ? activeTypes[0].id
            : null,
        )

        // The Status defaults to the Project's canonical default
        // (is_default), falling back to the first active status.
        // Switching Project always resets this, so no stale
        // selection from a previous Project survives.
        const defaultStatus =
          activeStatuses.find(
            (statusDefinition) =>
              statusDefinition.isDefault,
          ) ?? activeStatuses[0]

        setStatusDefinitionId(
          defaultStatus ? defaultStatus.id : null,
        )
      } catch (loadError) {
        if (!cancelled) {
          setTypeDefinitions([])
          setStatusDefinitions([])
          setTypeDefinitionId(null)
          setStatusDefinitionId(null)
          setError(
            getErrorMessage(
              loadError,
              'Work item options could not be loaded.',
            ),
          )
        }
      } finally {
        if (!cancelled) {
          setLoadingConfig(false)
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

  // Local validation for the state where Create is disabled by
  // design: the Project is selected and its configuration has
  // finished loading, but it offers no valid Type definition, so
  // a Work Item cannot be created. Explains it instead of leaving
  // a silently inert button.
  const typeValidationError =
    projectId !== '' &&
    !loadingProjects &&
    !loadingConfig &&
    typeDefinitionId == null
      ? 'Select a valid project and type before creating a work item.'
      : null

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
      const numericStatusDefinitionId =
        statusDefinitionId == null
          ? null
          : Number(statusDefinitionId)

      const workItem =
        await createWorkItemFromMeetingItem(
          meetingItem.id,
          {
            projectId: numericProjectId,
            typeDefinitionId,
            title: title.trim(),
            description: description.trim(),
            // Only pass a concrete status for the selected
            // Project; a stale ID from a previous Project would
            // be invalid.
            ...(numericStatusDefinitionId != null &&
            Number.isInteger(numericStatusDefinitionId)
              ? {
                  statusDefinitionId:
                    numericStatusDefinitionId,
                }
              : {}),
            assigneeIds,
            dueDate:
              dueDate || null,
            // Anchor the created WorkItem to the exact persisted
            // source Note (one primary WorkItem per Note).
            meetingNoteId:
              sourceNote?.id ?? null,
          },
        )

      // Build the compact linked-work summary shown directly at the
      // source Note after creation.
      const linkedProject = projects.find(
        (project) =>
          project.id ===
            numericProjectId,
      )

      const linkedStatus =
        statusDefinitionId != null
          ? statusDefinitions.find(
              (statusDefinition) =>
                statusDefinition.id ===
                  statusDefinitionId,
            )
          : undefined

      const linkedAssigneeNames =
        assigneeIds
          .map((assigneeId) =>
            memberships.find(
              (membership) =>
                membership.user.id ===
                  assigneeId,
            ),
          )
          .filter(
            (membership):
              membership is
                ApiProjectMembership =>
              membership != null,
          )
          .map(getPersonName)

      const linkedWorkItem:
        ApiLinkedWorkItem | null =
        linkedProject != null
          ? {
              id: workItem.id,
              title: workItem.title,
              projectId: linkedProject.id,
              projectName:
                linkedProject.name,
              statusName:
                linkedStatus?.name ??
                '',
              assigneeNames:
                linkedAssigneeNames,
            }
          : null

      // A Project page opened in another tab (or still mounted in
      // this SPA) must pick up the new canonical WorkItem without
      // requiring a hard reload.
      window.dispatchEvent(
        new CustomEvent('fg-workspace:work-item-created', {
          detail: workItem,
        }),
      )

      onCreated(
        workItem,
        linkedWorkItem,
      )
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4 py-4"
    >
      <form
        onSubmit={handleSubmit}
        className="flex max-h-[min(52rem,calc(100dvh-2rem))] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest shadow-xl"
      >
        <div className="shrink-0 border-b border-outline-variant px-6 py-5">
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

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
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
                <>
                  <option value="">
                    Select a project…
                  </option>

                  {projects.map((project) => (
                  <option
                    key={project.id}
                    value={project.id}
                  >
                    {project.name}
                  </option>
                ))}
                </>
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

          {statusDefinitions.length > 0 && (
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-on-surface">
                Status
              </span>

              <select
                value={
                  statusDefinitionId == null
                    ? ''
                    : statusDefinitionId
                }
                onChange={(event) => {
                  const next = Number(event.target.value)

                  setStatusDefinitionId(
                    Number.isInteger(next) ? next : null,
                  )
                }}
                className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus:border-primary"
              >
                {statusDefinitions.map((statusDefinition) => (
                  <option
                    key={statusDefinition.id}
                    value={statusDefinition.id}
                  >
                    {statusDefinition.name}
                  </option>
                ))}
              </select>
            </label>
          )}

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

        <div className="shrink-0 border-t border-outline-variant bg-surface-container-low/45">
          {(error ?? typeValidationError) && (
            <div
              role="alert"
              className="px-6 pt-3 text-sm text-error"
            >
              {error ?? typeValidationError}
            </div>
          )}

          <div className="flex justify-end gap-3 px-6 py-4">
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
              loadingConfig ||
              !projectId ||
              typeDefinitionId == null ||
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
        </div>
      </form>
    </div>
  )
}
