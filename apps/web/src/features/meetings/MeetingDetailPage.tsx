import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import type { ReactNode } from 'react'
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
import { useSyncResearchGroupContext } from '../research-group/useSyncResearchGroupContext'

type MeetingState = 'upcoming' | 'live' | 'completed'

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

function meetingContentHeading(
  status: MeetingState,
) {
  if (status === 'upcoming') {
    return 'Agenda preparation'
  }

  if (status === 'completed') {
    return 'Protocol'
  }

  return 'Discussion'
}

function meetingContentSubtitle(
  status: MeetingState,
) {
  if (status === 'upcoming') {
    return 'Agenda items, grouped by section.'
  }

  if (status === 'completed') {
    return 'Meeting record, grouped by section.'
  }

  return 'Agenda items, grouped by section.'
}

function MenuItem({
  label,
  icon,
  danger,
  disabled,
  onClick,
}: {
  label: string
  icon?: string
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={[
        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm outline-none',
        danger
          ? 'text-error hover:bg-error-container/40 focus-visible:bg-error-container/40'
          : 'text-on-surface hover:bg-surface-container-low focus-visible:bg-surface-container-low',
        disabled ? 'pointer-events-none opacity-45' : '',
      ].join(' ')}
    >
      {icon && (
        <span
          aria-hidden="true"
          className="material-symbols-outlined text-[17px] text-on-surface-variant"
        >
          {icon}
        </span>
      )}

      <span className="truncate">{label}</span>
    </button>
  )
}

