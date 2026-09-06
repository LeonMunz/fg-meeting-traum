import {
  useCallback,
  useEffect,
  lazy,
  useMemo,
  Suspense,
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
  createMeetingNote,
  createMeetingSection,
  deleteMeeting,
  deleteMeetingNote,
  endMeeting,
  focusMeetingItem,
  getMeeting,
  listMeetingItems,
  listMeetingParticipants,
  listMeetingSections,
  markMeetingItemDone,
  markMeetingItemFollowUp,
  reorderMeetingSections,
  reopenMeeting,
  removeMeetingParticipant,
  startMeeting,
  updateMeetingItem,
  updateMeetingNote,
  updateMeetingSection,
} from '../../api/meetings'
import {
  getProject,
  listResearchGroupMembers,
  getProjectWorkItemConfiguration,
  listProjectMemberships,
} from '../../api/projects'
import {
  getWorkItem,
  listProjectWorkItems,
  updateWorkItem,
} from '../../api/work-items'
import { useResearchGroup } from '../research-group/useResearchGroup'
import { useSession } from '../../api/useSession'
import { CreateMeetingWorkItemDialog } from './CreateMeetingWorkItemDialog'
import { agendaStatusMeta } from './agendaStatus'
import { CompletedMeetingRecap } from './CompletedMeetingRecap'
import {
  completedOutcomeCountParts,
  formatMeetingDate as sharedFormatMeetingDate,
  formatMeetingDateCompact,
  formatMeetingDurationCompact,
  formatNoteTime as sharedFormatNoteTime,
  getPersonName as sharedGetPersonName,
  itemResultingWork,
  meetingDurationMinutes,
} from './shared'

// The Work Item Inspector is the same shared drawer the Project
// page uses; keep it out of the initial Meeting bundle.
const WorkItemDrawer = lazy(() =>
  import('../projects/WorkItemDrawer').then(
    (module) => ({
      default: module.WorkItemDrawer,
    }),
  ),
)

import type {
  ApiMeeting,
  ApiMeetingItem,
  ApiMeetingNote,
  ApiMeetingParticipant,
  ApiMeetingSection,
  ApiResearchGroupMember,
  ApiLinkedWorkItem,
  ApiProject,
  ApiProjectMembership,
  ApiProjectWorkItemConfiguration,
  ApiUpdateWorkItemInput,
  ApiWorkItem,
  ApiWorkItemType,
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
  return sharedFormatMeetingDate(value)
}

function formatNoteTime(value: string) {
  return sharedFormatNoteTime(value)
}

