import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import {
  useNavigate,
  useParams,
} from 'react-router'

import { ApiError } from '../../api/client'
import {
  addMeetingParticipant,
  createMeetingItem,
  createMeetingSection,
  endMeeting,
  getMeeting,
  listMeetingItems,
  listMeetingParticipants,
  listMeetingSections,
  reorderMeetingSections,
  reopenMeeting,
  removeMeetingParticipant,
  startMeeting,
  updateMeetingItem,
  updateMeetingSection,
} from '../../api/meetings'
import {
  getProject,
  listResearchGroupMembers,
} from '../../api/projects'
import { useResearchGroup } from '../research-group/useResearchGroup'
import { useSession } from '../../api/useSession'
import { CreateMeetingWorkItemDialog } from './CreateMeetingWorkItemDialog'

import type {
  ApiMeeting,
  ApiMeetingItem,
  ApiMeetingParticipant,
  ApiMeetingSection,
  ApiResearchGroupMember,
  ApiWorkItem,
} from '../../api/types'

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

  const [sections, setSections] =
    useState<ApiMeetingSection[]>([])

  const [
    sectionItemTitle,
    setSectionItemTitle,
  ] = useState<Record<number, string>>({})

  const [
    creatingSectionId,
    setCreatingSectionId,
  ] = useState<number | null>(null)

  const [
    addingSection,
    setAddingSection,
  ] = useState(false)
  const [newSectionName, setNewSectionName] =
    useState('')

  const [
    editingSectionId,
    setEditingSectionId,
  ] = useState<number | null>(null)
  const [editSectionName, setEditSectionName] =
    useState('')
  const [editSectionDescription, setEditSectionDescription] =
    useState('')
  const [savingSection, setSavingSection] =
    useState(false)

  const [
    reorderingSections,
    setReorderingSections,
  ] = useState(false)

  const [updatingItemId, setUpdatingItemId] =
    useState<number | null>(null)

  const [updatingMeeting, setUpdatingMeeting] =
    useState(false)

  const [
    workItemSource,
    setWorkItemSource,
  ] = useState<ApiMeetingItem | null>(null)

  const { user } = useSession()
  const { activeResearchGroup } = useResearchGroup()

  const isGroupAdmin = useMemo(() => {
    if (user == null) {
      return false
    }

    return (
      activeResearchGroup?.role === 'admin' &&
      activeResearchGroup.id === meeting?.researchGroupId
    )
  }, [activeResearchGroup, user, meeting?.researchGroupId])

  // For a Project Meeting, resolve the current user's role from the
  // Project read-model so viewers never see enabled lifecycle actions.
  const [projectRole, setProjectRole] = useState<string | null>(null)

  useEffect(() => {
    if (meeting == null || meeting.scope !== 'project') {
      setProjectRole(null)

      return
    }

    if (meeting.projectId == null) {
      setProjectRole(null)

      return
    }

    let cancelled = false

    getProject(meeting.projectId)
      .then((project) => {
        if (!cancelled) {
          setProjectRole(project.currentUserRole)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProjectRole(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [meeting])

  // Group Meetings are managed by Research Group admins. Project
  // Meetings are managed by the Project's owner/member (write roles).
  // The server remains authoritative; this only decides whether to
  // render the controls.
  const canManageLifecycle = useMemo(() => {
    if (meeting == null) {
      return false
    }

    if (meeting.scope === 'group') {
      return isGroupAdmin
    }

    if (meeting.projectId == null) {
      return false
    }

    return (
      projectRole === 'owner' ||
      projectRole === 'member'
    )
  }, [meeting, isGroupAdmin, projectRole])

  const loadMeeting = useCallback(async () => {
    if (meetingId == null) {
      setMeeting(null)
      setParticipants([])
      setMembers([])
      setItems([])
      setSections([])
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
        nextSections,
      ] = await Promise.all([
        listMeetingParticipants(meetingId),
        listMeetingItems(meetingId),
        listResearchGroupMembers(
          nextMeeting.researchGroupId,
        ),
        listMeetingSections(meetingId),
      ])

      setMeeting(nextMeeting)
      setParticipants(nextParticipants)
      setItems(nextItems)
      setMembers(nextMembers)
      setSections(nextSections)
    } catch (error) {
      setMeeting(null)
      setParticipants([])
      setMembers([])
      setItems([])
      setSections([])

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

  const sortedSections = useMemo(
    () =>
      [...sections].sort(
        (a, b) =>
          a.position - b.position ||
          a.id - b.id,
      ),
    [sections],
  )

  const visibleSections = useMemo(
    () =>
      sortedSections.filter(
        (section) => section.isVisible,
      ),
    [sortedSections],
  )

  const itemsBySection = useMemo(() => {
    const map = new Map<number, ApiMeetingItem[]>()

    for (const item of sortedItems) {
      const existing = map.get(
        item.meetingSectionId,
      ) ?? []

      existing.push(item)
      map.set(item.meetingSectionId, existing)
    }

    return map
  }, [sortedItems])

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

  const handleCreateItemInSection = async (
    section: ApiMeetingSection,
  ) => {
    if (
      meetingId == null ||
      creatingSectionId !== null
    ) {
      return
    }

    const title = (sectionItemTitle[section.id] ?? '').trim()
    if (!title) {
      return
    }

    setCreatingSectionId(section.id)
    setActionError(null)

    try {
      const item = await createMeetingItem(
        meetingId,
        {
          meetingSectionId: section.id,
          title,
        },
      )

      setItems((current) => [
        ...current.filter(
          (candidate) =>
            candidate.id !== item.id,
        ),
        item,
      ])

      setSectionItemTitle((current) => ({
        ...current,
        [section.id]: '',
      }))
    } catch (error) {
      setActionError(
        getErrorMessage(
          error,
          'Agenda item could not be created.',
        ),
      )
    } finally {
      setCreatingSectionId(null)
    }
  }

  const handleAddSection = async () => {
    if (
      meetingId == null ||
      !newSectionName.trim() ||
      addingSection
    ) {
      return
    }

    setAddingSection(true)
    setActionError(null)

    try {
      const section = await createMeetingSection(
        meetingId,
        { name: newSectionName.trim() },
      )

      setSections((current) => [...current, section])
      setNewSectionName('')
    } catch (error) {
      setActionError(
        getErrorMessage(
          error,
          'Section could not be created.',
        ),
      )
    } finally {
      setAddingSection(false)
    }
  }

  const handleSaveSection = async (
    section: ApiMeetingSection,
  ) => {
    if (savingSection) {
      return
    }

    setSavingSection(true)
    setActionError(null)

    try {
      const updated = await updateMeetingSection(
        section.id,
        {
          name: editSectionName.trim(),
          description: editSectionDescription.trim(),
        },
      )

      setSections((current) =>
        current.map((candidate) =>
          candidate.id === updated.id
            ? updated
            : candidate,
        ),
      )
      setEditingSectionId(null)
    } catch (error) {
      setActionError(
        getErrorMessage(
          error,
          'Section could not be updated.',
        ),
      )
    } finally {
      setSavingSection(false)
    }
  }

  const handleToggleSectionVisibility = async (
    section: ApiMeetingSection,
  ) => {
    setActionError(null)

    try {
      const updated = await updateMeetingSection(
        section.id,
        { isVisible: !section.isVisible },
      )

      setSections((current) =>
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
          'Section could not be updated.',
        ),
      )
    }
  }

  const handleMoveSection = async (
    section: ApiMeetingSection,
    direction: -1 | 1,
  ) => {
    if (reorderingSections) {
      return
    }

    const sorted = sortedSections
    const index = sorted.findIndex(
      (s) => s.id === section.id,
    )
    const targetIndex = index + direction

    if (
      targetIndex < 0 ||
      targetIndex >= sorted.length
    ) {
      return
    }

    const reordered = [...sorted]
    ;[reordered[index], reordered[targetIndex]] =
      [reordered[targetIndex], reordered[index]]

    setReorderingSections(true)
    setActionError(null)

    try {
      await reorderMeetingSections(
        meetingId!,
        {
          sectionIds: reordered.map(
            (s) => s.id,
          ),
        },
      )
      setSections(reordered)
    } catch (error) {
      setActionError(
        getErrorMessage(
          error,
          'Sections could not be reordered.',
        ),
      )
    } finally {
      setReorderingSections(false)
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

  const handleStartMeeting = async () => {
    if (
      meeting == null ||
      updatingMeeting ||
      meeting.status !== 'upcoming'
    ) {
      return
    }

    setUpdatingMeeting(true)
    setActionError(null)

    try {
      const updated = await startMeeting(meeting.id)

      setMeeting(updated)
    } catch (error) {
      setActionError(
        getErrorMessage(
          error,
          'Meeting could not be started.',
        ),
      )
    } finally {
      setUpdatingMeeting(false)
    }
  }

  const handleEndMeeting = async () => {
    if (
      meeting == null ||
      updatingMeeting ||
      meeting.status !== 'live'
    ) {
      return
    }

    setUpdatingMeeting(true)
    setActionError(null)

    try {
      const updated = await endMeeting(meeting.id)

      setMeeting(updated)
    } catch (error) {
      setActionError(
        getErrorMessage(
          error,
          'Meeting could not be ended.',
        ),
      )
    } finally {
      setUpdatingMeeting(false)
    }
  }


  const handleReopenMeeting = async () => {
    if (
      meeting == null ||
      updatingMeeting ||
      meeting.status !== 'completed'
    ) {
      return
    }

    setUpdatingMeeting(true)
    setActionError(null)

    try {
      const updated = await reopenMeeting(meeting.id)

      setMeeting(updated)
    } catch (error) {
      setActionError(
        getErrorMessage(
          error,
          'Meeting could not be reopened.',
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

  const isCompleted = meeting?.status === 'completed'

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

          <div className="mt-2 flex items-center gap-3 text-sm text-on-surface-variant">
            <span className="inline-flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[18px]">
                event
              </span>

              {formatMeetingDate(
                meeting.scheduledAt,
              )}
            </span>

            <span className="inline-flex items-center gap-1.5 rounded-full border border-outline-variant bg-surface-container-low px-2.5 py-0.5 text-xs font-medium">
              <span className="material-symbols-outlined text-[14px]">
                {meeting.scope === 'project'
                  ? 'folder'
                  : 'groups'}
              </span>

              {meeting.scope === 'project'
                ? 'Project Meeting'
                : 'Research Group Meeting'}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-outline-variant bg-surface-container-lowest px-3 py-1.5 text-xs font-medium text-on-surface-variant">
            <span
              className={`material-symbols-outlined text-[16px] ${
                meeting.status === 'live'
                  ? 'text-primary'
                  : 'text-on-surface-variant'
              }`}
            >
              {meeting.status === 'live'
                ? 'radio_button_checked'
                : meeting.status === 'completed'
                  ? 'check_circle'
                  : 'schedule'}
            </span>
            {meeting.status.charAt(0).toUpperCase() +
              meeting.status.slice(1)}
          </span>

          {meeting.status === 'upcoming' &&
            canManageLifecycle && (
              <button
                type="button"
                disabled={updatingMeeting}
                onClick={() => void handleStartMeeting()}
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-on-primary outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:opacity-60"
              >
                <span className="material-symbols-outlined text-[18px]">
                  play_arrow
                </span>
                Start meeting
              </button>
            )}

          {meeting.status === 'live' &&
            canManageLifecycle && (
              <button
                type="button"
                disabled={updatingMeeting}
                onClick={() => void handleEndMeeting()}
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-error-container px-4 text-sm font-medium text-on-error-container outline-none focus:ring-2 focus:ring-error-container focus:ring-offset-2 disabled:opacity-60"
              >
                <span className="material-symbols-outlined text-[18px]">
                  stop
                </span>
                End meeting
              </button>
            )}

          {meeting.status === 'completed' &&
            canManageLifecycle && (
              <button
                type="button"
                disabled={updatingMeeting}
                onClick={() => void handleReopenMeeting()}
                className="inline-flex h-10 items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-lowest px-4 text-sm font-medium text-on-surface outline-none focus:border-primary disabled:opacity-60"
              >
                <span className="material-symbols-outlined text-[18px]">
                  replay
                </span>
                Reopen meeting
              </button>
            )}
        </div>
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
                Discussion
              </h2>

              <p className="mt-1 text-sm text-on-surface-variant">
                Agenda items, grouped by section.
              </p>
            </div>

            {!isCompleted && (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newSectionName}
                  onChange={(e) =>
                    setNewSectionName(e.target.value)
                  }
                  placeholder="New section name"
                  aria-label="New section name"
                  className="h-9 w-44 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
                />

                <button
                  type="button"
                  disabled={addingSection}
                  onClick={() => void handleAddSection()}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-xs font-semibold text-on-surface transition hover:border-primary/40 hover:bg-surface-container-low disabled:opacity-45"
                >
                  <span className="material-symbols-outlined text-[16px]">
                    add
                  </span>
                  {addingSection
                    ? 'Adding…'
                    : 'Add section'}
                </button>
              </div>
            )}
          </div>

          {visibleSections.length === 0 ? (
            <div className="mt-5 rounded-xl border border-dashed border-outline-variant bg-surface-container-lowest px-6 py-12 text-center">
              <span className="material-symbols-outlined text-[28px] text-on-surface-variant">
                checklist
              </span>

              <p className="mt-3 text-sm font-medium text-on-surface">
                No visible sections
              </p>

              <p className="mt-1 text-sm text-on-surface-variant">
                Add a section to start building the agenda.
              </p>
            </div>
          ) : (
            <div className="mt-5 space-y-6">
              {visibleSections.map(
                (section, sectionIndex) => {
                  const sectionItems =
                    itemsBySection.get(
                      section.id,
                    ) ?? []

                  return (
                    <div
                      key={section.id}
                      className="rounded-xl border border-outline-variant bg-surface-container-lowest"
                    >
                      {/* Section header */}
                      <div className="flex items-center justify-between gap-4 border-b border-outline-variant px-5 py-3">
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-semibold text-on-surface">
                            {section.name}
                          </h3>

                          {section.description && (
                            <span className="text-xs text-on-surface-variant">
                              {section.description}
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1">
                          {/* Move up */}
                          {!isCompleted && (
                            <>
                              <button
                                type="button"
                                aria-label={`Move ${section.name} up`}
                                disabled={
                                  sectionIndex ===
                                    0 ||
                                  reorderingSections
                                }
                                onClick={() =>
                                  void handleMoveSection(
                                    section,
                                    -1,
                                  )
                                }
                                className="flex h-7 w-7 items-center justify-center rounded text-on-surface-variant transition hover:bg-surface-container-high disabled:opacity-30"
                              >
                                <span className="material-symbols-outlined text-[15px]">
                                  arrow_upward
                                </span>
                              </button>

                              <button
                                type="button"
                                aria-label={`Move ${section.name} down`}
                                disabled={
                                  sectionIndex ===
                                    visibleSections.length -
                                    1 ||
                                  reorderingSections
                                }
                                onClick={() =>
                                  void handleMoveSection(
                                    section,
                                    1,
                                  )
                                }
                                className="flex h-7 w-7 items-center justify-center rounded text-on-surface-variant transition hover:bg-surface-container-high disabled:opacity-30"
                              >
                                <span className="material-symbols-outlined text-[15px]">
                                  arrow_downward
                                </span>
                              </button>

                              {/* Edit */}
                              <button
                                type="button"
                                aria-label={`Edit ${section.name}`}
                                onClick={() => {
                                  setEditingSectionId(
                                    section.id,
                                  )
                                  setEditSectionName(
                                    section.name,
                                  )
                                  setEditSectionDescription(
                                    section.description,
                                  )
                                }}
                                className="flex h-7 w-7 items-center justify-center rounded text-on-surface-variant transition hover:bg-surface-container-high"
                              >
                                <span className="material-symbols-outlined text-[15px]">
                                  edit
                                </span>
                              </button>

                              {/* Hide */}
                              <button
                                type="button"
                                aria-label={`Hide ${section.name}`}
                                onClick={() =>
                                  void handleToggleSectionVisibility(
                                    section,
                                  )
                                }
                                className="flex h-7 w-7 items-center justify-center rounded text-on-surface-variant transition hover:bg-surface-container-high"
                              >
                                <span className="material-symbols-outlined text-[15px]">
                                  visibility_off
                                </span>
                              </button>
                            </>
                          )}
                        </div>
                      </div>

                      {/* Edit form */}
                      {editingSectionId ===
                        section.id && (
                        <div className="border-b border-outline-variant bg-surface-container-low/40 px-5 py-4">
                          <div className="flex items-end gap-3">
                            <label className="flex-1">
                              <span className="mb-1 block text-xs font-medium text-on-surface-variant">
                                Name
                              </span>

                              <input
                                type="text"
                                value={editSectionName}
                                onChange={(e) =>
                                  setEditSectionName(
                                    e.target.value,
                                  )
                                }
                                className="h-9 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus:border-primary"
                              />
                            </label>

                            <label className="flex-1">
                              <span className="mb-1 block text-xs font-medium text-on-surface-variant">
                                Description
                              </span>

                              <input
                                type="text"
                                value={editSectionDescription}
                                onChange={(e) =>
                                  setEditSectionDescription(
                                    e.target.value,
                                  )
                                }
                                className="h-9 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus:border-primary"
                              />
                            </label>

                            <button
                              type="button"
                              disabled={savingSection}
                              onClick={() =>
                                void handleSaveSection(
                                  section,
                                )
                              }
                              className="h-9 rounded-lg bg-primary px-4 text-sm font-semibold text-white transition hover:bg-primary/90 disabled:opacity-45"
                            >
                              {savingSection
                                ? 'Saving…'
                                : 'Save'}
                            </button>

                            <button
                              type="button"
                              onClick={() =>
                                setEditingSectionId(
                                  null,
                                )
                              }
                              className="h-9 rounded-lg px-3 text-sm font-medium text-on-surface-variant transition hover:bg-surface-container-high"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Items */}
                      <div className="p-4">
                        {sectionItems.length ===
                          0 &&
                          !isCompleted && (
                          <p className="mb-3 text-xs text-on-surface-variant">
                            No items in this section yet.
                          </p>
                        )}

                        {sectionItems.length ===
                          0 &&
                          isCompleted && (
                          <p className="text-xs text-on-surface-variant">
                            No items.
                          </p>
                        )}

                        <div className="space-y-3">
                          {sectionItems.map(
                            (item, itemIndex) => (
                              <article
                                key={item.id}
                                className="rounded-lg border border-outline-variant bg-surface-container-lowest p-4"
                              >
                                <div className="flex items-start justify-between gap-4">
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs font-medium text-on-surface-variant">
                                        #{itemIndex + 1}
                                      </span>

                                      <h4 className="text-sm font-medium text-on-surface">
                                        {item.title}
                                      </h4>
                                    </div>

                                    {item.notes && (
                                      <p className="mt-1.5 whitespace-pre-wrap text-sm text-on-surface-variant">
                                        {item.notes}
                                      </p>
                                    )}

                                    {item.workItemIds.length >
                                      0 && (
                                      <div className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-primary">
                                        <span className="material-symbols-outlined text-[14px]">
                                          task_alt
                                        </span>

                                        {item.workItemIds.length}{' '}
                                        linked work{' '}
                                        {item.workItemIds.length ===
                                          1
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
                                      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-outline-variant bg-surface-container-lowest px-2.5 text-xs font-semibold text-on-surface transition hover:border-primary/40 hover:bg-surface-container-low"
                                    >
                                      <span className="material-symbols-outlined text-[15px]">
                                        add_task
                                      </span>

                                      Work item
                                    </button>

                                    <button
                                      type="button"
                                      disabled={
                                        isCompleted ||
                                        updatingItemId ===
                                          item.id
                                      }
                                      onClick={() =>
                                        void handleToggleItemStatus(
                                          item,
                                        )
                                      }
                                      className={[
                                        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition disabled:opacity-45',
                                        item.status ===
                                        'discussed'
                                          ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                                          : 'border-outline-variant bg-surface-container-lowest text-on-surface hover:bg-surface-container-low',
                                      ].join(' ')}
                                    >
                                      <span className="material-symbols-outlined text-[15px]">
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
                            ),
                          )}
                        </div>

                        {/* Add item */}
                        {!isCompleted && (
                          <form
                            onSubmit={(e) => {
                              e.preventDefault()
                              void handleCreateItemInSection(
                                section,
                              )
                            }}
                            className="mt-3 flex items-center gap-2"
                          >
                            <input
                              type="text"
                              value={
                                sectionItemTitle[section.id] ??
                                ''
                              }
                              onChange={(e) =>
                                setSectionItemTitle(
                                  (current) => ({
                                    ...current,
                                    [section.id]:
                                      e.target.value,
                                  }),
                                )
                              }
                              placeholder="+ Add item"
                              aria-label={`Add item to ${section.name}`}
                              disabled={
                                creatingSectionId ===
                                section.id
                              }
                              className="h-9 flex-1 rounded-lg border border-dashed border-outline-variant bg-transparent px-3 text-sm text-on-surface outline-none transition placeholder:text-on-surface-variant/50 focus:border-solid focus:border-primary"
                            />

                            <button
                              type="submit"
                              aria-label={`Add ${section.name} item`}
                              disabled={
                                creatingSectionId ===
                                section.id
                              }
                              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-white transition hover:bg-primary/90 disabled:opacity-45"
                            >
                              <span className="material-symbols-outlined text-[18px]">
                                add
                              </span>
                            </button>
                          </form>
                        )}
                      </div>
                    </div>
                  )
                },
              )}
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
                      isCompleted ||
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
                    isCompleted ||
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
                          isCompleted ||
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