function MenuTrigger({
  label,
  ariaLabel,
  children,
}: {
  label: string
  ariaLabel?: string
  children: (
    open: boolean,
    toggle: () => void,
  ) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({
    top: 0,
    left: 0,
  })
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    const onOutside = (event: MouseEvent) => {
      if (
        ref.current &&
        !ref.current.contains(
          event.target as Node,
        )
      ) {
        setOpen(false)
      }
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    const onScroll = () => setOpen(false)

    document.addEventListener('mousedown', onOutside, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)

    return () => {
      document.removeEventListener('mousedown', onOutside, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  const toggle = () => {
    if (!open && ref.current) {
      const rect =
        ref.current.getBoundingClientRect()

      setPosition({
        top: rect.bottom + 6,
        left: Math.max(
          8,
          rect.right - 208,
        ),
      })
    }

    setOpen((current) => !current)
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={ariaLabel ?? label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        className={[
          'flex h-8 w-8 items-center justify-center rounded-lg text-on-surface-variant outline-none transition hover:bg-surface-container-high focus-visible:bg-surface-container-high focus-visible:ring-2 focus-visible:ring-primary/30',
          open
            ? 'bg-surface-container-high'
            : 'group-hover/menu:bg-surface-container-high/70 focus-visible:bg-surface-container-high',
        ].join(' ')}
      >
        <span
          aria-hidden="true"
          className="material-symbols-outlined text-[18px]"
        >
          more_horiz
        </span>
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'fixed',
            top: position.top,
            left: position.left,
          }}
          className="z-50 w-52 rounded-xl border border-outline-variant bg-surface-container-lowest p-1 shadow-lg shadow-on-surface/10"
        >
          {children(open, toggle)}
        </div>
      )}
    </div>
  )
}

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

  const [
    managingParticipants,
    setManagingParticipants,
  ] = useState(false)

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
    structureEditing,
    setStructureEditing,
  ] = useState(false)

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

  const [
    editingItemId,
    setEditingItemId,
  ] = useState<number | null>(null)
  const [editItemTitle, setEditItemTitle] =
    useState('')
  const [editItemNotes, setEditItemNotes] =
    useState('')
  const [savingItemId, setSavingItemId] =
    useState<number | null>(null)

  const [updatingItemId, setUpdatingItemId] =
    useState<number | null>(null)

  const [updatingMeeting, setUpdatingMeeting] =
    useState(false)

  const [
    workItemSource,
    setWorkItemSource,
  ] = useState<ApiMeetingItem | null>(null)

  const quickAddInputRef =
    useRef<HTMLInputElement>(null)

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



  useEffect(() => {
    if (creatingSectionId !== null) {
      quickAddInputRef.current?.focus()
    }
  }, [creatingSectionId])


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

  const hiddenSectionCount =
    sortedSections.length - visibleSections.length

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
    if (meetingId == null) {
      return
    }

    const title = (sectionItemTitle[section.id] ?? '').trim()
    if (!title) {
      return
    }

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
      await reorderMeetingSections(meetingId!, {
        sectionIds: reordered.map(
          (s) => s.id,
        ),
      })
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

  const startEditingItem = (item: ApiMeetingItem) => {
    setEditingItemId(item.id)
    setEditItemTitle(item.title)
    setEditItemNotes(item.notes)
  }

  const handleSaveItem = async (
    item: ApiMeetingItem,
  ) => {
    if (savingItemId != null) {
      return
    }

    const title = editItemTitle.trim()

    if (!title) {
      setActionError(
        'Agenda item title must not be empty.',
      )

      return
    }

    setSavingItemId(item.id)
    setActionError(null)

    try {
      const updated = await updateMeetingItem(
        item.id,
        {
          title,
          notes: editItemNotes.trim(),
        },
      )

      setItems((current) =>
        current.map((candidate) =>
          candidate.id === updated.id
            ? updated
            : candidate,
        ),
      )
      setEditingItemId(null)
    } catch (error) {
      setActionError(
        getErrorMessage(
          error,
          'Agenda item could not be updated.',
        ),
      )
    } finally {
      setSavingItemId(null)
    }
  }

  const handleDeleteItem = async (
    item: ApiMeetingItem,
  ) => {
    const confirmed = window.confirm(
      `Delete agenda item "${item.title}"?`,
    )

    if (!confirmed) {
      return
    }

    setActionError(null)

    try {
      await fetch(`/api/meetings/items/${item.id}`, {
        method: 'DELETE',
      })

      setItems((current) =>
        current.filter(
          (candidate) => candidate.id !== item.id,
        ),
      )

      setEditingItemId(null)
    } catch (error) {
      setActionError(
        getErrorMessage(
          error,
          'Agenda item could not be deleted.',
        ),
      )
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

  const isUpcoming = meeting.status === 'upcoming'
  const isCompleted = meeting.status === 'completed'
  const isLive = meeting.status === 'live'
  const canPrepare = isUpcoming && canManageLifecycle
  const canEditParticipants =
    canPrepare && !structureEditing

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8 lg:px-8 lg:py-10 xl:px-10">
      {/* Header */}
      <nav>
        <button
          type="button"
          onClick={() => navigate('/meetings')}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-on-surface-variant transition hover:text-primary"
        >
          <span aria-hidden="true" className="material-symbols-outlined text-[18px]">
            arrow_back
          </span>
          Meetings
        </button>
      </nav>

      <header className="mt-4 flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-3xl font-semibold tracking-tight text-on-surface">
            {meeting.title}
          </h1>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-on-surface-variant">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="material-symbols-outlined text-[17px]">
                event
              </span>
              {formatMeetingDate(meeting.scheduledAt)}
            </span>

            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="material-symbols-outlined text-[17px]">
                {meeting.scope === 'project'
                  ? 'folder'
                  : 'groups'}
              </span>
              {meeting.scope === 'project'
                ? 'Project Meeting'
                : 'Research Group Meeting'}
            </span>

            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="material-symbols-outlined text-[17px]">
                groups
              </span>
              {participants.length}{' '}
              {participants.length === 1
                ? 'participant'
                : 'participants'}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2.5">
          {isCompleted && (
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-on-surface-variant">
              <span aria-hidden="true" className="material-symbols-outlined text-[18px]">
                check_circle
              </span>
              Completed
            </span>
          )}

          {isCompleted && canManageLifecycle && (
            <button
              type="button"
              disabled={updatingMeeting}
              onClick={() => void handleReopenMeeting()}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-outline-variant bg-surface-container-lowest px-3.5 text-sm font-medium text-on-surface outline-none transition hover:border-primary/40 hover:bg-surface-container-low focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-[18px]">
                replay
              </span>
              Reopen meeting
            </button>
          )}

          {isUpcoming && canManageLifecycle && (
            <button
              type="button"
              disabled={updatingMeeting}
              onClick={() => void handleStartMeeting()}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-on-primary outline-none transition hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:opacity-60"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-[18px]">
                play_arrow
              </span>
              Start meeting
            </button>
          )}

          {isLive && canManageLifecycle && (
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

      {/* Participants — compact context surface */}
      <div className="mt-6 flex flex-wrap items-center gap-3 border-b border-outline-variant pb-5">
        <div className="flex -space-x-1.5">
          {sortedParticipants.slice(0, 6).map((participant) => (
            <span
              key={participant.id}
              title={getPersonName(participant.user)}
              className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-background bg-surface-container-high text-[10px] font-semibold text-on-surface"
            >
              {getInitials(participant.user)}
            </span>
          ))}

          {participants.length > 6 && (
            <span className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-background bg-surface-container text-[10px] font-semibold text-on-surface-variant">
              +{participants.length - 6}
            </span>
          )}
        </div>

        <span className="text-sm text-on-surface-variant">
          <span className="font-medium text-on-surface">
            Participants
          </span>{' '}
          · {participants.length}
        </span>

        {canEditParticipants && (
          <button
            type="button"
            onClick={() => {
              setManagingParticipants((value) => {
                const next = !value

                if (next) {
                  requestAnimationFrame(() => {
                    document
                      .querySelector<HTMLSelectElement>(
                        'select[data-participant-select]',
                      )
                      ?.focus()
                  })
                }

                return next
              })
            }}
            aria-expanded={managingParticipants}
            className="inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-sm font-medium text-primary outline-none transition hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[17px]">
              {managingParticipants
                ? 'close'
                : 'manage_accounts'}
            </span>
            {managingParticipants
              ? 'Done'
              : 'Manage'}
          </button>
        )}
      </div>

      {managingParticipants && canEditParticipants && (
        <div className="mt-4 rounded-xl border border-outline-variant bg-surface-container-low/50 p-4">
          <div className="flex gap-2">
            <label className="min-w-0 flex-1">
              <span className="sr-only">
                Add participant
              </span>

              <select
                data-participant-select
                value={selectedMemberId}
                disabled={
                  addingParticipant ||
                  availableMembers.length === 0
                }
                onChange={(event) =>
                  setSelectedMemberId(event.target.value)
                }
                className="h-9 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-2 text-sm text-on-surface outline-none focus:border-primary"
              >
                <option value="">
                  {availableMembers.length > 0
                    ? 'Select member…'
                    : 'Everyone added'}
                </option>

                {availableMembers.map((member) => (
                  <option
                    key={member.id}
                    value={member.id}
                  >
                    {getPersonName(member)}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              disabled={
                addingParticipant ||
                !selectedMemberId
              }
              onClick={() => void handleAddParticipant()}
              className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45"
            >
              Add
            </button>
          </div>

          <div className="mt-4 divide-y divide-outline-variant">
            {sortedParticipants.map((participant) => (
              <div
                key={participant.id}
                className="flex items-center gap-3 py-2.5"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-[10px] font-semibold text-on-surface">
                  {getInitials(participant.user)}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-on-surface">
                    {getPersonName(participant.user)}
                  </div>

                  <div className="truncate text-xs text-on-surface-variant">
                    @
                    {participant.user.username}
                  </div>
                </div>

                <button
                  type="button"
                  aria-label={`Remove ${getPersonName(participant.user)}`}
                  disabled={
                    removingParticipantId === participant.id
                  }
                  onClick={() =>
                    void handleRemoveParticipant(participant)
                  }
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-on-surface-variant transition hover:bg-error-container hover:text-error disabled:opacity-45"
                >
                  <span aria-hidden="true" className="material-symbols-outlined text-[18px]">
                    close
                  </span>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Content heading */}
      <div className="mt-8 flex items-end justify-between gap-6">
        <div>
          <h2 className="text-lg font-semibold text-on-surface">
            {meetingContentHeading(meeting.status)}
          </h2>

          <p className="mt-1 text-sm text-on-surface-variant">
            {meetingContentSubtitle(meeting.status)}
          </p>
        </div>

        {canPrepare && !isLive && (
          <button
            type="button"
            onClick={() => setStructureEditing((value) => !value)}
            aria-expanded={structureEditing}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-xs font-semibold text-on-surface outline-none transition hover:border-primary/40 hover:bg-surface-container-low focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[16px]">
              {structureEditing ? 'close' : 'edit_note'}
            </span>
            {structureEditing
              ? 'Done editing structure'
              : 'Edit structure'}
          </button>
        )}
      </div>

      {/* Structure editing banner */}
      {structureEditing && canPrepare && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-primary/25 bg-primary/5 px-4 py-3">
          <span aria-hidden="true" className="material-symbols-outlined text-[18px] text-primary">
            edit_note
          </span>

          <div className="min-w-0 flex-1 text-sm text-on-surface">
            Section structure editing.
            {hiddenSectionCount > 0 && (
              <span className="text-on-surface-variant">
                {' '}
                {hiddenSectionCount} hidden{' '}
                {hiddenSectionCount === 1
                  ? 'section'
                  : 'sections'}{' '}
                are listed here.
              </span>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault()
              void handleAddSection()
            }}
            className="flex items-center gap-2"
          >
            <input
              type="text"
              value={newSectionName}
              onChange={(e) => setNewSectionName(e.target.value)}
              placeholder="New section name"
              aria-label="New section name"
              className="h-8 w-44 rounded-lg border border-outline-variant bg-surface-container-lowest px-2.5 text-sm text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
            />

            <button
              type="submit"
              disabled={addingSection || !newSectionName.trim()}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-white transition hover:bg-primary/90 disabled:opacity-45"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-[15px]">
                add
              </span>
              {addingSection ? 'Adding…' : 'Add section'}
            </button>
          </form>
        </div>
      )}

      {/* Agenda / Protocol */}
      <div className="mt-6">
        {visibleSections.length === 0 ? (
          <div className="rounded-xl border border-dashed border-outline-variant px-6 py-12 text-center">
            <span aria-hidden="true" className="material-symbols-outlined text-[26px] text-on-surface-variant">
              checklist
            </span>

            <p className="mt-3 text-sm font-medium text-on-surface">
              {structureEditing && canPrepare
                ? 'No sections yet'
                : 'No agenda items yet.'}
            </p>

            {!structureEditing && canPrepare && (
              <button
                type="button"
                onClick={() => setStructureEditing(true)}
                className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-medium text-on-primary transition hover:bg-primary/90"
              >
                <span aria-hidden="true" className="material-symbols-outlined text-[17px]">
                  add
                </span>
                Add first section
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-10">
            {(structureEditing && canPrepare
              ? sortedSections
              : visibleSections
            ).map((section) => {
              const sectionItems =
                itemsBySection.get(section.id) ?? []

              return (
                <section key={section.id} aria-label={section.name}>
                  {/* Section header */}
                  <div className="group/menu flex items-center gap-2">
                    <h3 className="text-base font-semibold text-on-surface">
                      {section.name}
                    </h3>

                    {section.description && (
                      <span className="truncate text-sm text-on-surface-variant">
                        {section.description}
                      </span>
                    )}

                    <span className="text-xs tabular-nums text-on-surface-variant/70">
                      {sectionItems.length}{' '}
                      {sectionItems.length === 1
                        ? 'item'
                        : 'items'}
                    </span>

                    {!section.isVisible && (
                      <span className="rounded-full bg-surface-container px-2 py-0.5 text-[11px] font-medium text-on-surface-variant">
                        hidden
                      </span>
                    )}

                    {canPrepare && (
                      <span className="ml-auto flex items-center gap-0.5">
                        <MenuTrigger
                          label={`Actions for section ${section.name}`}
                        >
                          {(_, close) => (
                            <>
                              <MenuItem
                                label="Rename / describe"
                                icon="edit"
                                onClick={() => {
                                  setEditingSectionId(section.id)
                                  setEditSectionName(section.name)
                                  setEditSectionDescription(section.description)
                                  close()
                                }}
                              />

                              <MenuItem
                                label="Move up"
                                icon="arrow_upward"
                                disabled={
                                  sortedSections[0]?.id !==
                                  section.id ||
                                  reorderingSections
                                }
                                onClick={() => {
                                  void handleMoveSection(section, -1)
                                  close()
                                }}
                              />

                              <MenuItem
                                label="Move down"
                                icon="arrow_downward"
                                disabled={
                                  sortedSections.at(-1)?.id !==
                                  section.id ||
                                  reorderingSections
                                }
                                onClick={() => {
                                  void handleMoveSection(section, 1)
                                  close()
                                }}
                              />

                              <MenuItem
                                label={
                                  section.isVisible
                                    ? 'Hide section'
                                    : 'Show section'
                                }
                                icon={
                                  section.isVisible
                                    ? 'visibility_off'
                                    : 'visibility'
                                }
                                onClick={() => {
                                  void handleToggleSectionVisibility(section)
                                  close()
                                }}
                              />

                            </>
                          )}
                        </MenuTrigger>
                      </span>
                    )}
                  </div>

                  {/* Section edit form */}
                  {canPrepare &&
                    editingSectionId === section.id && (
                      <div className="mt-3 rounded-xl border border-outline-variant bg-surface-container-low/50 p-4">
                        <div className="flex flex-wrap items-end gap-3">
                          <label className="min-w-40 flex-1">
                            <span className="mb-1 block text-xs font-medium text-on-surface-variant">
                              Name
                            </span>

                            <input
                              type="text"
                              aria-label="Name"
                              value={editSectionName}
                              onChange={(e) =>
                                setEditSectionName(e.target.value)
                              }
                              className="h-9 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus:border-primary"
                            />
                          </label>

                          <label className="min-w-40 flex-1">
                            <span className="mb-1 block text-xs font-medium text-on-surface-variant">
                              Description
                            </span>

                            <input
                              type="text"
                              aria-label="Description"
                              value={editSectionDescription}
                              onChange={(e) =>
                                setEditSectionDescription(e.target.value)
                              }
                              className="h-9 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus:border-primary"
                            />
                          </label>

                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              disabled={savingSection}
                              onClick={() =>
                                void handleSaveSection(section)
                              }
                              className="h-9 rounded-lg bg-primary px-4 text-sm font-semibold text-white transition hover:bg-primary/90 disabled:opacity-45"
                            >
                              {savingSection ? 'Saving…' : 'Save'}
                            </button>

                            <button
                              type="button"
                              onClick={() => setEditingSectionId(null)}
                              className="h-9 rounded-lg px-3 text-sm font-medium text-on-surface-variant transition hover:bg-surface-container-high"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      </div>
                    )}

                  {/* Items */}
                  <div className="mt-3">
                    {sectionItems.length === 0 && !canPrepare && (
                      <p className="text-sm text-on-surface-variant/70">
                        No agenda items yet.
                      </p>
                    )}

                    <ul className="space-y-1">
                      {sectionItems.map((item, itemIndex) => (
                        <li key={item.id}>
                          {/* Item editing form */}
                          {canPrepare &&
                            editingItemId === item.id ? (
                            <div className="rounded-xl border border-outline-variant bg-surface-container-low/50 p-4">
                              <label className="block">
                                <span className="mb-1 block text-xs font-medium text-on-surface-variant">
                                  Title
                                </span>

                                <input
                                  type="text"
                                  value={editItemTitle}
                                  onChange={(e) =>
                                    setEditItemTitle(e.target.value)
                                  }
                                  className="h-9 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus:border-primary"
                                />
                              </label>

                              <label className="mt-3 block">
                                <span className="mb-1 block text-xs font-medium text-on-surface-variant">
                                  Context / notes
                                </span>

                                <textarea
                                  value={editItemNotes}
                                  onChange={(e) =>
                                    setEditItemNotes(e.target.value)
                                  }
                                  rows={3}
                                  className="w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 text-sm text-on-surface outline-none focus:border-primary"
                                />
                              </label>

                              <div className="mt-3 flex items-center gap-2">
                                <button
                                  type="button"
                                  disabled={savingItemId === item.id}
                                  onClick={() =>
                                    void handleSaveItem(item)
                                  }
                                  className="h-9 rounded-lg bg-primary px-4 text-sm font-semibold text-white transition hover:bg-primary/90 disabled:opacity-45"
                                >
                                  {savingItemId === item.id
                                    ? 'Saving…'
                                    : 'Save'}
                                </button>

                                <button
                                  type="button"
                                  onClick={() => setEditingItemId(null)}
                                  className="h-9 rounded-lg px-3 text-sm font-medium text-on-surface-variant transition hover:bg-surface-container-high"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="group/item -mx-3 rounded-lg px-3 py-2.5 transition hover:bg-surface-container-low/60">
                              <div className="flex items-start gap-3">
                                <span
                                  aria-hidden="true"
                                  className="mt-0.5 select-none text-xs tabular-nums text-on-surface-variant/50"
                                >
                                  {itemIndex + 1}
                                </span>

                                <div className="min-w-0 flex-1">
                                  <div className="flex items-baseline gap-2">
                                    <h4
                                      className={[
                                        'text-sm font-medium',
                                        item.status === 'discussed' &&
                                        isCompleted
                                          ? 'text-on-surface-variant'
                                          : 'text-on-surface',
                                      ].join(' ')}
                                    >
                                      {item.title}
                                    </h4>

                                    {item.status === 'discussed' && (
                                      <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-on-surface-variant">
                                        <span aria-hidden="true" className="material-symbols-outlined text-[13px]">
                                          check_circle
                                        </span>
                                        Discussed
                                      </span>
                                    )}
                                  </div>

                                  {item.notes && (
                                    <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-on-surface-variant">
                                      {item.notes}
                                    </p>
                                  )}

                                  {item.workItemIds.length > 0 && (
                                    <div className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-primary">
                                      <span aria-hidden="true" className="material-symbols-outlined text-[14px]">
                                        task_alt
                                      </span>
                                      {item.workItemIds.length}{' '}
                                      linked work{' '}
                                      {item.workItemIds.length === 1
                                        ? 'item'
                                        : 'items'}
                                    </div>
                                  )}
                                </div>

                                {/* Live: keep the discussed toggle available */}
                                {isLive && canManageLifecycle && (
                                  <button
                                    type="button"
                                    disabled={
                                      updatingItemId === item.id
                                    }
                                    onClick={() =>
                                      void handleToggleItemStatus(item)
                                    }
                                    aria-label={
                                      item.status === 'discussed'
                                        ? `Mark ${item.title} as open`
                                        : `Mark ${item.title} as discussed`
                                    }
                                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-on-surface-variant transition hover:bg-surface-container-high disabled:opacity-45"
                                  >
                                    <span aria-hidden="true" className="material-symbols-outlined text-[18px]">
                                      {item.status === 'discussed'
                                        ? 'check_circle'
                                        : 'radio_button_unchecked'}
                                    </span>
                                  </button>
                                )}

                                {/* Upcoming: secondary actions on hover/focus */}
                                {canPrepare && (
                                  <span className="shrink-0 opacity-0 transition group-hover/item:opacity-100 focus-within:opacity-100">
                                    <MenuTrigger
                                      label={`Actions for agenda item ${item.title}`}
                                    >
                                      {(_, close) => (
                                        <>
                                          <MenuItem
                                            label="Edit"
                                            icon="edit"
                                            onClick={() => {
                                              startEditingItem(item)
                                              close()
                                            }}
                                          />

                                          <MenuItem
                                            label="Create work item"
                                            icon="add_task"
                                            onClick={() => {
                                              setWorkItemSource(item)
                                              close()
                                            }}
                                          />

                                          <span role="none" className="my-1 border-t border-outline-variant" />

                                          <MenuItem
                                            label="Delete"
                                            icon="delete"
                                            danger
                                            onClick={() => {
                                              void handleDeleteItem(item)
                                              close()
                                            }}
                                          />
                                        </>
                                      )}
                                    </MenuTrigger>
                                  </span>
                                )}
                              </div>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>

                    {/* Inline quick-add: the inline form opens for any
                        section (empty or not); the trigger label and
                        emphasis adapt to the empty case. */}
                    {canPrepare &&
                      (creatingSectionId === section.id ? (
                        <form
                          data-quick-add-form={section.id}
                          onSubmit={(e) => {
                            e.preventDefault()
                            void handleCreateItemInSection(section)
                          }}
                          className="mt-2 flex items-center gap-2"
                        >
                          <input
                            ref={quickAddInputRef}
                            type="text"
                            value={
                              sectionItemTitle[section.id] ?? ''
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
                            onKeyDown={(e) => {
                              if (e.key === 'Escape') {
                                e.preventDefault()
                                setCreatingSectionId(null)
                                setSectionItemTitle((current) => ({
                                  ...current,
                                  [section.id]: '',
                                }))
                              }
                            }}
                            placeholder="Agenda item title"
                            aria-label={`Add item to ${section.name}`}
                            className="h-9 min-w-0 flex-1 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
                          />

                          <button
                            type="submit"
                            disabled={
                              !(
                                sectionItemTitle[section.id] ??
                                ''
                              ).trim()
                            }
                            className="inline-flex h-9 items-center gap-1 rounded-lg bg-primary px-3 text-sm font-semibold text-white transition hover:bg-primary/90 disabled:opacity-45"
                          >
                            Add
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setCreatingSectionId(null)
                              setSectionItemTitle((current) => ({
                                ...current,
                                [section.id]: '',
                              }))
                            }}
                            className="inline-flex h-9 items-center rounded-lg px-3 text-sm font-medium text-on-surface-variant transition hover:bg-surface-container-high"
                          >
                            Cancel
                          </button>
                        </form>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setCreatingSectionId(section.id)
                            setSectionItemTitle((current) => ({
                              ...current,
                              [section.id]: '',
                            }))
                          }}
                          className={
                            sectionItems.length === 0
                              ? 'mt-2 inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary outline-none transition hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-primary/40'
                              : 'mt-2 inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-on-surface-variant outline-none transition hover:bg-surface-container-low hover:text-primary focus-visible:ring-2 focus-visible:ring-primary/40'
                          }
                        >
                          <span aria-hidden="true" className="material-symbols-outlined text-[17px]">
                            add
                          </span>
                          {sectionItems.length === 0
                            ? 'Add first item'
                            : 'Add item'}
                        </button>
                      ))}

                  </div>
                </section>
              )
            })}
          </div>
        )}
      </div>

      <CreateMeetingWorkItemDialog
        open={workItemSource != null}
        researchGroupId={meeting.researchGroupId}
        meetingItem={workItemSource}
        onClose={() => setWorkItemSource(null)}
        onCreated={handleWorkItemCreated}
      />
    </div>
  )
}
