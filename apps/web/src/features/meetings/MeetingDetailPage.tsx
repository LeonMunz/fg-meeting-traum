import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import type { FormEvent } from 'react'
import {
  useNavigate,
  useParams,
} from 'react-router'

import { ApiError } from '../../api/client'
import {
  addMeetingParticipant,
  createMeetingItem,
  getMeeting,
  listMeetingItems,
  listMeetingParticipants,
  removeMeetingParticipant,
  updateMeeting,
  updateMeetingItem,
} from '../../api/meetings'
import { listResearchGroupMembers } from '../../api/projects'
import { CreateMeetingWorkItemDialog } from './CreateMeetingWorkItemDialog'

import type {
  ApiMeeting,
  ApiMeetingItem,
  ApiMeetingParticipant,
  ApiMeetingStatus,
  ApiResearchGroupMember,
  ApiWorkItem,
} from '../../api/types'

const meetingStatusLabels: Record<
  ApiMeetingStatus,
  string
> = {
  upcoming: 'Upcoming',
  live: 'Live',
  completed: 'Completed',
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

  if (error instanceof Error && error.message) {
    return error.message
  }

  return fallback
}

function formatMeetingDate(value: string) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat('en', {
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(date)
}

function getPersonName(person: {
  firstName: string
  lastName: string
  username: string
}) {
  const fullName = [
    person.firstName,
    person.lastName,
  ]
    .filter(Boolean)
    .join(' ')
    .trim()

  return fullName || person.username
}

function getInitials(person: {
  firstName: string
  lastName: string
  username: string
}) {
  const first =
    person.firstName.trim()[0] ??
    person.username.trim()[0] ??
    '?'

  const last =
    person.lastName.trim()[0] ?? ''

  return `${first}${last}`.toUpperCase()
}
import { useSyncResearchGroupContext } from '../research-group/useSyncResearchGroupContext'

export function MeetingDetailPage() {
  const navigate = useNavigate()
  const { meetingId: meetingIdParam } = useParams()

  const parsedMeetingId = Number(meetingIdParam)

  const meetingId =
    Number.isInteger(parsedMeetingId) &&
    parsedMeetingId > 0
      ? parsedMeetingId
      : null

  const [meeting, setMeeting] =
    useState<ApiMeeting | null>(null)

  useSyncResearchGroupContext(
    meeting?.researchGroupId,
  )


  const [participants, setParticipants] =
    useState<ApiMeetingParticipant[]>([])

  const [members, setMembers] =
    useState<ApiResearchGroupMember[]>([])

  const [items, setItems] =
    useState<ApiMeetingItem[]>([])

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] =
    useState<string | null>(null)

  const [actionError, setActionError] =
    useState<string | null>(null)

  const [selectedMemberId, setSelectedMemberId] =
    useState('')

  const [addingParticipant, setAddingParticipant] =
    useState(false)

  const [
    removingParticipantId,
    setRemovingParticipantId,
  ] = useState<number | null>(null)

  const [agendaTitle, setAgendaTitle] =
    useState('')

  const [agendaNotes, setAgendaNotes] =
    useState('')

  const [creatingItem, setCreatingItem] =
    useState(false)

  const [updatingItemId, setUpdatingItemId] =
    useState<number | null>(null)

  const [updatingMeeting, setUpdatingMeeting] =
    useState(false)

  const [
    workItemSource,
    setWorkItemSource,
  ] = useState<ApiMeetingItem | null>(null)

  const loadMeeting = useCallback(async () => {
    if (meetingId == null) {
      setMeeting(null)
      setParticipants([])
      setMembers([])
      setItems([])
      setLoadError('Invalid Meeting ID.')
      setLoading(false)
      return
    }

    setLoading(true)
    setLoadError(null)
    setActionError(null)

    try {
      const nextMeeting =
        await getMeeting(meetingId)

      const [
        nextParticipants,
        nextItems,
        nextMembers,
      ] = await Promise.all([
        listMeetingParticipants(meetingId),
        listMeetingItems(meetingId),
        listResearchGroupMembers(
          nextMeeting.researchGroupId,
        ),
      ])

      setMeeting(nextMeeting)
      setParticipants(nextParticipants)
      setItems(nextItems)
      setMembers(nextMembers)
    } catch (error) {
      setMeeting(null)
      setParticipants([])
      setMembers([])
      setItems([])

      setLoadError(
        getErrorMessage(
          error,
          'Meeting could not be loaded.',
        ),
      )
    } finally {
      setLoading(false)
    }
  }, [meetingId])

  useEffect(() => {
    void loadMeeting()
  }, [loadMeeting])

  const participantUserIds = useMemo(
    () =>
      new Set(
        participants.map(
          (participant) =>
            participant.user.id,
        ),
      ),
    [participants],
  )

  const availableMembers = useMemo(
    () =>
      members
        .filter(
          (member) =>
            !participantUserIds.has(member.id),
        )
        .sort((a, b) =>
          getPersonName(a).localeCompare(
            getPersonName(b),
          ),
        ),
    [members, participantUserIds],
  )

  const sortedParticipants = useMemo(
    () =>
      [...participants].sort((a, b) =>
        getPersonName(a.user).localeCompare(
          getPersonName(b.user),
        ),
      ),
    [participants],
  )

  const sortedItems = useMemo(
    () =>
      [...items].sort(
        (a, b) =>
          a.position - b.position ||
          a.id - b.id,
      ),
    [items],
  )

  const handleAddParticipant = async () => {
    if (
      meetingId == null ||
      !selectedMemberId ||
      addingParticipant
    ) {
      return
    }

    const userId = Number(selectedMemberId)

    if (!Number.isInteger(userId)) {
      return
    }

    setAddingParticipant(true)
    setActionError(null)

    try {
      const participant =
        await addMeetingParticipant(
          meetingId,
          { userId },
        )

      setParticipants((current) => [
        ...current.filter(
          (candidate) =>
            candidate.id !== participant.id,
        ),
        participant,
      ])

      setMeeting((current) =>
        current
          ? {
              ...current,
              participantIds: [
                ...new Set([
                  ...current.participantIds,
                  participant.user.id,
                ]),
              ],
            }
          : current,
      )

      setSelectedMemberId('')
    } catch (error) {
      setActionError(
        getErrorMessage(
          error,
          'Participant could not be added.',
        ),
      )
    } finally {
      setAddingParticipant(false)
    }
  }

  const handleRemoveParticipant = async (
    participant: ApiMeetingParticipant,
  ) => {
    if (
      meetingId == null ||
      removingParticipantId != null
    ) {
      return
    }

    setRemovingParticipantId(participant.id)
    setActionError(null)

    try {
      await removeMeetingParticipant(
        meetingId,
        participant.id,
      )

      setParticipants((current) =>
        current.filter(
          (candidate) =>
            candidate.id !== participant.id,
        ),
      )

      setMeeting((current) =>
        current
          ? {
              ...current,
              participantIds:
                current.participantIds.filter(
                  (id) =>
                    id !== participant.user.id,
                ),
            }
          : current,
      )
    } catch (error) {
      setActionError(
        getErrorMessage(
          error,
          'Participant could not be removed.',
        ),
      )
    } finally {
      setRemovingParticipantId(null)
    }
  }

  const handleCreateItem = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault()

    if (
      meetingId == null ||
      !agendaTitle.trim() ||
      creatingItem
    ) {
      return
    }

    setCreatingItem(true)
    setActionError(null)

    try {
      const item = await createMeetingItem(
        meetingId,
        {
          title: agendaTitle.trim(),
          notes: agendaNotes.trim(),
        },
      )

      setItems((current) => [
        ...current.filter(
          (candidate) =>
            candidate.id !== item.id,
        ),
        item,
      ])

      setAgendaTitle('')
      setAgendaNotes('')
    } catch (error) {
      setActionError(
        getErrorMessage(
          error,
          'Agenda item could not be created.',
        ),
      )
    } finally {
      setCreatingItem(false)
    }
  }

  const handleToggleItemStatus = async (
    item: ApiMeetingItem,
  ) => {
    if (updatingItemId != null) {
      return
    }

    setUpdatingItemId(item.id)
    setActionError(null)

    try {
      const updated = await updateMeetingItem(
        item.id,
        {
          status:
            item.status === 'open'
              ? 'discussed'
              : 'open',
        },
      )

      setItems((current) =>
        current.map((candidate) =>
          candidate.id === updated.id
            ? updated
            : candidate,
        ),
      )
    } catch (error) {
      setActionError(
        getErrorMessage(
          error,
          'Agenda item could not be updated.',
        ),
      )
    } finally {
      setUpdatingItemId(null)
    }
  }

  const handleMeetingStatusChange = async (
    status: ApiMeetingStatus,
  ) => {
    if (
      meeting == null ||
      updatingMeeting ||
      meeting.status === status
    ) {
      return
    }

    setUpdatingMeeting(true)
    setActionError(null)

    try {
      const updated = await updateMeeting(
        meeting.id,
        { status },
      )

      setMeeting(updated)
    } catch (error) {
      setActionError(
        getErrorMessage(
          error,
          'Meeting status could not be updated.',
        ),
      )
    } finally {
      setUpdatingMeeting(false)
    }
  }

  const handleWorkItemCreated = (
    workItem: ApiWorkItem,
  ) => {
    if (!workItemSource) {
      return
    }

    const meetingItemId =
      workItemSource.id

    setItems((current) =>
      current.map((item) =>
        item.id === meetingItemId
          ? {
              ...item,
              workItemIds: [
                ...new Set([
                  ...item.workItemIds,
                  workItem.id,
                ]),
              ],
            }
          : item,
      ),
    )
  }

  if (loading) {
    return (
      <div className="w-full px-6 py-8 lg:px-8 lg:py-10 xl:px-10">
        <div className="flex min-h-72 items-center justify-center rounded-xl border border-outline-variant bg-surface-container-lowest">
          <span className="material-symbols-outlined mr-2 animate-spin text-[20px] text-on-surface-variant">
            refresh
          </span>

          <span className="text-sm text-on-surface-variant">
            Loading meeting…
          </span>
        </div>
      </div>
    )
  }

  if (!meeting || loadError) {
    return (
      <div className="w-full px-6 py-8 lg:px-8 lg:py-10 xl:px-10">
        <button
          type="button"
          onClick={() => navigate('/meetings')}
          className="inline-flex items-center gap-2 text-sm font-medium text-on-surface-variant hover:text-primary"
        >
          <span className="material-symbols-outlined text-[18px]">
            arrow_back
          </span>
          Meetings
        </button>

        <div
          role="alert"
          className="mt-6 flex min-h-64 flex-col items-center justify-center rounded-xl border border-outline-variant bg-surface-container-lowest px-6 py-10 text-center"
        >
          <span className="material-symbols-outlined text-[28px] text-error">
            error
          </span>

          <h1 className="mt-3 text-lg font-semibold text-on-surface">
            Meeting unavailable
          </h1>

          <p className="mt-1 text-sm text-on-surface-variant">
            {loadError ??
              'Meeting could not be loaded.'}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full px-6 py-8 lg:px-8 lg:py-10 xl:px-10">
      <button
        type="button"
        onClick={() => navigate('/meetings')}
        className="inline-flex items-center gap-2 text-sm font-medium text-on-surface-variant transition hover:text-primary"
      >
        <span className="material-symbols-outlined text-[18px]">
          arrow_back
        </span>
        Meetings
      </button>

      <header className="mt-5 flex items-start justify-between gap-6 border-b border-outline-variant pb-6">
        <div className="min-w-0">
          <h1 className="truncate text-3xl font-semibold tracking-tight text-on-surface">
            {meeting.title}
          </h1>

          <div className="mt-2 flex items-center gap-2 text-sm text-on-surface-variant">
            <span className="material-symbols-outlined text-[18px]">
              event
            </span>

            {formatMeetingDate(
              meeting.scheduledAt,
            )}
          </div>
        </div>

        <label className="shrink-0">
          <span className="sr-only">
            Meeting status
          </span>

          <select
            value={meeting.status}
            disabled={updatingMeeting}
            onChange={(event) =>
              void handleMeetingStatusChange(
                event.target
                  .value as ApiMeetingStatus,
              )
            }
            className="h-10 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm font-medium text-on-surface outline-none focus:border-primary"
          >
            {(
              Object.keys(
                meetingStatusLabels,
              ) as ApiMeetingStatus[]
            ).map((status) => (
              <option
                key={status}
                value={status}
              >
                {meetingStatusLabels[status]}
              </option>
            ))}
          </select>
        </label>
      </header>

      {actionError && (
        <div
          role="alert"
          className="mt-5 rounded-lg bg-error-container px-4 py-3 text-sm text-error"
        >
          {actionError}
        </div>
      )}

      <div className="mt-8 grid gap-8 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section>
          <div className="flex items-end justify-between gap-6">
            <div>
              <h2 className="text-lg font-semibold text-on-surface">
                Agenda
              </h2>

              <p className="mt-1 text-sm text-on-surface-variant">
                Discussion points for this meeting.
              </p>
            </div>

            <div className="text-sm text-on-surface-variant">
              {items.length}{' '}
              {items.length === 1
                ? 'item'
                : 'items'}
            </div>
          </div>

          <form
            onSubmit={handleCreateItem}
            className="mt-5 rounded-xl border border-outline-variant bg-surface-container-lowest p-5"
          >
            <div className="grid gap-4">
              <label>
                <span className="mb-1.5 block text-sm font-medium text-on-surface">
                  Agenda item
                </span>

                <input
                  type="text"
                  value={agendaTitle}
                  onChange={(event) =>
                    setAgendaTitle(
                      event.target.value,
                    )
                  }
                  placeholder="What should be discussed?"
                  className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
                />
              </label>

              <label>
                <span className="mb-1.5 block text-sm font-medium text-on-surface">
                  Notes
                </span>

                <textarea
                  value={agendaNotes}
                  onChange={(event) =>
                    setAgendaNotes(
                      event.target.value,
                    )
                  }
                  rows={3}
                  placeholder="Optional context or notes..."
                  className="w-full resize-y rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2.5 text-sm text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
                />
              </label>
            </div>

            <div className="mt-4 flex justify-end">
              <button
                type="submit"
                disabled={
                  creatingItem ||
                  !agendaTitle.trim()
                }
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <span className="material-symbols-outlined text-[18px]">
                  add
                </span>

                {creatingItem
                  ? 'Adding…'
                  : 'Add agenda item'}
              </button>
            </div>
          </form>

          {sortedItems.length === 0 ? (
            <div className="mt-5 rounded-xl border border-dashed border-outline-variant bg-surface-container-lowest px-6 py-12 text-center">
              <span className="material-symbols-outlined text-[28px] text-on-surface-variant">
                checklist
              </span>

              <p className="mt-3 text-sm font-medium text-on-surface">
                No agenda items yet
              </p>

              <p className="mt-1 text-sm text-on-surface-variant">
                Add the first discussion point above.
              </p>
            </div>
          ) : (
            <div className="mt-5 space-y-3">
              {sortedItems.map((item) => (
                <article
                  key={item.id}
                  className="rounded-xl border border-outline-variant bg-surface-container-lowest p-5"
                >
                  <div className="flex items-start justify-between gap-6">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-on-surface-variant">
                          #{item.position + 1}
                        </span>

                        <h3 className="text-sm font-semibold text-on-surface">
                          {item.title}
                        </h3>
                      </div>

                      {item.notes && (
                        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-on-surface-variant">
                          {item.notes}
                        </p>
                      )}

                      {item.workItemIds.length >
                        0 && (
                        <div className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-primary">
                          <span className="material-symbols-outlined text-[16px]">
                            task_alt
                          </span>

                          {item.workItemIds.length}{' '}
                          linked work{' '}
                          {item.workItemIds
                            .length === 1
                            ? 'item'
                            : 'items'}
                        </div>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setWorkItemSource(item)
                        }
                        className="inline-flex h-9 items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-xs font-semibold text-on-surface transition hover:border-primary/40 hover:bg-surface-container-low"
                      >
                        <span className="material-symbols-outlined text-[17px]">
                          add_task
                        </span>

                        Create work item
                      </button>

                      <button
                      type="button"
                      disabled={
                        updatingItemId === item.id
                      }
                      onClick={() =>
                        void handleToggleItemStatus(
                          item,
                        )
                      }
                      className={[
                        'inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border px-3 text-xs font-semibold transition disabled:opacity-45',
                        item.status ===
                        'discussed'
                          ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                          : 'border-outline-variant bg-surface-container-lowest text-on-surface hover:bg-surface-container-low',
                      ].join(' ')}
                    >
                      <span className="material-symbols-outlined text-[17px]">
                        {item.status ===
                        'discussed'
                          ? 'check_circle'
                          : 'radio_button_unchecked'}
                      </span>

                      {item.status ===
                      'discussed'
                        ? 'Discussed'
                        : 'Mark discussed'}
                    </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <aside>
          <div className="rounded-xl border border-outline-variant bg-surface-container-lowest">
            <div className="border-b border-outline-variant px-5 py-4">
              <h2 className="text-base font-semibold text-on-surface">
                Participants
              </h2>

              <p className="mt-1 text-xs text-on-surface-variant">
                {participants.length}{' '}
                {participants.length === 1
                  ? 'person'
                  : 'people'}
              </p>
            </div>

            <div className="p-5">
              <div className="flex gap-2">
                <label className="min-w-0 flex-1">
                  <span className="sr-only">
                    Add participant
                  </span>

                  <select
                    value={selectedMemberId}
                    disabled={
                      addingParticipant ||
                      availableMembers.length ===
                        0
                    }
                    onChange={(event) =>
                      setSelectedMemberId(
                        event.target.value,
                      )
                    }
                    className="h-9 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-2 text-sm text-on-surface outline-none focus:border-primary"
                  >
                    <option value="">
                      {availableMembers.length >
                      0
                        ? 'Select member…'
                        : 'Everyone added'}
                    </option>

                    {availableMembers.map(
                      (member) => (
                        <option
                          key={member.id}
                          value={member.id}
                        >
                          {getPersonName(member)}
                        </option>
                      ),
                    )}
                  </select>
                </label>

                <button
                  type="button"
                  disabled={
                    addingParticipant ||
                    !selectedMemberId
                  }
                  onClick={() =>
                    void handleAddParticipant()
                  }
                  className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45"
                >
                  Add
                </button>
              </div>

              <div className="mt-5 divide-y divide-outline-variant">
                {sortedParticipants.map(
                  (participant) => (
                    <div
                      key={participant.id}
                      className="flex items-center gap-3 py-3"
                    >
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-[11px] font-semibold text-on-surface">
                        {getInitials(
                          participant.user,
                        )}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-on-surface">
                          {getPersonName(
                            participant.user,
                          )}
                        </div>

                        <div className="truncate text-xs text-on-surface-variant">
                          @
                          {
                            participant.user
                              .username
                          }
                        </div>
                      </div>

                      <button
                        type="button"
                        aria-label={`Remove ${getPersonName(participant.user)}`}
                        disabled={
                          removingParticipantId ===
                          participant.id
                        }
                        onClick={() =>
                          void handleRemoveParticipant(
                            participant,
                          )
                        }
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-on-surface-variant transition hover:bg-error-container hover:text-error disabled:opacity-45"
                      >
                        <span className="material-symbols-outlined text-[18px]">
                          close
                        </span>
                      </button>
                    </div>
                  ),
                )}
              </div>
            </div>
          </div>
        </aside>
      </div>

      <CreateMeetingWorkItemDialog
        open={workItemSource != null}
        researchGroupId={
          meeting.researchGroupId
        }
        meetingItem={workItemSource}
        onClose={() =>
          setWorkItemSource(null)
        }
        onCreated={
          handleWorkItemCreated
        }
      />
    </div>
  )
}