function getPersonName(person: {
  firstName: string
  lastName: string
  username: string
}) {
  return sharedGetPersonName(person)
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
  // Only Upcoming and Completed keep the classic all-items layout;
  // a Live Meeting renders its own Agenda | Current Item shell.
  if (status === 'upcoming') {
    return 'Agenda items, grouped by section.'
  }

  return 'Meeting record, grouped by section.'
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

  // Live Meeting: the agenda item the user is currently VIEWING in the
  // detail pane. Purely local UI navigation (never persisted). "Current"
  // (persisted on the Meeting as currentMeetingItemId) is a distinct,
  // domain concept; selecting an item must not change it.
  const [selectedItemId, setSelectedItemId] =
    useState<number | null>(null)

  const [updatingMeeting, setUpdatingMeeting] =
    useState(false)

  const [deleteDialogOpen, setDeleteDialogOpen] =
    useState(false)
  const [deletingMeeting, setDeletingMeeting] =
    useState(false)

  const [
    workItemSource,
    setWorkItemSource,
  ] = useState<ApiMeetingItem | null>(null)

  // ── Persistent Meeting Notes ────────────────────────────────
  // Notes come from the canonical API; this block only tracks
  // transient UI concerns (which composer is open, drafts, in-flight
  // mutation IDs, the in-flight delete confirmation).
  const [
    noteComposerItemId,
    setNoteComposerItemId,
  ] = useState<number | null>(null)
  const [noteDraftContent, setNoteDraftContent] =
    useState('')
  const [
    creatingNoteItemId,
    setCreatingNoteItemId,
  ] = useState<number | null>(null)
  const [
    editingNoteId,
    setEditingNoteId,
  ] = useState<number | null>(null)
  const [
    noteEditContent,
    setNoteEditContent,
  ] = useState('')
  const [
    savingNoteId,
    setSavingNoteId,
  ] = useState<number | null>(null)
  const [
    deletingNoteId,
    setDeletingNoteId,
  ] = useState<number | null>(null)
  const [
    pendingDeleteNote,
    setPendingDeleteNote,
  ] = useState<ApiMeetingNote | null>(null)
  // The exact persisted MeetingNote the Work Item dialog is anchored
  // to (null for the plain MeetingItem flow).
  const [
    noteWorkItemNote,
    setNoteWorkItemNote,
  ] = useState<ApiMeetingNote | null>(null)
  const [
    justLinkedNoteId,
    setJustLinkedNoteId,
  ] = useState<number | null>(null)

  // ── Linked work item inspector (shared WorkItemDrawer) ─────
  const [
    inspectorWorkItemId,
    setInspectorWorkItemId,
  ] = useState<number | null>(null)
  const [
    inspectorItem,
    setInspectorItem,
  ] = useState<ApiWorkItem | null>(null)
  const [
    inspectorProject,
    setInspectorProject,
  ] = useState<ApiProject | null>(null)
  const [
    inspectorConfiguration,
    setInspectorConfiguration,
  ] = useState<
    ApiProjectWorkItemConfiguration | null
  >(null)
  const [
    inspectorAssignees,
    setInspectorAssignees,
  ] = useState<
    Array<{
      id: string
      name: string
      initials: string
    }>
  >([])
  const [
    inspectorParentItems,
    setInspectorParentItems,
  ] = useState<
    Array<{
      id: string
      title: string
      type: ApiWorkItemType
    }>
  >([])
  const [
    inspectorLoading,
    setInspectorLoading,
  ] = useState(false)
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
      // A fresh load/re-entry resets local selection to the Meeting's
      // actual current item (selection is never persisted).
      setSelectedItemId(nextMeeting.currentMeetingItemId)
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

  // Refresh only the agenda item collection after a server-side
  // transition that mutates MeetingItem rows (Start / Reopen /
  // Focus / Done / Follow-up all change one or more items). Keeps
  // the local items in sync without a full page reload or scroll
  // reset.
  const refreshItems = useCallback(async ():
    Promise<ApiMeetingItem[] | null> => {
    if (meetingId == null) {
      return null
    }
    try {
      const next = await listMeetingItems(meetingId)
      setItems(next)
      return next
    } catch {
      // The action that triggered the refresh succeeded on the
      // server; the next full load recovers the canonical list.
      return null
    }
  }, [meetingId])

  // Re-read the Meeting row after a server-side transition that
  // may have moved the persisted current pointer
  // (currentMeetingItemId). The Live item action endpoints
  // return only the updated MeetingItem, so the pointer is
  // obtainable here only from a fresh Meeting read. Awaited after
  // refreshItems (never racing it), so the final state always
  // reflects the post-action server truth.
  const refreshMeeting = useCallback(async ():
    Promise<ApiMeeting | null> => {
    if (meetingId == null) {
      return null
    }
    try {
      const next = await getMeeting(meetingId)
      setMeeting(next)
      return next
    } catch {
      // The action that triggered the refresh succeeded on the
      // server; the next full load recovers the canonical row.
      return null
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
      // Collapse the inline composer after a successful create so it
      // is not left open; the newly added item (not_discussed,
      // appended, not replacing the current item) is shown in the rail.
      setCreatingSectionId(null)
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
    setEditItemNotes(item.contextNotes)
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

  // ── Live Meeting: local selection (decoupled from "current") ──
  // Selecting an agenda item is pure UI navigation: it only changes
  // which item the detail pane shows. It never touches the persisted
  // current pointer or any item outcome.
  const handleSelectLiveItem = (item: ApiMeetingItem) => {
    setSelectedItemId(item.id)
  }

  // "Return to current": re-point local selection at the Meeting's
  // actual current item. No domain mutation.
  const handleReturnToCurrent = () => {
    if (meeting?.currentMeetingItemId != null) {
      setSelectedItemId(meeting.currentMeetingItemId)
    }
  }

  // After an action that may move the persisted current pointer, keep
  // local selection consistent with the user's intent:
  //  - if they were following the old current item, follow the new one;
  //  - if they had explicitly navigated elsewhere, preserve that choice
  //    (unless the selected item no longer exists).
  const reconcileLiveSelection = (
    wasFollowing: boolean,
    newCurrentId: number | null,
    currentItems: ApiMeetingItem[] | null,
  ) => {
    setSelectedItemId((prev) => {
      const resolvedCurrent =
        newCurrentId ?? meeting?.currentMeetingItemId ?? null
      if (wasFollowing) {
        return resolvedCurrent
      }
      if (currentItems == null) {
        // The post-action refresh failed; keep the explicit selection.
        return prev
      }
      const stillExists =
        prev != null && currentItems.some((i) => i.id === prev)
      if (prev == null || !stillExists) {
        return resolvedCurrent
      }
      return prev
    })
  }

  const handleFocusItem = async (item: ApiMeetingItem) => {
    if (updatingItemId != null) return
    const wasFollowing =
      meeting != null &&
      selectedItemId === meeting.currentMeetingItemId
    setUpdatingItemId(item.id)
    setActionError(null)
    try {
      await focusMeetingItem(item.id)
      // Focus moves the persisted current pointer; the action
      // response carries only the item, so re-read the Meeting for
      // the fresh currentMeetingItemId and refresh the collection.
      const nextItems = await refreshItems()
      const nextMeeting = await refreshMeeting()
      reconcileLiveSelection(
        wasFollowing,
        nextMeeting?.currentMeetingItemId ?? null,
        nextItems,
      )
    } catch (error) {
      setActionError(
        getErrorMessage(error, 'Agenda item could not be focused.'),
      )
    } finally {
      setUpdatingItemId(null)
    }
  }

  const handleDoneItem = async (item: ApiMeetingItem) => {
    if (updatingItemId != null) return
    const wasFollowing =
      meeting != null &&
      selectedItemId === meeting.currentMeetingItemId
    setUpdatingItemId(item.id)
    setActionError(null)
    try {
      await markMeetingItemDone(item.id)
      // Done mutates the item's outcome and, when the item was
      // current, advances the persisted current pointer; re-read
      // the Meeting and refresh the collection.
      const nextItems = await refreshItems()
      const nextMeeting = await refreshMeeting()
      reconcileLiveSelection(
        wasFollowing,
        nextMeeting?.currentMeetingItemId ?? null,
        nextItems,
      )
    } catch (error) {
      setActionError(
        getErrorMessage(error, 'Agenda item could not be marked done.'),
      )
    } finally {
      setUpdatingItemId(null)
    }
  }

  const handleFollowUpItem = async (item: ApiMeetingItem) => {
    if (updatingItemId != null) return
    const wasFollowing =
      meeting != null &&
      selectedItemId === meeting.currentMeetingItemId
    setUpdatingItemId(item.id)
    setActionError(null)
    try {
      await markMeetingItemFollowUp(item.id)
      // Follow-up mutates the item's outcome and, when the item
      // was current, advances the persisted current pointer;
      // re-read the Meeting and refresh the collection.
      const nextItems = await refreshItems()
      const nextMeeting = await refreshMeeting()
      reconcileLiveSelection(
        wasFollowing,
        nextMeeting?.currentMeetingItemId ?? null,
        nextItems,
      )
    } catch (error) {
      setActionError(
        getErrorMessage(
          error,
          'Agenda item could not be marked as follow-up.',
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
      // Start may select the first agenda item as the current
      // item; refresh the collection so the UI shows it immediately.
      // A fresh Live session follows the (new) current item.
      const nextItems = await refreshItems()
      reconcileLiveSelection(
        true,
        updated.currentMeetingItemId,
        nextItems,
      )
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
      // Reopen may select the first remaining not_discussed item
      // as the current item; refresh the collection. A re-entered
      // Live session follows the (new) current item.
      const nextItems = await refreshItems()
      reconcileLiveSelection(
        true,
        updated.currentMeetingItemId,
        nextItems,
      )
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

  const handleDeleteMeeting = async () => {
    if (meeting == null || deletingMeeting) {
      return
    }

    setDeletingMeeting(true)
    setActionError(null)

    try {
      await deleteMeeting(meeting.id)
      setDeleteDialogOpen(false)
      navigate('/meetings')
    } catch (error) {
      setActionError(getErrorMessage(error, 'Meeting could not be deleted.'))
    } finally {
      setDeletingMeeting(false)
    }
  }

  const updateItemNotes = (
    itemId: number,
    notes: ApiMeetingNote[],
  ) => {
    setItems((current) =>
      current.map((candidate) =>
        candidate.id === itemId
          ? { ...candidate, notes }
          : candidate,
      ),
    )
  }

  const openNoteComposer = (item: ApiMeetingItem) => {
    // Only one composer open at a time; an unsaved draft in another
    // composer is simply discarded (never submitted).
    setNoteComposerItemId(item.id)
    setNoteDraftContent('')
  }

  const submitNoteComposer = async (
    item: ApiMeetingItem,
  ) => {
    const trimmed = noteDraftContent.trim()
    if (!trimmed || creatingNoteItemId != null) {
      return
    }

    setCreatingNoteItemId(item.id)
    setActionError(null)

    try {
      const created = await createMeetingNote(
        item.id,
        { content: trimmed },
      )
      updateItemNotes(
        item.id,
        [...(item.notes ?? []), created],
      )
      setNoteComposerItemId(null)
      setNoteDraftContent('')
    } catch (error) {
      // Preserve the draft so the user can retry without re-typing.
      setActionError(
        getErrorMessage(
          error,
          'Note could not be added.',
        ),
      )
    } finally {
      setCreatingNoteItemId(null)
    }
  }

  const cancelNoteComposer = () => {
    setNoteComposerItemId(null)
    setNoteDraftContent('')
  }

  const startEditingNote = (
    note: ApiMeetingNote,
  ) => {
    setEditingNoteId(note.id)
    setNoteEditContent(note.content)
  }

  const cancelEditingNote = () => {
    setEditingNoteId(null)
    setNoteEditContent('')
  }

  const saveNoteEdit = async (
    item: ApiMeetingItem,
    note: ApiMeetingNote,
  ) => {
    const trimmed = noteEditContent.trim()
    if (!trimmed || savingNoteId != null) {
      return
    }

    setSavingNoteId(note.id)
    setActionError(null)

    try {
      const updated = await updateMeetingNote(
        note.id,
        { content: trimmed },
      )
      updateItemNotes(
        item.id,
        (item.notes ?? []).map((candidate) =>
          candidate.id === updated.id ? updated : candidate,
        ),
      )
      setEditingNoteId(null)
      setNoteEditContent('')
    } catch (error) {
      // Keep the edited draft visible so it is not lost.
      setActionError(
        getErrorMessage(
          error,
          'Note could not be updated.',
        ),
      )
    } finally {
      setSavingNoteId(null)
    }
  }

  const confirmDeleteNote = () => {
    if (pendingDeleteNote == null || deletingNoteId != null) {
      return
    }

    const note = pendingDeleteNote
    setPendingDeleteNote(null)

    setDeletingNoteId(note.id)
    setActionError(null)

    void (async () => {
      try {
        await deleteMeetingNote(note.id)
        setItems((current) =>
          current.map((candidate) =>
            candidate.id === note.meetingItemId
              ? {
                  ...candidate,
                  notes: (candidate.notes ?? []).filter(
                    (n) => n.id !== note.id,
                  ),
                }
              : candidate,
          ),
        )
        if (editingNoteId === note.id) {
          setEditingNoteId(null)
          setNoteEditContent('')
        }
      } catch (error) {
        setActionError(
          getErrorMessage(
            error,
            'Note could not be deleted.',
          ),
        )
      } finally {
        setDeletingNoteId(null)
      }
    })()
  }

  // Opens the Work Item dialog anchored to the exact persisted
  // Note. React batches these updates, so the inline composer (if
  // open) closes in the same commit that the dialog opens — the two
  // surfaces never coexist.
  const openNoteWorkItem = (
    item: ApiMeetingItem,
    note: ApiMeetingNote,
  ) => {
    setNoteComposerItemId(null)
    setNoteDraftContent('')
    setNoteWorkItemNote(note)
    setWorkItemSource(item)
  }

  // "Create work item" inside the inline composer: persist the Note
  // FIRST. Only a successfully persisted Note becomes the Work Item
  // source; on failure the draft stays in the composer with a local
  // error and no dialog opens.
  const submitNoteThenCreateWorkItem = async (
    item: ApiMeetingItem,
  ) => {
    const trimmed = noteDraftContent.trim()
    if (!trimmed || creatingNoteItemId != null) {
      return
    }

    setCreatingNoteItemId(item.id)
    setActionError(null)

    try {
      const created = await createMeetingNote(
        item.id,
        { content: trimmed },
      )

      updateItemNotes(
        item.id,
        [...(item.notes ?? []), created],
      )
      openNoteWorkItem(item, created)
    } catch (error) {
      // Preserve the draft so the user can retry without re-typing.
      setActionError(
        getErrorMessage(
          error,
          'Note could not be added.',
        ),
      )
    } finally {
      setCreatingNoteItemId(null)
    }
  }

  const handleNoteWorkItemCreated = (
    workItem: ApiWorkItem,
    linkedWorkItem: ApiLinkedWorkItem | null,
  ) => {
    const sourceItem = workItemSource
    const sourceNote = noteWorkItemNote
    setWorkItemSource(null)
    setNoteWorkItemNote(null)

    if (sourceItem == null) {
      return
    }

    setItems((current) =>
      current.map((item) =>
        item.id === sourceItem.id
          ? {
              ...item,
              workItemIds: [
                ...new Set([
                  ...item.workItemIds,
                  workItem.id,
                ]),
              ],
              notes: (item.notes ?? []).map(
                (note) =>
                  note.id === sourceNote?.id &&
                  linkedWorkItem != null
                    ? {
                        ...note,
                        linkedWorkItem,
                      }
                    : note,
              ),
            }
          : item,
      ),
    )

    if (sourceNote != null) {
      setJustLinkedNoteId(sourceNote.id)
    }
  }

  const closeWorkItemDialog = () => {
    setNoteWorkItemNote(null)
    setWorkItemSource(null)
  }

  // The short "Work item created" state fades once the linked work
  // representation is visible.
  useEffect(() => {
    if (justLinkedNoteId == null) {
      return
    }

    const timeout = setTimeout(
      () => setJustLinkedNoteId(null),
      3000,
    )

    return () => clearTimeout(timeout)
  }, [justLinkedNoteId])

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

  // ── Linked work item: open the shared Inspector in place ─────
  // The Inspector opens over the Meeting without navigating away,
  // so the Meeting context (scroll position, open composer state)
  // is preserved and closing returns to the same view.
  const openLinkedWorkInspector = (
    linked: ApiLinkedWorkItem,
  ) => {
    if (inspectorLoading) {
      return
    }

    setInspectorWorkItemId(linked.id)
    setInspectorItem(null)
    setInspectorProject(null)
    setInspectorConfiguration(null)
    setInspectorAssignees([])
    setInspectorParentItems([])
    setInspectorLoading(true)
    setActionError(null)

    void (async () => {
      try {
        const [
          workItem,
          project,
          configuration,
          memberships,
          projectWorkItems,
        ] = await Promise.all([
          getWorkItem(linked.id),
          getProject(linked.projectId),
          getProjectWorkItemConfiguration(
            linked.projectId,
          ),
          listProjectMemberships(
            linked.projectId,
          ),
          listProjectWorkItems(
            linked.projectId,
          ),
        ])

        setInspectorItem(workItem)
        setInspectorProject(project)
        setInspectorConfiguration(
          configuration,
        )
        setInspectorAssignees(
          memberships
            .filter(
              (membership) =>
                membership.role ===
                  'owner' ||
                membership.role ===
                  'member',
            )
            .map((membership) => {
              const fullName =
                [
                  membership
                    .user.firstName,
                  membership
                    .user.lastName,
                ]
                  .filter(Boolean)
                  .join(' ')
                  .trim()

              return {
                id: String(
                  membership.user.id,
                ),
                name:
                  fullName ||
                  membership
                    .user.username,
                initials:
                  getInitials(
                    membership.user,
                  ),
              }
            }),
        )
        setInspectorParentItems(
          projectWorkItems.map(
            (workItem) => ({
              id: String(
                workItem.id,
              ),
              title:
                workItem.title,
              type:
                workItem.type ??
                'task',
            }),
          ),
        )
      } catch (error) {
        setActionError(
          getErrorMessage(
            error,
            'Work item could not be opened.',
          ),
        )
        closeLinkedWorkInspector()
      } finally {
        setInspectorLoading(false)
      }
    })()
  }

  const closeLinkedWorkInspector = () => {
    setInspectorWorkItemId(null)
    setInspectorItem(null)
    setInspectorProject(null)
    setInspectorConfiguration(null)
    setInspectorAssignees([])
    setInspectorParentItems([])
  }

  // ── Completed recap: hydrate canonical display data for every
  // Work Item originating from this Meeting (direct
  // MeetingItem -> Work Item links + Note-linked primary Work
  // Items). The Meeting items API only carries Work Item IDs for
  // direct links, so the existing per-Work Item API resolves the
  // current title / Project / status / assignees. Only runs for
  // Completed Meetings; one in-flight guard per id set.
  const [
    recapWorkById,
    setRecapWorkById,
  ] = useState<Map<number, ApiLinkedWorkItem>>(
    () => new Map(),
  )

  useEffect(() => {
    if (meeting?.status !== 'completed') {
      setRecapWorkById(new Map())
      return
    }

    const ids = new Map<number, ApiLinkedWorkItem>()

    // Note-linked Work already carries a full display payload.
    for (const item of items) {
      for (const note of item.notes ?? []) {
        if (note.linkedWorkItem != null) {
          ids.set(
            note.linkedWorkItem.id,
            note.linkedWorkItem,
          )
        }
      }
    }

    // Direct item links only carry IDs; hydrate the missing
    // ones through the existing Work Item API.
    const missing: number[] = []
    for (const item of items) {
      for (const id of item.workItemIds) {
        if (!ids.has(id)) {
          missing.push(id)
        }
      }
    }

    const uniqueMissing = [...new Set(missing)]
    if (uniqueMissing.length === 0) {
      setRecapWorkById(ids)
      return
    }

    let cancelled = false

    void (async () => {
      // 1. Resolve every Work Item (one request per unique id).
      const workItems: ApiWorkItem[] = []
      for (const id of uniqueMissing) {
        try {
          workItems.push(await getWorkItem(id))
        } catch {
          // A Work Item that can no longer be read (deleted or
          // access revoked) simply does not render a row; never
          // fabricate display data.
        }
        if (cancelled) {
          return
        }
      }

      if (cancelled) {
        return
      }

      if (workItems.length === 0) {
        if (!cancelled) {
          setRecapWorkById(new Map(ids))
        }
        return
      }

      // 2. Resolve Project data once per distinct Project
      // (project name, assignee names, canonical Work Item
      // configuration). The configuration is the canonical
      // source for the status name (statusDefinitionId ->
      // definition name), never the legacy fixed string.
      const projectIds = [
        ...new Set(workItems.map((item) => item.projectId)),
      ]
      const projectData = new Map<
        number,
        {
          project: ApiProject | null
          memberships: ApiProjectMembership[]
          configuration: ApiProjectWorkItemConfiguration | null
        }
      >()

      await Promise.all(
        projectIds.map(async (projectId) => {
          const [project, memberships, configuration] =
            await Promise.all([
              getProject(projectId).catch(() => null),
              listProjectMemberships(projectId).catch(
                () => [],
              ),
              getProjectWorkItemConfiguration(
                projectId,
              ).catch(() => null),
            ])

          projectData.set(projectId, {
            project,
            memberships,
            configuration,
          })
        }),
      )

      if (cancelled) {
        return
      }

      // 3. Assemble the display rows.
      for (const workItem of workItems) {
        const data =
          projectData.get(workItem.projectId)
        if (data == null) {
          continue
        }

        const assigneeNames = data.memberships
          .filter((membership) =>
            workItem.assigneeIds.includes(
              membership.user.id,
            ),
          )
          .map((membership) => {
            const fullName = [
              membership.user.firstName,
              membership.user.lastName,
            ]
              .filter(Boolean)
              .join(' ')
              .trim()

            return fullName || membership.user.username
          })

        const statusDefinition = data.configuration?.statuses.find(
          (definition) =>
            definition.id === workItem.statusDefinitionId,
        )

        ids.set(workItem.id, {
          id: workItem.id,
          title: workItem.title,
          projectId: workItem.projectId,
          projectName: data.project?.name ?? '',
          statusName: statusDefinition?.name ?? '',
          assigneeNames,
        })
      }

      if (!cancelled) {
        setRecapWorkById(new Map(ids))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [meeting?.status, items])

  const handleInspectorPatch =
    async (
      workItemId: number,
      patch: ApiUpdateWorkItemInput,
    ) => {
      const updated =
        await updateWorkItem(
          workItemId,
          patch,
        )

      setInspectorItem(updated)
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
  // A persisted, unlinked Note may become a Work Item while the
  // Meeting is Live, and still after it is Completed — as long as
  // the current user can write the Meeting's scope (any member for
  // a group Meeting; owner/member for a project Meeting). The
  // action never edits the Note itself.
  const canCreateWorkFromNote =
    !isUpcoming &&
    (meeting.scope === 'group'
      ? true
      : projectRole === 'owner' ||
        projectRole === 'member')

  // A Live Meeting's current item is persisted on the Meeting
  // (currentMeetingItemId); "current" is not an item outcome.
  const liveCurrentItem = isLive
    ? sortedItems.find(
        (item) =>
          item.id === meeting.currentMeetingItemId,
      ) ?? null
    : null

  // Live Meeting: the item the user is currently VIEWING (local,
  // decoupled from "current"). Falls back to the current item when
  // the explicit selection is unset or the item no longer exists.
  const liveSelectedItem = isLive
    ? sortedItems.find(
        (item) => item.id === selectedItemId,
      ) ??
      liveCurrentItem ??
      null
    : null

  const liveSelectedSection =
    liveSelectedItem != null
      ? sections.find(
          (section) =>
            section.id ===
            liveSelectedItem!.meetingSectionId,
        ) ?? null
      : null

  const liveSelectedPosition =
    liveSelectedItem != null &&
    liveSelectedSection != null
      ? (itemsBySection.get(liveSelectedSection.id) ?? []).findIndex(
          (item) => item.id === liveSelectedItem!.id,
        ) + 1
      : 0

  // True while the detail pane shows the Meeting's actual current
  // item (i.e., the user is "on" current). Lifecycle controls
  // (Done / Follow-up) only act on the current item, so they render
  // only in this state and never on an arbitrary selected item.
  const liveSelectionIsCurrent =
    liveSelectedItem != null &&
    liveCurrentItem != null &&
    liveSelectedItem.id === liveCurrentItem.id

  const liveOpenItemCount = sortedItems.filter(
    (item) => item.outcome === 'not_discussed',
  ).length

  // Completed recap header fragment: calm historical identity
  // (title + small Completed indicator, date/time, Meeting type,
  // participant count, reliable duration). Rendered inside the
  // shared <header> so the back nav + lifecycle controls stay
  // identical across all Meeting states.
  // Duration label for the Completed header: only when both
  // timestamps exist and the computed duration is reliable.
  const completedDurationLabel = (() => {
    if (!isCompleted) {
      return null
    }

    return formatMeetingDurationCompact(
      meetingDurationMinutes(
        meeting.startedAt,
        meeting.endedAt,
      ),
    )
  })()

  // Non-zero outcome counts (Resulting work union + follow-ups),
  // rendered once, directly beneath the header metadata.
  const completedOutcomeCounts = (() => {
    if (!isCompleted) {
      return []
    }

    const workIds = new Set<number>()

    for (const item of sortedItems) {
      for (const linked of itemResultingWork(
        item,
        recapWorkById,
      )) {
        workIds.add(linked.id)
      }
    }

    return completedOutcomeCountParts({
      workItems: workIds.size,
      followUps: sortedItems.filter(
        (item) => item.outcome === 'follow_up',
      ).length,
    })
  })()


  const completedRecapHeader = isCompleted && (
    <>
      <h1 className="min-w-0 break-words text-2xl font-semibold tracking-tight text-on-surface">
        {meeting.title}
      </h1>

      <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-on-surface-variant">
        <span aria-hidden="true" className="material-symbols-outlined text-[14px]">
          check_circle
        </span>
        Completed
      </span>
    </>
  )

  const completedRecapMetaLine = isCompleted && (
    <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-on-surface-variant">
      <span>{formatMeetingDateCompact(meeting.scheduledAt)}</span>
      {completedDurationLabel != null && (
        <>
          <span aria-hidden="true">·</span>
          <span>{completedDurationLabel}</span>
        </>
      )}
      <span aria-hidden="true">·</span>
      <span>
        {meeting.scope === 'project'
          ? 'Project Meeting'
          : 'Research Group Meeting'}
      </span>
      <span aria-hidden="true">·</span>
      <span>
        {participants.length}{' '}
        {participants.length === 1
          ? 'participant'
          : 'participants'}
      </span>
    </p>
  )


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
          {(completedRecapHeader || null) ?? (
            <h1 className="truncate text-3xl font-semibold tracking-tight text-on-surface">
              {meeting.title}
            </h1>
          )}

          {(completedRecapMetaLine || null) ?? (
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
          )}

          {isCompleted &&
            completedOutcomeCounts.length > 0 && (
              <p className="mt-1.5 text-[13px] text-on-surface-variant">
                {completedOutcomeCounts.join(' · ')}
              </p>
            )}
        </div>

        <div className="flex shrink-0 items-center gap-2.5">
          {isLive && (
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-primary" role="status">
              <span aria-hidden="true" className="material-symbols-outlined animate-pulse text-[18px]">
                fiber_manual_record
              </span>
              Live
            </span>
          )}

          {isCompleted && canManageLifecycle && (
            <button
              type="button"
              disabled={updatingMeeting}
              onClick={() => void handleReopenMeeting()}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-on-surface-variant outline-none transition hover:bg-surface-container-low/60 hover:text-on-surface focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-[16px]">
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
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm font-medium text-on-surface outline-none transition hover:border-error/40 hover:bg-error-container/30 hover:text-error focus-visible:ring-2 focus-visible:ring-error/40 disabled:opacity-60"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-[18px]">
                stop
              </span>
              End meeting
            </button>
          )}

          {canManageLifecycle && (
            <MenuTrigger label="Meeting actions">
              {(_, close) => (
                <>
                  <MenuItem
                    label="Delete meeting"
                    icon="delete"
                    danger
                    onClick={() => {
                      setDeleteDialogOpen(true)
                      close()
                    }}
                  />
                </>
              )}
            </MenuTrigger>
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

      {/* Participants — compact context surface. Hidden while Live
          and Completed because the header metadata line already
          shows the count. */}
      {!isLive && !isCompleted && (
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
      )}

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

      {/* Content heading — the Live shell and the Completed
          recap carry their own structure and do not repeat a
          content heading. */}
      {!isLive && !isCompleted && (
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
      )}

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

      {/* Live Meeting: Agenda rail | Current Item workspace */}
      {isLive ? (
        <div
          data-live-shell
          className="mt-6 flex flex-col gap-6 lg:flex-row lg:items-start"
        >
          {/* LEFT: Agenda rail — narrow, visually secondary, always readable. */}
          <nav
            aria-label="Agenda"
            className="w-full shrink-0 lg:sticky lg:top-8 lg:w-72 lg:self-start lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:pr-1"
          >
            <h2 className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
              Agenda
            </h2>

            {sortedSections.length === 0 ? (
              <p className="mt-3 text-sm text-on-surface-variant">
                No agenda items yet.
              </p>
            ) : (
              <div className="mt-2 space-y-4">
                {sortedSections.map((section) => {
                  const sectionItems =
                    itemsBySection.get(section.id) ?? []

                  return (
                    <div
                      key={section.id}
                      className={[
                        '',
                        !section.isVisible
                          ? 'opacity-50'
                          : '',
                      ].join(' ')}
                    >
                      <h3 className="px-2.5 pb-1 pt-0.5 text-[13px] font-semibold tracking-tight text-on-surface">
                        {section.name}
                      </h3>

                      {sectionItems.length === 0 ? (
                        <p className="mt-1 px-2.5 text-xs text-on-surface-variant/70">
                          No items
                        </p>
                      ) : (
                        <ul className="mt-1 space-y-0.5">
                          {sectionItems.map((item) => {
                            const statusMeta =
                              agendaStatusMeta(item.outcome)

                            const isCurrent =
                              item.id ===
                              meeting.currentMeetingItemId
                            const isSelected =
                              item.id === selectedItemId

                            const rowClass = [
                              'flex w-full items-start gap-2 rounded-md py-1.5 pl-2.5 pr-2 text-left outline-none transition',
                              isCurrent
                                ? 'border-l-2 border-primary bg-primary/5'
                                : isSelected
                                  ? 'border-l-2 border-primary/50 bg-primary/10'
                                  : 'border-l-2 border-transparent hover:bg-surface-container-low/70',
                            ].join(' ')

                            return (
                              <li key={item.id}>
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleSelectLiveItem(item)
                                  }
                                  aria-pressed={isSelected}
                                  aria-label={
                                    isCurrent
                                      ? `View current item ${item.title}`
                                      : `View item ${item.title}`
                                  }
                                  className={`${rowClass} flex-1 focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset`}
                                >
                                  <span
                                    aria-hidden="true"
                                    className={`mt-px w-4 shrink-0 pl-0.5 text-center text-[13px] leading-5 ${isCurrent ? 'text-primary' : 'text-on-surface-variant'}`}
                                  >
                                    {statusMeta.symbol}
                                  </span>

                                  <span className={`min-w-0 flex-1 break-words text-sm leading-5 ${isSelected ? 'font-medium' : 'font-normal'} text-on-surface`}>
                                    {item.title}
                                  </span>

                                  {isCurrent && (
                                    <span className="shrink-0 rounded bg-primary/15 px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-primary">
                                      Current
                                    </span>
                                  )}

                                  {isSelected && !isCurrent && (
                                    <span className="shrink-0 rounded bg-primary/10 px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-primary/80">
                                      Selected
                                    </span>
                                  )}

                                  <span className="sr-only">
                                    {statusMeta.hint}
                                  </span>
                                </button>

                              </li>
                            )
                          })}
                        </ul>
                      )}

                      {/* Existing Live quick-add survives: the
                          inline composer stays available under
                          every Section. */}
                      {creatingSectionId === section.id ? (
                        <form
                          data-quick-add-form={section.id}
                          onSubmit={(e) => {
                            e.preventDefault()
                            void handleCreateItemInSection(section)
                          }}
                          className="mt-1.5 flex items-center gap-1.5 px-2.5"
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
                            className="h-8 min-w-0 flex-1 rounded-md border border-outline-variant bg-surface-container-lowest px-2.5 text-sm text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
                          />

                          <button
                            type="submit"
                            disabled={
                              !(
                                sectionItemTitle[section.id] ??
                                ''
                              ).trim()
                            }
                            className="inline-flex h-8 items-center rounded-md px-2 text-sm font-medium text-primary transition hover:bg-primary/10 disabled:opacity-45"
                          >
                            Add
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
                          className="mt-1 inline-flex h-7 items-center gap-1 pl-1 pr-2 text-xs font-medium text-on-surface-variant/80 outline-none transition hover:text-primary focus-visible:ring-2 focus-visible:ring-primary/40 rounded-md"
                        >
                          <span aria-hidden="true" className="material-symbols-outlined text-[14px]">
                            add
                          </span>
                          {sectionItems.length === 0
                            ? 'Add first item'
                            : 'Add item'}
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </nav>

          {/* RIGHT: Current Item workspace. */}
          <main
            aria-label="Agenda item"
            className="min-w-0 flex-1"
          >
            {liveSelectedItem != null ? (
              <div>
                {/* Small context line: Section · position */}
                <p className="text-sm font-medium text-on-surface-variant">
                  {liveSelectedSection?.name ?? ''}
                  {liveSelectedPosition > 0 && (
                    <>
                      {' · '}
                      {liveSelectedPosition} of{' '}
                      {(
                        itemsBySection.get(
                          liveSelectedSection!.id,
                        ) ?? []
                      ).length}
                    </>
                  )}
                </p>

                {/* Shown only while the user is viewing a non-current
                    item. "Return to current" is purely local navigation —
                    it re-points selection at the Meeting's actual current
                    item and never mutates the domain. "Make current" is
                    the deliberate, domain-mutating alternative: it calls
                    the canonical Focus action so the VIEWED item becomes
                    the persisted current item. The Focus contract accepts
                    an item of any outcome, so availability here mirrors
                    the domain rule: the user may write the Meeting and
                    the viewed item is not already current. */}
                {!liveSelectionIsCurrent && (
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleReturnToCurrent}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/5 px-3 text-sm font-medium text-primary outline-none transition hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-primary/40"
                    >
                      <span aria-hidden="true" className="material-symbols-outlined text-[16px]">
                        arrow_back
                      </span>
                      Return to current
                    </button>

                    {canManageLifecycle && (
                      <button
                        type="button"
                        disabled={
                          updatingItemId ===
                          liveSelectedItem!.id
                        }
                        onClick={() =>
                          void handleFocusItem(
                            liveSelectedItem!,
                          )
                        }
                        aria-label={`Make ${liveSelectedItem!.title} current`}
                        title="Make this item the meeting's current item"
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm font-medium text-on-surface outline-none transition hover:border-primary/40 hover:bg-surface-container-low focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
                      >
                        {updatingItemId ===
                        liveSelectedItem!.id ? (
                          <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[16px]">
                            refresh
                          </span>
                        ) : (
                          <span aria-hidden="true" className="material-symbols-outlined text-[16px]">
                            center_focus_strong
                          </span>
                        )}
                        {updatingItemId ===
                        liveSelectedItem!.id
                          ? 'Making current…'
                          : 'Make current'}
                      </button>
                    )}

                    <span className="sr-only">
                      You are viewing a different item than the meeting's
                      current item.
                    </span>
                  </div>
                )}

                {/* Current item title — strongest heading. */}
                <h2
                  data-current-item-title
                  className="mt-1 break-words text-2xl font-semibold tracking-tight text-on-surface"
                >
                  {liveSelectedItem.title}
                </h2>

                {liveSelectedItem.contextNotes && (
                  <p className="mt-2 whitespace-pre-wrap text-sm text-on-surface-variant">
                    {liveSelectedItem.contextNotes}
                  </p>
                )}

                {/* Existing persistent Meeting Notes: content,
                    authoring, and Note -> Work Item all stay
                    exactly as before, scoped to THIS item. The
                    column is left-aligned and width-constrained
                    for readability on wide screens. */}
                <div className="mt-5 w-full max-w-[740px]">
                  {(liveSelectedItem.notes ?? []).length >
                    0 ? (
                    <div>
                      <p className="text-xs font-semibold text-on-surface-variant">
                        Notes
                      </p>

                      <ul className="mt-2 space-y-5">
                        {(liveSelectedItem.notes ?? []).map(
                          (note) => (
                            <li
                              key={note.id}
                              className="group/note relative rounded-lg px-2 py-1 transition hover:bg-surface-container-low/60"
                            >
                              {editingNoteId ===
                              note.id ? (
                                <div>
                                  <textarea
                                    value={noteEditContent}
                                    onChange={(
                                      event,
                                    ) =>
                                      setNoteEditContent(
                                        event.target.value,
                                      )
                                    }
                                    onKeyDown={
                                      (event) => {
                                        if (
                                          event.key ===
                                            'Escape'
                                        ) {
                                          event.preventDefault()
                                          cancelEditingNote()
                                        }
                                      }
                                    }
                                    autoFocus
                                    rows={2}
                                    aria-label={`Edit note on ${liveSelectedItem.title}`}
                                    className="w-full resize-y rounded-lg border border-outline-variant bg-surface-container-lowest px-2 py-1.5 text-sm text-on-surface outline-none focus:border-primary"
                                  />

                                  <div className="mt-1.5 flex items-center justify-end gap-2">
                                    <button
                                      type="button"
                                      onClick={
                                        cancelEditingNote
                                      }
                                      className="h-7 rounded-md px-2 text-xs font-medium text-on-surface-variant outline-none transition hover:bg-surface-container-high focus-visible:ring-2 focus-visible:ring-primary/40"
                                    >
                                      Cancel
                                    </button>

                                    <button
                                      type="button"
                                      disabled={
                                        !noteEditContent.trim()
                                      }
                                      onClick={
                                        () =>
                                          void saveNoteEdit(
                                            liveSelectedItem,
                                            note,
                                          )
                                      }
                                      className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2 text-xs font-semibold text-white outline-none transition hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-45"
                                    >
                                      {savingNoteId ===
                                      note.id && (
                                        <span
                                          aria-hidden="true"
                                          className="material-symbols-outlined animate-spin text-[13px]"
                                        >
                                          refresh
                                        </span>
                                      )}
                                      {savingNoteId ===
                                      note.id
                                        ? 'Saving…'
                                        : 'Save'}
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <>
                                  <p className="whitespace-pre-wrap text-sm leading-6 text-on-surface">
                                    {note.content}
                                  </p>

                                  <p className="mt-1 text-[11px] text-on-surface-variant/70">
                                    {getPersonName(
                                      note.author,
                                    )}{' '}
                                    ·{' '}
                                    {formatNoteTime(
                                      note.createdAt,
                                    )}
                                  </p>

                                  {/* Linked work: rendered
                                      directly at the exact
                                      source Note, same as before. */}
                                  {(() => {
                                    const linked =
                                      note.linkedWorkItem

                                    if (
                                      linked == null
                                    ) {
                                      return null
                                    }

                                    return (
                                      <div className="mt-1.5 rounded-lg border border-outline-variant/70 bg-surface-container-low/60 px-2.5 py-2">
                                        <p className="text-[11px] font-medium text-on-surface-variant">
                                          Linked work
                                        </p>

                                        <button
                                          type="button"
                                          onClick={() =>
                                            openLinkedWorkInspector(
                                              linked,
                                            )
                                          }
                                          aria-label={`Open linked work item: ${linked.title}`}
                                          className="mt-1 flex w-full items-start gap-2 rounded-md text-left outline-none transition hover:bg-surface-container-high/60 focus-visible:ring-2 focus-visible:ring-primary/40"
                                        >
                                          <span aria-hidden="true" className="material-symbols-outlined mt-px text-[16px] text-on-surface-variant">
                                            check_box_outline_blank
                                          </span>

                                          <span className="min-w-0 flex-1">
                                            <span className="block truncate text-sm text-on-surface">
                                              {linked.title}
                                            </span>

                                            <span className="block truncate text-[11px] text-on-surface-variant">
                                              {linked.projectName}
                                              {' · '}
                                              {linked.assigneeNames.length > 0
                                                ? linked.assigneeNames.join(', ')
                                                : 'Unassigned'}
                                              {' · '}
                                              {linked.statusName}
                                            </span>
                                          </span>
                                        </button>

                                        {justLinkedNoteId ===
                                        note.id && (
                                          <p role="status" className="mt-1 text-[11px] font-medium text-primary">
                                            Work item created
                                          </p>
                                        )}
                                      </div>
                                    )
                                  })()}

                                  {(isLive ||
                                  (canCreateWorkFromNote &&
                                  note.linkedWorkItem ==
                                  null)) && (
                                    <div className="mt-0.5 flex items-center justify-end gap-1 opacity-0 transition group-hover/note:opacity-100 focus-within:opacity-100">
                                      {canCreateWorkFromNote &&
                                      note.linkedWorkItem ==
                                        null && (
                                        <button
                                          type="button"
                                          onClick={() =>
                                            openNoteWorkItem(
                                              liveSelectedItem,
                                              note,
                                            )
                                          }
                                          aria-label={`Create work item from note: ${note.content}`}
                                          title="Create work item"
                                          className="rounded-md p-1 text-on-surface-variant/50 outline-none transition hover:bg-surface-container-high hover:text-on-surface-variant focus-visible:text-primary focus-visible:ring-2 focus-visible:ring-primary/40"
                                        >
                                          <span aria-hidden="true" className="material-symbols-outlined text-[15px]">
                                            add_task
                                          </span>
                                        </button>
                                      )}

                                      {isLive && (
                                      <MenuTrigger
                                        label={`Note actions for ${note.content}`}
                                      >
                                        {(_, close) => (
                                          <>
                                            <MenuItem
                                              label="Edit note"
                                              icon="edit"
                                              onClick={
                                                () => {
                                                  startEditingNote(
                                                    note,
                                                  )
                                                  close()
                                                }
                                              }
                                            />

                                            <span
                                              role="none"
                                              className="my-1 border-t border-outline-variant"
                                            />

                                            <MenuItem
                                              label="Delete note"
                                              icon="delete"
                                              danger
                                              onClick={
                                                () => {
                                                  close()
                                                  setPendingDeleteNote(
                                                    note,
                                                  )
                                                }
                                              }
                                            />
                                          </>
                                        )}
                                      </MenuTrigger>
                                      )}
                                    </div>
                                  )}
                                </>
                              )}
                            </li>
                          ),
                        )}
                      </ul>
                    </div>
                  ) : null}

                  {/* Composer: only when explicitly open. */}
                  {noteComposerItemId ===
                  liveSelectedItem.id ? (
                    <div className="mt-3">
                      <textarea
                        value={noteDraftContent}
                        onChange={(event) =>
                          setNoteDraftContent(
                            event.target.value,
                          )
                        }
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.preventDefault()
                            cancelNoteComposer()
                          }
                        }}
                        autoFocus
                        rows={2}
                        placeholder="Add what came up during the discussion…"
                        aria-label={`Add note to ${liveSelectedItem.title}`}
                        className="w-full resize-y rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 text-sm text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
                      />

                      <div className="mt-2 flex items-center gap-2">
                        <button
                          type="button"
                          disabled={
                            !noteDraftContent.trim()
                          }
                          onClick={() =>
                            void
                              submitNoteThenCreateWorkItem(
                                liveSelectedItem,
                              )
                          }
                          className="h-8 rounded-lg px-2 text-xs font-medium text-on-surface-variant outline-none transition hover:bg-surface-container-high hover:text-on-surface focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-45"
                        >
                          Create work item
                        </button>

                        <button
                          type="button"
                          disabled={
                            !noteDraftContent.trim()
                          }
                          onClick={() =>
                            void submitNoteComposer(
                              liveSelectedItem,
                            )
                          }
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-on-primary outline-none transition hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-45"
                        >
                          {creatingNoteItemId ===
                          liveSelectedItem.id && (
                            <span
                              aria-hidden="true"
                              className="material-symbols-outlined animate-spin text-[15px]"
                            >
                              refresh
                            </span>
                          )}
                          {creatingNoteItemId ===
                          liveSelectedItem.id
                            ? 'Adding…'
                            : 'Add note'}
                        </button>

                        <button
                          type="button"
                          onClick={cancelNoteComposer}
                          className="ml-auto h-8 rounded-lg px-2 text-sm font-medium text-on-surface-variant outline-none transition hover:bg-surface-container-high focus-visible:ring-2 focus-visible:ring-primary/40"
                        >
                          Cancel
                        </button></div>
                    </div>
                  ) : null}

                  {isLive &&
                  noteComposerItemId !==
                    liveSelectedItem.id && (
                    <button
                      type="button"
                      onClick={() =>
                        openNoteComposer(liveSelectedItem)
                      }
                      className="mt-3 inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-on-surface-variant/70 outline-none transition hover:bg-surface-container-low hover:text-on-surface focus-visible:ring-2 focus-visible:ring-primary/40"
                    >
                      <span aria-hidden="true" className="material-symbols-outlined text-[14px]">
                        add
                      </span>
                      {(liveSelectedItem.notes ?? []).length >
                      0
                        ? 'Add note'
                        : 'Add note…'}
                    </button>
                  )}
                </div>

                {/* Live resolution actions — bound to the CURRENT item
                    only. They render only while the user is viewing the
                    current item, so they never operate on an arbitrary
                    selected non-current item. */}
                {canManageLifecycle && liveSelectionIsCurrent && (
                  <div className="mt-8 flex items-center gap-2 border-t border-outline-variant pt-5">
                    <button
                      type="button"
                      disabled={
                        updatingItemId ===
                        liveCurrentItem!.id
                      }
                      onClick={() =>
                        void handleDoneItem(liveCurrentItem!)
                      }
                      aria-label={`Mark ${liveCurrentItem!.title} as done`}
                      title="Done"
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-on-primary outline-none transition hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:opacity-60"
                    >
                      <span aria-hidden="true" className="material-symbols-outlined text-[16px]">
                        check
                      </span>
                      {updatingItemId ===
                      liveCurrentItem!.id
                        ? 'Saving…'
                        : 'Done'}
                    </button>

                    <button
                      type="button"
                      disabled={
                        updatingItemId ===
                        liveCurrentItem!.id
                      }
                      onClick={() =>
                        void handleFollowUpItem(
                          liveCurrentItem!,
                        )
                      }
                      aria-label={`Mark ${liveCurrentItem!.title} as follow-up`}
                      title="Follow up"
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm font-medium text-on-surface outline-none transition hover:border-primary/40 hover:bg-surface-container-low focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
                    >
                      <span aria-hidden="true" className="material-symbols-outlined text-[16px]">
                        follow_up
                      </span>
                      Follow up
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-outline-variant px-6 py-12 text-center">
                <span aria-hidden="true" className="material-symbols-outlined text-[26px] text-on-surface-variant">
                  check_circle
                </span>

                <p className="mt-3 text-sm font-medium text-on-surface">
                  No current item
                </p>

                {liveOpenItemCount > 0 && (
                  <p className="mt-1 max-w-72 text-sm text-on-surface-variant">
                    Select an open agenda item to start
                    discussing it.
                  </p>
                )}
              </div>
            )}
          </main>
        </div>
      ) : isCompleted ? (
      /* Completed: calm read-first recap + protocol. */
      <CompletedMeetingRecap
        sortedSections={sortedSections}
        sortedItems={sortedItems}
        itemsBySection={itemsBySection}
        workById={recapWorkById}
        onOpenLinkedWork={openLinkedWorkInspector}
      />
      ) : (
      /* Agenda / Protocol */
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
                                        (item.outcome === 'done' ||
                                          item.outcome === 'follow_up') &&
                                        !isLive
                                          ? 'text-on-surface-variant'
                                          : 'text-on-surface',
                                      ].join(' ')}
                                    >
                                      {item.title}
                                    </h4>

                                    {item.outcome === 'done' && (
                                      <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-on-surface-variant">
                                        <span aria-hidden="true" className="material-symbols-outlined text-[13px]">
                                          check_circle
                                        </span>
                                        Done
                                      </span>
                                    )}

                                    {item.outcome === 'follow_up' && (
                                      <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-on-surface-variant">
                                        <span aria-hidden="true" className="material-symbols-outlined text-[13px]">
                                          follow_up
                                        </span>
                                        Follow-up
                                      </span>
                                    )}
                                  </div>

                                  {item.contextNotes && (
                                    <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-on-surface-variant">
                                      {item.contextNotes}
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

                                  {/* Persistent meeting Notes:
                                      saved notes render in Live and Completed;
                                      authoring controls are Live-only. */}
                                  {(isLive || isCompleted) && (
                                    <div className="mt-2">
                                      {isLive &&
                                      noteComposerItemId ===
                                        item.id && (
                                          <div className="mb-2">
                                            <textarea
                                              value={noteDraftContent}
                                              onChange={(event) =>
                                                setNoteDraftContent(
                                                  event.target.value,
                                                )
                                              }
                                              onKeyDown={(event) => {
                                                if (
                                                  event.key ===
                                                    'Escape'
                                                ) {
                                                  event.preventDefault()
                                                  cancelNoteComposer()
                                                }
                                              }}
                                              autoFocus
                                              rows={2}
                                              placeholder="Add what came up during the discussion…"
                                              aria-label={`Add note to ${item.title}`}
                                              className="w-full resize-y rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 text-sm text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
                                            />

                                            <div className="mt-2 flex items-center justify-end gap-2">
                                              <button
                                                type="button"
                                                onClick={
                                                  cancelNoteComposer
                                                }
                                                className="h-8 rounded-lg px-2 text-sm font-medium text-on-surface-variant outline-none transition hover:bg-surface-container-high focus-visible:ring-2 focus-visible:ring-primary/40"
                                              >
                                                Cancel
                                              </button>

                                              <button
                                                type="button"
                                                disabled={
                                                  !noteDraftContent.trim()
                                                }
                                                onClick={() =>
                                                  void
                                                    submitNoteThenCreateWorkItem(
                                                      item,
                                                    )
                                                }
                                                className="h-8 rounded-lg px-2 text-xs font-medium text-on-surface-variant outline-none transition hover:bg-surface-container-high hover:text-on-surface focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-45"
                                              >
                                                Create work item
                                              </button>

                                              <button
                                                type="button"
                                                disabled={
                                                  !noteDraftContent.trim()
                                                }
                                                onClick={() =>
                                                  void submitNoteComposer(
                                                    item,
                                                  )
                                                }
                                                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-white outline-none transition hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-45"
                                              >
                                                {creatingNoteItemId ===
                                                item.id && (
                                                  <span
                                                    aria-hidden="true"
                                                    className="material-symbols-outlined animate-spin text-[15px]"
                                                  >
                                                    refresh
                                                  </span>
                                                )}
                                                {creatingNoteItemId ===
                                                item.id
                                                  ? 'Adding…'
                                                  : 'Add note'}
                                              </button>
                                            </div>
                                          </div>
                                        )}

                                      {(item.notes ?? []).length >
                                        0 && (
                                        <div>
                                          <p className="text-xs font-semibold text-on-surface-variant">
                                            Notes
                                          </p>

                                          <ul className="mt-1 space-y-2">
                                            {(item.notes ?? []).map(
                                              (note) => (
                                                <li
                                                  key={note.id}
                                                  className="group/note relative rounded-lg px-2 py-1 transition hover:bg-surface-container-low/60"
                                                >
                                                  {isLive &&
                                                  editingNoteId ===
                                                    note.id ? (
                                                    <div>
                                                      <textarea
                                                        value={noteEditContent}
                                                        onChange={(
                                                          event,
                                                        ) =>
                                                          setNoteEditContent(
                                                            event.target.value,
                                                          )
                                                        }
                                                        onKeyDown={
                                                          (event) => {
                                                            if (
                                                              event.key ===
                                                                'Escape'
                                                            ) {
                                                              event.preventDefault()
                                                              cancelEditingNote()
                                                            }
                                                          }
                                                        }
                                                        autoFocus
                                                        rows={2}
                                                        aria-label={`Edit note on ${item.title}`}
                                                        className="w-full resize-y rounded-lg border border-outline-variant bg-surface-container-lowest px-2 py-1.5 text-sm text-on-surface outline-none focus:border-primary"
                                                      />

                                                      <div className="mt-1.5 flex items-center justify-end gap-2">
                                                        <button
                                                          type="button"
                                                          onClick={
                                                            cancelEditingNote
                                                          }
                                                          className="h-7 rounded-md px-2 text-xs font-medium text-on-surface-variant outline-none transition hover:bg-surface-container-high focus-visible:ring-2 focus-visible:ring-primary/40"
                                                        >
                                                          Cancel
                                                        </button>

                                                        <button
                                                          type="button"
                                                          disabled={
                                                            !noteEditContent.trim()
                                                          }
                                                          onClick={
                                                            () =>
                                                              void saveNoteEdit(
                                                                item,
                                                                note,
                                                              )
                                                          }
                                                          className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2 text-xs font-semibold text-white outline-none transition hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-45"
                                                        >
                                                          {savingNoteId ===
                                                          note.id && (
                                                            <span
                                                              aria-hidden="true"
                                                              className="material-symbols-outlined animate-spin text-[13px]"
                                                            >
                                                              refresh
                                                            </span>
                                                          )}
                                                          {savingNoteId ===
                                                          note.id
                                                            ? 'Saving…'
                                                            : 'Save'}
                                                        </button>
                                                      </div>
                                                    </div>
                                                  ) : (
                                                    <>
                                                      <p className="whitespace-pre-wrap text-sm text-on-surface">
                                                        {note.content}
                                                      </p>

                                                      <p className="mt-0.5 text-[11px] text-on-surface-variant/70">
                                                        {getPersonName(
                                                          note.author,
                                                        )}{' '}
                                                        ·{' '}
                                                        {formatNoteTime(
                                                          note.createdAt,
                                                        )}
                                                      </p>

                                                      {/* Linked work:
                                                          calm, contextual, and
                                                          directly at the exact
                                                          source Note. */}
                                                      {(() => {
                                                        const linked =
                                                          note.linkedWorkItem

                                                        if (
                                                          linked ==
                                                          null
                                                        ) {
                                                          return null
                                                        }

                                                        return (
                                                          <div className="mt-1.5 rounded-lg border border-outline-variant/70 bg-surface-container-low/60 px-2.5 py-2">
                                                            <p className="text-[11px] font-medium text-on-surface-variant">
                                                              Linked work
                                                            </p>

                                                            <button
                                                              type="button"
                                                              onClick={() =>
                                                                openLinkedWorkInspector(
                                                                  linked,
                                                                )
                                                              }
                                                              aria-label={`Open linked work item: ${linked.title}`}
                                                              className="mt-1 flex w-full items-start gap-2 rounded-md text-left outline-none transition hover:bg-surface-container-high/60 focus-visible:ring-2 focus-visible:ring-primary/40"
                                                            >
                                                              <span aria-hidden="true" className="material-symbols-outlined mt-px text-[16px] text-on-surface-variant">
                                                                check_box_outline_blank
                                                              </span>

                                                              <span className="min-w-0 flex-1">
                                                                <span className="block truncate text-sm text-on-surface">
                                                                  {linked.title}
                                                                </span>

                                                                <span className="block truncate text-[11px] text-on-surface-variant">
                                                                  {linked.projectName}
                                                                  {' · '}
                                                                  {linked.assigneeNames.length > 0
                                                                    ? linked.assigneeNames.join(', ')
                                                                    : 'Unassigned'}
                                                                  {' · '}
                                                                  {linked.statusName}
                                                                </span>
                                                              </span>
                                                            </button>

                                                            {justLinkedNoteId ===
                                                            note.id && (
                                                              <p role="status" className="mt-1 text-[11px] font-medium text-primary">
                                                                Work item created
                                                              </p>
                                                            )}
                                                          </div>
                                                        )
                                                      })()}

                                                      {(isLive ||
                                                      (canCreateWorkFromNote &&
                                                      note.linkedWorkItem ==
                                                      null)) && (
                                                        <div className="mt-0.5 flex items-center justify-end gap-1 opacity-0 transition group-hover/note:opacity-100 focus-within:opacity-100">
                                                          {canCreateWorkFromNote &&
                                                          note.linkedWorkItem ==
                                                            null && (
                                                            <button
                                                              type="button"
                                                              onClick={() =>
                                                                openNoteWorkItem(
                                                                  item,
                                                                  note,
                                                                )
                                                              }
                                                              aria-label={`Create work item from note: ${note.content}`}
                                                              title="Create work item"
                                                              className="rounded-md p-1 text-on-surface-variant/50 outline-none transition hover:bg-surface-container-high hover:text-on-surface-variant focus-visible:text-primary focus-visible:ring-2 focus-visible:ring-primary/40"
                                                            >
                                                              <span aria-hidden="true" className="material-symbols-outlined text-[15px]">
                                                                add_task
                                                              </span>
                                                            </button>
                                                          )}

                                                          {isLive && (
                                                          <MenuTrigger
                                                            label={`Note actions for ${note.content}`}
                                                          >
                                                            {(_, close) => (
                                                              <>
                                                                <MenuItem
                                                                  label="Edit note"
                                                                  icon="edit"
                                                                  onClick={
                                                                    () => {
                                                                      startEditingNote(
                                                                        note,
                                                                      )
                                                                      close()
                                                                    }
                                                                  }
                                                                />

                                                                <span
                                                                  role="none"
                                                                  className="my-1 border-t border-outline-variant"
                                                                />

                                                                <MenuItem
                                                                  label="Delete note"
                                                                  icon="delete"
                                                                  danger
                                                                  onClick={
                                                                    () => {
                                                                      close()
                                                                      setPendingDeleteNote(
                                                                        note,
                                                                      )
                                                                    }
                                                                  }
                                                                />
                                                              </>
                                                            )}
                                                          </MenuTrigger>
                                                          )}
                                                        </div>
                                                      )}
                                                    </>
                                                  )}
                                                </li>
                                              ),
                                            )}
                                          </ul>
                                        </div>
                                      )}

                                      {isLive &&
                                      noteComposerItemId !==
                                        item.id && (
                                        <button
                                          type="button"
                                          onClick={() =>
                                            openNoteComposer(item)
                                          }
                                          className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-on-surface-variant/70 outline-none transition hover:bg-surface-container-low hover:text-on-surface focus-visible:ring-2 focus-visible:ring-primary/40"
                                        >
                                          <span aria-hidden="true" className="material-symbols-outlined text-[14px]">
                                            add
                                          </span>
                                          {(item.notes ?? []).length >
                                          0
                                            ? 'Add note'
                                            : 'Add note…'}
                                        </button>
                                      )}
                                    </div>
                                  )}
                                </div>

                                {/* Live: canonical actions.
                                    The current item (persisted on the
                                    Meeting) can be closed with Done or
                                    Follow-up; any non-current item can
                                    be focused. */}
                                {isLive && canManageLifecycle && (
                                  <span className="flex shrink-0 items-center gap-2">
                                    {item.id !==
                                      meeting.currentMeetingItemId && (
                                      <button
                                        type="button"
                                        disabled={
                                          updatingItemId === item.id
                                        }
                                        onClick={() =>
                                          void handleFocusItem(item)
                                        }
                                        aria-label={`Focus ${item.title}`}
                                        title="Focus"
                                        className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg text-on-surface-variant transition hover:bg-surface-container-high disabled:opacity-45"
                                      >
                                        <span aria-hidden="true" className="material-symbols-outlined text-[18px]">
                                          radio_button_checked
                                        </span>
                                      </button>
                                    )}
                                    {item.id ===
                                      meeting.currentMeetingItemId && (
                                      <>
                                        <button
                                          type="button"
                                          disabled={
                                            updatingItemId === item.id
                                          }
                                          onClick={() =>
                                            void handleDoneItem(item)
                                          }
                                          aria-label={`Mark ${item.title} as done`}
                                          title="Done"
                                          className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg text-on-surface-variant transition hover:bg-surface-container-high disabled:opacity-45"
                                        >
                                          <span aria-hidden="true" className="material-symbols-outlined text-[18px]">
                                            check_circle
                                          </span>
                                        </button>
                                        <button
                                          type="button"
                                          disabled={
                                            updatingItemId === item.id
                                          }
                                          onClick={() =>
                                            void handleFollowUpItem(item)
                                          }
                                          aria-label={`Mark ${item.title} as follow-up`}
                                          title="Follow up"
                                          className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg text-on-surface-variant transition hover:bg-surface-container-high disabled:opacity-45"
                                        >
                                          <span aria-hidden="true" className="material-symbols-outlined text-[18px]">
                                            follow_up
                                          </span>
                                        </button>
                                      </>
                                    )}
                                  </span>
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
                        emphasis adapt to the empty case. Spontaneous
                        items remain creatable while the Meeting is
                        Live. */}
                    {creatingSectionId === section.id ? (
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
                    )}

                  </div>
                </section>
              )
            })}
          </div>
        )}
      </div>
      )}

      {deleteDialogOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-on-surface/25 px-4 py-8 backdrop-blur-[2px]"
          onMouseDown={(event) => {
            if (
              event.target === event.currentTarget &&
              !deletingMeeting
            ) {
              setDeleteDialogOpen(false)
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="meeting-delete-title"
            className="w-full max-w-md overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-lowest shadow-xl"
          >
            <div className="px-6 py-5">
              <h2
                id="meeting-delete-title"
                className="text-lg font-semibold tracking-tight text-on-surface"
              >
                Delete meeting?
              </h2>

              <p className="mt-2 text-sm text-on-surface-variant">
                This permanently deletes this meeting and its
                agenda/protocol content. Work Items created from this
                meeting will not be deleted.
              </p>

              {actionError && (
                <p
                  role="alert"
                  className="mt-3 rounded-lg bg-error-container px-3 py-2 text-sm text-error"
                >
                  {actionError}
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-outline-variant px-6 py-4">
              <button
                type="button"
                disabled={deletingMeeting}
                onClick={() => setDeleteDialogOpen(false)}
                className="inline-flex h-9 items-center rounded-lg px-3.5 text-sm font-medium text-on-surface-variant outline-none transition hover:bg-surface-container-high focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
              >
                Cancel
              </button>

              <button
                type="button"
                disabled={deletingMeeting}
                onClick={() => void handleDeleteMeeting()}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-error-container px-3.5 text-sm font-semibold text-on-error-container outline-none transition hover:bg-error-container/80 focus-visible:ring-2 focus-visible:ring-error focus-visible:ring-offset-2 disabled:opacity-60"
              >
                {deletingMeeting && (
                  <span
                    aria-hidden="true"
                    className="material-symbols-outlined animate-spin text-[18px]"
                  >
                    refresh
                  </span>
                )}
                {deletingMeeting
                  ? 'Deleting…'
                  : 'Delete meeting'}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingDeleteNote != null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-on-surface/25 px-4 py-8 backdrop-blur-[2px]"
          onMouseDown={(event) => {
            if (
              event.target === event.currentTarget &&
              deletingNoteId == null
            ) {
              setPendingDeleteNote(null)
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="note-delete-title"
            className="w-full max-w-md overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-lowest shadow-xl"
          >
            <div className="px-6 py-5">
              <h2
                id="note-delete-title"
                className="text-lg font-semibold tracking-tight text-on-surface"
              >
                Delete note?
              </h2>

              <p className="mt-2 text-sm text-on-surface-variant">
                This permanently deletes the note. The agenda item
                and any linked Work Items are not affected.
              </p>

              {actionError && (
                <p
                  role="alert"
                  className="mt-3 rounded-lg bg-error-container px-3 py-2 text-sm text-error"
                >
                  {actionError}
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-outline-variant px-6 py-4">
              <button
                type="button"
                disabled={deletingNoteId != null}
                onClick={() => setPendingDeleteNote(null)}
                className="inline-flex h-9 items-center rounded-lg px-3.5 text-sm font-medium text-on-surface-variant outline-none transition hover:bg-surface-container-high focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
              >
                Cancel
              </button>

              <button
                type="button"
                disabled={deletingNoteId != null}
                onClick={() => void confirmDeleteNote()}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-error-container px-3.5 text-sm font-semibold text-on-error-container outline-none transition hover:bg-error-container/80 focus-visible:ring-2 focus-visible:ring-error focus-visible:ring-offset-2 disabled:opacity-60"
              >
                {deletingNoteId != null && (
                  <span
                    aria-hidden="true"
                    className="material-symbols-outlined animate-spin text-[18px]"
                  >
                    refresh
                  </span>
                )}
                {deletingNoteId != null
                  ? 'Deleting…'
                  : 'Delete note'}
              </button>
            </div>
          </div>
        </div>
      )}

      <CreateMeetingWorkItemDialog
        open={workItemSource != null}
        researchGroupId={meeting.researchGroupId}
        meetingItem={workItemSource}
        defaultProjectId={
          meeting.projectId ?? null
        }
        sourceNote={noteWorkItemNote}
        onClose={
          closeWorkItemDialog
        }
        onCreated={
          noteWorkItemNote != null
            ? handleNoteWorkItemCreated
            : handleWorkItemCreated
        }
      />

      {/* Shared Work Item Inspector, opened in place over the
          Meeting (no navigation, context preserved). */}
      {inspectorWorkItemId != null && (
        inspectorItem != null &&
        !inspectorLoading ? (
          <Suspense fallback={null}>
            <WorkItemDrawer
              open={true}
              mode="edit"
              projectName={
                inspectorProject
                  ?.name ??
                ''
              }
              item={inspectorItem}
              readOnly={
                inspectorProject
                  ?.currentUserRole ===
                'viewer'
              }
              currentUserId={
                user ? user.id : null
              }
              workItemConfiguration={
                inspectorConfiguration
              }
              assignees={
                inspectorAssignees
              }
              parentItems={
                inspectorParentItems
              }
              onClose={
                closeLinkedWorkInspector
              }
              onCreate={
                async () => {
                  // Creation is handled by the dialog; the
                  // Inspector opened from a Meeting is edit-only.
                  throw new Error(
                    'Create is not available here.',
                  )
                }
              }
              onPatch={
                handleInspectorPatch
              }
            />
          </Suspense>
        ) : (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
            <div className="flex items-center gap-2 rounded-xl border border-outline-variant bg-surface-container-lowest px-5 py-4 text-sm text-on-surface-variant shadow-xl">
              <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[18px]">
                refresh
              </span>
              Opening work item…
            </div>
          </div>
        )
      )}
    </div>
  )
}
